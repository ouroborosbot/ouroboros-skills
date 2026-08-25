import { test } from "node:test"
import { strict as assert } from "node:assert"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../../../..", import.meta.url)),
)
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")
const evidencePath = path.join(
  repoRoot,
  "desk",
  "tasks",
  "2026-06-14-1335-doing-desk-dependency-activation",
  "codex-smoke-evidence.md",
)
const installedProfileSmokePath = path.join(
  repoRoot,
  "desk",
  "tasks",
  "2026-06-14-1335-doing-desk-dependency-activation",
  "codex-installed-profile-smoke.json",
)
const supportMatrixPath = path.join(repoRoot, "plugins", "desk", "activation", "support-matrix.json")
const codexDesktopUnsupportedPrimitive = "codex-desktop-scriptable-activation-smoke"

async function loadCodexSmokeHarness() {
  return import(pathToFileURL(path.join(mcpRoot, "src", "activation", "codex-smoke.js")))
}

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"))
}

function makeTempHost() {
  return mkdtempSync(path.join(tmpdir(), "desk-codex-smoke-"))
}

function writeHostFile(root, relativePath, content) {
  const filePath = path.join(root, relativePath)
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, "utf8")
}

function smokeStdout({
  instructionSources = ["CODEX_HOME/AGENTS.md"],
  instructions = "You are the desk worker by default.\nRun the `desk:session-start` skill before other work.",
  tools = ["desk_status"],
  deskStatus,
}) {
  return `${JSON.stringify({
    type: "final_message",
    message: JSON.stringify({
      instruction_sources: instructionSources,
      combined_instructions: instructions,
      tools,
      desk_status: deskStatus,
    }),
  })}\n`
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
  const manifest = loadJson(path.join(repoRoot, "plugins", "desk", "activation", "desk.activation.json"))
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

function assertUnderRoot(root, actualPath, label) {
  const relative = path.relative(root, actualPath)
  assert.equal(
    relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)),
    true,
    `${label} must stay under temp host root: ${actualPath}`,
  )
}

function assertNoHealthyPathManualSetup(trace) {
  assert.doesNotMatch(trace, /\bcodex\s+mcp\s+add\b/iu)
  assert.doesNotMatch(trace, /(?:^|[\\/])\.codex[\\/]agents(?:[\\/]|$)/iu)
  assert.doesNotMatch(trace, /\bcopy(?:ing|ied)?\s+(?:the\s+)?(?:worker|agent)\s+file\b/iu)
  assert.doesNotMatch(trace, /\buncontrolled\s+AGENTS(?:\.md)?\s+(?:append|copy|edit)\b/iu)
}

function codexMatrixRow() {
  const matrix = loadJson(supportMatrixPath)
  const row = matrix.hosts.find((host) => host.host_id === "codex")
  assert.ok(row, "support matrix must include codex")
  return row
}

