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

  const maintenance = createMaintenanceCoordinator({
    ensureIndex: async (deskRoot, options) => {
      ensureCallCount += 1
      ensureCalls.push({ deskRoot, options })
      if (ensureCallCount === 1) {
        freshnessEntered.resolve()
        await freshnessRelease.promise
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
    const first = maintenance.ensureSearchFreshness({
      deskRoot: root,
      ensureOptions: { embed, marker: "first", skipEmbed: false },
    })
    await awaitBounded(
      freshnessEntered.promise,
      "first search freshness did not enter ensureIndex",
    )
    const second = maintenance.ensureSearchFreshness({
      deskRoot: root,
      ensureOptions: { embed, marker: "second" },
    })

    assert.equal(
      scheduler.size,
      0,
      "semantic repair must not be scheduled before synchronous freshness completes",
    )

    freshnessRelease.resolve()
    const [firstResult, secondResult] = await awaitBounded(
      Promise.all([first, second]),
      "same-root search freshness calls did not settle",
    )

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
    await removeRoots(root)
  }
})

test("one root queue serializes freshness, repair, and reindex while other roots stay independent", async () => {
  const { createRootMaintenanceQueue } = await loadMaintenance()
  const [rootA, rootB] = await Promise.all([
    makeRoot("desk-maintenance-root-a-"),
    makeRoot("desk-maintenance-root-b-"),
  ])
  const queue = createRootMaintenanceQueue()
  const freshnessEntered = deferred()
  const freshnessRelease = deferred()
  const events = []

  try {
    const freshness = queue.run(rootA, async () => {
      events.push("a:freshness:start")
      freshnessEntered.resolve()
      await freshnessRelease.promise
      events.push("a:freshness:end")
    })
    await awaitBounded(
      freshnessEntered.promise,
      "root A freshness writer did not enter the maintenance queue",
    )

    const repair = queue.run(rootA, async () => {
      events.push("a:repair:start")
      events.push("a:repair:end")
    })
    const reindex = queue.run(rootA, async () => {
      events.push("a:reindex:start")
      events.push("a:reindex:end")
    })
    const otherRoot = queue.run(rootB, async () => {
      events.push("b:writer:start")
      events.push("b:writer:end")
      return "root-b-complete"
    })

    assert.equal(
      await awaitBounded(
        otherRoot,
        "different-root maintenance was incorrectly blocked",
      ),
      "root-b-complete",
    )
    assert.deepEqual(events, [
      "a:freshness:start",
      "b:writer:start",
      "b:writer:end",
    ])

    freshnessRelease.resolve()
    await awaitBounded(
      Promise.all([freshness, repair, reindex]),
      "same-root maintenance queue did not drain",
    )
    assert.deepEqual(events, [
      "a:freshness:start",
      "b:writer:start",
      "b:writer:end",
      "a:freshness:end",
      "a:repair:start",
      "a:repair:end",
      "a:reindex:start",
      "a:reindex:end",
    ])
  } finally {
    freshnessRelease.resolve()
    await removeRoots(rootA, rootB)
  }
})

test("force reindex cancels cleanup, then locks reset and complete repair behind a competing writer", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = await makeRoot("desk-maintenance-reindex-")
  const backgroundStarted = deferred()
  const backgroundAborted = deferred()
  const backgroundCleanupRelease = deferred()
  const cancelReturnRelease = deferred()
  const cancelDone = deferred()
  const competingWriterStarted = deferred()
  const competingWriterRelease = deferred()
  const fullRepairStarted = deferred()
  const fullRepairRelease = deferred()
  const events = []
  const resetCalls = []
  const ensureCalls = []
  const activeByRoot = new Map()
  const embed = { fetch: async () => null }
  let overlapThrows = 0
  let freshnessCalls = 0
  let explicitReindex
  let competingFreshness
  let searchFreshness

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
        controller.abort()
        await active
        events.push("cancel:cleanup-awaited")
        await cancelReturnRelease.promise
        events.push("cancel:done")
        cancelDone.resolve()
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

  const maintenance = createMaintenanceCoordinator({
    ensureIndex: async (deskRoot, options) => {
      ensureCalls.push({ deskRoot, options })
      if (options.skipEmbed) {
        freshnessCalls += 1
        const label =
          freshnessCalls === 1 ? "freshness" : "competing-freshness"
        return guardedWriter(deskRoot, label, async () => {
          if (freshnessCalls > 1) {
            competingWriterStarted.resolve()
            await competingWriterRelease.promise
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
        })
      }
      return guardedWriter(deskRoot, "reindex:ensure", async () => {
        fullRepairStarted.resolve()
        await fullRepairRelease.promise
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
        await new Promise((resolve) => {
          const onAbort = () => {
            events.push("background:abort")
            backgroundAborted.resolve()
            resolve()
          }
          if (signal.aborted) onAbort()
          else signal.addEventListener("abort", onAbort, { once: true })
        })
        await backgroundCleanupRelease.promise
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
      return guardedWriter(options.deskRoot, "reindex:reset", async () => {})
    },
  })

  try {
    searchFreshness = await maintenance.ensureSearchFreshness({
      deskRoot: root,
      ensureOptions: { embed },
    })
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
    competingFreshness = maintenance.ensureSearchFreshness({
      deskRoot: root,
      ensureOptions: { embed },
    })
    assert.equal(resetCalls.length, 0)
    assert.equal(
      ensureCalls.length,
      1,
      "explicit repair must not start until background cleanup completes",
    )
    assert.equal(observedReindex.state, "pending")

    backgroundCleanupRelease.resolve()
    await awaitBounded(
      competingWriterStarted.promise,
      "competing writer did not acquire the root lock after background cleanup",
    )
    assert.equal(resetCalls.length, 0)
    assert.equal(overlapThrows, 0)
    assert.equal(observedReindex.state, "pending")

    cancelReturnRelease.resolve()
    await awaitBounded(
      cancelDone.promise,
      "explicit reindex cancellation did not finish after cleanup",
    )
    await flushAsyncWork(
      "force-reindex reset overlap check did not reach a deterministic turn",
    )
    assert.equal(
      resetCalls.length,
      0,
      "force reset must remain behind the same per-root mutex while another writer owns it",
    )
    assert.equal(
      overlapThrows,
      0,
      "reset outside the root mutex would overlap the competing writer",
    )
    assert.equal(observedReindex.state, "pending")

    competingWriterRelease.resolve()
    const competingResult = await awaitBounded(
      competingFreshness,
      "competing writer did not release the root mutex",
    )
    await awaitBounded(
      fullRepairStarted.promise,
      "explicit reindex did not acquire the root lock after the competing writer",
    )

    assert.deepEqual(resetCalls, [{ deskRoot: path.resolve(root) }])
    assert.equal(ensureCalls.length, 3)
    assert.equal(ensureCalls[2].deskRoot, path.resolve(root))
    assert.equal(ensureCalls[2].options.embed, embed)
    assert.equal(
      "skipEmbed" in ensureCalls[2].options,
      false,
      "explicit reindex must run the complete embeddings-enabled repair path",
    )
    assert.ok(events.indexOf("background:cleanup") < events.indexOf("cancel:done"))
    assert.ok(
      events.indexOf("competing-freshness:start") <
        events.indexOf("cancel:done"),
    )
    assert.ok(
      events.indexOf("cancel:done") <
        events.indexOf("competing-freshness:end"),
    )
    assert.ok(
      events.indexOf("competing-freshness:end") <
        events.indexOf("reindex:reset:start"),
    )
    assert.ok(
      events.indexOf("reindex:reset:end") <
        events.indexOf("reindex:ensure:start"),
    )

    fullRepairRelease.resolve()
    const result = await awaitBounded(
      explicitReindex,
      "explicit reindex did not await its complete repair",
    )
    assert.equal(result.reason, "semantic_missing")
    assert.equal(result.semantic.missing_vectors, 0)
    await awaitBounded(
      searchFreshness.repair,
      "cancelled background repair promise did not settle",
    )
    await awaitBounded(
      competingResult.repair,
      "competing search repair promise did not settle",
    )
    assert.ok(
      events.indexOf("reindex:ensure:start") <
        events.indexOf("reindex:ensure:end"),
    )
  } finally {
    backgroundCleanupRelease.resolve()
    cancelReturnRelease.resolve()
    competingWriterRelease.resolve()
    fullRepairRelease.resolve()
    if (maintenance) {
      await awaitBounded(
        maintenance.cancelBackgroundRepair(root),
        "maintenance did not settle during force-reindex cleanup",
      ).catch(() => {})
    }
    await awaitBounded(
      Promise.allSettled(
        [explicitReindex, competingFreshness, searchFreshness?.repair].filter(
          Boolean,
        ),
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

  try {
    const successEntered = deferred()
    const successRelease = deferred()
    const success = queue.run(root, async () => {
      successEntered.resolve()
      await successRelease.promise
      return "success"
    })
    await awaitBounded(successEntered.promise, "success writer did not enter")
    const afterSuccess = queue.run(root, async () => "after-success")
    const afterSuccessState = observeSettlement(afterSuccess)
    assert.equal(afterSuccessState.state, "pending")
    successRelease.resolve()
    assert.equal(await awaitBounded(success, "success writer did not settle"), "success")
    assert.equal(
      await awaitBounded(afterSuccess, "queue stayed locked after success"),
      "after-success",
    )

    const rejectionEntered = deferred()
    const rejectionRelease = deferred()
    const rejected = queue.run(root, async () => {
      rejectionEntered.resolve()
      await rejectionRelease.promise
      throw new Error("writer rejected")
    })
    const rejectedAssertion = assert.rejects(rejected, /writer rejected/)
    await awaitBounded(rejectionEntered.promise, "rejecting writer did not enter")
    const afterRejection = queue.run(root, async () => "after-rejection")
    rejectionRelease.resolve()
    await awaitBounded(rejectedAssertion, "rejecting writer did not settle")
    assert.equal(
      await awaitBounded(afterRejection, "queue stayed locked after rejection"),
      "after-rejection",
    )

    const controller = new AbortController()
    const cancellationEntered = deferred()
    const cancelled = queue.run(root, async () => {
      cancellationEntered.resolve()
      await new Promise((_, reject) => {
        const onAbort = () => {
          const error = new Error("writer cancelled")
          error.name = "AbortError"
          reject(error)
        }
        if (controller.signal.aborted) onAbort()
        else controller.signal.addEventListener("abort", onAbort, { once: true })
      })
    })
    const cancelledAssertion = assert.rejects(
      cancelled,
      (error) => error?.name === "AbortError",
    )
    await awaitBounded(
      cancellationEntered.promise,
      "cancellable writer did not enter",
    )
    const afterCancellation = queue.run(root, async () => "after-cancellation")
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
    await removeRoots(root)
  }
})
