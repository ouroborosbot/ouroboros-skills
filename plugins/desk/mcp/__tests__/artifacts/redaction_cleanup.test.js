// Unit 20a: red contract for tombstone metadata, redaction invalidation, and
// artifact cleanup before vector packs or snapshots can represent deleted docs.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { closeDb, openDb } from "../../src/db/init.js"
import { rebuildIndex } from "../../src/indexer/index.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"
import { validateVectorPackCompaction } from "../../src/indexer/vector-compaction.js"
import {
  validateVectorPackFile,
  writeVectorPackArtifact,
} from "../../src/indexer/vector-packs.js"
import { ensureIndex } from "../../src/server-helpers.js"
import {
  validateSnapshotArtifact,
  writeSnapshotArtifact,
} from "../../src/snapshots/manifest.js"

const mcpRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))
const repoRoot = path.resolve(mcpRoot, "..", "..", "..")
const deskPluginRoot = path.join(repoRoot, "plugins", "desk")
const publicationPolicySchemaPath = path.join(
  deskPluginRoot,
  "artifacts",
  "publication-policy.schema.json",
)
const tombstoneSchemaPath = path.join(
  deskPluginRoot,
  "artifacts",
  "tombstones",
  "tombstone.schema.json",
)
const tombstoneLedgerPath = path.join(
  deskPluginRoot,
  "artifacts",
  "tombstones",
  "tombstones.jsonl",
)
const SNAPSHOT_DB_SCHEMA = { id: "desk-index-sqlite-v1", version: 1 }
const SNAPSHOT_SQLITE_VEC = { package: "sqlite-vec", version: "0.1.6", table: "vec0" }
const SNAPSHOT_RUNTIME = { platform: "darwin", arch: "arm64", node_abi: "node-127" }
const SNAPSHOT_SOURCE_SCOPE_HASH = `sha256:${"a".repeat(64)}`
const SNAPSHOT_DOCUMENT_TREE_HASH = `sha256:${"b".repeat(64)}`

async function loadTombstonesModule() {
  return import(pathToFileURL(path.join(mcpRoot, "src", "artifacts", "tombstones.js")))
}

async function loadRebuildIndexScriptModule() {
  return import(pathToFileURL(path.join(mcpRoot, "scripts", "rebuild-index.js")).href)
}

async function tmpRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function writeFile(root, rel, body) {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, "utf8")
}

async function writePublicationSchemaFixture(pluginRoot) {
  const artifactsRoot = path.join(pluginRoot, "artifacts")
  await fs.mkdir(artifactsRoot, { recursive: true })
  await fs.copyFile(
    publicationPolicySchemaPath,
    path.join(artifactsRoot, "publication-policy.schema.json"),
  )
}

async function writeTombstoneLedger(pluginRoot, rows) {
  const tombstoneRoot = path.join(pluginRoot, "artifacts", "tombstones")
  await fs.mkdir(tombstoneRoot, { recursive: true })
  await fs.writeFile(
    path.join(tombstoneRoot, "tombstones.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  )
}

async function writeRawTombstoneLedger(pluginRoot, body) {
  const tombstoneRoot = path.join(pluginRoot, "artifacts", "tombstones")
  await fs.mkdir(tombstoneRoot, { recursive: true })
  await fs.writeFile(path.join(tombstoneRoot, "tombstones.jsonl"), body, "utf8")
}

async function writeVectorValidationFixture({
  pluginRoot,
  packId,
  represented_documents,
} = {}) {
  const packDir = path.join(
    pluginRoot,
    "artifacts",
    "vector-packs",
    ACTIVE_EMBEDDING_SPEC.id,
  )
  await fs.mkdir(packDir, { recursive: true })
  const row = {
    chunk_key: `ck_${"1".repeat(40)}`,
    text_hash: sha256("fixture chunk"),
    embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id,
    dimension: ACTIVE_EMBEDDING_SPEC.dimension,
    encoding: "float32-json",
    vector: Array.from(
      { length: ACTIVE_EMBEDDING_SPEC.dimension },
      (_, index) => index / ACTIVE_EMBEDDING_SPEC.dimension,
    ),
  }
  const packPath = path.join(packDir, `${packId}.jsonl`)
  const manifestPath = path.join(packDir, `${packId}.manifest.json`)
  const checksumPath = path.join(packDir, `${packId}.sha256`)
  const packBytes = `${JSON.stringify(row)}\n`
  const packSha = createHash("sha256").update(packBytes).digest("hex")
  await fs.writeFile(packPath, packBytes, "utf8")
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({
      schema_version: 1,
      pack_id: packId,
      embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id,
      dimension: ACTIVE_EMBEDDING_SPEC.dimension,
      encoding: "float32-json",
      row_count: 1,
      rows_sha256: packSha,
      represented_documents,
      created_at: "2026-06-15T00:00:00.000Z",
      provenance: {
        builder: "artifact:vector-pack:build",
        source: "unit-test",
      },
    }, null, 2)}\n`,
    "utf8",
  )
  await fs.writeFile(checksumPath, `${packSha}  ${packId}.jsonl\n`, "utf8")
  return { packPath, manifestPath, checksumPath }
}

async function writeSnapshotValidationFixture({
  pluginRoot,
  snapshotId,
  represented_documents,
} = {}) {
  const snapshotDir = path.join(
    pluginRoot,
    "artifacts",
    "snapshots",
    ACTIVE_EMBEDDING_SPEC.id,
  )
  await fs.mkdir(snapshotDir, { recursive: true })
  const snapshotPath = path.join(snapshotDir, `${snapshotId}.sqlite.zst`)
  const manifestPath = path.join(snapshotDir, `${snapshotId}.manifest.json`)
  const checksumPath = path.join(snapshotDir, `${snapshotId}.sha256`)
  const snapshotBytes = Buffer.from(`snapshot bytes for ${snapshotId}`, "utf8")
  const snapshotSha = sha256(snapshotBytes)
  await fs.writeFile(snapshotPath, snapshotBytes)
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({
      schema_version: 1,
      snapshot_id: snapshotId,
      embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id,
      dimension: ACTIVE_EMBEDDING_SPEC.dimension,
      chunker_id: ACTIVE_EMBEDDING_SPEC.chunker_id,
      normalization_id: ACTIVE_EMBEDDING_SPEC.normalization_id,
      db_schema: SNAPSHOT_DB_SCHEMA,
      sqlite_vec: SNAPSHOT_SQLITE_VEC,
      runtime: SNAPSHOT_RUNTIME,
      artifact_source_scope_hash: SNAPSHOT_SOURCE_SCOPE_HASH,
      document_tree_hash: SNAPSHOT_DOCUMENT_TREE_HASH,
      included_pack_ids: ["redaction-pack"],
      represented_documents,
      created_at: "2026-06-15T00:00:00.000Z",
      artifact: {
        file: `${snapshotId}.sqlite.zst`,
        format: "sqlite-zstd",
        sha256: snapshotSha,
        compressed: true,
      },
      provenance: {
        builder: "plugins/desk/mcp/scripts/build-snapshot.js",
        source: "unit-test",
        commit: "0123456789abcdef0123456789abcdef01234567",
      },
      source_paths: [
        "plugins/desk/mcp/src/snapshots/restore.js",
        "plugins/desk/mcp/src/db/schema.sql",
        "plugins/desk/mcp/package-lock.json",
      ],
    }, null, 2)}\n`,
    "utf8",
  )
  await fs.writeFile(checksumPath, `${snapshotSha}  ${snapshotId}.sqlite.zst\n`, "utf8")
  return { snapshotPath, manifestPath, checksumPath }
}

