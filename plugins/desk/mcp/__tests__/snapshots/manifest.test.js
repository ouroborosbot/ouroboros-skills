// Unit 15a: red contract for committed snapshot manifest validation.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"
import manifestContracts from "../../src/artifacts/manifest-contracts.cjs"

const { ARTIFACT_SOURCE_PATHS } = manifestContracts
const mcpRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))
const repoRoot = path.resolve(mcpRoot, "..", "..", "..")
const deskPluginRoot = path.join(repoRoot, "plugins", "desk")
const SNAPSHOT_ID = "desk-base-20260615T000000Z"
const SOURCE_SCOPE_HASH = `sha256:${"a".repeat(64)}`
const REPRESENTED_DOCUMENTS = Object.freeze([{
  path: "trackA/task-1/task.md",
  hash: `sha256:${"e".repeat(64)}`,
}])
const DOCUMENT_TREE_HASH = documentTreeHash(REPRESENTED_DOCUMENTS)
const DISCOVERY_GRAMMAR_VERSION = 2
const DB_SCHEMA = { id: "desk-index-sqlite-v1", version: 1 }
const SQLITE_VEC = { package: "sqlite-vec", version: "0.1.6", table: "vec0" }
const RUNTIME = { platform: "darwin", arch: "arm64", node_abi: "node-127" }

async function loadManifestModule() {
  return import(pathToFileURL(path.join(mcpRoot, "src", "snapshots", "manifest.js")))
}

async function tmpPluginRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desk-snapshot-manifest-"))
  return path.join(root, "plugins", "desk")
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function documentTreeHash(docs) {
  const hash = createHash("sha256")
  for (const doc of [...docs].sort((left, right) => left.path.localeCompare(right.path))) {
    const documentHash = doc.hash.startsWith("sha256:")
      ? doc.hash
      : `sha256:${doc.hash}`
    hash.update(`${doc.path.split(path.sep).join("/")}\0${documentHash}\0`)
  }
  return `sha256:${hash.digest("hex")}`
}

function validManifest({ artifactSha, snapshotId = SNAPSHOT_ID } = {}) {
  return {
    schema_version: 1,
    snapshot_id: snapshotId,
    embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id,
    dimension: ACTIVE_EMBEDDING_SPEC.dimension,
    chunker_id: ACTIVE_EMBEDDING_SPEC.chunker_id,
    normalization_id: ACTIVE_EMBEDDING_SPEC.normalization_id,
    db_schema: DB_SCHEMA,
    sqlite_vec: SQLITE_VEC,
    runtime: RUNTIME,
    artifact_source_scope_hash: SOURCE_SCOPE_HASH,
    document_tree_hash: DOCUMENT_TREE_HASH,
    discovery_grammar_version: DISCOVERY_GRAMMAR_VERSION,
    represented_documents: REPRESENTED_DOCUMENTS.map((doc) => ({ ...doc })),
    included_pack_ids: ["desk-base-pack"],
    created_at: "2026-06-15T00:00:00.000Z",
    artifact: {
      file: `${snapshotId}.sqlite.zst`,
      format: "sqlite-zstd",
      sha256: artifactSha ?? `sha256:${"c".repeat(64)}`,
      compressed: true,
    },
    provenance: {
      builder: "plugins/desk/mcp/scripts/build-snapshot.js",
      source: "local-db",
      commit: "0123456789abcdef0123456789abcdef01234567",
    },
    source_paths: ARTIFACT_SOURCE_PATHS,
  }
}

async function writeSnapshotArtifact({
  pluginRoot,
  snapshotId = SNAPSHOT_ID,
  artifactBytes = Buffer.from("fake zstd sqlite snapshot", "utf8"),
  manifest = {},
  checksum,
  embeddingSpecId = ACTIVE_EMBEDDING_SPEC.id,
} = {}) {
  const snapshotDir = path.join(
    pluginRoot,
    "artifacts",
    "snapshots",
    embeddingSpecId,
  )
  await fs.mkdir(snapshotDir, { recursive: true })
  const snapshotPath = path.join(snapshotDir, `${snapshotId}.sqlite.zst`)
  const manifestPath = path.join(snapshotDir, `${snapshotId}.manifest.json`)
  const checksumPath = path.join(snapshotDir, `${snapshotId}.sha256`)
  const artifactSha = `sha256:${sha256(artifactBytes)}`
  const snapshotManifest = {
    ...validManifest({ artifactSha, snapshotId }),
    ...manifest,
  }
  await fs.writeFile(snapshotPath, artifactBytes)
  await fs.writeFile(manifestPath, `${JSON.stringify(snapshotManifest, null, 2)}\n`, "utf8")
  await fs.writeFile(checksumPath, checksum ?? `${artifactSha}  ${snapshotId}.sqlite.zst\n`, "utf8")
  return { snapshotDir, snapshotPath, manifestPath, checksumPath, manifest: snapshotManifest }
}

