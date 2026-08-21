// Unit 21a: red contract for maintenance artifact scripts and performance
// budgets. These are release/package surfaces, not an everyday Desk CLI.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { main as startMcpServer } from "../../index.js"
import {
  __artifactScriptInternalsForTests,
  runArtifactValidateCli,
  runSnapshotBuildCli,
  runSnapshotVerifyCli,
  runVectorPackBuildCli,
} from "../../src/artifacts/artifact-scripts.js"
import {
  __performanceBudgetInternalsForTests,
  assertBudgetAllowsStart,
  assertWithinBudget,
  budgetValue,
  loadPerformanceBudgets,
} from "../../src/artifacts/performance-budgets.js"
import { closeDb, openDb, setMeta } from "../../src/db/init.js"
import { rebuildIndex } from "../../src/indexer/index.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")
const packageJsonPath = path.join(mcpRoot, "package.json")
const workflowPath = path.join(repoRoot, ".github", "workflows", "desk-mcp-tests.yml")
const performanceBudgetsPath = path.join(mcpRoot, "config", "performance-budgets.json")
const policySchemaPath = path.join(
  repoRoot,
  "plugins",
  "desk",
  "artifacts",
  "publication-policy.schema.json",
)
const EXPECTED_ARTIFACT_SCRIPTS = Object.freeze({
  "artifact:vector-pack:build": "node scripts/build-vector-pack.js",
  "artifact:snapshot:build": "node scripts/build-snapshot.js",
  "artifact:snapshot:verify": "node scripts/verify-snapshot.js",
  "artifact:validate": "node scripts/validate-artifacts.js",
})
const EXPECTED_SCRIPT_FILES = Object.freeze([
  "build-vector-pack.js",
  "build-snapshot.js",
  "verify-snapshot.js",
  "validate-artifacts.js",
])
const ARTIFACT_SCRIPT_TARGETS = Object.freeze([
  Object.freeze({
    artifactType: "vector-pack",
    scriptName: "artifact:vector-pack:build",
    idArg: "--pack-id",
    id: "guarded-pack",
    primaryRel: path.join(
      "artifacts",
      "vector-packs",
      ACTIVE_EMBEDDING_SPEC.id,
      "guarded-pack.jsonl",
    ),
  }),
  Object.freeze({
    artifactType: "snapshot",
    scriptName: "artifact:snapshot:build",
    idArg: "--snapshot-id",
    id: "guarded-snapshot",
    primaryRel: path.join(
      "artifacts",
      "snapshots",
      ACTIVE_EMBEDDING_SPEC.id,
      "guarded-snapshot.sqlite.zst",
    ),
  }),
])

function loadJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

function scriptPath(scriptName) {
  return path.join(mcpRoot, "scripts", scriptName)
}

function scriptSource(scriptName) {
  return readFileSync(scriptPath(scriptName), "utf8")
}

