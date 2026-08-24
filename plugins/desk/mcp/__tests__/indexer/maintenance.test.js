import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { createSemanticRepairCoordinator } from "../../src/indexer/semantic-repair.js"
import {
  physicalRootKey,
  resolveRootIdentity,
} from "../../src/indexer/root-identity.js"
import { createModeledCaseCollisionRootIdentity } from "../fixtures/root_identity_fixture.js"

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

test("runtime maintenance binding brands one complete coordinator and rejects untrusted injection", async () => {
  const {
    __setMaintenanceCoordinatorForTests,
    createMaintenanceCoordinator,
    createMaintenanceRuntimeBinding,
    isMaintenanceCoordinator,
    maintenanceCoordinator,
    resolveRuntimeMaintenance,
  } = await loadMaintenance()
  const injected = createMaintenanceCoordinator({
    ensureIndex: async () => ({ built: false, reason: "fresh" }),
  })
  const other = createMaintenanceCoordinator({
    ensureIndex: async () => ({ built: false, reason: "fresh" }),
  })
  const methodCalls = []
  const structural = {
    async cancelBackgroundRepair() {
      methodCalls.push("structural:cancel")
    },
    async ensureSearchFreshness() {
      methodCalls.push("structural:freshness")
    },
    async runExplicitReindex() {
      methodCalls.push("structural:reindex")
    },
    async runFreshRead() {
      methodCalls.push("structural:read")
    },
    async runStartupEnsureIndex() {
      methodCalls.push("structural:startup")
    },
  }
  const inherited = Object.create(injected)
  const copied = { ...injected }
  const mixed = {
    ...injected,
    runExplicitReindex: other.runExplicitReindex,
  }

  assert.equal(isMaintenanceCoordinator(injected), true)
  assert.equal(isMaintenanceCoordinator(other), true)
  assert.equal(Object.isFrozen(injected), true)
  assert.equal(Object.isFrozen(other), true)
  assert.equal(isMaintenanceCoordinator(null), false)
  assert.equal(isMaintenanceCoordinator("coordinator"), false)
  assert.equal(isMaintenanceCoordinator({ runFreshRead() {} }), false)
  for (const untrusted of [structural, inherited, copied, mixed]) {
    assert.equal(isMaintenanceCoordinator(untrusted), false)
    assert.throws(
      () => createMaintenanceRuntimeBinding(untrusted),
      /maintenance coordinator is unavailable/i,
    )
    assert.throws(
      () => __setMaintenanceCoordinatorForTests(untrusted),
      /maintenance coordinator is unavailable/i,
    )
  }

  const bound = createMaintenanceRuntimeBinding(injected)
  assert.equal(bound.maintenanceCoordinator, injected)
  assert.equal(Object.isFrozen(bound), true)
  assert.deepEqual(Object.keys(bound), ["maintenanceCoordinator"])

  assert.throws(
    () => createMaintenanceRuntimeBinding({ runFreshRead() {} }),
    /maintenance coordinator is unavailable/i,
  )
  assert.throws(
    () => createMaintenanceRuntimeBinding(undefined),
    /maintenance coordinator is unavailable/i,
  )
  assert.equal(
    resolveRuntimeMaintenance({
      runtimeContext: bound,
    }),
    injected,
  )
  assert.equal(
    resolveRuntimeMaintenance(),
    maintenanceCoordinator,
  )
  assert.throws(
    () => resolveRuntimeMaintenance({
      opts: { maintenance: injected },
    }),
    /per-tool maintenance override/i,
  )
  const reflectedDescriptors = Object.getOwnPropertyDescriptors(bound)
  const reflectedForgery = Object.freeze(
    Object.defineProperties({}, reflectedDescriptors),
  )
  const inheritedBinding = Object.freeze(Object.create(bound))
  const copiedBinding = Object.freeze({ ...bound })
  for (const runtimeContext of [
    {},
    { maintenanceCoordinator: null },
    { maintenanceCoordinator: injected },
    { ...bound },
    copiedBinding,
    reflectedForgery,
    inheritedBinding,
    undefined,
  ]) {
    assert.throws(
      () => resolveRuntimeMaintenance({
        runtimeContext,
        runtimeContextProvided: true,
      }),
      /runtime binding is unavailable or untrusted/i,
    )
  }
  assert.throws(
    () => __setMaintenanceCoordinatorForTests({ runFreshRead() {} }),
    /maintenance coordinator is unavailable/i,
  )
  const restoreSingleton = __setMaintenanceCoordinatorForTests(other)
  try {
    assert.equal(resolveRuntimeMaintenance(), other)
  } finally {
    restoreSingleton()
  }
  assert.deepEqual(methodCalls, [])
})

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

test("modeled case-only referent aliases share one queue while the distinct case variant stays concurrent", async () => {
  const { createRootMaintenanceQueue } = await loadMaintenance()
  const fixture = createModeledCaseCollisionRootIdentity()
  const queue = createRootMaintenanceQueue({
    resolveIdentity: fixture.resolveIdentity,
  })
  const rootAEntered = deferred()
  const rootARelease = deferred()
  const aliasAEntered = deferred()
  const rootBEntered = deferred()
  let rootA
  let aliasA
  let rootB

  try {
    rootA = queue.run(fixture.rootA, async () => {
      rootAEntered.resolve()
      await rootARelease.promise
      return "root-a"
    })
    await awaitBounded(rootAEntered.promise, "modeled root A did not enter")
    aliasA = queue.run(fixture.aliasA, async () => {
      aliasAEntered.resolve()
      return "alias-a"
    })
    rootB = queue.run(fixture.rootB, async () => {
      rootBEntered.resolve()
      return "root-b"
    })

    await awaitBounded(
      rootBEntered.promise,
      "distinct case-variant root B did not remain concurrent",
    )
    await flushAsyncWork("modeled root queue did not settle")
    assert.equal(
      aliasAEntered.settled,
      false,
      "case-only symlink alias entered while its referent held the queue",
    )

    rootARelease.resolve()
    assert.deepEqual(
      await awaitBounded(
        Promise.all([rootA, aliasA, rootB]),
        "modeled root queue operations did not settle",
      ),
      ["root-a", "alias-a", "root-b"],
    )
  } finally {
    rootARelease.resolve()
    await Promise.allSettled([rootA, aliasA, rootB].filter(Boolean))
  }
})

test("same-path root replacement stays serialized when file IDs change", async () => {
  const { createRootMaintenanceQueue } = await loadMaintenance()
  const root = path.resolve("modeled-replaced-root")
  let inode = 100n
  const resolveIdentity = (deskRoot) =>
    resolveRootIdentity(deskRoot, {
      nativeRealpath: () => root,
      nativeStat: () => ({ dev: 1n, ino: inode++ }),
    })
  const queue = createRootMaintenanceQueue({
    resolveIdentity,
    validateIdentity: () => {},
  })
  const firstEntered = deferred()
  const firstRelease = deferred()
  const replacementEntered = deferred()
  let first
  let replacement

  try {
    first = queue.run(root, async () => {
      firstEntered.resolve()
      await firstRelease.promise
    })
    await awaitBounded(firstEntered.promise, "initial root did not enter")
    replacement = queue.run(root, async () => {
      replacementEntered.resolve()
    })
    await flushAsyncWork("replacement root queue did not settle")
    assert.equal(
      replacementEntered.settled,
      false,
      "replacing a root at the same canonical path split its maintenance queue",
    )
    firstRelease.resolve()
    await awaitBounded(
      Promise.all([first, replacement]),
      "same-path replacement operations did not settle",
    )
  } finally {
    firstRelease.resolve()
    await Promise.allSettled([first, replacement].filter(Boolean))
  }
})

test("queued work rejects a symlink retarget before invoking its writer", async () => {
  const { createRootMaintenanceQueue } = await loadMaintenance()
  const fixture = createModeledCaseCollisionRootIdentity()
  const queue = createRootMaintenanceQueue({
    resolveIdentity: fixture.resolveIdentity,
    validateIdentity: fixture.validateIdentity,
  })
  const firstEntered = deferred()
  const firstRelease = deferred()
  let staleWriterCalls = 0
  let first
  let stale

  try {
    first = queue.run(fixture.rootA, async () => {
      firstEntered.resolve()
      await firstRelease.promise
    })
    await awaitBounded(firstEntered.promise, "initial root did not enter")
    stale = queue.run(fixture.aliasA, async () => {
      staleWriterCalls += 1
    })
    fixture.retargetAlias(fixture.rootB)
    firstRelease.resolve()
    await awaitBounded(first, "initial root did not settle")
    await assert.rejects(
      stale,
      (error) => {
        assert.equal(error.code, "desk_root_identity_changed")
        return true
      },
    )
    assert.equal(staleWriterCalls, 0)
  } finally {
    firstRelease.resolve()
    await Promise.allSettled([first, stale].filter(Boolean))
  }
})

