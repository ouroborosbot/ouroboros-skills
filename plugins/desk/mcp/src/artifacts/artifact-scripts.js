import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import * as zlib from "node:zlib"
import { fileURLToPath } from "node:url"

import { closeDb, indexDbPath, openDb } from "../db/init.js"
import { DISCOVERY_GRAMMAR_VERSION } from "../indexer/discover.js"
import { ACTIVE_EMBEDDING_SPEC } from "../indexer/spec.js"
import {
  deriveVectorPackPaths,
  validateVectorPackFile,
  writeVectorPackArtifact,
} from "../indexer/vector-packs.js"
import {
  deriveSnapshotPaths,
  validateSnapshotArtifact,
  writeSnapshotArtifact,
} from "../snapshots/manifest.js"
import {
  assertBudgetAllowsStart,
  assertWithinBudget,
  budgetValue,
  loadPerformanceBudgets,
} from "./performance-budgets.js"

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_MCP_ROOT = path.resolve(MODULE_DIR, "..", "..")
const DEFAULT_PLUGIN_ROOT = path.resolve(DEFAULT_MCP_ROOT, "..")
const SNAPSHOT_DB_SCHEMA = Object.freeze({ id: "desk-index-sqlite-v1", version: 1 })
const SNAPSHOT_SQLITE_VEC_TABLE = "vec0"
const SNAPSHOT_PORTABLE_RUNTIME = Object.freeze({
  platform: "portable",
  arch: "portable",
  node_abi: "portable",
})
const VECTOR_ENCODING = "float32-json"
const DEFAULT_SOURCE_PATHS = Object.freeze([
  "plugins/desk/mcp/src/indexer/discover.js",
  "plugins/desk/mcp/src/indexer/index.js",
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

export async function runVectorPackBuildCli(options = {}) {
  return runCli({
    argv: options.argv,
    io: options.io,
    helpText: vectorPackBuildHelp(),
    run: (args) => buildVectorPackFromLocalDb({
      ...commonRoots(args),
      packId: requiredArg(args, "pack-id"),
      budgetConfig: args["budget-config"],
      provenanceCommit: optionalProvenanceCommit(args["provenance-commit"]),
    }),
  })
}

export async function runSnapshotBuildCli(options = {}) {
  return runCli({
    argv: options.argv,
    io: options.io,
    helpText: snapshotBuildHelp(),
    run: (args) => buildSnapshotFromLocalDb({
      ...commonRoots(args),
      snapshotId: requiredArg(args, "snapshot-id"),
      includedPackIds: valuesFor(args, "included-pack-id"),
      budgetConfig: args["budget-config"],
      provenanceCommit: optionalProvenanceCommit(args["provenance-commit"]),
    }),
  })
}

export async function runSnapshotVerifyCli(options = {}) {
  return runCli({
    argv: options.argv,
    io: options.io,
    helpText: snapshotVerifyHelp(),
    run: (args) => verifySnapshotArtifact({
      mcpRoot: DEFAULT_MCP_ROOT,
      pluginRoot: resolvePath(args["plugin-root"] ?? DEFAULT_PLUGIN_ROOT),
      snapshotId: optionalString(args["snapshot-id"]),
      budgetConfig: args["budget-config"],
    }),
  })
}

export async function runArtifactValidateCli(options = {}) {
  return runCli({
    argv: options.argv,
    io: options.io,
    helpText: artifactValidateHelp(),
    run: (args) => validateArtifacts({
      ...commonRoots(args),
      budgetConfig: args["budget-config"],
    }),
  })
}

export async function buildVectorPackFromLocalDb({
  deskRoot,
  pluginRoot = DEFAULT_PLUGIN_ROOT,
  mcpRoot = DEFAULT_MCP_ROOT,
  packId,
  budgetConfig,
  now = Date.now,
  provenanceCommit,
} = {}) {
  const budgets = await loadPerformanceBudgets({ configPath: budgetConfig, mcpRoot })
  const budgetMs = budgetValue(budgets, "rebuild", "vector_pack_rebuild_ms")
  assertBudgetAllowsStart({ budgetMs, label: "vector-pack rebuild" })
  const startedAt = now()
  const db = openDb(requiredPath(deskRoot, "deskRoot"))
  try {
    const sourceDocs = representedDocuments(db)
    const rows = vectorPackRows(db)
    const packBytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8")
    const packSha = sha256Hex(packBytes)
    const context = snapshotCompatibilityContext({ mcpRoot, docs: sourceDocs })
    const manifest = {
      schema_version: 1,
      pack_id: packId,
      embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id,
      dimension: ACTIVE_EMBEDDING_SPEC.dimension,
      encoding: VECTOR_ENCODING,
      row_count: rows.length,
      rows_sha256: packSha,
      artifact_source_scope_hash: context.expectedArtifactSourceScopeHash,
      document_tree_hash: context.expectedDocumentTreeHash,
      discovery_grammar_version: DISCOVERY_GRAMMAR_VERSION,
      represented_documents: sourceDocs,
      created_at: new Date(now()).toISOString(),
      provenance: {
        builder: "plugins/desk/mcp/scripts/build-vector-pack.js",
        source: "local-db",
        commit: provenanceCommit ?? gitCommit(),
      },
      source_paths: DEFAULT_SOURCE_PATHS,
    }
    const paths = await writeVectorPackArtifact({
      pluginRoot,
      embeddingSpecId: ACTIVE_EMBEDDING_SPEC.id,
      packId,
      packBytes,
      manifestBytes: jsonBytes(manifest),
      checksumBytes: Buffer.from(`${packSha}  ${packId}.jsonl\n`, "utf8"),
      deskRoot,
      sourceDocs,
    })
    const elapsedMs = assertWithinBudget({
      startedAt,
      budgetMs,
      label: "vector-pack rebuild",
      now,
    })
    return {
      ok: true,
      artifact_type: "vector-pack",
      pack_id: packId,
      rows_written: rows.length,
      elapsed_ms: elapsedMs,
      paths: relativeArtifactPaths(pluginRoot, paths),
    }
  } finally {
    closeDb(db)
  }
}

export async function buildSnapshotFromLocalDb({
  deskRoot,
  pluginRoot = DEFAULT_PLUGIN_ROOT,
  mcpRoot = DEFAULT_MCP_ROOT,
  snapshotId,
  includedPackIds = [],
  budgetConfig,
  now = Date.now,
  provenanceCommit,
} = {}) {
  const budgets = await loadPerformanceBudgets({ configPath: budgetConfig, mcpRoot })
  const budgetMs = budgetValue(budgets, "rebuild", "snapshot_build_ms")
  assertBudgetAllowsStart({ budgetMs, label: "snapshot build" })
  const startedAt = now()
  const db = openDb(requiredPath(deskRoot, "deskRoot"))
  try {
    checkpointDb(db)
    const sourceDocs = representedDocuments(db)
    const sqliteBytes = await fs.readFile(indexDbPath(deskRoot))
    const snapshotBytes = compressSnapshotBytes(sqliteBytes)
    const artifactSha = `sha256:${sha256Hex(snapshotBytes)}`
    const context = snapshotCompatibilityContext({ mcpRoot, docs: sourceDocs })
    const manifest = {
      schema_version: 1,
      snapshot_id: snapshotId,
      embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id,
      dimension: ACTIVE_EMBEDDING_SPEC.dimension,
      chunker_id: ACTIVE_EMBEDDING_SPEC.chunker_id,
      normalization_id: ACTIVE_EMBEDDING_SPEC.normalization_id,
      db_schema: SNAPSHOT_DB_SCHEMA,
      sqlite_vec: context.expectedSqliteVec,
      runtime: context.expectedRuntime,
      artifact_source_scope_hash: context.expectedArtifactSourceScopeHash,
      document_tree_hash: context.expectedDocumentTreeHash,
      discovery_grammar_version: DISCOVERY_GRAMMAR_VERSION,
      included_pack_ids: includedPackIds,
      represented_documents: sourceDocs,
      created_at: new Date(now()).toISOString(),
      artifact: {
        file: `${snapshotId}.sqlite.zst`,
        format: "sqlite-zstd",
        sha256: artifactSha,
        compressed: true,
      },
      provenance: {
        builder: "plugins/desk/mcp/scripts/build-snapshot.js",
        source: "local-db",
        commit: provenanceCommit ?? gitCommit(),
      },
      source_paths: DEFAULT_SOURCE_PATHS,
    }
    const paths = await writeSnapshotArtifact({
      pluginRoot,
      embeddingSpecId: ACTIVE_EMBEDDING_SPEC.id,
      snapshotId,
      snapshotBytes,
      manifestBytes: jsonBytes(manifest),
      checksumBytes: Buffer.from(`${artifactSha}  ${snapshotId}.sqlite.zst\n`, "utf8"),
      deskRoot,
      sourceDocs,
    })
    const elapsedMs = assertWithinBudget({
      startedAt,
      budgetMs,
      label: "snapshot build",
      now,
    })
    return {
      ok: true,
      artifact_type: "snapshot",
      snapshot_id: snapshotId,
      elapsed_ms: elapsedMs,
      paths: relativeArtifactPaths(pluginRoot, paths),
    }
  } finally {
    closeDb(db)
  }
}

export async function verifySnapshotArtifact({
  pluginRoot = DEFAULT_PLUGIN_ROOT,
  mcpRoot = DEFAULT_MCP_ROOT,
  snapshotId,
  budgetConfig,
  now = Date.now,
} = {}) {
  const budgets = await loadPerformanceBudgets({ configPath: budgetConfig, mcpRoot })
  const budgetMs = budgetValue(budgets, "artifacts", "snapshot_verify_ms")
  assertBudgetAllowsStart({ budgetMs, label: "snapshot verify" })
  const startedAt = now()
  if (!hasText(snapshotId)) {
    const snapshots = await validateAllSnapshots({ pluginRoot, mcpRoot })
    const elapsedMs = assertWithinBudget({
      startedAt,
      budgetMs,
      label: "snapshot verify",
      now,
    })
    return {
      ok: true,
      artifact_type: "snapshot",
      snapshots,
      elapsed_ms: elapsedMs,
    }
  }
  const paths = deriveSnapshotPaths({ pluginRoot, snapshotId })
  const manifest = await readJson(paths.manifestPath)
  const context = snapshotCompatibilityContext({
    mcpRoot,
    docs: manifest.represented_documents ?? [],
  })
  const validation = await validateSnapshotArtifact({
    pluginRoot,
    snapshotPath: paths.snapshotPath,
    manifestPath: paths.manifestPath,
    checksumPath: paths.checksumPath,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDbSchema: SNAPSHOT_DB_SCHEMA,
    ...context,
  })
  const elapsedMs = assertWithinBudget({
    startedAt,
    budgetMs,
    label: "snapshot verify",
    now,
  })
  return {
    ok: true,
    artifact_type: "snapshot",
    snapshot_id: validation.snapshot_id,
    elapsed_ms: elapsedMs,
    freshness: validation.freshness,
  }
}

export async function validateArtifacts({
  deskRoot,
  pluginRoot = DEFAULT_PLUGIN_ROOT,
  mcpRoot = DEFAULT_MCP_ROOT,
  budgetConfig,
  now = Date.now,
} = {}) {
  const budgets = await loadPerformanceBudgets({ configPath: budgetConfig, mcpRoot })
  const budgetMs = budgetValue(budgets, "artifacts", "validate_ms")
  assertBudgetAllowsStart({ budgetMs, label: "artifact validation" })
  const startedAt = now()
  const vectorPacks = await validateAllVectorPacks({ pluginRoot, mcpRoot })
  const snapshots = await validateAllSnapshots({ pluginRoot, mcpRoot })
  const elapsedMs = assertWithinBudget({
    startedAt,
    budgetMs,
    label: "artifact validation",
    now,
  })
  return {
    ok: true,
    vector_packs: vectorPacks,
    snapshots,
    elapsed_ms: elapsedMs,
  }
}

function vectorPackRows(db) {
  const rows = db.prepare(
    `SELECT c.chunk_key,
            c.text_hash,
            c.embedding_spec_id,
            v.embedding
     FROM chunks c
     JOIN chunk_vecs v ON v.chunk_id = c.id
     WHERE c.embedding_spec_id = ?
       AND c.chunker_id = ?
       AND c.normalization_id = ?
     ORDER BY c.chunk_key`,
  ).all(
    ACTIVE_EMBEDDING_SPEC.id,
    ACTIVE_EMBEDDING_SPEC.chunker_id,
    ACTIVE_EMBEDDING_SPEC.normalization_id,
  )
  return rows.map((row) => ({
    chunk_key: row.chunk_key,
    text_hash: canonicalSha(row.text_hash),
    embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id,
    dimension: ACTIVE_EMBEDDING_SPEC.dimension,
    encoding: VECTOR_ENCODING,
    vector: decodeFloat32(row.embedding),
  }))
}

function representedDocuments(db) {
  return db.prepare(
    "SELECT path, hash FROM docs ORDER BY path",
  ).all().map((doc) => ({
    path: normalizePath(doc.path),
    hash: canonicalSha(doc.hash),
  }))
}

async function validateAllVectorPacks({ pluginRoot, mcpRoot }) {
  const dir = path.join(pluginRoot, "artifacts", "vector-packs", ACTIVE_EMBEDDING_SPEC.id)
  const files = await filesWithSuffix(dir, ".jsonl")
  const out = []
  for (const packPath of files) {
    const manifestPath = packPath.replace(/\.jsonl$/u, ".manifest.json")
    const manifest = await readJson(manifestPath)
    const context = snapshotCompatibilityContext({
      mcpRoot,
      docs: manifest.represented_documents ?? [],
    })
    const validation = await validateVectorPackFile({
      pluginRoot,
      packPath,
      expectedArtifactSourceScopeHash: context.expectedArtifactSourceScopeHash,
      expectedDiscoveryGrammarVersion: context.expectedDiscoveryGrammarVersion,
    })
    out.push({
      pack_id: validation.pack_id,
      rows: validation.rows.length,
      freshness: validation.freshness,
    })
  }
  return {
    count: out.length,
    artifacts: out,
  }
}

async function validateAllSnapshots({ pluginRoot, mcpRoot }) {
  const dir = path.join(pluginRoot, "artifacts", "snapshots", ACTIVE_EMBEDDING_SPEC.id)
  const files = await filesWithSuffix(dir, ".sqlite.zst")
  const out = []
  for (const snapshotPath of files) {
    const manifestPath = snapshotPath.replace(/\.sqlite\.zst$/u, ".manifest.json")
    const manifest = await readJson(manifestPath)
    const context = snapshotCompatibilityContext({
      mcpRoot,
      docs: manifest.represented_documents ?? [],
    })
    const validation = await validateSnapshotArtifact({
      pluginRoot,
      snapshotPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
      expectedDbSchema: SNAPSHOT_DB_SCHEMA,
      ...context,
    })
    out.push({
      snapshot_id: validation.snapshot_id,
      freshness: validation.freshness,
    })
  }
  return {
    count: out.length,
    artifacts: out,
  }
}

function snapshotCompatibilityContext({ mcpRoot = DEFAULT_MCP_ROOT, docs = [] } = {}) {
  return {
    expectedSqliteVec: {
      package: "sqlite-vec",
      version: sqliteVecVersion(mcpRoot),
      table: SNAPSHOT_SQLITE_VEC_TABLE,
    },
    expectedRuntime: SNAPSHOT_PORTABLE_RUNTIME,
    expectedArtifactSourceScopeHash: artifactSourceScopeHash(mcpRoot),
    expectedDocumentTreeHash: documentTreeHash(docs),
    expectedDiscoveryGrammarVersion: DISCOVERY_GRAMMAR_VERSION,
  }
}

function artifactSourceScopeHash(mcpRoot) {
  const hash = createHash("sha256")
  for (const repoPath of DEFAULT_SOURCE_PATHS) {
    const relFromMcp = repoPath.replace(/^plugins\/desk\/mcp\//u, "")
    hash.update(`${repoPath}\0`)
    hash.update(readFileOrEmpty(path.join(mcpRoot, relFromMcp)))
    hash.update("\0")
  }
  return `sha256:${hash.digest("hex")}`
}

function documentTreeHash(docs) {
  const hash = createHash("sha256")
  for (const doc of [...docs].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(`${normalizePath(doc.path)}\0${canonicalSha(doc.hash)}\0`)
  }
  return `sha256:${hash.digest("hex")}`
}

function sqliteVecVersion(mcpRoot) {
  const packageLock = JSON.parse(readFileSync(path.join(mcpRoot, "package-lock.json"), "utf8"))
  return packageLock.packages?.["node_modules/sqlite-vec"]?.version
}

async function filesWithSuffix(dir, suffix) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => path.join(dir, entry.name))
      .sort()
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
}

function commonRoots(args) {
  return {
    deskRoot: resolvePath(requiredArg(args, "desk-root")),
    pluginRoot: resolvePath(args["plugin-root"] ?? DEFAULT_PLUGIN_ROOT),
    mcpRoot: DEFAULT_MCP_ROOT,
  }
}

async function runCli({
  argv = process.argv.slice(2),
  io = defaultIo(),
  helpText,
  run,
}) {
  try {
    const args = parseArgs(argv)
    if (args.help) {
      io.stdout.write(helpText)
      return 0
    }
    const result = await run(args)
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  } catch (error) {
    const code = error.code ?? "artifact_script_failed"
    io.stderr.write(`${code}: ${error.message}\n`)
    return 1
  }
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") {
      args.help = true
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2)
      const next = argv[index + 1]
      if (next === undefined || next.startsWith("--")) {
        args[key] = true
      } else if (args[key] === undefined) {
        args[key] = next
        index += 1
      } else if (Array.isArray(args[key])) {
        args[key].push(next)
        index += 1
      } else {
        args[key] = [args[key], next]
        index += 1
      }
    } else {
      args._.push(arg)
    }
  }
  return args
}