function scriptHelp(scriptName) {
  const result = spawnSync(
    process.execPath,
    [scriptPath(scriptName), "--help"],
    {
      cwd: mcpRoot,
      encoding: "utf8",
    },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return `${result.stdout}${result.stderr}`
}

function makeTempDir(prefix = "desk-artifact-scripts-") {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

function writeFile(root, rel, body) {
  const abs = path.join(root, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, body, "utf8")
  return abs
}

function writeJson(root, rel, value) {
  writeFile(root, rel, `${JSON.stringify(value, null, 2)}\n`)
}

function rewriteJson(file, edit) {
  const body = loadJson(file)
  edit(body)
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8")
}

function validPolicy(overrides = {}) {
  return {
    schema_version: 1,
    default_publication: "deny",
    repo_visibility: "public",
    sensitive_repo: true,
    approved_artifact_types: [],
    approval_required: true,
    approvals: [],
    updated_at: "2026-06-15T00:00:00.000Z",
    ...overrides,
  }
}

function repoApproval(artifactType) {
  return {
    scope: "repo",
    artifact_type: artifactType,
    approved_by: "unit-test-reviewer",
    approved_at: "2026-06-15T00:00:00.000Z",
    reason: "explicit artifact-script fixture approval",
  }
}

function writePolicyFixture(pluginRoot, policy) {
  mkdirSync(path.join(pluginRoot, "artifacts"), { recursive: true })
  writeFileSync(
    path.join(pluginRoot, "artifacts", "publication-policy.schema.json"),
    readFileSync(policySchemaPath),
  )
  writeJson(pluginRoot, path.join("artifacts", "publication-policy.json"), policy)
}

function writeApprovedPolicy(pluginRoot) {
  writePolicyFixture(pluginRoot, validPolicy({
    approved_artifact_types: ["vector-pack", "snapshot"],
    approvals: [repoApproval("vector-pack"), repoApproval("snapshot")],
  }))
}

function writeDeniedPolicy(pluginRoot) {
  writePolicyFixture(pluginRoot, validPolicy())
}

function writeTombstoneLedger(pluginRoot, rows) {
  mkdirSync(path.join(pluginRoot, "artifacts", "tombstones"), { recursive: true })
  writeFileSync(
    path.join(pluginRoot, "artifacts", "tombstones", "tombstones.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  )
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function embedFetch() {
  return async () => ({
    ok: true,
    json: async () => ({
      embedding: Array.from(
        { length: ACTIVE_EMBEDDING_SPEC.dimension },
        (_, index) => index / ACTIVE_EMBEDDING_SPEC.dimension,
      ),
    }),
  })
}

async function seedIndexedDesk({ deskRoot, docPath = "trackA/task-1/task.md", body }) {
  const documentBody = body ?? "---\nstatus: processing\n---\nrelease fixture text\n"
  writeFile(deskRoot, docPath, documentBody)
  await rebuildIndex(deskRoot, { embed: { fetch: embedFetch() } })
  return {
    docPath,
    body: documentBody,
    hash: sha256(documentBody),
  }
}

function runNpmScript(scriptName, args = []) {
  return spawnSync(
    "npm",
    ["--prefix", "plugins/desk/mcp", "run", scriptName, "--", ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DESK_EMBED_TIMEOUT_MS: "10",
      },
    },
  )
}

function artifactArgs({ target, deskRoot, pluginRoot, id = target.id, budgetConfig } = {}) {
  const args = [
    "--desk-root",
    deskRoot,
    "--plugin-root",
    pluginRoot,
    target.idArg,
    id,
    "--from-local-db",
  ]
  if (budgetConfig) args.push("--budget-config", budgetConfig)
  return args
}

function scriptOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
}

function scriptJsonOutput(result) {
  const index = result.stdout.indexOf("{")
  assert.notEqual(index, -1, result.stdout || result.stderr)
  return JSON.parse(result.stdout.slice(index))
}

function assertScriptFailedWithCode(result, code) {
  assert.notEqual(result.status, 0, result.stdout || result.stderr)
  assert.match(scriptOutput(result), new RegExp(`\\b${escapeRegExp(code)}\\b`, "u"))
}

function assertScriptSucceeded(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

function assertOutputDoesNotLeak(result, body) {
  assert.doesNotMatch(scriptOutput(result), new RegExp(escapeRegExp(body), "u"))
}

function filesUnder(root) {
  const out = []
  function walk(current) {
    if (!existsSync(current)) return
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
      } else if (entry.isFile()) {
        out.push(path.relative(root, abs).split(path.sep).join("/"))
      }
    }
  }
  walk(root)
  return out.sort()
}

function artifactTree(pluginRoot) {
  return filesUnder(path.join(pluginRoot, "artifacts"))
    .filter((file) => (
      !file.startsWith("publication-policy.") &&
      !file.startsWith("tombstones/")
    ))
}

function assertArtifactTreeUnchanged(pluginRoot, before) {
  assert.deepEqual(artifactTree(pluginRoot), before)
}

function writeBudgetConfig(file, overrides = {}) {
  const base = {
    schema_version: 1,
    startup: {
      ensure_index_ms: 250,
      snapshot_restore_ms: 250,
      vector_pack_import_ms: 250,
    },
    rebuild: {
      vector_pack_rebuild_ms: 1000,
      snapshot_build_ms: 1000,
    },
    artifacts: {
      snapshot_verify_ms: 1000,
      validate_ms: 1000,
    },
  }
  writeFileSync(
    file,
    `${JSON.stringify({
      ...base,
      ...overrides,
      startup: { ...base.startup, ...overrides.startup },
      rebuild: { ...base.rebuild, ...overrides.rebuild },
      artifacts: { ...base.artifacts, ...overrides.artifacts },
    }, null, 2)}\n`,
    "utf8",
  )
}

function captureIo() {
  const stdout = []
  const stderr = []
  return {
    io: {
      stdout: { write: (text) => stdout.push(text) },
      stderr: { write: (text) => stderr.push(text) },
    },
    stdout,
    stderr,
  }
}

function workflowPathFilters(workflow, eventName) {
  const lines = workflow.split(/\r?\n/u)
  const eventStart = lines.findIndex((line) => line === `  ${eventName}:`)
  assert.notEqual(eventStart, -1, `workflow must define ${eventName}`)
  const eventEnd = lines.findIndex((line, index) => (
    index > eventStart
    && (/^[a-z_]+:/u.test(line) || /^  [a-z_]+:/u.test(line))
  ))
  const eventLines = lines.slice(eventStart, eventEnd === -1 ? lines.length : eventEnd)
  const pathsStart = eventLines.findIndex((line) => line === "    paths:")
  assert.notEqual(pathsStart, -1, `${eventName} must define paths`)
  const paths = []
  for (const line of eventLines.slice(pathsStart + 1)) {
    if (/^\s*$/u.test(line)) continue
    const match = line.match(/^      - "([^"]+)"$/u)
    if (match === null) break
    paths.push(match[1])
  }
  return paths
}

function workflowJob(workflow, jobName) {
  const lines = workflow.split(/\r?\n/u)
  const jobStart = lines.findIndex((line) => line === `  ${jobName}:`)
  assert.notEqual(jobStart, -1, `workflow must define job ${jobName}`)
  const jobEnd = lines.findIndex((line, index) => (
    index > jobStart
    && /^  [A-Za-z0-9_-]+:\s*$/u.test(line)
  ))
  return lines.slice(jobStart, jobEnd === -1 ? lines.length : jobEnd).join("\n")
}

function workflowStepBlocks(jobSection) {
  const blocks = []
  let currentBlock
  for (const line of jobSection.split(/\r?\n/u)) {
    if (/^      - /u.test(line)) {
      if (currentBlock !== undefined) blocks.push(currentBlock.join("\n"))
      currentBlock = [line]
      continue
    }
    if (currentBlock !== undefined) currentBlock.push(line)
  }
  if (currentBlock !== undefined) blocks.push(currentBlock.join("\n"))
  return blocks
}

function workflowStepRunText(stepBlock) {
  const lines = stepBlock.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const inline = lines[index].match(/^\s*run:\s+(.+?)\s*$/u)
    if (inline !== null && inline[1] !== "|" && inline[1] !== ">") {
      return inline[1]
    }
    if (/^\s*run:\s*[|>]\s*$/u.test(lines[index])) {
      return lines
        .slice(index + 1)
        .filter((line) => /^\s{10,}\S/u.test(line))
        .map((line) => line.replace(/^\s{10}/u, ""))
        .join("\n")
    }
  }
  return ""
}

