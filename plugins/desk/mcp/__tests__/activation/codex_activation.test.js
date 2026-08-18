import { test } from "node:test"
import { strict as assert } from "node:assert"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../../../..", import.meta.url)),
)
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")
const fixturesRoot = path.join(mcpRoot, "__tests__", "fixtures", "activation", "codex")
const ledgerPath = ".codex/desk-activation-ledger.json"

const existingConfig = `# user-authored Codex config
model = "gpt-5.4"
approval_policy = "on-request"
`

const existingInstructions = `# user-authored Codex guidance
Keep repo-local rules intact.
`

async function loadCodexAdapter() {
  return import(pathToFileURL(path.join(mcpRoot, "src", "activation", "adapters", "codex.js")))
}

function loadJson(...segments) {
  return JSON.parse(readFileSync(path.join(repoRoot, ...segments), "utf8"))
}

function loadFixture(mode, fileName) {
  return readFileSync(path.join(fixturesRoot, mode, fileName), "utf8")
}

function withTempHost(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "desk-codex-activation-"))
  try {
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function readHostFile(root, relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8")
}

function activationInput(mode, overrides = {}) {
  return {
    manifest: loadJson("plugins", "desk", "activation", "desk.activation.json"),
    mode,
    existingConfig,
    existingInstructions,
    pluginRoot: "plugins/desk",
    workSuitePluginRoot: "plugins/work-suite",
    deskRoot: mode === "project-local" ? ".desk" : "~/desk",
    runtimeCacheDir: mode === "project-local"
      ? ".codex/desk-runtime-cache"
      : "~/.cache/ouroboros-skills/desk",
    ...overrides,
  }
}

function pluginDependency(id, version = "1.0.0") {
  return {
    id,
    kind: "plugin",
    version,
    provenance: {
      source: `plugins/${id}/plugin.json`,
      package: `ourostack/${id}`,
    },
    lock: {
      version,
      integrity: `sha256-${id}-fixture`,
    },
  }
}

function overlayAgent({
  id,
  dependsOn,
  inherits,
  identity,
  addendum,
}) {
  return {
    id,
    kind: "agent-overlay",
    depends_on: dependsOn,
    launch_as: id,
    inherits,
    entrypoints: {
      codex: `agents/${id.replace(/:/gu, "-")}.toml`,
    },
    instructions: {
      identity,
      addendum,
    },
  }
}

function overlayChainManifest() {
  const manifest = loadJson("plugins", "desk", "activation", "desk.activation.json")
  return {
    ...manifest,
    dependencies: [
      ...manifest.dependencies,
      pluginDependency("ms-desk", "2.3.0"),
      pluginDependency("ms-area-desk", "4.5.0"),
    ],
    provides: {
      ...manifest.provides,
      overlay_agents: [
        overlayAgent({
          id: "ms-desk:worker",
          dependsOn: ["desk", "work-suite", "ms-desk"],
          inherits: ["desk:worker"],
          identity: "Microsoft Desk worker",
          addendum: "Use Microsoft employee context without copying Desk setup.",
        }),
        overlayAgent({
          id: "ms-area:worker",
          dependsOn: ["ms-area-desk"],
          inherits: ["ms-desk:worker"],
          identity: "Area Desk worker",
          addendum: "Use area-specific context layered on Microsoft Desk.",
        }),
      ],
    },
  }
}

function assertNoManualSetup(content) {
  assert.doesNotMatch(content, /codex\s+mcp\s+add/i)
  assert.doesNotMatch(content, /~\/\.codex\/agents/i)
  assert.doesNotMatch(content, /copy_to_host/i)
  assert.doesNotMatch(content, /\[desk\.activation]/i)
  assert.doesNotMatch(content, /mcp_auto_start/i)
}

function assertDeskMcpHealthGuard(content) {
  assert.match(content, /Desk MCP health guard/u)
  assert.match(content, /desk_status/u)
  assert.match(content, /do not silently continue in local-only mode/u)
  assert.match(content, /fix\/reload now or continue without reminders/u)
  assert.match(content, /codex-onboarding/u)
}

test("Codex plugin metadata declares host-native Desk activation surfaces", () => {
  const deskPlugin = loadJson("plugins", "desk", ".codex-plugin", "plugin.json")
  const workSuitePlugin = loadJson("plugins", "work-suite", ".codex-plugin", "plugin.json")

  assert.equal(deskPlugin.skills, "./skills/")
  assert.equal(deskPlugin.mcpServers, "./.mcp.json")
  assert.equal(deskPlugin.hooks, "./hooks/hooks.json")
  assert.equal(deskPlugin.activation?.codex?.defaultMode, "global-personal")
  assert.equal(deskPlugin.activation?.codex?.artifactOwner, "desk-activation")
  assert.deepEqual(deskPlugin.activation?.codex?.optOutModes, ["project-local", "manual-only"])
  assert.equal(deskPlugin.activation?.codex?.targets?.["desk:worker"]?.default, true)
  assert.equal(deskPlugin.activation?.codex?.targets?.["desk:worker"]?.source, "agents/worker.toml")
  assert.equal(deskPlugin.activation?.codex?.targets?.["desk:worker"]?.activationSurface, "global-or-project-agents-md")
  assert.deepEqual(deskPlugin.activation?.codex?.nativeSurfaces, [
    "plugins.<plugin>.enabled",
    "plugins.<plugin>.mcp_servers.<server>",
    "mcp_servers.<server>",
    "AGENTS.md",
  ])
  assert.equal(deskPlugin.activation?.codex?.mcpServers?.desk?.launch, "plugin-bundled")
  assert.equal(deskPlugin.activation?.codex?.mcpServers?.desk?.manualRegistration, false)
  assert.deepEqual(deskPlugin.activation?.codex?.dependencies?.["work-suite"], {
    path: "../work-suite",
    version: workSuitePlugin.version,
    resolution: "flattened",
  })
  assert.deepEqual(deskPlugin.activation?.codex?.manualSetupSteps ?? [], [])
})

test("Codex worker source no longer documents healthy-path copy registration", () => {
  const workerToml = readFileSync(path.join(repoRoot, "plugins", "desk", "agents", "worker.toml"), "utf8")
  const workerMarkdown = readFileSync(path.join(repoRoot, "plugins", "desk", "agents", "worker.md"), "utf8")
  const workerAgent = readFileSync(path.join(repoRoot, "plugins", "desk", "agents", "worker.agent.md"), "utf8")
  const workerOutputStyle = readFileSync(path.join(repoRoot, "plugins", "desk", "output-styles", "worker.md"), "utf8")

  assert.doesNotMatch(workerToml, /copy\s+to\s+~\/\.codex\/agents/i)
  assert.doesNotMatch(workerToml, /Invoke via `\/agent worker` once registered/i)
  assert.match(workerToml, /host-native activation/i)
  for (const workerSource of [workerToml, workerMarkdown, workerAgent, workerOutputStyle]) {
    assertDeskMcpHealthGuard(workerSource)
  }
})

test("session-start owns the Desk MCP absence prompt inherited by worker overlays", () => {
  const sessionStart = readFileSync(path.join(repoRoot, "plugins", "desk", "skills", "session-start", "SKILL.md"), "utf8")

  assert.match(sessionStart, /Desk MCP availability checkpoint/u)
  assert.match(sessionStart, /every agent built on `desk:worker`/u)
  assert.match(sessionStart, /including downstream overlays like `ms-desk`/u)
  assert.match(sessionStart, /Desk MCP is not available in this session/u)
  assert.match(sessionStart, /Fix Desk MCP now/u)
  assert.match(sessionStart, /Continue without reminders/u)
  assert.match(sessionStart, /\$DESK\/AGENTS\.md/u)
  assert.match(sessionStart, /durable task lifecycle updates, historical recall, cross-session resumption/u)
})

test("global personal activation materializes worker and Desk as the default", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()
  const result = materializeCodexActivation(activationInput("global-personal"))

  assert.equal(result.mode, "global-personal")
  assert.equal(result.scope, "global")
  assert.equal(result.configPath, "~/.codex/config.toml")
  assert.equal(result.instructionsPath, "~/.codex/AGENTS.md")
  assert.equal(result.activationConfigPath, "~/.codex/desk.activation.json")
  assert.deepEqual(result.manualSetupSteps, [])
  assert.deepEqual(result.permissions.requestedCapabilities, ["Read", "Write", "Interactive"])
  assert.deepEqual(result.permissions.neverDelete, ["desk-root-data"])
  assert.deepEqual(result.generatedArtifacts, [
    {
      owner: "desk-activation",
      kind: "owned-host-config",
      path: "~/.codex/config.toml",
    },
    {
      owner: "desk-activation",
      kind: "owned-host-config",
      path: "~/.codex/desk.activation.json",
    },
    {
      owner: "desk-activation",
      kind: "owned-codex-instructions",
      path: "~/.codex/AGENTS.md",
    },
  ])
  assert.equal(result.generatedConfig, loadFixture("global-personal", "generated-config.toml"))
  assert.equal(result.generatedActivationConfig, loadFixture("global-personal", "generated-activation-config.json"))
  assert.equal(result.generatedInstructions, loadFixture("global-personal", "generated-instructions.md"))
  assertNoManualSetup(result.generatedConfig)
  assert.match(result.generatedConfig, /\[plugins\."desk@ourostack"\]/)
  assert.match(result.generatedConfig, /\[plugins\."desk@ourostack"\.mcp_servers\.desk\]/)
  assert.match(result.generatedConfig, /\[mcp_servers\.desk\]/)
  assert.match(result.generatedConfig, /args = \["plugins\/desk\/mcp\/index\.js", "--activation-config", "~\/\.codex\/desk\.activation\.json"\]/)
  assert.match(result.generatedInstructions, /desk worker by default/)
  assert.match(result.generatedInstructions, /Run the `desk:session-start` skill/)
  assertDeskMcpHealthGuard(result.generatedInstructions)
})

