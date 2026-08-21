import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { createSemanticRepairCoordinator } from "../../src/indexer/semantic-repair.js"

const maintenanceModuleUrl = new URL(
  "../../src/indexer/maintenance.js",
  import.meta.url,
)
const TEST_TIMEOUT_MS = 1000

async function loadMaintenance() {
  try {
    return await import(maintenanceModuleUrl.href)
  } catch (error) {
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      String(error.message).includes("maintenance.js")
    ) {
      assert.fail(
        "missing search maintenance integration: add src/indexer/maintenance.js with createRootMaintenanceQueue(), createMaintenanceCoordinator(), maintenanceCoordinator, and __setMaintenanceCoordinatorForTests()",
      )
    }
    throw error
  }
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

async function awaitBounded(promise, message, timeoutMs = TEST_TIMEOUT_MS) {
  let timeout
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(message)
          error.code = "ERR_TEST_TIMEOUT"
          reject(error)
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function flushAsyncWork(message) {
  await awaitBounded(
    new Promise((resolve) => setImmediate(resolve)),
    message,
  )
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

function createManualScheduler() {
  const queued = []
  return {
    clear(handle) {
      handle.cancelled = true
    },
    get size() {
      return queued.filter((entry) => !entry.handle.cancelled).length
    },
    async runNext() {
      const entry = queued.shift()
      assert.ok(entry, "expected one scheduled semantic repair batch")
      if (entry.handle.cancelled) return undefined
      return entry.callback()
    },
    schedule(callback, delay) {
      const handle = {
        cancelled: false,
        delay,
        unrefCalled: false,
        unref() {
          this.unrefCalled = true
        },
      }
      queued.push({ callback, handle })
      return handle
    },
  }
}

async function makeRoot(prefix) {
  return fs.mkdtemp(path.join(tmpdir(), prefix))
}

async function removeRoots(...roots) {
  await awaitBounded(
    Promise.all(
      roots.map((root) => fs.rm(root, { recursive: true, force: true })),
    ),
    "maintenance fixture cleanup timed out",
  )
}

test("search freshness finishes before scheduling one reused same-root repair job", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = await makeRoot("desk-maintenance-search-")
  const scheduler = createManualScheduler()
  const freshnessEntered = deferred()
  const freshnessRelease = deferred()
  const ensureCalls = []
  const repairCalls = []
  const embed = { fetch: async () => null }
  let ensureCallCount = 0
  let first
  let second
  let firstResult
  let secondResult

  const maintenance = createMaintenanceCoordinator({
    ensureIndex: async (deskRoot, options) => {
      ensureCallCount += 1
      ensureCalls.push({ deskRoot, options })
      if (ensureCallCount === 1) {
        freshnessEntered.resolve()
        await awaitBounded(
          freshnessRelease.promise,
          "first same-root search freshness was not released",
        )
      }
      return {
        built: false,
        reason: "fresh",
        semantic: {
          chunks_total: 2,
          vectors_indexed: 1,
          missing_vectors: 1,
        },
      }
    },
    repairBatch: async (options) => {
      repairCalls.push(options)
      return {
        processed_chunks: 1,
        vectors_indexed: 1,
        remaining_chunks: 0,
        stopped_by: "complete",
      }
    },
    createRepairCoordinator: (options) =>
      createSemanticRepairCoordinator({
        ...options,
        schedule: scheduler.schedule,
        clearScheduled: scheduler.clear,
      }),
  })

  try {
    first = maintenance.ensureSearchFreshness({
      deskRoot: root,
      ensureOptions: { embed, marker: "first", skipEmbed: false },
    })
    await awaitBounded(
      freshnessEntered.promise,
      "first search freshness did not enter ensureIndex",
    )
    second = maintenance.ensureSearchFreshness({
      deskRoot: root,
      ensureOptions: { embed, marker: "second" },
    })

    assert.equal(
      scheduler.size,
      0,
      "semantic repair must not be scheduled before synchronous freshness completes",
    )

    freshnessRelease.resolve()
    const results = await awaitBounded(
      Promise.all([first, second]),
      "same-root search freshness calls did not settle",
    )
    firstResult = results[0]
    secondResult = results[1]

    assert.equal(ensureCalls.length, 2)
    for (const call of ensureCalls) {
      assert.equal(call.deskRoot, path.resolve(root))
      assert.equal(call.options.embed, embed)
      assert.equal(
        call.options.skipEmbed,
        true,
        "search freshness must override caller input and skip document embeddings",
      )
    }
    assert.equal(scheduler.size, 1, "same-root searches must queue one repair timer")
    assert.equal(
      firstResult.repair,
      secondResult.repair,
      "same-root searches must reuse the same in-flight repair promise",
    )
    assert.equal(repairCalls.length, 0)

    await awaitBounded(
      scheduler.runNext(),
      "scheduled semantic repair batch did not complete",
    )
    await awaitBounded(
      Promise.all([firstResult.repair, secondResult.repair]),
      "reused semantic repair promise did not settle",
    )

    assert.equal(repairCalls.length, 1)
    assert.equal(repairCalls[0].deskRoot, path.resolve(root))
    assert.equal(repairCalls[0].embed, embed)
    assert.equal("skipEmbed" in repairCalls[0], false)
    assert.equal("marker" in repairCalls[0], false)
  } finally {
    freshnessRelease.resolve()
    const settledFreshness = await awaitBounded(
      Promise.allSettled([first, second].filter(Boolean)),
      "same-root freshness calls did not settle during cleanup",
    ).catch(() => [])
    const repairPromises = [
      firstResult?.repair,
      secondResult?.repair,
      ...settledFreshness
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value?.repair),
    ].filter(Boolean)
    await awaitBounded(
      maintenance.cancelBackgroundRepair(root),
      "same-root maintenance did not settle during cleanup",
    ).catch(() => {})
    await awaitBounded(
      Promise.allSettled(repairPromises),
      "same-root repair promises did not settle during cleanup",
    ).catch(() => {})
    await removeRoots(root)
  }
})

