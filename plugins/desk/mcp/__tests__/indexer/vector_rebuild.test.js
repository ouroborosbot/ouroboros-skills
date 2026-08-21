// Unit 13a: red contract for rebuilding local vectors from committed packs.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import matter from "gray-matter"

import { closeDb, openDb } from "../../src/db/init.js"
import { chunkBody } from "../../src/indexer/chunk.js"
import { rebuildIndex } from "../../src/indexer/index.js"
import {
  ACTIVE_EMBEDDING_SPEC,
  chunkIdentity,
} from "../../src/indexer/spec.js"
import {
  configureRuntimeArtifacts,
  ensureIndex,
  resolveEnsureIndexOptions,
} from "../../src/server-helpers.js"
import { desk_reindex } from "../../src/tools/reindex.js"

const NO_RELEASE_ARTIFACTS = { snapshots: false, vectorPacks: false }

async function tmpRoot(prefix = "desk-vector-rebuild-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function writeFile(root, rel, body) {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, "utf8")
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function vector(seed, dimension = ACTIVE_EMBEDDING_SPEC.dimension) {
  return Array.from({ length: dimension }, (_, index) => ((seed + index) % 19) / 19)
}

function rowForDoc({ docPath, body, chunkIndex = 0, seed = 1 }) {
  const chunk = chunkBody(docBody(body))[chunkIndex]
  assert.ok(chunk, `missing chunk ${chunkIndex} for ${docPath}`)
  const identity = chunkIdentity({ docPath, chunk })
  return {
    chunk_key: identity.chunk_key,
    text_hash: identity.text_hash,
    embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id,
    dimension: ACTIVE_EMBEDDING_SPEC.dimension,
    encoding: "float32-json",
    vector: vector(seed),
  }
}

function docBody(raw) {
  return matter(raw).content ?? ""
}

async function writePack({ pluginRoot, packId, rows }) {
  const packDir = path.join(
    pluginRoot,
    "artifacts",
    "vector-packs",
    ACTIVE_EMBEDDING_SPEC.id,
  )
  await fs.mkdir(packDir, { recursive: true })
  const packPath = path.join(packDir, `${packId}.jsonl`)
  const manifestPath = path.join(packDir, `${packId}.manifest.json`)
  const checksumPath = path.join(packDir, `${packId}.sha256`)
  const jsonl = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
  const packSha = sha256(jsonl)
  await fs.writeFile(packPath, jsonl, "utf8")
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({
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
    }, null, 2)}\n`,
    "utf8",
  )
  await fs.writeFile(checksumPath, `${packSha}  ${packId}.jsonl\n`, "utf8")
}

async function corruptPackChecksum({ pluginRoot, packId }) {
  await fs.writeFile(
    path.join(
      pluginRoot,
      "artifacts",
      "vector-packs",
      ACTIVE_EMBEDDING_SPEC.id,
      `${packId}.sha256`,
    ),
    `${"0".repeat(64)}  ${packId}.jsonl\n`,
    "utf8",
  )
}

function storedVector(db, docPath, chunkIndex) {
  const row = db
    .prepare(
      `SELECT v.embedding
       FROM chunk_vecs v
       JOIN chunks c ON c.id = v.chunk_id
       JOIN docs d ON d.id = c.doc_id
       WHERE d.path = ? AND c.chunk_index = ?`,
    )
    .get(docPath, chunkIndex)
  assert.ok(row, `missing stored vector for ${docPath} chunk ${chunkIndex}`)
  const buffer = Buffer.from(row.embedding)
  const values = []
  for (let offset = 0; offset < buffer.length; offset += 4) {
    values.push(buffer.readFloatLE(offset))
  }
  return values
}

function assertVectorApprox(actual, expected) {
  assert.equal(actual.length, expected.length)
  for (let index = 0; index < expected.length; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) < 0.000001,
      `vector[${index}] expected ${expected[index]}, got ${actual[index]}`,
    )
  }
}

test("rebuildIndex imports fully covered vector packs without live embedding calls", async () => {
  const deskRoot = await tmpRoot()
  const pluginRoot = await tmpRoot("desk-plugin-vector-rebuild-")
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\ncovered semantic body"
  await writeFile(deskRoot, docPath, body)
  await writePack({
    pluginRoot,
    packId: "covered",
    rows: [rowForDoc({ docPath, body, seed: 7 })],
  })

  let calls = 0
  const failIfCalled = async () => {
    calls += 1
    throw new Error("embedding endpoint should not be called for covered chunks")
  }

  const summary = await rebuildIndex(deskRoot, {
    vectorPacks: { pluginRoot },
    embed: { fetch: failIfCalled },
  })
  assert.equal(calls, 0)
  assert.equal(summary.semantic_warnings, 0)

  const db = openDb(deskRoot)
  try {
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM chunk_vecs").get().count,
      1,
    )
    assertVectorApprox(storedVector(db, docPath, 0), vector(7))
  } finally {
    closeDb(db)
  }
})

test("rebuildIndex live-generates only chunks missing from vector packs", async () => {
  const deskRoot = await tmpRoot()
  const pluginRoot = await tmpRoot("desk-plugin-vector-rebuild-")
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\ncovered semantic body\n\n## Missing\n\nmissing semantic body"
  await writeFile(deskRoot, docPath, body)
  await writePack({
    pluginRoot,
    packId: "partial",
    rows: [rowForDoc({ docPath, body, chunkIndex: 0, seed: 3 })],
  })

  const requests = []
  const fetchMissing = async (_url, request) => {
    requests.push(JSON.parse(request.body).prompt)
    return {
      ok: true,
      json: async () => ({ embedding: vector(11) }),
    }
  }

  const summary = await rebuildIndex(deskRoot, {
    vectorPacks: { pluginRoot },
    embed: { fetch: fetchMissing },
  })
  assert.equal(summary.semantic_warnings, 0)
  assert.equal(requests.length, 1)
  assert.match(requests[0], /missing semantic body/u)
  assert.doesNotMatch(requests[0], /covered semantic body/u)

  const db = openDb(deskRoot)
  try {
    assert.equal(db.prepare("SELECT count(*) AS count FROM chunk_vecs").get().count, 2)
    assertVectorApprox(storedVector(db, docPath, 0), vector(3))
    assertVectorApprox(storedVector(db, docPath, 1), vector(11))
  } finally {
    closeDb(db)
  }
})

test("rebuildIndex continues live vector generation after an oversized chunk", async () => {
  const deskRoot = await tmpRoot()
  const oversizePath = "trackA/task-oversize/task.md"
  const smallPath = "trackA/task-small/task.md"
  await writeFile(
    deskRoot,
    oversizePath,
    "---\nstatus: processing\n---\noversized semantic body",
  )
  await writeFile(
    deskRoot,
    smallPath,
    "---\nstatus: processing\n---\nsmall semantic body",
  )

  const requests = []
  const fetchWithOversizeFailure = async (_url, request) => {
    const prompt = JSON.parse(request.body).prompt
    requests.push(prompt)
    if (/oversized semantic body/u.test(prompt)) {
      return {
        ok: false,
        status: 500,
        json: async () => ({
          error: "the input length exceeds the context length",
        }),
      }
    }
    return {
      ok: true,
      json: async () => ({ embedding: vector(13) }),
    }
  }

  const summary = await rebuildIndex(deskRoot, {
    embed: {
      endpoint: "http://127.0.0.1:11434",
      fetch: fetchWithOversizeFailure,
    },
  })
  assert.equal(summary.semantic_warnings, 0)
  assert.equal(summary.embedding_failures_recorded, 1)
  assert.equal(requests.length, 2)
  assert.match(requests[0], /oversized semantic body/u)
  assert.match(requests[1], /small semantic body/u)

  const db = openDb(deskRoot)
  try {
    assert.equal(db.prepare("SELECT count(*) AS count FROM chunk_vecs").get().count, 1)
    assertVectorApprox(storedVector(db, smallPath, 0), vector(13))
    const missingOversize = db
      .prepare(
        `SELECT count(*) AS count
         FROM chunks c
         JOIN docs d ON d.id = c.doc_id
         LEFT JOIN chunk_vecs v ON v.chunk_id = c.id
         WHERE d.path = ? AND v.chunk_id IS NULL`,
      )
      .get(oversizePath).count
    assert.equal(missingOversize, 1)
    const failure = db
      .prepare(
        `SELECT reason, message
         FROM chunk_embedding_failures`,
      )
      .get()
    assert.equal(failure.reason, "http_500")
    assert.match(failure.message, /input length exceeds the context length/u)
  } finally {
    closeDb(db)
  }

  const second = await rebuildIndex(deskRoot, {
    reembedMissing: true,
    embed: {
      endpoint: "http://127.0.0.1:11434",
      fetch: fetchWithOversizeFailure,
    },
  })
  assert.equal(second.docs_indexed, 0)
  assert.equal(second.docs_skipped, 2)
  assert.equal(requests.length, 2)

  const ensured = await ensureIndex(deskRoot, {
    ...NO_RELEASE_ARTIFACTS,
    embed: {
      endpoint: "http://127.0.0.1:11434",
      fetch: async () => {
        throw new Error("known chunk-local failures should not probe embeddings")
      },
    },
  })
  assert.equal(ensured.built, false)
  assert.equal(ensured.reason, "fresh")
  assert.equal(ensured.semantic.missing_vectors, 1)
  assert.equal(ensured.semantic.known_unembeddable_vectors, 1)
  assert.equal(ensured.semantic.repairable_missing_vectors, 0)
})

test("ensureIndex imports vector packs for chunks previously marked unembeddable", async () => {
  const deskRoot = await tmpRoot()
  const pluginRoot = await tmpRoot("desk-plugin-vector-repair-")
  const oversizePath = "trackA/task-oversize/task.md"
  const oversizeBody = "---\nstatus: processing\n---\noversized semantic body"
  await writeFile(deskRoot, oversizePath, oversizeBody)

  await rebuildIndex(deskRoot, {
    ...NO_RELEASE_ARTIFACTS,
    embed: {
      endpoint: "http://127.0.0.1:11434",
      fetch: async () => ({
        ok: false,
        status: 500,
        json: async () => ({
          error: "the input length exceeds the context length",
        }),
      }),
    },
  })

  const before = await ensureIndex(deskRoot, {
    ...NO_RELEASE_ARTIFACTS,
    embed: {
      endpoint: "http://127.0.0.1:11434",
      fetch: async () => {
        throw new Error("known chunk-local failures should not probe embeddings")
      },
    },
  })
  assert.equal(before.built, false)
  assert.equal(before.semantic.missing_vectors, 1)
  assert.equal(before.semantic.known_unembeddable_vectors, 1)
  assert.equal(before.semantic.repairable_missing_vectors, 0)

  await writePack({
    pluginRoot,
    packId: "late-pack",
    rows: [rowForDoc({
      docPath: oversizePath,
      body: oversizeBody,
      seed: 17,
    })],
  })

  const repaired = await ensureIndex(deskRoot, {
    snapshots: false,
    vectorPacks: { pluginRoot },
    embed: {
      endpoint: "http://127.0.0.1:11434",
      fetch: async () => {
        throw new Error("vector-pack repair should not need live embeddings")
      },
    },
  })
  assert.equal(repaired.built, true)
  assert.equal(repaired.reason, "semantic_missing")
  assert.equal(repaired.summary.vector_packs.rows_imported, 1)
  assert.equal(repaired.semantic.missing_vectors, 0)
  assert.equal(repaired.semantic.known_unembeddable_vectors, 0)
  assert.equal(repaired.semantic.repairable_missing_vectors, 0)

  const db = openDb(deskRoot)
  try {
    assertVectorApprox(storedVector(db, oversizePath, 0), vector(17))
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM chunk_embedding_failures").get().count,
      0,
    )
  } finally {
    closeDb(db)
  }
})

test("ensureIndex skips repeated no-op vector-pack repair for unchanged known-unembeddable misses", async () => {
  const deskRoot = await tmpRoot()
  const oversizePath = "trackA/task-oversize/task.md"
  const oversizeBody = "---\nstatus: processing\n---\nknown oversize body"
  await writeFile(deskRoot, oversizePath, oversizeBody)

  await rebuildIndex(deskRoot, {
    ...NO_RELEASE_ARTIFACTS,
    embed: {
      endpoint: "http://127.0.0.1:11434",
      fetch: async () => ({
        ok: false,
        status: 500,
        json: async () => ({
          error: "the input length exceeds the context length",
        }),
      }),
    },
  })

  await writePack({
    pluginRoot: deskRoot,
    packId: "unmatched",
    rows: [rowForDoc({
      docPath: "trackA/other/task.md",
      body: "---\nstatus: processing\n---\nother vector pack body",
      seed: 19,
    })],
  })

  const first = await ensureIndex(deskRoot, {
    snapshots: false,
    embed: {
      endpoint: "http://127.0.0.1:11434",
      fetch: async () => {
        throw new Error("known chunk-local failures should not probe embeddings")
      },
    },
  })
  assert.equal(first.built, true)
  assert.equal(first.reason, "semantic_missing")
  assert.equal(first.summary.vector_packs.import_state, "validated")
  assert.equal(first.summary.vector_packs.rows_imported, 0)
  assert.equal(first.semantic.missing_vectors, 1)
  assert.equal(first.semantic.known_unembeddable_vectors, 1)
  assert.equal(first.semantic.repairable_missing_vectors, 0)

  const packPath = path.join(
    deskRoot,
    "artifacts",
    "vector-packs",
    ACTIVE_EMBEDDING_SPEC.id,
    "unmatched.jsonl",
  )
  await fs.writeFile(packPath, "not valid jsonl\n", "utf8")

  const second = await ensureIndex(deskRoot, {
    snapshots: false,
    embed: {
      endpoint: "http://127.0.0.1:11434",
      fetch: async () => {
        throw new Error("cached no-op vector-pack repair should not probe embeddings")
      },
    },
  })
  assert.equal(second.built, false)
  assert.equal(second.reason, "fresh")
  assert.equal(second.semantic.missing_vectors, 1)
  assert.equal(second.semantic.known_unembeddable_vectors, 1)
  assert.equal(second.semantic.repairable_missing_vectors, 0)

  await writePack({
    pluginRoot: deskRoot,
    packId: "unmatched",
    rows: [rowForDoc({
      docPath: oversizePath,
      body: oversizeBody,
      seed: 29,
    })],
  })

  const repaired = await ensureIndex(deskRoot, {
    snapshots: false,
    embed: {
      endpoint: "http://127.0.0.1:11434",
      fetch: async () => {
        throw new Error("changed vector pack should repair without live embeddings")
      },
    },
  })
  assert.equal(repaired.built, true)
  assert.equal(repaired.reason, "semantic_missing")
  assert.equal(repaired.summary.vector_packs.rows_imported, 1)
  assert.equal(repaired.semantic.missing_vectors, 0)
  assert.equal(repaired.semantic.known_unembeddable_vectors, 0)
  assert.equal(repaired.semantic.repairable_missing_vectors, 0)

  const db = openDb(deskRoot)
  try {
    assertVectorApprox(storedVector(db, oversizePath, 0), vector(29))
  } finally {
    closeDb(db)
  }
})

test("ensureIndex remembers absent vector-pack repair for known-unembeddable misses", async () => {
  const deskRoot = await tmpRoot()
  const pluginRoot = await tmpRoot("desk-empty-vector-pack-root-")
  const oversizePath = "trackA/task-oversize/task.md"
  await writeFile(
    deskRoot,
    oversizePath,
    "---\nstatus: processing\n---\nknown absent pack body",
  )

  await rebuildIndex(deskRoot, {
    ...NO_RELEASE_ARTIFACTS,
    embed: {
      endpoint: "http://127.0.0.1:11434",
      fetch: async () => ({
        ok: false,
        status: 500,
        json: async () => ({
          error: "the input length exceeds the context length",
        }),
      }),
    },
  })

  const first = await ensureIndex(deskRoot, {
    snapshots: false,
    vectorPacks: { pluginRoot },
    embed: {
      endpoint: "http://127.0.0.1:11434",
      fetch: async () => {
        throw new Error("known chunk-local failures should not probe embeddings")
      },
    },
  })
  assert.equal(first.built, true)
  assert.equal(first.reason, "semantic_missing")
  assert.equal(first.summary.vector_packs.import_state, "absent")
  assert.equal(first.summary.vector_packs.rows_imported, 0)
  assert.equal(first.semantic.known_unembeddable_vectors, 1)
  assert.equal(first.semantic.repairable_missing_vectors, 0)

  const second = await ensureIndex(deskRoot, {
    snapshots: false,
    vectorPacks: { pluginRoot },
    embed: {
      endpoint: "http://127.0.0.1:11434",
      fetch: async () => {
        throw new Error("cached absent vector-pack repair should not probe embeddings")
      },
    },
  })
  assert.equal(second.built, false)
  assert.equal(second.reason, "fresh")
  assert.equal(second.semantic.known_unembeddable_vectors, 1)
  assert.equal(second.semantic.repairable_missing_vectors, 0)
})

test("ensureIndex still validates malformed vector packs with missing sidecars", async () => {
  const deskRoot = await tmpRoot()
  const oversizePath = "trackA/task-oversize/task.md"
  await writeFile(
    deskRoot,
    oversizePath,
    "---\nstatus: processing\n---\nknown malformed pack body",
  )

  await rebuildIndex(deskRoot, {
    ...NO_RELEASE_ARTIFACTS,
    embed: {
      endpoint: "http://127.0.0.1:11434",
      fetch: async () => ({
        ok: false,
        status: 500,
        json: async () => ({
          error: "the input length exceeds the context length",
        }),
      }),
    },
  })

  const packDir = path.join(
    deskRoot,
    "artifacts",
    "vector-packs",
    ACTIVE_EMBEDDING_SPEC.id,
  )
  await fs.mkdir(packDir, { recursive: true })
  await fs.writeFile(path.join(packDir, "missing-sidecars.jsonl"), "{}\n", "utf8")

  await assert.rejects(
    () => ensureIndex(deskRoot, {
      snapshots: false,
      vectorPacks: { pluginRoot: deskRoot },
      embed: {
        endpoint: "http://127.0.0.1:11434",
        fetch: async () => {
          throw new Error("malformed vector pack should fail before live embedding")
        },
      },
    }),
    /manifest/u,
  )
})

test("rebuildIndex with disabled embeddings still succeeds when vector packs cover all chunks", async () => {
  const deskRoot = await tmpRoot()
  const pluginRoot = await tmpRoot("desk-plugin-vector-rebuild-")
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\noffline covered semantic body"
  await writeFile(deskRoot, docPath, body)
  await writePack({
    pluginRoot,
    packId: "offline-covered",
    rows: [rowForDoc({ docPath, body, seed: 5 })],
  })

  const summary = await rebuildIndex(deskRoot, {
    vectorPacks: { pluginRoot },
    skipEmbed: true,
  })
  assert.equal(summary.semantic_warnings, 0)

  const db = openDb(deskRoot)
  try {
    assert.equal(db.prepare("SELECT count(*) AS count FROM chunk_vecs").get().count, 1)
    assertVectorApprox(storedVector(db, docPath, 0), vector(5))
  } finally {
    closeDb(db)
  }
})

test("rebuildIndex reports validated vector packs when no rows match local chunks", async () => {
  const deskRoot = await tmpRoot()
  const pluginRoot = await tmpRoot("desk-plugin-vector-rebuild-")
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\nvalidated no-match semantic body"
  await writeFile(deskRoot, docPath, body)
  await writePack({
    pluginRoot,
    packId: "validated-no-match",
    rows: [rowForDoc({
      docPath: "other/task.md",
      body: "---\nstatus: processing\n---\nother semantic body",
      seed: 5,
    })],
  })

  const summary = await rebuildIndex(deskRoot, {
    vectorPacks: { pluginRoot },
    skipEmbed: true,
  })

  assert.equal(summary.vector_packs.import_state, "validated")
  assert.equal(summary.vector_packs.packs_imported, 1)
  assert.equal(summary.vector_packs.rows_imported, 0)

  const db = openDb(deskRoot)
  try {
    assert.equal(db.prepare("SELECT count(*) AS count FROM chunk_vecs").get().count, 0)
  } finally {
    closeDb(db)
  }
})

test("rebuildIndex reports absent vector packs when configured packs are missing", async () => {
  const deskRoot = await tmpRoot()
  const pluginRoot = await tmpRoot("desk-plugin-vector-rebuild-")
  await writeFile(
    deskRoot,
    "trackA/task-1/task.md",
    "---\nstatus: processing\n---\nmissing pack body",
  )

  const summary = await rebuildIndex(deskRoot, {
    vectorPacks: { pluginRoot },
    skipEmbed: true,
  })

  assert.equal(summary.vector_packs.import_state, "absent")
  assert.equal(summary.vector_packs.packs_imported, 0)
  assert.equal(summary.vector_packs.rows_imported, 0)
})

test("rebuildIndex rejects immediately when startup abort signal is already tripped", async () => {
  const deskRoot = await tmpRoot()
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    rebuildIndex(deskRoot, { signal: controller.signal }),
    (err) => err.name === "AbortError" && err.message === "operation aborted",
  )
})

test("rebuildIndex forwards startup abort signal into vector-pack import", async () => {
  const deskRoot = await tmpRoot()
  const pluginRoot = await tmpRoot("desk-plugin-vector-rebuild-")
  await writePack({
    pluginRoot,
    packId: "abort-forwarding",
    rows: [],
  })
  let reads = 0
  const signal = {
    get aborted() {
      reads += 1
      return reads >= 6
    },
  }

  await assert.rejects(
    rebuildIndex(deskRoot, {
      vectorPacks: { pluginRoot },
      skipEmbed: true,
      signal,
    }),
    (err) => err.name === "AbortError" && err.message === "operation aborted",
  )
  assert.ok(reads >= 6, `expected vector-pack import to observe signal; saw ${reads} reads`)

  reads = 0
  await assert.rejects(
    rebuildIndex(deskRoot, {
      vectorPacks: { pluginRoot, ignoreInvalidRoots: true },
      skipEmbed: true,
      signal,
    }),
    (err) => err.name === "AbortError" && err.message === "operation aborted",
  )
})

test("ensureIndex repairs a fresh lexical-only DB from vector packs without probing embeddings", async () => {
  const deskRoot = await tmpRoot()
  const pluginRoot = await tmpRoot("desk-plugin-vector-rebuild-")
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\nfresh lexical body"
  await writeFile(deskRoot, docPath, body)
  await rebuildIndex(deskRoot, { skipEmbed: true })
  await writePack({
    pluginRoot,
    packId: "fresh-repair",
    rows: [rowForDoc({ docPath, body, seed: 13 })],
  })

  let calls = 0
  const failIfCalled = async () => {
    calls += 1
    throw new Error("covered vector pack repair should not probe embeddings")
  }

  const ensured = await ensureIndex(deskRoot, {
    vectorPacks: { pluginRoot },
    embed: { fetch: failIfCalled },
  })
  assert.equal(calls, 0)
  assert.equal(ensured.built, true)
  assert.equal(ensured.reason, "semantic_missing")
  assert.equal(ensured.semantic.missing_vectors, 0)
  assert.equal(ensured.semantic.embedding_available, undefined)

  const db = openDb(deskRoot)
  try {
    assertVectorApprox(storedVector(db, docPath, 0), vector(13))
  } finally {
    closeDb(db)
  }
})

test("ensureIndex leaves a fresh semantic DB untouched without probing embeddings", async () => {
  const deskRoot = await tmpRoot()
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\nfresh semantic body"
  await writeFile(deskRoot, docPath, body)
  await rebuildIndex(deskRoot, {
    embed: {
      fetch: async () => ({
        ok: true,
        json: async () => ({ embedding: vector(43) }),
      }),
    },
  })

  let calls = 0
  const failIfCalled = async () => {
    calls += 1
    throw new Error("fresh semantic index should not probe embeddings")
  }

  const ensured = await ensureIndex(deskRoot, {
    ...NO_RELEASE_ARTIFACTS,
    embed: { fetch: failIfCalled },
  })

  assert.equal(calls, 0)
  assert.equal(ensured.built, false)
  assert.equal(ensured.reason, "fresh")
  assert.equal(ensured.semantic.missing_vectors, 0)
})

test("ensureIndex honors skipEmbed when a fresh DB is missing vectors", async () => {
  const deskRoot = await tmpRoot()
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\nfresh lexical skip body"
  await writeFile(deskRoot, docPath, body)
  await rebuildIndex(deskRoot, { skipEmbed: true })

  let calls = 0
  const failIfCalled = async () => {
    calls += 1
    throw new Error("skipEmbed should not probe embeddings")
  }

  const ensured = await ensureIndex(deskRoot, {
    ...NO_RELEASE_ARTIFACTS,
    skipEmbed: true,
    embed: { fetch: failIfCalled },
  })

  assert.equal(calls, 0)
  assert.equal(ensured.built, false)
  assert.equal(ensured.reason, "fresh")
  assert.equal(ensured.semantic.missing_vectors, 1)
})

test("ensureIndex rejects immediately when startup abort signal is already tripped", async () => {
  const deskRoot = await tmpRoot()
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    ensureIndex(deskRoot, { signal: controller.signal }),
    (err) => err.name === "AbortError" && err.message === "operation aborted",
  )
})

test("ensureIndex probes with default embed options when none are provided", async () => {
  const deskRoot = await tmpRoot()
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\ndefault probe semantic body"
  await writeFile(deskRoot, docPath, body)
  await rebuildIndex(deskRoot, { skipEmbed: true })

  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return {
      ok: true,
      json: async () => ({ embedding: vector(47) }),
    }
  }
  try {
    const ensured = await ensureIndex(deskRoot, NO_RELEASE_ARTIFACTS)

    assert.equal(calls, 2)
    assert.equal(ensured.built, true)
    assert.equal(ensured.reason, "semantic_missing")
    assert.equal(ensured.semantic.missing_vectors, 0)
    assert.equal(ensured.semantic.embedding_available, true)
    assert.equal(ensured.semantic.embedding_diagnostic.reason, "ok")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("ensureIndex calls embeddings only after vector-pack import leaves missing chunks", async () => {
  const deskRoot = await tmpRoot()
  const pluginRoot = await tmpRoot("desk-plugin-vector-rebuild-")
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\ncovered semantic body\n\n## Missing\n\nmissing semantic body"
  await writeFile(deskRoot, docPath, body)
  await rebuildIndex(deskRoot, { skipEmbed: true })
  await writePack({
    pluginRoot,
    packId: "fresh-partial-repair",
    rows: [rowForDoc({ docPath, body, chunkIndex: 0, seed: 17 })],
  })

  let calls = 0
  const failingFetch = async () => {
    calls += 1
    throw new Error("embedding endpoint unavailable after vector import")
  }

  const ensured = await ensureIndex(deskRoot, {
    vectorPacks: { pluginRoot },
    embed: {
      endpoint: "http://127.0.0.1:9/api/embeddings",
      fetch: failingFetch,
    },
  })
  assert.equal(calls, 1)
  assert.equal(ensured.built, true)
  assert.equal(ensured.reason, "semantic_missing")
  assert.equal(ensured.summary.semantic_warnings, 1)
  assert.equal(ensured.semantic.vectors_indexed, 1)
  assert.equal(ensured.semantic.missing_vectors, 1)
  assert.equal(ensured.semantic.embedding_available, false)
  assert.equal(
    ensured.semantic.embedding_diagnostic.reason,
    "embedding_generation_failed",
  )

  const db = openDb(deskRoot)
  try {
    assertVectorApprox(storedVector(db, docPath, 0), vector(17))
    assert.equal(db.prepare("SELECT count(*) AS count FROM chunk_vecs").get().count, 1)
  } finally {
    closeDb(db)
  }
})

test("ensureIndex reports failure diagnostics when probe succeeds but rebuild embedding fails", async () => {
  const deskRoot = await tmpRoot()
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\nprobe then fail body"
  await writeFile(deskRoot, docPath, body)
  await rebuildIndex(deskRoot, { skipEmbed: true })

  let calls = 0
  const flakyFetch = async () => {
    calls += 1
    if (calls === 1) {
      return {
        ok: true,
        json: async () => ({ embedding: vector(31) }),
      }
    }
    throw new Error("embedding failed after probe")
  }

  const ensured = await ensureIndex(deskRoot, {
    ...NO_RELEASE_ARTIFACTS,
    embed: {
      endpoint: "http://127.0.0.1:9/api/embeddings",
      fetch: flakyFetch,
    },
  })
  assert.equal(calls, 2)
  assert.equal(ensured.built, true)
  assert.equal(ensured.reason, "semantic_missing")
  assert.equal(ensured.summary.semantic_warnings, 1)
  assert.equal(ensured.semantic.embedding_available, false)
  assert.equal(
    ensured.semantic.embedding_diagnostic.reason,
    "embedding_generation_failed",
  )
  assert.equal(ensured.semantic.missing_vectors, 1)
})

test("ensureIndex preserves probe diagnostics when repair records a known unembeddable chunk", async () => {
  const deskRoot = await tmpRoot()
  const docPath = "trackA/task-oversize/task.md"
  const body = "---\nstatus: processing\n---\noversized repair body"
  await writeFile(deskRoot, docPath, body)
  await rebuildIndex(deskRoot, { skipEmbed: true })

  let calls = 0
  const probeThenOversize = async () => {
    calls += 1
    if (calls === 1) {
      return {
        ok: true,
        json: async () => ({ embedding: vector(43) }),
      }
    }
    return {
      ok: false,
      status: 500,
      json: async () => ({
        error: "the input length exceeds the context length",
      }),
    }
  }

  const ensured = await ensureIndex(deskRoot, {
    ...NO_RELEASE_ARTIFACTS,
    embed: {
      endpoint: "http://127.0.0.1:9/api/embeddings",
      fetch: probeThenOversize,
    },
  })
  assert.equal(calls, 2)
  assert.equal(ensured.built, true)
  assert.equal(ensured.reason, "semantic_missing")
  assert.equal(ensured.summary.semantic_warnings, 0)
  assert.equal(ensured.summary.embedding_failures_recorded, 1)
  assert.equal(ensured.semantic.missing_vectors, 1)
  assert.equal(ensured.semantic.known_unembeddable_vectors, 1)
  assert.equal(ensured.semantic.repairable_missing_vectors, 0)
  assert.equal(ensured.semantic.embedding_available, true)
  assert.equal(ensured.semantic.embedding_diagnostic.reason, "ok")
})

test("ensureIndex treats exact known-unembeddable-only coverage as fresh and semantically available", async () => {
  const deskRoot = await tmpRoot()
  const docPath = "trackA/task-oversize/task.md"
  const body = "---\nstatus: processing\n---\nstale known oversize body"
  await writeFile(deskRoot, docPath, body)
  await rebuildIndex(deskRoot, {
    ...NO_RELEASE_ARTIFACTS,
    embed: {
      endpoint: "http://127.0.0.1:9/api/embeddings",
      fetch: async () => ({
        ok: false,
        status: 500,
        json: async () => ({
          error: "the input length exceeds the context length",
        }),
      }),
    },
  })
  const future = new Date(Date.now() + 5000)
  await fs.utimes(path.join(deskRoot, docPath), future, future)

  const ensured = await ensureIndex(deskRoot, {
    ...NO_RELEASE_ARTIFACTS,
    embed: {
      endpoint: "http://127.0.0.1:9/api/embeddings",
      fetch: async () => {
        throw new Error("known chunk-local failures should not probe embeddings")
      },
    },
  })

  assert.equal(ensured.built, false)
  assert.equal(ensured.reason, "fresh")
  assert.equal(ensured.summary, undefined)
  assert.equal(ensured.semantic.missing_vectors, 1)
  assert.equal(ensured.semantic.known_unembeddable_vectors, 1)
  assert.equal(ensured.semantic.repairable_missing_vectors, 0)
  assert.equal(ensured.semantic.embedding_available, true)
  assert.equal(ensured.semantic.embedding_diagnostic, undefined)
})

test("ensureIndex preserves successful probe diagnostics after live embedding repair", async () => {
  const deskRoot = await tmpRoot()
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\nlive repair preserves diagnostic body"
  await writeFile(deskRoot, docPath, body)
  await rebuildIndex(deskRoot, { skipEmbed: true })

  let calls = 0
  const okFetch = async () => {
    calls += 1
    return {
      ok: true,
      json: async () => ({ embedding: vector(41) }),
    }
  }

  const ensured = await ensureIndex(deskRoot, {
    ...NO_RELEASE_ARTIFACTS,
    embed: {
      endpoint: "http://127.0.0.1:9/api/embeddings",
      fetch: okFetch,
    },
  })

  assert.equal(calls, 2)
  assert.equal(ensured.built, true)
  assert.equal(ensured.reason, "semantic_missing")
  assert.equal(ensured.summary.semantic_warnings, 0)
  assert.equal(ensured.semantic.missing_vectors, 0)
  assert.equal(ensured.semantic.embedding_available, true)
  assert.equal(ensured.semantic.embedding_diagnostic.reason, "ok")
})

test("ensureIndex preserves failed probe diagnostics when exact content is fresh", async () => {
  const deskRoot = await tmpRoot()
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\nstale same-hash body"
  await writeFile(deskRoot, docPath, body)
  await rebuildIndex(deskRoot, { skipEmbed: true })
  const future = new Date(Date.now() + 5000)
  await fs.utimes(path.join(deskRoot, docPath), future, future)

  let calls = 0
  const failingFetch = async () => {
    calls += 1
    throw new Error("probe failed before skipped rebuild")
  }

  const ensured = await ensureIndex(deskRoot, {
    ...NO_RELEASE_ARTIFACTS,
    embed: {
      endpoint: "http://127.0.0.1:9/api/embeddings",
      fetch: failingFetch,
    },
  })
  assert.equal(calls, 1)
  assert.equal(ensured.built, false)
  assert.equal(ensured.reason, "fresh")
  assert.equal(ensured.summary, undefined)
  assert.equal(ensured.semantic.missing_vectors, 1)
  assert.equal(ensured.semantic.embedding_available, false)
  assert.equal(ensured.semantic.embedding_diagnostic.reason, "network_error")
})

test("ensureIndex clears failed probe diagnostics when stale rebuild embeds successfully", async () => {
  const deskRoot = await tmpRoot()
  const docPath = "trackA/task-1/task.md"
  const oldBody = "---\nstatus: processing\n---\nold transient probe body"
  const newBody = "---\nstatus: processing\n---\nnew transient probe body"
  await writeFile(deskRoot, docPath, oldBody)
  await rebuildIndex(deskRoot, { skipEmbed: true })
  await writeFile(deskRoot, docPath, newBody)
  const future = new Date(Date.now() + 5000)
  await fs.utimes(path.join(deskRoot, docPath), future, future)

  let calls = 0
  const transientFetch = async () => {
    calls += 1
    if (calls === 1) {
      throw new Error("transient probe failure")
    }
    return {
      ok: true,
      json: async () => ({ embedding: vector(37) }),
    }
  }

  const ensured = await ensureIndex(deskRoot, {
    ...NO_RELEASE_ARTIFACTS,
    embed: {
      endpoint: "http://127.0.0.1:9/api/embeddings",
      fetch: transientFetch,
    },
  })
  assert.equal(calls, 2)
  assert.equal(ensured.built, true)
  assert.equal(ensured.reason, "stale")
  assert.equal(ensured.summary.semantic_warnings, 0)
  assert.equal(ensured.summary.docs_indexed, 1)
  assert.equal(ensured.semantic.missing_vectors, 0)
  assert.equal(ensured.semantic.embedding_available, true)
  assert.equal(ensured.semantic.embedding_diagnostic, undefined)
})

test("ensureIndex refreshes a stale lexical-only DB from vector packs without embedding calls", async () => {
  const deskRoot = await tmpRoot()
  const pluginRoot = await tmpRoot("desk-plugin-vector-rebuild-")
  const docPath = "trackA/task-1/task.md"
  const oldBody = "---\nstatus: processing\n---\nold lexical body"
  const newBody = "---\nstatus: processing\n---\nnew covered body"
  await writeFile(deskRoot, docPath, oldBody)
  await rebuildIndex(deskRoot, { skipEmbed: true })
  await writeFile(deskRoot, docPath, newBody)
  const future = new Date(Date.now() + 5000)
  await fs.utimes(path.join(deskRoot, docPath), future, future)
  await writePack({
    pluginRoot,
    packId: "stale-repair",
    rows: [rowForDoc({ docPath, body: newBody, seed: 23 })],
  })

  let calls = 0
  const failIfCalled = async () => {
    calls += 1
    throw new Error("stale covered vector pack repair should not call embeddings")
  }

  const ensured = await ensureIndex(deskRoot, {
    vectorPacks: { pluginRoot },
    embed: { fetch: failIfCalled },
  })
  assert.equal(calls, 0)
  assert.equal(ensured.built, true)
  assert.equal(ensured.reason, "stale")
  assert.equal(ensured.summary.docs_indexed, 1)
  assert.equal(ensured.semantic.missing_vectors, 0)
  assert.equal(ensured.semantic.embedding_available, undefined)

  const db = openDb(deskRoot)
  try {
    assertVectorApprox(storedVector(db, docPath, 0), vector(23))
  } finally {
    closeDb(db)
  }
})

test("ensureIndex reports vector-pack fallback for cold covered rebuilds without snapshots", async () => {
  const deskRoot = await tmpRoot()
  const pluginRoot = await tmpRoot("desk-plugin-vector-rebuild-")
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\ncold covered startup body"
  await writeFile(deskRoot, docPath, body)
  await writePack({
    pluginRoot,
    packId: "cold-covered-startup",
    rows: [rowForDoc({ docPath, body, seed: 29 })],
  })

  const ensured = await ensureIndex(deskRoot, {
    skipEmbed: true,
    startup: true,
    vectorPacks: { pluginRoot },
  })

  assert.equal(ensured.built, true)
  assert.equal(ensured.reason, "missing")
  assert.equal(ensured.fallback, "vector_packs")
  assert.equal(ensured.vector_packs.import_state, "used_as_fallback")
  assert.equal(ensured.vector_packs.packs_imported, 1)
  assert.equal(ensured.vector_packs.rows_imported, 1)
  assert.equal(ensured.semantic.missing_vectors, 0)

  const db = openDb(deskRoot)
  try {
    assertVectorApprox(storedVector(db, docPath, 0), vector(29))
  } finally {
    closeDb(db)
  }
})

test("ensureIndex discovers repo-local vector packs from the desk root by default", async () => {
  const deskRoot = await tmpRoot()
  const pluginRoot = await tmpRoot("desk-plugin-vector-rebuild-")
  const explicitWorkspaceRoot = await tmpRoot("desk-explicit-vector-root-")
  const envWorkspaceRoot = await tmpRoot("desk-env-vector-root-")
  const emptyDeskRoot = await tmpRoot("desk-empty-vector-root-")
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\nrepo local vector pack body"
  await writeFile(deskRoot, docPath, body)
  await writePack({
    pluginRoot: deskRoot,
    packId: "workspace-pack",
    rows: [rowForDoc({ docPath, body, seed: 31 })],
  })
  for (const [root, packId] of [
    [explicitWorkspaceRoot, "explicit-workspace-pack"],
    [envWorkspaceRoot, "env-workspace-pack"],
    [pluginRoot, "plugin-fallback-pack"],
  ]) {
    await writePack({
      pluginRoot: root,
      packId,
      rows: [rowForDoc({ docPath, body, seed: 31 })],
    })
  }

  const original = process.env.DESK_PLUGIN_ROOT
  const originalWorkspace = process.env.DESK_WORKSPACE_ARTIFACT_ROOT
  delete process.env.DESK_PLUGIN_ROOT
  try {
    configureRuntimeArtifacts({ pluginRoot })
    const ensured = await ensureIndex(deskRoot, {
      snapshots: false,
      skipEmbed: true,
      embed: {
        fetch: async () => {
          throw new Error("repo-local vector pack should not call embeddings")
        },
      },
    })

    assert.equal(ensured.fallback, "vector_packs")
    assert.equal(ensured.vector_packs.import_state, "used_as_fallback")
    assert.equal(ensured.vector_packs.rows_imported, 1)
    assert.equal(ensured.semantic.missing_vectors, 0)

    const resolved = resolveEnsureIndexOptions({}, { deskRoot })
    assert.equal(resolved.vectorPacks.pluginRoot, path.resolve(deskRoot))

    const explicit = resolveEnsureIndexOptions({
      vectorPacks: { pluginRoot },
    }, { deskRoot })
    assert.equal(explicit.vectorPacks.pluginRoot, path.resolve(pluginRoot))

    const explicitWorkspace = resolveEnsureIndexOptions({
      workspaceArtifactRoot: explicitWorkspaceRoot,
    }, { deskRoot })
    assert.equal(explicitWorkspace.vectorPacks.pluginRoot, path.resolve(explicitWorkspaceRoot))

    process.env.DESK_WORKSPACE_ARTIFACT_ROOT = envWorkspaceRoot
    const envWorkspace = resolveEnsureIndexOptions({}, { deskRoot })
    assert.equal(envWorkspace.vectorPacks.pluginRoot, path.resolve(envWorkspaceRoot))
    delete process.env.DESK_WORKSPACE_ARTIFACT_ROOT

    const fallback = resolveEnsureIndexOptions({}, { deskRoot: emptyDeskRoot })
    assert.equal(fallback.vectorPacks.pluginRoot, path.resolve(pluginRoot))
    assert.deepEqual(fallback.vectorPacks.fallbackPluginRoots, [])
    assert.equal(fallback.vectorPacks.ignoreInvalidRoots, true)

    const db = openDb(deskRoot)
    try {
      assertVectorApprox(storedVector(db, docPath, 0), vector(31))
    } finally {
      closeDb(db)
    }
  } finally {
    configureRuntimeArtifacts()
    if (original === undefined) {
      delete process.env.DESK_PLUGIN_ROOT
    } else {
      process.env.DESK_PLUGIN_ROOT = original
    }
    if (originalWorkspace === undefined) {
      delete process.env.DESK_WORKSPACE_ARTIFACT_ROOT
    } else {
      process.env.DESK_WORKSPACE_ARTIFACT_ROOT = originalWorkspace
    }
  }
})

test("ensureIndex skips corrupt auto-discovered workspace vector packs and uses plugin fallback", async () => {
  const deskRoot = await tmpRoot()
  const strictDeskRoot = await tmpRoot("desk-strict-corrupt-vector-")
  const pluginRoot = await tmpRoot("desk-plugin-vector-rebuild-")
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\ncorrupt workspace vector pack body"
  await writeFile(deskRoot, docPath, body)
  await writeFile(strictDeskRoot, docPath, body)
  await writePack({
    pluginRoot: deskRoot,
    packId: "corrupt-workspace-pack",
    rows: [rowForDoc({ docPath, body, seed: 3 })],
  })
  await corruptPackChecksum({
    pluginRoot: deskRoot,
    packId: "corrupt-workspace-pack",
  })
  await writePack({
    pluginRoot,
    packId: "plugin-fallback-pack",
    rows: [rowForDoc({ docPath, body, seed: 37 })],
  })

  await assert.rejects(
    rebuildIndex(strictDeskRoot, {
      vectorPacks: { pluginRoot: deskRoot },
      skipEmbed: true,
    }),
    /checksum mismatch/u,
  )

  const original = process.env.DESK_PLUGIN_ROOT
  delete process.env.DESK_PLUGIN_ROOT
  try {
    configureRuntimeArtifacts({ pluginRoot })
    const ensured = await ensureIndex(deskRoot, {
      snapshots: false,
      skipEmbed: true,
    })

    assert.equal(ensured.fallback, "vector_packs")
    assert.equal(ensured.vector_packs.rows_imported, 1)
    assert.equal(ensured.vector_packs.import_errors.length, 1)
    assert.match(ensured.vector_packs.import_errors[0].message, /checksum mismatch/u)
    assert.equal(ensured.semantic.missing_vectors, 0)

    const db = openDb(deskRoot)
    try {
      assertVectorApprox(storedVector(db, docPath, 0), vector(37))
    } finally {
      closeDb(db)
    }
  } finally {
    configureRuntimeArtifacts()
    if (original === undefined) {
      delete process.env.DESK_PLUGIN_ROOT
    } else {
      process.env.DESK_PLUGIN_ROOT = original
    }
  }
})

test("desk_reindex force rebuild restores vector packs with live embeddings disabled", async () => {
  const deskRoot = await tmpRoot()
  const pluginRoot = await tmpRoot("desk-plugin-vector-rebuild-")
  const docPath = "trackA/task-1/task.md"
  const body = "---\nstatus: processing\n---\nforce covered body"
  await writeFile(deskRoot, docPath, body)
  await rebuildIndex(deskRoot, { skipEmbed: true })
  await writePack({
    pluginRoot,
    packId: "force-repair",
    rows: [rowForDoc({ docPath, body, seed: 29 })],
  })

  const result = await desk_reindex({
    deskRoot,
    input: { force: true },
    opts: {
      vectorPacks: { pluginRoot },
      skipEmbed: true,
    },
  })
  assert.equal(result.built, true)
  assert.equal(result.reason, "missing")
  assert.equal(result.docs_indexed, 1)
  assert.equal(result.missing_vectors, 0)

  const db = openDb(deskRoot)
  try {
    assertVectorApprox(storedVector(db, docPath, 0), vector(29))
  } finally {
    closeDb(db)
  }
})
