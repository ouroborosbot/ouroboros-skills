import { test } from "node:test"
import { strict as assert } from "node:assert"
import {
  existsSync,
  readFileSync,
} from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { deriveRuntimeDependencyPackPaths } from "../../src/runtime/runtime-deps.js"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const pluginRoot = path.join(repoRoot, "plugins", "desk")
const mcpRoot = path.join(pluginRoot, "mcp")
const expectedPluginVersion = "1.7.17"
const expectedMcpVersion = "1.3.3"
const expectedReleaseDate = "2026-08-18"

function readJson(...segments) {
  return JSON.parse(readFileSync(path.join(repoRoot, ...segments), "utf8"))
}

function readText(...segments) {
  return readFileSync(path.join(repoRoot, ...segments), "utf8")
}

function recordMismatch(errors, label, actual, expected) {
  if (actual !== expected) {
    errors.push(`${label}: expected ${expected}, received ${String(actual)}`)
  }
}

test("Desk 1.7.17 and MCP 1.3.3 release surfaces move together", () => {
  const errors = []
  const deskPlugin = readJson("plugins", "desk", "plugin.json")
  const claudePlugin = readJson("plugins", "desk", ".claude-plugin", "plugin.json")
  const codexPlugin = readJson("plugins", "desk", ".codex-plugin", "plugin.json")
  const marketplace = readJson(".claude-plugin", "marketplace.json")
  const activation = readJson("plugins", "desk", "activation", "desk.activation.json")
  const bundle = readJson(
    "plugins",
    "desk",
    "activation",
    "copilot-root.flattened-bundle.json",
  )
  const packageJson = readJson("plugins", "desk", "mcp", "package.json")
  const packageLock = readJson("plugins", "desk", "mcp", "package-lock.json")
  const marketplaceDesk = marketplace.plugins.find((plugin) => plugin.name === "desk")
  const activationDesk = activation.dependencies.find((dependency) => dependency.id === "desk")
  const bundleDesk = bundle.dependency_closure.find((dependency) => dependency.id === "desk")

  for (const [label, version] of [
    ["plugins/desk/plugin.json", deskPlugin.version],
    ["plugins/desk/.claude-plugin/plugin.json", claudePlugin.version],
    ["plugins/desk/.codex-plugin/plugin.json", codexPlugin.version],
    [".claude-plugin/marketplace.json desk entry", marketplaceDesk?.version],
    ["plugins/desk/activation/desk.activation.json", activation.version],
    ["plugins/desk/activation/desk.activation.json desk dependency", activationDesk?.version],
    ["plugins/desk/activation/desk.activation.json desk lock", activationDesk?.lock?.version],
    ["plugins/desk/activation/copilot-root.flattened-bundle.json", bundleDesk?.version],
  ]) {
    recordMismatch(errors, label, version, expectedPluginVersion)
  }

  for (const [label, version] of [
    ["plugins/desk/mcp/package.json", packageJson.version],
    ["plugins/desk/mcp/package-lock.json", packageLock.version],
    ["plugins/desk/mcp/package-lock.json root package", packageLock.packages?.[""]?.version],
  ]) {
    recordMismatch(errors, label, version, expectedMcpVersion)
  }

  const serverSource = readText("plugins", "desk", "mcp", "src", "server.js")
  const serverVersion = serverSource.match(
    /name:\s*"desk-mcp",\s*version:\s*"(?<version>[^"]+)"/su,
  )?.groups?.version
  recordMismatch(errors, "plugins/desk/mcp/src/server.js", serverVersion, expectedMcpVersion)

  const changelog = readText("plugins", "desk", "CHANGELOG.md")
  const expectedHeading = `## ${expectedPluginVersion} — ${expectedReleaseDate}`
  if (!changelog.startsWith(`# desk plugin — changelog\n\n${expectedHeading}\n`)) {
    errors.push(`plugins/desk/CHANGELOG.md must begin with ${expectedHeading}`)
  }
  const currentEntry = changelog.split(/\n## /u, 3)[1] ?? ""
  if (!currentEntry.includes(`desk-mcp@${expectedMcpVersion}`)) {
    errors.push(`plugins/desk/CHANGELOG.md current entry must name desk-mcp@${expectedMcpVersion}`)
  }

  const codexFixturePaths = [
    ["global-personal", "generated-config.toml"],
    ["global-personal", "generated-instructions.md"],
    ["manual-only", "generated-config.toml"],
    ["project-local", "generated-config.toml"],
    ["project-local", "generated-instructions.md"],
  ]
  for (const fixturePath of codexFixturePaths) {
    const relativePath = path.join(
      "plugins",
      "desk",
      "mcp",
      "__tests__",
      "fixtures",
      "activation",
      "codex",
      ...fixturePath,
    )
    if (!readFileSync(path.join(repoRoot, relativePath), "utf8").includes(`desk@${expectedPluginVersion}`)) {
      errors.push(`${relativePath} must contain desk@${expectedPluginVersion}`)
    }
  }

  const releasePackPaths = deriveRuntimeDependencyPackPaths({
    mcpRoot,
    packageJson: {
      ...packageJson,
      version: expectedMcpVersion,
    },
    packageLock,
    platform: "darwin",
    arch: "arm64",
    nodeAbi: "127",
  })
  for (const filePath of [
    releasePackPaths.archivePath,
    releasePackPaths.manifestPath,
    releasePackPaths.checksumPath,
  ]) {
    if (!existsSync(filePath)) {
      errors.push(`${path.relative(repoRoot, filePath)} must exist`)
    }
  }

  assert.deepEqual(errors, [])
})
