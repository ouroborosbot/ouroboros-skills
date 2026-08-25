"use strict"

const { createHash } = require("node:crypto")
const { readFileSync } = require("node:fs")
const path = require("node:path")

const ARTIFACT_SOURCE_PATHS = Object.freeze([
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
  "plugins/desk/mcp/src/artifacts/manifest-contracts.cjs",
  "plugins/desk/mcp/src/artifacts/policy.js",
  "plugins/desk/mcp/src/artifacts/publication.js",
  "plugins/desk/mcp/src/server-helpers.js",
  "plugins/desk/mcp/scripts/build-vector-pack.js",
  "plugins/desk/mcp/scripts/build-snapshot.js",
  "plugins/desk/mcp/scripts/verify-snapshot.js",
  "plugins/desk/mcp/scripts/validate-artifacts.js",
  "plugins/desk/mcp/src/db/schema.sql",
  "plugins/desk/mcp/package.json",
  "plugins/desk/mcp/package-lock.json",
])

const COMMON_FIELDS = Object.freeze([
  "schema_version",
  "embedding_spec_id",
  "dimension",
  "artifact_source_scope_hash",
  "document_tree_hash",
  "discovery_grammar_version",
  "represented_documents",
  "created_at",
  "provenance",
  "source_paths",
])
const VECTOR_PACK_FIELDS = Object.freeze([
  ...COMMON_FIELDS,
  "pack_id",
  "encoding",
  "row_count",
  "rows_sha256",
])
const SNAPSHOT_FIELDS = Object.freeze([
  ...COMMON_FIELDS,
  "snapshot_id",
  "chunker_id",
  "normalization_id",
  "db_schema",
  "sqlite_vec",
  "runtime",
  "included_pack_ids",
  "artifact",
])
const REPRESENTED_DOCUMENT_FIELDS = Object.freeze(["path", "hash"])
const PROVENANCE_FIELDS = Object.freeze(["builder", "source", "commit"])
const SNAPSHOT_ARTIFACT_FIELDS = Object.freeze([
  "file",
  "format",
  "sha256",
  "compressed",
])
const DB_SCHEMA_FIELDS = Object.freeze(["id", "version"])
const SQLITE_VEC_FIELDS = Object.freeze(["package", "version", "table"])
const RUNTIME_FIELDS = Object.freeze(["platform", "arch", "node_abi"])
const SHA256_RE = /^sha256:[a-f0-9]{64}$/u
const RAW_SHA256_RE = /^[a-f0-9]{64}$/u
const GIT_SHA_RE = /^[a-f0-9]{40}$/u
const IDENTIFIER_RE = /^[a-z0-9][a-z0-9._-]*$/iu
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const BUILDERS = Object.freeze({
  snapshot: "plugins/desk/mcp/scripts/build-snapshot.js",
  "vector-pack": "plugins/desk/mcp/scripts/build-vector-pack.js",
})

