// model-io JSONL reader + stitcher (L2 data source for context-lens).
//
// The CLI's model runner appends one JSON line per model call to
// ~/.zcode/cli/rollout (prod) or ~/.zcode/cli/debug (dev): full request payload
// (system blocks, tool schemas, messages) + response meta. The log compacts
// messages across records (messagesKind: full|delta|tail + offsets), so reading
// requires stitching - semantics mirror the writer in
// apps/zcode-cli/packages/adapters/src/model/runner-debug.ts.
// This format is internal/diagnostic: any deviation degrades to null, never throws.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const LOG_DIRS = [
  join(homedir(), ".zcode", "cli", "rollout"),
  join(homedir(), ".zcode", "cli", "debug"),
];

// Per-record / per-message caps (chars). The viewer is for reading, not bulk export.
export const CAPS = {
  messageBody: 24000,
  toolSchema: 20000,
  systemBlock: 40000,
};

// Log cache: path -> entry { path, size, mtimeMs, records, stitched, meta }.
// Invalidated when mtime or size changes (the file grows while a turn runs).
const logCache = new Map();

// Mirror of runner-debug.ts sanitizeFileSegment: session id -> filename segment.
export function sanitizeFileSegment(value) {
  if (!value) return "";
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function findLogFile(sessionId) {
  const seg = sanitizeFileSegment(sessionId);
  if (!seg) return null;
  for (const dir of LOG_DIRS) {
    const path = join(dir, `model-io-${seg}.jsonl`);
    try {
      const s = await stat(path);
      if (s.isFile()) return { path, size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      // not in this dir; try the next
    }
  }
  return null;
}

// Parse a model-io JSONL file into records, skipping malformed / partial lines.
function parseRecords(text) {
  const records = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object") records.push(record);
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

// Stitch request.messages across records using messagesKind/messageOffset/messageCount.
// Semantics mirror runner-debug.ts compactMessageCollection:
//   full  -> buffer = record messages (whole history present)
//   delta -> append; expected when buffer length === messageOffset
//   tail  -> last (count - offset) messages replace the end of the buffer; when the
//            delta chain was broken (restart / model switch), only the tail window
//            remains and truncated=true.
export function stitchMessages(records) {
  let messages = [];
  let truncated = false;
  for (const record of records) {
    const request = record?.request;
    if (!request || !Array.isArray(request.messages)) continue;
    const kind = request.messagesKind;
    const offset = request.messageOffset ?? 0;
    if (kind === "full") {
      messages = request.messages.slice();
    } else if (kind === "delta") {
      if (messages.length !== offset) truncated = true;
      messages = messages.concat(request.messages);
    } else if (kind === "tail") {
      if (messages.length >= offset) {
        messages = messages.slice(0, offset).concat(request.messages);
      } else {
        messages = request.messages.slice();
        truncated = true;
      }
    }
  }
  return { messages, truncated };
}

// Load (and cache) the log for a session. Returns null when no log exists.
export async function loadLog(sessionId) {
  const file = await findLogFile(sessionId);
  if (!file) return null;
  const cached = logCache.get(file.path);
  if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
    return cached;
  }
  try {
    const text = await readFile(file.path, "utf8");
    const { records, skipped } = parseRecords(text);
    const stitched = stitchMessages(records);
    const last = records.length ? records[records.length - 1].request ?? {} : {};
    const meta = {
      path: file.path,
      records: records.length,
      skipped,
      lastMessageCount: last.messageCount ?? null,
      stitchedCount: stitched.messages.length,
      truncated: stitched.truncated,
      complete: records.length > 0 && last.messageCount === stitched.messages.length,
    };
    const entry = { ...file, records, stitched, meta };
    logCache.set(file.path, entry);
    return entry;
  } catch {
    return null;
  }
}