function evidenceSection(content, heading) {
  const pattern = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |\\n?$)`, "u")
  const match = content.match(pattern)
  assert.ok(match, `missing evidence section: ${heading}`)
  return match[1]
}

function completeDesktopRealSmoke(section) {
  return [
    /^Status: PASS$/m,
    /^Primitive: codex-desktop-scriptable-activation-smoke$/m,
    /^Command: codex (?:app|app-server|debug app-server send-message-v2)\b/m,
    /^Artifact: .+/m,
    /^Temp CODEX_HOME: PASS$/m,
    /^Temp HOME: PASS$/m,
    /^No real Codex config touched: PASS$/m,
    /^Worker instructions: PASS$/m,
    /^desk_status: PASS$/m,
    /You are the desk worker by default\./u,
    /desk:session-start/u,
  ].every((pattern) => pattern.test(section))
}

function completeDesktopFallback(section, codex) {
  return (
    /^Status: UNSUPPORTED$/m.test(section) &&
    /^Unsupported primitive: codex-desktop-scriptable-activation-smoke$/m.test(section) &&
    /^Fallback: .+/m.test(section) &&
    /Codex Desktop lacks a stable scriptable activation-smoke primitive/iu.test(codex.fallback_behavior) &&
    codex.unsupported_primitives.includes(codexDesktopUnsupportedPrimitive) &&
    codex.evidence_command_or_doc.includes("codex-smoke-evidence.md")
  )
}

test("Codex CLI activation smoke uses a temp profile and proves worker instructions plus desk_status", async () => {
  const { runCodexCliActivationSmoke } = await loadCodexSmokeHarness()
  const hostRoot = makeTempHost()
  try {
    const workspaceRoot = path.join(hostRoot, "workspace")
    mkdirSync(workspaceRoot, { recursive: true })
    const runnerCalls = []

    const result = await runCodexCliActivationSmoke({
      repoRoot,
      hostRoot,
      workspaceRoot,
      mode: "global-personal",
      codexRunner: async (request) => {
        runnerCalls.push(request)
        const configPath = path.join(request.env.CODEX_HOME, "config.toml")
        const activationConfigPath = path.join(request.env.CODEX_HOME, "desk.activation.json")
        const instructionsPath = path.join(request.env.CODEX_HOME, "AGENTS.md")

        assert.equal(request.command, "codex")
        assert.ok(request.args.includes("exec"), "smoke must launch a new noninteractive session")
        assert.ok(request.args.includes("--json"), "smoke must preserve machine-readable evidence")
        assert.ok(request.args.includes("--ephemeral"), "smoke must avoid persistent session side effects")
        assert.ok(request.args.includes("--cd"), "smoke must pin the workspace")
        assert.ok(request.args.includes(workspaceRoot), "smoke must run from the temp workspace")
        assert.equal(request.env.DESK, path.join(hostRoot, "desk"))
        assertUnderRoot(hostRoot, request.env.HOME, "HOME")
        assertUnderRoot(hostRoot, request.env.CODEX_HOME, "CODEX_HOME")
        assert.notEqual(request.env.HOME, process.env.HOME)
        assert.notEqual(request.env.CODEX_HOME, process.env.CODEX_HOME)
        assert.match(request.prompt, /current instructions/iu)
        assert.match(request.prompt, /desk_status/u)
        assertNoHealthyPathManualSetup(JSON.stringify(request))
        assert.equal(existsSync(configPath), true, "smoke must materialize temp Codex config before launch")
        assert.equal(
          existsSync(activationConfigPath),
          true,
          "smoke must materialize temp Desk activation config before launch",
        )
        assert.equal(
          existsSync(instructionsPath),
          true,
          "smoke must materialize temp Codex instructions before launch",
        )

        const generatedConfig = readFileSync(configPath, "utf8")
        const generatedActivationConfig = readFileSync(activationConfigPath, "utf8")
        const generatedInstructions = readFileSync(instructionsPath, "utf8")
        assert.match(generatedConfig, /# BEGIN desk activation: desk@2\.1\.0 mode=global-personal owner=desk-activation/u)
        assert.match(generatedConfig, /\[plugins\."desk@ourostack"\]/u)
        assert.match(generatedConfig, /\[plugins\."desk@ourostack"\.mcp_servers\.desk\]/u)
        assert.match(generatedConfig, /\[mcp_servers\.desk\]/u)
        assert.match(generatedConfig, /--activation-config/u)
        assert.match(generatedConfig, /enabled = true/u)
        assert.match(generatedInstructions, /# BEGIN desk activation: desk@2\.1\.0 mode=global-personal owner=desk-activation/u)
        assert.match(generatedInstructions, /You are the desk worker by default\./u)
        assert.match(generatedInstructions, /desk:session-start/u)
        const activationConfig = JSON.parse(generatedActivationConfig)
        assert.equal(activationConfig.desk.root, path.join(hostRoot, "desk"))
        assert.equal(activationConfig.activation.selected_id, "desk:worker")
        assertNoHealthyPathManualSetup(`${generatedConfig}\n${generatedInstructions}`)

        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            type: "final_message",
            message: JSON.stringify({
              instruction_sources: ["CODEX_HOME/AGENTS.md"],
              combined_instructions: [
                "You are the desk worker by default.",
                "Run the `desk:session-start` skill before other work.",
              ].join("\n"),
              tools: ["desk_status"],
              desk_status: {
                status: "ok",
                root: {
                  path: path.join(hostRoot, "desk"),
                  source: "activation-config",
                },
                runtime: {
                  loaded_from_source_mirror: true,
                },
              },
            }),
          })}\n`,
          stderr: "",
        }
      },
    })

    assert.equal(runnerCalls.length, 1)
    assert.equal(result.status, "pass")
    assert.deepEqual(result.instruction_sources, ["CODEX_HOME/AGENTS.md"])
    assert.match(result.combined_instructions, /desk worker by default/u)
    assert.match(result.combined_instructions, /desk:session-start/u)
    assert.deepEqual(result.tools, ["desk_status"])
    assert.equal(result.desk_status.status, "ok")
    assert.equal(result.desk_status.root.path, path.join(hostRoot, "desk"))
    assert.equal(result.desk_status.root.source, "activation-config")
    assert.equal(result.desk_status.runtime.loaded_from_source_mirror, true)
    assert.deepEqual(result.activation, {
      config_path: path.join(hostRoot, ".codex", "config.toml"),
      activation_config_path: path.join(hostRoot, ".codex", "desk.activation.json"),
      instructions_path: path.join(hostRoot, ".codex", "AGENTS.md"),
      mode: "global-personal",
    })
    assert.deepEqual(result.manual_setup, {
      codex_mcp_add: false,
      copied_agent_file: false,
      uncontrolled_agents_edit: false,
    })
    assert.equal(result.real_profile_touched, false)
    assertNoHealthyPathManualSetup(JSON.stringify(result))
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
  }
})

