// Unit 17d: red contract for bounded startup fallback before MCP registration.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { main } from "../../index.js"
import {
  __setMaintenanceCoordinatorForTests,
  createMaintenanceCoordinator,
} from "../../src/indexer/maintenance.js"
import { startServer as registerRuntimeServer } from "../../src/server.js"

function makeRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

function deferred() {
  let resolve
  let reject
  let settled = false
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    reject = (error) => {
      if (settled) return
      settled = true
      rejectPromise(error)
    }
  })
  return {
    promise,
    reject,
    resolve,
    get settled() {
      return settled
    },
  }
}

function observeSettlement(promise) {
  const observed = { state: "pending", value: undefined }
  Promise.resolve(promise).then(
    (value) => {
      observed.state = "fulfilled"
      observed.value = value
    },
    (error) => {
      observed.state = "rejected"
      observed.value = error
    },
  )
  return observed
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve))
}

function writeStartupBudget(mcpRoot, ensureIndexMs) {
  const configDir = path.join(mcpRoot, "config")
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    path.join(configDir, "performance-budgets.json"),
    JSON.stringify({
      schema_version: 1,
      search: {
        semantic_repair_batch_chunks: 100,
        semantic_repair_batch_ms: 5000,
      },
      startup: {
        ensure_index_ms: ensureIndexMs,
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
    }),
  )
}

function runtimeServerWithEnsureIndex({ ensureIndex, maintenanceCoordinator }) {
  const events = []
  const startCalls = []
  const runtimeServer = {
    _deskRuntime: {
      runtime_cache_dir: "/runtime-cache",
      source_mirror_path: "/runtime-cache/source-mirror/hash",
      target: `${process.platform}-${process.arch}-node-${process.versions.modules}`,
      loaded_from_source_mirror: true,
    },
    events,
    startCalls,
    async ensureIndex(...args) {
      events.push("ensureIndex")
      return ensureIndex(...args)
    },
    async startServer(args) {
      events.push("startServer")
      startCalls.push(args)
    },
  }
  if (maintenanceCoordinator !== null) {
    runtimeServer.maintenanceCoordinator =
      maintenanceCoordinator ??
      createMaintenanceCoordinator({
        ensureIndex: runtimeServer.ensureIndex,
      })
  }
  return runtimeServer
}

