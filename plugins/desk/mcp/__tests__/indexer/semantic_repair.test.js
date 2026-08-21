import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
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
  return fs.mkdtemp(path.join(tmpdir(), prefix))
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

function insertStoredVector(db, text, vector = deterministicRepairVector(1)) {
  const chunk = db.prepare(
    "SELECT id FROM chunks WHERE text = ?",
  ).get(text)
  assert.ok(chunk, `missing chunk for stored vector ${text}`)
  db.prepare(
    "INSERT INTO chunk_vecs (chunk_id, embedding) VALUES (?, ?)",
  ).run(BigInt(chunk.id), new Float32Array(vector))
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

test("semantic repair test roots stay outside the MCP source tree", async () => {
  const root = await makeRoot("desk-semantic-repair-location-")
  try {
    assert.equal(path.dirname(root), path.resolve(tmpdir()))
    assert.equal(
      path.relative(mcpRoot, root).startsWith(`..${path.sep}`),
      true,
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("semantic repair validates roots and positive batch limits", async () => {
  const {
    createSemanticRepairCoordinator,
    repairMissingVectorBatch,
  } = await loadSemanticRepair()
  const coordinator = createSemanticRepairCoordinator()

  assert.throws(() => coordinator.status(" \t"), /deskRoot is required/)
  assert.throws(() => coordinator.start(), /deskRoot is required/)
  assert.throws(
    () => coordinator.start({ deskRoot: null }),
    /deskRoot is required/,
  )
  await assert.rejects(
    coordinator.cancel(undefined),
    /deskRoot is required/,
  )

  for (const batchChunks of [0, 1.5]) {
    await assert.rejects(
      repairMissingVectorBatch({
        deskRoot: path.resolve("invalid-batch-chunks"),
        batchChunks,
      }),
      /batchChunks must be a positive integer/,
    )
  }
  for (const batchMs of [-1, 2.5]) {
    await assert.rejects(
      repairMissingVectorBatch({
        deskRoot: path.resolve("invalid-batch-ms"),
        batchMs,
      }),
      /batchMs must be a positive integer/,
    )
  }
  await assert.rejects(
    repairMissingVectorBatch(),
    /deskRoot is required/,
  )
})

test("semantic repair default scheduling exposes isolated status snapshots and terminal cancellation", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const root = await makeRoot("desk-semantic-repair-default-")
  const cancelledRoot = await makeRoot(
    "desk-semantic-repair-default-cancel-",
  )
  const coordinator = createSemanticRepairCoordinator()
  const unknownRoot = path.join(root, "unknown")

  try {
    const unknown = coordinator.status(unknownRoot)
    assert.deepEqual(unknown, {
      state: "idle",
      last_error: null,
    })
    unknown.state = "mutated"
    assert.equal(coordinator.status(unknownRoot).state, "idle")
    assert.deepEqual(await coordinator.cancel(unknownRoot), {
      state: "idle",
      last_error: null,
      cancelled: false,
    })

    const pending = coordinator.start({ deskRoot: cancelledRoot })
    const running = coordinator.status(cancelledRoot)
    assert.equal(running.state, "running")
    running.state = "mutated"
    assert.equal(coordinator.status(cancelledRoot).state, "running")
    assert.deepEqual(
      await awaitBounded(
        coordinator.cancel(cancelledRoot),
        "default semantic repair pending cancellation did not settle",
      ),
      {
        state: "idle",
        last_error: null,
        cancelled: true,
      },
    )
    assert.deepEqual(
      await awaitBounded(
        pending,
        "default semantic repair pending promise did not settle",
      ),
      {
        state: "idle",
        last_error: null,
      },
    )

    const repair = coordinator.start({
      deskRoot: root,
      dbPath: path.join(root, "owned.sqlite"),
    })
    assert.equal(coordinator.status(root).state, "running")
    assert.deepEqual(
      await awaitBounded(
        repair,
        "default semantic repair completion did not settle",
        { timeoutMs: TEST_SETTLEMENT_TIMEOUT_MS * 4 },
      ),
      {
        state: "complete",
        last_error: null,
      },
    )
    assert.deepEqual(await fs.readdir(root), ["owned.sqlite"])

    const completed = coordinator.status(root)
    completed.state = "mutated"
    assert.equal(coordinator.status(root).state, "complete")
    assert.deepEqual(await coordinator.cancel(root), {
      state: "complete",
      last_error: null,
      cancelled: false,
    })
  } finally {
    await fs.rm(cancelledRoot, { recursive: true, force: true })
    await fs.rm(root, { recursive: true, force: true })
  }
})

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

test("semantic repair compacts synchronous scheduling failures and preserves status snapshots", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const root = path.resolve("desk-root-schedule-failure")
  const error = new Error("private scheduler detail")
  error.reason = "embedding_service_unavailable"
  const coordinator = createSemanticRepairCoordinator({
    schedule: () => {
      throw error
    },
  })

  const result = await awaitBounded(
    coordinator.start({ deskRoot: root }),
    "semantic repair scheduling failure did not settle",
  )
  assert.deepEqual(result, {
    state: "failed",
    last_error: {
      reason: "embedding_service_unavailable",
      message: "embedding endpoint unavailable",
    },
  })

  const snapshot = coordinator.status(root)
  snapshot.last_error.reason = "mutated"
  assert.deepEqual(coordinator.status(root), result)
})

test("semantic repair isolates resolved terminal results from stored status", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const root = path.resolve("desk-root-result-isolation")
  const error = new Error("private scheduler detail")
  error.reason = "embedding_service_unavailable"
  const coordinator = createSemanticRepairCoordinator({
    schedule: () => {
      throw error
    },
  })

  const result = await awaitBounded(
    coordinator.start({ deskRoot: root }),
    "semantic repair result isolation failure did not settle",
  )
  const stored = coordinator.status(root)
  result.state = "mutated"
  result.last_error.reason = "mutated"
  result.last_error.message = "mutated"

  assert.deepEqual(coordinator.status(root), stored)
})

test("semantic repair clears a registered timer when unref throws and permits retry", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const root = path.resolve("desk-root-unref-failure")
  const handles = []
  const cleared = []
  let callbackCalls = 0
  let repairCalls = 0
  const error = new Error("private timer unref detail")
  const schedule = (callback, delay) => {
    const handle = {
      cancelled: false,
      delay,
      shouldThrow: handles.length === 0,
      unrefCalls: 0,
      async callback() {
        callbackCalls += 1
        return callback()
      },
      unref() {
        this.unrefCalls += 1
        if (this.shouldThrow) throw error
      },
    }
    handles.push(handle)
    return handle
  }
  const coordinator = createSemanticRepairCoordinator({
    repairBatch: async () => {
      repairCalls += 1
      return { processed_chunks: 1, remaining_chunks: 0 }
    },
    schedule,
    clearScheduled: (handle) => {
      handle.cancelled = true
      cleared.push(handle)
    },
  })

  const failed = await awaitBounded(
    coordinator.start({ deskRoot: root }),
    "semantic repair unref failure did not settle",
  )
  assert.deepEqual(failed, {
    state: "failed",
    last_error: {
      reason: "semantic_repair_failed",
      message: "semantic repair failed",
    },
  })
  assert.strictEqual(cleared[0], handles[0])
  if (!handles[0].cancelled) await handles[0].callback()
  assert.equal(callbackCalls, 0)
  assert.equal(repairCalls, 0)
  assert.deepEqual(coordinator.status(root), failed)

  const retry = coordinator.start({ deskRoot: root })
  assert.equal(handles.length, 2)
  assert.equal(handles[1].unrefCalls, 1)
  if (!handles[1].cancelled) await handles[1].callback()
  assert.deepEqual(
    await awaitBounded(
      retry,
      "semantic repair retry after unref failure did not settle",
    ),
    {
      state: "complete",
      last_error: null,
    },
  )
  assert.equal(callbackCalls, 1)
  assert.equal(repairCalls, 1)
})

test("semantic repair finish stays terminal when unref and timer clearing throw", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const root = path.resolve("desk-root-unref-clear-failure")
  const handles = []
  let clearCalls = 0
  let repairCalls = 0
  const unrefError = new Error("private timer unref detail")
  unrefError.reason = "embedding_service_unavailable"
  const clearError = new Error("private timer clear detail")
  const schedule = (callback, delay) => {
    const handle = {
      callback,
      delay,
      unrefCalls: 0,
      unref() {
        this.unrefCalls += 1
        if (handles.length === 1) throw unrefError
      },
    }
    handles.push(handle)
    return handle
  }
  const coordinator = createSemanticRepairCoordinator({
    repairBatch: async () => {
      repairCalls += 1
      return { processed_chunks: 1, remaining_chunks: 0 }
    },
    schedule,
    clearScheduled: () => {
      clearCalls += 1
      throw clearError
    },
  })

  const failedPromise = coordinator.start({ deskRoot: root })
  let failedSettlements = 0
  failedPromise.then(() => {
    failedSettlements += 1
  })
  const failed = await awaitBounded(
    failedPromise,
    "semantic repair unref and clear failure did not settle",
  )
  assert.deepEqual(failed, {
    state: "failed",
    last_error: {
      reason: "embedding_service_unavailable",
      message: "embedding endpoint unavailable",
    },
  })
  assert.equal(failedSettlements, 1)
  assert.equal(clearCalls, 1)
  assert.equal(repairCalls, 0)

  await handles[0].callback()
  assert.equal(failedSettlements, 1)
  assert.equal(clearCalls, 1)
  assert.equal(repairCalls, 0)
  assert.deepEqual(coordinator.status(root), failed)

  const retry = coordinator.start({ deskRoot: root })
  assert.notStrictEqual(retry, failedPromise)
  assert.strictEqual(coordinator.start({ deskRoot: root }), retry)
  assert.equal(handles.length, 2)
  await handles[1].callback()
  assert.deepEqual(
    await awaitBounded(
      retry,
      "semantic repair retry after unref and clear failure did not settle",
    ),
    {
      state: "complete",
      last_error: null,
    },
  )
  assert.equal(clearCalls, 1)
  assert.equal(repairCalls, 1)

  await handles[0].callback()
  assert.equal(failedSettlements, 1)
  assert.equal(clearCalls, 1)
  assert.equal(repairCalls, 1)
  assert.equal(coordinator.status(root).state, "complete")
})