test("coordinator lets root B complete while root A search freshness holds its lock", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const [rootA, rootB] = await Promise.all([
    makeRoot("desk-maintenance-root-a-"),
    makeRoot("desk-maintenance-root-b-"),
  ])
  const rootAEntered = deferred()
  const rootARelease = deferred()
  const rootBEntered = deferred()
  const events = []
  const ensureCalls = []
  const embedA = { fetch: async () => null }
  const embedB = { fetch: async () => null }
  let maintenance
  let rootAFreshness
  let rootBReindex

  try {
    maintenance = createMaintenanceCoordinator({
      ensureIndex: async (deskRoot, options) => {
        ensureCalls.push({ deskRoot, options })
        if (deskRoot === path.resolve(rootA)) {
          events.push("a:freshness:start")
          rootAEntered.resolve()
          await awaitBounded(
            rootARelease.promise,
            "root A search freshness was not released",
          )
          events.push("a:freshness:end")
          return {
            built: false,
            reason: "fresh",
            semantic: {
              chunks_total: 1,
              vectors_indexed: 1,
              missing_vectors: 0,
            },
          }
        }
        assert.equal(deskRoot, path.resolve(rootB))
        events.push("b:reindex:start")
        rootBEntered.resolve()
        events.push("b:reindex:end")
        return {
          built: true,
          reason: "semantic_missing",
          semantic: {
            chunks_total: 2,
            vectors_indexed: 2,
            missing_vectors: 0,
          },
        }
      },
      repairBatch: async () => {
        assert.fail("complete semantic coverage must not schedule repair")
      },
    })

    rootAFreshness = maintenance.ensureSearchFreshness({
      deskRoot: rootA,
      ensureOptions: { embed: embedA },
    })
    await awaitBounded(
      rootAEntered.promise,
      "root A search freshness did not enter the coordinator",
    )
    const observedRootA = observeSettlement(rootAFreshness)

    rootBReindex = maintenance.runExplicitReindex({
      deskRoot: rootB,
      force: false,
      ensureOptions: { embed: embedB },
    })
    await awaitBounded(
      rootBEntered.promise,
      "root B coordinator operation did not start independently",
    )
    const rootBResult = await awaitBounded(
      rootBReindex,
      "root B coordinator operation was incorrectly blocked by root A",
    )
    assert.equal(rootBResult.reason, "semantic_missing")
    assert.equal(rootBResult.semantic.missing_vectors, 0)
    assert.equal(observedRootA.state, "pending")
    assert.deepEqual(events, [
      "a:freshness:start",
      "b:reindex:start",
      "b:reindex:end",
    ])

    rootARelease.resolve()
    const rootAResult = await awaitBounded(
      rootAFreshness,
      "root A search freshness did not settle after release",
    )
    await awaitBounded(
      rootAResult.repair,
      "root A no-op repair promise did not settle",
    )
    assert.deepEqual(events, [
      "a:freshness:start",
      "b:reindex:start",
      "b:reindex:end",
      "a:freshness:end",
    ])
    assert.deepEqual(ensureCalls, [
      {
        deskRoot: path.resolve(rootA),
        options: { embed: embedA, skipEmbed: true },
      },
      {
        deskRoot: path.resolve(rootB),
        options: { embed: embedB },
      },
    ])
  } finally {
    rootARelease.resolve()
    if (maintenance) {
      await awaitBounded(
        Promise.all([
          maintenance.cancelBackgroundRepair(rootA),
          maintenance.cancelBackgroundRepair(rootB),
        ]),
        "different-root coordinator cleanup did not settle",
      ).catch(() => {})
    }
    await awaitBounded(
      Promise.allSettled([rootAFreshness, rootBReindex].filter(Boolean)),
      "different-root coordinator promises did not settle during cleanup",
    ).catch(() => {})
    await removeRoots(rootA, rootB)
  }
})

