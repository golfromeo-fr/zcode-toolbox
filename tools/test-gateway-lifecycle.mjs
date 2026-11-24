// Lifecycle tests for the copilot-gateway control layer (impl/gateway.js).
//
// They cover what the incident of 2026-11-24 showed could go wrong: an install
// older than the extension, a gateway that exits at once, a stale serve.pid, a
// process that is not ours on the port, update on an external checkout, a
// behind-count that cannot run, and two starts at once. Hermetic: a stand-in
// gateway replaces the real one, and nothing touches the network or the
// default runtime dir.
//
//   node tools/test-gateway-lifecycle.mjs          hermetic tests
//   REAL=1 node tools/test-gateway-lifecycle.mjs   also the real upgrade path (network, about 2 min)
//
// POSIX only for now: the stand-in gateway is a script, and on Windows the
// extension only runs an .exe from the venv.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform === "win32") {
  console.log("skipped on Windows: the stand-in gateway is a POSIX script");
  process.exit(0);
}
const REAL = process.env.REAL === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realGit = execFileSync("which", ["git"]).toString().trim();

// The stand-in gateway. Like the real CLI it refuses an option its installed
// version does not know, with the same words typer uses; otherwise it serves
// 200 on the given port. Its process is the server itself, as the real one is.
const FAKE_CLI = [
  "#!/usr/bin/env node",
  'const fs = require("node:fs"), path = require("node:path"), http = require("node:http");',
  'const bin = path.dirname(process.argv[1]);',
  'const args = process.argv.slice(2);',
  'fs.appendFileSync(path.join(bin, "serve-calls.txt"), args.join(" ") + "\\n");',
  'let installed = "";',
  'try { installed = fs.readFileSync(path.join(bin, "installed-version.txt"), "utf8").trim(); } catch { }',
  'const num = (v) => v.split(".").map(Number);',
  'const cmp = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };',
  'const port = Number(args[args.indexOf("--port") + 1]);',
  'if (args.includes("--idle-exit") && cmp(installed, "0.1.1") < 0) {',
  '  console.log("Usage: crispy-copilot serve [OPTIONS]\\nTry \'crispy-copilot serve --help\' for help.\\nNo such option: --idle-exit");',
  "  process.exit(2);",
  "}",
  'if (process.env.FAKE_SERVE_CRASH) { console.log(process.env.FAKE_SERVE_CRASH); process.exit(2); }',
  'http.createServer((q, r) => r.end("ok")).listen(port, "127.0.0.1", () => console.log(`stand-in gateway ${installed} on ${port}`));',
  "",
].join("\n");

const git = (cwd, ...args) => execFileSync(realGit, ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString();
const gitHead = (cwd) => git(cwd, "rev-parse", "--short", "HEAD").trim();

// A local remote and a clone of it. The remote then moves on from gateway
// 0.1.0 to 0.1.1 (the release that added --idle-exit); the clone stays at
// 0.1.0 unless asked to be current. This is the state the incident machine was in.
function makeRepo(root, { managed = true, current = false } = {}) {
  const src = join(root, "src");
  const remote = join(root, "remote.git");
  const pyproject = (v) => `[project]\nname = "crispy-copilot-gateway"\nversion = "${v}"\n`;
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "pyproject.toml"), pyproject("0.1.0"));
  git(src, "init", "-q", "-b", "main");
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "gateway 0.1.0");
  execFileSync(realGit, ["clone", "-q", "--bare", src, remote]);
  const install = managed ? join(root, "gateway") : join(root, "external");
  execFileSync(realGit, ["clone", "-q", remote, install]);
  writeFileSync(join(src, "pyproject.toml"), pyproject("0.1.1"));
  git(src, "commit", "-q", "-am", "gateway 0.1.1");
  execFileSync(realGit, ["-C", src, "push", "-q", remote, "main"]);
  if (current) git(install, "pull", "-q");
  return { install, remote };
}

