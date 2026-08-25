#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  auditCodexPluginCache,
  run,
} = require("./audit-codex-plugin-cache.cjs");

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, value) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function manifest(name, version, extra = {}) {
  return {
    name,
    version,
    skills: "./skills/",
    activation: {
      codex: {
        marker: `${name}-${version}`,
      },
    },
    ...extra,
  };
}

function writePlugin(root, name, version, extra = {}) {
  writeJson(
    path.join(root, "plugins", name, ".codex-plugin", "plugin.json"),
    manifest(name, version, extra),
  );
}

function writeCache(codexHome, name, version, value, namespace = "ourostack") {
  writeJson(
    path.join(codexHome, "plugins", "cache", namespace, name, version, ".codex-plugin", "plugin.json"),
    value,
  );
}

function makeFixture({ namespace = "ourostack" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-cache-audit-"));
  const repoRoot = path.join(root, "repo");
  const codexHome = path.join(root, "codex-home");
  mkdirp(repoRoot);
  writePlugin(repoRoot, "desk", "1.7.3");
  writePlugin(repoRoot, "work-suite", "1.4.9");
  writePlugin(repoRoot, "plain-language", "0.1.0");
  writeJson(path.join(repoRoot, ".agents", "plugins", "marketplace.json"), {
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
    ],
  });
  writeCache(codexHome, "desk", "1.7.3", manifest("desk", "1.7.3"), namespace);
  writeCache(codexHome, "work-suite", "1.4.9", manifest("work-suite", "1.4.9"), namespace);
  writeCache(codexHome, "plain-language", "0.1.0", manifest("plain-language", "0.1.0"), namespace);
  return { root, repoRoot, codexHome };
}

function testCurrentFixture() {
  const fixture = makeFixture();
  try {
    const report = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
    });
    assert.equal(report.status, "current");
    assert.equal(report.marketplace_namespace, "ourostack");
    assert.equal(report.host_marketplace.provided, false);
    assert.equal(report.host_marketplace.current, true);
    assert.equal(report.plugins.length, 3);
    for (const plugin of report.plugins) {
      assert.equal(plugin.marketplace_namespace, "ourostack");
      assert.equal(plugin.repo_source_current, true);
      assert.equal(plugin.installed_cache_current, true);
      assert.equal(plugin.active_session_visible, "not_checked");
    }
    assert.match(
      report.evidence_states.active_session_visible,
      /optional active MCP tool snapshot/u,
    );
    assert.equal(report.active_session.status, "not_checked");
    assert.equal(report.active_session.provided, false);
    assert.ok(report.active_session.required.includes("desk_status"));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function writeHostMarketplace(root, plugins) {
  writeJson(path.join(root, ".agents", "plugins", "marketplace.json"), {
    name: "ourostack",
    plugins: plugins.map(([name, sourcePath]) => ({
      name,
      source: { source: "local", path: sourcePath },
    })),
  });
}