test("force reindex holds one continuous lock across reset and full repair before a queued same-root writer", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = await makeRoot("desk-maintenance-reindex-")
  const backgroundStarted = deferred()
  const backgroundAborted = deferred()
  const backgroundCleanupRelease = deferred()
  const resetStarted = deferred()
  const resetRelease = deferred()
  const fullRepairStarted = deferred()
  const fullRepairRelease = deferred()
  const competingWriterStarted = deferred()
  const competingWriterRelease = deferred()
  const events = []
  const resetCalls = []
  const ensureCalls = []
  const activeByRoot = new Map()
  const embed = { fetch: async () => null }
  let overlapThrows = 0
  let maxSameRootWriters = 0
  let freshnessCalls = 0
  let explicitReindex
  let competingFreshness
  let competingResult
  let searchFreshness
  let maintenance

  async function guardedWriter(deskRoot, label, operation) {
    const canonical = path.resolve(deskRoot)
    const active = activeByRoot.get(canonical)
    if (active) {
      overlapThrows += 1
      const error = new Error(`SQLITE_BUSY overlap: ${label} while ${active}`)
      error.code = "SQLITE_BUSY"
      throw error
    }
    activeByRoot.set(canonical, label)
    maxSameRootWriters = Math.max(maxSameRootWriters, activeByRoot.size)
    events.push(`${label}:start`)
    try {
      return await operation()
    } finally {
      events.push(`${label}:end`)
      activeByRoot.delete(canonical)
    }
  }

  function createRepairCoordinator({ repairBatch }) {
    let active = null
    let controller = null
    return {
      start(options) {
        if (active) return active
        controller = new AbortController()
        active = repairBatch({
          ...options,
          signal: controller.signal,
        })
        return active
      },
      async cancel(deskRoot) {
        events.push("cancel:start")
        assert.equal(deskRoot, path.resolve(root))
        controller?.abort()
        if (active) {
          await awaitBounded(
            active,
            "background repair cleanup was not awaited by cancellation",
          )
        }
        events.push("cancel:cleanup-awaited")
        events.push("cancel:done")
        return {
          state: "idle",
          last_error: null,
          cancelled: true,
        }
      },
      status() {
        return { state: active ? "running" : "idle", last_error: null }
      },
    }
  }

  maintenance = createMaintenanceCoordinator({
    ensureIndex: async (deskRoot, options) => {
      ensureCalls.push({ deskRoot, options })
      if (options.skipEmbed) {
        freshnessCalls += 1
        const label =
          freshnessCalls === 1 ? "freshness" : "competing-freshness"
        return guardedWriter(deskRoot, label, async () => {
          if (freshnessCalls > 1) {
            competingWriterStarted.resolve()
            await awaitBounded(
              competingWriterRelease.promise,
              "competing same-root writer was not released",
            )
          }
          return {
            built: false,
            reason: "fresh",
            semantic: {
              chunks_total: 2,
              vectors_indexed: freshnessCalls === 1 ? 1 : 2,
              missing_vectors: freshnessCalls === 1 ? 1 : 0,
            },
          }
        })
      }
      return guardedWriter(deskRoot, "reindex:ensure", async () => {
        fullRepairStarted.resolve()
        await awaitBounded(
          fullRepairRelease.promise,
          "full explicit repair was not released",
        )
        return {
          built: true,
          reason: "semantic_missing",
          semantic: {
            chunks_total: 2,
            vectors_indexed: 2,
            missing_vectors: 0,
          },
        }
      })
    },
    repairBatch: async ({ deskRoot, signal }) => {
      return guardedWriter(deskRoot, "background", async () => {
        backgroundStarted.resolve()
        await awaitBounded(
          new Promise((resolve) => {
            const onAbort = () => {
              events.push("background:abort")
              backgroundAborted.resolve()
              resolve()
            }
            if (signal.aborted) onAbort()
            else signal.addEventListener("abort", onAbort, { once: true })
          }),
          "background repair did not observe explicit-reindex cancellation",
        )
        await awaitBounded(
          backgroundCleanupRelease.promise,
          "background repair cleanup was not released",
        )
        events.push("background:cleanup")
        return {
          processed_chunks: 0,
          vectors_indexed: 0,
          remaining_chunks: 1,
          stopped_by: "cancelled",
          cancelled: true,
        }
      })
    },
    createRepairCoordinator,
    resetIndex: async (options) => {
      resetCalls.push(options)
      return guardedWriter(options.deskRoot, "reindex:reset", async () => {
        resetStarted.resolve()
        await awaitBounded(
          resetRelease.promise,
          "force reset was not released",
        )
      })
    },
  })

  try {
    searchFreshness = await awaitBounded(
      maintenance.ensureSearchFreshness({
        deskRoot: root,
        ensureOptions: { embed },
      }),
      "initial search freshness did not settle",
    )
    await awaitBounded(
      backgroundStarted.promise,
      "background repair did not start after search freshness",
    )

    explicitReindex = maintenance.runExplicitReindex({
      deskRoot: root,
      force: true,
      ensureOptions: { embed },
    })
    const observedReindex = observeSettlement(explicitReindex)

    await awaitBounded(
      backgroundAborted.promise,
      "explicit reindex did not abort the active background repair",
    )
    assert.equal(resetStarted.settled, false)
    assert.equal(ensureCalls.length, 1)
    assert.equal(observedReindex.state, "pending")

    backgroundCleanupRelease.resolve()
    await awaitBounded(
      resetStarted.promise,
      "force reset did not start after background cleanup completed",
    )
    const cancellationOrder = [
      "cancel:start",
      "background:abort",
      "background:cleanup",
      "background:end",
      "cancel:cleanup-awaited",
      "cancel:done",
      "reindex:reset:start",
    ].map((event) => events.indexOf(event))
    assert.ok(
      cancellationOrder.every((index) => index >= 0),
      "cancel, cleanup, and reset events must all be observable",
    )
    assert.deepEqual(
      [...cancellationOrder].sort((a, b) => a - b),
      cancellationOrder,
      "explicit reindex must cancel, await cleanup, then enter the locked reset",
    )
    assert.equal(observedReindex.state, "pending")

    competingFreshness = maintenance.ensureSearchFreshness({
      deskRoot: root,
      ensureOptions: { embed },
    })
    await flushAsyncWork(
      "queued same-root writer check did not reach a deterministic turn",
    )
    assert.equal(
      competingWriterStarted.settled,
      false,
      "competing writer entered while force reset held the root lock",
    )

    resetRelease.resolve()
    const nextWriter = await awaitBounded(
      Promise.race([
        fullRepairStarted.promise.then(() => "full-repair"),
        competingWriterStarted.promise.then(() => "competitor"),
      ]),
      "neither full repair nor the competing writer started after reset",
    )
    assert.equal(
      nextWriter,
      "full-repair",
      "separate reset and repair mutex acquisitions let the queued writer interleave",
    )
    assert.equal(competingWriterStarted.settled, false)
    assert.deepEqual(resetCalls, [{ deskRoot: path.resolve(root) }])
    assert.equal(ensureCalls.length, 2)
    assert.equal(ensureCalls[1].deskRoot, path.resolve(root))
    assert.equal(ensureCalls[1].options.embed, embed)
    assert.equal(
      "skipEmbed" in ensureCalls[1].options,
      false,
      "explicit reindex must run the complete embeddings-enabled repair path",
    )
    await flushAsyncWork(
      "full-repair lock check did not reach a deterministic turn",
    )
    assert.equal(competingWriterStarted.settled, false)
    assert.equal(observedReindex.state, "pending")
    assert.equal(overlapThrows, 0)
    assert.equal(maxSameRootWriters, 1)

    fullRepairRelease.resolve()
    const result = await awaitBounded(
      explicitReindex,
      "explicit reindex did not await its complete repair",
    )
    assert.equal(result.reason, "semantic_missing")
    assert.equal(result.semantic.missing_vectors, 0)
    await awaitBounded(
      competingWriterStarted.promise,
      "queued same-root writer did not start after explicit reindex completed",
    )

    const resetEnd = events.indexOf("reindex:reset:end")
    const fullStart = events.indexOf("reindex:ensure:start")
    const fullEnd = events.indexOf("reindex:ensure:end")
    const competingStart = events.indexOf("competing-freshness:start")
    assert.equal(
      fullStart,
      resetEnd + 1,
      "reset and full repair must be adjacent inside one continuous root lock",
    )
    assert.ok(fullStart < fullEnd)
    assert.ok(
      fullEnd < competingStart,
      "competing writer must start only after the complete reindex releases the lock",
    )

    competingWriterRelease.resolve()
    competingResult = await awaitBounded(
      competingFreshness,
      "competing search freshness did not settle after release",
    )
    await awaitBounded(
      searchFreshness.repair,
      "cancelled background repair promise did not settle",
    )
    await awaitBounded(
      competingResult.repair,
      "competing search repair promise did not settle",
    )
    assert.equal(overlapThrows, 0)
    assert.equal(maxSameRootWriters, 1)
  } finally {
    backgroundCleanupRelease.resolve()
    resetRelease.resolve()
    fullRepairRelease.resolve()
    competingWriterRelease.resolve()
    if (maintenance) {
      await awaitBounded(
        maintenance.cancelBackgroundRepair(root),
        "maintenance did not settle during force-reindex cleanup",
      ).catch(() => {})
    }
    await awaitBounded(
      Promise.allSettled(
        [
          explicitReindex,
          competingFreshness,
          competingResult?.repair,
          searchFreshness?.repair,
        ].filter(Boolean),
      ),
      "force-reindex test promises did not settle during cleanup",
    ).catch(() => {})
    await removeRoots(root)
  }
})

