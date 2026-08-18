import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(__dirname, "../..");
const deskPluginRoot = path.resolve(mcpRoot, "..");
const fixtureRoot = path.join(mcpRoot, "__tests__/fixtures/runtime");
const runtimeArtifactNames = new Set([
  ".desk-runtime-cache.json",
  "node_modules",
  "package-lock.json",
  "package.json",
  "runtime-cache",
  "source-mirror",
]);

const bootstrapModule = await import(pathToFileURL(path.join(mcpRoot, "src/runtime/bootstrap.js")).href);
const runtimeDepsModule = await import(pathToFileURL(path.join(mcpRoot, "src/runtime/runtime-deps.js")).href);
const {
  buildRuntimeDependencyPack,
  buildRuntimeSupportMatrix,
  deriveRuntimeSupportMatrixPath,
} = runtimeDepsModule;
const { prepareRuntime } = bootstrapModule;
const packageJson = readJson(path.join(mcpRoot, "package.json"));
const packageLock = readJson(path.join(mcpRoot, "package-lock.json"));

const tempRoots = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function makeTempRoot(prefix) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function makeUntrackedTempRoot(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function makeInstalledPluginFixture(tempRoot) {
  const pluginRoot = path.join(tempRoot, "installed", "desk");
  cpSync(deskPluginRoot, pluginRoot, {
    recursive: true,
    filter: (sourcePath) => {
      const relativePath = path.relative(deskPluginRoot, sourcePath);
      return relativePath === "" || (relativePath !== "mcp/node_modules" && !relativePath.startsWith(`mcp/node_modules${path.sep}`));
    },
  });
  const runtimeMcpRoot = path.join(pluginRoot, "mcp");
  buildRuntimeDependencyPack({
    mcpRoot,
    outputRoot: path.join(runtimeMcpRoot, "artifacts", "runtime-deps"),
    platform: process.platform,
    arch: process.arch,
    nodeAbi: process.versions.modules,
    createdAt: "1970-01-01T00:00:00.000Z",
    provenanceSource: "cache_and_launch.test installed plugin fixture",
  });
  const runtimePackageJson = readJson(path.join(runtimeMcpRoot, "package.json"));
  writeJson(
    deriveRuntimeSupportMatrixPath({
      mcpRoot: runtimeMcpRoot,
      packageJson: runtimePackageJson,
    }),
    buildRuntimeSupportMatrix({
      mcpRoot: runtimeMcpRoot,
      packageJson: runtimePackageJson,
    }),
  );
  return { pluginRoot, mcpRoot: runtimeMcpRoot };
}

function hasRuntimeDeps(cacheDir) {
  return (
    existsSync(path.join(cacheDir, "node_modules")) &&
    existsSync(path.join(cacheDir, "package.json")) &&
    existsSync(path.join(cacheDir, "package-lock.json"))
  );
}

function assertNoDeskStateRuntimeDeps(deskRoot) {
  assert.deepEqual(
    findRuntimeArtifactsUnder(path.join(deskRoot, ".state")),
    [],
    "runtime dependency artifacts must not be written anywhere under desk .state",
  );
}

function findRuntimeArtifactsUnder(rootPath) {
  if (!existsSync(rootPath)) return [];
  const matches = [];
  const walk = (current, relativePrefix = "") => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relativePath = path.join(relativePrefix, entry.name);
      const absolutePath = path.join(current, entry.name);
      if (runtimeArtifactNames.has(entry.name)) {
        matches.push(relativePath);
        if (entry.isDirectory()) continue;
      }
      if (entry.isDirectory()) walk(absolutePath, relativePath);
    }
  };
  walk(rootPath);
  return matches.sort();
}

function assertNoRuntimeArtifactsUnder(rootPath, message) {
  assert.deepEqual(findRuntimeArtifactsUnder(rootPath), [], message);
}

