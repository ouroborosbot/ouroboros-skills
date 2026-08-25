---
name: codex-onboarding
description: Verify and repair Codex host-native Desk activation, including plugin source/marketplace exposure, Desk + Work Suite enablement, the activation-owned Desk MCP bridge, runtime dependency pack health, `$DESK` binding, and owned worker-default activation blocks.
---

# Codex onboarding

Use this when a Codex agent needs to verify or repair Desk activation on a machine.

## Target shape

- Local workspace: `$DESK`, commonly `~/desk` for a personal Codex workspace.
- Desk and Work Suite are installed or exposed through the host's plugin loading surface.
- Codex config has:
  - a marketplace/plugin source that exposes Desk and Work Suite.
  - `desk@<marketplace-name>` enabled.
  - `work-suite@<marketplace-name>` enabled.
  - an activation-owned Desk MCP bridge that launches Desk's bundled MCP entrypoint with the activation config.
- The `worker` agent layer is materialized by an owned activation block:
  - **global-personal** (default): every Codex session reads the desk substrate as always-on context.
  - **project-local**: a repo/session owns its local Desk binding.
  - **manual-only**: Desk remains available without default worker behavior.

Codex plugin and MCP changes generally require a new Codex session before the tools and skills appear in the active tool list.

## First distinction: absent vs degraded

Do this before treating `session-start` as healthy:

- **MCP absent from active session** — the active tool list is missing `desk_status` or the Desk MCP namespace/tools. This is a host activation/reload problem, not a desk-index problem. Do not silently continue in local-only mode. `session-start` should explain the consequence and ask whether to repair/reload now or continue without generic reminders; if the operator chooses repair, repair plugin/cache/config, then restart/open a fresh Codex session.
- **MCP present but degraded** — `desk_status` is callable and reports missing/stale local DB, lexical index, vectors, snapshots, or runtime cache. This is a Desk runtime/index problem. Use `desk_status` guidance, `desk_reindex`, runtime-pack verification, and embedding/Ollama checks.
- **Manual-only** — the selected activation intentionally has no default worker instruction block and does not autostart Desk MCP. Do not report it as broken unless the operator expected default worker behavior.

## Verify or repair

1. If this is a local development install, make the host marketplace point at the canonical `ouroboros-skills` checkout, not a long-lived `~/plugins` snapshot. The common Codex implicit marketplace is `~/.agents/plugins/marketplace.json`; its source paths are resolved relative to `$HOME`, so local repo paths should look like:

```json
{
  "name": "ourostack",
  "plugins": [
    {
      "name": "desk",
      "source": { "source": "local", "path": "./Projects/ouroboros-skills/plugins/desk" }
    },
    {
      "name": "work-suite",
      "source": { "source": "local", "path": "./Projects/ouroboros-skills/plugins/work-suite" }
    },
    {
      "name": "plain-language",
      "source": { "source": "local", "path": "./Projects/ouroboros-skills/plugins/plain-language" }
    }
  ]
}
```

Avoid keeping `~/plugins/desk`, `~/plugins/work-suite`, and `~/plugins/plain-language` as the steady-state source unless a separate sync job and audit prove they are fresh. Stale snapshots can keep Codex installing old plugin versions even after the repo and cache look healthy.

2. Ensure the plugin source/marketplace includes `desk`, `work-suite`, and `plain-language`. Use the marketplace `name` as the namespace in config (`desk@<marketplace-name>`), not a hard-coded `ourostack` value. Local development installs may use `ourostack`; older installs may still say `ourostack-local`, but the source path must still resolve to the canonical plugin files.

Run the source/cache/implicit-marketplace audit after repairs:

```bash
node scripts/audit-codex-plugin-cache.cjs --strict
```

This checks the repo marketplace, installed `~/.codex/plugins/cache` manifests, and the host implicit `~/.agents/plugins/marketplace.json` when present. A current repo/cache report with a stale host marketplace still means future Codex sessions can reinstall old plugins.

3. Ensure `~/.codex/config.toml` has an owned Desk activation block equivalent to the adapter output for the selected mode:

```toml
[marketplaces.ourostack-local]
source_type = "local"
source = "/Users/<operator>"

[plugins."desk@ourostack-local"]
enabled = true

[plugins."work-suite@ourostack-local"]
enabled = true

[plugins."plain-language@ourostack-local"]
enabled = true

[plugins."desk@ourostack-local".mcp_servers.desk]
enabled = true
default_tools_approval_mode = "prompt"

[mcp_servers.desk]
command = "node"
args = ["/Users/<operator>/.codex/plugins/cache/ourostack-local/desk/<version>/mcp/index.js", "--activation-config", "/Users/<operator>/.codex/desk.activation.json"]
enabled = true
default_tools_approval_mode = "prompt"
```

