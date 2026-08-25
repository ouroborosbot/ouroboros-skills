import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { validateOuroborosStdioPackagingContract } from "../../src/activation/ouroboros-stdio-packaging.js"

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../../../..", import.meta.url)),
)
const activationManifestPath = "plugins/desk/activation/desk.activation.json"
const evidencePath = "desk/tasks/2026-06-14-1335-doing-desk-dependency-activation/host-capability-evidence.md"
const supportMatrixPath = "plugins/desk/activation/support-matrix.json"
const unitTestCommand =
  "node --test plugins/desk/mcp/__tests__/activation/ouroboros_stdio_packaging.test.js"

function readText(...segments) {
  return readFileSync(path.join(repoRoot, ...segments), "utf8")
}

function loadJson(...segments) {
  return JSON.parse(readText(...segments))
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

function normalizedEvidenceRows() {
  return parseEvidenceTable(readText(...evidencePath.split("/"))).map((row) => ({
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

function assertIncludesAll(actual, expected, label) {
  for (const item of expected) {
    assert.ok(actual.includes(item), `${label} must include ${item}`)
  }
}

function sectionBetween(markdown, heading, nextHeadingLevel = "###") {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const match = markdown.match(new RegExp(
    `^${escapedHeading}\\n(?<body>[\\s\\S]*?)(?=^${nextHeadingLevel} |(?![\\s\\S]))`,
    "mu",
  ))
  assert.ok(match, `missing section ${heading}`)
  return match.groups.body
}

function sectionByAnchor(markdown, anchor) {
  const headingPattern = /^(?<level>#{2,6})\s+(?<title>.+)$/gmu
  const headings = Array.from(markdown.matchAll(headingPattern), (match) => ({
    anchor: markdownAnchor(match.groups.title),
    index: match.index,
    level: match.groups.level.length,
    bodyStart: match.index + match[0].length,
  }))
  const headingIndex = headings.findIndex((heading) => heading.anchor === anchor)
  assert.notEqual(headingIndex, -1, `missing markdown anchor #${anchor}`)

  const heading = headings[headingIndex]
  const nextHeading = headings.slice(headingIndex + 1)
    .find((candidate) => candidate.level <= heading.level)
  return markdown.slice(heading.bodyStart, nextHeading?.index ?? markdown.length)
}

function markdownAnchor(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/`/gu, "")
    .replace(/&/gu, "and")
    .replace(/[^a-z0-9\s-]/gu, "")
    .replace(/\s+/gu, "-")
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function currentOuroborosStdioPackagingInput() {
  const activationReadme = readText("plugins", "desk", "activation", "README.md")
  return {
    activationManifest: loadJson(...activationManifestPath.split("/")),
    evidenceRows: normalizedEvidenceRows(),
    ouroborosReadmeSection: sectionBetween(
      readText("plugins", "desk", "README.md"),
      "### Under Ouroboros",
    ),
    ouroborosActivationSection: sectionByAnchor(
      activationReadme,
      "ouroboros-autonomous-agent",
    ),
    genericStdioReadmeSection: sectionBetween(
      readText("plugins", "desk", "mcp", "README.md"),
      "## Generic stdio MCP launch",
      "##",
    ),
    genericStdioActivationSection: sectionByAnchor(activationReadme, "generic-stdio"),
  }
}

test("Ouroboros/autonomous-agent packaging has a flattened bundle disposition", () => {
  const evidenceRow = findByField(
    normalizedEvidenceRows(),
    "host_id",
    "ouroboros-autonomous-agent",
    evidencePath,
  )
  const supportMatrixRow = findByField(
    loadJson(...supportMatrixPath.split("/")).hosts,
    "host_id",
    "ouroboros-autonomous-agent",
    supportMatrixPath,
  )
  const manifestRow = findByField(
    loadJson(...activationManifestPath.split("/")).host_support,
    "host",
    "ouroboros-autonomous-agent",
    activationManifestPath,
  )

  assert.equal(evidenceRow.disposition, "supported-flattened")
  assert.deepEqual(supportMatrixRow, evidenceRow)
  assert.equal(manifestRow.status, "supported")
  assert.equal(manifestRow.dependency_resolution, "flattened")
  assert.deepEqual(manifestRow.unsupported_primitives, ["host-native-plugin-install"])
  assertIncludesAll(manifestRow.capabilities, ["agents", "skills", "mcp"], "Ouroboros capabilities")
  assertIncludesAll(evidenceRow.source_paths, [
    "plugins/desk/README.md",
    "plugins/desk/activation/README.md",
    "plugins/desk/.mcp.json",
    "plugins/desk/plugin.json",
    "plugins/work-suite/plugin.json",
    "plugins/plain-language/plugin.json",
    "plugins/ponytail-upstream/plugin.json",
  ], "Ouroboros evidence source_paths")
  assertIncludesAll(evidenceRow.evidence_command_or_doc, [
    unitTestCommand,
    "plugins/desk/README.md#under-ouroboros",
    "plugins/desk/activation/README.md#ouroboros-autonomous-agent",
  ], "Ouroboros evidence_command_or_doc")
  assert.match(evidenceRow.fallback_behavior, /\$DESK/u)
  assert.match(evidenceRow.fallback_behavior, /bundle Desk \+ Work Suite/u)
})

test("Ouroboros activation docs define the evidence anchor and disposition", () => {
  const activationReadme = readText("plugins", "desk", "activation", "README.md")
  const section = sectionByAnchor(activationReadme, "ouroboros-autonomous-agent")

  assert.match(section, /supported-flattened/u)
  assert.match(section, /host-native-plugin-install/u)
  assert.match(section, /bundle Desk \+ Work Suite/u)
  assert.match(section, /\$DESK/u)
})

test("Ouroboros docs specify bundle.json plugin closure and $DESK preamble binding", () => {
  const readme = readText("plugins", "desk", "README.md")
  const section = sectionBetween(readme, "### Under Ouroboros")

  assert.match(section, /bundle\.json/u)
  assert.match(section, /"plugins"\s*:\s*\[/u)
  assert.match(section, /"desk"/u)
  assert.match(section, /"work-suite"/u)
  assert.match(section, /"plain-language"/u)
  assert.match(section, /"ponytail-upstream"/u)
  assert.match(section, /preamble/u)
  assert.match(section, /\$DESK\s*=\s*~\/AgentBundles\/<agent>\.ouro\/desk\//u)
  assert.doesNotMatch(section, /npm install/u)
})

test("generic stdio support matrix records an MCP-only degraded disposition", () => {
  const evidenceRow = findByField(
    normalizedEvidenceRows(),
    "host_id",
    "generic-stdio",
    evidencePath,
  )
  const supportMatrixRow = findByField(
    loadJson(...supportMatrixPath.split("/")).hosts,
    "host_id",
    "generic-stdio",
    supportMatrixPath,
  )
  const manifestRow = findByField(
    loadJson(...activationManifestPath.split("/")).host_support,
    "host",
    "generic-stdio",
    activationManifestPath,
  )

  assert.equal(evidenceRow.disposition, "degraded-mcp-only")
  assert.deepEqual(supportMatrixRow, evidenceRow)
  assert.equal(manifestRow.status, "degraded")
  assert.equal(manifestRow.dependency_resolution, "manual-host")
  assert.deepEqual(manifestRow.capabilities, ["mcp"])
  assert.deepEqual(manifestRow.unsupported_primitives, [
    "agent-defaults",
    "plugin-dependency-resolution",
  ])
  assertIncludesAll(evidenceRow.source_paths, [
    "plugins/desk/.mcp.json",
    "plugins/desk/mcp/README.md",
    "plugins/desk/activation/README.md",
  ], "generic stdio evidence source_paths")
  assertIncludesAll(evidenceRow.evidence_command_or_doc, [
    unitTestCommand,
    "plugins/desk/mcp/README.md#generic-stdio-mcp-launch",
    "plugins/desk/activation/README.md#generic-stdio",
  ], "generic stdio evidence_command_or_doc")
  assert.match(evidenceRow.fallback_behavior, /explicit --root or DESK/u)
  assert.match(evidenceRow.fallback_behavior, /no worker activation/u)
})

test("generic stdio activation docs define the evidence anchor and disposition", () => {
  const activationReadme = readText("plugins", "desk", "activation", "README.md")
  const section = sectionByAnchor(activationReadme, "generic-stdio")

  assert.match(section, /degraded-mcp-only/u)
  assert.match(section, /agent-defaults/u)
  assert.match(section, /plugin-dependency-resolution/u)
  assert.match(section, /explicit --root or DESK/u)
  assert.match(section, /no worker activation/u)
})

test("generic stdio docs show explicit root binding and no default worker claim", () => {
  const mcpReadme = readText("plugins", "desk", "mcp", "README.md")
  const section = sectionBetween(mcpReadme, "## Generic stdio MCP launch", "##")

  assert.match(section, /node .*mcp\/index\.js .*--root/u)
  assert.match(section, /DESK=/u)
  assert.match(section, /\$DESK/u)
  assert.doesNotMatch(section, /DESK=[^\n]+--root "\$DESK"/u)
  assert.match(section, /MCP-only/u)
  assert.match(section, /no worker activation/u)
  assert.doesNotMatch(section, /desk:worker is activated by generic stdio/u)
})

test("Ouroboros/generic stdio packaging validation accepts current artifacts", () => {
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(currentOuroborosStdioPackagingInput()),
    [],
  )
})

test("Ouroboros packaging validation rejects missing bundle metadata and DESK binding", () => {
  const missingBundleJson = clone(currentOuroborosStdioPackagingInput())
  missingBundleJson.ouroborosReadmeSection =
    missingBundleJson.ouroborosReadmeSection.replace("bundle.json", "agent metadata")
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(missingBundleJson),
    ["Ouroboros docs must define bundle.json plugin metadata"],
  )

  const missingDeskPlugin = clone(currentOuroborosStdioPackagingInput())
  missingDeskPlugin.ouroborosReadmeSection =
    missingDeskPlugin.ouroborosReadmeSection.replace("\"desk\"", "\"notes\"")
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(missingDeskPlugin),
    ["Ouroboros bundle metadata must include desk plugin"],
  )

  const missingWorkSuitePlugin = clone(currentOuroborosStdioPackagingInput())
  missingWorkSuitePlugin.ouroborosReadmeSection =
    missingWorkSuitePlugin.ouroborosReadmeSection.replace("\"work-suite\"", "\"workflow\"")
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(missingWorkSuitePlugin),
    ["Ouroboros bundle metadata must include work-suite plugin"],
  )

  const missingDeskBinding = clone(currentOuroborosStdioPackagingInput())
  missingDeskBinding.ouroborosReadmeSection =
    missingDeskBinding.ouroborosReadmeSection.replace(
      "$DESK = ~/AgentBundles/<agent>.ouro/desk/",
      "DESK is provided by the host",
    )
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(missingDeskBinding),
    ["Ouroboros preamble must bind $DESK to ~/AgentBundles/<agent>.ouro/desk/"],
  )

  const missingBundleSource = clone(currentOuroborosStdioPackagingInput())
  findByField(
    missingBundleSource.evidenceRows,
    "host_id",
    "ouroboros-autonomous-agent",
    "test input",
  ).source_paths = ["plugins/desk/README.md", "plugins/desk/activation/README.md"]
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(missingBundleSource),
    ["Ouroboros evidence must reference bundle metadata sources"],
  )

  const malformedBundleWithProse = clone(currentOuroborosStdioPackagingInput())
  malformedBundleWithProse.ouroborosReadmeSection =
    malformedBundleWithProse.ouroborosReadmeSection.replace(
      /```json[\s\S]*?```/u,
      [
        "```json",
        "{",
        "  \"plugins\": [",
        "    \"notes\",",
        "    \"work-suite\"",
        "  ]",
        "}",
        "```",
        "",
        "The word \"desk\" appears in prose but not in bundle metadata.",
      ].join("\n"),
    )
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(malformedBundleWithProse),
    ["Ouroboros bundle metadata must include desk plugin"],
  )

  const malformedWorkSuiteBundleWithProse = clone(currentOuroborosStdioPackagingInput())
  malformedWorkSuiteBundleWithProse.ouroborosReadmeSection =
    malformedWorkSuiteBundleWithProse.ouroborosReadmeSection.replace(
      /```json[\s\S]*?```/u,
      [
        "```json",
        "{",
        "  \"plugins\": [",
        "    \"desk\",",
        "    \"workflow\"",
        "  ]",
        "}",
        "```",
        "",
        "The word \"work-suite\" appears in prose but not in bundle metadata.",
      ].join("\n"),
    )
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(malformedWorkSuiteBundleWithProse),
    ["Ouroboros bundle metadata must include work-suite plugin"],
  )

  const malformedJsonBundle = clone(currentOuroborosStdioPackagingInput())
  malformedJsonBundle.ouroborosReadmeSection =
    malformedJsonBundle.ouroborosReadmeSection.replace(
      /```json[\s\S]*?```/u,
      [
        "```json",
        "{",
        "  \"plugins\": [\"desk\",",
        "}",
        "```",
      ].join("\n"),
    )
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(malformedJsonBundle),
    ["Ouroboros bundle metadata must be valid JSON"],
  )

  const malformedJsonBeforeValidJson = clone(currentOuroborosStdioPackagingInput())
  malformedJsonBeforeValidJson.ouroborosReadmeSection =
    malformedJsonBeforeValidJson.ouroborosReadmeSection.replace(
      /```json[\s\S]*?```/u,
      [
        "```json",
        "{",
        "  \"plugins\": [\"desk\",",
        "}",
        "```",
        "",
        "Later unrelated JSON must not rescue malformed bundle metadata:",
        "",
        "```json",
        "{ \"plugins\": [\"desk\", \"work-suite\"] }",
        "```",
      ].join("\n"),
    )
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(malformedJsonBeforeValidJson),
    ["Ouroboros bundle metadata must be valid JSON"],
  )

  const bundleWithoutPluginsArray = clone(currentOuroborosStdioPackagingInput())
  bundleWithoutPluginsArray.ouroborosReadmeSection =
    bundleWithoutPluginsArray.ouroborosReadmeSection.replace(
      /```json[\s\S]*?```/u,
      [
        "```json",
        "{",
        "  \"metadata\": [\"desk\", \"work-suite\"]",
        "}",
        "```",
      ].join("\n"),
    )
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(bundleWithoutPluginsArray),
    [
      "Ouroboros bundle metadata must include desk plugin",
      "Ouroboros bundle metadata must include work-suite plugin",
    ],
  )

  const bundleWithNonStringPlugin = clone(currentOuroborosStdioPackagingInput())
  bundleWithNonStringPlugin.ouroborosReadmeSection =
    bundleWithNonStringPlugin.ouroborosReadmeSection.replace(
      /```json[\s\S]*?```/u,
      [
        "```json",
        "{",
        "  \"plugins\": [",
        "    \"desk\",",
        "    42",
        "  ]",
        "}",
        "```",
      ].join("\n"),
    )
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(bundleWithNonStringPlugin),
    ["Ouroboros bundle metadata must include work-suite plugin"],
  )
})