test("startup runs bounded ensureIndex before registering the server and forwards artifact status", async () => {
  const root = makeRoot("desk-startup-budget-snapshot-")
  const ensureCalls = []
  const runtimeServer = runtimeServerWithEnsureIndex({
    ensureIndex: async (deskRoot, opts = {}) => {
      ensureCalls.push({ deskRoot, opts })
      return {
        built: true,
        reason: "snapshot_restored",
        snapshot: {
          restored: true,
          reason: "snapshot_restored",
          snapshot_id: "startup-compatible",
          freshness: {
            artifact_source_scope: "fresh",
            document_tree: "fresh",
          },
        },
        semantic: {
          chunks_total: 3,
          vectors_indexed: 3,
          missing_vectors: 0,
        },
      }
    },
  })
  try {
    await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => runtimeServer,
    })

    assert.equal(ensureCalls.length, 1)
    assert.equal(ensureCalls[0].deskRoot, root)
    assert.equal(ensureCalls[0].opts.startup, true)
    assert.equal(ensureCalls[0].opts.budgetMs, 250)
    assert.equal(runtimeServer.startCalls.length, 1)
    assert.deepEqual(runtimeServer.events, ["ensureIndex", "startServer"])
    const statusContext = runtimeServer.startCalls[0].statusContext
    assert.equal(statusContext.startup.ensure_index.reason, "snapshot_restored")
    assert.equal(statusContext.startup.ensure_index.snapshot.snapshot_id, "startup-compatible")
    assert.equal(statusContext.startup.duration_ms >= 0, true)
    assert.equal(statusContext.startup.budget_ms, 250)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("startup reports lexical fallback when snapshots and vector packs cannot cover offline startup", async () => {
  const root = makeRoot("desk-startup-budget-lexical-")
  const runtimeServer = runtimeServerWithEnsureIndex({
    ensureIndex: async () => ({
      built: true,
      reason: "missing",
      snapshot: {
        restored: false,
        reason: "no_compatible_snapshot",
      },
      semantic: {
        chunks_total: 1,
        vectors_indexed: 0,
        missing_vectors: 1,
        embedding_available: false,
        embedding_diagnostic: {
          reason: "embedding_generation_failed",
        },
      },
    }),
  })
  try {
    await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => runtimeServer,
    })

    const statusContext = runtimeServer.startCalls[0].statusContext
    assert.deepEqual(runtimeServer.events, ["ensureIndex", "startServer"])
    assert.ok(statusContext.startup, "startup should forward bounded fallback status context")
    assert.equal(statusContext.startup.ensure_index.reason, "missing")
    assert.equal(statusContext.startup.ensure_index.snapshot.reason, "no_compatible_snapshot")
    assert.equal(statusContext.startup.ensure_index.semantic.embedding_available, false)
    assert.equal(
      statusContext.startup.ensure_index.semantic.embedding_diagnostic.reason,
      "embedding_generation_failed",
    )
    assert.equal(statusContext.startup.fallback_mode, "lexical_only")
    assert.equal(statusContext.startup.degraded, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("startup reports snapshot plus vector-pack fallback and startup errors", async () => {
  const root = makeRoot("desk-startup-budget-edges-")
  const vectorPackRuntime = runtimeServerWithEnsureIndex({
    ensureIndex: async () => ({
      built: true,
      reason: "semantic_missing",
      fallback: "vector_packs",
      snapshot: {
        restored: true,
        snapshot_id: "startup-snapshot-with-packs",
      },
      semantic: {
        chunks_total: 2,
        vectors_indexed: 2,
        missing_vectors: 0,
      },
    }),
  })
  const errorRuntime = runtimeServerWithEnsureIndex({
    ensureIndex: async () => {
      throw new Error("startup repair unavailable")
    },
  })
  try {
    await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => vectorPackRuntime,
    })
    assert.equal(
      vectorPackRuntime.startCalls[0].statusContext.startup.fallback_mode,
      "snapshot_then_vector_packs",
    )
    assert.equal(vectorPackRuntime.startCalls[0].statusContext.startup.degraded, false)

    await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => errorRuntime,
    })
    const errorStartup = errorRuntime.startCalls[0].statusContext.startup
    assert.equal(errorStartup.ensure_index.reason, "startup_error")
    assert.equal(errorStartup.ensure_index.error.message, "startup repair unavailable")
    assert.equal(errorStartup.fallback_mode, "startup_error")
    assert.equal(errorStartup.degraded, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("startup classifies every bounded fallback mode", async () => {
  const root = makeRoot("desk-startup-budget-modes-")
  async function startupFor(resultOrThrow) {
    const runtimeServer = runtimeServerWithEnsureIndex({
      ensureIndex: async () => {
        if (resultOrThrow instanceof Error || typeof resultOrThrow === "string") {
          throw resultOrThrow
        }
        return resultOrThrow
      },
    })

    await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => runtimeServer,
    })
    return runtimeServer.startCalls[0].statusContext.startup
  }

  try {
    assert.equal((await startupFor({
      built: true,
      reason: "semantic_missing",
      fallback: "vector_packs",
      semantic: { chunks_total: 1, vectors_indexed: 1, missing_vectors: 0 },
    })).fallback_mode, "vector_packs")

    assert.equal((await startupFor({
      built: false,
      reason: "snapshot_restored",
      snapshot: { restored: true, snapshot_id: "snapshot-only" },
      semantic: { chunks_total: 1, vectors_indexed: 1, missing_vectors: 0 },
    })).fallback_mode, "snapshot")

    const rebuild = await startupFor({
      built: true,
      reason: "stale",
      semantic: { chunks_total: 1, vectors_indexed: 1, missing_vectors: 0 },
    })
    assert.equal(rebuild.fallback_mode, "rebuild")
    assert.equal(rebuild.degraded, false)

    const degradedLexical = await startupFor({
      built: true,
      reason: "stale",
      semantic: { chunks_total: 1, vectors_indexed: 0, missing_vectors: 1 },
    })
    assert.equal(degradedLexical.fallback_mode, "lexical_only")
    assert.equal(degradedLexical.degraded, true)

    assert.equal((await startupFor({ built: false, reason: "fresh" })).fallback_mode, "fresh")

    const stringError = await startupFor("string startup failure")
    assert.equal(stringError.ensure_index.reason, "startup_error")
    assert.equal(stringError.ensure_index.error.message, "string startup failure")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("startup stops waiting and aborts when bounded ensureIndex exceeds budget", async () => {
  const root = makeRoot("desk-startup-budget-timeout-")
  let signalSeen = false
  let abortSeen = false
  const runtimeServer = runtimeServerWithEnsureIndex({
    ensureIndex: async (_deskRoot, opts = {}) => {
      signalSeen = opts.signal instanceof AbortSignal
      if (opts.signal) {
        opts.signal.addEventListener("abort", () => {
          abortSeen = true
        }, { once: true })
      }
      await new Promise((resolve) => setTimeout(resolve, 600))
      throw new Error("late rebuild rejection")
    },
  })
  try {
    const startedAt = Date.now()
    await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => runtimeServer,
    })
    const elapsedMs = Date.now() - startedAt

    assert.equal(signalSeen, true)
    assert.equal(abortSeen, true)
    assert.ok(elapsedMs < 500, `startup took ${elapsedMs}ms despite 250ms budget`)
    const startup = runtimeServer.startCalls[0].statusContext.startup
    assert.equal(startup.ensure_index.reason, "startup_budget_exceeded")
    assert.equal(startup.fallback_mode, "startup_deferred")
    assert.equal(startup.degraded, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("startup enters truthful diagnostic mode without serving when shared maintenance is unavailable", async () => {
  const root = makeRoot("desk-startup-budget-no-maintenance-")
  writeStartupBudget(root, 0)
  const activationConfig = path.join(root, "desk.activation.json")
  writeFileSync(
    activationConfig,
    JSON.stringify({
      schema_version: 1,
      desk: { root },
      runtimeCacheDir: "configured-runtime-cache",
    }),
  )
  const directEnsureRelease = deferred()
  const diagnosticCalls = []
  let directEnsureCalls = 0
  const runtimeServer = runtimeServerWithEnsureIndex({
    ensureIndex: async () => {
      directEnsureCalls += 1
      await directEnsureRelease.promise
      return { built: false, reason: "fresh" }
    },
    maintenanceCoordinator: null,
  })

  try {
    await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      mcpRoot: root,
      runtimeImporter: async () => runtimeServer,
      diagnosticServerStarter: async (args) => {
        diagnosticCalls.push(args)
        return args.diagnostic
      },
    })

    assert.equal(directEnsureCalls, 0)
    assert.equal(runtimeServer.startCalls.length, 0)
    assert.deepEqual(runtimeServer.events, [])
    assert.equal(diagnosticCalls.length, 1)
    assert.equal(diagnosticCalls[0].diagnostic.reason, "maintenance_unavailable")
    assert.match(diagnosticCalls[0].diagnostic.summary, /maintenance coordinator/i)

    await main({
      argv: [
        "--root",
        root,
        "--activation-config",
        activationConfig,
      ],
      env: {},
      cwd: root,
      homeDir: root,
      mcpRoot: root,
      runtimeImporter: async () => ({
        _deskRuntime: {
          runtime_cache_dir: null,
          source_mirror_path: null,
          target: null,
          loaded_from_source_mirror: false,
        },
        maintenanceCoordinator: null,
        async startServer() {
          assert.fail("missing maintenance must not start the runtime server")
        },
      }),
      diagnosticServerStarter: async (args) => {
        diagnosticCalls.push(args)
        return args.diagnostic
      },
    })
    assert.equal(diagnosticCalls.length, 2)
    assert.equal(
      diagnosticCalls[1].diagnostic.runtime.runtime_cache_path,
      path.join(root, "configured-runtime-cache"),
    )

    await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      mcpRoot: root,
      runtimeImporter: async () => ({
        maintenanceCoordinator: null,
        async startServer() {
          assert.fail("missing maintenance must not start the runtime server")
        },
      }),
      diagnosticServerStarter: async (args) => {
        diagnosticCalls.push(args)
        return args.diagnostic
      },
    })
    assert.equal(diagnosticCalls.length, 3)
    assert.equal(
      diagnosticCalls[2].diagnostic.runtime.runtime_cache_path,
      null,
    )
  } finally {
    directEnsureRelease.resolve()
    await flushAsyncWork()
    rmSync(root, { recursive: true, force: true })
  }
})

test("runtime-wide coordinator identity serializes timed-out startup with served force reindex", async () => {
  const root = makeRoot("desk-startup-budget-runtime-identity-")
  writeStartupBudget(root, 0)
  const startupEntered = deferred()
  const startupCleanupRelease = deferred()
  const startupClosed = deferred()
  const boundResetEntered = deferred()
  const boundResetRelease = deferred()
  const wrongResetEntered = deferred()
  const wrongResetRelease = deferred()
  const handlers = []
  const events = []
  let startupHandleOpen = false
  let boundResetOverlappedStartup = false
  let wrongResetOverlappedStartup = false
  let forceCall
  let startupCall

  const ensureIndex = async (_deskRoot, opts = {}) => {
    if (opts.startup) {
      startupHandleOpen = true
      events.push("startup-open")
      startupEntered.resolve()
      opts.signal.addEventListener("abort", () => {
        events.push("startup-abort")
      }, { once: true })
      await startupCleanupRelease.promise
      startupHandleOpen = false
      events.push("startup-close")
      startupClosed.resolve()
      throw new Error("late startup cleanup rejection")
    }
    events.push("bound-reindex")
    return { built: false, reason: "fresh" }
  }
  const boundMaintenance = createMaintenanceCoordinator({
    ensureIndex,
    resetIndex: async () => {
      boundResetOverlappedStartup = startupHandleOpen
      events.push("bound-reset")
      boundResetEntered.resolve()
      await boundResetRelease.promise
    },
  })
  const wrongMaintenance = createMaintenanceCoordinator({
    ensureIndex: async () => {
      events.push("wrong-reindex")
      return { built: false, reason: "fresh" }
    },
    resetIndex: async () => {
      wrongResetOverlappedStartup = startupHandleOpen
      events.push("wrong-reset")
      wrongResetEntered.resolve()
      await wrongResetRelease.promise
    },
  })
  const restoreMaintenance =
    __setMaintenanceCoordinatorForTests(wrongMaintenance)
  const transport = { kind: "runtime-identity-test" }
  const server = {
    setRequestHandler(schema, handler) {
      handlers.push({ schema, handler })
    },
    async connect(receivedTransport) {
      assert.equal(receivedTransport, transport)
    },
  }
  const runtimeServer = {
    _deskRuntime: {
      runtime_cache_dir: "/runtime-cache",
      source_mirror_path: "/runtime-cache/source-mirror/hash",
      target: `${process.platform}-${process.arch}-node-${process.versions.modules}`,
      loaded_from_source_mirror: true,
    },
    ensureIndex,
    maintenanceCoordinator: boundMaintenance,
    async startServer(args) {
      return registerRuntimeServer({
        ...args,
        server,
        transport,
      })
    },
  }

  try {
    startupCall = main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      mcpRoot: root,
      runtimeImporter: async () => runtimeServer,
    })
    await startupEntered.promise
    await startupCall

    assert.equal(handlers.length, 2)
    forceCall = handlers[1].handler({
      params: {
        name: "desk_reindex",
        arguments: { force: true },
      },
    })
    const observedForce = observeSettlement(forceCall)
    await flushAsyncWork()

    assert.equal(
      wrongResetEntered.settled,
      false,
      `served force reindex escaped to the module singleton and overlapped startup: ${JSON.stringify({
        events,
        wrongResetOverlappedStartup,
      })}`,
    )
    assert.equal(boundResetEntered.settled, false)
    assert.equal(observedForce.state, "pending")

    startupCleanupRelease.resolve()
    await startupClosed.promise
    await boundResetEntered.promise
    assert.equal(boundResetOverlappedStartup, false)
    boundResetRelease.resolve()

    const forceResult = await forceCall
    assert.equal(forceResult.isError, undefined)
    assert.equal(JSON.parse(forceResult.content[0].text).status, "ok")
    assert.deepEqual(events, [
      "startup-open",
      "startup-abort",
      "startup-close",
      "bound-reset",
      "bound-reindex",
    ])
  } finally {
    restoreMaintenance()
    startupCleanupRelease.resolve()
    boundResetRelease.resolve()
    wrongResetRelease.resolve()
    await Promise.allSettled([startupCall, forceCall].filter(Boolean))
    rmSync(root, { recursive: true, force: true })
  }
})

