// Unit 12a: red contract for shared vector-pack validation and import.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { closeDb, openDb } from "../../src/db/init.js"
import {
  ACTIVE_EMBEDDING_SPEC,
  chunkIdentity,
} from "../../src/indexer/spec.js"

const mcpRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))
const repoRoot = path.resolve(mcpRoot, "..", "..", "..")
const deskPluginRoot = path.join(repoRoot, "plugins", "desk")
const SOURCE_SCOPE_HASH = `sha256:${"a".repeat(64)}`
const DISCOVERY_GRAMMAR_VERSION = 2

async function loadVectorPackModule() {
  return import(pathToFileURL(path.join(mcpRoot, "src", "indexer", "vector-packs.js")))
}

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "desk-vector-pack-"))
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function representedDocumentsHash(docs) {
  const hash = createHash("sha256")
  for (const doc of [...docs].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    const documentHash = doc.hash.startsWith("sha256:")
      ? doc.hash
      : `sha256:${doc.hash}`
    hash.update(`${doc.path.split(path.sep).join("/")}\0${documentHash}\0`)
  }
  return `sha256:${hash.digest("hex")}`
}

function vector(seed, dimension = ACTIVE_EMBEDDING_SPEC.dimension) {
  return Array.from({ length: dimension }, (_, index) => ((index + seed) % 17) / 17)
}

function rowFor(identity, seed = 1, overrides = {}) {
  return {
    chunk_key: identity.chunk_key,
    text_hash: identity.text_hash,
    embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id,
    dimension: ACTIVE_EMBEDDING_SPEC.dimension,
    encoding: "float32-json",
    vector: vector(seed),
    ...overrides,
  }
}

function storedVector(db, chunkId) {
  const row = db.prepare("SELECT embedding FROM chunk_vecs WHERE chunk_id = ?").get(chunkId)
  assert.ok(row, `missing vector row for chunk_id ${chunkId}`)
  const buffer = Buffer.from(row.embedding)
  const values = []
  for (let offset = 0; offset < buffer.length; offset += 4) {
    values.push(buffer.readFloatLE(offset))
  }
  return values
}

function assertStoredVector(db, chunkId, expected) {
  const actual = storedVector(db, chunkId)
  assert.equal(actual.length, expected.length)
  for (let index = 0; index < expected.length; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) < 0.000001,
      `chunk_id ${chunkId} vector[${index}] expected ${expected[index]}, got ${actual[index]}`,
    )
  }
}

async function writePack({
  pluginRoot,
  packId,
  rows,
  manifest = {},
  checksum,
  embeddingSpecId = ACTIVE_EMBEDDING_SPEC.id,
}) {
  const packDir = path.join(
    pluginRoot,
    "artifacts",
    "vector-packs",
    embeddingSpecId,
  )
  await fs.mkdir(packDir, { recursive: true })
  const packPath = path.join(packDir, `${packId}.jsonl`)
  const manifestPath = path.join(packDir, `${packId}.manifest.json`)
  const checksumPath = path.join(packDir, `${packId}.sha256`)
  const jsonl = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
  const packSha = sha256(jsonl)
  const packManifest = {
    schema_version: 1,
    pack_id: packId,
    embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id,
    dimension: ACTIVE_EMBEDDING_SPEC.dimension,
    encoding: "float32-json",
    row_count: rows.length,
    rows_sha256: packSha,
    created_at: "2026-06-15T00:00:00.000Z",
    provenance: {
      builder: "artifact:vector-pack:build",
      source: "unit-test",
    },
    ...manifest,
  }
  await fs.writeFile(packPath, jsonl, "utf8")
  await fs.writeFile(manifestPath, `${JSON.stringify(packManifest, null, 2)}\n`, "utf8")
  await fs.writeFile(checksumPath, checksum ?? `${packSha}  ${packId}.jsonl\n`, "utf8")
  return { packDir, packPath, manifestPath, checksumPath, manifest: packManifest }
}

