// copilot-gateway control layer: one source of truth for the local
// crispy-copilot-gateway service, shared by the view impl and the MCP server.
// Local-only surface: GET /healthz (unauthenticated), 0600 state files
// (secrets stripped on read), and the gateway venv CLI. GitHub tokens and
// proxy-key hashes are never logged or returned.
import { readFile, writeFile, rename, chmod, appendFile, mkdir, open } from "node:fs/promises";
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
const START_TIMEOUT_MS = 60_000; // slow machines; an early exit is noticed at once
const USAGE_CACHE_MS = 10_000;

// CRISPY_GATEWAY_* env (userConfig via manifest) > gateway .env > defaults.
// One-time migration: stores created before 0.2.0 lived inside the plugin dir
// (ZCODE_PLUGIN_DATA/store or ~/.zcode/plugins/copilot-gateway/store) and were
// wiped by plugin updates. Copy them to the durable runtime dir.
let storeMigrated = false;
function migrateLegacyStore(dataDir) {
  if (storeMigrated) return;
  storeMigrated = true;
  try {
    if (existsSync(join(dataDir, "connections.json"))) return;
    const home = homedir();
    const candidates = [
      process.env.ZCODE_PLUGIN_DATA ? join(process.env.ZCODE_PLUGIN_DATA, "store") : null,
      join(home, ".zcode", "plugins", "copilot-gateway", "store"),
    ].filter(Boolean);
    for (const legacy of candidates) {
      if (!existsSync(join(legacy, "connections.json"))) continue;
      mkdirSync(dataDir, { recursive: true });
      for (const f of ["connections.json", "active.json", "api-keys.json", "usage.db", "storage_secret.txt"]) {
        try {
          if (existsSync(join(legacy, f))) copyFileSync(join(legacy, f), join(dataDir, f));
        } catch { /* keep going; partial migration beats none */ }
      }
      try {
        writeFileSync(join(dataDir, "migrated-from.txt"), `${legacy}\n`, { mode: 0o600 });
      } catch { }
      return;
    }
  } catch { /* never let migration break loadCfg */ }
}

