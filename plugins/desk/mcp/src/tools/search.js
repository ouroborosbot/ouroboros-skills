// Search tools — desk_search / desk_recall / desk_similar / desk_timeline.
//
// W6 Unit 5. Each tool opens the index DB, executes its query, post-ranks in
// JS, and returns a structured payload. The fifth search tool (desk_thread)
// lives in src/tools/thread.js — wired in Unit 6 (provenance walk via
// refs_graph).
//
// Design references (see desk-search-design.md):
//   §4 hybrid ranking — semantic 0.55 + bm25 0.25 + recency 0.12 + state 0.08
//                       + active-iteration-pin (additive +0.30).
//   §6 — most kill-features (synthesis, clustering, contradiction) are post-MVP.
//
// Soft-fail rule: if Ollama is unreachable when embedding the query, the
// search tools degrade. `desk_search` and `desk_timeline` drop the semantic
// component and renormalize. `desk_recall` is semantic-only so it errors
// out. `desk_similar` reads the seed doc's stored embeddings from vec0 (no
// new embedding needed) so it always works as long as the seed itself was
// embedded at index time.

import { promises as fs } from "node:fs"
import * as path from "node:path"
import { resolveRuntimeMaintenance } from "../indexer/maintenance.js"
import { embedQuery } from "../util/embed-query.js"
import {
  clipCosine,
  combineScore,
  cosine,
  normalizeBm25,
  recencyDecay,
  stateBias,
} from "../util/rank.js"

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
const SNIPPET_MAX_CHARS = 280
const SEMANTIC_REPAIR_COMMAND =
  "Start Ollama, pull nomic-embed-text, then run desk_reindex; no force is required after v1.2.2 because missing vectors are repaired automatically."

function semanticUnavailableFields(diagnostic) {
  return {
    semantic_note: diagnostic?.message
      ? `Semantic search unavailable: ${diagnostic.message}`
      : "Semantic search unavailable: embedding service did not return a usable vector",
    semantic_diagnostic: diagnostic ?? null,
    semantic_repair: SEMANTIC_REPAIR_COMMAND,
  }
}

/**
 * Read `<deskRoot>/_meta/featured.md` and return the first track slug listed
 * (one per line). Returns null when absent or empty.
 */
async function readFeaturedTrack(deskRoot) {
  try {
    const raw = await fs.readFile(
      path.join(deskRoot, "_meta", "featured.md"),
      "utf8",
    )
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.length > 0 && !trimmed.startsWith("#")) {
        return trimmed
      }
    }
    return null
  } catch (err) {
    if (err.code === "ENOENT") return null
    throw err
  }
}

/**
 * Find the active-iteration directory (relative to deskRoot) for the
 * featured track's task(s). Per planning Unit 5: "first featured track's
 * active iteration (the most recent iterations.history[] entry with
 * outcome: in-progress)".
 *
 * Returns a Set of relative-path prefixes such that any chunk whose doc.path
 * starts with one of these strings gets the +0.30 pin bonus.
 */
function computePinPrefixes(db, featuredTrack) {
  if (!featuredTrack) {
    return new Set()
  }

  // Pull all task.md docs in the featured track that have iteration history.
  const taskRows = db
    .prepare(
      "SELECT path, frontmatter FROM docs WHERE track = ? AND kind = 'task'",
    )
    .all(featuredTrack)

  const prefixes = new Set()
  for (const row of taskRows) {
    let fm
    const frontmatter =
      typeof row.frontmatter === "string" && row.frontmatter.length
        ? row.frontmatter
        : "{}"
    try {
      fm = JSON.parse(frontmatter)
    } catch {
      continue
    }
    const history = fm?.iterations?.history
    if (!Array.isArray(history)) continue
    // Walk in reverse — most-recent first — and take the first entry
    // with outcome=in-progress (per Unit 5 spec). Tolerate string variants.
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i]
      if (!entry || typeof entry !== "object") continue
      const outcome =
        typeof entry.outcome === "string" ? entry.outcome.toLowerCase() : ""
      if (outcome !== "in-progress") continue
      if (typeof entry.path !== "string" || !entry.path.length) continue
      // entry.path is relative to the task dir (e.g. "./OrderService/...").
      // Normalize against the task dir so we get a desk-root-relative prefix.
      const taskDir = path.dirname(row.path)
      let rel = entry.path.replace(/^\.\//, "")
      const combined = path.join(taskDir, rel)
      prefixes.add(combined)
      break
    }
  }
  return prefixes
}