test("root maintenance queue releases after success, rejection, and cancellation", async () => {
  const { createRootMaintenanceQueue } = await loadMaintenance()
  const root = await makeRoot("desk-maintenance-release-")
  const queue = createRootMaintenanceQueue()
  const successEntered = deferred()
  const successRelease = deferred()
  const rejectionEntered = deferred()
  const rejectionRelease = deferred()
  const cancellationEntered = deferred()
  const controller = new AbortController()
  let success
  let afterSuccess
  let rejected
  let afterRejection
  let cancelled
  let afterCancellation

  try {
    success = queue.run(root, async () => {
      successEntered.resolve()
      await awaitBounded(
        successRelease.promise,
        "successful writer was not released",
      )
      return "success"
    })
    await awaitBounded(successEntered.promise, "success writer did not enter")
    afterSuccess = queue.run(root, async () => "after-success")
    const afterSuccessState = observeSettlement(afterSuccess)
    assert.equal(afterSuccessState.state, "pending")
    successRelease.resolve()
    assert.equal(await awaitBounded(success, "success writer did not settle"), "success")
    assert.equal(
      await awaitBounded(afterSuccess, "queue stayed locked after success"),
      "after-success",
    )

    rejected = queue.run(root, async () => {
      rejectionEntered.resolve()
      await awaitBounded(
        rejectionRelease.promise,
        "rejecting writer was not released",
      )
      throw new Error("writer rejected")
    })
    const rejectedAssertion = assert.rejects(rejected, /writer rejected/)
    await awaitBounded(rejectionEntered.promise, "rejecting writer did not enter")
    afterRejection = queue.run(root, async () => "after-rejection")
    rejectionRelease.resolve()
    await awaitBounded(rejectedAssertion, "rejecting writer did not settle")
    assert.equal(
      await awaitBounded(afterRejection, "queue stayed locked after rejection"),
      "after-rejection",
    )

    cancelled = queue.run(root, async () => {
      cancellationEntered.resolve()
      await awaitBounded(
        new Promise((_, reject) => {
          const onAbort = () => {
            const error = new Error("writer cancelled")
            error.name = "AbortError"
            reject(error)
          }
          if (controller.signal.aborted) onAbort()
          else controller.signal.addEventListener("abort", onAbort, { once: true })
        }),
        "cancellable writer did not observe abort",
      )
    })
    const cancelledAssertion = assert.rejects(
      cancelled,
      (error) => error?.name === "AbortError",
    )
    await awaitBounded(
      cancellationEntered.promise,
      "cancellable writer did not enter",
    )
    afterCancellation = queue.run(root, async () => "after-cancellation")
    controller.abort()
    await awaitBounded(cancelledAssertion, "cancelled writer did not settle")
    assert.equal(
      await awaitBounded(
        afterCancellation,
        "queue stayed locked after cancellation",
      ),
      "after-cancellation",
    )
  } finally {
    successRelease.resolve()
    rejectionRelease.resolve()
    controller.abort()
    await awaitBounded(
      Promise.allSettled(
        [
          success,
          afterSuccess,
          rejected,
          afterRejection,
          cancelled,
          afterCancellation,
        ].filter(Boolean),
      ),
      "root queue promises did not settle during cleanup",
    ).catch(() => {})
    await removeRoots(root)
  }
})