async function rewritePackText(paths, text, manifest = {}) {
  const packSha = sha256(text)
  const nextManifest = {
    ...paths.manifest,
    row_count: text.split(/\n/u).filter((line) => line.trim() !== "").length,
    rows_sha256: packSha,
    ...manifest,
  }
  await fs.writeFile(paths.packPath, text, "utf8")
  await fs.writeFile(paths.manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8")
  await fs.writeFile(
    paths.checksumPath,
    `${packSha}  ${path.basename(paths.packPath)}\n`,
    "utf8",
  )
}

function insertChunk(db, { docPath, text, chunkIndex = 0 }) {
  const docId = db
    .prepare(
      `INSERT INTO docs (path, kind, hash, mtime, frontmatter)
       VALUES (?, 'task', ?, 0, '{}')
       RETURNING id`,
    )
    .get(docPath, sha256(text)).id
  const chunk = {
    index: chunkIndex,
    text,
    heading: null,
    start_offset: 0,
    end_offset: text.length,
  }
  const identity = chunkIdentity({ docPath, chunk })
  const chunkId = db
    .prepare(
      `INSERT INTO chunks (
         doc_id,
         chunk_index,
         chunk_key,
         text_hash,
         embedding_spec_id,
         chunker_id,
         normalization_id,
         text,
         heading,
         start_offset,
         end_offset
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      docId,
      chunk.index,
      identity.chunk_key,
      identity.text_hash,
      identity.embedding_spec_id,
      identity.chunker_id,
      identity.normalization_id,
      chunk.text,
      chunk.heading,
      chunk.start_offset,
      chunk.end_offset,
    ).id
  return { docId, chunkId, identity, chunk }
}

function insertChunkForDoc(db, { docId, docPath, text, chunkIndex = 0 }) {
  const chunk = {
    index: chunkIndex,
    text,
    heading: null,
    start_offset: 0,
    end_offset: text.length,
  }
  const identity = chunkIdentity({ docPath, chunk })
  const chunkId = db
    .prepare(
      `INSERT INTO chunks (
         doc_id,
         chunk_index,
         chunk_key,
         text_hash,
         embedding_spec_id,
         chunker_id,
         normalization_id,
         text,
         heading,
         start_offset,
         end_offset
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      docId,
      chunk.index,
      identity.chunk_key,
      identity.text_hash,
      identity.embedding_spec_id,
      identity.chunker_id,
      identity.normalization_id,
      chunk.text,
      chunk.heading,
      chunk.start_offset,
      chunk.end_offset,
    ).id
  return { docId, chunkId, identity, chunk }
}

test("vector pack paths are canonical, plugin-root relative, and spec-scoped", async () => {
  const { deriveVectorPackPaths } = await loadVectorPackModule()
  const paths = deriveVectorPackPaths({
    pluginRoot: deskPluginRoot,
    embeddingSpecId: ACTIVE_EMBEDDING_SPEC.id,
    packId: "desk-base",
  })

  assert.equal(
    paths.packDir,
    path.join(deskPluginRoot, "artifacts", "vector-packs", ACTIVE_EMBEDDING_SPEC.id),
  )
  assert.equal(paths.packPath, path.join(paths.packDir, "desk-base.jsonl"))
  assert.equal(paths.manifestPath, path.join(paths.packDir, "desk-base.manifest.json"))
  assert.equal(paths.checksumPath, path.join(paths.packDir, "desk-base.sha256"))
  assert.equal(
    paths.relativePackPath,
    `plugins/desk/artifacts/vector-packs/${ACTIVE_EMBEDDING_SPEC.id}/desk-base.jsonl`,
  )
  assert.throws(
    () => deriveVectorPackPaths({
      pluginRoot: deskPluginRoot,
      embeddingSpecId: ACTIVE_EMBEDDING_SPEC.id,
      packId: "../escape",
    }),
    /invalid pack_id|path traversal/u,
  )
  assert.throws(
    () => deriveVectorPackPaths({
      pluginRoot: deskPluginRoot,
      embeddingSpecId: "bad/spec",
      packId: "desk-base",
    }),
    /invalid embedding_spec_id|path traversal/u,
  )
})

test("valid vector packs require adjacent manifest and checksum sidecars", async () => {
  const { validateVectorPackFile } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const identity = chunkIdentity({
    docPath: "trackA/task-1/task.md",
    chunk: { text: "shareable semantic chunk" },
  })
  const paths = await writePack({
    pluginRoot,
    packId: "valid-pack",
    rows: [rowFor(identity)],
  })

  const result = await validateVectorPackFile({
    packPath: paths.packPath,
    manifestPath: paths.manifestPath,
    checksumPath: paths.checksumPath,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
  })

  assert.equal(result.pack_id, "valid-pack")
  assert.equal(result.embedding_spec_id, ACTIVE_EMBEDDING_SPEC.id)
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].chunk_key, identity.chunk_key)
  assert.equal(result.rows[0].vector.length, ACTIVE_EMBEDDING_SPEC.dimension)

  const defaultSidecars = await validateVectorPackFile({
    packPath: paths.packPath,
  })
  assert.equal(defaultSidecars.pack_id, "valid-pack")

  const missingManifest = await writePack({
    pluginRoot,
    packId: "missing-manifest",
    rows: [rowFor(identity)],
  })
  await fs.rm(missingManifest.manifestPath)
  await assert.rejects(
    () => validateVectorPackFile({
      packPath: missingManifest.packPath,
      manifestPath: missingManifest.manifestPath,
      checksumPath: missingManifest.checksumPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    }),
    /manifest.*missing/u,
  )

  const missingChecksum = await writePack({
    pluginRoot,
    packId: "missing-checksum",
    rows: [rowFor(identity)],
  })
  await fs.rm(missingChecksum.checksumPath)
  await assert.rejects(
    () => validateVectorPackFile({
      packPath: missingChecksum.packPath,
      manifestPath: missingChecksum.manifestPath,
      checksumPath: missingChecksum.checksumPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    }),
    /checksum.*missing|sha256.*missing/u,
  )

  const badChecksum = await writePack({
    pluginRoot,
    packId: "bad-checksum",
    rows: [rowFor(identity)],
    checksum: `${"0".repeat(64)}  bad-checksum.jsonl\n`,
  })
  await assert.rejects(
    () => validateVectorPackFile({
      packPath: badChecksum.packPath,
      manifestPath: badChecksum.manifestPath,
      checksumPath: badChecksum.checksumPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    }),
    /checksum.*mismatch|sha256.*mismatch/u,
  )

  const badChecksumFormat = await writePack({
    pluginRoot,
    packId: "bad-checksum-format",
    rows: [rowFor(identity)],
    checksum: "not-a-sha\n",
  })
  await assert.rejects(
    () => validateVectorPackFile({
      packPath: badChecksumFormat.packPath,
      manifestPath: badChecksumFormat.manifestPath,
      checksumPath: badChecksumFormat.checksumPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    }),
    /checksum.*sha256 digest/u,
  )

  const badManifestJson = await writePack({
    pluginRoot,
    packId: "bad-manifest-json",
    rows: [rowFor(identity)],
  })
  await fs.writeFile(badManifestJson.manifestPath, "{not json", "utf8")
  await assert.rejects(
    () => validateVectorPackFile({
      packPath: badManifestJson.packPath,
      manifestPath: badManifestJson.manifestPath,
      checksumPath: badManifestJson.checksumPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    }),
    /manifest.*valid JSON/u,
  )

  const directoryPack = path.join(root, "directory-pack")
  await fs.mkdir(directoryPack, { recursive: true })
  await assert.rejects(
    () => validateVectorPackFile({
      packPath: directoryPack,
      manifestPath: paths.manifestPath,
      checksumPath: paths.checksumPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    }),
    (error) => error.code === "EISDIR",
  )

  await assert.rejects(
    () => validateVectorPackFile({
      manifestPath: paths.manifestPath,
      checksumPath: paths.checksumPath,
    }),
    /vector-pack pack path is required/u,
  )
  await assert.rejects(
    () => validateVectorPackFile({
      packPath: " ",
      manifestPath: paths.manifestPath,
      checksumPath: paths.checksumPath,
    }),
    /pack path is required/u,
  )
})

