// Unit 23a: red contract for CI-level generated artifact freshness.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../../../..", import.meta.url)),
)
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")
const generatedArtifactsScript = "scripts/test-desk-generated-artifacts.cjs"
const hostManifestScript = "scripts/test-desk-host-manifests.cjs"
const require = createRequire(import.meta.url)

const requiredPackageScripts = {
  "activation:support-matrix:generate": "node scripts/generate-support-matrix.js",
  "activation:copilot-bundle:generate": "node scripts/generate-copilot-bundle.js",
  "runtime:deps-pack:build": "node scripts/build-runtime-deps-pack.js",
  "runtime:deps-pack:verify": "node scripts/verify-runtime-deps-pack.js",
  "artifact:vector-pack:build": "node scripts/build-vector-pack.js",
  "artifact:snapshot:build": "node scripts/build-snapshot.js",
  "artifact:snapshot:verify": "node scripts/verify-snapshot.js",
  "artifact:validate": "node scripts/validate-artifacts.js",
}

const requiredHostFreshnessPathFilters = [
  "plugins/desk/activation/**",
  "plugins/desk/.claude-plugin/plugin.json",
  "plugins/desk/.codex-plugin/plugin.json",
  "plugins/desk/.mcp.copilot.json",
  "plugins/desk/.mcp.json",
  "plugins/desk/agents/**",
  "plugins/desk/hooks/**",
  "plugins/desk/output-styles/**",
  "plugins/desk/plugin.json",
  "plugins/desk/principles.md",
  "plugins/desk/skills/**",
  "plugins/work-suite/.claude-plugin/plugin.json",
  "plugins/work-suite/.codex-plugin/plugin.json",
  "plugins/work-suite/plugin.json",
  "plugins/work-suite/skills/**",
]

const requiredHostManifestChecks = [
  "support-matrix",
  "copilot-bundle",
  "copilot-plugin-metadata",
  "codex-plugin",
  "claude-plugin",
  "worker-sources",
  "humanize-skill",
  "codex-fixtures",
]

const hostManifestFixtureFiles = [
  "manifest.json",
  ".github/workflows/desk-mcp-tests.yml",
  ".github/workflows/validate-skills.yml",
  "desk/tasks/2026-06-14-1335-doing-desk-dependency-activation/host-capability-evidence.md",
  "plugins/desk/.claude-plugin/plugin.json",
  "plugins/desk/.codex-plugin/plugin.json",
  "plugins/desk/.mcp.copilot.json",
  "plugins/desk/.mcp.json",
  "plugins/desk/activation/copilot-root.flattened-bundle.json",
  "plugins/desk/activation/desk.activation.json",
  "plugins/desk/activation/support-matrix.json",
  "plugins/desk/agents/worker.agent.md",
  "plugins/desk/agents/worker.md",
  "plugins/desk/agents/worker.toml",
  "plugins/desk/hooks/hooks.json",
  "plugins/desk/skills/humanize/LICENSE",
  "plugins/desk/skills/humanize/SKILL.md",
  "plugins/desk/mcp/src/activation/adapters/codex.js",
  "plugins/desk/mcp/__tests__/fixtures/activation/codex/global-personal/generated-activation-config.json",
  "plugins/desk/mcp/__tests__/fixtures/activation/codex/global-personal/generated-config.toml",
  "plugins/desk/mcp/__tests__/fixtures/activation/codex/global-personal/generated-instructions.md",
  "plugins/desk/mcp/__tests__/fixtures/activation/codex/manual-only/generated-config.toml",
  "plugins/desk/mcp/__tests__/fixtures/activation/codex/project-local/generated-activation-config.json",
  "plugins/desk/mcp/__tests__/fixtures/activation/codex/project-local/generated-config.toml",
  "plugins/desk/mcp/__tests__/fixtures/activation/codex/project-local/generated-instructions.md",
  "plugins/desk/output-styles/worker.md",
  "plugins/desk/plugin.json",
  "plugins/desk/principles.md",
  "plugins/work-suite/.claude-plugin/plugin.json",
  "plugins/work-suite/.codex-plugin/plugin.json",
  "plugins/work-suite/plugin.json",
  "plugins/plain-language/.claude-plugin/plugin.json",
  "plugins/plain-language/.codex-plugin/plugin.json",
  "plugins/plain-language/plugin.json",
  "plugins/ponytail-upstream/.claude-plugin/plugin.json",
  "plugins/ponytail-upstream/.codex-plugin/plugin.json",
  "plugins/ponytail-upstream/plugin.json",
  "scripts/validate-skills.cjs",
]

function loadJson(...segments) {
  return JSON.parse(readFileSync(path.join(repoRoot, ...segments), "utf8"))
}

function loadText(...segments) {
  return readFileSync(path.join(repoRoot, ...segments), "utf8")
}

function writeText(root, relativePath, content) {
  const filePath = path.join(root, relativePath)
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, "utf8")
}

function writeJson(root, relativePath, value) {
  writeText(root, relativePath, `${JSON.stringify(value, null, 2)}\n`)
}

function copyRepoFile(relativePath, targetRoot) {
  const targetPath = path.join(targetRoot, relativePath)
  mkdirSync(path.dirname(targetPath), { recursive: true })
  copyFileSync(path.join(repoRoot, relativePath), targetPath)
}

