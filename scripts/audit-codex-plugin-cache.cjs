#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const defaultPlugins = Object.freeze(["desk", "work-suite", "plain-language", "ponytail-upstream"]);
const fallbackDeskMcpTools = Object.freeze([
  "task_create",
  "task_update",
  "task_archive",
  "track_create",
  "track_update",
  "friction_add",
  "lesson_add",
  "desk_search",
  "desk_recall",
  "desk_similar",
  "desk_timeline",
  "desk_thread",
  "desk_reindex",
  "desk_status",
]);

function expandHome(inputPath) {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return readJson(filePath);
}

function normalizeToolName(value) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const prefixes = [
    "mcp__desk.",
    "mcp__desk__",
    "mcp__desk/",
    "mcp__desk:",
    "desk.",
    "desk/",
    "desk:",
  ];
  for (const prefix of prefixes) {
    if (trimmed.startsWith(prefix)) return [trimmed.slice(prefix.length)];
  }
  return [trimmed];
}

function normalizeActiveToolNames(value) {
  if (Array.isArray(value)) return value.flatMap(normalizeActiveToolNames);
  if (typeof value === "string") return normalizeToolName(value);
  if (value && typeof value === "object") {
    if (typeof value.name === "string") return normalizeToolName(value.name);
    for (const key of ["tools", "availableTools", "activeTools", "mcpTools"]) {
      if (Array.isArray(value[key])) return normalizeActiveToolNames(value[key]);
    }
  }
  return [];
}

function sameJson(left, right) {
  return stableStringify(left) === stableStringify(right);
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

function pluginManifestPath(root, pluginName) {
  return path.join(root, "plugins", pluginName, ".codex-plugin", "plugin.json");
}

function marketplacePlugin(marketplace, pluginName) {
  return (marketplace.plugins ?? []).find((plugin) => plugin.name === pluginName) ?? null;
}

function marketplaceNamespace(marketplace) {
  return typeof marketplace?.name === "string" && marketplace.name.trim().length > 0
    ? marketplace.name.trim()
    : "unknown";
}

function marketplaceSourcePath({ repoRoot, marketplacePath, plugin }) {
  const sourcePath = plugin?.source?.path;
  if (typeof sourcePath !== "string" || sourcePath.trim().length === 0) return null;
  return path.resolve(repoRoot, sourcePath);
}

function defaultHostMarketplacePath(codexHome) {
  return path.join(path.dirname(codexHome), ".agents", "plugins", "marketplace.json");
}

function defaultHostMarketplaceRoot(hostMarketplacePath) {
  return path.dirname(path.dirname(path.dirname(hostMarketplacePath)));
}

function cacheManifestPath({ cacheRoot, namespace, pluginName, version }) {
  return path.join(
    cacheRoot,
    namespace,
    pluginName,
    version,
    ".codex-plugin",
    "plugin.json",
  );
}

function compareManifest(actual, expected) {
  if (actual === null) {
    return { current: false, reason: "missing" };
  }
  if (!sameJson(actual, expected)) {
    return { current: false, reason: "manifest-drift" };
  }
  return { current: true, reason: "current" };
}

function requiredDeskMcpTools(repoRoot) {
  const toolNamesPath = path.join(repoRoot, "plugins", "desk", "mcp", "src", "tool-names.js");
  const source = fs.existsSync(toolNamesPath) ? fs.readFileSync(toolNamesPath, "utf8") : "";
  const match = source.match(/export\s+const\s+TOOL_NAMES\s*=\s*\[([\s\S]*?)\]/u);
  if (!match) return [...fallbackDeskMcpTools];
  const names = [...match[1].matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]);
  return names.length > 0 ? names : [...fallbackDeskMcpTools];
}

function collectActiveTools({ repoRoot, activeTools = null, activeToolsFiles = [] }) {
  let active = activeTools ? new Set(normalizeActiveToolNames(activeTools)) : null;
  for (const file of activeToolsFiles) {
    const absolute = path.resolve(repoRoot, expandHome(file));
    active = active ?? new Set();
    for (const name of normalizeActiveToolNames(readJson(absolute))) {
      active.add(name);
    }
  }
  return active;
}

function auditActiveTools(activeTools, requiredTools = [...fallbackDeskMcpTools]) {
  if (!activeTools) {
    return {
      provided: false,
      status: "not_checked",
      required: [...requiredTools],
      present: [],
      missing: [],
      guidance: "No active host MCP tool snapshot was provided. Repo and cache state can be current while the running Codex session still needs a reload.",
    };
  }

  const missing = requiredTools.filter((name) => !activeTools.has(name));
  const present = requiredTools.filter((name) => activeTools.has(name));
  return {
    provided: true,
    status: missing.length === 0 ? "pass" : "fail",
    required: [...requiredTools],
    present,
    missing,
    guidance: missing.length === 0
      ? "All required Desk MCP tools were visible in the active host tool snapshot."
      : "Desk MCP is not fully visible in the active host session. Run desk:codex-onboarding or the Codex repair checklist, then restart/open a fresh Codex session before treating Desk as healthy.",
  };
}