async function fileHashes(root) {
  const hashes = {}
  async function walk(current) {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch (error) {
      if (error.code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (entry.isFile()) {
        hashes[path.relative(root, abs).split(path.sep).join("/")] =
          await fs.readFile(abs, "utf8")
      }
    }
  }
  await walk(root)
  return Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)))
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function tombstoneRow(overrides = {}) {
  return {
    schema_version: 1,
    document_path: "trackA/task-1/task.md",
    document_hash: sha256("public body"),
    reason: "deleted",
    redacted_at: "2026-06-15T00:00:00.000Z",
    effective_from: "2026-06-15T00:00:00.000Z",
    artifact_rotation_id: "rotation-2026-06-15",
    actor: "unit-test-reviewer",
    ...overrides,
  }
}

function vectorRow({ key, hash, seed }) {
  return {
    chunk_key: `ck_${key.repeat(40).slice(0, 40)}`,
    text_hash: `sha256:${hash.repeat(64).slice(0, 64)}`,
    embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id,
    dimension: ACTIVE_EMBEDDING_SPEC.dimension,
    encoding: "float32-json",
    vector: Array.from(
      { length: ACTIVE_EMBEDDING_SPEC.dimension },
      (_, index) => ((seed + index) % 31) / 31,
    ),
  }
}

function pack(packId, rows) {
  return {
    pack_id: packId,
    embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id,
    rows,
  }
}

function dbCounts(deskRoot) {
  const db = openDb(deskRoot)
  try {
    return {
      docs: db.prepare("SELECT COUNT(*) AS count FROM docs").get().count,
      chunks: db.prepare("SELECT COUNT(*) AS count FROM chunks").get().count,
      vectors: db.prepare("SELECT COUNT(*) AS count FROM chunk_vecs").get().count,
      refs: db.prepare("SELECT COUNT(*) AS count FROM refs_graph").get().count,
    }
  } finally {
    closeDb(db)
  }
}

function approvedPublicationPolicy() {
  return {
    schema_version: 1,
    default_publication: "deny",
    repo_visibility: "public",
    sensitive_repo: true,
    approved_artifact_types: ["snapshot", "vector-pack"],
    approval_required: true,
    approvals: [
      {
        scope: "repo",
        artifact_type: "vector-pack",
        approved_by: "unit-test-reviewer",
        approved_at: "2026-06-15T00:00:00.000Z",
        reason: "explicit vector-pack approval for redaction fixture",
      },
      {
        scope: "repo",
        artifact_type: "snapshot",
        approved_by: "unit-test-reviewer",
        approved_at: "2026-06-15T00:00:00.000Z",
        reason: "explicit snapshot approval for redaction fixture",
      },
    ],
    updated_at: "2026-06-15T00:00:00.000Z",
  }
}

function publicErrorShape(value, seen = new Set()) {
  if (value == null || typeof value !== "object") return value
  if (seen.has(value)) return "[Circular]"
  seen.add(value)

  if (value instanceof Error) {
    const shape = { message: value.message }
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === "stack" || key === "message") continue
      shape[key] = publicErrorShape(value[key], seen)
    }
    return shape
  }

  if (Array.isArray(value)) {
    return value.map((item) => publicErrorShape(item, seen))
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, publicErrorShape(item, seen)]),
  )
}

function assertPublicErrorDoesNotLeak(error) {
  const serialized = JSON.stringify(publicErrorShape(error))
  assert.doesNotMatch(
    serialized,
    /public body|archive body|safe body|updated public body|ledger secret|task-1|old-note|public-note|trackA|trackB/u,
  )
}

async function assertRejectsBeforeArtifactWrites(write, artifactType) {
  const originalWriteFile = fs.writeFile
  const attemptedWrites = []
  fs.writeFile = async (...args) => {
    attemptedWrites.push(String(args[0]))
    return originalWriteFile.apply(fs, args)
  }
  try {
    await assert.rejects(
      write,
      (error) => {
        assert.equal(error.code, "artifact_input_redacted")
        assert.equal(error.artifact_type, artifactType)
        assert.equal(error.redacted_count, 2)
        assertPublicErrorDoesNotLeak(error)
        return true
      },
    )
  } finally {
    fs.writeFile = originalWriteFile
  }
  assert.deepEqual(attemptedWrites, [])
}

function assertInvalidLedgerArtifactError(error, artifactType) {
  assert.equal(error.code, "artifact_tombstone_ledger_invalid")
  assert.equal(error.artifact_type, artifactType)
  assertPublicErrorDoesNotLeak(error)
  return true
}

async function assertInvalidLedgerRejectsBeforeArtifactWrites(write, artifactType) {
  const originalWriteFile = fs.writeFile
  const attemptedWrites = []
  fs.writeFile = async (...args) => {
    attemptedWrites.push(String(args[0]))
    return originalWriteFile.apply(fs, args)
  }
  try {
    await assert.rejects(write, (error) => assertInvalidLedgerArtifactError(error, artifactType))
  } finally {
    fs.writeFile = originalWriteFile
  }
  assert.deepEqual(attemptedWrites, [])
}

test("canonical tombstone ledger and schema exist under plugin artifacts", async () => {
  const schema = JSON.parse(await fs.readFile(tombstoneSchemaPath, "utf8"))
  assert.equal(schema.type, "object")
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(
    [...schema.required].sort(),
    [
      "actor",
      "artifact_rotation_id",
      "document_hash",
      "document_path",
      "effective_from",
      "reason",
      "redacted_at",
      "schema_version",
    ],
  )
  assert.equal(schema.properties.schema_version.const, 1)
  assert.equal(schema.properties.document_path.type, "string")
  assert.equal(schema.properties.document_path.minLength, 1)
  assert.equal(typeof schema.properties.document_path.pattern, "string")
  const documentPathPattern = new RegExp(schema.properties.document_path.pattern, "u")
  for (const validPath of [
    "trackA/task-1/task.md",
    "trackA/_archive/old-note.md",
    "nested/path/deep-note.md",
  ]) {
    assert.match(validPath, documentPathPattern)
  }
  for (const invalidPath of [
    "/absolute.md",
    "../escape.md",
    "trackA/../escape.md",
    "trackA\\task.md",
    "trackA//task.md",
  ]) {
    assert.doesNotMatch(invalidPath, documentPathPattern)
  }
  assert.equal(schema.properties.document_hash.type, "string")
  assert.equal(schema.properties.document_hash.pattern, "^sha256:[a-f0-9]{64}$")
  assert.equal(schema.properties.reason.type, "string")
  assert.deepEqual(schema.properties.reason.enum.sort(), ["deleted", "redacted"])
  assert.equal(schema.properties.redacted_at.type, "string")
  assert.equal(schema.properties.redacted_at.format, "date-time")
  assert.equal(schema.properties.effective_from.type, "string")
  assert.equal(schema.properties.effective_from.format, "date-time")
  assert.equal(schema.properties.artifact_rotation_id.type, "string")
  assert.equal(schema.properties.artifact_rotation_id.minLength, 1)
  assert.equal(schema.properties.actor.type, "string")
  assert.equal(schema.properties.actor.minLength, 1)

  const ledger = await fs.readFile(tombstoneLedgerPath, "utf8")
  assert.ok(ledger === "" || ledger.endsWith("\n"))
  const { loadTombstoneLedger } = await loadTombstonesModule()
  const loaded = await loadTombstoneLedger({ pluginRoot: deskPluginRoot })
  assert.equal(loaded.valid, true)
  assert.deepEqual(loaded.diagnostics, [])
  assert.equal(
    loaded.rows.length,
    ledger.trim() === "" ? 0 : ledger.trimEnd().split("\n").length,
  )
})

