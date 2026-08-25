import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { validateClaudePackagingContract } from "../../src/activation/claude-packaging.js"

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../../../..", import.meta.url)),
)
const activationManifestPath = "plugins/desk/activation/desk.activation.json"
const evidencePath = "desk/tasks/2026-06-14-1335-doing-desk-dependency-activation/host-capability-evidence.md"
const supportMatrixPath = "plugins/desk/activation/support-matrix.json"
const claudeNativeWorkerSource = "agents/worker.md"
const expectedClaudeSourcePaths = [
  "plugins/desk/.claude-plugin/plugin.json",
  "plugins/desk/.mcp.json",
  `plugins/desk/${claudeNativeWorkerSource}`,
  "plugins/work-suite/.claude-plugin/plugin.json",
  "plugins/plain-language/.claude-plugin/plugin.json",
  "plugins/ponytail-upstream/.claude-plugin/plugin.json",
]
const supportedDispositionStatuses = new Set([
  "supported",
  "supported-with-version-floor",
  "validated",
])
const unsupportedDispositionStatuses = new Set([
  "degraded",
  "unsupported",
])

function readText(...segments) {
  return readFileSync(path.join(repoRoot, ...segments), "utf8")
}

function loadJson(...segments) {
  return JSON.parse(readText(...segments))
}

function parseSimpleFrontmatter(...segments) {
  const text = readText(...segments)
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/u)
  assert.ok(match, `${segments.join("/")} must have YAML frontmatter`)
  return Object.fromEntries(match[1]
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const [key, ...rest] = line.split(":")
      const raw = rest.join(":").trim()
      return [key.trim(), parseScalar(raw)]
    }))
}

function parseScalar(raw) {
  if (raw === "true") return true
  if (raw === "false") return false
  if (raw.startsWith("\"") && raw.endsWith("\"")) return raw.slice(1, -1)
  return raw
}

function marketplacePlugin(name) {
  return loadJson(".claude-plugin", "marketplace.json")
    .plugins
    .find((plugin) => plugin.name === name)
}

function splitMarkdownRow(row) {
  return row.trim().replace(/^\|/u, "").replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim())
}

function parseEvidenceTable(content) {
  const tableRows = content
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("|"))
  const columns = splitMarkdownRow(tableRows[0])
  return tableRows.slice(2).map((line) => {
    const values = splitMarkdownRow(line)
    return Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""]))
  })
}

function splitList(value) {
  if (value === "none") {
    return []
  }
  return value.split(";").map((item) => item.trim()).filter(Boolean)
}

function normalizedEvidenceRows(content) {
  return parseEvidenceTable(content).map((row) => ({
    ...row,
    source_paths: splitList(row.source_paths),
    unsupported_primitives: splitList(row.unsupported_primitives),
  }))
}

function findByField(rows, field, value, source) {
  const row = rows.find((candidate) => candidate[field] === value)
  assert.ok(row, `${source} must include ${field}=${value}`)
  return row
}

function copyHostRow(row) {
  return {
    ...row,
    source_paths: [...row.source_paths],
    unsupported_primitives: [...row.unsupported_primitives],
  }
}

function hasDocumentedField(value, fields) {
  return fields.some((field) => {
    const fieldValue = value[field]
    if (typeof fieldValue === "string") {
      return fieldValue.trim() !== ""
    }
    if (Array.isArray(fieldValue)) {
      return fieldValue.length > 0
    }
    return fieldValue && typeof fieldValue === "object" && Object.keys(fieldValue).length > 0
  })
}