test("snapshot paths are canonical, plugin-root relative, and spec-scoped", async () => {
  const { deriveSnapshotPaths } = await loadManifestModule()
  const paths = deriveSnapshotPaths({
    pluginRoot: deskPluginRoot,
    embeddingSpecId: ACTIVE_EMBEDDING_SPEC.id,
    snapshotId: SNAPSHOT_ID,
  })

  assert.equal(
    paths.snapshotDir,
    path.join(deskPluginRoot, "artifacts", "snapshots", ACTIVE_EMBEDDING_SPEC.id),
  )
  assert.equal(paths.snapshotPath, path.join(paths.snapshotDir, `${SNAPSHOT_ID}.sqlite.zst`))
  assert.equal(paths.manifestPath, path.join(paths.snapshotDir, `${SNAPSHOT_ID}.manifest.json`))
  assert.equal(paths.checksumPath, path.join(paths.snapshotDir, `${SNAPSHOT_ID}.sha256`))
  assert.equal(
    paths.relativeSnapshotPath,
    `plugins/desk/artifacts/snapshots/${ACTIVE_EMBEDDING_SPEC.id}/${SNAPSHOT_ID}.sqlite.zst`,
  )
  assert.throws(
    () => deriveSnapshotPaths({
      pluginRoot: deskPluginRoot,
      embeddingSpecId: ACTIVE_EMBEDDING_SPEC.id,
      snapshotId: "../escape",
    }),
    /invalid snapshot_id|path traversal/u,
  )
  assert.throws(
    () => deriveSnapshotPaths({
      pluginRoot: deskPluginRoot,
      embeddingSpecId: "/absolute/spec",
      snapshotId: SNAPSHOT_ID,
    }),
    /invalid embedding_spec_id|path traversal/u,
  )
})

test("valid snapshot artifacts require manifest fields and checksum sidecars", async () => {
  const { validateSnapshotArtifact } = await loadManifestModule()
  const pluginRoot = await tmpPluginRoot()
  const written = await writeSnapshotArtifact({ pluginRoot })

  const result = await validateSnapshotArtifact({
    snapshotPath: written.snapshotPath,
    manifestPath: written.manifestPath,
    checksumPath: written.checksumPath,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDbSchema: DB_SCHEMA,
    expectedSqliteVec: SQLITE_VEC,
    expectedRuntime: RUNTIME,
    expectedArtifactSourceScopeHash: SOURCE_SCOPE_HASH,
    expectedDocumentTreeHash: DOCUMENT_TREE_HASH,
  })

  assert.equal(result.compatible, true)
  assert.equal(result.snapshot_id, SNAPSHOT_ID)
  assert.equal(result.embedding_spec_id, ACTIVE_EMBEDDING_SPEC.id)
  assert.deepEqual(result.included_pack_ids, ["desk-base-pack"])
  assert.deepEqual(result.freshness, {
    artifact_source_scope: "fresh",
    document_tree: "fresh",
  })
})

test("snapshot artifacts reject unknown nested DB schema metadata", async () => {
  const { validateSnapshotArtifact } = await loadManifestModule()
  const pluginRoot = await tmpPluginRoot()
  const nestedSchema = {
    ...DB_SCHEMA,
    tables: [
      { name: "chunks", columns: ["doc_id", "chunk_index", "text_hash"] },
    ],
  }
  const written = await writeSnapshotArtifact({
    pluginRoot,
    manifest: { db_schema: nestedSchema },
  })

  await assert.rejects(
    () => validateSnapshotArtifact({
      snapshotPath: written.snapshotPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
      expectedDbSchema: nestedSchema,
      expectedSqliteVec: SQLITE_VEC,
      expectedRuntime: RUNTIME,
      expectedArtifactSourceScopeHash: SOURCE_SCOPE_HASH,
      expectedDocumentTreeHash: DOCUMENT_TREE_HASH,
    }),
    /db_schema unknown field tables/u,
  )
})

