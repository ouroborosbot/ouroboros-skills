import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as path from "node:path"
import Database from "better-sqlite3"
import * as sqliteVec from "sqlite-vec"
import { indexDbPath } from "../db/init.js"
import { resolveRuntimeMaintenance } from "../indexer/maintenance.js"
import { ACTIVE_EMBEDDING_SPEC } from "../indexer/spec.js"
import { personPrefix } from "../util/paths.js"

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
)
const DB_SCHEMA = { id: "desk-index", version: 1 }
const EMBEDDING_SPEC = {
  id: ACTIVE_EMBEDDING_SPEC.id,
  provider: "ollama",
  model: ACTIVE_EMBEDDING_SPEC.model,
  model_revision: ACTIVE_EMBEDDING_SPEC.model_revision,
  dimensions: ACTIVE_EMBEDDING_SPEC.dimension,
  encoding: "float32",
  chunker_id: ACTIVE_EMBEDDING_SPEC.chunker_id,
  normalization_id: ACTIVE_EMBEDDING_SPEC.normalization_id,
}

export async function desk_status(args) {
  const {
    deskRoot,
    person,
    runtimeContext,
    statusContext = {},
  } = args
  const maintenance = resolveRuntimeMaintenance({
    runtimeContext,
    runtimeContextProvided: Object.hasOwn(args, "runtimeContext"),
  })
  const effectiveRoot = personPrefix(deskRoot, person)
  const writeScope = effectiveRoot === deskRoot
    ? { mode: "workspace", person: null, relative_path: "." }
    : {
        mode: "person",
        person: path.basename(effectiveRoot),
        relative_path: path.posix.join("desks", path.basename(effectiveRoot)),
      }
  const requestedRoot = rootStatus(deskRoot, statusContext.root)
  const rootLease = requestedRoot.valid
    ? maintenance.acquireRootLease(deskRoot)
    : undefined
  const repair = maintenance.semanticRepairSnapshot({
    deskRoot,
    rootLease,
  })
  const root = requestedRoot
  const inspectionRoot = repair.rootIdentity?.key ?? deskRoot
  const runtime = runtimeStatus(statusContext.runtime ?? {})
  const localDb = root.valid
    ? inspectLocalDb(inspectionRoot, { reportedRoot: root.path })
    : unavailableLocalDb(root.path === null ? null : indexDbPath(root.path), "root_unavailable")
  const startup = normalizeStartup(statusContext.startup)
  const snapshots = snapshotStatus(startup)
  const vectorPacks = vectorPackStatus(startup)
  const queryEmbedding = queryEmbeddingStatus(startup)
  const activation = activationStatus(statusContext.activation)
  const startupFallback = startupFallbackStatus({
    startup,
    documentVectors: localDb.document_vectors,
    queryEmbedding,
    lexicalIndex: localDb.lexical_index,
  })
  const degradedModes = degradedModesFor({
    documentVectors: localDb.document_vectors,
    queryEmbedding,
    lexicalIndex: localDb.lexical_index,
    startupFallback,
  })

  return {
    status: root.valid ? "ok" : "error",
    root,
    activation,
    runtime,
    local_db: localDb.local_db,
    db_schema: localDb.local_db.schema,
    active_embedding_spec: EMBEDDING_SPEC,
    snapshots,
    vector_packs: vectorPacks,
    document_vectors: localDb.document_vectors,
    semantic_repair_status: repair.status,
    query_embedding: queryEmbedding,
    lexical_index: localDb.lexical_index,
    startup_fallback: startupFallback,
    degraded_modes: degradedModes,
    write_scope: writeScope,
    summary: summaryFor({ root, activation, localDb, snapshots, vectorPacks, startupFallback }),
  }
}

