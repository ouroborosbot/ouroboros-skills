// reindex.test.js — desk_reindex tool wraps ensureIndex (mtime-incremental)
// and the force:true rebuild path.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import { existsSync } from "node:fs"
import * as path from "node:path"

import { desk_reindex } from "../../src/tools/reindex.js"
import { closeDb, indexDbPath, openDb } from "../../src/db/init.js"
import { rebuildIndex } from "../../src/indexer/index.js"
import {
  createMaintenanceCoordinator,
  createMaintenanceRuntimeBinding,
} from "../../src/indexer/maintenance.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"
import { mkTempDeskRoot } from "./_helpers.js"

// All tests use skipEmbed to keep them hermetic (no Ollama dependency).
const noReleaseArtifacts = { snapshots: false, vectorPacks: false }
const reindexOpts = { ...noReleaseArtifacts, embed: undefined, skipEmbed: true }

function okEmbedFetch() {
  const vec = Array.from({ length: 768 }, (_, i) => (i % 11) / 768)
  return async () => ({
    ok: true,
    json: async () => ({ embedding: vec }),
  })
}

function failingFetch() {
  return async () => {
    const err = new Error("ECONNREFUSED")
    err.code = "ECONNREFUSED"
    throw err
  }
}

async function writeFile(root, rel, body) {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, "utf8")
}

test("desk_reindex — empty bundle returns ok with built=true and zero docs", async () => {
  const root = await mkTempDeskRoot()
  const res = await desk_reindex({
    deskRoot: root,
    input: {},
    opts: reindexOpts,
  })

  assert.equal(res.status, "ok")
  assert.equal(typeof res.built, "boolean")
  assert.equal(typeof res.reason, "string")
  assert.equal(res.docs_indexed, 0)
  assert.equal(res.docs_skipped, 0)
  assert.equal(res.docs_pruned, 0)
  assert.ok(typeof res.ms === "number" && res.ms >= 0)
  // First call against a fresh root has no DB on disk → built must be true.
  assert.equal(res.built, true)
  assert.equal(res.reason, "missing")
})

test("desk_reindex — after writing a doc, reindex returns docs_indexed >= 1", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/task-1/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\nhello body\n",
  )
  const res = await desk_reindex({
    deskRoot: root,
    input: {},
    opts: reindexOpts,
  })

  assert.equal(res.status, "ok")
  assert.equal(res.built, true)
  assert.ok(
    res.docs_indexed >= 1,
    `expected docs_indexed >= 1, got ${res.docs_indexed}`,
  )
})

test("desk_reindex — second call without force returns built=false reason=fresh", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/task-1/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\nhello body\n",
  )
  // First call seeds the index.
  await desk_reindex({ deskRoot: root, input: {}, opts: reindexOpts })

  // Second call without force: nothing has changed → fresh, built=false.
  const res = await desk_reindex({
    deskRoot: root,
    input: {},
    opts: reindexOpts,
  })
  assert.equal(res.status, "ok")
  assert.equal(res.built, false)
  assert.equal(res.reason, "fresh")
  // ensureIndex no-op path → no per-doc counts (0).
  assert.equal(res.docs_indexed, 0)
})

test("desk_reindex — no-force repairs a fresh lexical-only index when embeddings return", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/task-1/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\nsemantic repair body\n",
  )
  await rebuildIndex(root, { embed: { fetch: failingFetch() } })

  let chunks = 0
  {
    const db = openDb(root)
    try {
      chunks = db.prepare("SELECT COUNT(*) AS n FROM chunks").get().n
      const vectors = db.prepare("SELECT COUNT(*) AS n FROM chunk_vecs").get().n
      assert.ok(chunks >= 1, "fixture should have chunks")
      assert.equal(vectors, 0, "first pass should be lexical-only")
    } finally {
      closeDb(db)
    }
  }

  const res = await desk_reindex({
    deskRoot: root,
    input: {},
    opts: { ...noReleaseArtifacts, embed: { fetch: okEmbedFetch() } },
  })
  assert.equal(res.status, "ok")
  assert.equal(res.built, true)
  assert.equal(res.reason, "semantic_missing")
  assert.equal(res.chunks_total, chunks)
  assert.equal(res.vectors_indexed, chunks)
  assert.equal(res.missing_vectors, 0)
  assert.equal(res.semantic_available, true)
})

test("desk_reindex — no-force repairs fresh vectors from an inactive embedding spec", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/task-1/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\nsemantic spec body\n",
  )
  await rebuildIndex(root, { embed: { fetch: okEmbedFetch() } })

  let chunks = 0
  {
    const db = openDb(root)
    try {
      chunks = db.prepare("SELECT COUNT(*) AS n FROM chunks").get().n
      const vectors = db.prepare("SELECT COUNT(*) AS n FROM chunk_vecs").get().n
      assert.ok(chunks >= 1, "fixture should have chunks")
      assert.equal(vectors, chunks, "fixture should start with full vector rows")
      db.prepare(
        `UPDATE chunks
         SET embedding_spec_id = 'old-spec',
             chunker_id = 'old-chunker',
             normalization_id = 'old-normalizer'`,
      ).run()
    } finally {
      closeDb(db)
    }
  }

  const res = await desk_reindex({
    deskRoot: root,
    input: {},
    opts: { ...noReleaseArtifacts, embed: { fetch: okEmbedFetch() } },
  })
  assert.equal(res.status, "ok")
  assert.equal(res.built, true)
  assert.equal(res.reason, "semantic_missing")
  assert.equal(res.chunks_total, chunks)
  assert.equal(res.vectors_indexed, chunks)
  assert.equal(res.missing_vectors, 0)
  assert.equal(res.semantic_available, true)

  const db = openDb(root)
  try {
    const stale = db.prepare(
      `SELECT COUNT(*) AS n
       FROM chunks
       WHERE embedding_spec_id != ?
          OR chunker_id != ?
          OR normalization_id != ?`,
    ).get(
      ACTIVE_EMBEDDING_SPEC.id,
      ACTIVE_EMBEDDING_SPEC.chunker_id,
      ACTIVE_EMBEDDING_SPEC.normalization_id,
    ).n
    assert.equal(stale, 0, "repair should rewrite chunks to the active embedding spec")
  } finally {
    closeDb(db)
  }
})