test("alternating root resolution failure fails closed before writer, open, or reset", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = path.resolve("modeled-alternating-root")
  let failResolution = true
  let ensureCalls = 0
  let openCalls = 0
  let resetCalls = 0
  const maintenance = createMaintenanceCoordinator({
    resolveIdentity: (deskRoot) =>
      resolveRootIdentity(deskRoot, {
        nativeRealpath: () => {
          if (failResolution) {
            throw Object.assign(new Error("transient realpath failure"), {
              code: "EIO",
            })
          }
          return root
        },
        nativeStat: () => {
          throw new Error("stat must not be sampled")
        },
      }),
    ensureIndex: async () => {
      ensureCalls += 1
      return { built: false, reason: "fresh" }
    },
    openIndex: () => {
      openCalls += 1
      return {}
    },
    closeIndex: () => {},
    resetIndex: async () => {
      resetCalls += 1
    },
    createRepairCoordinator: () => ({
      start: async () => ({ state: "complete", last_error: null }),
      cancel: async () => ({
        state: "idle",
        last_error: null,
        cancelled: false,
      }),
      status: () => ({ state: "idle", last_error: null }),
    }),
  })

  assert.throws(
    () => maintenance.runFreshRead({
      deskRoot: root,
      read: async () => "unreachable",
    }),
    (error) => {
      assert.equal(error.code, "desk_root_identity_unavailable")
      return true
    },
  )
  assert.deepEqual(
    { ensureCalls, openCalls, resetCalls },
    { ensureCalls: 0, openCalls: 0, resetCalls: 0 },
  )

  failResolution = false
  assert.equal(
    await maintenance.runFreshRead({
      deskRoot: root,
      read: async () => "read",
    }),
    "read",
  )
  assert.deepEqual(
    { ensureCalls, openCalls, resetCalls },
    { ensureCalls: 1, openCalls: 1, resetCalls: 0 },
  )

  failResolution = true
  await assert.rejects(
    maintenance.runExplicitReindex({
      deskRoot: root,
      force: true,
    }),
    (error) => {
      assert.equal(error.code, "desk_root_identity_unavailable")
      return true
    },
  )
  assert.deepEqual(
    { ensureCalls, openCalls, resetCalls },
    { ensureCalls: 1, openCalls: 1, resetCalls: 0 },
  )
})

test("maintenance resolves once and threads one root lease through queued work", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = path.resolve("modeled-stable-lease")
  const lease = Object.freeze({ path: root, key: root })
  let resolveCalls = 0
  const seen = []
  const maintenance = createMaintenanceCoordinator({
    resolveIdentity: () => {
      resolveCalls += 1
      return lease
    },
    ensureIndex: async (_deskRoot, _options, rootIdentity) => {
      seen.push(rootIdentity)
      return {
        built: false,
        reason: "fresh",
        semantic: { missing_vectors: 0 },
      }
    },
    createRepairCoordinator: () => ({
      start: async () => ({ state: "complete", last_error: null }),
      async cancel(_deskRoot, rootIdentity) {
        seen.push(rootIdentity)
        return {
          state: "idle",
          last_error: null,
          cancelled: false,
        }
      },
      status: () => ({ state: "idle", last_error: null }),
    }),
  })

  await maintenance.ensureSearchFreshness({ deskRoot: root })
  assert.equal(resolveCalls, 1)
  assert.deepEqual(seen, [lease])

  seen.length = 0
  await maintenance.runExplicitReindex({ deskRoot: root })
  assert.equal(resolveCalls, 2)
  assert.deepEqual(seen, [lease, lease, lease])
})

test("fresh-read root leases are coordinator-issued and non-transferable", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const fixture = createModeledCaseCollisionRootIdentity()
  const ensureTargets = []
  const openTargets = []

  function createCoordinator() {
    return createMaintenanceCoordinator({
      resolveIdentity: fixture.resolveIdentity,
      validateIdentity: fixture.validateIdentity,
      ensureIndex: async (deskRoot) => {
        ensureTargets.push(fixture.nativeRealpath(deskRoot))
        return {
          built: false,
          reason: "fresh",
          semantic: { missing_vectors: 0 },
        }
      },
      openIndex: (deskRoot) => {
        openTargets.push(fixture.nativeRealpath(deskRoot))
        return {}
      },
      closeIndex: () => {},
    })
  }

  const owner = createCoordinator()
  const other = createCoordinator()
  assert.equal(typeof owner.acquireRootLease, "function")
  const lease = owner.acquireRootLease(fixture.aliasA)

  await assert.rejects(
    Promise.resolve().then(() =>
      owner.runFreshRead({
        rootLease: Object.freeze({}),
        read: () => "forged",
      })),
    (error) => {
      assert.equal(error.code, "maintenance_root_lease_unavailable")
      return true
    },
  )
  await assert.rejects(
    Promise.resolve().then(() =>
      other.runFreshRead({
        rootLease: lease,
        read: () => "transferred",
      })),
    (error) => {
      assert.equal(error.code, "maintenance_root_lease_unavailable")
      return true
    },
  )
  assert.equal(
    await owner.runFreshRead({
      rootLease: lease,
      read: () => "owned",
    }),
    "owned",
  )
  assert.deepEqual(ensureTargets, [fixture.rootA])
  assert.deepEqual(openTargets, [fixture.rootA])
})

async function assertRetargetedReindexFailsClosed({ force }) {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const fixture = createModeledCaseCollisionRootIdentity()
  const secondCancelEntered = deferred()
  const secondCancelRelease = deferred()
  const laterAEntered = deferred()
  const laterARelease = deferred()
  const laterBEntered = deferred()
  const staleEnsureTargets = []
  const staleResetTargets = []
  let cancelCalls = 0
  let reindex
  let laterA
  let laterB

  const maintenance = createMaintenanceCoordinator({
    resolveIdentity: fixture.resolveIdentity,
    validateIdentity: fixture.validateIdentity,
    ensureIndex: async (deskRoot, options) => {
      if (options.marker === "stale") {
        staleEnsureTargets.push(fixture.nativeRealpath(deskRoot))
      } else if (options.marker === "later-a") {
        laterAEntered.resolve()
        await laterARelease.promise
      } else if (options.marker === "later-b") {
        laterBEntered.resolve()
      }
      return { built: false, reason: "fresh" }
    },
    resetIndex: async ({ deskRoot }) => {
      staleResetTargets.push(fixture.nativeRealpath(deskRoot))
    },
    createRepairCoordinator: () => ({
      start: async () => ({ state: "complete", last_error: null }),
      async cancel() {
        cancelCalls += 1
        if (cancelCalls === 2) {
          secondCancelEntered.resolve()
          await secondCancelRelease.promise
        }
        return {
          state: "idle",
          last_error: null,
          cancelled: false,
        }
      },
      status: () => ({ state: "idle", last_error: null }),
    }),
  })

  try {
    reindex = maintenance.runExplicitReindex({
      deskRoot: fixture.aliasA,
      force,
      ensureOptions: { marker: "stale" },
    })
    await awaitBounded(
      secondCancelEntered.promise,
      "retained reindex did not pass queue validation before cancellation",
    )
    fixture.retargetAlias(fixture.rootB)
    secondCancelRelease.resolve()

    await assert.rejects(
      reindex,
      (error) => {
        assert.equal(error.code, "desk_root_identity_changed")
        return true
      },
    )
    assert.deepEqual(staleResetTargets, [])
    assert.deepEqual(staleEnsureTargets, [])

    laterA = maintenance.runExplicitReindex({
      deskRoot: fixture.rootA,
      ensureOptions: { marker: "later-a" },
    })
    await awaitBounded(
      laterAEntered.promise,
      "later root A reindex did not enter",
    )
    laterB = maintenance.runExplicitReindex({
      deskRoot: fixture.rootB,
      ensureOptions: { marker: "later-b" },
    })
    await awaitBounded(
      laterBEntered.promise,
      "root B reindex did not remain independent of root A",
    )
    assert.deepEqual(
      await awaitBounded(laterB, "later root B reindex did not settle"),
      { built: false, reason: "fresh" },
    )
    laterARelease.resolve()
    assert.deepEqual(
      await awaitBounded(laterA, "later root A reindex did not settle"),
      { built: false, reason: "fresh" },
    )
  } finally {
    secondCancelRelease.resolve()
    laterARelease.resolve()
    await Promise.allSettled([reindex, laterA, laterB].filter(Boolean))
  }
}

test("force reindex rejects alias retarget after cancellation before reset or full ensure", async () => {
  await assertRetargetedReindexFailsClosed({ force: true })
})

test("non-force reindex rejects alias retarget after cancellation before full ensure", async () => {
  await assertRetargetedReindexFailsClosed({ force: false })
})