test("semantic repair preserves the active batch when a custom scheduler fires a reschedule synchronously", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const root = path.resolve("desk-root-synchronous-reschedule")
  const handles = []
  const cleared = []
  let calls = 0
  let firstCallback
  let nestedCallback
  const schedule = (callback, delay) => {
    const handle = {
      delay,
      unrefCalls: 0,
      unref() {
        this.unrefCalls += 1
      },
    }
    handles.push(handle)
    if (handles.length === 1) {
      firstCallback = callback
    } else {
      nestedCallback = callback()
    }
    return handle
  }
  const coordinator = createSemanticRepairCoordinator({
    repairBatch: async () => {
      calls += 1
      return {
        processed_chunks: 1,
        remaining_chunks: calls === 1 ? 1 : 0,
      }
    },
    schedule,
    clearScheduled: (handle) => {
      cleared.push(handle)
    },
  })

  const repair = coordinator.start({ deskRoot: root })
  assert.equal(typeof firstCallback, "function")
  await awaitBounded(
    firstCallback(),
    "semantic repair first synchronous-reschedule batch did not settle",
  )
  await awaitBounded(
    nestedCallback,
    "semantic repair nested synchronous-reschedule batch did not settle",
  )
  assert.deepEqual(
    await awaitBounded(
      repair,
      "semantic repair synchronous-reschedule job did not settle",
    ),
    {
      state: "complete",
      last_error: null,
    },
  )
  assert.equal(calls, 2)
  assert.equal(handles.length, 2)
  assert.deepEqual(handles.map(({ delay, unrefCalls }) => ({
    delay,
    unrefCalls,
  })), [
    { delay: 0, unrefCalls: 1 },
    { delay: 0, unrefCalls: 1 },
  ])
  assert.deepEqual(cleared, [handles[1]])
})

