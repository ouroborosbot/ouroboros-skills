// search.test.js — desk_search hybrid lexical+semantic ranking + filters.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as path from "node:path"

import { __searchInternalsForTests, desk_search } from "../../src/tools/search.js"
import { openDb, closeDb } from "../../src/db/init.js"
import {
  createMaintenanceCoordinator,
  createMaintenanceRuntimeBinding,
} from "../../src/indexer/maintenance.js"
import { ensureIndex } from "../../src/server-helpers.js"
import {
  buildFixtureIndex,
  makeEmbedFetch,
  makeFailingFetch,
  mkTempDeskRoot,
  writeFile,
} from "./_search_helpers.js"

const TEST_TIMEOUT_MS = 1500

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

// Build a fixture desk where chunks across multiple tracks share or differ
// on the first-word "family" (deterministic 768-dim vectors per
// _search_helpers.js). A query whose first letter matches a doc's first
// letter produces a strong semantic hit; mismatched produces near-zero.

async function buildBaseDesk() {
  const root = await mkTempDeskRoot()
  // Track A — alpha-family docs
  await writeFile(
    root,
    "trackA/task-1/task.md",
    "---\nstatus: processing\nschema_version: 1\ntitle: A1\n---\nalpha retry exponential backoff details\n",
  )
  await writeFile(
    root,
    "trackA/task-1/planning.md",
    "alpha retry plan body content\n",
  )
  // Track B — bravo-family docs
  await writeFile(
    root,
    "trackB/task-2/task.md",
    "---\nstatus: done\nschema_version: 1\ntitle: B1\n---\nbravo widget design notes\n",
  )
  // Track C — alpha-family but blocked status
  await writeFile(
    root,
    "trackC/task-3/task.md",
    "---\nstatus: blocked\nschema_version: 1\ntitle: C1\n---\nalpha retry insight\n",
  )
  return root
}

