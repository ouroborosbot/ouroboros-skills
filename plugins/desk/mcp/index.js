#!/usr/bin/env node
// desk MCP server entry point.
//
// Spawned by consumers as a stdio MCP server. Hosts may pass `--root <path>`
// directly, or pass/auto-discover an activation config that carries the root,
// runtime cache, and active worker/overlay identity. Consumers wire this up via
// the sibling `.mcp.json` declaration.
//
//   node ./mcp/index.js --root ~/AgentBundles/slugger.ouro/desk
//
// The same binary serves every consumer (Codex, Claude Code worker, Copilot
// CLI, ouroboros daemon per agent). Each consumer supplies or discovers its
// own root/activation context without needing a bespoke Desk CLI.

import { existsSync, readFileSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as path from "node:path"
import {
  budgetValue,
  loadPerformanceBudgets,
} from "./src/artifacts/performance-budgets.js"
import {
  importRuntimeServer,
  inspectRuntimeDependencyPack,
} from "./src/runtime/bootstrap.js"
import { startDiagnosticServer } from "./src/runtime/diagnostic-server.js"
import { createRuntimeDiagnostic } from "./src/runtime/diagnostics.js"
import {
  discoverNodeCandidates,
  REEXEC_ATTEMPT_ENV,
  reexecuteWithCompatibleNode,
  selectCompatibleNode,
} from "./src/runtime/node-selection.js"
import { expandHome, loadActivationConfig, resolveDeskRootWithSource } from "./src/util/paths.js"

const MCP_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/u

export function parseArgs(argv) {
  const args = { root: null, person: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) {
      args.root = argv[++i]
    } else if (argv[i] === "--host-session-root" && argv[i + 1]) {
      args.hostSessionRoot = argv[++i]
    } else if (argv[i] === "--person" && argv[i + 1]) {
      args.person = argv[++i]
    } else if (argv[i] === "--activation-config" && argv[i + 1]) {
      args.activationConfig = argv[++i]
    }
  }
  return args
}

export function resolveStartupDeskRoot({ args, env = process.env, homeDir } = {}) {
  return resolveDeskRootWithSource({
    activationConfigPath: resolveStartupActivationConfigPath({ args, env }),
    env,
    explicitRoot: args?.root,
    homeDir,
    hostSessionRoot: args?.hostSessionRoot,
  })
}

export function resolveStartupActivationConfigPath({ args, env = process.env } = {}) {
  if (hasText(args?.activationConfig)) {
    return args.activationConfig
  }
  if (hasText(env.DESK_ACTIVATION_CONFIG)) {
    return env.DESK_ACTIVATION_CONFIG
  }
  if (hasText(env.CODEX_HOME)) {
    const candidate = path.join(env.CODEX_HOME, "desk.activation.json")
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

export function resolveStartupRuntimeCacheDir({
  args,
  cwd = process.cwd(),
  env = process.env,
  homeDir,
} = {}) {
  const activationConfig = resolveStartupActivationConfigPath({ args, env })
  if (!hasText(activationConfig)) {
    return null
  }
  const loadedActivationConfig = loadActivationConfig({
    configPath: activationConfig,
    cwd,
    homeDir,
  })
  if (!hasText(loadedActivationConfig.runtimeCacheDir)) {
    return null
  }
  const expanded = expandHome(loadedActivationConfig.runtimeCacheDir, homeDir)
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded))
}

export function resolveStartupActivationContext({
  args,
  cwd = process.cwd(),
  env = process.env,
  homeDir,
} = {}) {
  const activationConfig = resolveStartupActivationConfigPath({ args, env })
  if (!hasText(activationConfig)) {
    return null
  }
  const loadedActivationConfig = loadActivationConfig({
    configPath: activationConfig,
    cwd,
    homeDir,
  })
  if (loadedActivationConfig?.activation === null || typeof loadedActivationConfig?.activation !== "object") {
    return null
  }
  return {
    ...loadedActivationConfig.activation,
    source: "activation-config",
  }
}