The activation-owned top-level `mcp_servers.desk` bridge is generated by the adapter, not by a user running `codex mcp add`. It points at the installed Desk plugin root and passes `--activation-config`, so `desk_status` can report the selected worker/overlay chain. Keep Desk's bundled `.mcp.json` host-neutral for hosts that correctly resolve plugin-relative MCP entries; Codex global activation still writes the direct bridge because current Codex CLI sessions expose plugin MCP entries without the plugin-root cwd.

4. Do not install MCP dependencies inside the plugin and do not register the MCP manually. The healthy path uses the committed runtime dependency pack and a writable runtime cache. Verify the committed pack instead. Set `DESK_PLUGIN_ROOT` explicitly to the canonical repo-backed Desk source (`$REPO/plugins/desk`) or the installed Codex cache path (`$HOME/.codex/plugins/cache/ourostack/desk/<version>`). Do not use durable `~/plugins` snapshots here; they are exactly the stale-source class this repair path is meant to catch.

```bash
DESK_PLUGIN_ROOT="${DESK_PLUGIN_ROOT:?Set DESK_PLUGIN_ROOT to the repo-backed Desk plugin source or installed Codex cache path; do not use ~/plugins snapshots.}"
cd "$DESK_PLUGIN_ROOT/mcp" && npm run runtime:deps-pack:verify
```

5. For an end-to-end stdio smoke, list the server's tool surface with an explicit temporary runtime cache:

```bash
node --input-type=module <<'EOF'
import { spawn } from "node:child_process"

const root = process.env.DESK || `${process.env.HOME}/desk`
if (!process.env.DESK_PLUGIN_ROOT) {
  throw new Error("Set DESK_PLUGIN_ROOT to the repo-backed Desk plugin source or installed Codex cache path; do not use ~/plugins snapshots.")
}
const mcpRoot = `${process.env.DESK_PLUGIN_ROOT}/mcp`
const child = spawn("node", [`${mcpRoot}/index.js`, "--root", root], {
  cwd: process.env.HOME,
  env: {
    ...process.env,
    DESK_RUNTIME_CACHE_DIR: `${process.env.HOME}/.cache/ouroboros-skills/desk-smoke`,
  },
  stdio: ["pipe", "pipe", "pipe"],
})

const stderr = []
let stdout = ""

function send(id, method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
}

function waitFor(id) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${id}: ${stderr.join("")}`)), 20000)
    child.stdout.on("data", function onData(chunk) {
      stdout += chunk.toString("utf8")
      const lines = stdout.split("\n")
      stdout = lines.pop() || ""
      for (const line of lines) {
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (message.id === id) {
          clearTimeout(timeout)
          child.stdout.off("data", onData)
          resolve(message)
        }
      }
    })
  })
}

child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")))
send(1, "initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "desk-smoke", version: "0.0.0" },
})
await waitFor(1)
send(2, "tools/list")
const tools = await waitFor(2)
console.log(tools.result.tools.map((tool) => tool.name).sort().join("\n"))
child.kill("SIGTERM")
EOF
```

The active Codex session will not gain new plugin skills retroactively. Restart Codex or open a fresh session to confirm that `desk`, `work-suite`, and `plain-language` appear in the available plugins/skills list.

6. If you can capture the active tool list, prove MCP visibility separately from cache freshness:

```bash
node scripts/audit-codex-plugin-cache.cjs \
  --active-tools-file active-tools.json \
  --strict-active
```

`active-tools.json` may be an array of tool names/objects or an object with `tools`, `activeTools`, `availableTools`, or `mcpTools`. `--strict-active` intentionally fails when no active tool snapshot is supplied. A current repo/cache report plus missing active tools means the host session has not reloaded or the MCP failed to launch.

## Worker layer

For `global-personal`, activation owns a delimited `AGENTS.md` block that makes Codex behave like `worker` by default. Repair should replace only the owned block and preserve user-authored instructions. For `manual-only`, the block is absent by design. If an explicit subagent surface is available in the host, it can be layered on separately, but it is not the healthy-path requirement for default worker behavior.

## Friction rule

If onboarding reveals a missing Codex instruction, broken manifest, stale path convention, or dependency trap, patch the plugin source first and then reinstall locally from that patched source. A desk that future agents cannot reliably enter is not finished.
