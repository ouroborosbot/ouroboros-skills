import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import {
  assertArtifactPublicationAllowed,
  policyForArtifactWrite,
} from "../artifacts/policy.js"
import {
  assertArtifactDoesNotRepresentTombstones,
  assertArtifactInputsDoNotContainTombstones,
} from "../artifacts/tombstones.js"
import { assertArtifactInputsAllowed } from "../indexer/exclusions.js"
import { ACTIVE_EMBEDDING_SPEC } from "../indexer/spec.js"
import { representedDocumentTreeHash } from "../indexer/document-tree.js"

const SNAPSHOT_FORMAT = "sqlite-zstd"
const ALLOWED_SOURCE_PREFIXES = Object.freeze([
  "plugins/desk/mcp/src/indexer/",
  "plugins/desk/mcp/src/snapshots/",
  "plugins/desk/mcp/src/artifacts/",
  "plugins/desk/mcp/scripts/",
])
const ALLOWED_SOURCE_FILES = Object.freeze([
  "plugins/desk/mcp/src/db/schema.sql",
  "plugins/desk/mcp/src/server-helpers.js",
  "plugins/desk/mcp/package.json",
  "plugins/desk/mcp/package-lock.json",
])

export function deriveSnapshotPaths({
  pluginRoot,
  embeddingSpecId = ACTIVE_EMBEDDING_SPEC.id,
  snapshotId,
} = {}) {
  assertPathSafeId(embeddingSpecId, "embedding_spec_id")
  assertPathSafeId(snapshotId, "snapshot_id")
  const snapshotDir = path.join(pluginRoot, "artifacts", "snapshots", embeddingSpecId)
  const snapshotPath = path.join(snapshotDir, `${snapshotId}.sqlite.zst`)
  return {
    snapshotDir,
    snapshotPath,
    manifestPath: path.join(snapshotDir, `${snapshotId}.manifest.json`),
    checksumPath: path.join(snapshotDir, `${snapshotId}.sha256`),
    relativeSnapshotPath: normalizePath(path.join(
      "plugins",
      "desk",
      "artifacts",
      "snapshots",
      embeddingSpecId,
      `${snapshotId}.sqlite.zst`,
    )),
  }
}

export async function writeSnapshotArtifact({
  pluginRoot,
  embeddingSpecId = ACTIVE_EMBEDDING_SPEC.id,
  snapshotId,
  snapshotBytes,
  manifestBytes,
  checksumBytes,
  policy,
  deskRoot,
  sourceDocs,
} = {}) {
  const paths = deriveSnapshotPaths({ pluginRoot, embeddingSpecId, snapshotId })
  await assertArtifactInputsAllowed({
    deskRoot,
    artifact_type: "snapshot",
    docs: sourceDocs,
  })
  await assertArtifactInputsDoNotContainTombstones({
    pluginRoot,
    artifact_type: "snapshot",
    sourceDocs,
  })
  const publicationPolicy = await policyForArtifactWrite({ pluginRoot, policy })
  await assertArtifactPublicationAllowed({
    policy: publicationPolicy,
    artifact_type: "snapshot",
    operation: "write",
    relative_path: paths.relativeSnapshotPath,
  })
  await fs.mkdir(paths.snapshotDir, { recursive: true })
  await writeAtomic(paths.snapshotPath, snapshotBytes)
  await writeAtomic(paths.manifestPath, manifestBytes)
  await writeAtomic(paths.checksumPath, checksumBytes)
  return paths
}