test("global personal activation can select a downstream Desk overlay worker", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()
  const result = materializeCodexActivation(activationInput("global-personal", {
    manifest: overlayChainManifest(),
    selectedActivationId: "ms-area:worker",
  }))

  assert.equal(result.selectedActivation.id, "ms-area:worker")
  assert.deepEqual(result.selectedActivation.chain.map((entry) => entry.id), [
    "desk:worker",
    "ms-desk:worker",
    "ms-area:worker",
  ])
  assert.match(result.generatedConfig, /\[plugins\."work-suite@ourostack"\]/)
  assert.match(result.generatedConfig, /\[plugins\."desk@ourostack"\]/)
  assert.match(result.generatedConfig, /\[plugins\."ms-desk@ourostack"\]/)
  assert.match(result.generatedConfig, /\[plugins\."ms-area-desk@ourostack"\]/)
  assert.match(result.generatedConfig, /\[plugins\."desk@ourostack"\.mcp_servers\.desk\]/)
  assert.equal(result.generatedConfig.match(/mcp_servers\.desk/g).length, 2)
  assert.match(result.generatedInstructions, /You are the Area Desk worker by default\./)
  assert.match(result.generatedInstructions, /Active Desk activation: `desk:worker` -> `ms-desk:worker` -> `ms-area:worker`\./)
  assert.match(result.generatedInstructions, /Microsoft Desk worker: Use Microsoft employee context without copying Desk setup\./)
  assert.match(result.generatedInstructions, /Area Desk worker: Use area-specific context layered on Microsoft Desk\./)
  assert.match(result.generatedInstructions, /Run the `desk:session-start` skill/)
  assert.match(result.generatedActivationConfig, /"selected_id": "ms-area:worker"/)
  assert.match(result.generatedActivationConfig, /"chain": \[\n      "desk:worker",\n      "ms-desk:worker",\n      "ms-area:worker"\n    \]/)
  assertDeskMcpHealthGuard(result.generatedInstructions)
  assertNoManualSetup(result.generatedInstructions)
})