test("tombstone ledger fingerprints bind semantic rows, not file presence", async () => {
  const {
    loadTombstoneLedger,
    tombstoneLedgerFingerprint,
  } = await loadTombstonesModule()
  const absentRoot = await tmpRoot("desk-tombstone-fingerprint-absent-")
  const emptyRoot = await tmpRoot("desk-tombstone-fingerprint-empty-")
  await writeRawTombstoneLedger(emptyRoot, "")

  const absent = await loadTombstoneLedger({ pluginRoot: absentRoot })
  const empty = await loadTombstoneLedger({ pluginRoot: emptyRoot })
  const emptyFingerprint = `sha256:${createHash("sha256").digest("hex")}`
  assert.equal(tombstoneLedgerFingerprint(absent), emptyFingerprint)
  assert.equal(tombstoneLedgerFingerprint(empty), emptyFingerprint)

  const row = tombstoneRow()
  assert.equal(
    tombstoneLedgerFingerprint({ valid: true, rows: [row] }),
    sha256(`${JSON.stringify(row)}\0`),
  )
  assert.equal(tombstoneLedgerFingerprint(), null)
  assert.equal(tombstoneLedgerFingerprint({ valid: true, rows: null }), null)
})

test("tombstone loader validates required row fields and repeated tombstones", async () => {
  const {
    loadTombstoneLedger,
    tombstoneDecisionForDoc,
    validateTombstoneRow,
  } = await loadTombstonesModule()
  const pluginRoot = await tmpRoot("desk-redaction-ledger-plugin-")

  async function assertInvalidLedgerRowRejected(row, diagnostic) {
    const invalidPluginRoot = await tmpRoot("desk-redaction-invalid-ledger-plugin-")
    await writeTombstoneLedger(invalidPluginRoot, [row])
    const ledger = await loadTombstoneLedger({ pluginRoot: invalidPluginRoot })
    assert.equal(ledger.valid, false)
    assert.deepEqual(ledger.rows, [])
    assert.ok(ledger.diagnostics.includes(diagnostic))
    assertPublicErrorDoesNotLeak(ledger)
  }

  async function assertInvalidRawLedgerRejected(body, diagnostic) {
    const invalidPluginRoot = await tmpRoot("desk-redaction-invalid-ledger-plugin-")
    await writeRawTombstoneLedger(invalidPluginRoot, body)
    const ledger = await loadTombstoneLedger({ pluginRoot: invalidPluginRoot })
    assert.equal(ledger.valid, false)
    assert.deepEqual(ledger.rows, [])
    assert.ok(ledger.diagnostics.includes(diagnostic))
    assertPublicErrorDoesNotLeak(ledger)
  }

  await assertInvalidRawLedgerRejected(
    '{"schema_version":1\n',
    "tombstone ledger line 1 must be valid JSON",
  )

  for (const row of [null, ["not", "an", "object"], "not an object"]) {
    assert.deepEqual(validateTombstoneRow(row), ["tombstone row must be an object"])
    await assertInvalidLedgerRowRejected(row, "tombstone row must be an object")
  }

  assert.deepEqual(
    validateTombstoneRow({ ...tombstoneRow(), unsupported: true }),
    ["tombstone row has unsupported field unsupported"],
  )
  await assertInvalidLedgerRowRejected(
    { ...tombstoneRow(), unsupported: "ledger secret" },
    "tombstone row has unsupported field unsupported",
  )
  assert.deepEqual(
    validateTombstoneRow({ ...tombstoneRow(), schema_version: 2 }),
    ["tombstone row schema_version is unsupported"],
  )
  await assertInvalidLedgerRowRejected(
    { ...tombstoneRow(), schema_version: 2 },
    "tombstone row schema_version is unsupported",
  )
  for (const field of [
    "schema_version",
    "document_path",
    "document_hash",
    "reason",
    "redacted_at",
    "effective_from",
    "artifact_rotation_id",
    "actor",
  ]) {
    const row = tombstoneRow()
    delete row[field]
    assert.deepEqual(
      validateTombstoneRow(row),
      [`tombstone row missing ${field}`],
    )
    await assertInvalidLedgerRowRejected(row, `tombstone row missing ${field}`)
  }
  for (const [field, value, diagnostic] of [
    ["document_path", "../escape.md", "tombstone row document_path must be a normalized relative path"],
    ["document_path", "", "tombstone row document_path must be a normalized relative path"],
    ["document_path", "   ", "tombstone row document_path must be a normalized relative path"],
    ["document_path", "./task.md", "tombstone row document_path must be a normalized relative path"],
    ["document_path", "trackA/./task.md", "tombstone row document_path must be a normalized relative path"],
    ["document_path", "/absolute.md", "tombstone row document_path must be a normalized relative path"],
    ["document_path", "trackA/../escape.md", "tombstone row document_path must be a normalized relative path"],
    ["document_path", "trackA\\task.md", "tombstone row document_path must be a normalized relative path"],
    ["document_path", "trackA//task.md", "tombstone row document_path must be a normalized relative path"],
    ["document_path", 42, "tombstone row document_path must be a normalized relative path"],
    ["document_hash", "not-a-sha", "tombstone row document_hash must be a sha256 digest"],
    ["document_hash", 42, "tombstone row document_hash must be a sha256 digest"],
    ["reason", "forgotten", "tombstone row reason is unsupported"],
    ["reason", 42, "tombstone row reason is unsupported"],
    ["redacted_at", "not-a-date", "tombstone row redacted_at must be a date-time string"],
    ["redacted_at", "2026-06-15", "tombstone row redacted_at must be a date-time string"],
    ["redacted_at", "2026-06-15T00:00:00", "tombstone row redacted_at must be a date-time string"],
    ["redacted_at", "2026-99-99T00:00:00.000Z", "tombstone row redacted_at must be a date-time string"],
    ["redacted_at", 42, "tombstone row redacted_at must be a date-time string"],
    ["effective_from", "not-a-date", "tombstone row effective_from must be a date-time string"],
    ["effective_from", "2026-06-15", "tombstone row effective_from must be a date-time string"],
    ["effective_from", "2026-06-15T00:00:00", "tombstone row effective_from must be a date-time string"],
    ["effective_from", "2026-99-99T00:00:00.000Z", "tombstone row effective_from must be a date-time string"],
    ["effective_from", 42, "tombstone row effective_from must be a date-time string"],
    ["artifact_rotation_id", "", "tombstone row artifact_rotation_id must be non-empty text"],
    ["artifact_rotation_id", 42, "tombstone row artifact_rotation_id must be non-empty text"],
    ["actor", "", "tombstone row actor must be non-empty text"],
    ["actor", 42, "tombstone row actor must be non-empty text"],
  ]) {
    assert.deepEqual(
      validateTombstoneRow({ ...tombstoneRow(), [field]: value }),
      [diagnostic],
    )
    await assertInvalidLedgerRowRejected({ ...tombstoneRow(), [field]: value }, diagnostic)
  }
  const wholeSecondRow = {
    ...tombstoneRow(),
    redacted_at: "2026-06-15T00:00:00Z",
    effective_from: "2026-06-15T00:00:00Z",
  }
  assert.deepEqual(validateTombstoneRow(wholeSecondRow), [])
  const wholeSecondPluginRoot = await tmpRoot("desk-redaction-whole-second-ledger-plugin-")
  await writeTombstoneLedger(wholeSecondPluginRoot, [wholeSecondRow])
  assert.equal((await loadTombstoneLedger({ pluginRoot: wholeSecondPluginRoot })).valid, true)

  await writeTombstoneLedger(pluginRoot, [
    tombstoneRow({ reason: "deleted", artifact_rotation_id: "rotation-old" }),
    tombstoneRow({
      reason: "redacted",
      redacted_at: "2026-06-16T00:00:00.000Z",
      effective_from: "2026-06-16T00:00:00.000Z",
      artifact_rotation_id: "rotation-new",
    }),
  ])

  const ledger = await loadTombstoneLedger({ pluginRoot })
  assert.equal(ledger.valid, true)
  assert.equal(ledger.rows.length, 2)
  assert.deepEqual(
    tombstoneDecisionForDoc({
      ledger,
      doc: {
        path: "trackA/task-1/task.md",
        hash: sha256("public body"),
      },
    }),
    {
      tombstoned: true,
      reason: "redacted",
      artifact_rotation_id: "rotation-new",
    },
  )

  const counterorderedPluginRoot = await tmpRoot("desk-redaction-counterordered-ledger-plugin-")
  await writeTombstoneLedger(counterorderedPluginRoot, [
    tombstoneRow({
      reason: "redacted",
      redacted_at: "2026-06-16T00:00:00.000Z",
      effective_from: "2026-06-16T00:00:00.000Z",
      artifact_rotation_id: "rotation-newer-time",
    }),
    tombstoneRow({
      reason: "deleted",
      redacted_at: "2026-06-15T00:00:00.000Z",
      effective_from: "2026-06-15T00:00:00.000Z",
      artifact_rotation_id: "rotation-last-row",
    }),
  ])
  const counterorderedLedger = await loadTombstoneLedger({
    pluginRoot: counterorderedPluginRoot,
  })
  assert.deepEqual(
    tombstoneDecisionForDoc({
      ledger: counterorderedLedger,
      doc: {
        path: "trackA/task-1/task.md",
        hash: sha256("public body"),
      },
    }),
    {
      tombstoned: true,
      reason: "deleted",
      artifact_rotation_id: "rotation-last-row",
    },
  )
})