test("successful explicit reindex replaces prior failed repair status on its retained canonical root", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const fixture = createModeledCaseCollisionRootIdentity()
  const scheduler = createManualScheduler()
  let explicitEnsureCalls = 0
  const maintenance = createMaintenanceCoordinator({
    resolveIdentity: fixture.resolveIdentity,
    validateIdentity: fixture.validateIdentity,
    ensureIndex: async (deskRoot, options) => {
      if (options.skipEmbed) {
        return {
          built: false,
          reason: "fresh",
          semantic: {
            chunks_total: 1,
            vectors_indexed: 0,
            missing_vectors: 1,
            repairable_missing_vectors: 1,
          },
        }
      }
      explicitEnsureCalls += 1
      assert.equal(deskRoot, fixture.rootA)
      fixture.retargetAlias(fixture.rootB)
      return {
        built: true,
        reason: "semantic_missing",
        semantic: {
          chunks_total: 1,
          vectors_indexed: 1,
          missing_vectors: 0,
          repairable_missing_vectors: 0,
        },
      }
    },
    repairBatch: async () => {
      const error = new Error("private failed repair detail")
      error.code = "embedding_service_unavailable"
      throw error
    },
    createRepairCoordinator: (options) =>
      createSemanticRepairCoordinator({
        ...options,
        schedule: scheduler.schedule,
        clearScheduled: scheduler.clear,
      }),
  })

  const freshness = await maintenance.ensureSearchFreshness({
    deskRoot: fixture.aliasA,
  })
  assert.deepEqual(
    maintenance.semanticRepairSnapshot({ deskRoot: fixture.rootA }).status,
    { state: "running", last_error: null },
  )
  await scheduler.runNext()
  assert.deepEqual(await freshness.repair, {
    state: "failed",
    last_error: {
      reason: "embedding_service_unavailable",
      message: "embedding endpoint unavailable",
    },
  })

  const result = await maintenance.runExplicitReindex({
    deskRoot: fixture.aliasA,
  })

  assert.equal(explicitEnsureCalls, 1)
  assert.deepEqual(result, {
    built: true,
    reason: "semantic_missing",
    semantic: {
      chunks_total: 1,
      vectors_indexed: 1,
      missing_vectors: 0,
      repairable_missing_vectors: 0,
    },
  })
  assert.deepEqual(
    maintenance.semanticRepairSnapshot({ deskRoot: fixture.rootA }).status,
    { state: "complete", last_error: null },
  )
  assert.deepEqual(
    maintenance.semanticRepairSnapshot({ deskRoot: fixture.rootB }).status,
    { state: "idle", last_error: null },
  )
})

test("successful explicit reindex completes repair status after cancelling an active repair", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = await makeRoot("desk-maintenance-reindex-status-")
  const scheduler = createManualScheduler()
  const repairEntered = deferred()
  let scheduledRepair
  let maintenance

  try {
    maintenance = createMaintenanceCoordinator({
      ensureIndex: async (_deskRoot, options) => {
        if (options.skipEmbed) {
          return {
            built: false,
            reason: "fresh",
            semantic: {
              chunks_total: 1,
              vectors_indexed: 0,
              missing_vectors: 1,
              repairable_missing_vectors: 1,
            },
          }
        }
        return {
          built: true,
          reason: "semantic_missing",
          semantic: {
            chunks_total: 1,
            vectors_indexed: 1,
            missing_vectors: 0,
            repairable_missing_vectors: 0,
          },
        }
      },
      repairBatch: async ({ signal }) => {
        repairEntered.resolve()
        await new Promise((resolve) => {
          const onAbort = () => resolve()
          if (signal.aborted) onAbort()
          else signal.addEventListener("abort", onAbort, { once: true })
        })
        return {
          processed_chunks: 0,
          vectors_indexed: 0,
          remaining_chunks: 1,
          stopped_by: "cancelled",
          cancelled: true,
        }
      },
      createRepairCoordinator: (options) =>
        createSemanticRepairCoordinator({
          ...options,
          schedule: scheduler.schedule,
          clearScheduled: scheduler.clear,
        }),
    })

    const freshness = await maintenance.ensureSearchFreshness({
      deskRoot: root,
    })
    scheduledRepair = scheduler.runNext()
    await awaitBounded(
      repairEntered.promise,
      "active semantic repair did not enter before explicit reindex",
    )
    assert.deepEqual(
      maintenance.semanticRepairSnapshot({ deskRoot: root }).status,
      { state: "running", last_error: null },
    )

    const result = await maintenance.runExplicitReindex({ deskRoot: root })

    assert.equal(result.reason, "semantic_missing")
    assert.equal(result.semantic.repairable_missing_vectors, 0)
    assert.deepEqual(await freshness.repair, {
      state: "idle",
      last_error: null,
    })
    await awaitBounded(
      scheduledRepair,
      "cancelled semantic repair callback did not settle",
    )
    assert.deepEqual(
      maintenance.semanticRepairSnapshot({ deskRoot: root }).status,
      { state: "complete", last_error: null },
    )
  } finally {
    if (maintenance) {
      await maintenance.cancelBackgroundRepair(root).catch(() => {})
    }
    await Promise.allSettled([scheduledRepair].filter(Boolean))
    await removeRoots(root)
  }
})

test("explicit reindex failure preserves prior failed repair status and redaction", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = await makeRoot("desk-maintenance-reindex-failure-")
  const scheduler = createManualScheduler()
  const maintenance = createMaintenanceCoordinator({
    ensureIndex: async (_deskRoot, options) => {
      if (options.skipEmbed) {
        return {
          built: false,
          reason: "fresh",
          semantic: {
            chunks_total: 1,
            vectors_indexed: 0,
            missing_vectors: 1,
            repairable_missing_vectors: 1,
          },
        }
      }
      throw new Error("private explicit reindex failure detail")
    },
    repairBatch: async () => {
      const error = new Error("private background repair failure detail")
      error.code = "embedding_service_unavailable"
      throw error
    },
    createRepairCoordinator: (options) =>
      createSemanticRepairCoordinator({
        ...options,
        schedule: scheduler.schedule,
        clearScheduled: scheduler.clear,
      }),
  })

  try {
    const freshness = await maintenance.ensureSearchFreshness({
      deskRoot: root,
    })
    await scheduler.runNext()
    const failedStatus = {
      state: "failed",
      last_error: {
        reason: "embedding_service_unavailable",
        message: "embedding endpoint unavailable",
      },
    }
    assert.deepEqual(await freshness.repair, failedStatus)

    await assert.rejects(
      maintenance.runExplicitReindex({ deskRoot: root }),
      /private explicit reindex failure detail/u,
    )
    assert.deepEqual(
      maintenance.semanticRepairSnapshot({ deskRoot: root }).status,
      failedStatus,
    )
  } finally {
    await maintenance.cancelBackgroundRepair(root).catch(() => {})
    await removeRoots(root)
  }
})

test("explicit reindex cancellation cleanup failure preserves running repair status", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = await makeRoot("desk-maintenance-reindex-cancel-failure-")
  let ensureCalls = 0
  let cancelCalls = 0
  const maintenance = createMaintenanceCoordinator({
    ensureIndex: async () => {
      ensureCalls += 1
      return {
        built: true,
        reason: "semantic_missing",
        semantic: {
          chunks_total: 1,
          vectors_indexed: 1,
          missing_vectors: 0,
          repairable_missing_vectors: 0,
        },
      }
    },
    createRepairCoordinator: () => ({
      start: () => new Promise(() => {}),
      async cancel() {
        cancelCalls += 1
        throw new Error("repair cancellation cleanup failed")
      },
      status: () => ({ state: "running", last_error: null }),
    }),
  })

  try {
    await assert.rejects(
      maintenance.runExplicitReindex({ deskRoot: root }),
      /repair cancellation cleanup failed/u,
    )
    assert.equal(cancelCalls, 1)
    assert.equal(ensureCalls, 0)
    assert.deepEqual(
      maintenance.semanticRepairSnapshot({ deskRoot: root }).status,
      { state: "running", last_error: null },
    )
  } finally {
    await removeRoots(root)
  }
})

test("explicit reindex with a repairable vector gap preserves idle repair status", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = await makeRoot("desk-maintenance-reindex-gap-")
  const maintenance = createMaintenanceCoordinator({
    ensureIndex: async () => ({
      built: true,
      reason: "semantic_missing",
      semantic: {
        chunks_total: 2,
        vectors_indexed: 1,
        missing_vectors: 1,
        repairable_missing_vectors: 1,
      },
    }),
  })

  try {
    const result = await maintenance.runExplicitReindex({ deskRoot: root })

    assert.equal(result.semantic.repairable_missing_vectors, 1)
    assert.deepEqual(
      maintenance.semanticRepairSnapshot({ deskRoot: root }).status,
      { state: "idle", last_error: null },
    )
  } finally {
    await maintenance.cancelBackgroundRepair(root).catch(() => {})
    await removeRoots(root)
  }
})

