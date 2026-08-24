import { test } from "node:test"
import { strict as assert } from "node:assert"
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import * as path from "node:path"

import { closeDb, indexDbPath, openDb, setMeta } from "../../src/db/init.js"
import {
  createMaintenanceCoordinator,
  createMaintenanceRuntimeBinding,
} from "../../src/indexer/maintenance.js"
import { getSemanticCoverage } from "../../src/server-helpers.js"
import { callTool } from "../../src/server.js"
import { desk_search } from "../../src/tools/search.js"
import { createModeledCaseCollisionRootIdentity } from "../fixtures/root_identity_fixture.js"
import {
  buildFixtureIndex,
  mkTempDeskRoot,
  topicVector,
  writeFile,
} from "./_search_helpers.js"

const SEMANTIC_REPAIR_COMMAND =
  "Start Ollama, pull nomic-embed-text, then run desk_reindex; no force is required after v1.2.2 because missing vectors are repaired automatically."
const DOCUMENT_VECTOR_KEYS = [
  "chunks_total",
  "coverage",
  "known_unembeddable_vectors",
  "missing_vectors",
  "repairable_missing_vectors",
  "state",
  "vectors_indexed",
]
const REPAIR_STATUS_KEYS = ["last_error", "state"]
const HYBRID_LEGACY_KEYS = [
  "latency_ms",
  "query",
  "results",
  "search_mode",
  "semantic_unavailable",
]
const LEXICAL_LEGACY_KEYS = [
  ...HYBRID_LEGACY_KEYS,
  "semantic_diagnostic",
  "semantic_note",
  "semantic_repair",
].sort()
const SEARCH_RESULT_KEYS = [
  "kind",
  "path",
  "score",
  "score_breakdown",
  "snippet",
  "status",
  "task_slug",
  "track",
  "updated_at",
]
const STATUS_LEGACY_KEYS = [
  "activation",
  "active_embedding_spec",
  "db_schema",
  "degraded_modes",
  "document_vectors",
  "lexical_index",
  "local_db",
  "query_embedding",
  "root",
  "runtime",
  "snapshots",
  "startup_fallback",
  "status",
  "summary",
  "vector_packs",
  "write_scope",
]
const LOCAL_DB_KEYS = ["exists", "freshness", "path", "schema", "state"]
const SEARCH_VECTOR_STATES = new Set(["missing", "partial", "available"])
const REPAIR_STATES = new Set(["idle", "running", "complete", "failed"])

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createRuntimeHarness({
  initialRepairStatus = { state: "idle", last_error: null },
  startRepairStatus = initialRepairStatus,
  indexRoot,
  openIndex = openDb,
  closeIndex = closeDb,
  resolveIdentity,
  validateIdentity,
  statusForRoot,
} = {}) {
  const calls = {
    cancel: [],
    ensure: [],
    start: [],
    status: [],
  }
  let repairStatus = clone(initialRepairStatus)
  const neverSettles = new Promise(() => {})
  const maintenance = createMaintenanceCoordinator({
    async ensureIndex(deskRoot, ensureOptions, rootIdentity) {
      calls.ensure.push({
        deskRoot,
        rootIdentity,
        skipEmbed: ensureOptions.skipEmbed,
        embed: ensureOptions.embed,
      })
      const db = openDb(indexRoot ?? deskRoot)
      try {
        return {
          built: false,
          reason: "fresh",
          semantic: getSemanticCoverage(db),
        }
      } finally {
        closeIndex(db)
      }
    },
    openIndex,
    closeIndex,
    resolveIdentity,
    validateIdentity,
    createRepairCoordinator: () => ({
      start(options) {
        calls.start.push(options)
        repairStatus = clone(startRepairStatus)
        return neverSettles
      },
      async cancel(deskRootOrIdentity) {
        calls.cancel.push(deskRootOrIdentity)
        repairStatus = { state: "idle", last_error: null }
        return { ...repairStatus, cancelled: false }
      },
      status(deskRootOrIdentity) {
        calls.status.push(deskRootOrIdentity)
        return clone(
          statusForRoot === undefined
            ? repairStatus
            : statusForRoot(deskRootOrIdentity),
        )
      },
    }),
  })
  return {
    calls,
    runtimeContext: createMaintenanceRuntimeBinding(maintenance),
  }
}