test("older vector-pack grammar versions report stale freshness", async () => {
  const { validateVectorPackFile } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const identity = chunkIdentity({
    docPath: "trackA/task-1/task.md",
    chunk: { text: "stale grammar vector chunk" },
  })
  const paths = await writePack({
    pluginRoot,
    packId: "stale-grammar-pack",
    rows: [rowFor(identity)],
    manifest: {
      artifact_source_scope_hash: SOURCE_SCOPE_HASH,
      discovery_grammar_version: 1,
    },
  })

  const result = await validateVectorPackFile({
    pluginRoot,
    packPath: paths.packPath,
    manifestPath: paths.manifestPath,
    checksumPath: paths.checksumPath,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedArtifactSourceScopeHash: SOURCE_SCOPE_HASH,
    expectedDiscoveryGrammarVersion: DISCOVERY_GRAMMAR_VERSION,
  })

  assert.deepEqual(result.freshness, {
    artifact_source_scope: "fresh",
    discovery_grammar: "stale",
  })
})

test("vector-pack document-tree drift reports stale freshness", async () => {
  const { validateVectorPackFile } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const identity = chunkIdentity({
    docPath: "trackA/task-1/task.md",
    chunk: { text: "stale document tree vector chunk" },
  })
  const paths = await writePack({
    pluginRoot,
    packId: "stale-document-tree-pack",
    rows: [rowFor(identity)],
    manifest: {
      document_tree_hash: `sha256:${"b".repeat(64)}`,
    },
  })

  const result = await validateVectorPackFile({
    pluginRoot,
    packPath: paths.packPath,
    manifestPath: paths.manifestPath,
    checksumPath: paths.checksumPath,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDocumentTreeHash: `sha256:${"c".repeat(64)}`,
  })

  assert.deepEqual(result.freshness, {
    document_tree: "stale",
  })
})

test("vector-pack freshness rejects represented documents that do not match the claimed tree", async () => {
  const { validateVectorPackFile } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const identity = chunkIdentity({
    docPath: "trackA/task-1/task.md",
    chunk: { text: "forged represented document tree chunk" },
  })
  const documentTreeHash = `sha256:${"b".repeat(64)}`
  const paths = await writePack({
    pluginRoot,
    packId: "forged-document-tree-pack",
    rows: [rowFor(identity)],
    manifest: {
      document_tree_hash: documentTreeHash,
      represented_documents: [],
    },
  })

  const result = await validateVectorPackFile({
    pluginRoot,
    packPath: paths.packPath,
    manifestPath: paths.manifestPath,
    checksumPath: paths.checksumPath,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDocumentTreeHash: documentTreeHash,
  })

  assert.deepEqual(result.freshness, {
    document_tree: "stale",
  })
})

test("vector-pack freshness hashes sorted represented documents", async () => {
  const { validateVectorPackFile } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const identity = chunkIdentity({
    docPath: "trackA/task-1/task.md",
    chunk: { text: "sorted represented document tree chunk" },
  })
  const representedDocuments = [
    { path: "z.md", hash: "a".repeat(64) },
    { path: "a.md", hash: `sha256:${"b".repeat(64)}` },
  ]
  const documentTreeHash = representedDocumentsHash(representedDocuments)
  const paths = await writePack({
    pluginRoot,
    packId: "sorted-document-tree-pack",
    rows: [rowFor(identity)],
    manifest: {
      document_tree_hash: documentTreeHash,
      represented_documents: representedDocuments,
    },
  })

  const result = await validateVectorPackFile({
    pluginRoot,
    packPath: paths.packPath,
    manifestPath: paths.manifestPath,
    checksumPath: paths.checksumPath,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDocumentTreeHash: documentTreeHash,
  })

  assert.deepEqual(result.freshness, {
    document_tree: "fresh",
  })
})

test("vector-pack freshness treats malformed represented documents as stale", async () => {
  const { validateVectorPackFile } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const identity = chunkIdentity({
    docPath: "trackA/task-1/task.md",
    chunk: { text: "malformed represented document tree chunk" },
  })
  const malformedValues = [
    null,
    [null],
    ["invalid"],
    [[]],
    [{ path: 1, hash: "a".repeat(64) }],
    [{ path: "a.md", hash: 1 }],
  ]

  for (const [index, represented_documents] of malformedValues.entries()) {
    const paths = await writePack({
      pluginRoot,
      packId: `malformed-document-tree-pack-${index}`,
      rows: [rowFor(identity)],
      manifest: {
        document_tree_hash: `sha256:${"c".repeat(64)}`,
        represented_documents,
      },
    })

    const result = await validateVectorPackFile({
      pluginRoot,
      packPath: paths.packPath,
      manifestPath: paths.manifestPath,
      checksumPath: paths.checksumPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
      expectedDocumentTreeHash: `sha256:${"c".repeat(64)}`,
    })

    assert.equal(result.freshness.document_tree, "stale")
  }
})