test("artifact writers reject tombstoned active and archived source docs before writes", async () => {
  const root = await tmpRoot("desk-redaction-writer-")
  const deskRoot = path.join(root, "desk")
  const pluginRoot = path.join(root, "plugins", "desk")
  await writePublicationSchemaFixture(pluginRoot)
  await writeFile(deskRoot, "trackA/task-1/task.md", "public body")
  await writeFile(deskRoot, "trackA/_archive/old-note.md", "archive body")
  await writeFile(deskRoot, "trackB/public-note.md", "safe body")
  await writeTombstoneLedger(pluginRoot, [
    tombstoneRow(),
    tombstoneRow({
      document_path: "trackA/_archive/old-note.md",
      document_hash: sha256("archive body"),
      reason: "redacted",
      artifact_rotation_id: "rotation-archived",
    }),
  ])

  const artifactsRoot = path.join(pluginRoot, "artifacts")
  const beforeRejectedWrites = await fileHashes(artifactsRoot)
  const tombstonedSourceDocs = [
    { path: "trackA/task-1/task.md", hash: sha256("public body"), body: "public body" },
    { path: "trackA/_archive/old-note.md", hash: sha256("archive body"), body: "archive body" },
    { path: "trackB/public-note.md", hash: sha256("safe body"), body: "safe body" },
    {
      path: "trackA/task-1/task.md",
      hash: sha256("updated public body"),
      body: "updated public body",
    },
  ]
  const safeSourceDocs = [
    { path: "trackB/public-note.md", hash: sha256("safe body"), body: "safe body" },
    {
      path: "trackA/task-1/task.md",
      hash: sha256("updated public body"),
      body: "updated public body",
    },
  ]

  for (const [label, writeLedger] of [
    ["malformed", (pluginRootForLedger) => writeRawTombstoneLedger(pluginRootForLedger, '{"schema_version":1\n')],
    ["schema-invalid", (pluginRootForLedger) => writeTombstoneLedger(pluginRootForLedger, [
      tombstoneRow({ schema_version: 2 }),
    ])],
  ]) {
    const invalidLedgerPluginRoot = path.join(root, "plugins", `desk-invalid-ledger-${label}`)
    await writePublicationSchemaFixture(invalidLedgerPluginRoot)
    await writeLedger(invalidLedgerPluginRoot)
    for (const [artifactType, write] of [
      [
        "vector-pack",
        () => writeVectorPackArtifact({
          pluginRoot: invalidLedgerPluginRoot,
          deskRoot,
          packId: `${label}-invalid-ledger-pack`,
          packBytes: "",
          manifestBytes: "{}\n",
          checksumBytes: `sha256:invalid  ${label}-invalid-ledger-pack.jsonl\n`,
          policy: approvedPublicationPolicy(),
          sourceDocs: safeSourceDocs,
        }),
      ],
      [
        "snapshot",
        () => writeSnapshotArtifact({
          pluginRoot: invalidLedgerPluginRoot,
          deskRoot,
          snapshotId: `${label}-invalid-ledger-snapshot`,
          snapshotBytes: "sqlite bytes",
          manifestBytes: "{}\n",
          checksumBytes: `sha256:invalid  ${label}-invalid-ledger-snapshot.sqlite.zst\n`,
          policy: approvedPublicationPolicy(),
          sourceDocs: safeSourceDocs,
        }),
      ],
    ]) {
      await assertInvalidLedgerRejectsBeforeArtifactWrites(write, artifactType)
    }
  }

  for (const [artifactType, write] of [
    [
      "vector-pack",
      () => writeVectorPackArtifact({
        pluginRoot,
        deskRoot,
        packId: "redacted-pack",
        packBytes: "",
        manifestBytes: "{}\n",
        checksumBytes: "sha256:redacted  redacted-pack.jsonl\n",
        policy: approvedPublicationPolicy(),
        sourceDocs: tombstonedSourceDocs,
      }),
    ],
    [
      "snapshot",
      () => writeSnapshotArtifact({
        pluginRoot,
        deskRoot,
        snapshotId: "redacted-snapshot",
        snapshotBytes: "sqlite bytes",
        manifestBytes: "{}\n",
        checksumBytes: "sha256:redacted  redacted-snapshot.sqlite.zst\n",
        policy: approvedPublicationPolicy(),
        sourceDocs: tombstonedSourceDocs,
      }),
    ],
  ]) {
    await assertRejectsBeforeArtifactWrites(write, artifactType)
  }
  assert.deepEqual(await fileHashes(artifactsRoot), beforeRejectedWrites)

  await assert.doesNotReject(() => writeVectorPackArtifact({
    pluginRoot,
    deskRoot,
    packId: "safe-pack",
    packBytes: "",
    manifestBytes: "{}\n",
    checksumBytes: "sha256:safe  safe-pack.jsonl\n",
    policy: approvedPublicationPolicy(),
    sourceDocs: safeSourceDocs,
  }))
  await assert.doesNotReject(() => writeSnapshotArtifact({
    pluginRoot,
    deskRoot,
    snapshotId: "safe-snapshot",
    snapshotBytes: "sqlite bytes",
    manifestBytes: "{}\n",
    checksumBytes: "sha256:safe  safe-snapshot.sqlite.zst\n",
    policy: approvedPublicationPolicy(),
    sourceDocs: safeSourceDocs,
  }))

  const before = await fileHashes(artifactsRoot)
  await assertRejectsBeforeArtifactWrites(
    () => writeVectorPackArtifact({
      pluginRoot,
      deskRoot,
      packId: "mixed-pack",
      packBytes: "",
      manifestBytes: "{}\n",
      checksumBytes: "sha256:mixed  mixed-pack.jsonl\n",
      policy: approvedPublicationPolicy(),
      sourceDocs: tombstonedSourceDocs,
    }),
    "vector-pack",
  )
  assert.deepEqual(await fileHashes(artifactsRoot), before)
})

