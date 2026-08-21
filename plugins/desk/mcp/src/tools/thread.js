// thread.js — desk_thread provenance walk via refs_graph.
//
// W6 Unit 6. The "killer feature" from desk-search-design.md §6 #1:
// follow refs_graph edges from a starting doc and assemble an ordered
// narrative — *"Apr 21 planning → Apr 23 doing → Apr 24 feedback found the
// jitter bug → Apr 25 lesson 'always jitter concurrent retries'."* Google
// can't do this; it has no causal graph over the corpus.
//
// Inputs:
//   start_path (required) — absolute or relative-to-deskRoot doc path
//   depth (optional, default 4) — max BFS hop distance
//   direction (optional, default "both") — "forward" | "backward" | "both"
//
// Behaviour: BFS from the start doc along refs_graph edges in the requested
// direction(s), with cycle detection (BFS visited-set). The start doc itself
// is hop_distance 0 and always appears first in `chain`. Subsequent results
// are sorted by hop_distance ascending, then chronologically (updated_at
// descending) within the same hop.
//
// `why_connected` is a short human-readable phrase derived from the
// ref_kind of the edge that first reached the node — e.g. "planning doc of
// my-task", "doing iteration of my-task", "iteration entry of my-task".
//
// Errors: when start_path isn't in the index, return
//   { error: "not_indexed", note: "<path> isn't in the desk-index. Re-run the indexer or check the path." }
// — consistent with other search-tool error shapes.

import * as path from "node:path"
import { openDb, closeDb } from "../db/init.js"
import { ensureIndex } from "../server-helpers.js"
import { canonicalDocumentPath } from "../indexer/document-tree.js"

const DEFAULT_DEPTH = 4
const MAX_DEPTH = 32

/** Clamp depth to [1, MAX_DEPTH] with a sane default. */
function clampDepth(depth) {
  if (typeof depth !== "number" || !Number.isFinite(depth)) return DEFAULT_DEPTH
  return Math.max(1, Math.min(MAX_DEPTH, Math.floor(depth)))
}

/**
 * Normalize a caller-supplied path against deskRoot. Absolute paths get
 * relativized; relative paths stay as-is. Result uses forward-slash semantics
 * since that's how docs.path is stored by the indexer.
 */