test("fresh read rejects alias retarget after freshness ensure before database open or query", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const fixture = createModeledCaseCollisionRootIdentity()
  const ensureEntered = deferred()
  const ensureRelease = deferred()
  const ensureTargets = []
  const openTargets = []
  let readCalls = 0
  let freshRead

  const maintenance = createMaintenanceCoordinator({
    resolveIdentity: fixture.resolveIdentity,
    validateIdentity: fixture.validateIdentity,
    ensureIndex: async (deskRoot, options) => {
      ensureTargets.push(fixture.nativeRealpath(deskRoot))
      if (options.marker === "stale") {
        ensureEntered.resolve()
        await ensureRelease.promise
      }
      return {
        built: false,
        reason: "fresh",
        semantic: { missing_vectors: 0 },
      }
    },
    openIndex: (deskRoot) => {
      openTargets.push(fixture.nativeRealpath(deskRoot))
      return { open: true }
    },
    closeIndex: (db) => {
      db.open = false
    },
  })

  try {
    freshRead = maintenance.runFreshRead({
      deskRoot: fixture.aliasA,
      ensureOptions: { marker: "stale" },
      read() {
        readCalls += 1
        return "stale-read"
      },
    })
    await awaitBounded(
      ensureEntered.promise,
      "fresh read did not enter freshness ensure",
    )
    fixture.retargetAlias(fixture.rootB)
    ensureRelease.resolve()

    await assert.rejects(
      freshRead,
      (error) => {
        assert.equal(error.code, "desk_root_identity_changed")
        return true
      },
    )
    assert.deepEqual(ensureTargets, [fixture.rootA])
    assert.deepEqual(openTargets, [])
    assert.equal(readCalls, 0)

    assert.equal(
      await maintenance.runFreshRead({
        deskRoot: fixture.rootA,
        read: () => "later-a",
      }),
      "later-a",
    )
    assert.equal(
      await maintenance.runFreshRead({
        deskRoot: fixture.rootB,
        read: () => "later-b",
      }),
      "later-b",
    )
    assert.deepEqual(openTargets, [fixture.rootA, fixture.rootB])
  } finally {
    ensureRelease.resolve()
    await Promise.allSettled([freshRead].filter(Boolean))
  }
})

test("scheduled repair batch keeps canonical root I/O after its retained alias retargets", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const fixture = createModeledCaseCollisionRootIdentity()
  const scheduler = createManualScheduler()
  const repairEntered = deferred()
  const repairRelease = deferred()
  const repairTargets = []
  let initial
  let scheduled

  const maintenance = createMaintenanceCoordinator({
    resolveIdentity: fixture.resolveIdentity,
    validateIdentity: fixture.validateIdentity,
    ensureIndex: async (deskRoot) => ({
      built: false,
      reason: "fresh",
      semantic: {
        missing_vectors: deskRoot === fixture.rootA ? 1 : 0,
      },
    }),
    repairBatch: async ({ deskRoot }) => {
      repairEntered.resolve()
      await repairRelease.promise
      repairTargets.push(fixture.nativeRealpath(deskRoot))
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
    initial = await maintenance.ensureSearchFreshness({
      deskRoot: fixture.aliasA,
    })
    scheduled = scheduler.runNext()
    await awaitBounded(
      repairEntered.promise,
      "scheduled retained repair batch did not enter",
    )
    fixture.retargetAlias(fixture.rootB)
    repairRelease.resolve()
    await awaitBounded(scheduled, "scheduled retained repair batch did not settle")
    assert.deepEqual(
      await awaitBounded(initial.repair, "retained repair promise did not settle"),
      { state: "complete", last_error: null },
    )
    assert.deepEqual(repairTargets, [fixture.rootA])

    const laterB = await maintenance.ensureSearchFreshness({
      deskRoot: fixture.rootB,
    })
    assert.deepEqual(
      await awaitBounded(laterB.repair, "later root B repair did not settle"),
      { state: "complete", last_error: null },
    )
  } finally {
    repairRelease.resolve()
    await Promise.allSettled([scheduled, initial?.repair].filter(Boolean))
  }
})

test("modeled referent identity shares freshness generations for A and its alias without suppressing B", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const fixture = createModeledCaseCollisionRootIdentity()
  const freshnessAEntered = deferred()
  const freshnessARelease = deferred()
  const reindexAEntered = deferred()
  const freshnessBEntered = deferred()
  const repairStarts = []
  const repairCancels = []
  let freshnessA
  let freshnessB
  let reindexA
  const maintenance = createMaintenanceCoordinator({
    resolveIdentity: fixture.resolveIdentity,
    ensureIndex: async (_deskRoot, options) => {
      if (options.marker === "freshness-a") {
        freshnessAEntered.resolve()
        await freshnessARelease.promise
        return {
          built: false,
          reason: "fresh",
          semantic: { missing_vectors: 1 },
        }
      }
      if (options.marker === "freshness-b") {
        freshnessBEntered.resolve()
        return {
          built: false,
          reason: "fresh",
          semantic: { missing_vectors: 1 },
        }
      }
      assert.equal(options.marker, "reindex-a")
      reindexAEntered.resolve()
      return {
        built: true,
        reason: "semantic_missing",
        semantic: { missing_vectors: 0 },
      }
    },
    createRepairCoordinator: () => ({
      start({ deskRoot }) {
        repairStarts.push(deskRoot)
        return Promise.resolve({
          state: "complete",
          last_error: null,
        })
      },
      async cancel(deskRoot) {
        repairCancels.push(deskRoot)
        return {
          state: "idle",
          last_error: null,
          cancelled: false,
        }
      },
      status() {
        return { state: "idle", last_error: null }
      },
    }),
  })

  try {
    freshnessA = maintenance.ensureSearchFreshness({
      deskRoot: fixture.rootA,
      ensureOptions: { marker: "freshness-a" },
    })
    await awaitBounded(
      freshnessAEntered.promise,
      "modeled root A freshness did not enter",
    )
    reindexA = maintenance.runExplicitReindex({
      deskRoot: fixture.aliasA,
      ensureOptions: { marker: "reindex-a" },
    })
    freshnessB = maintenance.ensureSearchFreshness({
      deskRoot: fixture.rootB,
      ensureOptions: { marker: "freshness-b" },
    })

    await awaitBounded(
      freshnessBEntered.promise,
      "distinct root B freshness did not remain concurrent",
    )
    const resultB = await awaitBounded(
      freshnessB,
      "distinct root B freshness did not settle",
    )
    await resultB.repair
    await flushAsyncWork("modeled reindex did not reach the root queue")
    assert.equal(
      reindexAEntered.settled,
      false,
      "case-only alias reindex bypassed the referent freshness lock",
    )
    assert.deepEqual(repairStarts, [fixture.rootB])

    freshnessARelease.resolve()
    const resultA = await awaitBounded(
      freshnessA,
      "modeled root A freshness did not settle",
    )
    await resultA.repair
    await awaitBounded(reindexA, "modeled alias A reindex did not settle")

    assert.equal(reindexAEntered.settled, true)
    assert.deepEqual(
      repairStarts,
      [fixture.rootB],
      "alias A reindex generation did not suppress stale root A repair",
    )
    assert.deepEqual(repairCancels, [
      fixture.rootA,
      fixture.rootA,
    ])
  } finally {
    freshnessARelease.resolve()
    await Promise.allSettled([freshnessA, freshnessB, reindexA].filter(Boolean))
  }
})

async function makeRoot(prefix) {
  return fs.mkdtemp(path.join(tmpdir(), prefix))
}

async function makeSymlinkAlias(root, prefix) {
  const container = await makeRoot(prefix)
  const alias = path.join(container, "root-alias")
  try {
    await fs.symlink(
      root,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    )
  } catch (error) {
    await removeRoots(container)
    throw error
  }
  return { alias, container }
}

async function findSupportedCaseAlias(root) {
  const resolved = path.resolve(root)
  const physical = await fs.realpath(resolved)
  for (let index = resolved.length - 1; index >= 0; index -= 1) {
    const character = resolved[index]
    if (!/[A-Za-z]/u.test(character)) continue
    const replacement =
      character === character.toLowerCase()
        ? character.toUpperCase()
        : character.toLowerCase()
    const candidate =
      `${resolved.slice(0, index)}${replacement}${resolved.slice(index + 1)}`
    try {
      if (await fs.realpath(candidate) === physical) return candidate
    } catch {}
  }
  return null
}

async function removeRoots(...roots) {
  await awaitBounded(
    Promise.all(
      roots
        .filter(Boolean)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    ),
    "maintenance fixture cleanup timed out",
  )
}