function inspectLocalDb(deskRoot, { reportedRoot = deskRoot } = {}) {
  const dbPath = indexDbPath(deskRoot)
  const reportedDbPath = indexDbPath(reportedRoot)
  if (!existsSync(dbPath)) {
    return unavailableLocalDb(reportedDbPath, "missing")
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    sqliteVec.load(db)
    const chunksTableExists = tableExists(db, "chunks")
    const vectorsTableExists = tableExists(db, "chunk_vecs")
    const embeddingFailuresTableExists = tableExists(db, "chunk_embedding_failures")
    const lexicalAvailable = tableExists(db, "chunks_fts")
    const chunksTotal = chunksTableExists ? countRows(db, "chunks") : 0
    const vectorsIndexed = countActiveVectors(db, {
      chunksTableExists,
      vectorsTableExists,
    })
    const missingVectors = Math.max(0, chunksTotal - vectorsIndexed)
    const knownUnembeddableVectors = countKnownUnembeddableVectors(db, {
      chunksTableExists,
      vectorsTableExists,
      embeddingFailuresTableExists,
    })
    const repairableMissingVectors = Math.max(0, missingVectors - knownUnembeddableVectors)
    const freshness = inspectFreshness(deskRoot, db)
    return {
      local_db: {
        path: reportedDbPath,
        exists: true,
        schema: DB_SCHEMA,
        state: freshness.state === "stale" ? "stale" : "available",
        freshness,
      },
      lexical_index: {
        available: lexicalAvailable,
        state: ["missing", "available"][Number(lexicalAvailable)],
      },
      document_vectors: projectDocumentVectors({
        chunks_total: chunksTotal,
        vectors_indexed: vectorsIndexed,
        missing_vectors: missingVectors,
        known_unembeddable_vectors: knownUnembeddableVectors,
        repairable_missing_vectors: repairableMissingVectors,
      }, { vectorsTableExists }),
    }
  } finally {
    db.close()
  }
}

function unavailableLocalDb(dbPath, state) {
  return {
    local_db: {
      path: dbPath,
      exists: false,
      schema: { id: DB_SCHEMA.id, version: null },
      state,
      freshness: { state: "unknown", reason: state },
    },
    lexical_index: {
      available: false,
      state: state === "missing" ? "missing_local_db" : state,
    },
    document_vectors: {
      state: state === "missing" ? "missing_local_db" : state,
      chunks_total: 0,
      vectors_indexed: 0,
      missing_vectors: 0,
      known_unembeddable_vectors: 0,
      repairable_missing_vectors: 0,
      coverage: null,
    },
  }
}

function normalizeStartup(startup) {
  return startup !== null && typeof startup === "object" ? startup : {}
}

function startupEnsure(startup) {
  const ensure = startup.ensure_index
  return ensure !== null && typeof ensure === "object" ? ensure : null
}

function snapshotStatus(startup) {
  const ensure = startupEnsure(startup)
  const snapshot = ensure?.snapshot
  const base = { module_state: "available" }
  if (!snapshot) {
    return { ...base, restore_state: "not_checked" }
  }
  return compactObject({
    ...base,
    restore_state: snapshotRestoreState(snapshot),
    snapshot_id: snapshot.snapshot_id,
    reason: snapshot.reason,
    reconciled: snapshot.reconciled,
    freshness: snapshot.freshness,
  })
}

function vectorPackStatus(startup) {
  const ensure = startupEnsure(startup)
  const base = { module_state: "available" }
  if (!ensure) return { ...base, import_state: "not_checked" }
  if (ensure.fallback === "vector_packs") {
    return {
      ...base,
      ...ensure.vector_packs,
      import_state: "used_as_fallback",
      fallback_used: true,
    }
  }
  if (ensure.vector_packs?.import_state) {
    return { ...base, ...ensure.vector_packs }
  }
  return { ...base, import_state: "absent" }
}

