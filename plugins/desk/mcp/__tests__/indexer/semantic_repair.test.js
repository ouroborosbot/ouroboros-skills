import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { closeDb, openDb } from "../../src/db/init.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"

const semanticRepairModuleUrl = new URL(
  "../../src/indexer/semantic-repair.js",
  import.meta.url,
)

async function loadSemanticRepair() {
  return import(semanticRepairModuleUrl.href)
}

function vector(seed = 1) {
  return Array.from(
    { length: ACTIVE_EMBEDDING_SPEC.dimension },
    (_, index) => ((seed + index) % 23) / 23,
  )
}

async function makeRoot(prefix = "desk-semantic-repair-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
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
  const drain = async () => {
    while (queued.length > 0) {
      await runNext()
    }
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
  assert.equal((await first).state, "complete")

  const next = coordinator.start({
    deskRoot: "/tmp/desk-root-a",
    batchChunks: 100,
    batchMs: 5000,
  })
  assert.notStrictEqual(next, first)
  assert.equal(scheduler.queued.length, 1)
  await scheduler.drain()
  assert.equal((await next).state, "complete")
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
  await started
  try {
    const second = coordinator.start({ deskRoot: `${root}${path.sep}.` })
    assert.strictEqual(second, first)
    assert.equal(calls, 1)
    assert.equal(scheduler.scheduled.length, 1)
    assert.equal(scheduler.queued.length, 0)
  } finally {
    releaseBatch({ processed_chunks: 1, remaining_chunks: 0 })
    await activeBatch
  }

  assert.equal((await first).state, "complete")
  assert.equal(calls, 1)
  assert.equal(scheduler.scheduled.length, 1)
})

test("semantic repair runs different roots independently", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const scheduler = createManualScheduler()
  const started = []
  const gates = new Map()
  const coordinator = createSemanticRepairCoordinator({
    repairBatch: ({ deskRoot, batchChunks, batchMs }) => new Promise((resolve) => {
      started.push({ deskRoot, batchChunks, batchMs })
      gates.set(deskRoot, resolve)
    }),
    schedule: scheduler.schedule,
    clearScheduled: scheduler.clearScheduled,
  })
  const rootA = path.resolve("/tmp/desk-root-a")
  const rootB = path.resolve("/tmp/desk-root-b")

  const repairA = coordinator.start({ deskRoot: rootA })
  const repairB = coordinator.start({ deskRoot: rootB })
  assert.notStrictEqual(repairA, repairB)
  const batchA = scheduler.runNext()
  const batchB = scheduler.runNext()
  await Promise.resolve()

  assert.deepEqual(started, [
    { deskRoot: rootA, batchChunks: 100, batchMs: 5000 },
    { deskRoot: rootB, batchChunks: 100, batchMs: 5000 },
  ])
  gates.get(rootA)({ processed_chunks: 1, remaining_chunks: 0 })
  gates.get(rootB)({ processed_chunks: 1, remaining_chunks: 0 })
  await Promise.all([batchA, batchB])
  assert.equal((await repairA).state, "complete")
  assert.equal((await repairB).state, "complete")
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
  assert.equal((await repair).state, "complete")
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
    const result = await repair
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
    assert.equal((await retry).state, "complete")
    assert.deepEqual(calls, [root, root])
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})