test("valid snapshot artifacts accept raw checksum sidecars", async () => {
  const { validateSnapshotArtifact } = await loadManifestModule()
  const pluginRoot = await tmpPluginRoot()
  const artifactBytes = Buffer.from("raw checksum snapshot", "utf8")
  const written = await writeSnapshotArtifact({
    pluginRoot,
    artifactBytes,
    checksum: `${sha256(artifactBytes)}  ${SNAPSHOT_ID}.sqlite.zst\n`,
  })

  const result = await validateSnapshotArtifact({
    snapshotPath: written.snapshotPath,
    manifestPath: written.manifestPath,
    checksumPath: written.checksumPath,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDbSchema: DB_SCHEMA,
    expectedSqliteVec: SQLITE_VEC,
    expectedRuntime: RUNTIME,
    expectedArtifactSourceScopeHash: SOURCE_SCOPE_HASH,
    expectedDocumentTreeHash: DOCUMENT_TREE_HASH,
  })

  assert.equal(result.compatible, true)
})

test("manifest source/document hash mismatch is freshness, not compatibility failure", async () => {
  const { validateSnapshotManifest } = await loadManifestModule()
  const artifactSha = `sha256:${"d".repeat(64)}`

  const result = validateSnapshotManifest({
    manifest: validManifest({ artifactSha }),
    artifactSha256: artifactSha,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDbSchema: DB_SCHEMA,
    expectedSqliteVec: SQLITE_VEC,
    expectedRuntime: RUNTIME,
    expectedArtifactSourceScopeHash: `sha256:${"e".repeat(64)}`,
    expectedDocumentTreeHash: `sha256:${"f".repeat(64)}`,
  })

  assert.equal(result.compatible, true)
  assert.deepEqual(result.freshness, {
    artifact_source_scope: "stale",
    document_tree: "stale",
  })
})

test("older snapshot grammar versions report stale freshness", async () => {
  const { validateSnapshotManifest } = await loadManifestModule()
  const artifactSha = `sha256:${"d".repeat(64)}`
  const manifest = {
    ...validManifest({ artifactSha }),
    discovery_grammar_version: 1,
  }

  const result = validateSnapshotManifest({
    manifest,
    artifactSha256: artifactSha,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDbSchema: DB_SCHEMA,
    expectedSqliteVec: SQLITE_VEC,
    expectedRuntime: RUNTIME,
    expectedArtifactSourceScopeHash: SOURCE_SCOPE_HASH,
    expectedDocumentTreeHash: DOCUMENT_TREE_HASH,
    expectedDiscoveryGrammarVersion: DISCOVERY_GRAMMAR_VERSION,
  })

  assert.equal(result.compatible, true)
  assert.deepEqual(result.freshness, {
    artifact_source_scope: "fresh",
    document_tree: "fresh",
    discovery_grammar: "stale",
  })
})

test("snapshot freshness rejects represented documents that do not match the claimed tree", async () => {
  const { validateSnapshotManifest } = await loadManifestModule()
  const artifactSha = `sha256:${"d".repeat(64)}`
  const manifest = {
    ...validManifest({ artifactSha }),
    represented_documents: [],
  }

  const result = validateSnapshotManifest({
    manifest,
    artifactSha256: artifactSha,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDbSchema: DB_SCHEMA,
    expectedSqliteVec: SQLITE_VEC,
    expectedRuntime: RUNTIME,
    expectedArtifactSourceScopeHash: SOURCE_SCOPE_HASH,
    expectedDocumentTreeHash: DOCUMENT_TREE_HASH,
  })

  assert.equal(result.freshness.document_tree, "stale")
})