test("timed-out startup retains same-root maintenance until aborted cleanup closes its DB handle", async () => {
  const root = makeRoot("desk-startup-budget-maintenance-")
  const otherRoot = makeRoot("desk-startup-budget-maintenance-other-")
  writeStartupBudget(root, 0)
  const startupEntered = deferred()
  const startupCleanupRelease = deferred()
  const startupClosed = deferred()
  const forceResetEntered = deferred()
  const forceResetRelease = deferred()
  const forceEnsureEntered = deferred()
  const forceEnsureRelease = deferred()
  const nonForceEntered = deferred()
  const nonForceRelease = deferred()
  const readEnsureEntered = deferred()
  const readEnsureRelease = deferred()
  const events = []
  const unhandled = []
  let startupHandleOpen = false
  let resetOverlappedStartup = false
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)

  const ensureIndex = async (deskRoot, opts = {}) => {
    if (opts.startup) {
      startupHandleOpen = true
      events.push("startup-open")
      startupEntered.resolve()
      opts.signal.addEventListener("abort", () => {
        events.push("startup-abort")
      }, { once: true })
      await startupCleanupRelease.promise
      startupHandleOpen = false
      events.push("startup-close")
      startupClosed.resolve()
      throw new Error("late startup rejection after cleanup")
    }
    if (opts.marker === "force") {
      events.push("force-ensure")
      forceEnsureEntered.resolve()
      await forceEnsureRelease.promise
    } else if (opts.marker === "non-force") {
      events.push("non-force-ensure")
      nonForceEntered.resolve()
      await nonForceRelease.promise
    } else if (opts.marker === "read") {
      events.push("read-ensure")
      readEnsureEntered.resolve()
      await readEnsureRelease.promise
    } else if (opts.marker === "other-root") {
      assert.equal(deskRoot, path.resolve(otherRoot))
      events.push("other-root-ensure")
    }
    return { built: false, reason: "fresh" }
  }
  const maintenance = createMaintenanceCoordinator({
    ensureIndex,
    resetIndex: async () => {
      resetOverlappedStartup = startupHandleOpen
      events.push("force-reset")
      forceResetEntered.resolve()
      await forceResetRelease.promise
    },
    openIndex: () => {
      events.push("read-open")
      return { open: true }
    },
    closeIndex: () => {
      events.push("read-close")
    },
  })
  const runtimeServer = runtimeServerWithEnsureIndex({
    ensureIndex,
    maintenanceCoordinator: maintenance,
  })
  let forceReindex
  let nonForceReindex
  let freshRead

  try {
    const startup = main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      mcpRoot: root,
      runtimeImporter: async () => runtimeServer,
    })
    await startupEntered.promise
    await startup

    assert.deepEqual(runtimeServer.events, ["startServer"])
    assert.deepEqual(events.slice(0, 2), ["startup-open", "startup-abort"])
    assert.equal(events.includes("startup-abort"), true)
    assert.equal(startupHandleOpen, true)
    const startupStatus = runtimeServer.startCalls[0].statusContext.startup
    assert.deepEqual(startupStatus.ensure_index, {
      built: false,
      reason: "startup_budget_exceeded",
      deferred: true,
    })
    assert.equal(startupStatus.duration_ms >= 0, true)
    assert.equal(startupStatus.budget_ms, 0)
    assert.equal(startupStatus.fallback_mode, "startup_deferred")
    assert.equal(startupStatus.degraded, true)

    assert.deepEqual(
      await maintenance.runExplicitReindex({
        deskRoot: otherRoot,
        ensureOptions: { marker: "other-root" },
      }),
      { built: false, reason: "fresh" },
    )
    assert.equal(startupHandleOpen, true)

    forceReindex = maintenance.runExplicitReindex({
      deskRoot: root,
      force: true,
      ensureOptions: { marker: "force" },
    })
    nonForceReindex = maintenance.runExplicitReindex({
      deskRoot: root,
      ensureOptions: { marker: "non-force" },
    })
    freshRead = maintenance.runFreshRead({
      deskRoot: root,
      ensureOptions: { marker: "read" },
      read: () => {
        events.push("read")
        return "read-result"
      },
    })
    const forceState = observeSettlement(forceReindex)
    const nonForceState = observeSettlement(nonForceReindex)
    const readState = observeSettlement(freshRead)
    await flushAsyncWork()

    assert.equal(
      forceResetEntered.settled,
      false,
      "force reindex must wait for timed-out startup cleanup",
    )
    assert.equal(nonForceEntered.settled, false)
    assert.equal(readEnsureEntered.settled, false)
    assert.equal(forceState.state, "pending")
    assert.equal(nonForceState.state, "pending")
    assert.equal(readState.state, "pending")

    startupCleanupRelease.resolve()
    await startupClosed.promise
    await forceResetEntered.promise
    assert.equal(resetOverlappedStartup, false)
    assert.equal(forceEnsureEntered.settled, false)
    assert.equal(nonForceEntered.settled, false)
    assert.equal(readEnsureEntered.settled, false)

    forceResetRelease.resolve()
    await forceEnsureEntered.promise
    assert.equal(nonForceEntered.settled, false)
    assert.equal(readEnsureEntered.settled, false)
    forceEnsureRelease.resolve()
    assert.deepEqual(await forceReindex, { built: false, reason: "fresh" })

    await nonForceEntered.promise
    assert.equal(readEnsureEntered.settled, false)
    nonForceRelease.resolve()
    assert.deepEqual(await nonForceReindex, { built: false, reason: "fresh" })

    await readEnsureEntered.promise
    readEnsureRelease.resolve()
    assert.equal(await freshRead, "read-result")
    await flushAsyncWork()

    assert.deepEqual(events, [
      "startup-open",
      "startup-abort",
      "other-root-ensure",
      "startup-close",
      "force-reset",
      "force-ensure",
      "non-force-ensure",
      "read-ensure",
      "read-open",
      "read",
      "read-close",
    ])
    assert.deepEqual(unhandled, [])
  } finally {
    process.off("unhandledRejection", onUnhandled)
    startupCleanupRelease.resolve()
    forceResetRelease.resolve()
    forceEnsureRelease.resolve()
    nonForceRelease.resolve()
    readEnsureRelease.resolve()
    await Promise.allSettled([forceReindex, nonForceReindex, freshRead].filter(Boolean))
    rmSync(root, { recursive: true, force: true })
    rmSync(otherRoot, { recursive: true, force: true })
  }
})