test("search internals cover defensive helper branches", async () => {
  const helpers = __searchInternalsForTests

  const featureRoot = await mkTempDeskRoot()
  assert.equal(await helpers.readFeaturedTrack(featureRoot), null)
  await writeFile(featureRoot, "_meta/featured.md", "# comment\n\ntrackA\n")
  assert.equal(await helpers.readFeaturedTrack(featureRoot), "trackA")
  await writeFile(featureRoot, "_meta/blank.md", "")
  const blankFeatureRoot = await mkTempDeskRoot()
  await writeFile(blankFeatureRoot, "_meta/featured.md", "# comment only\n")
  assert.equal(await helpers.readFeaturedTrack(blankFeatureRoot), null)

  assert.match(
    helpers.semanticUnavailableFields(undefined).semantic_note,
    /embedding service did not return/u,
  )
  assert.equal(helpers.semanticUnavailableFields(undefined).semantic_diagnostic, null)

  assert.deepEqual(helpers.buildFtsQuery(null), { matchExpr: null, terms: [] })
  assert.deepEqual(helpers.buildFtsQuery("a"), { matchExpr: null, terms: [] })
  assert.equal(helpers.clampLimit(Number.NaN), 10)
  assert.equal(helpers.clampLimit(999), 50)
  assert.equal(helpers.decodeEmbedding(null), null)
  assert.deepEqual(helpers.decodeEmbedding(Buffer.from([0, 0, 128, 63])), [1])

  assert.deepEqual(helpers.resolveScopeFilter("all", "active"), { sql: "", params: [] })
  assert.deepEqual(helpers.resolveScopeFilter("archived", "active"), {
    sql: " AND d.is_archived = 1",
    params: [],
  })
  assert.deepEqual(helpers.resolveScopeFilter("bogus", "active"), {
    sql: " AND d.is_archived = 0",
    params: [],
  })
  assert.deepEqual(helpers.resolveScopeFilter(undefined, "archived", "doc"), {
    sql: " AND doc.is_archived = 1",
    params: [],
  })

  assert.deepEqual(helpers.buildDocsFilter(null), { sql: "", params: [] })
  assert.deepEqual(helpers.buildDocsFilter("bad"), { sql: "", params: [] })
  assert.equal(
    helpers.buildDocsFilter({
      track: ["trackA", "trackB"],
      status: ["processing"],
      kind: ["task"],
      since: "2025-01-01",
      until: "2026-01-01",
    }).params.length,
    6,
  )
  assert.deepEqual(helpers.buildDocsFilter({ status: [""], kind: [""] }), {
    sql: "",
    params: [],
  })
  assert.deepEqual(helpers.buildDocsFilter({ track: [], since: 123, until: false }), {
    sql: "",
    params: [],
  })
  assert.deepEqual(
    helpers.buildDocsFilter({ track: "trackA", status: "processing", kind: "task" }).params,
    ["trackA", "processing", "task"],
  )
  assert.deepEqual(helpers.buildDocsFilter({ kind: "reference" }).params, ["reference"])

  assert.deepEqual(helpers.gatherFtsCandidates({}, null, "", [], 10), [])
  assert.deepEqual(helpers.gatherVecCandidates({}, null, 10), [])
  assert.equal(helpers.hydrateChunks({}, []).size, 0)

  assert.equal(helpers.makeSnippet("", ["alpha"]), "")
  const long = `${Array.from({ length: 90 }, (_, i) => `before${i}`).join(" ")} alpha ${Array.from({ length: 90 }, (_, i) => `after${i}`).join(" ")}`
  assert.match(helpers.makeSnippet(long, [""]), /\.\.\.$/u)
  assert.match(helpers.makeSnippet(long, null), /\.\.\.$/u)
  assert.match(helpers.makeSnippet(long, ["missing"]), /\.\.\.$/u)
  assert.match(helpers.makeSnippet(long, ["alpha"]), /alpha/u)

  const row = {
    track: "trackA",
    status: "processing",
    kind: "task",
    updated_at: "2025-06-01",
    is_archived: 0,
  }
  assert.equal(helpers.passesFilter(row, null), true)
  assert.equal(helpers.passesFilter(row, { track: ["trackB"] }), false)
  assert.equal(helpers.passesFilter(row, { track: ["trackA"] }), true)
  assert.equal(helpers.passesFilter(row, { track: "trackB" }), false)
  assert.equal(helpers.passesFilter(row, { track: "trackA" }), true)
  assert.equal(helpers.passesFilter(row, { status: ["done"] }), false)
  assert.equal(helpers.passesFilter(row, { status: "processing" }), true)
  assert.equal(helpers.passesFilter(row, { kind: ["planning"] }), false)
  assert.equal(helpers.passesFilter(row, { kind: "task" }), true)
  assert.equal(helpers.passesFilter({ ...row, kind: "reference" }, { kind: "reference" }), true)
  assert.equal(helpers.passesFilter({ ...row, kind: "reference" }, { kind: "other" }), false)
  assert.equal(helpers.passesFilter(row, { since: "2026-01-01" }), false)
  assert.equal(helpers.passesFilter(row, { until: "2025-01-01" }), false)
  assert.equal(helpers.passesFilter(row, { until: "2026-01-01" }), true)
  assert.equal(helpers.passesFilter({ ...row, updated_at: null }, { since: "2026-01-01" }), true)
  assert.equal(helpers.passesFilter({ ...row, updated_at: null }, { until: "2025-01-01" }), true)

  assert.equal(helpers.passesScope({ is_archived: 1 }, "all", "active"), true)
  assert.equal(helpers.passesScope({ is_archived: 1 }, "archived", "active"), true)
  assert.equal(helpers.passesScope({ is_archived: 0 }, "archived", "active"), false)
  assert.equal(helpers.passesScope({ is_archived: 0 }, "active", "all"), true)
  assert.equal(helpers.passesScope({ is_archived: 1 }, "active", "all"), false)
  assert.equal(helpers.passesScope({ is_archived: 1 }, undefined, "archived"), true)
  assert.equal(helpers.shouldReplaceBest(undefined, 1), true)
  assert.equal(helpers.shouldReplaceBest({ score: 0.5 }, 0.6), true)
  assert.equal(helpers.shouldReplaceBest({ score: 0.5 }, 0.4), false)
  assert.equal(helpers.comparableUpdatedAt({ updated_at: "2026-01-01" }), "2026-01-01")
  assert.equal(helpers.comparableUpdatedAt({ updated_at: null }), "")
  assert.equal(helpers.firstChunkText({ text: "body" }), "body")
  assert.equal(helpers.firstChunkText({ text: null }), "")

  const fakeDb = {
    prepare() {
      return {
        all() {
          return [
            { path: "trackA/bad-json/task.md", frontmatter: "{bad" },
            { path: "trackA/default-frontmatter/task.md" },
            { path: "trackA/no-history/task.md", frontmatter: "{}" },
            {
              path: "trackA/not-array/task.md",
              frontmatter: JSON.stringify({ iterations: { history: "nope" } }),
            },
            {
              path: "trackA/null-entry/task.md",
              frontmatter: JSON.stringify({ iterations: { history: [null] } }),
            },
            {
              path: "trackA/missing-outcome/task.md",
              frontmatter: JSON.stringify({
                iterations: { history: [{ path: "./repo" }] },
              }),
            },
            {
              path: "trackA/done/task.md",
              frontmatter: JSON.stringify({
                iterations: { history: [{ outcome: "done", path: "./repo" }] },
              }),
            },
            {
              path: "trackA/no-path/task.md",
              frontmatter: JSON.stringify({
                iterations: { history: [{ outcome: "in-progress", path: "" }] },
              }),
            },
            {
              path: "trackA/pinned/task.md",
              frontmatter: JSON.stringify({
                iterations: { history: [{ outcome: "in-progress", path: "./repo/iter" }] },
              }),
            },
          ]
        },
      }
    },
  }
  const prefixes = helpers.computePinPrefixes(fakeDb, "trackA")
  assert.equal(prefixes.has(path.join("trackA", "pinned", "repo", "iter")), true)
  assert.equal(helpers.computePinPrefixes(fakeDb, null).size, 0)
  assert.equal(helpers.isPinned("anything.md", new Set()), false)
  assert.equal(
    helpers.isPinned(
      path.join("trackA", "pinned", "repo", "iter", "doing.md"),
      prefixes,
    ),
    true,
  )
  assert.equal(helpers.isPinned(path.join("trackA", "pinned", "repo", "iter"), prefixes), true)
  assert.equal(helpers.isPinned("trackA/other/doing.md", prefixes), false)
})

