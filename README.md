# zcode-toolbox

Personal ZCode plugin collection, distributed as a self-hosted ZCode marketplace:
one git repo, one entry per plugin, each with its own activate/deactivate toggle
in the Plugins page.

## Plugins

| Plugin | What it does |
|---|---|
| [context-lens](plugins/context-lens/) | Live viewer for the LLM context window: a composer chip (tok/s, provider-exact usage %, cumulative output, last rate in parentheses) + a side-pane view with the full system prompt, all tool schemas and message bodies, stitched from ZCode's model-io diagnostic log. |
| [token-speed](plugins/token-speed/) | Composer chip with the live output tokens-per-second (streaming rate while generating, last rate when idle, ttft and totals in the tooltip) + subagent tracking: per-call rate in the parent session's chip and a side-pane "Subagent speed" view with live rates, totals and status per agent. Works for every provider (rate = usage/duration; streaming rate is a chars-based estimate until the call completes). |
| [copilot-gateway](plugins/copilot-gateway/) | Runs the [crispy-copilot-gateway](https://github.com/golfromeo-fr/crispy-copilot-gateway) (GitHub Copilot API gateway) locally, wrapped for ease of use: on first start the plugin clones the gateway from GitHub into the plugin data dir and installs it (venv + pip), exactly like a manual install would — anonymous hermetic git access, no GitHub credentials used or stored; `gateway_update` keeps the git tree current (fetch, reset, reinstall, restart). Isolated plugin-owned data store — fresh machines just redo the OAuth device flow once. Composer chip (up/latency, credits + accounts in the tooltip), a side-pane view (accounts, device-flow login, proxy keys + account pinning, credits metering, provider-config generator) and MCP tools (`gateway_status/start/stop/update/login/keys/pin/use/credits`). Needs git + python ≥ 3.12 — Linux, Windows 11 (Git for Windows + python.org python; `Scripts\` venv layout and pid-based stop handled), macOS (needs Homebrew/python.org python — the CLT one is < 3.12). |

## Install (any ZCode instance)

1. Plugins page → **Add** → paste `https://github.com/golfromeo-fr/zcode-toolbox`
2. Install the plugins you want (**Context Lens**, **Token Speed**) from the store and toggle them on
3. Hover the composer chip: the tooltip starts with `v<version> ·` — that's the proof the loaded code matches this repo

## Updating

1. Edit `plugins/<plugin>/impl/impl.js` (plugin code), bump `version` in `plugins/<plugin>/.zcode-plugin/plugin.json`
2. Commit + push
3. On any instance: refresh/update the marketplace, then toggle the plugin off/on — the loader shim re-imports `impl/impl.js` with a unique query on every activation, so the new code runs without any app restart

## Why the loader shim

Node caches ESM modules by URL for the process lifetime, so re-activating a plugin
re-runs the *cached* module. The shim (a tiny stable `loader.js` entry) re-imports the
real code with a fresh URL on every activation, which Node treats as a new module.
Trade-off: old impl instances linger in memory until the extension process restarts —
negligible at toggle frequency.