export function resolveRuntimeInspector({ runtimeImporter, runtimeInspector }) {
  if (runtimeInspector !== undefined) {
    return runtimeInspector
  }
  return runtimeImporter === importRuntimeServer
    ? inspectRuntimeDependencyPack
    : null
}

export function resolveMcpServerVersion({
  mcpRoot,
  readFile = readFileSync,
} = {}) {
  try {
    const version = JSON.parse(
      readFile(path.join(mcpRoot, "package.json"), "utf8"),
    ).version
    return hasText(version) && MCP_VERSION_PATTERN.test(version)
      ? version
      : "0.0.0"
  } catch {
    return "0.0.0"
  }
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  homeDir,
  mcpRoot = path.dirname(fileURLToPath(import.meta.url)),
  runtimeImporter = importRuntimeServer,
  runtimeInspector,
  diagnosticServerStarter = startDiagnosticServer,
  nodeCandidateDiscoverer = discoverNodeCandidates,
  nodeSelector = selectCompatibleNode,
  nodeReexecutor = reexecuteWithCompatibleNode,
} = {}) {
  runtimeInspector = resolveRuntimeInspector({ runtimeImporter, runtimeInspector })
  const serverVersion = resolveMcpServerVersion({ mcpRoot })
  const startRuntimeDiagnostic = (options) => diagnosticServerStarter({
    ...options,
    serverVersion,
  })
  const args = parseArgs(argv)
  const rootResolution = resolveStartupDeskRoot({ args, env, homeDir })
  const { root: deskRoot } = rootResolution
  const runtimeCacheDir = resolveStartupRuntimeCacheDir({ args, cwd, env, homeDir })
  const activationStatus = resolveStartupActivationContext({ args, cwd, env, homeDir })
  let inspection = null
  let runtimeServer
  if (runtimeInspector !== null) {
    try {
      inspection = runtimeInspector({ mcpRoot })
    } catch {
      inspection = startupFailureInspection({
        mcpRoot,
        reason: "runtime_inspection_failed",
      })
      return startRuntimeDiagnostic({
        diagnostic: runtimeDiagnostic({
          inspection,
          runtimeCacheDir,
          env,
        }),
      })
    }
    if (!inspection.ok) {
      return handleUnavailableRuntime({
        argv,
        diagnosticServerStarter: startRuntimeDiagnostic,
        env,
        homeDir,
        inspection,
        mcpRoot,
        nodeCandidateDiscoverer,
        nodeReexecutor,
        nodeSelector,
        runtimeCacheDir,
      })
    }
    try {
      runtimeServer = await runtimeImporter({
        env,
        mcpRoot,
        runtimeCacheDir,
      })
    } catch {
      return startRuntimeDiagnostic({
        diagnostic: runtimeDiagnostic({
          inspection,
          reason: "runtime_restore_failed",
          runtimeCacheDir,
          env,
        }),
      })
    }
  } else {
    runtimeServer = await runtimeImporter({
      env,
      mcpRoot,
      runtimeCacheDir,
    })
  }
  const importedRuntime = runtimeServer._deskRuntime ?? {
    runtime_cache_dir: runtimeCacheDir,
    source_mirror_path: null,
    target: null,
    loaded_from_source_mirror: false,
  }
  const runtimeStatus = inspection === null
    ? importedRuntime
    : {
        ...inspection.runtime,
        ...importedRuntime,
        state: "ready",
        current_target: inspection.runtime?.current_target ?? inspection.current_target,
        shipped_targets: inspection.runtime?.shipped_targets ?? inspection.shipped_targets ?? [],
        paths_checked: inspection.runtime?.paths_checked ?? inspection.paths_checked ?? [],
        runtime_cache_path: importedRuntime.runtime_cache_dir ?? runtimeCacheDir,
        support_matrix_path: inspection.runtime?.support_matrix_path ?? inspection.support_matrix_path,
      }
  const performanceBudgets = await loadPerformanceBudgets({ mcpRoot })
  const startupStatus = await runStartupEnsureIndex({
    budgetMs: budgetValue(performanceBudgets, "startup", "ensure_index_ms"),
    deskRoot,
    runtimeServer,
  })
  await runtimeServer.startServer({
    deskRoot,
    person: args.person,
    statusContext: {
      root: rootResolution,
      activation: activationStatus,
      runtime: runtimeStatus,
      startup: startupStatus,
    },
  })
}