test("Ouroboros packaging validation rejects host-support drift and manual installs", () => {
  const hostSupportDrift = clone(currentOuroborosStdioPackagingInput())
  const ouroborosHost = findByField(
    hostSupportDrift.activationManifest.host_support,
    "host",
    "ouroboros-autonomous-agent",
    "test input",
  )
  ouroborosHost.dependency_resolution = "manual-host"
  ouroborosHost.capabilities = "skills"
  ouroborosHost.unsupported_primitives = "host-native-plugin-install"
  hostSupportDrift.ouroborosReadmeSection += "\nnpm install plugins/desk/mcp\n"

  assert.deepEqual(
    validateOuroborosStdioPackagingContract(hostSupportDrift),
    [
      "Ouroboros host support must use flattened dependency resolution",
      "Ouroboros host support must expose agents, skills, and mcp",
      "Ouroboros host support must mark host-native-plugin-install unsupported",
      "Ouroboros healthy path must not require npm install",
    ],
  )
})

test("Ouroboros packaging validation rejects evidence row drift", () => {
  const evidenceDrift = clone(currentOuroborosStdioPackagingInput())
  const ouroborosEvidence = findByField(
    evidenceDrift.evidenceRows,
    "host_id",
    "ouroboros-autonomous-agent",
    "test input",
  )
  ouroborosEvidence.disposition = "unsupported"
  ouroborosEvidence.unsupported_primitives = []
  ouroborosEvidence.fallback_behavior = "manual npm install only"

  assert.deepEqual(
    validateOuroborosStdioPackagingContract(evidenceDrift),
    [
      "Ouroboros evidence must record supported-flattened disposition",
      "Ouroboros evidence must mark host-native-plugin-install unsupported",
      "Ouroboros evidence fallback must describe bundled Desk and Work Suite",
      "Ouroboros evidence fallback must describe $DESK binding",
    ],
  )

  const missingFallback = clone(currentOuroborosStdioPackagingInput())
  delete findByField(
    missingFallback.evidenceRows,
    "host_id",
    "ouroboros-autonomous-agent",
    "test input",
  ).fallback_behavior
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(missingFallback),
    [
      "Ouroboros evidence fallback must describe bundled Desk and Work Suite",
      "Ouroboros evidence fallback must describe $DESK binding",
    ],
  )
})

