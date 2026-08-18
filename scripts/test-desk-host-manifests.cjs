#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const defaultRepoRoot = path.resolve(__dirname, "..");
const defaultMcpRoot = path.join(defaultRepoRoot, "plugins", "desk", "mcp");
const activationManifestPath = "plugins/desk/activation/desk.activation.json";
const copilotBundlePath = "plugins/desk/activation/copilot-root.flattened-bundle.json";
const evidencePath =
  "desk/tasks/2026-06-14-1335-doing-desk-dependency-activation/host-capability-evidence.md";
const supportMatrixPath = "plugins/desk/activation/support-matrix.json";
const requiredEvidenceColumns = [
  "host_id",
  "surface",
  "disposition",
  "source_paths",
  "evidence_command_or_doc",
  "unsupported_primitives",
  "fallback_behavior",
];

function readText(repoRoot, relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readJson(repoRoot, relativePath) {
  return JSON.parse(readText(repoRoot, relativePath));
}

function splitMarkdownRow(row) {
  return row.trim().replace(/^\|/u, "").replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());
}

function splitList(value) {
  if (value === "none") return [];
  return value.replace(/^none$/u, "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseEvidenceTable(content) {
  const tableRows = content.split(/\r?\n/u).filter((line) => line.startsWith("|"));
  const columns = splitMarkdownRow(tableRows[0] ?? "");
  if (!sameJson(columns, requiredEvidenceColumns)) {
    throw new Error(`support-matrix evidence columns drifted in ${evidencePath}`);
  }
  return tableRows.slice(2).map((line) => {
    const values = splitMarkdownRow(line);
    const row = Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""]));
    return {
      ...row,
      source_paths: splitList(row.source_paths),
      unsupported_primitives: splitList(row.unsupported_primitives),
    };
  });
}

function expectedSupportMatrix(repoRoot) {
  return {
    schema_version: 1,
    generated_from: {
      activation_manifest: activationManifestPath,
      host_capability_evidence: evidencePath,
    },
    hosts: parseEvidenceTable(readText(repoRoot, evidencePath)),
  };
}