async function handleUnavailableRuntime({
  argv,
  diagnosticServerStarter,
  env,
  homeDir,
  inspection,
  mcpRoot,
  nodeCandidateDiscoverer,
  nodeReexecutor,
  nodeSelector,
  runtimeCacheDir,
}) {
  const shouldSelectNode = inspection.reason === "unsupported_target"
    || hasText(env[REEXEC_ATTEMPT_ENV])
  if (!shouldSelectNode) {
    return diagnosticServerStarter({
      diagnostic: runtimeDiagnostic({
        inspection,
        runtimeCacheDir,
        env,
      }),
    })
  }

  let selection
  try {
    selection = nodeSelector({
      candidates: nodeCandidateDiscoverer({ env, homeDir }),
      currentTarget: inspection.runtime?.current_target ?? inspection.current_target,
      env,
      shippedTargets: inspection.runtime?.shipped_targets ?? inspection.shipped_targets ?? [],
    })
  } catch {
    return diagnosticServerStarter({
      diagnostic: runtimeDiagnostic({
        inspection,
        reason: "node_selection_failed",
        runtimeCacheDir,
        env,
      }),
    })
  }
  if (selection.mode === "reexec") {
    try {
      const result = await nodeReexecutor({
        argv,
        entrypointPath: path.join(mcpRoot, "index.js"),
        env,
        executable: selection.executable,
      })
      if (result.forwardedSignal !== null && result.forwardedSignal !== undefined) {
        return result
      }
      if (result.code !== 0 || result.signal !== null) {
        throw new Error(`compatible Node exited with ${result.signal ?? result.code}`)
      }
      return result
    } catch {
      return diagnosticServerStarter({
        diagnostic: runtimeDiagnostic({
          inspection,
          reason: "guarded_reexec_failure",
          pathsChecked: selection.paths_checked,
          runtimeCacheDir,
          env,
        }),
      })
    }
  }
  return diagnosticServerStarter({
    diagnostic: runtimeDiagnostic({
      inspection,
      reason: selection.reason,
      pathsChecked: selection.paths_checked,
      runtimeCacheDir,
      env,
    }),
  })
}

function startupFailureInspection({ mcpRoot, reason }) {
  const currentTarget = {
    id: `${process.platform}-${process.arch}-node-${process.versions.modules}`,
    platform: process.platform,
    arch: process.arch,
    node_abi: process.versions.modules,
  }
  const runtime = {
    current_target: currentTarget,
    shipped_targets: [],
    paths_checked: [mcpRoot],
    support_matrix_path: null,
  }
  return {
    ok: false,
    mode: "diagnostic",
    reason,
    runtime,
  }
}

function runtimeDiagnostic({
  inspection,
  reason = inspection.reason,
  pathsChecked = [],
  runtimeCacheDir,
  env,
}) {
  const runtime = inspection.runtime ?? inspection
  return createRuntimeDiagnostic({
    reason,
    failureKind: reason === inspection.reason ? inspection.failure_kind : undefined,
    currentTarget: runtime.current_target,
    shippedTargets: runtime.shipped_targets ?? [],
    pathsChecked: [...(runtime.paths_checked ?? []), ...pathsChecked],
    runtimeCachePath: runtimeCacheDir ?? env.DESK_RUNTIME_CACHE_DIR ?? null,
    supportMatrixPath: runtime.support_matrix_path ?? null,
  })
}