function listTree(dirPath, { skipPaths = [] } = {}) {
  if (!existsSync(dirPath)) return [];
  const entries = [];
  const walk = (current, relativePrefix = "") => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relativePath = path.join(relativePrefix, entry.name);
      const absolutePath = path.join(current, entry.name);
      if (skipPaths.some((skipPath) => absolutePath === skipPath || absolutePath.startsWith(`${skipPath}${path.sep}`))) {
        continue;
      }
      const stat = statSync(absolutePath);
      entries.push({
        path: relativePath,
        type: entry.isDirectory() ? "dir" : "file",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      if (entry.isDirectory()) walk(absolutePath, relativePath);
    }
  };
  walk(dirPath);
  return entries;
}

function snapshotPath(targetPath) {
  if (!existsSync(targetPath)) return { exists: false };
  const stat = statSync(targetPath);
  if (!stat.isDirectory()) {
    return {
      exists: true,
      type: "file",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  }
  return {
    exists: true,
    type: "dir",
    entries: listTree(targetPath),
  };
}

function forbiddenPluginArtifactPathsFor({ pluginRoot, mcpRoot }) {
  return [
    path.join(pluginRoot, ".desk-runtime-cache.json"),
    path.join(pluginRoot, ".state"),
    path.join(pluginRoot, "node_modules"),
    path.join(pluginRoot, "runtime-cache"),
    path.join(pluginRoot, "source-mirror"),
    path.join(mcpRoot, ".desk-runtime-cache.json"),
    path.join(mcpRoot, ".state"),
    path.join(mcpRoot, "node_modules"),
    path.join(mcpRoot, "runtime-cache"),
    path.join(mcpRoot, "source-mirror"),
  ];
}

function snapshotImmutableState({ pluginRoot, mcpRoot }) {
  return {
    pluginRoot,
    pluginArtifacts: new Map(forbiddenPluginArtifactPathsFor({ pluginRoot, mcpRoot }).map((targetPath) => [targetPath, snapshotPath(targetPath)])),
    pluginSourceTree: listTree(pluginRoot),
  };
}

function assertImmutableStateUnchanged(before) {
  assert.deepEqual(
    listTree(before.pluginRoot),
    before.pluginSourceTree,
    `${before.pluginRoot} plugin source must not be mutated by runtime startup`,
  );
  for (const [targetPath, expected] of before.pluginArtifacts.entries()) {
    assert.deepEqual(snapshotPath(targetPath), expected, `${targetPath} must not be created or mutated by runtime startup`);
  }
}

function mcpServerFromConfig(configPath) {
  const config = readJson(configPath);
  assert.ok(config.mcpServers?.desk, `${configPath} should declare a desk MCP server`);
  return config.mcpServers.desk;
}

function mcpServerFromManifest(manifestPath, { pluginRoot = deskPluginRoot } = {}) {
  const manifest = readJson(manifestPath);
  if (typeof manifest.mcpServers === "string") {
    const configPath = path.resolve(pluginRoot, manifest.mcpServers);
    assert.equal(existsSync(configPath), true, `${manifestPath} mcpServers must resolve relative to the installed plugin root: ${configPath}`);
    return mcpServerFromConfig(configPath);
  }
  assert.ok(manifest.mcpServers?.desk, `${manifestPath} should declare or reference a desk MCP server`);
  return manifest.mcpServers.desk;
}

function manifestCases(pluginRoot = deskPluginRoot) {
  return [
    {
      id: "desk plugin.json",
      sourcePath: path.join(pluginRoot, "plugin.json"),
    },
    {
      id: "codex plugin.json",
      sourcePath: path.join(pluginRoot, ".codex-plugin/plugin.json"),
    },
    {
      id: "claude plugin.json",
      sourcePath: path.join(pluginRoot, ".claude-plugin/plugin.json"),
    },
  ];
}

function declarationCases(pluginRoot = deskPluginRoot) {
  return [
    {
      id: "agency shared .mcp.json",
      sourcePath: path.join(pluginRoot, ".mcp.json"),
      configBaseDir: pluginRoot,
      expandTokens: ["CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT"],
      resolveRelativeCwdFromConfig: false,
      resolveServer: () => mcpServerFromConfig(path.join(pluginRoot, ".mcp.json")),
    },
    {
      id: "desk plugin.json",
      sourcePath: path.join(pluginRoot, "plugin.json"),
      configBaseDir: pluginRoot,
      expandTokens: ["COPILOT_PLUGIN_ROOT"],
      resolveRelativeCwdFromConfig: false,
      resolveServer: () => mcpServerFromManifest(path.join(pluginRoot, "plugin.json"), { pluginRoot }),
    },
    {
      id: "codex plugin.json",
      sourcePath: path.join(pluginRoot, ".codex-plugin/plugin.json"),
      configBaseDir: pluginRoot,
      expandTokens: [],
      resolveRelativeCwdFromConfig: true,
      resolveServer: () => mcpServerFromManifest(path.join(pluginRoot, ".codex-plugin/plugin.json"), { pluginRoot }),
    },
    {
      id: "claude plugin.json",
      sourcePath: path.join(pluginRoot, ".claude-plugin/plugin.json"),
      configBaseDir: pluginRoot,
      expandTokens: ["CLAUDE_PLUGIN_ROOT"],
      resolveRelativeCwdFromConfig: false,
      resolveServer: () => mcpServerFromManifest(path.join(pluginRoot, ".claude-plugin/plugin.json"), { pluginRoot }),
    },
    {
      id: "generic stdio fixture",
      sourcePath: path.join(pluginRoot, "mcp/__tests__/fixtures/runtime/host-launch/generic-stdio.mcp.json"),
      configBaseDir: path.join(pluginRoot, "mcp/__tests__/fixtures/runtime/host-launch"),
      expandTokens: [],
      resolveRelativeCwdFromConfig: true,
      resolveServer: () => mcpServerFromConfig(path.join(pluginRoot, "mcp/__tests__/fixtures/runtime/host-launch/generic-stdio.mcp.json")),
    },
  ];
}

function staticLaunchConfigCases() {
  return declarationCases();
}

function rawEntrypointConfigCases(pluginRoot = deskPluginRoot) {
  return [
    {
      id: "desk .mcp.json",
      sourcePath: path.join(pluginRoot, ".mcp.json"),
      expectedArgs: [
        "-e",
        "const fs=require('node:fs');const path=require('node:path');const {pathToFileURL}=require('node:url');const configured=process.env.DESK_PLUGIN_ROOT;const root=configured&&fs.existsSync(path.join(configured,'mcp','index.js'))?configured:process.cwd();process.env.DESK_PLUGIN_ROOT=root;import(pathToFileURL(path.join(root,'mcp','index.js')).href).then(({main})=>main()).catch((error)=>{console.error(error);process.exitCode=1});",
      ],
      expectedCwd: ".",
      expectedEnv: {
        DESK_PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}",
      },
    },
    {
      id: "desk .mcp.copilot.json",
      sourcePath: path.join(pluginRoot, ".mcp.copilot.json"),
      expectedArgs: ["${COPILOT_PLUGIN_ROOT}/mcp/index.js"],
      expectedCwd: undefined,
      expectedEnv: {},
    },
  ];
}