test("artifact validation rejects packs and snapshots that still reference tombstoned docs", async () => {
  const {
    assertArtifactDoesNotRepresentTombstones,
  } = await loadTombstonesModule()
  const pluginRoot = await tmpRoot("desk-redaction-active-artifact-plugin-")
  const safeDocs = [
    { path: "trackB/public-note.md", hash: sha256("safe body") },
    { path: "trackA/task-1/task.md", hash: sha256("updated public body") },
  ]
  const mixedDocs = [
    { path: "trackA/task-1/task.md", hash: sha256("public body") },
    { path: "trackB/public-note.md", hash: sha256("safe body") },
    { path: "trackA/task-1/task.md", hash: sha256("updated public body") },
  ]
  const archivedDoc = {
    path: "trackA/_archive/old-note.md",
    hash: sha256("archive body"),
  }
  const activeDoc = { path: "trackA/task-1/task.md", hash: sha256("public body") }
  const fullyRedactedDocs = [activeDoc, archivedDoc, ...safeDocs]
  const invalidLedgerPluginRoots = []
  for (const [label, writeLedger] of [
    ["malformed", (pluginRootForLedger) => writeRawTombstoneLedger(pluginRootForLedger, '{"schema_version":1\n')],
    ["schema-invalid", (pluginRootForLedger) => writeTombstoneLedger(pluginRootForLedger, [
      tombstoneRow({ schema_version: 2 }),
    ])],
  ]) {
    const invalidLedgerPluginRoot = await tmpRoot(`desk-redaction-${label}-ledger-artifact-plugin-`)
    await writeLedger(invalidLedgerPluginRoot)
    invalidLedgerPluginRoots.push({ label, pluginRoot: invalidLedgerPluginRoot })
  }
  await writeTombstoneLedger(pluginRoot, [
    tombstoneRow(),
    tombstoneRow({
      document_path: archivedDoc.path,
      document_hash: archivedDoc.hash,
      reason: "redacted",
      artifact_rotation_id: "rotation-archived",
    }),
  ])

  const safeVectorPack = await writeVectorValidationFixture({
    pluginRoot,
    packId: "safe-existing-pack",
    represented_documents: safeDocs,
  })
  await assert.doesNotReject(() => validateVectorPackFile({
    ...safeVectorPack,
    pluginRoot,
    represented_documents: safeDocs,
  }))
  for (const [packId, represented_documents] of [
    ["missing-represented-docs-pack", undefined],
    ["invalid-represented-docs-pack", [{ path: "trackA/task-1/task.md" }]],
  ]) {
    const invalidRepresentedDocsPack = await writeVectorValidationFixture({
      pluginRoot,
      packId,
      represented_documents,
    })
    await assert.rejects(
      () => validateVectorPackFile({
        ...invalidRepresentedDocsPack,
        pluginRoot,
        represented_documents: safeDocs,
      }),
      (error) => {
        assert.equal(error.code, "artifact_represented_documents_invalid")
        assert.equal(error.artifact_type, "vector-pack")
        assertPublicErrorDoesNotLeak(error)
        return true
      },
    )
  }
  for (const { label, pluginRoot: invalidLedgerPluginRoot } of invalidLedgerPluginRoots) {
    const invalidLedgerVectorPack = await writeVectorValidationFixture({
      pluginRoot: invalidLedgerPluginRoot,
      packId: `${label}-invalid-ledger-existing-pack`,
      represented_documents: safeDocs,
    })
    await assert.rejects(
      () => validateVectorPackFile({
        ...invalidLedgerVectorPack,
        pluginRoot: invalidLedgerPluginRoot,
        represented_documents: safeDocs,
      }),
      (error) => assertInvalidLedgerArtifactError(error, "vector-pack"),
    )
  }

  const redactedVectorPack = await writeVectorValidationFixture({
    pluginRoot,
    packId: "redacted-existing-pack",
    represented_documents: mixedDocs,
  })
  await assert.rejects(
    () => validateVectorPackFile({
      ...redactedVectorPack,
      pluginRoot,
      represented_documents: safeDocs,
    }),
    (error) => {
      assert.equal(error.code, "artifact_represents_redacted_document")
      assert.equal(error.artifact_type, "vector-pack")
      assert.equal(error.redacted_count, 1)
      assertPublicErrorDoesNotLeak(error)
      return true
    },
  )
  const redactedArchivedVectorPack = await writeVectorValidationFixture({
    pluginRoot,
    packId: "redacted-archived-existing-pack",
    represented_documents: fullyRedactedDocs,
  })
  await assert.rejects(
    () => validateVectorPackFile({
      ...redactedArchivedVectorPack,
      pluginRoot,
      represented_documents: safeDocs,
    }),
    (error) => {
      assert.equal(error.code, "artifact_represents_redacted_document")
      assert.equal(error.artifact_type, "vector-pack")
      assert.equal(error.redacted_count, 2)
      assertPublicErrorDoesNotLeak(error)
      return true
    },
  )

  const safeSnapshot = await writeSnapshotValidationFixture({
    pluginRoot,
    snapshotId: "safe-existing-snapshot",
    represented_documents: safeDocs,
  })
  await assert.doesNotReject(() => validateSnapshotArtifact({
    ...safeSnapshot,
    pluginRoot,
    represented_documents: safeDocs,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDbSchema: SNAPSHOT_DB_SCHEMA,
    expectedSqliteVec: SNAPSHOT_SQLITE_VEC,
    expectedRuntime: SNAPSHOT_RUNTIME,
    expectedArtifactSourceScopeHash: SNAPSHOT_SOURCE_SCOPE_HASH,
    expectedDocumentTreeHash: SNAPSHOT_DOCUMENT_TREE_HASH,
  }))
  for (const [snapshotId, represented_documents] of [
    ["missing-represented-docs-snapshot", undefined],
    ["invalid-represented-docs-snapshot", [{ path: "trackA/task-1/task.md" }]],
  ]) {
    const invalidRepresentedDocsSnapshot = await writeSnapshotValidationFixture({
      pluginRoot,
      snapshotId,
      represented_documents,
    })
    await assert.rejects(
      () => validateSnapshotArtifact({
        ...invalidRepresentedDocsSnapshot,
        pluginRoot,
        represented_documents: safeDocs,
        expectedSpec: ACTIVE_EMBEDDING_SPEC,
        expectedDbSchema: SNAPSHOT_DB_SCHEMA,
        expectedSqliteVec: SNAPSHOT_SQLITE_VEC,
        expectedRuntime: SNAPSHOT_RUNTIME,
        expectedArtifactSourceScopeHash: SNAPSHOT_SOURCE_SCOPE_HASH,
        expectedDocumentTreeHash: SNAPSHOT_DOCUMENT_TREE_HASH,
      }),
      (error) => {
        assert.equal(error.code, "artifact_represented_documents_invalid")
        assert.equal(error.artifact_type, "snapshot")
        assertPublicErrorDoesNotLeak(error)
        return true
      },
    )
  }
  for (const { label, pluginRoot: invalidLedgerPluginRoot } of invalidLedgerPluginRoots) {
    const invalidLedgerSnapshot = await writeSnapshotValidationFixture({
      pluginRoot: invalidLedgerPluginRoot,
      snapshotId: `${label}-invalid-ledger-existing-snapshot`,
      represented_documents: safeDocs,
    })
    await assert.rejects(
      () => validateSnapshotArtifact({
        ...invalidLedgerSnapshot,
        pluginRoot: invalidLedgerPluginRoot,
        represented_documents: safeDocs,
        expectedSpec: ACTIVE_EMBEDDING_SPEC,
        expectedDbSchema: SNAPSHOT_DB_SCHEMA,
        expectedSqliteVec: SNAPSHOT_SQLITE_VEC,
        expectedRuntime: SNAPSHOT_RUNTIME,
        expectedArtifactSourceScopeHash: SNAPSHOT_SOURCE_SCOPE_HASH,
        expectedDocumentTreeHash: SNAPSHOT_DOCUMENT_TREE_HASH,
      }),
      (error) => assertInvalidLedgerArtifactError(error, "snapshot"),
    )
  }

  const redactedSnapshot = await writeSnapshotValidationFixture({
    pluginRoot,
    snapshotId: "redacted-existing-snapshot",
    represented_documents: fullyRedactedDocs,
  })
  await assert.rejects(
    () => validateSnapshotArtifact({
      ...redactedSnapshot,
      pluginRoot,
      represented_documents: safeDocs,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
      expectedDbSchema: SNAPSHOT_DB_SCHEMA,
      expectedSqliteVec: SNAPSHOT_SQLITE_VEC,
      expectedRuntime: SNAPSHOT_RUNTIME,
      expectedArtifactSourceScopeHash: SNAPSHOT_SOURCE_SCOPE_HASH,
      expectedDocumentTreeHash: SNAPSHOT_DOCUMENT_TREE_HASH,
    }),
    (error) => {
      assert.equal(error.code, "artifact_represents_redacted_document")
      assert.equal(error.artifact_type, "snapshot")
      assert.equal(error.redacted_count, 2)
      assertPublicErrorDoesNotLeak(error)
      return true
    },
  )
  const redactedActiveSnapshot = await writeSnapshotValidationFixture({
    pluginRoot,
    snapshotId: "redacted-active-existing-snapshot",
    represented_documents: [
      { path: "trackA/task-1/task.md", hash: sha256("public body") },
    ],
  })
  await assert.rejects(
    () => validateSnapshotArtifact({
      ...redactedActiveSnapshot,
      pluginRoot,
      represented_documents: safeDocs,
      expectedSpec: ACTIVE_EMBEDDING_SPEC,
      expectedDbSchema: SNAPSHOT_DB_SCHEMA,
      expectedSqliteVec: SNAPSHOT_SQLITE_VEC,
      expectedRuntime: SNAPSHOT_RUNTIME,
      expectedArtifactSourceScopeHash: SNAPSHOT_SOURCE_SCOPE_HASH,
      expectedDocumentTreeHash: SNAPSHOT_DOCUMENT_TREE_HASH,
    }),
    (error) => {
      assert.equal(error.code, "artifact_represents_redacted_document")
      assert.equal(error.artifact_type, "snapshot")
      assert.equal(error.redacted_count, 1)
      assertPublicErrorDoesNotLeak(error)
      return true
    },
  )

  for (const artifactType of ["vector-pack", "snapshot"]) {
    await assert.doesNotReject(() => assertArtifactDoesNotRepresentTombstones({
      pluginRoot,
      artifact_type: artifactType,
      represented_documents: safeDocs,
    }))

    await assert.rejects(
      () => assertArtifactDoesNotRepresentTombstones({
        pluginRoot,
        artifact_type: artifactType,
        represented_documents: mixedDocs,
      }),
      (error) => {
        assert.equal(error.code, "artifact_represents_redacted_document")
        assert.equal(error.artifact_type, artifactType)
        assert.equal(error.redacted_count, 1)
        assertPublicErrorDoesNotLeak(error)
        return true
      },
    )

    for (const representedDoc of [
      { path: "trackA/task-1/task.md", hash: sha256("public body") },
      archivedDoc,
    ]) {
      await assert.rejects(
        () => assertArtifactDoesNotRepresentTombstones({
          pluginRoot,
          artifact_type: artifactType,
          represented_documents: [representedDoc],
        }),
        (error) => {
          assert.equal(error.code, "artifact_represents_redacted_document")
          assert.equal(error.artifact_type, artifactType)
          assert.equal(error.redacted_count, 1)
          assertPublicErrorDoesNotLeak(error)
          return true
        },
      )
    }
  }
})