function recordingEmbedFetch(calls, { fail = false } = {}) {
  return async (url, options) => {
    const body = JSON.parse(options?.body ?? "{}")
    calls.push({
      url: String(url),
      method: options?.method,
      contentType: options?.headers?.["content-type"],
      body,
      hasAbortSignal: options?.signal instanceof AbortSignal,
    })
    if (fail) {
      const error = new Error("embedding endpoint unavailable")
      error.code = "ECONNREFUSED"
      throw error
    }
    return {
      ok: true,
      json: async () => ({ embedding: topicVector(body.prompt) }),
    }
  }
}

function assertEmbeddingRequest(calls, prompt) {
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    url: "http://127.0.0.1:11434/api/embeddings",
    method: "POST",
    contentType: "application/json",
    body: {
      model: "nomic-embed-text",
      prompt,
    },
    hasAbortSignal: true,
  })
}

function assertFreshnessInput(calls, root, embed) {
  const canonicalRoot = realpathSync(root)
  assert.equal(calls.ensure.length, 1)
  assert.equal(calls.ensure[0].deskRoot, canonicalRoot)
  assert.equal(calls.ensure[0].rootIdentity.path, path.resolve(root))
  assert.equal(calls.ensure[0].rootIdentity.key, canonicalRoot)
  assert.equal(calls.ensure[0].skipEmbed, true)
  assert.strictEqual(calls.ensure[0].embed, embed)
}

function assertRepairStatusInput(calls, root, {
  canonicalRoot = root === undefined ? undefined : realpathSync(root),
  retainedIdentity,
} = {}) {
  assert.ok(calls.status.length >= 1, "repair status dependency was not queried")
  for (const input of calls.status) {
    if (canonicalRoot === undefined) {
      assert.equal(input, undefined)
      continue
    }
    const actualRoot = typeof input === "string" ? input : input?.key
    assert.equal(actualRoot, canonicalRoot)
    if (retainedIdentity !== undefined) {
      assert.ok(
        input === retainedIdentity || input === retainedIdentity.key,
        "repair status must receive the retained root identity or its canonical key",
      )
    }
  }
}

function assertSearchContract(result, {
  legacyKeys,
  documentVectors,
  repairStatus,
}) {
  const {
    document_vectors: actualDocumentVectors,
    semantic_repair_status: actualRepairStatus,
    ...legacy
  } = result
  assert.deepEqual(Object.keys(legacy).sort(), [...legacyKeys].sort())
  assert.deepEqual(Object.keys(result.results[0]).sort(), SEARCH_RESULT_KEYS)
  assert.deepEqual(actualDocumentVectors, documentVectors)
  assert.deepEqual(Object.keys(actualDocumentVectors).sort(), DOCUMENT_VECTOR_KEYS)
  assert.ok(
    SEARCH_VECTOR_STATES.has(actualDocumentVectors.state),
    `unexpected search vector state: ${actualDocumentVectors.state}`,
  )
  assert.deepEqual(Object.keys(actualRepairStatus).sort(), REPAIR_STATUS_KEYS)
  assert.deepEqual(actualRepairStatus, repairStatus)
  assert.ok(
    REPAIR_STATES.has(actualRepairStatus.state),
    `unexpected semantic repair state: ${actualRepairStatus.state}`,
  )
}

