import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import * as path from "node:path"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const require = createRequire(import.meta.url)
const docsValidator = require(path.join(repoRoot, "scripts", "test-desk-docs.cjs"))

function record(text, headingPath = [], { inFence = false, file = "fixture.md", line = 1 } = {}) {
  return docsValidator.fixtureRecord(text, headingPath, { inFence, file, line })
}

function errorsFor(text, headingPath = [], options = {}) {
  const errors = []
  docsValidator.validateHealthyPathRecord(errors, record(text, headingPath, options))
  return errors
}

function assertFails(text, expected, headingPath = [], options = {}) {
  assert.ok(
    errorsFor(text, headingPath, options).some((error) => error.includes(expected)),
    `${JSON.stringify(text)} should fail with ${expected}`,
  )
}

function assertPasses(text, headingPath = [], options = {}) {
  assert.deepEqual(errorsFor(text, headingPath, options), [])
}

function mcpReadmeBody(tools = docsValidator.MCP_TOOL_NAMES) {
  return [
    `## Tools exposed (${tools.length})`,
    ...tools.map((tool) => `- \`${tool}\``),
    `All ${tools.length} tools are wired to real implementations.`,
  ].join("\n")
}

test("Desk docs validator exports a testable contract", () => {
  for (const exportName of [
    "DOCS",
    "MCP_TOOL_NAMES",
    "PRIVACY_REQUIRED_DOCS",
    "TOPIC_REQUIREMENTS",
    "WORKFLOW_REQUIREMENTS",
    "fixtureRecord",
    "run",
    "validateHealthyPathRecord",
    "validatePrivacyNotes",
    "validateMcpReadmeToolSurface",
    "validateTopicCoverage",
    "validateValidatorFixtures",
    "validateWorkflowWiring",
  ]) {
    assert.equal(typeof docsValidator[exportName] === "undefined", false, `${exportName} must be exported`)
  }
})

test("markdown parsing preserves headings and fenced command context", () => {
  const records = docsValidator.markdownLines("fixture.md", {
    readFile: () => [
      "# Root",
      "healthy prose",
      "```",
      "## fenced heading ignored",
      "/plugin install desk@ouroboros-skills",
      "```",
      "## Troubleshooting",
      "/plugin install desk@ouroboros-skills",
    ].join("\n"),
  })

  assert.equal(records[1].headingPath.join(" > "), "Root")
  assert.equal(records[4].inFence, true)
  assert.equal(records[4].headingPath.join(" > "), "Root")
  assert.equal(records[7].headingPath.join(" > "), "Root > Troubleshooting")
})

test("healthy-path command validation covers Codex and Claude manual setup escapes", () => {
  assertFails("Run `codex mcp add desk` after activation.", "codex mcp add")
  assertFails("/plugin install desk@ouroboros-skills", "manual Desk/Work Suite plugin dependency installation", [], { inFence: true })
  assertFails("/plugin install work-suite@ouroboros-skills", "manual Desk/Work Suite plugin dependency installation", [], { inFence: true })
  assertFails("Claude Code requires you to install `work-suite` explicitly.", "manual Desk/Work Suite plugin dependency installation")
  assertFails("Paste the worker default block into your Codex instructions.", "AGENTS/worker copy or append")

  assertPasses("Do not run `codex mcp add` for the healthy path.")
  assertPasses("/plugin install desk@ouroboros-skills", ["Troubleshooting"], { inFence: true })
  assertPasses("Copied agent files are not part of the healthy path.")
})

test("healthy-path validation allows host-native activation language for all supported host families", () => {
  for (const text of [
    "Codex uses global-personal activation by default, with project-local and manual-only opt-outs.",
    "Claude uses host-native dependency resolution or a flattened Desk + Work Suite bundle.",
    "Copilot-compatible hosts load the generated flattened bundle metadata.",
    "Ouroboros bundles Desk + Work Suite into the autonomous-agent bundle and binds $DESK in the preamble.",
    "Generic stdio is degraded MCP-only with no worker activation or dependency closure.",
  ]) {
    assertPasses(text)
  }
})