function expectedCopilotBundle(repoRoot) {
  const activation = readJson(repoRoot, activationManifestPath);
  const workSuiteDependency = activation.dependencies.find((dependency) => (
    dependency.id === "work-suite"
  ));
  return {
    schema_version: 1,
    host: "copilot-root",
    generated_by: "npm --prefix plugins/desk/mcp run activation:copilot-bundle:generate",
    generated_from: {
      activation_manifest: activationManifestPath,
      desk_plugin: "plugins/desk/plugin.json",
      work_suite_plugin: "plugins/work-suite/plugin.json",
    },
    launch: {
      agent: "plugins/desk/agents/worker.agent.md",
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
        version: workSuiteDependency?.lock?.version,
        plugin: "plugins/work-suite/plugin.json",
        skills: "plugins/work-suite/skills/",
      },
    ],
    manual_steps: [],
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameJson(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function normalizeNewlines(value) {
  return value.replaceAll("\r\n", "\n");
}

function pushMismatch(errors, label, actual, expected) {
  if (!sameJson(actual, expected)) {
    errors.push(`${label} drift: committed host-facing artifact does not match generated expectation`);
  }
}

function findActivationDependency(activation, id) {
  return activation.dependencies.find((dependency) => dependency.id === id);
}

function checkSupportMatrix({ repoRoot, errors, checked }) {
  checked.push("support-matrix");
  const activation = readJson(repoRoot, activationManifestPath);
  const evidenceRows = parseEvidenceTable(readText(repoRoot, evidencePath));
  const matrix = readJson(repoRoot, supportMatrixPath);
  pushMismatch(errors, "support-matrix", matrix, expectedSupportMatrix(repoRoot));

  for (const hostSupport of activation.host_support) {
    const row = evidenceRows.find((candidate) => candidate.host_id === hostSupport.host);
    if (!row) {
      errors.push(`support-matrix missing evidence row for ${hostSupport.host}`);
    } else {
      if (!row.disposition.startsWith(`${hostSupport.status}-`)) {
        errors.push(`support-matrix evidence disposition drift for ${hostSupport.host}`);
      }
      if (row.fallback_behavior !== hostSupport.fallback_behavior) {
        errors.push(`support-matrix fallback drift for ${hostSupport.host}`);
      }
    }
  }
}

async function checkCopilotBundle({ repoRoot, mcpRoot, errors, checked }) {
  checked.push("copilot-bundle");
  const { buildCopilotBundle, validateCopilotPackagingContract } = await import(pathToFileURL(
    path.join(mcpRoot, "src", "activation", "copilot-bundle.js"),
  ).href);
  const activation = readJson(repoRoot, activationManifestPath);
  const bundle = readJson(repoRoot, copilotBundlePath);
  pushMismatch(errors, "copilot-bundle", bundle, buildCopilotBundle({ activation }));

  checked.push("copilot-plugin-metadata");
  const contractErrors = validateCopilotPackagingContract({
    activation,
    bundle,
    deskPlugin: readJson(repoRoot, "plugins/desk/plugin.json"),
    workSuitePlugin: readJson(repoRoot, "plugins/work-suite/plugin.json"),
  });
  if (contractErrors.length > 0) {
    errors.push(`copilot-plugin-metadata drift: ${contractErrors.join("; ")}`);
  }
}

function checkCodexPlugin({ repoRoot, errors, checked }) {
  checked.push("codex-plugin");
  const activation = readJson(repoRoot, activationManifestPath);
  const deskPlugin = readJson(repoRoot, "plugins/desk/.codex-plugin/plugin.json");
  const workSuitePlugin = readJson(repoRoot, "plugins/work-suite/.codex-plugin/plugin.json");
  const workSuiteLock = findActivationDependency(activation, "work-suite")?.lock?.version;
  const codex = deskPlugin.activation?.codex;

  if (deskPlugin.version !== activation.version) {
    errors.push("codex-plugin Desk version drift");
  }
  if (deskPlugin.skills !== "./skills/" || deskPlugin.mcpServers !== "./.mcp.json") {
    errors.push("codex-plugin Desk surfaces drift");
  }
  if (codex?.defaultMode !== "global-personal") {
    errors.push("codex-plugin default activation mode drift");
  }
  if (!sameJson(codex?.optOutModes, ["project-local", "manual-only"])) {
    errors.push("codex-plugin opt-out modes drift");
  }
  if (codex?.targets?.["desk:worker"]?.source !== "agents/worker.toml") {
    errors.push("codex-plugin desk:worker source drift");
  }
  if (codex?.targets?.["desk:worker"]?.default !== true) {
    errors.push("codex-plugin desk:worker default drift");
  }
  if (codex?.mcpServers?.desk?.manualRegistration !== false) {
    errors.push("codex-plugin Desk MCP manual-registration drift");
  }
  if (!sameJson(codex?.manualSetupSteps ?? [], [])) {
    errors.push("codex-plugin manual setup steps drift");
  }
  if (codex?.dependencies?.["work-suite"]?.version !== workSuitePlugin.version) {
    errors.push("codex-plugin Work Suite dependency version drift");
  }
  if (workSuitePlugin.version !== workSuiteLock) {
    errors.push("codex-plugin Work Suite provider lock drift");
  }
}

function checkClaudePlugin({ repoRoot, errors, checked }) {
  checked.push("claude-plugin");
  const activation = readJson(repoRoot, activationManifestPath);
  const deskPlugin = readJson(repoRoot, "plugins/desk/.claude-plugin/plugin.json");
  const workSuitePlugin = readJson(repoRoot, "plugins/work-suite/.claude-plugin/plugin.json");
  const claudeActivation = activation.host_activation?.claude;
  const workSuiteLock = findActivationDependency(activation, "work-suite")?.lock?.version;

  if (deskPlugin.version !== activation.version) {
    errors.push("claude-plugin Desk version drift");
  }
  if (!Array.isArray(deskPlugin.agents) || !deskPlugin.agents.includes("./agents/worker.md")) {
    errors.push("claude-plugin worker exposure drift");
  }
  if (deskPlugin.skills !== "./skills/" || deskPlugin.mcpServers !== "./.mcp.json") {
    errors.push("claude-plugin Desk surfaces drift");
  }
  if (deskPlugin.outputStyles !== "./output-styles/") {
    errors.push("claude-plugin output style surface drift");
  }
  if (deskPlugin.dependencies?.[0]?.name !== "work-suite" || deskPlugin.dependencies?.[0]?.version !== "^1.4.0") {
    errors.push("claude-plugin Work Suite dependency drift");
  }
  if (workSuitePlugin.version !== workSuiteLock) {
    errors.push("claude-plugin Work Suite provider lock drift");
  }
  if (claudeActivation?.targets?.["desk:worker"]?.source !== "agents/worker.md") {
    errors.push("claude-plugin activation worker source drift");
  }
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  if (!match) return {};
  return Object.fromEntries(match[1]
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const [key, ...rest] = line.split(":");
      return [key.trim(), rest.join(":").trim().replace(/^"|"$/gu, "")];
    }));
}

function tomlStringValue(text, key) {
  const match = text.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "mu"));
  return match?.[1];
}