/** True if `docPath` falls under any of the pin prefixes. */
function isPinned(docPath, pinPrefixes) {
  if (!pinPrefixes.size) {
    return false
  }
  for (const p of pinPrefixes) {
    if (
      docPath === p ||
      docPath.startsWith(p + path.sep) ||
      docPath.startsWith(p + "/")
    ) {
      return true
    }
  }
  return false
}

/** Trim a chunk text to a snippet, preferring sentence-ish boundaries. */
function makeSnippet(text, queryTerms) {
  if (!text) return ""
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= SNIPPET_MAX_CHARS) return flat

  // Try to center the snippet around the first match of any query term.
  const terms = Array.isArray(queryTerms) ? queryTerms : []
  if (terms.length) {
    const lower = flat.toLowerCase()
    for (const term of terms) {
      const t = term.toLowerCase().trim()
      if (!t) continue
      const idx = lower.indexOf(t)
      if (idx < 0) continue
      const start = Math.max(0, idx - Math.floor(SNIPPET_MAX_CHARS / 2))
      const end = Math.min(flat.length, start + SNIPPET_MAX_CHARS)
      const prefix = start > 0 ? "..." : ""
      const suffix = end < flat.length ? "..." : ""
      return prefix + flat.slice(start, end) + suffix
    }
  }
  return flat.slice(0, SNIPPET_MAX_CHARS) + "..."
}

/** Clamp limit to [1, MAX_LIMIT] with a sane default. */
function clampLimit(limit) {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
}

/**
 * Split a query string into FTS5-safe tokens. FTS5 MATCH expressions accept
 * a phrase / boolean grammar; for hybrid search we just want OR-ed terms.
 * We strip punctuation that FTS5 treats as operators and join with OR.
 *
 * Returns `{ matchExpr, terms }` where `matchExpr` is what we feed to MATCH
 * and `terms` is the raw token list used for snippet centering.
 */
function buildFtsQuery(query) {
  const terms = (query ?? "")
    .split(/[^A-Za-z0-9_]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
  if (!terms.length) return { matchExpr: null, terms: [] }
  // Quote each term to neutralize any residual FTS5 operator interpretation;
  // join with OR for a relaxed lexical match.
  const matchExpr = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ")
  return { matchExpr, terms }
}

/**
 * Decode a vec0 BLOB column (Buffer of little-endian Float32 bytes) into a
 * plain number array suitable for cosine().
 */
function decodeEmbedding(buf) {
  if (!buf || !Buffer.isBuffer(buf)) return null
  const f32 = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    Math.floor(buf.length / 4),
  )
  return Array.from(f32)
}

// ---------------------------------------------------------------------------
// Shared candidate-gathering helpers.
// ---------------------------------------------------------------------------

/**
 * Resolve the `scope` parameter to a docs-level filter clause.
 *
 * `scope` values:
 *   "active"   — is_archived = 0 (default for desk_search)
 *   "archived" — is_archived = 1
 *   "all"      — no filter (default for desk_recall, desk_similar, desk_timeline)
 *
 * If the caller passes an unrecognized value, falls back to the toolDefault.
 *
 * @param {string|undefined} scope  caller-supplied value
 * @param {"active"|"archived"|"all"} toolDefault per-tool default
 * @param {string} alias SQL table alias
 * @returns {{sql: string, params: Array}}
 */
function resolveScopeFilter(scope, toolDefault, alias = "d") {
  const resolved = ["active", "archived", "all"].includes(scope)
    ? scope
    : toolDefault
  if (resolved === "all") return { sql: "", params: [] }
  if (resolved === "archived") {
    return { sql: ` AND ${alias}.is_archived = 1`, params: [] }
  }
  // "active" (the default)
  return { sql: ` AND ${alias}.is_archived = 0`, params: [] }
}