function validateArtifactManifest({
  artifactType,
  manifest,
  expectedSpec,
  expectedDbSchema,
  expectedSqliteVec,
  expectedRuntime,
  expectedArtifactSourceScopeHash,
  expectedDocumentTreeHash,
  expectedDiscoveryGrammarVersion,
  expectedSourcePaths = ARTIFACT_SOURCE_PATHS,
  expectedDocuments,
  artifactSha256,
} = {}) {
  const label = `${artifactType ?? "artifact"} manifest`
  const fields = artifactType === "vector-pack"
    ? VECTOR_PACK_FIELDS
    : artifactType === "snapshot"
      ? SNAPSHOT_FIELDS
      : null
  if (fields === null) {
    throw new Error("artifact manifest type must be snapshot or vector-pack")
  }
  assertExactObject(manifest, fields, label)
  assertEqual(manifest.schema_version, 1, `${label} schema_version must be 1`)
  assertPathSafeId(
    artifactType === "vector-pack" ? manifest.pack_id : manifest.snapshot_id,
    artifactType === "vector-pack" ? "pack_id" : "snapshot_id",
    label,
  )
  assertNonEmptyString(manifest.embedding_spec_id, `${label} embedding_spec_id`)
  assertInteger(manifest.dimension, `${label} dimension`, { minimum: 1 })
  if (expectedSpec !== undefined) {
    assertEqual(
      manifest.embedding_spec_id,
      expectedSpec.id,
      `${label} embedding_spec_id must match active spec`,
    )
    assertEqual(
      manifest.dimension,
      expectedSpec.dimension,
      `${label} dimension must match active spec`,
    )
  }
  assertSha(manifest.artifact_source_scope_hash, `${label} artifact_source_scope_hash`)
  assertSha(manifest.document_tree_hash, `${label} document_tree_hash`)
  if (expectedArtifactSourceScopeHash !== undefined) {
    assertEqual(
      manifest.artifact_source_scope_hash,
      expectedArtifactSourceScopeHash,
      `${label} artifact_source_scope_hash must match expected source scope`,
    )
  }
  if (expectedDocumentTreeHash !== undefined) {
    assertEqual(
      manifest.document_tree_hash,
      expectedDocumentTreeHash,
      `${label} document_tree_hash must match expected document tree`,
    )
  }
  assertInteger(
    manifest.discovery_grammar_version,
    `${label} discovery_grammar_version`,
    { minimum: 1 },
  )
  if (expectedDiscoveryGrammarVersion !== undefined) {
    assertEqual(
      manifest.discovery_grammar_version,
      expectedDiscoveryGrammarVersion,
      `${label} discovery_grammar_version must match expected grammar`,
    )
  }
  validateRepresentedDocuments({
    documents: manifest.represented_documents,
    expectedDocuments,
    label,
  })
  assertIsoTimestamp(manifest.created_at, `${label} created_at`)
  validateProvenance(manifest.provenance, artifactType, label)
  validateSourcePaths(manifest.source_paths, expectedSourcePaths, label)

  if (artifactType === "vector-pack") {
    validateVectorPackManifest({
      manifest,
      expectedSpec,
      artifactSha256,
      label,
    })
  } else {
    validateSnapshotManifest({
      manifest,
      expectedSpec,
      expectedDbSchema,
      expectedSqliteVec,
      expectedRuntime,
      artifactSha256,
      label,
    })
  }
  assertManifestValuePrivacy(manifest, label)
  return manifest
}

function validateVectorPackManifest({
  manifest,
  artifactSha256,
  label,
}) {
  assertEqual(
    manifest.encoding,
    "float32-json",
    `${label} encoding must be float32-json`,
  )
  assertInteger(manifest.row_count, `${label} row_count`, { minimum: 0 })
  if (typeof manifest.rows_sha256 !== "string" ||
      !RAW_SHA256_RE.test(manifest.rows_sha256)) {
    throw new Error(`${label} rows_sha256 must be a sha256 hex digest`)
  }
  if (artifactSha256 !== undefined) {
    const rawArtifactSha = String(artifactSha256).replace(/^sha256:/u, "")
    assertEqual(
      manifest.rows_sha256,
      rawArtifactSha,
      `${label} rows_sha256 must match vector pack`,
    )
  }
}