async function withHostFreshnessFixture(fn) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "desk-host-freshness-"))
  const fixtureRoot = path.join(tempRoot, "repo")
  try {
    for (const relativePath of hostManifestFixtureFiles) {
      copyRepoFile(relativePath, fixtureRoot)
    }
    return await fn(fixtureRoot)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function withValidateSkillsFixture({ hostStatus = 0, generatedStatus = 0 }, fn) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "desk-validate-skills-"))
  const fixtureRoot = path.join(tempRoot, "repo")
  try {
    writeJson(fixtureRoot, "manifest.json", { skills: [] })
    writeJson(fixtureRoot, ".claude-plugin/marketplace.json", { plugins: [] })
    copyRepoFile(".github/workflows/desk-mcp-tests.yml", fixtureRoot)
    copyRepoFile(".github/workflows/validate-skills.yml", fixtureRoot)
    copyRepoFile("scripts/validate-skills.cjs", fixtureRoot)
    copyRepoFile("scripts/check-apple-distribution-kit-skill.cjs", fixtureRoot)
    writeJson(fixtureRoot, "plugins/desk/mcp/package.json", {
      scripts: requiredPackageScripts,
    })
    for (const command of Object.values(requiredPackageScripts)) {
      const relativeScript = command.replace(/^node\s+/u, "plugins/desk/mcp/")
      writeText(fixtureRoot, relativeScript, "#!/usr/bin/env node\nprocess.exit(0)\n")
    }

    for (const name of [
      "autopilot",
      "deep-research",
      "inch-worm",
      "stay-in-turn",
      "visual-qa-dogfood",
      "watchdog-mode",
      "work-doer",
      "work-ideator",
      "work-merger",
      "work-planner",
    ]) {
      const body = `---\nname: ${name}\ndescription: fixture skill\n---\n# ${name}\n`
      writeText(fixtureRoot, `skills/${name}/SKILL.md`, body)
      writeText(fixtureRoot, `plugins/work-suite/skills/${name}/SKILL.md`, body)
    }
    const plainLanguage = "---\nname: plain-language\ndescription: fixture skill\n---\n# plain-language\n"
    writeText(fixtureRoot, "skills/plain-language/SKILL.md", plainLanguage)
    writeText(
      fixtureRoot,
      "plugins/plain-language/skills/plain-language/SKILL.md",
      plainLanguage,
    )
    writeText(
      fixtureRoot,
      "skills/sign-apple-apps/SKILL.md",
      `---
name: sign-apple-apps
description: fixture skill
---
# sign-apple-apps

apple-distribution-kit
distribution/apple-distribution.json
scripts/apple-distribution-kit.sh
bot.ouro.md
bot.ouro.workbench
app.spoonjoy
APP_STORE_CONNECT_API_KEY_ID
APP_STORE_CONNECT_PROVIDER_PUBLIC_ID
TestFlight Submission Lane
testflight plan
testflight publish
asc get
ExportOptions.testflight.plist
method = app-store-connect
Stop for the operator for:
not source files
non-secret CI/preflight gate
Use app-neutral names for reusable materials
For non-Ouro apps, rename these env vars
`,
    )

    for (const script of [
      "scripts/test-autopilot-state-audit.cjs",
      "scripts/test-work-suite-runtime-audit.cjs",
      "scripts/audit-work-suite-runtime.cjs",
    ]) {
      writeText(fixtureRoot, script, "#!/usr/bin/env node\nprocess.exit(0)\n")
    }
    writeText(
      fixtureRoot,
      hostManifestScript,
      `#!/usr/bin/env node\nconsole.error("host manifest fixture failure")\nprocess.exit(${hostStatus})\n`,
    )
    writeText(
      fixtureRoot,
      generatedArtifactsScript,
      `#!/usr/bin/env node\nconsole.error("generated artifact fixture failure")\nprocess.exit(${generatedStatus})\n`,
    )

    return await fn(fixtureRoot)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function stripYamlComment(line) {
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if ((char === "\"" || char === "'") && line[index - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char
    }
    if (char === "#" && !quote) return line.slice(0, index)
  }
  return line
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function workflowPathFilters(workflow, eventName) {
  const filters = []
  const stack = []
  for (const line of workflow.split(/\r?\n/u)) {
    const clean = stripYamlComment(line)
    if (!clean.trim()) continue
    const indent = clean.match(/^ */u)[0].length
    const trimmed = clean.trim()

    if (trimmed.startsWith("- ")) {
      const keys = stack.map((entry) => entry.key)
      if (keys.at(-1) === "paths" && keys.at(-2) === eventName && keys.at(-3) === "on") {
        filters.push(unquoteYamlScalar(trimmed.slice(2)))
      }
      continue
    }

    const keyMatch = trimmed.match(/^(['"]?)([A-Za-z0-9_-]+)\1:\s*(?:.*)?$/u)
    if (!keyMatch) continue
    while (stack.length && stack.at(-1).indent >= indent) stack.pop()
    stack.push({ indent, key: keyMatch[2] })
  }
  return filters
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
  let current
  for (const line of jobSection.split(/\r?\n/u)) {
    if (/^      - /u.test(line)) {
      if (current !== undefined) blocks.push(current.join("\n"))
      current = [line]
      continue
    }
    if (current !== undefined) current.push(line)
  }
  if (current !== undefined) blocks.push(current.join("\n"))
  return blocks
}

function workflowStepAllowsFailure(stepBlock) {
  const match = stepBlock.match(/^\s*continue-on-error:\s+(.+?)\s*$/mu)
  return match !== null && !/^["']?false["']?$/iu.test(match[1])
}

function workflowStepWorkingDirectory(stepBlock) {
  const match = stepBlock.match(/^\s*working-directory:\s+(.+?)\s*$/mu)
  return match?.[1]?.replace(/^["']|["']$/gu, "")
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

function workflowStepRunsRootScript(stepBlock, scriptPath) {
  if (workflowStepAllowsFailure(stepBlock)) return false
  const workingDirectory = workflowStepWorkingDirectory(stepBlock)
  if (workingDirectory !== undefined && workingDirectory !== ".") return false
  const escapedScript = scriptPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const optionalDotScript = escapedScript.replace(/^scripts\//u, "(?:\\.\\/)?scripts/")
  const commandPattern = new RegExp(`^node\\s+${optionalDotScript}(?:\\s|$)`, "u")
  return workflowStepRunText(stepBlock)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .some((line) => commandPattern.test(line))
}

function workflowRunsRootScript(workflow, jobName, scriptPath) {
  return workflowStepBlocks(workflowJob(workflow, jobName))
    .some((stepBlock) => workflowStepRunsRootScript(stepBlock, scriptPath))
}

function assertIncludesAll(actual, expected, label) {
  for (const value of expected) {
    assert.ok(actual.includes(value), `${label} must include ${value}`)
  }
}

function pathFilterCovers(actualFilter, requiredPath) {
  if (actualFilter === requiredPath) return true
  if (actualFilter.endsWith("/**")) {
    const prefix = actualFilter.slice(0, -3)
    return requiredPath === prefix || requiredPath.startsWith(`${prefix}/`)
  }
  if (actualFilter.endsWith("/*")) {
    const prefix = actualFilter.slice(0, -2)
    const remainder = requiredPath.slice(prefix.length + 1)
    return requiredPath.startsWith(`${prefix}/`) && !remainder.includes("/")
  }
  return false
}

function assertPathFiltersCoverAll(actual, expected, label) {
  for (const value of expected) {
    assert.ok(
      actual.some((filter) => pathFilterCovers(filter, value)),
      `${label} must include or cover ${value}`,
    )
  }
}

function scriptExists(scriptPath) {
  return existsSync(path.join(repoRoot, scriptPath))
}

function packageScriptTargetPath(command) {
  const match = command.match(/^node\s+scripts\/(.+\.js)$/u)
  assert.ok(match, `package script command must run a local JS script: ${command}`)
  return path.join(mcpRoot, "scripts", match[1])
}

function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "")
}

function validatorRunsScript(scriptPath) {
  const source = stripJsComments(loadText("scripts", "validate-skills.cjs"))
  const escaped = scriptPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  return new RegExp(`spawnSync\\(\\s*process\\.execPath\\s*,\\s*\\[\\s*["']${escaped}["']`, "u")
    .test(source)
}

function loadHostManifestVerifier() {
  assert.equal(
    scriptExists(hostManifestScript),
    true,
    `${hostManifestScript} must be the single CI-facing host manifest drift verifier`,
  )
  return require(path.join(repoRoot, hostManifestScript))
}

test("Desk MCP package exposes every freshness artifact script CI needs", () => {
  const packageJson = loadJson("plugins", "desk", "mcp", "package.json")

  for (const [scriptName, command] of Object.entries(requiredPackageScripts)) {
    assert.equal(packageJson.scripts?.[scriptName], command)
    assert.equal(
      existsSync(packageScriptTargetPath(command)),
      true,
      `${scriptName} target script must exist`,
    )
  }
})

test("root generated-artifact verifier exports the production freshness contract", () => {
  const generatedArtifacts = require(path.join(repoRoot, generatedArtifactsScript))

  for (const exportName of [
    "verifyGeneratedArtifacts",
    "verifyPublishedRuntimeDependencyPack",
    "verifyProductionSharedArtifacts",
    "productionRuntimePackExpectations",
    "productionSharedArtifactExpectation",
    "artifactSourceScopeHash",
    "documentTreeHash",
  ]) {
    assert.equal(typeof generatedArtifacts[exportName], "function", `${exportName} must be exported`)
  }
})

test("root generated-artifact verifier fails closed when required runtime packs are absent", async () => {
  const generatedArtifacts = require(path.join(repoRoot, generatedArtifactsScript))
  const stdout = []
  const stderr = []

  const result = await generatedArtifacts.verifyGeneratedArtifacts({
    repoRoot,
    mcpRoot,
    targets: [{ platform: "unit", arch: "fixture", nodeAbi: "999" }],
    io: {
      stdout: { write: (text) => stdout.push(text) },
      stderr: { write: (text) => stderr.push(text) },
    },
  })

  assert.equal(result.ok, false)
  assert.match(result.errors.join("\n"), /generated artifact missing/u)
  assert.match(stderr.join(""), /unit-fixture-node-999/u)
  assert.equal(stdout.join(""), "")
})

test("root generated-artifact verifier propagates missing production vector and snapshot artifacts", async () => {
  const generatedArtifacts = require(path.join(repoRoot, generatedArtifactsScript))
  const tempRoot = mkdtempSync(path.join(tmpdir(), "desk-generated-artifacts-"))
  try {
    const stdout = []
    const stderr = []
    const result = await generatedArtifacts.verifyGeneratedArtifacts({
      repoRoot,
      mcpRoot,
      pluginRoot: path.join(tempRoot, "plugins", "desk"),
      targets: [],
      io: {
        stdout: { write: (text) => stdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
      },
      spawn: () => ({ status: 1, stdout: "", stderr: "" }),
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join("\n"), /production vector pack artifact missing/u)
    assert.match(result.errors.join("\n"), /production snapshot artifact missing/u)
    assert.match(stderr.join(""), /vector-packs/u)
    assert.equal(stdout.join(""), "")
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test("root generated-artifact verifier rejects present but stale runtime dependency packs", async () => {
  const generatedArtifacts = require(path.join(repoRoot, generatedArtifactsScript))
  const tempRoot = mkdtempSync(path.join(tmpdir(), "desk-runtime-pack-stale-"))
  try {
    const tempRepoRoot = path.join(tempRoot, "repo")
    const tempMcpRoot = path.join(tempRepoRoot, "plugins", "desk", "mcp")
    writeJson(tempMcpRoot, "package.json", {
      name: "@ourostack/desk-mcp",
      version: "1.7.3",
    })
    writeJson(tempMcpRoot, "package-lock.json", {
      lockfileVersion: 3,
      packages: {},
    })
    const packDir = path.join(
      tempRepoRoot,
      "plugins",
      "desk",
      "artifacts",
      "runtime-deps",
      "unit-fixture-node-999",
    )
    const fakeRuntimeDeps = {
      productionDependencyLockHash: () => `sha256:${"1".repeat(64)}`,
      deriveRuntimeDependencyPackPaths: () => ({
        packDir,
        archivePath: path.join(packDir, "runtime-deps.tgz"),
        manifestPath: path.join(packDir, "runtime-deps.manifest.json"),
        checksumPath: path.join(packDir, "runtime-deps.sha256"),
      }),
      validateRuntimeDependencyPackManifest: () => [
        "runtime dependency pack manifest package_lock.prod_dependency_lock_hash must match production dependency closure",
      ],
    }
    const expectation = await generatedArtifacts.productionRuntimePackExpectation({
      repoRoot: tempRepoRoot,
      mcpRoot: tempMcpRoot,
      platform: "unit",
      arch: "fixture",
      nodeAbi: "999",
      runtimeDeps: fakeRuntimeDeps,
    })
    writeJson(packDir, "runtime-deps.manifest.json", {
      archive: { sha256: "f".repeat(64) },
      package_lock: { sha256: "e".repeat(64) },
      production_dependencies: [],
    })
    writeText(packDir, "runtime-deps.tgz", "stale archive bytes")
    writeText(packDir, "runtime-deps.sha256", `${"0".repeat(64)}  runtime-deps.tgz\n`)

    const result = generatedArtifacts.verifyPublishedRuntimeDependencyPack({
      expectation,
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })

    assert.equal(result.ok, false)
    assert.doesNotMatch(result.errors.join("\n"), /generated artifact missing/u)
    assert.match(result.errors.join("\n"), /prod_dependency_lock_hash must match production dependency closure/u)
    assert.match(result.errors.join("\n"), /runtime dependency pack checksum mismatch/u)
    assert.match(result.errors.join("\n"), /manifest archive\.sha256 must match runtime-deps\.tgz/u)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test("root generated-artifact verifier CLI fails closed on setup exceptions", async () => {
  const generatedArtifacts = require(path.join(repoRoot, generatedArtifactsScript))
  const tempRoot = mkdtempSync(path.join(tmpdir(), "desk-generated-cli-exception-"))
  try {
    const stdout = []
    const stderr = []
    const exitCode = await generatedArtifacts.runCli({
      repoRoot: tempRoot,
      mcpRoot: path.join(tempRoot, "plugins", "desk", "mcp"),
      io: {
        stdout: { write: (text) => stdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
      },
    })

    assert.equal(exitCode, 1)
    assert.equal(stdout.join(""), "")
    assert.match(stderr.join(""), /Cannot find module|ENOENT|no such file or directory/u)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test("root generated-artifact verifier covers defensive helper and CLI branches", async () => {
  const generatedArtifacts = require(path.join(repoRoot, generatedArtifactsScript))
  const internals = generatedArtifacts.__generatedArtifactVerifierInternalsForTests
  const tempRoot = mkdtempSync(path.join(tmpdir(), "desk-generated-internals-"))
  try {
    const fixtureJson = path.join(tempRoot, "fixture.json")
    writeFileSync(fixtureJson, "{}", "utf8")

    assert.equal(generatedArtifacts.startCli({ isMain: false }), null)
    assert.equal(generatedArtifacts.startCli(), null)
    const exitCodes = []
    assert.equal(
      await generatedArtifacts.startCli({
        isMain: true,
        run: async () => 7,
        setExitCode: (code) => exitCodes.push(code),
      }),
      1,
    )
    assert.deepEqual(exitCodes, [7])
    const defaultRunExitCodes = []
    assert.equal(
      await generatedArtifacts.startCli({
        isMain: true,
        verifyGeneratedArtifactsFn: async () => ({ ok: true }),
        setExitCode: (code) => defaultRunExitCodes.push(code),
        io: { stdout: { write: () => {} }, stderr: { write: () => {} } },
      }),
      1,
    )
    assert.deepEqual(defaultRunExitCodes, [0])
    const previousExitCode = process.exitCode
    try {
      await generatedArtifacts.startCli({ isMain: true, run: async () => 0 })
      assert.equal(process.exitCode, 0)
    } finally {
      process.exitCode = previousExitCode
    }

    assert.equal(
      await generatedArtifacts.runCli({
        verifyGeneratedArtifactsFn: async () => ({ ok: true }),
        io: { stdout: { write: () => {} }, stderr: { write: () => {} } },
      }),
      0,
    )
    assert.equal(
      await generatedArtifacts.runCli({
        verifyGeneratedArtifactsFn: async () => ({ ok: false }),
        io: { stdout: { write: () => {} }, stderr: { write: () => {} } },
      }),
      1,
    )
    const plainErrorStderr = []
    assert.equal(
      await generatedArtifacts.runCli({
        verifyGeneratedArtifactsFn: async () => {
          throw "plain verifier failure"
        },
        io: { stderr: { write: (text) => plainErrorStderr.push(text) } },
      }),
      1,
    )
    assert.equal(plainErrorStderr.join(""), "plain verifier failure\n")
    assert.equal(
      await generatedArtifacts.runCli({
        verifyGeneratedArtifactsFn: async () => {
          throw new Error("default io verifier failure")
        },
      }),
      1,
    )

    const defaultExpectation = await generatedArtifacts.productionRuntimePackExpectation()
    assert.equal(defaultExpectation.target, "darwin-arm64-node-127")
    const defaultShared = await generatedArtifacts.productionSharedArtifactExpectation()
    assert.ok(defaultShared.relativeVectorPackDir.startsWith("plugins/desk/artifacts/vector-packs/"))
    const processIoVerify = await generatedArtifacts.verifyGeneratedArtifacts()
    assert.equal(processIoVerify.ok, true, processIoVerify.errors.join("\n"))
    const defaultVerifyStdout = []
    const defaultVerify = await generatedArtifacts.verifyGeneratedArtifacts({
      io: {
        stdout: { write: (text) => defaultVerifyStdout.push(text) },
        stderr: { write: () => {} },
      },
    })
    assert.equal(defaultVerify.ok, true, defaultVerify.errors.join("\n"))
    assert.match(defaultVerifyStdout.join(""), /Desk generated artifacts verified/u)

    assert.equal(internals.gitTracksFile({
      repoRoot,
      repoPath: "missing",
      spawn: () => ({}),
    }), false)
    assert.equal(generatedArtifacts.artifactSourceScopeHash(tempRoot).startsWith("sha256:"), true)
    assert.equal(
      generatedArtifacts.documentTreeHash([
        { path: "b.md", hash: "sha256:b" },
        { path: "a.md", hash: "a" },
      ]).startsWith("sha256:"),
      true,
    )
    assert.equal(internals.canonicalSha("abc"), "sha256:abc")
    assert.equal(internals.formatErrorMessage(new Error("error object")), "error object")
    assert.equal(internals.formatErrorMessage("plain string"), "plain string")

    const previousParse = JSON.parse
    try {
      JSON.parse = () => {
        throw "plain parse failure"
      }
      const readJsonErrors = []
      assert.equal(internals.readJsonIfPresent(fixtureJson, readJsonErrors, "fixture json"), undefined)
      assert.match(readJsonErrors.join("\n"), /plain parse failure/u)
      const archiveErrors = []
      assert.equal(internals.parseArchiveJson(Buffer.from("{}", "utf8"), "archive json", archiveErrors), undefined)
      assert.match(archiveErrors.join("\n"), /plain parse failure/u)
    } finally {
      JSON.parse = previousParse
    }

    const missingArchiveJsonErrors = []
    assert.equal(internals.parseArchiveJson(undefined, "missing.json", missingArchiveJsonErrors), undefined)
    assert.match(missingArchiveJsonErrors.join("\n"), /must include root missing\.json/u)
    assert.equal(internals.packageRootFromArchiveEntry("not-node-modules/file.js"), undefined)
    assert.equal(internals.packageRootFromArchiveEntry("node_modules/"), undefined)
    assert.equal(internals.packageRootFromArchiveEntry("node_modules/@scope"), undefined)
    assert.match(
      internals.validatePublishedArchiveShape({
        entries: ["package.json", "package-lock.json", "runtime-deps.manifest.json", "node_modules/@scope"],
        productionDependencies: [],
      }).join("\n"),
      /non-production dependency/u,
    )

    const freshnessErrors = []
    internals.propagateValidationFreshness({
      artifacts: undefined,
      errors: freshnessErrors,
      idField: "pack_id",
      label: "production vector pack",
    })
    internals.propagateValidationFreshness({
      artifacts: [{ freshness: { artifact_source_scope: "stale", document_tree: "stale" } }],
      errors: freshnessErrors,
      idField: "pack_id",
      label: "production vector pack",
    })
    assert.match(freshnessErrors.join("\n"), /production vector pack <unknown> artifact_source_scope_hash is stale/u)

    assert.throws(
      () => internals.primaryArtifactFiles({ dir: fixtureJson, suffix: ".jsonl" }),
      /ENOTDIR|not a directory/u,
    )
    const checksumErrors = []
    internals.verifyProductionArtifactChecksum({
      errors: checksumErrors,
      label: "missing artifact",
      primaryPath: path.join(tempRoot, "missing.jsonl"),
      checksumPath: path.join(tempRoot, "missing.sha256"),
      existsSync: () => false,
      repoRoot,
      primaryRepoPath: "missing.jsonl",
      checksumRepoPath: "missing.sha256",
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })
    assert.deepEqual(checksumErrors, [])
    assert.equal(internals.readTrackedFileBytes({
      repoRoot,
      repoPath: "missing",
      spawn: () => ({ stdout: Buffer.from("tracked bytes"), stderr: "" }),
    }), undefined)
    assert.equal(internals.readTrackedFileBytes({
      repoRoot,
      repoPath: "missing",
      spawn: () => ({ status: 0, stdout: Buffer.alloc(0), stderr: "" }),
    }), undefined)
    assert.deepEqual(
      internals.readTrackedFileBytes({
        repoRoot,
        repoPath: "string",
        spawn: () => ({ status: 0, stdout: "string bytes", stderr: "" }),
      }),
      Buffer.from("string bytes", "utf8"),
    )
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test("root host-manifest verifier exists and validates current host-facing generated files", async () => {
  const hostManifests = loadHostManifestVerifier()
  assert.equal(typeof hostManifests.verifyDeskHostManifests, "function")
  assert.equal(typeof hostManifests.runCli, "function")

  const stderr = []
  const stdout = []
  const result = await hostManifests.verifyDeskHostManifests({
    repoRoot,
    mcpRoot,
    io: {
      stderr: { write: (text) => stderr.push(text) },
      stdout: { write: (text) => stdout.push(text) },
    },
  })

  assert.equal(result.ok, true, result.errors?.join("\n") ?? stderr.join(""))
  assertIncludesAll(result.checked ?? [], requiredHostManifestChecks, "host manifest checks")
})

test("root host-manifest verifier catches stale generated host-facing files", async () => {
  const hostManifests = loadHostManifestVerifier()

  await withHostFreshnessFixture(async (freshRoot) => {
    const result = await hostManifests.verifyDeskHostManifests({
      repoRoot: freshRoot,
      mcpRoot,
      io: {
        stderr: { write: () => {} },
        stdout: { write: () => {} },
      },
    })
    assert.equal(result.ok, true, result.errors?.join("\n") ?? "")
    assertIncludesAll(result.checked ?? [], requiredHostManifestChecks, "fresh fixture host manifest checks")
  })

  const staleCases = [
    {
      label: "support-matrix",
      errorPattern: /support[- ]matrix/u,
      mutate: (fixtureRoot) => {
        const matrix = loadJson("plugins", "desk", "activation", "support-matrix.json")
        matrix.hosts = matrix.hosts.filter((row) => row.host_id !== "codex")
        writeJson(fixtureRoot, "plugins/desk/activation/support-matrix.json", matrix)
      },
    },
    {
      label: "copilot-bundle",
      errorPattern: /copilot[- ]bundle/u,
      mutate: (fixtureRoot) => {
        const bundle = loadJson("plugins", "desk", "activation", "copilot-root.flattened-bundle.json")
        bundle.dependency_closure = bundle.dependency_closure.filter((entry) => entry.id !== "work-suite")
        writeJson(fixtureRoot, "plugins/desk/activation/copilot-root.flattened-bundle.json", bundle)
      },
    },
    {
      label: "copilot-plugin-metadata",
      errorPattern: /copilot[- ]plugin[- ]metadata|Copilot desk:worker target|Copilot Work Suite dependency/u,
      mutate: (fixtureRoot) => {
        const plugin = loadJson("plugins", "desk", "plugin.json")
        plugin.activation.copilot.targets["desk:worker"].source = "agents/worker.md"
        plugin.activation.copilot.dependencies["work-suite"].bundleMetadata =
          "plugins/desk/activation/stale-bundle.json"
        writeJson(fixtureRoot, "plugins/desk/plugin.json", plugin)
      },
    },
    {
      label: "claude-plugin",
      errorPattern: /claude[- ]plugin/u,
      mutate: (fixtureRoot) => {
        const claude = loadJson("plugins", "desk", ".claude-plugin", "plugin.json")
        claude.agents = []
        writeJson(fixtureRoot, "plugins/desk/.claude-plugin/plugin.json", claude)
      },
    },
    {
      label: "codex-plugin",
      errorPattern: /codex[- ]plugin/u,
      mutate: (fixtureRoot) => {
        const codex = loadJson("plugins", "desk", ".codex-plugin", "plugin.json")
        codex.activation.codex.targets["desk:worker"].source = "agents/worker.md"
        writeJson(fixtureRoot, "plugins/desk/.codex-plugin/plugin.json", codex)
      },
    },
    {
      label: "worker-sources",
      errorPattern: /worker[- ]sources/u,
      mutate: (fixtureRoot) => {
        writeText(
          fixtureRoot,
          "plugins/desk/agents/worker.toml",
          loadText("plugins", "desk", "agents", "worker.toml")
            .replace('name = "worker"', 'name = "worker-stale"'),
        )
      },
    },
    {
      label: "humanize-skill",
      errorPattern: /humanize[- ]skill/u,
      mutate: (fixtureRoot) => {
        const manifest = loadJson("manifest.json")
        manifest.skills.push({ name: "humanize" })
        writeJson(fixtureRoot, "manifest.json", manifest)
      },
    },
    {
      label: "codex-fixtures",
      errorPattern: /codex[- ]fixtures/u,
      mutate: (fixtureRoot) => {
        writeText(
          fixtureRoot,
          "plugins/desk/mcp/__tests__/fixtures/activation/codex/global-personal/generated-config.toml",
          loadText(
            "plugins",
            "desk",
            "mcp",
            "__tests__",
            "fixtures",
            "activation",
            "codex",
            "global-personal",
            "generated-config.toml",
          ).replace("[plugins.\"desk@ourostack\"]", "[plugins.\"desk-stale@ourostack\"]"),
        )
      },
    },
  ]

  for (const staleCase of staleCases) {
    await withHostFreshnessFixture(async (caseRoot) => {
      staleCase.mutate(caseRoot)
      const result = await hostManifests.verifyDeskHostManifests({
        repoRoot: caseRoot,
        mcpRoot,
        io: {
          stderr: { write: () => {} },
          stdout: { write: () => {} },
        },
      })
      assert.equal(result.ok, false, `${staleCase.label} drift must fail verification`)
      assert.match(result.errors.join("\n"), staleCase.errorPattern)
    })
  }
})

test("root host-manifest verifier catches cross-host plugin version drift", async () => {
  const hostManifests = loadHostManifestVerifier()
  const staleVersionCases = [
    {
      label: "codex-desk-version",
      errorPattern: /codex-plugin Desk version drift/u,
      mutate: (fixtureRoot) => {
        const plugin = loadJson("plugins", "desk", ".codex-plugin", "plugin.json")
        plugin.version = "0.0.0"
        writeJson(fixtureRoot, "plugins/desk/.codex-plugin/plugin.json", plugin)
      },
    },
    {
      label: "claude-desk-version",
      errorPattern: /claude-plugin Desk version drift/u,
      mutate: (fixtureRoot) => {
        const plugin = loadJson("plugins", "desk", ".claude-plugin", "plugin.json")
        plugin.version = "0.0.0"
        writeJson(fixtureRoot, "plugins/desk/.claude-plugin/plugin.json", plugin)
      },
    },
    {
      label: "copilot-desk-version",
      errorPattern: /Copilot root Desk version must match activation version/u,
      mutate: (fixtureRoot) => {
        const plugin = loadJson("plugins", "desk", "plugin.json")
        plugin.version = "0.0.0"
        writeJson(fixtureRoot, "plugins/desk/plugin.json", plugin)
      },
    },
    {
      label: "codex-work-suite-lock",
      errorPattern: /codex-plugin Work Suite (dependency version|provider lock) drift/u,
      mutate: (fixtureRoot) => {
        const plugin = loadJson("plugins", "work-suite", ".codex-plugin", "plugin.json")
        plugin.version = "0.0.0"
        writeJson(fixtureRoot, "plugins/work-suite/.codex-plugin/plugin.json", plugin)
      },
    },
    {
      label: "claude-work-suite-lock",
      errorPattern: /claude-plugin Work Suite provider lock drift/u,
      mutate: (fixtureRoot) => {
        const plugin = loadJson("plugins", "work-suite", ".claude-plugin", "plugin.json")
        plugin.version = "0.0.0"
        writeJson(fixtureRoot, "plugins/work-suite/.claude-plugin/plugin.json", plugin)
      },
    },
    {
      label: "copilot-work-suite-lock",
      errorPattern: /Copilot root Work Suite version must match activation lock/u,
      mutate: (fixtureRoot) => {
        const plugin = loadJson("plugins", "work-suite", "plugin.json")
        plugin.version = "0.0.0"
        writeJson(fixtureRoot, "plugins/work-suite/plugin.json", plugin)
      },
    },
  ]

  for (const staleCase of staleVersionCases) {
    await withHostFreshnessFixture(async (caseRoot) => {
      staleCase.mutate(caseRoot)
      const result = await hostManifests.verifyDeskHostManifests({
        repoRoot: caseRoot,
        mcpRoot,
        io: {
          stderr: { write: () => {} },
          stdout: { write: () => {} },
        },
      })

      assert.equal(result.ok, false, `${staleCase.label} drift must fail verification`)
      assert.match(result.errors.join("\n"), staleCase.errorPattern)
    })
  }
})

test("root host-manifest verifier catches worker body drift across host formats", async () => {
  const hostManifests = loadHostManifestVerifier()
  const workerCases = [
    {
      label: "claude-worker-body",
      workerPath: "plugins/desk/agents/worker.md",
      errorPattern: /worker-sources claude body drift/u,
    },
    {
      label: "codex-worker-body",
      workerPath: "plugins/desk/agents/worker.toml",
      errorPattern: /worker-sources codex body drift/u,
    },
    {
      label: "copilot-worker-body",
      workerPath: "plugins/desk/agents/worker.agent.md",
      errorPattern: /worker-sources copilot body drift/u,
    },
  ]

  for (const staleCase of workerCases) {
    await withHostFreshnessFixture(async (caseRoot) => {
      writeText(
        caseRoot,
        staleCase.workerPath,
        loadText(...staleCase.workerPath.split("/")).replaceAll("$DESK", "$STALE_DESK"),
      )
      const result = await hostManifests.verifyDeskHostManifests({
        repoRoot: caseRoot,
        mcpRoot,
        io: {
          stderr: { write: () => {} },
          stdout: { write: () => {} },
        },
      })

      assert.equal(result.ok, false, `${staleCase.label} drift must fail verification`)
      assert.match(result.errors.join("\n"), staleCase.errorPattern)
    })
  }
})

test("validate-skills exits nonzero when desk freshness child verifiers fail", async () => {
  await withValidateSkillsFixture({ hostStatus: 1, generatedStatus: 0 }, (fixtureRoot) => {
    const result = spawnSync(process.execPath, ["scripts/validate-skills.cjs"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    })

    assert.notEqual(result.status, 0, "host manifest verifier failure must fail validate-skills.cjs")
    assert.match(`${result.stdout}\n${result.stderr}`, /host manifest|test-desk-host-manifests/u)
  })

  await withValidateSkillsFixture({ hostStatus: 0, generatedStatus: 1 }, (fixtureRoot) => {
    const result = spawnSync(process.execPath, ["scripts/validate-skills.cjs"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    })

    assert.notEqual(result.status, 0, "generated artifact verifier failure must fail validate-skills.cjs")
    assert.match(`${result.stdout}\n${result.stderr}`, /generated artifact|test-desk-generated-artifacts/u)
  })
})

test("root validation delegates host manifest freshness and artifact availability checks", () => {
  assert.equal(
    validatorRunsScript(hostManifestScript),
    true,
    "validate-skills.cjs must execute the host manifest verifier and fail the repo when it fails",
  )
  assert.equal(
    validatorRunsScript(generatedArtifactsScript),
    true,
    "validate-skills.cjs must execute the committed generated-artifact verifier and fail the repo when it fails",
  )

  const source = loadText("scripts", "validate-skills.cjs")
  for (const scriptName of Object.keys(requiredPackageScripts)) {
    assert.match(
      source,
      new RegExp(scriptName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
      `validate-skills.cjs must verify package script ${scriptName}`,
    )
  }
})

test("desk MCP CI runs committed artifact and host manifest verifiers", () => {
  const workflow = loadText(".github", "workflows", "desk-mcp-tests.yml")

  assert.equal(
    workflowRunsRootScript(workflow, "desk-mcp-tests", generatedArtifactsScript),
    true,
    "desk MCP CI must run the committed generated artifact verifier",
  )
  assert.equal(
    workflowRunsRootScript(workflow, "desk-mcp-tests", hostManifestScript),
    true,
    "desk MCP CI must run the host manifest drift verifier",
  )
})

test("desk MCP CI path filters include every host-facing freshness input", () => {
  const workflow = loadText(".github", "workflows", "desk-mcp-tests.yml")

  for (const eventName of ["pull_request", "push"]) {
    const filters = workflowPathFilters(workflow, eventName)
    assertPathFiltersCoverAll(
      filters,
      requiredHostFreshnessPathFilters,
      `desk MCP CI ${eventName}.paths`,
    )
    assert.ok(
      filters.includes("scripts/*.cjs") || filters.includes(hostManifestScript),
      `desk MCP CI ${eventName}.paths must include root host verifier script changes`,
    )
  }
})

test("validate-skills workflow reaches host manifest freshness through workflow or validator", () => {
  const workflow = loadText(".github", "workflows", "validate-skills.yml")
  const workflowDirectlyRunsHostVerifier = workflowRunsRootScript(
    workflow,
    "validate",
    hostManifestScript,
  )

  assert.ok(
    workflowDirectlyRunsHostVerifier || validatorRunsScript(hostManifestScript),
    "validate-skills.yml must fail on host manifest drift directly or through validate-skills.cjs",
  )
})

test("validate-skills workflow installs Desk MCP dependencies before root freshness validation", () => {
  const workflow = loadText(".github", "workflows", "validate-skills.yml")
  const steps = workflowStepBlocks(workflowJob(workflow, "validate"))
  const validateIndex = steps.findIndex((stepBlock) => (
    workflowStepRunsRootScript(stepBlock, "scripts/validate-skills.cjs")
  ))
  const installIndex = steps.findIndex((stepBlock) => (
    workflowStepWorkingDirectory(stepBlock) === "plugins/desk/mcp" &&
      workflowStepRunText(stepBlock)
        .split(/\r?\n/u)
        .some((line) => line.trim() === "npm ci")
  ))

  assert.notEqual(validateIndex, -1, "validate-skills.yml must run node scripts/validate-skills.cjs")
  assert.notEqual(installIndex, -1, "validate-skills.yml must install Desk MCP dependencies")
  assert.ok(
    installIndex < validateIndex,
    "validate-skills.yml must run npm ci before validate-skills.cjs imports MCP freshness verifiers",
  )
  assert.match(
    workflow,
    /cache-dependency-path:\s+plugins\/desk\/mcp\/package-lock\.json/u,
    "validate-skills.yml should cache the Desk MCP package-lock install",
  )
})
