import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"

import { TOOL_NAMES } from "../../src/tool-names.js"
import { ensureIndex } from "../../src/server-helpers.js"
import { rebuildIndex } from "../../src/indexer/index.js"
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
        "missing search/reindex maintenance integration: add src/indexer/maintenance.js and wire both tools through it",
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
  await fs.rm(root, { recursive: true, force: true })
}

test("desk_search sends skipEmbed freshness options and bypasses the old synchronous repair path", async () => {
  const root = await mkTempDeskRoot()
  const maintenanceCalls = []
  const prompts = []
  const embed = { fetch: recordingEmbedFetch(prompts) }
  const maintenance = {
    async ensureSearchFreshness(options) {
      maintenanceCalls.push(options)
      return {
        index: completeIndexResult({ chunks: 1, vectors: 0 }),
        repair: Promise.resolve({ state: "complete", last_error: null }),
      }
    },
  }

  try {
    await writeFile(
      root,
      "trackA/task-1/task.md",
      "---\nstatus: processing\nschema_version: 1\n---\nalpha document body requiring repair\n",
    )
    await rebuildIndex(root, { skipEmbed: true })

    const result = await desk_search({
      deskRoot: root,
      input: { query: "alpha" },
      opts: { embed, maintenance },
    })

    assert.ok(result.results.length >= 1)
    assert.deepEqual(
      {
        maintenance_calls: maintenanceCalls.map((call) => ({
          deskRoot: call.deskRoot,
          embed_is_forwarded: call.ensureOptions?.embed === embed,
          ensure_option_keys: Object.keys(call.ensureOptions ?? {}).sort(),
          skipEmbed: call.ensureOptions?.skipEmbed,
        })),
        prompt_kinds_before_return: prompts.map((prompt) =>
          prompt === "alpha" ? "query" : "old-synchronous-document-repair",
        ),
      },
      {
        maintenance_calls: [
          {
            deskRoot: root,
            embed_is_forwarded: true,
            ensure_option_keys: ["embed", "skipEmbed"],
            skipEmbed: true,
          },
        ],
        prompt_kinds_before_return: ["query"],
      },
      "desk_search must run freshness through maintenance with skipEmbed:true and must not enter the legacy synchronous missing-vector repair before returning",
    )
  } finally {
    await cleanupRoot(root)
  }
})

test("desk_search returns existing-vector hybrid results before gated background repair completes", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = await mkTempDeskRoot()
  const repairEntered = deferred()
  const repairRelease = deferred()
  const prompts = []
  const embed = { fetch: recordingEmbedFetch(prompts) }
  let maintenance

  try {
    await writeFile(
      root,
      "trackA/existing/task.md",
      "---\nstatus: processing\nschema_version: 1\n---\nalpha existing vector content\n",
    )
    await buildFixtureIndex(root)
    await writeFile(
      root,
      "trackB/new/task.md",
      "---\nstatus: processing\nschema_version: 1\n---\nzulu gated background repair content\n",
    )

    const repairCalls = []
    maintenance = createMaintenanceCoordinator({
      ensureIndex,
      repairBatch: async (options) => {
        repairCalls.push(options)
        repairEntered.resolve()
        await repairRelease.promise
        return {
          processed_chunks: 1,
          vectors_indexed: 1,
          remaining_chunks: 0,
          stopped_by: "complete",
        }
      },
    })

    const search = desk_search({
      deskRoot: root,
      input: { query: "alpha" },
      opts: { embed, maintenance },
    })

    await awaitBounded(
      repairEntered.promise,
      "background repair was not scheduled after search freshness",
    )
    const result = await awaitBounded(
      search,
      "desk_search still awaited gated document-vector repair instead of returning existing-vector results",
    )

    assert.equal(repairRelease.settled, false)
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
  } finally {
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

test("shared maintenance prevents SQLITE_BUSY overlap from leaking to search or reindex callers", async () => {
  const { createMaintenanceCoordinator } = await loadMaintenance()
  const root = await mkTempDeskRoot()
  const backgroundEntered = deferred()
  const activeByRoot = new Map()
  const events = []
  const ensureCalls = []
  const repairCalls = []
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
        input: {},
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
    assert.deepEqual(events, [
      "search-freshness:start",
      "search-freshness:end",
      "background-repair:start",
      "background-repair:end",
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
