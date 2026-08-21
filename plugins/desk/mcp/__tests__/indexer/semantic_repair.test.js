import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { closeDb, openDb } from "../../src/db/init.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"
import {
  deterministicProcessRepairVector,
  deterministicRepairVector,
} from "../fixtures/semantic_repair_test_vectors.js"

const mcpRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))
const repairProcessFixturePath = fileURLToPath(
  new URL("../fixtures/semantic_repair_process_fixture.js", import.meta.url),
)
const semanticRepairModuleUrl = new URL(
  "../../src/indexer/semantic-repair.js",
  import.meta.url,
)
const TEST_SETTLEMENT_TIMEOUT_MS = 250
const MANUAL_SCHEDULER_MAX_BATCHES = 16

async function loadSemanticRepair() {
  return import(semanticRepairModuleUrl.href)
}

async function makeRoot(prefix = "desk-semantic-repair-") {
  return fs.mkdtemp(path.join(mcpRoot, `.${prefix}`))
}

function runRepairProcessPhase(phase, root, observationPath) {
  const result = spawnSync(
    process.execPath,
    [repairProcessFixturePath, phase, root, observationPath],
    {
      cwd: mcpRoot,
      encoding: "utf8",
      timeout: 10000,
    },
  )
  const failure = [
    `semantic repair child ${phase} failed`,
    `status=${String(result.status)}`,
    `signal=${String(result.signal)}`,
    `error=${result.error?.stack ?? "none"}`,
    `stdout:\n${result.stdout || "<empty>"}`,
    `stderr:\n${result.stderr || "<empty>"}`,
  ].join("\n")
  assert.equal(result.error, undefined, failure)
  assert.equal(result.signal, null, failure)
  assert.equal(result.status, 0, failure)
}

function boundedSettlement(promise, message, {
  onTimeout,
  timeoutMs = TEST_SETTLEMENT_TIMEOUT_MS,
} = {}) {
  let timeout
  const clear = () => {
    if (timeout === undefined) return
    clearTimeout(timeout)
    timeout = undefined
  }
  const settled = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      try {
        onTimeout?.()
      } catch (error) {
        reject(error)
        return
      }
      const error = new Error(message)
      error.code = "ERR_TEST_TIMEOUT"
      reject(error)
    }, timeoutMs)
    Promise.resolve(promise).then(
      (value) => {
        clear()
        resolve(value)
      },
      (error) => {
        clear()
        reject(error)
      },
    )
  })
  return { clear, settled }
}

async function awaitBounded(promise, message, options) {
  const settlement = boundedSettlement(promise, message, options)
  try {
    return await settlement.settled
  } finally {
    settlement.clear()
  }
}

function decodeStoredVector(value) {
  const buffer = Buffer.from(value)
  assert.equal(
    buffer.length % Float32Array.BYTES_PER_ELEMENT,
    0,
    "stored semantic repair vector must contain complete Float32 values",
  )
  const values = []
  for (
    let offset = 0;
    offset < buffer.length;
    offset += Float32Array.BYTES_PER_ELEMENT
  ) {
    values.push(buffer.readFloatLE(offset))
  }
  return values
}

function storedVectorForText(db, text) {
  const row = db.prepare(
    `SELECT v.embedding
     FROM chunk_vecs v
     JOIN chunks c ON c.id = v.chunk_id
     WHERE c.text = ?`,
  ).get(text)
  assert.ok(row, `missing stored semantic repair vector for ${text}`)
  return decodeStoredVector(row.embedding)
}

function assertVectorApprox(actual, expected, label) {
  const normalizedExpected = Array.from(Float32Array.from(expected))
  assert.equal(actual.length, normalizedExpected.length, `${label} dimension`)
  for (let index = 0; index < normalizedExpected.length; index += 1) {
    assert.ok(
      Math.abs(actual[index] - normalizedExpected[index]) <= 0.000001,
      `${label}[${index}] expected ${normalizedExpected[index]}, got ${actual[index]}`,
    )
  }
}

function assertStoredVector(db, text, expected) {
  assertVectorApprox(
    storedVectorForText(db, text),
    expected,
    `stored vector for ${text}`,
  )
}

