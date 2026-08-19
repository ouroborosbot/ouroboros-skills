import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { validateCopilotPackagingContract } from "../../src/activation/copilot-bundle.js"

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../../../..", import.meta.url)),
)
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")
const activationManifestPath = "plugins/desk/activation/desk.activation.json"
const copilotBundlePath = "plugins/desk/activation/copilot-root.flattened-bundle.json"
const evidencePath = "desk/tasks/2026-06-14-1335-doing-desk-dependency-activation/host-capability-evidence.md"
const supportMatrixPath = "plugins/desk/activation/support-matrix.json"
const copilotWorkerSource = "agents/worker.agent.md"
const copilotBundleCommand =
  "npm --prefix plugins/desk/mcp run activation:copilot-bundle:generate"
const expectedCopilotSourcePaths = [
  "plugins/desk/plugin.json",
  "plugins/desk/agents/worker.agent.md",
  "plugins/desk/.mcp.copilot.json",
  "plugins/work-suite/plugin.json",
  copilotBundlePath,
]

function readText(...segments) {
  return readFileSync(path.join(repoRoot, ...segments), "utf8")
}

function loadJson(...segments) {
  return JSON.parse(readText(...segments))
}

function assertFileExists(...segments) {
  const file = path.join(repoRoot, ...segments)
  assert.equal(existsSync(file), true, `${segments.join("/")} must exist`)
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

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function currentCopilotPackagingInput() {
  const activation = loadJson(activationManifestPath)
  return {
    activation,
    bundle: loadJson(...copilotBundlePath.split("/")),
    deskPlugin: loadJson("plugins", "desk", "plugin.json"),
    workSuitePlugin: loadJson("plugins", "work-suite", "plugin.json"),
  }
}

function expectedCopilotBundle() {
  const activation = loadJson(activationManifestPath)
  const lockedWorkSuiteVersion = activation.dependencies.find((dependency) => (
    dependency.id === "work-suite"
  )).lock.version

  return {
    schema_version: 1,
    host: "copilot-root",
    generated_by: copilotBundleCommand,
    generated_from: {
      activation_manifest: activationManifestPath,
      desk_plugin: "plugins/desk/plugin.json",
      work_suite_plugin: "plugins/work-suite/plugin.json",
    },
    launch: {
      agent: `plugins/desk/${copilotWorkerSource}`,
      mcp: "plugins/desk/.mcp.copilot.json",
    },
    dependency_closure: [
      {
        id: "desk",
        version: activation.version,
        plugin: "plugins/desk/plugin.json",
        skills: "plugins/desk/skills/",
        agents: "plugins/desk/agents/",
        mcpServers: "plugins/desk/.mcp.copilot.json",
      },
      {
        id: "work-suite",
        version: lockedWorkSuiteVersion,
        plugin: "plugins/work-suite/plugin.json",
        skills: "plugins/work-suite/skills/",
      },
    ],
    manual_steps: [],
  }
}

test("Copilot root plugin metadata exposes Desk worker and MCP without manual registration", () => {
  const activation = loadJson(activationManifestPath)
  const deskPlugin = loadJson("plugins", "desk", "plugin.json")
  const worker = parseSimpleFrontmatter("plugins", "desk", "agents", "worker.agent.md")
  const activationTarget = findByField(
    activation.provides.activation_targets,
    "id",
    "desk:worker",
    activationManifestPath,
  )

  assert.equal(deskPlugin.name, "desk")
  assert.equal(deskPlugin.version, activation.version)
  assert.equal(deskPlugin.version, marketplacePlugin("desk").version)
  assert.equal(deskPlugin.agents, "./agents/")
  assert.equal(deskPlugin.skills, "./skills/")
  assert.equal(deskPlugin.mcpServers, "./.mcp.copilot.json")
  assert.deepEqual(deskPlugin.activation?.copilot?.targets?.["desk:worker"], {
    default: true,
    source: copilotWorkerSource,
    activationSurface: "root-plugin-agent",
  })
  assert.equal(activationTarget.entrypoints.copilot, copilotWorkerSource)
  assert.deepEqual(deskPlugin.activation?.copilot?.manualSetupSteps, [])

  assert.equal(worker.name, "worker")
  assert.equal(worker.target, "github-copilot")
  assert.equal(worker["user-invocable"], true)
})

test("Work Suite root plugin metadata provides the flattened dependency provider", () => {
  assertFileExists("plugins", "work-suite", "plugin.json")

  const activation = loadJson(activationManifestPath)
  const workSuitePlugin = loadJson("plugins", "work-suite", "plugin.json")
  const lockedWorkSuiteVersion = activation.dependencies.find((dependency) => (
    dependency.id === "work-suite"
  )).lock.version

  assert.equal(workSuitePlugin.name, "work-suite")
  assert.equal(workSuitePlugin.version, lockedWorkSuiteVersion)
  assert.equal(workSuitePlugin.version, marketplacePlugin("work-suite").version)
  assert.equal(workSuitePlugin.skills, "./skills/")
  assert.deepEqual(workSuitePlugin.activation?.copilot?.dependencyProvider, {
    id: "work-suite",
    version: lockedWorkSuiteVersion,
    resolution: "flattened",
  })
})

test("Copilot root packaging declares a generated flattened dependency closure", () => {
  assertFileExists(...copilotBundlePath.split("/"))

  const activation = loadJson(activationManifestPath)
  const deskPlugin = loadJson("plugins", "desk", "plugin.json")
  const bundle = loadJson(...copilotBundlePath.split("/"))
  const lockedWorkSuiteVersion = activation.dependencies.find((dependency) => (
    dependency.id === "work-suite"
  )).lock.version

  assert.deepEqual(deskPlugin.activation?.copilot?.dependencies?.["work-suite"], {
    path: "../work-suite",
    version: lockedWorkSuiteVersion,
    resolution: "flattened",
    bundleMetadata: copilotBundlePath,
  })
  assert.deepEqual(bundle, expectedCopilotBundle())
})

test("generated Copilot flattened bundle is fresh and package-scripted", async () => {
  assertFileExists(...copilotBundlePath.split("/"))
  assertFileExists("plugins", "desk", "mcp", "scripts", "generate-copilot-bundle.js")

  const packageJson = loadJson("plugins", "desk", "mcp", "package.json")
  assert.equal(
    packageJson.scripts["activation:copilot-bundle:generate"],
    "node scripts/generate-copilot-bundle.js",
  )

  await import(`${pathToFileURL(path.join(mcpRoot, "scripts", "generate-copilot-bundle.js")).href}?test=unit5a`)

  assert.equal(process.exitCode, 0)
  assert.deepEqual(loadJson(...copilotBundlePath.split("/")), expectedCopilotBundle())
})

test("Copilot root evidence and support matrix record flattened packaging as generated", () => {
  const supportMatrix = loadJson(supportMatrixPath)
  const evidenceRow = findByField(
    normalizedEvidenceRows(readText(evidencePath)),
    "host_id",
    "copilot-root",
    evidencePath,
  )
  const supportMatrixRow = findByField(
    supportMatrix.hosts,
    "host_id",
    "copilot-root",
    supportMatrixPath,
  )

  assert.equal(evidenceRow.surface, "Root plugin package for Copilot-compatible hosts")
  assert.equal(evidenceRow.disposition, "supported-flattened")
  assert.deepEqual(evidenceRow.source_paths, expectedCopilotSourcePaths)
  assert.match(evidenceRow.evidence_command_or_doc, /activation:copilot-bundle:generate/u)
  assert.match(evidenceRow.evidence_command_or_doc, /copilot_packaging\.test\.js/u)
  assert.deepEqual(evidenceRow.unsupported_primitives, ["transitive-dependency-resolution"])
  assert.equal(
    evidenceRow.fallback_behavior,
    "load the generated flattened Desk plus Work Suite bundle metadata",
  )
  assert.deepEqual(supportMatrixRow, evidenceRow)
})

test("Copilot root package docs avoid healthy-path manual dependency setup", () => {
  const readme = readText("plugins", "desk", "README.md")
  const agentDocs = readText("plugins", "desk", "docs", "agent-files.md")
  const workSuiteReadme = readText("plugins", "work-suite", "README.md")

  assert.doesNotMatch(readme, /copilot plugin install ourostack\/ouroboros-skills:plugins\/work-suite/u)
  assert.doesNotMatch(agentDocs, /Copilot CLI doesn't auto-resolve transitive plugin deps/u)
  assert.doesNotMatch(workSuiteReadme, /copilot plugin install ourostack\/ouroboros-skills:plugins\/work-suite/u)
})

test("Copilot packaging validation rejects missing root surfaces and stale versions", () => {
  assert.deepEqual(validateCopilotPackagingContract(currentCopilotPackagingInput()), [])

  const missingAgents = clone(currentCopilotPackagingInput())
  delete missingAgents.deskPlugin.agents
  assert.deepEqual(
    validateCopilotPackagingContract(missingAgents),
    ["Copilot root plugin metadata must expose ./agents/"],
  )

  const missingSkills = clone(currentCopilotPackagingInput())
  missingSkills.deskPlugin.skills = undefined
  assert.deepEqual(
    validateCopilotPackagingContract(missingSkills),
    ["Copilot root plugin metadata must expose ./skills/"],
  )

  const missingMcp = clone(currentCopilotPackagingInput())
  missingMcp.deskPlugin.mcpServers = "./missing-mcp.json"
  assert.deepEqual(
    validateCopilotPackagingContract(missingMcp),
    ["Copilot root plugin metadata must expose ./.mcp.copilot.json"],
  )

  const staleDeskVersion = clone(currentCopilotPackagingInput())
  staleDeskVersion.deskPlugin.version = "1.7.2"
  assert.deepEqual(
    validateCopilotPackagingContract(staleDeskVersion),
    ["Copilot root Desk version must match activation version 1.7.19"],
  )

  const staleWorkSuiteVersion = clone(currentCopilotPackagingInput())
  staleWorkSuiteVersion.workSuitePlugin.version = "1.4.8"
  assert.deepEqual(
    validateCopilotPackagingContract(staleWorkSuiteVersion),
    ["Copilot root Work Suite version must match activation lock 1.5.4"],
  )
})

test("Copilot packaging validation rejects incomplete flattened dependency closure", () => {
  const missingActivationDependencies = clone(currentCopilotPackagingInput())
  delete missingActivationDependencies.activation.dependencies
  assert.deepEqual(
    validateCopilotPackagingContract(missingActivationDependencies),
    ["Copilot activation must lock Work Suite dependency"],
  )

  const missingActivationLock = clone(currentCopilotPackagingInput())
  missingActivationLock.activation.dependencies =
    missingActivationLock.activation.dependencies.filter((entry) => entry.id !== "work-suite")
  assert.deepEqual(
    validateCopilotPackagingContract(missingActivationLock),
    ["Copilot activation must lock Work Suite dependency"],
  )

  const missingWorkSuitePlugin = clone(currentCopilotPackagingInput())
  delete missingWorkSuitePlugin.workSuitePlugin
  assert.deepEqual(
    validateCopilotPackagingContract(missingWorkSuitePlugin),
    ["Copilot root Work Suite version must match activation lock 1.5.4"],
  )

  const missingBundle = clone(currentCopilotPackagingInput())
  delete missingBundle.bundle
  assert.deepEqual(
    validateCopilotPackagingContract(missingBundle),
    ["Copilot flattened bundle must include work-suite dependency closure"],
  )

  const missingBundleDependency = clone(currentCopilotPackagingInput())
  missingBundleDependency.bundle.dependency_closure =
    missingBundleDependency.bundle.dependency_closure.filter((entry) => entry.id !== "work-suite")
  assert.deepEqual(
    validateCopilotPackagingContract(missingBundleDependency),
    ["Copilot flattened bundle must include work-suite dependency closure"],
  )

  const missingBundleClosure = clone(currentCopilotPackagingInput())
  delete missingBundleClosure.bundle.dependency_closure
  assert.deepEqual(
    validateCopilotPackagingContract(missingBundleClosure),
    ["Copilot flattened bundle must include work-suite dependency closure"],
  )

  const malformedBundleClosure = clone(currentCopilotPackagingInput())
  malformedBundleClosure.bundle.dependency_closure = [null]
  assert.deepEqual(
    validateCopilotPackagingContract(malformedBundleClosure),
    ["Copilot flattened bundle must include work-suite dependency closure"],
  )

  const missingBundleMetadata = clone(currentCopilotPackagingInput())
  delete missingBundleMetadata.deskPlugin.activation.copilot.dependencies["work-suite"]
  assert.deepEqual(
    validateCopilotPackagingContract(missingBundleMetadata),
    ["Copilot Work Suite dependency must point to generated flattened bundle metadata"],
  )

  const staleBundlePath = clone(currentCopilotPackagingInput())
  staleBundlePath.deskPlugin.activation.copilot.dependencies["work-suite"].bundleMetadata =
    "plugins/desk/activation/old-bundle.json"
  assert.deepEqual(
    validateCopilotPackagingContract(staleBundlePath),
    ["Copilot Work Suite dependency must point to generated flattened bundle metadata"],
  )

  const missingWorker = clone(currentCopilotPackagingInput())
  delete missingWorker.deskPlugin.activation.copilot.targets["desk:worker"]
  assert.deepEqual(
    validateCopilotPackagingContract(missingWorker),
    ["Copilot desk:worker target must use agents/worker.agent.md"],
  )

  const wrongWorker = clone(currentCopilotPackagingInput())
  wrongWorker.deskPlugin.activation.copilot.targets["desk:worker"].source = "agents/worker.md"
  assert.deepEqual(
    validateCopilotPackagingContract(wrongWorker),
    ["Copilot desk:worker target must use agents/worker.agent.md"],
  )
})