test("startup maintenance releases the root queue after success and handled error", async () => {
  const root = makeRoot("desk-startup-budget-maintenance-release-")
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)

  async function runScenario({ startupError }) {
    const events = []
    const ensureIndex = async (_deskRoot, opts = {}) => {
      if (opts.startup) {
        events.push(startupError ? "startup-error" : "startup-success")
        if (startupError) throw startupError
        return { built: false, reason: "fresh" }
      }
      events.push("after-startup")
      return { built: false, reason: "fresh" }
    }
    const maintenance = createMaintenanceCoordinator({ ensureIndex })
    const runtimeServer = runtimeServerWithEnsureIndex({
      ensureIndex,
      maintenanceCoordinator: maintenance,
    })

    await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => runtimeServer,
    })
    const afterStartup = await maintenance.runExplicitReindex({
      deskRoot: root,
      ensureOptions: { marker: "after-startup" },
    })
    return { afterStartup, events, runtimeServer }
  }

  try {
    const success = await runScenario({ startupError: null })
    assert.deepEqual(success.events, ["startup-success", "after-startup"])
    assert.equal(
      success.runtimeServer.startCalls[0].statusContext.startup.ensure_index.reason,
      "fresh",
    )
    assert.deepEqual(success.afterStartup, { built: false, reason: "fresh" })

    const error = await runScenario({
      startupError: new Error("startup maintenance failed"),
    })
    assert.deepEqual(error.events, ["startup-error", "after-startup"])
    assert.equal(
      error.runtimeServer.startCalls[0].statusContext.startup.ensure_index.reason,
      "startup_error",
    )
    assert.deepEqual(error.afterStartup, { built: false, reason: "fresh" })

    await flushAsyncWork()
    assert.deepEqual(unhandled, [])
  } finally {
    process.off("unhandledRejection", onUnhandled)
    rmSync(root, { recursive: true, force: true })
  }
})

test("startup skips bounded ensureIndex when the runtime server has no ensureIndex hook", async () => {
  const root = makeRoot("desk-startup-budget-no-hook-")
  const startCalls = []
  const maintenanceCoordinator = createMaintenanceCoordinator({
    ensureIndex: async () => ({ built: false, reason: "fresh" }),
  })
  try {
    await main({
      argv: ["--root", root],
      env: {},
      cwd: root,
      homeDir: root,
      runtimeImporter: async () => ({
        maintenanceCoordinator,
        async startServer(args) {
          startCalls.push(args)
        },
      }),
    })

    assert.equal(startCalls.length, 1)
    assert.deepEqual(startCalls[0].statusContext.startup, {
      fallback_mode: "not_checked",
      degraded: false,
      duration_ms: 0,
      budget_ms: 250,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
