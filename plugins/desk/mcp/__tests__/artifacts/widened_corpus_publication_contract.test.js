import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { zstdDecompressSync } from "node:zlib"

import {
  buildSnapshotFromLocalDb,
  buildVectorPackFromLocalDb,
} from "../../src/artifacts/artifact-scripts.js"
import {
  evaluateArtifactPublication,
} from "../../src/artifacts/policy.js"
import { closeDb, indexDbPath, openDb } from "../../src/db/init.js"
import { discover } from "../../src/indexer/discover.js"
import { rebuildIndex } from "../../src/indexer/index.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"
import { validateVectorPackFile } from "../../src/indexer/vector-packs.js"
import {
  ensureIndex,
  resolveEnsureIndexOptions,
} from "../../src/server-helpers.js"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")
const pluginRoot = path.join(repoRoot, "plugins", "desk")
const fixtureRoot = path.join(mcpRoot, "__tests__", "fixtures", "widened-corpus")
const policySchemaPath = path.join(pluginRoot, "artifacts", "publication-policy.schema.json")
const productionNotesPath = path.join(
  repoRoot,
  "desk",
  "tasks",
  "2026-06-14-1335-doing-desk-dependency-activation",
  "production-artifacts.md",
)
const require = createRequire(import.meta.url)
const generatedArtifacts = require(path.join(repoRoot, "scripts", "test-desk-generated-artifacts.cjs"))

const ALLOWED_PATHS = Object.freeze([
  "nested/visible.md",
  "references/cache-only.md",
  "references/deleted.md",
  "references/frontmatter.md",
  "references/guide.md",
  "references/malformed.md",
  "references/personal-note.md",
  "references/redacted.md",
  "sample-track/_planning/architecture.md",
  "sample-track/sample-task/planning.md",
  "sample-track/track.md",
])
const EXCLUDED_PATHS = Object.freeze([
  ".git/internal.md",
  ".state/local-cache.md",
  "_secrets/ignored.md",
  "credentials/ignored.md",
  "nested/private-notes/ignored.md",
  "node_modules/example/README.md",
  "references/customer-secrets.md",
])
const EXCLUDED_MARKERS = Object.freeze([
  "SYNTHETIC_EXCLUDED_CREDENTIAL_BODY",
  "SYNTHETIC_EXCLUDED_GIT_BODY",
  "SYNTHETIC_EXCLUDED_NESTED_BODY",
  "SYNTHETIC_EXCLUDED_NODE_MODULE_BODY",
  "SYNTHETIC_EXCLUDED_SECRET_BODY",
  "SYNTHETIC_EXCLUDED_SENSITIVE_NAME_BODY",
  "SYNTHETIC_EXCLUDED_STATE_BODY",
])
const MANIFEST_VALUE_LEAK_PROBES = Object.freeze([
  "SYNTHETIC_PRIVATE_BODY_MARKER",
  "SYNTHETIC_PRIVATE_CONTENT_MARKER",
  "SYNTHETIC_PRIVATE_SNIPPET_MARKER",
  "SYNTHETIC_PRIVATE_QUERY_MARKER",
])
const WIDENED_SOURCE_SCOPE_PATHS = Object.freeze([
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
  "plugins/desk/mcp/src/server-helpers.js",
  "plugins/desk/mcp/scripts/build-vector-pack.js",
  "plugins/desk/mcp/scripts/build-snapshot.js",
  "plugins/desk/mcp/scripts/verify-snapshot.js",
  "plugins/desk/mcp/scripts/validate-artifacts.js",
  "plugins/desk/mcp/src/db/schema.sql",
  "plugins/desk/mcp/package.json",
  "plugins/desk/mcp/package-lock.json",
])
const PUBLICATION_GUIDANCE_DOCS = Object.freeze([
  "plugins/desk/README.md",
  "plugins/desk/mcp/README.md",
  "plugins/desk/activation/README.md",
  "plugins/desk/artifacts/vector-packs/README.md",
  "plugins/desk/artifacts/snapshots/README.md",
])
const PUBLIC_VECTOR_MANIFEST_PATH = path.join(
  pluginRoot,
  "artifacts",
  "vector-packs",
  ACTIVE_EMBEDDING_SPEC.id,
  "repo-public-bootstrap-2026-06-15.manifest.json",
)
const PUBLIC_SNAPSHOT_MANIFEST_PATH = path.join(
  pluginRoot,
  "artifacts",
  "snapshots",
  ACTIVE_EMBEDDING_SPEC.id,
  "repo-public-bootstrap-2026-06-15.manifest.json",
)
const PUBLIC_MANIFEST_PATHS = Object.freeze([
  PUBLIC_VECTOR_MANIFEST_PATH,
  PUBLIC_SNAPSHOT_MANIFEST_PATH,
])
const REMOVED_DOCUMENTS = Object.freeze([
  {
    path: "references/cache-only.md",
    marker: "SYNTHETIC_ALLOWED_CACHE_BODY",
  },
  {
    path: "references/deleted.md",
    marker: "SYNTHETIC_ALLOWED_DELETED_BODY",
  },
  {
    path: "references/redacted.md",
    marker: "SYNTHETIC_ALLOWED_REDACTED_BODY",
  },
])
const PRIVATE_CORPUS_MARKERS = Object.freeze([
  ".state/benchmarks",
  "queries-blind",
  "release-partition",
  "private-canary",
])
const VECTOR_PACK_ROW_KEYS = Object.freeze([
  "chunk_key",
  "dimension",
  "embedding_spec_id",
  "encoding",
  "text_hash",
  "vector",
])
const IDENTIFIER_SCHEMA = Object.freeze({
  type: "string",
  pattern: /^[a-z0-9][a-z0-9._-]*$/iu,
})
const SHA256_SCHEMA = Object.freeze({
  type: "string",
  pattern: /^sha256:[a-f0-9]{64}$/u,
})
const REPRESENTED_DOCUMENT_SCHEMA = objectSchema({
  hash: SHA256_SCHEMA,
  path: { type: "string", minLength: 1 },
})
const SHARED_MANIFEST_SCHEMA = Object.freeze({
  artifact_source_scope_hash: SHA256_SCHEMA,
  created_at: { type: "string", format: "iso-timestamp" },
  dimension: { type: "number", integer: true, const: ACTIVE_EMBEDDING_SPEC.dimension },
  discovery_grammar_version: { type: "number", integer: true, const: 2 },
  document_tree_hash: SHA256_SCHEMA,
  embedding_spec_id: { type: "string", const: ACTIVE_EMBEDDING_SPEC.id },
  represented_documents: arraySchema(REPRESENTED_DOCUMENT_SCHEMA),
  schema_version: { type: "number", integer: true, const: 1 },
  source_paths: arraySchema({ type: "string", minLength: 1 }),
})
const VECTOR_PACK_MANIFEST_SCHEMA = objectSchema({
  ...SHARED_MANIFEST_SCHEMA,
  encoding: { type: "string", const: "float32-json" },
  pack_id: IDENTIFIER_SCHEMA,
  provenance: provenanceSchema("plugins/desk/mcp/scripts/build-vector-pack.js"),
  row_count: { type: "number", integer: true, minimum: 0 },
  rows_sha256: { type: "string", pattern: /^[a-f0-9]{64}$/u },
})
const SNAPSHOT_MANIFEST_SCHEMA = objectSchema({
  ...SHARED_MANIFEST_SCHEMA,
  artifact: objectSchema({
    compressed: { type: "boolean", const: true },
    file: { type: "string", pattern: /^[a-z0-9][a-z0-9._-]*\.sqlite\.zst$/iu },
    format: { type: "string", const: "sqlite-zstd" },
    sha256: SHA256_SCHEMA,
  }),
  chunker_id: { type: "string", const: ACTIVE_EMBEDDING_SPEC.chunker_id },
  db_schema: objectSchema({
    id: { type: "string", const: "desk-index-sqlite-v1" },
    version: { type: "number", integer: true, const: 1 },
  }),
  included_pack_ids: arraySchema(IDENTIFIER_SCHEMA),
  normalization_id: { type: "string", const: ACTIVE_EMBEDDING_SPEC.normalization_id },
  provenance: provenanceSchema("plugins/desk/mcp/scripts/build-snapshot.js"),
  runtime: objectSchema({
    arch: { type: "string", const: "portable" },
    node_abi: { type: "string", const: "portable" },
    platform: { type: "string", const: "portable" },
  }),
  snapshot_id: IDENTIFIER_SCHEMA,
  sqlite_vec: objectSchema({
    package: { type: "string", const: "sqlite-vec" },
    table: { type: "string", const: "vec0" },
    version: { type: "string", pattern: /^\d+\.\d+\.\d+$/u },
  }),
})
const MANIFEST_SCHEMAS = Object.freeze({
  snapshot: SNAPSHOT_MANIFEST_SCHEMA,
  "vector-pack": VECTOR_PACK_MANIFEST_SCHEMA,
})