test("snapshot freshness hashes sorted represented documents", async () => {
  const { validateSnapshotManifest } = await loadManifestModule()
  const artifactSha = `sha256:${"d".repeat(64)}`
  const representedDocuments = [
    { path: "z.md", hash: `sha256:${"a".repeat(64)}` },
    { path: "a.md", hash: `sha256:${"b".repeat(64)}` },
  ]
  const expectedDocumentTreeHash = documentTreeHash(representedDocuments)
  const manifest = {
    ...validManifest({ artifactSha }),
    document_tree_hash: expectedDocumentTreeHash,
    represented_documents: representedDocuments,
  }

  const result = validateSnapshotManifest({
    manifest,
    artifactSha256: artifactSha,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDbSchema: DB_SCHEMA,
    expectedSqliteVec: SQLITE_VEC,
    expectedRuntime: RUNTIME,
    expectedArtifactSourceScopeHash: SOURCE_SCOPE_HASH,
    expectedDocumentTreeHash,
  })

  assert.equal(result.freshness.document_tree, "fresh")
})

test("snapshot validation rejects malformed represented documents", async () => {
  const { validateSnapshotManifest } = await loadManifestModule()
  const artifactSha = `sha256:${"d".repeat(64)}`
  const malformedValues = [
    null,
    [null],
    ["invalid"],
    [[]],
    [{ path: 1, hash: "a".repeat(64) }],
    [{ path: "a.md", hash: 1 }],
  ]

  for (const represented_documents of malformedValues) {
    assert.throws(
      () => validateSnapshotManifest({
        manifest: {
          ...validManifest({ artifactSha }),
          represented_documents,
        },
        artifactSha256: artifactSha,
        expectedSpec: ACTIVE_EMBEDDING_SPEC,
        expectedDbSchema: DB_SCHEMA,
        expectedSqliteVec: SQLITE_VEC,
        expectedRuntime: RUNTIME,
        expectedArtifactSourceScopeHash: SOURCE_SCOPE_HASH,
        expectedDocumentTreeHash: DOCUMENT_TREE_HASH,
      }),
      /represented_documents/u,
    )
  }
})

