import { test } from "node:test"
import { strict as assert } from "node:assert"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import Database from "better-sqlite3"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { closeDb, indexDbPath, openDb, setMeta } from "../../src/db/init.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"
import { callTool, TOOL_IMPLS } from "../../src/server.js"
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from "../../src/tool-names.js"

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
)

function makeRoot() {
  return mkdtempSync(path.join(tmpdir(), "desk-status-"))
}

function parseToolResult(response) {
  assert.equal(response.isError, undefined, response.content?.[0]?.text)
  return JSON.parse(response.content[0].text)
}

test("desk_status is registered with a session-start-safe description", () => {
  assert.ok(TOOL_NAMES.includes("desk_status"), `registered tools: ${TOOL_NAMES.join(", ")}`)
  assert.equal(typeof TOOL_IMPLS.desk_status, "function")
  assert.match(TOOL_DESCRIPTIONS.desk_status, /health|status/iu)
  assert.match(TOOL_DESCRIPTIONS.desk_status, /session-start|fast|repair/iu)
})

test("desk_status reports the exact workspace write scope for OFF person values", async () => {
  const root = makeRoot()
  try {
    for (const person of [undefined, null, 42, {}, true, "", "   ", "\t\n"]) {
      const body = parseToolResult(await callTool({
        deskRoot: root,
        name: "desk_status",
        input: {},
        person,
      }))
      assert.deepEqual(body.write_scope, {
        mode: "workspace",
        person: null,
        relative_path: ".",
      })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status reports the exact normalized person write scope", async () => {
  const root = makeRoot()
  try {
    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      person: "  ari  ",
    }))
    assert.deepEqual(body.write_scope, {
      mode: "person",
      person: "ari",
      relative_path: "desks/ari",
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status rejects every traversal and multi-segment alias family", async () => {
  const root = makeRoot()
  try {
    for (const person of [".", "..", "../evil", "a..b", "a/b", "a\\b", "/etc/passwd"]) {
      const response = await callTool({
        deskRoot: root,
        name: "desk_status",
        input: {},
        person,
      })
      assert.equal(response.isError, true)
      assert.match(JSON.parse(response.content[0].text).message, /alias/iu)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status reports root, runtime, missing DB, and deferred repair state without creating .state", async () => {
  const root = makeRoot()
  const runtimeCacheDir = path.join(root, "..", "runtime-cache")
  const sourceMirrorPath = path.join(runtimeCacheDir, "source-mirror", "abc123")
  const dbPath = indexDbPath(root)
  try {
    mkdirSync(path.join(root, "ops", "status-check"), { recursive: true })
    writeFileSync(
      path.join(root, "ops", "status-check", "task.md"),
      "---\nschema_version: 1\nstatus: in_progress\n---\n\n# Status Check\n",
      "utf8",
    )

    assert.equal(existsSync(dbPath), false, "fixture must start without a local DB")

    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      statusContext: {
        root: {
          source: "activation-config",
          tried: [{ source: "activation-config", path: root }],
        },
        runtime: {
          runtime_cache_dir: runtimeCacheDir,
          source_mirror_path: sourceMirrorPath,
          target: `${process.platform}-${process.arch}-node-${process.versions.modules}`,
        },
      },
    }))

    assert.equal(body.status, "ok")
    assert.equal(body.root.path, root)
    assert.equal(body.root.source, "activation-config")
    assert.deepEqual(body.root.tried, [{ source: "activation-config", path: root }])
    assert.equal(body.runtime.plugin.name, packageJson.name)
    assert.equal(body.runtime.plugin.version, packageJson.version)
    assert.equal(body.runtime.runtime_cache_dir, runtimeCacheDir)
    assert.equal(body.runtime.source_mirror_path, sourceMirrorPath)
    assert.equal(body.local_db.path, dbPath)
    assert.equal(body.local_db.exists, false)
    assert.deepEqual(body.local_db.schema, { id: "desk-index", version: null })
    assert.equal(body.local_db.state, "missing")
    assert.equal(body.lexical_index.available, false)
    assert.equal(body.document_vectors.state, "missing_local_db")
    assert.equal(body.query_embedding.available, "not_checked")
    assert.equal(body.active_embedding_spec.id, ACTIVE_EMBEDDING_SPEC.id)
    assert.equal(body.active_embedding_spec.model, ACTIVE_EMBEDDING_SPEC.model)
    assert.equal(body.active_embedding_spec.model_revision, ACTIVE_EMBEDDING_SPEC.model_revision)
    assert.equal(body.active_embedding_spec.dimensions, ACTIVE_EMBEDDING_SPEC.dimension)
    assert.equal(body.active_embedding_spec.chunker_id, ACTIVE_EMBEDDING_SPEC.chunker_id)
    assert.equal(body.active_embedding_spec.normalization_id, ACTIVE_EMBEDDING_SPEC.normalization_id)
    assert.doesNotMatch(body.active_embedding_spec.id, /[\\/: \t\r\n]/u)
    assert.equal(body.snapshots.restore_state, "not_checked")
    assert.equal(body.snapshots.module_state, "available")
    assert.equal(body.vector_packs.import_state, "not_checked")
    assert.equal(body.vector_packs.module_state, "available")
    assert.match(body.summary, /activation-config/iu)
    assert.equal(existsSync(dbPath), false, "status must not create the local index DB")
    assert.equal(existsSync(path.dirname(dbPath)), false, "status must not create .state during first-run checks")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status reports active activation target and overlay chain when provided", async () => {
  const root = makeRoot()
  try {
    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      statusContext: {
        root: {
          source: "activation-config",
          tried: [{ source: "activation-config", path: root }],
        },
        activation: {
          selected_id: "ms-area:worker",
          chain: [
            { id: "desk:worker" },
            { id: "ms-desk:worker" },
            { id: "ms-area:worker" },
          ],
          mode: "global-personal",
          source: "activation-config",
        },
      },
    }))

    assert.equal(body.status, "ok")
    assert.deepEqual(body.activation, {
      selected_id: "ms-area:worker",
      chain: ["desk:worker", "ms-desk:worker", "ms-area:worker"],
      mode: "global-personal",
      source: "activation-config",
    })
    assert.match(body.summary, /Active activation: ms-area:worker/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status normalizes activation aliases and ignores malformed chain entries", async () => {
  const root = makeRoot()
  try {
    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      statusContext: {
        activation: {
          selectedActivationId: "ms-desk:worker",
          chain: [
            "desk:worker",
            "",
            { id: "ms-desk:worker" },
            { id: 42 },
            null,
            false,
          ],
        },
      },
    }))

    assert.deepEqual(body.activation, {
      selected_id: "ms-desk:worker",
      chain: ["desk:worker", "ms-desk:worker"],
      mode: null,
      source: "unknown",
    })

    const camelCaseBody = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      statusContext: {
        activation: {
          selectedId: "ms-desk:worker",
          chain: "desk:worker -> ms-desk:worker",
          source: " ",
        },
      },
    }))
    assert.deepEqual(camelCaseBody.activation, {
      selected_id: "ms-desk:worker",
      chain: [],
      mode: null,
      source: "unknown",
    })

    const idBody = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      statusContext: {
        activation: {
          id: "desk:worker",
          chain: [],
        },
      },
    }))
    assert.equal(idBody.activation.selected_id, "desk:worker")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status reports stale DB by comparing last_indexed_at to markdown mtimes without reindexing", async () => {
  const root = makeRoot()
  try {
    mkdirSync(path.join(root, "ops", "status-check"), { recursive: true })
    const olderPath = path.join(root, "ops", "status-check", "a-older.md")
    const newerPath = path.join(root, "ops", "status-check", "z-newer.md")
    writeFileSync(
      olderPath,
      "---\nschema_version: 1\nstatus: in_progress\n---\n\n# Older\n",
      "utf8",
    )
    writeFileSync(newerPath, "# Newer\n", "utf8")
    utimesSync(olderPath, new Date("2001-01-01T00:00:00.000Z"), new Date("2001-01-01T00:00:00.000Z"))
    utimesSync(newerPath, new Date("2002-01-01T00:00:00.000Z"), new Date("2002-01-01T00:00:00.000Z"))
    const db = openDb(root)
    try {
      setMeta(db, "last_indexed_at", "2000-01-01T00:00:00.000Z")
    } finally {
      closeDb(db)
    }

    const beforeStatus = readFileSync(newerPath, "utf8")
    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
    }))

    assert.equal(body.local_db.exists, true)
    assert.equal(body.local_db.state, "stale")
    assert.equal(body.local_db.freshness.state, "stale")
    assert.equal(body.local_db.freshness.last_indexed_at, "2000-01-01T00:00:00.000Z")
    assert.equal(body.local_db.freshness.newest_document.path, path.join("ops", "status-check", "z-newer.md"))
    assert.equal(readFileSync(newerPath, "utf8"), beforeStatus)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status reports fresh and unknown freshness states without repair work", async () => {
  const noDocsRoot = makeRoot()
  const invalidMetaRoot = makeRoot()
  const freshRoot = makeRoot()
  try {
    let db = openDb(noDocsRoot)
    try {
      setMeta(db, "last_indexed_at", "2000-01-01T00:00:00.000Z")
    } finally {
      closeDb(db)
    }
    const noDocsBody = parseToolResult(await callTool({
      deskRoot: noDocsRoot,
      name: "desk_status",
      input: {},
    }))
    assert.equal(noDocsBody.local_db.freshness.state, "fresh")
    assert.equal(noDocsBody.local_db.freshness.newest_document, null)

    db = openDb(invalidMetaRoot)
    try {
      setMeta(db, "last_indexed_at", "not-a-date")
    } finally {
      closeDb(db)
    }
    const invalidMetaBody = parseToolResult(await callTool({
      deskRoot: invalidMetaRoot,
      name: "desk_status",
      input: {},
    }))
    assert.equal(invalidMetaBody.local_db.freshness.state, "unknown")
    assert.equal(invalidMetaBody.local_db.freshness.reason, "last_indexed_at_invalid")
    assert.equal(invalidMetaBody.local_db.freshness.last_indexed_at, "not-a-date")

    mkdirSync(path.join(freshRoot, "ops"), { recursive: true })
    writeFileSync(path.join(freshRoot, "ops", "fresh.md"), "# Fresh\n", "utf8")
    db = openDb(freshRoot)
    try {
      setMeta(db, "last_indexed_at", "2999-01-01T00:00:00.000Z")
    } finally {
      closeDb(db)
    }
    const freshBody = parseToolResult(await callTool({
      deskRoot: freshRoot,
      name: "desk_status",
      input: {},
    }))
    assert.equal(freshBody.local_db.freshness.state, "fresh")
    assert.equal(freshBody.local_db.freshness.newest_document.path, path.join("ops", "fresh.md"))
  } finally {
    rmSync(noDocsRoot, { recursive: true, force: true })
    rmSync(invalidMetaRoot, { recursive: true, force: true })
    rmSync(freshRoot, { recursive: true, force: true })
  }
})