function auditPlugin({ repoRoot, cacheRoot, marketplace, marketplacePath, namespace, pluginName }) {
  const repoManifestPath = pluginManifestPath(repoRoot, pluginName);
  const repoManifest = readJson(repoManifestPath);
  const marketplaceEntry = marketplacePlugin(marketplace, pluginName);
  const sourceRoot = marketplaceSourcePath({ repoRoot, marketplacePath, plugin: marketplaceEntry });
  const sourceManifestPath = sourceRoot === null
    ? null
    : path.join(sourceRoot, ".codex-plugin", "plugin.json");
  const sourceComparison = marketplaceEntry === null
    ? { current: false, reason: "missing-marketplace-entry" }
    : sourceManifestPath === null
      ? { current: false, reason: "missing-marketplace-source" }
      : compareManifest(readJsonIfPresent(sourceManifestPath), repoManifest);
  const installedManifestPath = cacheManifestPath({
    cacheRoot,
    namespace,
    pluginName,
    version: repoManifest.version,
  });
  const cacheComparison = compareManifest(readJsonIfPresent(installedManifestPath), repoManifest);

  return {
    name: pluginName,
    version: repoManifest.version,
    marketplace_namespace: namespace,
    repo_manifest_path: repoManifestPath,
    marketplace_source_path: sourceManifestPath,
    repo_source_current: sourceComparison.current,
    repo_source_reason: sourceComparison.reason,
    installed_cache_path: installedManifestPath,
    installed_cache_current: cacheComparison.current,
    installed_cache_reason: cacheComparison.reason,
    active_session_visible: "not_checked",
    active_session_reason: "Codex Desktop/active-thread plugin visibility is a host runtime state, not a filesystem property.",
  };
}

function auditHostMarketplace({
  repoRoot,
  hostMarketplacePath,
  hostMarketplaceRoot,
  namespace,
  plugins,
}) {
  const resolvedPath = path.isAbsolute(hostMarketplacePath)
    ? hostMarketplacePath
    : path.resolve(repoRoot, hostMarketplacePath);
  const resolvedRoot = path.isAbsolute(hostMarketplaceRoot)
    ? hostMarketplaceRoot
    : path.resolve(repoRoot, hostMarketplaceRoot);

  if (!fs.existsSync(resolvedPath)) {
    return {
      provided: false,
      current: true,
      reason: "missing",
      path: resolvedPath,
      root: resolvedRoot,
      marketplace_namespace: null,
      namespace_current: true,
      plugins: [],
      guidance: "Host implicit marketplace was not found; repo/cache freshness can still be current, but Codex may use another marketplace source.",
    };
  }

  const hostMarketplace = readJson(resolvedPath);
  const hostNamespace = marketplaceNamespace(hostMarketplace);
  const pluginReports = plugins.map((pluginName) => {
    const repoManifestPath = pluginManifestPath(repoRoot, pluginName);
    const repoManifest = readJson(repoManifestPath);
    const entry = marketplacePlugin(hostMarketplace, pluginName);
    const sourceRoot = marketplaceSourcePath({
      repoRoot: resolvedRoot,
      marketplacePath: resolvedPath,
      plugin: entry,
    });
    const sourceManifestPath = sourceRoot === null
      ? null
      : path.join(sourceRoot, ".codex-plugin", "plugin.json");
    const comparison = entry === null
      ? { current: false, reason: "missing-marketplace-entry" }
      : sourceManifestPath === null
        ? { current: false, reason: "missing-marketplace-source" }
        : compareManifest(readJsonIfPresent(sourceManifestPath), repoManifest);
    return {
      name: pluginName,
      repo_manifest_path: repoManifestPath,
      host_marketplace_source_path: sourceManifestPath,
      current: comparison.current,
      reason: comparison.reason,
    };
  });
  const namespaceCurrent = hostNamespace === namespace;
  const sourcesCurrent = pluginReports.every((plugin) => plugin.current);
  return {
    provided: true,
    current: namespaceCurrent && sourcesCurrent,
    reason: !namespaceCurrent ? "namespace-mismatch" : sourcesCurrent ? "current" : "source-drift",
    path: resolvedPath,
    root: resolvedRoot,
    marketplace_namespace: hostNamespace,
    namespace_current: namespaceCurrent,
    plugins: pluginReports,
    guidance: namespaceCurrent && sourcesCurrent
      ? "Host implicit marketplace resolves Desk plugin sources to the same manifests as the repo source of truth."
      : "Host implicit marketplace is stale or points at a different plugin source. Repoint ~/.agents/plugins/marketplace.json at the canonical repo, reinstall plugins, and restart/open a fresh Codex session.",
  };
}