test("snapshot manifest rejects compatibility and provenance drift", async () => {
  const { validateSnapshotManifest } = await loadManifestModule()
  const artifactSha = `sha256:${"d".repeat(64)}`
  const base = validManifest({ artifactSha })
  const validate = (manifest) => validateSnapshotManifest({
    manifest,
    artifactSha256: artifactSha,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDbSchema: DB_SCHEMA,
    expectedSqliteVec: SQLITE_VEC,
    expectedRuntime: RUNTIME,
    expectedArtifactSourceScopeHash: SOURCE_SCOPE_HASH,
    expectedDocumentTreeHash: DOCUMENT_TREE_HASH,
  })

  assert.throws(() => validate({ ...base, schema_version: 999 }), /schema_version/u)
  assert.throws(() => validate({ ...base, schema_version: undefined }), /schema_version/u)
  assert.throws(() => validate({ ...base, snapshot_id: "../escape" }), /snapshot_id/u)
  assert.throws(() => validate({ ...base, snapshot_id: "" }), /snapshot_id/u)
  assert.throws(() => validate({ ...base, embedding_spec_id: "other-spec" }), /embedding_spec_id/u)
  assert.throws(() => validate({ ...base, embedding_spec_id: undefined }), /embedding_spec_id/u)
  assert.throws(() => validate({ ...base, dimension: 42 }), /dimension/u)
  assert.throws(() => validate({ ...base, dimension: String(ACTIVE_EMBEDDING_SPEC.dimension) }), /dimension/u)
  assert.throws(() => validate({ ...base, chunker_id: "other-chunker" }), /chunker_id/u)
  assert.throws(() => validate({ ...base, normalization_id: "other-normalizer" }), /normalization_id/u)
  assert.throws(() => validate({ ...base, db_schema: { ...DB_SCHEMA, version: 999 } }), /DB schema/u)
  assert.throws(() => validate({ ...base, sqlite_vec: { ...SQLITE_VEC, version: "9.9.9" } }), /sqlite-vec/u)
  assert.throws(() => validate({ ...base, runtime: { ...RUNTIME, arch: "x64" } }), /runtime/u)
  assert.throws(() => validate({ ...base, included_pack_ids: ["../pack"] }), /included_pack_ids/u)
  assert.throws(() => validate({ ...base, created_at: 123 }), /created_at/u)
  assert.throws(() => validate({ ...base, created_at: "not-a-date" }), /created_at/u)
  assert.throws(() => validate({ ...base, created_at: "June 15, 2026" }), /created_at/u)
  assert.throws(() => validate({ ...base, provenance: {} }), /provenance/u)
  assert.throws(
    () => validate({ ...base, artifact_source_scope_hash: undefined }),
    /artifact_source_scope_hash/u,
  )
  assert.throws(
    () => validate({ ...base, document_tree_hash: undefined }),
    /document_tree_hash/u,
  )
  assert.throws(
    () => validate({ ...base, provenance: { ...base.provenance, builder: "" } }),
    /provenance/u,
  )
  assert.throws(
    () => validate({ ...base, provenance: { ...base.provenance, commit: "not-a-sha" } }),
    /provenance/u,
  )
  assert.throws(
    () => validate({
      ...base,
      artifact: { ...base.artifact, format: "raw-sqlite", compressed: false },
    }),
    /artifact (?:format|compressed)/u,
  )
  assert.throws(
    () => validate({
      ...base,
      artifact: { ...base.artifact, compressed: "true" },
    }),
    /artifact (?:format|compressed)/u,
  )
  assert.throws(
    () => validate({
      ...base,
      artifact: { ...base.artifact, sha256: `sha256:${"0".repeat(64)}` },
    }),
    /artifact sha256/u,
  )
  assert.throws(
    () => validate({
      ...base,
      artifact: { ...base.artifact, sha256: 123 },
    }),
    /artifact sha256/u,
  )
  assert.throws(
    () => validate({ ...base, unexpected: "metadata" }),
    /unknown|unsupported|allowed fields/u,
  )
  assert.throws(
    () => validate({
      ...base,
      artifact: { ...base.artifact, unexpected: "metadata" },
    }),
    /unknown|unsupported|allowed fields/u,
  )
  assert.throws(
    () => validate({
      ...base,
      provenance: { ...base.provenance, unexpected: "metadata" },
    }),
    /unknown|unsupported|allowed fields/u,
  )
  assert.throws(
    () => validate({
      ...base,
      represented_documents: [{
        ...base.represented_documents[0],
        unexpected: "metadata",
      }],
    }),
    /unknown|unsupported|allowed fields/u,
  )
  assert.throws(
    () => validate({
      ...base,
      represented_documents: [
        base.represented_documents[0],
        { ...base.represented_documents[0] },
      ],
    }),
    /duplicate represented document/u,
  )
  assert.throws(
    () => validate({
      ...base,
      source_paths: [...base.source_paths, base.source_paths[0]],
    }),
    /source_paths|source paths/u,
  )
  assert.throws(
    () => validate({
      ...base,
      source_paths: base.source_paths.slice(1),
    }),
    /source_paths|source paths/u,
  )
  assert.throws(
    () => validate({
      ...base,
      provenance: {
        ...base.provenance,
        source: "nested/.state/private.json",
      },
    }),
    /provenance|private|\.state/u,
  )
  assert.throws(
    () => validate({ ...base, body: "private body" }),
    /unknown|unsupported|allowed fields|body/u,
  )
})

test("snapshot manifests reject absolute, traversal, and unexpected source paths", async () => {
  const { validateSnapshotManifest } = await loadManifestModule()
  const artifactSha = `sha256:${"d".repeat(64)}`
  const validate = (sourcePaths) => validateSnapshotManifest({
    manifest: { ...validManifest({ artifactSha }), source_paths: sourcePaths },
    artifactSha256: artifactSha,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDbSchema: DB_SCHEMA,
    expectedSqliteVec: SQLITE_VEC,
    expectedRuntime: RUNTIME,
    expectedArtifactSourceScopeHash: SOURCE_SCOPE_HASH,
    expectedDocumentTreeHash: DOCUMENT_TREE_HASH,
  })

  assert.throws(() => validate(["/Users/ari/secret.md"]), /normalized relative path/u)
  assert.throws(() => validate(["plugins/desk/../secret.md"]), /normalized public relative path/u)
  assert.throws(
    () => validate(["plugins/desk/mcp/src/indexer/C:\\Users\\ari\\secret.md"]),
    /normalized relative path/u,
  )
  assert.throws(
    () => validate(["plugins/desk/mcp/src/indexer/C:/Users/ari/secret.md"]),
    /normalized public relative path/u,
  )
  assert.throws(
    () => validate(["private/customer-secrets.md"]),
    (error) => {
      assert.match(error.message, /canonical source list/u)
      assert.doesNotMatch(error.message, /private|customer-secrets/u)
      return true
    },
  )
})

