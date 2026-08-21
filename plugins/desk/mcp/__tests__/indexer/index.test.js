// index.test.js — end-to-end indexer behaviour against a small fixture desk.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import * as path from "node:path"
import * as os from "node:os"
import { promises as fs } from "node:fs"
import Database from "better-sqlite3"

import { isIndexFresh, rebuildIndex } from "../../src/indexer/index.js"
import { openDb, closeDb, getMeta, setMeta } from "../../src/db/init.js"
import * as discovery from "../../src/indexer/discover.js"
import { ensureIndex } from "../../src/server-helpers.js"

async function mkRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "desk-idx-"))
}
async function w(root, rel, body) {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, "utf8")
}

async function writeManyEmptySharedDocs(root, count) {
  const dir = path.join(root, "_shared")
  await fs.mkdir(dir, { recursive: true })
  for (let index = 0; index < count; index += 1) {
    await fs.writeFile(
      path.join(dir, `${String(index).padStart(5, "0")}.md`),
      "",
      "utf8",
    )
  }
}

async function writeManyChunkySharedDocs(root, docCount, chunksPerDoc) {
  const dir = path.join(root, "_shared")
  await fs.mkdir(dir, { recursive: true })
  const body = Array.from(
    { length: chunksPerDoc },
    (_, index) => `## Chunk ${index}\n\nbody ${index}`,
  ).join("\n\n")
  for (let index = 0; index < docCount; index += 1) {
    await fs.writeFile(
      path.join(dir, `chunky-${String(index).padStart(5, "0")}.md`),
      body,
      "utf8",
    )
  }
}

const indexOpts = { skipEmbed: true }

test("empty desk → empty index", async () => {
  const root = await mkRoot()
  const summary = await rebuildIndex(root, indexOpts)
  assert.equal(summary.docs_indexed, 0)
  assert.equal(summary.docs_skipped, 0)
  assert.equal(summary.chunks_inserted, 0)
})

test("small fixture desk → expected doc + chunk counts", async () => {
  const root = await mkRoot()
  await w(
    root,
    "trackA/task-1/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\n# T1\n\nbody one\n\n## H2\n\nbody two",
  )
  await w(root, "trackA/task-1/planning.md", "## Plan\n\nplan body")
  await w(root, "trackA/task-1/doing.md", "# Doing\n\ndoing body")
  await w(root, "_meta/friction.md", "# Friction\n\nentry")

  const summary = await rebuildIndex(root, indexOpts)
  assert.equal(summary.docs_indexed, 4)
  assert.ok(summary.chunks_inserted >= 4)

  const db = openDb(root)
  try {
    const docCount = db.prepare("SELECT count(*) AS c FROM docs").get().c
    assert.equal(docCount, 4)
    const chunkCount = db.prepare("SELECT count(*) AS c FROM chunks").get().c
    assert.ok(chunkCount >= 4, `expected >=4 chunks; got ${chunkCount}`)

    // refs_graph picked up planning_of + doing_of for the trackA/task-1
    // task.
    const refs = db.prepare("SELECT ref_kind FROM refs_graph").all().map((r) => r.ref_kind)
    assert.ok(refs.includes("planning_of"), `refs=${refs.join(",")}`)
    assert.ok(refs.includes("doing_of"), `refs=${refs.join(",")}`)
  } finally {
    closeDb(db)
  }
})

test("re-running on an unchanged desk is a no-op (hash unchanged)", async () => {
  const root = await mkRoot()
  await w(root, "trackA/task-1/task.md", "---\nstatus: processing\n---\nbody")
  await w(root, "trackA/task-1/planning.md", "body")

  const first = await rebuildIndex(root, indexOpts)
  assert.equal(first.docs_indexed, 2)
  assert.equal(first.docs_skipped, 0)

  const second = await rebuildIndex(root, indexOpts)
  assert.equal(second.docs_indexed, 0, "no docs should reindex on no-op run")
  assert.equal(second.docs_skipped, 2)
})