test("privacy validation requires embeddings, snapshots, derivative data, and privacy risk", () => {
  const errors = []
  const docs = ["plugins/desk/README.md", "plugins/desk/mcp/README.md"]
  docsValidator.validatePrivacyNotes(errors, {
    docs,
    readFile: (file) => file === "plugins/desk/README.md"
      ? "Embeddings and snapshots are derivative data and may carry privacy risk."
      : "Embeddings and snapshots are derivative data only.",
  })

  assert.deepEqual(errors, [
    "plugins/desk/mcp/README.md must state that embeddings and snapshots are derivative data and may carry privacy risk",
  ])
})

test("workflow validation requires docs command and host/artifact path filters", () => {
  const errors = []
  docsValidator.validateWorkflowWiring(errors, {
    requirements: [{
      path: ".github/workflows/desk-mcp-tests.yml",
      command: "node scripts/test-desk-docs.cjs",
      paths: [
        "plugins/desk/README.md",
        "plugins/desk/docs/**",
        "plugins/desk/mcp/README.md",
        "plugins/desk/activation/README.md",
        "desk/tasks/2026-06-14-1335-planning-desk-dependency-activation.md",
        "scripts/test-desk-docs.cjs",
      ],
    }],
    readFile: () => [
      "run: node scripts/test-desk-docs.cjs",
      '- "plugins/desk/README.md"',
      '- "plugins/desk/docs/**"',
      '- "plugins/desk/mcp/README.md"',
      '- "plugins/desk/activation/README.md"',
      '- "desk/tasks/2026-06-14-1335-planning-desk-dependency-activation.md"',
    ].join("\n"),
  })

  assert.deepEqual(errors, [
    ".github/workflows/desk-mcp-tests.yml path filters must include scripts/test-desk-docs.cjs",
  ])

  const commandErrors = []
  docsValidator.validateWorkflowWiring(commandErrors, {
    requirements: [{
      path: ".github/workflows/desk-mcp-tests.yml",
      command: "node scripts/test-desk-docs.cjs",
      paths: ["plugins/desk/README.md"],
    }],
    readFile: () => '- plugins/desk/README.md\n',
  })

  assert.deepEqual(commandErrors, [
    ".github/workflows/desk-mcp-tests.yml must run node scripts/test-desk-docs.cjs",
  ])
})

test("MCP README validation locks the advertised tool surface", () => {
  const errors = []
  docsValidator.validateMcpReadmeToolSurface(errors, {
    tools: ["desk_status", "desk_search"],
    readFile: () => mcpReadmeBody(["desk_status", "desk_search"]),
  })
  assert.deepEqual(errors, [])

  const staleErrors = []
  docsValidator.validateMcpReadmeToolSurface(staleErrors, {
    tools: ["desk_status"],
    readFile: () => "## Tools exposed (13)\n13 tools are wired.",
  })

  assert.ok(staleErrors.some((error) => error.includes("advertise 1 exposed tools")))
  assert.ok(staleErrors.some((error) => error.includes("state all 1 tools are wired")))
  assert.ok(staleErrors.some((error) => error.includes("must list desk_status")))
  assert.ok(staleErrors.some((error) => error.includes("stale 12/13 tool counts")))
})

test("browser focus validation requires background targets and rejects active-tab recipes", () => {
  const errors = []
  docsValidator.validateBrowserFocusPolicy(errors, {
    readFile: () => "Target.createTarget({ url, background: true })",
  })
  assert.deepEqual(errors, [])

  const staleErrors = []
  docsValidator.validateBrowserFocusPolicy(staleErrors, {
    readFile: () => 'curl -X PUT "http://localhost:9222/json/new?<URL>"',
  })
  assert.ok(staleErrors.some((error) => error.includes("background target creation")))
  assert.ok(staleErrors.some((error) => error.includes("foregrounding CDP HTTP endpoints")))
})