test("generic stdio packaging validation rejects unsafe or under-specified launches", () => {
  const unsafeInlineBinding = clone(currentOuroborosStdioPackagingInput())
  unsafeInlineBinding.genericStdioReadmeSection =
    unsafeInlineBinding.genericStdioReadmeSection.replace(
      "DESK=~/desk\nnode /path/to/plugins/desk/mcp/index.js --root \"$DESK\"",
      "DESK=~/desk node /path/to/plugins/desk/mcp/index.js --root \"$DESK\"",
    )
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(unsafeInlineBinding),
    [
      "Generic stdio launch docs must bind $DESK before invoking node",
      "Generic stdio launch must not use inline DESK assignment with --root \"$DESK\"",
    ],
  )

  const missingExplicitRoot = clone(currentOuroborosStdioPackagingInput())
  missingExplicitRoot.genericStdioReadmeSection =
    missingExplicitRoot.genericStdioReadmeSection.replaceAll("--root", "--desk-root")
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(missingExplicitRoot),
    [
      "Generic stdio launch docs must pass an explicit --root",
      "Generic stdio launch docs must bind $DESK before invoking node",
    ],
  )

  const workerClaim = clone(currentOuroborosStdioPackagingInput())
  workerClaim.genericStdioReadmeSection += "\ndesk:worker is activated by generic stdio.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(workerClaim),
    ["Generic stdio docs must not claim worker activation"],
  )

  const equivalentWorkerClaim = clone(currentOuroborosStdioPackagingInput())
  equivalentWorkerClaim.genericStdioReadmeSection +=
    "\nGeneric stdio starts desk:worker automatically and loads the agent defaults.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(equivalentWorkerClaim),
    ["Generic stdio docs must not claim worker activation"],
  )

  const equivalentDependencyClaim = clone(currentOuroborosStdioPackagingInput())
  equivalentDependencyClaim.genericStdioReadmeSection +=
    "\nGeneric stdio resolves plugin dependencies and loads Work Suite automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(equivalentDependencyClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const dependencySupportClaim = clone(currentOuroborosStdioPackagingInput())
  dependencySupportClaim.genericStdioReadmeSection +=
    "\nGeneric stdio provides plugin dependency support automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(dependencySupportClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const dependencyResolutionClaim = clone(currentOuroborosStdioPackagingInput())
  dependencyResolutionClaim.genericStdioReadmeSection +=
    "\nGeneric stdio provides dependency resolution automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(dependencyResolutionClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const handlesDependencyResolution = clone(currentOuroborosStdioPackagingInput())
  handlesDependencyResolution.genericStdioReadmeSection +=
    "\nGeneric stdio handles dependency resolution automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(handlesDependencyResolution),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const managesPluginDependencies = clone(currentOuroborosStdioPackagingInput())
  managesPluginDependencies.genericStdioReadmeSection +=
    "\nGeneric stdio manages plugin dependencies automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(managesPluginDependencies),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const setsUpWorkSuite = clone(currentOuroborosStdioPackagingInput())
  setsUpWorkSuite.genericStdioReadmeSection +=
    "\nGeneric stdio sets up Work Suite automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(setsUpWorkSuite),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const shipsWorkerActivation = clone(currentOuroborosStdioPackagingInput())
  shipsWorkerActivation.genericStdioReadmeSection +=
    "\nGeneric stdio ships worker activation automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(shipsWorkerActivation),
    ["Generic stdio docs must not claim worker activation"],
  )

  const spawnsWorkerActivation = clone(currentOuroborosStdioPackagingInput())
  spawnsWorkerActivation.genericStdioReadmeSection +=
    "\nGeneric stdio spawns the worker automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(spawnsWorkerActivation),
    ["Generic stdio docs must not claim worker activation"],
  )

  const launchingWorkerActivation = clone(currentOuroborosStdioPackagingInput())
  launchingWorkerActivation.genericStdioReadmeSection +=
    "\nGeneric stdio is launching worker activation automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(launchingWorkerActivation),
    ["Generic stdio docs must not claim worker activation"],
  )

  const includesAgentDefaults = clone(currentOuroborosStdioPackagingInput())
  includesAgentDefaults.genericStdioReadmeSection +=
    "\nGeneric stdio includes agent-defaults automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(includesAgentDefaults),
    ["Generic stdio docs must not claim worker activation"],
  )

  const installsDefaultAgent = clone(currentOuroborosStdioPackagingInput())
  installsDefaultAgent.genericStdioReadmeSection +=
    "\nGeneric stdio installs the default agent automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(installsDefaultAgent),
    ["Generic stdio docs must not claim worker activation"],
  )

  const installsDeskWorker = clone(currentOuroborosStdioPackagingInput())
  installsDeskWorker.genericStdioReadmeSection +=
    "\nGeneric stdio installs desk:worker automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(installsDeskWorker),
    ["Generic stdio docs must not claim worker activation"],
  )

  const includesWorkerActivation = clone(currentOuroborosStdioPackagingInput())
  includesWorkerActivation.genericStdioReadmeSection +=
    "\nGeneric stdio includes worker activation automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(includesWorkerActivation),
    ["Generic stdio docs must not claim worker activation"],
  )

  const bundlesWorkSuite = clone(currentOuroborosStdioPackagingInput())
  bundlesWorkSuite.genericStdioReadmeSection +=
    "\nGeneric stdio bundles Work Suite automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(bundlesWorkSuite),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const loadingWorkSuite = clone(currentOuroborosStdioPackagingInput())
  loadingWorkSuite.genericStdioReadmeSection +=
    "\nGeneric stdio is loading Work Suite automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(loadingWorkSuite),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const workerWithExternalDependency = clone(currentOuroborosStdioPackagingInput())
  workerWithExternalDependency.genericStdioReadmeSection +=
    "\nGeneric stdio starts worker activation with Work Suite dependency closure provided by a separate host.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(workerWithExternalDependency),
    ["Generic stdio docs must not claim worker activation"],
  )

  const mixedWorkerClaim = clone(currentOuroborosStdioPackagingInput())
  mixedWorkerClaim.genericStdioReadmeSection +=
    "\nGeneric stdio does not activate worker automatically, but generic stdio loads the default agent.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(mixedWorkerClaim),
    ["Generic stdio docs must not claim worker activation"],
  )

  const mixedDependencyClaim = clone(currentOuroborosStdioPackagingInput())
  mixedDependencyClaim.genericStdioReadmeSection +=
    "\nGeneric stdio does not activate worker, but generic stdio loads Work Suite automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(mixedDependencyClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const negativeBoundaryClaims = clone(currentOuroborosStdioPackagingInput())
  negativeBoundaryClaims.genericStdioReadmeSection +=
    "\nGeneric stdio does not activate worker and does not resolve plugin dependencies.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(negativeBoundaryClaims),
    [],
  )

  const supportClaimWithNoSetup = clone(currentOuroborosStdioPackagingInput())
  supportClaimWithNoSetup.genericStdioReadmeSection +=
    "\nGeneric stdio starts desk:worker with no manual setup.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(supportClaimWithNoSetup),
    ["Generic stdio docs must not claim worker activation"],
  )

  const supportClaimWithWithout = clone(currentOuroborosStdioPackagingInput())
  supportClaimWithWithout.genericStdioReadmeSection +=
    "\nGeneric stdio loads Work Suite without requiring a plugin installer.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(supportClaimWithWithout),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const willNotBoundaryClaims = clone(currentOuroborosStdioPackagingInput())
  willNotBoundaryClaims.genericStdioReadmeSection +=
    "\nGeneric stdio will not activate worker and will not resolve plugin dependencies.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(willNotBoundaryClaims),
    [],
  )

  const activationReadmeDependencyClaim = clone(currentOuroborosStdioPackagingInput())
  activationReadmeDependencyClaim.genericStdioActivationSection +=
    "\nGeneric stdio loads Work Suite automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(activationReadmeDependencyClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )
})

