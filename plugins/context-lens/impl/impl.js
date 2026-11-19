// context-lens: live viewer for the LLM context window.
//
// L1 (contract): ctx.context.get — composition categories (names + sizes), model,
//   context window. Always available; survives updates.
// L2 (best-effort): model-io JSONL (lib/model-io.js) — full system prompt, tool
//   schemas, message bodies. Degrades to L1-only when unavailable.
// Session resolution: page pick > focused > first visible (ctx.workbench).
// Refresh is event-driven only (no polling).
import { loadLog, CAPS } from "../lib/model-io.js";
import { capText, messageText, clampInt } from "../lib/content.js";

const MESSAGES_WINDOW_DEFAULT = 30;
const TOOLS_PAGE = 40;

// Resolve the session a view instance should show.
function resolveSessionFromList(sessions, requested) {
  if (requested) {
    const pinned = sessions.find((s) => s.sessionId === requested);
    if (pinned) return { sessionId: requested, source: "pinned" };
    return { sessionId: requested, source: "pinned-stale" };
  }
  const focused = sessions.find((s) => s.focused && !s.isDraft);
  if (focused) return { sessionId: focused.sessionId, source: "focused" };
  const visible = sessions.find((s) => s.sessionId && !s.isDraft);
  if (visible) return { sessionId: visible.sessionId, source: "visible" };
  return null;
}
// Cap one message for transport: body capped per content part.
function capMessage(msg) {
  const content = msg?.content;
  let truncated = false;
  const capStr = (s) => {
    const r = capText(s, CAPS.messageBody);
    truncated = truncated || r.truncated;
    return r.text;
  };
  let capped = content;
  if (typeof content === "string") {
    capped = capStr(content);
  } else if (Array.isArray(content)) {
    capped = content.map((part) => {
      if (typeof part === "string") return capStr(part);
      if (part?.type === "text" || part?.type === "thinking") {
        const key = part.type === "text" ? "text" : "thinking";
        const r = capText(part[key] ?? "", CAPS.messageBody);
        truncated = truncated || r.truncated;
        return { ...part, [key]: r.text };
      }
      return part;
    });
  }
  return { ...msg, content: capped, bodyTruncated: truncated };
}