test("indexer records active embedding spec metadata and stable chunk keys", async () => {
  const root = await mkRoot()
  await w(root, "trackA/task-1/doing.md", "## Stable\n\nsame body\n")

  const first = await rebuildIndex(root, indexOpts)
  assert.equal(first.docs_indexed, 1)

  const db = openDb(root)
  let firstKeys
  try {
    const activeSpecId = getMeta(db, "active_embedding_spec_id")
    assert.ok(activeSpecId, "missing active_embedding_spec_id meta")
    assert.match(activeSpecId, /nomic-embed-text-v1_5/u)
    assert.equal(getMeta(db, "active_chunker_id"), "desk-md-h2-paragraph-v1")
    assert.equal(getMeta(db, "active_normalization_id"), "unicode-whitespace-v1")

    const rows = db
      .prepare(
        `SELECT chunk_key, text_hash, embedding_spec_id, chunker_id, normalization_id
         FROM chunks
         ORDER BY chunk_index`,
      )
      .all()
    assert.ok(rows.length >= 1)
    for (const row of rows) {
      assert.match(row.chunk_key, /^ck_/u)
      assert.match(row.text_hash, /^sha256:/u)
      assert.equal(row.embedding_spec_id, activeSpecId)
      assert.equal(row.chunker_id, "desk-md-h2-paragraph-v1")
      assert.equal(row.normalization_id, "unicode-whitespace-v1")
    }
    firstKeys = rows.map((row) => row.chunk_key)
  } finally {
    closeDb(db)
  }

  const second = await rebuildIndex(root, indexOpts)
  assert.equal(second.docs_indexed, 0)
  assert.equal(second.docs_skipped, 1)

  const dbAfter = openDb(root)
  try {
    const secondKeys = dbAfter
      .prepare("SELECT chunk_key FROM chunks ORDER BY chunk_index")
      .all()
      .map((row) => row.chunk_key)
    assert.deepEqual(secondKeys, firstKeys)
  } finally {
    closeDb(dbAfter)
  }
})

test("indexer persists the current discovery grammar version", async () => {
  const root = await mkRoot()
  await w(root, "trackA/task-1/task.md", "---\nstatus: processing\n---\nbody")

  assert.equal(discovery.DISCOVERY_GRAMMAR_VERSION, 2)
  await rebuildIndex(root, indexOpts)

  const db = openDb(root)
  try {
    assert.equal(getMeta(db, "discovery_grammar_version"), "2")
  } finally {
    closeDb(db)
  }
})

test("unchanged legacy indexes are reindexed to backfill chunk identity metadata", async () => {
  const root = await mkRoot()
  const relPath = "trackA/task-1/doing.md"
  const raw = "## Stable\n\nsame body\n"
  await w(root, relPath, raw)

  const stateDir = path.join(root, ".state")
  await fs.mkdir(stateDir, { recursive: true })
  const legacy = new Database(path.join(stateDir, "desk-index.sqlite"))
  try {
    legacy.exec(`
      CREATE TABLE docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        track TEXT,
        task_slug TEXT,
        status TEXT,
        schema_version INTEGER DEFAULT 0,
        created_at TEXT,
        updated_at TEXT,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        frontmatter TEXT
      );
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        heading TEXT,
        start_offset INTEGER,
        end_offset INTEGER
      );
    `)
    const docId = legacy
      .prepare(
        `INSERT INTO docs
          (path, kind, track, task_slug, hash, mtime, frontmatter)
         VALUES (?, 'doing', 'trackA', 'task-1', ?, 0, '{}')
         RETURNING id`,
      )
      .get(relPath, createHash("sha256").update(raw).digest("hex")).id
    legacy
      .prepare(
        `INSERT INTO chunks
          (doc_id, chunk_index, text, heading, start_offset, end_offset)
         VALUES (?, 0, ?, 'Stable', 0, ?)`,
      )
      .run(docId, raw.trim(), raw.length)
  } finally {
    legacy.close()
  }

  const summary = await rebuildIndex(root, indexOpts)
  assert.equal(summary.docs_indexed, 1)
  assert.equal(summary.docs_skipped, 0)

  const db = openDb(root)
  try {
    const rows = db
      .prepare(
        `SELECT chunk_key, text_hash, embedding_spec_id, chunker_id, normalization_id
         FROM chunks
         ORDER BY chunk_index`,
      )
      .all()
    assert.ok(rows.length > 0)
    for (const row of rows) {
      assert.match(row.chunk_key, /^ck_/u)
      assert.match(row.text_hash, /^sha256:/u)
      assert.equal(row.embedding_spec_id, getMeta(db, "active_embedding_spec_id"))
      assert.equal(row.chunker_id, getMeta(db, "active_chunker_id"))
      assert.equal(row.normalization_id, getMeta(db, "active_normalization_id"))
    }
  } finally {
    closeDb(db)
  }
})