test("generic stdio packaging validation rejects identifier and support-verb claim variants", () => {
  const backtickedWorkSuite = clone(currentOuroborosStdioPackagingInput())
  backtickedWorkSuite.genericStdioReadmeSection +=
    "\nGeneric stdio loads `work-suite` automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(backtickedWorkSuite),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const dependencyPrimitive = clone(currentOuroborosStdioPackagingInput())
  dependencyPrimitive.genericStdioReadmeSection +=
    "\nGeneric stdio resolves plugin-dependency-resolution automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(dependencyPrimitive),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const agentDefaults = clone(currentOuroborosStdioPackagingInput())
  agentDefaults.genericStdioReadmeSection +=
    "\nGeneric stdio loads `agent-defaults` automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(agentDefaults),
    ["Generic stdio docs must not claim worker activation"],
  )

  const supportWorker = clone(currentOuroborosStdioPackagingInput())
  supportWorker.genericStdioReadmeSection +=
    "\nGeneric stdio supports desk:worker with no manual setup.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(supportWorker),
    ["Generic stdio docs must not claim worker activation"],
  )

  const supportWorkSuite = clone(currentOuroborosStdioPackagingInput())
  supportWorkSuite.genericStdioReadmeSection +=
    "\nGeneric stdio supports Work Suite without requiring a plugin installer.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(supportWorkSuite),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const bringsInWorkSuite = clone(currentOuroborosStdioPackagingInput())
  bringsInWorkSuite.genericStdioReadmeSection +=
    "\nGeneric stdio brings in Work Suite automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(bringsInWorkSuite),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const preloadsWorkSuite = clone(currentOuroborosStdioPackagingInput())
  preloadsWorkSuite.genericStdioReadmeSection +=
    "\nGeneric stdio preloads Work Suite automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(preloadsWorkSuite),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const comesWithWorkSuite = clone(currentOuroborosStdioPackagingInput())
  comesWithWorkSuite.genericStdioReadmeSection +=
    "\nGeneric stdio comes with Work Suite automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(comesWithWorkSuite),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const hasWorkSuiteBuiltIn = clone(currentOuroborosStdioPackagingInput())
  hasWorkSuiteBuiltIn.genericStdioReadmeSection +=
    "\nGeneric stdio has Work Suite built in.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(hasWorkSuiteBuiltIn),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const hasBuiltInWorkSuite = clone(currentOuroborosStdioPackagingInput())
  hasBuiltInWorkSuite.genericStdioReadmeSection +=
    "\nGeneric stdio has built-in Work Suite.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(hasBuiltInWorkSuite),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const hasBuiltInDeskWorker = clone(currentOuroborosStdioPackagingInput())
  hasBuiltInDeskWorker.genericStdioReadmeSection +=
    "\nGeneric stdio has a built-in desk:worker.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(hasBuiltInDeskWorker),
    ["Generic stdio docs must not claim worker activation"],
  )

  const passiveBuiltIntoWorkSuite = clone(currentOuroborosStdioPackagingInput())
  passiveBuiltIntoWorkSuite.genericStdioReadmeSection +=
    "\nWork Suite is built into generic stdio.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(passiveBuiltIntoWorkSuite),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const passiveBuiltIntoDeskWorker = clone(currentOuroborosStdioPackagingInput())
  passiveBuiltIntoDeskWorker.genericStdioReadmeSection +=
    "\ndesk:worker is built into generic stdio.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(passiveBuiltIntoDeskWorker),
    ["Generic stdio docs must not claim worker activation"],
  )

  const givesYouDeskWorker = clone(currentOuroborosStdioPackagingInput())
  givesYouDeskWorker.genericStdioReadmeSection +=
    "\nGeneric stdio gives you desk:worker automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(givesYouDeskWorker),
    ["Generic stdio docs must not claim worker activation"],
  )

  const activationReadmeIdentifierClaim = clone(currentOuroborosStdioPackagingInput())
  activationReadmeIdentifierClaim.genericStdioActivationSection +=
    "\nGeneric stdio loads `work-suite` automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(activationReadmeIdentifierClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const yetDependencyClaim = clone(currentOuroborosStdioPackagingInput())
  yetDependencyClaim.genericStdioReadmeSection +=
    "\nGeneric stdio does not support desk:worker, yet generic stdio supports Work Suite without requiring a plugin installer.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(yetDependencyClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const yetIdentifierClaim = clone(currentOuroborosStdioPackagingInput())
  yetIdentifierClaim.genericStdioReadmeSection +=
    "\nGeneric stdio does not load agent-defaults, yet generic stdio loads `work-suite` automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(yetIdentifierClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const thoughDependencyClaim = clone(currentOuroborosStdioPackagingInput())
  thoughDependencyClaim.genericStdioReadmeSection +=
    "\nGeneric stdio does not support desk:worker, though generic stdio provides plugin-dependency-resolution automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(thoughDependencyClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const whileDependencyClaim = clone(currentOuroborosStdioPackagingInput())
  whileDependencyClaim.genericStdioReadmeSection +=
    "\nWhile generic stdio does not support desk:worker, generic stdio exposes Work Suite automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(whileDependencyClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const scopedWorkerClaim = clone(currentOuroborosStdioPackagingInput())
  scopedWorkerClaim.genericStdioReadmeSection +=
    "\nThis path provides worker activation.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(scopedWorkerClaim),
    ["Generic stdio docs must not claim worker activation"],
  )

  const scopedDependencyClaim = clone(currentOuroborosStdioPackagingInput())
  scopedDependencyClaim.genericStdioReadmeSection +=
    "\nThis path provides Work Suite dependency closure.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(scopedDependencyClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const secondSentenceClaim = clone(currentOuroborosStdioPackagingInput())
  secondSentenceClaim.genericStdioReadmeSection +=
    "\nGeneric stdio does not support desk:worker. It supports Work Suite automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(secondSentenceClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const noManualSetupDependencyClaim = clone(currentOuroborosStdioPackagingInput())
  noManualSetupDependencyClaim.genericStdioReadmeSection +=
    "\nNo manual setup is needed because generic stdio supports Work Suite automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(noManualSetupDependencyClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const noManualSetupSupportDependencyClaim = clone(currentOuroborosStdioPackagingInput())
  noManualSetupSupportDependencyClaim.genericStdioReadmeSection +=
    "\nNo manual setup is needed for Work Suite support.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(noManualSetupSupportDependencyClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const noManualInstallWorkerClaim = clone(currentOuroborosStdioPackagingInput())
  noManualInstallWorkerClaim.genericStdioReadmeSection +=
    "\nNo manual install is needed because this path starts worker activation automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(noManualInstallWorkerClaim),
    ["Generic stdio docs must not claim worker activation"],
  )

  const noHostSetupDependencyClaim = clone(currentOuroborosStdioPackagingInput())
  noHostSetupDependencyClaim.genericStdioReadmeSection +=
    "\nNo host-specific setup is required because Work Suite is supported by this path.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(noHostSetupDependencyClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const noExtraCommandWorkerClaim = clone(currentOuroborosStdioPackagingInput())
  noExtraCommandWorkerClaim.genericStdioReadmeSection +=
    "\nNo extra command is needed because desk:worker is activated by generic stdio.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(noExtraCommandWorkerClaim),
    ["Generic stdio docs must not claim worker activation"],
  )

  const noExtraHostSupportWorkerClaim = clone(currentOuroborosStdioPackagingInput())
  noExtraHostSupportWorkerClaim.genericStdioReadmeSection +=
    "\nNo extra host is needed for worker activation support.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(noExtraHostSupportWorkerClaim),
    ["Generic stdio docs must not claim worker activation"],
  )

  const neitherSetupDependencyClaim = clone(currentOuroborosStdioPackagingInput())
  neitherSetupDependencyClaim.genericStdioReadmeSection +=
    "\nNeither extra setup nor special config is needed because generic stdio supports Work Suite automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(neitherSetupDependencyClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const asDependencyClaim = clone(currentOuroborosStdioPackagingInput())
  asDependencyClaim.genericStdioReadmeSection +=
    "\nNo manual setup is needed as generic stdio supports Work Suite automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(asDependencyClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const soDependencyClaim = clone(currentOuroborosStdioPackagingInput())
  soDependencyClaim.genericStdioReadmeSection +=
    "\nNo manual setup is needed so generic stdio supports Work Suite automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(soDependencyClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const dashDependencyClaim = clone(currentOuroborosStdioPackagingInput())
  dashDependencyClaim.genericStdioReadmeSection +=
    "\nNo manual setup is needed - generic stdio supports Work Suite automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(dashDependencyClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const externalHostThenDependencyClaim = clone(currentOuroborosStdioPackagingInput())
  externalHostThenDependencyClaim.genericStdioReadmeSection +=
    "\nA separate host must manually provide Work Suite dependency closure then generic stdio supports Work Suite automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(externalHostThenDependencyClaim),
    ["Generic stdio docs must not claim plugin dependency resolution"],
  )

  const asWorkerClaim = clone(currentOuroborosStdioPackagingInput())
  asWorkerClaim.genericStdioReadmeSection +=
    "\nNo manual install is needed as this path starts worker activation automatically.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(asWorkerClaim),
    ["Generic stdio docs must not claim worker activation"],
  )

  const dashWorkerClaim = clone(currentOuroborosStdioPackagingInput())
  dashWorkerClaim.genericStdioReadmeSection +=
    "\nNo extra command is needed - desk:worker is activated by generic stdio.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(dashWorkerClaim),
    ["Generic stdio docs must not claim worker activation"],
  )
})