function objectSchema(properties) {
  return Object.freeze({ type: "object", properties: Object.freeze(properties) })
}

function arraySchema(items) {
  return Object.freeze({ type: "array", items })
}

function provenanceSchema(builder) {
  return objectSchema({
    builder: { type: "string", const: builder },
    commit: { type: "string", pattern: /^[a-f0-9]{40}$/u },
    source: { type: "string", const: "local-db" },
  })
}

async function collectSyntheticFixtureBodyMarkers() {
  const markers = new Set(EXCLUDED_MARKERS)
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(entryPath)
        continue
      }
      const body = await readFile(entryPath, "utf8")
      for (const marker of body.match(/\bSYNTHETIC_[A-Z0-9_]+_BODY\b/gu) ?? []) {
        markers.add(marker)
      }
    }
  }
  await visit(fixtureRoot)
  return [...markers].sort()
}

const SYNTHETIC_FIXTURE_BODY_MARKERS = Object.freeze(
  await collectSyntheticFixtureBodyMarkers(),
)

async function scratchRoot(prefix) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`))
  const relativeToSource = path.relative(mcpRoot, scratch)
  assert.ok(
    path.isAbsolute(relativeToSource) ||
      relativeToSource === ".." ||
      relativeToSource.startsWith(`..${path.sep}`),
    `scratch root must stay outside source: ${scratch}`,
  )
  return scratch
}

async function writeText(root, relativePath, body) {
  const filePath = path.join(root, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, body, "utf8")
  return filePath
}

async function copyCorpusFixture(targetRoot) {
  await cp(fixtureRoot, targetRoot, { recursive: true })
  await writeText(targetRoot, ".git/internal.md", "# Synthetic git internal\n\nSYNTHETIC_EXCLUDED_GIT_BODY")
  await writeText(
    targetRoot,
    ".state/local-cache.md",
    "# Synthetic local state\n\nSYNTHETIC_EXCLUDED_STATE_BODY",
  )
  await writeText(
    targetRoot,
    "node_modules/example/README.md",
    "# Synthetic dependency doc\n\nSYNTHETIC_EXCLUDED_NODE_MODULE_BODY",
  )
}

async function copyDeskWithoutLocalState(sourceRoot, targetRoot) {
  await cp(sourceRoot, targetRoot, {
    recursive: true,
    filter: (source) => {
      const relativePath = path.relative(sourceRoot, source)
      if (relativePath === "") return true
      const [first] = relativePath.split(path.sep)
      return ![".git", ".state", "node_modules"].includes(first)
    },
  })
}

function embedFetch(prompts = []) {
  return async (_url, request) => {
    prompts.push(JSON.parse(request.body).prompt)
    return {
      ok: true,
      json: async () => ({
        embedding: Array.from(
          { length: ACTIVE_EMBEDDING_SPEC.dimension },
          (_, index) => (index % 31) / 31,
        ),
      }),
    }
  }
}

function publicationPolicy({ approved = false } = {}) {
  const approvedTypes = ["snapshot", "vector-pack"]
  return {
    schema_version: 1,
    default_publication: "deny",
    repo_visibility: "public",
    sensitive_repo: true,
    approved_artifact_types: approvedTypes,
    approval_required: true,
    approvals: approved
      ? approvedTypes.map((artifactType) => ({
          scope: "repo",
          artifact_type: artifactType,
          approved_by: "synthetic-reviewer",
          approved_at: "2026-08-24T00:00:00.000Z",
          reason: "Synthetic widened-corpus fixture reviewed and approved for artifact contract testing.",
        }))
      : [],
    updated_at: "2026-08-24T00:00:00.000Z",
  }
}

async function writePublicationPolicy(targetPluginRoot, policy) {
  await mkdir(path.join(targetPluginRoot, "artifacts"), { recursive: true })
  await cp(
    policySchemaPath,
    path.join(targetPluginRoot, "artifacts", "publication-policy.schema.json"),
  )
  await writeFile(
    path.join(targetPluginRoot, "artifacts", "publication-policy.json"),
    `${JSON.stringify(policy, null, 2)}\n`,
    "utf8",
  )
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

async function writeTombstone(targetPluginRoot, relativePath, body) {
  const ledgerPath = path.join(
    targetPluginRoot,
    "artifacts",
    "tombstones",
    "tombstones.jsonl",
  )
  await mkdir(path.dirname(ledgerPath), { recursive: true })
  await writeFile(
    ledgerPath,
    `${JSON.stringify({
      schema_version: 1,
      document_path: relativePath,
      document_hash: sha256(body),
      reason: "redacted",
      redacted_at: "2026-08-24T00:00:00.000Z",
      effective_from: "2026-08-24T00:00:00.000Z",
      artifact_rotation_id: "synthetic-unit-6a-rotation",
      actor: "synthetic-reviewer",
    })}\n`,
    "utf8",
  )
}

function indexedPaths(deskRoot) {
  const db = openDb(deskRoot)
  try {
    return db.prepare("SELECT path FROM docs ORDER BY path").all().map((row) => row.path)
  } finally {
    closeDb(db)
  }
}

function indexedText(deskRoot) {
  return indexedChunks(deskRoot).map((row) => row.text).join("\n")
}

function indexedChunks(deskRoot) {
  const db = openDb(deskRoot)
  try {
    return db.prepare(
      `SELECT d.path, c.chunk_key, c.text_hash, c.text
       FROM chunks c
       JOIN docs d ON d.id = c.doc_id
       ORDER BY d.path, c.chunk_index`,
    ).all()
  } finally {
    closeDb(db)
  }
}

function captureRemovedDocuments(deskRoot) {
  const db = openDb(deskRoot)
  try {
    const allText = db.prepare("SELECT text FROM chunks ORDER BY id").all()
      .map((row) => row.text)
      .join("\n")
    return REMOVED_DOCUMENTS.map((document) => {
      const chunks = db.prepare(
        `SELECT c.chunk_key, c.text_hash, c.text
         FROM chunks c
         JOIN docs d ON d.id = c.doc_id
         WHERE d.path = ?
         ORDER BY c.chunk_index`,
      ).all(document.path)
      assert.ok(chunks.length > 0, `${document.path} must have indexed chunks before removal`)
      assert.equal(
        chunks.filter((chunk) => chunk.text.includes(document.marker)).length,
        1,
        `${document.path} must expose one indexed chunk with its unique marker`,
      )
      assert.equal(
        allText.split(document.marker).length - 1,
        1,
        `${document.marker} must be unique in the pre-removal index`,
      )
      return {
        ...document,
        chunks: chunks.map((chunk) => ({
          chunk_key: chunk.chunk_key,
          text_hash: chunk.text_hash,
        })),
      }
    })
  } finally {
    closeDb(db)
  }
}

function capturedIdentity(identity) {
  return `${identity.chunk_key}\0${identity.text_hash}`
}

function assertCapturedDocumentsPresent(rows, captures, label) {
  const identities = new Set(rows.map(capturedIdentity))
  for (const capture of captures) {
    for (const identity of capture.chunks) {
      assert.ok(
        identities.has(capturedIdentity(identity)),
        `${label} must initially contain captured identity for ${capture.path}`,
      )
    }
  }
}

function assertCapturedDocumentsAbsent(rows, captures, label, { text = true } = {}) {
  const chunkKeys = new Set(rows.map((row) => row.chunk_key))
  const textHashes = new Set(rows.map((row) => row.text_hash))
  const liveText = text
    ? rows.map((row) => row.text ?? "").join("\n")
    : ""
  for (const capture of captures) {
    if (text) {
      assert.equal(
        liveText.includes(capture.marker),
        false,
        `${label} leaked removed marker for ${capture.path}`,
      )
    }
    for (const identity of capture.chunks) {
      assert.equal(
        chunkKeys.has(identity.chunk_key),
        false,
        `${label} leaked removed chunk key for ${capture.path}`,
      )
      assert.equal(
        textHashes.has(identity.text_hash),
        false,
        `${label} leaked removed text hash for ${capture.path}`,
      )
    }
  }
}

function capturedRemovedValues(captures) {
  return captures.flatMap((capture) => [
    {
      kind: "body marker",
      path: capture.path,
      value: capture.marker,
    },
    ...capture.chunks.flatMap((identity) => [
      {
        kind: "chunk key",
        path: capture.path,
        value: identity.chunk_key,
      },
      {
        kind: "text hash",
        path: capture.path,
        value: identity.text_hash,
      },
    ]),
  ])
}

function assertSerializedTreeExcludesCaptured(value, captures, label) {
  const removedValues = capturedRemovedValues(captures)
  const leaks = []
  const inspectSerialized = (candidate, location) => {
    const serialized = JSON.stringify(candidate)
    assert.notEqual(serialized, undefined, `${label} ${location} must be JSON-serializable`)
    for (const removed of removedValues) {
      if (serialized.includes(removed.value)) {
        leaks.push(`${location}: ${removed.kind} for ${removed.path}`)
      }
    }
  }
  const visit = (candidate, location) => {
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${location}[${index}]`))
      return
    }
    if (candidate !== null && typeof candidate === "object") {
      for (const [key, entry] of Object.entries(candidate)) {
        inspectSerialized(key, `${location} key`)
        visit(entry, `${location}.${key}`)
      }
      return
    }
    inspectSerialized(candidate, location)
  }
  visit(value, "$")
  assert.deepEqual(leaks, [], `${label} leaked captured values:\n${leaks.join("\n")}`)
}