test("unchanged docs with missing chunk rows are rebuilt only when chunks are expected", async () => {
  const root = await mkRoot()
  await w(
    root,
    "trackA/task-1/doing.md",
    "## Missing chunks\n\nbody\n\n## Second chunk\n\nmore body",
  )
  await w(root, "trackA/task-2/doing.md", "")

  await rebuildIndex(root, indexOpts)
  const db = openDb(root)
  try {
    const missingChunksDoc = db
      .prepare("SELECT id FROM docs WHERE path = ?")
      .get("trackA/task-1/doing.md")
    const emptyDoc = db
      .prepare("SELECT id FROM docs WHERE path = ?")
      .get("trackA/task-2/doing.md")
    db.prepare("DELETE FROM chunks WHERE doc_id = ? AND chunk_index = 1").run(
      missingChunksDoc.id,
    )
    db.prepare("DELETE FROM chunks WHERE doc_id = ?").run(emptyDoc.id)
  } finally {
    closeDb(db)
  }

  const summary = await rebuildIndex(root, indexOpts)
  assert.equal(summary.docs_indexed, 1)
  assert.equal(summary.docs_skipped, 1)

  const dbAfter = openDb(root)
  try {
    const rebuiltChunks = dbAfter
      .prepare(
        `SELECT count(*) AS count
         FROM chunks c
         JOIN docs d ON d.id = c.doc_id
         WHERE d.path = ? AND c.chunk_key IS NOT NULL`,
      )
      .get("trackA/task-1/doing.md").count
    const emptyChunks = dbAfter
      .prepare(
        `SELECT count(*) AS count
         FROM chunks c
         JOIN docs d ON d.id = c.doc_id
         WHERE d.path = ?`,
      )
      .get("trackA/task-2/doing.md").count
    assert.equal(rebuiltChunks, 2)
    assert.equal(emptyChunks, 0)
  } finally {
    closeDb(dbAfter)
  }
})

