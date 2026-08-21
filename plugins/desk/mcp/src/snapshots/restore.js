import { promises as fs } from "node:fs"
import { createHash } from "node:crypto"
import * as path from "node:path"
import * as zlib from "node:zlib"
import { indexDbPath } from "../db/init.js"
import { ACTIVE_EMBEDDING_SPEC } from "../indexer/spec.js"
import { validateSnapshotArtifact } from "./manifest.js"

export async function discoverSnapshotArtifacts({
  pluginRoot,
  expectedSpec = ACTIVE_EMBEDDING_SPEC,
  expectedDbSchema,
  expectedSqliteVec,
  expectedRuntime,
  expectedArtifactSourceScopeHash,
  expectedDocumentTreeHash,
  expectedDiscoveryGrammarVersion,
} = {}) {
  const root = requiredPath(pluginRoot, "pluginRoot")
  const snapshotsRoot = path.join(root, "artifacts", "snapshots")
  const compatible = []
  const ignored = []

  for (const specDirent of await readDirOrEmpty(snapshotsRoot)) {
    if (!specDirent.isDirectory()) continue
    const embeddingSpecId = specDirent.name
    const snapshotDir = path.join(snapshotsRoot, embeddingSpecId)
    if (embeddingSpecId !== expectedSpec.id) {
      for (const snapshotPath of await snapshotFiles(snapshotDir)) {
        ignored.push(ignoredCandidate(snapshotPath, "inactive_embedding_spec"))
      }
      continue
    }

    for (const snapshotPath of await snapshotFiles(snapshotDir)) {
      try {
        const validation = await validateSnapshotArtifact({
          pluginRoot: root,
          snapshotPath,
          expectedSpec,
          expectedDbSchema,
          expectedSqliteVec,
          expectedRuntime,
          expectedArtifactSourceScopeHash: await resolveExpectedHash(
            expectedArtifactSourceScopeHash,
          ),
          expectedDocumentTreeHash: await resolveExpectedHash(
            expectedDocumentTreeHash,
          ),
          expectedDiscoveryGrammarVersion,
        })
        compatible.push({
          ...validation,
          snapshotPath,
          manifestPath: sidecarPath(snapshotPath, ".manifest.json"),
          checksumPath: sidecarPath(snapshotPath, ".sha256"),
        })
      } catch {
        ignored.push(ignoredCandidate(snapshotPath, "incompatible_manifest"))
      }
    }
  }

  return { compatible, ignored }
}

async function resolveExpectedHash(expected) {
  return typeof expected === "function" ? await expected() : expected
}

export function selectNewestCompatibleSnapshot(discovered) {
  const candidates = discovered?.compatible
  if (!Array.isArray(candidates) || candidates.length === 0) return null
  return [...candidates].sort(compareCandidates)[0]
}

export async function restoreSnapshotToState({
  pluginRoot,
  deskRoot,
  ...context
} = {}) {
  requiredPath(deskRoot, "deskRoot")
  const discovered = await discoverSnapshotArtifacts({ pluginRoot, ...context })
  const selected = selectNewestCompatibleSnapshot(discovered)
  if (!selected) {
    return { restored: false, reason: "no_compatible_snapshot" }
  }

  const stateDbPath = indexDbPath(deskRoot)
  const stateMetaPath = `${stateDbPath}.snapshot.json`
  const existing = await readJsonOrNull(stateMetaPath)
  const existingStateSha256 = await fileSha256OrNull(stateDbPath)
  if (
    existing?.snapshot_id === selected.snapshot_id &&
    existing?.artifact_sha256 === selected.manifest.artifact.sha256 &&
    existing?.state_db_sha256 === existingStateSha256
  ) {
    return {
      restored: false,
      reason: "snapshot_already_restored",
      snapshot_id: selected.snapshot_id,
      state_db_path: stateDbPath,
      freshness: selected.freshness,
    }
  }

  const compressed = await fs.readFile(selected.snapshotPath)
  const decompressed = decompressSnapshotBytes(compressed)
  if (!decompressed.bytes) {
    return {
      restored: false,
      reason: decompressed.reason,
      snapshot_id: selected.snapshot_id,
      state_db_path: stateDbPath,
      freshness: selected.freshness,
    }
  }
  const sqliteBytes = decompressed.bytes
  const stateDbSha256 = `sha256:${sha256(sqliteBytes)}`
  await fs.mkdir(path.dirname(stateDbPath), { recursive: true })
  await writeAtomic(stateDbPath, sqliteBytes)
  await writeAtomic(
    stateMetaPath,
    `${JSON.stringify({
      schema_version: 1,
      snapshot_id: selected.snapshot_id,
      artifact_sha256: selected.manifest.artifact.sha256,
      state_db_sha256: stateDbSha256,
      restored_at: new Date().toISOString(),
      source_snapshot_path: normalizePath(path.relative(pluginRoot, selected.snapshotPath)),
    }, null, 2)}\n`,
  )

  return {
    restored: true,
    reason: "snapshot_restored",
    snapshot_id: selected.snapshot_id,
    state_db_path: stateDbPath,
    freshness: selected.freshness,
  }
}

async function snapshotFiles(snapshotDir) {
  const dirents = await readDirOrEmpty(snapshotDir)
  return dirents
    .filter((dirent) => dirent.isFile() && dirent.name.endsWith(".sqlite.zst"))
    .map((dirent) => path.join(snapshotDir, dirent.name))
}

async function readDirOrEmpty(dirPath) {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
}

function compareCandidates(left, right) {
  const created =
    Date.parse(right.manifest.created_at) -
    Date.parse(left.manifest.created_at)
  if (created !== 0) return created
  return left.snapshot_id.localeCompare(right.snapshot_id)
}

function ignoredCandidate(snapshotPath, reason) {
  const file = path.basename(snapshotPath)
  return {
    snapshot_id: file.slice(0, -".sqlite.zst".length),
    snapshotPath,
    reason,
  }
}

function sidecarPath(snapshotPath, suffix) {
  return snapshotPath.replace(/\.sqlite\.zst$/u, suffix)
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"))
  } catch {
    return null
  }
}

async function fileSha256OrNull(filePath) {
  try {
    return `sha256:${sha256(await fs.readFile(filePath))}`
  } catch {
    return null
  }
}

async function writeAtomic(filePath, bytes) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmpPath, bytes)
  await fs.rename(tmpPath, filePath)
}

export function decompressSnapshotBytes(compressed, codec = zlib) {
  if (typeof codec?.zstdDecompressSync !== "function") {
    return {
      bytes: null,
      reason: "snapshot_codec_unavailable",
    }
  }
  try {
    return {
      bytes: codec.zstdDecompressSync(compressed),
      reason: "snapshot_decompressed",
    }
  } catch {
    return {
      bytes: null,
      reason: "snapshot_corrupt",
    }
  }
}

function requiredPath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`)
  }
  return value
}

function normalizePath(value) {
  return value.replaceAll(path.sep, "/")
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}