test("desk_reindex — stale lexical-only indexes repair through default embedding options", async () => {
  const root = await mkTempDeskRoot()
  const originalFetch = globalThis.fetch
  try {
    const docPath = path.join("trackA", "task-1", "task.md")
    await writeFile(
      root,
      docPath,
      "---\nstatus: processing\nschema_version: 1\n---\nstale semantic repair body\n",
    )
    await rebuildIndex(root, { skipEmbed: true })
    await writeFile(
      root,
      docPath,
      "---\nstatus: processing\nschema_version: 1\n---\nstale semantic repair body changed\n",
    )
    const changedAt = new Date(Date.now() + 2_000)
    await fs.utimes(path.join(root, docPath), changedAt, changedAt)

    const vec = Array.from({ length: ACTIVE_EMBEDDING_SPEC.dimension }, (_, i) => (i % 13) / 768)
    let fetchCalls = 0
    globalThis.fetch = async () => {
      fetchCalls += 1
      return { ok: true, json: async () => ({ embedding: vec }) }
    }

    const res = await desk_reindex({
      deskRoot: root,
      input: {},
      opts: noReleaseArtifacts,
    })

    assert.equal(res.status, "ok")
    assert.equal(res.built, true)
    assert.equal(res.reason, "stale")
    assert.ok(res.docs_indexed >= 1)
    assert.equal(res.missing_vectors, 0)
    assert.equal(res.semantic_available, true)
    assert.ok(fetchCalls >= 2, "probe and rebuild should use default global fetch options")
  } finally {
    if (originalFetch === undefined) {
      delete globalThis.fetch
    } else {
      globalThis.fetch = originalFetch
    }
  }
})

test("desk_reindex — force:true drops the DB and rebuilds from scratch", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/task-1/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\nhello body\n",
  )
  // First call to seed.
  await desk_reindex({ deskRoot: root, input: {}, opts: reindexOpts })
  const dbPath = indexDbPath(root)
  assert.ok(existsSync(dbPath), "db should exist after first reindex")

  // Second call with force:true must rebuild from scratch even though
  // nothing has changed. ensureIndex sees a missing DB → built=true,
  // reason=missing.
  const res = await desk_reindex({
    deskRoot: root,
    input: { force: true },
    opts: reindexOpts,
  })
  assert.equal(res.status, "ok")
  assert.equal(res.built, true)
  assert.equal(res.reason, "missing")
  assert.ok(res.docs_indexed >= 1, "force rebuild re-indexes all docs")
  // DB exists again after the rebuild.
  assert.ok(existsSync(dbPath), "db re-created after force rebuild")
})

test("desk_reindex — force:true on a fresh root with no DB still succeeds", async () => {
  const root = await mkTempDeskRoot()
  const res = await desk_reindex({
    deskRoot: root,
    input: { force: true },
    opts: reindexOpts,
  })
  assert.equal(res.status, "ok")
  assert.equal(res.built, true)
  // No docs on disk → docs_indexed stays 0.
  assert.equal(res.docs_indexed, 0)
})

test("desk_reindex — omitted input defaults to non-force maintenance", async () => {
  const root = await mkTempDeskRoot()
  const calls = []
  const maintenance = createMaintenanceCoordinator({
    async ensureIndex(deskRoot, ensureOptions) {
      calls.push({ deskRoot, ensureOptions })
      return {
        built: false,
        reason: "fresh",
      }
    },
  })

  const res = await desk_reindex({
    deskRoot: root,
    runtimeContext: createMaintenanceRuntimeBinding(maintenance),
  })

  assert.deepEqual(calls, [
    {
      deskRoot: path.resolve(root),
      ensureOptions: {},
    },
  ])
  assert.equal(res.status, "ok")
  assert.equal(res.built, false)
  assert.equal(res.reason, "fresh")
  assert.equal(res.docs_indexed, 0)
  assert.equal(res.docs_skipped, 0)
  assert.equal(res.docs_pruned, 0)
  assert.equal(res.chunks_total, 0)
  assert.equal(res.vectors_indexed, 0)
  assert.equal(res.missing_vectors, 0)
  assert.equal(res.semantic_available, undefined)
  assert.equal(res.semantic_diagnostic, undefined)
})

test("desk_reindex — rejects a mismatched per-tool maintenance override before either writer runs", async () => {
  const root = await mkTempDeskRoot()
  let runtimeWriterCalls = 0
  let overrideWriterCalls = 0
  const runtimeContext = {
    maintenanceCoordinator: {
      async runExplicitReindex() {
        runtimeWriterCalls += 1
        return { built: false, reason: "fresh" }
      },
    },
  }
  const mismatchedMaintenance = {
    async runExplicitReindex() {
      overrideWriterCalls += 1
      return { built: false, reason: "fresh" }
    },
  }

  await assert.rejects(
    desk_reindex({
      deskRoot: root,
      input: { force: true },
      runtimeContext,
      opts: { maintenance: mismatchedMaintenance },
    }),
    /per-tool maintenance override/i,
  )
  assert.equal(runtimeWriterCalls, 0)
  assert.equal(overrideWriterCalls, 0)
})