test("semantic repair cancellation aborts the active batch and permits a later retry", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const scheduler = createManualScheduler()
  let calls = 0
  let abortCleanupFinished = false
  let activeBatchSettled = false
  let batchStarted
  const started = new Promise((resolve) => {
    batchStarted = resolve
  })
  const coordinator = createSemanticRepairCoordinator({
    repairBatch: ({ signal }) => {
      calls += 1
      if (calls > 1) {
        return Promise.resolve({ processed_chunks: 1, remaining_chunks: 0 })
      }
      return new Promise((resolve) => {
        batchStarted()
        signal.addEventListener(
          "abort",
          () => {
            setImmediate(() => {
              abortCleanupFinished = true
              resolve({
                processed_chunks: 0,
                remaining_chunks: 1,
                cancelled: true,
              })
            })
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
  await started
  const cancelled = await coordinator.cancel(root)
  assert.equal(abortCleanupFinished, true)
  assert.equal(activeBatchSettled, true)
  assert.equal(cancelled.cancelled, true)
  assert.equal(scheduler.queued.length, 0)
  assert.equal(scheduler.scheduled.length, 1)
  await activeBatch
  assert.equal((await first).state, "idle")
  assert.equal(coordinator.status(root).state, "idle")

  const retry = coordinator.start({ deskRoot: root })
  assert.notStrictEqual(retry, first)
  await scheduler.drain()
  assert.equal((await retry).state, "complete")
  assert.equal(calls, 2)
})

test("semantic repair cancellation clears a pending batch without running repair work", async () => {
  const { createSemanticRepairCoordinator } = await loadSemanticRepair()
  const scheduler = createManualScheduler()
  let calls = 0
  const coordinator = createSemanticRepairCoordinator({
    repairBatch: async () => {
      calls += 1
      return { processed_chunks: 1, remaining_chunks: 0 }
    },
    schedule: scheduler.schedule,
    clearScheduled: scheduler.clearScheduled,
  })
  const root = path.resolve("/tmp/desk-root")

  const repair = coordinator.start({ deskRoot: root })
  const pendingBatch = scheduler.queued[0]
  assert.ok(pendingBatch)
  assert.equal(scheduler.scheduled.length, 1)

  const cancelled = await coordinator.cancel(root)
  assert.equal(cancelled.cancelled, true)
  assert.equal(pendingBatch.handle.cancelled, true)
  assert.deepEqual(scheduler.cleared, [pendingBatch.handle])
  assert.equal((await repair).state, "idle")
  assert.equal(coordinator.status(root).state, "idle")

  await scheduler.drain()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 0)
  assert.equal(scheduler.queued.length, 0)
  assert.equal(scheduler.scheduled.length, 1)
})

test("a new coordinator resumes persisted missing work after process interruption", async () => {
  const {
    createSemanticRepairCoordinator,
    repairMissingVectorBatch,
  } = await loadSemanticRepair()
  const root = await makeRoot()
  const interruptedScheduler = createManualScheduler()
  const resumedScheduler = createManualScheduler()
  const embeddedTexts = []
  const embedChunkDetailed = async (text) => {
    embeddedTexts.push(text)
    return {
      vector: vector(embeddedTexts.length),
      available: true,
      diagnostic: null,
    }
  }
  let interruptedDb = openDb(root)
  let resumedDb
  let interrupted
  let abandoned
  try {
    insertDocument(interruptedDb, {
      documentPath: "active/reference.md",
      updatedAt: "2026-01-01T00:00:00.000Z",
      texts: ["chunk-0", "chunk-1", "chunk-2"],
    })
    interrupted = createSemanticRepairCoordinator({
      repairBatch: (options) => repairMissingVectorBatch({
        ...options,
        db: interruptedDb,
        embedChunkDetailed,
      }),
      schedule: interruptedScheduler.schedule,
      clearScheduled: interruptedScheduler.clearScheduled,
    })

    abandoned = interrupted.start({
      deskRoot: root,
      batchChunks: 1,
      batchMs: 5000,
    })
    await interruptedScheduler.runNext()

    assert.equal(
      interruptedDb.prepare("SELECT COUNT(*) AS count FROM chunk_vecs").get().count,
      1,
    )
    assert.deepEqual(embeddedTexts, ["chunk-0"])
    assert.equal(interruptedScheduler.queued.length, 1)
    assert.equal(interruptedScheduler.scheduled.length, 2)
    assert.equal(interruptedScheduler.queued[0].delay, 0)
    assert.equal(interruptedScheduler.queued[0].handle.unrefCalls, 1)

    closeDb(interruptedDb)
    resumedDb = openDb(root)
    const resumed = createSemanticRepairCoordinator({
      repairBatch: (options) => repairMissingVectorBatch({
        ...options,
        db: resumedDb,
        embedChunkDetailed,
      }),
      schedule: resumedScheduler.schedule,
      clearScheduled: resumedScheduler.clearScheduled,
    })
    const resumedRepair = resumed.start({
      deskRoot: root,
      batchChunks: 1,
      batchMs: 5000,
    })
    await resumedScheduler.drain()

    assert.equal((await resumedRepair).state, "complete")
    assert.equal(
      resumedDb.prepare("SELECT COUNT(*) AS count FROM chunk_vecs").get().count,
      3,
    )
    assert.equal(
      resumedDb.prepare(
        `SELECT COUNT(*) AS count
         FROM chunks c
         LEFT JOIN chunk_vecs v ON v.chunk_id = c.id
         WHERE v.chunk_id IS NULL`,
      ).get().count,
      0,
    )
    assert.deepEqual(embeddedTexts, ["chunk-0", "chunk-1", "chunk-2"])

    const cancelled = await interrupted.cancel(root)
    await interruptedScheduler.drain()
    assert.equal(cancelled.cancelled, true)
    assert.equal((await abandoned).state, "idle")
    interrupted = null
  } finally {
    if (interrupted !== null && interrupted !== undefined) {
      await interrupted.cancel(root)
      await interruptedScheduler.drain()
    }
    closeDb(interruptedDb)
    closeDb(resumedDb)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("semantic repair batch prioritizes active recent documents, chunk ordinal, and path", async () => {
  const { repairMissingVectorBatch } = await loadSemanticRepair()
  const root = await makeRoot()
  const db = openDb(root)
  const seen = []
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
        return { vector: vector(seen.length), available: true, diagnostic: null }
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
        return { vector: vector(seen.length), available: true, diagnostic: null }
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
        return { vector: vector(seen.length), available: true, diagnostic: null }
      },
    })

    assert.deepEqual(seen, ["chunk-0", "chunk-1"])
    assert.equal(result.processed_chunks, 2)
    assert.equal(result.remaining_chunks, 1)
    assert.equal(result.stopped_by, "time_limit")
  } finally {
    closeDb(db)
    await fs.rm(root, { recursive: true, force: true })
  }
})