async function buildSearchRoot({
  chunksTotal,
  vectorsIndexed,
  knownUnembeddableVectors = 0,
}) {
  const root = await mkTempDeskRoot()
  for (let index = 0; index < chunksTotal; index += 1) {
    await writeFile(
      root,
      `trackA/task-${index}/task.md`,
      `---\nstatus: processing\nschema_version: 1\n---\nalpha contract document ${index}\n`,
    )
  }
  await buildFixtureIndex(root)

  const db = openDb(root)
  try {
    const chunks = db.prepare(
      `SELECT
         id,
         chunk_key,
         text_hash,
         embedding_spec_id,
         chunker_id,
         normalization_id
       FROM chunks
       ORDER BY id`,
    ).all()
    assert.equal(chunks.length, chunksTotal, "fixture must create one chunk per document")
    for (const chunk of chunks.slice(vectorsIndexed)) {
      db.prepare("DELETE FROM chunk_vecs WHERE chunk_id = ?").run(BigInt(chunk.id))
    }
    for (const chunk of chunks.slice(vectorsIndexed, vectorsIndexed + knownUnembeddableVectors)) {
      db.prepare(
        `INSERT INTO chunk_embedding_failures (
           chunk_key,
           text_hash,
           embedding_spec_id,
           chunker_id,
           normalization_id,
           reason,
           message,
           failed_at
         )
         VALUES (?, ?, ?, ?, ?, 'input_too_large', 'document chunk is not embeddable',
                 '2026-08-24T00:00:00.000Z')`,
      ).run(
        chunk.chunk_key,
        chunk.text_hash,
        chunk.embedding_spec_id,
        chunk.chunker_id,
        chunk.normalization_id,
      )
    }
    assert.deepEqual(getSemanticCoverage(db), {
      chunks_total: chunksTotal,
      vectors_indexed: vectorsIndexed,
      missing_vectors: chunksTotal - vectorsIndexed,
      known_unembeddable_vectors: knownUnembeddableVectors,
      repairable_missing_vectors:
        chunksTotal - vectorsIndexed - knownUnembeddableVectors,
    })
  } finally {
    closeDb(db)
  }
  return root
}

function parseToolResult(response) {
  assert.equal(response.isError, undefined, response.content?.[0]?.text)
  return JSON.parse(response.content[0].text)
}

