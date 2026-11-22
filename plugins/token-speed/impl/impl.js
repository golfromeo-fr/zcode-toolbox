// token-speed: composer chip with the live output tokens-per-second.
// Main session: only consumes models.onDidGenerate (generation metrics) — no context.get, no fs:
//   streaming rate every 500ms while generating, accurate final rate afterwards.
// Subagents: onDidGenerate never fires for them (the host generation pump filters to
//   querySource=main_turn and drops stream chunks carrying parentToolCallId), and subagent
//   child sessions are excluded from the sessions.* API. The data therefore comes from files
//   the CLI already writes, read-only (same trick as context-lens's model-io log):
//   ~/.zcode/cli/agents/sess_<parent>/agent_<id>/metadata.json — parentSessionId + status
//   ~/.zcode/cli/rollout/model-io-sess_subagent_agent_<id>.jsonl — one line per COMPLETED
//     model call with usage + durationMs → per-call tok/s. The rate refreshes once per
//     agentic iteration (~5-15s), not char-level live; that needs a host change.
// Polling: 1s tick, but each tick only stats mtimes/sizes; JSON is re-read/parsed only when
//   a file actually changed. The chip has no event source for subagents, so polling is the
//   only option (the "event-driven only" principle applies to context-lens's view path).
// Chip text is compact (shell truncates composer.status at max-w-40).
import { readFile, readdir, stat, open } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

// Test hook: tests point ZCODE_HOME at a fixture tree.
const ZC = process.env.ZCODE_HOME ?? join(homedir(), ".zcode");
const AGENTS_DIR = join(ZC, "cli", "agents");
const LOG_DIRS = [join(ZC, "cli", "rollout"), join(ZC, "cli", "debug")];
const logName = (agentId) => `model-io-sess_subagent_agent_${agentId}.jsonl`;

const TERMINAL = new Set(["completed", "failed", "error", "cancelled"]);
const POLL_MS = 1000;
const STALE_RUNNING_MS = 10 * 60_000; // metadata untouched for 10min → crashed "running" agent
// Keep showing a just-finished agent's last rate for a few seconds: the final model
// call usually completes <1s before the metadata flips to a terminal status, so a
// hard `running` gate would hide the rate of the call the user was waiting for.
const SUB_GRACE_MS = Number(process.env.TOKEN_SPEED_SUB_GRACE_MS ?? 10_000);