// A venv that answers the extension like a real one: python reports the
// installed version, pip makes the installed version match the checkout.
function plantFake(install, installed) {
  const bin = join(install, ".venv", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "installed-version.txt"), `${installed}\n`); // where python reports it and pip rewrites it
  const sh = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}`);
    chmodSync(join(bin, name), 0o755);
  };
  sh("python", 'case "$*" in *importlib.metadata*) cat "$(dirname "$0")/installed-version.txt" ;; *) exit 1 ;; esac\n');
  sh("pip", [
    'echo "$@" >> "$(dirname "$0")/pip-calls.txt"',
    'inst="$(cd "$(dirname "$0")/../.." && pwd)"',
    'sed -n \'s/^version = "\\(.*\\)"/\\1/p\' "$inst/pyproject.toml" > "$(dirname "$0")/installed-version.txt"',
    "",
  ].join("\n"));
  writeFileSync(join(bin, "crispy-copilot"), FAKE_CLI);
  chmodSync(join(bin, "crispy-copilot"), 0o755);
}

const calls = (install, name) => (existsSync(join(install, ".venv", "bin", name)) ? readFileSync(join(install, ".venv", "bin", name), "utf8").trim().split("\n") : []);
const serveCalls = (install) => calls(install, "serve-calls.txt");
const pipCalls = (install) => calls(install, "pip-calls.txt");
const cmdline = (pid) => {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "); } catch { return null; }
};

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

let seq = 0;
// One fresh runtime dir, port and module instance per scenario: the module
// reads its settings once, at import.
async function load(name, env) {
  // nothing from the previous scenario may carry over
  for (const k of Object.keys(process.env)) if (k.startsWith("CRISPY_") || k.startsWith("FAKE_")) delete process.env[k];
  Object.assign(process.env, env);
  return import(new URL(`../plugins/copilot-gateway/impl/gateway.js?lifecycle-test=${++seq}-${name}`, import.meta.url).href);
}

async function cleanup(root) {
  const file = join(root, "serve.pid");
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, "utf8").trim());
    if (cmdline(pid)?.includes(root)) {
      try { process.kill(pid); } catch { }
      await sleep(300);
    }
  }
  rmSync(root, { recursive: true, force: true });
}

let passed = 0;
let failed = 0;
async function scenario(name, envFor, fn) {
  const root = mkdtempSync(join(tmpdir(), "cg-lifecycle-"));
  const port = await freePort();
  const mod = await load(name.replace(/\W+/g, "-"), {
    CRISPY_GATEWAY_RUNTIME_DIR: root,
    CRISPY_GATEWAY_PORT: String(port),
    // a setting may be given as a function of the scratch folder
    ...Object.fromEntries(Object.entries(envFor).map(([k, v]) => [k, typeof v === "function" ? v(root) : v])),
  });
  try {
    await fn({ root, port, mod });
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL  ${name}\n${e.stack ?? e}`);
  } finally {
    await cleanup(root);
  }
}

// A managed install at 0.1.0, one commit behind its remote.
async function oldInstall(root, { unreachable = false, ...extra } = {}) {
  const { install, remote } = makeRepo(root, extra);
  if (unreachable) git(install, "remote", "set-url", "origin", join(root, "no-such-remote.git"));
  plantFake(install, extra.installed ?? "0.1.0");
  return { install, remote };
}

console.log("lifecycle tests (hermetic)");

await scenario("status names an install older than the extension before anything is pressed", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git") }, async ({ root, mod }) => {
  await oldInstall(root);
  const st = await mod.gatewayStatus();
  assert.equal(st.gateway.managed, true);
  assert.equal(st.gateway.installed, "0.1.0");
  assert.equal(st.gateway.minVersion, "0.1.0");
  assert.equal(st.gateway.wantedVersion, "0.1.1");
  assert.deepEqual(st.gateway.unsupported, ["--idle-exit"]);
  assert.equal(st.gateway.outdated, true);
});

await scenario("managed install older than the extension: start updates it first, then starts", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git") }, async ({ root, mod }) => {
  const { install } = await oldInstall(root);
  const r = await mod.gatewayStart();
  assert.equal(r.ok, true, r.error ?? r.message);
  assert.deepEqual(r.healed && { from: r.healed.from, to: r.healed.to, behind: r.healed.behind }, { from: "0.1.0", to: "0.1.1", behind: 1 });
  assert.match(r.message, /updated from 0\.1\.0 to 0\.1\.1 \(1 commit\), then started/);
  assert.match(serveCalls(install).at(-1), /--idle-exit 30$/);
  assert.match(readFileSync(join(install, "pyproject.toml"), "utf8"), /0\.1\.1/);
  assert.equal((await mod.gatewayStatus()).gateway.outdated, false);
});

await scenario("the checkout is current but the venv still runs the old version: start reinstalls, then starts", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git") }, async ({ root, mod }) => {
  const { install } = await oldInstall(root, { current: true });
  const r = await mod.gatewayStart();
  assert.equal(r.ok, true, r.error ?? r.message);
  assert.deepEqual(r.healed && { from: r.healed.to, behind: r.healed.behind }, { from: "0.1.1", behind: 0 });
  assert.match(serveCalls(install).at(-1), /--idle-exit 30$/);
  assert.equal(pipCalls(install).length, 1);
});