/**
 * Build the `WHERE` clause + bind values for the docs-level filter set.
 * Returns `{ sql, params }`. `sql` is empty string when no filters; else
 * starts with " AND ...".
 *
 * Note: `scope` is handled separately by `resolveScopeFilter()` so per-tool
 * defaults can differ. Callers compose the two: `${filterFragment}${scopeFragment}`.
 */
function buildDocsFilter(filters, alias = "d") {
  if (!filters || typeof filters !== "object") return { sql: "", params: [] }
  const clauses = []
  const params = []
  if (filters.track) {
    if (Array.isArray(filters.track)) {
      if (filters.track.length) {
        clauses.push(
          `${alias}.track IN (${filters.track.map(() => "?").join(",")})`,
        )
        params.push(...filters.track)
      }
    } else if (typeof filters.track === "string") {
      clauses.push(`${alias}.track = ?`)
      params.push(filters.track)
    }
  }
  if (filters.status) {
    const arr = Array.isArray(filters.status) ? filters.status : [filters.status]
    const clean = arr.filter((s) => typeof s === "string" && s.length)
    if (clean.length) {
      clauses.push(`${alias}.status IN (${clean.map(() => "?").join(",")})`)
      params.push(...clean)
    }
  }
  if (filters.kind) {
    const arr = Array.isArray(filters.kind) ? filters.kind : [filters.kind]
    const clean = arr.filter((s) => typeof s === "string" && s.length)
    if (clean.length) {
      clauses.push(`${alias}.kind IN (${clean.map(() => "?").join(",")})`)
      params.push(...clean)
    }
  }
  if (filters.since && typeof filters.since === "string") {
    clauses.push(`${alias}.updated_at >= ?`)
    params.push(filters.since)
  }
  if (filters.until && typeof filters.until === "string") {
    clauses.push(`${alias}.updated_at <= ?`)
    params.push(filters.until)
  }
  if (!clauses.length) return { sql: "", params: [] }
  return { sql: " AND " + clauses.join(" AND "), params }
}

/**
 * Gather candidate chunks from FTS5 with raw bm25 scores. Returns rows of
 * `{ chunk_id, doc_id, raw_bm25 }`. Bm25 is sqlite's bm25() — negative
 * floats with lower-magnitude = more relevant (we flip + normalize later).
 *
 * filterFragment is the AND-prefixed snippet from buildDocsFilter; params is
 * its bind values.
 */
function gatherFtsCandidates(db, matchExpr, filterFragment, filterParams, candidateLimit) {
  if (!matchExpr) return []
  const sql = `
    SELECT c.id AS chunk_id, c.doc_id AS doc_id, bm25(chunks_fts) AS raw_bm25
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    JOIN docs d ON d.id = c.doc_id
    WHERE chunks_fts MATCH ? ${filterFragment}
    ORDER BY raw_bm25
    LIMIT ?
  `
  return db.prepare(sql).all(matchExpr, ...filterParams, candidateLimit)
}

/**
 * Gather candidate chunks from sqlite-vec via KNN. Returns rows of
 * `{ chunk_id, distance }`. Caller computes true cosine separately.
 *
 * vec0 doesn't let us filter inside the MATCH (it predates SQLite's
 * generated-column filtering); we over-fetch and let the caller post-filter.
 */
function gatherVecCandidates(db, queryVec, k) {
  if (!queryVec) return []
  const sql = `
    SELECT chunk_id, distance
    FROM chunk_vecs
    WHERE embedding MATCH ? AND k = ?
    ORDER BY distance
  `
  return db.prepare(sql).all(new Float32Array(queryVec), k)
}

/**
 * Hydrate chunk + doc metadata for a set of chunk_ids. Returns a Map
 * chunk_id → row with { doc_path, kind, track, task_slug, status,
 * updated_at, text, heading, embedding (decoded array | null) }.
 */