function queryEmbeddingStatus(startup) {
  const semantic = startupEnsure(startup)?.semantic
  const base = { spec_id: EMBEDDING_SPEC.id }
  if (typeof semantic?.embedding_available === "boolean") {
    return compactObject({
      ...base,
      available: semantic.embedding_available,
      diagnostic: semantic.embedding_diagnostic,
    })
  }
  return {
    ...base,
    available: "not_checked",
    note: "desk_status does not probe live embedding endpoints during session start",
  }
}

function startupFallbackStatus({
  startup,
  documentVectors,
  queryEmbedding,
  lexicalIndex,
}) {
  const ensure = startupEnsure(startup)
  const mode = startup.fallback_mode ?? inferStartupFallbackMode({ ensure, lexicalIndex })
  const degraded = startup.degraded ?? fallbackIsDegraded({
    documentVectors,
    mode,
    queryEmbedding,
  })
  return compactObject({
    mode,
    degraded,
    duration_ms: startup.duration_ms,
    budget_ms: startup.budget_ms,
  })
}

function degradedModesFor({
  documentVectors,
  queryEmbedding,
  lexicalIndex,
  startupFallback,
}) {
  const modes = []
  if (documentVectors.state === "partial") modes.push("document_vectors_partial")
  if (documentVectors.state === "missing") modes.push("document_vectors_missing")
  if (queryEmbedding.available === false) modes.push("query_embedding_unavailable")
  if (startupFallback.mode === "lexical_only" && lexicalIndex.available) {
    modes.push("lexical_fallback_active")
  }
  return modes
}

function snapshotRestoreState(snapshot) {
  if (snapshot.restored === true) return "restored"
  if (snapshot.reason === "snapshot_already_restored") return "already_restored"
  return "skipped"
}

export function projectDocumentVectors(semantic = {}, {
  operationalOnly = false,
  vectorsTableExists = true,
} = {}) {
  const chunksTotal = semantic.chunks_total ?? 0
  const vectorsIndexed = semantic.vectors_indexed ?? 0
  const missingVectors = semantic.missing_vectors ?? 0
  const knownUnembeddableVectors =
    semantic.known_unembeddable_vectors ?? 0
  const repairableMissingVectors =
    semantic.repairable_missing_vectors ?? 0
  const operationalStates = new Set(["missing", "partial", "available"])
  const state = operationalOnly && typeof semantic.state === "string"
    ? operationalStates.has(semantic.state) ? semantic.state : "missing"
    : documentVectorState({
        chunksTotal,
        missingVectors,
        repairableMissingVectors,
        vectorsIndexed,
        vectorsTableExists,
      })
  return {
    state,
    chunks_total: chunksTotal,
    vectors_indexed: vectorsIndexed,
    missing_vectors: missingVectors,
    known_unembeddable_vectors: knownUnembeddableVectors,
    repairable_missing_vectors: repairableMissingVectors,
    coverage: vectorsIndexed / Math.max(1, chunksTotal),
  }
}

function documentVectorState({
  chunksTotal,
  missingVectors,
  repairableMissingVectors,
  vectorsIndexed,
  vectorsTableExists,
}) {
  if (!vectorsTableExists) return "missing"
  if (chunksTotal === 0) return "available"
  if (vectorsIndexed === 0 && repairableMissingVectors > 0) return "missing"
  return repairableMissingVectors > 0 ? "partial" : "available"
}

function inferStartupFallbackMode({ ensure, lexicalIndex }) {
  if (!ensure) return "not_checked"
  if (ensure.fallback === "vector_packs" && ensure.snapshot?.restored) {
    return "snapshot_then_vector_packs"
  }
  if (ensure.fallback === "vector_packs") return "vector_packs"
  if (
    (ensure.semantic?.repairable_missing_vectors ?? ensure.semantic?.missing_vectors) > 0 &&
    lexicalIndex.available
  ) {
    return "lexical_only"
  }
  if (ensure.snapshot?.restored) return "snapshot"
  if (ensure.reason === "startup_budget_exceeded") return "startup_deferred"
  return ensure.built ? "rebuild" : "fresh"
}