test("Codex CLI activation smoke proves selected overlay activation in desk_status", async () => {
  const { runCodexCliActivationSmoke } = await loadCodexSmokeHarness()
  const hostRoot = makeTempHost()
  try {
    const workspaceRoot = path.join(hostRoot, "workspace")
    const result = await runCodexCliActivationSmoke({
      repoRoot,
      hostRoot,
      workspaceRoot,
      mode: "global-personal",
      manifest: overlayChainManifest(),
      selectedActivationId: "ms-area:worker",
      codexRunner: async (request) => {
        const generatedInstructions = readFileSync(path.join(request.env.CODEX_HOME, "AGENTS.md"), "utf8")
        assert.match(generatedInstructions, /You are the Area Desk worker by default\./u)
        assert.match(generatedInstructions, /Active Desk activation: `desk:worker` -> `ms-desk:worker` -> `ms-area:worker`\./u)
        assert.match(generatedInstructions, /Microsoft Desk worker: Use Microsoft employee context/u)
        assert.match(generatedInstructions, /Area Desk worker: Use area-specific context/u)
        assertNoHealthyPathManualSetup(generatedInstructions)

        return {
          exitCode: 0,
          stdout: smokeStdout({
            instructions: generatedInstructions,
            deskStatus: {
              status: "ok",
              root: {
                path: path.join(hostRoot, "desk"),
                source: "activation-config",
              },
              activation: {
                selected_id: "ms-area:worker",
                chain: ["desk:worker", "ms-desk:worker", "ms-area:worker"],
                mode: "global-personal",
                source: "activation-config",
              },
              runtime: {
                loaded_from_source_mirror: true,
              },
            },
          }),
          stderr: "",
        }
      },
    })

    assert.equal(result.status, "pass")
    assert.equal(result.activation.selected_activation.id, "ms-area:worker")
    assert.deepEqual(result.activation.selected_activation.chain.map((entry) => entry.id), [
      "desk:worker",
      "ms-desk:worker",
      "ms-area:worker",
    ])
    assert.equal(result.desk_status.activation.selected_id, "ms-area:worker")
    assert.deepEqual(result.desk_status.activation.chain, [
      "desk:worker",
      "ms-desk:worker",
      "ms-area:worker",
    ])
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
  }
})