function hydrateChunks(db, chunkIds) {
  if (!chunkIds.length) return new Map()
  const placeholders = chunkIds.map(() => "?").join(",")
  const rows = db
    .prepare(
      `SELECT c.id AS chunk_id, c.text, c.heading, c.doc_id,
              d.path AS doc_path, d.kind, d.track, d.task_slug,
              d.status, d.updated_at, d.is_archived,
              v.embedding AS embedding
       FROM chunks c
       JOIN docs d ON d.id = c.doc_id
       LEFT JOIN chunk_vecs v ON v.chunk_id = c.id
       WHERE c.id IN (${placeholders})`,
    )
    .all(...chunkIds)
  const out = new Map()
  for (const r of rows) {
    out.set(r.chunk_id, {
      ...r,
      embedding: decodeEmbedding(r.embedding),
    })
  }
  return out
}

/**
 * Re-check a hydrated row against filters (used after KNN gather, which
 * can't filter inside the MATCH).
 */
function passesFilter(row, filters) {
  if (!filters) return true
  if (filters.track) {
    if (Array.isArray(filters.track)) {
      if (filters.track.length && !filters.track.includes(row.track)) return false
    } else if (row.track !== filters.track) {
      return false
    }
  }
  if (filters.status) {
    const arr = Array.isArray(filters.status) ? filters.status : [filters.status]
    if (arr.length && !arr.includes(row.status)) return false
  }
  if (filters.kind) {
    const arr = Array.isArray(filters.kind) ? filters.kind : [filters.kind]
    if (arr.length && !arr.includes(row.kind)) return false
  }
  if (filters.since && row.updated_at && row.updated_at < filters.since) return false
  if (filters.until && row.updated_at && row.updated_at > filters.until) return false
  return true
}

/**
 * Post-filter a hydrated row by scope. Used after KNN gather where the
 * is_archived filter couldn't be expressed inside the vec0 MATCH.
 */
function passesScope(row, scope, toolDefault) {
  const resolved = ["active", "archived", "all"].includes(scope) ? scope : toolDefault
  if (resolved === "all") return true
  const archived = row.is_archived ? true : false
  if (resolved === "archived") return archived
  return !archived
}

function shouldReplaceBest(existing, score) {
  return !existing || score > existing.score
}

function comparableUpdatedAt(row) {
  return typeof row.updated_at === "string" ? row.updated_at : ""
}

function firstChunkText(row) {
  return typeof row.text === "string" ? row.text : ""
}

// ---------------------------------------------------------------------------
// Tool: desk_search
// ---------------------------------------------------------------------------

/**
 * desk_search — hybrid lexical + semantic + recency + state-bias + pin.
 *
 * Input:
 *   { query: string, filters?: {track,status,kind,since,until}, limit?: number }
 *
 * Returns:
 *   { results: [...], semantic_unavailable: boolean, latency_ms: number,
 *     query: string }
 */
