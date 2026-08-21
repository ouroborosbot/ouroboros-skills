// index.js — top-level indexer orchestrator.
//
// Walks the desk root, parses each doc, hash-compares to the existing index,
// re-chunks + re-embeds + upserts on change, and refreshes refs_graph.
// Idempotent — running it twice on a clean tree results in 0 reindexed docs.
//
// Soft-fail: if Ollama is down, FTS5 still gets populated; chunk_vecs rows
// for new chunks are left absent so semantic search degrades gracefully.

import { promises as fs } from "node:fs"
import { openDb, closeDb, getMeta, setMeta } from "../db/init.js"
import {
  filterTombstonedDocuments,
  tombstoneStatusForDocuments,
} from "../artifacts/tombstones.js"
import { DISCOVERY_GRAMMAR_VERSION, discover } from "./discover.js"
import { chunkBody } from "./chunk.js"
import {
  embedChunksDetailed,
  EMBEDDING_DIM,
  isChunkLocalEmbeddingFailure,
} from "./embed.js"
import { computeRefs } from "./refs.js"
import {
  ACTIVE_EMBEDDING_SPEC,
  chunkIdentity,
  writeActiveEmbeddingSpec,
} from "./spec.js"
import { importVectorPacks } from "./vector-packs.js"

const SQLITE_PARAMETER_BATCH_SIZE = 500
const ACTIVE_CHUNK_FAILURE_JOIN = `
  f.chunk_key = c.chunk_key AND
  f.text_hash = c.text_hash AND
  f.embedding_spec_id = c.embedding_spec_id AND
  f.chunker_id = c.chunker_id AND
  f.normalization_id = c.normalization_id
`

/**
 * Run the indexer against `deskRoot`. Creates/refreshes
 * `<deskRoot>/.state/desk-index.sqlite` and returns a summary.
 *
 * @param {string} deskRoot
 * @param {object} [opts]
 * @param {object} [opts.db] — reuse an already-open DB handle (tests).
 * @param {string} [opts.dbPath] — override DB path (tests).
 * @param {object} [opts.embed] — override embed options (endpoint/model/fetch).
 * @param {boolean} [opts.skipEmbed] — skip embedding entirely (testing).
 * @param {boolean} [opts.reembedMissing] — reindex unchanged docs whose
 *   chunks exist but do not have vectors.
 * @param {object} [opts.vectorPacks] — import shared vector packs before
 *   live embedding generation.
 * @param {string} [opts.vectorPacks.pluginRoot] — plugin root containing
 *   artifacts/vector-packs/<embedding-spec-id>/.
 * @returns {Promise<{ docs_indexed: number, docs_skipped: number,
 *                     docs_removed: number, chunks_inserted: number,
 *                     semantic_warnings: number }>}
 */