test("Codex smoke replaces stale temp activation blocks while preserving temp user config", async () => {
  const { runCodexCliActivationSmoke } = await loadCodexSmokeHarness()
  const hostRoot = makeTempHost()
  try {
    const workspaceRoot = path.join(hostRoot, "workspace")
    const staleConfig = [
      'model = "gpt-5.4"',
      "",
      "# BEGIN desk activation: desk@1.6.0 mode=manual-only owner=desk-activation",
      '[plugins."desk@ourostack"]',
      "enabled = false",
      "# END desk activation",
      "",
    ].join("\n")
    const staleInstructions = [
      "# user guidance",
      "",
      "# BEGIN desk activation: desk@1.6.0 mode=manual-only owner=desk-activation",
      "You are not the desk worker by default.",
      "# END desk activation",
      "",
    ].join("\n")
    writeHostFile(hostRoot, ".codex/config.toml", staleConfig)
    writeHostFile(hostRoot, ".codex/AGENTS.md", staleInstructions)

    const result = await runCodexCliActivationSmoke({
      repoRoot,
      hostRoot,
      workspaceRoot,
      codexRunner: async (request) => {
        const generatedConfig = readFileSync(path.join(request.env.CODEX_HOME, "config.toml"), "utf8")
        const generatedInstructions = readFileSync(path.join(request.env.CODEX_HOME, "AGENTS.md"), "utf8")
        assert.match(generatedConfig, /model = "gpt-5\.4"/u)
        assert.doesNotMatch(generatedConfig, /desk@1\.6\.0/u)
        assert.doesNotMatch(generatedConfig, /enabled = false/u)
        assert.match(generatedInstructions, /# user guidance/u)
        assert.doesNotMatch(generatedInstructions, /not the desk worker/u)
        return {
          exitCode: 0,
          stdout: smokeStdout({
            deskStatus: {
              status: "ok",
              root: { path: path.join(hostRoot, "desk"), source: "activation-config" },
              runtime: { loaded_from_source_mirror: true },
            },
          }),
          stderr: "",
        }
      },
    })

    assert.equal(result.status, "pass")
    assert.equal(result.activation.mode, "global-personal")
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
  }
})

test("Codex smoke supports project-local activation without mutating global defaults", async () => {
  const { runCodexCliActivationSmoke } = await loadCodexSmokeHarness()
  const hostRoot = makeTempHost()
  try {
    const workspaceRoot = path.join(hostRoot, "project")
    const result = await runCodexCliActivationSmoke({
      repoRoot,
      hostRoot,
      workspaceRoot,
      mode: "project-local",
      codexRunner: async (request) => {
        const projectConfigPath = path.join(workspaceRoot, ".codex", "config.toml")
        const projectInstructionsPath = path.join(workspaceRoot, "AGENTS.md")
        assert.equal(existsSync(path.join(request.env.CODEX_HOME, "config.toml")), false)
        assert.equal(existsSync(projectConfigPath), true)
        assert.equal(existsSync(projectInstructionsPath), true)
        assert.match(readFileSync(projectConfigPath, "utf8"), /\[mcp_servers\.desk\]/u)
        assert.match(readFileSync(projectInstructionsPath, "utf8"), /desk worker by default in this project/u)
        assert.equal(request.env.DESK, path.join(workspaceRoot, ".desk"))
        return {
          exitCode: 0,
          stdout: smokeStdout({
            instructionSources: ["AGENTS.md"],
            instructions: "You are the desk worker by default in this project.\nRun the `desk:session-start` skill.",
            deskStatus: {
              status: "ok",
              root: { path: path.join(workspaceRoot, ".desk"), source: "activation-config" },
              runtime: { loaded_from_source_mirror: true },
            },
          }),
          stderr: "",
        }
      },
    })

    assert.equal(result.status, "pass")
    assert.deepEqual(result.activation, {
      config_path: path.join(workspaceRoot, ".codex", "config.toml"),
      activation_config_path: path.join(workspaceRoot, ".codex", "desk.activation.json"),
      instructions_path: path.join(workspaceRoot, "AGENTS.md"),
      mode: "project-local",
    })
    assert.equal(result.desk_status.root.path, path.join(workspaceRoot, ".desk"))
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
  }
})

test("Codex smoke treats manual-only as an opt-out and can clean temp profile files", async () => {
  const { runCodexCliActivationSmoke } = await loadCodexSmokeHarness()
  const hostRoot = makeTempHost()
  try {
    const workspaceRoot = path.join(hostRoot, "workspace")
    let runnerCalled = false
    const result = await runCodexCliActivationSmoke({
      repoRoot,
      hostRoot,
      workspaceRoot,
      mode: "manual-only",
      cleanupProfile: true,
      codexRunner: async () => {
        runnerCalled = true
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    })

    assert.equal(runnerCalled, false)
    assert.equal(result.status, "skipped")
    assert.equal(result.reason, "manual-only opt-out")
    assert.equal(result.activation.config_path, path.join(hostRoot, ".codex", "config.toml"))
    assert.equal(result.activation.activation_config_path, null)
    assert.equal(result.activation.instructions_path, null)
    assert.equal(existsSync(path.join(hostRoot, ".codex")), false)
    assert.equal(existsSync(workspaceRoot), true)
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
  }
})

test("Codex smoke reports missing Codex binary and failed MCP launch without stack traces", async () => {
  const { runCodexCliActivationSmoke } = await loadCodexSmokeHarness()
  const missingBinaryRoot = makeTempHost()
  const failedMcpRoot = makeTempHost()
  const launchErrorRoot = makeTempHost()
  const launchStringRoot = makeTempHost()
  const missingStderrRoot = makeTempHost()
  try {
    await assert.rejects(
      () => runCodexCliActivationSmoke({
        repoRoot,
        hostRoot: missingBinaryRoot,
        workspaceRoot: path.join(missingBinaryRoot, "workspace"),
        cleanupProfile: true,
        codexRunner: async () => {
          const error = new Error("spawn codex ENOENT")
          error.code = "ENOENT"
          throw error
        },
      }),
      (error) => {
        assert.match(error.message, /Codex CLI unavailable: codex binary not found/u)
        assert.doesNotMatch(error.message, /at .*codex-smoke/u)
        return true
      },
    )
    assert.equal(existsSync(path.join(missingBinaryRoot, ".codex")), false)

    await assert.rejects(
      () => runCodexCliActivationSmoke({
        repoRoot,
        hostRoot: launchStringRoot,
        workspaceRoot: path.join(launchStringRoot, "workspace"),
        codexRunner: async () => {
          throw "string launch failure"
        },
      }),
      /Codex CLI smoke failed to launch: string launch failure/u,
    )

    await assert.rejects(
      () => runCodexCliActivationSmoke({
        repoRoot,
        hostRoot: launchErrorRoot,
        workspaceRoot: path.join(launchErrorRoot, "workspace"),
        codexRunner: async () => {
          throw new Error("permission denied while launching codex")
        },
      }),
      (error) => {
        assert.match(error.message, /Codex CLI smoke failed to launch/u)
        assert.match(error.message, /permission denied while launching codex/u)
        assert.doesNotMatch(error.message, /at .*codex-smoke/u)
        return true
      },
    )

    await assert.rejects(
      () => runCodexCliActivationSmoke({
        repoRoot,
        hostRoot: failedMcpRoot,
        workspaceRoot: path.join(failedMcpRoot, "workspace"),
        codexRunner: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: [
            "MCP server desk failed to initialize",
            "    at launchDesk (/tmp/desk-smoke.js:10:5)",
            "    at async startServer (/tmp/server.js:22:3)",
          ].join("\n"),
        }),
      }),
      (error) => {
        assert.match(error.message, /Codex CLI smoke failed with exit code 1/u)
        assert.match(error.message, /MCP server desk failed to initialize/u)
        assert.doesNotMatch(error.message, /\bat\s+(?:async\s+)?\S+/u)
        return true
      },
    )

    await assert.rejects(
      () => runCodexCliActivationSmoke({
        repoRoot,
        hostRoot: missingStderrRoot,
        workspaceRoot: path.join(missingStderrRoot, "workspace"),
        codexRunner: async () => ({ exitCode: 2, stdout: "" }),
      }),
      /Codex CLI smoke failed with exit code 2/u,
    )
  } finally {
    rmSync(missingBinaryRoot, { recursive: true, force: true })
    rmSync(failedMcpRoot, { recursive: true, force: true })
    rmSync(launchErrorRoot, { recursive: true, force: true })
    rmSync(launchStringRoot, { recursive: true, force: true })
    rmSync(missingStderrRoot, { recursive: true, force: true })
  }
})

