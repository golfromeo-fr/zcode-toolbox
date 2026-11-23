// copilot-gateway control layer: one source of truth for the local
// crispy-copilot-gateway service, shared by the view impl and the MCP server.
// Local-only surface: GET /healthz (unauthenticated), 0600 state files
// (secrets stripped on read), and the gateway venv CLI. GitHub tokens and
// proxy-key hashes are never logged or returned.
import { readFile, writeFile, rename, chmod, appendFile, mkdir } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const APP_NAME = "crispy-copilot-gateway";
const IS_WIN = process.platform === "win32";
// venv layout differs: Scripts\ on Windows, bin/ elsewhere
function venvBin(cfg) { return join(cfg.path, ".venv", IS_WIN ? "Scripts" : "bin"); }
// gateway source is cloned from GitHub into the plugin-managed install dir
const GIT_REPO = process.env.CRISPY_GATEWAY_REPO || "https://github.com/golfromeo-fr/crispy-copilot-gateway";
const GIT_BRANCH = process.env.CRISPY_GATEWAY_BRANCH || "main";
const DEFAULT_PATH = join(homedir(), APP_NAME);
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8812;
const HEALTH_TIMEOUT_MS = 1500;
const START_TIMEOUT_MS = 20_000;
const USAGE_CACHE_MS = 10_000;

