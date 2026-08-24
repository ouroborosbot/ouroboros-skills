// server-helpers.js — pieces of server.js that the search tools call into.
//
// Split out from server.js so `src/tools/search.js` can call ensureIndex()
// without creating an import cycle (server.js imports the search tools, the
// search tools need ensureIndex, ensureIndex used to live in server.js).

import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { closeDb, getMeta, indexDbPath, openDb, setMeta } from "./db/init.js"
import {
  DISCOVERY_GRAMMAR_VERSION,
  discover,
  discoverStatInventory,
} from "./indexer/discover.js"
import { documentTreeHash } from "./indexer/document-tree.js"
import {
  isIndexFresh,
  rebuildIndex,
} from "./indexer/index.js"
import { filterTombstonedDocuments } from "./artifacts/tombstones.js"
import { probeEmbeddingService } from "./indexer/embed.js"
import { ACTIVE_EMBEDDING_SPEC } from "./indexer/spec.js"
import { restoreSnapshotToState } from "./snapshots/restore.js"

const EMBEDDING_GENERATION_FAILURE_DIAGNOSTIC = {
  reason: "embedding_generation_failed",
  message: "one or more document embeddings could not be generated during rebuild",
}
const VECTOR_PACK_NOOP_REPAIR_SIGNATURE_META_KEY =
  "vector_pack_noop_repair_signature"
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_MCP_ROOT = path.resolve(MODULE_DIR, "..")
const DEFAULT_PLUGIN_ROOT = path.resolve(DEFAULT_MCP_ROOT, "..")
const SNAPSHOT_DB_SCHEMA = { id: "desk-index-sqlite-v1", version: 1 }
const SNAPSHOT_SQLITE_VEC_TABLE = "vec0"
const SNAPSHOT_PORTABLE_RUNTIME = Object.freeze({
  platform: "portable",
  arch: "portable",
  node_abi: "portable",
})
const ARTIFACT_SOURCE_SCOPE_PATHS = Object.freeze([
  "plugins/desk/mcp/src/artifacts/tombstones.js",
  "plugins/desk/mcp/src/indexer/chunk.js",
  "plugins/desk/mcp/src/indexer/discover.js",
  "plugins/desk/mcp/src/indexer/document-tree.js",
  "plugins/desk/mcp/src/indexer/exclusions.js",
  "plugins/desk/mcp/src/indexer/index.js",
  "plugins/desk/mcp/src/indexer/refs.js",
  "plugins/desk/mcp/src/indexer/vector-packs.js",
  "plugins/desk/mcp/src/snapshots/manifest.js",
  "plugins/desk/mcp/src/snapshots/restore.js",
  "plugins/desk/mcp/src/artifacts/artifact-scripts.js",
  "plugins/desk/mcp/src/artifacts/policy.js",
  "plugins/desk/mcp/scripts/build-vector-pack.js",
  "plugins/desk/mcp/scripts/build-snapshot.js",
  "plugins/desk/mcp/scripts/verify-snapshot.js",
  "plugins/desk/mcp/scripts/validate-artifacts.js",
  "plugins/desk/mcp/src/db/schema.sql",
  "plugins/desk/mcp/package.json",
  "plugins/desk/mcp/package-lock.json",
])
let configuredArtifactPluginRoot = null

/**
 * Bring the on-disk index up to date for `deskRoot`. Idempotent: when the
 * DB exists and its document path/hash set exactly matches current discovery,
 * does nothing. Called at server-boot and re-called at the top of each search
 * tool invocation so single-process callers see a consistent view after writes.
 *
 * @param {string} deskRoot
 * @param {object} [opts]
 * @param {object} [opts.embed] — forwarded to rebuildIndex (test injection).
 * @param {boolean} [opts.skipEmbed] — skip embedding when (re)building.
 * @param {object} [opts.vectorPacks] — forwarded to rebuildIndex.
 * @param {{ path: string, key: string }} [rootIdentity] — retained maintenance lease for freshness-cache coordination.
 * @returns {Promise<{ built: boolean, reason: string,
 *                     summary?: import("./indexer/index.js").RebuildSummary,
 *                     semantic?: object }>}
 *   When `built=true`, `summary` carries the rebuildIndex counts. When
 *   `built=false` (fresh), `summary` is omitted — nothing was reindexed.
 */