export async function rebuildIndex(deskRoot, opts = {}) {
  const ownsDb = !opts.db
  const db = opts.db ?? openDb(deskRoot, { dbPath: opts.dbPath })

  const summary = {
    docs_indexed: 0,
    docs_skipped: 0,
    docs_removed: 0,
    docs_tombstoned: 0,
    chunks_inserted: 0,
    semantic_warnings: 0,
    embedding_failures_recorded: 0,
  }

  try {
    throwIfAborted(opts.signal)
    writeActiveEmbeddingSpec(db, setMeta)
    const discoveredRaw = await discover(deskRoot, { signal: opts.signal })
    const tombstoneFilter = await filterTombstonedDocuments({
      pluginRoot: opts.tombstones?.pluginRoot,
      docs: discoveredRaw,
    })
    const discovered = tombstoneFilter.docs
    summary.docs_tombstoned = tombstoneFilter.tombstoned_count
    throwIfAborted(opts.signal)
    const discoveredByPath = new Map(discovered.map((d) => [d.path, d]))

    // Compare against existing docs table. Anything no longer on disk gets
    // deleted (cascade clears chunks + refs).
    const existing = db
      .prepare("SELECT id, path, hash, mtime FROM docs")
      .all()
    const existingByPath = new Map(existing.map((r) => [r.path, r]))

    const deletedPaths = []
    for (const row of existing) {
      throwIfAborted(opts.signal)
      if (!discoveredByPath.has(row.path)) {
        deletedPaths.push(row.path)
      }
    }
    if (deletedPaths.length) {
      const delStmt = db.prepare("DELETE FROM docs WHERE path = ?")
      const delTxn = db.transaction((paths) => {
        for (const p of paths) delStmt.run(p)
      })
      delTxn(deletedPaths)
      summary.docs_removed = deletedPaths.length
    }

    // Decide which docs need reindexing.
    const toReindex = []
    for (const doc of discovered) {
      throwIfAborted(opts.signal)
      const existingRow = existingByPath.get(doc.path)
      if (existingRow && existingRow.hash === doc.hash) {
        if (docNeedsActiveChunkMetadata(db, existingRow.id, doc)) {
          toReindex.push(doc)
          continue
        }
        if (
          opts.reembedMissing &&
          !opts.skipEmbed &&
          docHasMissingActiveEmbeddings(db, existingRow.id)
        ) {
          toReindex.push(doc)
          continue
        }
        summary.docs_skipped += 1
        continue
      }
      toReindex.push(doc)
    }

    // Per doc: upsert docs row and replace chunks. Vectors are imported from
    // committed packs first, then live-generated only for remaining gaps.
    const reindexedDocIds = []
    for (const doc of toReindex) {
      throwIfAborted(opts.signal)
      reindexedDocIds.push(indexOneDoc(db, doc, summary))
      summary.docs_indexed += 1
    }

    if (opts.vectorPacks?.pluginRoot) {
      summary.vector_packs = vectorPackImportStatus(await importVectorPackRoots({
        db,
        vectorPacks: opts.vectorPacks,
        signal: opts.signal,
      }))
    }

    pruneStaleEmbeddingFailures(db)

    if (!opts.skipEmbed) {
      throwIfAborted(opts.signal)
      await embedMissingVectors(db, opts, summary, reindexedDocIds)
    }

    // Refs graph — recompute from scratch each pass. Cheap (just a table
    // scan of docs frontmatter) and avoids stale edges.
    refreshRefs(db, discovered)

    setMeta(db, "discovery_grammar_version", String(DISCOVERY_GRAMMAR_VERSION))
    setMeta(db, "last_indexed_at", new Date().toISOString())
    setMeta(db, "embedding_dim", String(EMBEDDING_DIM))
    setMeta(db, "embedding_model", opts.embed?.model ?? "nomic-embed-text")
  } finally {
    if (ownsDb) closeDb(db)
  }

  return summary
}