test("reembedMissing treats vectors from inactive embedding specs as missing", async () => {
  const root = await mkRoot()
  await w(root, "trackA/task-1/task.md", "---\nstatus: processing\n---\nsemantic body")

  const dim = 768
  const vec = Array.from({ length: dim }, (_, i) => (i % 5) / dim)
  const firstFetch = async () => ({ ok: true, json: async () => ({ embedding: vec }) })
  await rebuildIndex(root, { embed: { fetch: firstFetch } })

  const db = openDb(root)
  try {
    const vecCount = db.prepare("SELECT count(*) AS c FROM chunk_vecs").get().c
    assert.ok(vecCount > 0, "expected initial vector rows")
    const activeSpecId = getMeta(db, "active_embedding_spec_id")
    assert.ok(activeSpecId, "missing active_embedding_spec_id meta")
    const inactiveSpecId = "inactive-spec-for-red-test"
    assert.notEqual(activeSpecId, inactiveSpecId)
    db.prepare(
      `INSERT INTO embedding_specs
        (id, model, model_revision, dimension, chunker_id, normalization_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      inactiveSpecId,
      "nomic-embed-text",
      "nomic-embed-text-v1.4",
      768,
      "desk-md-h2-paragraph-v0",
      "unicode-whitespace-v0",
    )
    db.prepare(
      `UPDATE chunks
       SET embedding_spec_id = ?,
           chunker_id = 'desk-md-h2-paragraph-v0',
           normalization_id = 'unicode-whitespace-v0'`,
    ).run(inactiveSpecId)
  } finally {
    closeDb(db)
  }

  let calls = 0
  const secondFetch = async () => {
    calls += 1
    return { ok: true, json: async () => ({ embedding: vec }) }
  }
  const second = await rebuildIndex(root, {
    reembedMissing: true,
    embed: { fetch: secondFetch },
  })

  assert.equal(second.docs_indexed, 1)
  assert.ok(calls > 0, "inactive spec vectors must not satisfy active-spec embedding coverage")
})

test("default embedding options use global fetch and archive docs keep archive metadata", async () => {
  const root = await mkRoot()
  await w(root, "trackA/_archive/old-task/task.md", "---\nstatus: done\n---\narchived semantic body")

  const originalFetch = globalThis.fetch
  const dim = 768
  const vec = Array.from({ length: dim }, (_, i) => (i % 11) / dim)
  const requests = []
  globalThis.fetch = async (url, request) => {
    requests.push({
      url: String(url),
      body: JSON.parse(request.body),
    })
    return { ok: true, json: async () => ({ embedding: vec }) }
  }

  try {
    const summary = await rebuildIndex(root)
    assert.equal(summary.docs_indexed, 1)
    assert.equal(summary.semantic_warnings, 0)
  } finally {
    if (originalFetch === undefined) {
      delete globalThis.fetch
    } else {
      globalThis.fetch = originalFetch
    }
  }

  assert.ok(requests.length > 0, "expected indexer to call global fetch with default embed options")
  assert.ok(requests[0].url.endsWith("/api/embeddings"), `unexpected embed URL: ${requests[0].url}`)
  assert.equal(requests[0].body.model, "nomic-embed-text")

  const db = openDb(root)
  try {
    const doc = db.prepare("SELECT is_archived FROM docs WHERE path = ?").get("trackA/_archive/old-task/task.md")
    const vecCount = db.prepare("SELECT count(*) AS c FROM chunk_vecs").get().c
    assert.equal(doc.is_archived, 1)
    assert.ok(vecCount > 0, "expected default embedding path to store vectors")
  } finally {
    closeDb(db)
  }
})

test("isIndexFresh requires valid metadata and trusts an exact document tree", async () => {
  const root = await mkRoot()
  await w(root, "trackA/task-1/task.md", "---\nstatus: processing\n---\nfreshness body")
  await rebuildIndex(root, indexOpts)
  const db = openDb(root)
  try {
    db.prepare("DELETE FROM meta WHERE key = 'last_indexed_at'").run()
    setMeta(
      db,
      "discovery_grammar_version",
      String(discovery.DISCOVERY_GRAMMAR_VERSION),
    )
    assert.equal(await isIndexFresh(root, db), false)

    setMeta(db, "last_indexed_at", "not-a-date")
    assert.equal(await isIndexFresh(root, db), false)

    setMeta(db, "last_indexed_at", "2000-01-01T00:00:00.000Z")
    assert.equal(await isIndexFresh(root, db), true)

    setMeta(db, "last_indexed_at", "2999-01-01T00:00:00.000Z")
    assert.equal(await isIndexFresh(root, db), true)
  } finally {
    closeDb(db)
  }
})

test("isIndexFresh rejects missing and stale discovery grammar metadata", async () => {
  const root = await mkRoot()
  const docPath = path.join(root, "trackA", "task-1", "task.md")
  await w(root, "trackA/task-1/task.md", "---\nstatus: processing\n---\ngrammar freshness body")
  const old = new Date("2000-01-01T00:00:00.000Z")
  await fs.utimes(docPath, old, old)
  await rebuildIndex(root, indexOpts)

  const db = openDb(root)
  try {
    setMeta(db, "last_indexed_at", "2999-01-01T00:00:00.000Z")
    db.prepare("DELETE FROM meta WHERE key = 'discovery_grammar_version'").run()
    assert.equal(await isIndexFresh(root, db), false)

    setMeta(db, "discovery_grammar_version", "1")
    assert.equal(await isIndexFresh(root, db), false)

    setMeta(db, "discovery_grammar_version", "not-a-version")
    assert.equal(await isIndexFresh(root, db), false)

    setMeta(db, "discovery_grammar_version", "3")
    assert.equal(await isIndexFresh(root, db), false)

    setMeta(db, "discovery_grammar_version", "2")
    assert.equal(await isIndexFresh(root, db), true)
  } finally {
    closeDb(db)
  }
})

test("ensureIndex rediscovers old-mtime documents exactly once after a grammar mismatch", async () => {
  const root = await mkRoot()
  const taskPath = "trackA/task-1/task.md"
  const referencePath = "references/old-note.md"
  await w(root, taskPath, "---\nstatus: processing\n---\nexisting task")
  await w(root, referencePath, "# Newly eligible old reference")
  const old = new Date("2000-01-01T00:00:00.000Z")
  await fs.utimes(path.join(root, taskPath), old, old)
  await fs.utimes(path.join(root, referencePath), old, old)
  await rebuildIndex(root, indexOpts)

  const db = openDb(root)
  try {
    db.prepare("DELETE FROM docs WHERE path = ?").run(referencePath)
    setMeta(db, "last_indexed_at", "2999-01-01T00:00:00.000Z")
    setMeta(db, "discovery_grammar_version", "1")
  } finally {
    closeDb(db)
  }

  const first = await ensureIndex(root, {
    skipEmbed: true,
    snapshots: false,
    vectorPacks: false,
  })
  assert.equal(first.built, true)
  assert.equal(first.reason, "stale")
  assert.equal(first.summary.docs_indexed, 1)
  assert.equal(first.summary.docs_skipped, 1)

  const dbAfter = openDb(root)
  try {
    assert.equal(getMeta(dbAfter, "discovery_grammar_version"), "2")
    assert.deepEqual(
      dbAfter.prepare("SELECT path FROM docs ORDER BY path").all(),
      [{ path: referencePath }, { path: taskPath }],
    )
  } finally {
    closeDb(dbAfter)
  }

  const second = await ensureIndex(root, {
    skipEmbed: true,
    snapshots: false,
    vectorPacks: false,
  })
  assert.equal(second.built, false)
  assert.equal(second.reason, "fresh")
})

test("modifying one doc → that doc reindexed, others skipped", async () => {
  const root = await mkRoot()
  await w(root, "trackA/task-1/task.md", "---\nstatus: processing\n---\nbody")
  await w(root, "trackA/task-1/planning.md", "plan v1")
  await w(root, "trackA/task-2/task.md", "---\nstatus: blocked\n---\nbody")

  await rebuildIndex(root, indexOpts)

  // Touch one file with new content.
  await w(root, "trackA/task-1/planning.md", "plan v2 has different content")
  // Bump mtime forward in case the FS gives us the same-second mtime.
  const future = new Date(Date.now() + 5000)
  await fs.utimes(path.join(root, "trackA/task-1/planning.md"), future, future)

  const summary = await rebuildIndex(root, indexOpts)
  assert.equal(summary.docs_indexed, 1)
  assert.equal(summary.docs_skipped, 2)
})

test("deleting a doc removes it from the index on next pass", async () => {
  const root = await mkRoot()
  await w(root, "trackA/task-1/task.md", "---\nstatus: processing\n---\nbody")
  await w(root, "trackA/task-1/planning.md", "plan")

  await rebuildIndex(root, indexOpts)

  await fs.unlink(path.join(root, "trackA/task-1/planning.md"))

  const summary = await rebuildIndex(root, indexOpts)
  assert.equal(summary.docs_removed, 1)

  const db = openDb(root)
  try {
    const remaining = db.prepare("SELECT path FROM docs").all().map((r) => r.path)
    assert.deepEqual(remaining, ["trackA/task-1/task.md"])
  } finally {
    closeDb(db)
  }
})

test("happy-path embedding writes chunk_vecs rows (BigInt PK binding)", async () => {
  const root = await mkRoot()
  await w(root, "trackA/t1/task.md", "---\nstatus: processing\n---\nhybrid retrieval body\n\n## H2\n\nmore text")

  // Mock fetch that returns a deterministic 768-dim vector. This exercises
  // the chunk_vecs INSERT path that requires BigInt-coerced primary keys —
  // a plain JS number bind here raises "Only integers are allows for
  // primary key values on chunk_vecs".
  const dim = 768
  const vec = Array.from({ length: dim }, (_, i) => (i % 7) / dim)
  const okFetch = async () => ({ ok: true, json: async () => ({ embedding: vec }) })

  const summary = await rebuildIndex(root, { embed: { fetch: okFetch } })
  assert.equal(summary.semantic_warnings, 0, "expected no soft-fail warnings on happy path")
  assert.ok(summary.chunks_inserted >= 1)

  const db = openDb(root)
  try {
    const vecCount = db.prepare("SELECT count(*) AS c FROM chunk_vecs").get().c
    assert.equal(vecCount, summary.chunks_inserted, "one vec row per chunk")
  } finally {
    closeDb(db)
  }
})

test("ollama-down soft-fail still populates FTS chunks", async () => {
  const root = await mkRoot()
  await w(root, "trackA/t1/task.md", "---\nstatus: processing\n---\nhybrid retrieval body")

  // Pass a mock fetch that always fails — embeddings come back null but
  // chunks still get inserted and FTS still indexes them.
  const failingFetch = async () => {
    const e = new Error("ECONNREFUSED")
    e.code = "ECONNREFUSED"
    throw e
  }
  const summary = await rebuildIndex(root, { embed: { fetch: failingFetch } })
  assert.equal(summary.docs_indexed, 1)
  assert.ok(summary.chunks_inserted >= 1)
  assert.equal(summary.semantic_warnings, 1)

  const db = openDb(root)
  try {
    const hits = db
      .prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?")
      .all("hybrid")
    assert.ok(hits.length >= 1, "expected FTS to have indexed the text")
    // No vec rows when ollama is down.
    const vecCount = db.prepare("SELECT count(*) AS c FROM chunk_vecs").get().c
    assert.equal(vecCount, 0)
  } finally {
    closeDb(db)
  }
})

test("unchanged lexical-only docs do not live-embed unless reembedMissing is enabled", async () => {
  const root = await mkRoot()
  await w(root, "trackA/t1/task.md", "---\nstatus: processing\n---\nlexical-only body")

  const failingFetch = async () => {
    const error = new Error("ECONNREFUSED")
    error.code = "ECONNREFUSED"
    throw error
  }
  const first = await rebuildIndex(root, { embed: { fetch: failingFetch } })
  assert.equal(first.docs_indexed, 1)
  assert.equal(first.semantic_warnings, 1)

  let calls = 0
  const okFetch = async () => {
    calls += 1
    const vec = Array.from({ length: 768 }, (_, i) => (i % 13) / 768)
    return { ok: true, json: async () => ({ embedding: vec }) }
  }
  const second = await rebuildIndex(root, { embed: { fetch: okFetch } })
  assert.equal(second.docs_indexed, 0)
  assert.equal(second.docs_skipped, 1)
  assert.equal(second.semantic_warnings, 0)
  assert.equal(calls, 0)

  const db = openDb(root)
  try {
    const vecCount = db.prepare("SELECT count(*) AS c FROM chunk_vecs").get().c
    assert.equal(vecCount, 0)
  } finally {
    closeDb(db)
  }
})

test("large rebuilds do not exceed SQLite variable limits when no chunks need embedding", { timeout: 60000 }, async () => {
  const root = await mkRoot()
  const docsBeyondLocalSqliteVariableLimit = 32767
  await writeManyEmptySharedDocs(root, docsBeyondLocalSqliteVariableLimit)

  let calls = 0
  const fetchShouldNotRun = async () => {
    calls += 1
    throw new Error("empty docs should not need embeddings")
  }

  const summary = await rebuildIndex(root, { embed: { fetch: fetchShouldNotRun } })
  assert.equal(summary.docs_indexed, docsBeyondLocalSqliteVariableLimit)
  assert.equal(summary.chunks_inserted, 0)
  assert.equal(summary.semantic_warnings, 0)
  assert.equal(calls, 0)
})

test("large missing-vector batches append rows without spread argument overflow", { timeout: 60000 }, async () => {
  const root = await mkRoot()
  const docsPerBatch = 500
  const chunksPerDoc = 240
  await writeManyChunkySharedDocs(root, docsPerBatch, chunksPerDoc)

  let calls = 0
  const failingFetch = async () => {
    calls += 1
    throw new Error("controlled embedding stop")
  }

  const summary = await rebuildIndex(root, {
    embed: {
      endpoint: "http://127.0.0.1:9/api/embeddings",
      fetch: failingFetch,
    },
  })
  assert.equal(summary.docs_indexed, docsPerBatch)
  assert.equal(summary.chunks_inserted, docsPerBatch * chunksPerDoc)
  assert.equal(summary.semantic_warnings, 1)
  assert.equal(calls, 1)
})