test("vector pack validation rejects wrong specs, dimensions, hashes, and malformed vectors", async () => {
  const { validateVectorPackFile } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const identity = chunkIdentity({
    docPath: "trackA/task-1/task.md",
    chunk: { text: "sensitive text must not leak" },
  })
  const cases = [
    {
      name: "wrong-spec",
      row: rowFor(identity, 1, { embedding_spec_id: "inactive-spec" }),
      pattern: /row 1.*embedding_spec_id/u,
    },
    {
      name: "wrong-dimension",
      row: rowFor(identity, 1, { dimension: 3, vector: vector(1, 3) }),
      pattern: /row 1.*dimension/u,
    },
    {
      name: "bad-hash",
      row: rowFor(identity, 1, { text_hash: "sha256:not-a-real-digest" }),
      pattern: /row 1.*text_hash/u,
    },
    {
      name: "bad-encoding",
      row: rowFor(identity, 1, { encoding: "base64-float32le" }),
      pattern: /row 1.*encoding/u,
    },
    {
      name: "bad-chunk-key",
      row: rowFor(identity, 1, { chunk_key: "not-a-chunk-key" }),
      pattern: /row 1.*chunk_key/u,
    },
    {
      name: "malformed-vector",
      row: rowFor(identity, 1, { vector: "not-an-array" }),
      pattern: /row 1.*vector/u,
    },
    {
      name: "wrong-vector-length",
      row: rowFor(identity, 1, { vector: vector(1, 3) }),
      pattern: /row 1.*vector length/u,
    },
    {
      name: "non-finite-vector",
      row: rowFor(identity, 1, { vector: [Infinity, ...vector(1).slice(1)] }),
      pattern: /row 1.*finite numbers/u,
    },
    {
      name: "row-not-object",
      row: null,
      pattern: /row 1.*object/u,
    },
    {
      name: "row-string",
      row: "not-an-object",
      pattern: /row 1.*object/u,
    },
    {
      name: "row-array",
      row: [],
      pattern: /row 1.*object/u,
    },
  ]

  for (const entry of cases) {
    const paths = await writePack({
      pluginRoot,
      packId: entry.name,
      rows: [entry.row],
    })
    await assert.rejects(
      () => validateVectorPackFile({
        packPath: paths.packPath,
        manifestPath: paths.manifestPath,
        checksumPath: paths.checksumPath,
        expectedSpec: ACTIVE_EMBEDDING_SPEC,
      }),
      (error) => {
        assert.match(error.message, entry.pattern)
        assert.doesNotMatch(error.message, /sensitive text/u)
        return true
      },
    )
  }

  const malformedJson = await writePack({
    pluginRoot,
    packId: "malformed-jsonl",
    rows: [rowFor(identity)],
  })
  await rewritePackText(malformedJson, "{\"chunk_key\":\n")
  await assert.rejects(
    () => validateVectorPackFile({
      packPath: malformedJson.packPath,
      manifestPath: malformedJson.manifestPath,
      checksumPath: malformedJson.checksumPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    }),
    /row 1.*malformed JSON/u,
  )
})

test("vector pack validation rejects unknown row fields before sensitive text can enter packs", async () => {
  const { validateVectorPackFile } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const identity = chunkIdentity({
    docPath: "trackA/task-1/task.md",
    chunk: { text: "sensitive row schema text" },
  })
  const paths = await writePack({
    pluginRoot,
    packId: "unknown-row-field",
    rows: [
      rowFor(identity, 1, {
        text: "sensitive row schema text",
      }),
    ],
  })

  await assert.rejects(
    () => validateVectorPackFile({
      packPath: paths.packPath,
      manifestPath: paths.manifestPath,
      checksumPath: paths.checksumPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    }),
    (error) => {
      assert.match(error.message, /row 1.*unknown field/u)
      assert.doesNotMatch(error.message, /sensitive row schema text/u)
      return true
    },
  )
})

test("vector pack validation rejects malformed manifests before import", async () => {
  const { validateVectorPackFile } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const identity = chunkIdentity({
    docPath: "trackA/task-1/task.md",
    chunk: { text: "manifest validation chunk" },
  })
  const manifestCases = [
    {
      name: "bad-schema-version",
      manifest: { schema_version: 2 },
      pattern: /schema_version must be 1/u,
    },
    {
      name: "bad-pack-id",
      manifest: { pack_id: "../escape" },
      pattern: /invalid pack_id/u,
    },
    {
      name: "bad-manifest-spec",
      manifest: { embedding_spec_id: "inactive-spec" },
      pattern: /manifest embedding_spec_id/u,
    },
    {
      name: "bad-manifest-dimension",
      manifest: { dimension: 3 },
      pattern: /manifest dimension/u,
    },
    {
      name: "bad-manifest-encoding",
      manifest: { encoding: "base64-float32le" },
      pattern: /manifest encoding/u,
    },
    {
      name: "bad-row-count",
      manifest: { row_count: -1 },
      pattern: /row_count.*non-negative integer/u,
    },
    {
      name: "bad-rows-sha",
      manifest: { rows_sha256: "0".repeat(64) },
      pattern: /rows_sha256.*match/u,
    },
    {
      name: "row-count-mismatch",
      manifest: { row_count: 2 },
      pattern: /row_count.*match vector pack rows/u,
    },
  ]

  for (const entry of manifestCases) {
    const paths = await writePack({
      pluginRoot,
      packId: entry.name,
      rows: [rowFor(identity)],
      manifest: entry.manifest,
    })
    await assert.rejects(
      () => validateVectorPackFile({
        packPath: paths.packPath,
        manifestPath: paths.manifestPath,
        checksumPath: paths.checksumPath,
        expectedSpec: ACTIVE_EMBEDDING_SPEC,
      }),
      entry.pattern,
    )
  }
})