test("snapshot artifact validation rejects checksum mismatch", async () => {
  const { validateSnapshotArtifact } = await loadManifestModule()
  const pluginRoot = await tmpPluginRoot()
  const written = await writeSnapshotArtifact({
    pluginRoot,
    checksum: `${"0".repeat(64)}  ${SNAPSHOT_ID}.sqlite.zst\n`,
  })

  await assert.rejects(
    () => validateSnapshotArtifact({
      snapshotPath: written.snapshotPath,
      manifestPath: written.manifestPath,
      checksumPath: written.checksumPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
      expectedDbSchema: DB_SCHEMA,
      expectedSqliteVec: SQLITE_VEC,
      expectedRuntime: RUNTIME,
      expectedArtifactSourceScopeHash: SOURCE_SCOPE_HASH,
      expectedDocumentTreeHash: DOCUMENT_TREE_HASH,
    }),
    /checksum mismatch/u,
  )
})

test("snapshot artifact validation rejects manifest and snapshot filename drift", async () => {
  const { validateSnapshotArtifact } = await loadManifestModule()
  const pluginRoot = await tmpPluginRoot()
  const written = await writeSnapshotArtifact({ pluginRoot })
  const renamedSnapshotPath = path.join(written.snapshotDir, "renamed.sqlite.zst")
  await fs.copyFile(written.snapshotPath, renamedSnapshotPath)

  await assert.rejects(
    () => validateSnapshotArtifact({
      snapshotPath: renamedSnapshotPath,
      manifestPath: written.manifestPath,
      checksumPath: written.checksumPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
      expectedDbSchema: DB_SCHEMA,
      expectedSqliteVec: SQLITE_VEC,
      expectedRuntime: RUNTIME,
      expectedArtifactSourceScopeHash: SOURCE_SCOPE_HASH,
      expectedDocumentTreeHash: DOCUMENT_TREE_HASH,
    }),
    /artifact file must match snapshot file/u,
  )
})

test("snapshot artifact validation preserves non-missing filesystem errors", async () => {
  const { validateSnapshotArtifact } = await loadManifestModule()
  const pluginRoot = await tmpPluginRoot()
  const written = await writeSnapshotArtifact({ pluginRoot })
  await fs.rm(written.snapshotPath)
  await fs.mkdir(written.snapshotPath)

  await assert.rejects(
    () => validateSnapshotArtifact({
      snapshotPath: written.snapshotPath,
      manifestPath: written.manifestPath,
      checksumPath: written.checksumPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
      expectedDbSchema: DB_SCHEMA,
      expectedSqliteVec: SQLITE_VEC,
      expectedRuntime: RUNTIME,
      expectedArtifactSourceScopeHash: SOURCE_SCOPE_HASH,
      expectedDocumentTreeHash: DOCUMENT_TREE_HASH,
    }),
    (error) => error?.code === "EISDIR",
  )
})

test("snapshot artifact validation rejects missing and malformed sidecars", async () => {
  const { validateSnapshotArtifact } = await loadManifestModule()
  const pluginRoot = await tmpPluginRoot()
  const written = await writeSnapshotArtifact({ pluginRoot })
  const validate = () => validateSnapshotArtifact({
    snapshotPath: written.snapshotPath,
    manifestPath: written.manifestPath,
    checksumPath: written.checksumPath,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDbSchema: DB_SCHEMA,
    expectedSqliteVec: SQLITE_VEC,
    expectedRuntime: RUNTIME,
    expectedArtifactSourceScopeHash: SOURCE_SCOPE_HASH,
    expectedDocumentTreeHash: DOCUMENT_TREE_HASH,
  })

  await fs.rm(written.snapshotPath)
  await assert.rejects(validate, /snapshot missing/u)

  await writeSnapshotArtifact({ pluginRoot })
  await fs.writeFile(written.manifestPath, "{not-json", "utf8")
  await assert.rejects(validate, /manifest must be valid JSON/u)

  await writeSnapshotArtifact({ pluginRoot })
  await fs.writeFile(written.checksumPath, "not-a-checksum\n", "utf8")
  await assert.rejects(validate, /checksum must start with a sha256 digest/u)
})