function assertDocumentedDisposition(label, disposition) {
  assert.equal(typeof disposition, "object", `${label} disposition must be documented`)
  assert.notEqual(disposition, null, `${label} disposition must be documented`)
  assert.ok(
    supportedDispositionStatuses.has(disposition.status)
      || unsupportedDispositionStatuses.has(disposition.status),
    `${label} status must be supported, degraded, or unsupported`,
  )

  if (supportedDispositionStatuses.has(disposition.status)) {
    assert.equal(
      disposition.inheritsPluginContext,
      true,
      `${label} supported status must state plugin-context inheritance`,
    )
    assert.ok(
      hasDocumentedField(disposition, ["evidence", "evidenceCommandOrDoc", "validatedBy", "validation"]),
      `${label} supported status must cite validation evidence`,
    )
  } else {
    assert.ok(
      hasDocumentedField(disposition, ["reason", "notes", "fallback", "fallbackBehavior", "degradedBehavior"]),
      `${label} unsupported/degraded status must document the fallback or reason`,
    )
  }

  if (Object.hasOwn(disposition, "minimumClaudeCodeVersion")) {
    assert.match(disposition.minimumClaudeCodeVersion, /^\d+\.\d+\.\d+$/u)
  }
  for (const commandField of ["foregroundLaunch", "backgroundLaunch", "agentViewLaunch"]) {
    if (Object.hasOwn(disposition, commandField)) {
      assert.equal(typeof disposition[commandField], "string")
      assert.match(disposition[commandField], /desk:worker/u)
    }
  }
}

