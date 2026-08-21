// Unit 24a1: red integration contract for production snapshot cold start.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { closeDb, indexDbPath, openDb } from "../../src/db/init.js"
import { EMBEDDING_DIM } from "../../src/indexer/embed.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"
import { configureRuntimeArtifacts, ensureIndex } from "../../src/server-helpers.js"
import { desk_search } from "../../src/tools/search.js"
import { desk_thread } from "../../src/tools/thread.js"

const require = createRequire(import.meta.url)
const packageLock = require("../../package-lock.json")
const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const pluginRoot = path.join(repoRoot, "plugins", "desk")
const productionDocPath = "tasks/dependency-activation/task.md"
const productionSnapshotRoot = path.join(
  pluginRoot,
  "artifacts",
  "snapshots",
  ACTIVE_EMBEDDING_SPEC.id,
)
const expectedRuntime = {
  platform: "portable",
  arch: "portable",
  node_abi: "portable",
}
const expectedSqliteVec = {
  package: "sqlite-vec",
  version: packageLock.packages["node_modules/sqlite-vec"].version,
  table: "vec0",
}
const expectedDbSchema = { id: "desk-index-sqlite-v1", version: 1 }

async function tmpRoot(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

async function copyProductionDeskDoc(deskRoot) {
  const target = path.join(deskRoot, productionDocPath)
  await mkdir(path.dirname(target), { recursive: true })
  await copyFile(path.join(repoRoot, "desk", productionDocPath), target)
}

async function writeDeskDoc(deskRoot, relativePath, body) {
  const target = path.join(deskRoot, relativePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, body, "utf8")
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

async function findCompatibleProductionSnapshot() {
  let dirents
  try {
    dirents = await readdir(productionSnapshotRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
  const manifests = []
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith(".manifest.json")) continue
    const manifestPath = path.join(productionSnapshotRoot, dirent.name)
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    if (
      manifest.embedding_spec_id === ACTIVE_EMBEDDING_SPEC.id &&
      stableStringify(manifest.db_schema) === stableStringify(expectedDbSchema) &&
      stableStringify(manifest.sqlite_vec) === stableStringify(expectedSqliteVec) &&
      stableStringify(manifest.runtime) === stableStringify(expectedRuntime)
    ) {
      manifests.push({ manifest, manifestPath })
    }
  }
  manifests.sort((left, right) => (
    Date.parse(right.manifest.created_at) - Date.parse(left.manifest.created_at) ||
    left.manifest.snapshot_id.localeCompare(right.manifest.snapshot_id)
  ))
  return manifests[0] ?? null
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

test("cold start restores the committed production snapshot without rebuild or embeddings", async () => {
  const tempRoot = await tmpRoot("desk-dependency-flow-snapshot-")
  try {
    const deskRoot = path.join(tempRoot, "desk")
    await copyProductionDeskDoc(deskRoot)
    const productionSnapshot = await findCompatibleProductionSnapshot()
    assert.notEqual(
      productionSnapshot,
      null,
      `expected at least one committed production snapshot compatible with ${stableStringify({
        db_schema: expectedDbSchema,
        runtime: expectedRuntime,
        sqlite_vec: expectedSqliteVec,
      })}`,
    )
    const { manifest: productionManifest } = productionSnapshot
    const productionDocBytes = await readFile(path.join(deskRoot, productionDocPath))

    assert.deepEqual(
      productionManifest.represented_documents,
      [{ path: productionDocPath, hash: sha256(productionDocBytes) }],
      "the integration fixture must use the real committed production snapshot inputs",
    )

    const result = await ensureIndex(deskRoot, {
      startup: true,
      embed: {
        fetch: async () => {
          throw new Error("cold-start production snapshot restore must not call live embeddings")
        },
      },
    })

    assert.equal(result.built, false, JSON.stringify(result, null, 2))
    assert.equal(result.reason, "snapshot_restored")
    assert.equal(result.snapshot?.snapshot_id, productionManifest.snapshot_id)
    assert.equal(result.snapshot?.freshness?.artifact_source_scope, "fresh")
    assert.equal(result.snapshot?.freshness?.document_tree, "fresh")
    assert.equal(result.fallback, undefined)

    const stateMeta = JSON.parse(
      await readFile(`${indexDbPath(deskRoot)}.snapshot.json`, "utf8"),
    )
    assert.equal(stateMeta.snapshot_id, productionManifest.snapshot_id)
    assert.equal(
      stateMeta.source_snapshot_path,
      path.posix.join(
        "artifacts",
        "snapshots",
        ACTIVE_EMBEDDING_SPEC.id,
        `${productionManifest.snapshot_id}.sqlite.zst`,
      ),
    )

    const db = openDb(deskRoot)
    try {
      assert.deepEqual(
        db.prepare("SELECT path FROM docs ORDER BY path").all(),
        [{ path: productionDocPath }],
      )
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunks").get().n, 2)
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunk_vecs").get().n, 2)
    } finally {
      closeDb(db)
    }

    const repeated = await ensureIndex(deskRoot, {
      startup: true,
      embed: {
        fetch: async () => {
          throw new Error("repeated production snapshot startup must not call live embeddings")
        },
      },
    })

    assert.equal(repeated.built, false, JSON.stringify(repeated, null, 2))
    assert.equal(repeated.reason, "fresh")
    assert.equal(repeated.fallback, undefined)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test("cold rebuild imports committed production vector packs without embeddings", async () => {
  const tempRoot = await tmpRoot("desk-dependency-flow-vector-pack-")
  try {
    const deskRoot = path.join(tempRoot, "desk")
    await copyProductionDeskDoc(deskRoot)
    let embeddingCalls = 0

    const result = await ensureIndex(deskRoot, {
      startup: true,
      snapshots: false,
      embed: {
        fetch: async () => {
          embeddingCalls += 1
          throw new Error("production vector-pack rebuild must not call live embeddings")
        },
      },
    })

    assert.equal(embeddingCalls, 0)
    assert.equal(result.built, true, JSON.stringify(result, null, 2))
    assert.equal(result.reason, "missing")
    assert.equal(result.fallback, "vector_packs")
    assert.equal(result.vector_packs?.import_state, "used_as_fallback")
    assert.equal(result.vector_packs?.packs_imported, 1)
    assert.equal(result.vector_packs?.rows_imported, 2)
    assert.equal(result.semantic?.missing_vectors, 0)

    const db = openDb(deskRoot)
    try {
      assert.deepEqual(
        db.prepare("SELECT path FROM docs ORDER BY path").all(),
        [{ path: productionDocPath }],
      )
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunks").get().n, 2)
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunk_vecs").get().n, 2)
    } finally {
      closeDb(db)
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test("cold rebuild rejects packs whose represented document changed and live-generates all vectors", async () => {
  const tempRoot = await tmpRoot("desk-dependency-flow-missing-vector-")
  try {
    const deskRoot = path.join(tempRoot, "desk")
    await copyProductionDeskDoc(deskRoot)
    const missingChunk = [
      "## Unit 24a3 Missing Vector",
      "",
      "This integration paragraph is intentionally absent from the committed production vector pack so live embedding generation must cover exactly this new chunk.",
    ].join("\n")
    await appendFile(path.join(deskRoot, productionDocPath), `\n\n${missingChunk}\n`)

    const embeddingRequests = []
    const result = await ensureIndex(deskRoot, {
      startup: true,
      snapshots: false,
      embed: {
        endpoint: "http://127.0.0.1:9/api/embeddings",
        model: "unit-24a3-production-missing-vector",
        fetch: async (url, request) => {
          embeddingRequests.push({
            url,
            body: JSON.parse(request.body),
          })
          return {
            ok: true,
            json: async () => ({
              embedding: Array.from({ length: EMBEDDING_DIM }, (_, index) =>
                index / EMBEDDING_DIM,
              ),
            }),
          }
        },
      },
    })

    assert.equal(result.built, true, JSON.stringify(result, null, 2))
    assert.equal(result.reason, "missing")
    assert.equal(result.fallback, undefined)
    assert.equal(result.vector_packs?.import_state, "absent")
    assert.equal(result.vector_packs?.packs_imported, 0)
    assert.equal(result.vector_packs?.rows_imported, 0)
    assert.equal(result.semantic?.chunks_total, 3)
    assert.equal(result.semantic?.vectors_indexed, 3)
    assert.equal(result.semantic?.missing_vectors, 0)

    assert.equal(embeddingRequests.length, 3)
    assert.ok(
      embeddingRequests.every((request) =>
        request.url === "http://127.0.0.1:9/api/embeddings" &&
        request.body.model === "unit-24a3-production-missing-vector"
      ),
    )
    assert.ok(
      embeddingRequests.some((request) => request.body.prompt === missingChunk),
    )

    const db = openDb(deskRoot)
    try {
      assert.deepEqual(
        db.prepare("SELECT path FROM docs ORDER BY path").all(),
        [{ path: productionDocPath }],
      )
      assert.deepEqual(
        db.prepare("SELECT chunk_index, heading FROM chunks ORDER BY chunk_index").all(),
        [
          { chunk_index: 0, heading: null },
          { chunk_index: 1, heading: null },
          { chunk_index: 2, heading: "Unit 24a3 Missing Vector" },
        ],
      )
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunk_vecs").get().n, 3)
    } finally {
      closeDb(db)
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test("cold rebuild preserves active archive scope and refs graph with production vector packs", async () => {
  const tempRoot = await tmpRoot("desk-dependency-flow-scope-refs-")
  try {
    const deskRoot = path.join(tempRoot, "desk")
    await copyProductionDeskDoc(deskRoot)
    await writeDeskDoc(
      deskRoot,
      "tasks/scope-active/task.md",
      "---\nstatus: processing\nschema_version: 1\nupdated: 2026-06-16\n---\nunit24scope active visible content\n",
    )
    await writeDeskDoc(
      deskRoot,
      "tasks/scope-active/planning.md",
      "---\nschema_version: 1\nupdated: 2026-06-15\n---\nunit24scope active planning content\n",
    )
    await writeDeskDoc(
      deskRoot,
      "tasks/scope-active/doing.md",
      "---\nschema_version: 1\nupdated: 2026-06-16\n---\nunit24scope active doing content\n",
    )
    await writeDeskDoc(
      deskRoot,
      "tasks/_archive/scope-old/task.md",
      "---\nstatus: done\nschema_version: 1\nupdated: 2026-06-14\n---\nunit24scope archived historical content\n",
    )

    const embed = {
      endpoint: "http://127.0.0.1:9/api/embeddings",
      fetch: async () => ({
        ok: true,
        json: async () => ({
          embedding: Array.from({ length: EMBEDDING_DIM }, (_, index) =>
            (index % 7) / 7,
          ),
        }),
      }),
    }
    const result = await ensureIndex(deskRoot, {
      startup: true,
      snapshots: false,
      embed,
    })

    assert.equal(result.built, true, JSON.stringify(result, null, 2))
    assert.equal(result.reason, "missing")
    assert.equal(result.fallback, "vector_packs")
    assert.equal(result.vector_packs?.rows_imported, 2)
    assert.equal(result.semantic?.chunks_total, 6)
    assert.equal(result.semantic?.vectors_indexed, 6)
    assert.equal(result.semantic?.missing_vectors, 0)

    const active = await desk_search({
      deskRoot,
      input: { query: "unit24scope" },
      opts: { embed },
    })
    assert.equal(active.search_mode, "hybrid")
    assert.ok(active.results.length >= 1)
    assert.ok(
      active.results.every((resultRow) => !resultRow.path.includes("_archive")),
      JSON.stringify(active.results, null, 2),
    )

    const all = await desk_search({
      deskRoot,
      input: { query: "unit24scope", scope: "all" },
      opts: { embed },
    })
    assert.equal(all.search_mode, "hybrid")
    assert.ok(
      all.results.some((resultRow) =>
        resultRow.path === "tasks/_archive/scope-old/task.md"
      ),
      JSON.stringify(all.results, null, 2),
    )

    const thread = await desk_thread({
      deskRoot,
      input: {
        start_path: "tasks/scope-active/planning.md",
        direction: "both",
        depth: 2,
      },
    })
    assert.deepEqual(
      thread.chain.map((row) => ({
        path: row.path,
        ref_kind: row.ref_kind,
        hop_distance: row.hop_distance,
      })),
      [
        {
          path: "tasks/scope-active/planning.md",
          ref_kind: null,
          hop_distance: 0,
        },
        {
          path: "tasks/scope-active/task.md",
          ref_kind: "planning_of",
          hop_distance: 1,
        },
        {
          path: "tasks/scope-active/doing.md",
          ref_kind: "doing_of",
          hop_distance: 2,
        },
      ],
    )

    const db = openDb(deskRoot)
    try {
      assert.deepEqual(
        db.prepare("SELECT path, is_archived FROM docs ORDER BY path").all(),
        [
          { path: "tasks/_archive/scope-old/task.md", is_archived: 1 },
          { path: productionDocPath, is_archived: 0 },
          { path: "tasks/scope-active/doing.md", is_archived: 0 },
          { path: "tasks/scope-active/planning.md", is_archived: 0 },
          { path: "tasks/scope-active/task.md", is_archived: 0 },
        ],
      )
      assert.deepEqual(
        db.prepare(
          `SELECT src.path AS src, dst.path AS dst, refs.ref_kind
           FROM refs_graph refs
           JOIN docs src ON src.id = refs.src_doc_id
           JOIN docs dst ON dst.id = refs.dst_doc_id
           ORDER BY src.path, dst.path, refs.ref_kind`,
        ).all(),
        [
          {
            src: "tasks/scope-active/doing.md",
            dst: "tasks/scope-active/task.md",
            ref_kind: "doing_of",
          },
          {
            src: "tasks/scope-active/planning.md",
            dst: "tasks/scope-active/task.md",
            ref_kind: "planning_of",
          },
        ],
      )
    } finally {
      closeDb(db)
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test("cold rebuild remains fresh and searchable in degraded lexical mode", async () => {
  const tempRoot = await tmpRoot("desk-dependency-flow-degraded-")
  try {
    const deskRoot = path.join(tempRoot, "desk")
    const emptyPluginRoot = path.join(tempRoot, "empty-plugin")
    await copyProductionDeskDoc(deskRoot)
    await mkdir(emptyPluginRoot, { recursive: true })

    let embeddingCalls = 0
    const embed = {
      endpoint: "http://127.0.0.1:9/api/embeddings",
      fetch: async () => {
        embeddingCalls += 1
        throw new Error("degraded lexical integration test keeps embeddings offline")
      },
    }

    configureRuntimeArtifacts({ pluginRoot: emptyPluginRoot })
    try {
      const first = await ensureIndex(deskRoot, { startup: true, embed })
      assert.equal(first.built, true, JSON.stringify(first, null, 2))
      assert.equal(first.reason, "missing")
      assert.equal(first.fallback, undefined)
      assert.equal(first.summary?.docs_indexed, 1)
      assert.equal(first.summary?.chunks_inserted, 2)
      assert.equal(first.summary?.semantic_warnings, 1)
      assert.equal(first.semantic?.chunks_total, 2)
      assert.equal(first.semantic?.vectors_indexed, 0)
      assert.equal(first.semantic?.missing_vectors, 2)
      assert.equal(first.semantic?.embedding_available, false)
      assert.equal(
        first.semantic?.embedding_diagnostic?.reason,
        "embedding_generation_failed",
      )
      assert.equal(embeddingCalls, 1)

      const second = await ensureIndex(deskRoot, { startup: true, embed })
      assert.equal(second.built, false, JSON.stringify(second, null, 2))
      assert.equal(second.reason, "fresh")
      assert.equal(second.semantic?.chunks_total, 2)
      assert.equal(second.semantic?.vectors_indexed, 0)
      assert.equal(second.semantic?.missing_vectors, 2)
      assert.equal(second.semantic?.embedding_available, false)
      assert.equal(second.semantic?.embedding_diagnostic?.reason, "network_error")
      assert.equal(embeddingCalls, 2)

      const search = await desk_search({
        deskRoot,
        input: { query: "Desk" },
        opts: { embed },
      })
      assert.equal(search.search_mode, "lexical")
      assert.equal(search.semantic_unavailable, true)
      assert.ok(
        search.results.some((resultRow) => resultRow.path === productionDocPath),
        JSON.stringify(search.results, null, 2),
      )
      const productionResult = search.results.find((resultRow) =>
        resultRow.path === productionDocPath
      )
      assert.equal(productionResult.score_breakdown.semantic, 0)
      assert.ok(productionResult.score_breakdown.bm25 > 0)
      assert.equal(embeddingCalls, 4)
    } finally {
      configureRuntimeArtifacts({ pluginRoot: null })
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