export async function validateSnapshotArtifact({
  pluginRoot,
  snapshotPath,
  manifestPath,
  checksumPath,
  expectedSpec = ACTIVE_EMBEDDING_SPEC,
  expectedDbSchema,
  expectedSqliteVec,
  expectedRuntime,
  expectedArtifactSourceScopeHash,
  expectedDocumentTreeHash,
  expectedDiscoveryGrammarVersion,
} = {}) {
  const label =
    typeof snapshotPath === "string" && snapshotPath.trim() !== ""
      ? path.basename(snapshotPath)
      : "snapshot"
  if (typeof snapshotPath !== "string" || snapshotPath.trim() === "") {
    throw new Error(`${label} snapshot path is required`)
  }
  if (!snapshotPath.endsWith(".sqlite.zst")) {
    throw new Error(`${label} snapshot path must end with .sqlite.zst`)
  }
  const resolvedManifestPath = manifestPath ?? sidecarPath(snapshotPath, ".manifest.json")
  const resolvedChecksumPath = checksumPath ?? sidecarPath(snapshotPath, ".sha256")
  const artifactBytes = await readRequiredFile(snapshotPath, `${label} snapshot`)
  const artifactSha256 = `sha256:${sha256(artifactBytes)}`
  const manifest = await readRequiredJson(resolvedManifestPath, `${label} manifest`)
  const checksum = await readRequiredChecksum(resolvedChecksumPath, `${label} checksum`)

  if (checksum !== artifactSha256) {
    throw new Error(`${label}: checksum mismatch for snapshot artifact`)
  }

  const result = validateSnapshotManifest({
    manifest,
    artifactSha256,
    expectedSpec,
    expectedDbSchema,
    expectedSqliteVec,
    expectedRuntime,
    expectedArtifactSourceScopeHash,
    expectedDocumentTreeHash,
    expectedDiscoveryGrammarVersion,
  })
  await assertArtifactDoesNotRepresentTombstones({
    pluginRoot,
    artifact_type: "snapshot",
    represented_documents: manifest.represented_documents,
  })
  if (manifest.artifact.file !== path.basename(snapshotPath)) {
    throw new Error(`${label}: manifest artifact file must match snapshot file`)
  }
  return result
}

export function validateSnapshotManifest({
  manifest,
  artifactSha256,
  expectedSpec = ACTIVE_EMBEDDING_SPEC,
  expectedDbSchema,
  expectedSqliteVec,
  expectedRuntime,
  expectedArtifactSourceScopeHash,
  expectedDocumentTreeHash,
  expectedDiscoveryGrammarVersion,
} = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("snapshot manifest must be an object")
  }
  if (manifest.schema_version !== 1) {
    throw new Error("snapshot manifest schema_version must be 1")
  }
  assertPathSafeId(manifest.snapshot_id, "snapshot_id")
  if (manifest.embedding_spec_id !== expectedSpec.id) {
    throw new Error("snapshot manifest embedding_spec_id must match active spec")
  }
  if (manifest.dimension !== expectedSpec.dimension) {
    throw new Error("snapshot manifest dimension must match active spec")
  }
  if (manifest.chunker_id !== expectedSpec.chunker_id) {
    throw new Error("snapshot manifest chunker_id must match active spec")
  }
  if (manifest.normalization_id !== expectedSpec.normalization_id) {
    throw new Error("snapshot manifest normalization_id must match active spec")
  }
  assertObjectEqual(manifest.db_schema, expectedDbSchema, "DB schema")
  assertObjectEqual(manifest.sqlite_vec, expectedSqliteVec, "sqlite-vec")
  assertObjectEqual(manifest.runtime, expectedRuntime, "runtime")
  assertSha(manifest.artifact_source_scope_hash, "artifact_source_scope_hash")
  assertSha(manifest.document_tree_hash, "document_tree_hash")
  assertIncludedPackIds(manifest.included_pack_ids)
  assertIsoTimestamp(manifest.created_at, "created_at")
  assertArtifact(manifest, artifactSha256)
  assertProvenance(manifest.provenance)
  assertSourcePaths(manifest.source_paths)

  const representedHash =
    representedDocumentTreeHash(manifest.represented_documents)
  const freshness = {
    artifact_source_scope:
      manifest.artifact_source_scope_hash === expectedArtifactSourceScopeHash
        ? "fresh"
        : "stale",
    document_tree:
      representedHash !== null &&
      representedHash === manifest.document_tree_hash &&
      representedHash === expectedDocumentTreeHash
        ? "fresh"
        : "stale",
  }
  if (expectedDiscoveryGrammarVersion !== undefined) {
    freshness.discovery_grammar =
      manifest.discovery_grammar_version === expectedDiscoveryGrammarVersion
        ? "fresh"
        : "stale"
  }

  return {
    compatible: true,
    snapshot_id: manifest.snapshot_id,
    embedding_spec_id: manifest.embedding_spec_id,
    included_pack_ids: [...manifest.included_pack_ids],
    manifest,
    freshness,
  }
}

function assertObjectEqual(actual, expected, label) {
  if (!expected || typeof expected !== "object") {
    throw new Error(`expected ${label} must be provided`)
  }
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new Error(`snapshot manifest ${label} must match expected ${label}`)
  }
}