test("Codex smoke rejects malformed output and desk_status proof failures", async () => {
  const { runCodexCliActivationSmoke } = await loadCodexSmokeHarness()
  const malformedRoot = makeTempHost()
  const failedStatusRoot = makeTempHost()
  const wrongRoot = makeTempHost()
  const missingStatusRoot = makeTempHost()
  const selectedMismatchRoot = makeTempHost()
  const selectedMissingChainRoot = makeTempHost()
  const selectedMissingActivationRoot = makeTempHost()
  const malformedMessageRoot = makeTempHost()
  try {
    await assert.rejects(
      () => runCodexCliActivationSmoke({
        repoRoot,
        hostRoot: malformedRoot,
        workspaceRoot: path.join(malformedRoot, "workspace"),
        codexRunner: async () => ({ exitCode: 0, stdout: "not-json\n", stderr: "" }),
      }),
      /Codex CLI smoke output did not contain a parseable final JSON message/u,
    )

    await assert.rejects(
      () => runCodexCliActivationSmoke({
        repoRoot,
        hostRoot: malformedMessageRoot,
        workspaceRoot: path.join(malformedMessageRoot, "workspace"),
        codexRunner: async () => ({
          exitCode: 0,
          stdout: `${JSON.stringify({ type: "final_message", message: "not-json" })}\n`,
          stderr: "",
        }),
      }),
      /Codex CLI smoke output did not contain a parseable final JSON message/u,
    )

    await assert.rejects(
      () => runCodexCliActivationSmoke({
        repoRoot,
        hostRoot: failedStatusRoot,
        workspaceRoot: path.join(failedStatusRoot, "workspace"),
        codexRunner: async () => ({
          exitCode: 0,
          stdout: smokeStdout({
            deskStatus: {
              status: "error",
              root: { path: path.join(failedStatusRoot, "desk"), source: "activation-config" },
            },
          }),
          stderr: "",
        }),
      }),
      /Codex CLI smoke did not prove desk_status availability/u,
    )

    await assert.rejects(
      () => runCodexCliActivationSmoke({
        repoRoot,
        hostRoot: wrongRoot,
        workspaceRoot: path.join(wrongRoot, "workspace"),
        codexRunner: async () => ({
          exitCode: 0,
          stdout: smokeStdout({
            deskStatus: {
              status: "ok",
              root: { path: path.join(wrongRoot, "other-desk"), source: "activation-config" },
            },
          }),
          stderr: "",
        }),
      }),
      /Codex CLI smoke did not prove desk_status availability/u,
    )

    await assert.rejects(
      () => runCodexCliActivationSmoke({
        repoRoot,
        hostRoot: missingStatusRoot,
        workspaceRoot: path.join(missingStatusRoot, "workspace"),
        codexRunner: async () => ({
          exitCode: 0,
          stdout: smokeStdout({ deskStatus: undefined }),
          stderr: "",
        }),
      }),
      /Codex CLI smoke did not prove desk_status availability/u,
    )

    await assert.rejects(
      () => runCodexCliActivationSmoke({
        repoRoot,
        hostRoot: selectedMismatchRoot,
        workspaceRoot: path.join(selectedMismatchRoot, "workspace"),
        manifest: overlayChainManifest(),
        selectedActivationId: "ms-area:worker",
        codexRunner: async () => ({
          exitCode: 0,
          stdout: smokeStdout({
            deskStatus: {
              status: "ok",
              root: { path: path.join(selectedMismatchRoot, "desk"), source: "activation-config" },
              activation: {
                selected_id: "ms-desk:worker",
                chain: ["desk:worker", "ms-desk:worker"],
              },
            },
          }),
          stderr: "",
        }),
      }),
      /Codex CLI smoke did not prove selected activation desk_status metadata/u,
    )

    await assert.rejects(
      () => runCodexCliActivationSmoke({
        repoRoot,
        hostRoot: selectedMissingActivationRoot,
        workspaceRoot: path.join(selectedMissingActivationRoot, "workspace"),
        manifest: overlayChainManifest(),
        selectedActivationId: "ms-area:worker",
        codexRunner: async () => ({
          exitCode: 0,
          stdout: smokeStdout({
            deskStatus: {
              status: "ok",
              root: { path: path.join(selectedMissingActivationRoot, "desk"), source: "activation-config" },
            },
          }),
          stderr: "",
        }),
      }),
      /Codex CLI smoke did not prove selected activation desk_status metadata/u,
    )

    await assert.rejects(
      () => runCodexCliActivationSmoke({
        repoRoot,
        hostRoot: selectedMissingChainRoot,
        workspaceRoot: path.join(selectedMissingChainRoot, "workspace"),
        manifest: overlayChainManifest(),
        selectedActivationId: "ms-area:worker",
        codexRunner: async () => ({
          exitCode: 0,
          stdout: smokeStdout({
            deskStatus: {
              status: "ok",
              root: { path: path.join(selectedMissingChainRoot, "desk"), source: "activation-config" },
              activation: {
                selected_id: "ms-area:worker",
                chain: "desk:worker -> ms-desk:worker -> ms-area:worker",
              },
            },
          }),
          stderr: "",
        }),
      }),
      /Codex CLI smoke did not prove selected activation desk_status metadata/u,
    )
  } finally {
    rmSync(malformedRoot, { recursive: true, force: true })
    rmSync(failedStatusRoot, { recursive: true, force: true })
    rmSync(wrongRoot, { recursive: true, force: true })
    rmSync(missingStatusRoot, { recursive: true, force: true })
    rmSync(selectedMismatchRoot, { recursive: true, force: true })
    rmSync(selectedMissingActivationRoot, { recursive: true, force: true })
    rmSync(selectedMissingChainRoot, { recursive: true, force: true })
    rmSync(malformedMessageRoot, { recursive: true, force: true })
  }
})