await scenario("the remote cannot be reached: the gateway still starts, without the option, and says so", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git") }, async ({ root, mod }) => {
  const { install } = await oldInstall(root, { unreachable: true });
  const r = await mod.gatewayStart();
  assert.equal(r.ok, true, r.error ?? r.message);
  assert.deepEqual(r.omitted, ["--idle-exit"]);
  assert.match(r.message, /Started without idle exit .*: gateway 0\.1\.0 is older than 0\.1\.1 and the update did not succeed/);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /could not be updated/);
  assert.doesNotMatch(serveCalls(install).at(-1), /--idle-exit/);
  assert.equal(pipCalls(install).length, 0);
});

await scenario("idle exit switched off: an old gateway is not outdated, nothing is updated", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git"), CRISPY_GATEWAY_IDLE_EXIT: "0" }, async ({ root, mod }) => {
  const { install } = await oldInstall(root);
  assert.equal((await mod.gatewayStatus()).gateway.outdated, false);
  const r = await mod.gatewayStart();
  assert.equal(r.ok, true, r.error ?? r.message);
  assert.equal(r.healed, null);
  assert.deepEqual(r.omitted, []);
  assert.doesNotMatch(serveCalls(install).at(-1), /--idle-exit/);
  assert.equal(pipCalls(install).length, 0);
});

await scenario("older than the minimum and the remote cannot be reached: refused, with the versions named", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git") }, async ({ root, mod }) => {
  const { install } = await oldInstall(root, { unreachable: true, installed: "0.0.9" });
  const r = await mod.gatewayStart();
  assert.equal(r.ok, false);
  assert.match(r.message, /needs gateway 0\.1\.0 or newer, and 0\.0\.9 is installed/);
  assert.equal(serveCalls(install).length, 0);
});

await scenario("older than the minimum, remote reachable: brought up to date first", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git") }, async ({ root, mod }) => {
  await oldInstall(root, { installed: "0.0.9" });
  const r = await mod.gatewayStart();
  assert.equal(r.ok, true, r.error ?? r.message);
  assert.equal(r.healed.from, "0.0.9");
  assert.equal(r.healed.to, "0.1.1");
});

await scenario("external checkout is never written to: started without the option, update refuses and says what to do", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git"), CRISPY_GATEWAY_PATH: (r) => join(r, "external") }, async ({ root, mod }) => {
  const { install } = await oldInstall(root, { managed: false });
  writeFileSync(join(install, "local-edits.txt"), "uncommitted work\n");
  const head = gitHead(install);
  const r = await mod.gatewayStart();
  assert.equal(r.ok, true, r.error ?? r.message);
  assert.deepEqual(r.omitted, ["--idle-exit"]);
  assert.match(r.message, /the checkout at .* is not changed by this plugin/);
  const u = await mod.gatewayUpdate();
  assert.equal(u.ok, false);
  assert.equal(u.managed, false);
  assert.match(u.message, /not managed by this plugin, so it was not changed/);
  assert.match(u.error, /git -C ".*" pull && ".*" -m pip install ".*"/);
  assert.equal(gitHead(install), head, "the checkout was moved");
  assert.equal(readFileSync(join(install, "local-edits.txt"), "utf8"), "uncommitted work\n", "uncommitted work was discarded");
  assert.equal(pipCalls(install).length, 0, "pip was run in the external checkout");
});

await scenario("the incident itself: a gateway whose version cannot be read rejects the option, and start returns its own words at once", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git") }, async ({ root, mod }) => {
  const { install } = await oldInstall(root);
  rmSync(join(install, ".venv", "bin", "installed-version.txt"));
  const t0 = Date.now();
  const r = await mod.gatewayStart();
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
  assert.match(r.message, /exited at once instead of starting/);
  assert.match(r.error, /code 2/);
  assert.match(r.detail, /No such option: --idle-exit/);
  assert.equal(existsSync(join(root, "serve.pid")), false, "a dead gateway must not leave a pid behind");
});

await scenario("a gateway that exits at once for any other reason: its error comes back in seconds", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git"), FAKE_SERVE_CRASH: "boom: the port is taken" }, async ({ root, mod }) => {
  await oldInstall(root, { current: true, installed: "0.1.1" });
  const t0 = Date.now();
  const r = await mod.gatewayStart();
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
  assert.match(r.detail, /boom: the port is taken/);
});

