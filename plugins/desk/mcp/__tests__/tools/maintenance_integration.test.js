import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"

import { closeDb, openDb } from "../../src/db/init.js"
import { createSemanticRepairCoordinator } from "../../src/indexer/semantic-repair.js"
import { ensureIndex } from "../../src/server-helpers.js"
import { TOOL_NAMES } from "../../src/tool-names.js"
import { desk_reindex } from "../../src/tools/reindex.js"
import { desk_search } from "../../src/tools/search.js"
import {
  buildFixtureIndex,
  makeEmbedFetch,
  mkTempDeskRoot,
  topicVector,
  writeFile,
} from "./_search_helpers.js"

const maintenanceModuleUrl = new URL(
  "../../src/indexer/maintenance.js",
  import.meta.url,
)
const TEST_TIMEOUT_MS = 1500
const EXPECTED_TOOL_NAMES = [
  "desk_doctor",
  "desk_recall",
  "desk_reindex",
  "desk_search",
  "desk_similar",
  "desk_status",
  "desk_thread",
  "desk_timeline",
  "friction_add",
  "lesson_add",
  "task_archive",
  "task_create",
  "task_update",
  "track_create",
  "track_update",
]

async function loadMaintenance() {
  try {
    return await import(maintenanceModuleUrl.href)
  } catch (error) {
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      String(error.message).includes("maintenance.js")
    ) {
      assert.fail(
        "missing search/reindex maintenance integration: add src/indexer/maintenance.js with createMaintenanceCoordinator(), shared default wiring, and __setMaintenanceCoordinatorForTests()",
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

function recordingEmbedFetch(prompts) {
  return async (_url, options) => {
    const body = JSON.parse(options?.body ?? "{}")
    const prompt = String(body.prompt ?? "")
    prompts.push(prompt)
    return {
      ok: true,
      json: async () => ({ embedding: topicVector(prompt) }),
    }
  }
}

function recordingFixedEmbedFetch(calls, vector) {
  return async (url, options) => {
    const body = JSON.parse(options?.body ?? "{}")
    calls.push({
      url: String(url),
      method: options?.method,
      contentType: options?.headers?.["content-type"],
      body,
      hasAbortSignal: options?.signal instanceof AbortSignal,
    })
    return {
      ok: true,
      json: async () => ({ embedding: vector }),
    }
  }
}

function completeIndexResult({
  built = false,
  reason = "fresh",
  chunks = 1,
  vectors = chunks,
} = {}) {
  return {
    built,
    reason,
    semantic: {
      chunks_total: chunks,
      vectors_indexed: vectors,
      missing_vectors: Math.max(0, chunks - vectors),
      embedding_available: true,
    },
  }
}

async function cleanupRoot(root) {
  await awaitBounded(
    fs.rm(root, { recursive: true, force: true }),
    `cleanup timed out for ${root}`,
  )
}

function findFtsRow(root, token) {
  const db = openDb(root)
  try {
    return db
      .prepare(
        `SELECT d.path, c.text
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         JOIN docs d ON d.id = c.doc_id
         WHERE chunks_fts MATCH ?
         LIMIT 1`,
      )
      .get(`"${token}"`)
  } finally {
    closeDb(db)
  }
}

function seedStoredVector(root, documentPath, vector) {
  const db = openDb(root)
  try {
    const chunks = db
      .prepare(
        `SELECT c.id
         FROM chunks c
         JOIN docs d ON d.id = c.doc_id
         WHERE d.path = ?
         ORDER BY c.chunk_index`,
      )
      .all(documentPath)
    assert.equal(
      chunks.length,
      1,
      `expected exactly one deterministic chunk for ${documentPath}`,
    )
    const chunkId = BigInt(chunks[0].id)
    db.prepare("DELETE FROM chunk_vecs WHERE chunk_id = ?").run(chunkId)
    db.prepare(
      "INSERT INTO chunk_vecs (chunk_id, embedding) VALUES (?, ?)",
    ).run(chunkId, new Float32Array(vector))
  } finally {
    closeDb(db)
  }
}

function readDocumentVectorCoverage(root, documentPaths) {
  const db = openDb(root)
  try {
    const placeholders = documentPaths.map(() => "?").join(", ")
    return db
      .prepare(
        `SELECT d.path,
                COUNT(c.id) AS chunks,
                COUNT(v.chunk_id) AS vectors
         FROM docs d
         JOIN chunks c ON c.doc_id = d.id
         LEFT JOIN chunk_vecs v ON v.chunk_id = c.id
         WHERE d.path IN (${placeholders})
         GROUP BY d.path
         ORDER BY d.path`,
      )
      .all(...documentPaths)
  } finally {
    closeDb(db)
  }
}

test("desk_search returns fresh lexical and retained semantic hits before gated repair completes", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = await mkTempDeskRoot()
  const freshnessEntered = deferred()
  const freshnessRelease = deferred()
  const freshnessIndexed = deferred()
  const repairEntered = deferred()
  const repairRelease = deferred()
  const repairCompleted = deferred()
  const queryToken = "unit4dfreshnessneedle"
  const freshPath = "trackA/fresh/task.md"
  const existingPath = "trackA/existing/task.md"
  const existingText = "alpha existing vector content"
  const queryVector = topicVector("zulu deterministic semantic bridge")
  const queryEmbeddingCalls = []
  const events = []
  const embed = {
    endpoint: "http://127.0.0.1:43123/api/embeddings",
    model: "unit4d-query-model",
    fetch: recordingFixedEmbedFetch(queryEmbeddingCalls, queryVector),
  }
  const ensureCalls = []
  const repairCalls = []
  let maintenance
  let search

  try {
    assert.doesNotMatch(existingText, new RegExp(queryToken, "u"))
    await writeFile(
      root,
      existingPath,
      `---\nstatus: processing\nschema_version: 1\n---\n${existingText}\n`,
    )
    await buildFixtureIndex(root)
    seedStoredVector(root, existingPath, queryVector)
    assert.deepEqual(
      readDocumentVectorCoverage(root, [existingPath]),
      [{ path: existingPath, chunks: 1, vectors: 1 }],
    )

    maintenance = createMaintenanceCoordinator({
      ensureIndex: async (deskRoot, options) => {
        ensureCalls.push({ deskRoot, options })
        events.push("freshness:start")
        freshnessEntered.resolve()
        await awaitBounded(
          freshnessRelease.promise,
          "controlled freshness was not released",
        )
        await writeFile(
          deskRoot,
          freshPath,
          `---\nstatus: processing\nschema_version: 1\n---\n${queryToken} content created during freshness\n`,
        )
        const result = await awaitBounded(
          ensureIndex(deskRoot, {
            ...options,
            skipEmbed: true,
            snapshots: false,
            vectorPacks: false,
          }),
          "controlled freshness did not index the newly written document",
        )
        const indexed = findFtsRow(deskRoot, queryToken)
        assert.equal(indexed?.path, freshPath)
        assert.match(indexed?.text ?? "", new RegExp(queryToken, "u"))
        assert.deepEqual(
          readDocumentVectorCoverage(deskRoot, [existingPath, freshPath]),
          [
            { path: existingPath, chunks: 1, vectors: 1 },
            { path: freshPath, chunks: 1, vectors: 0 },
          ],
          "freshness must preserve the existing vector while adding one vectorless lexical chunk",
        )
        events.push("freshness:indexed")
        freshnessIndexed.resolve()
        return result
      },
      repairBatch: async (options) => {
        repairCalls.push(options)
        events.push("repair:start")
        repairEntered.resolve()
        await awaitBounded(
          repairRelease.promise,
          "controlled background repair was not released",
        )
        events.push("repair:end")
        repairCompleted.resolve()
        return {
          processed_chunks: 1,
          vectors_indexed: 1,
          remaining_chunks: 0,
          stopped_by: "complete",
        }
      },
      createRepairCoordinator: ({ repairBatch }) => {
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
          async cancel() {
            controller?.abort()
            await awaitBounded(
              active,
              "controlled background repair did not settle after cancellation",
            )
            return { state: "idle", last_error: null, cancelled: true }
          },
          status() {
            return { state: active ? "running" : "idle", last_error: null }
          },
        }
      },
    })

    search = desk_search({
      deskRoot: root,
      input: { query: queryToken },
      opts: { embed, maintenance },
    })
    const observedSearch = observeSettlement(search)

    await awaitBounded(
      freshnessEntered.promise,
      "desk_search did not enter synchronous skipEmbed freshness",
    )
    assert.equal(observedSearch.state, "pending")
    assert.equal(repairEntered.settled, false)
    assert.deepEqual(queryEmbeddingCalls, [])
    assert.equal(findFtsRow(root, queryToken), undefined)
    assert.equal(ensureCalls.length, 1)
    assert.equal(ensureCalls[0].deskRoot, path.resolve(root))
    assert.equal(ensureCalls[0].options.embed, embed)
    assert.deepEqual(
      Object.keys(ensureCalls[0].options).sort(),
      ["embed", "skipEmbed"],
    )
    assert.equal(ensureCalls[0].options.skipEmbed, true)

    freshnessRelease.resolve()
    await awaitBounded(
      freshnessIndexed.promise,
      "freshness did not create the new document, chunk, and FTS row",
    )
    await awaitBounded(
      repairEntered.promise,
      "background repair was not scheduled after freshness completed",
    )
    const result = await awaitBounded(
      search,
      "desk_search did not settle after freshness while background repair remained gated",
    )

    assert.equal(repairRelease.settled, false)
    assert.equal(repairCompleted.settled, false)
    assert.equal(observedSearch.state, "fulfilled")
    assert.equal(result.search_mode, "hybrid")
    assert.equal(result.query, queryToken)
    assert.deepEqual(
      result.results.map((entry) => entry.path).sort(),
      [existingPath, freshPath].sort(),
      "the first response must union lexical candidates with KNN candidates under partial vector coverage",
    )
    const fresh = result.results.find(
      (entry) => entry.path === freshPath,
    )
    const existing = result.results.find(
      (entry) => entry.path === existingPath,
    )
    assert.ok(
      fresh,
      "the first response must query after freshness and include the newly indexed document",
    )
    assert.ok(
      existing,
      "the first response must retain the lexically nonmatching existing vector candidate",
    )
    assert.match(fresh.snippet, new RegExp(queryToken, "u"))
    assert.equal(
      fresh.score_breakdown.semantic,
      0,
      "the new chunk must still be missing its vector while repair is gated",
    )
    assert.doesNotMatch(existing.snippet, new RegExp(queryToken, "u"))
    assert.equal(
      existing.score_breakdown.bm25,
      0,
      "the existing vector hit must not enter through lexical matching",
    )
    assert.ok(
      existing.score_breakdown.semantic > 0,
      "the retained vector hit must carry a positive semantic ranking signal",
    )
    assert.ok(existing.score > 0)
    assert.deepEqual(queryEmbeddingCalls, [
      {
        url: embed.endpoint,
        method: "POST",
        contentType: "application/json",
        body: {
          model: embed.model,
          prompt: queryToken,
        },
        hasAbortSignal: true,
      },
    ])
    assert.equal(repairCalls.length, 1)
    assert.equal(repairCalls[0].deskRoot, path.resolve(root))
    assert.equal(repairCalls[0].embed, embed)
    assert.equal(repairCalls[0].signal instanceof AbortSignal, true)
    events.push("search:return")
    assert.deepEqual(events, [
      "freshness:start",
      "freshness:indexed",
      "repair:start",
      "search:return",
    ])
    repairRelease.resolve()
    await awaitBounded(
      repairCompleted.promise,
      "background repair did not drain after release",
    )
    assert.deepEqual(events, [
      "freshness:start",
      "freshness:indexed",
      "repair:start",
      "search:return",
      "repair:end",
    ])
  } finally {
    freshnessRelease.resolve()
    repairRelease.resolve()
    await awaitBounded(
      Promise.allSettled([search].filter(Boolean)),
      "gated freshness search did not settle during cleanup",
    ).catch(() => {})
    if (maintenance) {
      await awaitBounded(
        maintenance.cancelBackgroundRepair(root),
        "background repair did not settle during test cleanup",
      )
    }
    await cleanupRoot(root)
  }
})

test("default-wired same-root searches share one replaceable coordinator and root lock", async () => {
  const maintenanceModule = await loadMaintenance()
  const {
    __setMaintenanceCoordinatorForTests,
    createMaintenanceCoordinator,
  } = maintenanceModule
  assert.equal(
    typeof __setMaintenanceCoordinatorForTests,
    "function",
    "Unit 4e must expose internal __setMaintenanceCoordinatorForTests(coordinator), returning a restore callback, so default wiring can be tested without changing the MCP schema",
  )

  const root = await mkTempDeskRoot()
  const firstFreshnessEntered = deferred()
  const firstFreshnessRelease = deferred()
  const ensureCalls = []
  const prompts = []
  const embed = { fetch: recordingEmbedFetch(prompts) }
  let maintenance
  let restoreDefault
  let first
  let second

  try {
    await writeFile(
      root,
      "trackA/task-1/task.md",
      "---\nstatus: processing\nschema_version: 1\n---\nalpha shared coordinator body\n",
    )
    await buildFixtureIndex(root)

    maintenance = createMaintenanceCoordinator({
      ensureIndex: async (deskRoot, options) => {
        ensureCalls.push({ deskRoot, options })
        if (ensureCalls.length === 1) {
          firstFreshnessEntered.resolve()
          await awaitBounded(
            firstFreshnessRelease.promise,
            "first default-wired freshness was not released",
          )
        }
        return completeIndexResult()
      },
      repairBatch: async () => {
        assert.fail("complete semantic coverage must not schedule repair")
      },
    })
    restoreDefault = __setMaintenanceCoordinatorForTests(maintenance)
    assert.equal(
      typeof restoreDefault,
      "function",
      "the internal default-coordinator seam must return a restore callback",
    )

    first = desk_search({
      deskRoot: root,
      input: { query: "alpha" },
      opts: { embed },
    })
    await awaitBounded(
      firstFreshnessEntered.promise,
      "first default-wired search did not enter the installed coordinator",
    )

    second = desk_search({
      deskRoot: root,
      input: { query: "alpha" },
      opts: { embed },
    })
    const observedSecond = observeSettlement(second)
    await flushAsyncWork(
      "default-wiring overlap check did not reach a deterministic turn",
    )

    assert.equal(
      ensureCalls.length,
      1,
      "two default-wired same-root searches must share one coordinator lock instead of instantiating isolated maintenance",
    )
    assert.equal(observedSecond.state, "pending")

    firstFreshnessRelease.resolve()
    const [firstResult, secondResult] = await awaitBounded(
      Promise.all([first, second]),
      "default-wired same-root searches did not drain through their shared lock",
    )

    assert.equal(ensureCalls.length, 2)
    for (const call of ensureCalls) {
      assert.equal(call.deskRoot, path.resolve(root))
      assert.equal(call.options.embed, embed)
      assert.equal(call.options.skipEmbed, true)
      assert.equal("maintenance" in call.options, false)
    }
    assert.equal(firstResult.search_mode, "hybrid")
    assert.equal(secondResult.search_mode, "hybrid")
    assert.deepEqual(prompts, ["alpha", "alpha"])
  } finally {
    firstFreshnessRelease.resolve()
    await awaitBounded(
      Promise.allSettled([first, second].filter(Boolean)),
      "default-wired searches did not settle during cleanup",
    ).catch(() => {})
    if (restoreDefault) restoreDefault()
    if (maintenance) {
      await awaitBounded(
        maintenance.cancelBackgroundRepair(root),
        "default coordinator did not settle during cleanup",
      )
    }
    await cleanupRoot(root)
  }
})

test("default-wired desk_reindex coordinates exact non-force and force requests without legacy direct maintenance", async () => {
  const {
    __setMaintenanceCoordinatorForTests,
  } = await loadMaintenance()
  const root = await mkTempDeskRoot()
  const dbPath = path.join(root, ".state", "desk-index.sqlite")
  const walPath = `${dbPath}-wal`
  const shmPath = `${dbPath}-shm`
  const sentinels = new Map([
    [dbPath, "poison legacy ensure path"],
    [walPath, "poison legacy force wal reset"],
    [shmPath, "poison legacy force shm reset"],
  ])
  const embed = { fetch: makeEmbedFetch() }
  const ensureOptions = {
    embed,
    marker: "default-shared-reindex",
    snapshots: false,
    vectorPacks: false,
  }
  const calls = []
  const maintenance = {
    async runExplicitReindex(args) {
      calls.push(args)
      if (args.force) {
        return {
          built: true,
          reason: "missing",
          summary: {
            docs_indexed: 4,
            docs_skipped: 1,
            docs_removed: 2,
          },
          semantic: {
            chunks_total: 5,
            vectors_indexed: 5,
            missing_vectors: 0,
            embedding_available: true,
          },
        }
      }
      return completeIndexResult({ chunks: 3, vectors: 3 })
    },
  }
  let restoreDefault

  try {
    await fs.mkdir(path.dirname(dbPath), { recursive: true })
    await Promise.all(
      [...sentinels].map(([filePath, body]) =>
        fs.writeFile(filePath, body, "utf8"),
      ),
    )
    restoreDefault = __setMaintenanceCoordinatorForTests(maintenance)

    const nonForce = await awaitBounded(
      desk_reindex({
        deskRoot: root,
        input: { force: false },
        opts: ensureOptions,
      }),
      "default-wired non-force reindex did not use the shared coordinator",
    )
    const force = await awaitBounded(
      desk_reindex({
        deskRoot: root,
        input: { force: true },
        opts: ensureOptions,
      }),
      "default-wired force reindex did not use the shared coordinator",
    )

    assert.deepEqual(calls, [
      {
        deskRoot: path.resolve(root),
        force: false,
        ensureOptions,
      },
      {
        deskRoot: path.resolve(root),
        force: true,
        ensureOptions,
      },
    ])
    assert.deepEqual(Object.keys(calls[0]).sort(), [
      "deskRoot",
      "ensureOptions",
      "force",
    ])
    assert.deepEqual(Object.keys(calls[1]).sort(), [
      "deskRoot",
      "ensureOptions",
      "force",
    ])
    assert.equal("maintenance" in ensureOptions, false)
    assert.equal(nonForce.built, false)
    assert.equal(nonForce.reason, "fresh")
    assert.equal(nonForce.chunks_total, 3)
    assert.equal(force.built, true)
    assert.equal(force.reason, "missing")
    assert.equal(force.docs_indexed, 4)
    assert.equal(force.docs_skipped, 1)
    assert.equal(force.docs_pruned, 2)
    assert.equal(force.chunks_total, 5)
    for (const [filePath, body] of sentinels) {
      assert.equal(
        await fs.readFile(filePath, "utf8"),
        body,
        `legacy direct ensure/reset path touched ${path.basename(filePath)}`,
      )
    }
  } finally {
    if (restoreDefault) restoreDefault()
    await cleanupRoot(root)
  }
})

test("non-force desk_reindex cancels active repair before one locked full repair and releases the root", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = await mkTempDeskRoot()
  const scheduler = createManualScheduler()
  const backgroundEntered = deferred()
  const backgroundAborted = deferred()
  const backgroundCleanupRelease = deferred()
  const fullRepairEntered = deferred()
  const fullRepairRelease = deferred()
  const competingFreshnessEntered = deferred()
  const activeByRoot = new Map()
  const events = []
  const ensureCalls = []
  const repairCalls = []
  const resetCalls = []
  const cancelCalls = []
  const explicitCalls = []
  const initialEmbed = { fetch: makeEmbedFetch() }
  const explicitEmbed = { fetch: makeEmbedFetch() }
  const competingEmbed = { fetch: makeEmbedFetch() }
  const explicitEnsureOptions = {
    embed: explicitEmbed,
    marker: "non-force-real-coordinator",
    snapshots: false,
    vectorPacks: false,
  }
  let busyThrows = 0
  let maxSameRootWriters = 0
  let coordinator
  let maintenance
  let initialFreshness
  let initialResult
  let scheduledRepair
  let reindex
  let competingFreshness
  let competingResult

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
    coordinator = createMaintenanceCoordinator({
      ensureIndex: async (deskRoot, options) => {
        ensureCalls.push({ deskRoot, options })
        if (options.embed === initialEmbed) {
          return guardedWriter(deskRoot, "initial-freshness", async () =>
            completeIndexResult({ chunks: 2, vectors: 1 }),
          )
        }
        if (options.embed === explicitEmbed) {
          return guardedWriter(deskRoot, "nonforce-reindex", async () => {
            fullRepairEntered.resolve()
            await awaitBounded(
              fullRepairRelease.promise,
              "non-force full repair was not released",
            )
            return {
              built: true,
              reason: "semantic_missing",
              summary: {
                docs_indexed: 2,
                docs_skipped: 1,
                docs_removed: 0,
              },
              semantic: {
                chunks_total: 3,
                vectors_indexed: 3,
                missing_vectors: 0,
                embedding_available: true,
              },
            }
          })
        }
        assert.equal(options.embed, competingEmbed)
        return guardedWriter(deskRoot, "competing-freshness", async () => {
          competingFreshnessEntered.resolve()
          return completeIndexResult({ chunks: 3, vectors: 3 })
        })
      },
      repairBatch: async (options) => {
        repairCalls.push(options)
        return guardedWriter(options.deskRoot, "background-repair", async () => {
          backgroundEntered.resolve()
          await awaitBounded(
            new Promise((resolve) => {
              const onAbort = () => {
                events.push("background-repair:abort")
                backgroundAborted.resolve()
                resolve()
              }
              if (options.signal.aborted) onAbort()
              else options.signal.addEventListener("abort", onAbort, { once: true })
            }),
            "background repair did not observe non-force reindex cancellation",
          )
          await awaitBounded(
            backgroundCleanupRelease.promise,
            "background repair cleanup was not released",
          )
          events.push("background-repair:cleanup")
          return {
            processed_chunks: 0,
            vectors_indexed: 0,
            remaining_chunks: 1,
            stopped_by: "cancelled",
            cancelled: true,
          }
        })
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
            cancelCalls.push(deskRoot)
            events.push("cancel:start")
            const result = await repair.cancel(deskRoot)
            events.push("cancel:done")
            return result
          },
        }
      },
      resetIndex: async (options) => {
        resetCalls.push(options)
        return guardedWriter(options.deskRoot, "unexpected-reset", async () => {})
      },
    })
    maintenance = {
      ...coordinator,
      async runExplicitReindex(args) {
        explicitCalls.push(args)
        return coordinator.runExplicitReindex(args)
      },
    }

    initialFreshness = coordinator.ensureSearchFreshness({
      deskRoot: root,
      ensureOptions: { embed: initialEmbed },
    })
    initialResult = await awaitBounded(
      initialFreshness,
      "initial freshness did not settle before active repair",
    )
    assert.equal(scheduler.size, 1)
    scheduledRepair = scheduler.runNext()
    await awaitBounded(
      backgroundEntered.promise,
      "background repair did not enter through the maintenance coordinator",
    )

    reindex = desk_reindex({
      deskRoot: root,
      input: { force: false },
      opts: { ...explicitEnsureOptions, maintenance },
    })
    const observedReindex = observeSettlement(reindex)
    await awaitBounded(
      backgroundAborted.promise,
      "non-force desk_reindex did not cancel the active background repair",
    )
    await flushAsyncWork(
      "non-force cancellation order check did not reach a deterministic turn",
    )

    assert.equal(observedReindex.state, "pending")
    assert.equal(fullRepairEntered.settled, false)
    assert.deepEqual(resetCalls, [])
    assert.deepEqual(events, [
      "initial-freshness:start",
      "initial-freshness:end",
      "background-repair:start",
      "cancel:start",
      "background-repair:abort",
    ])

    backgroundCleanupRelease.resolve()
    await awaitBounded(
      fullRepairEntered.promise,
      "non-force full repair did not start after abort cleanup",
    )
    assert.deepEqual(events, [
      "initial-freshness:start",
      "initial-freshness:end",
      "background-repair:start",
      "cancel:start",
      "background-repair:abort",
      "background-repair:cleanup",
      "background-repair:end",
      "cancel:done",
      "nonforce-reindex:start",
    ])
    assert.deepEqual(resetCalls, [])
    assert.equal(observedReindex.state, "pending")

    competingFreshness = coordinator.ensureSearchFreshness({
      deskRoot: root,
      ensureOptions: { embed: competingEmbed, marker: "after-non-force" },
    })
    const observedCompetingFreshness = observeSettlement(competingFreshness)
    await flushAsyncWork(
      "non-force lock-release check did not reach a deterministic turn",
    )
    assert.equal(observedCompetingFreshness.state, "pending")
    assert.equal(competingFreshnessEntered.settled, false)
    assert.equal(busyThrows, 0)
    assert.equal(maxSameRootWriters, 1)

    fullRepairRelease.resolve()
    const reindexResult = await awaitBounded(
      reindex,
      "non-force desk_reindex did not await the complete full repair",
    )
    await awaitBounded(
      competingFreshnessEntered.promise,
      "same-root freshness did not enter after non-force reindex released the lock",
    )
    competingResult = await awaitBounded(
      competingFreshness,
      "same-root freshness did not settle after non-force reindex",
    )
    await awaitBounded(
      competingResult.repair,
      "post-reindex no-op repair promise did not settle",
    )
    await awaitBounded(
      scheduledRepair,
      "cancelled scheduled repair run did not settle",
    )
    await awaitBounded(
      initialResult.repair,
      "cancelled background repair promise did not settle",
    )

    assert.deepEqual(explicitCalls, [
      {
        deskRoot: path.resolve(root),
        force: false,
        ensureOptions: explicitEnsureOptions,
      },
    ])
    assert.deepEqual(cancelCalls, [path.resolve(root)])
    assert.deepEqual(resetCalls, [])
    assert.deepEqual(ensureCalls, [
      {
        deskRoot: path.resolve(root),
        options: { embed: initialEmbed, skipEmbed: true },
      },
      {
        deskRoot: path.resolve(root),
        options: explicitEnsureOptions,
      },
      {
        deskRoot: path.resolve(root),
        options: {
          embed: competingEmbed,
          marker: "after-non-force",
          skipEmbed: true,
        },
      },
    ])
    assert.equal(repairCalls.length, 1)
    assert.deepEqual(Object.keys(repairCalls[0]).sort(), [
      "batchChunks",
      "batchMs",
      "deskRoot",
      "embed",
      "signal",
    ])
    assert.equal(repairCalls[0].deskRoot, path.resolve(root))
    assert.equal(repairCalls[0].embed, initialEmbed)
    assert.equal(repairCalls[0].signal instanceof AbortSignal, true)
    assert.equal(repairCalls[0].signal.aborted, true)
    assert.equal(reindexResult.status, "ok")
    assert.equal(reindexResult.built, true)
    assert.equal(reindexResult.reason, "semantic_missing")
    assert.equal(reindexResult.docs_indexed, 2)
    assert.equal(reindexResult.docs_skipped, 1)
    assert.equal(reindexResult.docs_pruned, 0)
    assert.equal(reindexResult.chunks_total, 3)
    assert.equal(reindexResult.vectors_indexed, 3)
    assert.equal(reindexResult.missing_vectors, 0)
    assert.equal(busyThrows, 0)
    assert.equal(maxSameRootWriters, 1)
    assert.equal(activeByRoot.size, 0)
    assert.equal(scheduler.size, 0)
    assert.deepEqual(events, [
      "initial-freshness:start",
      "initial-freshness:end",
      "background-repair:start",
      "cancel:start",
      "background-repair:abort",
      "background-repair:cleanup",
      "background-repair:end",
      "cancel:done",
      "nonforce-reindex:start",
      "nonforce-reindex:end",
      "competing-freshness:start",
      "competing-freshness:end",
    ])
  } finally {
    backgroundCleanupRelease.resolve()
    fullRepairRelease.resolve()
    if (coordinator) {
      await awaitBounded(
        coordinator.cancelBackgroundRepair(root),
        "non-force maintenance did not settle during cleanup",
      ).catch(() => {})
    }
    await awaitBounded(
      Promise.allSettled(
        [
          initialFreshness,
          initialResult?.repair,
          scheduledRepair,
          reindex,
          competingFreshness,
          competingResult?.repair,
        ].filter(Boolean),
      ),
      "non-force integration promises did not settle during cleanup",
    ).catch(() => {})
    await cleanupRoot(root)
  }
})

