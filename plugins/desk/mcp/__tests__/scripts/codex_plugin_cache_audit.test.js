import { strict as assert } from "node:assert"
import { test } from "node:test"
import { createRequire } from "node:module"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const require = createRequire(import.meta.url)
const {
  auditActiveTools,
  auditCodexPluginCache,
  requiredDeskMcpTools,
  run,
  startCli,
} = require(path.join(repoRoot, "scripts", "audit-codex-plugin-cache.cjs"))

function mkdirp(dir) {
  mkdirSync(dir, { recursive: true })
}

function writeJson(filePath, value) {
  mkdirp(path.dirname(filePath))
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function manifest(name, version, extra = {}) {
  return {
    name,
    version,
    skills: "./skills/",
    tags: [name, version],
    activation: {
      codex: {
        marker: `${name}-${version}`,
      },
    },
    ...extra,
  }
}

function writePlugin(root, name, version, extra = {}) {
  writeJson(
    path.join(root, "plugins", name, ".codex-plugin", "plugin.json"),
    manifest(name, version, extra),
  )
}

function writeCache(codexHome, namespace, name, version, value) {
  writeJson(
    path.join(codexHome, "plugins", "cache", namespace, name, version, ".codex-plugin", "plugin.json"),
    value,
  )
}

function writeHostMarketplace(root, { namespace = "ourostack", plugins = [] } = {}) {
  writeJson(path.join(root, ".agents", "plugins", "marketplace.json"), {
    name: namespace,
    plugins: plugins.map(([name, sourcePath]) => ({
      name,
      source: { source: "local", path: sourcePath },
    })),
  })
}

function makeFixture({ namespace = "ourostack" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "desk-cache-audit-node-test-"))
  const fixtureRepo = path.join(root, "repo")
  const codexHome = path.join(root, "codex-home")
  mkdirp(fixtureRepo)
  writePlugin(fixtureRepo, "desk", "1.7.3")
  writePlugin(fixtureRepo, "work-suite", "1.4.9")
  writePlugin(fixtureRepo, "plain-language", "0.1.0")
  writePlugin(fixtureRepo, "ponytail-upstream", "4.9.0")
  writeJson(path.join(fixtureRepo, ".agents", "plugins", "marketplace.json"), {
    name: namespace,
    plugins: [
      {
        name: "desk",
        source: { source: "local", path: "./plugins/desk" },
      },
      {
        name: "work-suite",
        source: { source: "local", path: "./plugins/work-suite" },
      },
      {
        name: "plain-language",
        source: { source: "local", path: "./plugins/plain-language" },
      },
      {
        name: "ponytail-upstream",
        source: { source: "local", path: "./plugins/ponytail-upstream" },
      },
    ],
  })
  writeCache(codexHome, namespace, "desk", "1.7.3", manifest("desk", "1.7.3"))
  writeCache(codexHome, namespace, "work-suite", "1.4.9", manifest("work-suite", "1.4.9"))
  writeCache(codexHome, namespace, "plain-language", "0.1.0", manifest("plain-language", "0.1.0"))
  writeCache(codexHome, namespace, "ponytail-upstream", "4.9.0", manifest("ponytail-upstream", "4.9.0"))
  return { root, repoRoot: fixtureRepo, codexHome }
}

