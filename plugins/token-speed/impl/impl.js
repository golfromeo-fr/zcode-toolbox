// token-speed: composer chip with the live output tokens-per-second.
// Only consumes models.onDidGenerate (generation metrics) — no context.get, no fs:
// streaming rate every 500ms while generating, accurate final rate afterwards.
// Chip text is compact (shell truncates composer.status at max-w-40).
const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

export async function activate(ctx) {
  const sessions = new Map(); // sessionId -> streaming state

  const update = (sessionId) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    let text;
    if (s.streaming && s.streamingTokS != null) {
      text = `${s.streamingTokS.toFixed(1)}t/s`;
    } else if (s.last != null) {
      text = `(${s.last.toFixed(1)}t/s)`;
    } else {
      return;
    }
    const tooltipParts = [
      `v${ctx.extension.version}`,
      s.model,
      s.streaming
        ? `${s.streamingTokS.toFixed(1)} tok/s`
        : `last ${s.last.toFixed(1)} tok/s`,
      s.ttft != null ? `ttft ${Math.round(s.ttft)}ms` : null,
      s.outTotal ? `out ${fmtK(s.outTotal)} tok · ${s.rounds} calls` : null,
    ].filter(Boolean);
    try {
      ctx.slots.update("speed", { text, tooltip: tooltipParts.join(" · ").slice(0, 200) }, { sessionId });
    } catch {
      // slot updates must never break the event path
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
    update(m.sessionId);
  });

  ctx.commands.register("ping", async () => {
    ctx.log.info(`TOKEN_SPEED ping v${ctx.extension.version}`);
  });
  ctx.log.info(`TOKEN_SPEED activated v${ctx.extension.version}`);
}

export async function deactivate() {}