test("tombstone helpers handle defensive edge cases without leaking document details", async () => {
  const {
    assertArtifactDoesNotRepresentTombstones,
    assertArtifactInputsDoNotContainTombstones,
    cleanupRotatedArtifacts,
    loadTombstoneLedger,
    tombstoneDecisionForDoc,
  } = await loadTombstonesModule()
  const missingRootLedger = await loadTombstoneLedger()
  assert.deepEqual(missingRootLedger, {
    valid: true,
    present: false,
    rows: [],
    diagnostics: [],
    ledger_path: null,
  })
  assert.deepEqual(await loadTombstoneLedger({ pluginRoot: "   " }), missingRootLedger)
  assert.deepEqual(tombstoneDecisionForDoc(), { tombstoned: false })
  assert.deepEqual(
    tombstoneDecisionForDoc({ ledger: { valid: true, rows: [] } }),
    { tombstoned: false },
  )
  assert.deepEqual(
    tombstoneDecisionForDoc({
      ledger: { valid: false, rows: [] },
      doc: { path: "safe/note.md", hash: sha256("safe body") },
    }),
    { tombstoned: false },
  )
  assert.deepEqual(
    tombstoneDecisionForDoc({
      ledger: { valid: true, rows: "not rows" },
      doc: { path: "safe/note.md", hash: sha256("safe body") },
    }),
    { tombstoned: false },
  )

  const pluginRoot = await tmpRoot("desk-redaction-helper-edges-plugin-")
  await writeTombstoneLedger(pluginRoot, [])
  for (const [helper, field] of [
    [assertArtifactDoesNotRepresentTombstones, "represented_documents"],
    [assertArtifactInputsDoNotContainTombstones, "sourceDocs"],
  ]) {
    for (const docs of [
      [null],
      [{ path: "../escape.md", hash: sha256("safe body") }],
      [{ path: "safe/note.md", hash: "not-a-sha" }],
    ]) {
      await assert.rejects(
        () => helper({
          pluginRoot,
          artifact_type: "vector-pack",
          [field]: docs,
        }),
        (error) => {
          assert.equal(error.code, "artifact_represented_documents_invalid")
          assert.equal(error.artifact_type, "vector-pack")
          assertPublicErrorDoesNotLeak(error)
          return true
        },
      )
    }
  }

  const noArtifactsRoot = await tmpRoot("desk-redaction-no-artifacts-plugin-")
  assert.deepEqual(await cleanupRotatedArtifacts({ pluginRoot: noArtifactsRoot }), {
    vector_packs_removed: 0,
    snapshots_removed: 0,
    sidecars_removed: 0,
  })

  const partialSidecarsRoot = await tmpRoot("desk-redaction-partial-sidecars-plugin-")
  const partialPackDir = path.join(
    partialSidecarsRoot,
    "artifacts",
    "vector-packs",
    ACTIVE_EMBEDDING_SPEC.id,
  )
  const partialSnapshotDir = path.join(
    partialSidecarsRoot,
    "artifacts",
    "snapshots",
    ACTIVE_EMBEDDING_SPEC.id,
  )
  await fs.mkdir(partialPackDir, { recursive: true })
  await fs.mkdir(partialSnapshotDir, { recursive: true })
  await fs.writeFile(path.join(partialPackDir, "old-pack.jsonl"), "old vector bytes", "utf8")
  await fs.writeFile(path.join(partialPackDir, "old-pack.manifest.json"), "{}", "utf8")
  await fs.writeFile(
    path.join(partialSnapshotDir, "old-snapshot.sqlite.zst"),
    "old snapshot bytes",
    "utf8",
  )
  assert.deepEqual(await cleanupRotatedArtifacts({ pluginRoot: partialSidecarsRoot }), {
    vector_packs_removed: 1,
    snapshots_removed: 1,
    sidecars_removed: 1,
  })

  const brokenVectorDirRoot = await tmpRoot("desk-redaction-broken-vector-dir-plugin-")
  const vectorRoot = path.join(brokenVectorDirRoot, "artifacts", "vector-packs")
  await fs.mkdir(vectorRoot, { recursive: true })
  await fs.writeFile(path.join(vectorRoot, ACTIVE_EMBEDDING_SPEC.id), "not a directory", "utf8")
  await assert.rejects(
    () => cleanupRotatedArtifacts({ pluginRoot: brokenVectorDirRoot }),
    (error) => error.code === "ENOTDIR",
  )

  const brokenSidecarRoot = await tmpRoot("desk-redaction-broken-sidecar-plugin-")
  const brokenSidecarPackDir = path.join(
    brokenSidecarRoot,
    "artifacts",
    "vector-packs",
    ACTIVE_EMBEDDING_SPEC.id,
  )
  await fs.mkdir(path.join(brokenSidecarPackDir, "old-pack.manifest.json"), {
    recursive: true,
  })
  await fs.writeFile(path.join(brokenSidecarPackDir, "old-pack.jsonl"), "old vector bytes", "utf8")
  await assert.rejects(
    () => cleanupRotatedArtifacts({ pluginRoot: brokenSidecarRoot }),
    (error) => error.code === "ERR_FS_EISDIR" || error.code === "EISDIR",
  )
})