test("desk_search — happy path returns ranked results with score_breakdown", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })

  assert.ok(Array.isArray(res.results), "results is an array")
  assert.ok(res.results.length >= 1, "at least one result")
  // Alpha-family docs should rank ahead of bravo-family.
  const top = res.results[0]
  assert.match(top.snippet.toLowerCase(), /alpha/, "top result mentions alpha")
  assert.ok(typeof top.score === "number" && top.score > 0)
  assert.ok(top.score_breakdown && typeof top.score_breakdown === "object")
  assert.ok(top.score_breakdown.semantic >= 0)
  assert.ok(top.score_breakdown.bm25 >= 0)
  assert.equal(res.semantic_unavailable, false)
  assert.ok(typeof res.latency_ms === "number")
})

test("desk_search — Ollama-down soft-fails to FTS-only with semantic_unavailable=true", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha" },
    opts: { embed: { fetch: makeFailingFetch() } },
  })

  assert.equal(res.semantic_unavailable, true, "flag set when query embed fails")
  // FTS still finds the alpha hits.
  assert.ok(res.results.length >= 1)
  // Semantic component in breakdown should be 0 (no embedding available).
  assert.equal(res.results[0].score_breakdown.semantic, 0)
})

test("desk_search — empty or missing query returns before indexing", async () => {
  const root = await mkTempDeskRoot()
  const empty = await desk_search({ deskRoot: root, input: null })
  assert.deepEqual(empty.results, [])
  assert.equal(empty.query, "")
  assert.equal(empty.semantic_unavailable, false)
})