function assertNoUnsupportedLaunchPlaceholders(id, value) {
  if (typeof value === "string") {
    assert.equal(value.includes("${pluginRoot}"), false, `${id} must not rely on undocumented \${pluginRoot} substitution`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoUnsupportedLaunchPlaceholders(id, item);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      assertNoUnsupportedLaunchPlaceholders(id, item);
    }
  }
}

function materializeHostLaunch(server, {
  configBaseDir,
  expandTokens,
  processCwd,
  resolveRelativeCwdFromConfig,
}) {
  assertNoUnsupportedLaunchPlaceholders("MCP launch config", server);
  const expandedCwd = expandSupportedHostTokens(server.cwd ?? ".", {
    pluginRoot: configBaseDir,
    expandTokens,
  });
  const cwd = path.isAbsolute(expandedCwd)
    ? expandedCwd
    : path.resolve(resolveRelativeCwdFromConfig ? configBaseDir : processCwd, expandedCwd);
  const commandValue = expandSupportedHostTokens(server.command, {
    pluginRoot: configBaseDir,
    expandTokens,
  });
  const command = pathLikeLaunchValue(commandValue)
    ? path.resolve(cwd, commandValue)
    : commandValue;
  const args = (server.args ?? []).map((arg) => {
    const value = expandSupportedHostTokens(arg, {
      pluginRoot: configBaseDir,
      expandTokens,
    });
    return pathLikeLaunchValue(value) ? path.resolve(cwd, value) : value;
  });
  const env = Object.fromEntries(
    Object.entries(server.env ?? {}).map(([name, value]) => [
      name,
      expandSupportedHostTokens(value, {
        pluginRoot: configBaseDir,
        expandTokens,
      }),
    ]),
  );
  return {
    command,
    args,
    cwd,
    env,
  };
}