function assertAllowedManifestSchema(manifest, artifactType, label) {
  const schema = MANIFEST_SCHEMAS[artifactType]
  assert.ok(schema, `${label} must identify a supported artifact type`)
  const visit = (value, currentSchema, location) => {
    if (currentSchema.type === "object") {
      assert.ok(
        value !== null && typeof value === "object" && !Array.isArray(value),
        `${label} ${location} must be an object`,
      )
      assert.deepEqual(
        Object.keys(value).sort(),
        Object.keys(currentSchema.properties).sort(),
        `${label} ${location} must contain exactly the allowed fields`,
      )
      for (const [key, childSchema] of Object.entries(currentSchema.properties)) {
        visit(value[key], childSchema, `${location}.${key}`)
      }
      return
    }
    if (currentSchema.type === "array") {
      assert.ok(Array.isArray(value), `${label} ${location} must be an array`)
      value.forEach((entry, index) => {
        visit(entry, currentSchema.items, `${location}[${index}]`)
      })
      return
    }
    assert.equal(typeof value, currentSchema.type, `${label} ${location} has the wrong type`)
    if (currentSchema.type === "number") {
      assert.ok(Number.isFinite(value), `${label} ${location} must be finite`)
      if (currentSchema.integer) {
        assert.ok(Number.isInteger(value), `${label} ${location} must be an integer`)
      }
      if (currentSchema.minimum !== undefined) {
        assert.ok(value >= currentSchema.minimum, `${label} ${location} is below its minimum`)
      }
    }
    if (currentSchema.type === "string" && currentSchema.minLength !== undefined) {
      assert.ok(
        value.length >= currentSchema.minLength,
        `${label} ${location} must not be empty`,
      )
    }
    if (currentSchema.pattern) {
      assert.match(value, currentSchema.pattern, `${label} ${location} has an invalid value`)
    }
    if (currentSchema.format === "iso-timestamp") {
      const parsed = new Date(value)
      assert.equal(
        Number.isNaN(parsed.getTime()) ? null : parsed.toISOString(),
        value,
        `${label} ${location} must be an ISO timestamp`,
      )
    }
    if (Object.hasOwn(currentSchema, "const")) {
      assert.equal(value, currentSchema.const, `${label} ${location} must preserve its contract`)
    }
  }
  visit(manifest, schema, "$")
  if (artifactType === "snapshot") {
    assert.equal(
      manifest.artifact.file,
      `${manifest.snapshot_id}.sqlite.zst`,
      `${label} artifact file must match snapshot_id`,
    )
  }
}

