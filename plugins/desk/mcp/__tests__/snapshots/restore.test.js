// Unit 16a: red contract for selecting and restoring committed snapshots.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { zstdCompressSync } from "node:zlib"

import manifestContracts from "../../src/artifacts/manifest-contracts.cjs"
import { indexDbPath } from "../../src/db/init.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"

const mcpRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))
const { ARTIFACT_SOURCE_PATHS } = manifestContracts
const SOURCE_SCOPE_HASH = `sha256:${"a".repeat(64)}`
const DOCUMENT_TREE_HASH = `sha256:${"b".repeat(64)}`
const DB_SCHEMA = { id: "desk-index-sqlite-v1", version: 1 }
const SQLITE_VEC = { package: "sqlite-vec", version: "0.1.6", table: "vec0" }
const RUNTIME = { platform: "darwin", arch: "arm64", node_abi: "node-127" }

async function loadRestoreModule() {
  return import(pathToFileURL(path.join(mcpRoot, "src", "snapshots", "restore.js")))
}

async function tmpRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function expectedContext(overrides = {}) {
  return {
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedDbSchema: DB_SCHEMA,
    expectedSqliteVec: SQLITE_VEC,
    expectedRuntime: RUNTIME,
    expectedArtifactSourceScopeHash: SOURCE_SCOPE_HASH,
    expectedDocumentTreeHash: DOCUMENT_TREE_HASH,
    ...overrides,
  }
}