test("semantic repair fails after a custom batch makes no progress", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const scheduler = createManualScheduler()
  let calls = 0
  const coordinator = createSemanticRepairCoordinator({
    repairBatch: async () => {
      calls += 1
      return { processed_chunks: 0, remaining_chunks: 2 }
    },
    schedule: scheduler.schedule,
    clearScheduled: scheduler.clearScheduled,
  })

  const repair = coordinator.start({ deskRoot: "/tmp/desk-root" })
  await scheduler.drain()
  const result = await awaitBounded(
    repair,
    "semantic repair no-progress job did not settle",
  )

  assert.deepEqual(result, {
    state: "failed",
    last_error: {
      reason: "semantic_repair_no_progress",
      message: "semantic repair made no progress",
    },
  })
  assert.equal(calls, 1)
  assert.equal(scheduler.scheduled.length, 1)
  assert.equal(scheduler.queued.length, 0)
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

test("semantic repair redacts private error details from status", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const scheduler = createManualScheduler()
  const privatePath = "/Users/private/customer-alpha/strategy.md"
  const error = new Error(`failed to embed ${privatePath}`)
  error.code = "document_embedding_failed"
  error.stack = `Error: failed to embed ${privatePath}\n    at ${privatePath}:42:7`
  const coordinator = createSemanticRepairCoordinator({
    repairBatch: async () => {
      throw error
    },
    schedule: scheduler.schedule,
    clearScheduled: scheduler.clearScheduled,
  })

  const repair = coordinator.start({ deskRoot: "/tmp/desk-root" })
  await scheduler.drain()
  const result = await awaitBounded(
    repair,
    "semantic repair private-error job did not settle",
  )
  const serialized = JSON.stringify(result)

  assert.deepEqual(Object.keys(result.last_error).sort(), ["message", "reason"])
  assert.equal(result.last_error.reason, "semantic_repair_failed")
  assert.equal(result.last_error.message, "semantic repair failed")
  assert.ok(result.last_error.message.length <= 64)
  assert.equal(serialized.includes("customer-alpha"), false)
  assert.equal(serialized.includes("strategy.md"), false)
  assert.equal(serialized.includes(privatePath), false)
  assert.equal(serialized.includes("at /Users"), false)
})

test("semantic repair treats an active custom batch rejection after abort as cancellation", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const scheduler = createManualScheduler()
  const root = path.resolve("desk-root-active-rejection-cancellation")
  let markStarted
  const started = new Promise((resolve) => {
    markStarted = resolve
  })
  const coordinator = createSemanticRepairCoordinator({
    repairBatch: ({ signal }) => new Promise((_resolve, reject) => {
      markStarted()
      signal.addEventListener("abort", () => {
        reject(new Error("private aborted batch detail"))
      }, { once: true })
    }),
    schedule: scheduler.schedule,
    clearScheduled: scheduler.clearScheduled,
  })

  const repair = coordinator.start({ deskRoot: root })
  const activeBatch = scheduler.runNext()
  await awaitBounded(
    started,
    "semantic repair active rejecting batch did not start",
  )
  assert.deepEqual(
    await awaitBounded(
      coordinator.cancel(root),
      "semantic repair active rejecting batch cancellation did not settle",
    ),
    {
      state: "idle",
      last_error: null,
      cancelled: true,
    },
  )
  await awaitBounded(
    activeBatch,
    "semantic repair active rejecting scheduler callback did not settle",
  )
  assert.deepEqual(await repair, {
    state: "idle",
    last_error: null,
  })
  assert.deepEqual(coordinator.status(root), {
    state: "idle",
    last_error: null,
  })
})

test("semantic repair cancellation settles across the reschedule cleanup boundary", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const scheduler = createManualScheduler()
  const root = path.resolve("desk-root-reschedule-cancellation")
  let calls = 0
  let cancellation
  let coordinator
  let markCancellationStarted
  const cancellationStarted = new Promise((resolve) => {
    markCancellationStarted = resolve
  })
  const schedule = (callback, delay) => {
    const handle = scheduler.schedule(callback, delay)
    if (scheduler.scheduled.length === 2) {
      queueMicrotask(() => {
        cancellation = coordinator.cancel(root)
        markCancellationStarted()
      })
    }
    return handle
  }
  coordinator = createSemanticRepairCoordinator({
    repairBatch: async () => {
      calls += 1
      return { processed_chunks: 1, remaining_chunks: 1 }
    },
    schedule,
    clearScheduled: scheduler.clearScheduled,
  })

  const repair = coordinator.start({ deskRoot: root })
  const firstBatch = scheduler.runNext()
  await awaitBounded(
    cancellationStarted,
    "semantic repair cancellation did not enter the reschedule cleanup boundary",
  )
  const pendingBatch = scheduler.scheduled[1]
  assert.ok(pendingBatch)
  assert.equal(pendingBatch.handle.cancelled, true)

  const [cancelled, result] = await awaitBounded(
    Promise.all([cancellation, repair]),
    "semantic repair cancellation did not settle across the reschedule cleanup boundary",
  )
  await awaitBounded(
    firstBatch,
    "semantic repair first batch did not settle after boundary cancellation",
  )
  await scheduler.drain()

  assert.deepEqual(cancelled, {
    state: "idle",
    last_error: null,
    cancelled: true,
  })
  assert.deepEqual(result, {
    state: "idle",
    last_error: null,
  })
  assert.deepEqual(coordinator.status(root), result)
  assert.equal(calls, 1)
  assert.equal(scheduler.scheduled.length, 2)
  assert.deepEqual(scheduler.cleared, [pendingBatch.handle])
  assert.equal(scheduler.queued.length, 0)
})