test("Codex activation respects non-default marketplace namespaces", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()
  const result = materializeCodexActivation(activationInput("global-personal", {
    marketplaceNamespace: "ourostack-local",
  }))

  assert.match(result.generatedConfig, /\[plugins\."work-suite@ourostack-local"\]/)
  assert.match(result.generatedConfig, /\[plugins\."desk@ourostack-local"\]/)
  assert.match(result.generatedConfig, /\[plugins\."desk@ourostack-local"\.mcp_servers\.desk\]/)
  assert.doesNotMatch(result.generatedConfig, /desk@ourostack"/u)
  assert.doesNotThrow(() => materializeCodexActivation(activationInput("global-personal", {
    marketplaceNamespace: "ourostack-local",
    existingConfig: `${existingConfig}
[plugins."desk@ourostack"]
enabled = false
`,
  })))
  assert.throws(
    () => materializeCodexActivation(activationInput("global-personal", {
      marketplaceNamespace: "ourostack-local",
      existingConfig: `${existingConfig}
[plugins."desk@ourostack-local"]
enabled = false
`,
    })),
    /user-authored.*disabled.*desk/i,
  )

  const snakeCase = materializeCodexActivation(activationInput("global-personal", {
    marketplace_namespace: "ourostack-snake",
  }))
  assert.match(snakeCase.generatedConfig, /\[plugins\."desk@ourostack-snake"\]/)
})