test("generic stdio packaging validation permits neither/nor negative support wording", () => {
  const neitherNorNegative = clone(currentOuroborosStdioPackagingInput())
  neitherNorNegative.genericStdioReadmeSection +=
    "\nGeneric stdio neither activates worker nor resolves plugin dependencies.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(neitherNorNegative),
    [],
  )

  const contractionNegative = clone(currentOuroborosStdioPackagingInput())
  contractionNegative.genericStdioReadmeSection +=
    "\nGeneric stdio doesn't support desk:worker.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(contractionNegative),
    [],
  )

  const adverbNegative = clone(currentOuroborosStdioPackagingInput())
  adverbNegative.genericStdioReadmeSection +=
    "\nGeneric stdio does not automatically activate worker.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(adverbNegative),
    [],
  )

  const postActionNegativeTarget = clone(currentOuroborosStdioPackagingInput())
  postActionNegativeTarget.genericStdioReadmeSection +=
    "\nGeneric stdio starts the MCP server, not worker activation.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(postActionNegativeTarget),
    [],
  )

  const supportsNeitherNor = clone(currentOuroborosStdioPackagingInput())
  supportsNeitherNor.genericStdioReadmeSection +=
    "\nGeneric stdio supports neither desk:worker nor Work Suite.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(supportsNeitherNor),
    [],
  )

  const startsNeitherNor = clone(currentOuroborosStdioPackagingInput())
  startsNeitherNor.genericStdioReadmeSection +=
    "\nGeneric stdio starts neither worker activation nor Work Suite.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(startsNeitherNor),
    [],
  )

  const passiveNeitherNor = clone(currentOuroborosStdioPackagingInput())
  passiveNeitherNor.genericStdioReadmeSection +=
    "\nNeither desk:worker nor Work Suite is supported by generic stdio.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(passiveNeitherNor),
    [],
  )

  const passiveClosureNeitherNor = clone(currentOuroborosStdioPackagingInput())
  passiveClosureNeitherNor.genericStdioReadmeSection +=
    "\nNeither worker activation nor Work Suite dependency closure is provided by this path.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(passiveClosureNeitherNor),
    [],
  )

  const noDependencyClosure = clone(currentOuroborosStdioPackagingInput())
  noDependencyClosure.genericStdioReadmeSection +=
    "\nNo Work Suite dependency closure is enabled here.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(noDependencyClosure),
    [],
  )

  const noWorkerActivationProvided = clone(currentOuroborosStdioPackagingInput())
  noWorkerActivationProvided.genericStdioReadmeSection +=
    "\nNo worker activation is provided by this path.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(noWorkerActivationProvided),
    [],
  )

  const noWorkSuiteSupportProvided = clone(currentOuroborosStdioPackagingInput())
  noWorkSuiteSupportProvided.genericStdioReadmeSection +=
    "\nNo Work Suite support is provided by generic stdio.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(noWorkSuiteSupportProvided),
    [],
  )

  const noWorkerActivationSupportProvided = clone(currentOuroborosStdioPackagingInput())
  noWorkerActivationSupportProvided.genericStdioReadmeSection +=
    "\nNo worker activation support is provided by generic stdio.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(noWorkerActivationSupportProvided),
    [],
  )

  const noPluginDependenciesResolved = clone(currentOuroborosStdioPackagingInput())
  noPluginDependenciesResolved.genericStdioReadmeSection +=
    "\nNo plugin dependencies are resolved by generic stdio.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(noPluginDependenciesResolved),
    [],
  )

  const supportMatrixUnsupported = clone(currentOuroborosStdioPackagingInput())
  supportMatrixUnsupported.genericStdioReadmeSection +=
    "\nThe generic stdio support matrix records Work Suite dependency closure as unsupported.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(supportMatrixUnsupported),
    [],
  )

  const supportMatrixIncludesUnsupportedClosure = clone(currentOuroborosStdioPackagingInput())
  supportMatrixIncludesUnsupportedClosure.genericStdioReadmeSection +=
    "\nThe generic stdio support matrix includes Work Suite dependency closure as unsupported.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(supportMatrixIncludesUnsupportedClosure),
    [],
  )

  const evidenceRowIncludesUnsupportedAgentDefaults = clone(currentOuroborosStdioPackagingInput())
  evidenceRowIncludesUnsupportedAgentDefaults.genericStdioReadmeSection +=
    "\nThe generic stdio evidence row includes agent-defaults as unsupported.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(evidenceRowIncludesUnsupportedAgentDefaults),
    [],
  )

  const workerActivationNotProvided = clone(currentOuroborosStdioPackagingInput())
  workerActivationNotProvided.genericStdioReadmeSection +=
    "\nWorker activation is not provided by generic stdio.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(workerActivationNotProvided),
    [],
  )

  const workerActivationNotCurrentlyProvided = clone(currentOuroborosStdioPackagingInput())
  workerActivationNotCurrentlyProvided.genericStdioReadmeSection +=
    "\nWorker activation is not currently provided by generic stdio.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(workerActivationNotCurrentlyProvided),
    [],
  )

  const separateHostInstallsDependencies = clone(currentOuroborosStdioPackagingInput())
  separateHostInstallsDependencies.genericStdioActivationSection +=
    "\nA separate host must install plugin dependencies manually.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(separateHostInstallsDependencies),
    [],
  )

  const separateOverlayProvidesClosure = clone(currentOuroborosStdioPackagingInput())
  separateOverlayProvidesClosure.genericStdioReadmeSection +=
    "\nA separate host or overlay must provide Work Suite dependency closure.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(separateOverlayProvidesClosure),
    [],
  )

  const passiveSeparateHostProvidesClosure = clone(currentOuroborosStdioPackagingInput())
  passiveSeparateHostProvidesClosure.genericStdioActivationSection +=
    "\nWork Suite dependency closure must be provided by a separate host or overlay.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(passiveSeparateHostProvidesClosure),
    [],
  )

  const passiveAnotherOverlaySuppliesWorker = clone(currentOuroborosStdioPackagingInput())
  passiveAnotherOverlaySuppliesWorker.genericStdioReadmeSection +=
    "\nWorker activation must be supplied by another overlay.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(passiveAnotherOverlaySuppliesWorker),
    [],
  )

  const passiveBuiltIntoSeparateHost = clone(currentOuroborosStdioPackagingInput())
  passiveBuiltIntoSeparateHost.genericStdioReadmeSection +=
    "\nWork Suite is built into a separate host or overlay.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(passiveBuiltIntoSeparateHost),
    [],
  )

  const passiveWorkerBuiltIntoExternalOverlay = clone(currentOuroborosStdioPackagingInput())
  passiveWorkerBuiltIntoExternalOverlay.genericStdioActivationSection +=
    "\nWorker activation is built into an external overlay.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(passiveWorkerBuiltIntoExternalOverlay),
    [],
  )

  const activeSeparateHostProvidesClosure = clone(currentOuroborosStdioPackagingInput())
  activeSeparateHostProvidesClosure.genericStdioReadmeSection +=
    "\nGeneric stdio requires a separate host to provide Work Suite dependency closure.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(activeSeparateHostProvidesClosure),
    [],
  )

  const activeSeparateHostManuallyProvidesClosure = clone(currentOuroborosStdioPackagingInput())
  activeSeparateHostManuallyProvidesClosure.genericStdioReadmeSection +=
    "\nGeneric stdio requires a separate host to manually provide Work Suite dependency closure.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(activeSeparateHostManuallyProvidesClosure),
    [],
  )

  const activeExternalOverlayStartsWorker = clone(currentOuroborosStdioPackagingInput())
  activeExternalOverlayStartsWorker.genericStdioActivationSection +=
    "\nGeneric stdio depends on an external overlay to start worker activation.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(activeExternalOverlayStartsWorker),
    [],
  )

  const activeExternalOverlayExplicitlyStartsWorker = clone(currentOuroborosStdioPackagingInput())
  activeExternalOverlayExplicitlyStartsWorker.genericStdioActivationSection +=
    "\nGeneric stdio depends on an external overlay to explicitly start worker activation.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(activeExternalOverlayExplicitlyStartsWorker),
    [],
  )

  const reliesOnSeparateHostProvidesClosure = clone(currentOuroborosStdioPackagingInput())
  reliesOnSeparateHostProvidesClosure.genericStdioReadmeSection +=
    "\nGeneric stdio relies on a separate host that provides Work Suite dependency closure.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(reliesOnSeparateHostProvidesClosure),
    [],
  )

  const reliesOnExternalOverlayStartsWorker = clone(currentOuroborosStdioPackagingInput())
  reliesOnExternalOverlayStartsWorker.genericStdioActivationSection +=
    "\nGeneric stdio relies on an external overlay that starts worker activation.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(reliesOnExternalOverlayStartsWorker),
    [],
  )

  const requiresSeparateHostPreloadsWorkSuite = clone(currentOuroborosStdioPackagingInput())
  requiresSeparateHostPreloadsWorkSuite.genericStdioReadmeSection +=
    "\nGeneric stdio requires a separate host to preload Work Suite.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(requiresSeparateHostPreloadsWorkSuite),
    [],
  )

  const reliesOnExternalOverlayBringsInWorkSuite = clone(currentOuroborosStdioPackagingInput())
  reliesOnExternalOverlayBringsInWorkSuite.genericStdioActivationSection +=
    "\nGeneric stdio relies on an external overlay that brings in Work Suite.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(reliesOnExternalOverlayBringsInWorkSuite),
    [],
  )

  const reliesOnSeparateHostComesWithWorkSuite = clone(currentOuroborosStdioPackagingInput())
  reliesOnSeparateHostComesWithWorkSuite.genericStdioReadmeSection +=
    "\nGeneric stdio relies on a separate host that comes with Work Suite.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(reliesOnSeparateHostComesWithWorkSuite),
    [],
  )

  const reliesOnExternalOverlayGivesDeskWorker = clone(currentOuroborosStdioPackagingInput())
  reliesOnExternalOverlayGivesDeskWorker.genericStdioActivationSection +=
    "\nGeneric stdio relies on an external overlay that gives you desk:worker.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(reliesOnExternalOverlayGivesDeskWorker),
    [],
  )

  const reliesOnSeparateHostHasBuiltInWorkSuite = clone(currentOuroborosStdioPackagingInput())
  reliesOnSeparateHostHasBuiltInWorkSuite.genericStdioReadmeSection +=
    "\nGeneric stdio relies on a separate host that has built-in Work Suite.\n"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(reliesOnSeparateHostHasBuiltInWorkSuite),
    [],
  )
})

