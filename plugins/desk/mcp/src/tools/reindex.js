// desk_reindex — rebuild the desk-index sqlite db through shared maintenance.
//
// Two modes:
//   - default (no args)     → behaves like ensureIndex (mtime-incremental).
//                             Returns built=false reason=fresh when nothing
//                             has changed since the last pass.
//   - { force: true }       → drops <deskRoot>/.state/desk-index.sqlite then
//                             calls ensureIndex, which sees a missing DB and
//                             rebuilds from scratch (built=true reason=missing).
//   - fresh DB with missing vectors and reachable embeddings → re-embeds the
//                             unchanged docs that were indexed while Ollama
//                             was unavailable (built=true reason=semantic_missing).
//
// Returns: { status, built, reason, docs_indexed, docs_skipped, docs_pruned,
//            ms }. The summary fields are 0 when ensureIndex returned a
// fresh/no-op response — nothing was reindexed in that pass.

import * as path from "node:path"

import { resolveRuntimeMaintenance } from "../indexer/maintenance.js"

/**
 * @param {object} args
 * @param {string} args.deskRoot
 * @param {{ force?: boolean }} [args.input]
 * @param {object} [args.opts] — forwarded to ensureIndex (embed/skipEmbed
 *   injection for tests). Not part of the public MCP input contract.
 */
export async function desk_reindex(args) {
  const {
    deskRoot,
    input,
    opts = {},
    runtimeContext,
  } = args
  const force = !!(input && input.force)
  const start = Date.now()
  const maintenance = resolveRuntimeMaintenance({
    runtimeContext,
    runtimeContextProvided: Object.hasOwn(args, "runtimeContext"),
    opts,
  })
  const ensureOptions = { ...opts }
  const ensured = await maintenance.runExplicitReindex({
    deskRoot: path.resolve(deskRoot),
    force,
    ensureOptions,
  })
  const summary = ensured.summary ?? {}

  return {
    status: "ok",
    built: ensured.built,
    reason: ensured.reason,
    docs_indexed: summary.docs_indexed ?? 0,
    docs_skipped: summary.docs_skipped ?? 0,
    docs_pruned: summary.docs_removed ?? 0,
    chunks_total: ensured.semantic?.chunks_total ?? 0,
    vectors_indexed: ensured.semantic?.vectors_indexed ?? 0,
    missing_vectors: ensured.semantic?.missing_vectors ?? 0,
    semantic_available: ensured.semantic?.embedding_available,
    semantic_diagnostic: ensured.semantic?.embedding_diagnostic,
    ms: Date.now() - start,
  }
}