function insertDocument(db, {
  documentPath,
  updatedAt,
  archived = false,
  texts,
}) {
  const doc = db.prepare(
    `INSERT INTO docs (
       path,
       kind,
       updated_at,
       hash,
       mtime,
       is_archived,
       frontmatter
     )
     VALUES (?, 'reference', ?, ?, 1, ?, '{}')
     RETURNING id`,
  ).get(
    documentPath,
    updatedAt,
    `hash:${documentPath}`,
    archived ? 1 : 0,
  )
  const insertChunk = db.prepare(
    `INSERT INTO chunks (
       doc_id,
       chunk_index,
       chunk_key,
       text_hash,
       embedding_spec_id,
       chunker_id,
       normalization_id,
       text
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (let index = 0; index < texts.length; index++) {
    insertChunk.run(
      doc.id,
      index,
      `${documentPath}:${index}`,
      `text-hash:${documentPath}:${index}`,
      ACTIVE_EMBEDDING_SPEC.id,
      ACTIVE_EMBEDDING_SPEC.chunker_id,
      ACTIVE_EMBEDDING_SPEC.normalization_id,
      texts[index],
    )
  }
}

function createManualScheduler() {
  const cleared = []
  const queued = []
  const scheduled = []
  const schedule = (callback, delay) => {
    const handle = {
      cancelled: false,
      unrefCalls: 0,
      unref() {
        this.unrefCalls += 1
      },
    }
    const entry = { callback, delay, handle }
    queued.push(entry)
    scheduled.push(entry)
    return handle
  }
  const clearScheduled = (handle) => {
    handle.cancelled = true
    cleared.push(handle)
  }
  const runNext = async () => {
    const entry = queued.shift()
    assert.ok(entry, "expected a scheduled semantic-repair batch")
    if (!entry.handle.cancelled) {
      await entry.callback()
    }
    return entry
  }
  const drain = async ({
    maxBatches = MANUAL_SCHEDULER_MAX_BATCHES,
  } = {}) => {
    let batchCount = 0
    while (queued.length > 0) {
      batchCount += 1
      assert.ok(
        batchCount <= maxBatches,
        `manual semantic-repair scheduler exceeded ${maxBatches} batches; repair may be rescheduling after completion`,
      )
      await awaitBounded(
        runNext(),
        `manual semantic-repair scheduler batch ${batchCount} did not settle`,
      )
    }
    return batchCount
  }
  return {
    clearScheduled,
    cleared,
    drain,
    queued,
    runNext,
    schedule,
    scheduled,
  }
}

test("semantic repair reuses one in-flight promise per root and evicts it after completion", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const scheduler = createManualScheduler()
  const calls = []
  const coordinator = createSemanticRepairCoordinator({
    repairBatch: async ({ deskRoot }) => {
      calls.push(deskRoot)
      return { processed_chunks: 1, remaining_chunks: 0 }
    },
    schedule: scheduler.schedule,
    clearScheduled: scheduler.clearScheduled,
  })

  const first = coordinator.start({
    deskRoot: "/tmp/desk-root-a",
    batchChunks: 100,
    batchMs: 5000,
  })
  const second = coordinator.start({
    deskRoot: "/tmp/desk-root-a",
    batchChunks: 100,
    batchMs: 5000,
  })

  assert.strictEqual(second, first)
  assert.equal(scheduler.queued.length, 1)
  await scheduler.drain()
  assert.equal(
    (await awaitBounded(
      first,
      "semantic repair first same-root job did not settle",
    )).state,
    "complete",
  )

  const next = coordinator.start({
    deskRoot: "/tmp/desk-root-a",
    batchChunks: 100,
    batchMs: 5000,
  })
  assert.notStrictEqual(next, first)
  assert.equal(scheduler.queued.length, 1)
  await scheduler.drain()
  assert.equal(
    (await awaitBounded(
      next,
      "semantic repair restarted same-root job did not settle",
    )).state,
    "complete",
  )
  assert.deepEqual(calls, [
    path.resolve("/tmp/desk-root-a"),
    path.resolve("/tmp/desk-root-a"),
  ])
})

test("semantic repair reuses the same promise while a same-root batch is active", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const scheduler = createManualScheduler()
  const root = path.resolve("desk-root-active")
  let calls = 0
  let markStarted
  let releaseBatch
  const started = new Promise((resolve) => {
    markStarted = resolve
  })
  const batchGate = new Promise((resolve) => {
    releaseBatch = resolve
  })
  const coordinator = createSemanticRepairCoordinator({
    repairBatch: () => {
      calls += 1
      markStarted()
      return batchGate
    },
    schedule: scheduler.schedule,
    clearScheduled: scheduler.clearScheduled,
  })

  const first = coordinator.start({ deskRoot: root })
  const activeBatch = scheduler.runNext()
  try {
    await awaitBounded(
      started,
      "semantic repair same-root active batch did not start",
      {
        onTimeout: () => releaseBatch({
          processed_chunks: 0,
          remaining_chunks: 0,
        }),
      },
    )
    const second = coordinator.start({ deskRoot: `${root}${path.sep}.` })
    assert.strictEqual(second, first)
    assert.equal(calls, 1)
    assert.equal(scheduler.scheduled.length, 1)
    assert.equal(scheduler.queued.length, 0)
  } finally {
    releaseBatch({ processed_chunks: 1, remaining_chunks: 0 })
    await awaitBounded(
      activeBatch,
      "semantic repair same-root active scheduler callback did not settle",
    )
  }

  assert.equal(
    (await awaitBounded(
      first,
      "semantic repair same-root active job did not settle",
    )).state,
    "complete",
  )
  assert.equal(calls, 1)
  assert.equal(scheduler.scheduled.length, 1)
})

test("semantic repair runs different roots independently", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const scheduler = createManualScheduler()
  const started = []
  const rootA = path.resolve("/tmp/desk-root-a")
  const rootB = path.resolve("/tmp/desk-root-b")
  let markBothStarted
  const bothStarted = new Promise((resolve) => {
    markBothStarted = resolve
  })
  const gates = new Map(
    [rootA, rootB].map((root) => {
      let release
      const promise = new Promise((resolve) => {
        release = resolve
      })
      return [root, { promise, release }]
    }),
  )
  const coordinator = createSemanticRepairCoordinator({
    repairBatch: ({ deskRoot, batchChunks, batchMs }) => {
      started.push({ deskRoot, batchChunks, batchMs })
      if (started.length === 2) markBothStarted()
      return gates.get(deskRoot).promise
    },
    schedule: scheduler.schedule,
    clearScheduled: scheduler.clearScheduled,
  })

  const repairA = coordinator.start({ deskRoot: rootA })
  const repairB = coordinator.start({ deskRoot: rootB })
  assert.notStrictEqual(repairA, repairB)
  const batchA = scheduler.runNext()
  const batchB = scheduler.runNext()
  try {
    await awaitBounded(
      bothStarted,
      "semantic repair different-root batches did not both start",
      {
        onTimeout: () => {
          for (const gate of gates.values()) {
            gate.release({ processed_chunks: 0, remaining_chunks: 0 })
          }
        },
      },
    )
    assert.deepEqual(started, [
      { deskRoot: rootA, batchChunks: 100, batchMs: 5000 },
      { deskRoot: rootB, batchChunks: 100, batchMs: 5000 },
    ])
  } finally {
    for (const gate of gates.values()) {
      gate.release({ processed_chunks: 1, remaining_chunks: 0 })
    }
  }
  await awaitBounded(
    Promise.all([batchA, batchB]),
    "semantic repair different-root scheduler callbacks did not settle",
  )
  const [resultA, resultB] = await awaitBounded(
    Promise.all([repairA, repairB]),
    "semantic repair different-root jobs did not settle",
  )
  assert.equal(resultA.state, "complete")
  assert.equal(resultB.state, "complete")
})

test("semantic repair schedules every batch at zero delay on an unref'ed timer", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const scheduler = createManualScheduler()
  const batches = []
  const root = path.resolve("/tmp/desk-root")
  const coordinator = createSemanticRepairCoordinator({
    repairBatch: async ({ deskRoot, batchChunks, batchMs }) => {
      batches.push({ deskRoot, batchChunks, batchMs })
      return {
        processed_chunks: 1,
        remaining_chunks: batches.length === 1 ? 1 : 0,
      }
    },
    schedule: scheduler.schedule,
    clearScheduled: scheduler.clearScheduled,
  })

  const repair = coordinator.start({
    deskRoot: root,
    batchChunks: 7,
    batchMs: 250,
  })
  await scheduler.drain()
  assert.equal(
    (await awaitBounded(
      repair,
      "semantic repair multi-batch job did not settle",
    )).state,
    "complete",
  )
  assert.deepEqual(batches, [
    { deskRoot: root, batchChunks: 7, batchMs: 250 },
    { deskRoot: root, batchChunks: 7, batchMs: 250 },
  ])
  assert.deepEqual(
    scheduler.scheduled.map(({ delay, handle }) => ({
      delay,
      unrefCalls: handle.unrefCalls,
    })),
    [
      { delay: 0, unrefCalls: 1 },
      { delay: 0, unrefCalls: 1 },
    ],
  )
})

test("semantic repair catches background rejection, records a compact failure, and permits retry", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const scheduler = createManualScheduler()
  const error = new Error("embedding endpoint unavailable")
  error.code = "embedding_service_unavailable"
  const calls = []
  const coordinator = createSemanticRepairCoordinator({
    repairBatch: async ({ deskRoot }) => {
      calls.push(deskRoot)
      if (calls.length === 1) {
        throw error
      }
      return { processed_chunks: 1, remaining_chunks: 0 }
    },
    schedule: scheduler.schedule,
    clearScheduled: scheduler.clearScheduled,
  })
  const root = path.resolve("/tmp/desk-root")
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on("unhandledRejection", onUnhandled)

  try {
    const repair = coordinator.start({ deskRoot: root })
    await scheduler.drain()
    await new Promise((resolve) => setImmediate(resolve))
    const result = await awaitBounded(
      repair,
      "semantic repair failed job did not settle",
    )
    assert.equal(result.state, "failed")
    assert.deepEqual(result.last_error, {
      reason: "embedding_service_unavailable",
      message: "embedding endpoint unavailable",
    })
    assert.deepEqual(coordinator.status(root), result)
    assert.deepEqual(unhandled, [])

    const retry = coordinator.start({ deskRoot: root })
    assert.notStrictEqual(retry, repair)
    assert.equal(scheduler.queued.length, 1)
    await scheduler.drain()
    assert.equal(
      (await awaitBounded(
        retry,
        "semantic repair retry after failure did not settle",
      )).state,
      "complete",
    )
    assert.deepEqual(calls, [root, root])
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})

test("semantic repair cancellation aborts the active batch and permits a later retry", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const scheduler = createManualScheduler()
  const settlements = []
  const bound = (promise, message, options) => {
    const settlement = boundedSettlement(promise, message, options)
    settlements.push(settlement)
    return settlement.settled
  }
  let calls = 0
  let abortCleanupFinished = false
  let activeBatchSettled = false
  let releaseBatchCleanup
  let batchStarted
  let markAbortObserved
  const started = new Promise((resolve) => {
    batchStarted = resolve
  })
  const abortObserved = new Promise((resolve) => {
    markAbortObserved = resolve
  })
  const coordinator = createSemanticRepairCoordinator({
    repairBatch: ({ signal }) => {
      calls += 1
      if (calls > 1) {
        return Promise.resolve({ processed_chunks: 1, remaining_chunks: 0 })
      }
      return new Promise((resolve) => {
        let cleanupScheduled = false
        releaseBatchCleanup = () => {
          if (cleanupScheduled) return
          cleanupScheduled = true
          setImmediate(() => {
            abortCleanupFinished = true
            resolve({
              processed_chunks: 0,
              remaining_chunks: 1,
              cancelled: true,
            })
          })
        }
        batchStarted()
        signal.addEventListener(
          "abort",
          () => {
            markAbortObserved()
          },
          { once: true },
        )
      })
    },
    schedule: scheduler.schedule,
    clearScheduled: scheduler.clearScheduled,
  })
  const root = path.resolve("/tmp/desk-root")

  const first = coordinator.start({ deskRoot: root })
  const activeBatch = scheduler.runNext().finally(() => {
    activeBatchSettled = true
  })
  let cancellation
  let cancellationSettled = false
  try {
    await bound(
      started,
      "semantic repair active batch did not start",
    )
    cancellation = Promise.resolve(coordinator.cancel(root))
    cancellation.then(
      () => {
        cancellationSettled = true
      },
      () => {
        cancellationSettled = true
      },
    )
    const cancelSettled = bound(
      cancellation,
      "semantic repair cancel did not settle after fallback batch cleanup",
      { onTimeout: () => releaseBatchCleanup?.() },
    )
    const activeBatchFinished = bound(
      activeBatch,
      "semantic repair active scheduler callback did not settle",
      { onTimeout: () => releaseBatchCleanup?.() },
    )
    const repairSettled = bound(
      first,
      "semantic repair promise did not settle after active cancellation",
      { onTimeout: () => releaseBatchCleanup?.() },
    )
    await bound(
      abortObserved,
      "semantic repair cancel did not abort the active batch before awaiting it",
      { onTimeout: () => releaseBatchCleanup?.() },
    )
    await Promise.resolve()
    assert.equal(cancellationSettled, false)
    assert.equal(abortCleanupFinished, false)
    assert.equal(activeBatchSettled, false)

    releaseBatchCleanup()
    const cancelled = await cancelSettled
    await activeBatchFinished
    assert.equal((await repairSettled).state, "idle")
    assert.equal(cancelled.cancelled, true)
    assert.equal(abortCleanupFinished, true)
    assert.equal(activeBatchSettled, true)
  } finally {
    releaseBatchCleanup?.()
    await Promise.allSettled(settlements.map(({ settled }) => settled))
    for (const settlement of settlements) settlement.clear()
  }

  assert.equal(abortCleanupFinished, true)
  assert.equal(activeBatchSettled, true)
  assert.equal(scheduler.queued.length, 0)
  assert.equal(scheduler.scheduled.length, 1)
  assert.equal(coordinator.status(root).state, "idle")

  const retry = coordinator.start({ deskRoot: root })
  assert.notStrictEqual(retry, first)
  const retryDrain = boundedSettlement(
    scheduler.drain(),
    "semantic repair retry scheduler callbacks did not settle",
  )
  const retrySettled = boundedSettlement(
    retry,
    "semantic repair retry did not settle",
  )
  try {
    await retryDrain.settled
    assert.equal((await retrySettled.settled).state, "complete")
  } finally {
    await Promise.allSettled([
      retryDrain.settled,
      retrySettled.settled,
    ])
    retryDrain.clear()
    retrySettled.clear()
  }
  assert.equal(calls, 2)
})

test("semantic repair cancellation clears a pending batch without running repair work", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const scheduler = createManualScheduler()
  const settlements = []
  const bound = (promise, message, options) => {
    const settlement = boundedSettlement(promise, message, options)
    settlements.push(settlement)
    return settlement.settled
  }
  let calls = 0
  let releaseUnexpectedRepair
  const unexpectedRepair = new Promise((resolve) => {
    releaseUnexpectedRepair = resolve
  })
  const coordinator = createSemanticRepairCoordinator({
    repairBatch: () => {
      calls += 1
      return unexpectedRepair
    },
    schedule: scheduler.schedule,
    clearScheduled: scheduler.clearScheduled,
  })
  const root = path.resolve("/tmp/desk-root")

  const repair = coordinator.start({ deskRoot: root })
  const pendingBatch = scheduler.queued[0]
  assert.ok(pendingBatch)
  assert.equal(scheduler.scheduled.length, 1)

  try {
    const cancellation = Promise.resolve(coordinator.cancel(root))
    const cancelSettled = bound(
      cancellation,
      "semantic repair pending cancellation did not settle",
      {
        onTimeout: () => releaseUnexpectedRepair({
          processed_chunks: 0,
          remaining_chunks: 1,
        }),
      },
    )
    const repairSettled = bound(
      repair,
      "semantic repair promise did not settle after pending cancellation",
      {
        onTimeout: () => releaseUnexpectedRepair({
          processed_chunks: 0,
          remaining_chunks: 1,
        }),
      },
    )
    const cancelled = await cancelSettled
    assert.equal(cancelled.cancelled, true)
    assert.equal(pendingBatch.handle.cancelled, true)
    assert.deepEqual(scheduler.cleared, [pendingBatch.handle])
    assert.equal((await repairSettled).state, "idle")
    assert.equal(coordinator.status(root).state, "idle")

    await bound(
      scheduler.drain(),
      "draining a cancelled semantic repair timer did not settle",
      {
        onTimeout: () => releaseUnexpectedRepair({
          processed_chunks: 0,
          remaining_chunks: 1,
        }),
      },
    )
    assert.equal(calls, 0)
    assert.equal(scheduler.queued.length, 0)
    assert.equal(scheduler.scheduled.length, 1)
  } finally {
    releaseUnexpectedRepair({
      processed_chunks: 0,
      remaining_chunks: 1,
    })
    await Promise.allSettled(settlements.map(({ settled }) => settled))
    for (const settlement of settlements) settlement.clear()
  }
})

test("semantic repair batch cancellation persists completed work and resumes the remainder", async () => {
  const { repairMissingVectorBatch } = await loadSemanticRepair()
  const root = await makeRoot()
  const db = openDb(root)
  const controller = new AbortController()
  const embedded = []
  const injectedVectors = new Map()
  try {
    insertDocument(db, {
      documentPath: "active/reference.md",
      updatedAt: "2026-01-01T00:00:00.000Z",
      texts: ["chunk-0", "chunk-1", "chunk-2"],
    })

    const cancelled = await repairMissingVectorBatch({
      db,
      deskRoot: root,
      batchChunks: 100,
      batchMs: 5000,
      signal: controller.signal,
      embedChunkDetailed: async (text) => {
        embedded.push(text)
        const injectedVector = deterministicRepairVector(embedded.length)
        injectedVectors.set(text, injectedVector)
        const result = {
          vector: injectedVector,
          available: true,
          diagnostic: null,
        }
        if (embedded.length === 1) controller.abort()
        return result
      },
    })

    assert.deepEqual(embedded, ["chunk-0"])
    assert.equal(cancelled.processed_chunks, 1)
    assert.equal(cancelled.vectors_indexed, 1)
    assert.equal(cancelled.remaining_chunks, 2)
    assert.equal(cancelled.stopped_by, "cancelled")
    assert.equal(cancelled.cancelled, true)
    assert.deepEqual(
      db.prepare(
        `SELECT c.text
         FROM chunk_vecs v
         JOIN chunks c ON c.id = v.chunk_id
         ORDER BY c.chunk_index`,
      ).all().map(({ text }) => text),
      ["chunk-0"],
    )
    assertStoredVector(
      db,
      "chunk-0",
      injectedVectors.get("chunk-0"),
    )
    assert.deepEqual(
      db.prepare(
        `SELECT c.text
         FROM chunks c
         LEFT JOIN chunk_vecs v ON v.chunk_id = c.id
         WHERE v.chunk_id IS NULL
         ORDER BY c.chunk_index`,
      ).all().map(({ text }) => text),
      ["chunk-1", "chunk-2"],
    )

    const resumedEmbeddings = []
    const resumed = await repairMissingVectorBatch({
      db,
      deskRoot: root,
      batchChunks: 100,
      batchMs: 5000,
      embedChunkDetailed: async (text) => {
        resumedEmbeddings.push(text)
        const injectedVector = deterministicRepairVector(
          100 + resumedEmbeddings.length,
        )
        injectedVectors.set(text, injectedVector)
        return {
          vector: injectedVector,
          available: true,
          diagnostic: null,
        }
      },
    })

    assert.deepEqual(resumedEmbeddings, ["chunk-1", "chunk-2"])
    assert.equal(resumed.processed_chunks, 2)
    assert.equal(resumed.vectors_indexed, 2)
    assert.equal(resumed.remaining_chunks, 0)
    assert.equal(resumed.stopped_by, "complete")
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM chunk_vecs").get().count,
      3,
    )
    for (const text of ["chunk-0", "chunk-1", "chunk-2"]) {
      assertStoredVector(db, text, injectedVectors.get(text))
    }
  } finally {
    closeDb(db)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("a new coordinator resumes persisted missing work after process interruption", async () => {
  await loadSemanticRepair()
  const root = await makeRoot()
  const observationPath = path.join(root, "repair-process-observation.json")
  let db = openDb(root)
  try {
    insertDocument(db, {
      documentPath: "active/reference.md",
      updatedAt: "2026-01-01T00:00:00.000Z",
      texts: ["chunk-0", "chunk-1", "chunk-2"],
    })
    closeDb(db)
    db = undefined

    runRepairProcessPhase("phase1", root, observationPath)
    db = openDb(root)
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM chunk_vecs").get().count,
      1,
    )
    const firstPersisted = db.prepare(
      `SELECT c.text, v.embedding
       FROM chunk_vecs v
       JOIN chunks c ON c.id = v.chunk_id`,
    ).get()
    assert.ok(firstPersisted)
    assertVectorApprox(
      decodeStoredVector(firstPersisted.embedding),
      deterministicProcessRepairVector("phase1", 1),
      `phase 1 persisted vector for ${firstPersisted.text}`,
    )
    closeDb(db)
    db = undefined

    const phaseOneObservation = JSON.parse(
      await fs.readFile(observationPath, "utf8"),
    ).phase1
    assert.equal(phaseOneObservation.repair_calls, 1)
    assert.equal(phaseOneObservation.repair_settled, false)
    assert.deepEqual(phaseOneObservation.embedded_texts, [firstPersisted.text])
    assert.deepEqual(phaseOneObservation.scheduled, [
      { delay: 0, unref_calls: 1, has_ref: false },
      { delay: 0, unref_calls: 1, has_ref: false },
    ])

    runRepairProcessPhase("phase2", root, observationPath)
    db = openDb(root)
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM chunk_vecs").get().count,
      3,
    )
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) AS count
         FROM chunks c
         LEFT JOIN chunk_vecs v ON v.chunk_id = c.id
         WHERE v.chunk_id IS NULL`,
      ).get().count,
      0,
    )
    const observation = JSON.parse(await fs.readFile(observationPath, "utf8"))
    assert.equal(observation.phase2.state, "complete")
    assert.equal(observation.phase2.repair_calls, 2)
    assert.equal(
      observation.phase2.embedded_texts.includes(firstPersisted.text),
      false,
    )
    assert.deepEqual(observation.phase2.scheduled, [
      { delay: 0, unref_calls: 1 },
      { delay: 0, unref_calls: 1 },
    ])
    assert.deepEqual(
      [
        ...observation.phase1.embedded_texts,
        ...observation.phase2.embedded_texts,
      ].sort(),
      ["chunk-0", "chunk-1", "chunk-2"],
    )
    assertStoredVector(
      db,
      firstPersisted.text,
      deterministicProcessRepairVector("phase1", 1),
    )
    assert.ok(
      observation.phase2.embedded_texts.length > 0,
      "phase 2 must resume at least one persisted semantic repair vector",
    )
    for (
      let index = 0;
      index < observation.phase2.embedded_texts.length;
      index += 1
    ) {
      assertStoredVector(
        db,
        observation.phase2.embedded_texts[index],
        deterministicProcessRepairVector("phase2", index + 1),
      )
    }
  } finally {
    closeDb(db)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("semantic repair batch prioritizes active recent documents, chunk ordinal, and path", async () => {
  const { repairMissingVectorBatch } = await loadSemanticRepair()
  const root = await makeRoot()
  const db = openDb(root)
  const seen = []
  const injectedVectors = new Map()
  try {
    insertDocument(db, {
      documentPath: "archive/reference.md",
      updatedAt: "2030-01-01T00:00:00.000Z",
      archived: true,
      texts: ["archived-new"],
    })
    insertDocument(db, {
      documentPath: "active/old.md",
      updatedAt: "2024-01-01T00:00:00.000Z",
      texts: ["active-old"],
    })
    insertDocument(db, {
      documentPath: "active/zulu.md",
      updatedAt: "2026-01-01T00:00:00.000Z",
      texts: ["active-zulu-0", "active-zulu-1"],
    })
    insertDocument(db, {
      documentPath: "active/alpha.md",
      updatedAt: "2026-01-01T00:00:00.000Z",
      texts: ["active-alpha-0", "active-alpha-1"],
    })
    insertDocument(db, {
      documentPath: "active/undated.md",
      updatedAt: null,
      texts: ["active-undated"],
    })

    const result = await repairMissingVectorBatch({
      db,
      deskRoot: root,
      batchChunks: 10,
      batchMs: 5000,
      embedChunkDetailed: async (text) => {
        seen.push(text)
        const injectedVector = deterministicRepairVector(seen.length)
        injectedVectors.set(text, injectedVector)
        return {
          vector: injectedVector,
          available: true,
          diagnostic: null,
        }
      },
    })

    assert.deepEqual(seen, [
      "active-alpha-0",
      "active-zulu-0",
      "active-alpha-1",
      "active-zulu-1",
      "active-old",
      "active-undated",
      "archived-new",
    ])
    assert.equal(result.processed_chunks, 7)
    assert.equal(result.vectors_indexed, 7)
    assert.equal(result.remaining_chunks, 0)
    assert.equal(result.stopped_by, "complete")
    for (const [text, injectedVector] of injectedVectors) {
      assertStoredVector(db, text, injectedVector)
    }
  } finally {
    closeDb(db)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("semantic repair batch stops at the chunk bound and resumes remaining vectors", async () => {
  const { repairMissingVectorBatch } = await loadSemanticRepair()
  const root = await makeRoot()
  const db = openDb(root)
  const seen = []
  const injectedVectors = new Map()
  try {
    insertDocument(db, {
      documentPath: "active/reference.md",
      updatedAt: "2026-01-01T00:00:00.000Z",
      texts: ["chunk-0", "chunk-1", "chunk-2"],
    })
    const options = {
      db,
      deskRoot: root,
      batchChunks: 2,
      batchMs: 5000,
      embedChunkDetailed: async (text) => {
        seen.push(text)
        const injectedVector = deterministicRepairVector(seen.length)
        injectedVectors.set(text, injectedVector)
        return {
          vector: injectedVector,
          available: true,
          diagnostic: null,
        }
      },
    }

    const first = await repairMissingVectorBatch(options)
    assert.equal(first.processed_chunks, 2)
    assert.equal(first.remaining_chunks, 1)
    assert.equal(first.stopped_by, "chunk_limit")

    const second = await repairMissingVectorBatch(options)
    assert.equal(second.processed_chunks, 1)
    assert.equal(second.remaining_chunks, 0)
    assert.equal(second.stopped_by, "complete")
    assert.deepEqual(seen, ["chunk-0", "chunk-1", "chunk-2"])
    for (const [text, injectedVector] of injectedVectors) {
      assertStoredVector(db, text, injectedVector)
    }
  } finally {
    closeDb(db)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("semantic repair batch stops at the elapsed-time bound", async () => {
  const { repairMissingVectorBatch } = await loadSemanticRepair()
  const root = await makeRoot()
  const db = openDb(root)
  const seen = []
  const injectedVectors = new Map()
  let elapsedMs = 0
  try {
    insertDocument(db, {
      documentPath: "active/reference.md",
      updatedAt: "2026-01-01T00:00:00.000Z",
      texts: ["chunk-0", "chunk-1", "chunk-2"],
    })

    const result = await repairMissingVectorBatch({
      db,
      deskRoot: root,
      batchChunks: 100,
      batchMs: 5,
      now: () => elapsedMs,
      embedChunkDetailed: async (text) => {
        seen.push(text)
        elapsedMs += 3
        const injectedVector = deterministicRepairVector(seen.length)
        injectedVectors.set(text, injectedVector)
        return {
          vector: injectedVector,
          available: true,
          diagnostic: null,
        }
      },
    })

    assert.deepEqual(seen, ["chunk-0", "chunk-1"])
    assert.equal(result.processed_chunks, 2)
    assert.equal(result.remaining_chunks, 1)
    assert.equal(result.stopped_by, "time_limit")
    for (const [text, injectedVector] of injectedVectors) {
      assertStoredVector(db, text, injectedVector)
    }
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) AS count
         FROM chunks c
         LEFT JOIN chunk_vecs v ON v.chunk_id = c.id
         WHERE c.text = 'chunk-2' AND v.chunk_id IS NULL`,
      ).get().count,
      1,
    )
  } finally {
    closeDb(db)
    await fs.rm(root, { recursive: true, force: true })
  }
})