test("desk_search — lexical no-match returns empty results with unavailable semantic note", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "zzzz-no-match" },
    opts: { embed: { fetch: makeFailingFetch() } },
  })

  assert.equal(res.search_mode, "lexical")
  assert.equal(res.semantic_unavailable, true)
  assert.deepEqual(res.results, [])
  assert.match(res.semantic_note, /Semantic search unavailable/u)
})

test("desk_search — single-character query uses semantic candidates without FTS", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "a" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })

  assert.equal(res.search_mode, "hybrid")
  assert.equal(res.semantic_unavailable, false)
  assert.ok(res.results.length >= 1)
})

test("desk_search — returns a partial result from a lexical-only index before background repair, then uses repaired vectors", async () => {
  const root = await mkTempDeskRoot()
  const repairStarted = deferred()
  const repairRelease = deferred()
  const prompts = []
  const baseFetch = makeEmbedFetch()
  const embed = {
    fetch: async (url, options) => {
      const body = JSON.parse(options?.body ?? "{}")
      prompts.push(String(body.prompt ?? ""))
      return baseFetch(url, options)
    },
  }
  let maintenanceCalls = 0
  let repairPromise = null
  const maintenance = createMaintenanceCoordinator({
    ensureIndex: async (deskRoot, ensureOptions) => {
      if (ensureOptions.skipEmbed) maintenanceCalls += 1
      return awaitBounded(
        ensureIndex(deskRoot, ensureOptions),
        "direct search freshness maintenance did not settle",
      )
    },
    openIndex: openDb,
    closeIndex: closeDb,
    createRepairCoordinator: () => ({
      start({ deskRoot, embed: repairEmbed }) {
        if (!repairPromise) {
          repairPromise = (async () => {
            repairStarted.resolve()
            await awaitBounded(
              repairRelease.promise,
              "direct search background repair was not released",
            )
            return awaitBounded(
              ensureIndex(deskRoot, {
                embed: repairEmbed,
                snapshots: false,
                vectorPacks: false,
              }),
              "direct search background repair did not settle",
            )
          })()
        }
        return repairPromise
      },
      async cancel() {
        repairRelease.resolve()
        await repairPromise
        return {
          state: "idle",
          last_error: null,
          cancelled: repairPromise !== null,
        }
      },
      status() {
        return {
          state: repairPromise === null ? "idle" : "running",
          last_error: null,
        }
      },
    }),
  })
  const runtimeContext = createMaintenanceRuntimeBinding(maintenance)

  try {
    await writeFile(
      root,
      "trackA/task-1/task.md",
      "---\nstatus: processing\nschema_version: 1\n---\nalpha semantic repair body\n",
    )
    const { rebuildIndex } = await import("../../src/indexer/index.js")
    await awaitBounded(
      rebuildIndex(root, { embed: { fetch: makeFailingFetch() } }),
      "lexical-only fixture rebuild did not settle",
    )

    const first = await awaitBounded(
      desk_search({
        deskRoot: root,
        input: { query: "alpha" },
        opts: { embed },
        runtimeContext,
      }),
      "first search did not return before background vector repair",
    )

    assert.equal(
      maintenanceCalls,
      1,
      "search must route freshness and repair through maintenance",
    )
    await awaitBounded(
      repairStarted.promise,
      "search maintenance did not separately start background repair",
    )
    assert.equal(repairRelease.settled, false)
    assert.equal(first.search_mode, "hybrid")
    assert.equal(first.semantic_unavailable, false)
    assert.ok(first.results.length >= 1)
    assert.equal(
      first.results[0].score_breakdown.semantic,
      0,
      "the first response may use lexical candidates while vectors are still missing",
    )
    assert.deepEqual(
      prompts,
      ["alpha"],
      "query embedding must still run before return",
    )
    assert.deepEqual(Object.keys(first).sort(), [
      "latency_ms",
      "query",
      "results",
      "search_mode",
      "semantic_unavailable",
    ])
    assert.deepEqual(Object.keys(first.results[0]).sort(), [
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

    repairRelease.resolve()
    await awaitBounded(
      repairPromise,
      "background vector repair did not drain",
    )

    const later = await awaitBounded(
      desk_search({
        deskRoot: root,
        input: { query: "alpha" },
        opts: { embed },
        runtimeContext,
      }),
      "later search did not use the repaired index",
    )

    assert.equal(maintenanceCalls, 2)
    assert.deepEqual(Object.keys(later).sort(), Object.keys(first).sort())
    assert.deepEqual(
      Object.keys(later.results[0]).sort(),
      Object.keys(first.results[0]).sort(),
    )
    assert.equal(later.semantic_unavailable, false)
    assert.ok(
      later.results[0].score_breakdown.semantic > 0,
      "a later search should use vectors after background repair drains",
    )
    assert.equal(
      prompts.filter((prompt) => prompt === "alpha").length,
      2,
      "each search must embed its query",
    )
    assert.ok(
      prompts.some((prompt) => prompt !== "alpha"),
      "background repair must embed the missing document chunk",
    )
  } finally {
    repairRelease.resolve()
    if (repairPromise) {
      await awaitBounded(
        repairPromise,
        "background repair did not settle during cleanup",
      ).catch(() => {})
    }
    await awaitBounded(
      fs.rm(root, { recursive: true, force: true }),
      "lexical-only search fixture cleanup timed out",
    )
  }
})

test("desk_search — default embed options use global fetch", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)
  const originalFetch = globalThis.fetch
  globalThis.fetch = makeEmbedFetch()
  try {
    const res = await desk_search({
      deskRoot: root,
      input: { query: "alpha" },
    })
    assert.equal(res.search_mode, "hybrid")
    assert.equal(res.semantic_unavailable, false)
  } finally {
    if (originalFetch === undefined) {
      delete globalThis.fetch
    } else {
      globalThis.fetch = originalFetch
    }
  }
})