await scenario("update: heals an old managed install, and a second update is a no-op that runs no pip", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git") }, async ({ root, mod }) => {
  const { install } = await oldInstall(root);
  const u = await mod.gatewayUpdate();
  assert.equal(u.ok, true, u.error);
  assert.equal(u.updated, true);
  assert.equal(u.behind, 1);
  assert.equal(u.gateway.installed, "0.1.1");
  assert.match(u.message, /Updated: 1 commit, now at [0-9a-f]+\./);
  assert.equal(existsSync(join(root, "serve.pid")), false, "update must not start a gateway that was stopped");
  const again = await mod.gatewayUpdate();
  assert.equal(again.ok, true, again.error);
  assert.equal(again.updated, false);
  assert.match(again.message, /Already on the latest version/);
  assert.equal(pipCalls(install).length, 1);
});

await scenario("update: a behind-count that cannot run is an error, not 'already on latest'", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git"), CRISPY_GATEWAY_GIT: (r) => join(r, "git-without-rev-list") }, async ({ root, mod }) => {
  await oldInstall(root);
  writeFileSync(join(root, "git-without-rev-list"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = rev-list ] && { echo "rev-list is not available" >&2; exit 128; }; done\nexec ${realGit} "$@"\n`);
  chmodSync(join(root, "git-without-rev-list"), 0o755);
  const u = await mod.gatewayUpdate();
  assert.equal(u.ok, false);
  assert.match(u.error, /rev-list/);
  assert.doesNotMatch(u.message ?? "", /Already on the latest/);
});

await scenario("stop: a stale serve.pid naming a live, unrelated process is removed and that process is left alone", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git") }, async ({ root, mod }) => {
  await oldInstall(root, { current: true, installed: "0.1.1" });
  const bystander = spawn("sleep", ["300"], { stdio: "ignore" });
  await sleep(300);
  writeFileSync(join(root, "serve.pid"), String(bystander.pid));
  const r = await mod.gatewayStop();
  assert.equal(r.ok, true);
  assert.equal(r.stopped, false);
  assert.match(r.message, /was not running/);
  assert.equal(bystander.exitCode, null, "the bystander was signalled");
  assert.equal(existsSync(join(root, "serve.pid")), false);
  bystander.kill();
  await new Promise((r2) => bystander.once("exit", r2));
  writeFileSync(join(root, "serve.pid"), String(bystander.pid)); // now a dead process's number
  await mod.gatewayStatus();
  assert.equal(existsSync(join(root, "serve.pid")), false, "status must drop a stale pid file");
});

await scenario("stop: something else on the port is not touched", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git") }, async ({ root, port, mod }) => {
  const server = http.createServer((q, s) => s.end("ok"));
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  try {
    await oldInstall(root, { current: true, installed: "0.1.1" });
    const r = await mod.gatewayStop();
    assert.equal(r.ok, false);
    assert.equal(r.stopped, false);
    assert.match(r.message, /Something else is answering on port \d+\. This plugin only stops the gateway it started/);
    assert.equal(server.listening, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

await scenario("two starts at once give one gateway; stop then stops it and leaves nothing behind", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git") }, async ({ root, port, mod }) => {
  const { install } = await oldInstall(root, { current: true, installed: "0.1.1" });
  const [a, b] = await Promise.all([mod.gatewayStart(), mod.gatewayStart()]);
  assert.ok(a.ok && b.ok, JSON.stringify([a.error, b.error]));
  assert.ok(a.already || b.already, "the second start did not see the first one's gateway");
  assert.equal(serveCalls(install).length, 1);
  assert.equal(existsSync(join(root, "start.lock")), false);
  const s = await mod.gatewayStop();
  assert.equal(s.ok, true, s.error);
  assert.equal(s.stopped, true);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) }));
  assert.equal(existsSync(join(root, "serve.pid")), false);
});

await scenario("a lock left behind by a dead process does not block a start", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git") }, async ({ root, mod }) => {
  const { install } = await oldInstall(root, { current: true, installed: "0.1.1" });
  const dead = spawn("true", [], { stdio: "ignore" });
  await new Promise((r) => dead.once("exit", r));
  mkdirSync(join(root, "start.lock"));
  writeFileSync(join(root, "start.lock", "pid"), String(dead.pid));
  const r = await mod.gatewayStart();
  assert.equal(r.ok, true, r.error ?? r.message);
  assert.equal(serveCalls(install).length, 1);
  assert.equal(existsSync(join(root, "start.lock")), false);
});

await scenario("login dismiss: stops a verifiable poller and removes the record", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git") }, async ({ root, mod }) => {
  const install = join(root, "gateway");
  await oldInstall(root, { current: true, installed: "0.1.1" });
  // a stand-in poller whose command line names the install dir, login and the label
  const poller = spawn(process.execPath, ["-e", `const install = ${JSON.stringify(install)}; // gateway login work\nsetInterval(() => {}, 1e6);`], { stdio: "ignore" });
  await sleep(300);
  writeFileSync(join(root, "login-work.log"), "One-time code: GONE-CODE\nOpen https://github.com/login/device and enter the code to authorize.\n");
  writeFileSync(join(root, "login-work.pid"), String(poller.pid));
  assert.ok((await mod.listPendingLogins()).some((p) => p.label === "work"));
  const r = await mod.loginDismiss("work");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.stopped, true, "the verifiable poller was not stopped");
  assert.equal(r.removed, true);
  await sleep(200);
  assert.ok(poller.exitCode !== null || poller.signalCode !== null, "the poller kept running");
  assert.equal((await mod.listPendingLogins()).some((p) => p.label === "work"), false);
  assert.equal(existsSync(join(root, "login-work.log")), false);
  const again = await mod.loginDismiss("work");
  assert.equal(again.ok, true);
  assert.equal(again.removed, false);
  assert.match(again.message, /No login attempt named 'work'/);
});