test("semantic repair cancellation aborts the active real batch, waits for cleanup, and permits a later retry", async () => {
  const {
    createSemanticRepairCoordinator,
    repairMissingVectorBatch,
  } = await loadSemanticRepair()
  const root = await makeRoot()
  const db = openDb(root)
  const scheduler = createManualScheduler()
  const settlements = []
  const bound = (promise, message, options) => {
    const settlement = boundedSettlement(promise, message, options)
    settlements.push(settlement)
    return settlement.settled
  }
  const cancellationTimeoutMs = TEST_SETTLEMENT_TIMEOUT_MS * 4
  const embeddingFallbackMs = TEST_SETTLEMENT_TIMEOUT_MS * 2
  const embedded = []
  const injectedVectors = new Map()
  let batchSignal
  let embedSignal
  let embeddingFallback
  let embeddingFallbackFired = false
  let finishPendingEmbedding
  let abortCleanupFinished = false
  let activeBatchSettled = false
  let releaseAbortCleanup
  let markEmbeddingStarted
  let markAbortObserved
  const embeddingStarted = new Promise((resolve) => {
    markEmbeddingStarted = resolve
  })
  const abortObserved = new Promise((resolve) => {
    markAbortObserved = resolve
  })
  const abortCleanup = new Promise((resolve) => {
    releaseAbortCleanup = resolve
  })
  const coordinator = createSemanticRepairCoordinator({
    repairBatch: (options) => {
      batchSignal = options.signal
      return awaitBounded(
        repairMissingVectorBatch({
          ...options,
          db,
          embedChunkDetailed: (text, opts) => {
            embedded.push(text)
            const injectedVector = deterministicRepairVector(
              200 + embedded.length,
            )
            injectedVectors.set(text, injectedVector)
            if (embedded.length > 1) {
              assert.strictEqual(opts?.signal, options.signal)
              return Promise.resolve({
                vector: injectedVector,
                available: true,
                diagnostic: null,
              })
            }

            embedSignal = opts?.signal
            markEmbeddingStarted()
            return new Promise((resolve, reject) => {
              let settled = false
              const finish = (callback, value) => {
                if (settled) return
                settled = true
                clearTimeout(embeddingFallback)
                callback(value)
              }
              finishPendingEmbedding = () => {
                finish(resolve, {
                  vector: injectedVector,
                  available: true,
                  diagnostic: null,
                })
              }
              embeddingFallback = setTimeout(() => {
                embeddingFallbackFired = true
                finishPendingEmbedding()
              }, embeddingFallbackMs)

              const onAbort = () => {
                markAbortObserved()
                abortCleanup.then(() => {
                  abortCleanupFinished = true
                  const error = new Error("semantic repair embedding aborted")
                  error.name = "AbortError"
                  error.code = "ABORT_ERR"
                  finish(reject, error)
                })
              }
              if (embedSignal?.aborted) {
                onAbort()
              } else {
                embedSignal?.addEventListener("abort", onAbort, { once: true })
              }
            })
          },
        }),
        "semantic repair active real batch did not settle",
        {
          onTimeout: () => {
            releaseAbortCleanup()
            finishPendingEmbedding?.()
          },
          timeoutMs: cancellationTimeoutMs * 2,
        },
      )
    },
    schedule: scheduler.schedule,
    clearScheduled: scheduler.clearScheduled,
  })

  try {
    insertDocument(db, {
      documentPath: "active/reference.md",
      updatedAt: "2026-01-01T00:00:00.000Z",
      texts: ["chunk-0", "chunk-1"],
    })

    const first = coordinator.start({
      deskRoot: root,
      batchChunks: 1,
      batchMs: 5000,
    })
    const activeBatch = scheduler.runNext().finally(() => {
      activeBatchSettled = true
    })
    let cancellationSettled = false
    await bound(
      embeddingStarted,
      "semantic repair active real batch did not enter embedding",
      {
        onTimeout: () => finishPendingEmbedding?.(),
        timeoutMs: cancellationTimeoutMs,
      },
    )
    assert.notEqual(
      embeddingFallback,
      undefined,
      "semantic repair cancellation test must pre-schedule its embedding fallback",
    )

    const cancellation = Promise.resolve(coordinator.cancel(root))
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
      "semantic repair cancel did not settle after real batch cleanup",
      {
        onTimeout: () => finishPendingEmbedding?.(),
        timeoutMs: cancellationTimeoutMs,
      },
    )
    const activeBatchFinished = bound(
      activeBatch,
      "semantic repair active real scheduler callback did not settle",
      {
        onTimeout: () => finishPendingEmbedding?.(),
        timeoutMs: cancellationTimeoutMs,
      },
    )
    const repairSettled = bound(
      first,
      "semantic repair promise did not settle after real batch cancellation",
      {
        onTimeout: () => finishPendingEmbedding?.(),
        timeoutMs: cancellationTimeoutMs,
      },
    )
    await bound(
      abortObserved,
      "semantic repair cancel did not propagate its AbortSignal into the embedding call",
      {
        onTimeout: () => finishPendingEmbedding?.(),
        timeoutMs: cancellationTimeoutMs,
      },
    )

    assert.strictEqual(embedSignal, batchSignal)
    assert.equal(embedSignal.aborted, true)
    await Promise.resolve()
    assert.equal(cancellationSettled, false)
    assert.equal(abortCleanupFinished, false)
    assert.equal(activeBatchSettled, false)
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM chunk_vecs").get().count,
      0,
    )

    releaseAbortCleanup()
    const cancelled = await cancelSettled
    await activeBatchFinished
    assert.equal((await repairSettled).state, "idle")
    assert.equal(cancelled.cancelled, true)
    assert.equal(abortCleanupFinished, true)
    assert.equal(activeBatchSettled, true)
    assert.equal(embeddingFallbackFired, false)
    assert.deepEqual(embedded, ["chunk-0"])
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM chunk_vecs").get().count,
      0,
    )
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) AS count
         FROM chunks c
         LEFT JOIN chunk_vecs v ON v.chunk_id = c.id
         WHERE v.chunk_id IS NULL`,
      ).get().count,
      2,
    )
    assert.equal(scheduler.queued.length, 0)
    assert.equal(scheduler.scheduled.length, 1)
    assert.equal(coordinator.status(root).state, "idle")

    const retry = coordinator.start({
      deskRoot: root,
      batchChunks: 100,
      batchMs: 5000,
    })
    assert.notStrictEqual(retry, first)
    await bound(
      scheduler.drain(),
      "semantic repair retry scheduler callbacks did not settle",
    )
    assert.equal(
      (await bound(
        retry,
        "semantic repair retry after real cancellation did not settle",
      )).state,
      "complete",
    )
    assert.deepEqual(embedded, ["chunk-0", "chunk-0", "chunk-1"])
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM chunk_vecs").get().count,
      2,
    )
    for (const text of ["chunk-0", "chunk-1"]) {
      assertStoredVector(db, text, injectedVectors.get(text))
    }
  } finally {
    clearTimeout(embeddingFallback)
    releaseAbortCleanup()
    finishPendingEmbedding?.()
    await Promise.allSettled(settlements.map(({ settled }) => settled))
    for (const settlement of settlements) settlement.clear()
    closeDb(db)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("semantic repair discards a pending vector resolved after cancellation", async () => {
  const {
    createSemanticRepairCoordinator,
    repairMissingVectorBatch,
  } = await loadSemanticRepair()
  const root = await makeRoot()
  const db = openDb(root)
  const scheduler = createManualScheduler()
  const injectedVector = deterministicRepairVector(404)
  let batchResult
  let embedSignal
  let markEmbeddingStarted
  let resolveEmbedding
  const embeddingStarted = new Promise((resolve) => {
    markEmbeddingStarted = resolve
  })
  const coordinator = createSemanticRepairCoordinator({
    repairBatch: async (options) => {
      batchResult = await repairMissingVectorBatch({
        ...options,
        db,
        embedChunkDetailed: (_text, embedOptions) => {
          embedSignal = embedOptions.signal
          markEmbeddingStarted()
          return new Promise((resolve) => {
            resolveEmbedding = resolve
          })
        },
      })
      return batchResult
    },
    schedule: scheduler.schedule,
    clearScheduled: scheduler.clearScheduled,
  })

  try {
    insertDocument(db, {
      documentPath: "active/reference.md",
      updatedAt: "2026-01-01T00:00:00.000Z",
      texts: ["chunk-0", "chunk-1"],
    })

    const repair = coordinator.start({
      deskRoot: root,
      batchChunks: 100,
      batchMs: 5000,
    })
    const activeBatch = scheduler.runNext()
    await awaitBounded(
      embeddingStarted,
      "semantic repair pending embedding did not start",
    )

    const cancellation = coordinator.cancel(root)
    assert.equal(embedSignal.aborted, true)
    resolveEmbedding({
      vector: injectedVector,
      available: true,
      diagnostic: null,
    })

    const cancelled = await awaitBounded(
      cancellation,
      "semantic repair cancellation did not settle after pending embedding resolved",
    )
    await awaitBounded(
      activeBatch,
      "semantic repair active batch did not settle after pending embedding resolved",
    )
    assert.equal(
      (await awaitBounded(
        repair,
        "semantic repair job did not settle after pending embedding resolved",
      )).state,
      "idle",
    )

    assert.deepEqual(batchResult, {
      processed_chunks: 0,
      vectors_indexed: 0,
      remaining_chunks: 2,
      stopped_by: "cancelled",
      cancelled: true,
    })
    assert.equal(cancelled.cancelled, true)
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM chunk_vecs").get().count,
      0,
    )
    assert.equal(
      db.prepare(
        "SELECT COUNT(*) AS count FROM chunk_embedding_failures",
      ).get().count,
      0,
    )
    assert.equal(scheduler.scheduled.length, 1)
    assert.equal(scheduler.queued.length, 0)
  } finally {
    resolveEmbedding?.({
      vector: injectedVector,
      available: true,
      diagnostic: null,
    })
    closeDb(db)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("semantic repair leaves a changed-only stale batch resumable at the chunk limit", async () => {
  const { repairMissingVectorBatch } = await loadSemanticRepair()
  const root = await makeRoot()
  const db = openDb(root)
  try {
    insertDocument(db, {
      documentPath: "active/reference.md",
      updatedAt: "2026-01-01T00:00:00.000Z",
      texts: ["stale-chunk"],
    })

    const result = await repairMissingVectorBatch({
      db,
      deskRoot: root,
      batchChunks: 1,
      embedChunkDetailed: async (text) => {
        assert.equal(text, "stale-chunk")
        db.prepare(
          `UPDATE chunks
           SET text = 'replacement-chunk',
               text_hash = 'text-hash:active/reference.md:replacement'
           WHERE text = 'stale-chunk'`,
        ).run()
        return {
          vector: deterministicRepairVector(504),
          available: true,
          diagnostic: null,
        }
      },
    })

    assert.deepEqual(result, {
      processed_chunks: 0,
      vectors_indexed: 0,
      remaining_chunks: 1,
      stopped_by: "chunk_limit",
    })
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM chunk_vecs").get().count,
      0,
    )
  } finally {
    closeDb(db)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("semantic repair discards a pending vector for a concurrently replaced chunk", async () => {
  const { repairMissingVectorBatch } = await loadSemanticRepair()
  const root = await makeRoot()
  const db = openDb(root)
  const writerDb = openDb(root)
  const staleVector = deterministicRepairVector(505)
  const replacementVector = deterministicRepairVector(506)
  const nextVector = deterministicRepairVector(507)
  let nowCalls = 0
  let markEmbeddingStarted
  let resolveEmbedding
  const embeddingStarted = new Promise((resolve) => {
    markEmbeddingStarted = resolve
  })

  try {
    insertDocument(db, {
      documentPath: "active/reference.md",
      updatedAt: "2026-01-01T00:00:00.000Z",
      texts: ["stale-chunk", "next-chunk"],
    })
    const stale = db.prepare(
      `SELECT
         c.id,
         c.doc_id,
         c.chunk_index
       FROM chunks c
       WHERE c.text = 'stale-chunk'`,
    ).get()
    assert.ok(stale)

    const pendingBatch = repairMissingVectorBatch({
      db,
      deskRoot: root,
      batchChunks: 2,
      batchMs: 5000,
      now: () => {
        nowCalls += 1
        return nowCalls === 1 ? 0 : 5000
      },
      embedChunkDetailed: (text) => {
        assert.equal(text, "stale-chunk")
        markEmbeddingStarted()
        return new Promise((resolve) => {
          resolveEmbedding = resolve
        })
      },
    })
    await awaitBounded(
      embeddingStarted,
      "semantic repair stale-chunk embedding did not start",
    )

    const replaceChunk = writerDb.transaction(() => {
      writerDb.prepare("DELETE FROM chunks WHERE id = ?").run(stale.id)
      writerDb.prepare(
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
      ).run(
        stale.doc_id,
        stale.chunk_index,
        "active/reference.md:replacement",
        "text-hash:active/reference.md:replacement",
        ACTIVE_EMBEDDING_SPEC.id,
        ACTIVE_EMBEDDING_SPEC.chunker_id,
        ACTIVE_EMBEDDING_SPEC.normalization_id,
        "replacement-chunk",
      )
    })
    replaceChunk.immediate()
    const replacement = writerDb.prepare(
      "SELECT id FROM chunks WHERE text = 'replacement-chunk'",
    ).get()
    assert.ok(replacement)
    assert.notEqual(replacement.id, stale.id)

    resolveEmbedding({
      vector: staleVector,
      available: true,
      diagnostic: null,
    })
    const first = await awaitBounded(
      pendingBatch,
      "semantic repair stale-chunk batch did not settle",
    )

    assert.equal(
      db.prepare(
        "SELECT COUNT(*) AS count FROM chunk_vecs WHERE chunk_id = ?",
      ).get(BigInt(stale.id)).count,
      0,
    )
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) AS count
         FROM chunk_vecs v
         LEFT JOIN chunks c ON c.id = v.chunk_id
         WHERE c.id IS NULL`,
      ).get().count,
      0,
    )
    assert.deepEqual(first, {
      processed_chunks: 0,
      vectors_indexed: 0,
      remaining_chunks: 2,
      stopped_by: "time_limit",
    })
    assert.deepEqual(
      db.prepare(
        `SELECT c.text
         FROM chunks c
         LEFT JOIN chunk_vecs v ON v.chunk_id = c.id
         WHERE v.chunk_id IS NULL
         ORDER BY c.chunk_index`,
      ).all().map(({ text }) => text),
      ["replacement-chunk", "next-chunk"],
    )

    const resumed = []
    const second = await awaitBounded(
      repairMissingVectorBatch({
        db,
        deskRoot: root,
        batchChunks: 2,
        batchMs: 5000,
        embedChunkDetailed: async (text) => {
          resumed.push(text)
          return {
            vector: text === "replacement-chunk"
              ? replacementVector
              : nextVector,
            available: true,
            diagnostic: null,
          }
        },
      }),
      "semantic repair replacement-chunk batch did not settle",
    )

    assert.deepEqual(second, {
      processed_chunks: 2,
      vectors_indexed: 2,
      remaining_chunks: 0,
      stopped_by: "complete",
    })
    assert.deepEqual(resumed, ["replacement-chunk", "next-chunk"])
    assertStoredVector(db, "replacement-chunk", replacementVector)
    assertStoredVector(db, "next-chunk", nextVector)
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) AS count
         FROM chunk_vecs v
         LEFT JOIN chunks c ON c.id = v.chunk_id
         WHERE c.id IS NULL`,
      ).get().count,
      0,
    )
  } finally {
    resolveEmbedding?.({
      vector: staleVector,
      available: true,
      diagnostic: null,
    })
    closeDb(writerDb)
    closeDb(db)
    await fs.rm(root, { recursive: true, force: true })
  }
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
    assert.equal(
      await pendingBatch.callback(),
      undefined,
      "a late queued callback must remain inert after cancellation",
    )

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
  let nowCalls = 0
  try {
    insertDocument(db, {
      documentPath: "active/reference.md",
      updatedAt: "2026-01-01T00:00:00.000Z",
      texts: ["chunk-0", "chunk-1", "chunk-2"],
    })

    const cancelled = await awaitBounded(
      repairMissingVectorBatch({
        db,
        deskRoot: root,
        batchChunks: 100,
        batchMs: 5000,
        signal: controller.signal,
        now: () => {
          nowCalls += 1
          if (nowCalls === 2) controller.abort()
          return 0
        },
        embedChunkDetailed: async (text) => {
          embedded.push(text)
          const injectedVector = deterministicRepairVector(embedded.length)
          injectedVectors.set(text, injectedVector)
          const result = {
            vector: injectedVector,
            available: true,
            diagnostic: null,
          }
          return result
        },
      }),
      "semantic repair cancelled batch did not settle",
      { onTimeout: () => controller.abort() },
    )

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
    const resumed = await awaitBounded(
      repairMissingVectorBatch({
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
      }),
      "semantic repair resumed batch did not settle",
    )

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

test("semantic repair returns a cancelled zero-work batch for an already-aborted signal", async () => {
  const { repairMissingVectorBatch } = await loadSemanticRepair()
  const root = await makeRoot()
  const db = openDb(root)
  const controller = new AbortController()
  let embedCalls = 0
  try {
    insertDocument(db, {
      documentPath: "active/reference.md",
      updatedAt: "2026-01-01T00:00:00.000Z",
      texts: ["chunk-0"],
    })
    controller.abort()

    const result = await repairMissingVectorBatch({
      db,
      deskRoot: root,
      signal: controller.signal,
      embedChunkDetailed: async () => {
        embedCalls += 1
        return {
          vector: deterministicRepairVector(1),
          available: true,
          diagnostic: null,
        }
      },
    })

    assert.deepEqual(result, {
      processed_chunks: 0,
      vectors_indexed: 0,
      remaining_chunks: 1,
      stopped_by: "cancelled",
      cancelled: true,
    })
    assert.equal(embedCalls, 0)
  } finally {
    closeDb(db)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("semantic repair closes owned databases after zero-work success and embedding errors", async () => {
  const { repairMissingVectorBatch } = await loadSemanticRepair()
  const emptyRoot = await makeRoot("desk-semantic-repair-owned-empty-")
  const errorRoot = await makeRoot("desk-semantic-repair-owned-error-")
  const emptyDbPath = path.join(emptyRoot, "owned.sqlite")
  const errorDbPath = path.join(errorRoot, "owned.sqlite")
  const expectedError = new Error("private embedding failure")

  try {
    assert.deepEqual(
      await repairMissingVectorBatch({
        deskRoot: emptyRoot,
        dbPath: emptyDbPath,
      }),
      {
        processed_chunks: 0,
        vectors_indexed: 0,
        remaining_chunks: 0,
        stopped_by: "complete",
      },
    )
    assert.deepEqual(await fs.readdir(emptyRoot), ["owned.sqlite"])

    const seedDb = openDb(errorRoot, { dbPath: errorDbPath })
    try {
      insertDocument(seedDb, {
        documentPath: "active/reference.md",
        updatedAt: "2026-01-01T00:00:00.000Z",
        texts: ["chunk-0"],
      })
    } finally {
      closeDb(seedDb)
    }

    await assert.rejects(
      repairMissingVectorBatch({
        deskRoot: errorRoot,
        dbPath: errorDbPath,
        embedChunkDetailed: async () => {
          throw expectedError
        },
      }),
      (error) => error === expectedError,
    )
    assert.deepEqual(await fs.readdir(errorRoot), ["owned.sqlite"])
  } finally {
    await fs.rm(errorRoot, { recursive: true, force: true })
    await fs.rm(emptyRoot, { recursive: true, force: true })
  }
})

test("semantic repair treats an already-covered database as complete without embedding", async () => {
  const { repairMissingVectorBatch } = await loadSemanticRepair()
  const root = await makeRoot()
  const db = openDb(root)
  let embedCalls = 0
  try {
    insertDocument(db, {
      documentPath: "active/reference.md",
      updatedAt: "2026-01-01T00:00:00.000Z",
      texts: ["covered-chunk"],
    })
    insertStoredVector(
      db,
      "covered-chunk",
      deterministicRepairVector(601),
    )

    assert.deepEqual(
      await repairMissingVectorBatch({
        db,
        deskRoot: root,
        embedChunkDetailed: async () => {
          embedCalls += 1
          throw new Error("covered chunks must not be re-embedded")
        },
      }),
      {
        processed_chunks: 0,
        vectors_indexed: 0,
        remaining_chunks: 0,
        stopped_by: "complete",
      },
    )
    assert.equal(embedCalls, 0)
    assertStoredVector(
      db,
      "covered-chunk",
      deterministicRepairVector(601),
    )
  } finally {
    closeDb(db)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("semantic repair tombstones chunk-local failures and retries changed failure identities", async () => {
  const { repairMissingVectorBatch } = await loadSemanticRepair()
  const root = await makeRoot()
  const db = openDb(root)
  const healthyVector = deterministicRepairVector(701)
  const revisedVector = deterministicRepairVector(702)
  const oversizeDiagnostic = {
    endpoint: "http://127.0.0.1:11434/api/embeddings",
    model: "nomic-embed-text",
    reason: "http_400",
    message: "the input length exceeds the context length",
  }
  const firstSeen = []
  try {
    insertDocument(db, {
      documentPath: "active/reference.md",
      updatedAt: "2026-01-01T00:00:00.000Z",
      texts: ["oversize-chunk", "healthy-chunk"],
    })

    const first = await repairMissingVectorBatch({
      db,
      deskRoot: root,
      embedChunkDetailed: async (text) => {
        firstSeen.push(text)
        if (text === "oversize-chunk") {
          return {
            vector: null,
            available: true,
            diagnostic: oversizeDiagnostic,
          }
        }
        return {
          vector: healthyVector,
          available: true,
          diagnostic: null,
        }
      },
    })

    assert.deepEqual(firstSeen, ["oversize-chunk", "healthy-chunk"])
    assert.deepEqual(first, {
      processed_chunks: 2,
      vectors_indexed: 1,
      remaining_chunks: 0,
      stopped_by: "complete",
    })
    assertStoredVector(db, "healthy-chunk", healthyVector)
    assert.deepEqual(
      db.prepare(
        `SELECT
           chunk_key,
           text_hash,
           reason,
           message
         FROM chunk_embedding_failures`,
      ).all(),
      [{
        chunk_key: "active/reference.md:0",
        text_hash: "text-hash:active/reference.md:0",
        reason: oversizeDiagnostic.reason,
        message: oversizeDiagnostic.message,
      }],
    )

    let repeatedCalls = 0
    assert.deepEqual(
      await repairMissingVectorBatch({
        db,
        deskRoot: root,
        embedChunkDetailed: async () => {
          repeatedCalls += 1
          throw new Error("known chunk-local failures must stay tombstoned")
        },
      }),
      {
        processed_chunks: 0,
        vectors_indexed: 0,
        remaining_chunks: 0,
        stopped_by: "complete",
      },
    )
    assert.equal(repeatedCalls, 0)

    db.prepare(
      `UPDATE chunks
       SET text = 'revised-chunk',
           text_hash = 'text-hash:active/reference.md:revised'
       WHERE text = 'oversize-chunk'`,
    ).run()

    assert.deepEqual(
      await repairMissingVectorBatch({
        db,
        deskRoot: root,
        embedChunkDetailed: async (text) => {
          assert.equal(text, "revised-chunk")
          return {
            vector: revisedVector,
            available: true,
            diagnostic: null,
          }
        },
      }),
      {
        processed_chunks: 1,
        vectors_indexed: 1,
        remaining_chunks: 0,
        stopped_by: "complete",
      },
    )
    assertStoredVector(db, "revised-chunk", revisedVector)
    assert.equal(
      db.prepare(
        "SELECT COUNT(*) AS count FROM chunk_embedding_failures",
      ).get().count,
      1,
    )
  } finally {
    closeDb(db)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("semantic repair rejects service-level and malformed embedding results without tombstones", async (t) => {
  const { repairMissingVectorBatch } = await loadSemanticRepair()
  const cases = [
    {
      name: "unavailable service",
      expectedCode: "network_error",
      expectedMessage: "Ollama is unavailable",
      options: {
        embed: {
          endpoint: "http://127.0.0.1:11434/api/embeddings",
          fetch: async () => {
            throw new Error("Ollama is unavailable")
          },
        },
      },
    },
    {
      name: "wrong vector dimension",
      expectedCode: "invalid_embedding",
      expectedMessage: "expected 768 dimensions, got 1",
      options: {
        embed: {
          endpoint: "http://127.0.0.1:11434/api/embeddings",
          fetch: async () => ({
            ok: true,
            json: async () => ({ embedding: [1] }),
          }),
        },
      },
    },
    {
      name: "wrong vector shape",
      expectedCode: "invalid_embedding",
      expectedMessage: "expected 768 dimensions, got none",
      options: {
        embed: {
          endpoint: "http://127.0.0.1:11434/api/embeddings",
          fetch: async () => ({
            ok: true,
            json: async () => ({ embedding: "not-an-array" }),
          }),
        },
      },
    },
    {
      name: "missing diagnostic",
      expectedCode: "semantic_unavailable",
      expectedMessage: "semantic embedding is unavailable",
      options: {
        embedChunkDetailed: async () => ({
          vector: null,
          available: false,
          diagnostic: {},
        }),
      },
    },
  ]

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const root = await makeRoot()
      const db = openDb(root)
      try {
        insertDocument(db, {
          documentPath: "active/reference.md",
          updatedAt: "2026-01-01T00:00:00.000Z",
          texts: ["chunk-0"],
        })

        await assert.rejects(
          repairMissingVectorBatch({
            db,
            deskRoot: root,
            ...testCase.options,
          }),
          (error) => {
            assert.equal(error.code, testCase.expectedCode)
            assert.equal(error.message, testCase.expectedMessage)
            return true
          },
        )
        assert.equal(
          db.prepare("SELECT COUNT(*) AS count FROM chunk_vecs").get().count,
          0,
        )
        assert.equal(
          db.prepare(
            "SELECT COUNT(*) AS count FROM chunk_embedding_failures",
          ).get().count,
          0,
        )
      } finally {
        closeDb(db)
        await fs.rm(root, { recursive: true, force: true })
      }
    })
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

    const result = await awaitBounded(
      repairMissingVectorBatch({
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
      }),
      "semantic repair ordered batch did not settle",
    )

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

    const first = await awaitBounded(
      repairMissingVectorBatch(options),
      "semantic repair first chunk-bounded batch did not settle",
    )
    assert.equal(first.processed_chunks, 2)
    assert.equal(first.remaining_chunks, 1)
    assert.equal(first.stopped_by, "chunk_limit")

    const second = await awaitBounded(
      repairMissingVectorBatch(options),
      "semantic repair resumed chunk-bounded batch did not settle",
    )
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

    const result = await awaitBounded(
      repairMissingVectorBatch({
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
      }),
      "semantic repair time-bounded batch did not settle",
    )

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

test("semantic repair attempts one candidate when selection consumes the budget", async () => {
  const { repairMissingVectorBatch } = await loadSemanticRepair()
  const root = await makeRoot()
  const db = openDb(root)
  const seen = []
  let nowCalls = 0
  try {
    insertDocument(db, {
      documentPath: "active/reference.md",
      updatedAt: "2026-01-01T00:00:00.000Z",
      texts: ["chunk-0", "chunk-1"],
    })

    const result = await awaitBounded(
      repairMissingVectorBatch({
        db,
        deskRoot: root,
        batchChunks: 100,
        batchMs: 5,
        now: () => {
          nowCalls += 1
          return nowCalls === 1 ? 0 : 5
        },
        embedChunkDetailed: async (text) => {
          seen.push(text)
          return {
            vector: deterministicRepairVector(seen.length),
            available: true,
            diagnostic: null,
          }
        },
      }),
      "semantic repair selection-budget batch did not settle",
    )

    assert.deepEqual(seen, ["chunk-0"])
    assert.equal(result.processed_chunks, 1)
    assert.equal(result.vectors_indexed, 1)
    assert.equal(result.remaining_chunks, 1)
    assert.equal(result.stopped_by, "time_limit")
  } finally {
    closeDb(db)
    await fs.rm(root, { recursive: true, force: true })
  }
})