test("tombstones make fresh local indexes stale and prune redacted docs", async () => {
  const deskRoot = await tmpRoot("desk-redaction-local-db-")
  const pluginRoot = await tmpRoot("desk-redaction-local-plugin-")
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\nlocal redaction body"
  await writeFile(deskRoot, docPath, body)
  await rebuildIndex(deskRoot, { skipEmbed: true })
  assert.deepEqual(dbCounts(deskRoot), {
    docs: 1,
    chunks: 1,
    vectors: 0,
    refs: 0,
  })

  const noLedger = await ensureIndex(deskRoot, {
    tombstones: { pluginRoot },
    skipEmbed: true,
  })
  assert.equal(noLedger.built, false)
  assert.equal(noLedger.reason, "fresh")

  await writeTombstoneLedger(pluginRoot, [
    tombstoneRow({
      document_path: docPath,
      document_hash: sha256(body),
      reason: "redacted",
      artifact_rotation_id: "rotation-local-db",
    }),
  ])

  const ensured = await ensureIndex(deskRoot, {
    tombstones: { pluginRoot },
    skipEmbed: true,
  })
  assert.equal(ensured.built, true)
  assert.equal(ensured.reason, "stale")
  assert.equal(ensured.summary.docs_tombstoned, 1)
  assert.equal(ensured.summary.docs_removed, 1)
  assert.equal(ensured.summary.docs_indexed, 0)
  assert.deepEqual(dbCounts(deskRoot), {
    docs: 0,
    chunks: 0,
    vectors: 0,
    refs: 0,
  })
})

test("manual rebuild-index script honors the committed tombstone ledger", async () => {
  const deskRoot = await tmpRoot("desk-redaction-script-rebuild-")
  const pluginRoot = await tmpRoot("desk-redaction-script-plugin-")
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\nscript redaction body"
  await writeFile(deskRoot, docPath, body)
  await writeTombstoneLedger(pluginRoot, [
    tombstoneRow({
      document_path: docPath,
      document_hash: sha256(body),
      reason: "deleted",
      artifact_rotation_id: "rotation-script-rebuild",
    }),
  ])

  const result = spawnSync(
    process.execPath,
    [path.join(mcpRoot, "scripts", "rebuild-index.js"), "--root", deskRoot],
    {
      cwd: mcpRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DESK_PLUGIN_ROOT: pluginRoot,
        DESK_EMBED_TIMEOUT_MS: "10",
      },
    },
  )

  assert.equal(result.status, 0, result.stderr)
  const summary = JSON.parse(result.stdout)
  assert.equal(summary.docs_tombstoned, 1)
  assert.equal(summary.docs_indexed, 0)
  assert.equal(summary.docs_removed, 0)
  assert.deepEqual(dbCounts(deskRoot), {
    docs: 0,
    chunks: 0,
    vectors: 0,
    refs: 0,
  })
})

test("manual rebuild-index command helpers stay covered and injectable", async () => {
  const scriptPath = path.join(mcpRoot, "scripts", "rebuild-index.js")
  const deskRoot = await tmpRoot("desk-redaction-command-rebuild-")
  const pluginRoot = await tmpRoot("desk-redaction-command-plugin-")
  const mod = await loadRebuildIndexScriptModule()
  const writes = []
  const captured = {}
  let now = 100

  assert.deepEqual(mod.parseArgs(["--unused", "--root", deskRoot]), {
    root: deskRoot,
  })
  assert.equal(mod.resolvePluginRoot({}, pluginRoot), pluginRoot)
  assert.equal(mod.isMainModule(`${pathToFileURL(scriptPath).href}?fresh=1`, scriptPath), true)
  assert.equal(mod.isMainModule(pathToFileURL(scriptPath).href, ""), false)

  const summary = await mod.main({
    argv: ["--root", deskRoot],
    env: { DESK_PLUGIN_ROOT: pluginRoot },
    now: () => {
      now += 7
      return now
    },
    rebuild: async (root, opts) => {
      captured.root = root
      captured.opts = opts
      return {
        docs_tombstoned: 1,
        docs_indexed: 0,
        docs_removed: 0,
      }
    },
    write: (text) => writes.push(text),
  })

  assert.equal(captured.root, deskRoot)
  assert.deepEqual(captured.opts, {
    tombstones: { pluginRoot },
  })
  assert.equal(summary.elapsed_ms, 7)
  assert.equal(summary.docs_tombstoned, 1)
  assert.deepEqual(JSON.parse(writes[0]), summary)

  const fatalMessages = []
  const started = mod.startCli({
    importMetaUrl: `${pathToFileURL(scriptPath).href}?fresh=2`,
    argv1: scriptPath,
    mainFn: async () => {
      throw new Error("covered failure")
    },
    onFatal: (err) => fatalMessages.push(err.message),
  })
  await started
  assert.deepEqual(fatalMessages, ["covered failure"])

  const skipped = mod.startCli({
    importMetaUrl: pathToFileURL(scriptPath).href,
    argv1: path.join(mcpRoot, "other-script.js"),
    mainFn: async () => {
      throw new Error("should not run")
    },
  })
  assert.equal(skipped, null)

  const logged = []
  let exitCode = 0
  mod.handleFatalError(new Error("fatal path"), {
    logError: (...args) => logged.push(args),
    exit: (code) => {
      exitCode = code
    },
  })
  assert.deepEqual(logged, [["[rebuild-index] fatal:", "fatal path"]])
  assert.equal(exitCode, 1)
})

test("local index freshness fails closed for corrupt tombstones and schema drift", async () => {
  const deskRoot = await tmpRoot("desk-redaction-local-invalid-")
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\nlocal invalid tombstone body"
  await writeFile(deskRoot, docPath, body)
  await rebuildIndex(deskRoot, { skipEmbed: true })

  for (const [label, writeLedger] of [
    ["malformed", (pluginRoot) => writeRawTombstoneLedger(pluginRoot, '{"schema_version":1\n')],
    ["schema-drift", (pluginRoot) => writeTombstoneLedger(pluginRoot, [
      tombstoneRow({
        document_path: docPath,
        document_hash: sha256(body),
        schema_version: 2,
      }),
    ])],
  ]) {
    const pluginRoot = await tmpRoot(`desk-redaction-local-invalid-${label}-`)
    await writeLedger(pluginRoot)
    await assert.rejects(
      () => ensureIndex(deskRoot, {
        tombstones: { pluginRoot },
        skipEmbed: true,
      }),
      (error) => {
        assert.equal(error.code, "tombstone_ledger_invalid")
        assertPublicErrorDoesNotLeak(error)
        return true
      },
    )
    assert.deepEqual(dbCounts(deskRoot), {
      docs: 1,
      chunks: 1,
      vectors: 0,
      refs: 0,
    })
  }
})

