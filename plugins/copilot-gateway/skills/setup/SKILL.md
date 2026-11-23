---
name: setup
description: Set up the local crispy-copilot-gateway (GitHub Copilot API gateway) for use with ZCode: install, connect a GitHub account via device flow, create a proxy key, and get the provider config block. Use when the user asks to set up, connect, or wire the Copilot gateway, or when gateway tools report down/not-configured.
---

# Set up the Copilot gateway

Control plane for the local **crispy-copilot-gateway** service (OpenAI/Anthropic-compatible endpoints backed by GitHub Copilot, with credits metering). The plugin manages the gateway like a manual install would: `gateway_start` clones it from GitHub (`gateway_repo` userConfig) into the plugin data dir and installs the venv; all git access is anonymous and hermetic (user/system gitconfig ignored, no credential helpers, no terminal prompt) — the plugin never uses or stores any GitHub credentials; `gateway_update` fetches, resets to origin/main, reinstalls deps and restarts the service. `gateway_path` userConfig optionally points at an external checkout instead (never touched by update).

## 1. Preflight

Platform requirements: git + python >= 3.12 on PATH. Windows: Git for Windows + python.org python (installer PATH option); the plugin handles the `Scripts\` venv layout and kills the service by pid, no pkill needed. macOS: git ships with the Xcode CLT, but its python3 is older than 3.12 — install python via Homebrew (`brew install python`) or python.org; discovery then just works (venv bin/, `open` for the OAuth browser, pid-based stop).

Run the `gateway_status` MCP tool first. Interpretation guide:

- `up: true` — everything already works; skip to step 4 (provider config) if the harness isn't wired yet.
- `up: false` — use `gateway_start`.
- down + `venvOk: false` — not installed yet: just call `gateway_start`. It clones the gateway from GitHub into the plugin data dir and installs it (venv + pip; needs git, python>=3.12, one-time network, ~20s) and then serves it.
- down + venvOk true — just use `gateway_start` and re-check status.
- `accounts: []` — no GitHub account connected yet → device-flow login (step 2).

## 1b. Start/stop

`gateway_start` is a no-op when already up (health-check first, never double-starts); first run auto-installs the embedded gateway (no separate checkout needed). `gateway_stop` kills only the exact host:port instance from status. The plugin-managed gateway uses its own store at the plugin data dir's `store/` subdirectory — isolated from any standalone gateway checkout, so a fresh machine starts with zero accounts and zero keys: do the device-flow login (step 2) once there.

## 2. Connect a GitHub account (device flow)

Use `gateway_login {label}` — it auto-installs if needed, spawns the device flow, opens github.com/login/device in the system browser (xdg-open/open/start), and returns `{code, url, openedInBrowser}`. Tell the user to enter the code shown in the view (click to copy) and authorize. Then `gateway_login_check {label}` until `phase: "connected"` (the background process finishes automatically). A fresh connection becomes the active account.

## 3. Keys

- List with `gateway_keys`. Create with `gateway_key_create {name}` — the raw `ck_...` key is returned **once**; the user must save it.
- Pin a harness to a specific account with `gateway_key_pin {name, label}` (omit label to follow the active account).
- Revoked/handed-out keys can't be recovered, only revoked and re-created.

## 4. Provider config for ZCode (or any harness)

`gateway_use {keyName}` finds-or-returns the key and composes `{baseUrl, apiKey, models}`.

When the harness is ZCode itself, the provider block goes into ZCode settings under custom providers (baseUrl `http://127.0.0.1:8812/v1`) and model ids from the gateway's catalog (46+ ids served as OpenAI-compatible). Point the user at the ZCode provider settings UI/settings JSON; plugins cannot register model providers themselves — wiring the provider is the one manual step.