export async function ensureIndex(deskRoot, opts = {}, rootIdentity) {
  const effectiveOpts = resolveEnsureIndexOptions(opts, { deskRoot })
  const dbPath = indexDbPath(deskRoot)
  let snapshot = null
  let dbExisted = existsSync(dbPath)
  throwIfAborted(effectiveOpts.signal)
  if (!dbExisted && effectiveOpts.snapshots?.pluginRoot) {
    snapshot = await restoreSnapshotWithFallback({
      deskRoot,
      ...effectiveOpts.snapshots,
    })
    dbExisted = existsSync(dbPath)
  }
  throwIfAborted(effectiveOpts.signal)
  const db = openDb(deskRoot)
  try {
    const rebaseRestoredSnapshot =
      snapshot?.restored && !snapshotNeedsReconcile(snapshot)
    if (rebaseRestoredSnapshot) {
      await markRestoredSnapshotFresh(deskRoot, db, effectiveOpts.signal)
    }
    const semanticBefore = getSemanticCoverage(db)
    let repairMissing = false
    if (dbExisted) {
      const fresh = await isIndexFresh(deskRoot, db, {
        rootIdentity,
        signal: effectiveOpts.signal,
        tombstones: effectiveOpts.tombstones,
      })
      if (fresh && !snapshotNeedsReconcile(snapshot)) {
        const repair = await maybeRepairMissingEmbeddings(
          deskRoot,
          db,
          effectiveOpts,
          semanticBefore,
          rootIdentity,
        )
        if (repair) return withSnapshot(repair, snapshot)
        if (
          semanticBefore.missing_vectors > 0 &&
          semanticBefore.repairable_missing_vectors === 0
        ) {
          semanticBefore.embedding_available = true
        }
        if (snapshot?.restored) {
          return withSnapshot(
            { built: false, reason: "snapshot_restored", semantic: semanticBefore },
            snapshot,
          )
        }
        return withSnapshot(
          { built: false, reason: "fresh", semantic: semanticBefore },
          snapshot,
        )
      }
      repairMissing = await shouldRepairMissingEmbeddings(db, effectiveOpts, semanticBefore)
    }
    const summary = await rebuildIndex(deskRoot, {
      ...effectiveOpts,
      db,
      reembedMissing: repairMissing,
      rootIdentity,
    })
    const semanticAfter = getSemanticCoverage(db)
    assignEmbeddingAvailability(semanticAfter, semanticBefore, summary)
    rememberVectorPackNoopRepair(db, effectiveOpts, summary, semanticAfter)
    const result = {
      built: true,
      reason: snapshot?.restored ? "stale_snapshot_reconciled" : dbExisted ? "stale" : "missing",
      summary,
      semantic: semanticAfter,
      vector_packs: summary.vector_packs,
    }
    const fallback = fallbackFor(effectiveOpts, snapshot, summary.vector_packs)
    if (fallback === "vector_packs") {
      result.vector_packs = fallbackVectorPackStatus(summary.vector_packs)
    }
    if (snapshot?.restored) {
      result.snapshot = {
        ...snapshot,
        reconciled: true,
      }
      if (fallback) result.fallback = fallback
    } else {
      return withSnapshot(result, snapshot, fallback)
    }
    return result
  } finally {
    closeDb(db)
  }
}

export function resolveEnsureIndexOptions(opts = {}, context = {}) {
  const pluginRoot = resolveArtifactPluginRoot(opts)
  const workspaceArtifactRoot = resolveWorkspaceArtifactRoot(opts, context)
  const effective = { ...opts }
  effective.snapshots = resolveSnapshotOptions({
    opts,
    pluginRoot,
    workspaceArtifactRoot,
    deskRoot: context.deskRoot,
    signal: opts.signal,
  })
  effective.vectorPacks = resolveVectorPackOptions({
    opts,
    pluginRoot,
    workspaceArtifactRoot,
  })
  effective.tombstones = {
    pluginRoot,
    ...(opts.tombstones ?? {}),
  }
  return effective
}