function backgroundSessionDisposition(claudeActivation) {
  if (claudeActivation?.backgroundSessionInheritance) {
    return claudeActivation.backgroundSessionInheritance
  }
  if (claudeActivation?.backgroundSessions) {
    return claudeActivation.backgroundSessions
  }
  const agentView = claudeActivation?.agentView
  if (!agentView || (
    !Object.hasOwn(agentView, "backgroundLaunch")
    && !Object.hasOwn(agentView, "backgroundInheritsPluginContext")
  )) {
    return undefined
  }
  return {
    ...agentView,
    inheritsPluginContext: agentView.backgroundInheritsPluginContext
      ?? agentView.inheritsPluginContext,
    evidence: agentView.backgroundEvidence ?? agentView.evidence,
    reason: agentView.backgroundReason ?? agentView.reason,
    fallback: agentView.backgroundFallback ?? agentView.fallback,
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function currentClaudePackagingInput() {
  const activation = loadJson(activationManifestPath)
  const evidenceRow = findByField(
    normalizedEvidenceRows(readText(evidencePath)),
    "host_id",
    "claude",
    evidencePath,
  )
  const supportMatrix = loadJson(supportMatrixPath)
  return {
    activation,
    claudeActivation: activation.host_activation?.claude,
    deskPlugin: loadJson("plugins", "desk", ".claude-plugin", "plugin.json"),
    evidenceRow,
    supportMatrixRow: findByField(
      supportMatrix.hosts,
      "host_id",
      "claude",
      supportMatrixPath,
    ),
    worker: parseSimpleFrontmatter("plugins", "desk", "agents", "worker.md"),
    workSuitePlugin: loadJson("plugins", "work-suite", ".claude-plugin", "plugin.json"),
  }
}

test("Claude plugin metadata declares native Desk surfaces and Work Suite dependency", () => {
  const deskPlugin = loadJson("plugins", "desk", ".claude-plugin", "plugin.json")
  const workSuitePlugin = loadJson("plugins", "work-suite", ".claude-plugin", "plugin.json")

  assert.equal(deskPlugin.skills, "./skills/")
  assert.deepEqual(deskPlugin.agents, ["./agents/worker.md"])
  assert.equal(deskPlugin.mcpServers, "./.mcp.json")
  assert.equal(deskPlugin.hooks, "./hooks/hooks.json")
  assert.equal(deskPlugin.outputStyles, "./output-styles/")
  assert.deepEqual(deskPlugin.dependencies, [
    {
      name: "work-suite",
      version: "^2.0.0",
    },
    {
      name: "plain-language",
      version: "0.1.0",
    },
    {
      name: "ponytail-upstream",
      version: "4.9.0",
    },
  ])
  assert.equal(Object.hasOwn(deskPlugin, "activation"), false)
  assert.equal(workSuitePlugin.version, "2.0.0")
})

test("Work Suite Claude manifest stays a strict-loadable skill provider", () => {
  const workSuitePlugin = loadJson("plugins", "work-suite", ".claude-plugin", "plugin.json")

  assert.equal(workSuitePlugin.name, "work-suite")
  assert.equal(workSuitePlugin.skills, "./skills/")
  assert.equal(Object.hasOwn(workSuitePlugin, "activation"), false)
})

test("Claude worker agent is exposed without unsupported scoped permission fields", () => {
  const worker = parseSimpleFrontmatter("plugins", "desk", "agents", "worker.md")

  assert.equal(worker.name, "worker")
  assert.equal(worker.model, "inherit")
  assert.equal(worker.background, false)
  assert.equal(worker.initialPrompt, "Run the `desk:session-start` skill before any other work.")
  assert.equal(Object.hasOwn(worker, "hooks"), false)
  assert.equal(Object.hasOwn(worker, "mcpServers"), false)
  assert.equal(Object.hasOwn(worker, "permissionMode"), false)
})

test("Claude activation metadata records Agent View and background-session disposition", () => {
  const activation = loadJson(activationManifestPath)
  const claudeActivation = activation.host_activation?.claude
  const backgroundDisposition = backgroundSessionDisposition(claudeActivation)

  assert.deepEqual(claudeActivation?.targets?.["desk:worker"], {
    default: true,
    source: claudeNativeWorkerSource,
    activationSurface: "plugin-agent",
  })
  assert.deepEqual(claudeActivation?.nativeSurfaces, [
    "skills",
    "agents",
    "hooks",
    "mcpServers",
    "outputStyles",
    "dependencies",
  ])
  assertDocumentedDisposition("Agent View", claudeActivation?.agentView)
  assert.equal(claudeActivation?.agentView?.status, "degraded")
  assert.equal(claudeActivation?.agentView?.inheritsPluginContext, false)
  assertDocumentedDisposition(
    "background-session inheritance",
    backgroundDisposition,
  )
  assert.equal(backgroundDisposition?.status, "unsupported")
  assert.equal(backgroundDisposition?.inheritsPluginContext, false)
})

test("Claude packaging metadata is backed by fresh evidence and support matrix rows", () => {
  const activation = loadJson(activationManifestPath)
  const supportMatrix = loadJson(supportMatrixPath)
  const evidenceRow = findByField(
    normalizedEvidenceRows(readText(evidencePath)),
    "host_id",
    "claude",
    evidencePath,
  )
  const supportMatrixRow = findByField(
    supportMatrix.hosts,
    "host_id",
    "claude",
    supportMatrixPath,
  )
  const activationTarget = findByField(
    activation.provides.activation_targets,
    "id",
    "desk:worker",
    activationManifestPath,
  )
  const activationHostSupport = findByField(
    activation.host_support,
    "host",
    "claude",
    activationManifestPath,
  )

  assert.match(evidenceRow.evidence_command_or_doc, /claude plugin validate plugins\/desk --strict/u)
  assert.match(evidenceRow.evidence_command_or_doc, /claude plugin validate plugins\/work-suite --strict/u)
  assert.match(evidenceRow.evidence_command_or_doc, /unit-4b-claude-help-evidence\.log/u)
  assert.match(evidenceRow.evidence_command_or_doc, /node --test plugins\/desk\/mcp\/__tests__\/activation\/claude_packaging\.test\.js/u)
  assert.deepEqual({
    activationManifestClaudeSource: activationTarget.entrypoints.claude,
    evidenceDisposition: evidenceRow.disposition,
    evidenceFallback: evidenceRow.fallback_behavior,
    evidenceSourcePaths: [...evidenceRow.source_paths],
    evidenceUnsupportedPrimitives: [...evidenceRow.unsupported_primitives],
    supportMatrixGeneratedFrom: supportMatrix.generated_from,
    supportMatrixRow: copyHostRow(supportMatrixRow),
    supportMatrixSourcePaths: [...supportMatrixRow.source_paths],
  }, {
    activationManifestClaudeSource: claudeNativeWorkerSource,
    evidenceDisposition: `${activationHostSupport.status}-${activationHostSupport.dependency_resolution}`,
    evidenceFallback: activationHostSupport.fallback_behavior,
    evidenceSourcePaths: [...expectedClaudeSourcePaths],
    evidenceUnsupportedPrimitives: [...activationHostSupport.unsupported_primitives],
    supportMatrixGeneratedFrom: {
      activation_manifest: activationManifestPath,
      host_capability_evidence: evidencePath,
    },
    supportMatrixRow: copyHostRow(evidenceRow),
    supportMatrixSourcePaths: [...expectedClaudeSourcePaths],
  })
})

test("Claude packaging documents its permission and capability boundary", () => {
  const activation = loadJson(activationManifestPath)
  const claudeActivation = activation.host_activation?.claude

  assert.deepEqual(claudeActivation?.permissionBoundary, {
    requestedCapabilities: ["Read", "Write", "Interactive"],
    generatedArtifacts: [],
    neverDelete: ["desk-root-data"],
    unsupportedAgentScopedFields: ["hooks", "mcpServers", "permissionMode"],
  })
  assert.deepEqual(claudeActivation?.mcpServers?.desk, {
    launch: "plugin-bundled",
    manualRegistration: false,
    configPath: ".mcp.json",
  })
})

test("Claude hook and MCP configuration stay plugin-relative and non-manual", () => {
  const hooks = loadJson("plugins", "desk", "hooks", "hooks.json")
  const mcp = loadJson("plugins", "desk", ".mcp.json")

  assert.equal(hooks.hooks.SessionStart[0].matcher, "startup|resume|clear")
  assert.equal(
    hooks.hooks.SessionStart[0].hooks[0].command,
    "bash ${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh",
  )
  assert.deepEqual(mcp.mcpServers.desk, {
    type: "stdio",
    command: "node",
    args: [
      "-e",
      "const fs=require('node:fs');const path=require('node:path');const {pathToFileURL}=require('node:url');const configured=process.env.DESK_PLUGIN_ROOT;const root=configured&&fs.existsSync(path.join(configured,'mcp','index.js'))?configured:process.cwd();process.env.DESK_PLUGIN_ROOT=root;import(pathToFileURL(path.join(root,'mcp','index.js')).href).then(({main})=>main()).catch((error)=>{console.error(error);process.exitCode=1});",
    ],
    cwd: ".",
    env: {
      DESK_PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}",
    },
  })
  assert.doesNotMatch(JSON.stringify(mcp), /\$\{pluginRoot\}/u)
})

test("Claude-facing manifests stay version-aligned with activation and marketplace metadata", () => {
  const activation = loadJson("plugins", "desk", "activation", "desk.activation.json")
  const deskClaude = loadJson("plugins", "desk", ".claude-plugin", "plugin.json")
  const deskCodex = loadJson("plugins", "desk", ".codex-plugin", "plugin.json")
  const workSuiteClaude = loadJson("plugins", "work-suite", ".claude-plugin", "plugin.json")
  const workSuiteCodex = loadJson("plugins", "work-suite", ".codex-plugin", "plugin.json")

  assert.equal(deskClaude.version, activation.version)
  assert.equal(deskClaude.version, deskCodex.version)
  assert.equal(deskClaude.version, marketplacePlugin("desk").version)
  assert.equal(workSuiteClaude.version, workSuiteCodex.version)
  assert.equal(workSuiteClaude.version, marketplacePlugin("work-suite").version)
  assert.equal(workSuiteClaude.version, activation.dependencies.find((dependency) => (
    dependency.id === "work-suite"
  )).lock.version)
})

test("Claude packaging validation rejects missing Work Suite dependency and stale versions", () => {
  assert.deepEqual(validateClaudePackagingContract(currentClaudePackagingInput()), [])

  const missingDependency = clone(currentClaudePackagingInput())
  missingDependency.deskPlugin.dependencies = []
  assert.deepEqual(
    validateClaudePackagingContract(missingDependency),
    ["missing Work Suite dependency in Claude plugin metadata"],
  )

  const staleDependencyRange = clone(currentClaudePackagingInput())
  staleDependencyRange.deskPlugin.dependencies[0].version = "^1.4.0"
  assert.deepEqual(
    validateClaudePackagingContract(staleDependencyRange),
    ["Claude Work Suite dependency range must be ^2.0.0"],
  )

  const staleProviderVersion = clone(currentClaudePackagingInput())
  staleProviderVersion.workSuitePlugin.version = "1.4.9"
  assert.deepEqual(
    validateClaudePackagingContract(staleProviderVersion),
    ["Work Suite Claude version must match activation lock 2.0.0"],
  )
})

test("Claude packaging validation rejects missing worker exposure and unsupported Agent View assumptions", () => {
  const missingPluginWorker = clone(currentClaudePackagingInput())
  missingPluginWorker.deskPlugin.agents = []
  assert.deepEqual(
    validateClaudePackagingContract(missingPluginWorker),
    ["Claude plugin metadata must expose ./agents/worker.md"],
  )

  const staleActivationWorker = clone(currentClaudePackagingInput())
  staleActivationWorker.claudeActivation.targets["desk:worker"].source = "agents/worker.agent.md"
  assert.deepEqual(
    validateClaudePackagingContract(staleActivationWorker),
    ["Claude activation target desk:worker must use agents/worker.md"],
  )

  const unsupportedManifestField = clone(currentClaudePackagingInput())
  unsupportedManifestField.deskPlugin.activation = { claude: {} }
  assert.deepEqual(
    validateClaudePackagingContract(unsupportedManifestField),
    ["Claude plugin manifest must not include host activation metadata"],
  )

  const unsupportedWorkSuiteManifestField = clone(currentClaudePackagingInput())
  unsupportedWorkSuiteManifestField.workSuitePlugin.activation = { claude: {} }
  assert.deepEqual(
    validateClaudePackagingContract(unsupportedWorkSuiteManifestField),
    ["Claude plugin manifest must not include host activation metadata"],
  )

  const unsupportedAgentViewClaim = clone(currentClaudePackagingInput())
  unsupportedAgentViewClaim.claudeActivation.agentView = {
    ...unsupportedAgentViewClaim.claudeActivation.agentView,
    status: "supported",
    inheritsPluginContext: true,
    evidence: "Claude Code help exposes `claude agents --agent`.",
  }
  assert.deepEqual(
    validateClaudePackagingContract(unsupportedAgentViewClaim),
    ["Agent View support requires dispatched-session smoke evidence"],
  )

  const unsupportedBackgroundClaim = clone(currentClaudePackagingInput())
  unsupportedBackgroundClaim.claudeActivation.backgroundSessionInheritance = {
    ...unsupportedBackgroundClaim.claudeActivation.backgroundSessionInheritance,
    status: "supported",
    inheritsPluginContext: true,
    evidence: "Claude Code help exposes background agent flags.",
  }
  assert.deepEqual(
    validateClaudePackagingContract(unsupportedBackgroundClaim),
    ["background-session support requires dispatched-session smoke evidence"],
  )

  const provenAgentViewClaim = clone(currentClaudePackagingInput())
  provenAgentViewClaim.claudeActivation.agentView = {
    ...provenAgentViewClaim.claudeActivation.agentView,
    status: "supported",
    inheritsPluginContext: true,
    evidence: "Unit 4c dispatched-session smoke loaded desk:worker with Desk plugin context.",
  }
  assert.deepEqual(validateClaudePackagingContract(provenAgentViewClaim), [])
})