test("Codex activation escapes direct MCP TOML args for host paths", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()
  const result = materializeCodexActivation(activationInput("global-personal", {
    pluginRoot: String.raw`C:\Users\Ari "Desk"\plugins\desk`,
  }))

  assert.ok(result.generatedConfig.includes(String.raw`args = ["C:\\Users\\Ari \"Desk\"\\plugins\\desk/mcp/index.js", "--activation-config", "~/.codex/desk.activation.json"]`))

  const controlPath = materializeCodexActivation(activationInput("global-personal", {
    pluginRoot: `plugins/desk${String.fromCharCode(1)}`,
  }))
  assert.ok(controlPath.generatedConfig.includes(String.raw`args = ["plugins/desk\u0001/mcp/index.js", "--activation-config", "~/.codex/desk.activation.json"]`))
})

test("Codex activation ignores non-plugin and unknown overlay dependencies in generated plugin config", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()
  const manifest = overlayChainManifest()
  manifest.dependencies.push({
    id: "docs-bundle",
    kind: "artifact",
    version: "1.0.0",
    provenance: {
      source: "plugins/docs-bundle/plugin.json",
      package: "ourostack/docs-bundle",
    },
    lock: {
      version: "1.0.0",
      integrity: "sha256-docs-bundle-fixture",
    },
  })
  manifest.provides.overlay_agents[0].depends_on.push("docs-bundle", "missing-local-plugin")

  const result = materializeCodexActivation(activationInput("global-personal", {
    manifest,
    selectedActivationId: "ms-desk:worker",
  }))

  assert.match(result.generatedConfig, /\[plugins\."ms-desk@ourostack"\]/)
  assert.doesNotMatch(result.generatedConfig, /docs-bundle@ourostack/u)
  assert.doesNotMatch(result.generatedConfig, /missing-local-plugin@ourostack/u)

  const missingDependsManifest = overlayChainManifest()
  delete missingDependsManifest.provides.overlay_agents[0].depends_on
  const missingDepends = materializeCodexActivation(activationInput("global-personal", {
    manifest: missingDependsManifest,
    selectedActivationId: "ms-desk:worker",
  }))
  assert.doesNotMatch(missingDepends.generatedConfig, /ms-desk@ourostack/u)
})

test("Codex activation does not duplicate plugin tables that plugin add already enabled", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()
  const existingInstalledConfig = `${existingConfig}
this line has no equals
bad key = true
plugins."unknown@ourostack".enabled = ["maybe"]

[plugins."work-suite@ourostack"]
enabled = true

[plugins."desk@ourostack"]
enabled = true

[plugins]
"ms-desk@ourostack" = { enabled = true }
`
  const result = materializeCodexActivation(activationInput("global-personal", {
    manifest: overlayChainManifest(),
    selectedActivationId: "ms-desk:worker",
    existingConfig: existingInstalledConfig,
  }))

  assert.equal(result.generatedConfig.match(/\[plugins\."work-suite@ourostack"\]/gu).length, 1)
  assert.equal(result.generatedConfig.match(/\[plugins\."desk@ourostack"\]/gu).length, 1)
  assert.doesNotMatch(result.generatedConfig, /\[plugins\."ms-desk@ourostack"\]/u)
  assert.match(result.generatedConfig, /\[plugins\."desk@ourostack"\.mcp_servers\.desk\]/u)
  assert.match(result.generatedConfig, /\[mcp_servers\.desk\]/u)
})