test("shared maintenance prevents SQLITE_BUSY overlap from leaking to search or force-reindex callers", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = await mkTempDeskRoot()
  const backgroundEntered = deferred()
  const activeByRoot = new Map()
  const events = []
  const ensureCalls = []
  const repairCalls = []
  const resetCalls = []
  let busyThrows = 0
  let maxSameRootWriters = 0
  let maintenance
  let searchPromise
  let reindexPromise

  async function fakeWriter(deskRoot, label, operation) {
    const canonical = path.resolve(deskRoot)
    const active = activeByRoot.get(canonical) ?? 0
    if (active > 0) {
      busyThrows += 1
      const error = new Error(`SQLITE_BUSY overlap at ${label}`)
      error.code = "SQLITE_BUSY"
      throw error
    }
    activeByRoot.set(canonical, active + 1)
    maxSameRootWriters = Math.max(maxSameRootWriters, active + 1)
    events.push(`${label}:start`)
    try {
      return await operation()
    } finally {
      events.push(`${label}:end`)
      activeByRoot.delete(canonical)
    }
  }

  try {
    await writeFile(
      root,
      "trackA/task-1/task.md",
      "---\nstatus: processing\nschema_version: 1\n---\nalpha indexed body\n",
    )
    await buildFixtureIndex(root)

    const searchEmbed = { fetch: makeEmbedFetch() }
    const reindexEmbed = { fetch: makeEmbedFetch() }
    maintenance = createMaintenanceCoordinator({
      ensureIndex: async (deskRoot, options) => {
        ensureCalls.push({ deskRoot, options })
        return fakeWriter(
          deskRoot,
          options.skipEmbed ? "search-freshness" : "explicit-reindex",
          async () =>
            completeIndexResult({
              built: !options.skipEmbed,
              reason: options.skipEmbed ? "fresh" : "semantic_missing",
              chunks: options.skipEmbed ? 2 : 1,
              vectors: 1,
            }),
        )
      },
      repairBatch: async (options) => {
        repairCalls.push(options)
        const { deskRoot, signal } = options
        return fakeWriter(deskRoot, "background-repair", async () => {
          backgroundEntered.resolve()
          await awaitBounded(
            new Promise((resolve) => {
              if (signal.aborted) resolve()
              else signal.addEventListener("abort", resolve, { once: true })
            }),
            "background repair did not observe explicit-reindex cancellation",
          )
          return {
            processed_chunks: 0,
            vectors_indexed: 0,
            remaining_chunks: 1,
            stopped_by: "cancelled",
            cancelled: true,
          }
        })
      },
      resetIndex: async (options) => {
        resetCalls.push(options)
        return fakeWriter(options.deskRoot, "explicit-reset", async () => {})
      },
    })

    searchPromise = desk_search({
      deskRoot: root,
      input: { query: "alpha" },
      opts: { embed: searchEmbed, maintenance },
    })
    const searchResult = await awaitBounded(
      searchPromise,
      "search caller did not return while background repair remained active",
    )
    await awaitBounded(
      backgroundEntered.promise,
      "search did not launch the fake background writer",
    )
    reindexPromise = desk_reindex({
      deskRoot: root,
      input: { force: true },
      opts: { embed: reindexEmbed, maintenance },
    })
    const reindexResult = await awaitBounded(
      reindexPromise,
      "reindex caller leaked SQLITE_BUSY or failed to await background cleanup",
    )

    assert.equal(searchResult.search_mode, "hybrid")
    assert.equal(reindexResult.status, "ok")
    assert.equal(busyThrows, 0)
    assert.equal(maxSameRootWriters, 1)
    assert.equal(ensureCalls.length, 2)
    assert.equal(ensureCalls[0].deskRoot, path.resolve(root))
    assert.equal(ensureCalls[0].options.embed, searchEmbed)
    assert.equal(ensureCalls[0].options.skipEmbed, true)
    assert.equal("maintenance" in ensureCalls[0].options, false)
    assert.equal(ensureCalls[1].deskRoot, path.resolve(root))
    assert.equal(ensureCalls[1].options.embed, reindexEmbed)
    assert.equal("skipEmbed" in ensureCalls[1].options, false)
    assert.equal("maintenance" in ensureCalls[1].options, false)
    assert.equal(repairCalls.length, 1)
    assert.equal(repairCalls[0].deskRoot, path.resolve(root))
    assert.equal(repairCalls[0].embed, searchEmbed)
    assert.deepEqual(resetCalls, [{ deskRoot: path.resolve(root) }])
    assert.deepEqual(events, [
      "search-freshness:start",
      "search-freshness:end",
      "background-repair:start",
      "background-repair:end",
      "explicit-reset:start",
      "explicit-reset:end",
      "explicit-reindex:start",
      "explicit-reindex:end",
    ])
  } finally {
    if (maintenance) {
      await awaitBounded(
        maintenance.cancelBackgroundRepair(root),
        "maintenance did not settle during SQLITE_BUSY test cleanup",
      )
    }
    await awaitBounded(
      Promise.allSettled(
        [searchPromise, reindexPromise].filter(Boolean),
      ),
      "SQLITE_BUSY integration promises did not settle during cleanup",
    ).catch(() => {})
    await cleanupRoot(root)
  }
})