await scenario("login dismiss: a stale pid file is cleaned without signalling anyone", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git") }, async ({ root, mod }) => {
  await oldInstall(root, { current: true, installed: "0.1.1" });
  const dead = spawn("true", [], { stdio: "ignore" });
  await new Promise((r) => dead.once("exit", r));
  writeFileSync(join(root, "login-work.log"), "One-time code: OLD-CODE\nOpen https://github.com/login/device and enter the code to authorize.\n");
  writeFileSync(join(root, "login-work.pid"), String(dead.pid));
  const r = await mod.loginDismiss("work");
  assert.equal(r.ok, true);
  assert.equal(r.stopped, false, "a dead pid must not be signalled");
  assert.equal(r.removed, true);
  assert.equal(existsSync(join(root, "login-work.pid")), false);
});

await scenario("login dismiss: a pid that belongs to someone else is not signalled", { CRISPY_GATEWAY_REPO: (r) => join(r, "remote.git") }, async ({ root, mod }) => {
  await oldInstall(root, { current: true, installed: "0.1.1" });
  const bystander = spawn("sleep", ["300"], { stdio: "ignore" });
  await sleep(300);
  writeFileSync(join(root, "login-work.log"), "One-time code: X-CODE\nOpen https://github.com/login/device and enter the code to authorize.\n");
  writeFileSync(join(root, "login-work.pid"), String(bystander.pid));
  const r = await mod.loginDismiss("work");
  assert.equal(r.ok, true);
  assert.equal(r.stopped, false, "an unrelated process was signalled");
  assert.equal(bystander.exitCode, null, "the bystander was killed");
  bystander.kill();
  await new Promise((r) => bystander.once("exit", r));
});

if (REAL) {
  console.log("lifecycle tests (real, network)");
  await scenario("real upgrade path: a clone from before --idle-exit is healed by start", {}, async ({ root, port, mod }) => {
    const first = await mod.gatewayStart();
    assert.equal(first.ok, true, first.error ?? first.message);
    assert.equal(first.installed, true);
    assert.equal((await mod.gatewayStop()).ok, true);
    // the incident machine's state: tree and venv at the commit before --idle-exit
    const install = join(root, "gateway");
    git(install, "reset", "-q", "--hard", "a54bcf1");
    execFileSync(join(install, ".venv", "bin", "python"), ["-m", "pip", "install", "-q", "--disable-pip-version-check", install], { stdio: ["ignore", "pipe", "pipe"] });
    mod.resetCaches();
    const before = await mod.gatewayStatus();
    assert.equal(before.gateway.installed, "0.1.0");
    assert.deepEqual(before.gateway.unsupported, ["--idle-exit"]);
    assert.equal(before.gateway.outdated, true);
    const r = await mod.gatewayStart();
    assert.equal(r.ok, true, r.error ?? r.message);
    assert.equal(r.healed?.from, "0.1.0");
    assert.equal(r.healed?.to, "0.1.1");
    const pid = Number(readFileSync(join(root, "serve.pid"), "utf8").trim());
    assert.match(cmdline(pid) ?? "", /--idle-exit 30/);
    const after = await mod.gatewayStatus();
    assert.equal(after.gateway.outdated, false);
    assert.equal(after.up, true);
    assert.equal((await mod.gatewayStop()).stopped, true);
  });
}

for (const k of Object.keys(process.env)) if (k.startsWith("CRISPY_") || k.startsWith("FAKE_")) delete process.env[k];
console.log(`lifecycle tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