function checkWorkerSources({ repoRoot, errors, checked }) {
  checked.push("worker-sources");
  const claudeWorker = readText(repoRoot, "plugins/desk/agents/worker.md");
  const codexWorker = readText(repoRoot, "plugins/desk/agents/worker.toml");
  const copilotWorker = readText(repoRoot, "plugins/desk/agents/worker.agent.md");
  const workerFacts = [
    ["claude", parseFrontmatter(claudeWorker).name],
    ["codex", tomlStringValue(codexWorker, "name")],
    ["copilot", parseFrontmatter(copilotWorker).name],
  ];

  for (const [host, name] of workerFacts) {
    if (name !== "worker") {
      errors.push(`worker-sources ${host} worker name drift`);
    }
  }
  for (const [host, body] of [
    ["claude", claudeWorker],
    ["codex", codexWorker],
    ["copilot", copilotWorker],
  ]) {
    if (!body.includes("I'm **worker**") || !body.includes("$DESK")) {
      errors.push(`worker-sources ${host} body drift`);
    }
  }
  if (!claudeWorker.includes("desk:session-start")) {
    errors.push("worker-sources claude session-start prompt drift");
  }
}

async function expectedCodexFixtures({ repoRoot, mcpRoot }) {
  const { materializeCodexActivation } = await import(pathToFileURL(
    path.join(mcpRoot, "src", "activation", "adapters", "codex.js"),
  ).href);
  const manifest = readJson(repoRoot, activationManifestPath);
  const existingConfig = [
    "# user-authored Codex config",
    "model = \"gpt-5.4\"",
    "approval_policy = \"on-request\"",
    "",
  ].join("\n");
  const existingInstructions = [
    "# user-authored Codex guidance",
    "Keep repo-local rules intact.",
    "",
  ].join("\n");
  const inputForMode = (mode) => ({
    manifest,
    mode,
    existingConfig,
    existingInstructions,
    pluginRoot: "plugins/desk",
    workSuitePluginRoot: "plugins/work-suite",
    deskRoot: mode === "project-local" ? ".desk" : "~/desk",
    runtimeCacheDir: mode === "project-local"
      ? ".codex/desk-runtime-cache"
      : "~/.cache/ouroboros-skills/desk",
  });
  return {
    "plugins/desk/mcp/__tests__/fixtures/activation/codex/global-personal/generated-config.toml":
      materializeCodexActivation(inputForMode("global-personal")).generatedConfig,
    "plugins/desk/mcp/__tests__/fixtures/activation/codex/global-personal/generated-instructions.md":
      materializeCodexActivation(inputForMode("global-personal")).generatedInstructions,
    "plugins/desk/mcp/__tests__/fixtures/activation/codex/project-local/generated-config.toml":
      materializeCodexActivation(inputForMode("project-local")).generatedConfig,
    "plugins/desk/mcp/__tests__/fixtures/activation/codex/project-local/generated-instructions.md":
      materializeCodexActivation(inputForMode("project-local")).generatedInstructions,
    "plugins/desk/mcp/__tests__/fixtures/activation/codex/manual-only/generated-config.toml":
      materializeCodexActivation(inputForMode("manual-only")).generatedConfig,
  };
}

async function checkCodexFixtures({ repoRoot, mcpRoot, errors, checked }) {
  checked.push("codex-fixtures");
  const expected = await expectedCodexFixtures({ repoRoot, mcpRoot });
  for (const [relativePath, content] of Object.entries(expected)) {
    if (normalizeNewlines(readText(repoRoot, relativePath)) !== normalizeNewlines(content)) {
      errors.push(`codex-fixtures drift: ${relativePath}`);
    }
  }
}

async function verifyDeskHostManifests(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const mcpRoot = options.mcpRoot ?? path.join(repoRoot, "plugins", "desk", "mcp");
  const io = options.io ?? {
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const errors = [];
  const checked = [];

  try {
    checkSupportMatrix({ repoRoot, errors, checked });
    await checkCopilotBundle({ repoRoot, mcpRoot, errors, checked });
    checkCodexPlugin({ repoRoot, errors, checked });
    checkClaudePlugin({ repoRoot, errors, checked });
    checkWorkerSources({ repoRoot, errors, checked });
    await checkCodexFixtures({ repoRoot, mcpRoot, errors, checked });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (errors.length > 0) {
    io.stderr.write("Desk host manifest verification failed\n");
    for (const error of errors) io.stderr.write(`- ${error}\n`);
  } else {
    io.stdout.write(`Desk host manifests verified for ${checked.join(", ")}\n`);
  }
  return {
    ok: errors.length === 0,
    errors,
    checked,
  };
}

async function runCli(options = {}) {
  try {
    const result = await verifyDeskHostManifests(options);
    return result.ok ? 0 : 1;
  } catch (error) {
    const io = options.io ?? { stderr: process.stderr };
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  defaultMcpRoot,
  defaultRepoRoot,
  runCli,
  verifyDeskHostManifests,
};