test("Codex smoke evidence records CLI proof and an exact Desktop App fallback", () => {
  const evidence = readFileSync(evidencePath, "utf8")
  const codex = codexMatrixRow()
  const desktopSection = evidenceSection(evidence, "Codex Desktop App Activation Surface")

  assert.match(evidence, /^Status: PASS$/m)
  assert.match(evidence, /## Codex CLI Activation Smoke[\s\S]*Status: PASS/u)
  assert.match(evidence, /codex exec --json/u)
  assert.match(evidence, /CODEX_HOME/u)
  assert.match(evidence, /You are the desk worker by default\./u)
  assert.match(evidence, /desk:session-start/u)
  assert.match(evidence, /desk_status/u)
  assert.match(evidence, /Actual installed-profile Codex CLI smoke: PASS/u)
  assert.match(evidence, /codex-installed-profile-smoke\.json/u)
  assert.match(evidence, /chunks_total: 363/u)
  assert.match(evidence, /vectors_indexed: 363/u)
  assert.match(evidence, /missing_vectors: 0/u)
  assert.match(evidence, /degraded_modes: \[\]/u)
  assert.match(evidence, /Cold snapshot restore smoke: PASS/u)
  assert.match(evidence, /Cold vector-pack-only smoke: PASS/u)
  assert.match(evidence, /Empty temp profiles may warn that `desk@ourostack` and `work-suite@ourostack` are not installed/u)
  assert.match(evidence, /activation-owned top-level `mcp_servers\.desk` bridge/u)
  assert.match(evidence, /developers\.openai\.com\/codex\/cli\/reference#codex-exec/u)
  assert.match(evidence, /developers\.openai\.com\/codex\/guides\/agents-md/u)
  assert.match(evidence, /developers\.openai\.com\/codex\/app-server/u)

  assert.equal(
    completeDesktopRealSmoke(desktopSection) || completeDesktopFallback(desktopSection, codex),
    true,
    "Codex App must have detailed real smoke proof or an exact unsupported primitive plus fallback",
  )
})

test("installed-profile Codex CLI smoke proof is machine-readable", () => {
  const proof = loadJson(installedProfileSmokePath)
  assert.equal(proof.command, "codex exec --json --ephemeral --strict-config")
  assert.equal(proof.called_desk_status, true)
  assert.equal(proof.status, "ok")
  assert.equal(proof.root_source, "activation-config")
  assert.equal(proof.selected_id, "desk:worker")
  assert.equal(proof.chunks_total, 363)
  assert.equal(proof.vectors_indexed, 363)
  assert.equal(proof.missing_vectors, 0)
  assert.deepEqual(proof.degraded_modes, [])
})

test("Codex support matrix points at the smoke contract and evidence artifact", () => {
  const codex = codexMatrixRow()
  const evidence = readFileSync(evidencePath, "utf8")
  const desktopSection = evidenceSection(evidence, "Codex Desktop App Activation Surface")
  const desktopRealSmoke = completeDesktopRealSmoke(desktopSection)

  assert.ok(codex.source_paths.includes("plugins/desk/mcp/__tests__/activation/codex_smoke.test.js"))
  assert.ok(
    codex.source_paths.includes(
      "desk/tasks/2026-06-14-1335-doing-desk-dependency-activation/codex-smoke-evidence.md",
    ),
  )
  assert.match(codex.evidence_command_or_doc, /node --test plugins\/desk\/mcp\/__tests__\/activation\/codex_smoke\.test\.js/u)
  assert.match(codex.evidence_command_or_doc, /codex-smoke-evidence\.md/u)
  assert.equal(
    desktopRealSmoke || codex.unsupported_primitives.includes(codexDesktopUnsupportedPrimitive),
    true,
    "Codex support matrix must either rely on real Desktop smoke evidence or name the unsupported primitive",
  )
})