function validateSnapshotManifest({
  manifest,
  expectedSpec,
  expectedDbSchema,
  expectedSqliteVec,
  expectedRuntime,
  artifactSha256,
  label,
}) {
  assertNonEmptyString(manifest.chunker_id, `${label} chunker_id`)
  assertNonEmptyString(manifest.normalization_id, `${label} normalization_id`)
  if (expectedSpec !== undefined) {
    assertEqual(
      manifest.chunker_id,
      expectedSpec.chunker_id,
      `${label} chunker_id must match active spec`,
    )
    assertEqual(
      manifest.normalization_id,
      expectedSpec.normalization_id,
      `${label} normalization_id must match active spec`,
    )
  }

  assertExactObject(manifest.db_schema, DB_SCHEMA_FIELDS, `${label} db_schema`)
  assertNonEmptyString(manifest.db_schema.id, `${label} db_schema.id`)
  assertInteger(manifest.db_schema.version, `${label} db_schema.version`, {
    minimum: 1,
  })
  if (expectedDbSchema !== undefined) {
    assertDeepEqual(
      manifest.db_schema,
      expectedDbSchema,
      `${label} DB schema must match expected DB schema`,
    )
  }

  assertExactObject(manifest.sqlite_vec, SQLITE_VEC_FIELDS, `${label} sqlite_vec`)
  assertEqual(
    manifest.sqlite_vec.package,
    "sqlite-vec",
    `${label} sqlite_vec.package must be sqlite-vec`,
  )
  if (typeof manifest.sqlite_vec.version !== "string" ||
      !SEMVER_RE.test(manifest.sqlite_vec.version)) {
    throw new Error(`${label} sqlite_vec.version must be semantic version text`)
  }
  assertEqual(
    manifest.sqlite_vec.table,
    "vec0",
    `${label} sqlite_vec.table must be vec0`,
  )
  if (expectedSqliteVec !== undefined) {
    assertDeepEqual(
      manifest.sqlite_vec,
      expectedSqliteVec,
      `${label} sqlite-vec must match expected sqlite-vec`,
    )
  }

  assertExactObject(manifest.runtime, RUNTIME_FIELDS, `${label} runtime`)
  for (const field of RUNTIME_FIELDS) {
    assertNonEmptyString(manifest.runtime[field], `${label} runtime.${field}`)
  }
  if (expectedRuntime !== undefined) {
    assertDeepEqual(
      manifest.runtime,
      expectedRuntime,
      `${label} runtime must match expected runtime`,
    )
  }

  if (!Array.isArray(manifest.included_pack_ids)) {
    throw new Error(`${label} included_pack_ids must be an array`)
  }
  const packIds = new Set()
  for (const packId of manifest.included_pack_ids) {
    assertPathSafeId(packId, "included_pack_ids", label)
    if (packIds.has(packId)) {
      throw new Error(`${label} included_pack_ids must be unique`)
    }
    packIds.add(packId)
  }

  assertExactObject(
    manifest.artifact,
    SNAPSHOT_ARTIFACT_FIELDS,
    `${label} artifact`,
  )
  assertEqual(
    manifest.artifact.file,
    `${manifest.snapshot_id}.sqlite.zst`,
    `${label} artifact file must match snapshot_id`,
  )
  assertEqual(
    manifest.artifact.format,
    "sqlite-zstd",
    `${label} artifact format must be sqlite-zstd`,
  )
  assertSha(manifest.artifact.sha256, `${label} artifact sha256`)
  assertEqual(
    manifest.artifact.compressed,
    true,
    `${label} artifact compressed must be true`,
  )
  if (artifactSha256 !== undefined) {
    assertEqual(
      manifest.artifact.sha256,
      canonicalSha(artifactSha256),
      `${label} artifact sha256 must match artifact`,
    )
  }
}

function validateRepresentedDocuments({
  documents,
  expectedDocuments,
  label,
}) {
  if (!Array.isArray(documents)) {
    throw new Error(`${label} represented_documents must be an array`)
  }
  const seen = new Set()
  const normalized = []
  for (let index = 0; index < documents.length; index += 1) {
    const document = documents[index]
    assertExactObject(
      document,
      REPRESENTED_DOCUMENT_FIELDS,
      `${label} represented_documents[${index}]`,
    )
    const documentPath = assertNormalizedRelativePath(
      document.path,
      `${label} represented_documents[${index}].path`,
    )
    assertSha(document.hash, `${label} represented_documents[${index}].hash`)
    if (seen.has(documentPath)) {
      throw new Error(`${label} duplicate represented document path`)
    }
    seen.add(documentPath)
    normalized.push({ path: documentPath, hash: canonicalSha(document.hash) })
  }
  if (expectedDocuments !== undefined) {
    if (!Array.isArray(expectedDocuments)) {
      throw new Error(`${label} expected documents must be an array`)
    }
    const expected = expectedDocuments.map((document, index) => ({
      path: assertNormalizedRelativePath(
        document?.path,
        `${label} expected_documents[${index}].path`,
      ),
      hash: canonicalSha(document?.hash),
    }))
    if (stableStringify(sortDocuments(normalized)) !==
        stableStringify(sortDocuments(expected))) {
      throw new Error(`${label} represented_documents must match expected documents`)
    }
  }
}

function validateProvenance(provenance, artifactType, label) {
  assertExactObject(provenance, PROVENANCE_FIELDS, `${label} provenance`)
  assertEqual(
    provenance.builder,
    BUILDERS[artifactType],
    `${label} provenance.builder must match the canonical builder`,
  )
  assertEqual(
    provenance.source,
    "local-db",
    `${label} provenance.source must be local-db`,
  )
  if (typeof provenance.commit !== "string" ||
      !GIT_SHA_RE.test(provenance.commit)) {
    throw new Error(`${label} provenance.commit must be a git sha`)
  }
}