function valuesFor(args, key) {
  const value = args[key]
  if (value === undefined || value === true) return []
  return Array.isArray(value) ? value : [value]
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== ""
    ? value
    : undefined
}

function optionalProvenanceCommit(value) {
  const commit = optionalString(value)
  if (commit === undefined) return undefined
  if (/^[a-f0-9]{40}$/u.test(commit)) return commit
  const error = new Error("--provenance-commit must be a 40-character lowercase git sha")
  error.code = "artifact_script_usage"
  throw error
}

function requiredArg(args, key) {
  const value = args[key]
  if (typeof value !== "string" || value.trim() === "") {
    const error = new Error(`--${key} is required`)
    error.code = "artifact_script_usage"
    throw error
  }
  return value
}

function requiredPath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`)
  }
  return value
}

function hasText(value) {
  return typeof value === "string" && value.trim() !== ""
}

function resolvePath(value) {
  const expanded = String(value).replace(/^~(?=$|\/)/u, process.env.HOME ?? "")
  return path.resolve(expanded)
}

function decodeFloat32(value) {
  const buffer = Buffer.from(value)
  const out = []
  for (let offset = 0; offset < buffer.length; offset += 4) {
    out.push(buffer.readFloatLE(offset))
  }
  return out
}

function checkpointDb(db) {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)")
  } catch {
    db.pragma("wal_checkpoint(PASSIVE)")
  }
}

function readFileOrEmpty(filePath) {
  try {
    return readFileSync(filePath)
  } catch {
    return Buffer.alloc(0)
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"))
}

function gitCommit({
  spawn = spawnSync,
  cwd = path.resolve(DEFAULT_MCP_ROOT, "..", "..", ".."),
} = {}) {
  const result = spawn("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  })
  return /^[a-f0-9]{40}$/u.test(result.stdout.trim())
    ? result.stdout.trim()
    : "0000000000000000000000000000000000000000"
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex")
}

function canonicalSha(value) {
  return String(value).startsWith("sha256:") ? String(value) : `sha256:${value}`
}

function normalizePath(value) {
  return String(value).split(path.sep).join("/")
}

function relativeArtifactPaths(pluginRoot, paths) {
  return Object.fromEntries(
    Object.entries(paths)
      .filter(([, value]) => typeof value === "string")
      .map(([key, value]) => [
        key,
        path.isAbsolute(value)
          ? normalizePath(path.relative(pluginRoot, value))
          : normalizePath(value),
      ]),
  )
}

function defaultIo() {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
  }
}

function vectorPackBuildHelp() {
  return `Build a Desk vector-pack artifact for release maintenance.