test("vector pack import is idempotent and deduplicates repeated chunk keys across append-only packs", async () => {
  const { importVectorPacks } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const deskRoot = path.join(root, "desk")
  const db = openDb(deskRoot)
  try {
    const first = insertChunk(db, {
      docPath: "trackA/task-1/task.md",
      text: "first semantic chunk",
      chunkIndex: 0,
    })
    const second = insertChunk(db, {
      docPath: "trackA/task-2/task.md",
      text: "second semantic chunk",
      chunkIndex: 0,
    })
    const third = insertChunk(db, {
      docPath: "trackA/task-3/task.md",
      text: "third semantic chunk",
      chunkIndex: 0,
    })
    await writePack({
      pluginRoot,
      packId: "pack-a",
      rows: [
        rowFor(first.identity, 1),
        rowFor(second.identity, 2),
        rowFor(second.identity, 2),
      ],
    })
    await writePack({
      pluginRoot,
      packId: "pack-b",
      rows: [rowFor(third.identity, 3)],
    })

    const imported = await importVectorPacks({
      db,
      pluginRoot,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    })
    assert.equal(imported.packs_considered, 2)
    assert.equal(imported.packs_imported, 2)
    assert.equal(imported.rows_imported, 3)
    assert.equal(imported.rows_skipped_duplicate, 1)
    assert.equal(db.prepare("SELECT count(*) AS count FROM chunk_vecs").get().count, 3)
    assertStoredVector(db, first.chunkId, vector(1))
    assertStoredVector(db, second.chunkId, vector(2))
    assertStoredVector(db, third.chunkId, vector(3))

    const secondImport = await importVectorPacks({
      db,
      pluginRoot,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    })
    assert.equal(secondImport.rows_imported, 0)
    assert.equal(secondImport.rows_skipped_duplicate, 4)
    assert.equal(db.prepare("SELECT count(*) AS count FROM chunk_vecs").get().count, 3)
  } finally {
    closeDb(db)
  }
})

test("vector pack import skips stale source, document tree, and grammar artifacts", async () => {
  const { importVectorPacks } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const deskRoot = path.join(root, "desk")
  const db = openDb(deskRoot)
  try {
    const current = insertChunk(db, {
      docPath: "trackA/task-1/task.md",
      text: "current semantic chunk",
      chunkIndex: 0,
    })
    const representedDocuments = [{
      path: "trackA/task-1/task.md",
      hash: `sha256:${"1".repeat(64)}`,
    }]
    const currentTreeHash = representedDocumentsHash(representedDocuments)
    const staleDocuments = [{
      path: "trackA/task-old/task.md",
      hash: `sha256:${"2".repeat(64)}`,
    }]

    await writePack({
      pluginRoot,
      packId: "stale-source",
      rows: [rowFor(current.identity, 1)],
      manifest: {
        artifact_source_scope_hash: `sha256:${"f".repeat(64)}`,
        document_tree_hash: currentTreeHash,
        discovery_grammar_version: DISCOVERY_GRAMMAR_VERSION,
        represented_documents: representedDocuments,
      },
    })
    await writePack({
      pluginRoot,
      packId: "stale-tree",
      rows: [rowFor(current.identity, 2)],
      manifest: {
        artifact_source_scope_hash: SOURCE_SCOPE_HASH,
        document_tree_hash: representedDocumentsHash(staleDocuments),
        discovery_grammar_version: DISCOVERY_GRAMMAR_VERSION,
        represented_documents: staleDocuments,
      },
    })
    await writePack({
      pluginRoot,
      packId: "stale-grammar",
      rows: [rowFor(current.identity, 3)],
      manifest: {
        artifact_source_scope_hash: SOURCE_SCOPE_HASH,
        document_tree_hash: currentTreeHash,
        discovery_grammar_version: DISCOVERY_GRAMMAR_VERSION - 1,
        represented_documents: representedDocuments,
      },
    })

    const imported = await importVectorPacks({
      db,
      pluginRoot,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
      expectedArtifactSourceScopeHash: SOURCE_SCOPE_HASH,
      expectedDocumentTreeHash: currentTreeHash,
      expectedDiscoveryGrammarVersion: DISCOVERY_GRAMMAR_VERSION,
    })
    assert.equal(imported.packs_considered, 3)
    assert.equal(imported.packs_imported, 0)
    assert.equal(imported.rows_imported, 0)
    assert.equal(db.prepare("SELECT count(*) AS count FROM chunk_vecs").get().count, 0)
  } finally {
    closeDb(db)
  }
})