async function assertAliasSerializesReadAndReindex({
  alias,
  force,
  root,
}) {
  const readEntered = deferred()
  const readRelease = deferred()
  const reindexEntered = deferred()
  const events = []
  let repairStarts = 0
  let resetCalls = 0
  const maintenance = (await loadMaintenance()).createMaintenanceCoordinator({
    ensureIndex: async (deskRoot, options) => {
      if (options.skipEmbed) {
        events.push(`read:ensure:${deskRoot}`)
        return {
          built: false,
          reason: "fresh",
          semantic: {
            chunks_total: 2,
            vectors_indexed: 1,
            missing_vectors: 1,
          },
        }
      }
      events.push(`reindex:ensure:${deskRoot}`)
      reindexEntered.resolve()
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
    openIndex: () => ({ open: true }),
    closeIndex: (db) => {
      db.open = false
      events.push("read:close")
    },
    resetIndex: async ({ deskRoot }) => {
      resetCalls += 1
      events.push(`reindex:reset:${deskRoot}`)
    },
    createRepairCoordinator: () => ({
      start() {
        repairStarts += 1
        events.push("repair:start")
        return Promise.resolve({ state: "complete", last_error: null })
      },
      async cancel() {
        events.push("repair:cancel")
        return { state: "idle", last_error: null, cancelled: false }
      },
      status() {
        return { state: "idle", last_error: null }
      },
    }),
  })
  let read
  let reindex
  try {
    read = maintenance.runFreshRead({
      deskRoot: root,
      ensureOptions: { embed: { fetch: async () => null } },
      async read(db) {
        assert.equal(db.open, true)
        events.push("read:open")
        readEntered.resolve()
        await readRelease.promise
        return "read"
      },
    })
    await awaitBounded(readEntered.promise, "aliased read did not enter")
    reindex = maintenance.runExplicitReindex({
      deskRoot: alias,
      force,
    })
    await flushAsyncWork("aliased reindex did not reach the queue")

    assert.equal(
      reindexEntered.settled,
      false,
      `${force ? "force" : "non-force"} reindex entered through a physical-root alias while a read handle was open`,
    )
    assert.equal(resetCalls, 0)

    readRelease.resolve()
    assert.equal(await awaitBounded(read, "aliased read did not settle"), "read")
    await awaitBounded(
      reindex,
      `${force ? "force" : "non-force"} aliased reindex did not settle`,
    )

    assert.equal(reindexEntered.settled, true)
    assert.equal(resetCalls, force ? 1 : 0)
    assert.equal(
      repairStarts,
      0,
      "the older read registered stale repair after aliased reindex intent",
    )
    assert.ok(
      events.indexOf("read:close") <
        events.findIndex((event) => event.startsWith("reindex:")),
    )
    assert.ok(events.includes(`read:ensure:${physicalRootKey(root)}`))
    assert.ok(events.includes(`reindex:ensure:${physicalRootKey(root)}`))
  } finally {
    readRelease.resolve()
    await Promise.allSettled([read, reindex].filter(Boolean))
    await maintenance.cancelBackgroundRepair(root).catch(() => {})
  }
}

test("physical symlink aliases share read locks and reindex generations", async (t) => {
  const root = await makeRoot("desk-maintenance-physical-root-")
  let aliasFixture
  try {
    try {
      aliasFixture = await makeSymlinkAlias(
        root,
        "desk-maintenance-physical-alias-",
      )
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`symlink aliases unavailable: ${error.code}`)
        return
      }
      throw error
    }
    for (const force of [false, true]) {
      await assertAliasSerializesReadAndReindex({
        alias: aliasFixture.alias,
        force,
        root,
      })
    }
  } finally {
    await removeRoots(aliasFixture?.container, root)
  }
})

test("case aliases share read locks where the filesystem is case-insensitive", async (t) => {
  const root = await makeRoot("desk-maintenance-case-root-")
  try {
    const alias = await findSupportedCaseAlias(root)
    if (alias === null) {
      t.skip("case aliases are not supported by this filesystem")
      return
    }
    await assertAliasSerializesReadAndReindex({
      alias,
      force: true,
      root,
    })
  } finally {
    await removeRoots(root)
  }
})

test("aliased repair waits for the physical-root read while a distinct root remains concurrent", async (t) => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const [rootA, rootB] = await Promise.all([
    makeRoot("desk-maintenance-alias-repair-a-"),
    makeRoot("desk-maintenance-alias-repair-b-"),
  ])
  let aliasA
  let aliasB
  const scheduler = createManualScheduler()
  const readEntered = deferred()
  const readRelease = deferred()
  const repairEntered = deferred()
  const repairRelease = deferred()
  const otherRootEntered = deferred()
  let maintenance
  let initialFreshness
  let heldRead
  let repairBatch
  let otherRootReindex

  try {
    try {
      [aliasA, aliasB] = await Promise.all([
        makeSymlinkAlias(rootA, "desk-maintenance-alias-link-a-"),
        makeSymlinkAlias(rootB, "desk-maintenance-alias-link-b-"),
      ])
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`symlink aliases unavailable: ${error.code}`)
        return
      }
      throw error
    }
    maintenance = createMaintenanceCoordinator({
      ensureIndex: async (deskRoot, options) => {
        if (options.marker === "other-root") {
          assert.equal(deskRoot, physicalRootKey(rootB))
          otherRootEntered.resolve()
          return { built: true, reason: "fresh" }
        }
        return {
          built: false,
          reason: "fresh",
          semantic: {
            chunks_total: 2,
            vectors_indexed: options.marker === "initial" ? 1 : 2,
            missing_vectors: options.marker === "initial" ? 1 : 0,
          },
        }
      },
      openIndex: () => ({ open: true }),
      closeIndex: (db) => {
        db.open = false
      },
      repairBatch: async ({ deskRoot }) => {
        assert.equal(deskRoot, physicalRootKey(rootA))
        repairEntered.resolve()
        await repairRelease.promise
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

    initialFreshness = await maintenance.ensureSearchFreshness({
      deskRoot: aliasA.alias,
      ensureOptions: {
        embed: { fetch: async () => null },
        marker: "initial",
      },
    })
    assert.equal(scheduler.size, 1)
    heldRead = maintenance.runFreshRead({
      deskRoot: rootA,
      ensureOptions: { marker: "held-read" },
      async read(db) {
        assert.equal(db.open, true)
        readEntered.resolve()
        await readRelease.promise
        return "held-read"
      },
    })
    await awaitBounded(readEntered.promise, "physical-root read did not enter")

    repairBatch = scheduler.runNext()
    otherRootReindex = maintenance.runExplicitReindex({
      deskRoot: aliasB.alias,
      ensureOptions: { marker: "other-root" },
    })
    await awaitBounded(
      otherRootEntered.promise,
      "distinct physical root did not remain concurrent",
    )
    await awaitBounded(
      otherRootReindex,
      "distinct physical-root reindex did not settle",
    )
    await flushAsyncWork("aliased repair did not reach its root queue")
    assert.equal(
      repairEntered.settled,
      false,
      "repair entered through a symlink alias while the physical-root read was open",
    )

    readRelease.resolve()
    assert.equal(await awaitBounded(heldRead, "held read did not settle"), "held-read")
    await awaitBounded(
      repairEntered.promise,
      "aliased repair did not enter after read close",
    )
    repairRelease.resolve()
    await awaitBounded(repairBatch, "aliased repair batch did not settle")
    await awaitBounded(
      initialFreshness.repair,
      "aliased repair promise did not settle",
    )
  } finally {
    readRelease.resolve()
    repairRelease.resolve()
    await Promise.allSettled(
      [heldRead, repairBatch, otherRootReindex, initialFreshness?.repair].filter(
        Boolean,
      ),
    )
    if (maintenance) {
      await Promise.allSettled([
        maintenance.cancelBackgroundRepair(rootA),
        maintenance.cancelBackgroundRepair(rootB),
      ])
    }
    await removeRoots(aliasA?.container, aliasB?.container, rootA, rootB)
  }
})

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
      assert.equal(call.deskRoot, physicalRootKey(root))
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
    assert.equal(repairCalls[0].deskRoot, physicalRootKey(root))
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