function manifestStringValueLeaks(value, forbiddenMarkers, location = "$", leaks = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      manifestStringValueLeaks(entry, forbiddenMarkers, `${location}[${index}]`, leaks)
    })
    return leaks
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      manifestStringValueLeaks(entry, forbiddenMarkers, `${location}.${key}`, leaks)
    }
    return leaks
  }
  if (typeof value !== "string") return leaks
  for (const marker of forbiddenMarkers) {
    if (value.includes(marker)) leaks.push(`${location}: ${marker}`)
  }
  return leaks
}

function assertManifestStringValuesExcludeMarkers(manifest, markers, label) {
  const leaks = manifestStringValueLeaks(manifest, markers)
  assert.deepEqual(leaks, [], `${label} leaked private content markers:\n${leaks.join("\n")}`)
}

function normalizedPathCandidates(value) {
  return String(value)
    .replaceAll("\\", "/")
    .split(/[\s"'`<>{}\[\](),;:=]+/u)
    .map((candidate) => candidate.replace(/^\/+|\/+$/gu, ""))
    .filter((candidate) => candidate !== "")
}

function statePathLeaks(value, location = "$", leaks = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => statePathLeaks(entry, `${location}[${index}]`, leaks))
    return leaks
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      statePathLeaks(entry, `${location}.${key}`, leaks)
    }
    return leaks
  }
  if (typeof value !== "string") return leaks
  for (const candidate of normalizedPathCandidates(value)) {
    if (candidate.split("/").includes(".state")) {
      leaks.push(`${location}: ${candidate}`)
    }
  }
  return leaks
}

function assertTreeExcludesStatePaths(value, label) {
  const leaks = statePathLeaks(value)
  assert.deepEqual(leaks, [], `${label} leaked .state paths:\n${leaks.join("\n")}`)
}

function parseGitTrackedPaths(stdout) {
  const delimiter = stdout.includes("\0") ? "\0" : /\r?\n/u
  return stdout
    .split(delimiter)
    .map((trackedPath) => trackedPath.trim())
    .filter((trackedPath) => trackedPath !== "")
    .map((trackedPath) => trackedPath.replaceAll("\\", "/"))
}

function assertTrackedPathsExcludeState(stdout, label) {
  const leaks = parseGitTrackedPaths(stdout)
    .filter((trackedPath) => trackedPath.split("/").includes(".state"))
  assert.deepEqual(leaks, [], `${label} tracked .state paths:\n${leaks.join("\n")}`)
}

function assertVectorPackRowSchema(row, label, index) {
  assert.deepEqual(
    Object.keys(row).sort(),
    VECTOR_PACK_ROW_KEYS,
    `${label} row ${index + 1} must contain exactly the allowed fields`,
  )
  assert.match(row.chunk_key, /^ck_[a-f0-9]{40}$/u)
  assert.match(row.text_hash, /^sha256:[a-f0-9]{64}$/u)
  assert.equal(row.embedding_spec_id, ACTIVE_EMBEDDING_SPEC.id)
  assert.equal(row.dimension, ACTIVE_EMBEDDING_SPEC.dimension)
  assert.equal(row.encoding, "float32-json")
  assert.ok(Array.isArray(row.vector), `${label} row ${index + 1} vector must be an array`)
  assert.equal(row.vector.length, ACTIVE_EMBEDDING_SPEC.dimension)
  assert.ok(
    row.vector.every((component) => typeof component === "number" && Number.isFinite(component)),
    `${label} row ${index + 1} vector components must be finite numbers`,
  )
}

function assertVectorPackRowsExcludeCaptured(rows, captures, label) {
  rows.forEach((row, index) => {
    assertVectorPackRowSchema(row, label, index)
    assertSerializedTreeExcludesCaptured(row, captures, `${label} row ${index + 1}`)
  })
}

function assertSnapshotBytesExcludeCaptured(sqliteBytes, captures, label) {
  const leaks = []
  for (const removed of capturedRemovedValues(captures)) {
    if (sqliteBytes.includes(Buffer.from(removed.value))) {
      leaks.push(`${removed.kind} for ${removed.path}`)
    }
  }
  assert.deepEqual(leaks, [], `${label} leaked captured values:\n${leaks.join("\n")}`)
}