export function configureRuntimeArtifacts({ pluginRoot } = {}) {
  configuredArtifactPluginRoot = textOrNull(pluginRoot)
    ? path.resolve(pluginRoot)
    : null
  return { pluginRoot: configuredArtifactPluginRoot }
}

function snapshotNeedsReconcile(snapshot) {
  if (!snapshot?.restored) return false
  return snapshot.freshness?.artifact_source_scope === "stale" ||
    snapshot.freshness?.document_tree === "stale" ||
    snapshot.freshness?.discovery_grammar === "stale"
}

function resolveSnapshotOptions({ opts, pluginRoot, workspaceArtifactRoot, deskRoot, signal }) {
  if (opts.snapshots === false || opts.snapshots === null) return undefined
  if (opts.snapshots !== undefined) {
    return {
      ...defaultSnapshotCompatibilityContext({ deskRoot, pluginRoot, signal }),
      pluginRoot,
      ...opts.snapshots,
    }
  }
  const artifactRoots = rootsWithArtifacts({
    roots: [workspaceArtifactRoot, pluginRoot],
    hasArtifacts: hasSnapshotArtifacts,
  })
  if (artifactRoots.length === 0) return undefined
  return {
    pluginRoot: artifactRoots[0],
    fallbackPluginRoots: artifactRoots.slice(1),
    ignoreInvalidRoots: true,
    ...defaultSnapshotCompatibilityContext({ deskRoot, pluginRoot, signal }),
  }
}

function resolveVectorPackOptions({ opts, pluginRoot, workspaceArtifactRoot }) {
  if (opts.vectorPacks === false || opts.vectorPacks === null) return undefined
  const compatibility = {
    expectedArtifactSourceScopeHash: artifactSourceScopeHash(),
    expectedDiscoveryGrammarVersion: DISCOVERY_GRAMMAR_VERSION,
  }
  if (opts.vectorPacks !== undefined) {
    return {
      pluginRoot,
      ...compatibility,
      ...opts.vectorPacks,
    }
  }
  const artifactRoots = rootsWithArtifacts({
    roots: [workspaceArtifactRoot, pluginRoot],
    hasArtifacts: hasVectorPackArtifacts,
  })
  if (artifactRoots.length === 0) return undefined
  return {
    pluginRoot: artifactRoots[0],
    fallbackPluginRoots: artifactRoots.slice(1),
    ignoreInvalidRoots: true,
    ...compatibility,
  }
}

function resolveArtifactPluginRoot(opts) {
  return path.resolve(
    textOrNull(opts.snapshots?.pluginRoot) ??
      textOrNull(opts.vectorPacks?.pluginRoot) ??
      textOrNull(opts.tombstones?.pluginRoot) ??
      textOrNull(process.env.DESK_PLUGIN_ROOT) ??
      configuredArtifactPluginRoot ??
      DEFAULT_PLUGIN_ROOT,
  )
}

function resolveWorkspaceArtifactRoot(opts, context) {
  const explicit = textOrNull(opts.workspaceArtifactRoot) ??
    textOrNull(process.env.DESK_WORKSPACE_ARTIFACT_ROOT)
  if (explicit) return path.resolve(explicit)
  return textOrNull(context.deskRoot) ? path.resolve(context.deskRoot) : null
}

function rootsWithArtifacts({ roots, hasArtifacts }) {
  const out = []
  for (const root of roots) {
    if (!textOrNull(root)) continue
    const resolved = path.resolve(root)
    if (!out.includes(resolved) && hasArtifacts(resolved)) out.push(resolved)
  }
  return out
}

async function restoreSnapshotWithFallback({
  pluginRoot,
  fallbackPluginRoots = [],
  ignoreInvalidRoots = false,
  ...context
}) {
  const roots = [pluginRoot, ...fallbackPluginRoots].filter((root) => textOrNull(root))
  let firstMiss = { restored: false, reason: "no_compatible_snapshot" }
  for (const root of roots) {
    const result = await restoreSnapshotToState({ pluginRoot: root, ...context })
    if (result.restored || !ignoreInvalidRoots) return result
    if (firstMiss.reason === "no_compatible_snapshot") firstMiss = result
  }
  return firstMiss
}