test("vector pack import accepts empty active packs as no-op artifacts", async () => {
  const { importVectorPacks, validateVectorPackFile } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const deskRoot = path.join(root, "desk")
  const db = openDb(deskRoot)
  try {
    const paths = await writePack({
      pluginRoot,
      packId: "empty-pack",
      rows: [],
    })
    const validated = await validateVectorPackFile({
      packPath: paths.packPath,
      manifestPath: paths.manifestPath,
      checksumPath: paths.checksumPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    })
    assert.equal(validated.rows.length, 0)

    const imported = await importVectorPacks({
      db,
      pluginRoot,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    })
    assert.equal(imported.packs_considered, 1)
    assert.equal(imported.packs_imported, 1)
    assert.equal(imported.rows_imported, 0)
    assert.equal(imported.rows_skipped_duplicate, 0)
    assert.equal(imported.rows_skipped_missing_chunk, 0)
    assert.equal(db.prepare("SELECT count(*) AS count FROM chunk_vecs").get().count, 0)
  } finally {
    closeDb(db)
  }
})

test("vector pack validation streams final rows without a trailing newline", async () => {
  const { validateVectorPackFile } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const identity = chunkIdentity({
    docPath: "trackA/task-1/task.md",
    chunk: { text: "final row without newline" },
  })
  const paths = await writePack({
    pluginRoot,
    packId: "no-trailing-newline",
    rows: [rowFor(identity, 7)],
  })
  await rewritePackText(paths, JSON.stringify(rowFor(identity, 7)))

  const validated = await validateVectorPackFile({
    packPath: paths.packPath,
    manifestPath: paths.manifestPath,
    checksumPath: paths.checksumPath,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
  })
  assert.equal(validated.rows.length, 1)
  assert.equal(validated.rows[0].row_number, 1)
})

test("vector pack validation flushes incomplete UTF-8 at EOF through row parsing", async () => {
  const { validateVectorPackFile } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const paths = await writePack({
    pluginRoot,
    packId: "incomplete-utf8",
    rows: [],
  })
  const packBytes = Buffer.from([0xe2])
  const packSha = sha256(packBytes)
  await fs.writeFile(paths.packPath, packBytes)
  await fs.writeFile(paths.checksumPath, `${packSha}  incomplete-utf8.jsonl\n`, "utf8")
  await fs.writeFile(paths.manifestPath, `${JSON.stringify({
    ...paths.manifest,
    row_count: 1,
    rows_sha256: packSha,
  }, null, 2)}\n`, "utf8")

  await assert.rejects(
    () => validateVectorPackFile({
      packPath: paths.packPath,
      manifestPath: paths.manifestPath,
      checksumPath: paths.checksumPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    }),
    /incomplete-utf8\.jsonl row 1: malformed JSON/u,
  )
})

test("vector pack validation yields while streaming many blank lines", async () => {
  const { validateVectorPackFile } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const paths = await writePack({
    pluginRoot,
    packId: "many-blank-lines",
    rows: [],
  })
  await rewritePackText(paths, "\n".repeat(101))

  const validated = await validateVectorPackFile({
    packPath: paths.packPath,
    manifestPath: paths.manifestPath,
    checksumPath: paths.checksumPath,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
  })
  assert.equal(validated.rows.length, 0)
})

test("vector pack validation propagates aborts thrown inside the pack stream reader", async () => {
  const { validateVectorPackFile } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const identity = chunkIdentity({
    docPath: "trackA/task-1/task.md",
    chunk: { text: "abort during stream reader" },
  })
  const paths = await writePack({
    pluginRoot,
    packId: "abort-during-stream",
    rows: [rowFor(identity, 9)],
  })
  let reads = 0
  const signal = {
    get aborted() {
      reads += 1
      return reads >= 8
    },
  }

  await assert.rejects(
    () => validateVectorPackFile({
      packPath: paths.packPath,
      manifestPath: paths.manifestPath,
      checksumPath: paths.checksumPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
      signal,
    }),
    (err) => err.name === "AbortError" && err.message === "operation aborted",
  )
})

test("vector pack validation reports missing pack bytes after sidecars validate", async () => {
  const { validateVectorPackFile } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const paths = await writePack({
    pluginRoot,
    packId: "missing-pack-bytes",
    rows: [],
  })
  await fs.rm(paths.packPath)

  await assert.rejects(
    () => validateVectorPackFile({
      packPath: paths.packPath,
      manifestPath: paths.manifestPath,
      checksumPath: paths.checksumPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    }),
    /missing-pack-bytes\.jsonl pack missing/u,
  )
})

test("vector pack validation surfaces unexpected pack stream failures", async () => {
  const { validateVectorPackFile } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const paths = await writePack({
    pluginRoot,
    packId: "pack-stream-failure",
    rows: [],
  })
  await fs.rm(paths.packPath)
  await fs.mkdir(paths.packPath)

  await assert.rejects(
    () => validateVectorPackFile({
      packPath: paths.packPath,
      manifestPath: paths.manifestPath,
      checksumPath: paths.checksumPath,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    }),
    (error) => error.code === "EISDIR",
  )
})