function fallbackIsDegraded({ documentVectors, mode, queryEmbedding }) {
  return mode === "lexical_only" ||
    mode === "startup_deferred" ||
    documentVectors.state === "missing" ||
    documentVectors.state === "partial" ||
    queryEmbedding.available === false
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  )
}

function rootStatus(deskRoot, rootContext = {}) {
  const pathValue = typeof deskRoot === "string" && deskRoot.trim().length > 0
    ? deskRoot
    : null
  const source = typeof rootContext?.source === "string" && rootContext.source.trim().length > 0
    ? rootContext.source
    : "unknown"
  const tried = Array.isArray(rootContext?.tried)
    ? rootContext.tried.filter(isRootAttempt)
    : []
  const exists = pathValue === null ? false : existsSync(pathValue)
  const malformed_context = rootContext !== null
    && typeof rootContext === "object"
    && (rootContext.source !== undefined && source === "unknown"
      || rootContext.tried !== undefined && !Array.isArray(rootContext.tried))

  return {
    path: pathValue,
    source,
    tried,
    exists,
    valid: exists,
    diagnostic: exists ? null : rootDiagnostic(pathValue),
    malformed_context,
  }
}

function runtimeStatus(runtime) {
  const sourceMirrorPath = runtime.source_mirror_path ?? runtime.sourceMirrorPath ?? null
  return {
    plugin: {
      name: packageJson.name,
      version: packageJson.version,
    },
    node: {
      platform: process.platform,
      arch: process.arch,
      abi: process.versions.modules,
    },
    target: runtime.target ?? defaultTarget(),
    runtime_cache_dir: runtime.runtime_cache_dir ?? runtime.runtimeCacheDir ?? null,
    source_mirror_path: sourceMirrorPath,
    loaded_from_source_mirror: typeof sourceMirrorPath === "string" && sourceMirrorPath.length > 0,
  }
}

function activationStatus(activation) {
  if (activation === null || typeof activation !== "object") {
    return {
      selected_id: null,
      chain: [],
      mode: null,
      source: "not_provided",
    }
  }
  const chain = normalizeActivationChain(activation.chain)
  const selectedId = textOrNull(
    activation.selected_id ??
    activation.selectedId ??
    activation.id ??
    activation.selectedActivationId,
  )
  return compactObject({
    selected_id: selectedId,
    chain,
    mode: textOrNull(activation.mode),
    source: textOrNull(activation.source) ?? "unknown",
  })
}

function normalizeActivationChain(chain) {
  if (!Array.isArray(chain)) return []
  return chain
    .map((entry) => {
      if (typeof entry === "string" && entry.trim().length > 0) return entry
      if (entry !== null && typeof entry === "object" && typeof entry.id === "string") {
        return entry.id
      }
      return null
    })
    .filter(Boolean)
}

function textOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

function inspectFreshness(deskRoot, db) {
  if (!tableExists(db, "meta")) {
    return { state: "unknown", reason: "meta_table_missing" }
  }
  const lastIndexedAt = metaValue(db, "last_indexed_at")
  if (lastIndexedAt === null) {
    return { state: "unknown", reason: "last_indexed_at_missing" }
  }
  const indexedMs = Date.parse(lastIndexedAt)
  if (Number.isNaN(indexedMs)) {
    return { state: "unknown", reason: "last_indexed_at_invalid", last_indexed_at: lastIndexedAt }
  }
  const newest = newestMarkdownFile(deskRoot)
  if (newest === null) {
    return { state: "fresh", last_indexed_at: lastIndexedAt, newest_document: null }
  }
  return {
    state: newest.mtime_ms > indexedMs ? "stale" : "fresh",
    last_indexed_at: lastIndexedAt,
    newest_document: newest,
  }
}