function normalizeStartPath(deskRoot, startPath) {
  if (!startPath) return ""
  if (path.isAbsolute(startPath)) {
    const rel = path.relative(deskRoot, startPath)
    // Don't accept paths that escape deskRoot.
    if (rel.startsWith("..")) return startPath
    return canonicalDocumentPath(rel)
  }
  // Strip leading ./ if present.
  return canonicalDocumentPath(startPath).replace(/^\.\//u, "")
}

/**
 * Translate an edge's ref_kind into a human-readable phrase referencing the
 * target node. `targetSlug` is the task slug of whichever endpoint of the
 * edge identifies the task — for planning/doing/feedback edges, this is the
 * slug of the task.md at the other end of the edge.
 *
 * Examples:
 *   planning_of, task-foo  → "planning doc of task-foo"
 *   doing_of, task-foo     → "doing iteration of task-foo"
 *   feedback_of, task-foo  → "feedback on task-foo"
 *   iteration_of, task-foo → "iteration entry of task-foo"
 *   linked_from_body, X    → "linked from body of X"
 *   <other>_of, slug       → "<other> entry of slug" (generic fallback)
 */
export function describeRefKind(refKind, targetSlug) {
  const slug = targetSlug ?? "task"
  switch (refKind) {
    case "planning_of":
      return `planning doc of ${slug}`
    case "doing_of":
      return `doing iteration of ${slug}`
    case "feedback_of":
      return `feedback on ${slug}`
    case "iteration_of":
      return `iteration entry of ${slug}`
    case "linked_from_body":
      return `linked from body of ${slug}`
    case "predecessor":
      return `predecessor of ${slug}`
    default: {
      // Strip the trailing `_of` for the generic phrase.
      const base = String(refKind ?? "").replace(/_of$/, "")
      if (base) return `${base} entry of ${slug}`
      return `connected to ${slug}`
    }
  }
}

/**
 * Walk the refs_graph from `startDocId` outward up to `depth` hops in the
 * requested direction(s). Returns a Map: docId → { hop_distance, ref_kind,
 * edge_other_id }, where edge_other_id is the doc on the *other* end of the
 * edge that first reached this node. (The start doc has hop_distance 0 and
 * no ref_kind/edge_other_id.)
 *
 * BFS naturally avoids cycles via the visited set.
 */
function bfs(db, startDocId, depth, direction) {
  // Prepared statements for each direction we'll need.
  const fwdStmt = db.prepare(
    "SELECT dst_doc_id AS other_id, ref_kind FROM refs_graph WHERE src_doc_id = ?",
  )
  const bwdStmt = db.prepare(
    "SELECT src_doc_id AS other_id, ref_kind FROM refs_graph WHERE dst_doc_id = ?",
  )

  const visited = new Map()
  visited.set(startDocId, { hop_distance: 0, ref_kind: null, edge_other_id: null })

  let frontier = [startDocId]
  for (let hop = 1; hop <= depth && frontier.length; hop++) {
    const next = []
    for (const cur of frontier) {
      const neighbours = []
      if (direction === "forward" || direction === "both") {
        for (const row of fwdStmt.all(cur)) {
          neighbours.push({ other_id: row.other_id, ref_kind: row.ref_kind })
        }
      }
      if (direction === "backward" || direction === "both") {
        for (const row of bwdStmt.all(cur)) {
          neighbours.push({ other_id: row.other_id, ref_kind: row.ref_kind })
        }
      }
      for (const n of neighbours) {
        if (visited.has(n.other_id)) continue
        visited.set(n.other_id, {
          hop_distance: hop,
          ref_kind: n.ref_kind,
          edge_other_id: cur,
        })
        next.push(n.other_id)
      }
    }
    frontier = next
  }
  return visited
}

function buildThreadRows(visited, metaById, startDocId) {
  const rows = []
  for (const [docId, info] of visited.entries()) {
    const meta = metaById.get(docId)
    if (!meta) continue
    if (docId === startDocId) {
      rows.push({
        path: meta.path,
        kind: meta.kind,
        ref_kind: null,
        hop_distance: 0,
        why_connected: "start",
        updated_at: meta.updated_at,
      })
      continue
    }
    const otherMeta = metaById.get(info.edge_other_id)
    const slug = otherMeta?.task_slug ?? meta.task_slug ?? "task"
    rows.push({
      path: meta.path,
      kind: meta.kind,
      ref_kind: info.ref_kind,
      hop_distance: info.hop_distance,
      why_connected: describeRefKind(info.ref_kind, slug),
      updated_at: meta.updated_at,
    })
  }
  return rows
}

function compareThreadRows(a, b) {
  if (a.hop_distance !== b.hop_distance) {
    return a.hop_distance - b.hop_distance
  }
  const ua = a.updated_at ?? ""
  const ub = b.updated_at ?? ""
  if (ua === ub) return a.path.localeCompare(b.path)
  if (!ua) return 1
  if (!ub) return -1
  return ub.localeCompare(ua)
}

export const __threadInternalsForTests = {
  bfs,
  buildThreadRows,
  clampDepth,
  compareThreadRows,
  normalizeStartPath,
}

/**
 * desk_thread — provenance walk via refs_graph.
 *
 * @param {object} args
 * @param {string} args.deskRoot
 * @param {object} args.input
 * @param {string} args.input.start_path
 * @param {number} [args.input.depth] — default 4
 * @param {"forward"|"backward"|"both"} [args.input.direction] — default "both"
 * @returns {Promise<{ start, chain } | { error, note }>}
 */
export async function desk_thread({ deskRoot, input, ensure = ensureIndex }) {
  const rawPath = String(input?.start_path ?? "").trim()
  if (!rawPath) {
    return {
      error: "invalid_input",
      note: "`start_path` is required",
    }
  }
  const startPath = normalizeStartPath(deskRoot, rawPath)
  const depth = clampDepth(input?.depth)
  const directionRaw = String(input?.direction ?? "both").toLowerCase()
  const direction =
    directionRaw === "forward" || directionRaw === "backward"
      ? directionRaw
      : "both"

  await ensure(deskRoot)
  const db = openDb(deskRoot)
  try {
    const startDoc = db
      .prepare(
        "SELECT id, path, kind, task_slug, updated_at FROM docs WHERE path = ?",
      )
      .get(startPath)
    if (!startDoc) {
      return {
        error: "not_indexed",
        note: `${startPath} isn't in the desk-index. Re-run the indexer or check the path.`,
      }
    }

    const visited = bfs(db, startDoc.id, depth, direction)

    // Hydrate metadata for every visited doc in one query.
    const docIds = [...visited.keys()]
    const placeholders = docIds.map(() => "?").join(",")
    const metaRows = db
      .prepare(
        `SELECT id, path, kind, task_slug, updated_at
         FROM docs WHERE id IN (${placeholders})`,
      )
      .all(...docIds)
    const metaById = new Map(metaRows.map((r) => [r.id, r]))

    // Build chain rows. The start doc has its own shape (no ref_kind /
    // why_connected) but is included as the first element per design.
    const rows = buildThreadRows(visited, metaById, startDoc.id)

    // Sort: start doc first (hop_distance 0), then by hop_distance asc, then
    // by updated_at desc within the same hop. Stable on ties.
    rows.sort(compareThreadRows)

    return {
      start: { path: startDoc.path, kind: startDoc.kind },
      chain: rows,
    }
  } finally {
    closeDb(db)
  }
}