export async function activate(ctx) {
  const stateUri = `ui://${ctx.extension.id}/state`;
  const views = new Set();
  const notify = (sessionId) => {
    for (const view of views) {
      if (!sessionId || view.sessionId === sessionId) view.notify(stateUri);
    }
  };
  const track = (view) => {
    views.add(view);
    ctx.log.info(`CONTEXT_LENS didOpen instance=${view.id} scope=${view.scope.kind}`);
    view.onDidClose(() => views.delete(view));
  };

  // Latest known composition per session (for the status chip + view header).
  const compBySession = new Map();
  const refreshComposition = async (sessionId) => {
    try {
      compBySession.set(sessionId, await ctx.context.get({ sessionId }));
    } catch {
      compBySession.delete(sessionId);
    }
    updateStatusChip(sessionId);
    notify(sessionId);
  };
  ctx.context.onDidChange((event) => {
    ctx.log.info(`CONTEXT_LENS changed sessionId=${event.sessionId} revision=${event.revision}`);
    void refreshComposition(event.sessionId);
  });
  ctx.workbench.onDidChange((event) => {
    ctx.log.info(
      `CONTEXT_LENS workbench ${JSON.stringify(
        event.sessions.map(({ sessionId, focused }) => ({ sessionId, focused })),
      )}`,
    );
    notify();
  });

  // ---- status chip (composer.status): tok/s + context usage + cumulative out ----
  const gen = new Map(); // sessionId -> { outTotal, rounds, lastTokS, lastTtft }
  const fmtK = (n) =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
  const updateStatusChip = (sessionId, streamingTokS) => {
    const s = gen.get(sessionId) ?? { outTotal: 0, rounds: 0 };
    const comp = compBySession.get(sessionId);
    // 与官方圆环同一口径：只信 provider usage（input 含 cache + output）。
    // estimatedTokens 是 (CJK×2 + other)/3 的字符估算，实测偏高约 2×——宁可不显示也不显示错数。
    const used = comp?.providerContextTokens ?? null;
    const window = comp?.model?.contextWindow ?? null;
    const pct = used != null && window ? Math.round((used / window) * 100) : null;
    const warn = pct != null && pct >= 85;
    // 壳层在 max-w-40 处 CSS 截断（DESIGN.md composer.status），文本必须紧凑：
    // 分隔符用空格不用 " · "，tok/s 无空格单位，est 标记并入百分比段。
    const lastTokS = s.lastTokS ? `${s.lastTokS.toFixed(1)}t/s` : null;
    // cache % 仅在 provider 口径时显示（inputTokens 已含 cache，命中率 = cacheRead/input）。
    const cachePct = s.lastCachePct != null ? `c${Math.round(s.lastCachePct)}%` : null;
    let text;
    if (streamingTokS) {
      text = `${streamingTokS.toFixed(1)}t/s${pct != null ? ` ${pct}%` : ""}`;
    } else {
      const pctPart = pct != null ? `${warn ? "⚠" : ""}${pct}%` : null;
      const outPart = s.outTotal ? `↓${fmtK(s.outTotal)}` : null;
      const tokPart = lastTokS ? `(${lastTokS})` : null;
      text = [pctPart, cachePct, outPart, tokPart].filter(Boolean).join(" ");
      if (!text) return;
    }
    if (text.length > 40) text = text.slice(0, 40);
    const tooltipParts = [
      `v${ctx.extension.version}`,
      comp?.model?.modelId,
      pct != null ? `context ${pct}% (${fmtK(used)} provider / ${fmtK(window)})` : null,
      s.inTotal ? `in ${fmtK(s.inTotal)} tok` : null,
      s.lastCachePct != null ? `cache hit ${Math.round(s.lastCachePct)}%` : null,
      s.outTotal ? `out ${fmtK(s.outTotal)} tok · ${s.rounds} calls` : null,
      s.query ? `turn: ↓${fmtK(s.query.out)} ↑${fmtK(s.query.in)}${s.query.cachePct != null ? ` · cache ${s.query.cachePct}%` : ""}` : null,
      s.lastTokS ? `last ${s.lastTokS.toFixed(1)} tok/s` : null,
      s.lastTtft ? `ttft ${Math.round(s.lastTtft)}ms` : null,
    ].filter(Boolean);
    try {
      ctx.slots.update(
        "status",
        {
          text,
          tooltip: tooltipParts.join(" · ").slice(0, 200),
          badge: pct != null && pct >= 80 ? "dot" : undefined,
        },
        { sessionId },
      );
    } catch {
      // slot updates must never break the notify path
    }
  };
  ctx.models.onDidGenerate((m) => {
    const s =
      gen.get(m.sessionId) ??
      { outTotal: 0, rounds: 0, streaming: false, inTotal: 0, lastCachePct: null, query: null };
    s.streaming = m.phase === "streaming";
    if (m.phase === "final") {
      if (m.outputTokens) {
        s.outTotal += m.outputTokens;
        s.rounds += 1;
      }
      // Phase 2 字段（spec §10）：inputTokens 已含 cache read/write（AI SDK v6 Anthropic 口径），
      // 命中率 = cacheReadTokens / inputTokens；queryId 标记轮次边界（一次用户输入一个）。
      if (m.inputTokens) s.inTotal += m.inputTokens;
      if (m.inputTokens && m.cacheReadTokens != null) {
        s.lastCachePct = Math.round((m.cacheReadTokens / m.inputTokens) * 100);
      }
      if (m.queryId) {
        if (!s.query || s.query.id !== m.queryId) {
          s.query = { id: m.queryId, out: 0, in: 0, cachePct: null };
        }
        if (m.outputTokens) s.query.out += m.outputTokens;
        if (m.inputTokens) s.query.in = m.inputTokens;
        if (m.inputTokens && m.cacheReadTokens != null) {
          s.query.cachePct = Math.round((m.cacheReadTokens / m.inputTokens) * 100);
        }
      }
    }
    if (m.outputTokensPerSecond) s.lastTokS = m.outputTokensPerSecond;
    if (m.timeToFirstTokenMs) s.lastTtft = m.timeToFirstTokenMs;
    gen.set(m.sessionId, s);
    updateStatusChip(m.sessionId, m.phase === "streaming" ? m.outputTokensPerSecond : undefined);
  });

  ctx.commands.register("open", async (call) => {
    const scope = call.scope.kind === "session" ? { sessionId: call.scope.sessionId } : undefined;
    await ctx.views.open("context", scope);
  });

  ctx.views.register("context", {
    entry: "./view.html",
    onDidOpen: track,
    tools: {
      snapshot: {
        description:
          "Composition (L1) + on-screen sessions + model-io log health for the session",
        inputSchema: { type: "object", properties: { sessionId: { type: "string" } } },
        run: async (input, call) => {
          const sessions = await ctx.workbench.visibleSessions();
          const resolved = resolveSessionFromList(sessions, input?.sessionId ?? null);
          const composition = resolved
            ? await ctx.context.get({ sessionId: resolved.sessionId }).catch(() => null)
            : null;
          let log = null;
          if (resolved) {
            const entry = await loadLog(resolved.sessionId);
            log = entry
              ? { available: true, ...entry.meta }
              : { available: false, reason: "no model-io file for this session" };
          }
          return {
            snapshot: 1,
            version: ctx.extension.version,
            composition,
            sessions,
            resolved: resolved?.sessionId ?? null,
            resolution: resolved?.source ?? "none",
            log,
            gen: resolved ? gen.get(resolved.sessionId) ?? null : null,
            instance: call.view.id,
          };
        },
      },
      content: {
        description:
          "Full context content (L2): system blocks, tool schemas or message window",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            what: { type: "string", enum: ["system", "tools", "messages"] },
            endOffset: { type: "number", description: "exclusive end index for the window" },
            limit: { type: "number" },
            offset: { type: "number", description: "tools page offset" },
            search: { type: "string" },
        },
      },
        run: async (input, call) => {
          const sessions = await ctx.workbench.visibleSessions();
          const resolved = resolveSessionFromList(sessions, input?.sessionId ?? null);
          if (!resolved) return { error: "no-session" };
          const entry = await loadLog(resolved.sessionId);
          if (!entry) return { error: "no-log", sessionId: resolved.sessionId };
          const { records, stitched, meta } = entry;
          const what = input?.what ?? "messages";
          const search = typeof input?.search === "string" ? input.search.toLowerCase() : "";
          if (what === "system") {
            for (let i = records.length - 1; i >= 0; i -= 1) {
              const sys = records[i]?.request?.body?.system;
              if (Array.isArray(sys) && sys.length) {
                return {
                  what,
                  sessionId: resolved.sessionId,
                  blocks: sys.map((b) => capText(b?.text ?? "", CAPS.systemBlock)),
                  recordIndex: i,
                };
              }
            }
            return { what, sessionId: resolved.sessionId, blocks: [] };
          }
          if (what === "tools") {
            for (let i = records.length - 1; i >= 0; i -= 1) {
              const tools = records[i]?.request?.body?.tools;
              if (Array.isArray(tools) && tools.length) {
                const start = clampInt(input?.offset, 0, Number.MAX_SAFE_INTEGER, 0);
                const page = tools.slice(start, start + TOOLS_PAGE);
                return {
                  what,
                  sessionId: resolved.sessionId,
                  total: tools.length,
                  offset: start,
                  tools: page.map((t) => ({
                    name: t?.name ?? "(unnamed)",
                    description: capText(t?.description ?? "", CAPS.toolSchema),
                    schema: capText(JSON.stringify(t), CAPS.toolSchema),
                  })),
                };
            }
          }
              }
          // messages: windowed from the end; search reports match count across all
          const all = stitched.messages;
          const limit = clampInt(input?.limit, 1, 100, 30);
          let end = clampInt(input?.endOffset, 1, all.length, all.length);
          let source = all;
          let matchedCount;
          if (search) {
            const filtered = all.filter((m) => messageText(m).toLowerCase().includes(search));
            matchedCount = filtered.length;
            source = filtered;
          }
          return {
            what: "messages",
            sessionId: resolved.sessionId,
            total: all.length,
            matched: matchedCount,
            end: end,
            messages: source.slice(Math.max(0, end - limit), end).map(capMessage),
          };
        },
      },
    },
      resources: {
        [stateUri]: {
          mimeType: "application/json",
          read: async () => JSON.stringify({ revision: Date.now() }),
        },
      },
    });
    ctx.log.info("CONTEXT_LENS activated");
}

export function deactivate() {}