test("generic stdio packaging validation rejects host dependency support claims", () => {
  const genericDependencyClaim = clone(currentOuroborosStdioPackagingInput())
  const genericHost = findByField(
    genericDependencyClaim.activationManifest.host_support,
    "host",
    "generic-stdio",
    "test input",
  )
  genericHost.status = "supported"
  genericHost.dependency_resolution = "flattened"
  genericHost.capabilities = ["mcp", "agents"]
  genericHost.unsupported_primitives = ["agent-defaults"]
  genericHost.fallback_behavior = "start worker after resolving plugin dependencies"

  assert.deepEqual(
    validateOuroborosStdioPackagingContract(genericDependencyClaim),
    [
      "Generic stdio host support must be degraded",
      "Generic stdio host support must use manual-host dependency resolution",
      "Generic stdio host support must expose MCP only",
      "Generic stdio host support must mark plugin-dependency-resolution unsupported",
      "Generic stdio fallback must state no worker activation",
    ],
  )
})

test("generic stdio packaging validation rejects fallback dependency support drift", () => {
  const fallbackDependencyClaim = clone(currentOuroborosStdioPackagingInput())
  findByField(
    fallbackDependencyClaim.activationManifest.host_support,
    "host",
    "generic-stdio",
    "test input",
  ).fallback_behavior =
    "explicit --root or DESK, no worker activation, but resolves plugin dependencies automatically"
  findByField(
    fallbackDependencyClaim.evidenceRows,
    "host_id",
    "generic-stdio",
    "test input",
  ).fallback_behavior =
    "explicit --root or DESK, no worker activation, but resolves plugin dependencies automatically"

  assert.deepEqual(
    validateOuroborosStdioPackagingContract(fallbackDependencyClaim),
    [
      "Generic stdio fallback must not claim plugin dependency resolution",
      "Generic stdio evidence fallback must not claim plugin dependency resolution",
    ],
  )

  const fallbackBuiltInDependencyClaim = clone(currentOuroborosStdioPackagingInput())
  findByField(
    fallbackBuiltInDependencyClaim.activationManifest.host_support,
    "host",
    "generic-stdio",
    "test input",
  ).fallback_behavior =
    "explicit --root or DESK, no worker activation, but has built-in Work Suite"
  findByField(
    fallbackBuiltInDependencyClaim.evidenceRows,
    "host_id",
    "generic-stdio",
    "test input",
  ).fallback_behavior =
    "explicit --root or DESK, no worker activation, but has built-in Work Suite"

  assert.deepEqual(
    validateOuroborosStdioPackagingContract(fallbackBuiltInDependencyClaim),
    [
      "Generic stdio fallback must not claim plugin dependency resolution",
      "Generic stdio evidence fallback must not claim plugin dependency resolution",
    ],
  )
})