async function importVectorPackRoots({ db, vectorPacks, signal }) {
  const roots = uniquePaths([
    vectorPacks.pluginRoot,
    ...(Array.isArray(vectorPacks.fallbackPluginRoots)
      ? vectorPacks.fallbackPluginRoots
      : []),
  ])
  const combined = emptyVectorPackSummary()
  for (const pluginRoot of roots) {
    try {
      const rootSummary = await importVectorPacks({
        db,
        pluginRoot,
        signal,
        expectedArtifactSourceScopeHash:
          vectorPacks.expectedArtifactSourceScopeHash,
        expectedDiscoveryGrammarVersion:
          vectorPacks.expectedDiscoveryGrammarVersion,
      })
      mergeVectorPackSummary(combined, rootSummary)
    } catch (error) {
      if (!vectorPacks.ignoreInvalidRoots || error?.name === "AbortError") throw error
      combined.import_errors.push({
        pluginRoot,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return combined
}

function emptyVectorPackSummary() {
  return {
    packs_considered: 0,
    packs_imported: 0,
    rows_imported: 0,
    rows_skipped_duplicate: 0,
    rows_skipped_missing_chunk: 0,
    import_errors: [],
  }
}

function mergeVectorPackSummary(target, source) {
  target.packs_considered += source.packs_considered
  target.packs_imported += source.packs_imported
  target.rows_imported += source.rows_imported
  target.rows_skipped_duplicate += source.rows_skipped_duplicate
  target.rows_skipped_missing_chunk += source.rows_skipped_missing_chunk
}

function uniquePaths(values) {
  return [...new Set(values.filter((value) =>
    typeof value === "string" && value.trim().length > 0
  ))]
}

function vectorPackImportStatus(summary) {
  return {
    import_state: summary.rows_imported > 0
      ? "imported"
      : summary.packs_imported > 0
        ? "validated"
        : "absent",
    ...summary,
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const err = new Error("operation aborted")
  err.name = "AbortError"
  throw err
}

function docNeedsActiveChunkMetadata(db, docId, doc) {
  const expectedKeys = chunkBody(doc.body).map((chunk) =>
    chunkIdentity({ docPath: doc.path, chunk }).chunk_key
  )
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(
           CASE
             WHEN chunk_key IS NULL OR
                  text_hash IS NULL OR
                  embedding_spec_id IS NULL OR
                  embedding_spec_id != ? OR
                  chunker_id IS NULL OR
                  chunker_id != ? OR
                  normalization_id IS NULL OR
                  normalization_id != ?
             THEN 1 ELSE 0 END
         ), 0) AS stale
       FROM chunks
       WHERE doc_id = ?`,
    )
    .get(
      ACTIVE_EMBEDDING_SPEC.id,
      ACTIVE_EMBEDDING_SPEC.chunker_id,
      ACTIVE_EMBEDDING_SPEC.normalization_id,
      docId,
    )
  if (row.stale > 0) return true
  if (row.total !== expectedKeys.length) return true
  if (expectedKeys.length === 0) return false
  const storedKeys = db
    .prepare(
      `SELECT chunk_key
       FROM chunks
       WHERE doc_id = ?
       ORDER BY chunk_index`,
    )
    .all(docId)
    .map((chunk) => chunk.chunk_key)
  return storedKeys.some((chunkKey, index) => chunkKey !== expectedKeys[index])
}

function docHasMissingActiveEmbeddings(db, docId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS missing
       FROM chunks c
       LEFT JOIN chunk_vecs v ON v.chunk_id = c.id
       LEFT JOIN chunk_embedding_failures f ON ${ACTIVE_CHUNK_FAILURE_JOIN}
       WHERE c.doc_id = ?
         AND (
           v.chunk_id IS NULL OR
           c.embedding_spec_id IS NULL OR
           c.embedding_spec_id != ? OR
           c.chunker_id != ? OR
           c.normalization_id != ?
         )
         AND f.chunk_key IS NULL`,
    )
    .get(
      docId,
      ACTIVE_EMBEDDING_SPEC.id,
      ACTIVE_EMBEDDING_SPEC.chunker_id,
      ACTIVE_EMBEDDING_SPEC.normalization_id,
    )
  return row.missing > 0
}

function indexOneDoc(db, doc, summary) {
  const chunks = chunkBody(doc.body).map((chunk) => ({
    ...chunk,
    ...chunkIdentity({ docPath: doc.path, chunk }),
  }))

  // Upsert in a transaction so a crash mid-doc doesn't leave a half-indexed row.
  const txn = db.transaction(() => {
    // Upsert docs row.
    const upsert = db.prepare(
      `INSERT INTO docs (path, kind, track, task_slug, status, schema_version,
                         created_at, updated_at, hash, mtime, is_archived, frontmatter)
       VALUES (@path, @kind, @track, @task_slug, @status, @schema_version,
               @created_at, @updated_at, @hash, @mtime, @is_archived, @frontmatter)
       ON CONFLICT(path) DO UPDATE SET
         kind=excluded.kind,
         track=excluded.track,
         task_slug=excluded.task_slug,
         status=excluded.status,
         schema_version=excluded.schema_version,
         created_at=excluded.created_at,
         updated_at=excluded.updated_at,
         hash=excluded.hash,
         mtime=excluded.mtime,
         is_archived=excluded.is_archived,
         frontmatter=excluded.frontmatter
       RETURNING id`,
    )
    const row = upsert.get({
      path: doc.path,
      kind: doc.kind,
      track: doc.track,
      task_slug: doc.task_slug,
      status: doc.status,
      schema_version: doc.schema_version,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      hash: doc.hash,
      mtime: doc.mtime,
      is_archived: doc.is_archived ? 1 : 0,
      frontmatter: JSON.stringify(doc.frontmatter),
    })
    const docId = row.id

    // Replace chunks. CASCADE on chunks doesn't fire for ON CONFLICT, so
    // we explicitly delete by doc_id first. The triggers on the chunks
    // table keep chunks_fts in sync; chunk_vecs we update by hand below.
    const oldChunkIds = db
      .prepare("SELECT id FROM chunks WHERE doc_id = ?")
      .all(docId)
      .map((r) => r.id)
    if (oldChunkIds.length) {
      const delVec = db.prepare("DELETE FROM chunk_vecs WHERE chunk_id = ?")
      for (const id of oldChunkIds) delVec.run(id)
    }
    db.prepare("DELETE FROM chunks WHERE doc_id = ?").run(docId)

    const insertChunk = db.prepare(
      `INSERT INTO chunks (
         doc_id,
         chunk_index,
         chunk_key,
         text_hash,
         embedding_spec_id,
         chunker_id,
         normalization_id,
         text,
         heading,
         start_offset,
         end_offset
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]
      insertChunk.get(
        docId,
        c.index,
        c.chunk_key,
        c.text_hash,
        c.embedding_spec_id,
        c.chunker_id,
        c.normalization_id,
        c.text,
        c.heading,
        c.start_offset,
        c.end_offset,
      )
      summary.chunks_inserted += 1
    }
    return docId
  })
  return txn()
}

async function embedMissingVectors(db, opts, summary, docIds) {
  if (docIds.length === 0) return
  const missing = []
  for (let start = 0; start < docIds.length; start += SQLITE_PARAMETER_BATCH_SIZE) {
    const batch = docIds.slice(start, start + SQLITE_PARAMETER_BATCH_SIZE)
    const placeholders = batch.map(() => "?").join(", ")
    const rows = db
      .prepare(
        `SELECT
           c.id,
           c.text,
           c.chunk_key,
           c.text_hash,
           c.embedding_spec_id,
           c.chunker_id,
           c.normalization_id
         FROM chunks c
         LEFT JOIN chunk_vecs v ON v.chunk_id = c.id
         LEFT JOIN chunk_embedding_failures f ON ${ACTIVE_CHUNK_FAILURE_JOIN}
         WHERE v.chunk_id IS NULL
           AND c.doc_id IN (${placeholders})
           AND f.chunk_key IS NULL
         ORDER BY c.id`,
      )
      .all(...batch)
    for (const row of rows) {
      missing.push(row)
    }
  }
  if (missing.length === 0) return

  const embeddingResults = await embedChunksDetailed(
    missing.map((c) => c.text),
    opts.embed ?? {},
  )
  const serviceFailure = embeddingResults.some((result) => (
    result.vector == null && !isChunkLocalEmbeddingFailure(result.diagnostic)
  ))
  if (serviceFailure && summary.semantic_warnings === 0) {
    summary.semantic_warnings += 1
    // One log line per run is enough; downstream tools surface the
    // semantic_unavailable warning at query time.
    console.warn(
      "[desk-mcp] semantic_unavailable: Ollama embeddings endpoint did not respond; index built with FTS5 only",
    )
  }

  const insertVec = db.prepare(
    `INSERT INTO chunk_vecs (chunk_id, embedding) VALUES (?, ?)`,
  )
  const upsertFailure = db.prepare(
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
     VALUES (@chunk_key, @text_hash, @embedding_spec_id, @chunker_id,
             @normalization_id, @reason, @message, @failed_at)
     ON CONFLICT (
       chunk_key,
       text_hash,
       embedding_spec_id,
       chunker_id,
       normalization_id
     ) DO UPDATE SET
       reason = excluded.reason,
       message = excluded.message,
       failed_at = excluded.failed_at`,
  )
  const deleteFailure = db.prepare(
    `DELETE FROM chunk_embedding_failures
     WHERE chunk_key = @chunk_key
       AND text_hash = @text_hash
       AND embedding_spec_id = @embedding_spec_id
       AND chunker_id = @chunker_id
       AND normalization_id = @normalization_id`,
  )
  const failedAt = new Date().toISOString()
  const txn = db.transaction(() => {
    for (let i = 0; i < missing.length; i++) {
      const row = missing[i]
      const result = embeddingResults[i]
      const vec = result.vector
      if (vec) {
        // sqlite-vec's vec0 virtual table requires BigInt for primary-key
        // bind values — plain JS numbers raise "Only integers are allows
        // for primary key values on chunk_vecs".
        insertVec.run(BigInt(row.id), new Float32Array(vec))
        deleteFailure.run(row)
      } else if (isChunkLocalEmbeddingFailure(result.diagnostic)) {
        upsertFailure.run({
          ...row,
          reason: result.diagnostic.reason,
          message: result.diagnostic.message,
          failed_at: failedAt,
        })
        summary.embedding_failures_recorded += 1
      }
    }
  })
  txn()
}

function pruneStaleEmbeddingFailures(db) {
  const result = db.prepare(
    `DELETE FROM chunk_embedding_failures
     WHERE NOT EXISTS (
       SELECT 1
       FROM chunks c
       WHERE c.chunk_key = chunk_embedding_failures.chunk_key
         AND c.text_hash = chunk_embedding_failures.text_hash
         AND c.embedding_spec_id = chunk_embedding_failures.embedding_spec_id
         AND c.chunker_id = chunk_embedding_failures.chunker_id
         AND c.normalization_id = chunk_embedding_failures.normalization_id
     )`,
  ).run()
  return result.changes
}

function refreshRefs(db, docs) {
  const edges = computeRefs(docs)
  const txn = db.transaction(() => {
    db.exec("DELETE FROM refs_graph")
    if (!edges.length) return
    const lookup = db.prepare("SELECT id FROM docs WHERE path = ?")
    const ins = db.prepare(
      "INSERT OR IGNORE INTO refs_graph (src_doc_id, dst_doc_id, ref_kind) VALUES (?, ?, ?)",
    )
    for (const e of edges) {
      ins.run(lookup.get(e.from).id, lookup.get(e.to).id, e.ref_kind)
    }
  })
  txn()
}

/**
 * Check whether the index at `dbPath` is fresh — i.e., no markdown file
 * under `deskRoot` has an mtime newer than the recorded last_indexed_at.
 *
 * Cheap heuristic; the real correctness invariant is the hash-compare
 * inside rebuildIndex. This is just for the boot-time "do we need to do
 * anything?" decision.
 */
export function isDiscoveryGrammarCurrent(db) {
  return getMeta(db, "discovery_grammar_version") === String(DISCOVERY_GRAMMAR_VERSION)
}

export async function isIndexedDocumentTreeCurrent(
  deskRoot,
  db,
  { signal, docs } = {},
) {
  const currentDocs = docs ?? await discover(deskRoot, { signal })
  const indexedDocs = db
    .prepare("SELECT path, hash FROM docs ORDER BY path")
    .all()
  const sortedCurrentDocs = [...currentDocs].sort((left, right) =>
    left.path.localeCompare(right.path)
  )
  if (indexedDocs.length !== sortedCurrentDocs.length) return false
  return indexedDocs.every((doc, index) =>
    doc.path === sortedCurrentDocs[index].path &&
    doc.hash === sortedCurrentDocs[index].hash
  )
}

export async function isIndexFresh(deskRoot, db, { signal, tombstones } = {}) {
  if (!isDiscoveryGrammarCurrent(db)) return false
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'last_indexed_at'")
    .get()
  if (!row) return false
  const indexedMs = Date.parse(row.value)
  if (Number.isNaN(indexedMs)) return false
  const tombstoneStatus = await tombstoneStatusForDocuments({
    pluginRoot: tombstones?.pluginRoot,
    docs: db.prepare("SELECT path, hash FROM docs").all(),
  })
  if (tombstoneStatus.tombstoned) return false
  // Walk discover() targets and bail on the first newer mtime.
  const docs = await discover(deskRoot, { signal })
  if (!await isIndexedDocumentTreeCurrent(deskRoot, db, { signal, docs })) {
    return false
  }
  for (const d of docs) {
    throwIfAborted(signal)
    if (d.mtime > indexedMs) return false
  }
  return true
}