function testHostMarketplaceCurrentAndDrift() {
  const fixture = makeFixture();
  try {
    writeHostMarketplace(fixture.root, [
      ["desk", "./repo/plugins/desk"],
      ["work-suite", "./repo/plugins/work-suite"],
      ["plain-language", "./repo/plugins/plain-language"],
    ]);
    const current = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
    });
    assert.equal(current.status, "current");
    assert.equal(current.host_marketplace.provided, true);
    assert.equal(current.host_marketplace.current, true);
    assert.equal(current.host_marketplace.reason, "current");

    writePlugin(fixture.root, "desk", "1.7.2");
    writePlugin(fixture.root, "work-suite", "1.4.8");
    writePlugin(fixture.root, "plain-language", "0.0.9");
    writeHostMarketplace(fixture.root, [
      ["desk", "./plugins/desk"],
      ["work-suite", "./plugins/work-suite"],
      ["plain-language", "./plugins/plain-language"],
    ]);
    const stale = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
    });
    assert.equal(stale.status, "stale");
    assert.equal(stale.host_marketplace.provided, true);
    assert.equal(stale.host_marketplace.current, false);
    assert.equal(stale.host_marketplace.reason, "source-drift");
    assert.equal(stale.host_marketplace.plugins.find((plugin) => plugin.name === "desk").reason, "manifest-drift");
    assert.match(stale.host_marketplace.guidance, /Repoint ~\/\.agents\/plugins\/marketplace\.json/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function testActiveToolSnapshot() {
  const fixture = makeFixture();
  try {
    const required = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
    }).active_session.required;
    const report = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      activeTools: required,
    });
    assert.equal(report.status, "current");
    assert.equal(report.active_session.status, "pass");
    assert.deepEqual(report.active_session.missing, []);
    assert.ok(report.active_session.present.includes("desk_status"));
    assert.equal(report.plugins.find((plugin) => plugin.name === "desk").active_session_visible, true);
    assert.equal(report.plugins.find((plugin) => plugin.name === "work-suite").active_session_visible, "not_checked");

    const prefixed = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      activeTools: required.map((name) => `mcp__desk__${name}`),
    });
    assert.equal(prefixed.active_session.status, "pass");

    const missingStatus = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      activeTools: required.filter((name) => name !== "desk_status"),
    });
    assert.equal(missingStatus.status, "current");
    assert.equal(missingStatus.active_session.status, "fail");
    assert.deepEqual(missingStatus.active_session.missing, ["desk_status"]);
    assert.equal(missingStatus.plugins.find((plugin) => plugin.name === "desk").active_session_visible, false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function testActiveToolSnapshotFileAndStrictMode() {
  const fixture = makeFixture();
  const activeToolsFile = path.join(fixture.root, "active-tools.json");
  try {
    const required = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
    }).active_session.required;
    writeJson(activeToolsFile, {
      tools: required.map((name) => ({ name: `mcp__desk.${name}` })),
    });

    const stdout = [];
    const stderr = [];
    const exitCode = run({
      argv: [
        "--repo-root", fixture.repoRoot,
        "--codex-home", fixture.codexHome,
        "--active-tools-file", activeToolsFile,
        "--strict-active",
      ],
      stdout: { write: (text) => stdout.push(text) },
      stderr: { write: (text) => stderr.push(text) },
    });
    assert.equal(exitCode, 0);
    assert.equal(JSON.parse(stdout.join("")).active_session.status, "pass");
    assert.equal(stderr.join(""), "");

    const missingSnapshotExit = run({
      argv: ["--repo-root", fixture.repoRoot, "--codex-home", fixture.codexHome, "--strict-active"],
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    assert.equal(missingSnapshotExit, 1);

    const missingValueStderr = [];
    const missingValueExit = run({
      argv: ["--repo-root"],
      stdout: { write: () => {} },
      stderr: { write: (text) => missingValueStderr.push(text) },
    });
    assert.equal(missingValueExit, 1);
    assert.match(missingValueStderr.join(""), /--repo-root requires a value/u);

    const unknownStderr = [];
    const unknownExit = run({
      argv: ["--what"],
      stdout: { write: () => {} },
      stderr: { write: (text) => unknownStderr.push(text) },
    });
    assert.equal(unknownExit, 1);
    assert.match(unknownStderr.join(""), /unknown argument/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function testStaleSourceAndCache() {
  const fixture = makeFixture();
  try {
    writePlugin(fixture.repoRoot, "desk", "1.7.3", { description: "new source" });
    writeCache(fixture.codexHome, "work-suite", "1.4.9", manifest("work-suite", "1.4.9", {
      description: "old cache",
    }));

    const report = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
    });
    const desk = report.plugins.find((plugin) => plugin.name === "desk");
    const workSuite = report.plugins.find((plugin) => plugin.name === "work-suite");

    assert.equal(report.status, "stale");
    assert.equal(desk.repo_source_current, true);
    assert.equal(desk.installed_cache_current, false);
    assert.equal(desk.installed_cache_reason, "manifest-drift");
    assert.equal(workSuite.repo_source_current, true);
    assert.equal(workSuite.installed_cache_current, false);
    assert.equal(workSuite.installed_cache_reason, "manifest-drift");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function testAlternateMarketplaceNamespace() {
  const fixture = makeFixture({ namespace: "contoso" });
  try {
    const report = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
    });
    assert.equal(report.status, "current");
    assert.equal(report.marketplace_namespace, "contoso");
    assert.ok(report.plugins.every((plugin) => (
      plugin.installed_cache_path.includes(path.join("plugins", "cache", "contoso"))
    )));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function testMissingMarketplaceSource() {
  const fixture = makeFixture();
  try {
    writeJson(path.join(fixture.repoRoot, ".agents", "plugins", "marketplace.json"), {
      name: "ourostack",
      plugins: [
        {
          name: "desk",
          source: { source: "local", path: "./missing-desk" },
        },
      ],
    });
    const report = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      plugins: ["desk"],
    });
    assert.equal(report.status, "stale");
    assert.equal(report.plugins[0].repo_source_current, false);
    assert.equal(report.plugins[0].repo_source_reason, "missing");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function testMissingMarketplaceEntryAndSourceObject() {
  const fixture = makeFixture();
  try {
    writeJson(path.join(fixture.repoRoot, ".agents", "plugins", "marketplace.json"), {
      name: "ourostack",
      plugins: [
        {
          name: "desk",
          source: false,
        },
      ],
    });
    const report = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      plugins: ["desk", "work-suite"],
    });
    assert.equal(report.status, "stale");
    assert.equal(report.plugins[0].repo_source_reason, "missing-marketplace-source");
    assert.equal(report.plugins[1].repo_source_reason, "missing-marketplace-entry");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function testRelativeMarketplacePathAndMissingNameFallback() {
  const fixture = makeFixture();
  try {
    writeJson(path.join(fixture.repoRoot, "marketplace.json"), {
      plugins: [
        {
          name: "desk",
          source: { source: "local", path: "./plugins/desk" },
        },
      ],
    });
    const report = auditCodexPluginCache({
      repoRoot: fixture.repoRoot,
      codexHome: fixture.codexHome,
      marketplacePath: "marketplace.json",
      plugins: ["desk"],
    });
    assert.equal(report.marketplace_namespace, "unknown");
    assert.equal(report.plugins[0].repo_source_current, true);
    assert.equal(report.plugins[0].installed_cache_current, false);
    assert.equal(report.plugins[0].installed_cache_reason, "missing");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function testCliStrictMode() {
  const fixture = makeFixture();
  try {
    fs.rmSync(path.join(fixture.codexHome, "plugins", "cache"), { recursive: true, force: true });
    const stdout = [];
    const stderr = [];
    const exitCode = run({
      argv: ["--repo-root", fixture.repoRoot, "--codex-home", fixture.codexHome, "--strict"],
      stdout: { write: (text) => stdout.push(text) },
      stderr: { write: (text) => stderr.push(text) },
    });
    const report = JSON.parse(stdout.join(""));
    assert.equal(exitCode, 1);
    assert.equal(report.status, "stale");
    assert.equal(stderr.join(""), "");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

testCurrentFixture();
testHostMarketplaceCurrentAndDrift();
testActiveToolSnapshot();
testActiveToolSnapshotFileAndStrictMode();
testStaleSourceAndCache();
testAlternateMarketplaceNamespace();
testMissingMarketplaceSource();
testMissingMarketplaceEntryAndSourceObject();
testRelativeMarketplacePathAndMissingNameFallback();
testCliStrictMode();

console.log("Codex plugin cache audit tests passed.");