Usage: npm run artifact:vector-pack:build -- --desk-root <path> --pack-id <id> [--plugin-root <path>] [--from-local-db] [--budget-config <path>] [--provenance-commit <sha>]
`
}

function snapshotBuildHelp() {
  return `Build a Desk snapshot artifact for release maintenance.

Usage: npm run artifact:snapshot:build -- --desk-root <path> --snapshot-id <id> [--plugin-root <path>] [--included-pack-id <id>] [--from-local-db] [--budget-config <path>] [--provenance-commit <sha>]
`
}

function snapshotVerifyHelp() {
  return `Verify a Desk snapshot artifact for release maintenance.

Usage: npm run artifact:snapshot:verify -- --plugin-root <path> [--snapshot-id <id>] [--budget-config <path>]
`
}

function artifactValidateHelp() {
  return `Validate Desk vector-pack and snapshot artifacts for release maintenance.

Usage: npm run artifact:validate -- --desk-root <path> [--plugin-root <path>] [--budget-config <path>]
`
}

function compressSnapshotBytes(sqliteBytes, codec = zlib) {
  if (typeof codec.zstdCompressSync !== "function") {
    throw new Error(
      "Snapshot compression requires a Node.js runtime with zstdCompressSync support (Node.js 22.15 or newer).",
    )
  }
  return codec.zstdCompressSync(sqliteBytes)
}

export const __artifactScriptInternalsForTests = {
  commonRoots,
  checkpointDb,
  compressSnapshotBytes,
  documentTreeHash,
  defaultIo,
  filesWithSuffix,
  gitCommit,
  optionalProvenanceCommit,
  optionalString,
  readFileOrEmpty,
  requiredPath,
  valuesFor,
}