test("pending reindex intent suppresses repair registration from an older fresh read", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = await makeRoot("desk-maintenance-reindex-intent-")
  const freshnessEntered = deferred()
  const freshnessRelease = deferred()
  const events = []
  let activeRepair = null
  let maintenance
  let freshRead
  let freshResult
  let reindex

  try {
    maintenance = createMaintenanceCoordinator({
      ensureIndex: async (_deskRoot, options) => {
        if (options.skipEmbed) {
          events.push("freshness:start")
          freshnessEntered.resolve()
          await awaitBounded(
            freshnessRelease.promise,
            "freshness was not released",
          )
          events.push("freshness:end")
          return {
            built: false,
            reason: "fresh",
            semantic: {
              chunks_total: 2,
              vectors_indexed: 1,
              missing_vectors: 1,
            },
          }
        }
        events.push("reindex:ensure")
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
      createRepairCoordinator: () => ({
        start() {
          events.push("repair:start")
          activeRepair = deferred()
          return activeRepair.promise
        },
        async cancel() {
          events.push("repair:cancel")
          activeRepair?.resolve({
            state: "idle",
            last_error: null,
            cancelled: true,
          })
          activeRepair = null
          return {
            state: "idle",
            last_error: null,
            cancelled: true,
          }
        },
        status() {
          return {
            state: activeRepair ? "running" : "idle",
            last_error: null,
          }
        },
      }),
    })

    freshRead = maintenance.ensureSearchFreshness({
      deskRoot: root,
      ensureOptions: { embed: { fetch: async () => null } },
    })
    await awaitBounded(
      freshnessEntered.promise,
      "freshness did not enter before reindex intent",
    )

    reindex = maintenance.runExplicitReindex({
      deskRoot: root,
      force: false,
      ensureOptions: { marker: "explicit-reindex" },
    })
    await flushAsyncWork(
      "reindex intent did not reach its initial cancellation",
    )
    assert.deepEqual(events, ["freshness:start", "repair:cancel"])

    freshnessRelease.resolve()
    freshResult = await awaitBounded(
      freshRead,
      "fresh read did not settle after reindex intent",
    )
    const reindexResult = await awaitBounded(
      reindex,
      "reindex did not settle after older freshness",
    )

    assert.equal(reindexResult.semantic.missing_vectors, 0)
    assert.equal(
      events.includes("repair:start"),
      false,
      "an older fresh read registered repair after reindex had already cancelled it",
    )
    assert.equal(
      events.filter((event) => event === "repair:cancel").length,
      2,
      "reindex must cancel again while holding the root before full repair",
    )
    await awaitBounded(
      freshResult.repair,
      "suppressed repair result did not settle",
    )
  } finally {
    freshnessRelease.resolve()
    activeRepair?.resolve({
      state: "idle",
      last_error: null,
      cancelled: true,
    })
    if (maintenance) {
      await awaitBounded(
        maintenance.cancelBackgroundRepair(root),
        "reindex-intent maintenance did not settle during cleanup",
      ).catch(() => {})
    }
    await awaitBounded(
      Promise.allSettled(
        [freshRead, freshResult?.repair, reindex].filter(Boolean),
      ),
      "reindex-intent promises did not settle during cleanup",
    ).catch(() => {})
    await removeRoots(root)
  }
})

test("fresh read closes its database handle before registering background repair", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = await makeRoot("desk-maintenance-fresh-read-close-")
  const events = []
  let openHandles = 0

  const maintenance = createMaintenanceCoordinator({
    ensureIndex: async () => {
      events.push("ensure")
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
    openIndex: () => {
      openHandles += 1
      events.push("open")
      return { open: true }
    },
    closeIndex: (db) => {
      db.open = false
      openHandles -= 1
      events.push("close")
    },
    createRepairCoordinator: () => ({
      start() {
        assert.equal(
          openHandles,
          0,
          "repair was registered while the read handle remained open",
        )
        events.push("repair:start")
        return Promise.resolve({ state: "complete", last_error: null })
      },
      async cancel() {
        return { state: "idle", last_error: null, cancelled: true }
      },
      status() {
        return { state: "idle", last_error: null }
      },
    }),
  })

  try {
    assert.equal(
      typeof maintenance.runFreshRead,
      "function",
      "maintenance must expose one fresh-read lifecycle for ensure/open/query/close/repair ordering",
    )
    const result = await maintenance.runFreshRead({
      deskRoot: root,
      ensureOptions: { embed: { fetch: async () => null } },
      read(db, index) {
        assert.equal(db.open, true)
        assert.equal(index.semantic.missing_vectors, 1)
        events.push("read")
        return "read-result"
      },
    })

    assert.equal(result, "read-result")
    assert.deepEqual(events, [
      "ensure",
      "open",
      "read",
      "close",
      "repair:start",
    ])
    assert.equal(openHandles, 0)
  } finally {
    await awaitBounded(
      maintenance.cancelBackgroundRepair(root),
      "fresh-read close maintenance did not settle during cleanup",
    ).catch(() => {})
    await removeRoots(root)
  }
})

test("fresh read handles missing semantic metadata, default repair options, and invalid roots", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = await makeRoot("desk-maintenance-fresh-read-defaults-")
  const repairOptions = []
  let ensureCalls = 0

  const maintenance = createMaintenanceCoordinator({
    ensureIndex: async () => {
      ensureCalls += 1
      if (ensureCalls === 1) return { built: false, reason: "fresh" }
      return {
        built: false,
        reason: "fresh",
        semantic: {
          chunks_total: 1,
          vectors_indexed: 0,
          missing_vectors: 1,
        },
      }
    },
    openIndex: () => ({ open: true }),
    closeIndex: (db) => {
      db.open = false
    },
    createRepairCoordinator: () => ({
      start(options) {
        repairOptions.push(options)
        return Promise.resolve({ state: "complete", last_error: null })
      },
      async cancel() {
        return { state: "idle", last_error: null, cancelled: true }
      },
      status() {
        return { state: "idle", last_error: null }
      },
    }),
  })

  try {
    const first = await maintenance.runFreshRead({
      deskRoot: root,
      read: () => "without-semantic",
    })
    const second = await maintenance.runFreshRead({
      deskRoot: root,
      read: () => "default-embed",
    })

    assert.equal(first, "without-semantic")
    assert.equal(second, "default-embed")
    assert.deepEqual(repairOptions, [
      {
        deskRoot: physicalRootKey(root),
        rootIdentity: {
          path: path.resolve(root),
          key: await fs.realpath(root),
        },
        embed: {},
      },
    ])
    assert.throws(
      () => maintenance.runFreshRead({
        deskRoot: "",
        read: () => null,
      }),
      /deskRoot is required/u,
    )
    assert.throws(
      () => maintenance.runFreshRead({
        deskRoot: null,
        read: () => null,
      }),
      /deskRoot is required/u,
    )
  } finally {
    await awaitBounded(
      maintenance.cancelBackgroundRepair(root),
      "fresh-read defaults maintenance did not settle during cleanup",
    ).catch(() => {})
    await removeRoots(root)
  }
})

test("force reindex waits for an open fresh-read handle and suppresses its stale repair", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = await makeRoot("desk-maintenance-open-handle-reset-")
  const readEntered = deferred()
  const readRelease = deferred()
  const events = []
  let openHandles = 0
  let repairStarts = 0
  let maintenance
  let freshRead
  let reindex

  try {
    maintenance = createMaintenanceCoordinator({
      ensureIndex: async (_deskRoot, options) => {
        events.push(options.skipEmbed ? "ensure:fresh" : "ensure:reindex")
        return options.skipEmbed
          ? {
              built: false,
              reason: "fresh",
              semantic: {
                chunks_total: 2,
                vectors_indexed: 1,
                missing_vectors: 1,
              },
            }
          : {
              built: true,
              reason: "missing",
              semantic: {
                chunks_total: 2,
                vectors_indexed: 2,
                missing_vectors: 0,
              },
            }
      },
      openIndex: () => {
        openHandles += 1
        events.push("open")
        return { open: true }
      },
      closeIndex: (db) => {
        db.open = false
        openHandles -= 1
        events.push("close")
      },
      resetIndex: async () => {
        assert.equal(
          openHandles,
          0,
          "force reset overlapped an open SQLite read handle",
        )
        events.push("reset")
      },
      createRepairCoordinator: () => ({
        start() {
          repairStarts += 1
          events.push("repair:start")
          return Promise.resolve({ state: "complete", last_error: null })
        },
        async cancel() {
          events.push("repair:cancel")
          return { state: "idle", last_error: null, cancelled: true }
        },
        status() {
          return { state: "idle", last_error: null }
        },
      }),
    })
    assert.equal(
      typeof maintenance.runFreshRead,
      "function",
      "maintenance must coordinate database reads with force reset",
    )

    freshRead = maintenance.runFreshRead({
      deskRoot: root,
      ensureOptions: { embed: { fetch: async () => null } },
      async read(db) {
        assert.equal(db.open, true)
        events.push("read:start")
        readEntered.resolve()
        await awaitBounded(
          readRelease.promise,
          "open-handle read was not released",
        )
        events.push("read:end")
        return "read-result"
      },
    })
    await awaitBounded(
      readEntered.promise,
      "fresh read did not open its database handle",
    )

    reindex = maintenance.runExplicitReindex({
      deskRoot: root,
      force: true,
      ensureOptions: {},
    })
    await flushAsyncWork(
      "force reindex did not register intent while read handle was open",
    )
    assert.equal(events.includes("reset"), false)
    assert.equal(openHandles, 1)

    readRelease.resolve()
    assert.equal(
      await awaitBounded(freshRead, "fresh read did not settle"),
      "read-result",
    )
    const reindexResult = await awaitBounded(
      reindex,
      "force reindex did not settle after the read handle closed",
    )

    assert.equal(reindexResult.semantic.missing_vectors, 0)
    assert.equal(repairStarts, 0)
    assert.equal(openHandles, 0)
    assert.ok(events.indexOf("close") < events.indexOf("reset"))
    assert.equal(
      events.filter((event) => event === "repair:cancel").length,
      2,
    )
  } finally {
    readRelease.resolve()
    if (maintenance) {
      await awaitBounded(
        maintenance.cancelBackgroundRepair(root),
        "open-handle maintenance did not settle during cleanup",
      ).catch(() => {})
    }
    await awaitBounded(
      Promise.allSettled([freshRead, reindex].filter(Boolean)),
      "open-handle promises did not settle during cleanup",
    ).catch(() => {})
    await removeRoots(root)
  }
})

