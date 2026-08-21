import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"

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

test("desk_search awaits gated skipEmbed freshness, then returns query results before gated repair completes", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = await mkTempDeskRoot()
  const freshnessEntered = deferred()
  const freshnessRelease = deferred()
  const repairEntered = deferred()
  const repairRelease = deferred()
  const repairCompleted = deferred()
  const prompts = []
  const embed = { fetch: recordingEmbedFetch(prompts) }
  const ensureCalls = []
  const repairCalls = []
  let maintenance

  try {
    await writeFile(
      root,
      "trackA/existing/task.md",
      "---\nstatus: processing\nschema_version: 1\n---\nalpha existing vector content\n",
    )
    await buildFixtureIndex(root)

    maintenance = createMaintenanceCoordinator({
      ensureIndex: async (deskRoot, options) => {
        ensureCalls.push({ deskRoot, options })
        freshnessEntered.resolve()
        await freshnessRelease.promise
        return completeIndexResult({ chunks: 2, vectors: 1 })
      },
      repairBatch: async (options) => {
        repairCalls.push(options)
        repairEntered.resolve()
        await repairRelease.promise
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
            await active
            return { state: "idle", last_error: null, cancelled: true }
          },
          status() {
            return { state: active ? "running" : "idle", last_error: null }
          },
        }
      },
    })

    const search = desk_search({
      deskRoot: root,
      input: { query: "alpha" },
      opts: { embed, maintenance },
    })
    const observedSearch = observeSettlement(search)

    await awaitBounded(
      freshnessEntered.promise,
      "desk_search did not enter synchronous skipEmbed freshness",
    )
    assert.equal(observedSearch.state, "pending")
    assert.equal(repairEntered.settled, false)
    assert.deepEqual(prompts, [])
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
      repairEntered.promise,
      "background repair was not scheduled after freshness completed",
    )
    const result = await awaitBounded(
      search,
      "desk_search did not settle after freshness while background repair remained gated",
    )

    assert.equal(repairRelease.settled, false)
    assert.equal(observedSearch.state, "fulfilled")
    assert.equal(result.search_mode, "hybrid")
    const existing = result.results.find(
      (entry) => entry.path === "trackA/existing/task.md",
    )
    assert.ok(existing, "search must retain the result backed by an existing vector")
    assert.ok(
      existing.score_breakdown.semantic > 0,
      "existing vectors must remain usable while missing vectors repair",
    )
    assert.deepEqual(prompts, ["alpha"])
    assert.equal(repairCalls.length, 1)
    assert.equal(repairCalls[0].deskRoot, path.resolve(root))
    assert.equal(repairCalls[0].embed, embed)
    assert.equal(repairCalls[0].signal instanceof AbortSignal, true)
    repairRelease.resolve()
    await awaitBounded(
      repairCompleted.promise,
      "background repair did not drain after release",
    )
  } finally {
    freshnessRelease.resolve()
    repairRelease.resolve()
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
          await firstFreshnessRelease.promise
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

    const first = desk_search({
      deskRoot: root,
      input: { query: "alpha" },
      opts: { embed },
    })
    await awaitBounded(
      firstFreshnessEntered.promise,
      "first default-wired search did not enter the installed coordinator",
    )

    const second = desk_search({
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
          await new Promise((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener("abort", resolve, { once: true })
          })
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

    const searchResult = await awaitBounded(
      desk_search({
        deskRoot: root,
        input: { query: "alpha" },
        opts: { embed: searchEmbed, maintenance },
      }),
      "search caller did not return while background repair remained active",
    )
    await awaitBounded(
      backgroundEntered.promise,
      "search did not launch the fake background writer",
    )
    const reindexResult = await awaitBounded(
      desk_reindex({
        deskRoot: root,
        input: { force: true },
        opts: { embed: reindexEmbed, maintenance },
      }),
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

    const search = await desk_search({
      deskRoot: root,
      input: { query: "alpha" },
      opts: { embed: { fetch: makeEmbedFetch() }, maintenance },
    })
    const reindex = await desk_reindex({
      deskRoot: root,
      input: {},
      opts: {
        maintenance,
        skipEmbed: true,
        snapshots: false,
        vectorPacks: false,
      },
    })

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