test("Codex activation replaces stale unowned direct Desk MCP config", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()
  const staleDirectMcpConfig = `${existingConfig}
mcp_servers.desk.command = "older"

[mcp_servers.desk]
command = "node"
args = ["old.js"]
enabled = true

[mcp_servers.desk.env]
DESK = "old"

[mcp_servers.other]
command = "node"
`

  const result = materializeCodexActivation(activationInput("global-personal", {
    existingConfig: staleDirectMcpConfig,
  }))

  assert.equal(result.generatedConfig.match(/^\[mcp_servers\.desk\]$/gmu).length, 1)
  assert.doesNotMatch(result.generatedConfig, /older/u)
  assert.doesNotMatch(result.generatedConfig, /old\.js/u)
  assert.doesNotMatch(result.generatedConfig, /DESK = "old"/u)
  assert.match(result.generatedConfig, /^\[mcp_servers\.other\]$/mu)
  assert.match(result.generatedConfig, /args = \["plugins\/desk\/mcp\/index\.js", "--activation-config", "~\/\.codex\/desk\.activation\.json"\]/u)

  const inlineDeskOnly = materializeCodexActivation(activationInput("global-personal", {
    existingConfig: `${existingConfig}
mcp_servers = { desk = { command = 'node' } }
`,
  }))
  assert.equal(inlineDeskOnly.generatedConfig.match(/^\[mcp_servers\.desk\]$/gmu).length, 1)

  assert.throws(
    () => materializeCodexActivation(activationInput("global-personal", {
      existingConfig: `${existingConfig}
mcp_servers = { desk = { command = "node" }, other = { command = "node" } }
`,
    })),
    /inline mcp_servers\.desk config/u,
  )
})

test("project-local opt-out materializes project config without mutating global defaults", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()
  const result = materializeCodexActivation(activationInput("project-local"))

  assert.equal(result.mode, "project-local")
  assert.equal(result.scope, "project")
  assert.equal(result.configPath, ".codex/config.toml")
  assert.equal(result.instructionsPath, "AGENTS.md")
  assert.equal(result.activationConfigPath, ".codex/desk.activation.json")
  assert.deepEqual(result.manualSetupSteps, [])
  assert.equal(result.generatedArtifacts[0].path, ".codex/config.toml")
  assert.equal(result.generatedArtifacts[1].path, ".codex/desk.activation.json")
  assert.equal(result.generatedArtifacts[2].path, "AGENTS.md")
  assert.equal(result.generatedConfig, loadFixture("project-local", "generated-config.toml"))
  assert.equal(result.generatedActivationConfig, loadFixture("project-local", "generated-activation-config.json"))
  assert.equal(result.generatedInstructions, loadFixture("project-local", "generated-instructions.md"))
  assertNoManualSetup(result.generatedConfig)
  assert.match(result.generatedConfig, /\[mcp_servers\.desk\]/)
  assert.match(result.generatedConfig, /args = \["plugins\/desk\/mcp\/index\.js", "--activation-config", "\.codex\/desk\.activation\.json"\]/)
  assert.match(result.generatedConfig, /cwd = "."/)
  assertDeskMcpHealthGuard(result.generatedInstructions)
})

test("manual-only opt-out keeps Desk available without default worker or MCP autostart", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()
  const result = materializeCodexActivation(activationInput("manual-only"))

  assert.equal(result.mode, "manual-only")
  assert.equal(result.scope, "global")
  assert.equal(result.configPath, "~/.codex/config.toml")
  assert.equal(result.instructionsPath, null)
  assert.equal(result.activationConfigPath, null)
  assert.deepEqual(result.manualSetupSteps, [])
  assert.equal(result.generatedArtifacts.length, 1)
  assert.equal(result.generatedActivationConfig, "")
  assert.equal(result.generatedConfig, loadFixture("manual-only", "generated-config.toml"))
  assert.equal(result.generatedInstructions, "")
  assertNoManualSetup(result.generatedConfig)
  assert.match(result.generatedConfig, /\[plugins\."desk@ourostack"\]/)
  assert.match(result.generatedConfig, /\[plugins\."desk@ourostack"\.mcp_servers\.desk\]/)
  assert.match(result.generatedConfig, /enabled = false/)
})