test("vector pack validation and import reject when startup abort signal is tripped", async () => {
  const { importVectorPacks, validateVectorPackFile } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const deskRoot = path.join(root, "desk")
  const db = openDb(deskRoot)
  const controller = new AbortController()
  try {
    const chunk = insertChunk(db, {
      docPath: "trackA/task-1/task.md",
      text: "aborted vector pack chunk",
      chunkIndex: 0,
    })
    const paths = await writePack({
      pluginRoot,
      packId: "aborted-pack",
      rows: [rowFor(chunk.identity, 8)],
    })
    controller.abort()

    await assert.rejects(
      () => validateVectorPackFile({
        packPath: paths.packPath,
        manifestPath: paths.manifestPath,
        checksumPath: paths.checksumPath,
        expectedSpec: ACTIVE_EMBEDDING_SPEC,
        signal: controller.signal,
      }),
      (err) => err.name === "AbortError" && err.message === "operation aborted",
    )
    await assert.rejects(
      () => importVectorPacks({
        db,
        pluginRoot,
        expectedSpec: ACTIVE_EMBEDDING_SPEC,
        signal: controller.signal,
      }),
      (err) => err.name === "AbortError" && err.message === "operation aborted",
    )
    assert.equal(db.prepare("SELECT count(*) AS count FROM chunk_vecs").get().count, 0)
  } finally {
    closeDb(db)
  }
})

test("vector pack import lets startup abort timers fire before whole-pack validation", async (t) => {
  const { importVectorPacks } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const deskRoot = path.join(root, "desk")
  const db = openDb(deskRoot)
  try {
    const paths = await writePack({
      pluginRoot,
      packId: "timer-abort-pack",
      rows: [],
    })
    await rewritePackText(paths, "\n".repeat(101))
    const originalReadFile = fs.readFile.bind(fs)
    const packBytes = await originalReadFile(paths.packPath)
    packBytes.toString = function toStringWithStartupBlocking(...args) {
      const end = Date.now() + 150
      while (Date.now() < end) {
        // Simulate the old whole-file string conversion monopolizing startup.
      }
      return Buffer.prototype.toString.apply(this, args)
    }
    t.mock.method(fs, "readFile", async (filePath, ...args) => {
      if (String(filePath) === paths.packPath) return packBytes
      return originalReadFile(filePath, ...args)
    })

    const controller = new AbortController()
    let reads = 0
    const signal = {
      get aborted() {
        reads += 1
        if (reads === 2) {
          setTimeout(() => controller.abort(), 0)
        }
        return controller.signal.aborted
      },
    }

    const startedAt = Date.now()
    await assert.rejects(
      () => importVectorPacks({
        db,
        pluginRoot,
        expectedSpec: ACTIVE_EMBEDDING_SPEC,
        signal,
      }),
      (err) => err.name === "AbortError" && err.message === "operation aborted",
    )
    const elapsedMs = Date.now() - startedAt
    assert.ok(elapsedMs < 100, `abort timer was blocked for ${elapsedMs}ms`)
  } finally {
    closeDb(db)
  }
})

test("vector pack import deduplicates repeated chunk keys across packs after hash verification", async () => {
  const { importVectorPacks } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const deskRoot = path.join(root, "desk")
  const db = openDb(deskRoot)
  try {
    const chunk = insertChunk(db, {
      docPath: "trackA/task-1/task.md",
      text: "cross-pack duplicate chunk",
      chunkIndex: 0,
    })
    await writePack({
      pluginRoot,
      packId: "cross-pack-a",
      rows: [rowFor(chunk.identity, 5)],
    })
    await writePack({
      pluginRoot,
      packId: "cross-pack-b",
      rows: [rowFor(chunk.identity, 6)],
    })

    const imported = await importVectorPacks({
      db,
      pluginRoot,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    })
    assert.equal(imported.packs_considered, 2)
    assert.equal(imported.packs_imported, 2)
    assert.equal(imported.rows_imported, 1)
    assert.equal(imported.rows_skipped_duplicate, 1)
    assert.equal(db.prepare("SELECT count(*) AS count FROM chunk_vecs").get().count, 1)
    assertStoredVector(db, chunk.chunkId, vector(5))
  } finally {
    closeDb(db)
  }
})

test("vector pack import handles missing pack directories and missing local chunks safely", async () => {
  const { importVectorPacks } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const deskRoot = path.join(root, "desk")
  const db = openDb(deskRoot)
  try {
    const missingDir = await importVectorPacks({
      db,
      pluginRoot,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    })
    assert.deepEqual(missingDir, {
      packs_considered: 0,
      packs_imported: 0,
      rows_imported: 0,
      rows_skipped_duplicate: 0,
      rows_skipped_missing_chunk: 0,
    })

    const identity = chunkIdentity({
      docPath: "trackA/task-missing/task.md",
      chunk: { text: "chunk absent from local db" },
    })
    await writePack({
      pluginRoot,
      packId: "missing-local-chunk",
      rows: [rowFor(identity)],
    })
    const imported = await importVectorPacks({
      db,
      pluginRoot,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    })
    assert.equal(imported.packs_considered, 1)
    assert.equal(imported.packs_imported, 1)
    assert.equal(imported.rows_imported, 0)
    assert.equal(imported.rows_skipped_missing_chunk, 1)
    assert.equal(db.prepare("SELECT count(*) AS count FROM chunk_vecs").get().count, 0)
  } finally {
    closeDb(db)
  }
})