test("artifact rotation cleanup is gated by compaction validation and snapshot rotation", async () => {
  const {
    cleanupRotatedArtifacts,
  } = await loadTombstonesModule()
  const pluginRoot = await tmpRoot("desk-redaction-rotation-gates-plugin-")
  const packDir = path.join(
    pluginRoot,
    "artifacts",
    "vector-packs",
    ACTIVE_EMBEDDING_SPEC.id,
  )
  const snapshotDir = path.join(
    pluginRoot,
    "artifacts",
    "snapshots",
    ACTIVE_EMBEDDING_SPEC.id,
  )
  await fs.mkdir(packDir, { recursive: true })
  await fs.mkdir(snapshotDir, { recursive: true })

  const rowA = vectorRow({ key: "a", hash: "1", seed: 1 })
  const rowB = vectorRow({ key: "b", hash: "2", seed: 2 })
  assert.deepEqual(validateVectorPackCompaction({
    sourcePacks: [
      pack("source-pack-a", [rowA]),
      pack("source-pack-b", [rowB]),
    ],
    compactedPack: pack("compacted-pack", [rowA, rowB]),
  }), {
    equivalent: true,
    source_pack_count: 2,
    source_rows: 2,
    compacted_rows: 2,
    unique_chunk_keys: 2,
    duplicate_rows_removed: 0,
  })
  assert.throws(
    () => validateVectorPackCompaction({
      sourcePacks: [pack("source-pack-a", [rowA])],
      compactedPack: pack("broken-compacted-pack", []),
    }),
    /missing compacted row/u,
  )

  for (const file of [
    path.join(packDir, "source-pack-a.jsonl"),
    path.join(packDir, "source-pack-a.manifest.json"),
    path.join(packDir, "source-pack-a.sha256"),
    path.join(packDir, "source-pack-b.jsonl"),
    path.join(packDir, "source-pack-b.manifest.json"),
    path.join(packDir, "source-pack-b.sha256"),
    path.join(packDir, "compacted-pack.jsonl"),
    path.join(packDir, "compacted-pack.manifest.json"),
    path.join(packDir, "compacted-pack.sha256"),
  ]) {
    await fs.writeFile(file, `artifact bytes for ${path.basename(file)}`, "utf8")
  }

  const olderSnapshot = await writeSnapshotValidationFixture({
    pluginRoot,
    snapshotId: "snapshot-old",
    represented_documents: [],
  })
  const activeSnapshot = await writeSnapshotValidationFixture({
    pluginRoot,
    snapshotId: "snapshot-active",
    represented_documents: [],
  })
  await assert.doesNotReject(() => validateSnapshotArtifact({
    ...olderSnapshot,
    pluginRoot,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDbSchema: SNAPSHOT_DB_SCHEMA,
    expectedSqliteVec: SNAPSHOT_SQLITE_VEC,
    expectedRuntime: SNAPSHOT_RUNTIME,
    expectedArtifactSourceScopeHash: SNAPSHOT_SOURCE_SCOPE_HASH,
    expectedDocumentTreeHash: SNAPSHOT_DOCUMENT_TREE_HASH,
  }))
  await assert.doesNotReject(() => validateSnapshotArtifact({
    ...activeSnapshot,
    pluginRoot,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDbSchema: SNAPSHOT_DB_SCHEMA,
    expectedSqliteVec: SNAPSHOT_SQLITE_VEC,
    expectedRuntime: SNAPSHOT_RUNTIME,
    expectedArtifactSourceScopeHash: SNAPSHOT_SOURCE_SCOPE_HASH,
    expectedDocumentTreeHash: SNAPSHOT_DOCUMENT_TREE_HASH,
  }))

  const summary = await cleanupRotatedArtifacts({
    pluginRoot,
    embeddingSpecId: ACTIVE_EMBEDDING_SPEC.id,
    activeVectorPackIds: ["compacted-pack"],
    activeSnapshotIds: ["snapshot-active"],
  })
  assert.deepEqual(summary, {
    vector_packs_removed: 2,
    snapshots_removed: 1,
    sidecars_removed: 6,
  })
  await fs.stat(path.join(packDir, "compacted-pack.jsonl"))
  await fs.stat(path.join(packDir, "compacted-pack.manifest.json"))
  await fs.stat(path.join(packDir, "compacted-pack.sha256"))
  await fs.stat(path.join(snapshotDir, "snapshot-active.sqlite.zst"))
  await fs.stat(path.join(snapshotDir, "snapshot-active.manifest.json"))
  await fs.stat(path.join(snapshotDir, "snapshot-active.sha256"))
  for (const removed of [
    path.join(packDir, "source-pack-a.jsonl"),
    path.join(packDir, "source-pack-b.jsonl"),
    path.join(snapshotDir, "snapshot-old.sqlite.zst"),
  ]) {
    await assert.rejects(() => fs.stat(removed), /ENOENT/u)
  }
})

test("artifact rotation cleanup removes obsolete sidecars and keeps active artifacts", async () => {
  const {
    cleanupRotatedArtifacts,
  } = await loadTombstonesModule()
  const pluginRoot = await tmpRoot("desk-redaction-cleanup-plugin-")
  const packDir = path.join(
    pluginRoot,
    "artifacts",
    "vector-packs",
    ACTIVE_EMBEDDING_SPEC.id,
  )
  const snapshotDir = path.join(
    pluginRoot,
    "artifacts",
    "snapshots",
    ACTIVE_EMBEDDING_SPEC.id,
  )
  for (const dir of [packDir, snapshotDir]) {
    await fs.mkdir(dir, { recursive: true })
  }
  for (const file of [
    path.join(packDir, "obsolete-pack.jsonl"),
    path.join(packDir, "obsolete-pack.manifest.json"),
    path.join(packDir, "obsolete-pack.sha256"),
    path.join(packDir, "active-pack.jsonl"),
    path.join(packDir, "active-pack.manifest.json"),
    path.join(packDir, "active-pack.sha256"),
    path.join(snapshotDir, "obsolete-snapshot.sqlite.zst"),
    path.join(snapshotDir, "obsolete-snapshot.manifest.json"),
    path.join(snapshotDir, "obsolete-snapshot.sha256"),
    path.join(snapshotDir, "active-snapshot.sqlite.zst"),
    path.join(snapshotDir, "active-snapshot.manifest.json"),
    path.join(snapshotDir, "active-snapshot.sha256"),
  ]) {
    await fs.writeFile(file, `artifact bytes for ${path.basename(file)}`, "utf8")
  }
  const activeBefore = await fileHashes(pluginRoot)

  const summary = await cleanupRotatedArtifacts({
    pluginRoot,
    embeddingSpecId: ACTIVE_EMBEDDING_SPEC.id,
    activeVectorPackIds: ["active-pack"],
    activeSnapshotIds: ["active-snapshot"],
    artifact_rotation_id: "rotation-2026-06-15",
  })

  assert.deepEqual(summary, {
    vector_packs_removed: 1,
    snapshots_removed: 1,
    sidecars_removed: 4,
  })
  await assert.rejects(() => fs.stat(path.join(packDir, "obsolete-pack.jsonl")), /ENOENT/u)
  await assert.rejects(() => fs.stat(path.join(packDir, "obsolete-pack.manifest.json")), /ENOENT/u)
  await assert.rejects(() => fs.stat(path.join(packDir, "obsolete-pack.sha256")), /ENOENT/u)
  await assert.rejects(() => fs.stat(path.join(snapshotDir, "obsolete-snapshot.sqlite.zst")), /ENOENT/u)
  await assert.rejects(() => fs.stat(path.join(snapshotDir, "obsolete-snapshot.manifest.json")), /ENOENT/u)
  await assert.rejects(() => fs.stat(path.join(snapshotDir, "obsolete-snapshot.sha256")), /ENOENT/u)
  await fs.stat(path.join(packDir, "active-pack.jsonl"))
  await fs.stat(path.join(packDir, "active-pack.manifest.json"))
  await fs.stat(path.join(packDir, "active-pack.sha256"))
  await fs.stat(path.join(snapshotDir, "active-snapshot.sqlite.zst"))
  await fs.stat(path.join(snapshotDir, "active-snapshot.manifest.json"))
  await fs.stat(path.join(snapshotDir, "active-snapshot.sha256"))
  const activeAfter = await fileHashes(pluginRoot)
  for (const rel of [
    `artifacts/vector-packs/${ACTIVE_EMBEDDING_SPEC.id}/active-pack.jsonl`,
    `artifacts/vector-packs/${ACTIVE_EMBEDDING_SPEC.id}/active-pack.manifest.json`,
    `artifacts/vector-packs/${ACTIVE_EMBEDDING_SPEC.id}/active-pack.sha256`,
    `artifacts/snapshots/${ACTIVE_EMBEDDING_SPEC.id}/active-snapshot.sqlite.zst`,
    `artifacts/snapshots/${ACTIVE_EMBEDDING_SPEC.id}/active-snapshot.manifest.json`,
    `artifacts/snapshots/${ACTIVE_EMBEDDING_SPEC.id}/active-snapshot.sha256`,
  ]) {
    assert.equal(activeAfter[rel], activeBefore[rel])
  }
})