test("desk_search — default active scope skips archived semantic candidates", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/active/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\nalpha active content\n",
  )
  await writeFile(
    root,
    "trackA/_archive/old/task.md",
    "---\nstatus: done\nschema_version: 1\n---\nalpha archived content\n",
  )
  await buildFixtureIndex(root)

  const active = await desk_search({
    deskRoot: root,
    input: { query: "a" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(active.results.length >= 1)
  assert.ok(active.results.every((result) => !result.path.includes("_archive")))

  const all = await desk_search({
    deskRoot: root,
    input: { query: "a", scope: "all" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(all.results.some((result) => result.path.includes("_archive")))
})

test("desk_search — track filter narrows to one track", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: { track: "trackA" } },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })

  assert.ok(res.results.length >= 1)
  for (const r of res.results) {
    assert.equal(r.track, "trackA")
  }
})

test("desk_search — invalid and empty filters behave as no-ops", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const invalid = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: "not-an-object" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(invalid.results.length >= 1)

  const emptyArrays = await desk_search({
    deskRoot: root,
    input: {
      query: "alpha",
      filters: { track: [] },
    },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(emptyArrays.results.length >= 1)
})

test("desk_search — track array filter excludes semantic candidates outside the set", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: { track: ["trackA", "trackC"] } },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })

  assert.ok(res.results.length >= 1)
  for (const r of res.results) {
    assert.ok(["trackA", "trackC"].includes(r.track))
  }
  assert.ok(!res.results.some((r) => r.track === "trackB"))
})