test("desk_status reports no desk root without trying to inspect a local DB", async () => {
  const body = parseToolResult(await callTool({
    name: "desk_status",
    input: {},
  }))

  assert.equal(body.status, "error")
  assert.equal(body.root.path, null)
  assert.equal(body.root.exists, false)
  assert.equal(body.root.valid, false)
  assert.equal(body.root.diagnostic, "missing_desk_root")
  assert.equal(body.local_db.path, null)
  assert.equal(body.local_db.state, "root_unavailable")
  assert.equal(body.lexical_index.state, "root_unavailable")
  assert.equal(body.document_vectors.state, "root_unavailable")
  assert.match(body.summary, /missing_desk_root/u)
})

test("desk_status sanitizes malformed root context and reports nonexistent roots", async () => {
  const parent = makeRoot()
  const root = path.join(parent, "removed")
  try {
    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      statusContext: {
        root: {
          source: 42,
          tried: "this is not a tried list",
        },
      },
    }))

    assert.equal(body.status, "error")
    assert.equal(body.root.path, root)
    assert.equal(body.root.source, "unknown")
    assert.deepEqual(body.root.tried, [])
    assert.equal(body.root.exists, false)
    assert.equal(body.root.valid, false)
    assert.equal(body.root.diagnostic, "desk_root_not_found")
    assert.equal(body.root.malformed_context, true)
    assert.equal(body.local_db.path, indexDbPath(root))
    assert.equal(body.local_db.state, "root_unavailable")
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test("desk_status reports existing DB coverage without probing query embeddings", async () => {
  const root = makeRoot()
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  try {
    const db = openDb(root)
    closeDb(db)
    globalThis.fetch = async () => {
      fetchCalls += 1
      throw new Error("desk_status must not probe live embeddings")
    }

    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
      statusContext: {
        root: { source: "explicit-root", tried: [{ source: "explicit-root", path: root }] },
        runtime: { runtime_cache_dir: null, source_mirror_path: null, target: "direct-import" },
      },
    }))

    assert.equal(body.local_db.exists, true)
    assert.equal(body.local_db.schema.id, "desk-index")
    assert.equal(body.local_db.schema.version, 1)
    assert.equal(body.lexical_index.available, true)
    assert.equal(body.document_vectors.chunks_total, 0)
    assert.equal(body.document_vectors.vectors_indexed, 0)
    assert.equal(body.document_vectors.missing_vectors, 0)
    assert.equal(body.query_embedding.available, "not_checked")
    assert.equal(fetchCalls, 0, "status must not call the embedding endpoint")
  } finally {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status leaves query embedding unprobed even when the endpoint is unavailable", async () => {
  const root = makeRoot()
  const originalFetch = globalThis.fetch
  const originalEndpoint = process.env.DESK_EMBED_ENDPOINT
  let fetchCalls = 0
  try {
    process.env.DESK_EMBED_ENDPOINT = "http://127.0.0.1:1/api/embeddings"
    globalThis.fetch = async () => {
      fetchCalls += 1
      throw new Error("embedding endpoint unavailable")
    }

    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
    }))

    assert.equal(body.query_embedding.available, "not_checked")
    assert.equal(body.query_embedding.spec_id, ACTIVE_EMBEDDING_SPEC.id)
    assert.match(body.query_embedding.note, /does not probe/u)
    assert.equal(fetchCalls, 0)
  } finally {
    if (originalEndpoint === undefined) {
      delete process.env.DESK_EMBED_ENDPOINT
    } else {
      process.env.DESK_EMBED_ENDPOINT = originalEndpoint
    }
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status defaults unknown startup context and reports partial vector coverage", async () => {
  const root = makeRoot()
  try {
    const db = openDb(root)
    try {
      db.prepare(
        `INSERT INTO docs (path, kind, hash, mtime, frontmatter)
         VALUES ('notes.md', 'reference', 'abc', 1, '{}')`,
      ).run()
      db.prepare(
        `INSERT INTO chunks (doc_id, chunk_index, text, heading, start_offset, end_offset)
         VALUES (1, 0, 'hello', null, 0, 5)`,
      ).run()
    } finally {
      closeDb(db)
    }

    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
    }))

    assert.equal(body.root.source, "unknown")
    assert.deepEqual(body.root.tried, [])
    assert.equal(body.runtime.runtime_cache_dir, null)
    assert.equal(body.runtime.source_mirror_path, null)
    assert.equal(body.runtime.loaded_from_source_mirror, false)
    assert.equal(body.document_vectors.chunks_total, 1)
    assert.equal(body.document_vectors.vectors_indexed, 0)
    assert.equal(body.document_vectors.missing_vectors, 1)
    assert.equal(body.document_vectors.coverage, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status reports vector coverage against the active embedding spec", async () => {
  const root = makeRoot()
  try {
    const db = openDb(root)
    try {
      const docId = db.prepare(
        `INSERT INTO docs (path, kind, hash, mtime, frontmatter)
         VALUES ('notes.md', 'reference', 'abc', 1, '{}')
         RETURNING id`,
      ).get().id
      const activeChunkId = db.prepare(
        `INSERT INTO chunks (
           doc_id,
           chunk_index,
           chunk_key,
           text_hash,
           embedding_spec_id,
           chunker_id,
           normalization_id,
           text
         )
         VALUES (?, 0, 'ck_active', 'sha256:active', ?, ?, ?, 'active text')
         RETURNING id`,
      ).get(
        docId,
        ACTIVE_EMBEDDING_SPEC.id,
        ACTIVE_EMBEDDING_SPEC.chunker_id,
        ACTIVE_EMBEDDING_SPEC.normalization_id,
      ).id
      const inactiveChunkId = db.prepare(
        `INSERT INTO chunks (
           doc_id,
           chunk_index,
           chunk_key,
           text_hash,
           embedding_spec_id,
           chunker_id,
           normalization_id,
           text
         )
         VALUES (?, 1, 'ck_inactive', 'sha256:inactive', 'old-spec', 'old-chunker', 'old-normalizer', 'inactive text')
         RETURNING id`,
      ).get(docId).id
      const vec = new Float32Array(ACTIVE_EMBEDDING_SPEC.dimension)
      db.prepare("INSERT INTO chunk_vecs (chunk_id, embedding) VALUES (?, ?)").run(BigInt(activeChunkId), vec)
      db.prepare("INSERT INTO chunk_vecs (chunk_id, embedding) VALUES (?, ?)").run(BigInt(inactiveChunkId), vec)
    } finally {
      closeDb(db)
    }

    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
    }))

    assert.equal(body.document_vectors.chunks_total, 2)
    assert.equal(body.document_vectors.vectors_indexed, 1)
    assert.equal(body.document_vectors.missing_vectors, 1)
    assert.equal(body.document_vectors.coverage, 0.5)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status treats known unembeddable chunks as non-repairable vector skips", async () => {
  const root = makeRoot()
  try {
    const db = openDb(root)
    try {
      const docId = db.prepare(
        `INSERT INTO docs (path, kind, hash, mtime, frontmatter)
         VALUES ('notes.md', 'reference', 'abc', 1, '{}')
         RETURNING id`,
      ).get().id
      const vectorChunkId = db.prepare(
        `INSERT INTO chunks (
           doc_id,
           chunk_index,
           chunk_key,
           text_hash,
           embedding_spec_id,
           chunker_id,
           normalization_id,
           text
         )
         VALUES (?, 0, 'ck_vector', 'sha256:vector', ?, ?, ?, 'vector text')
         RETURNING id`,
      ).get(
        docId,
        ACTIVE_EMBEDDING_SPEC.id,
        ACTIVE_EMBEDDING_SPEC.chunker_id,
        ACTIVE_EMBEDDING_SPEC.normalization_id,
      ).id
      db.prepare(
        `INSERT INTO chunks (
           doc_id,
           chunk_index,
           chunk_key,
           text_hash,
           embedding_spec_id,
           chunker_id,
           normalization_id,
           text
         )
         VALUES (?, 1, 'ck_oversize', 'sha256:oversize', ?, ?, ?, 'oversize text')`,
      ).run(
        docId,
        ACTIVE_EMBEDDING_SPEC.id,
        ACTIVE_EMBEDDING_SPEC.chunker_id,
        ACTIVE_EMBEDDING_SPEC.normalization_id,
      )
      db.prepare(
        `INSERT INTO chunk_embedding_failures (
           chunk_key,
           text_hash,
           embedding_spec_id,
           chunker_id,
           normalization_id,
           reason,
           message,
           failed_at
         )
         VALUES ('ck_oversize', 'sha256:oversize', ?, ?, ?, 'http_500',
                 'the input length exceeds the context length',
                 '2026-07-09T00:00:00.000Z')`,
      ).run(
        ACTIVE_EMBEDDING_SPEC.id,
        ACTIVE_EMBEDDING_SPEC.chunker_id,
        ACTIVE_EMBEDDING_SPEC.normalization_id,
      )
      const vec = new Float32Array(ACTIVE_EMBEDDING_SPEC.dimension)
      db.prepare("INSERT INTO chunk_vecs (chunk_id, embedding) VALUES (?, ?)").run(BigInt(vectorChunkId), vec)
    } finally {
      closeDb(db)
    }

    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
    }))

    assert.equal(body.document_vectors.state, "available")
    assert.equal(body.document_vectors.chunks_total, 2)
    assert.equal(body.document_vectors.vectors_indexed, 1)
    assert.equal(body.document_vectors.missing_vectors, 1)
    assert.equal(body.document_vectors.known_unembeddable_vectors, 1)
    assert.equal(body.document_vectors.repairable_missing_vectors, 0)
    assert.equal(body.degraded_modes.includes("document_vectors_partial"), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status reports lexical index absence without mutating an existing DB", async () => {
  const root = makeRoot()
  const dbPath = indexDbPath(root)
  try {
    mkdirSync(path.dirname(dbPath), { recursive: true })
    const db = new Database(dbPath)
    try {
      db.exec(`
        CREATE TABLE chunks (id INTEGER PRIMARY KEY);
        CREATE TABLE chunk_vecs (chunk_id INTEGER PRIMARY KEY);
        CREATE TABLE chunk_embedding_failures (chunk_key TEXT PRIMARY KEY);
      `)
    } finally {
      db.close()
    }

    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
    }))

    assert.equal(body.local_db.exists, true)
    assert.equal(body.lexical_index.available, false)
    assert.equal(body.lexical_index.state, "missing")
    assert.equal(body.document_vectors.known_unembeddable_vectors, 0)
    assert.equal(body.document_vectors.repairable_missing_vectors, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status tolerates a malformed embedding failure table", async () => {
  const root = makeRoot()
  const dbPath = indexDbPath(root)
  try {
    mkdirSync(path.dirname(dbPath), { recursive: true })
    const db = new Database(dbPath)
    try {
      db.exec(`
        CREATE TABLE chunks (
          id INTEGER PRIMARY KEY,
          chunk_key TEXT,
          text_hash TEXT,
          embedding_spec_id TEXT,
          chunker_id TEXT,
          normalization_id TEXT
        );
        CREATE TABLE chunk_vecs (chunk_id INTEGER PRIMARY KEY);
        CREATE TABLE chunk_embedding_failures (chunk_key TEXT PRIMARY KEY);
      `)
    } finally {
      db.close()
    }

    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
    }))

    assert.equal(body.local_db.exists, true)
    assert.equal(body.document_vectors.known_unembeddable_vectors, 0)
    assert.equal(body.document_vectors.repairable_missing_vectors, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("desk_status tolerates an existing DB with missing index tables", async () => {
  const root = makeRoot()
  const dbPath = indexDbPath(root)
  try {
    mkdirSync(path.dirname(dbPath), { recursive: true })
    const db = new Database(dbPath)
    db.close()

    const body = parseToolResult(await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
    }))

    assert.equal(body.local_db.exists, true)
    assert.equal(body.lexical_index.available, false)
    assert.equal(body.document_vectors.state, "missing")
    assert.equal(body.document_vectors.chunks_total, 0)
    assert.equal(body.document_vectors.vectors_indexed, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