let cfgCache = null;
let cfgCacheAt = 0;
async function loadCfg() {
  if (cfgCache && Date.now() - cfgCacheAt < 3000) return cfgCache;
  // Outside the plugin dir ON PURPOSE: plugin updates replace the plugin dir,
  // which must never wipe the store/install (that bug silently destroyed the
  // OAuth account on every redeploy before 0.2.0).
  const runtimeDir = process.env.CRISPY_GATEWAY_RUNTIME_DIR
    || join(homedir(), ".zcode", "plugin-data", "copilot-gateway");
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
  migrateLegacyStore(cfg.dataDir);
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

// Flatten one upstream catalog entry into the fields a harness config needs
// (vision/reasoning flags, limits, per-M prices).
export function flattenModel(m) {
  const caps = m.capabilities ?? {};
  const sup = caps.supports ?? {};
  const lim = caps.limits ?? {};
  const bp = ((m.billing ?? {}).token_prices ?? {});
  const tier = bp[bp.preferred_tier] ?? bp.default ?? {};
  const scale = (bp.batch_size ?? 1_000_000) / 1_000_000;
  const vision = lim.vision ?? (sup.vision ? {} : null);
  return {
    id: m.id,
    name: m.name ?? m.model_name ?? null,
    vendor: m.vendor ?? null,
    preview: !!m.preview,
    enabled: ((m.policy ?? {}).state ?? "enabled") === "enabled",
    endpoints: m.supported_endpoints ?? [],
    vision: !!vision,
    vision_max_images: vision?.max_prompt_images ?? null,
    reasoning_effort: Array.isArray(sup.reasoning_effort) ? sup.reasoning_effort : (sup.reasoning_effort === true ? ["low","medium","high"] : null),
    adaptive_thinking: sup.adaptive_thinking === true,
    min_thinking_budget: sup.min_thinking_budget ?? null,
    max_thinking_budget: sup.max_thinking_budget ?? null,
    tool_calls: sup.tool_calls === true,
    structured_outputs: sup.structured_outputs === true,
    streaming: sup.streaming === true,
    max_context_tokens: lim.max_context_window_tokens ?? null,
    max_output_tokens: lim.max_output_tokens ?? null,
    max_prompt_tokens: lim.max_prompt_tokens ?? null,
    price_in_per_m: tier.input_price != null ? tier.input_price * scale : null,
    price_out_per_m: tier.output_price != null ? tier.output_price * scale : null,
  };
}

export async function fetchModels(rawKey) {
  // /v1/models needs a raw ck_ key; returns {models:[ids], models_full:[flat]|null, error?}
  const cfg = await loadCfg();
  try {
    const resp = await fetch(`${cfg.baseUrl}/v1/models`, {
      headers: bearerHeaders(rawKey),
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return { models: null, models_full: null, error: `HTTP ${resp.status}` };
    const body = await resp.json();
    const entries = (body.data ?? []).filter((m) => typeof m?.id === "string");
    return { models: entries.map((m) => m.id), models_full: entries.map((m) => flattenModel(m)) };
  } catch (e) {
    return { models: null, models_full: null, error: String(e) };
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
        { timeout: 5000, maxBuffer: 1 << 20, windowsHide: true, env: { ...process.env, CRISPY_COPILOT_DATA_DIR: cfg.dataDir } },
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
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 22, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}

// ALL plugin git access is anonymous and hermetic: user/system gitconfig is
// ignored (no insteadOf rewrites, no per-user credential helpers, no proxies
// from config), credential helpers are cleared, and terminal prompting is
// disabled. The repo is public https; if it ever goes private the plugin
// fails fast instead of silently using the user's GitHub credentials.
// hermetic git config: a real empty file, NOT a device path. git-for-windows
// normalizes os.devNull (\\.\nul) to //./nul and then treats it as a remote
// ("unable to access '//./nul'"); /dev/null only works via mingw mapping. An
// empty regular file is unambiguous on every platform.
let emptyGitCfgPath = null;
function emptyGitConfig() {
  if (emptyGitCfgPath) return emptyGitCfgPath;
  // Outside the plugin dir ON PURPOSE: plugin updates replace the plugin dir,
  // which must never wipe the store/install (that bug silently destroyed the
  // OAuth account on every redeploy before 0.2.0).
  const runtimeDir = process.env.CRISPY_GATEWAY_RUNTIME_DIR
    || join(homedir(), ".zcode", "plugin-data", "copilot-gateway");
  emptyGitCfgPath = join(runtimeDir, "gitconfig-empty");
  try {
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(emptyGitCfgPath, "", { mode: 0o600 });
  } catch { }
  return emptyGitCfgPath;
}

function gitAnon(args, timeoutMs) {
  return new Promise((resolve) => {
    resolveGit().then((gitPath) => {
      if (!gitPath) {
        resolve({ ok: false, stdout: "", stderr: "git not found" });
        return;
      }
      execFile(gitPath, ["-c", "credential.helper=", ...args], {
        timeout: timeoutMs,
        maxBuffer: 1 << 22,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: emptyGitConfig(), GIT_CONFIG_SYSTEM: emptyGitConfig() },
      }, (err, stdout, stderr) =>
        resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || "") }));
    });
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

// git discovery: CRISPY_GATEWAY_GIT override > PATH > standard Windows install
// locations. The ZCode app process can predate a git install (stale PATH), so
// on Windows PATH alone is not enough - probing the files is.
let gitPathCache = null;
async function resolveGit() {
  if (gitPathCache) return gitPathCache;
  const candidates = [];
  if (process.env.CRISPY_GATEWAY_GIT) candidates.push(process.env.CRISPY_GATEWAY_GIT);
  candidates.push("git");
  if (IS_WIN) {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Programs", "Git", "cmd", "git.exe"));
    candidates.push(join(pf, "Git", "cmd", "git.exe"));
    candidates.push(join(pf86, "Git", "cmd", "git.exe"));
    if (process.env.USERPROFILE) candidates.push(join(process.env.USERPROFILE, "scoop", "apps", "git", "current", "cmd", "git.exe"));
  }
  for (const c of candidates) {
    if (c !== "git" && !existsSync(c)) continue;
    const r = await runStep(c, ["--version"], 5000);
    if (r.ok) { gitPathCache = c; return c; }
  }
  return null;
}

async function gitBin() {
  return resolveGit();
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

// ---- what this extension needs from the gateway ----
// The extension mandates the gateway version it runs: it never passes the
// gateway an option the installed version does not know.
//   GATEWAY_MIN_VERSION  the oldest gateway this extension will start at all
//   SERVE_OPTIONS        every option gateway_start adds to `serve`, each with
//                        the gateway version that introduced it
// An install older than an option's version is updated first when this plugin
// manages it, or started without that option, and the result says which.
// A release that relies on a new gateway feature must (1) come after that
// gateway commit is on origin/main and (2) raise the version here. 0.2.3
// passed --idle-exit without this, and every install cloned before gateway
// 0.1.1 stopped starting (incident of 2026-11-24).
const GATEWAY_MIN_VERSION = "0.1.0";
function idleExitMinutes() {
  const n = Number(process.env.CRISPY_GATEWAY_IDLE_EXIT ?? "30");
  return Number.isFinite(n) && n > 0 ? n : null; // null: switched off by its setting
}
const SERVE_OPTIONS = {
  "--idle-exit": {
    since: "0.1.1",
    what: "idle exit (the gateway will keep running until stopped)",
    args: () => { const m = idleExitMinutes(); return m == null ? null : [String(m)]; },
  },
};

function parseVersion(v) {
  const m = /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}
// below zero when a is older than b, 0 when equal, above zero when newer;
// null when either version is unknown
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
// the newest gateway that any option in use needs
function wantedVersion() {
  return Object.values(SERVE_OPTIONS)
    .filter((o) => o.args() != null)
    .reduce((w, o) => (compareVersions(o.since, w) > 0 ? o.since : w), GATEWAY_MIN_VERSION);
}

// The version that actually runs is the package installed in the venv. The git
// tree can be ahead of it when a pip step failed, so the tree alone is not enough.
let versionCache = { at: 0, key: null, val: undefined };
function bustVersionCache() { versionCache = { at: 0, key: null, val: undefined }; }
async function installedGatewayVersion(cfg) {
  if (!existsSync(cfg.py)) return null;
  if (versionCache.val !== undefined && versionCache.key === cfg.path && Date.now() - versionCache.at < 60_000) return versionCache.val;
  const r = await runStep(cfg.py, ["-c", "from importlib.metadata import version; print(version('crispy-copilot-gateway'))"], 15_000);
  const v = r.ok ? r.stdout.trim().slice(0, 40) : null;
  versionCache = { at: Date.now(), key: cfg.path, val: v };
  return v;
}
// the version written in the checkout's pyproject.toml: tells whether the venv is in step with the tree
async function treeVersion(cfg) {
  try {
    const m = /^version\s*=\s*"([^"]+)"/m.exec(await readFile(join(cfg.path, "pyproject.toml"), "utf8"));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// What the installed gateway is, and which options in use it does not know.
async function gatewayRequirement(cfg) {
  const installed = await installedGatewayVersion(cfg);
  const req = {
    managed: cfg.path === cfg.installDir,
    installed,
    minVersion: GATEWAY_MIN_VERSION,
    wantedVersion: wantedVersion(),
    tooOld: compareVersions(installed, GATEWAY_MIN_VERSION) < 0,
    unsupported: Object.entries(SERVE_OPTIONS)
      .filter(([, o]) => o.args() != null && compareVersions(installed, o.since) < 0)
      .map(([name]) => name),
  };
  req.outdated = req.tooOld || req.unsupported.length > 0;
  return req;
}

// ---- one install, update or start at a time, across processes ----
// The view tools run in the extension host and the MCP tools in a separate
// process, both on the same runtime dir, so an in-memory promise is not enough.
// mkdir is atomic. A lock whose owner is gone, or that is older than any of
// these steps can take, is stale and gets removed.
const LOCK_STALE_MS = 20 * 60_000;
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } // signal 0 only probes
}
async function withRuntimeLock(cfg, name, fn, waitMs = 10 * 60_000) {
  const dir = join(cfg.runtimeDir, `${name}.lock`);
  mkdirSync(cfg.runtimeDir, { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let owner = null;
      let age = 0;
      try { owner = parseInt(readFileSync(join(dir, "pid"), "utf8").trim(), 10) || null; } catch { }
      try { age = Date.now() - statSync(dir).mtimeMs; } catch { }
      const stale = age > LOCK_STALE_MS || (owner ? !pidAlive(owner) : age > 30_000);
      if (stale) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { }
        continue;
      }
      if (Date.now() - t0 > waitMs) {
        throw new Error(`another ${name} is still running (pid ${owner ?? "?"}); try again when it has finished`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  try { writeFileSync(join(dir, "pid"), String(process.pid), { mode: 0o600 }); } catch { }
  try {
    return await fn();
  } finally {
    // only our own lock: it may have been taken over as stale while we ran
    try {
      const owner = parseInt(readFileSync(join(dir, "pid"), "utf8").trim(), 10);
      if (owner === process.pid) rmSync(dir, { recursive: true, force: true });
    } catch { }
  }
}

let installPromise = null;
async function ensureInstall(cfg) {
  if (existsSync(cfg.cli)) return { ok: true, fresh: false };
  if (installPromise) return installPromise;
  installPromise = withRuntimeLock(cfg, "install", async () => {
    // another process may have finished the install while this one waited for the lock
    if (existsSync(cfg.cli)) return { ok: true, fresh: false };
    const r = await doInstall(cfg);
    if (r.ok) bustVersionCache();
    return r;
  }).catch((e) => ({ ok: false, error: String(e).slice(0, 300) }))
    .finally(() => { installPromise = null; });
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
        if (!git) {
          return { ok: false, error: gitMissingError() };
        }
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

function gitMissingError() {
  return IS_WIN
    ? "git not found - install Git for Windows (git-scm.com, default options), then try again (restart ZCode if it persists)"
    : "git not found - install git, then try again";
}

// Bring the managed install up to origin/<branch> and make the venv match the
// tree. Managed installs only: an external gateway_path checkout is never
// written to. Every git call goes through the resolved, hermetic git, and a
// step that cannot run is an error, never "already on latest".
async function updateTree(cfg) {
  return withRuntimeLock(cfg, "update", async () => {
    if (!(await gitBin())) return { ok: false, error: gitMissingError() };
    const f = await gitAnon(["-C", cfg.path, "fetch", "origin", "--quiet"], 120_000);
    if (!f.ok) return { ok: false, error: `git fetch failed: ${f.stderr.slice(0, 200)}` };
    const behind = await gitAnon(["-C", cfg.path, "rev-list", "--count", `HEAD..origin/${GIT_BRANCH}`], 10_000);
    if (!behind.ok) return { ok: false, error: `git rev-list failed: ${behind.stderr.slice(0, 200)}` };
    const n = Number(behind.stdout.trim());
    if (!Number.isInteger(n) || n < 0) return { ok: false, error: `git rev-list gave an unexpected answer: ${behind.stdout.trim().slice(0, 40)}` };
    const commitBefore = (await gitInfo(cfg)).commit;
    // nothing to do when the tree is current and the venv already matches it
    const installed = await installedGatewayVersion(cfg);
    if (n === 0 && installed != null && compareVersions(installed, await treeVersion(cfg)) === 0) {
      return { ok: true, updated: false, behind: 0, commit: commitBefore };
    }
    if (n > 0) {
      const r = await gitAnon(["-C", cfg.path, "reset", "--hard", `origin/${GIT_BRANCH}`], 30_000);
      if (!r.ok) return { ok: false, error: `git reset failed: ${r.stderr.slice(0, 200)}` };
      await appendLog(cfg, `updated: ${n} commit(s), reset to origin/${GIT_BRANCH}`);
    }
    // pip is mandatory: the CLI runs the copy installed in the venv, not the tree
    const pip = join(venvBin(cfg), IS_WIN ? "pip.exe" : "pip");
    const p = await runStep(pip, ["install", "--quiet", "--disable-pip-version-check", cfg.path], 420_000);
    if (!p.ok) return { ok: false, error: `pip install after update failed: ${p.stderr.slice(0, 200)}` };
    bustVersionCache();
    gitCache = { at: 0, key: null, val: null };
    return { ok: true, updated: true, behind: n, commit: (await gitInfo(cfg)).commit, commitBefore };
  });
}

// ---- lifecycle ----
export async function gatewayStart() {
  const cfg = await loadCfg();
  const h = await healthz();
  if (h.up) return { ok: true, already: true, message: "The gateway was already running.", ...h };
  const inst = await ensureInstall(cfg);
  if (!inst.ok) {
    return { ok: false, error: inst.error, message: "The gateway could not be installed.", hint: `install needs python>=3.12 + network for pip; log: ${cfg.installLog}` };
  }
  try {
    return await withRuntimeLock(cfg, "start", async () => {
      // another process may have started it while this one waited for the lock
      const again = await healthz();
      if (again.up) return { ok: true, already: true, message: "The gateway was already running.", ...again };
      return startInstalled(cfg, inst);
    });
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) };
  }
}

async function startInstalled(cfg, inst) {
  const notes = [];
  let req = await gatewayRequirement(cfg);
  let healed = null;
  if (req.outdated && req.managed) {
    // the extension mandates the gateway version: bring the install up to date first
    const upd = await updateTree(cfg);
    if (!upd.ok) {
      notes.push(`The gateway could not be updated: ${upd.error}`);
    } else {
      healed = { from: req.installed, to: await installedGatewayVersion(cfg), behind: upd.behind, commit: upd.commit };
      req = await gatewayRequirement(cfg);
    }
  }
  if (req.tooOld) {
    return {
      ok: false, gateway: req, healed, notes,
      message: `Not started: this extension needs gateway ${GATEWAY_MIN_VERSION} or newer, and ${req.installed} is installed.`,
      error: `gateway ${req.installed} is older than the minimum ${GATEWAY_MIN_VERSION}`,
      hint: req.managed ? "update the gateway (update…), then start again" : `update the checkout at ${cfg.path} yourself, then start again`,
    };
  }
  // only the options this gateway knows
  const args = ["serve", "--host", cfg.host, "--port", String(cfg.port)];
  const omitted = [];
  for (const [name, o] of Object.entries(SERVE_OPTIONS)) {
    const a = o.args();
    if (a == null) continue; // switched off by its setting
    if (req.unsupported.includes(name)) omitted.push(name); else args.push(name, ...a);
  }
  const messages = [];
  if (healed) {
    const count = healed.behind ? ` (${healed.behind} commit${healed.behind === 1 ? "" : "s"})` : "";
    messages.push(`Gateway updated from ${healed.from ?? "?"} to ${healed.to ?? "?"}${count}, then started.`);
  }
  for (const name of omitted) {
    const why = req.managed ? " and the update did not succeed" : ` and the checkout at ${cfg.path} is not changed by this plugin`;
    messages.push(`Started without ${SERVE_OPTIONS[name].what}: gateway ${req.installed} is older than ${SERVE_OPTIONS[name].since}${why}.`);
  }
  if (!messages.length) messages.push("Gateway is up.");

  await appendLog(cfg, `serve starting on ${cfg.host}:${cfg.port}${omitted.length ? ` (without ${omitted.join(", ")})` : ""}`);
  const logFrom = fileEnd(cfg.serveLog);
  let child;
  try {
    const log = openSync(cfg.serveLog, "a");
    child = spawn(cfg.cli, args, {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, CRISPY_COPILOT_DATA_DIR: cfg.dataDir },
    });
    closeSync(log);
  } catch (e) {
    return { ok: false, gateway: req, healed, omitted, notes, message: "The gateway could not be launched.", error: String(e).slice(0, 200) };
  }
  // Watch it from the first moment: an exit before /healthz answers is the
  // gateway's own verdict and must come back at once, not after the timeout.
  const state = {};
  const onExit = (code, signal) => { state.exited = { code, signal }; };
  const onSpawnError = (e) => { state.exited = { error: String(e) }; };
  child.on("exit", onExit);
  child.on("error", onSpawnError);
  child.unref();
  // this plugin started it: remember the number so that stop can find it again
  try { await writeFile(join(cfg.runtimeDir, "serve.pid"), String(child.pid ?? ""), { mode: 0o600 }); } catch { }
  const up = await awaitStart(state);
  child.removeListener("exit", onExit);
  const extra = { gateway: req, healed, omitted, notes, args };
  if (up.up) {
    return { ok: true, installed: inst.fresh === true, steps: inst.steps ?? [], message: messages.join(" "), ...up, ...extra };
  }
  try { rmSync(join(cfg.runtimeDir, "serve.pid"), { force: true }); } catch { }
  const detail = await serveLogTail(cfg, logFrom);
  if (state.exited) {
    const how = state.exited.error ?? (state.exited.code != null ? `code ${state.exited.code}` : state.exited.signal ?? "an unknown status");
    return { ok: false, message: "The gateway exited at once instead of starting.", ...extra, error: `the gateway process exited with ${how}`, detail };
  }
  return {
    ok: false,
    message: `The gateway did not answer on ${cfg.baseUrl} within ${Math.round(START_TIMEOUT_MS / 1000)} s.`,
    ...extra,
    error: "the gateway did not come up",
    detail,
    log: cfg.serveLog,
  };
}

// For tests only: forget everything cached about an install, so that a change
// made behind this module's back (a downgrade, a new checkout) is seen at once.
export function resetCaches() {
  bustVersionCache();
  gitCache = { at: 0, key: null, val: null };
  pyCache = { at: 0, val: null };
  cfgCacheAt = 0;
}

// Poll until the gateway answers, it exits, or the time is up. The timeout is
// generous for slow machines because an early exit is noticed at once.
async function awaitStart(state, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (state.exited) return { up: false };
    const h = await healthz();
    if (h.up) return h;
    if (Date.now() > deadline) return { up: false };
    await new Promise((r) => setTimeout(r, 250));
  }
}

function fileEnd(path) {
  try { return statSync(path).size; } catch { return 0; }
}

// The gateway's last words in serve.log since a given point, without the noise
// of the health polls (about two lines per 5 s while a view or chip polls).
async function serveLogTail(cfg, fromByte, maxLines = 12) {
  try {
    const size = statSync(cfg.serveLog).size;
    const start = Math.max(fromByte, size - 64 * 1024);
    const fh = await open(cfg.serveLog, "r");
    try {
      const buf = Buffer.alloc(size - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      return buf.subarray(0, bytesRead).toString("utf8")
        .split("\n").map((l) => l.replace(/\r$/, "").trimEnd())
        .filter((l) => l && !l.includes("/healthz")).slice(-maxLines).join("\n");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
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

// Update like a manual install would, for the install this plugin manages.
export async function gatewayUpdate() {
  const cfg = await loadCfg();
  if (!existsSync(join(cfg.path, ".git"))) {
    return { ok: false, message: "Nothing to update yet.", error: "no git tree yet - run gateway_start first (it clones the repo)" };
  }
  if (cfg.path !== cfg.installDir) {
    // never write to an external checkout: say what to do instead
    const info = await gitInfo(cfg);
    return {
      ok: false, managed: false, path: cfg.path, commit: info.commit, installedVersion: await installedGatewayVersion(cfg),
      message: "This checkout is not managed by this plugin, so it was not changed.",
      error: `update it yourself: git -C "${cfg.path}" pull && "${cfg.py}" -m pip install "${cfg.path}"`,
    };
  }
  const wasUp = (await healthz()).up;
  const r = await updateTree(cfg);
  if (!r.ok) return { ok: false, message: "Update failed.", error: r.error };
  let restarted = false;
  if (r.updated && wasUp) {
    await gatewayStop();
    const again = await gatewayStart();
    if (!again.ok) return { ok: false, message: "Updated, but the gateway did not restart.", error: again.error ?? "unknown", detail: again.detail, behind: r.behind };
    restarted = true;
  }
  const gateway = await gatewayRequirement(cfg);
  let message;
  if (!r.updated) message = `Already on the latest version (commit ${r.commit}).`;
  else if (!r.behind) message = `Reinstalled the gateway to match the checkout (commit ${r.commit}).`;
  else message = `Updated: ${r.behind} commit${r.behind === 1 ? "" : "s"}, now at ${r.commit}${restarted ? "; the gateway was restarted" : ""}.`;
  return { ok: true, updated: r.updated, behind: r.behind, commit: r.commit, restarted, gateway, message };
}

// The command line of a process, or null when there is none.
async function processCommandLine(pid) {
  if (IS_WIN) {
    const r = await runStep("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}').CommandLine`], 20_000);
    return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
  }
  if (process.platform === "darwin") {
    const r = await runStep("ps", ["-p", String(Number(pid)), "-o", "command="], 10_000);
    return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
  }
  try {
    return readFileSync(`/proc/${Number(pid)}/cmdline`, "utf8").replaceAll("\0", " ") || null;
  } catch {
    return null;
  }
}

// Is this the gateway this plugin started from this install? Its command line
// must name the install dir and `serve`. A serve.pid left behind by a crash,
// the idle exit or a reboot can point at any process, because numbers get reused.
function isOurGateway(cmdline, cfg) {
  const c = String(cmdline ?? "").toLowerCase();
  return c.includes(String(cfg.path).toLowerCase()) && /\bserve\b/.test(c);
}

// Stop the gateway this plugin started, and nothing else. A serve.pid that
// does not belong to a gateway from this install is removed, never signalled.
export async function gatewayStop() {
  const cfg = await loadCfg();
  const pidFile = join(cfg.runtimeDir, "serve.pid");
  let pid = null;
  try { pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10); } catch { }
  let ours = null;
  if (Number.isInteger(pid) && pid > 0) {
    if (isOurGateway(await processCommandLine(pid), cfg)) ours = pid;
    else { try { rmSync(pidFile, { force: true }); } catch { } }
  }
  const h = await healthz();
  if (!h.up) {
    return { ok: true, stopped: false, running: false, message: ours ? "The gateway is stopping or was not running." : "The gateway was not running.", ...h };
  }
  if (!ours) {
    return {
      ok: false, stopped: false, running: true, ...h,
      message: `Something else is answering on port ${cfg.port}. This plugin only stops the gateway it started.`,
      error: `a process this plugin did not start is answering on ${cfg.baseUrl}`,
    };
  }
  try { process.kill(ours); } catch { /* gone already */ }
  await waitForHealth(false, 10_000);
  const after = await healthz();
  if (after.up) {
    return { ok: false, stopped: false, running: true, ...after, message: "The gateway did not stop.", error: "the gateway is still answering after being asked to stop" };
  }
  try { rmSync(pidFile, { force: true }); } catch { }
  return { ok: true, stopped: true, running: false, ...after, message: "Gateway stopped." };
}

// After an idle exit, a crash or a reboot, serve.pid names a process that is
// gone or that reused the number. Drop it so that nothing ever acts on it.
async function dropStalePidFile(cfg) {
  const pidFile = join(cfg.runtimeDir, "serve.pid");
  let pid = null;
  try { pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10); } catch { return; }
  if (isOurGateway(await processCommandLine(pid), cfg)) return;
  try { rmSync(pidFile, { force: true }); } catch { }
}
import { openSync, closeSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync, copyFileSync, statSync } from "node:fs";

const DATA_DIR = process.env.CRISPY_GATEWAY_RUNTIME_DIR || join(homedir(), ".zcode", "plugin-data", "copilot-gateway");

// Best effort: ask the OS to open the URL in the default browser. Resolves true
// only when an opener really launched it (found + exit 0); false when there is
// none (no xdg-open or no default browser: common on VMs and remote desktops).
// Callers must still show the URL as text that can be typed by hand.
export async function openInBrowser(url) {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolve) => {
    let child;
    let timer = null;
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    try {
      child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    } catch {
      return resolve(false);
    }
    // openers hand the URL over and exit at once; if one keeps running, assume
    // it did its job rather than wait on it
    timer = setTimeout(() => done(true), 5000);
    child.on("error", () => done(false));
    child.on("exit", (code) => done(code === 0));
    child.unref();
  });
}

// The pid of the login poller for a label, but only when the recorded process
// still is ours (command line names this install, `login` and the label).
// A pid file left behind by a finished, failed or reused process is ignored.
async function loginPollerPid(cfg, safe) {
  let pid = null;
  try { pid = parseInt(readFileSync(join(DATA_DIR, `login-${safe}.pid`), "utf8").trim(), 10); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const cmd = await processCommandLine(pid);
  if (!cmd) return null;
  const lc = cmd.toLowerCase();
  const ours = lc.includes(String(cfg.path).toLowerCase()) && /\blogin\b/.test(lc) && lc.includes(safe.toLowerCase());
  return ours ? pid : null;
}

export async function gatewayLogin(label) {
  if (!label || typeof label !== "string") return { ok: false, error: "label required" };
  const cfg = await loadCfg();
  const inst = await ensureInstall(cfg);
  if (!inst.ok) return { ok: false, error: inst.error };
  const safe = label.replace(/[^\w.-]/g, "_").slice(0, 40) || "account";
  // a retry must not stack a second poller next to the previous attempt's
  const prev = await loginPollerPid(cfg, safe);
  if (prev) { try { process.kill(prev); } catch { } }
  const logPath = join(DATA_DIR, `login-${safe}.log`);
  const fd = openSync(logPath, "w");
  const child = spawn(cfg.cli, ["login", safe], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, CRISPY_COPILOT_DATA_DIR: cfg.dataDir },
  });
  child.unref();
  try { closeSync(fd); } catch { }
  try { await writeFile(join(DATA_DIR, `login-${safe}.pid`), String(child.pid ?? ""), { mode: 0o600 }); } catch { }
  await new Promise((r) => setTimeout(r, 3000));
  const state = await loginState(safe);
  if (state.code) {
    // only the address GitHub sent with the code: never a guessed default
    if (state.url) state.openedInBrowser = await openInBrowser(state.url);
  }
  return { ok: true, platform: process.platform, ...state };
}

export async function loginState(label) {
  const safe = label ? label.replace(/[^\w.-]/g, "_").slice(0, 40) : null;
  if (!safe) return { phase: "idle" };
  const logPath = join(DATA_DIR, `login-${safe}.log`);
  let log = "";
  let ageMs = null; // since the log's last write (the CLI flushes each line)
  try {
    log = readFileSync(logPath, "utf8");
    ageMs = Date.now() - statSync(logPath).mtimeMs;
  } catch {
    return { phase: "no-login-started", label: safe };
  }
  const code = (log.match(/One-time code: (\S+)/) || [])[1] ?? null;
  const url = (log.match(/Open (\S+)/) || [])[1] ?? null;
  const conns = await connections();
  if (conns.some((c) => c.label === safe)) return { phase: "connected", label: safe, logTail: log.slice(-200) };
  if (log.includes("Device flow failed")) return { phase: "failed", label: safe, logTail: log.slice(-200) };
  if (code) {
    // GitHub device codes live ~15 minutes: an older log is a dead attempt,
    // and offering its code would only get the user an "expired" page.
    if (ageMs > 16 * 60_000) return { phase: "expired", label: safe, code, url };
    return { phase: "awaiting-authorization", label: safe, code, url, logTail: log.slice(-200) };
  }
  // No code yet: normal for the first seconds. An older log means the start
  // itself died (network, proxy): surface its tail instead of waiting forever.
  if (ageMs > 20_000) return { phase: "failed", label: safe, logTail: log.slice(-300) };
  return { phase: "starting", label: safe };
}
// Remove a login attempt: stop its poller (only when the pid is verifiably
// ours) and delete its record, so a dead attempt cannot sit in Pending logins
// forever. Harmless when there is nothing to remove.
export async function loginDismiss(label) {
  if (!label || typeof label !== "string") return { ok: false, error: "label required" };
  const cfg = await loadCfg();
  const safe = label.replace(/[^\w.-]/g, "_").slice(0, 40) || "account";
  const logPath = join(DATA_DIR, `login-${safe}.log`);
  const pidPath = join(DATA_DIR, `login-${safe}.pid`);
  const pid = await loginPollerPid(cfg, safe);
  let stopped = false;
  if (pid) { try { process.kill(pid); stopped = true; } catch { /* gone already */ } }
  const existed = existsSync(logPath) || existsSync(pidPath);
  try { rmSync(logPath, { force: true }); } catch { }
  try { rmSync(pidPath, { force: true }); } catch { }
  return {
    ok: true, label: safe, stopped, removed: existed,
    message: !existed && !stopped ? `No login attempt named '${safe}'.` : stopped ? `Login '${safe}' removed and its poller stopped.` : `Login '${safe}' removed.`,
  };
}

export async function gatewayStatus() {
  const cfg = await loadCfg();
  const h = await healthz();
  if (!h.up) await dropStalePidFile(cfg);
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
    platform: process.platform,
    pythonOk: (await findPython(cfg)).ok,
    installing: installPromise != null,
    venvOk: existsSync(cfg.cli),
    idleExitMin: Number(process.env.CRISPY_GATEWAY_IDLE_EXIT ?? "30"),
    git: await gitInfo(cfg),
    gateway: await gatewayRequirement(cfg),
    accounts: conns,
    activeLabel: conns.find((c) => c.active)?.label ?? null,
    keys,
    usage,
    pendingLogins: pending,
  };
}

// Device-flow attempts found in the runtime dir (login-<label>.log), for the
// 5s view tick. Connected labels are skipped; everything else is listed so a
// pending, dead or failed attempt gets explained instead of silently dropped.
const LISTED_LOGIN_PHASES = new Set(["awaiting-authorization", "starting", "failed", "expired"]);
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
    if (LISTED_LOGIN_PHASES.has(st.phase)) out.push(st);
  }
  return out;
}
async function cliWithCfg(cfg, args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    execFile(
      cfg.cli, args,
      { timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true, env: { ...process.env, CRISPY_COPILOT_DATA_DIR: cfg.dataDir } },
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
// Regenerate the provider config for an EXISTING key. The saved raw value is
// unrecoverable (hashes only), so the catalog is read via a throwaway key
// (create -> fetch -> revoke; stale temp keys from crashed runs cleaned first).
export async function gatewayConfig(keyName = "zcode") {
  const cfg = await loadCfg();
  const keys = await keysMeta();
  if (!keys.some((k) => k.name === keyName)) {
    return { ok: false, error: `no key '${keyName}' yet - create one first (new key… / gateway_key_create)` };
  }
  const tempName = `${keyName}-catalog-tmp`;
  let made = await keyCreate(tempName);
  if (!made.ok && /already exists/.test(made.error ?? "")) {
    await keyRevoke(tempName);
    made = await keyCreate(tempName);
  }
  if (!made.ok) return { ok: false, error: `temporary catalog key failed: ${made.error}` };
  const models = await fetchModels(made.raw);
  await keyRevoke(tempName);
  const apiKeyOut = `<value of existing key '${keyName}'>`;
  const note = `config for existing key '${keyName}' (paste your saved key value); catalog read via a temporary key, revoked right after`;
  return {
    ok: true,
    keyName,
    baseUrl: cfg.baseUrl,
    apiKey: apiKeyOut,
    note: models.models_full ? note : note + ` (catalog fetch failed: ${models.error ?? "unknown"} - is an account connected?)`,
    models: models.models,
    models_full: models.models_full ?? null,
    modelsError: models.error ?? null,
    provider: {
      baseUrl: `${cfg.baseUrl}/v1`,
      apiKey: apiKeyOut,
      // full catalog entries: vision / reasoning_effort / tool_calls / limits /
      // per-M prices per model - enough for a harness to configure options
      models: models.models_full ?? models.models,
    },
  };
}

// Find-or-create a key, then compose everything needed to wire a harness.
// First-time path returns the raw key (shown once); an existing key delegates
// to gatewayConfig.
export async function gatewayUse(keyName = "zcode") {
  const cfg = await loadCfg();
  const keys = await keysMeta();
  if (keys.some((k) => k.name === keyName)) return gatewayConfig(keyName);
  const created = await keyCreate(keyName);
  if (!created.ok) return { ok: false, ...created };
  const raw = created.raw;
  const models = await fetchModels(raw);
  return {
    ok: true,
    keyName,
    baseUrl: cfg.baseUrl,
    apiKey: raw,
    note: `new key '${keyName}' created - its raw value is shown ONCE, save it; config below`,
    models: models.models,
    models_full: models.models_full ?? null,
    modelsError: models.error ?? null,
    provider: {
      baseUrl: `${cfg.baseUrl}/v1`,
      apiKey: raw,
      models: models.models_full ?? models.models,
    },
  };
}