function assertArtifact(manifest, artifactSha256) {
  const artifact = manifest.artifact
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error("snapshot manifest artifact is required")
  }
  if (artifact.file !== `${manifest.snapshot_id}.sqlite.zst`) {
    throw new Error("snapshot manifest artifact file must match snapshot_id")
  }
  if (artifact.format !== SNAPSHOT_FORMAT || artifact.compressed !== true) {
    throw new Error(`snapshot manifest artifact format must be ${SNAPSHOT_FORMAT}`)
  }
  assertSha(artifact.sha256, "artifact sha256")
  if (artifact.sha256 !== artifactSha256) {
    throw new Error("snapshot manifest artifact sha256 must match artifact")
  }
}

function assertProvenance(provenance) {
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    throw new Error("snapshot manifest provenance is required")
  }
  if (typeof provenance.builder !== "string" || provenance.builder.trim() === "") {
    throw new Error("snapshot manifest provenance builder is required")
  }
  if (typeof provenance.source !== "string" || provenance.source.trim() === "") {
    throw new Error("snapshot manifest provenance source is required")
  }
  if (
    typeof provenance.commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(provenance.commit)
  ) {
    throw new Error("snapshot manifest provenance commit must be a git sha")
  }
}

function assertSourcePaths(sourcePaths) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    throw new Error("snapshot manifest source_paths must be a non-empty array")
  }
  for (const sourcePath of sourcePaths) {
    if (typeof sourcePath !== "string" || sourcePath.trim() === "") {
      throw new Error("snapshot manifest source_paths must be strings")
    }
    const segments = sourcePath.split(/[\\/]+/u)
    if (path.isAbsolute(sourcePath)) {
      throw new Error("snapshot manifest must not include absolute source path")
    }
    if (
      sourcePath.includes("\\") ||
      segments.some((segment) => /^[a-z]:$/iu.test(segment))
    ) {
      throw new Error("snapshot manifest source path must be a normalized repo path")
    }
    if (
      segments.some((segment) => segment === "..")
    ) {
      throw new Error("snapshot manifest source path traversal is not allowed")
    }
    const normalized = normalizePath(path.normalize(sourcePath))
    const allowed =
      ALLOWED_SOURCE_FILES.includes(normalized) ||
      ALLOWED_SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    if (!allowed) {
      throw new Error("snapshot manifest unexpected source path")
    }
  }
}

function assertIncludedPackIds(value) {
  if (!Array.isArray(value)) {
    throw new Error("snapshot manifest included_pack_ids must be an array")
  }
  for (const packId of value) {
    assertPathSafeId(packId, "included_pack_ids")
  }
}

function assertSha(value, label) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`snapshot manifest ${label} must be sha256:<hex>`)
  }
}

function assertIsoTimestamp(value, label) {
  const parsed = typeof value === "string" ? new Date(value) : null
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`snapshot manifest ${label} must be an ISO timestamp`)
  }
}

async function readRequiredFile(filePath, label) {
  try {
    return await fs.readFile(filePath)
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} missing`)
    }
    throw error
  }
}

async function readRequiredJson(filePath, label) {
  const bytes = await readRequiredFile(filePath, label)
  try {
    return JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error(`${label} must be valid JSON`)
  }
}

async function readRequiredChecksum(filePath, label) {
  const bytes = await readRequiredFile(filePath, label)
  const match = bytes.toString("utf8").match(/^\s*(sha256:[a-f0-9]{64}|[a-f0-9]{64})\b/u)
  if (!match) {
    throw new Error(`${label} must start with a sha256 digest`)
  }
  return match[1].startsWith("sha256:") ? match[1] : `sha256:${match[1]}`
}

async function writeAtomic(filePath, bytes) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporaryPath, bytes)
    await fs.rename(temporaryPath, filePath)
  } finally {
    await fs.rm(temporaryPath, { force: true })
  }
}

function sidecarPath(snapshotPath, suffix) {
  return snapshotPath.replace(/\.sqlite\.zst$/u, suffix)
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value))
}

function stableValue(value) {
  if (!value || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(stableValue)
  const sorted = {}
  for (const key of Object.keys(value).sort()) {
    sorted[key] = stableValue(value[key])
  }
  return sorted
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function assertPathSafeId(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    path.isAbsolute(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("..")
  ) {
    throw new Error(`invalid ${label}: path traversal is not allowed`)
  }
}

function normalizePath(value) {
  return value.replaceAll(path.sep, "/")
}