function expandSupportedHostTokens(value, { pluginRoot, expandTokens }) {
  if (typeof value !== "string") return value;
  return expandTokens.reduce(
    (expanded, token) => expanded.replaceAll(`\${${token}}`, pluginRoot),
    value,
  );
}

function pathLikeLaunchValue(value) {
  return typeof value === "string"
    && (value.startsWith("./") || value.startsWith("../") || path.isAbsolute(value));
}

function assertPluginScopedLaunchArgs(id, declaration) {
  const server = declaration.resolveServer();
  assert.equal(server.command, "node", `${id} must launch through the host-provided node command`);
  assertNoUnsupportedLaunchPlaceholders(id, server);
  const launch = materializeHostLaunch(server, {
    ...declaration,
    processCwd: makeTempRoot("desk-host-contract-cwd-"),
  });
  const entrypointArg = launch.args.find((arg) => arg.replaceAll("\\", "/").endsWith("/mcp/index.js"));
  if (entrypointArg) {
    assert.equal(path.isAbsolute(entrypointArg), true, `${id} MCP entrypoint arg must materialize to an absolute installed path`);
    assert.equal(existsSync(entrypointArg), true, `${id} materialized MCP entrypoint must exist`);
    return;
  }
  assert.equal(launch.args[0], "-e", `${id} must use the shared Node bootstrap when it has no direct entrypoint arg`);
  assert.match(launch.args[1], /DESK_PLUGIN_ROOT/u, `${id} shared bootstrap must resolve the installed Desk root`);
  const envRoot = launch.env.DESK_PLUGIN_ROOT;
  assert.equal(
    envRoot === declaration.configBaseDir || launch.cwd === declaration.configBaseDir,
    true,
    `${id} must provide the installed plugin root through the environment or resolved cwd`,
  );
}

function makeMcpEnvelope(id, method, params = {}) {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

function waitForResponse(child, id, stderrChunks, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let stdoutBuffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for response ${id}. stderr:\n${stderrChunks.join("")}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`MCP process exited before response ${id} (code=${code}, signal=${signal}). stderr:\n${stderrChunks.join("")}`));
    };

    const onStdout = (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === id) {
          cleanup();
          resolve(message);
          return;
        }
      }
    };

    child.stdout.on("data", onStdout);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function runListToolsSession({ command, args, cwd, env }) {
  const stderrChunks = [];
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk.toString("utf8")));
  const closePromise = new Promise((resolve) => child.once("close", resolve));

  try {
    child.stdin.write(makeMcpEnvelope(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "cache-and-launch-test", version: "1.0.0" },
    }));
    const init = await waitForResponse(child, 1, stderrChunks);
    assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);

    child.stdin.write(makeMcpEnvelope(2, "tools/list"));
    const tools = await waitForResponse(child, 2, stderrChunks);
    assert.equal(tools.error, undefined, `tools/list failed: ${JSON.stringify(tools.error)}`);
    assert.ok(Array.isArray(tools.result?.tools), "tools/list should return tools");
    assert.ok(tools.result.tools.some((tool) => tool.name === "task_create"), "desk task_create tool should be available");
    return tools;
  } finally {
    child.kill("SIGTERM");
    await closePromise;
  }
}

async function runIndexListTools({ runtimeMcpRoot = mcpRoot, args, cwd, env }) {
  return runListToolsSession({
    command: process.execPath,
    args: [path.join(runtimeMcpRoot, "index.js"), ...args],
    cwd,
    env,
  });
}