function parseVectorPackRows(packBytes) {
  return packBytes
    .toString("utf8")
    .split(/\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
}

async function inspectSnapshotPayload({
  snapshotBytes,
  scratch,
  name,
}) {
  const sqliteBytes = zstdDecompressSync(snapshotBytes)
  const dbPath = path.join(scratch, `${name}.sqlite`)
  await writeFile(dbPath, sqliteBytes)
  const db = openDb(scratch, { dbPath })
  try {
    return {
      sqliteBytes,
      docs: db.prepare("SELECT path FROM docs ORDER BY path").all().map((row) => row.path),
      chunks: db.prepare(
        `SELECT d.path, c.chunk_key, c.text_hash, c.text
         FROM chunks c
         JOIN docs d ON d.id = c.doc_id
         ORDER BY d.path, c.chunk_index`,
      ).all(),
    }
  } finally {
    closeDb(db)
  }
}

function artifactPaths(targetPluginRoot, artifactType, artifactId) {
  const artifactDir = path.join(
    targetPluginRoot,
    "artifacts",
    artifactType === "vector-pack" ? "vector-packs" : "snapshots",
    ACTIVE_EMBEDDING_SPEC.id,
  )
  const primarySuffix = artifactType === "vector-pack" ? ".jsonl" : ".sqlite.zst"
  return {
    primary: path.join(artifactDir, `${artifactId}${primarySuffix}`),
    manifest: path.join(artifactDir, `${artifactId}.manifest.json`),
    checksum: path.join(artifactDir, `${artifactId}.sha256`),
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"))
}

function assertManifestIsMetadataOnly(
  manifest,
  artifactType,
  scratch,
  expectedPaths,
  captures = [],
) {
  const serialized = JSON.stringify(manifest)
  assertAllowedManifestSchema(manifest, artifactType, `${artifactType} manifest`)
  assert.doesNotMatch(serialized, /"(?:absPath|body|frontmatter|raw)"\s*:/u)
  assert.equal(serialized.includes(scratch), false)
  for (const excludedPath of EXCLUDED_PATHS) assert.equal(serialized.includes(excludedPath), false)
  assertManifestStringValuesExcludeMarkers(
    manifest,
    [...SYNTHETIC_FIXTURE_BODY_MARKERS, ...MANIFEST_VALUE_LEAK_PROBES],
    `${artifactType} manifest`,
  )
  assertTreeExcludesStatePaths(manifest, `${artifactType} manifest`)
  assertSerializedTreeExcludesCaptured(manifest, captures, "artifact manifest")
  assert.deepEqual(
    manifest.represented_documents.map((doc) => doc.path).sort(),
    [...expectedPaths].sort(),
  )
  assert.ok(
    manifest.represented_documents.every((doc) => (
      Object.keys(doc).sort().join(",") === "hash,path" &&
      /^sha256:[a-f0-9]{64}$/u.test(doc.hash)
    )),
  )
  assert.equal(manifest.discovery_grammar_version, 2)
}

function assertManifestSourceScope(manifest) {
  assert.equal(new Set(manifest.source_paths).size, manifest.source_paths.length)
  assert.deepEqual(
    [...manifest.source_paths].sort(),
    [...WIDENED_SOURCE_SCOPE_PATHS].sort(),
    "source scope must contain exactly the widened production paths",
  )
  assert.ok(manifest.source_paths.every((sourcePath) => (
    sourcePath.startsWith("plugins/desk/mcp/") &&
    !sourcePath.includes("\\") &&
    !sourcePath.includes("benchmark") &&
    !sourcePath.includes("canary")
  )))
}

test("directory-form and nested exclusions run before discovery, chunking, embedding, and local index writes", async () => {
  const scratch = await scratchRoot("unit-6a-discovery")
  const deskRoot = path.join(scratch, "desk")
  try {
    await copyCorpusFixture(deskRoot)
    const docs = await discover(deskRoot)
    assert.deepEqual(docs.map((doc) => doc.path), ALLOWED_PATHS)
    assert.equal(docs.find((doc) => doc.path === "sample-track/track.md").kind, "track")
    assert.equal(
      docs.find((doc) => doc.path === "sample-track/sample-task/planning.md").kind,
      "planning",
    )
    assert.equal(
      docs.find((doc) => doc.path === "sample-track/_planning/architecture.md").kind,
      "reference",
    )
    const malformed = docs.find((doc) => doc.path === "references/malformed.md")
    assert.equal(malformed.kind, "reference")
    assert.equal(malformed.status, null)
    assert.match(malformed.body, /SYNTHETIC_ALLOWED_MALFORMED_BODY/u)

    const prompts = []
    await rebuildIndex(deskRoot, { embed: { fetch: embedFetch(prompts) } })
    assert.deepEqual(indexedPaths(deskRoot), ALLOWED_PATHS)
    const embeddedText = prompts.join("\n")
    assert.match(embeddedText, /SYNTHETIC_ALLOWED_REFERENCE_BODY/u)
    for (const marker of EXCLUDED_MARKERS) assert.equal(embeddedText.includes(marker), false)
    const chunkText = indexedText(deskRoot)
    for (const marker of EXCLUDED_MARKERS) assert.equal(chunkText.includes(marker), false)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test("widened local index eligibility never bypasses snapshot or vector-pack approval decisions", async () => {
  const scratch = await scratchRoot("unit-6a-policy")
  const deskRoot = path.join(scratch, "desk")
  const deniedPluginRoot = path.join(scratch, "plugin")
  try {
    await copyCorpusFixture(deskRoot)
    await rebuildIndex(deskRoot, { embed: { fetch: embedFetch() } })
    const policy = publicationPolicy()
    await writePublicationPolicy(deniedPluginRoot, policy)
    assert.ok(indexedPaths(deskRoot).includes("references/personal-note.md"))

    for (const artifactType of ["vector-pack", "snapshot"]) {
      assert.deepEqual(
        evaluateArtifactPublication({
          policy,
          artifact_type: artifactType,
          operation: "publish",
        }),
        {
          allowed: false,
          reason: "approval_required",
          message: `${artifactType} publication requires explicit approval`,
        },
      )
    }

    await assert.rejects(
      () => buildVectorPackFromLocalDb({
        deskRoot,
        pluginRoot: deniedPluginRoot,
        mcpRoot,
        packId: "synthetic-denied-pack",
      }),
      (error) => (
        error.code === "artifact_publication_not_approved" &&
        error.reason === "approval_required" &&
        error.artifact_type === "vector-pack"
      ),
    )
    await assert.rejects(
      () => buildSnapshotFromLocalDb({
        deskRoot,
        pluginRoot: deniedPluginRoot,
        mcpRoot,
        snapshotId: "synthetic-denied-snapshot",
      }),
      (error) => (
        error.code === "artifact_publication_not_approved" &&
        error.reason === "approval_required" &&
        error.artifact_type === "snapshot"
      ),
    )
    await assert.rejects(
      () => readdir(path.join(deniedPluginRoot, "artifacts", "vector-packs")),
      (error) => error.code === "ENOENT",
    )
    await assert.rejects(
      () => readdir(path.join(deniedPluginRoot, "artifacts", "snapshots")),
      (error) => error.code === "ENOENT",
    )
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test("tombstones and deletions cannot reappear through packs, snapshots, restored caches, or regenerated manifests", async (t) => {
  const scratch = await scratchRoot("unit-6a-artifacts")
  const deskRoot = path.join(scratch, "desk")
  const restoredRoot = path.join(scratch, "restored-desk")
  const targetPluginRoot = path.join(scratch, "plugin")
  const embed = { fetch: embedFetch() }
  try {
    await copyCorpusFixture(deskRoot)
    await writePublicationPolicy(targetPluginRoot, publicationPolicy({ approved: true }))
    await rebuildIndex(deskRoot, {
      embed,
      tombstones: { pluginRoot: targetPluginRoot },
    })
    const initialDb = openDb(deskRoot)
    try {
      assert.equal(
        initialDb.pragma("secure_delete", { simple: true }),
        0,
        "privacy fixture must exercise SQLite secure_delete=0",
      )
    } finally {
      closeDb(initialDb)
    }
    const removedCaptures = captureRemovedDocuments(deskRoot)

    const historicalPackId = "synthetic-before-redaction"
    await buildVectorPackFromLocalDb({
      deskRoot,
      pluginRoot: targetPluginRoot,
      mcpRoot,
      packId: historicalPackId,
    })
    const historicalPack = artifactPaths(targetPluginRoot, "vector-pack", historicalPackId)
    const historicalPackRows = parseVectorPackRows(await readFile(historicalPack.primary))
    assertCapturedDocumentsPresent(
      historicalPackRows,
      removedCaptures,
      "pre-removal vector pack",
    )
    const redactedPath = "references/redacted.md"
    const redactedBody = await readFile(path.join(deskRoot, redactedPath), "utf8")
    await writeTombstone(targetPluginRoot, redactedPath, redactedBody)
    await assert.rejects(
      () => validateVectorPackFile({
        pluginRoot: targetPluginRoot,
        packPath: historicalPack.primary,
        manifestPath: historicalPack.manifest,
        checksumPath: historicalPack.checksum,
      }),
      (error) => (
        error.code === "artifact_represents_redacted_document" &&
        error.artifact_type === "vector-pack" &&
        error.redacted_count === 1
      ),
    )

    await unlink(path.join(deskRoot, "references", "deleted.md"))
    await ensureIndex(deskRoot, {
      embed,
      snapshots: false,
      vectorPacks: false,
      tombstones: { pluginRoot: targetPluginRoot },
    })
    assert.equal(indexedPaths(deskRoot).includes(redactedPath), false)
    assert.equal(indexedPaths(deskRoot).includes("references/deleted.md"), false)
    assertCapturedDocumentsAbsent(
      indexedChunks(deskRoot),
      removedCaptures.filter((capture) => capture.path !== "references/cache-only.md"),
      "post-tombstone live index",
    )

    const cacheSnapshotId = "synthetic-before-cache-delete"
    await buildSnapshotFromLocalDb({
      deskRoot,
      pluginRoot: targetPluginRoot,
      mcpRoot,
      snapshotId: cacheSnapshotId,
    })
    await unlink(path.join(deskRoot, "references", "cache-only.md"))
    await ensureIndex(deskRoot, {
      embed,
      snapshots: false,
      vectorPacks: false,
      tombstones: { pluginRoot: targetPluginRoot },
    })
    assertCapturedDocumentsAbsent(
      indexedChunks(deskRoot),
      removedCaptures,
      "post-deletion live index",
    )

    await copyDeskWithoutLocalState(deskRoot, restoredRoot)
    const restored = await ensureIndex(restoredRoot, {
      embed,
      snapshots: { pluginRoot: targetPluginRoot },
      vectorPacks: false,
      tombstones: { pluginRoot: targetPluginRoot },
    })
    assert.equal(restored.reason, "stale_snapshot_reconciled")
    assert.equal(restored.snapshot?.snapshot_id, cacheSnapshotId)
    await t.test("restored snapshot logical rows exclude every captured value", () => {
      assertCapturedDocumentsAbsent(
        indexedChunks(restoredRoot),
        removedCaptures,
        "reconciled restored index",
      )
    })

    const currentPackId = "synthetic-current-pack"
    const currentSnapshotId = "synthetic-current-snapshot"
    await buildVectorPackFromLocalDb({
      deskRoot,
      pluginRoot: targetPluginRoot,
      mcpRoot,
      packId: currentPackId,
    })
    await buildSnapshotFromLocalDb({
      deskRoot,
      pluginRoot: targetPluginRoot,
      mcpRoot,
      snapshotId: currentSnapshotId,
      includedPackIds: [currentPackId],
    })

    const expectedPaths = ALLOWED_PATHS.filter((docPath) => ![
      "references/cache-only.md",
      "references/deleted.md",
      redactedPath,
    ].includes(docPath))
    const currentPack = artifactPaths(targetPluginRoot, "vector-pack", currentPackId)
    const currentSnapshot = artifactPaths(targetPluginRoot, "snapshot", currentSnapshotId)
    const [packManifest, snapshotManifest, packBytes, snapshotBytes] = await Promise.all([
      readJson(currentPack.manifest),
      readJson(currentSnapshot.manifest),
      readFile(currentPack.primary),
      readFile(currentSnapshot.primary),
    ])
    await t.test("generated manifests structurally exclude every captured value", () => {
      assertManifestIsMetadataOnly(
        packManifest,
        "vector-pack",
        scratch,
        expectedPaths,
        removedCaptures,
      )
      assertManifestIsMetadataOnly(
        snapshotManifest,
        "snapshot",
        scratch,
        expectedPaths,
        removedCaptures,
      )
    })
    const packRows = parseVectorPackRows(packBytes)
    await t.test("generated vector-pack rows enforce the exact schema and exclude every captured value", () => {
      assertVectorPackRowsExcludeCaptured(packRows, removedCaptures, "current vector pack")
    })
    const snapshot = await inspectSnapshotPayload({
      snapshotBytes,
      scratch,
      name: currentSnapshotId,
    })
    await t.test("generated snapshot logical rows exclude every captured value", () => {
      assertCapturedDocumentsAbsent(
        snapshot.chunks,
        removedCaptures,
        "decoded current snapshot DB",
      )
      for (const marker of EXCLUDED_MARKERS) {
        assert.equal(
          snapshot.chunks.some((chunk) => chunk.text.includes(marker)),
          false,
          `decoded current snapshot DB leaked excluded marker ${marker}`,
        )
      }
    })
    await t.test("generated snapshot raw SQLite bytes exclude every captured value", () => {
      for (const marker of EXCLUDED_MARKERS) {
        assert.equal(
          snapshot.sqliteBytes.includes(Buffer.from(marker)),
          false,
          `raw current snapshot pages leaked excluded marker ${marker}`,
        )
      }
      assertSnapshotBytesExcludeCaptured(
        snapshot.sqliteBytes,
        removedCaptures,
        "raw current snapshot pages",
      )
    })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test("artifact source-scope hashing invalidates deterministically when restored-cache behavior changes", async () => {
  const scratch = await scratchRoot("unit-6a-source-scope")
  const scratchMcpRoot = path.join(scratch, "plugins", "desk", "mcp")
  const discoverPath = path.join(scratchMcpRoot, "src", "indexer", "discover.js")
  const helpersPath = path.join(scratchMcpRoot, "src", "server-helpers.js")
  try {
    await writeText(scratchMcpRoot, "src/indexer/discover.js", "discover-v1\n")
    await writeText(scratchMcpRoot, "src/server-helpers.js", "restore-v1\n")
    const baseline = generatedArtifacts.artifactSourceScopeHash(scratchMcpRoot)

    await writeFile(discoverPath, "discover-v2\n", "utf8")
    const discoveryChanged = generatedArtifacts.artifactSourceScopeHash(scratchMcpRoot)
    assert.notEqual(discoveryChanged, baseline)
    await writeFile(discoverPath, "discover-v1\n", "utf8")
    assert.equal(generatedArtifacts.artifactSourceScopeHash(scratchMcpRoot), baseline)

    await writeFile(helpersPath, "restore-v2\n", "utf8")
    const restoredCacheChanged = generatedArtifacts.artifactSourceScopeHash(scratchMcpRoot)
    assert.notEqual(
      restoredCacheChanged,
      baseline,
      "source scope must change when server-helpers.js restored-cache behavior changes",
    )
    await writeFile(helpersPath, "restore-v1\n", "utf8")
    assert.equal(generatedArtifacts.artifactSourceScopeHash(scratchMcpRoot), baseline)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test("new vector-pack and snapshot manifests carry the complete widened source scope", async () => {
  const scratch = await scratchRoot("unit-6a-built-source-scope")
  const deskRoot = path.join(scratch, "desk")
  const targetPluginRoot = path.join(scratch, "plugin")
  try {
    await copyCorpusFixture(deskRoot)
    await writePublicationPolicy(targetPluginRoot, publicationPolicy({ approved: true }))
    await rebuildIndex(deskRoot, { embed: { fetch: embedFetch() } })
    await buildVectorPackFromLocalDb({
      deskRoot,
      pluginRoot: targetPluginRoot,
      mcpRoot,
      packId: "synthetic-source-scope-pack",
    })
    await buildSnapshotFromLocalDb({
      deskRoot,
      pluginRoot: targetPluginRoot,
      mcpRoot,
      snapshotId: "synthetic-source-scope-snapshot",
    })

    const [packManifest, snapshotManifest] = await Promise.all([
      readJson(artifactPaths(
        targetPluginRoot,
        "vector-pack",
        "synthetic-source-scope-pack",
      ).manifest),
      readJson(artifactPaths(
        targetPluginRoot,
        "snapshot",
        "synthetic-source-scope-snapshot",
      ).manifest),
    ])
    for (const manifest of [packManifest, snapshotManifest]) {
      assertManifestSourceScope(manifest)
      assert.equal(
        manifest.artifact_source_scope_hash,
        generatedArtifacts.artifactSourceScopeHash(mcpRoot),
      )
    }
    const portableRuntimeScope = resolveEnsureIndexOptions(
      { vectorPacks: { pluginRoot: targetPluginRoot } },
      { deskRoot },
    ).vectorPacks.expectedArtifactSourceScopeHash
    assert.equal(portableRuntimeScope, packManifest.artifact_source_scope_hash)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

for (const relativeDocPath of PUBLICATION_GUIDANCE_DOCS) {
  test(`${relativeDocPath} discloses widened-corpus review and approval requirements`, async () => {
    const body = (await readFile(path.join(repoRoot, relativeDocPath), "utf8")).toLowerCase()
    assert.ok(
      /\ball allowed markdown\b/u.test(body),
      `${relativeDocPath} must disclose that local discovery covers all allowed Markdown`,
    )
    assert.ok(
      /\bnon-secret personal content\b/u.test(body),
      `${relativeDocPath} must disclose that allowed Markdown may contain non-secret personal content`,
    )
    assert.ok(
      /\blocal index(?:ing| eligibility)?\b[\s\S]{0,180}\b(?:does not|never|not)\b[\s\S]{0,100}\b(?:publish|share)/u.test(body),
      `${relativeDocPath} must separate local index eligibility from publishability`,
    )
    assert.ok(
      /\breview(?:ed)?\b[\s\S]{0,180}\bapprov(?:al|ed)\b[\s\S]{0,180}\b(?:share|publish|commit)/u.test(body),
      `${relativeDocPath} must require review and approval before sharing artifacts`,
    )
  })
}

test("committed public artifact manifests identify the widened production source scope", async () => {
  const manifests = await Promise.all(PUBLIC_MANIFEST_PATHS.map(readJson))
  const sourceScopeHash = generatedArtifacts.artifactSourceScopeHash(mcpRoot)
  for (const manifest of manifests) {
    assert.equal(manifest.artifact_source_scope_hash, sourceScopeHash)
    assert.equal(manifest.discovery_grammar_version, 2)
    assertManifestSourceScope(manifest)
  }
})

test("manifest privacy guards reject unknown fields, scalar drift, and every private value marker", async () => {
  const [vectorManifest, snapshotManifest] = await Promise.all(
    PUBLIC_MANIFEST_PATHS.map(readJson),
  )
  assertAllowedManifestSchema(vectorManifest, "vector-pack", "vector-pack manifest")
  assertAllowedManifestSchema(snapshotManifest, "snapshot", "snapshot manifest")

  const schemaProbes = [
    {
      label: "vector top-level unknown field",
      artifactType: "vector-pack",
      manifest: { ...vectorManifest, unexpected: "metadata" },
    },
    {
      label: "vector provenance unknown field",
      artifactType: "vector-pack",
      manifest: {
        ...vectorManifest,
        provenance: { ...vectorManifest.provenance, unexpected: "metadata" },
      },
    },
    {
      label: "vector represented-document unknown field",
      artifactType: "vector-pack",
      manifest: {
        ...vectorManifest,
        represented_documents: [{
          ...vectorManifest.represented_documents[0],
          unexpected: "metadata",
        }],
      },
    },
    {
      label: "snapshot DB schema unknown field",
      artifactType: "snapshot",
      manifest: {
        ...snapshotManifest,
        db_schema: { ...snapshotManifest.db_schema, unexpected: "metadata" },
      },
    },
    {
      label: "snapshot sqlite-vec unknown field",
      artifactType: "snapshot",
      manifest: {
        ...snapshotManifest,
        sqlite_vec: { ...snapshotManifest.sqlite_vec, unexpected: "metadata" },
      },
    },
    {
      label: "snapshot runtime unknown field",
      artifactType: "snapshot",
      manifest: {
        ...snapshotManifest,
        runtime: { ...snapshotManifest.runtime, unexpected: "metadata" },
      },
    },
    {
      label: "snapshot artifact unknown field",
      artifactType: "snapshot",
      manifest: {
        ...snapshotManifest,
        artifact: { ...snapshotManifest.artifact, unexpected: "metadata" },
      },
    },
    {
      label: "snapshot provenance unknown field",
      artifactType: "snapshot",
      manifest: {
        ...snapshotManifest,
        provenance: { ...snapshotManifest.provenance, unexpected: "metadata" },
      },
    },
    {
      label: "snapshot represented-document unknown field",
      artifactType: "snapshot",
      manifest: {
        ...snapshotManifest,
        represented_documents: [{
          ...snapshotManifest.represented_documents[0],
          unexpected: "metadata",
        }],
      },
    },
    {
      label: "vector row count scalar drift",
      artifactType: "vector-pack",
      manifest: { ...vectorManifest, row_count: String(vectorManifest.row_count) },
    },
    {
      label: "vector source paths array scalar drift",
      artifactType: "vector-pack",
      manifest: { ...vectorManifest, source_paths: [123] },
    },
    {
      label: "snapshot nested scalar drift",
      artifactType: "snapshot",
      manifest: {
        ...snapshotManifest,
        artifact: { ...snapshotManifest.artifact, compressed: "true" },
      },
    },
    {
      label: "snapshot included pack IDs array scalar drift",
      artifactType: "snapshot",
      manifest: { ...snapshotManifest, included_pack_ids: [123] },
    },
  ]
  for (const probe of schemaProbes) {
    assert.throws(
      () => assertAllowedManifestSchema(probe.manifest, probe.artifactType, probe.label),
      undefined,
      probe.label,
    )
  }

  for (const marker of [...SYNTHETIC_FIXTURE_BODY_MARKERS, ...MANIFEST_VALUE_LEAK_PROBES]) {
    const leakProbe = {
      ...vectorManifest,
      provenance: { ...vectorManifest.provenance, source: marker },
    }
    assert.throws(
      () => assertManifestStringValuesExcludeMarkers(leakProbe, [marker], "manifest probe"),
      /private content markers/u,
      marker,
    )
  }
})

test("structural publication guards reject root, nested, Windows, quoted, and serialized .state paths", () => {
  const statePathProbes = [
    ".state/benchmarks/other.json",
    "nested/.state/benchmarks/other.json",
    "nested\\.state\\benchmarks\\other.json",
    "\".state/benchmarks/other.json\"",
    JSON.stringify({ path: "nested/.state/benchmarks/other.json" }),
    `safe/path.json\n${JSON.stringify({ path: "nested\\.state\\benchmarks\\other.json" })}`,
  ]
  for (const probe of statePathProbes) {
    assert.throws(
      () => assertTreeExcludesStatePaths({ value: probe }, "manifest path probe"),
      /leaked \.state paths/u,
      probe,
    )
  }
  for (const probe of statePathProbes.slice(0, 3)) {
    assert.throws(
      () => assertTrackedPathsExcludeState(`${probe}\0`, "git path probe"),
      /tracked \.state paths/u,
      probe,
    )
  }

  const cleanValues = {
    prose: "The publication status.state marker is prose, not a path.",
    hash: "sha256:unrelated.state.digest",
    path: "artifacts/snapshots/public.manifest.json",
  }
  assert.doesNotThrow(() => assertTreeExcludesStatePaths(cleanValues, "clean manifest"))
  assert.doesNotThrow(() => assertTrackedPathsExcludeState(
    "artifacts/snapshots/public.manifest.json\0notes/about.state.json\0",
    "clean git paths",
  ))
})

test("committed public artifacts contain only approved public corpus data", async () => {
  const scratch = await scratchRoot("unit-6a-committed-artifact-privacy")
  try {
    const [vectorManifest, snapshotManifest] = await Promise.all([
      readJson(PUBLIC_VECTOR_MANIFEST_PATH),
      readJson(PUBLIC_SNAPSHOT_MANIFEST_PATH),
    ])
    assertManifestIsMetadataOnly(
      vectorManifest,
      "vector-pack",
      scratch,
      ["tasks/dependency-activation/task.md"],
    )
    assertManifestIsMetadataOnly(
      snapshotManifest,
      "snapshot",
      scratch,
      ["tasks/dependency-activation/task.md"],
    )
    for (const manifest of [vectorManifest, snapshotManifest]) {
      assertManifestStringValuesExcludeMarkers(
        manifest,
        PRIVATE_CORPUS_MARKERS,
        "committed public manifest",
      )
    }

    const vectorRows = parseVectorPackRows(
      await readFile(PUBLIC_VECTOR_MANIFEST_PATH.replace(/\.manifest\.json$/u, ".jsonl")),
    )
    vectorRows.forEach((row, index) => {
      assertVectorPackRowSchema(row, "committed vector pack", index)
    })
    const snapshot = await inspectSnapshotPayload({
      snapshotBytes: await readFile(path.join(
        path.dirname(PUBLIC_SNAPSHOT_MANIFEST_PATH),
        snapshotManifest.artifact.file,
      )),
      scratch,
      name: "committed-public-snapshot",
    })
    assert.deepEqual(
      snapshot.docs,
      ["tasks/dependency-activation/task.md"],
    )
    const snapshotText = snapshot.chunks.map((chunk) => chunk.text).join("\n")
    for (const marker of PRIVATE_CORPUS_MARKERS) {
      assert.equal(snapshotText.includes(marker), false)
      assert.equal(snapshot.sqliteBytes.includes(Buffer.from(marker)), false)
    }

    const notes = (await readFile(productionNotesPath, "utf8")).toLowerCase()
    assert.ok(
      /repo-local public desk documents only/u.test(notes),
      "production artifact notes must retain the approved public-document boundary",
    )
    assert.ok(
      /synthetic|de-identified/u.test(notes),
      "production artifact notes must identify committed public inputs as synthetic or de-identified",
    )
    assert.ok(
      /all allowed markdown/u.test(notes),
      "production artifact notes must disclose the wider local discovery corpus",
    )

    const tracked = spawnSync("git", ["ls-files", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
    assert.equal(tracked.status, 0, tracked.stderr)
    assertTrackedPathsExcludeState(tracked.stdout, "repository")
    const trackedPaths = parseGitTrackedPaths(tracked.stdout)
    for (const marker of PRIVATE_CORPUS_MARKERS.filter((marker) => marker !== ".state/benchmarks")) {
      assert.equal(
        trackedPaths.some((trackedPath) => trackedPath.includes(marker)),
        false,
        `repository tracked private marker ${marker}`,
      )
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