test("generic stdio packaging validation rejects fallback worker activation drift", () => {
  const fallbackWorkerClaim = clone(currentOuroborosStdioPackagingInput())
  findByField(
    fallbackWorkerClaim.activationManifest.host_support,
    "host",
    "generic-stdio",
    "test input",
  ).fallback_behavior =
    "explicit --root or DESK, no worker activation, but starts worker activation automatically"
  findByField(
    fallbackWorkerClaim.evidenceRows,
    "host_id",
    "generic-stdio",
    "test input",
  ).fallback_behavior =
    "explicit --root or DESK, no worker activation, but starts worker activation automatically"

  assert.deepEqual(
    validateOuroborosStdioPackagingContract(fallbackWorkerClaim),
    [
      "Generic stdio fallback must not claim worker activation",
      "Generic stdio evidence fallback must not claim worker activation",
    ],
  )

  const fallbackProgressiveWorkerClaim = clone(currentOuroborosStdioPackagingInput())
  findByField(
    fallbackProgressiveWorkerClaim.activationManifest.host_support,
    "host",
    "generic-stdio",
    "test input",
  ).fallback_behavior =
    "explicit --root or DESK, no worker activation, but is launching worker activation automatically"
  findByField(
    fallbackProgressiveWorkerClaim.evidenceRows,
    "host_id",
    "generic-stdio",
    "test input",
  ).fallback_behavior =
    "explicit --root or DESK, no worker activation, but is launching worker activation automatically"

  assert.deepEqual(
    validateOuroborosStdioPackagingContract(fallbackProgressiveWorkerClaim),
    [
      "Generic stdio fallback must not claim worker activation",
      "Generic stdio evidence fallback must not claim worker activation",
    ],
  )

  const fallbackBuiltInWorkerClaim = clone(currentOuroborosStdioPackagingInput())
  findByField(
    fallbackBuiltInWorkerClaim.activationManifest.host_support,
    "host",
    "generic-stdio",
    "test input",
  ).fallback_behavior =
    "explicit --root or DESK, no worker activation, but has a built-in desk:worker"
  findByField(
    fallbackBuiltInWorkerClaim.evidenceRows,
    "host_id",
    "generic-stdio",
    "test input",
  ).fallback_behavior =
    "explicit --root or DESK, no worker activation, but has a built-in desk:worker"

  assert.deepEqual(
    validateOuroborosStdioPackagingContract(fallbackBuiltInWorkerClaim),
    [
      "Generic stdio fallback must not claim worker activation",
      "Generic stdio evidence fallback must not claim worker activation",
    ],
  )
})