function newestMarkdownFile(deskRoot) {
  let newest = null
  for (const file of markdownFiles(deskRoot)) {
    const stat = statSync(path.join(deskRoot, file))
    const candidate = { path: file, mtime_ms: stat.mtimeMs }
    if (newest === null || candidate.mtime_ms > newest.mtime_ms) {
      newest = candidate
    }
  }
  return newest
}

function markdownFiles(root, current = root) {
  const out = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (shouldSkipDir(entry.name)) {
      continue
    }
    const absolute = path.join(current, entry.name)
    if (entry.isDirectory()) {
      out.push(...markdownFiles(root, absolute))
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(path.relative(root, absolute))
    }
  }
  return out
}

function defaultTarget() {
  return `${process.platform}-${process.arch}-node-${process.versions.modules}`
}

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
}

function tableExists(db, table) {
  return db.prepare("SELECT 1 AS found FROM sqlite_master WHERE name = ?").get(table) !== undefined
}

function tableHasColumns(db, table, columns) {
  const names = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
  return columns.every((column) => names.has(column))
}

function countActiveVectors(db, { chunksTableExists, vectorsTableExists }) {
  if (!chunksTableExists || !vectorsTableExists) return 0
  if (!tableHasColumns(db, "chunks", [
    "embedding_spec_id",
    "chunker_id",
    "normalization_id",
  ])) {
    return 0
  }
  return db.prepare(
    `SELECT COUNT(*) AS count
     FROM chunks c
     JOIN chunk_vecs v ON v.chunk_id = c.id
     WHERE c.embedding_spec_id = ?
       AND c.chunker_id = ?
       AND c.normalization_id = ?`,
  ).get(
    ACTIVE_EMBEDDING_SPEC.id,
    ACTIVE_EMBEDDING_SPEC.chunker_id,
    ACTIVE_EMBEDDING_SPEC.normalization_id,
  ).count
}

function countKnownUnembeddableVectors(db, {
  chunksTableExists,
  vectorsTableExists,
  embeddingFailuresTableExists,
}) {
  if (!chunksTableExists || !vectorsTableExists || !embeddingFailuresTableExists) return 0
  if (!tableHasColumns(db, "chunks", [
    "chunk_key",
    "text_hash",
    "embedding_spec_id",
    "chunker_id",
    "normalization_id",
  ])) {
    return 0
  }
  if (!tableHasColumns(db, "chunk_embedding_failures", [
    "chunk_key",
    "text_hash",
    "embedding_spec_id",
    "chunker_id",
    "normalization_id",
  ])) {
    return 0
  }
  return db.prepare(
    `SELECT COUNT(*) AS count
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
  ).count
}

function metaValue(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key)
  return row?.value ?? null
}

function isRootAttempt(value) {
  return value !== null
    && typeof value === "object"
    && typeof value.source === "string"
    && typeof value.path === "string"
}

function rootDiagnostic(pathValue) {
  return pathValue === null ? "missing_desk_root" : "desk_root_not_found"
}

function shouldSkipDir(name) {
  return name === ".state" || name === ".git" || name === "node_modules"
}

function summaryFor({ root, activation, localDb, snapshots, vectorPacks, startupFallback }) {
  const startupSummary = startupFallback.mode === "not_checked"
    ? "Snapshot restore, vector-pack import, and query embedding probes were not run."
    : `Startup fallback mode: ${startupFallback.mode}. Snapshot restore: ${snapshots.restore_state}. Vector pack import: ${vectorPacks.import_state}.`
  const activationSummary = activation.selected_id
    ? `Active activation: ${activation.selected_id}.`
    : null
  return [
    `Desk root ${root.path} resolved from ${root.source}.`,
    activationSummary,
    root.valid ? null : `Root diagnostic: ${root.diagnostic}.`,
    localDb.local_db.exists
      ? `Local DB is ${localDb.local_db.state}.`
      : "Local DB is missing; this is normal on first run.",
    startupSummary,
  ].filter(Boolean).join(" ")
}
