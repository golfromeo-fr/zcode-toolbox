// copilot-gateway in-process impl: composer chip + side-pane gateway view.
// Chip: up/down + latency, tooltip with accounts/keys/credits; polls
// gatewayStatus() every 5s (healthz 1.5s timeout, usage cached 10s inside
// gateway.js). A service has no session events, so chip scope comes from
// ctx.workbench.visibleSessions() each tick.
import {
  gatewayStatus, gatewayStart, gatewayStop, gatewayUpdate, gatewayLogin, loginState,
  keysMeta, keyCreate, keyRevoke, keySetPin, gatewayUse, gatewayConfig,
} from "./gateway.js";

const POLL_MS = 5000;
let timer = null;

export async function activate(ctx) {
  const rendered = new Map(); // sessionId -> last chip payload (skip no-op updates)
  const views = new Set(); // open "gateway" view instances
  let lastSnapshot = ""; // serialized status; change-detects view notifications
  const stateUri = `ui://${ctx.extension.id}/state`;

  const chipFor = (st) => {
    if (!st || st.up === false) {
      return { text: "gw down", tooltip: `copilot-gateway v${ctx.extension.version} · gateway not responding` };
    }
    const tt = st.usage?.totals ?? {};
    const credits = typeof tt.credits === "number" ? tt.credits.toFixed(1) : "?";
    const cost = typeof tt.cost_usd === "number" ? `$${tt.cost_usd.toFixed(2)}` : "?";
    const parts = [
      `copilot-gateway v${ctx.extension.version}`,
      st.baseUrl,
      st.accounts.length ? `acct ${st.accounts.map((a) => (a.active ? "★" : "") + a.label).join(",")}` : "no accounts",
      `keys ${st.keys.length}`,
      `credits ${credits} (${cost})`,
      `req ${tt.requests ?? "?"}`,
    ];
    return {
      text: `gw ${st.latencyMs ?? "?"}ms`,
      tooltip: parts.join(" · ").slice(0, 200),
    };
  };

  const renderChip = (sessionId, st) => {
    const payload = chipFor(st);
    const prev = rendered.get(sessionId);
    if (prev && prev.text === payload.text && prev.tooltip === payload.tooltip) return;
    rendered.set(sessionId, payload);
    try {
      ctx.slots.update("gateway", payload, { sessionId });
    } catch {
      // slot updates must never break the poll loop
    }
  };
  const tick = async () => {
    let st = null;
    try {
      st = await gatewayStatus();
    } catch {
      st = null; // render down-state on transient control-layer errors
    }
    for (const s of (await ctx.workbench.visibleSessions().catch(() => [])) ?? []) {
      if (s.sessionId) renderChip(s.sessionId, st);
    }
    const snap = JSON.stringify(st ?? { down: true });
    if (views.size && snap !== lastSnapshot) {
      lastSnapshot = snap;
      for (const view of views) {
        try {
          view.notify(stateUri);
        } catch {
          // a dead view must not break the poll loop
        }
      }
    }
  };

  timer = setInterval(() => void tick(), POLL_MS);
  if (timer.unref) timer.unref();
  const viewTools = {
    status: {
      description: "Full gateway status: up/latency, accounts, keys, credits totals + recent calls",
      inputSchema: { type: "object", properties: {} },
      run: () => gatewayStatus(),
    },
    start: {
      description: "Start the gateway (first run clones from GitHub + installs, ~20s)",
      inputSchema: { type: "object", properties: {} },
      run: () => gatewayStart(),
    },
    stop: {
      description: "Stop the gateway service",
      inputSchema: { type: "object", properties: {} },
      run: () => gatewayStop(),
    },
    login: {
      description: "Start GitHub device-flow login; returns one-time code + URL",
      inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
      run: (a) => gatewayLogin(String(a?.label ?? "")),
    },
    loginCheck: {
      description: "Check a pending login: awaiting-authorization / connected / failed",
      inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
      run: (a) => loginState(String(a?.label ?? "")),
    },
    keyCreate: {
      description: "Create a proxy key; raw value returned once",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: (a) => keyCreate(String(a?.name ?? "")),
    },
    keyRevoke: {
      description: "Revoke a proxy key by name",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: (a) => keyRevoke(String(a?.name ?? "")),
    },
    keyPin: {
      description: "Pin/clear a key→account connection",
      inputSchema: { type: "object", properties: { name: { type: "string" }, label: { type: "string" } } },
      run: (a) => keySetPin(String(a?.name ?? ""), a?.label ? String(a.label) : null),
    },
    config: {
      description: "Regenerate provider config for an existing key (placeholder apiKey)",
      inputSchema: { type: "object", properties: { keyName: { type: "string" } } },
      run: (a) => gatewayConfig(a?.keyName ? String(a.keyName) : "zcode"),
    },
    use: {
      description: "New key + its provider config (raw key shown once)",
      inputSchema: { type: "object", properties: { keyName: { type: "string" } } },
      run: (a) => gatewayUse(a?.keyName ? String(a.keyName) : "zcode"),
    },
    update: {
      description: "Update the gateway git tree (fetch, reset to origin/main, pip install, restart if running)",
      inputSchema: { type: "object", properties: {} },
      run: () => gatewayUpdate(),
    },
  };
  ctx.views.register("gateway", {
    entry: "./view.html",
    onDidOpen: (view) => {
      views.add(view);
      ctx.log.info(`COPILOT_GATEWAY didOpen view=${view.id}`);
      view.onDidClose(() => views.delete(view));
    },
    tools: viewTools,
    resources: {
      [stateUri]: {
        mimeType: "application/json",
        read: async () => JSON.stringify({ revision: Date.now() }),
      },
    },
  });

  ctx.commands.register("open", async (call) => {
    const scope = call.scope.kind === "session" ? { sessionId: call.scope.sessionId } : undefined;
    await ctx.views.open("gateway", scope);
  });

  ctx.log.info(`COPILOT_GATEWAY activated v${ctx.extension.version}`);
}

export async function deactivate() {
  if (timer) clearInterval(timer);
  timer = null;
}