test("generic stdio packaging validation rejects evidence row support drift", () => {
  const genericEvidenceDrift = clone(currentOuroborosStdioPackagingInput())
  const genericEvidence = findByField(
    genericEvidenceDrift.evidenceRows,
    "host_id",
    "generic-stdio",
    "test input",
  )
  genericEvidence.disposition = "supported-flattened"
  genericEvidence.source_paths = ["plugins/desk/.mcp.json"]
  genericEvidence.unsupported_primitives = []
  genericEvidence.fallback_behavior = "resolves plugin dependencies and starts worker activation"

  assert.deepEqual(
    validateOuroborosStdioPackagingContract(genericEvidenceDrift),
    [
      "Generic stdio evidence must record degraded-mcp-only disposition",
      "Generic stdio evidence must reference MCP launch docs and activation docs",
      "Generic stdio evidence must mark agent-defaults unsupported",
      "Generic stdio evidence must mark plugin-dependency-resolution unsupported",
      "Generic stdio evidence fallback must state no worker activation",
    ],
  )

  const missingEvidenceFallback = clone(currentOuroborosStdioPackagingInput())
  delete findByField(
    missingEvidenceFallback.evidenceRows,
    "host_id",
    "generic-stdio",
    "test input",
  ).fallback_behavior
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(missingEvidenceFallback),
    ["Generic stdio evidence fallback must state no worker activation"],
  )
})

test("generic stdio packaging validation rejects missing agent-defaults fallback marker", () => {
  const missingAgentDefaultsMarker = clone(currentOuroborosStdioPackagingInput())
  const genericHost = findByField(
    missingAgentDefaultsMarker.activationManifest.host_support,
    "host",
    "generic-stdio",
    "test input",
  )
  genericHost.unsupported_primitives = ["plugin-dependency-resolution"]

  assert.deepEqual(
    validateOuroborosStdioPackagingContract(missingAgentDefaultsMarker),
    ["Generic stdio host support must mark agent-defaults unsupported"],
  )

  const missingFallback = clone(currentOuroborosStdioPackagingInput())
  const fallbackHost = findByField(
    missingFallback.activationManifest.host_support,
    "host",
    "generic-stdio",
    "test input",
  )
  delete fallbackHost.fallback_behavior
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(missingFallback),
    ["Generic stdio fallback must state no worker activation"],
  )
})

test("generic stdio packaging validation rejects malformed host support lists", () => {
  const nonArrayCapabilities = clone(currentOuroborosStdioPackagingInput())
  const capabilitiesHost = findByField(
    nonArrayCapabilities.activationManifest.host_support,
    "host",
    "generic-stdio",
    "test input",
  )
  capabilitiesHost.capabilities = "mcp"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(nonArrayCapabilities),
    ["Generic stdio host support must expose MCP only"],
  )

  const wrongSingleCapability = clone(currentOuroborosStdioPackagingInput())
  const wrongCapabilityHost = findByField(
    wrongSingleCapability.activationManifest.host_support,
    "host",
    "generic-stdio",
    "test input",
  )
  wrongCapabilityHost.capabilities = ["agents"]
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(wrongSingleCapability),
    ["Generic stdio host support must expose MCP only"],
  )

  const nonArrayUnsupported = clone(currentOuroborosStdioPackagingInput())
  const unsupportedHost = findByField(
    nonArrayUnsupported.activationManifest.host_support,
    "host",
    "generic-stdio",
    "test input",
  )
  unsupportedHost.unsupported_primitives = "agent-defaults"
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(nonArrayUnsupported),
    [
      "Generic stdio host support must mark agent-defaults unsupported",
      "Generic stdio host support must mark plugin-dependency-resolution unsupported",
    ],
  )
})

test("Ouroboros/generic stdio packaging validation reports missing rows without crashing", () => {
  assert.deepEqual(
    validateOuroborosStdioPackagingContract(),
    [
      "Ouroboros host support row is required",
      "Ouroboros evidence row is required",
      "Ouroboros docs must define bundle.json plugin metadata",
      "Ouroboros bundle metadata must include desk plugin",
      "Ouroboros bundle metadata must include work-suite plugin",
      "Ouroboros preamble must bind $DESK to ~/AgentBundles/<agent>.ouro/desk/",
      "Generic stdio host support row is required",
      "Generic stdio evidence row is required",
      "Generic stdio launch docs must pass an explicit --root",
      "Generic stdio launch docs must bind $DESK before invoking node",
      "Generic stdio docs must state MCP-only behavior",
      "Generic stdio docs must state no worker activation",
    ],
  )

  assert.deepEqual(
    validateOuroborosStdioPackagingContract({
      activationManifest: {},
      evidenceRows: [],
      ouroborosReadmeSection: "",
      genericStdioReadmeSection: "",
    }),
    [
      "Ouroboros host support row is required",
      "Ouroboros evidence row is required",
      "Ouroboros docs must define bundle.json plugin metadata",
      "Ouroboros bundle metadata must include desk plugin",
      "Ouroboros bundle metadata must include work-suite plugin",
      "Ouroboros preamble must bind $DESK to ~/AgentBundles/<agent>.ouro/desk/",
      "Generic stdio host support row is required",
      "Generic stdio evidence row is required",
      "Generic stdio launch docs must pass an explicit --root",
      "Generic stdio launch docs must bind $DESK before invoking node",
      "Generic stdio docs must state MCP-only behavior",
      "Generic stdio docs must state no worker activation",
    ],
  )

  assert.deepEqual(
    validateOuroborosStdioPackagingContract({
      activationManifest: { host_support: [null] },
      evidenceRows: [null],
      ouroborosReadmeSection: currentOuroborosStdioPackagingInput().ouroborosReadmeSection,
      genericStdioReadmeSection: currentOuroborosStdioPackagingInput().genericStdioReadmeSection,
    }),
    [
      "Ouroboros host support row is required",
      "Ouroboros evidence row is required",
      "Generic stdio host support row is required",
      "Generic stdio evidence row is required",
    ],
  )
})