function auditCodexPluginCache({
  repoRoot = path.resolve(__dirname, ".."),
  codexHome = path.join(os.homedir(), ".codex"),
  cacheRoot = path.join(codexHome, "plugins", "cache"),
  marketplacePath = path.join(repoRoot, ".agents", "plugins", "marketplace.json"),
  hostMarketplacePath = defaultHostMarketplacePath(codexHome),
  hostMarketplaceRoot = defaultHostMarketplaceRoot(hostMarketplacePath),
  plugins = defaultPlugins,
  activeTools = null,
  activeToolsFiles = [],
} = {}) {
  const resolvedMarketplacePath = path.isAbsolute(marketplacePath)
    ? marketplacePath
    : path.join(repoRoot, marketplacePath);
  const marketplace = readJson(resolvedMarketplacePath);
  const namespace = marketplaceNamespace(marketplace);
  const requiredTools = requiredDeskMcpTools(repoRoot);
  const activeSession = auditActiveTools(collectActiveTools({
    repoRoot,
    activeTools,
    activeToolsFiles,
  }), requiredTools);
  const pluginReports = plugins.map((pluginName) => auditPlugin({
    repoRoot,
    cacheRoot,
    marketplace,
    marketplacePath: resolvedMarketplacePath,
    namespace,
    pluginName,
  }));
  const hostMarketplace = auditHostMarketplace({
    repoRoot,
    hostMarketplacePath,
    hostMarketplaceRoot,
    namespace,
    plugins,
  });
  if (activeSession.provided) {
    for (const plugin of pluginReports) {
      if (plugin.name === "desk") {
        plugin.active_session_visible = activeSession.status === "pass";
        plugin.active_session_reason = activeSession.guidance;
      }
    }
  }
  return {
    status: pluginReports.every((plugin) => (
      plugin.repo_source_current && plugin.installed_cache_current
    )) && hostMarketplace.current ? "current" : "stale",
    repo_root: repoRoot,
    codex_home: codexHome,
    marketplace_namespace: namespace,
    marketplace_path: resolvedMarketplacePath,
    cache_root: cacheRoot,
    evidence_states: {
      repo_source_current: "compares .agents marketplace source manifests with repo manifests",
      installed_cache_current: "compares ~/.codex/plugins/cache manifests with repo manifests",
      host_marketplace_current: "compares the host implicit ~/.agents marketplace source manifests with repo manifests when present",
      active_session_visible: "checks an optional active MCP tool snapshot when --active-tools or --active-tools-file is supplied",
    },
    host_marketplace: hostMarketplace,
    active_session: activeSession,
    plugins: pluginReports,
  };
}

function parseArgs(argv) {
  const options = {
    plugins: [...defaultPlugins],
    strict: false,
    strictActive: false,
    activeTools: null,
    activeToolsFiles: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = path.resolve(requireValue(argv, ++index, arg));
    } else if (arg === "--codex-home") {
      options.codexHome = path.resolve(requireValue(argv, ++index, arg));
    } else if (arg === "--cache-root") {
      options.cacheRoot = path.resolve(requireValue(argv, ++index, arg));
    } else if (arg === "--marketplace") {
      options.marketplacePath = requireValue(argv, ++index, arg);
    } else if (arg === "--host-marketplace") {
      options.hostMarketplacePath = requireValue(argv, ++index, arg);
    } else if (arg === "--host-marketplace-root") {
      options.hostMarketplaceRoot = path.resolve(requireValue(argv, ++index, arg));
    } else if (arg === "--no-host-marketplace") {
      options.hostMarketplacePath = path.join(os.tmpdir(), "missing-codex-host-marketplace.json");
      options.hostMarketplaceRoot = os.tmpdir();
    } else if (arg === "--plugins") {
      options.plugins = requireValue(argv, ++index, arg).split(",").map((name) => name.trim()).filter(Boolean);
    } else if (arg === "--active-tools") {
      options.activeTools = requireValue(argv, ++index, arg).split(",").map((name) => name.trim()).filter(Boolean);
    } else if (arg === "--active-tools-file") {
      options.activeToolsFiles.push(requireValue(argv, ++index, arg));
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--strict-active") {
      options.strictActive = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function run({
  argv = process.argv.slice(2),
  auditFn = auditCodexPluginCache,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const options = parseArgs(argv);
    const report = auditFn(options);
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (options.strict && report.status !== "current") return 1;
    if (options.strictActive && report.active_session.status !== "pass") return 1;
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function startCli({
  isMain = require.main === module,
  runFn = run,
  setExitCode = (code) => {
    process.exitCode = code;
  },
} = {}) {
  if (!isMain) return null;
  const code = runFn();
  setExitCode(code);
  return code;
}

module.exports = {
  auditActiveTools,
  auditCodexPluginCache,
  auditHostMarketplace,
  requiredDeskMcpTools,
  run,
  startCli,
};

startCli();