test("vector pack import ignores inactive spec directories and rejects inactive manifests in the active dir", async () => {
  const { importVectorPacks } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const deskRoot = path.join(root, "desk")
  const inactiveSpecId = "inactive-spec"
  const db = openDb(deskRoot)
  try {
    const chunk = insertChunk(db, {
      docPath: "trackA/task-1/task.md",
      text: "active local chunk",
      chunkIndex: 0,
    })
    await writePack({
      pluginRoot,
      embeddingSpecId: inactiveSpecId,
      packId: "inactive-dir-pack",
      rows: [
        rowFor(chunk.identity, 1, {
          embedding_spec_id: inactiveSpecId,
        }),
      ],
      manifest: {
        embedding_spec_id: inactiveSpecId,
      },
    })

    const ignored = await importVectorPacks({
      db,
      pluginRoot,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    })
    assert.equal(ignored.packs_considered, 0)
    assert.equal(ignored.packs_imported, 0)
    assert.equal(db.prepare("SELECT count(*) AS count FROM chunk_vecs").get().count, 0)

    await writePack({
      pluginRoot,
      packId: "inactive-active-dir-pack",
      rows: [
        rowFor(chunk.identity, 1, {
          embedding_spec_id: inactiveSpecId,
        }),
      ],
      manifest: {
        embedding_spec_id: inactiveSpecId,
      },
    })
    await assert.rejects(
      () => importVectorPacks({
        db,
        pluginRoot,
        expectedSpec: ACTIVE_EMBEDDING_SPEC,
      }),
      /manifest embedding_spec_id/u,
    )
    assert.equal(db.prepare("SELECT count(*) AS count FROM chunk_vecs").get().count, 0)
  } finally {
    closeDb(db)
  }
})

test("vector pack import surfaces unexpected artifact directory failures", async () => {
  const { importVectorPacks } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const deskRoot = path.join(root, "desk")
  const specParent = path.join(pluginRoot, "artifacts", "vector-packs")
  await fs.mkdir(specParent, { recursive: true })
  await fs.writeFile(path.join(specParent, ACTIVE_EMBEDDING_SPEC.id), "not a directory", "utf8")
  const db = openDb(deskRoot)
  try {
    await assert.rejects(
      () => importVectorPacks({
        db,
        pluginRoot,
        expectedSpec: ACTIVE_EMBEDDING_SPEC,
      }),
      (error) => error.code === "ENOTDIR",
    )
  } finally {
    closeDb(db)
  }
})

test("vector pack import verifies chunk text hashes against the local DB before inserting", async () => {
  const { importVectorPacks } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const deskRoot = path.join(root, "desk")
  const db = openDb(deskRoot)
  try {
    const chunk = insertChunk(db, {
      docPath: "trackA/task-1/task.md",
      text: "actual local chunk",
      chunkIndex: 0,
    })
    await writePack({
      pluginRoot,
      packId: "wrong-hash",
      rows: [
        rowFor(chunk.identity, 1, {
          text_hash: chunkIdentity({
            docPath: "trackA/task-1/task.md",
            chunk: { text: "different text" },
          }).text_hash,
        }),
      ],
    })

    await assert.rejects(
      () => importVectorPacks({
        db,
        pluginRoot,
        expectedSpec: ACTIVE_EMBEDDING_SPEC,
      }),
      (error) => {
        assert.match(error.message, /wrong-hash\.jsonl.*row 1.*text_hash/u)
        assert.match(error.message, new RegExp(chunk.identity.chunk_key, "u"))
        assert.doesNotMatch(error.message, /actual local chunk|different text/u)
        return true
      },
    )
    assert.equal(db.prepare("SELECT count(*) AS count FROM chunk_vecs").get().count, 0)
  } finally {
    closeDb(db)
  }
})

test("vector pack import inserts vectors for every local chunk that shares a covered chunk key", async () => {
  const { importVectorPacks } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const deskRoot = path.join(root, "desk")
  const db = openDb(deskRoot)
  try {
    const first = insertChunk(db, {
      docPath: "trackA/task-1/task.md",
      text: "duplicated semantic chunk",
      chunkIndex: 0,
    })
    const second = insertChunkForDoc(db, {
      docId: first.docId,
      docPath: "trackA/task-1/task.md",
      text: "duplicated semantic chunk",
      chunkIndex: 1,
    })
    assert.equal(first.identity.chunk_key, second.identity.chunk_key)
    await writePack({
      pluginRoot,
      packId: "duplicate-local-chunks",
      rows: [rowFor(first.identity, 4)],
    })

    const imported = await importVectorPacks({
      db,
      pluginRoot,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
    })
    assert.equal(imported.rows_imported, 2)
    assert.equal(imported.rows_skipped_duplicate, 0)
    assert.equal(db.prepare("SELECT count(*) AS count FROM chunk_vecs").get().count, 2)
    assertStoredVector(db, first.chunkId, vector(4))
    assertStoredVector(db, second.chunkId, vector(4))
  } finally {
    closeDb(db)
  }
})

test("vector pack import rejects contradictory duplicate rows before deduplication", async () => {
  const { importVectorPacks } = await loadVectorPackModule()
  const root = await tmpRoot()
  const pluginRoot = path.join(root, "plugins", "desk")
  const deskRoot = path.join(root, "desk")
  const db = openDb(deskRoot)
  try {
    const chunk = insertChunk(db, {
      docPath: "trackA/task-1/task.md",
      text: "duplicate row local chunk",
      chunkIndex: 0,
    })
    await writePack({
      pluginRoot,
      packId: "duplicate-a",
      rows: [rowFor(chunk.identity, 1)],
    })
    await writePack({
      pluginRoot,
      packId: "duplicate-b",
      rows: [
        rowFor(chunk.identity, 2, {
          text_hash: chunkIdentity({
            docPath: "trackA/task-1/task.md",
            chunk: { text: "conflicting duplicate text" },
          }).text_hash,
        }),
      ],
    })

    await assert.rejects(
      () => importVectorPacks({
        db,
        pluginRoot,
        expectedSpec: ACTIVE_EMBEDDING_SPEC,
      }),
      /duplicate-b\.jsonl.*row 1.*text_hash/u,
    )
  } finally {
    closeDb(db)
  }
})