export async function desk_search(args) {
  const { deskRoot, input, opts, runtimeContext } = args
  const maintenance = resolveRuntimeMaintenance({
    runtimeContext,
    runtimeContextProvided: Object.hasOwn(args, "runtimeContext"),
    opts,
  })
  const t0 = Date.now()
  const query = String(input?.query ?? "").trim()
  if (!query) {
    return {
      results: [],
      semantic_unavailable: false,
      latency_ms: 0,
      query: "",
      note: "empty query",
    }
  }
  const limit = clampLimit(input?.limit)
  const filters = input?.filters ?? null
  const scope = input?.scope
  const now = opts?.now ?? Date.now()
  const rootLease = maintenance.acquireRootLease(deskRoot)

  const {
    vector: queryVec,
    available: semanticAvailable,
    diagnostic: semanticDiagnostic,
  } = await embedQuery(
    query,
    opts?.embed ?? {},
  )
  return maintenance.runFreshRead({
    rootLease,
    ensureOptions: { embed: opts?.embed ?? {} },
    async read(db, _index, { deskRoot: canonicalDeskRoot }) {
      const { matchExpr, terms } = buildFtsQuery(query)
      const filter = buildDocsFilter(filters)
      // desk_search default: active. Day-to-day signal; archive on opt-in.
      const scopeFilter = resolveScopeFilter(scope, "active")

      // Gather candidates from both backends. Over-fetch — we'll re-rank in JS.
      const ftsCandidates = gatherFtsCandidates(
        db,
        matchExpr,
        filter.sql + scopeFilter.sql,
        [...filter.params, ...scopeFilter.params],
        limit * 4,
      )
      const vecCandidates = semanticAvailable
        ? gatherVecCandidates(db, queryVec, limit * 4)
        : []

      // Union the chunk_ids; hydrate once.
      const idSet = new Set()
      for (const r of ftsCandidates) idSet.add(r.chunk_id)
      for (const r of vecCandidates) idSet.add(r.chunk_id)
      const chunkIds = [...idSet]
      const hydrated = hydrateChunks(db, chunkIds)

      // Normalize BM25 over the FTS candidate set.
      const bm25ByChunk = new Map()
      const bm25Raw = ftsCandidates.map((r) => r.raw_bm25)
      const bm25Norm = normalizeBm25(bm25Raw)
      ftsCandidates.forEach((r, i) => bm25ByChunk.set(r.chunk_id, bm25Norm[i]))

      // Compute true cosine for each candidate that has an embedding.
      const cosByChunk = new Map()
      if (semanticAvailable) {
        for (const [id, row] of hydrated) {
          cosByChunk.set(id, clipCosine(cosine(queryVec, row.embedding)))
        }
      }

      // Active-iteration pin.
      const featuredTrack = await readFeaturedTrack(canonicalDeskRoot)
      const pinPrefixes = computePinPrefixes(db, featuredTrack)

      // Score every candidate and pick top-N. We dedupe by doc_id so a single
      // doc with many matching chunks doesn't crowd out the result list — keep
      // the best chunk per doc.
      const bestByDoc = new Map()
      for (const [id, row] of hydrated) {
        if (!passesFilter(row, filters)) continue
        if (!passesScope(row, scope, "active")) continue
        const parts = {
          semantic: cosByChunk.get(id) ?? 0,
          bm25: bm25ByChunk.get(id) ?? 0,
          recency: recencyDecay(row.updated_at, now),
          state: stateBias(row.status),
          pin: isPinned(row.doc_path, pinPrefixes),
          semanticAvailable,
        }
        const { score, breakdown } = combineScore(parts)
        const existing = bestByDoc.get(row.doc_id)
        if (shouldReplaceBest(existing, score)) {
          bestByDoc.set(row.doc_id, {
            path: row.doc_path,
            kind: row.kind,
            track: row.track,
            task_slug: row.task_slug,
            status: row.status,
            updated_at: row.updated_at,
            snippet: makeSnippet(row.text, terms),
            score,
            score_breakdown: breakdown,
          })
        }
      }

      const results = [...bestByDoc.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)

      return {
        query,
        results,
        search_mode: semanticAvailable ? "hybrid" : "lexical",
        semantic_unavailable: !semanticAvailable,
        latency_ms: Date.now() - t0,
        ...(!semanticAvailable ? semanticUnavailableFields(semanticDiagnostic) : {}),
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Tool: desk_recall
// ---------------------------------------------------------------------------

/**
 * desk_recall — semantic-only "do I remember anything about X" lookup.
 *
 * Per design §6 #4 the long-term plan is HDBSCAN clustering with one-line
 * cluster labels. MVP simplification (planning Unit 5): return top-N by
 * cosine, no clustering. Documented inline. The `cluster_count` field is
 * always equal to the result count in MVP — a future PR can swap clustering
 * in without changing the tool's response shape.
 *
 * Input: { topic: string, limit?: number }
 * Returns: { results, cluster_count?, semantic_unavailable } OR an error
 *   payload when Ollama is down.
 */
export async function desk_recall(args) {
  const { deskRoot, input, opts, runtimeContext } = args
  const maintenance = resolveRuntimeMaintenance({
    runtimeContext,
    runtimeContextProvided: Object.hasOwn(args, "runtimeContext"),
    opts,
  })
  const t0 = Date.now()
  const topic = String(input?.topic ?? "").trim()
  if (!topic) {
    return { results: [], note: "empty topic" }
  }
  const limit = clampLimit(input?.limit)
  const scope = input?.scope
  const rootLease = maintenance.acquireRootLease(deskRoot)

  const {
    vector: queryVec,
    available,
    diagnostic: semanticDiagnostic,
  } = await embedQuery(topic, opts?.embed ?? {})
  return maintenance.runFreshRead({
    rootLease,
    ensureOptions: { embed: opts?.embed ?? {} },
    read(db) {
      if (!available) {
        return {
          error: "semantic_unavailable",
          note: "Recall requires semantic search; the embedding service is unavailable.",
          ...semanticUnavailableFields(semanticDiagnostic),
          latency_ms: Date.now() - t0,
        }
      }

      // Over-fetch a wider net (limit * 3 per spec) — clustering would dedupe
      // down; MVP just dedupes by doc_id and takes top-limit. desk_recall
      // default: "all" — this IS the historical/lookback tool; archive
      // should be searched by default.
      const vecRows = gatherVecCandidates(db, queryVec, limit * 3)
      const chunkIds = vecRows.map((r) => r.chunk_id)
      const hydrated = hydrateChunks(db, chunkIds)

      const bestByDoc = new Map()
      for (const row of hydrated.values()) {
        if (!passesScope(row, scope, "all")) continue
        const score = clipCosine(cosine(queryVec, row.embedding))
        const existing = bestByDoc.get(row.doc_id)
        if (shouldReplaceBest(existing, score)) {
          bestByDoc.set(row.doc_id, {
            path: row.doc_path,
            kind: row.kind,
            snippet: makeSnippet(row.text, [topic]),
            score,
          })
        }
      }

      const results = [...bestByDoc.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)

      return {
        topic,
        results,
        cluster_count: results.length, // MVP: 1:1 with results
        latency_ms: Date.now() - t0,
        note:
          "clustering deferred to a follow-up — see desk-search-design §6 #4. " +
          "cluster_count equals results.length until HDBSCAN lands.",
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Tool: desk_similar
// ---------------------------------------------------------------------------

/**
 * desk_similar — "more like this" against a given doc path.
 *
 * Strategy: read the seed doc's chunk embeddings out of vec0; average them
 * into a centroid; KNN-search against the rest of vec0 excluding the seed
 * doc's own chunks; rank by cosine. Centroid > first-chunk-only because
 * task docs often have boilerplate frontmatter at the top — using the doc's
 * entire embedded body better captures what the doc is "about".
 *
 * Input: { path: string, limit?: number }
 * Returns: { results, latency_ms } OR error when path is unknown OR when
 *   the seed has no embeddings (Ollama was down at index time).
 */
export async function desk_similar(args) {
  const { deskRoot, input, opts, runtimeContext } = args
  const maintenance = resolveRuntimeMaintenance({
    runtimeContext,
    runtimeContextProvided: Object.hasOwn(args, "runtimeContext"),
    opts,
  })
  const t0 = Date.now()
  const seedPath = String(input?.path ?? "").trim()
  if (!seedPath) {
    return { error: "invalid_input", note: "`path` is required" }
  }
  const limit = clampLimit(input?.limit)
  const scope = input?.scope

  return maintenance.runFreshRead({
    deskRoot: path.resolve(deskRoot),
    ensureOptions: { embed: opts?.embed ?? {} },
    read(db) {
      const seedDoc = db
        .prepare("SELECT id, path, kind, track, task_slug FROM docs WHERE path = ?")
        .get(seedPath)
      if (!seedDoc) {
        return {
          error: "not_found",
          note: `path not in index: ${seedPath}`,
          latency_ms: Date.now() - t0,
        }
      }

      // Pull seed embeddings.
      const seedRows = db
        .prepare(
          `SELECT v.chunk_id, v.embedding
           FROM chunks c
           JOIN chunk_vecs v ON v.chunk_id = c.id
           WHERE c.doc_id = ?`,
        )
        .all(seedDoc.id)
      const seedEmbeddings = seedRows
        .map((r) => decodeEmbedding(r.embedding))
        .filter((e) => e != null)
      if (!seedEmbeddings.length) {
        return {
          error: "semantic_unavailable",
          note:
            "seed doc has no embeddings; the index was built while semantic embeddings were unavailable.",
          semantic_repair: SEMANTIC_REPAIR_COMMAND,
          latency_ms: Date.now() - t0,
        }
      }

      const dim = seedEmbeddings[0].length
      const centroid = new Array(dim).fill(0)
      for (const e of seedEmbeddings) {
        for (let i = 0; i < dim; i++) centroid[i] += e[i]
      }
      for (let i = 0; i < dim; i++) centroid[i] /= seedEmbeddings.length

      // Set of seed chunk_ids to exclude.
      const seedChunkIds = new Set(seedRows.map((r) => r.chunk_id))

      // KNN — over-fetch since we drop seed chunks + dedupe by doc.
      const vecRows = gatherVecCandidates(db, centroid, (limit + seedChunkIds.size + 5) * 3)
      const chunkIds = vecRows
        .map((r) => r.chunk_id)
        .filter((id) => !seedChunkIds.has(id))
      const hydrated = hydrateChunks(db, chunkIds)

      const bestByDoc = new Map()
      for (const row of hydrated.values()) {
        // desk_similar default: "all" — similarity has no time/status semantic;
        // when asking "what's like this doc" we want the full corpus.
        if (!passesScope(row, scope, "all")) continue
        const score = clipCosine(cosine(centroid, row.embedding))
        const existing = bestByDoc.get(row.doc_id)
        if (shouldReplaceBest(existing, score)) {
          bestByDoc.set(row.doc_id, {
            path: row.doc_path,
            kind: row.kind,
            track: row.track,
            task_slug: row.task_slug,
            status: row.status,
            updated_at: row.updated_at,
            snippet: makeSnippet(row.text, []),
            score,
          })
        }
      }

      const results = [...bestByDoc.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)

      return {
        seed: seedPath,
        results,
        latency_ms: Date.now() - t0,
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Tool: desk_timeline
// ---------------------------------------------------------------------------

/**
 * desk_timeline — temporal slice. With `query`: hybrid search within the
 * window. Without `query`: bare chronological listing of docs touched in
 * the window.
 *
 * Input: { from: ISO, to: ISO, query?: string, limit?: number }
 * Returns: { results, semantic_unavailable, latency_ms }
 */
export async function desk_timeline(args) {
  const { deskRoot, input, opts, runtimeContext } = args
  const maintenance = resolveRuntimeMaintenance({
    runtimeContext,
    runtimeContextProvided: Object.hasOwn(args, "runtimeContext"),
    opts,
  })
  const t0 = Date.now()
  const from = String(input?.from ?? "").trim() || null
  const to = String(input?.to ?? "").trim() || null
  const query = String(input?.query ?? "").trim()
  const limit = clampLimit(input?.limit)
  const scope = input?.scope
  const now = opts?.now ?? Date.now()
  const rootLease = maintenance.acquireRootLease(deskRoot)

  let semanticAvailable = false
  let semanticDiagnostic = null
  let queryVec = null
  if (query) {
    const r = await embedQuery(query, opts?.embed ?? {})
    semanticAvailable = r.available
    queryVec = r.vector
    semanticDiagnostic = r.diagnostic
  }

  return maintenance.runFreshRead({
    rootLease,
    ensureOptions: { embed: opts?.embed ?? {} },
    read(db) {
      // Window filter clauses for the docs table + scope filter.
      // desk_timeline default: "all" — timeline is already temporally bounded;
      // archive items in the window are legitimate timeline entries.
      const params = []
      const clauses = []
      if (from) {
        clauses.push("d.updated_at >= ?")
        params.push(from)
      }
      if (to) {
        clauses.push("d.updated_at <= ?")
        params.push(to)
      }
      const scopeFilter = resolveScopeFilter(scope, "all")
      const windowSql = (clauses.length ? " AND " + clauses.join(" AND ") : "") + scopeFilter.sql
      params.push(...scopeFilter.params)

      let candidateChunks = []
      if (query) {
        // Hybrid path: FTS within the window + semantic over candidates.
        const { matchExpr, terms } = buildFtsQuery(query)
        const ftsRows = matchExpr
          ? db
              .prepare(
                `SELECT c.id AS chunk_id, c.doc_id, bm25(chunks_fts) AS raw_bm25
                 FROM chunks_fts
                 JOIN chunks c ON c.id = chunks_fts.rowid
                 JOIN docs d ON d.id = c.doc_id
                 WHERE chunks_fts MATCH ? ${windowSql}
                 ORDER BY raw_bm25
                 LIMIT ?`,
              )
              .all(matchExpr, ...params, limit * 4)
          : []
        const vecRows = semanticAvailable
          ? gatherVecCandidates(db, queryVec, limit * 4)
          : []
        const idSet = new Set()
        for (const r of ftsRows) idSet.add(r.chunk_id)
        for (const r of vecRows) idSet.add(r.chunk_id)
        const chunkIds = [...idSet]
        const hydrated = hydrateChunks(db, chunkIds)

        const bm25ByChunk = new Map()
        const bm25Norm = normalizeBm25(ftsRows.map((r) => r.raw_bm25))
        ftsRows.forEach((r, i) => bm25ByChunk.set(r.chunk_id, bm25Norm[i]))

        const cosByChunk = new Map()
        if (semanticAvailable) {
          for (const [id, row] of hydrated) {
            cosByChunk.set(id, clipCosine(cosine(queryVec, row.embedding)))
          }
        }

        const bestByDoc = new Map()
        for (const [id, row] of hydrated) {
          // Re-apply window + scope checks (vec candidates aren't filtered upstream).
          if (from && row.updated_at && row.updated_at < from) continue
          if (to && row.updated_at && row.updated_at > to) continue
          if (!passesScope(row, scope, "all")) continue
          const parts = {
            semantic: cosByChunk.get(id) ?? 0,
            bm25: bm25ByChunk.get(id) ?? 0,
            recency: recencyDecay(row.updated_at, now),
            state: stateBias(row.status),
            pin: false, // timeline doesn't pin
            semanticAvailable,
          }
          const { score, breakdown } = combineScore(parts)
          const existing = bestByDoc.get(row.doc_id)
          if (shouldReplaceBest(existing, score)) {
            bestByDoc.set(row.doc_id, {
              path: row.doc_path,
              kind: row.kind,
              track: row.track,
              task_slug: row.task_slug,
              status: row.status,
              updated_at: row.updated_at,
              snippet: makeSnippet(row.text, terms),
              score,
              score_breakdown: breakdown,
            })
          }
        }
        candidateChunks = [...bestByDoc.values()]
          // Within timeline, sort by updated_at DESC per spec (recency
          // dominates inside an explicit window — score-driven ordering
          // makes more sense for desk_search where the window is implicit).
          .sort((a, b) => comparableUpdatedAt(b).localeCompare(comparableUpdatedAt(a)))
          .slice(0, limit)
      } else {
        // No query — straight chronological listing within the window.
        const rows = db
          .prepare(
            `SELECT d.id AS doc_id, d.path AS doc_path, d.kind, d.track,
                    d.task_slug, d.status, d.updated_at,
                    (SELECT text FROM chunks WHERE doc_id = d.id ORDER BY chunk_index LIMIT 1) AS text
             FROM docs d
             WHERE 1=1 ${windowSql}
             ORDER BY d.updated_at DESC
             LIMIT ?`,
          )
          .all(...params, limit)
        candidateChunks = rows.map((r) => ({
          path: r.doc_path,
          kind: r.kind,
          track: r.track,
          task_slug: r.task_slug,
          status: r.status,
          updated_at: r.updated_at,
          snippet: makeSnippet(firstChunkText(r), []),
        }))
      }

      return {
        from,
        to,
        query: query || null,
        results: candidateChunks,
        search_mode: query ? (semanticAvailable ? "hybrid" : "lexical") : "temporal",
        semantic_unavailable: query ? !semanticAvailable : false,
        latency_ms: Date.now() - t0,
        ...(query && !semanticAvailable
          ? semanticUnavailableFields(semanticDiagnostic)
          : {}),
      }
    },
  })
}

export const __searchInternalsForTests = {
  buildDocsFilter,
  buildFtsQuery,
  clampLimit,
  computePinPrefixes,
  decodeEmbedding,
  gatherFtsCandidates,
  gatherVecCandidates,
  hydrateChunks,
  isPinned,
  makeSnippet,
  passesFilter,
  passesScope,
  readFeaturedTrack,
  resolveScopeFilter,
  semanticUnavailableFields,
  shouldReplaceBest,
  comparableUpdatedAt,
  firstChunkText,
}