function workflowStepWorkingDirectory(stepBlock) {
  const match = stepBlock.match(/^\s*working-directory:\s+(.+?)\s*$/mu)
  return match?.[1]?.replace(/^["']|["']$/gu, "")
}

function workflowStepAllowsFailure(stepBlock) {
  const match = stepBlock.match(/^\s*continue-on-error:\s+(.+?)\s*$/mu)
  return match !== null && !/^["']?false["']?$/iu.test(match[1])
}

function workflowStepRunsMcpScript(stepBlock, scriptName) {
  if (workflowStepAllowsFailure(stepBlock)) return false
  const runLines = workflowStepRunText(stepBlock)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
  const runsCommand = runLines.some((line) => workflowLineRunsMcpScript(line, scriptName))
  if (!runsCommand) return false
  return (
    workflowStepWorkingDirectory(stepBlock) === "plugins/desk/mcp" ||
    runLines.some((line) => workflowLineRunsMcpScript(line, scriptName, { requirePrefix: true }))
  )
}

function workflowLineRunsMcpScript(line, scriptName, { requirePrefix = false } = {}) {
  const envPrefix = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*`
  const escapedScriptName = escapeRegExp(scriptName)
  const prefixPattern = String.raw`npm\s+--prefix\s+plugins/desk/mcp\s+run\s+${escapedScriptName}(?:\s+(?<prefixArgs>.*)|$)`
  const workingDirPattern = String.raw`npm\s+run\s+${escapedScriptName}(?:\s+(?<workingDirArgs>.*)|$)`
  const match = line.match(new RegExp(`^${envPrefix}(?:${prefixPattern}${requirePrefix ? "" : `|${workingDirPattern}`})`, "u"))
  const args = match?.groups?.prefixArgs ?? match?.groups?.workingDirArgs ?? ""
  return match !== null && workflowScriptArgsAreReal(args)
}

function workflowScriptArgsAreReal(args) {
  return !/(?:^|\s)--help(?:\s|$)/u.test(args)
    && !/(?:^|\s)(?:\|\||&&|\||;)(?:\s|$)/u.test(args)
}

function assertWorkflowJobRunsMcpScript(jobSection, jobName, scriptName) {
  assert.ok(
    workflowStepBlocks(jobSection).some((stepBlock) => workflowStepRunsMcpScript(stepBlock, scriptName)),
    `workflow job ${jobName} must run ${scriptName} from plugins/desk/mcp or via npm --prefix plugins/desk/mcp`,
  )
}

function assertIncludesAll(actual, expected, label) {
  for (const item of expected) {
    assert.ok(actual.includes(item), `${label} must include ${item}`)
  }
}

function assertPositiveIntegerBudget(value, label) {
  assert.equal(Number.isInteger(value), true, `${label} must be an integer`)
  assert.ok(value > 0, `${label} must be positive`)
}

function runtimeServerWithEnsureIndex(ensureIndexResult = { built: false, reason: "fresh" }) {
  const ensureCalls = []
  const startCalls = []
  return {
    ensureCalls,
    startCalls,
    async ensureIndex(deskRoot, opts = {}) {
      ensureCalls.push({ deskRoot, opts })
      return ensureIndexResult
    },
    async startServer(args) {
      startCalls.push(args)
    },
  }
}

async function withSeededArtifactFixture(fn) {
  const deskRoot = makeTempDir("desk-artifact-scripts-budget-desk-")
  const pluginRoot = makeTempDir("desk-artifact-scripts-budget-plugin-")
  try {
    writeApprovedPolicy(pluginRoot)
    await seedIndexedDesk({ deskRoot })
    const vectorTarget = ARTIFACT_SCRIPT_TARGETS[0]
    const vectorRun = runNpmScript(
      vectorTarget.scriptName,
      artifactArgs({ target: vectorTarget, deskRoot, pluginRoot }),
    )
    assertScriptSucceeded(vectorRun)
    const snapshotTarget = ARTIFACT_SCRIPT_TARGETS[1]
    const snapshotRun = runNpmScript(
      snapshotTarget.scriptName,
      [
        ...artifactArgs({ target: snapshotTarget, deskRoot, pluginRoot }),
        "--included-pack-id",
        vectorTarget.id,
      ],
    )
    assertScriptSucceeded(snapshotRun)
    await fn({ deskRoot, pluginRoot, snapshotTarget, vectorTarget })
  } finally {
    rmSync(deskRoot, { recursive: true, force: true })
    rmSync(pluginRoot, { recursive: true, force: true })
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

test("package declares artifact maintenance scripts without adding a user Desk CLI", () => {
  const packageJson = loadJson(packageJsonPath)

  assert.deepEqual(
    Object.fromEntries(
      Object.keys(EXPECTED_ARTIFACT_SCRIPTS)
        .map((scriptName) => [scriptName, packageJson.scripts?.[scriptName]]),
    ),
    EXPECTED_ARTIFACT_SCRIPTS,
  )
  assert.deepEqual(packageJson.bin, { "desk-mcp": "./index.js" })

  for (const scriptName of EXPECTED_SCRIPT_FILES) {
    const source = scriptSource(scriptName)
    assert.equal(source.startsWith("#!/usr/bin/env node\n"), true)
    assert.match(scriptHelp(scriptName), /artifact|snapshot|vector-pack|maintenance|release/iu)
    assert.doesNotMatch(source, /new\s+Command|commander|yargs/u)
  }
})

test("artifact build scripts publish allowed artifacts only under canonical dirs", async () => {
  const deskRoot = makeTempDir("desk-artifact-scripts-allowed-desk-")
  const pluginRoot = makeTempDir("desk-artifact-scripts-allowed-plugin-")
  try {
    writeApprovedPolicy(pluginRoot)
    await seedIndexedDesk({ deskRoot })

    const vectorTarget = ARTIFACT_SCRIPT_TARGETS[0]
    const vectorRun = runNpmScript(
      vectorTarget.scriptName,
      artifactArgs({ target: vectorTarget, deskRoot, pluginRoot }),
    )
    assertScriptSucceeded(vectorRun)
    assert.deepEqual(
      filesUnder(path.join(pluginRoot, "artifacts", "vector-packs", ACTIVE_EMBEDDING_SPEC.id)),
      [
        "guarded-pack.jsonl",
        "guarded-pack.manifest.json",
        "guarded-pack.sha256",
      ],
    )

    const snapshotTarget = ARTIFACT_SCRIPT_TARGETS[1]
    const snapshotRun = runNpmScript(
      snapshotTarget.scriptName,
      [
        ...artifactArgs({ target: snapshotTarget, deskRoot, pluginRoot }),
        "--included-pack-id",
        vectorTarget.id,
      ],
    )
    assertScriptSucceeded(snapshotRun)
    assert.deepEqual(
      filesUnder(path.join(pluginRoot, "artifacts", "snapshots", ACTIVE_EMBEDDING_SPEC.id)),
      [
        "guarded-snapshot.manifest.json",
        "guarded-snapshot.sha256",
        "guarded-snapshot.sqlite.zst",
      ],
    )

    const artifactFiles = filesUnder(path.join(pluginRoot, "artifacts"))
    assert.equal(artifactFiles.includes("guarded-pack.jsonl"), false)
    assert.equal(artifactFiles.includes("guarded-snapshot.sqlite.zst"), false)
    assert.ok(artifactFiles.every((file) => (
      file.startsWith("publication-policy.") ||
      file.startsWith(`vector-packs/${ACTIVE_EMBEDDING_SPEC.id}/`) ||
      file.startsWith(`snapshots/${ACTIVE_EMBEDDING_SPEC.id}/`)
    )))
  } finally {
    rmSync(deskRoot, { recursive: true, force: true })
    rmSync(pluginRoot, { recursive: true, force: true })
  }
})

test("artifact build scripts can stamp a source provenance commit", async () => {
  const deskRoot = makeTempDir("desk-artifact-scripts-provenance-desk-")
  const pluginRoot = makeTempDir("desk-artifact-scripts-provenance-plugin-")
  const provenanceCommit = "1".repeat(40)
  try {
    writeApprovedPolicy(pluginRoot)
    await seedIndexedDesk({ deskRoot })

    const packId = "source-provenance-pack"
    assert.equal(
      await runVectorPackBuildCli({
        argv: [
          "--desk-root",
          deskRoot,
          "--plugin-root",
          pluginRoot,
          "--pack-id",
          packId,
          "--from-local-db",
          "--provenance-commit",
          provenanceCommit,
        ],
        io: captureIo().io,
      }),
      0,
    )

    const snapshotId = "source-provenance-snapshot"
    assert.equal(
      await runSnapshotBuildCli({
        argv: [
          "--desk-root",
          deskRoot,
          "--plugin-root",
          pluginRoot,
          "--snapshot-id",
          snapshotId,
          "--included-pack-id",
          packId,
          "--from-local-db",
          "--provenance-commit",
          provenanceCommit,
        ],
        io: captureIo().io,
      }),
      0,
    )

    const packManifest = loadJson(path.join(
      pluginRoot,
      "artifacts",
      "vector-packs",
      ACTIVE_EMBEDDING_SPEC.id,
      `${packId}.manifest.json`,
    ))
    const snapshotManifest = loadJson(path.join(
      pluginRoot,
      "artifacts",
      "snapshots",
      ACTIVE_EMBEDDING_SPEC.id,
      `${snapshotId}.manifest.json`,
    ))

    assert.equal(packManifest.provenance.commit, provenanceCommit)
    assert.equal(snapshotManifest.provenance.commit, provenanceCommit)
    assert.equal(packManifest.discovery_grammar_version, 2)
    assert.equal(snapshotManifest.discovery_grammar_version, 2)
    assert.ok(packManifest.source_paths.includes("plugins/desk/mcp/src/indexer/discover.js"))
    assert.ok(snapshotManifest.source_paths.includes("plugins/desk/mcp/src/indexer/discover.js"))
  } finally {
    rmSync(deskRoot, { recursive: true, force: true })
    rmSync(pluginRoot, { recursive: true, force: true })
  }
})

test("artifact build scripts reject publication-policy denial before writing bytes", async () => {
  const deskRoot = makeTempDir("desk-artifact-scripts-denied-desk-")
  const pluginRoot = makeTempDir("desk-artifact-scripts-denied-plugin-")
  try {
    writeDeniedPolicy(pluginRoot)
    const doc = await seedIndexedDesk({ deskRoot })

    for (const target of ARTIFACT_SCRIPT_TARGETS) {
      const before = artifactTree(pluginRoot)
      const result = runNpmScript(
        target.scriptName,
        artifactArgs({ target, deskRoot, pluginRoot }),
      )
      assertScriptFailedWithCode(result, "artifact_publication_not_approved")
      assertOutputDoesNotLeak(result, doc.body)
      assertArtifactTreeUnchanged(pluginRoot, before)
    }
  } finally {
    rmSync(deskRoot, { recursive: true, force: true })
    rmSync(pluginRoot, { recursive: true, force: true })
  }
})

test("artifact build scripts reject excluded local DB docs before writing bytes", async () => {
  const deskRoot = makeTempDir("desk-artifact-scripts-excluded-desk-")
  const pluginRoot = makeTempDir("desk-artifact-scripts-excluded-plugin-")
  try {
    writeApprovedPolicy(pluginRoot)
    const doc = await seedIndexedDesk({
      deskRoot,
      docPath: "ignored-track/task-1/task.md",
      body: "---\nstatus: processing\n---\nexcluded release fixture text\n",
    })
    writeFile(deskRoot, ".gitignore", "ignored-track/\n")

    for (const target of ARTIFACT_SCRIPT_TARGETS) {
      const before = artifactTree(pluginRoot)
      const result = runNpmScript(
        target.scriptName,
        artifactArgs({ target, deskRoot, pluginRoot }),
      )
      assertScriptFailedWithCode(result, "artifact_input_excluded")
      assertOutputDoesNotLeak(result, doc.body)
      assertArtifactTreeUnchanged(pluginRoot, before)
    }
  } finally {
    rmSync(deskRoot, { recursive: true, force: true })
    rmSync(pluginRoot, { recursive: true, force: true })
  }
})

test("artifact build scripts reject tombstoned local DB docs before writing bytes", async () => {
  const deskRoot = makeTempDir("desk-artifact-scripts-tombstone-desk-")
  const pluginRoot = makeTempDir("desk-artifact-scripts-tombstone-plugin-")
  try {
    writeApprovedPolicy(pluginRoot)
    const doc = await seedIndexedDesk({
      deskRoot,
      body: "---\nstatus: processing\n---\nredacted release fixture text\n",
    })
    writeTombstoneLedger(pluginRoot, [
      {
        schema_version: 1,
        document_path: doc.docPath,
        document_hash: doc.hash,
        reason: "redacted",
        redacted_at: "2026-06-15T00:00:00.000Z",
        effective_from: "2026-06-15T00:00:00.000Z",
        artifact_rotation_id: "unit-21a-redaction",
        actor: "unit-test-reviewer",
      },
    ])

    for (const target of ARTIFACT_SCRIPT_TARGETS) {
      const before = artifactTree(pluginRoot)
      const result = runNpmScript(
        target.scriptName,
        artifactArgs({ target, deskRoot, pluginRoot }),
      )
      assertScriptFailedWithCode(result, "artifact_input_redacted")
      assertOutputDoesNotLeak(result, doc.body)
      assertArtifactTreeUnchanged(pluginRoot, before)
    }
  } finally {
    rmSync(deskRoot, { recursive: true, force: true })
    rmSync(pluginRoot, { recursive: true, force: true })
  }
})

test("performance budget config declares startup, rebuild, and artifact thresholds", () => {
  assert.equal(existsSync(performanceBudgetsPath), true)
  const budgets = loadJson(performanceBudgetsPath)

  assert.equal(budgets.schema_version, 1)
  assertPositiveIntegerBudget(budgets.startup?.ensure_index_ms, "startup.ensure_index_ms")
  assert.equal(
    budgets.startup.ensure_index_ms,
    250,
    "startup.ensure_index_ms must match the bounded startup MCP registration budget",
  )
  assertPositiveIntegerBudget(budgets.startup?.snapshot_restore_ms, "startup.snapshot_restore_ms")
  assertPositiveIntegerBudget(budgets.startup?.vector_pack_import_ms, "startup.vector_pack_import_ms")
  assertPositiveIntegerBudget(budgets.rebuild?.vector_pack_rebuild_ms, "rebuild.vector_pack_rebuild_ms")
  assertPositiveIntegerBudget(budgets.rebuild?.snapshot_build_ms, "rebuild.snapshot_build_ms")
  assertPositiveIntegerBudget(budgets.artifacts?.snapshot_verify_ms, "artifacts.snapshot_verify_ms")
  assertPositiveIntegerBudget(budgets.artifacts?.validate_ms, "artifacts.validate_ms")
})

test("performance budget loader fails closed for malformed, missing, or invalid configs", async () => {
  const fallbackRoot = makeTempDir("desk-artifact-scripts-budget-fallback-")
  const explicitRoot = makeTempDir("desk-artifact-scripts-budget-invalid-")
  try {
    const fallback = await loadPerformanceBudgets({ mcpRoot: fallbackRoot })
    assert.equal(fallback.startup.ensure_index_ms, 250)
    fallback.startup.ensure_index_ms = 1
    assert.equal(
      (await loadPerformanceBudgets({ mcpRoot: fallbackRoot })).startup.ensure_index_ms,
      250,
    )

    await assert.rejects(
      () => loadPerformanceBudgets(),
      /mcpRoot is required/u,
    )

    await assert.rejects(
      () => loadPerformanceBudgets({
        configPath: path.join(explicitRoot, "missing.json"),
        mcpRoot: explicitRoot,
      }),
      (error) => error.code === "performance_budget_config_invalid" &&
        /could not be read/u.test(error.message),
    )

    const malformed = path.join(explicitRoot, "malformed.json")
    writeFileSync(malformed, "{", "utf8")
    await assert.rejects(
      () => loadPerformanceBudgets({ configPath: malformed, mcpRoot: explicitRoot }),
      (error) => error.code === "performance_budget_config_invalid" &&
        /valid JSON/u.test(error.message),
    )

    for (const [body, expectedDiagnostic] of [
      [null, "performance budget config must be an object"],
      [{ schema_version: 2 }, "performance budget config schema_version must be 1"],
      [{ schema_version: 1, startup: [], rebuild: {}, artifacts: {} }, "performance budget startup must be an object"],
      [
        {
          schema_version: 1,
          startup: { ensure_index_ms: -1, snapshot_restore_ms: 1, vector_pack_import_ms: 1 },
          rebuild: { vector_pack_rebuild_ms: 1, snapshot_build_ms: 1 },
          artifacts: { snapshot_verify_ms: 1, validate_ms: 1 },
        },
        "performance budget startup.ensure_index_ms must be a non-negative integer",
      ],
    ]) {
      const config = path.join(explicitRoot, `invalid-${expectedDiagnostic.split(" ").at(-1)}.json`)
      writeFileSync(config, `${JSON.stringify(body)}\n`, "utf8")
      await assert.rejects(
        () => loadPerformanceBudgets({ configPath: config, mcpRoot: explicitRoot }),
        (error) => error.code === "performance_budget_config_invalid" &&
          error.diagnostics.includes(expectedDiagnostic),
      )
    }

    assert.throws(
      () => budgetValue({ startup: { ensure_index_ms: "250" } }, "startup", "ensure_index_ms"),
      (error) => error.code === "performance_budget_config_invalid",
    )
    assert.throws(
      () => assertBudgetAllowsStart({ budgetMs: 0, label: "unit budget" }),
      (error) => error.code === "performance_budget_exceeded" &&
        error.budget_ms === 0 &&
        error.elapsed_ms === 0,
    )
    assert.equal(
      assertWithinBudget({ startedAt: 10, budgetMs: 5, label: "unit budget", now: () => 12 }),
      2,
    )
    assert.throws(
      () => assertWithinBudget({ startedAt: 10, budgetMs: 5, label: "unit budget", now: () => 20 }),
      (error) => error.code === "performance_budget_exceeded" &&
        error.budget_ms === 5 &&
        error.elapsed_ms === 10,
    )
    assert.throws(
      () => __performanceBudgetInternalsForTests.requiredPath("", "budget root"),
      /budget root is required/u,
    )
  } finally {
    rmSync(fallbackRoot, { recursive: true, force: true })
    rmSync(explicitRoot, { recursive: true, force: true })
  }
})

test("MCP startup reads ensure-index budget from plugin performance config", async () => {
  const deskRoot = makeTempDir("desk-artifact-scripts-startup-budget-desk-")
  const pluginRoot = makeTempDir("desk-artifact-scripts-startup-budget-plugin-")
  try {
    mkdirSync(path.join(pluginRoot, "config"), { recursive: true })
    writeBudgetConfig(path.join(pluginRoot, "config", "performance-budgets.json"), {
      startup: {
        ensure_index_ms: 37,
      },
    })
    const runtimeServer = runtimeServerWithEnsureIndex()

    await startMcpServer({
      argv: ["--root", deskRoot],
      cwd: deskRoot,
      env: {},
      homeDir: deskRoot,
      mcpRoot: pluginRoot,
      runtimeImporter: async () => runtimeServer,
    })

    assert.equal(runtimeServer.ensureCalls.length, 1)
    assert.equal(runtimeServer.ensureCalls[0].deskRoot, deskRoot)
    assert.equal(runtimeServer.ensureCalls[0].opts.startup, true)
    assert.equal(runtimeServer.ensureCalls[0].opts.budgetMs, 37)
    assert.equal(runtimeServer.startCalls.length, 1)
    assert.equal(runtimeServer.startCalls[0].statusContext.startup.budget_ms, 37)
  } finally {
    rmSync(deskRoot, { recursive: true, force: true })
    rmSync(pluginRoot, { recursive: true, force: true })
  }
})

test("artifact validation output does not leak resolved local roots", async () => {
  await withSeededArtifactFixture(async ({ deskRoot, pluginRoot }) => {
    const result = runNpmScript("artifact:validate", [
      "--desk-root",
      deskRoot,
      "--plugin-root",
      pluginRoot,
    ])
    assertScriptSucceeded(result)
    const output = scriptJsonOutput(result)
    const outputText = JSON.stringify(output)
    assert.doesNotMatch(outputText, new RegExp(escapeRegExp(deskRoot), "u"))
    assert.doesNotMatch(outputText, new RegExp(escapeRegExp(pluginRoot), "u"))
    assert.equal(Object.hasOwn(output, "desk_root"), false)
    assert.equal(Object.hasOwn(output, "plugin_root"), false)
  })
})

test("artifact builders reject stale discovery grammar DBs", async () => {
  const deskRoot = makeTempDir("desk-artifact-scripts-stale-grammar-desk-")
  const pluginRoot = makeTempDir("desk-artifact-scripts-stale-grammar-plugin-")
  try {
    writeApprovedPolicy(pluginRoot)
    writeFile(
      deskRoot,
      path.join("trackA", "task-1", "task.md"),
      "---\nstatus: processing\n---\nstale grammar artifact body",
    )
    await rebuildIndex(deskRoot, { skipEmbed: true })
    const db = openDb(deskRoot)
    try {
      setMeta(db, "discovery_grammar_version", "1")
    } finally {
      closeDb(db)
    }

    for (const [run, idFlag, id] of [
      [runVectorPackBuildCli, "--pack-id", "stale-grammar-pack"],
      [runSnapshotBuildCli, "--snapshot-id", "stale-grammar-snapshot"],
    ]) {
      const captured = captureIo()
      assert.equal(
        await run({
          argv: [
            "--desk-root",
            deskRoot,
            "--plugin-root",
            pluginRoot,
            idFlag,
            id,
            "--from-local-db",
          ],
          io: captured.io,
        }),
        1,
      )
      assert.match(
        captured.stderr.join(""),
        /discovery grammar version 1 is stale.*desk_reindex/u,
      )
    }
  } finally {
    rmSync(deskRoot, { recursive: true, force: true })
    rmSync(pluginRoot, { recursive: true, force: true })
  }
})

test("artifact builders reject missing grammar metadata and stale document trees", async () => {
  const deskRoot = makeTempDir("desk-artifact-scripts-stale-tree-desk-")
  const pluginRoot = makeTempDir("desk-artifact-scripts-stale-tree-plugin-")
  try {
    writeApprovedPolicy(pluginRoot)
    writeFile(
      deskRoot,
      path.join("trackA", "task-1", "task.md"),
      "---\nstatus: processing\n---\nindexed artifact body",
    )
    await rebuildIndex(deskRoot, { skipEmbed: true })

    const db = openDb(deskRoot)
    try {
      db.prepare("DELETE FROM meta WHERE key = 'discovery_grammar_version'").run()
    } finally {
      closeDb(db)
    }
    const missingGrammar = captureIo()
    assert.equal(
      await runVectorPackBuildCli({
        argv: [
          "--desk-root",
          deskRoot,
          "--plugin-root",
          pluginRoot,
          "--pack-id",
          "missing-grammar-pack",
          "--from-local-db",
        ],
        io: missingGrammar.io,
      }),
      1,
    )
    assert.match(
      missingGrammar.stderr.join(""),
      /discovery grammar version missing is stale.*desk_reindex/u,
    )

    const restoredDb = openDb(deskRoot)
    try {
      setMeta(restoredDb, "discovery_grammar_version", "2")
    } finally {
      closeDb(restoredDb)
    }
    writeFile(
      deskRoot,
      path.join("trackA", "reference.md"),
      "newly discovered artifact document",
    )

    for (const [run, idFlag, id] of [
      [runVectorPackBuildCli, "--pack-id", "stale-tree-pack"],
      [runSnapshotBuildCli, "--snapshot-id", "stale-tree-snapshot"],
    ]) {
      const captured = captureIo()
      assert.equal(
        await run({
          argv: [
            "--desk-root",
            deskRoot,
            "--plugin-root",
            pluginRoot,
            idFlag,
            id,
            "--from-local-db",
          ],
          io: captured.io,
        }),
        1,
      )
      assert.match(
        captured.stderr.join(""),
        /document tree is stale.*desk_reindex/u,
      )
    }
  } finally {
    rmSync(deskRoot, { recursive: true, force: true })
    rmSync(pluginRoot, { recursive: true, force: true })
  }
})

test("artifact builders reject matching document trees with stale chunk contents", async () => {
  const deskRoot = makeTempDir("desk-artifact-scripts-stale-chunks-desk-")
  const pluginRoot = makeTempDir("desk-artifact-scripts-stale-chunks-plugin-")
  try {
    writeApprovedPolicy(pluginRoot)
    writeFile(
      deskRoot,
      path.join("trackA", "task-1", "task.md"),
      "---\nstatus: processing\n---\nstale chunk artifact body",
    )
    await rebuildIndex(deskRoot, { skipEmbed: true })
    const db = openDb(deskRoot)
    try {
      db.prepare("DELETE FROM chunks").run()
    } finally {
      closeDb(db)
    }

    for (const [run, idFlag, id] of [
      [runVectorPackBuildCli, "--pack-id", "stale-chunks-pack"],
      [runSnapshotBuildCli, "--snapshot-id", "stale-chunks-snapshot"],
    ]) {
      const captured = captureIo()
      assert.equal(
        await run({
          argv: [
            "--desk-root",
            deskRoot,
            "--plugin-root",
            pluginRoot,
            idFlag,
            id,
            "--from-local-db",
          ],
          io: captured.io,
        }),
        1,
      )
      assert.match(
        captured.stderr.join(""),
        /index contents are stale.*desk_reindex/u,
      )
    }
  } finally {
    rmSync(deskRoot, { recursive: true, force: true })
    rmSync(pluginRoot, { recursive: true, force: true })
  }
})

test("artifact script CLIs cover help, usage errors, repeated args, and targeted snapshot verification", async () => {
  for (const [run, pattern] of [
    [runVectorPackBuildCli, /Build a Desk vector-pack artifact/u],
    [runSnapshotBuildCli, /Build a Desk snapshot artifact/u],
    [runSnapshotVerifyCli, /Verify a Desk snapshot artifact/u],
    [runArtifactValidateCli, /Validate Desk vector-pack/u],
  ]) {
    for (const helpFlag of ["-h", "--help"]) {
      const { io, stdout, stderr } = captureIo()
      assert.equal(await run({ argv: [helpFlag], io }), 0)
      assert.match(stdout.join(""), pattern)
      assert.equal(stderr.join(""), "")
    }
  }

  const usage = captureIo()
  assert.equal(await runVectorPackBuildCli({ argv: ["ignored-positional"], io: usage.io }), 1)
  assert.match(usage.stderr.join(""), /artifact_script_usage: --desk-root is required/u)

  const defaultRootVerify = captureIo()
  assert.equal(await runSnapshotVerifyCli({ argv: [], io: defaultRootVerify.io }), 0)
  assert.ok(
    JSON.parse(defaultRootVerify.stdout.join("")).snapshots.count >= 1,
    "default plugin root should verify committed release snapshots",
  )

  const invalidManifestPluginRoot = makeTempDir("desk-artifact-scripts-invalid-snapshot-")
  try {
    writeFile(
      invalidManifestPluginRoot,
      path.join(
        "artifacts",
        "snapshots",
        ACTIVE_EMBEDDING_SPEC.id,
        "invalid-snapshot.manifest.json",
      ),
      "{",
    )
    const plainError = captureIo()
    assert.equal(
      await runSnapshotVerifyCli({
        argv: ["--plugin-root", invalidManifestPluginRoot, "--snapshot-id", "invalid-snapshot"],
        io: plainError.io,
      }),
      1,
    )
    assert.match(plainError.stderr.join(""), /artifact_script_failed:/u)
  } finally {
    rmSync(invalidManifestPluginRoot, { recursive: true, force: true })
  }

  await withSeededArtifactFixture(async ({ deskRoot, pluginRoot, snapshotTarget, vectorTarget }) => {
    const buildPack = captureIo()
    const nextPackId = "direct-build-pack"
    assert.equal(
      await runVectorPackBuildCli({
        argv: [
          "--desk-root",
          deskRoot,
          "--plugin-root",
          pluginRoot,
          "--pack-id",
          nextPackId,
          "--from-local-db",
        ],
        io: buildPack.io,
      }),
      0,
      buildPack.stderr.join(""),
    )
    const builtPack = JSON.parse(buildPack.stdout.join(""))
    assert.equal(builtPack.pack_id, nextPackId)
    assert.equal(builtPack.rows_written, 1)

    const allVerify = captureIo()
    assert.equal(
      await runSnapshotVerifyCli({
        argv: ["--plugin-root", pluginRoot],
        io: allVerify.io,
      }),
      0,
      allVerify.stderr.join(""),
    )
    const allVerifyBody = JSON.parse(allVerify.stdout.join(""))
    assert.equal(allVerifyBody.snapshots.count, 1)
    assert.equal(allVerifyBody.snapshots.artifacts[0].snapshot_id, snapshotTarget.id)

    const directVerify = captureIo()
    assert.equal(
      await runSnapshotVerifyCli({
        argv: [
          "--desk-root",
          deskRoot,
          "--plugin-root",
          pluginRoot,
          "--snapshot-id",
          snapshotTarget.id,
        ],
        io: directVerify.io,
      }),
      0,
      directVerify.stderr.join(""),
    )
    const directVerifyBody = JSON.parse(directVerify.stdout.join(""))
    assert.equal(directVerifyBody.snapshot_id, snapshotTarget.id)
    assert.equal(directVerifyBody.freshness.artifact_source_scope, "fresh")

    const buildSnapshot = captureIo()
    const nextSnapshotId = "multi-pack-snapshot"
    assert.equal(
      await runSnapshotBuildCli({
        argv: [
          "--desk-root",
          deskRoot,
          "--plugin-root",
          pluginRoot,
          "--snapshot-id",
          nextSnapshotId,
          "--included-pack-id",
          vectorTarget.id,
          "--included-pack-id",
          "second-pack",
          "--included-pack-id",
          "third-pack",
        ],
        io: buildSnapshot.io,
      }),
      0,
      buildSnapshot.stderr.join(""),
    )
    const builtSnapshot = JSON.parse(buildSnapshot.stdout.join(""))
    assert.equal(builtSnapshot.snapshot_id, nextSnapshotId)
    const manifest = loadJson(path.join(
      pluginRoot,
      "artifacts",
      "snapshots",
      ACTIVE_EMBEDDING_SPEC.id,
      `${nextSnapshotId}.manifest.json`,
    ))
    assert.deepEqual(manifest.included_pack_ids, [vectorTarget.id, "second-pack", "third-pack"])
    assert.deepEqual(manifest.runtime, {
      platform: "portable",
      arch: "portable",
      node_abi: "portable",
    })

    for (const snapshotId of [snapshotTarget.id, nextSnapshotId]) {
      rewriteJson(
        path.join(
          pluginRoot,
          "artifacts",
          "snapshots",
          ACTIVE_EMBEDDING_SPEC.id,
          `${snapshotId}.manifest.json`,
        ),
        (body) => {
          delete body.represented_documents
          body.document_tree_hash =
            __artifactScriptInternalsForTests.documentTreeHash([])
        },
      )
    }
    rewriteJson(
      path.join(
        pluginRoot,
        "artifacts",
        "vector-packs",
        ACTIVE_EMBEDDING_SPEC.id,
        `${nextPackId}.manifest.json`,
      ),
      (body) => {
        delete body.represented_documents
        body.document_tree_hash =
          __artifactScriptInternalsForTests.documentTreeHash([])
      },
    )

    const missingDocsVerify = captureIo()
    assert.equal(
      await runSnapshotVerifyCli({
        argv: ["--plugin-root", pluginRoot, "--snapshot-id", snapshotTarget.id],
        io: missingDocsVerify.io,
      }),
      0,
      missingDocsVerify.stderr.join(""),
    )
    const missingDocsVerifyBody = JSON.parse(missingDocsVerify.stdout.join(""))
    assert.equal(missingDocsVerifyBody.snapshot_id, snapshotTarget.id)
    assert.equal(missingDocsVerifyBody.freshness.document_tree, "stale")

    const missingDocsAllVerify = captureIo()
    assert.equal(
      await runSnapshotVerifyCli({
        argv: ["--plugin-root", pluginRoot],
        io: missingDocsAllVerify.io,
      }),
      0,
      missingDocsAllVerify.stderr.join(""),
    )
    assert.ok(
      JSON.parse(missingDocsAllVerify.stdout.join(""))
        .snapshots.artifacts.every(
          (artifact) => artifact.freshness.document_tree === "stale",
        ),
    )

    const directValidate = captureIo()
    assert.equal(
      await runArtifactValidateCli({
        argv: [
          "--desk-root",
          deskRoot,
          "--plugin-root",
          pluginRoot,
        ],
        io: directValidate.io,
      }),
      0,
      directValidate.stderr.join(""),
    )
    const directValidateBody = JSON.parse(directValidate.stdout.join(""))
    assert.equal(directValidateBody.vector_packs.count, 2)
    assert.equal(directValidateBody.snapshots.count, 2)
    assert.equal(
      directValidateBody.vector_packs.artifacts.find(
        (artifact) => artifact.pack_id === nextPackId,
      ).freshness.document_tree,
      "stale",
    )

    const emptyPluginRoot = makeTempDir("desk-artifact-scripts-empty-plugin-")
    try {
      writeApprovedPolicy(emptyPluginRoot)
      const emptyValidate = captureIo()
      assert.equal(
        await runArtifactValidateCli({
          argv: [
            "--desk-root",
            deskRoot,
            "--plugin-root",
            emptyPluginRoot,
          ],
          io: emptyValidate.io,
        }),
        0,
        emptyValidate.stderr.join(""),
      )
      const emptyValidateBody = JSON.parse(emptyValidate.stdout.join(""))
      assert.equal(emptyValidateBody.vector_packs.count, 0)
      assert.equal(emptyValidateBody.snapshots.count, 0)
    } finally {
      rmSync(emptyPluginRoot, { recursive: true, force: true })
    }
  })
})

test("vector-pack build supports lexical-only local DBs with no vector rows", async () => {
  const deskRoot = makeTempDir("desk-artifact-scripts-empty-pack-desk-")
  const pluginRoot = makeTempDir("desk-artifact-scripts-empty-pack-plugin-")
  try {
    writeApprovedPolicy(pluginRoot)
    writeFile(deskRoot, "trackA/task-1/task.md", "---\nstatus: processing\n---\nrelease fixture text\n")
    await rebuildIndex(deskRoot, { skipEmbed: true })

    const buildPack = captureIo()
    const packId = "lexical-only-pack"
    assert.equal(
      await runVectorPackBuildCli({
        argv: [
          "--desk-root",
          deskRoot,
          "--plugin-root",
          pluginRoot,
          "--pack-id",
          packId,
          "--from-local-db",
        ],
        io: buildPack.io,
      }),
      0,
      buildPack.stderr.join(""),
    )
    const output = JSON.parse(buildPack.stdout.join(""))
    assert.equal(output.rows_written, 0)
    const packDir = path.join(pluginRoot, "artifacts", "vector-packs", ACTIVE_EMBEDDING_SPEC.id)
    assert.equal(readFileSync(path.join(packDir, `${packId}.jsonl`), "utf8"), "")
    assert.equal(loadJson(path.join(packDir, `${packId}.manifest.json`)).row_count, 0)
  } finally {
    rmSync(deskRoot, { recursive: true, force: true })
    rmSync(pluginRoot, { recursive: true, force: true })
  }
})

test("artifact script defensive helpers cover filesystem and fallback branches", async () => {
  const tempRoot = makeTempDir("desk-artifact-scripts-helper-")
  try {
    assert.throws(
      () => __artifactScriptInternalsForTests.requiredPath("", "helper root"),
      /helper root is required/u,
    )
    assert.equal(
      Buffer.compare(
        __artifactScriptInternalsForTests.readFileOrEmpty(path.join(tempRoot, "missing.txt")),
        Buffer.alloc(0),
      ),
      0,
    )
    const fakeDb = {
      calls: [],
      pragma(sql) {
        this.calls.push(sql)
        if (sql.includes("TRUNCATE")) throw new Error("checkpoint busy")
      },
    }
    __artifactScriptInternalsForTests.checkpointDb(fakeDb)
    assert.deepEqual(fakeDb.calls, ["wal_checkpoint(TRUNCATE)", "wal_checkpoint(PASSIVE)"])

    const notDirectory = path.join(tempRoot, "not-a-directory")
    writeFileSync(notDirectory, "fixture", "utf8")
    await assert.rejects(
      () => __artifactScriptInternalsForTests.filesWithSuffix(notDirectory, ".jsonl"),
      (error) => error.code !== "ENOENT",
    )
    const defaultIo = __artifactScriptInternalsForTests.defaultIo()
    assert.equal(defaultIo.stdout, process.stdout)
    assert.equal(defaultIo.stderr, process.stderr)
    assert.deepEqual(__artifactScriptInternalsForTests.valuesFor({}, "missing"), [])
    assert.deepEqual(__artifactScriptInternalsForTests.valuesFor({ flag: true }, "flag"), [])
    assert.deepEqual(__artifactScriptInternalsForTests.valuesFor({ flag: "one" }, "flag"), ["one"])
    assert.deepEqual(__artifactScriptInternalsForTests.valuesFor({ flag: ["one", "two"] }, "flag"), ["one", "two"])
    assert.equal(__artifactScriptInternalsForTests.optionalString(" value "), " value ")
    assert.equal(__artifactScriptInternalsForTests.optionalString(""), undefined)
    assert.equal(__artifactScriptInternalsForTests.optionalString(true), undefined)
    assert.equal(
      __artifactScriptInternalsForTests.optionalProvenanceCommit("2".repeat(40)),
      "2".repeat(40),
    )
    assert.equal(__artifactScriptInternalsForTests.optionalProvenanceCommit(""), undefined)
    assert.throws(
      () => __artifactScriptInternalsForTests.optionalProvenanceCommit("not-a-sha"),
      /--provenance-commit/u,
    )
    assert.throws(
      () => __artifactScriptInternalsForTests.compressSnapshotBytes(Buffer.alloc(0), {}),
      /Node\.js 22\.15 or newer/u,
    )
    assert.equal(
      __artifactScriptInternalsForTests.gitCommit({
        spawn: () => ({ stdout: "not-a-sha\n" }),
        cwd: tempRoot,
      }),
      "0000000000000000000000000000000000000000",
    )
    assert.match(
      __artifactScriptInternalsForTests.documentTreeHash([
        { path: "b.md", hash: `${"b".repeat(64)}` },
        { path: "a.md", hash: `sha256:${"a".repeat(64)}` },
      ]),
      /^sha256:[a-f0-9]{64}$/u,
    )
    assert.equal(
      __artifactScriptInternalsForTests.commonRoots({ "desk-root": tempRoot }).deskRoot,
      path.resolve(tempRoot),
    )
    assert.equal(
      __artifactScriptInternalsForTests.commonRoots({ "desk-root": "~" }).deskRoot,
      path.resolve(process.env.HOME),
    )
    const oldHome = process.env.HOME
    try {
      delete process.env.HOME
      assert.equal(
        __artifactScriptInternalsForTests.commonRoots({ "desk-root": "~", "plugin-root": "~" }).deskRoot,
        path.resolve(""),
      )
    } finally {
      process.env.HOME = oldHome
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test("artifact scripts fail when configured rebuild or validation budgets are exceeded", async () => {
  const budgetConfig = path.join(makeTempDir("desk-artifact-scripts-budget-config-"), "budgets.json")
  try {
    writeBudgetConfig(budgetConfig, {
      artifacts: {
        snapshot_verify_ms: 0,
        validate_ms: 0,
      },
      rebuild: {
        snapshot_build_ms: 0,
        vector_pack_rebuild_ms: 0,
      },
    })
    await withSeededArtifactFixture(async ({ deskRoot, pluginRoot, snapshotTarget, vectorTarget }) => {
      for (const [scriptName, args] of [
        [
          vectorTarget.scriptName,
          artifactArgs({
            target: vectorTarget,
            deskRoot,
            pluginRoot,
            id: "budget-pack",
            budgetConfig,
          }),
        ],
        [
          snapshotTarget.scriptName,
          [
            ...artifactArgs({
              target: snapshotTarget,
              deskRoot,
              pluginRoot,
              id: "budget-snapshot",
              budgetConfig,
            }),
            "--included-pack-id",
            vectorTarget.id,
          ],
        ],
        [
          "artifact:snapshot:verify",
          [
            "--plugin-root",
            pluginRoot,
            "--snapshot-id",
            snapshotTarget.id,
            "--budget-config",
            budgetConfig,
          ],
        ],
        [
          "artifact:validate",
          [
            "--desk-root",
            deskRoot,
            "--plugin-root",
            pluginRoot,
            "--budget-config",
            budgetConfig,
          ],
        ],
      ]) {
        const before = artifactTree(pluginRoot)
        const result = runNpmScript(scriptName, args)
        assertScriptFailedWithCode(result, "performance_budget_exceeded")
        assertArtifactTreeUnchanged(pluginRoot, before)
      }
    })
  } finally {
    rmSync(path.dirname(budgetConfig), { recursive: true, force: true })
  }
})

test("CI invokes artifact validation and watches artifact script inputs", () => {
  const workflow = readFileSync(workflowPath, "utf8")
  const deskMcpJob = workflowJob(workflow, "desk-mcp-tests")

  assertWorkflowJobRunsMcpScript(deskMcpJob, "desk-mcp-tests", "artifact:validate")
  assertWorkflowJobRunsMcpScript(deskMcpJob, "desk-mcp-tests", "artifact:snapshot:verify")

  for (const [eventName, pathFilters] of [
    ["pull_request", workflowPathFilters(workflow, "pull_request")],
    ["push", workflowPathFilters(workflow, "push")],
  ]) {
    assertIncludesAll(pathFilters, [
      "plugins/desk/artifacts/vector-packs/**",
      "plugins/desk/artifacts/snapshots/**",
      "plugins/desk/artifacts/tombstones/**",
      "plugins/desk/artifacts/publication-policy.json",
      "plugins/desk/artifacts/publication-policy.schema.json",
      "plugins/desk/mcp/config/performance-budgets.json",
      "plugins/desk/mcp/scripts/build-vector-pack.js",
      "plugins/desk/mcp/scripts/build-snapshot.js",
      "plugins/desk/mcp/scripts/verify-snapshot.js",
      "plugins/desk/mcp/scripts/validate-artifacts.js",
    ], `${eventName} path filters`)
  }
})