test("Codex plugin cache audit derives cache namespace from marketplace name", () => {
  const fixture = makeFixture({ namespace: "contoso" })
  try {
    const report = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
    })
    assert.equal(report.status, "current")
    assert.equal(report.marketplace_namespace, "contoso")
    assert.equal(report.active_session.status, "not_checked")
    assert.equal(report.active_session.provided, false)
    assert.ok(report.active_session.required.includes("desk_status"))
    assert.ok(report.plugins.every((plugin) => (
      plugin.marketplace_namespace === "contoso" &&
      plugin.installed_cache_path.includes(path.join("plugins", "cache", "contoso"))
    )))
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("Codex plugin cache audit checks host implicit marketplace source drift", () => {
  const fixture = makeFixture()
  try {
    writeHostMarketplace(fixture.root, {
      plugins: [
        ["desk", "./repo/plugins/desk"],
        ["work-suite", "./repo/plugins/work-suite"],
        ["plain-language", "./repo/plugins/plain-language"],
        ["ponytail-upstream", "./repo/plugins/ponytail-upstream"],
      ],
    })
    const current = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
    })
    assert.equal(current.status, "current")
    assert.equal(current.host_marketplace.provided, true)
    assert.equal(current.host_marketplace.current, true)
    assert.equal(current.host_marketplace.reason, "current")
    assert.equal(current.host_marketplace.namespace_current, true)
    assert.ok(current.host_marketplace.plugins.every((plugin) => plugin.current))

    writePlugin(fixture.root, "desk", "1.7.2")
    writePlugin(fixture.root, "work-suite", "1.4.8")
    writePlugin(fixture.root, "plain-language", "0.0.9")
    writePlugin(fixture.root, "ponytail-upstream", "4.8.0")
    writeHostMarketplace(fixture.root, {
      plugins: [
        ["desk", "./plugins/desk"],
        ["work-suite", "./plugins/work-suite"],
        ["plain-language", "./plugins/plain-language"],
        ["ponytail-upstream", "./plugins/ponytail-upstream"],
      ],
    })
    const stale = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
    })
    assert.equal(stale.status, "stale")
    assert.equal(stale.host_marketplace.provided, true)
    assert.equal(stale.host_marketplace.current, false)
    assert.equal(stale.host_marketplace.reason, "source-drift")
    assert.equal(stale.host_marketplace.plugins.find((plugin) => plugin.name === "desk").reason, "manifest-drift")
    assert.match(stale.host_marketplace.guidance, /Repoint ~\/\.agents\/plugins\/marketplace\.json/u)

    writeHostMarketplace(fixture.root, {
      namespace: "contoso",
      plugins: [
        ["desk", "./repo/plugins/desk"],
        ["work-suite", "./repo/plugins/work-suite"],
        ["plain-language", "./repo/plugins/plain-language"],
      ],
    })
    const namespaceMismatch = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
    })
    assert.equal(namespaceMismatch.status, "stale")
    assert.equal(namespaceMismatch.host_marketplace.reason, "namespace-mismatch")
    assert.equal(namespaceMismatch.host_marketplace.namespace_current, false)

    writePlugin(path.join(fixture.repoRoot, "host-root"), "desk", "1.7.3")
    writeJson(path.join(fixture.repoRoot, "host-marketplace.json"), {
      name: "ourostack",
      plugins: [
        {
          name: "desk",
          source: { source: "local", path: "./plugins/desk" },
        },
      ],
    })
    const relativeHostPaths = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      hostMarketplacePath: "host-marketplace.json",
      hostMarketplaceRoot: "host-root",
      plugins: ["desk"],
    })
    assert.equal(relativeHostPaths.status, "current")
    assert.equal(relativeHostPaths.host_marketplace.path, path.join(fixture.repoRoot, "host-marketplace.json"))
    assert.equal(relativeHostPaths.host_marketplace.root, path.join(fixture.repoRoot, "host-root"))
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("Codex plugin cache audit reports malformed host marketplace entries", () => {
  const fixture = makeFixture()
  try {
    writeJson(path.join(fixture.root, ".agents", "plugins", "marketplace.json"), {
      name: "ourostack",
      plugins: [
        {
          name: "desk",
          source: false,
        },
      ],
    })
    const report = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      plugins: ["desk", "work-suite"],
    })
    assert.equal(report.status, "stale")
    assert.equal(report.host_marketplace.current, false)
    assert.equal(report.host_marketplace.reason, "source-drift")
    assert.equal(report.host_marketplace.plugins[0].reason, "missing-marketplace-source")
    assert.equal(report.host_marketplace.plugins[0].host_marketplace_source_path, null)
    assert.equal(report.host_marketplace.plugins[1].reason, "missing-marketplace-entry")
    assert.equal(report.host_marketplace.plugins[1].host_marketplace_source_path, null)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("Codex plugin cache audit checks optional active Desk MCP tool snapshots", () => {
  const fixture = makeFixture()
  try {
    const required = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
    }).active_session.required

    const full = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      activeTools: required,
    })
    assert.equal(full.status, "current")
    assert.equal(full.active_session.status, "pass")
    assert.deepEqual(full.active_session.missing, [])
    assert.ok(full.active_session.present.includes("desk_status"))
    assert.equal(full.plugins.find((plugin) => plugin.name === "desk").active_session_visible, true)
    assert.equal(full.plugins.find((plugin) => plugin.name === "work-suite").active_session_visible, "not_checked")

    const prefixed = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      activeTools: required.map((name) => `mcp__desk.${name}`),
    })
    assert.equal(prefixed.active_session.status, "pass")

    const activeToolsFile = path.join(fixture.root, "active-tools.json")
    writeJson(activeToolsFile, {
      activeTools: required.map((name) => ({ name: `mcp__desk__${name}` })),
    })
    const fromFile = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      activeToolsFiles: [activeToolsFile],
    })
    assert.equal(fromFile.active_session.status, "pass")

    const mixedActiveToolsFile = path.join(fixture.root, "mixed-active-tools.json")
    writeJson(mixedActiveToolsFile, {
      tools: required.slice(1).map((name) => ({ name })),
    })
    const mixedActive = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      activeTools: [required[0]],
      activeToolsFiles: [mixedActiveToolsFile],
    })
    assert.equal(mixedActive.active_session.status, "pass")

    const missingStatus = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      activeTools: required.filter((name) => name !== "desk_status"),
    })
    assert.equal(missingStatus.status, "current")
    assert.equal(missingStatus.active_session.status, "fail")
    assert.deepEqual(missingStatus.active_session.missing, ["desk_status"])
    assert.equal(missingStatus.plugins.find((plugin) => plugin.name === "desk").active_session_visible, false)

    const malformedActive = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      activeTools: [{ unexpected: true }, "", { mcpTools: ["desk:desk_status"] }],
    })
    assert.equal(malformedActive.active_session.status, "fail")
    assert.deepEqual(malformedActive.active_session.present, ["desk_status"])

    assert.deepEqual(auditActiveTools(null, ["desk_status"]).required, ["desk_status"])
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("Codex plugin cache audit derives required active tools from canonical tool-names source when present", () => {
  const fixture = makeFixture()
  try {
    const toolNamesPath = path.join(fixture.repoRoot, "plugins", "desk", "mcp", "src", "tool-names.js")
    mkdirp(path.dirname(toolNamesPath))
    writeFileSync(toolNamesPath, 'export const TOOL_NAMES = ["desk_status", "desk_search"]\n', "utf8")

    assert.deepEqual(requiredDeskMcpTools(fixture.repoRoot), ["desk_status", "desk_search"])
    const report = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      activeTools: ["desk_status", "desk_search"],
    })
    assert.equal(report.active_session.status, "pass")
    assert.deepEqual(report.active_session.required, ["desk_status", "desk_search"])
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("Codex plugin cache audit falls back when canonical tool-names source has no names", () => {
  const fixture = makeFixture()
  try {
    const toolNamesPath = path.join(fixture.repoRoot, "plugins", "desk", "mcp", "src", "tool-names.js")
    mkdirp(path.dirname(toolNamesPath))
    writeFileSync(toolNamesPath, "export const TOOL_NAMES = []\n", "utf8")

    const required = requiredDeskMcpTools(fixture.repoRoot)
    assert.ok(required.includes("desk_status"))
    assert.ok(required.length > 2)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("Codex plugin cache audit reports source, cache, entry, and namespace evidence states", () => {
  const fixture = makeFixture()
  try {
    writePlugin(fixture.repoRoot, "desk", "1.7.3", { description: "new source" })
    writeCache(fixture.codexHome, "ourostack", "work-suite", "1.4.9", manifest("work-suite", "1.4.9", {
      description: "old cache",
    }))
    writeJson(path.join(fixture.repoRoot, ".agents", "plugins", "marketplace.json"), {
      plugins: [
        {
          name: "desk",
          source: false,
        },
      ],
    })

    const report = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      plugins: ["desk", "work-suite"],
    })
    assert.equal(report.status, "stale")
    assert.equal(report.marketplace_namespace, "unknown")
    assert.equal(report.plugins[0].repo_source_reason, "missing-marketplace-source")
    assert.equal(report.plugins[0].installed_cache_reason, "missing")
    assert.equal(report.plugins[1].repo_source_reason, "missing-marketplace-entry")
    assert.equal(report.plugins[1].installed_cache_reason, "missing")
    assert.equal(report.plugins[0].active_session_visible, "not_checked")
    assert.equal(report.active_session.status, "not_checked")

    writeJson(path.join(fixture.repoRoot, ".agents", "plugins", "marketplace.json"), {
      name: "ourostack",
      plugins: [
        {
          name: "desk",
          source: { source: "local", path: "./plugins/desk" },
        },
      ],
    })
    const driftReport = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      plugins: ["desk"],
    })
    assert.equal(driftReport.marketplace_namespace, "ourostack")
    assert.equal(driftReport.plugins[0].repo_source_current, true)
    assert.equal(driftReport.plugins[0].installed_cache_reason, "manifest-drift")

    writeJson(path.join(fixture.repoRoot, ".agents", "plugins", "marketplace.json"), {
      name: "ourostack",
    })
    const missingPluginsReport = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      plugins: ["desk"],
    })
    assert.equal(missingPluginsReport.plugins[0].repo_source_reason, "missing-marketplace-entry")
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("Codex plugin cache audit resolves relative marketplace paths from repo root", () => {
  const fixture = makeFixture()
  try {
    writeJson(path.join(fixture.repoRoot, "marketplace.json"), {
      name: "ourostack",
      plugins: [
        {
          name: "desk",
          source: { source: "local", path: "./plugins/desk" },
        },
      ],
    })
    const report = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      marketplacePath: "marketplace.json",
      plugins: ["desk"],
    })
    assert.equal(report.status, "current")
    assert.equal(report.marketplace_path, path.join(fixture.repoRoot, "marketplace.json"))
    assert.equal(report.plugins[0].repo_source_current, true)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("Codex plugin cache audit CLI covers strict and error paths", () => {
  const fixture = makeFixture()
  try {
    const stdout = []
    const stderr = []
    assert.equal(
      run({
        argv: [
          "--repo-root", fixture.repoRoot,
          "--codex-home", fixture.codexHome,
          "--cache-root", path.join(fixture.codexHome, "plugins", "cache"),
          "--marketplace", path.join(fixture.repoRoot, ".agents", "plugins", "marketplace.json"),
          "--plugins", "desk,work-suite",
          "--strict",
        ],
        stdout: { write: (text) => stdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
      }),
      0,
    )
    assert.equal(JSON.parse(stdout.join("")).status, "current")
    assert.equal(stderr.join(""), "")

    const relativeMarketplaceStdout = []
    assert.equal(
      run({
        argv: [
          "--repo-root", fixture.repoRoot,
          "--codex-home", fixture.codexHome,
          "--marketplace", ".agents/plugins/marketplace.json",
          "--plugins", "desk",
        ],
        stdout: { write: (text) => relativeMarketplaceStdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
      }),
      0,
    )
    assert.equal(JSON.parse(relativeMarketplaceStdout.join("")).marketplace_path, path.join(
      fixture.repoRoot,
      ".agents",
      "plugins",
      "marketplace.json",
    ))

    writeHostMarketplace(fixture.root, {
      plugins: [
        ["desk", "./repo/plugins/desk"],
      ],
    })
    const hostMarketplaceStdout = []
    assert.equal(
      run({
        argv: [
          "--repo-root", fixture.repoRoot,
          "--codex-home", fixture.codexHome,
          "--host-marketplace", path.join(fixture.root, ".agents", "plugins", "marketplace.json"),
          "--host-marketplace-root", fixture.root,
          "--plugins", "desk",
        ],
        stdout: { write: (text) => hostMarketplaceStdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
      }),
      0,
    )
    const hostMarketplaceReport = JSON.parse(hostMarketplaceStdout.join(""))
    assert.equal(hostMarketplaceReport.host_marketplace.provided, true)
    assert.equal(hostMarketplaceReport.host_marketplace.root, fixture.root)

    const disabledHostMarketplaceStdout = []
    assert.equal(
      run({
        argv: [
          "--repo-root", fixture.repoRoot,
          "--codex-home", fixture.codexHome,
          "--no-host-marketplace",
          "--plugins", "desk",
        ],
        stdout: { write: (text) => disabledHostMarketplaceStdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
      }),
      0,
    )
    assert.equal(JSON.parse(disabledHostMarketplaceStdout.join("")).host_marketplace.provided, false)

    rmSync(path.join(fixture.codexHome, "plugins", "cache"), { recursive: true, force: true })
    const staleStdout = []
    assert.equal(
      run({
        argv: ["--repo-root", fixture.repoRoot, "--codex-home", fixture.codexHome, "--strict"],
        stdout: { write: (text) => staleStdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
      }),
      1,
    )
    assert.equal(JSON.parse(staleStdout.join("")).status, "stale")

    const nonStrictStaleStdout = []
    assert.equal(
      run({
        argv: ["--repo-root", fixture.repoRoot, "--codex-home", fixture.codexHome],
        stdout: { write: (text) => nonStrictStaleStdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
      }),
      0,
    )
    assert.equal(JSON.parse(nonStrictStaleStdout.join("")).status, "stale")

    const stringStderr = []
    assert.equal(
      run({
        auditFn: () => {
          throw "plain audit failure"
        },
        stdout: { write: () => {} },
        stderr: { write: (text) => stringStderr.push(text) },
      }),
      1,
    )
    assert.equal(stringStderr.join(""), "plain audit failure\n")

    const errorStderr = []
    assert.equal(
      run({
        argv: ["--repo-root", path.join(fixture.root, "missing-repo")],
        stdout: { write: () => {} },
        stderr: { write: (text) => errorStderr.push(text) },
      }),
      1,
    )
    assert.match(errorStderr.join(""), /no such file|ENOENT/u)

    const missingActiveSnapshotStdout = []
    assert.equal(
      run({
        argv: ["--repo-root", fixture.repoRoot, "--codex-home", fixture.codexHome, "--strict-active"],
        stdout: { write: (text) => missingActiveSnapshotStdout.push(text) },
        stderr: { write: () => {} },
      }),
      1,
    )
    assert.equal(JSON.parse(missingActiveSnapshotStdout.join("")).active_session.status, "not_checked")

    const activeTools = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
    }).active_session.required
    const strictActiveStdout = []
    assert.equal(
      run({
        argv: [
          "--repo-root", fixture.repoRoot,
          "--codex-home", fixture.codexHome,
          "--active-tools", activeTools.map((name) => `desk:${name}`).join(","),
          "--strict-active",
        ],
        stdout: { write: (text) => strictActiveStdout.push(text) },
        stderr: { write: () => {} },
      }),
      0,
    )
    assert.equal(JSON.parse(strictActiveStdout.join("")).active_session.status, "pass")

    const activeToolsFile = path.join(fixture.root, "active-tools-cli.json")
    writeJson(activeToolsFile, { tools: activeTools.map((name) => ({ name })) })
    const strictActiveFileStdout = []
    assert.equal(
      run({
        argv: [
          "--repo-root", fixture.repoRoot,
          "--codex-home", fixture.codexHome,
          "--active-tools-file", activeToolsFile,
          "--strict-active",
        ],
        stdout: { write: (text) => strictActiveFileStdout.push(text) },
        stderr: { write: () => {} },
      }),
      0,
    )
    assert.equal(JSON.parse(strictActiveFileStdout.join("")).active_session.status, "pass")

    const missingValueStderr = []
    assert.equal(
      run({
        argv: ["--repo-root"],
        stdout: { write: () => {} },
        stderr: { write: (text) => missingValueStderr.push(text) },
      }),
      1,
    )
    assert.match(missingValueStderr.join(""), /--repo-root requires a value/u)

    const unknownArgStderr = []
    assert.equal(
      run({
        argv: ["--unknown"],
        stdout: { write: () => {} },
        stderr: { write: (text) => unknownArgStderr.push(text) },
      }),
      1,
    )
    assert.match(unknownArgStderr.join(""), /unknown argument/u)

    const tildeFileStderr = []
    assert.equal(
      run({
        argv: [
          "--repo-root", fixture.repoRoot,
          "--codex-home", fixture.codexHome,
          "--active-tools-file", "~",
        ],
        stdout: { write: () => {} },
        stderr: { write: (text) => tildeFileStderr.push(text) },
      }),
      1,
    )
    assert.match(tildeFileStderr.join(""), /EISDIR|illegal operation|directory/u)

    const homeRelativeFileStderr = []
    assert.equal(
      run({
        argv: [
          "--repo-root", fixture.repoRoot,
          "--codex-home", fixture.codexHome,
          "--active-tools-file", "~/definitely-missing-desk-active-tools.json",
        ],
        stdout: { write: () => {} },
        stderr: { write: (text) => homeRelativeFileStderr.push(text) },
      }),
      1,
    )
    assert.match(homeRelativeFileStderr.join(""), /ENOENT|no such file/u)

    assert.equal(startCli({ isMain: false }), null)
    const previousExitCode = process.exitCode
    try {
      assert.equal(startCli({ isMain: true, runFn: () => 0 }), 0)
      assert.equal(process.exitCode, 0)
    } finally {
      process.exitCode = previousExitCode
    }
    const exitCodes = []
    assert.equal(
      startCli({
        isMain: true,
        runFn: () => 7,
        setExitCode: (code) => exitCodes.push(code),
      }),
      7,
    )
    assert.deepEqual(exitCodes, [7])
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})