test("desk_search — status filter (single value)", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: { status: "processing" } },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  for (const r of res.results) {
    assert.equal(r.status, "processing")
  }
})

test("desk_search — status filter (array of values)", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: { status: ["processing", "blocked"] } },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  for (const r of res.results) {
    assert.ok(["processing", "blocked"].includes(r.status))
  }
})

test("desk_search — kind filter narrows by doc kind", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: { kind: "planning" } },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  for (const r of res.results) {
    assert.equal(r.kind, "planning")
  }
  assert.ok(res.results.length >= 1, "at least one planning doc")
})

test("desk_search — kind array filter narrows by doc kind", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: { kind: ["planning"] } },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(res.results.length >= 1)
  for (const r of res.results) {
    assert.equal(r.kind, "planning")
  }
})

test("desk_search — reference kind filter has no hidden other-kind branch", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(root, "references/alpha-guide.md", "# Alpha guide\n\nalpha reference material\n")
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: { kind: "reference" } },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })

  assert.equal(res.results.length, 1)
  assert.equal(res.results[0].kind, "reference")
  assert.equal(res.results[0].path, "references/alpha-guide.md")
})

test("desk_search — since filter excludes older docs", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/task-1/task.md",
    "---\nstatus: processing\nschema_version: 1\nupdated: 2024-01-01\n---\nalpha old content\n",
  )
  await writeFile(
    root,
    "trackA/task-2/task.md",
    "---\nstatus: processing\nschema_version: 1\nupdated: 2026-05-01\n---\nalpha new content\n",
  )
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: { since: "2025-01-01" } },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  for (const r of res.results) {
    assert.ok(
      r.updated_at >= "2025-01-01",
      `expected updated_at >= 2025-01-01, got ${r.updated_at}`,
    )
  }
})

test("desk_search — until filter excludes newer docs", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/task-1/task.md",
    "---\nstatus: processing\nschema_version: 1\nupdated: 2024-01-01\n---\nalpha old content\n",
  )
  await writeFile(
    root,
    "trackA/task-2/task.md",
    "---\nstatus: processing\nschema_version: 1\nupdated: 2026-05-01\n---\nalpha new content\n",
  )
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: { until: "2025-01-01" } },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(res.results.length >= 1)
  for (const r of res.results) {
    assert.ok(
      r.updated_at <= "2025-01-01",
      `expected updated_at <= 2025-01-01, got ${r.updated_at}`,
    )
  }
})