function defaultSnapshotCompatibilityContext({ deskRoot, pluginRoot, signal } = {}) {
  return {
    expectedDbSchema: SNAPSHOT_DB_SCHEMA,
    expectedSqliteVec: {
      package: "sqlite-vec",
      version: sqliteVecVersion(),
      table: SNAPSHOT_SQLITE_VEC_TABLE,
    },
    expectedRuntime: SNAPSHOT_PORTABLE_RUNTIME,
    expectedArtifactSourceScopeHash: artifactSourceScopeHash(),
    expectedDocumentTreeHash: () =>
      currentDocumentTreeHash(deskRoot, pluginRoot, signal),
    expectedDiscoveryGrammarVersion: DISCOVERY_GRAMMAR_VERSION,
  }
}

async function currentDocumentTreeHash(deskRoot, pluginRoot, signal) {
  const discovered = await discover(deskRoot, { signal })
  const filtered = await filterTombstonedDocuments({
    pluginRoot,
    docs: discovered,
  })
  return documentTreeHash(filtered.docs)
}

async function markRestoredSnapshotFresh(deskRoot, db, signal) {
  const docs = await discoverStatInventory(deskRoot, { signal })
  const newestDocMtime = docs.reduce((max, doc) => Math.max(max, doc.mtime), 0)
  const indexedAtMs = Math.max(Date.now(), newestDocMtime)
  setMeta(db, "last_indexed_at", new Date(indexedAtMs).toISOString())
}

function artifactSourceScopeHash() {
  const hash = createHash("sha256")
  for (const repoPath of ARTIFACT_SOURCE_SCOPE_PATHS) {
    const relFromMcp = repoPath.replace(/^plugins\/desk\/mcp\//u, "")
    hash.update(`${repoPath}\0`)
    hash.update(readFileSync(path.join(DEFAULT_MCP_ROOT, relFromMcp)))
    hash.update("\0")
  }
  return `sha256:${hash.digest("hex")}`
}

function normalizeArtifactPath(value) {
  return value.replaceAll(path.sep, "/")
}

function sqliteVecVersion() {
  const packageLock = JSON.parse(
    readFileSync(path.join(DEFAULT_MCP_ROOT, "package-lock.json"), "utf8"),
  )
  return packageLock.packages?.["node_modules/sqlite-vec"]?.version
}

function hasSnapshotArtifacts(pluginRoot) {
  return hasArtifactFiles(
    path.join(pluginRoot, "artifacts", "snapshots", ACTIVE_EMBEDDING_SPEC.id),
    ".sqlite.zst",
  )
}

function hasVectorPackArtifacts(pluginRoot) {
  return hasArtifactFiles(
    path.join(pluginRoot, "artifacts", "vector-packs", ACTIVE_EMBEDDING_SPEC.id),
    ".jsonl",
  )
}

function hasArtifactFiles(dir, suffix) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .some((entry) => entry.isFile() && entry.name.endsWith(suffix))
  } catch {
    return false
  }
}

function textOrNull(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : null
}

export function getSemanticCoverage(db) {
  const chunks = db.prepare("SELECT COUNT(*) AS n FROM chunks").get().n
  const vectors = db.prepare(
    `SELECT COUNT(*) AS n
     FROM chunks c
     JOIN chunk_vecs v ON v.chunk_id = c.id
     WHERE c.embedding_spec_id = ?
       AND c.chunker_id = ?
       AND c.normalization_id = ?`,
  ).get(
    ACTIVE_EMBEDDING_SPEC.id,
    ACTIVE_EMBEDDING_SPEC.chunker_id,
    ACTIVE_EMBEDDING_SPEC.normalization_id,
  ).n
  const knownFailures = db.prepare(
    `SELECT COUNT(*) AS n
     FROM chunks c
     LEFT JOIN chunk_vecs v ON v.chunk_id = c.id
     JOIN chunk_embedding_failures f
       ON f.chunk_key = c.chunk_key
      AND f.text_hash = c.text_hash
      AND f.embedding_spec_id = c.embedding_spec_id
      AND f.chunker_id = c.chunker_id
      AND f.normalization_id = c.normalization_id
     WHERE v.chunk_id IS NULL
       AND c.embedding_spec_id = ?
       AND c.chunker_id = ?
       AND c.normalization_id = ?`,
  ).get(
    ACTIVE_EMBEDDING_SPEC.id,
    ACTIVE_EMBEDDING_SPEC.chunker_id,
    ACTIVE_EMBEDDING_SPEC.normalization_id,
  ).n
  const missing = Math.max(0, chunks - vectors)
  return {
    chunks_total: chunks,
    vectors_indexed: vectors,
    missing_vectors: missing,
    known_unembeddable_vectors: knownFailures,
    repairable_missing_vectors: Math.max(0, missing - knownFailures),
  }
}