export async function activate(ctx) {
  const sessions = new Map(); // sessionId -> main-turn streaming state
  const agents = new Map(); // agentId -> subagent watch state
  const rendered = new Map(); // sessionId -> last chip payload (skip no-op slot updates)
  const views = new Set(); // open "subagents" view instances
  let lastSnapshot = ""; // serialized agent list; change-detects view notifications

  const stateUri = `ui://${ctx.extension.id}/state`;

  // ---- main-turn state (unchanged v1.0 behavior) ----
  // ---- subagent watch state ----
  // a = { dir, metaMtimeMs, metaSize, meta, parentSessionId, description, status, running,
  //       logPath, logSize, remainderBuf, rounds, outTotal, lastRate, lastCompletedAt, model }

  const consumeLog = async (a, newSize) => {
    try {
      if (newSize < a.logSize) {
        // log replaced/truncated: reset accumulators, re-read from scratch
        a.rounds = 0;
        a.outTotal = 0;
        a.lastRate = null;
        a.remainderBuf = null;
        a.logSize = -1;
        a.readTo = 0;
      }
      const start = a.logSize < 0 ? 0 : a.readTo;
      const len = newSize - start;
      if (len <= 0) return;
      const fh = await open(a.logPath, "r");
      let slice;
      try {
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, start);
        slice = buf.subarray(0, bytesRead);
        // cursor advances even when the tail has no newline yet (partial line keeps
        // buffering in remainderBuf); set BEFORE parsing so failures can't loop
        a.readTo = start + bytesRead;
        a.logSize = newSize;
      } finally {
        await fh.close();
      }
      // complete lines only; a partial trailing line waits in remainderBuf (byte-safe for CJK)
      const combined = a.remainderBuf?.length ? Buffer.concat([a.remainderBuf, slice]) : slice;
      const lastNl = combined.lastIndexOf(0x0a);
      if (lastNl < 0) {
        // no complete line yet — keep everything (old remainder + new bytes) buffered
        a.remainderBuf = combined;
        return;
      }
      const text = combined.subarray(0, lastNl).toString("utf8");
      a.remainderBuf = combined.subarray(lastNl + 1);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const usage = rec?.response?.usage ?? rec?.usage ?? {};
        const out = usage.outputTokens ?? 0;
        const dur = rec?.durationMs;
        a.rounds += 1;
        a.outTotal += out;
        if (out > 0 && dur > 0) a.lastRate = out / (dur / 1000);
        if (rec?.completedAt) a.lastCompletedAt = Date.parse(rec.completedAt) || a.lastCompletedAt;
        if (rec?.model?.modelId) a.model = rec.model.modelId;
      }
    } catch {
      // transient fs error: keep state, retry next tick
    }
  };

  const watchAgent = async (agentId, dir) => {
    let a = agents.get(agentId);
    const metaPath = join(dir, "metadata.json");
    let st;
    try {
      st = await stat(metaPath);
    } catch {
      return;
    }
    if (!a) {
      a = {
        dir, metaMtimeMs: -1, metaSize: -1, meta: null, parentSessionId: null,
        description: "", status: null, running: false, logPath: null, logSize: -1,
        readTo: 0, remainderBuf: null, rounds: 0, outTotal: 0, lastRate: null,
        lastCompletedAt: 0, model: null,
      };
      agents.set(agentId, a);
    }
    if (st.mtimeMs !== a.metaMtimeMs || st.size !== a.metaSize) {
      try {
        a.meta = JSON.parse(await readFile(metaPath, "utf8"));
        a.metaMtimeMs = st.mtimeMs;
        a.metaSize = st.size;
      } catch {
        return;
      }
    }
    if (!a.meta) return;
    a.parentSessionId = a.meta.parentSessionId ?? null;
    a.description = typeof a.meta.description === "string" ? a.meta.description : "";
    a.status = a.meta.status ?? null;
    a.running =
      !TERMINAL.has(a.status) &&
      (!a.meta.updatedAt || Date.now() - (Date.parse(a.meta.updatedAt) || 0) < STALE_RUNNING_MS);
    // locate the model-io log once while running; tail it whenever it grows.
    // NOT gated on running: the final model call often completes ~100ms before the
    // metadata flips to a terminal status — drain it anyway or the last rate is lost.
    if (!a.logPath) {
      if (!a.running) return;
      for (const d of LOG_DIRS) {
        const p = join(d, logName(agentId));
        try {
          const ls = await stat(p);
          if (ls.isFile()) {
            a.logPath = p;
            break;
          }
        } catch {
          // not in this dir; try the next
        }
      }
      if (!a.logPath) return;
    }
    const ls = await stat(a.logPath).catch(() => null);
    if (!ls || ls.size === a.logSize) return;
    await consumeLog(a, ls.size);
  };

  const scanAgents = async () => {
    let sessDirs;
    try {
      sessDirs = await readdir(AGENTS_DIR, { withFileTypes: true });
    } catch {
      return;
    }
    const seen = new Set();
    for (const sd of sessDirs) {
      if (!sd.isDirectory() || !sd.name.startsWith("sess_")) continue;
      let agentDirs;
      try {
        agentDirs = await readdir(join(AGENTS_DIR, sd.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ad of agentDirs) {
        if (!ad.isDirectory() || !ad.name.startsWith("agent_")) continue;
        const agentId = ad.name.slice("agent_".length);
        seen.add(agentId);
        await watchAgent(agentId, join(AGENTS_DIR, sd.name, ad.name));
      }
    }
    for (const id of [...agents.keys()]) {
      if (!seen.has(id)) agents.delete(id);
    }
  };

  // ---- chip render: main part + sub part, shared by both data paths ----
  const render = (sessionId) => {
    const s = sessions.get(sessionId);
    const parts = [];
    const tooltipParts = [`v${ctx.extension.version}`];
    if (s) {
      if (s.streaming && s.streamingTokS != null) parts.push(`${s.streamingTokS.toFixed(1)}t/s`);
      else if (s.last != null) parts.push(`(${s.last.toFixed(1)}t/s)`);
      tooltipParts.push(
        s.model,
        s.streaming && s.streamingTokS != null
          ? `${s.streamingTokS.toFixed(1)} tok/s`
          : s.last != null
            ? `last ${s.last.toFixed(1)} tok/s`
            : null,
        s.ttft != null ? `ttft ${Math.round(s.ttft)}ms` : null,
        s.outTotal ? `out ${fmtK(s.outTotal)} tok · ${s.rounds} calls` : null,
      );
    }
    // sub part: newest rate first among this session's running (or just-finished,
    // within SUB_GRACE_MS) agents
    const subs = [...agents.values()]
      .filter(
        (a) =>
          a.parentSessionId === sessionId &&
          a.lastRate != null &&
          (a.running || Date.now() - (a.lastCompletedAt || 0) < SUB_GRACE_MS),
      )
      .sort((x, y) => (y.lastCompletedAt ?? 0) - (x.lastCompletedAt ?? 0));
    if (subs.length) {
      parts.push(`sub ${subs[0].lastRate.toFixed(1)}t/s${subs.length > 1 ? ` ×${subs.length}` : ""}`);
      for (const g of subs) {
        tooltipParts.push(
          `sub ${g.description.slice(0, 40)}: last ${g.lastRate.toFixed(1)} tok/s · out ${fmtK(g.outTotal)} · ${g.rounds} calls${g.model ? ` · ${g.model}` : ""}`,
        );
      }
    }
    const text = parts.join(" ");
    const payload = text
      ? { text: text.slice(0, 40), tooltip: tooltipParts.filter(Boolean).join(" · ").slice(0, 200) }
      : { text: "" }; // empty text hides the chip (shell filters !!text)
    const prev = rendered.get(sessionId);
    if (!text && !prev) return; // nothing to show and nothing shown before
    if (prev && prev.text === payload.text && prev.tooltip === payload.tooltip) return;
    rendered.set(sessionId, payload);
    try {
      ctx.slots.update("speed", payload, { sessionId });
    } catch {
      // slot updates must never break the event/poll path
    }
  };

  ctx.models.onDidGenerate((m) => {
    const s = sessions.get(m.sessionId) ?? {
      streaming: false, streamingTokS: null, last: null, ttft: null, outTotal: 0, rounds: 0,
    };
    s.model = m.model?.modelId ?? s.model;
    if (m.phase === "streaming") {
      s.streaming = true;
      s.streamingTokS = m.outputTokensPerSecond;
    } else {
      s.streaming = false;
      if (m.outputTokensPerSecond) s.last = m.outputTokensPerSecond;
      if (m.outputTokens) {
        s.outTotal += m.outputTokens;
        s.rounds += 1;
      }
      if (m.timeToFirstTokenMs) s.ttft = m.timeToFirstTokenMs;
    }
    sessions.set(m.sessionId, s);
    render(m.sessionId);
  });

  const tick = async () => {
    try {
      await scanAgents();
    } catch {
      // scanning must never throw into the timer
    }
    // re-render every session that could show sub data; the rendered-cache turns
    // no-op renders into zero slot updates
    const ids = new Set(sessions.keys());
    for (const a of agents.values()) if (a.parentSessionId) ids.add(a.parentSessionId);
    for (const id of ids) render(id);
    // push the view only when the agent list actually changed (notify is cheap but
    // the view re-render isn't; 1s ticks otherwise repaint pointlessly)
    if (views.size) {
      const snap = JSON.stringify(agentList());
      if (snap !== lastSnapshot) {
        lastSnapshot = snap;
        for (const view of views) {
          try {
            view.notify(stateUri);
          } catch {
            // a dead view must not break the poll loop
          }
        }
      }
    }
  };

  const timer = setInterval(() => void tick(), POLL_MS);
  if (timer.unref) timer.unref();

  // ---- subagents side-pane view: live list, same data as the chip ----
  const agentList = () =>
    [...agents.values()]
      .filter(
        (a) =>
          a.running ||
          Date.now() - (a.lastCompletedAt || 0) < SUB_GRACE_MS ||
          a.rounds > 0, // anything measured since activation stays listed until deactivate
      )
      .map((a) => ({
        agentId: a.meta?.agentId ?? null,
        agentIdShort: a.meta?.agentId ? `…${a.meta.agentId.slice(-8)}` : null,
        parentShort: a.parentSessionId ? `…${a.parentSessionId.slice(-6)}` : null,
        description: a.description,
        status: a.status,
        running: !!a.running,
        recent: !a.running && Date.now() - (a.lastCompletedAt || 0) < SUB_GRACE_MS,
        lastRate: a.lastRate,
        outTotal: a.outTotal,
        rounds: a.rounds,
        model: a.model,
        lastCompletedAt: a.lastCompletedAt || null,
      }))
      .sort((x, y) => (y.lastCompletedAt ?? 0) - (x.lastCompletedAt ?? 0))
      .slice(0, 50);

  ctx.views.register("subagents", {
    entry: "./view.html",
    onDidOpen: (view) => {
      views.add(view);
      ctx.log.info(`TOKEN_SPEED didOpen view=${view.id}`);
      view.onDidClose(() => views.delete(view));
    },
    tools: {
      list: {
        description: "All known subagents with live per-call tok/s, totals and status",
        inputSchema: { type: "object", properties: {} },
        run: async () => ({ agents: agentList() }),
      },
    },
    resources: {
      [stateUri]: {
        mimeType: "application/json",
        read: async () => JSON.stringify({ revision: Date.now() }),
      },
    },
  });

  // chip click opens the panel (the composer.status slot targets the "open" command)
  ctx.commands.register("open", async (call) => {
    const scope = call.scope.kind === "session" ? { sessionId: call.scope.sessionId } : undefined;
    await ctx.views.open("subagents", scope);
  });

  ctx.log.info(`TOKEN_SPEED activated v${ctx.extension.version}`);
}

export async function deactivate() {}