test("Unit 5a search preserves the hybrid legacy projection and adds complete-vector idle status", async () => {
  const root = await buildSearchRoot({ chunksTotal: 1, vectorsIndexed: 1 })
  const harness = createRuntimeHarness()
  const embedCalls = []
  const embed = {
    endpoint: "http://127.0.0.1:11434",
    fetch: recordingEmbedFetch(embedCalls),
  }
  try {
    const result = await desk_search({
      deskRoot: root,
      input: { query: "alpha" },
      opts: { embed },
      runtimeContext: harness.runtimeContext,
    })

    assert.equal(result.search_mode, "hybrid")
    assert.equal(result.semantic_unavailable, false)
    assert.equal(result.semantic_repair, undefined)
    assertFreshnessInput(harness.calls, root, embed)
    assertEmbeddingRequest(embedCalls, "alpha")
    assert.equal(harness.calls.start.length, 0)
    assertSearchContract(result, {
      legacyKeys: HYBRID_LEGACY_KEYS,
      documentVectors: {
        state: "available",
        chunks_total: 1,
        vectors_indexed: 1,
        missing_vectors: 0,
        known_unembeddable_vectors: 0,
        repairable_missing_vectors: 0,
        coverage: 1,
      },
      repairStatus: { state: "idle", last_error: null },
    })
    assertRepairStatusInput(harness.calls, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Unit 5a search pins repair status to the retained root when its caller alias retargets", async () => {
  const fixture = createModeledCaseCollisionRootIdentity()
  const dataRoot = await buildSearchRoot({ chunksTotal: 1, vectorsIndexed: 1 })
  const openTargets = []
  const embedCalls = []
  const embed = {
    endpoint: "http://127.0.0.1:11434",
    fetch: recordingEmbedFetch(embedCalls),
  }
  const rootAStatus = {
    state: "failed",
    last_error: {
      reason: "semantic_repair_failed",
      message: "root A repair failed",
      path: "root-a-private-marker",
    },
  }
  const rootBStatus = {
    state: "complete",
    last_error: null,
  }
  let aliasRetargeted = false
  const harness = createRuntimeHarness({
    indexRoot: dataRoot,
    resolveIdentity: fixture.resolveIdentity,
    validateIdentity: fixture.validateIdentity,
    openIndex(deskRoot) {
      openTargets.push(deskRoot)
      fixture.retargetAlias(fixture.rootB)
      aliasRetargeted = true
      return openDb(dataRoot)
    },
    statusForRoot(deskRootOrIdentity) {
      assert.equal(
        aliasRetargeted,
        true,
        "repair status must be projected after the controlled read/open retarget",
      )
      const requestedRoot = typeof deskRootOrIdentity === "string"
        ? deskRootOrIdentity
        : deskRootOrIdentity?.key ?? deskRootOrIdentity?.path
      const canonicalRoot =
        requestedRoot === fixture.rootA || requestedRoot === fixture.rootB
          ? requestedRoot
          : fixture.nativeRealpath(requestedRoot)
      if (canonicalRoot === fixture.rootA) return rootAStatus
      if (canonicalRoot === fixture.rootB) return rootBStatus
      throw new Error(`unexpected repair status root: ${canonicalRoot}`)
    },
  })

  try {
    const result = await desk_search({
      deskRoot: fixture.aliasA,
      input: { query: "alpha" },
      opts: { embed },
      runtimeContext: harness.runtimeContext,
    })
    const retainedIdentity = harness.calls.ensure[0]?.rootIdentity
    const expectedRepairStatus = {
      state: "failed",
      last_error: {
        reason: "semantic_repair_failed",
        message: "root A repair failed",
      },
    }

    assert.equal(result.search_mode, "hybrid")
    assert.equal(result.semantic_unavailable, false)
    assert.equal(result.semantic_repair, undefined)
    assert.equal(result.query, "alpha")
    assert.equal(result.results.length, 1)
    assertEmbeddingRequest(embedCalls, "alpha")
    assert.equal(harness.calls.ensure.length, 1)
    assert.equal(harness.calls.ensure[0].deskRoot, fixture.rootA)
    assert.equal(retainedIdentity.path, path.resolve(fixture.aliasA))
    assert.equal(retainedIdentity.key, fixture.rootA)
    assert.equal(harness.calls.ensure[0].skipEmbed, true)
    assert.strictEqual(harness.calls.ensure[0].embed, embed)
    assert.deepEqual(openTargets, [fixture.rootA])
    assert.equal(harness.calls.start.length, 0)
    assert.deepEqual(result.semantic_repair_status, expectedRepairStatus)
    assert.notDeepEqual(result.semantic_repair_status, rootBStatus)
    assert.equal(
      JSON.stringify(result.semantic_repair_status).includes(
        "root-a-private-marker",
      ),
      false,
    )
    assertSearchContract(result, {
      legacyKeys: HYBRID_LEGACY_KEYS,
      documentVectors: {
        state: "available",
        chunks_total: 1,
        vectors_indexed: 1,
        missing_vectors: 0,
        known_unembeddable_vectors: 0,
        repairable_missing_vectors: 0,
        coverage: 1,
      },
      repairStatus: expectedRepairStatus,
    })
    assertRepairStatusInput(harness.calls, fixture.aliasA, {
      canonicalRoot: fixture.rootA,
      retainedIdentity,
    })
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test("Unit 5a search preserves lexical fallback and the exact semantic repair command", async () => {
  const root = await buildSearchRoot({ chunksTotal: 1, vectorsIndexed: 1 })
  const harness = createRuntimeHarness()
  const embedCalls = []
  const embed = {
    endpoint: "http://127.0.0.1:11434",
    fetch: recordingEmbedFetch(embedCalls, { fail: true }),
  }
  try {
    const result = await desk_search({
      deskRoot: root,
      input: { query: "alpha" },
      opts: { embed },
      runtimeContext: harness.runtimeContext,
    })

    assert.equal(result.search_mode, "lexical")
    assert.equal(result.semantic_unavailable, true)
    assert.equal(result.semantic_repair, SEMANTIC_REPAIR_COMMAND)
    assert.match(result.semantic_note, /Semantic search unavailable/u)
    assertFreshnessInput(harness.calls, root, embed)
    assertEmbeddingRequest(embedCalls, "alpha")
    assert.equal(harness.calls.start.length, 0)
    assertSearchContract(result, {
      legacyKeys: LEXICAL_LEGACY_KEYS,
      documentVectors: {
        state: "available",
        chunks_total: 1,
        vectors_indexed: 1,
        missing_vectors: 0,
        known_unembeddable_vectors: 0,
        repairable_missing_vectors: 0,
        coverage: 1,
      },
      repairStatus: { state: "idle", last_error: null },
    })
    assertRepairStatusInput(harness.calls, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Unit 5a search reports zero document vectors as missing while repair runs", async () => {
  const root = await buildSearchRoot({ chunksTotal: 1, vectorsIndexed: 0 })
  const harness = createRuntimeHarness({
    startRepairStatus: { state: "running", last_error: null },
  })
  const embedCalls = []
  const embed = {
    endpoint: "http://127.0.0.1:11434",
    fetch: recordingEmbedFetch(embedCalls),
  }
  try {
    const result = await desk_search({
      deskRoot: root,
      input: { query: "alpha" },
      opts: { embed },
      runtimeContext: harness.runtimeContext,
    })

    assert.equal(result.search_mode, "hybrid")
    assert.equal(result.results[0].score_breakdown.semantic, 0)
    assertFreshnessInput(harness.calls, root, embed)
    assertEmbeddingRequest(embedCalls, "alpha")
    assert.equal(harness.calls.start.length, 1)
    assert.equal(harness.calls.start[0].deskRoot, realpathSync(root))
    assert.strictEqual(harness.calls.start[0].embed, embed)
    assertSearchContract(result, {
      legacyKeys: HYBRID_LEGACY_KEYS,
      documentVectors: {
        state: "missing",
        chunks_total: 1,
        vectors_indexed: 0,
        missing_vectors: 1,
        known_unembeddable_vectors: 0,
        repairable_missing_vectors: 1,
        coverage: 0,
      },
      repairStatus: { state: "running", last_error: null },
    })
    assertRepairStatusInput(harness.calls, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Unit 5a search reports partial vectors and separates known from repairable gaps", async () => {
  const root = await buildSearchRoot({
    chunksTotal: 3,
    vectorsIndexed: 1,
    knownUnembeddableVectors: 1,
  })
  const harness = createRuntimeHarness({
    startRepairStatus: { state: "running", last_error: null },
  })
  const embedCalls = []
  const embed = {
    endpoint: "http://127.0.0.1:11434",
    fetch: recordingEmbedFetch(embedCalls),
  }
  try {
    const result = await desk_search({
      deskRoot: root,
      input: { query: "alpha" },
      opts: { embed },
      runtimeContext: harness.runtimeContext,
    })

    assert.equal(result.search_mode, "hybrid")
    assertFreshnessInput(harness.calls, root, embed)
    assertEmbeddingRequest(embedCalls, "alpha")
    assert.equal(harness.calls.start.length, 1)
    assertSearchContract(result, {
      legacyKeys: HYBRID_LEGACY_KEYS,
      documentVectors: {
        state: "partial",
        chunks_total: 3,
        vectors_indexed: 1,
        missing_vectors: 2,
        known_unembeddable_vectors: 1,
        repairable_missing_vectors: 1,
        coverage: 1 / 3,
      },
      repairStatus: { state: "running", last_error: null },
    })
    assertRepairStatusInput(harness.calls, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Unit 5a search treats known-unembeddable-only gaps as available after successful repair", async () => {
  const root = await buildSearchRoot({
    chunksTotal: 2,
    vectorsIndexed: 1,
    knownUnembeddableVectors: 1,
  })
  const harness = createRuntimeHarness({
    initialRepairStatus: { state: "complete", last_error: null },
  })
  const embedCalls = []
  const embed = {
    endpoint: "http://127.0.0.1:11434",
    fetch: recordingEmbedFetch(embedCalls),
  }
  try {
    const result = await desk_search({
      deskRoot: root,
      input: { query: "alpha" },
      opts: { embed },
      runtimeContext: harness.runtimeContext,
    })

    assertFreshnessInput(harness.calls, root, embed)
    assertEmbeddingRequest(embedCalls, "alpha")
    assert.equal(harness.calls.start.length, 0)
    assertSearchContract(result, {
      legacyKeys: HYBRID_LEGACY_KEYS,
      documentVectors: {
        state: "available",
        chunks_total: 2,
        vectors_indexed: 1,
        missing_vectors: 1,
        known_unembeddable_vectors: 1,
        repairable_missing_vectors: 0,
        coverage: 0.5,
      },
      repairStatus: { state: "complete", last_error: null },
    })
    assertRepairStatusInput(harness.calls, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Unit 5a search preserves hybrid legacy behavior and redacts failed repair details", async () => {
  const root = await buildSearchRoot({ chunksTotal: 1, vectorsIndexed: 1 })
  const harness = createRuntimeHarness({
    initialRepairStatus: {
      state: "failed",
      last_error: {
        reason: "semantic_repair_failed",
        message: "semantic repair failed",
        path: "forbidden-path-marker",
        paths: ["forbidden-paths-marker"],
        query: "forbidden-query-marker",
        body: "forbidden-body-marker",
        snippet: "forbidden-snippet-marker",
        snippets: ["forbidden-snippets-marker"],
        request: { body: "forbidden-request-marker" },
        stack: "forbidden-stack-marker",
        extra_key: "forbidden-extra-marker",
      },
    },
  })
  const embedCalls = []
  const embed = {
    endpoint: "http://127.0.0.1:11434",
    fetch: recordingEmbedFetch(embedCalls),
  }
  try {
    const result = await desk_search({
      deskRoot: root,
      input: { query: "alpha" },
      opts: { embed },
      runtimeContext: harness.runtimeContext,
    })

    assert.equal(result.search_mode, "hybrid")
    assert.equal(result.semantic_unavailable, false)
    assert.equal(result.semantic_repair, undefined)
    assert.equal(result.query, "alpha")
    assert.equal(result.results.length, 1)
    assertFreshnessInput(harness.calls, root, embed)
    assertEmbeddingRequest(embedCalls, "alpha")
    assert.equal(harness.calls.start.length, 0)
    assertSearchContract(result, {
      legacyKeys: HYBRID_LEGACY_KEYS,
      documentVectors: {
        state: "available",
        chunks_total: 1,
        vectors_indexed: 1,
        missing_vectors: 0,
        known_unembeddable_vectors: 0,
        repairable_missing_vectors: 0,
        coverage: 1,
      },
      repairStatus: {
        state: "failed",
        last_error: {
          reason: "semantic_repair_failed",
          message: "semantic repair failed",
        },
      },
    })
    assert.deepEqual(
      Object.keys(result.semantic_repair_status.last_error).sort(),
      ["message", "reason"],
    )
    const serialized = JSON.stringify(result.semantic_repair_status)
    for (const marker of [
      "forbidden-path-marker",
      "forbidden-paths-marker",
      "forbidden-query-marker",
      "forbidden-body-marker",
      "forbidden-snippet-marker",
      "forbidden-snippets-marker",
      "forbidden-request-marker",
      "forbidden-stack-marker",
      "forbidden-extra-marker",
    ]) {
      assert.equal(serialized.includes(marker), false)
    }
    assertRepairStatusInput(harness.calls, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Unit 5a status retains missing local DB vocabulary and exposes idle repair", async () => {
  const root = await mkTempDeskRoot()
  const harness = createRuntimeHarness()
  const dbPath = indexDbPath(root)
  try {
    assert.equal(existsSync(dbPath), false)
    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      runtimeContext: harness.runtimeContext,
    }))

    assert.equal(body.local_db.state, "missing")
    assert.equal(body.document_vectors.state, "missing_local_db")
    assert.deepEqual(body.semantic_repair_status, {
      state: "idle",
      last_error: null,
    })
    assert.equal(harness.calls.ensure.length, 0)
    assert.equal(harness.calls.start.length, 0)
    assertRepairStatusInput(harness.calls, root)
    assert.equal(existsSync(dbPath), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Unit 5a status retains unavailable-root vocabulary and exposes idle repair", async () => {
  const harness = createRuntimeHarness()
  const body = parseToolResult(await callTool({
    name: "desk_status",
    input: {},
    runtimeContext: harness.runtimeContext,
  }))

  assert.equal(body.local_db.state, "root_unavailable")
  assert.equal(body.document_vectors.state, "root_unavailable")
  assert.deepEqual(body.semantic_repair_status, {
    state: "idle",
    last_error: null,
  })
  assert.equal(harness.calls.ensure.length, 0)
  assert.equal(harness.calls.start.length, 0)
  assertRepairStatusInput(harness.calls, undefined)
})

test("Unit 5a status retains stale local DB vocabulary while repair is active", async () => {
  const root = await mkTempDeskRoot()
  const harness = createRuntimeHarness({
    initialRepairStatus: { state: "running", last_error: null },
  })
  try {
    mkdirSync(path.join(root, "ops"), { recursive: true })
    const documentPath = path.join(root, "ops", "status-contract.md")
    writeFileSync(documentPath, "# Status contract\n", "utf8")
    utimesSync(
      documentPath,
      new Date("2026-08-24T00:00:00.000Z"),
      new Date("2026-08-24T00:00:00.000Z"),
    )
    const db = openDb(root)
    try {
      setMeta(db, "last_indexed_at", "2026-08-23T00:00:00.000Z")
    } finally {
      closeDb(db)
    }

    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      runtimeContext: harness.runtimeContext,
    }))

    assert.equal(body.local_db.state, "stale")
    assert.equal(body.local_db.freshness.state, "stale")
    assert.equal(body.document_vectors.state, "available")
    assert.deepEqual(body.semantic_repair_status, {
      state: "running",
      last_error: null,
    })
    assert.equal(harness.calls.ensure.length, 0)
    assert.equal(harness.calls.start.length, 0)
    assertRepairStatusInput(harness.calls, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Unit 5a status preserves complete local/vector vocabulary and exposes complete repair", async () => {
  const root = await buildSearchRoot({ chunksTotal: 1, vectorsIndexed: 1 })
  const harness = createRuntimeHarness({
    initialRepairStatus: { state: "complete", last_error: null },
  })
  try {
    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      runtimeContext: harness.runtimeContext,
    }))
    const {
      semantic_repair_status: repairStatus,
      ...legacyStatus
    } = body

    assert.deepEqual(Object.keys(legacyStatus).sort(), STATUS_LEGACY_KEYS)
    assert.equal(body.status, "ok")
    assert.deepEqual(Object.keys(body.local_db).sort(), LOCAL_DB_KEYS)
    assert.equal(body.local_db.exists, true)
    assert.deepEqual(body.local_db.schema, { id: "desk-index", version: 1 })
    assert.equal(body.local_db.state, "available")
    assert.equal(body.local_db.freshness.state, "fresh")
    assert.deepEqual(body.lexical_index, {
      available: true,
      state: "available",
    })
    assert.deepEqual(body.document_vectors, {
      state: "available",
      chunks_total: 1,
      vectors_indexed: 1,
      missing_vectors: 0,
      known_unembeddable_vectors: 0,
      repairable_missing_vectors: 0,
      coverage: 1,
    })
    assert.deepEqual(Object.keys(body.document_vectors).sort(), DOCUMENT_VECTOR_KEYS)
    assert.equal(body.query_embedding.available, "not_checked")
    assert.deepEqual(body.degraded_modes, [])
    assert.deepEqual(repairStatus, {
      state: "complete",
      last_error: null,
    })
    assert.deepEqual(Object.keys(repairStatus).sort(), REPAIR_STATUS_KEYS)
    assert.equal(harness.calls.ensure.length, 0)
    assert.equal(harness.calls.start.length, 0)
    assertRepairStatusInput(harness.calls, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Unit 5a status exposes failed repair with only a redacted reason/message", async () => {
  const root = await mkTempDeskRoot()
  const harness = createRuntimeHarness({
    initialRepairStatus: {
      state: "failed",
      last_error: {
        reason: "semantic_repair_failed",
        message: "semantic repair failed",
        path: "forbidden-path-marker",
        body: "forbidden-body-marker",
        query: "forbidden-query-marker",
        snippets: ["forbidden-snippet-marker"],
      },
    },
  })
  try {
    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      runtimeContext: harness.runtimeContext,
    }))

    assert.deepEqual(body.semantic_repair_status, {
      state: "failed",
      last_error: {
        reason: "semantic_repair_failed",
        message: "semantic repair failed",
      },
    })
    assert.deepEqual(Object.keys(body.semantic_repair_status).sort(), REPAIR_STATUS_KEYS)
    assert.deepEqual(
      Object.keys(body.semantic_repair_status.last_error).sort(),
      ["message", "reason"],
    )
    const serialized = JSON.stringify(body.semantic_repair_status)
    assert.equal(serialized.includes("forbidden-path-marker"), false)
    assert.equal(serialized.includes("forbidden-body-marker"), false)
    assert.equal(serialized.includes("forbidden-query-marker"), false)
    assert.equal(serialized.includes("forbidden-snippet-marker"), false)
    assert.ok(REPAIR_STATES.has(body.semantic_repair_status.state))
    assert.equal(harness.calls.ensure.length, 0)
    assert.equal(harness.calls.start.length, 0)
    assertRepairStatusInput(harness.calls, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