function makeDeskHome(tempRoot) {
  const homeDir = ensureDir(path.join(tempRoot, "home"));
  const deskRoot = ensureDir(path.join(homeDir, "ms-desk"));
  return { homeDir, deskRoot };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function prependNodeShimToPath(tempRoot, existingPath) {
  const binDir = ensureDir(path.join(tempRoot, "bin"));
  const invocationLogPath = path.join(tempRoot, "node-shim-invocations.log");
  if (process.platform === "win32") {
    writeFileSync(path.join(binDir, "node.cmd"), `@echo node %*>>"${invocationLogPath}"\r\n@"${process.execPath}" %*\r\n`);
  } else {
    const shimPath = path.join(binDir, "node");
    writeFileSync(shimPath, `#!/bin/sh\nprintf '%s\\n' "node $*" >> ${shellQuote(invocationLogPath)}\nexec ${shellQuote(process.execPath)} "$@"\n`);
    chmodSync(shimPath, 0o755);
  }
  return {
    invocationLogPath,
    path: [binDir, existingPath ?? ""].filter(Boolean).join(path.delimiter),
  };
}

describe("runtime cache and host launch contract", () => {
  it("resolves committed host manifest MCP references relative to the installed plugin root", async (t) => {
    for (const manifest of manifestCases()) {
      await t.test(manifest.id, () => {
        const server = mcpServerFromManifest(manifest.sourcePath);
        assert.equal(server.type, "stdio", `${manifest.id} should resolve a stdio MCP server`);
        assert.ok(Array.isArray(server.args), `${manifest.id} should resolve launch args`);
      });
    }
  });

  it("committed MCP launch configs use plugin-scoped or explicitly cwd-scoped entrypoint args", async (t) => {
    for (const declaration of staticLaunchConfigCases()) {
      await t.test(declaration.id, () => {
        assertPluginScopedLaunchArgs(declaration.id, declaration);
      });
    }
  });

  it("committed Desk MCP config files keep distinct raw host entrypoint contracts", async (t) => {
    for (const declaration of rawEntrypointConfigCases()) {
      await t.test(declaration.id, () => {
        const server = mcpServerFromConfig(declaration.sourcePath);
        assert.deepEqual(server.args, declaration.expectedArgs);
        assert.equal(server.cwd, declaration.expectedCwd);
        assert.deepEqual(server.env ?? {}, declaration.expectedEnv);
      });
    }
  });

  it("uses activation-config runtimeCacheDir before DESK_RUNTIME_CACHE_DIR and never writes runtime deps under desk .state", async () => {
    const tempRoot = makeTempRoot("desk-runtime-cache-config-");
    const installed = makeInstalledPluginFixture(tempRoot);
    const { homeDir, deskRoot } = makeDeskHome(tempRoot);
    const activationCache = ensureDir(path.join(tempRoot, "activation-cache"));
    const envCache = ensureDir(path.join(tempRoot, "env-cache"));
    const xdgCache = ensureDir(path.join(tempRoot, "xdg-cache"));
    const activationConfigPath = path.join(tempRoot, "activation.json");
    writeJson(activationConfigPath, {
      schema_version: 1,
      desk: { root: deskRoot },
      runtimeCacheDir: activationCache,
    });

    await runIndexListTools({
      runtimeMcpRoot: installed.mcpRoot,
      args: ["--activation-config", activationConfigPath],
      cwd: makeTempRoot("desk-runtime-cache-cwd-"),
      env: {
        ...process.env,
        DESK: "",
        DESK_RUNTIME_CACHE_DIR: envCache,
        XDG_CACHE_HOME: xdgCache,
        HOME: homeDir,
      },
    });

    assert.equal(hasRuntimeDeps(activationCache), true, "activation config runtimeCacheDir should receive runtime dependencies");
    assertNoRuntimeArtifactsUnder(envCache, "DESK_RUNTIME_CACHE_DIR should not be used when activation config supplies runtimeCacheDir");
    assertNoRuntimeArtifactsUnder(path.join(xdgCache, "ouroboros-skills", "desk"), "XDG cache fallback should not be used");
    assertNoDeskStateRuntimeDeps(deskRoot);
  });

  it("launches every committed host declaration from a temporary cwd without mutating plugin source/cache directories", async (t) => {
    const installRoot = makeUntrackedTempRoot("desk-host-launch-install-");
    try {
      const installed = makeInstalledPluginFixture(installRoot);
      const before = snapshotImmutableState(installed);

      for (const declaration of declarationCases(installed.pluginRoot)) {
        await t.test(declaration.id, async () => {
          const tempRoot = makeTempRoot("desk-host-launch-");
          const { homeDir } = makeDeskHome(tempRoot);
          const runtimeCacheDir = ensureDir(path.join(tempRoot, "runtime-cache"));
          const server = declaration.resolveServer();
          const nodeShim = prependNodeShimToPath(tempRoot, process.env.PATH);
          const launch = materializeHostLaunch(server, {
            ...declaration,
            processCwd: tempRoot,
          });

          await runListToolsSession({
            command: launch.command,
            args: launch.args,
            cwd: launch.cwd,
            env: {
              ...process.env,
              ...launch.env,
              DESK: "",
              DESK_RUNTIME_CACHE_DIR: runtimeCacheDir,
              HOME: homeDir,
              PATH: nodeShim.path,
            },
          });
          if (process.platform !== "win32") {
            assert.match(readFileSync(nodeShim.invocationLogPath, "utf8"), /^node .+/u, `${declaration.id} must launch through the controlled node PATH shim`);
          }
        });
      }

      assertImmutableStateUnchanged(before);
    } finally {
      rmSync(installRoot, { recursive: true, force: true });
    }
  });

  it("repairs cached runtime dependencies when the cache marker and dependency artifacts are stale", async () => {
    const tempRoot = makeTempRoot("desk-runtime-cache-marker-");
    const installed = makeInstalledPluginFixture(tempRoot);
    const runtimeCacheDir = ensureDir(path.join(tempRoot, "runtime-cache"));

    prepareRuntime({ mcpRoot: installed.mcpRoot, env: process.env, runtimeCacheDir });
    const markerPath = path.join(runtimeCacheDir, ".desk-runtime-cache.json");
    const marker = readJson(markerPath);
    marker.plugin.version = "0.0.0-incompatible";
    writeJson(markerPath, marker);
    const cachedPackageJsonPath = path.join(runtimeCacheDir, "package.json");
    const cachedPackageJson = readJson(cachedPackageJsonPath);
    cachedPackageJson.version = "0.0.0-incompatible";
    writeJson(cachedPackageJsonPath, cachedPackageJson);
    const staleRuntimeArtifactPath = path.join(runtimeCacheDir, "node_modules/.stale-runtime-artifact");
    writeFileSync(staleRuntimeArtifactPath, "stale runtime artifact\n");

    prepareRuntime({ mcpRoot: installed.mcpRoot, env: process.env, runtimeCacheDir });
    const repairedMarker = readJson(markerPath);
    const repairedPackageJson = readJson(cachedPackageJsonPath);

    assert.equal(repairedMarker.plugin.version, packageJson.version, "runtime cache marker should be repaired from the committed pack");
    assert.equal(repairedPackageJson.version, packageJson.version, "runtime cache package.json should be restored from the committed pack");
    assert.equal(existsSync(staleRuntimeArtifactPath), false, "stale runtime dependency artifacts should be removed during cache repair");
  });

  it("repairs cached runtime dependencies when a required runtime file is missing despite current metadata", async () => {
    const tempRoot = makeTempRoot("desk-runtime-cache-required-file-");
    const installed = makeInstalledPluginFixture(tempRoot);
    const runtimeCacheDir = ensureDir(path.join(tempRoot, "runtime-cache"));

    prepareRuntime({ mcpRoot: installed.mcpRoot, env: process.env, runtimeCacheDir });
    const requiredRuntimeFile = path.join(
      runtimeCacheDir,
      "node_modules",
      "@modelcontextprotocol",
      "sdk",
      "dist",
      "esm",
      "server",
      "index.js",
    );
    assert.equal(existsSync(requiredRuntimeFile), true, "test setup should restore the MCP SDK runtime file");
    rmSync(requiredRuntimeFile, { force: true });

    prepareRuntime({ mcpRoot: installed.mcpRoot, env: process.env, runtimeCacheDir });

    assert.equal(existsSync(requiredRuntimeFile), true, "current-marked caches missing required runtime files should be repaired");
  });
});