async function shouldRepairMissingEmbeddings(db, opts, semantic) {
  if (semantic.missing_vectors <= 0) return false
  if (opts.vectorPacks?.pluginRoot) {
    if (
      semantic.repairable_missing_vectors <= 0 &&
      vectorPackNoopRepairAlreadyTried(db, opts.vectorPacks)
    ) {
      return false
    }
    return true
  }
  if (semantic.repairable_missing_vectors <= 0) return false
  if (opts.skipEmbed) return false
  const probe = await probeEmbeddingService(opts.embed ?? {})
  semantic.embedding_available = probe.available
  semantic.embedding_diagnostic = probe.diagnostic
  return probe.available
}

async function maybeRepairMissingEmbeddings(
  deskRoot,
  db,
  opts,
  semantic,
  rootIdentity,
) {
  const shouldRepair = await shouldRepairMissingEmbeddings(db, opts, semantic)
  if (!shouldRepair) return null
  const summary = await rebuildIndex(deskRoot, {
    ...opts,
    db,
    reembedMissing: true,
    rootIdentity,
  })
  const semanticAfter = assignEmbeddingAvailability(
    getSemanticCoverage(db),
    semantic,
    summary,
  )
  rememberVectorPackNoopRepair(db, opts, summary, semanticAfter)
  return {
    built: true,
    reason: "semantic_missing",
    summary,
    fallback: fallbackFor(opts, null, summary.vector_packs),
    vector_packs: fallbackFor(opts, null, summary.vector_packs) === "vector_packs"
      ? fallbackVectorPackStatus(summary.vector_packs)
      : summary.vector_packs,
    semantic: semanticAfter,
  }
}

function assignEmbeddingAvailability(target, source, summary) {
  if (summary.semantic_warnings > 0) {
    target.embedding_available = false
    target.embedding_diagnostic = EMBEDDING_GENERATION_FAILURE_DIAGNOSTIC
  } else if (target.repairable_missing_vectors === 0 && target.missing_vectors > 0) {
    target.embedding_available = source.embedding_available ?? true
    if (source.embedding_diagnostic) {
      target.embedding_diagnostic = source.embedding_diagnostic
    }
  } else if (source.embedding_available === true) {
    target.embedding_available = true
    if (source.embedding_diagnostic) {
      target.embedding_diagnostic = source.embedding_diagnostic
    }
  } else if (source.embedding_available === false) {
    if (summary.chunks_inserted > 0 && target.missing_vectors === 0) {
      target.embedding_available = true
    } else {
      target.embedding_available = false
      if (source.embedding_diagnostic) {
        target.embedding_diagnostic = source.embedding_diagnostic
      }
    }
  }
  return target
}

function rememberVectorPackNoopRepair(db, opts, summary, semantic) {
  if (!opts.vectorPacks?.pluginRoot) return
  if (
    summary.vector_packs.rows_imported === 0 &&
    semantic.missing_vectors > 0 &&
    semantic.repairable_missing_vectors === 0
  ) {
    const signature = vectorPackNoopRepairSignature(db, opts.vectorPacks)
    setMeta(db, VECTOR_PACK_NOOP_REPAIR_SIGNATURE_META_KEY, signature)
    return
  }
  db.prepare("DELETE FROM meta WHERE key = ?")
    .run(VECTOR_PACK_NOOP_REPAIR_SIGNATURE_META_KEY)
}