test("maintenance integration preserves the exact 15 tools and current search/reindex result schemas", async () => {
  const root = await mkTempDeskRoot()
  const maintenance = {
    async ensureSearchFreshness() {
      return {
        index: completeIndexResult(),
        repair: Promise.resolve({ state: "complete", last_error: null }),
      }
    },
    async runExplicitReindex() {
      return completeIndexResult()
    },
  }

  try {
    await writeFile(
      root,
      "trackA/task-1/task.md",
      "---\nstatus: processing\nschema_version: 1\n---\nalpha schema body\n",
    )
    await buildFixtureIndex(root)

    const search = await awaitBounded(
      desk_search({
        deskRoot: root,
        input: { query: "alpha" },
        opts: { embed: { fetch: makeEmbedFetch() }, maintenance },
      }),
      "schema search did not settle through maintenance",
    )
    const reindex = await awaitBounded(
      desk_reindex({
        deskRoot: root,
        input: {},
        opts: {
          maintenance,
          skipEmbed: true,
          snapshots: false,
          vectorPacks: false,
        },
      }),
      "schema reindex did not settle through maintenance",
    )

    assert.deepEqual([...TOOL_NAMES].sort(), EXPECTED_TOOL_NAMES)
    assert.deepEqual(Object.keys(search).sort(), [
      "latency_ms",
      "query",
      "results",
      "search_mode",
      "semantic_unavailable",
    ])
    assert.ok(search.results.length >= 1)
    assert.deepEqual(Object.keys(search.results[0]).sort(), [
      "kind",
      "path",
      "score",
      "score_breakdown",
      "snippet",
      "status",
      "task_slug",
      "track",
      "updated_at",
    ])
    assert.deepEqual(Object.keys(search.results[0].score_breakdown).sort(), [
      "bm25",
      "pin",
      "recency",
      "semantic",
      "state",
    ])
    assert.deepEqual(Object.keys(reindex).sort(), [
      "built",
      "chunks_total",
      "docs_indexed",
      "docs_pruned",
      "docs_skipped",
      "missing_vectors",
      "ms",
      "reason",
      "semantic_available",
      "semantic_diagnostic",
      "status",
      "vectors_indexed",
    ])
  } finally {
    await cleanupRoot(root)
  }
})