test("snapshot artifact validation rejects invalid paths and missing sidecars", async () => {
  const { validateSnapshotArtifact } = await loadManifestModule()
  const pluginRoot = await tmpPluginRoot()
  const written = await writeSnapshotArtifact({ pluginRoot })
  const validate = (overrides = {}) => validateSnapshotArtifact({
    snapshotPath: written.snapshotPath,
    manifestPath: written.manifestPath,
    checksumPath: written.checksumPath,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDbSchema: DB_SCHEMA,
    expectedSqliteVec: SQLITE_VEC,
    expectedRuntime: RUNTIME,
    expectedArtifactSourceScopeHash: SOURCE_SCOPE_HASH,
    expectedDocumentTreeHash: DOCUMENT_TREE_HASH,
    ...overrides,
  })
  const invalidSnapshotPath = path.join(written.snapshotDir, `${SNAPSHOT_ID}.sqlite`)

  await fs.writeFile(invalidSnapshotPath, "not a zstd sqlite artifact", "utf8")
  await assert.rejects(() => validate({ snapshotPath: 123 }), /snapshot path is required/u)
  await assert.rejects(
    () => validate({ snapshotPath: invalidSnapshotPath }),
    /snapshot path must end with \.sqlite\.zst/u,
  )

  await fs.rm(written.manifestPath)
  await assert.rejects(validate, /manifest missing/u)

  const rewritten = await writeSnapshotArtifact({ pluginRoot })
  await fs.rm(rewritten.checksumPath)
  await assert.rejects(
    () => validate({
      snapshotPath: rewritten.snapshotPath,
      manifestPath: rewritten.manifestPath,
      checksumPath: rewritten.checksumPath,
    }),
    /checksum missing/u,
  )
})

test("snapshot manifest rejects missing expected compatibility context and defensive shapes", async () => {
  const { validateSnapshotArtifact, validateSnapshotManifest } = await loadManifestModule()
  const artifactSha = `sha256:${"d".repeat(64)}`
  const base = validManifest({ artifactSha })
  const validate = (manifest, overrides = {}) => validateSnapshotManifest({
    manifest,
    artifactSha256: artifactSha,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDbSchema: DB_SCHEMA,
    expectedSqliteVec: SQLITE_VEC,
    expectedRuntime: RUNTIME,
    expectedArtifactSourceScopeHash: SOURCE_SCOPE_HASH,
    expectedDocumentTreeHash: DOCUMENT_TREE_HASH,
    ...overrides,
  })

  assert.throws(() => validate(null), /manifest must be an object/u)
  assert.throws(() => validate([]), /manifest must be an object/u)
  assert.throws(() => validate(base, { expectedDbSchema: undefined }), /expected DB schema/u)
  assert.throws(() => validate(base, { expectedSqliteVec: undefined }), /expected sqlite-vec/u)
  assert.throws(() => validate(base, { expectedRuntime: undefined }), /expected runtime/u)
  assert.throws(() => validate({ ...base, artifact: null }), /artifact must be an object/u)
  assert.throws(() => validate({ ...base, artifact: [] }), /artifact must be an object/u)
  assert.throws(
    () => validate({
      ...base,
      artifact: { ...base.artifact, file: "other.sqlite.zst" },
    }),
    /artifact file/u,
  )
  assert.throws(() => validate({ ...base, source_paths: [] }), /source_paths/u)
  assert.throws(() => validate({ ...base, source_paths: [123] }), /source_paths/u)
  assert.throws(() => validate({ ...base, included_pack_ids: "pack" }), /included_pack_ids/u)
  assert.throws(() => validate({ ...base, provenance: null }), /provenance/u)
  assert.throws(
    () => validate({ ...base, provenance: { ...base.provenance, source: "" } }),
    /provenance/u,
  )
  await assert.rejects(() => validateSnapshotArtifact(), /snapshot path is required/u)
})