function validManifest({
  artifactSha,
  snapshotId,
  createdAt,
  embeddingSpecId = ACTIVE_EMBEDDING_SPEC.id,
  dimension = ACTIVE_EMBEDDING_SPEC.dimension,
} = {}) {
  return {
    schema_version: 1,
    snapshot_id: snapshotId,
    embedding_spec_id: embeddingSpecId,
    dimension,
    chunker_id: ACTIVE_EMBEDDING_SPEC.chunker_id,
    normalization_id: ACTIVE_EMBEDDING_SPEC.normalization_id,
    db_schema: DB_SCHEMA,
    sqlite_vec: SQLITE_VEC,
    runtime: RUNTIME,
    artifact_source_scope_hash: SOURCE_SCOPE_HASH,
    document_tree_hash: DOCUMENT_TREE_HASH,
    discovery_grammar_version: 2,
    represented_documents: [],
    included_pack_ids: ["desk-base-pack"],
    created_at: createdAt,
    artifact: {
      file: `${snapshotId}.sqlite.zst`,
      format: "sqlite-zstd",
      sha256: artifactSha,
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

async function writeSnapshot({
  pluginRoot,
  snapshotId,
  createdAt,
  sqliteBytes = Buffer.from(`sqlite:${snapshotId}`, "utf8"),
  embeddingSpecId = ACTIVE_EMBEDDING_SPEC.id,
  manifest = {},
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
  const artifactBytes = zstdCompressSync(sqliteBytes)
  const artifactSha = `sha256:${sha256(artifactBytes)}`
  const snapshotManifest = {
    ...validManifest({
      artifactSha,
      snapshotId,
      createdAt,
      embeddingSpecId,
      dimension:
        embeddingSpecId === ACTIVE_EMBEDDING_SPEC.id
          ? ACTIVE_EMBEDDING_SPEC.dimension
          : 384,
    }),
    ...manifest,
  }

  await fs.writeFile(snapshotPath, artifactBytes)
  await fs.writeFile(manifestPath, `${JSON.stringify(snapshotManifest, null, 2)}\n`, "utf8")
  await fs.writeFile(checksumPath, `${artifactSha}  ${snapshotId}.sqlite.zst\n`, "utf8")

  return {
    snapshotDir,
    snapshotPath,
    manifestPath,
    checksumPath,
    sqliteBytes,
    artifactBytes,
    manifest: snapshotManifest,
  }
}

async function fingerprint(paths) {
  const entries = []
  for (const targetPath of paths) {
    const stat = await fs.stat(targetPath)
    const bytes = await fs.readFile(targetPath)
    entries.push({
      path: targetPath,
      mode: stat.mode & 0o777,
      mtime: stat.mtime.toISOString(),
      size: stat.size,
      sha256: sha256(bytes),
    })
  }
  return entries
}

async function setSnapshotMtime(snapshot, timestamp) {
  await Promise.all([
    fs.utimes(snapshot.snapshotPath, timestamp, timestamp),
    fs.utimes(snapshot.manifestPath, timestamp, timestamp),
    fs.utimes(snapshot.checksumPath, timestamp, timestamp),
  ])
}

function artifactPaths(...snapshots) {
  return snapshots.flatMap((snapshot) => [
    snapshot.snapshotPath,
    snapshot.manifestPath,
    snapshot.checksumPath,
  ])
}

test("selectNewestCompatibleSnapshot chooses newest active-spec snapshot and ignores inactive specs", async () => {
  const { discoverSnapshotArtifacts, selectNewestCompatibleSnapshot } = await loadRestoreModule()
  const pluginRoot = await tmpRoot("desk-snapshot-restore-plugin-")
  const activeNewer = await writeSnapshot({
    pluginRoot,
    snapshotId: "m-active-newer",
    createdAt: "2026-06-15T01:00:00.000Z",
  })
  const invalidRuntime = await writeSnapshot({
    pluginRoot,
    snapshotId: "active-invalid-runtime",
    createdAt: "2026-06-15T03:00:00.000Z",
    manifest: { runtime: { ...RUNTIME, arch: "x64" } },
  })
  const invalidChecksum = await writeSnapshot({
    pluginRoot,
    snapshotId: "active-invalid-checksum",
    createdAt: "2026-06-15T02:30:00.000Z",
  })
  await fs.writeFile(
    invalidChecksum.checksumPath,
    `${"0".repeat(64)}  active-invalid-checksum.sqlite.zst\n`,
    "utf8",
  )
  await writeSnapshot({
    pluginRoot,
    snapshotId: "inactive-newest",
    createdAt: "2026-06-15T02:00:00.000Z",
    embeddingSpecId: "inactive-spec-v1",
  })
  const activeOlder = await writeSnapshot({
    pluginRoot,
    snapshotId: "a-active-older",
    createdAt: "2026-06-15T00:00:00.000Z",
  })
  const activeNewestNameOnly = await writeSnapshot({
    pluginRoot,
    snapshotId: "z-active-name-only",
    createdAt: "2026-06-14T23:00:00.000Z",
  })
  await setSnapshotMtime(activeNewer, new Date("2026-06-15T00:00:00.000Z"))
  await setSnapshotMtime(invalidRuntime, new Date("2026-06-15T03:00:00.000Z"))
  await setSnapshotMtime(activeOlder, new Date("2026-06-15T04:00:00.000Z"))
  await setSnapshotMtime(activeNewestNameOnly, new Date("2026-06-15T05:00:00.000Z"))

  const discovered = await discoverSnapshotArtifacts({
    pluginRoot,
    ...expectedContext(),
  })
  const selected = selectNewestCompatibleSnapshot(discovered)
  const ignoredById = new Map(
    discovered.ignored.map((candidate) => [candidate.snapshot_id, candidate.reason]),
  )

  assert.deepEqual(
    new Set(discovered.compatible.map((candidate) => candidate.snapshot_id)),
    new Set(["a-active-older", "m-active-newer", "z-active-name-only"]),
  )
  assert.equal(ignoredById.get("inactive-newest"), "inactive_embedding_spec")
  assert.equal(ignoredById.get("active-invalid-runtime"), "incompatible_manifest")
  assert.equal(ignoredById.get("active-invalid-checksum"), "incompatible_manifest")
  assert.equal(selected.snapshot_id, "m-active-newer")
  assert.equal(selected.manifest.created_at, "2026-06-15T01:00:00.000Z")
})

test("selectNewestCompatibleSnapshot returns null for no compatible snapshots and ties by snapshot id", async () => {
  const { discoverSnapshotArtifacts, selectNewestCompatibleSnapshot } = await loadRestoreModule()
  const missingPluginRoot = await tmpRoot("desk-snapshot-restore-missing-plugin-")
  const incompatiblePluginRoot = await tmpRoot("desk-snapshot-restore-incompatible-plugin-")
  const tiedPluginRoot = await tmpRoot("desk-snapshot-restore-tied-plugin-")
  await writeSnapshot({
    pluginRoot: incompatiblePluginRoot,
    snapshotId: "inactive-only",
    createdAt: "2026-06-15T00:00:00.000Z",
    embeddingSpecId: "inactive-spec-v1",
  })
  await writeSnapshot({
    pluginRoot: tiedPluginRoot,
    snapshotId: "b-tied",
    createdAt: "2026-06-15T00:00:00.000Z",
  })
  await writeSnapshot({
    pluginRoot: tiedPluginRoot,
    snapshotId: "a-tied",
    createdAt: "2026-06-15T00:00:00.000Z",
  })

  assert.equal(
    selectNewestCompatibleSnapshot(await discoverSnapshotArtifacts({
      pluginRoot: missingPluginRoot,
      ...expectedContext(),
    })),
    null,
  )
  assert.equal(selectNewestCompatibleSnapshot({}), null)
  assert.equal(
    selectNewestCompatibleSnapshot(await discoverSnapshotArtifacts({
      pluginRoot: incompatiblePluginRoot,
      ...expectedContext(),
    })),
    null,
  )
  assert.equal(
    selectNewestCompatibleSnapshot(await discoverSnapshotArtifacts({
      pluginRoot: tiedPluginRoot,
      ...expectedContext(),
    })).snapshot_id,
    "a-tied",
  )
})

test("discoverSnapshotArtifacts ignores non-directory entries and rejects invalid snapshot roots", async () => {
  const { discoverSnapshotArtifacts } = await loadRestoreModule()
  const pluginRoot = await tmpRoot("desk-snapshot-restore-plugin-")
  const badPluginRoot = await tmpRoot("desk-snapshot-restore-bad-plugin-")
  const snapshotsRoot = path.join(pluginRoot, "artifacts", "snapshots")
  await fs.mkdir(snapshotsRoot, { recursive: true })
  await fs.writeFile(path.join(snapshotsRoot, "README.md"), "not a spec directory\n", "utf8")
  await writeSnapshot({
    pluginRoot,
    snapshotId: "active-only",
    createdAt: "2026-06-15T00:00:00.000Z",
  })
  await fs.mkdir(path.join(badPluginRoot, "artifacts"), { recursive: true })
  await fs.writeFile(path.join(badPluginRoot, "artifacts", "snapshots"), "not a directory\n", "utf8")

  const discovered = await discoverSnapshotArtifacts({
    pluginRoot,
    ...expectedContext(),
  })
  assert.deepEqual(
    discovered.compatible.map((candidate) => candidate.snapshot_id),
    ["active-only"],
  )
  await assert.rejects(
    () => discoverSnapshotArtifacts({
      pluginRoot: badPluginRoot,
      ...expectedContext(),
    }),
    (error) => error?.code === "ENOTDIR",
  )
})

test("restoreSnapshotToState copies decompressed bytes into desk state without mutating repo artifacts", async () => {
  const { restoreSnapshotToState } = await loadRestoreModule()
  const pluginRoot = await tmpRoot("desk-snapshot-restore-plugin-")
  const deskRoot = await tmpRoot("desk-snapshot-restore-desk-")
  const newer = await writeSnapshot({
    pluginRoot,
    snapshotId: "m-active-newer",
    createdAt: "2026-06-15T01:00:00.000Z",
    sqliteBytes: Buffer.from("newer sqlite bytes", "utf8"),
  })
  const invalidNewest = await writeSnapshot({
    pluginRoot,
    snapshotId: "active-invalid-newest",
    createdAt: "2026-06-15T02:00:00.000Z",
    sqliteBytes: Buffer.from("invalid newest sqlite bytes", "utf8"),
    manifest: { sqlite_vec: { ...SQLITE_VEC, version: "9.9.9" } },
  })
  const older = await writeSnapshot({
    pluginRoot,
    snapshotId: "a-active-older",
    createdAt: "2026-06-15T00:00:00.000Z",
    sqliteBytes: Buffer.from("older sqlite bytes", "utf8"),
  })
  const newestNameOnly = await writeSnapshot({
    pluginRoot,
    snapshotId: "z-active-name-only",
    createdAt: "2026-06-14T23:00:00.000Z",
    sqliteBytes: Buffer.from("name-only sqlite bytes", "utf8"),
  })
  await setSnapshotMtime(newer, new Date("2026-06-15T00:00:00.000Z"))
  await setSnapshotMtime(invalidNewest, new Date("2026-06-15T03:00:00.000Z"))
  await setSnapshotMtime(older, new Date("2026-06-15T04:00:00.000Z"))
  await setSnapshotMtime(newestNameOnly, new Date("2026-06-15T05:00:00.000Z"))
  const repoArtifactPaths = artifactPaths(older, invalidNewest, newestNameOnly, newer)
  await Promise.all(repoArtifactPaths.map((targetPath) => fs.chmod(targetPath, 0o444)))
  const before = await fingerprint(repoArtifactPaths)

  const result = await restoreSnapshotToState({
    pluginRoot,
    deskRoot,
    ...expectedContext(),
  })

  assert.equal(result.restored, true)
  assert.equal(result.reason, "snapshot_restored")
  assert.equal(result.snapshot_id, "m-active-newer")
  assert.equal(result.state_db_path, indexDbPath(deskRoot))
  assert.deepEqual(await fs.readFile(indexDbPath(deskRoot)), newer.sqliteBytes)
  assert.deepEqual(await fingerprint(repoArtifactPaths), before)
})

test("restoreSnapshotToState repairs corrupt metadata and missing state DB markers", async () => {
  const { restoreSnapshotToState } = await loadRestoreModule()
  const pluginRoot = await tmpRoot("desk-snapshot-restore-plugin-")
  const deskRoot = await tmpRoot("desk-snapshot-restore-desk-")
  const snapshot = await writeSnapshot({
    pluginRoot,
    snapshotId: "active-only",
    createdAt: "2026-06-15T00:00:00.000Z",
    sqliteBytes: Buffer.from("repair sqlite bytes", "utf8"),
  })
  const statePath = indexDbPath(deskRoot)
  const stateMetaPath = `${statePath}.snapshot.json`

  assert.equal((await restoreSnapshotToState({
    pluginRoot,
    deskRoot,
    ...expectedContext(),
  })).restored, true)

  await fs.writeFile(stateMetaPath, "{not-json", "utf8")
  assert.equal((await restoreSnapshotToState({
    pluginRoot,
    deskRoot,
    ...expectedContext(),
  })).restored, true)
  assert.deepEqual(await fs.readFile(statePath), snapshot.sqliteBytes)

  await fs.rm(statePath)
  assert.equal((await restoreSnapshotToState({
    pluginRoot,
    deskRoot,
    ...expectedContext(),
  })).restored, true)
  assert.deepEqual(await fs.readFile(statePath), snapshot.sqliteBytes)

  await fs.writeFile(statePath, "tampered sqlite bytes", "utf8")
  assert.equal((await restoreSnapshotToState({
    pluginRoot,
    deskRoot,
    ...expectedContext(),
  })).restored, true)
  assert.deepEqual(await fs.readFile(statePath), snapshot.sqliteBytes)
})

test("restoreSnapshotToState treats corrupt compressed snapshots as cache misses", async () => {
  const { restoreSnapshotToState } = await loadRestoreModule()
  const pluginRoot = await tmpRoot("desk-snapshot-restore-plugin-")
  const deskRoot = await tmpRoot("desk-snapshot-restore-desk-")
  const snapshot = await writeSnapshot({
    pluginRoot,
    snapshotId: "active-corrupt",
    createdAt: "2026-06-15T00:00:00.000Z",
  })
  const corruptBytes = Buffer.from("not zstd data", "utf8")
  const corruptSha = `sha256:${sha256(corruptBytes)}`
  const corruptManifest = {
    ...snapshot.manifest,
    artifact: {
      ...snapshot.manifest.artifact,
      sha256: corruptSha,
    },
  }
  await fs.writeFile(snapshot.snapshotPath, corruptBytes)
  await fs.writeFile(snapshot.manifestPath, `${JSON.stringify(corruptManifest, null, 2)}\n`, "utf8")
  await fs.writeFile(snapshot.checksumPath, `${corruptSha}  active-corrupt.sqlite.zst\n`, "utf8")

  const result = await restoreSnapshotToState({
    pluginRoot,
    deskRoot,
    ...expectedContext(),
  })

  assert.equal(result.restored, false)
  assert.equal(result.reason, "snapshot_corrupt")
  assert.equal(result.snapshot_id, "active-corrupt")
  await assert.rejects(() => fs.stat(indexDbPath(deskRoot)), /ENOENT/u)
})

test("snapshot restoration stays importable when the runtime has no zstd codec", async () => {
  const source = await fs.readFile(
    path.join(mcpRoot, "src", "snapshots", "restore.js"),
    "utf8",
  )
  assert.match(source, /import \* as zlib from "node:zlib"/u)
  assert.doesNotMatch(source, /import \{[^}]*zstdDecompressSync[^}]*\} from "node:zlib"/u)

  const { decompressSnapshotBytes } = await loadRestoreModule()
  assert.deepEqual(
    decompressSnapshotBytes(Buffer.from("snapshot", "utf8"), {}),
    {
      bytes: null,
      reason: "snapshot_codec_unavailable",
    },
  )
})

test("restoreSnapshotToState surfaces unwritable state paths", async () => {
  const { restoreSnapshotToState } = await loadRestoreModule()
  const pluginRoot = await tmpRoot("desk-snapshot-restore-plugin-")
  const deskRoot = await tmpRoot("desk-snapshot-restore-desk-")
  await writeSnapshot({
    pluginRoot,
    snapshotId: "active-only",
    createdAt: "2026-06-15T00:00:00.000Z",
  })
  await fs.mkdir(indexDbPath(deskRoot), { recursive: true })

  await assert.rejects(
    () => restoreSnapshotToState({
      pluginRoot,
      deskRoot,
      ...expectedContext(),
    }),
    (error) => error?.code === "EISDIR" || error?.code === "ENOTDIR",
  )
})

test("restoreSnapshotToState reports cache miss when no compatible snapshot exists", async () => {
  const { restoreSnapshotToState } = await loadRestoreModule()
  const pluginRoot = await tmpRoot("desk-snapshot-restore-plugin-")
  const deskRoot = await tmpRoot("desk-snapshot-restore-desk-")

  assert.deepEqual(
    await restoreSnapshotToState({
      pluginRoot,
      deskRoot,
      ...expectedContext(),
    }),
    { restored: false, reason: "no_compatible_snapshot" },
  )
  await assert.rejects(
    () => restoreSnapshotToState({
      pluginRoot,
      deskRoot: "",
      ...expectedContext(),
    }),
    /deskRoot is required/u,
  )
  await assert.rejects(
    () => restoreSnapshotToState({
      pluginRoot: "",
      deskRoot,
      ...expectedContext(),
    }),
    /pluginRoot is required/u,
  )
})

test("restoreSnapshotToState is idempotent for repeated compatible restores", async () => {
  const { restoreSnapshotToState } = await loadRestoreModule()
  const pluginRoot = await tmpRoot("desk-snapshot-restore-plugin-")
  const deskRoot = await tmpRoot("desk-snapshot-restore-desk-")
  const snapshot = await writeSnapshot({
    pluginRoot,
    snapshotId: "active-only",
    createdAt: "2026-06-15T00:00:00.000Z",
    sqliteBytes: Buffer.from("idempotent sqlite bytes", "utf8"),
  })

  const first = await restoreSnapshotToState({
    pluginRoot,
    deskRoot,
    ...expectedContext(),
  })
  const statePath = indexDbPath(deskRoot)
  const sentinel = new Date("2001-02-03T04:05:06.000Z")
  await fs.utimes(statePath, sentinel, sentinel)
  const firstStateStat = await fs.stat(statePath)
  const second = await restoreSnapshotToState({
    pluginRoot,
    deskRoot,
    ...expectedContext(),
  })
  const secondStateStat = await fs.stat(statePath)

  assert.equal(first.restored, true)
  assert.equal(second.restored, false)
  assert.equal(second.reason, "snapshot_already_restored")
  assert.equal(second.snapshot_id, "active-only")
  assert.equal(secondStateStat.mtime.getTime(), firstStateStat.mtime.getTime())
  assert.deepEqual(await fs.readFile(statePath), snapshot.sqliteBytes)
})