function validateSourcePaths(sourcePaths, expectedSourcePaths, label) {
  if (!Array.isArray(sourcePaths)) {
    throw new Error(`${label} source_paths must be an array`)
  }
  if (!Array.isArray(expectedSourcePaths) || expectedSourcePaths.length === 0) {
    throw new Error(`${label} expected source paths must be provided`)
  }
  const seen = new Set()
  for (let index = 0; index < sourcePaths.length; index += 1) {
    const sourcePath = assertNormalizedRelativePath(
      sourcePaths[index],
      `${label} source_paths[${index}]`,
    )
    if (seen.has(sourcePath)) {
      throw new Error(`${label} source_paths must be unique`)
    }
    seen.add(sourcePath)
  }
  if (stableStringify(sourcePaths) !== stableStringify(expectedSourcePaths)) {
    throw new Error(`${label} source_paths must match the canonical source list`)
  }
}

function assertManifestValuePrivacy(value, label, location = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertManifestValuePrivacy(entry, label, `${location}[${index}]`)
    })
    return
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (/^(?:body|raw|content)$/iu.test(key)) {
        throw new Error(`${label} field ${location}.${key} is not allowed`)
      }
      assertManifestValuePrivacy(entry, label, `${location}.${key}`)
    }
    return
  }
  if (typeof value !== "string") return
  if (value.includes("\0")) {
    throw new Error(`${label} string values must not contain null bytes`)
  }
  for (const candidate of normalizedPathCandidates(value)) {
    const normalized = candidate.replaceAll("\\", "/")
    const segments = normalized.split("/")
    if (segments.includes(".state")) {
      throw new Error(`${label} string values must not include private .state paths`)
    }
    if (
      path.posix.isAbsolute(normalized) ||
      path.win32.isAbsolute(candidate) ||
      segments.includes("..")
    ) {
      throw new Error(`${label} string values must not include unsafe paths`)
    }
  }
}

function assertExactObject(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const allowed = new Set(fields)
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      throw new Error(`${label} missing required field ${field}`)
    }
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      throw new Error(`${label} unknown field ${field}`)
    }
  }
}

function assertPathSafeId(value, field, label) {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) {
    throw new Error(`${label} invalid ${field}: path traversal is not allowed`)
  }
}

function assertNormalizedRelativePath(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    throw new Error(`${label} must be a normalized relative path`)
  }
  const normalized = path.posix.normalize(value)
  const segments = value.split("/")
  if (
    normalized !== value ||
    normalized === "." ||
    segments.some((segment) =>
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      segment === ".state" ||
      /^[a-z]:$/iu.test(segment)
    )
  ) {
    throw new Error(`${label} must be a normalized public relative path`)
  }
  return normalized
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be non-empty text`)
  }
}

function assertInteger(value, label, { minimum } = {}) {
  if (!Number.isInteger(value) || (minimum !== undefined && value < minimum)) {
    throw new Error(`${label} must be an integer${minimum === undefined ? "" : ` >= ${minimum}`}`)
  }
}

function assertSha(value, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new Error(`${label} must be sha256:<hex>`)
  }
}

function assertIsoTimestamp(value, label) {
  const parsed = typeof value === "string" ? new Date(value) : null
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`)
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message)
}

function assertDeepEqual(actual, expected, message) {
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new Error(message)
  }
}

function normalizedPathCandidates(value) {
  return String(value)
    .split(/[\s"'`<>{}\[\](),;=]+/u)
    .map((candidate) => candidate.replace(/^\/+|\/+$/gu, ""))
    .filter((candidate) => candidate !== "")
}

function sortDocuments(documents) {
  return [...documents].sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.hash.localeCompare(right.hash)
  )
}

function canonicalSha(value) {
  const text = String(value)
  return text.startsWith("sha256:") ? text : `sha256:${text}`
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(",")}}`
  }
  return JSON.stringify(value)
}

function artifactSourceScopeHash(mcpRoot, {
  readFile = readFileSync,
} = {}) {
  const hash = createHash("sha256")
  for (const repoPath of ARTIFACT_SOURCE_PATHS) {
    const relFromMcp = repoPath.replace(/^plugins\/desk\/mcp\//u, "")
    hash.update(`${repoPath}\0`)
    try {
      hash.update(readFile(path.join(mcpRoot, relFromMcp)))
    } catch {
      hash.update(Buffer.alloc(0))
    }
    hash.update("\0")
  }
  return `sha256:${hash.digest("hex")}`
}

module.exports = {
  ARTIFACT_SOURCE_PATHS,
  artifactSourceScopeHash,
  validateArtifactManifest,
}
