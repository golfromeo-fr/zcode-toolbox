#!/usr/bin/env node
// copilot-gateway MCP server: exposes the local crispy-copilot-gateway
// control plane as MCP tools over stdio (zero-dep, line-delimited JSON-RPC
// 2.0). Launched from the plugin manifest's mcpServers entry.
import { gatewayStatus, gatewayStart, gatewayStop, gatewayUpdate, gatewayLogin, loginState,
         keysMeta, keyCreate, keyRevoke, keySetPin, gatewayUse, gatewayConfig, usageData,
         connections, listPendingLogins } from "./gateway.js";

const VERSION = "0.1.0";

// ---- tool registry ----

// ---- protocol plumbing ----
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    handleLine(line).catch((e) => {
      process.stderr.write(`copilot-gateway mcp: ${String(e).slice(0, 300)}\n`);
    });
  }
});

// Tools mutate shared gateway state via read-modify-write files/CLI — run
// strictly one at a time so parallel harness calls can't race each other.
let queueTail = Promise.resolve();
function enqueue(fn) {
  const next = queueTail.then(fn, fn);
  queueTail = next.catch(() => {});
  return next;
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handleLine(line) {
  const msg = JSON.parse(line);
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return;
  if (msg.id === undefined || msg.id === null) return; // notification: no reply
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "copilot-gateway", version: VERSION },
      },
    });
    return;
  }
  if (msg.method === "ping") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0", id: msg.id,
      result: {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    });
    return;
  }
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    const t = TOOLS[name];
    if (!t) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool: ${name}` } });
      return;
    }
    try {
      const out = await enqueue(() => t.run(args));
      send({
        jsonrpc: "2.0", id: msg.id,
        result: { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 1) }] },
      });
    } catch (e) {
      send({
        jsonrpc: "2.0", id: msg.id,
        result: { isError: true, content: [{ type: "text", text: String(e).slice(0, 400) }] },
      });
    }
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
}
const obj = (props, req = null) => ({ type: "object", properties: props, required: req ?? [] });
const s = (desc) => ({ type: "string", description: desc });

const TOOLS = {
  gateway_status: {
    description: "Local Copilot gateway: up/down + latency, connected GitHub accounts (active flagged), proxy keys (metadata only), credits metering totals + recent calls.",
    inputSchema: obj({}),
    run: () => gatewayStatus(),
  },
  gateway_start: {
    description: "Start the gateway. First run clones it from GitHub and installs it (git, python>=3.12, network once). An installed gateway older than this extension needs is updated first on a plugin-managed install, or started without the newer feature; the result says which. No-op when already up. Always relay its message, notes, error and detail.",
    inputSchema: obj({}),
    run: () => gatewayStart(),
  },
  gateway_stop: {
    description: "Stop the gateway this extension started, and nothing else. When the gateway is not running or something else answers on the port, nothing is signalled and the result says so.",
    inputSchema: obj({}),
    run: () => gatewayStop(),
  },
  gateway_update: {
    description: "Update the plugin-managed gateway to the latest on its main branch: fetch, reset, reinstall, restart if it was running. Never changes an external gateway_path checkout; returns the command to run there instead. A step that cannot run is an error, never 'already on latest'.",
    inputSchema: obj({}),
    run: () => gatewayUpdate(),
  },
  gateway_login: {
    description: "Begin GitHub OAuth device flow: returns the one-time code + URL, then finishes in the background. Check with gateway_login_check.",
    inputSchema: obj({ label: s("Name for the new connection, e.g. 'work'") }, ["label"]),
    run: (a) => gatewayLogin(String(a.label ?? "")),
  },
  gateway_login_check: {
    description: "Status of a device-flow login: awaiting-authorization (code + URL), connected, failed.",
    inputSchema: obj({ label: s("Connection label to check") }, ["label"]),
    run: (a) => loginState(String(a.label ?? "")),
  },
  gateway_keys: {
    description: "List proxy keys (name, created, last_used, account pin). Metadata only — raw keys are never recoverable.",
    inputSchema: obj({}),
    run: () => keysMeta(),
  },
  gateway_key_create: {
    description: "Create a proxy key (ck_...): the raw key is returned ONCE - save it. Errors when the name already exists.",
    inputSchema: obj({ name: s("Key name to create, e.g. 'zcode'") }, ["name"]),
    run: (a) => keyCreate(String(a.name ?? "")),
  },
  gateway_key_revoke: {
    description: "Revoke a proxy key by name. The gateway rejects it immediately.",
    inputSchema: obj({ name: s("Key name to revoke") }, ["name"]),
    run: (a) => keyRevoke(String(a.name ?? "")),
  },
  gateway_key_pin: {
    description: "Pin a key to a connection label (routes that harness to that GitHub account), or clear the pin when label is omitted.",
    inputSchema: obj({ name: s("Key name"), label: s("Connection label, or omit to unpin") }),
    run: (a) => keySetPin(String(a.name ?? ""), a.label ? String(a.label) : null),
  },
  gateway_config: {
    description: "Regenerate the provider config for an EXISTING key (default 'zcode'): baseUrl + full capability-rich model list; apiKey comes back as a placeholder (paste your saved value). Use when the harness is already connected.",
    inputSchema: obj({ keyName: s("Existing proxy key name (default zcode)") }),
    run: (a) => gatewayConfig(a.keyName ? String(a.keyName) : "zcode"),
  },
  gateway_use: {
    description: "First-time wiring: creates proxy key <keyName> (default 'zcode') and returns baseUrl + raw key (shown ONCE) + full model list for provider config. Errors when the name exists - use gateway_config then.",
    inputSchema: obj({ keyName: s("Proxy key name to find or create (default zcode)") }),
    run: (a) => gatewayUse(a.keyName ? String(a.keyName) : "zcode"),
  },
  gateway_credits: {
    description: "Copilot credits metering: totals + per-call recent rows (key, model, tokens, nano_aiu credits, usd).",
    inputSchema: obj({ limit: { type: "integer", description: "Recent rows to include (default 8)" } }),
    run: (a) => usageData(Math.min(Number(a.limit) || 8, 100)),
  },
};