test("active background repair holds the same-root lock while other roots stay independent", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const [rootA, rootB] = await Promise.all([
    makeRoot("desk-maintenance-repair-root-a-"),
    makeRoot("desk-maintenance-repair-root-b-"),
  ])
  const scheduler = createManualScheduler()
  const repairEntered = deferred()
  const repairRelease = deferred()
  const queuedFreshnessEntered = deferred()
  const rootBFreshnessEntered = deferred()
  const activeByRoot = new Map()
  const ensureCalls = []
  const repairCalls = []
  const events = []
  const initialEmbed = { fetch: async () => null }
  const queuedEmbed = { fetch: async () => null }
  const rootBEmbed = { fetch: async () => null }
  let busyThrows = 0
  let maxSameRootWriters = 0
  let rootAEnsureCount = 0
  let maintenance
  let initialFreshness
  let initialResult
  let scheduledRepair
  let queuedFreshness
  let queuedResult
  let rootBFreshness
  let rootBResult

  async function guardedWriter(deskRoot, label, operation) {
    const canonical = path.resolve(deskRoot)
    const active = activeByRoot.get(canonical)
    maxSameRootWriters = Math.max(maxSameRootWriters, active ? 2 : 1)
    if (active) {
      busyThrows += 1
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

  try {
    maintenance = createMaintenanceCoordinator({
      ensureIndex: async (deskRoot, options) => {
        ensureCalls.push({ deskRoot, options })
        if (deskRoot === physicalRootKey(rootA)) {
          rootAEnsureCount += 1
          if (rootAEnsureCount === 1) {
            return guardedWriter(deskRoot, "a:initial-freshness", async () => ({
              built: false,
              reason: "fresh",
              semantic: {
                chunks_total: 2,
                vectors_indexed: 1,
                missing_vectors: 1,
              },
            }))
          }
          return guardedWriter(deskRoot, "a:queued-freshness", async () => {
            queuedFreshnessEntered.resolve()
            return {
              built: false,
              reason: "fresh",
              semantic: {
                chunks_total: 2,
                vectors_indexed: 2,
                missing_vectors: 0,
              },
            }
          })
        }

        assert.equal(deskRoot, physicalRootKey(rootB))
        return guardedWriter(deskRoot, "b:freshness", async () => {
          rootBFreshnessEntered.resolve()
          return {
            built: false,
            reason: "fresh",
            semantic: {
              chunks_total: 1,
              vectors_indexed: 1,
              missing_vectors: 0,
            },
          }
        })
      },
      repairBatch: async (options) => {
        repairCalls.push(options)
        return guardedWriter(options.deskRoot, "a:repair", async () => {
          repairEntered.resolve()
          await awaitBounded(
            repairRelease.promise,
            "active background repair was not released",
          )
          return {
            processed_chunks: 1,
            vectors_indexed: 1,
            remaining_chunks: 0,
            stopped_by: "complete",
          }
        })
      },
      createRepairCoordinator: (options) =>
        createSemanticRepairCoordinator({
          ...options,
          schedule: scheduler.schedule,
          clearScheduled: scheduler.clear,
        }),
    })

    initialFreshness = maintenance.ensureSearchFreshness({
      deskRoot: rootA,
      ensureOptions: { embed: initialEmbed },
    })
    initialResult = await awaitBounded(
      initialFreshness,
      "initial root A freshness did not settle",
    )
    assert.equal(scheduler.size, 1)

    scheduledRepair = scheduler.runNext()
    await awaitBounded(
      repairEntered.promise,
      "root A background repair did not enter through maintenance",
    )

    queuedFreshness = maintenance.ensureSearchFreshness({
      deskRoot: rootA,
      ensureOptions: { embed: queuedEmbed },
    })
    const observedQueuedFreshness = observeSettlement(queuedFreshness)
    rootBFreshness = maintenance.ensureSearchFreshness({
      deskRoot: rootB,
      ensureOptions: { embed: rootBEmbed },
    })

    await awaitBounded(
      rootBFreshnessEntered.promise,
      "root B freshness did not enter independently of root A repair",
    )
    rootBResult = await awaitBounded(
      rootBFreshness,
      "root B freshness was blocked by root A repair",
    )
    await awaitBounded(
      rootBResult.repair,
      "root B no-op repair promise did not settle",
    )
    await flushAsyncWork(
      "same-root repair lock check did not reach a deterministic turn",
    )

    assert.equal(observedQueuedFreshness.state, "pending")
    assert.equal(queuedFreshnessEntered.settled, false)
    assert.equal(
      repairCalls[0].signal.aborted,
      false,
      "same-root search freshness must queue behind, not cancel, active repair",
    )
    assert.equal(busyThrows, 0)
    assert.equal(maxSameRootWriters, 1)
    assert.deepEqual(events, [
      "a:initial-freshness:start",
      "a:initial-freshness:end",
      "a:repair:start",
      "b:freshness:start",
      "b:freshness:end",
    ])
    assert.deepEqual(ensureCalls, [
      {
        deskRoot: physicalRootKey(rootA),
        options: { embed: initialEmbed, skipEmbed: true },
      },
      {
        deskRoot: physicalRootKey(rootB),
        options: { embed: rootBEmbed, skipEmbed: true },
      },
    ])
    assert.equal(repairCalls.length, 1)
    assert.deepEqual(Object.keys(repairCalls[0]).sort(), [
      "batchChunks",
      "batchMs",
      "deskRoot",
      "embed",
      "rootIdentity",
      "signal",
    ])
    assert.equal(repairCalls[0].deskRoot, physicalRootKey(rootA))
    assert.deepEqual(repairCalls[0].rootIdentity, {
      path: path.resolve(rootA),
      key: await fs.realpath(rootA),
    })
    assert.equal(repairCalls[0].embed, initialEmbed)
    assert.equal(repairCalls[0].batchChunks, 100)
    assert.equal(repairCalls[0].batchMs, 5000)
    assert.equal(repairCalls[0].signal instanceof AbortSignal, true)

    repairRelease.resolve()
    await awaitBounded(
      scheduledRepair,
      "released root A repair batch did not settle",
    )
    await awaitBounded(
      initialResult.repair,
      "root A background repair promise did not settle",
    )
    await awaitBounded(
      queuedFreshnessEntered.promise,
      "same-root freshness did not enter after repair released the lock",
    )
    queuedResult = await awaitBounded(
      queuedFreshness,
      "same-root freshness did not settle after repair released the lock",
    )
    await awaitBounded(
      queuedResult.repair,
      "same-root no-op repair promise did not settle",
    )

    assert.equal(observedQueuedFreshness.state, "fulfilled")
    assert.equal(busyThrows, 0)
    assert.equal(maxSameRootWriters, 1)
    assert.equal(activeByRoot.size, 0)
    assert.equal(scheduler.size, 0)
    assert.deepEqual(ensureCalls[2], {
      deskRoot: physicalRootKey(rootA),
      options: { embed: queuedEmbed, skipEmbed: true },
    })
    assert.deepEqual(events, [
      "a:initial-freshness:start",
      "a:initial-freshness:end",
      "a:repair:start",
      "b:freshness:start",
      "b:freshness:end",
      "a:repair:end",
      "a:queued-freshness:start",
      "a:queued-freshness:end",
    ])
  } finally {
    repairRelease.resolve()
    if (maintenance) {
      await awaitBounded(
        Promise.all([
          maintenance.cancelBackgroundRepair(rootA),
          maintenance.cancelBackgroundRepair(rootB),
        ]),
        "repair mutex test maintenance did not settle during cleanup",
      ).catch(() => {})
    }
    await awaitBounded(
      Promise.allSettled(
        [
          initialFreshness,
          initialResult?.repair,
          scheduledRepair,
          queuedFreshness,
          queuedResult?.repair,
          rootBFreshness,
          rootBResult?.repair,
        ].filter(Boolean),
      ),
      "repair mutex test promises did not settle during cleanup",
    ).catch(() => {})
    await removeRoots(rootA, rootB)
  }
})

test("explicit reindex reserves the root before cancelling active repair so fresh reads cannot deadlock it", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = await makeRoot("desk-maintenance-reindex-reservation-")
  const scheduler = createManualScheduler()
  const activeRepairEntered = deferred()
  const activeRepairAborted = deferred()
  const activeRepairCleanupRelease = deferred()
  const secondFreshReadEntered = deferred()
  const secondFreshReadRelease = deferred()
  const fullReindexEntered = deferred()
  const laterFreshReadEntered = deferred()
  const events = []
  let reindexed = false
  let repairBatchCalls = 0
  let replacementTimerFired = false
  let maintenance
  let initialFreshRead
  let activeRepair
  let reindex
  let firstFreshRead
  let secondFreshRead
  let replacementRepair
  let laterFreshRead

  try {
    maintenance = createMaintenanceCoordinator({
      ensureIndex: async (_deskRoot, options) => {
        const marker = options.marker
        if (!options.skipEmbed) {
          events.push("reindex:ensure")
          reindexed = true
          fullReindexEntered.resolve()
          return {
            built: true,
            reason: "semantic_missing",
            semantic: {
              chunks_total: 2,
              vectors_indexed: 2,
              missing_vectors: 0,
            },
          }
        }

        events.push(`${marker}:ensure`)
        if (marker === "second") {
          secondFreshReadEntered.resolve()
          await awaitBounded(
            secondFreshReadRelease.promise,
            "second fresh read was not released",
          )
        } else if (marker === "later") {
          laterFreshReadEntered.resolve()
        }
        return {
          built: false,
          reason: "fresh",
          semantic: {
            chunks_total: 2,
            vectors_indexed: reindexed ? 2 : 1,
            missing_vectors: reindexed ? 0 : 1,
          },
        }
      },
      openIndex: () => ({ open: true }),
      closeIndex: (db) => {
        db.open = false
      },
      repairBatch: async ({ signal }) => {
        repairBatchCalls += 1
        if (repairBatchCalls > 1) {
          events.push("replacement-repair:run")
          return {
            processed_chunks: 1,
            vectors_indexed: 1,
            remaining_chunks: 0,
            stopped_by: "complete",
          }
        }

        events.push("active-repair:start")
        activeRepairEntered.resolve()
        await awaitBounded(
          new Promise((resolve) => {
            const onAbort = () => {
              events.push("active-repair:abort")
              activeRepairAborted.resolve()
              resolve()
            }
            if (signal.aborted) onAbort()
            else signal.addEventListener("abort", onAbort, { once: true })
          }),
          "active repair did not observe reindex cancellation",
        )
        await awaitBounded(
          activeRepairCleanupRelease.promise,
          "active repair cleanup was not released",
        )
        events.push("active-repair:end")
        return {
          processed_chunks: 0,
          vectors_indexed: 0,
          remaining_chunks: 1,
          stopped_by: "cancelled",
          cancelled: true,
        }
      },
      createRepairCoordinator: (options) => {
        const repair = createSemanticRepairCoordinator({
          ...options,
          schedule: scheduler.schedule,
          clearScheduled: scheduler.clear,
        })
        return {
          start: repair.start,
          status: repair.status,
          async cancel(deskRoot) {
            events.push("cancel:start")
            const result = await repair.cancel(deskRoot)
            events.push("cancel:done")
            return result
          },
        }
      },
    })

    initialFreshRead = maintenance.runFreshRead({
      deskRoot: root,
      ensureOptions: {
        embed: { fetch: async () => null },
        marker: "initial",
      },
      read: () => "initial",
    })
    assert.equal(
      await awaitBounded(initialFreshRead, "initial fresh read did not settle"),
      "initial",
    )
    assert.equal(scheduler.size, 1)

    activeRepair = scheduler.runNext()
    await awaitBounded(
      activeRepairEntered.promise,
      "active repair did not enter before reindex",
    )

    reindex = maintenance.runExplicitReindex({
      deskRoot: root,
      ensureOptions: { marker: "explicit-reindex" },
    })
    const observedReindex = observeSettlement(reindex)
    await awaitBounded(
      activeRepairAborted.promise,
      "reindex did not abort the active repair",
    )

    firstFreshRead = maintenance.runFreshRead({
      deskRoot: root,
      ensureOptions: {
        embed: { fetch: async () => null },
        marker: "first",
      },
      read: () => "first",
    })
    secondFreshRead = maintenance.runFreshRead({
      deskRoot: root,
      ensureOptions: {
        embed: { fetch: async () => null },
        marker: "second",
      },
      read: () => "second",
    })

    activeRepairCleanupRelease.resolve()
    const nextOperation = await awaitBounded(
      Promise.race([
        fullReindexEntered.promise.then(() => "reindex"),
        secondFreshReadEntered.promise.then(() => "second-fresh-read"),
      ]),
      "neither reindex nor the overtaking fresh reads entered",
    )

    if (nextOperation === "second-fresh-read") {
      assert.equal(
        await awaitBounded(
          firstFreshRead,
          "first overtaking fresh read did not settle",
        ),
        "first",
      )
      assert.equal(
        scheduler.size,
        1,
        "first overtaking read did not register replacement repair",
      )
      replacementTimerFired = true
      replacementRepair = scheduler.runNext()
      laterFreshRead = maintenance.runFreshRead({
        deskRoot: root,
        ensureOptions: { marker: "later" },
        read: () => "later",
      })
      secondFreshReadRelease.resolve()
      assert.equal(
        await awaitBounded(
          secondFreshRead,
          "second overtaking fresh read did not settle",
        ),
        "second",
      )
      await flushAsyncWork(
        "deadlocked reindex state did not reach a deterministic turn",
      )
    } else {
      assert.equal(
        await awaitBounded(reindex, "reserved reindex did not settle"),
        observedReindex.value,
      )
      await awaitBounded(
        secondFreshReadEntered.promise,
        "second fresh read did not resume after reindex",
      )
      secondFreshReadRelease.resolve()
      assert.deepEqual(
        await awaitBounded(
          Promise.all([firstFreshRead, secondFreshRead]),
          "fresh reads did not settle after reserved reindex",
        ),
        ["first", "second"],
      )
      assert.equal(scheduler.size, 0)
      laterFreshRead = maintenance.runFreshRead({
        deskRoot: root,
        ensureOptions: { marker: "later" },
        read: () => "later",
      })
      assert.equal(
        await awaitBounded(
          laterFreshRead,
          "later same-root read did not resume",
        ),
        "later",
      )
    }

    assert.deepEqual(
      {
        nextOperation,
        fullReindexEntered: fullReindexEntered.settled,
        reindexState: observedReindex.state,
        replacementTimerFired,
        repairBatchCalls,
        laterFreshReadEntered: laterFreshReadEntered.settled,
      },
      {
        nextOperation: "reindex",
        fullReindexEntered: true,
        reindexState: "fulfilled",
        replacementTimerFired: false,
        repairBatchCalls: 1,
        laterFreshReadEntered: true,
      },
      "reindex must settle before fresh reads, without replacement repair, and release later same-root work",
    )
    assert.equal(
      events.includes("replacement-repair:run"),
      false,
      "replacement repair batch ran after explicit reindex",
    )
  } finally {
    activeRepairCleanupRelease.resolve()
    secondFreshReadRelease.resolve()
    if (fullReindexEntered.settled && maintenance) {
      await awaitBounded(
        maintenance.cancelBackgroundRepair(root),
        "reindex-reservation maintenance did not settle during cleanup",
      ).catch(() => {})
      await awaitBounded(
        Promise.allSettled(
          [
            initialFreshRead,
            activeRepair,
            reindex,
            firstFreshRead,
            secondFreshRead,
            replacementRepair,
            laterFreshRead,
          ].filter(Boolean),
        ),
        "reindex-reservation promises did not settle during cleanup",
      ).catch(() => {})
    }
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
        if (deskRoot === physicalRootKey(rootA)) {
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
        assert.equal(deskRoot, physicalRootKey(rootB))
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
        deskRoot: physicalRootKey(rootA),
        options: { embed: embedA, skipEmbed: true },
      },
      {
        deskRoot: physicalRootKey(rootB),
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
        assert.equal(deskRoot, physicalRootKey(root))
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
    assert.deepEqual(resetCalls, [{ deskRoot: physicalRootKey(root) }])
    assert.equal(ensureCalls.length, 2)
    assert.equal(ensureCalls[1].deskRoot, physicalRootKey(root))
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