test("Codex activation preserves user-authored config and instructions with owned generated blocks", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()
  const result = materializeCodexActivation(activationInput("global-personal"))

  assert.equal(result.generatedConfig.startsWith(existingConfig), true)
  assert.match(result.generatedConfig, /# BEGIN desk activation: desk@1\.7\.18 mode=global-personal owner=desk-activation/)
  assert.match(result.generatedConfig, /# END desk activation/)
  assert.equal(result.generatedConfig.match(/# BEGIN desk activation/g).length, 1)
  assert.equal(result.generatedConfig.match(/# END desk activation/g).length, 1)
  assert.equal(result.generatedInstructions.startsWith(existingInstructions), true)
  assert.match(result.generatedInstructions, /# BEGIN desk activation: desk@1\.7\.18 mode=global-personal owner=desk-activation/)
  assert.match(result.generatedInstructions, /# END desk activation/)
  assert.equal(result.generatedInstructions.match(/# BEGIN desk activation/g).length, 1)
  assert.equal(result.generatedInstructions.match(/# END desk activation/g).length, 1)
})

test("Codex activation materializes owned blocks into empty host files", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()
  const result = materializeCodexActivation(activationInput("global-personal", {
    existingConfig: "",
    existingInstructions: "",
  }))

  assert.equal(result.generatedConfig.startsWith("# BEGIN desk activation"), true)
  assert.equal(result.generatedInstructions.startsWith("# BEGIN desk activation"), true)
  assert.doesNotMatch(result.generatedConfig, /^\n/)
  assert.doesNotMatch(result.generatedInstructions, /^\n/)
})

test("Codex activation replaces existing owned blocks and stays idempotent", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()
  const first = materializeCodexActivation(activationInput("global-personal"))
  const repeated = materializeCodexActivation(activationInput("global-personal", {
    existingConfig: first.generatedConfig,
    existingInstructions: first.generatedInstructions,
  }))

  assert.equal(repeated.generatedConfig, first.generatedConfig)
  assert.equal(repeated.generatedInstructions, first.generatedInstructions)
  assert.equal(repeated.generatedConfig.match(/# BEGIN desk activation/g).length, 1)
  assert.equal(repeated.generatedInstructions.match(/# BEGIN desk activation/g).length, 1)
})

test("Codex activation upgrades older owned blocks without duplicating activation content", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()
  const oldConfig = `${existingConfig}
# BEGIN desk activation: desk@1.6.0 mode=manual-only owner=desk-activation
[plugins."desk@ourostack"]
enabled = false
# END desk activation
`
  const oldInstructions = `${existingInstructions}
# BEGIN desk activation: desk@1.6.0 mode=manual-only owner=desk-activation
You are not the desk worker by default.
# END desk activation
`
  const result = materializeCodexActivation(activationInput("global-personal", {
    existingConfig: oldConfig,
    existingInstructions: oldInstructions,
  }))

  assert.doesNotMatch(result.generatedConfig, /desk@1\.6\.0/)
  assert.doesNotMatch(result.generatedInstructions, /desk@1\.6\.0/)
  assert.equal(result.generatedConfig, loadFixture("global-personal", "generated-config.toml"))
  assert.equal(result.generatedInstructions, loadFixture("global-personal", "generated-instructions.md"))
})

test("Codex activation fails closed for malformed owned activation blocks", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()

  assert.throws(
    () => materializeCodexActivation(activationInput("global-personal", {
      existingConfig: `${existingConfig}
# BEGIN desk activation: desk@1.7.3 mode=global-personal owner=desk-activation
[plugins."desk@ourostack"]
enabled = true
`,
    })),
    /malformed owned desk activation block/i,
  )

  assert.throws(
    () => materializeCodexActivation(activationInput("global-personal", {
      existingInstructions: `${existingInstructions}
# END desk activation
`,
    })),
    /malformed owned desk activation block/i,
  )

  assert.throws(
    () => materializeCodexActivation(activationInput("global-personal", {
      existingConfig: `${existingConfig}
# END desk activation
# BEGIN desk activation: desk@1.7.3 mode=global-personal owner=desk-activation
`,
    })),
    /malformed owned desk activation block/i,
  )
})

test("Codex activation rejects duplicate owned activation blocks", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()
  const duplicateOwnedConfig = `${existingConfig}
# BEGIN desk activation: desk@1.7.2 mode=global-personal owner=desk-activation
[plugins."desk@ourostack"]
enabled = true
# END desk activation

# BEGIN desk activation: desk@1.7.3 mode=global-personal owner=desk-activation
[plugins."desk@ourostack"]
enabled = true
# END desk activation
`

  assert.throws(
    () => materializeCodexActivation(activationInput("global-personal", {
      existingConfig: duplicateOwnedConfig,
    })),
    /multiple owned desk activation blocks/i,
  )
})

test("Codex activation replaces an owned block at EOF without adding extra spacing", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()
  const eofConfig = `${existingConfig}
# BEGIN desk activation: desk@1.7.2 mode=manual-only owner=desk-activation
[plugins."desk@ourostack"]
enabled = false
# END desk activation`
  const result = materializeCodexActivation(activationInput("global-personal", {
    existingConfig: eofConfig,
  }))

  assert.equal(result.generatedConfig, loadFixture("global-personal", "generated-config.toml"))
})

test("Codex activation does not silently override user-authored disabled Desk config", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()
  const disabledDeskConfigs = [
    `${existingConfig}
[plugins."desk@ourostack"]
enabled = false
`,
    `${existingConfig}
[plugins."desk@ourostack".mcp_servers.desk]
enabled = false
`,
    `${existingConfig}
plugins."desk@ourostack".enabled = false
`,
    `${existingConfig}
plugins."desk\\u0040ourostack".enabled = false
`,
    `${existingConfig}
plugins."desk\\U00000040ourostack".enabled = false
`,
    `${existingConfig}
plugins.'desk@ourostack'.enabled = false
`,
    `${existingConfig}
plugins."desk@ourostack".mcp_servers.desk.enabled = false
`,
    `${existingConfig}
[plugins]
"desk@ourostack" = { enabled = false }
`,
    `${existingConfig}
[plugins]
"desk@ourostack" = { mcp_servers = { desk = { enabled = false } } }
`,
    `${existingConfig}
plugins."desk@ourostack" = { enabled = false }
`,
    `${existingConfig}
plugins."desk@ourostack".mcp_servers.desk = { enabled = false }
`,
    `${existingConfig}
plugins."desk@ourostack".mcp_servers = { desk = { enabled = false } }
`,
    `${existingConfig}
plugins."desk@ourostack" = { mcp_servers.foo.enabled = true, mcp_servers.desk.enabled = false }
`,
    `${existingConfig}
[plugins."desk@ourostack".mcp_servers]
desk = { enabled = false }
`,
    `${existingConfig}
[plugins."desk@ourostack"]
mcp_servers = { desk = { enabled = false } }
`,
    `${existingConfig}
mcp_servers.desk.enabled = false
`,
    `${existingConfig}
[mcp_servers.desk]
enabled = false
`,
    `${existingConfig}
[mcp_servers]
desk = { enabled = false }
`,
    `${existingConfig}
mcp_servers = { desk = { enabled = false } }
`,
    `${existingConfig}
[[plugins."desk@ourostack".mcp_servers.desk]]
enabled = false
`,
  ]

  for (const disabledConfig of disabledDeskConfigs) {
    assert.throws(
      () => materializeCodexActivation(activationInput("global-personal", {
        existingConfig: disabledConfig,
      })),
      /user-authored.*disabled.*desk/i,
    )
  }
})

test("Codex disabled-Desk scanner allows unrelated TOML while scanning defensive shapes", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()
  const safeConfig = `${existingConfig}
note = "escaped \\" # is still inside the string" # real comment
plugins."work-suite@ourostack".enabled = false
plugins."desk@ourostack".enabled = true
plugins."desk@ourostack" = {}
plugins."desk@ourostack".mcp_servers = { desk = { enabled = true } }
plugins."desk@ourostack".mcp_servers = { desk = { enabled = "false" } }
plugins."desk@ourostack" = { mcp_servers = { other = { enabled = false } } }
plugins."desk@ourostack" = { ignored }
plugins."desk@ourostack" = { bad@key = false }
not_a_toml_assignment
plugins."desk@ourostack".bad@key = false
`

  assert.doesNotThrow(
    () => materializeCodexActivation(activationInput("global-personal", {
      existingConfig: safeConfig,
    })),
  )
})

test("Codex activation rejects unsupported requested host capabilities", async () => {
  const { materializeCodexActivation } = await loadCodexAdapter()
  const manifest = activationInput("global-personal").manifest
  manifest.permissions.requested_capabilities = ["Read", "Write", "Interactive", "Network"]

  assert.throws(
    () => materializeCodexActivation(activationInput("global-personal", { manifest })),
    /permission.*Network.*not declared|unsupported capability/i,
  )
})

test("Codex activation applies generated artifacts through the ownership ledger", async () => {
  const { applyCodexActivation } = await loadCodexAdapter()

  withTempHost((root) => {
    const result = applyCodexActivation(activationInput("project-local", {
      hostRoot: root,
      ledgerPath,
      now: "2026-06-14T19:00:00.000Z",
    }))

    assert.equal(readHostFile(root, ".codex/config.toml"), loadFixture("project-local", "generated-config.toml"))
    assert.equal(readHostFile(root, ".codex/desk.activation.json"), loadFixture("project-local", "generated-activation-config.json"))
    assert.equal(readHostFile(root, "AGENTS.md"), loadFixture("project-local", "generated-instructions.md"))
    assert.equal(result.activation.mode, "project-local")
    assert.equal(result.ledger.activation.host, "codex")
    assert.equal(result.ledger.activation.generated_by, "codex-adapter")
    assert.deepEqual(result.ledger.never_delete, ["desk-root-data"])
    assert.deepEqual(
      result.ledger.artifacts.map((artifact) => ({
        owner: artifact.owner,
        kind: artifact.kind,
        path: artifact.path,
        updated_at: artifact.updated_at,
      })),
      [
        {
          owner: "desk-activation",
          kind: "owned-host-config",
          path: ".codex/config.toml",
          updated_at: "2026-06-14T19:00:00.000Z",
        },
        {
          owner: "desk-activation",
          kind: "owned-host-config",
          path: ".codex/desk.activation.json",
          updated_at: "2026-06-14T19:00:00.000Z",
        },
        {
          owner: "desk-activation",
          kind: "owned-codex-instructions",
          path: "AGENTS.md",
          updated_at: "2026-06-14T19:00:00.000Z",
        },
      ],
    )
    assert.equal(existsSync(path.join(root, ledgerPath)), true)
  })
})

test("Codex global activation applies tilde artifacts under the host root ledger", async () => {
  const { applyCodexActivation, deactivateCodexActivation } = await loadCodexAdapter()

  withTempHost((root) => {
    const result = applyCodexActivation(activationInput("global-personal", {
      hostRoot: root,
    }))

    assert.equal(readHostFile(root, ".codex/config.toml"), loadFixture("global-personal", "generated-config.toml"))
    assert.equal(readHostFile(root, ".codex/desk.activation.json"), loadFixture("global-personal", "generated-activation-config.json"))
    assert.equal(readHostFile(root, ".codex/AGENTS.md"), loadFixture("global-personal", "generated-instructions.md"))
    assert.deepEqual(
      result.ledger.artifacts.map((artifact) => artifact.path),
      [".codex/config.toml", ".codex/desk.activation.json", ".codex/AGENTS.md"],
    )
    assert.match(result.ledger.updated_at, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(existsSync(path.join(root, ledgerPath)), true)

    const deactivation = deactivateCodexActivation({ hostRoot: root })
    assert.deepEqual(
      deactivation.removed.map((artifact) => ({ path: artifact.path, kind: artifact.kind })),
      [
        { path: ".codex/config.toml", kind: "owned-host-config" },
        { path: ".codex/desk.activation.json", kind: "owned-host-config" },
        { path: ".codex/AGENTS.md", kind: "owned-codex-instructions" },
        { path: ledgerPath, kind: "activation-ledger" },
      ],
    )
    assert.equal(existsSync(path.join(root, ledgerPath)), false)
  })
})

test("Codex activation deactivates generated artifacts through the ownership ledger", async () => {
  const { applyCodexActivation, deactivateCodexActivation } = await loadCodexAdapter()

  withTempHost((root) => {
    applyCodexActivation(activationInput("project-local", {
      hostRoot: root,
      ledgerPath,
      now: "2026-06-14T19:00:00.000Z",
    }))

    const result = deactivateCodexActivation({ hostRoot: root, ledgerPath })

    assert.equal(readHostFile(root, ".codex/config.toml"), existingConfig)
    assert.equal(readHostFile(root, "AGENTS.md"), existingInstructions)
    assert.deepEqual(
      result.removed.map((artifact) => ({ path: artifact.path, kind: artifact.kind })),
      [
        { path: ".codex/config.toml", kind: "owned-host-config" },
        { path: ".codex/desk.activation.json", kind: "owned-host-config" },
        { path: "AGENTS.md", kind: "owned-codex-instructions" },
        { path: ledgerPath, kind: "activation-ledger" },
      ],
    )
    assert.equal(existsSync(path.join(root, ledgerPath)), false)
  })
})