async function runStartupEnsureIndex({ budgetMs, deskRoot, runtimeServer }) {
  if (typeof runtimeServer.ensureIndex !== "function") {
    return {
      fallback_mode: "not_checked",
      degraded: false,
      duration_ms: 0,
      budget_ms: budgetMs,
    }
  }
  const startedAt = Date.now()
  const controller = new AbortController()
  let timeout
  let timedOut = false
  const ensureOptions = {
    startup: true,
    budgetMs,
    signal: controller.signal,
    skipEmbed: true,
  }
  const startupMaintenance = runtimeServer.maintenanceCoordinator
  if (typeof startupMaintenance?.runStartupEnsureIndex !== "function") {
    return {
      ensure_index: {
        built: false,
        reason: "shared_maintenance_unavailable",
        skipped: true,
      },
      duration_ms: 0,
      budget_ms: budgetMs,
      fallback_mode: "maintenance_unavailable",
      degraded: true,
    }
  }
  const ensureIndexPromise = Promise.resolve().then(() =>
    startupMaintenance.runStartupEnsureIndex({
      deskRoot,
      ensureOptions,
    }),
  )
  try {
    const ensureIndexResult = await Promise.race([
      ensureIndexPromise,
      new Promise((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true
          controller.abort()
          resolve({
            built: false,
            reason: "startup_budget_exceeded",
            deferred: true,
          })
        }, budgetMs)
      }),
    ])
    if (timedOut) {
      ensureIndexPromise.catch(() => {})
    }
    clearTimeout(timeout)
    const fallbackMode = inferStartupFallbackMode(ensureIndexResult)
    return {
      ensure_index: ensureIndexResult,
      duration_ms: Date.now() - startedAt,
      budget_ms: budgetMs,
      fallback_mode: fallbackMode,
      degraded: startupIsDegraded(ensureIndexResult, fallbackMode),
    }
  } catch (err) {
    const ensureIndexResult = {
      built: false,
      reason: "startup_error",
      error: {
        message: err?.message ?? String(err),
      },
    }
    clearTimeout(timeout)
    const fallbackMode = inferStartupFallbackMode(ensureIndexResult)
    return {
      ensure_index: ensureIndexResult,
      duration_ms: Date.now() - startedAt,
      budget_ms: budgetMs,
      fallback_mode: fallbackMode,
      degraded: startupIsDegraded(ensureIndexResult, fallbackMode),
    }
  }
}

function inferStartupFallbackMode(ensureIndexResult) {
  if (ensureIndexResult?.fallback === "vector_packs" && ensureIndexResult?.snapshot?.restored) {
    return "snapshot_then_vector_packs"
  }
  if (ensureIndexResult?.fallback === "vector_packs") return "vector_packs"
  if (
    ensureIndexResult?.semantic?.missing_vectors > 0
  ) {
    return "lexical_only"
  }
  if (ensureIndexResult?.snapshot?.restored) return "snapshot"
  if (ensureIndexResult?.reason === "startup_error") return "startup_error"
  if (ensureIndexResult?.reason === "startup_budget_exceeded") return "startup_deferred"
  return ensureIndexResult?.built ? "rebuild" : "fresh"
}

function startupIsDegraded(ensureIndexResult, fallbackMode) {
  return fallbackMode === "lexical_only" ||
    fallbackMode === "startup_error" ||
    fallbackMode === "startup_deferred" ||
    ensureIndexResult?.semantic?.embedding_available === false ||
    ensureIndexResult?.semantic?.missing_vectors > 0
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0
}

export function isEntrypoint({
  argv = process.argv,
  moduleUrl = import.meta.url,
  realpath = realpathSync,
} = {}) {
  if (!argv[1]) {
    return false
  }
  const modulePath = fileURLToPath(moduleUrl)
  try {
    return realpath(modulePath) === realpath(argv[1])
  } catch {
    return path.resolve(modulePath) === path.resolve(argv[1])
  }
}

export function runIfEntrypoint({
  argv = process.argv,
  moduleUrl = import.meta.url,
  launch = main,
  stderr = process.stderr,
  exit = process.exit,
} = {}) {
  if (!isEntrypoint({ argv, moduleUrl })) return null
  const handleFatalError = (err) => {
    stderr.write(`[desk-mcp] fatal: ${err.message}\n`)
    exit(1)
  }
  try {
    return Promise.resolve(launch()).catch(handleFatalError)
  } catch (err) {
    handleFatalError(err)
    return Promise.resolve()
  }
}

// Only launch the server when run as the entry point, not when imported
// (tests import `parseArgs` without spawning a stdio server).
runIfEntrypoint()