test("desk_search — limit is clamped to [1, 50]", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const huge = await desk_search({
    deskRoot: root,
    input: { query: "alpha", limit: 9999 },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(huge.results.length <= 50, "limit clamped to 50 max")

  const tiny = await desk_search({
    deskRoot: root,
    input: { query: "alpha", limit: 0 },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  // 0 → clamped to 1; depending on data we get 0 or 1 result, but never
  // more than 1.
  assert.ok(tiny.results.length <= 1, "limit=0 clamped to >= 1 (so <=1 result)")
})

test("desk_search — state_bias raises active-status docs above terminal-status docs", async () => {
  const root = await mkTempDeskRoot()
  // Two docs with identical text → same FTS + semantic scores. State_bias
  // is the only differentiator.
  await writeFile(
    root,
    "trackA/active/task.md",
    "---\nstatus: processing\nschema_version: 1\nupdated: 2026-05-01\n---\nalpha identical body content\n",
  )
  await writeFile(
    root,
    "trackA/finished/task.md",
    "---\nstatus: done\nschema_version: 1\nupdated: 2026-05-01\n---\nalpha identical body content\n",
  )
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(res.results.length >= 2)
  const processingResult = res.results.find((r) => r.status === "processing")
  const doneResult = res.results.find((r) => r.status === "done")
  assert.ok(processingResult, "found processing-status result")
  assert.ok(doneResult, "found done-status result")
  assert.ok(
    processingResult.score > doneResult.score,
    `expected processing(${processingResult.score}) > done(${doneResult.score})`,
  )
  // Verify the state component is what differentiates them.
  assert.ok(
    processingResult.score_breakdown.state >
      doneResult.score_breakdown.state,
  )
})

test("desk_search — empty query returns empty results", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.deepEqual(res.results, [])
})

test("desk_search — long snippets center around query terms", async () => {
  const root = await mkTempDeskRoot()
  const prefix = Array.from({ length: 90 }, (_, index) => `prefix${index}`).join(" ")
  const suffix = Array.from({ length: 90 }, (_, index) => `suffix${index}`).join(" ")
  await writeFile(
    root,
    "trackA/task-long/task.md",
    `---\nstatus: processing\nschema_version: 1\n---\n${prefix} alpha-centered ${suffix}\n`,
  )
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha-centered" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(res.results.length >= 1)
  assert.match(res.results[0].snippet, /alpha-centered/u)
  assert.match(res.results[0].snippet, /^\.\.\./u)
  assert.match(res.results[0].snippet, /\.\.\.$/u)
})

test("desk_search — long semantic-only snippets fall back when query term is absent", async () => {
  const root = await mkTempDeskRoot()
  const longBody = Array.from({ length: 120 }, (_, index) => `aardvark${index}`).join(" ")
  await writeFile(
    root,
    "trackA/task-semantic/task.md",
    `---\nstatus: processing\nschema_version: 1\n---\n${longBody}\n`,
  )
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(res.results.length >= 1)
  assert.match(res.results[0].snippet, /\.\.\.$/u)
  assert.doesNotMatch(res.results[0].snippet, /alpha/u)
})

test("desk_search — long snippets handle start and end query-term boundaries", async () => {
  const root = await mkTempDeskRoot()
  const tail = Array.from({ length: 90 }, (_, index) => `tail${index}`).join(" ")
  const head = Array.from({ length: 90 }, (_, index) => `head${index}`).join(" ")
  await writeFile(
    root,
    "trackA/task-start/task.md",
    `---\nstatus: processing\nschema_version: 1\nupdated: 2026-05-02\n---\nalpha-start ${tail}\n`,
  )
  await writeFile(
    root,
    "trackA/task-end/task.md",
    `---\nstatus: processing\nschema_version: 1\nupdated: 2026-05-01\n---\n${head} alpha-end\n`,
  )
  await buildFixtureIndex(root)

  const start = await desk_search({
    deskRoot: root,
    input: { query: "alpha-start" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.doesNotMatch(start.results[0].snippet, /^\.\.\./u)
  assert.match(start.results[0].snippet, /\.\.\.$/u)

  const end = await desk_search({
    deskRoot: root,
    input: { query: "alpha-end" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  const endResult = end.results.find((result) =>
    result.path.includes("task-end/task.md"),
  )
  assert.ok(endResult, "end-boundary result surfaced")
  assert.match(endResult.snippet, /^\.\.\./u)
  assert.doesNotMatch(endResult.snippet, /\.\.\.$/u)
})

test("desk_search — active-iteration pin adds the +0.30 bonus", async () => {
  const root = await mkTempDeskRoot()
  // Featured track + a task with an in-progress iteration whose path points
  // at a doc that should get the pin bonus.
  await writeFile(root, "_meta/featured.md", "trackP\n")
  await writeFile(
    root,
    "trackP/task-pinned/task.md",
    `---
schema_version: 1
status: processing
updated: 2026-05-01
title: P1
iterations:
  active: ./repo-x/2026-05-01-impl
  history:
    - slug: 2026-05-01-impl
      repo: repo-x
      trigger: initial-impl
      path: ./repo-x/2026-05-01-impl
      outcome: in-progress
---
alpha pinned body summary
`,
  )
  // The iteration directory has its own doing.md which should get pinned.
  await writeFile(
    root,
    "trackP/task-pinned/repo-x/2026-05-01-impl/doing.md",
    "alpha iteration body content\n",
  )
  // A control doc, same alpha text, NOT under the pinned prefix.
  await writeFile(
    root,
    "trackQ/task-other/doing.md",
    "alpha control body content\n",
  )

  await buildFixtureIndex(root)
  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })

  // The pinned doing.md should rank top — its pin breakdown should be 0.3.
  const pinned = res.results.find((r) =>
    r.path.includes("2026-05-01-impl/doing.md"),
  )
  const control = res.results.find((r) =>
    r.path.includes("trackQ/task-other/doing.md"),
  )
  assert.ok(pinned, "pinned doc surfaced in results")
  assert.ok(control, "control doc surfaced in results")
  assert.ok(
    pinned.score_breakdown.pin > 0,
    "pin component on the pinned chunk > 0",
  )
  assert.equal(control.score_breakdown.pin, 0, "control chunk not pinned")
  assert.ok(
    pinned.score > control.score,
    `pin bumps pinned (${pinned.score}) above control (${control.score})`,
  )
})

test("desk_search — ignores malformed featured task frontmatter when pinning", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(root, "_meta/featured.md", "trackP\n")
  await writeFile(
    root,
    "trackP/task-pinned/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\nalpha malformed pin body\n",
  )
  await buildFixtureIndex(root)

  const db = openDb(root)
  try {
    db.prepare("UPDATE docs SET frontmatter = ? WHERE path = ?").run(
      "{malformed-json",
      "trackP/task-pinned/task.md",
    )
  } finally {
    closeDb(db)
  }

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(res.results.length >= 1)
  assert.equal(res.results[0].score_breakdown.pin, 0)
})

test("desk_search — ignores blank featured track and no-op iteration histories", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(root, "_meta/featured.md", "# comment only\n\n")
  await writeFile(
    root,
    "trackP/no-history/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\nalpha no history\n",
  )
  await buildFixtureIndex(root)

  const blankFeatured = await desk_search({
    deskRoot: root,
    input: { query: "alpha" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(blankFeatured.results.length >= 1)
  assert.equal(blankFeatured.results[0].score_breakdown.pin, 0)

  await writeFile(root, "_meta/featured.md", "trackP\n")
  const rows = [
    ["trackP/no-history/task.md", { status: "processing" }],
    ["trackP/string-history/task.md", { iterations: { history: "nope" } }],
    ["trackP/null-entry/task.md", { iterations: { history: [null] } }],
    ["trackP/done-entry/task.md", { iterations: { history: [{ outcome: "done", path: "./repo" }] } }],
    ["trackP/bad-path/task.md", { iterations: { history: [{ outcome: "in-progress", path: "" }] } }],
  ]
  for (const [docPath] of rows.slice(1)) {
    await writeFile(root, docPath, "---\nstatus: processing\nschema_version: 1\n---\nalpha pin edge\n")
  }
  await buildFixtureIndex(root)

  const db = openDb(root)
  try {
    for (const [docPath, frontmatter] of rows) {
      db.prepare("UPDATE docs SET frontmatter = ? WHERE path = ?").run(
        JSON.stringify(frontmatter),
        docPath,
      )
    }
  } finally {
    closeDb(db)
  }

  const noPins = await desk_search({
    deskRoot: root,
    input: { query: "alpha" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(noPins.results.length >= 1)
  assert.ok(noPins.results.every((result) => result.score_breakdown.pin === 0))
})

test("desk_search — propagates unexpected featured-track read errors", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/task-1/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\nalpha body\n",
  )
  await buildFixtureIndex(root)
  await fs.mkdir(path.join(root, "_meta", "featured.md"), { recursive: true })

  await assert.rejects(
    () => desk_search({
      deskRoot: root,
      input: { query: "alpha" },
      opts: { embed: { fetch: makeEmbedFetch() } },
    }),
    /EISDIR|illegal operation/u,
  )
})