test("run and startCli expose success, failure, and no-op CLI paths", () => {
  const goodBody = "Embeddings and snapshots are derivative data and may carry privacy risk."
  const workflowBody = [
    "run: node scripts/test-desk-docs.cjs",
    '- "plugins/desk/README.md"',
  ].join("\n")
  const stdout = []
  const stderr = []

  assert.equal(
    docsValidator.run({
      docs: ["plugins/desk/README.md"],
      privacyRequiredDocs: ["plugins/desk/README.md"],
      topicRequirements: [],
      workflowRequirements: [{
        path: ".github/workflows/validate-skills.yml",
        command: "node scripts/test-desk-docs.cjs",
        paths: ["plugins/desk/README.md"],
      }],
      readFile: (file) => {
        if (file === "plugins/desk/mcp/README.md") return mcpReadmeBody()
        if (file === "plugins/desk/skills/cdp-headed-browser/SKILL.md") return "Target.createTarget({ url, background: true })"
        return file.endsWith(".yml") ? workflowBody : goodBody
      },
      stdout: { write: (text) => stdout.push(text) },
      stderr: { write: (text) => stderr.push(text) },
    }),
    0,
  )
  assert.equal(stdout.join(""), "Desk docs validation passed.\n")
  assert.equal(stderr.join(""), "")

  const badStderr = []
  assert.equal(
    docsValidator.run({
      docs: ["plugins/desk/README.md"],
      privacyRequiredDocs: ["plugins/desk/README.md"],
      workflowRequirements: [],
      readFile: () => "Run `npm install`.",
      stdout: { write: () => {} },
      stderr: { write: (text) => badStderr.push(text) },
    }),
    1,
  )
  assert.match(badStderr.join(""), /Desk docs validation failed:/u)
  assert.match(badStderr.join(""), /npm install/u)

  assert.equal(docsValidator.startCli({ isMain: false }), null)
  const exitCodes = []
  assert.equal(
    docsValidator.startCli({
      isMain: true,
      runFn: () => 7,
      setExitCode: (code) => exitCodes.push(code),
    }),
    7,
  )
  assert.deepEqual(exitCodes, [7])

  const previousExitCode = process.exitCode
  try {
    assert.equal(docsValidator.startCli({ isMain: true, runFn: () => 0 }), 0)
    assert.equal(process.exitCode, 0)
  } finally {
    process.exitCode = previousExitCode
  }
})

test("validator fixture self-tests cover artifact privacy and publication policy language", () => {
  const errors = []
  docsValidator.validateValidatorFixtures(errors)
  assert.deepEqual(errors, [])

  const selfTestErrors = []
  docsValidator.validateValidatorFixtures(selfTestErrors, {
    failingFixtures: [{
      text: "Do not run `codex mcp add` for the healthy path.",
      expected: "codex mcp add",
    }],
    passingFixtures: [{
      text: "Run `npm install`.",
    }],
  })
  assert.match(selfTestErrors.join("\n"), /expected "Do not run `codex mcp add`/)
  assert.match(selfTestErrors.join("\n"), /expected "Run `npm install`."/)

  for (const text of [
    "Vector packs are explicit release artifacts protected by publication policy.",
    "Snapshots restore into local state and do not mutate the repository artifact.",
    "Redaction cleanup uses tombstones and artifact rotation.",
  ]) {
    assertPasses(text)
  }
})

test("validateAll rejects docs stripped of required host and artifact coverage", () => {
  const privacyOnly = "Embeddings and snapshots are derivative data and may carry privacy risk."
  const workflowBody = [
    "run: node scripts/test-desk-docs.cjs",
    '- "plugins/desk/README.md"',
    '- "plugins/desk/docs/**"',
    '- "plugins/desk/mcp/README.md"',
    '- "plugins/desk/activation/README.md"',
    '- "desk/tasks/2026-06-14-1335-planning-desk-dependency-activation.md"',
    '- "scripts/test-desk-docs.cjs"',
  ].join("\n")

  const errors = docsValidator.validateAll({
    readFile: (file) => file.endsWith(".yml") ? workflowBody : privacyOnly,
  })

  for (const label of [
    "Codex global personal activation",
    "Claude native dependency activation",
    "Copilot root flattened bundle",
    "Ouroboros autonomous-agent bundle",
    "Generic stdio MCP-only fallback",
    "Vector pack publication",
    "Snapshot warm boot restore",
    "Redaction cleanup",
    "Publication policy approval",
  ]) {
    assert.ok(
      errors.some((error) => error.includes(label)),
      `${label} coverage should be required`,
    )
  }
})

test("topic coverage reports missing terms without accepting command-body false positives", () => {
  const errors = []
  docsValidator.validateTopicCoverage(errors, {
    requirements: [{
      label: "Fixture host coverage",
      docs: ["fixture.md"],
      terms: ["codex", "global-personal", "manual-only"],
    }],
    readFile: () => "Codex uses global-personal activation.",
  })

  assert.deepEqual(errors, [
    "docs must cover Fixture host coverage: missing manual-only in fixture.md",
  ])
})

test("actual Desk docs validate through the default file reads", () => {
  assert.deepEqual(docsValidator.validateAll(), [])
})