function vectorPackNoopRepairAlreadyTried(db, vectorPacks) {
  const signature = vectorPackNoopRepairSignature(db, vectorPacks)
  return getMeta(db, VECTOR_PACK_NOOP_REPAIR_SIGNATURE_META_KEY) === signature
}

function vectorPackNoopRepairSignature(db, vectorPacks) {
  const knownMissing = knownUnembeddableMissingChunks(db)
  return stableJsonDigest({
    schema_version: 1,
    embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id,
    chunks: knownMissing,
    vector_packs: vectorPackArtifactState(vectorPacks),
  })
}

function knownUnembeddableMissingChunks(db) {
  return db.prepare(
    `SELECT
       c.chunk_key,
       c.text_hash,
       c.embedding_spec_id,
       c.chunker_id,
       c.normalization_id
     FROM chunks c
     LEFT JOIN chunk_vecs v ON v.chunk_id = c.id
     JOIN chunk_embedding_failures f
       ON f.chunk_key = c.chunk_key
      AND f.text_hash = c.text_hash
      AND f.embedding_spec_id = c.embedding_spec_id
      AND f.chunker_id = c.chunker_id
      AND f.normalization_id = c.normalization_id
     WHERE v.chunk_id IS NULL
       AND c.embedding_spec_id = ?
       AND c.chunker_id = ?
       AND c.normalization_id = ?
     ORDER BY
       c.chunk_key,
       c.text_hash,
       c.embedding_spec_id,
       c.chunker_id,
       c.normalization_id`,
  ).all(
    ACTIVE_EMBEDDING_SPEC.id,
    ACTIVE_EMBEDDING_SPEC.chunker_id,
    ACTIVE_EMBEDDING_SPEC.normalization_id,
  )
}

function vectorPackArtifactState(vectorPacks) {
  return vectorPackRoots(vectorPacks).map((root) => {
    const packDir = path.join(
      root,
      "artifacts",
      "vector-packs",
      ACTIVE_EMBEDDING_SPEC.id,
    )
    return {
      root: normalizeArtifactPath(root),
      packs: vectorPackSidecarState(packDir),
    }
  })
}

function vectorPackRoots(vectorPacks) {
  return [...new Set([
    vectorPacks.pluginRoot,
    ...(Array.isArray(vectorPacks.fallbackPluginRoots)
      ? vectorPacks.fallbackPluginRoots
      : []),
  ].filter((value) => textOrNull(value)).map((value) => path.resolve(value)))]
}

function vectorPackSidecarState(packDir) {
  let entries
  try {
    entries = readdirSync(packDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort()
    .map((pack) => {
      const packPath = path.join(packDir, pack)
      const base = packPath.slice(0, -".jsonl".length)
      return {
        pack,
        manifest_sha256: fileDigest(`${base}.manifest.json`),
        checksum_sha256: fileDigest(`${base}.sha256`),
      }
    })
}

function fileDigest(file) {
  try {
    return stableFileDigest(readFileSync(file))
  } catch {
    return null
  }
}

function stableJsonDigest(value) {
  const hash = createHash("sha256")
  hash.update(JSON.stringify(value))
  return `sha256:${hash.digest("hex")}`
}

function stableFileDigest(buffer) {
  const hash = createHash("sha256")
  hash.update(buffer)
  return `sha256:${hash.digest("hex")}`
}

function withSnapshot(result, snapshot, fallback = null) {
  if (snapshot) {
    result.snapshot = snapshot
  }
  if (fallback) {
    result.fallback = fallback
  }
  return result
}

function fallbackFor(opts, _snapshot, vectorPacks) {
  if (opts.vectorPacks?.pluginRoot && vectorPacks?.rows_imported > 0) return "vector_packs"
  return null
}

function fallbackVectorPackStatus(vectorPacks) {
  return {
    ...vectorPacks,
    import_state: "used_as_fallback",
    fallback_used: true,
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const err = new Error("operation aborted")
  err.name = "AbortError"
  throw err
}
