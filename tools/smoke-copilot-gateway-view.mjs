// Runtime smoke for the copilot-gateway view.
//
// Runs the real <script> from plugins/copilot-gateway/view.html under
// browser-faithful stubs (window === globalThis, a zcode-only bridge, elements
// that record event listeners) and drives the paths that only run on click or
// refresh. `node --check` cannot catch these: 0.1.3 shipped stale identifiers
// and 0.2.1 a duplicate element id, both parse-clean.
//
//   node tools/smoke-copilot-gateway-view.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../plugins/copilot-gateway/view.html", import.meta.url), "utf8");
const ids = [...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]);
assert.equal(new Set(ids).size, ids.length, `duplicate element ids: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
// the address is whatever GitHub returns with a code: the view must not carry a default
assert.doesNotMatch(html, /github\.com\/login\/device/, "view hard-codes the device address");

// the manifest and the marketplace entry must advertise the same version
{
  const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
  const manifest = read("../plugins/copilot-gateway/.zcode-plugin/plugin.json").version;
  const entry = read("../marketplace.json").plugins.find((e) => e["name"] === "copilot-gateway").version;
  assert.equal(entry, manifest, `marketplace entry ${entry} != manifest ${manifest}`);
}

// ---- stubs ----
const els = new Map();
const el = (id) => {
  if (!els.has(id)) {
    els.set(id, {
      textContent: "", innerHTML: "", hidden: false, style: {}, dataset: {}, value: "", disabled: false,
      handlers: {},
      addEventListener(type, fn) { this.handlers[type] = fn; },
      focus() { this.focused = true; },
      select() { this.selected = true; },
    });
  }
  return els.get(id);
};
// button labels come from the markup, which the stubs do not parse
for (const m of html.matchAll(/<button id="([\w-]+)"[^>]*>([^<]*)<\/button>/g)) el(m[1]).textContent = m[2];
// elements marked hidden in the markup start hidden
for (const m of html.matchAll(/<\w+[^>]*\bid="([\w-]+)"[^>]*\bhidden\b[^>]*>/g)) el(m[1]).hidden = true;

const docHandlers = {};
const calls = [];
let copied = null; // last text that reached a clipboard
let clipboard = null; // null: no async clipboard API
let legacyCopy = null; // null: no legacy execCommand path
let status = null;
const tools = {};
const bridge = {
  subscribe() {},
  ready: async () => {},
  onResourceUpdated(fn) { bridge.updated = fn; },
  listResources: async () => ({ resources: [{ uri: "ui://copilot-gateway/state" }] }),
  subscribeResource: async () => {},
  callTool(name, args) {
    calls.push([name, args]);
    return Promise.resolve(tools[name] ? tools[name](args ?? {}) : undefined);
  },
  locale: "en",
  theme: "dark",
  hostContext: { styles: { variables: {} } },
};

globalThis.window = globalThis;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  get: () => ({ get clipboard() { return clipboard; } }),
});
Object.assign(globalThis, {
  zcode: bridge,
  confirm: () => true,
  prompt: () => "zcode",
  document: {
    getElementById: (id) => el(id),
    querySelectorAll: () => [],
    createElement: () => ({ value: "", style: {}, setAttribute() {}, select() {}, remove() {} }),
    body: { appendChild() {} },
    execCommand: (cmd) => (legacyCopy ? legacyCopy(cmd) : undefined),
    addEventListener: (type, fn) => { (docHandlers[type] ??= []).push(fn); },
    documentElement: { style: { setProperty() {} }, dataset: {} },
  },
});

// ---- helpers ----
const settle = () => new Promise((r) => setTimeout(r, 30));
const click = async (id) => {
  assert.ok(el(id).handlers.click, `${id} has no click handler`);
  await el(id).handlers.click({ target: { closest: () => null } });
  await settle();
};
const documentClick = async (target) => {
  for (const fn of docHandlers.click ?? []) await fn({ target: { closest: (sel) => (sel === ".copycode" ? target : null) } });
  await settle();
};
const refresh = async (st) => {
  status = st;
  await bridge.updated("ui://copilot-gateway/state");
  await settle();
};
const base = (over = {}) => ({
  up: false, latencyMs: null, baseUrl: "http://127.0.0.1:8812", venvOk: false, git: { cloned: false },
  accounts: [], keys: [], pendingLogins: [], usage: { totals: null, recent: [] }, ...over,
});
const pending = (phase, extra = {}) => [{ phase, label: "work", url: "https://github.com/login/device", ...extra }];
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
  } catch (e) {
    console.error(`FAILED: ${name}\n${e.stack ?? e}`);
    process.exit(1);
  }
  passed += 1;
}

// ---- load ----
tools.status = () => status;
status = base();
await import("data:text/javascript," + encodeURIComponent(script));
await settle();

await check("load: gateway not installed yet", async () => {
  assert.equal(el("cards").hidden, false);
  assert.equal(el("empty").hidden, false);
  assert.match(el("empty").textContent, /not installed yet/);
  assert.equal(el("btn-start").textContent, "start");
  assert.match(el("updated").textContent, /bridge zcode/);
  assert.deepEqual(calls, [["status", {}]]);
  assert.equal(el("login-flow").hidden, true);
});

await check("start button follows the current state", async () => {
  const seqFrom = (n) => calls.slice(n).map((c) => c[0]);
  tools.start = () => ({ ok: true, up: true, latencyMs: 24, installed: true });
  let n = calls.length;
  await click("btn-start");
  assert.deepEqual(seqFrom(n), ["status", "start", "status"]);
  assert.match(el("use-out").textContent, /gateway up \(24ms\) · freshly installed/);
  status = base({ up: true, venvOk: true, latencyMs: 24 });
  tools.stop = () => ({ ok: true, up: false });
  n = calls.length;
  await click("btn-start");
  assert.deepEqual(seqFrom(n), ["status", "stop", "status"]);
  assert.match(el("use-out").textContent, /gateway stopped/);
});

const login = (extra = {}) => ({ ok: true, phase: "awaiting-authorization", label: "work", code: "ABCD-1234", url: "https://github.com/login/device", ...extra });

await check("login: address and code shown as text when no browser opened", async () => {
  tools.login = () => login({ openedInBrowser: false });
  el("login-label").value = "work";
  await click("btn-login");
  assert.deepEqual(calls.find((c) => c[0] === "login"), ["login", { label: "work" }]);
  assert.equal(el("login-flow").hidden, false);
  assert.equal(el("login-url").value, "https://github.com/login/device");
  assert.equal(el("login-code").value, "ABCD-1234");
  assert.match(el("login-msg").textContent, /Type the address in any browser/);
  assert.equal(el("btn-login").textContent, "login…");
  assert.equal(el("btn-login").disabled, false);
});

await check("login: message when a browser did open", async () => {
  tools.login = () => login({ code: "WXYZ-5678", openedInBrowser: true });
  await click("btn-login");
  assert.match(el("login-msg").textContent, /browser page was opened/);
  assert.equal(el("login-code").value, "WXYZ-5678");
});

await check("login: a failure from the tool is reported", async () => {
  tools.login = () => ({ ok: false, error: "no python >= 3.12 found" });
  await click("btn-login");
  assert.equal(el("login-code").value, "");
  assert.match(el("login-msg").textContent, /Login failed: no python/);
});

await check("copy: no clipboard at all says so and selects the code", async () => {
  tools.login = () => login({ openedInBrowser: false });
  await click("btn-login");
  await click("btn-copy-code");
  assert.equal(copied, null);
  assert.equal(el("btn-copy-code").textContent, "not copied — type it");
  assert.equal(el("login-code").selected, true);
});

await check("copy: legacy path", async () => {
  legacyCopy = () => { copied = "legacy"; return true; };
  await click("btn-copy-code");
  assert.equal(copied, "legacy");
  assert.equal(el("btn-copy-code").textContent, "copied");
});

await check("copy: async clipboard API, address and code", async () => {
  legacyCopy = () => { throw new Error("legacy path must not be used"); };
  clipboard = { writeText: async (t) => { copied = t; } };
  await click("btn-copy-code");
  assert.equal(copied, "ABCD-1234");
  await click("btn-copy-url");
  assert.equal(copied, "https://github.com/login/device");
});

await check("refresh keeps a pending code on display", async () => {
  await refresh(base({ pendingLogins: pending("awaiting-authorization", { code: "ABCD-1234" }) }));
  assert.equal(el("login-code").value, "ABCD-1234");
  assert.equal(el("card-logins").hidden, false);
  assert.match(el("logins").innerHTML, /ABCD-1234/);
});

await check("refresh: no address returned with the code says so, no guess", async () => {
  await refresh(base({ pendingLogins: [{ phase: "awaiting-authorization", label: "work", code: "ABCD-1234" }] }));
  assert.equal(el("login-url").value, "");
  assert.equal(el("login-code").value, "ABCD-1234");
  assert.match(el("login-msg").textContent, /No address came back/);
});

await check("pending list: click the code to copy it", async () => {
  const codeEl = { dataset: { code: "ABCD-1234" }, textContent: "ABCD-1234" };
  await documentClick(codeEl);
  assert.equal(copied, "ABCD-1234");
  assert.equal(codeEl.textContent, "copied");
});

await check("refresh reports an expired code instead of offering it", async () => {
  await refresh(base({ pendingLogins: pending("expired", { code: "ABCD-1234" }) }));
  assert.equal(el("login-code").value, "");
  assert.match(el("login-msg").textContent, /expired/);
  assert.match(el("logins").innerHTML, /code expired/);
  assert.doesNotMatch(el("logins").innerHTML, /ABCD-1234/);
});

await check("refresh surfaces a failed start with its log tail", async () => {
  await refresh(base({ pendingLogins: pending("failed", { logTail: "httpx.ConnectError: boom" }) }));
  assert.match(el("login-msg").textContent, /Login failed/);
  assert.match(el("login-msg").textContent, /boom/);
});

await check("refresh marks the account connected", async () => {
  await refresh(base({ accounts: [{ label: "work", active: true, api_endpoint: "https://api.example" }] }));
  assert.match(el("login-msg").textContent, /Connected as 'work'/);
  assert.equal(el("card-accounts").hidden, false);
});

await check("config: output and its sticky copy button", async () => {
  const provider = { baseUrl: "http://127.0.0.1:8812/v1", apiKey: "<value>", models: [{ id: "m", vision: true }] };
  tools.config = () => ({ ok: true, apiKey: "<value>", note: "n", provider });
  await click("btn-config");
  assert.deepEqual(calls.at(-1), ["config", {}]);
  assert.equal(el("use-wrap").hidden, false);
  assert.match(el("use-out").textContent, /PROVIDER/);
  assert.equal(el("btn-copy-config").textContent, "copy");
  await click("btn-copy-config");
  assert.equal(copied, el("use-out").textContent);
  assert.equal(el("btn-copy-config").textContent, "copied");
});

assert.equal(el("errors").textContent, "", "view reported a runtime error");
console.log(`copilot-gateway view smoke: ${passed} checks passed`);
process.exit(0);