// CRISPY_GATEWAY_* env (userConfig via manifest) > gateway .env > defaults.
let cfgCache = null;
let cfgCacheAt = 0;
async function loadCfg() {
  if (cfgCache && Date.now() - cfgCacheAt < 3000) return cfgCache;
  const runtimeDir = process.env.ZCODE_PLUGIN_DATA
    || join(homedir(), ".zcode", "plugins", "copilot-gateway");
  let path = process.env.CRISPY_GATEWAY_PATH || join(runtimeDir, "gateway");
  let host = process.env.CRISPY_GATEWAY_HOST || "";
  let port = process.env.CRISPY_GATEWAY_PORT || "";
  let dataDir = process.env.CRISPY_COPILOT_DATA_DIR || "";
  try {
    const dotEnv = await readFile(join(path, ".env"), "utf8");
    for (const m of dotEnv.matchAll(/^(CRISPY_COPILOT_(DATA_DIR|HOST|PORT))=(.*)$/gm)) {
      const val = m[3].trim().replace(/^["']|["']$/g, "");
      if (!val) continue;
      if (m[2] === "DATA_DIR") dataDir = dataDir || val;
      if (m[2] === "HOST") host = host || val;
      if (m[2] === "PORT") port = port || val;
    }
  } catch {
    // no .env: defaults apply
  }
  const cfg = {
    path,
    runtimeDir,
    installDir: join(runtimeDir, "gateway"),
    host: host || DEFAULT_HOST,
    port: Number(port) || DEFAULT_PORT,
    dataDir: dataDir || join(runtimeDir, "store"),
  };
  cfg.srcDir = join(cfg.path, "src");
  cfg.cli = join(venvBin(cfg), IS_WIN ? "crispy-copilot.exe" : "crispy-copilot");
  cfg.py = join(venvBin(cfg), IS_WIN ? "python.exe" : "python");
  cfg.baseUrl = `http://${cfg.host}:${cfg.port}`;
  cfg.serveLog = join(runtimeDir, "serve.log");
  cfg.installLog = join(runtimeDir, "install.log");
  cfgCache = cfg;
  cfgCacheAt = Date.now();
  return cfg;
}
export async function healthz() {
  const cfg = await loadCfg();
  const t0 = Date.now();
  try {
    const resp = await fetch(`${cfg.baseUrl}/healthz`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return { up: resp.ok, latencyMs: resp.ok ? Date.now() - t0 : null };
  } catch {
    return { up: false, latencyMs: null };
  }
}
function bearerHeaders(rawKey) {
  return rawKey ? { authorization: `Bearer ${rawKey}` } : {};
}

export async function fetchModels(rawKey) {
  // /v1/models needs a raw ck_ key; returns {models:[ids]|null, error?}
  const cfg = await loadCfg();
  try {
    const resp = await fetch(`${cfg.baseUrl}/v1/models`, {
      headers: bearerHeaders(rawKey),
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return { models: null, error: `HTTP ${resp.status}` };
    const body = await resp.json();
    return { models: (body.data ?? []).map((m) => m.id) };
  } catch (e) {
    return { models: null, error: String(e) };
  }
}
function stripToken(e) {
  const { github_token, ...rest } = e ?? {};
  return rest;
}

function stripHash(e) {
  const { key_hash, ...rest } = e ?? {};
  return rest;
}

export async function connections() {
  // connections.json → [{label, added_at, api_endpoint, active}]
  const cfg = await loadCfg();
  try {
    const stored = JSON.parse(await readFile(join(cfg.dataDir, "connections.json"), "utf8"));
    const storedActive = await activeLabel();
    const firstLabel = Object.keys(stored)[0] ?? null;
    const effective = storedActive && storedActive in stored ? storedActive : firstLabel;
    return Object.entries(stored).map(([label, e]) => ({
      label, ...stripToken(e), active: label === effective,
    }));
  } catch {
    return [];
  }
}

export async function activeLabel() {
  try {
    const cfg = await loadCfg();
    const raw = JSON.parse(await readFile(join(cfg.dataDir, "active.json"), "utf8"));
    return raw.label ?? null;
  } catch {
    return null;
  }
}
export async function keysMeta() {
  // api-keys.json → [{name, created_at, last_used, connection}] (hash stripped)
  const cfg = await loadCfg();
  try {
    const parsed = JSON.parse(await readFile(join(cfg.dataDir, "api-keys.json"), "utf8"));
    return parsed.map((x) => stripHash(x));
  } catch {
    return [];
  }
}

export async function keySetPin(name, label) {
  // 0600 atomic edit of api-keys.json: pin a key to a connection label; null = follow active.
  const cfg = await loadCfg();
  try {
    const keys = JSON.parse(await readFile(join(cfg.dataDir, "api-keys.json"), "utf8"));
    const entry = keys.find((x) => x.name === name);
    if (!entry) return false;
    if (label) entry.connection = label;
    else delete entry.connection;
    await writePrivate(join(cfg.dataDir, "api-keys.json"), JSON.stringify(keys, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}
// ---- atomic 0600 write (same discipline as config.write_private) ----
async function writePrivate(path, text) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

// ---- usage metering: totals + recent calls from the gateway's SQLite store.
// usage.py is stdlib-only, so the venv python reads it without importing httpx.
let usageCache = null;
let usageCacheAt = 0;
export async function usageData(limit = 8) {
  const now = Date.now();
  if (usageCache && now - usageCacheAt < USAGE_CACHE_MS) return usageCache;
  const cfg = await loadCfg();
  const script = [
    "import sys, json",
    `sys.path.insert(0, ${JSON.stringify(join(cfg.path, "src"))})`,
    "from crispy_copilot_gateway import usage",
    `print(json.dumps({"totals": usage.totals(), "recent": usage.recent(${Number(limit) || 8})}))`,
  ].join("\n");
  try {
    const raw = await new Promise((resolve, reject) => {
      execFile(
        cfg.py, ["-I", "-c", script],
        { timeout: 5000, maxBuffer: 1 << 20, env: { ...process.env, CRISPY_COPILOT_DATA_DIR: cfg.dataDir } },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
    usageCache = JSON.parse(raw);
    usageCacheAt = Date.now();
    return usageCache;
  } catch (e) {
    return { totals: null, recent: [], error: String(e) };
  }
}
// ---- embedded install: vendored source -> data-dir copy -> venv -> pip ----
function appendLog(cfg, line) {
  const stamp = new Date().toISOString().slice(0, 19);
  return appendFile(cfg.installLog, `[${stamp}] ${line}\n`, { mode: 0o600 }).catch(() => {});
}

function runStep(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 22 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}

// ALL plugin git access is anonymous and hermetic: user/system gitconfig is
// ignored (no insteadOf rewrites, no per-user credential helpers, no proxies
// from config), credential helpers are cleared, and terminal prompting is
// disabled. The repo is public https; if it ever goes private the plugin
// fails fast instead of silently using the user's GitHub credentials.
function gitAnon(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile("git", ["-c", "credential.helper=", ...args], {
      timeout: timeoutMs,
      maxBuffer: 1 << 22,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}

// TTL caches: gatewayStatus runs every 5s from the chip tick, so probes stay cheap
let pyCache = { at: 0, val: null };
async function findPython(cfg) {
  if (pyCache.val && Date.now() - pyCache.at < 30_000) return pyCache.val;
  const candidates = [
    process.env.CRISPY_GATEWAY_PYTHON,
    "python3.13", "python3.12",
    ...(IS_WIN ? ["python"] : ["python3", "python"]),
  ].filter(Boolean);
  let out = null;
  for (const bin of candidates) {
    const r = await runStep(bin, ["-c", "import sys;print('%d.%d'%sys.version_info[:2])"], 5000);
    if (parseFloat(r.ok ? r.stdout.trim() : "0") >= 3.12) { out = { ok: true, bin, version: r.stdout.trim() }; break; }
  }
  if (!out) out = { ok: false, error: "no python >= 3.12 found (tried: " + candidates.join(", ") + ")" };
  pyCache = { at: Date.now(), val: out };
  return out;
}

async function gitBin() {
  const r = await gitAnon(["--version"], 5000);
  return r.ok ? "git" : null;
}

let gitCache = { at: 0, key: null, val: null };
async function gitInfo(cfg) {
  if (gitCache.val && gitCache.key === cfg.path && Date.now() - gitCache.at < 30_000) return gitCache.val;
  let out;
  if (!existsSync(join(cfg.path, ".git"))) {
    out = { cloned: false, repo: GIT_REPO, branch: null, commit: null };
  } else {
    const commit = await gitAnon(["-C", cfg.path, "rev-parse", "--short", "HEAD"], 5000);
    const branch = await gitAnon(["-C", cfg.path, "rev-parse", "--abbrev-ref", "HEAD"], 5000);
    out = { cloned: true, repo: GIT_REPO, branch: branch.ok ? branch.stdout.trim() : null, commit: commit.ok ? commit.stdout.trim() : null };
  }
  gitCache = { at: Date.now(), key: cfg.path, val: out };
  return out;
}

// one install at a time; concurrent starts share the same promise
let installPromise = null;

async function ensureInstall(cfg) {
  if (existsSync(cfg.cli)) return { ok: true, fresh: false };
  if (installPromise) return installPromise;
  installPromise = doInstall(cfg).finally(() => { installPromise = null; });
  return installPromise;
}

async function doInstall(cfg) {
  const steps = [];
  try {
    await mkdir(cfg.path, { recursive: true });
    // 1. source: clone from GitHub into the managed install dir. Only the
    // plugin-owned dir is ever wiped/re-cloned (regenerable; the data store is
    // separate); an explicit gateway_path checkout is never touched.
    {
      const managed = cfg.path === cfg.installDir;
      if (!existsSync(join(cfg.path, ".git"))) {
        if (!managed) {
          return { ok: false, error: `no git tree in gateway_path: ${cfg.path}` };
        }
        if (existsSync(join(cfg.path, "pyproject.toml"))) {
          await rmSync(cfg.path, { recursive: true, force: true });
          steps.push("stale install dir wiped");
          await appendLog(cfg, "stale non-git install dir wiped for re-clone");
        }
        const git = await gitBin();
        if (!git) return { ok: false, error: "git not found - install git, then gateway_start again" };
        const c = await gitAnon(["clone", GIT_REPO, cfg.path], 300_000);
        if (!c.ok) {
          await appendLog(cfg, `clone failed: ${c.stderr.slice(0, 300)}`);
          return { ok: false, error: `git clone failed: ${c.stderr.slice(0, 200)}` };
        }
        steps.push("cloned from GitHub");
        await appendLog(cfg, `cloned ${GIT_REPO}`);
      }
    }
    // 2. python >= 3.12
    const py = await findPython(cfg);
    if (!py.ok) { await appendLog(cfg, py.error); return { ok: false, error: py.error }; }
    steps.push(`python ${py.version}`);
    await appendLog(cfg, `using ${py.bin} (${py.version})`);
    // 3. venv
    if (!existsSync(cfg.py)) {
      const v = await runStep(py.bin, ["-m", "venv", join(cfg.path, ".venv")], 120_000);
      if (!v.ok) { await appendLog(cfg, `venv failed: ${v.stderr.slice(0, 300)}`); return { ok: false, error: `venv create failed: ${v.stderr.slice(0, 200)}` }; }
      steps.push("venv created");
      await appendLog(cfg, "venv created");
    }
    // 4. deps (network needed once; pyproject drives the versions)
    const pip = join(venvBin(cfg), IS_WIN ? "pip.exe" : "pip");
    const p = await runStep(pip, ["install", "--quiet", "--disable-pip-version-check", cfg.path], 420_000);
    if (!p.ok) { await appendLog(cfg, `pip failed: ${p.stderr.slice(0, 500)}`); return { ok: false, error: `pip install failed: ${p.stderr.slice(0, 300)}` }; }
    steps.push("pip install done");
    await appendLog(cfg, "pip install done");
    return { ok: true, fresh: true, steps };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) };
  }
}

// ---- lifecycle ----
export async function gatewayStart() {
  const cfg = await loadCfg();
  const h = await healthz();
  if (h.up) return { ok: true, already: true, ...h };
  const inst = await ensureInstall(cfg);
  if (!inst.ok) return { ok: false, error: inst.error, hint: `install needs python>=3.12 + network for pip; log: ${cfg.installLog}` };
  await appendLog(cfg, `serve starting on ${cfg.host}:${cfg.port}`);
  try {
    const log = openSync(cfg.serveLog, "a");
    const child = spawn(cfg.cli, ["serve", "--host", cfg.host, "--port", String(cfg.port)], {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, CRISPY_COPILOT_DATA_DIR: cfg.dataDir },
    });
    child.unref();
    try { await writeFile(join(cfg.runtimeDir, "serve.pid"), String(child.pid ?? ""), { mode: 0o600 }); } catch { }
    closeSync(log);
  } catch (e) {
    return { ok: false, error: `spawn failed: ${String(e).slice(0, 200)}` };
  }
  const h2 = await waitForHealth(true, START_TIMEOUT_MS);
  if (!h2.up) {
    return { ok: false, hint: `gateway did not come up within ${START_TIMEOUT_MS / 1000}s; tail ${cfg.serveLog}`, ...h2 };
  }
  return { ok: true, installed: inst.fresh === true, steps: inst.steps ?? [], ...h2 };
}

async function waitForHealth(up, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await healthz();
    if (h.up === up) return h;
    await new Promise((r) => setTimeout(r, 400));
  }
  return healthz();
}

// Fetch/reset the managed git tree to origin/<branch>, reinstall deps, restart
// the service when it was running. The workhorse of "update like a manual install".
export async function gatewayUpdate() {
  const cfg = await loadCfg();
  if (!existsSync(join(cfg.path, ".git"))) {
    return { ok: false, error: "no git tree yet - run gateway_start first (it clones the repo)" };
  }
  const h = await healthz();
  const wasUp = h.up;
  const f = await gitAnon(["-C", cfg.path, "fetch", "origin", "--quiet"], 120_000);
  if (!f.ok) return { ok: false, error: `git fetch failed: ${f.stderr.slice(0, 200)}` };
  const behind = await runStep("git", ["-C", cfg.path, "rev-list", "--count", `HEAD..origin/${GIT_BRANCH}`], 10_000);
  const n = behind.ok ? parseInt(behind.stdout.trim() || "0", 10) : 0;
  gitCache = { at: 0, key: null, val: null };
  if (n === 0) {
    const info = await gitInfo(cfg);
    return { ok: true, updated: false, behind: 0, commit: info.commit, restarted: false, note: "already on latest origin/" + GIT_BRANCH };
  }
  const r = await gitAnon(["-C", cfg.path, "reset", "--hard", `origin/${GIT_BRANCH}`], 30_000);
  if (!r.ok) return { ok: false, error: `git reset failed: ${r.stderr.slice(0, 200)}` };
  await appendLog(cfg, `updated: ${n} commit(s), reset to origin/${GIT_BRANCH}`);
  const pip = join(venvBin(cfg), IS_WIN ? "pip.exe" : "pip");
  const p = await runStep(pip, ["install", "--quiet", "--disable-pip-version-check", cfg.path], 420_000);
  if (!p.ok) return { ok: false, error: `pip install after update failed: ${p.stderr.slice(0, 200)}` };
  let restarted = false;
  if (wasUp) {
    const st = await gatewayStop();
    restarted = st.ok;
    const st2 = await gatewayStart();
    if (!st2.ok) return { ok: false, error: "updated but restart failed: " + (st2.error ?? st2.hint ?? "unknown"), behind: n };
  }
  const info = await gitInfo(cfg);
  return { ok: true, updated: true, behind: n, commit: info.commit, restarted };
}

export async function gatewayStop() {
  const cfg = await loadCfg();
  // Preferred: kill exactly the child we spawned (pid file; works on Windows too).
  let pid = null;
  try { pid = parseInt(readFileSync(join(cfg.runtimeDir, "serve.pid"), "utf8").trim(), 10); } catch { pid = null; }
  if (pid && Number.isFinite(pid)) {
    try { process.kill(pid); } catch { /* already gone */ }
    try { rmSync(join(cfg.runtimeDir, "serve.pid")); } catch { }
    await waitForHealth(false, 8000);
    const h = await healthz();
    if (!h.up) return { ok: true, via: "pid", ...h };
  }
  if (IS_WIN) {
    return { ok: false, error: "no plugin-spawned gateway (no pid file) - use gateway_start" };
  }
  // POSIX fallback for an instance not spawned by this plugin
  await new Promise((resolve) => {
    execFile("pkill", ["-f", `crispy-copilot serve --host ${cfg.host} --port ${cfg.port}`], { timeout: 5000 }, () => resolve());
  });
  await waitForHealth(false, 5000);
  const h = await healthz();
  return { ok: !h.up, via: "pkill", ...h };
}
import { openSync, closeSync, readFileSync, existsSync, rmSync } from "node:fs";

const DATA_DIR = process.env.ZCODE_PLUGIN_DATA || join(homedir(), ".zcode", "plugins", "copilot-gateway");

// Open the system default browser: the device flow needs the USER's browser
// session (their GitHub login), and plugin views cannot reliably open links.
function openInBrowser(url) {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function gatewayLogin(label) {
  if (!label || typeof label !== "string") return { ok: false, error: "label required" };
  const cfg = await loadCfg();
  const inst = await ensureInstall(cfg);
  if (!inst.ok) return { ok: false, error: inst.error };
  const safe = label.replace(/[^\w.-]/g, "_").slice(0, 40) || "account";
  const logPath = join(DATA_DIR, `login-${safe}.log`);
  const fd = openSync(logPath, "w");
  const child = spawn(cfg.cli, ["login", safe], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, CRISPY_COPILOT_DATA_DIR: cfg.dataDir },
  });
  child.unref();
  try { closeSync(fd); } catch { }
  await new Promise((r) => setTimeout(r, 3000));
  const state = await loginState(safe);
  if (state.code) {
    state.openedInBrowser = openInBrowser(state.url || "https://github.com/login/device");
  }
  return { ok: true, ...state };
}

export async function loginState(label) {
  const safe = label ? label.replace(/[^\w.-]/g, "_").slice(0, 40) : null;
  if (!safe) return { phase: "idle" };
  const logPath = join(DATA_DIR, `login-${safe}.log`);
  let log = "";
  try {
    log = readFileSync(logPath, "utf8");
    log = readFileSync(logPath, "utf8");
  } catch {
    return { phase: "no-login-started", label: safe };
 
  }
  const code = (log.match(/One-time code: (\S+)/) || [])[1] ?? null;
  const url = (log.match(/Open (\S+)/) || [])[1] ?? null;
  const conns = await connections();
  if (conns.some((c) => c.label === safe)) return { phase: "connected", label: safe, logTail: log.slice(-200) };
  if (log.includes("Device flow failed")) return { phase: "failed", label: safe, logTail: log.slice(-200) };
  if (code) return { phase: "awaiting-authorization", label: safe, code, url, logTail: log.slice(-200) };
  return { phase: "starting", label: safe };
}
export async function gatewayStatus() {
  const cfg = await loadCfg();
  const h = await healthz();
  const [conns, keys, usage, pending] = await Promise.all([
    connections(),
    keysMeta(),
    usageData(8),
    listPendingLogins(),
  ]);
  const existsSync = (await import("node:fs")).existsSync;
  return {
    up: h.up,
    latencyMs: h.latencyMs,
    baseUrl: cfg.baseUrl,
    path: cfg.path,
    dataDir: cfg.dataDir,
    installDir: cfg.installDir,
    repo: GIT_REPO,
    pythonOk: (await findPython(cfg)).ok,
    installing: installPromise != null,
    venvOk: existsSync(cfg.cli),
    git: await gitInfo(cfg),
    accounts: conns,
    activeLabel: conns.find((c) => c.active)?.label ?? null,
    keys,
    usage,
    pendingLogins: pending,
  };
}

// In-flight device-flow logins: login-<label>.log files whose label is not
// yet connected. Cheap enough for the 5s view tick.
export async function listPendingLogins() {
  let names = [];
  try {
    names = (await import("node:fs")).readdirSync(DATA_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const f of names.filter((n) => n.startsWith("login-") && n.endsWith(".log"))) {
    const label = f.slice("login-".length, -".log".length);
    const st = await loginState(label);
    if (st.phase === "awaiting-authorization" || st.phase === "starting") out.push(st);
  }
  return out;
}
async function cliWithCfg(cfg, args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    execFile(
      cfg.cli, args,
      { timeout: timeoutMs, maxBuffer: 1 << 20, env: { ...process.env, CRISPY_COPILOT_DATA_DIR: cfg.dataDir } },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || "") }),
    );
  });
}

export async function keyCreate(name) {
  const cfg = await loadCfg();
  const r2 = await cliWithCfg(cfg, ["key", name]);
  if (!r2.ok) {
    const dup = /already exists/.test(r2.stderr + r2.stdout);
    return { ok: false, error: dup ? `key name already exists: ${name}` : r2.stderr.slice(0, 300) };
  }
  return { ok: true, raw: r2.stdout.trim(), name, note: "raw key shown once — save it now" };
}

export async function keyRevoke(name) {
  const cfg = await loadCfg();
  const r = await cliWithCfg(cfg, ["revoke", name]);
  return { ok: r.ok, revoked: /revoked/.test(r.stdout), name };
}
export async function gatewayUse(keyName = "zcode") {
  // Find or create a proxy key, then compose everything needed to wire ZCode
  // (or any OpenAI/Anthropic-speaking harness) to the gateway.
  const cfg = await loadCfg();
  const keys = await keysMeta();
  const existing = keys.find((k) => k.name === keyName);
  let raw = null;
  let note = null;
  if (existing) {
    note = `key '${keyName}' exists; its raw value was shown once at creation. Revoke + recreate to get a new one, or paste your saved value.`;
  } else {
    const created = await keyCreate(keyName);
    if (!created.ok) return { ok: false, ...created };
    raw = created.raw;
  }
  const models = raw ? await fetchModels(raw) : { models: null };
  return {
    ok: true,
    keyName,
    baseUrl: cfg.baseUrl,
    apiKey: raw ?? `<value of existing key '${keyName}'>`,
    note,
    models: models.models,
    modelsError: models.error ?? null,
    provider: {
      baseUrl: `${cfg.baseUrl}/v1`,
      apiKey: raw ?? `<value of existing key '${keyName}'>`,
      models: models.models,
    },
  };
}
