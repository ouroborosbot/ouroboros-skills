import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as os from "node:os"
import * as path from "node:path"
import { promises as fs } from "node:fs"

import { closeDb, getMeta, openDb, setMeta } from "../../src/db/init.js"
import { discover } from "../../src/indexer/discover.js"
import {
  fileStatOrNull,
  isIndexFresh,
  rebuildIndex,
} from "../../src/indexer/index.js"
import { ensureIndex } from "../../src/server-helpers.js"

const indexOpts = {
  skipEmbed: true,
  snapshots: false,
  vectorPacks: false,
}

async function mkRoot(prefix = "desk-stat-freshness-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function writeFile(root, relPath, body) {
  const absPath = path.join(root, relPath)
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  await fs.writeFile(absPath, body, "utf8")
  return absPath
}

async function captureMarkdownReads(root, action) {
  const originalReadFile = fs.readFile
  const reads = []
  fs.readFile = async (file, ...args) => {
    const resolved = path.resolve(String(file))
    if (
      resolved.startsWith(`${path.resolve(root)}${path.sep}`) &&
      resolved.toLowerCase().endsWith(".md")
    ) {
      reads.push(path.relative(root, resolved).split(path.sep).join("/"))
    }
    return originalReadFile(file, ...args)
  }
  try {
    return { value: await action(), reads }
  } finally {
    fs.readFile = originalReadFile
  }
}

async function writeTombstone(pluginRoot, doc) {
  const ledgerDir = path.join(pluginRoot, "artifacts", "tombstones")
  await fs.mkdir(ledgerDir, { recursive: true })
  await fs.writeFile(
    path.join(ledgerDir, "tombstones.jsonl"),
    `${JSON.stringify({
      schema_version: 1,
      document_path: doc.path,
      document_hash: `sha256:${doc.hash}`,
      reason: "redacted",
      redacted_at: "2026-08-21T00:00:00.000Z",
      effective_from: "2026-08-21T00:00:00.000Z",
      artifact_rotation_id: "unit-3-stat-freshness",
      actor: "unit-test",
    })}\n`,
    "utf8",
  )
}

test("warm no-op freshness performs zero Markdown body reads", async () => {
  const root = await mkRoot()
  await writeFile(root, "trackA/task-1/task.md", "warm task body")
  await writeFile(root, "references/context.md", "warm reference body")
  await rebuildIndex(root, indexOpts)

  const db = openDb(root)
  try {
    const check = await captureMarkdownReads(root, () => isIndexFresh(root, db))
    assert.equal(check.value, true)
    assert.deepEqual(check.reads, [])
  } finally {
    closeDb(db)
  }
})

test("literal backslash filenames do not collide with nested paths on POSIX", async (t) => {
  if (path.sep !== "/") {
    t.skip("POSIX-only filename case")
    return
  }
  const root = await mkRoot()
  const literalPath = "trackA\\task-1\\task.md"
  const nestedPath = "trackA/task-1/task.md"
  await writeFile(root, literalPath, "literal backslash body")
  await writeFile(root, nestedPath, "nested path body")

  await rebuildIndex(root, indexOpts)
  const db = openDb(root)
  try {
    assert.deepEqual(
      db.prepare("SELECT path FROM docs ORDER BY path").all(),
      [{ path: nestedPath }, { path: literalPath }],
    )
    assert.equal(await isIndexFresh(root, db), true)
  } finally {
    closeDb(db)
  }
})

test("statable unreadable Markdown does not disable warm freshness", async () => {
  const root = await mkRoot()
  await writeFile(root, "trackA/task-1/task.md", "visible body")
  const lockedPath = await writeFile(root, "references/locked.md", "locked body")
  const originalReadFile = fs.readFile
  let markdownReads = []
  fs.readFile = async (file, ...args) => {
    const resolved = path.resolve(String(file))
    if (resolved.toLowerCase().endsWith(".md")) {
      markdownReads.push(path.relative(root, resolved).split(path.sep).join("/"))
    }
    if (resolved === lockedPath) {
      const error = new Error("unreadable")
      error.code = "EACCES"
      throw error
    }
    return originalReadFile(file, ...args)
  }
  try {
    await rebuildIndex(root, indexOpts)
    markdownReads = []
    const first = await ensureIndex(root, indexOpts)
    assert.equal(first.built, false)
    assert.equal(first.reason, "fresh")
    assert.deepEqual(markdownReads, [])

    const stat = await fs.stat(lockedPath)
    await fs.utimes(
      lockedPath,
      new Date(stat.atimeMs + 1000),
      new Date(stat.mtimeMs + 1000),
    )
    markdownReads = []
    const refreshed = await ensureIndex(root, indexOpts)
    assert.equal(refreshed.built, false)
    assert.equal(refreshed.reason, "fresh")
    assert.ok(markdownReads.includes("references/locked.md"))
    assert.ok(markdownReads.includes("trackA/task-1/task.md"))

    markdownReads = []
    const settled = await ensureIndex(root, indexOpts)
    assert.equal(settled.built, false)
    assert.deepEqual(markdownReads, [])
  } finally {
    fs.readFile = originalReadFile
  }
})

test("mtime-only drift triggers one exact refresh and then returns to stat-only freshness", async () => {
  const root = await mkRoot()
  const docPath = await writeFile(root, "trackA/task-1/task.md", "same task body")
  await rebuildIndex(root, indexOpts)
  const stat = await fs.stat(docPath)
  const changed = new Date(stat.mtimeMs + 5000)
  await fs.utimes(docPath, changed, changed)

  const first = await captureMarkdownReads(root, () => ensureIndex(root, indexOpts))
  assert.equal(first.value.built, false)
  assert.equal(first.value.reason, "fresh")
  assert.ok(first.reads.includes("trackA/task-1/task.md"))

  const second = await captureMarkdownReads(root, () => ensureIndex(root, indexOpts))
  assert.equal(second.value.built, false)
  assert.equal(second.value.reason, "fresh")
  assert.deepEqual(second.reads, [])
})

test("same-mtime rewrites still invalidate the warm fingerprint", async () => {
  const root = await mkRoot()
  const docPath = await writeFile(root, "trackA/task-1/task.md", "alpha task body")
  const preservedTime = new Date("2026-08-21T00:00:00.000Z")
  await fs.utimes(docPath, preservedTime, preservedTime)
  await rebuildIndex(root, indexOpts)
  const before = await fs.stat(docPath)
  await new Promise((resolve) => setTimeout(resolve, 5))
  await fs.writeFile(docPath, "omega task body", "utf8")
  await fs.utimes(docPath, preservedTime, preservedTime)
  const after = await fs.stat(docPath)
  assert.equal(after.mtimeMs, before.mtimeMs)
  assert.notEqual(after.ctimeMs, before.ctimeMs)

  const refresh = await captureMarkdownReads(root, () =>
    ensureIndex(root, indexOpts)
  )
  assert.equal(refresh.value.built, true)
  assert.equal(refresh.value.reason, "stale")
  assert.ok(refresh.reads.includes("trackA/task-1/task.md"))

  const settled = await captureMarkdownReads(root, () =>
    ensureIndex(root, indexOpts)
  )
  assert.equal(settled.value.built, false)
  assert.deepEqual(settled.reads, [])
})

test("path-set drift triggers exact refresh for added and deleted Markdown", async () => {
  const root = await mkRoot()
  await writeFile(root, "trackA/task-1/task.md", "first task body")
  await writeFile(root, "trackB/task-2/task.md", "second task body")
  await rebuildIndex(root, indexOpts)

  const addedPath = await writeFile(root, "references/old-note.md", "old reference body")
  const old = new Date("2000-01-01T00:00:00.000Z")
  await fs.utimes(addedPath, old, old)
  const added = await captureMarkdownReads(root, () => ensureIndex(root, indexOpts))
  assert.equal(added.value.built, true)
  assert.ok(added.reads.includes("references/old-note.md"))

  await fs.unlink(path.join(root, "trackB", "task-2", "task.md"))
  const deleted = await captureMarkdownReads(root, () => ensureIndex(root, indexOpts))
  assert.equal(deleted.value.built, true)
  assert.ok(deleted.reads.length > 0)

  const settled = await captureMarkdownReads(root, () => ensureIndex(root, indexOpts))
  assert.equal(settled.value.built, false)
  assert.deepEqual(settled.reads, [])
})

test("transient stat failures fall back to exact discovery", async (t) => {
  const root = await mkRoot()
  const docPath = await writeFile(root, "references/context.md", "context body")
  await rebuildIndex(root, indexOpts)
  const stat = fs.stat.bind(fs)
  let failed = false
  t.mock.method(fs, "stat", async (file, ...args) => {
    if (file === docPath && !failed) {
      failed = true
      const error = new Error("transient metadata race")
      error.code = "EACCES"
      throw error
    }
    return stat(file, ...args)
  })

  const db = openDb(root)
  try {
    const recovered = await captureMarkdownReads(root, () =>
      isIndexFresh(root, db)
    )
    assert.equal(recovered.value, true)
    assert.ok(recovered.reads.includes("references/context.md"))
    const settled = await captureMarkdownReads(root, () =>
      isIndexFresh(root, db)
    )
    assert.equal(settled.value, true)
    assert.deepEqual(settled.reads, [])
  } finally {
    closeDb(db)
  }
})

test("rebuild leaves freshness metadata stale when the stat inventory never settles", async (t) => {
  const root = await mkRoot()
  const docPath = await writeFile(root, "references/context.md", "context body")
  const stat = fs.stat.bind(fs)
  let calls = 0
  t.mock.method(fs, "stat", async (file, ...args) => {
    const value = await stat(file, ...args)
    if (file !== docPath) return value
    calls += 1
    const generation = calls <= 3 ? 0 : calls <= 6 ? 1 : 2
    return {
      dev: value.dev,
      ino: value.ino,
      size: value.size,
      mtimeMs: value.mtimeMs + generation,
      ctimeMs: value.ctimeMs + generation,
    }
  })

  const summary = await rebuildIndex(root, indexOpts)
  assert.equal(summary.docs_indexed, 1)
  const db = openDb(root)
  try {
    assert.equal(getMeta(db, "document_stat_inventory_hash"), null)
  } finally {
    closeDb(db)
  }
})

test("unstable stat inventories degrade to exact freshness without throwing", async (t) => {
  const root = await mkRoot()
  const docPath = await writeFile(root, "references/context.md", "context body")
  await rebuildIndex(root, indexOpts)
  const stat = fs.stat.bind(fs)
  let calls = 0
  const generations = [1, 1, 1, 2, 2, 2, 3]
  t.mock.method(fs, "stat", async (file, ...args) => {
    const value = await stat(file, ...args)
    if (file !== docPath) return value
    const cycle = Math.floor(calls / generations.length) * 3
    const generation = cycle + generations[calls % generations.length]
    calls += 1
    return {
      dev: value.dev,
      ino: value.ino,
      size: value.size,
      mtimeMs: value.mtimeMs + generation,
      ctimeMs: value.ctimeMs + generation,
    }
  })

  const first = await captureMarkdownReads(root, () =>
    ensureIndex(root, indexOpts)
  )
  assert.equal(first.value.built, false)
  assert.equal(first.value.reason, "fresh")
  assert.ok(first.reads.includes("references/context.md"))

  const second = await captureMarkdownReads(root, () =>
    ensureIndex(root, indexOpts)
  )
  assert.equal(second.value.built, false)
  assert.equal(second.value.reason, "fresh")
  assert.ok(second.reads.includes("references/context.md"))
})

test("readable documents survive transient absence from stat inventory", async (t) => {
  const root = await mkRoot()
  const docPath = await writeFile(root, "references/context.md", "context body")
  await rebuildIndex(root, indexOpts)
  const stat = fs.stat.bind(fs)
  let calls = 0
  t.mock.method(fs, "stat", async (file, ...args) => {
    if (file !== docPath) return stat(file, ...args)
    calls += 1
    if (calls === 1 || calls === 4 || calls === 7) {
      const error = new Error("transient metadata race")
      error.code = "EACCES"
      throw error
    }
    return stat(file, ...args)
  })

  const summary = await rebuildIndex(root, indexOpts)
  assert.equal(summary.docs_removed, 0)
  assert.equal(summary.docs_skipped, 1)

  const db = openDb(root)
  try {
    assert.deepEqual(
      db.prepare("SELECT path FROM docs").all(),
      [{ path: "references/context.md" }],
    )
    assert.equal(getMeta(db, "document_stat_inventory_hash"), null)
  } finally {
    closeDb(db)
  }
})

test("unstable rebuilds still purge tombstoned and disk-deleted documents", async (t) => {
  const root = await mkRoot()
  const pluginRoot = await mkRoot("desk-stat-unstable-purge-")
  const writerPath = await writeFile(root, "references/writer.md", "writer body")
  await writeFile(root, "references/redacted.md", "redacted body")
  const deletedPath = await writeFile(root, "references/deleted.md", "deleted body")
  await rebuildIndex(root, indexOpts)
  const redactedDoc = (await discover(root))
    .find((doc) => doc.path === "references/redacted.md")
  await writeTombstone(pluginRoot, redactedDoc)
  await fs.unlink(deletedPath)

  const stat = fs.stat.bind(fs)
  let calls = 0
  const generations = [1, 1, 1, 2, 2, 2, 3]
  t.mock.method(fs, "stat", async (file, ...args) => {
    const value = await stat(file, ...args)
    if (file !== writerPath) return value
    const generation = generations[calls % generations.length]
    calls += 1
    return {
      dev: value.dev,
      ino: value.ino,
      size: value.size,
      mtimeMs: value.mtimeMs + generation,
      ctimeMs: value.ctimeMs + generation,
    }
  })

  const result = await ensureIndex(root, {
    ...indexOpts,
    tombstones: { pluginRoot },
  })
  assert.equal(result.built, true)
  assert.equal(result.reason, "stale")
  assert.equal(result.summary.docs_removed, 2)
  assert.equal(result.summary.docs_tombstoned, 1)

  const db = openDb(root)
  try {
    assert.deepEqual(
      db.prepare("SELECT path FROM docs ORDER BY path").all(),
      [{ path: "references/writer.md" }],
    )
    assert.equal(getMeta(db, "document_stat_inventory_hash"), null)
  } finally {
    closeDb(db)
  }
})

test("ignored Markdown stat drift does not invalidate a warm index", async () => {
  const root = await mkRoot()
  await writeFile(root, ".gitignore", "_secrets/\n")
  await writeFile(root, "references/visible.md", "visible body")
  const ignoredPath = await writeFile(root, "_secrets/private.md", "private body")
  await rebuildIndex(root, indexOpts)

  const stat = await fs.stat(ignoredPath)
  const changed = new Date(stat.mtimeMs + 5000)
  await fs.utimes(ignoredPath, changed, changed)
  const check = await captureMarkdownReads(root, () => ensureIndex(root, indexOpts))

  assert.equal(check.value.built, false)
  assert.equal(check.value.reason, "fresh")
  assert.deepEqual(check.reads, [])
})

test("grammar and tombstone drift each trigger one exact refresh", async () => {
  const grammarRoot = await mkRoot()
  await writeFile(grammarRoot, "trackA/task-1/task.md", "grammar body")
  await rebuildIndex(grammarRoot, indexOpts)
  const grammarDb = openDb(grammarRoot)
  try {
    setMeta(grammarDb, "discovery_grammar_version", "1")
  } finally {
    closeDb(grammarDb)
  }

  const grammarRefresh = await captureMarkdownReads(grammarRoot, () =>
    ensureIndex(grammarRoot, indexOpts)
  )
  assert.equal(grammarRefresh.value.built, true)
  assert.ok(grammarRefresh.reads.includes("trackA/task-1/task.md"))
  const grammarSettled = await captureMarkdownReads(grammarRoot, () =>
    ensureIndex(grammarRoot, indexOpts)
  )
  assert.equal(grammarSettled.value.built, false)
  assert.deepEqual(grammarSettled.reads, [])

  const tombstoneRoot = await mkRoot()
  const pluginRoot = await mkRoot("desk-stat-tombstones-")
  await writeFile(tombstoneRoot, "references/redacted.md", "redacted body")
  await rebuildIndex(tombstoneRoot, indexOpts)
  const [doc] = await discover(tombstoneRoot)
  await writeTombstone(pluginRoot, doc)

  const tombstoneOpts = {
    ...indexOpts,
    tombstones: { pluginRoot },
  }
  const tombstoneRefresh = await captureMarkdownReads(tombstoneRoot, () =>
    ensureIndex(tombstoneRoot, tombstoneOpts)
  )
  assert.equal(tombstoneRefresh.value.built, true)
  assert.ok(tombstoneRefresh.reads.includes("references/redacted.md"))
  const tombstoneSettled = await captureMarkdownReads(tombstoneRoot, () =>
    ensureIndex(tombstoneRoot, tombstoneOpts)
  )
  assert.equal(tombstoneSettled.value.built, false)
  assert.deepEqual(tombstoneSettled.reads, [])
})

test("non-matching tombstone drift refreshes metadata without rebuilding content", async () => {
  const root = await mkRoot()
  const pluginRoot = await mkRoot("desk-stat-unrelated-tombstone-")
  await writeFile(root, "references/visible.md", "visible body")
  const opts = {
    ...indexOpts,
    tombstones: { pluginRoot },
  }
  await rebuildIndex(root, opts)
  await writeTombstone(pluginRoot, {
    path: "references/missing.md",
    hash: "a".repeat(64),
  })

  const refresh = await captureMarkdownReads(root, () => ensureIndex(root, opts))
  assert.equal(refresh.value.built, false)
  assert.equal(refresh.value.reason, "fresh")
  assert.ok(refresh.reads.includes("references/visible.md"))

  const settled = await captureMarkdownReads(root, () => ensureIndex(root, opts))
  assert.equal(settled.value.built, false)
  assert.deepEqual(settled.reads, [])
})

test("stat-only freshness does not mask derived-index corruption", async () => {
  const root = await mkRoot()
  await writeFile(root, "trackA/task-1/task.md", "task body")
  await writeFile(root, "trackA/task-1/planning.md", "planning body")
  await rebuildIndex(root, indexOpts)

  const chunkDb = openDb(root)
  try {
    assert.equal(await isIndexFresh(root, chunkDb), true)
    chunkDb.prepare("DELETE FROM chunks").run()
    const corrupted = await captureMarkdownReads(root, () =>
      isIndexFresh(root, chunkDb)
    )
    assert.equal(corrupted.value, false)
    assert.ok(corrupted.reads.length > 0)
  } finally {
    closeDb(chunkDb)
  }

  await rebuildIndex(root, indexOpts)
  const ftsDb = openDb(root)
  try {
    assert.equal(await isIndexFresh(root, ftsDb), true)
    const chunk = ftsDb
      .prepare("SELECT id, text FROM chunks ORDER BY id LIMIT 1")
      .get()
    ftsDb.prepare(
      "INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)",
    ).run(chunk.id, chunk.text)
    ftsDb.prepare(
      "INSERT INTO chunks_fts(rowid, text) VALUES(?, ?)",
    ).run(chunk.id, "wrong indexed terms")
    const corrupted = await captureMarkdownReads(root, () =>
      isIndexFresh(root, ftsDb)
    )
    assert.equal(corrupted.value, false)
    assert.ok(corrupted.reads.length > 0)
  } finally {
    closeDb(ftsDb)
  }
})

test("freshness metadata remains parseable after stat-only checks", async () => {
  const root = await mkRoot()
  await writeFile(root, "trackA/task-1/task.md", "metadata body")
  await rebuildIndex(root, indexOpts)
  const db = openDb(root)
  try {
    assert.equal(await isIndexFresh(root, db), true)
    const lastIndexedAt = getMeta(db, "last_indexed_at")
    assert.equal(Number.isNaN(Date.parse(lastIndexedAt)), false)
    setMeta(db, "last_indexed_at", "not-a-date")
    assert.equal(await isIndexFresh(root, db), false)
    setMeta(db, "last_indexed_at", lastIndexedAt)
    const recovered = await captureMarkdownReads(root, () =>
      isIndexFresh(root, db)
    )
    assert.equal(recovered.value, true)
    assert.ok(recovered.reads.includes("trackA/task-1/task.md"))
    const settled = await captureMarkdownReads(root, () =>
      isIndexFresh(root, db)
    )
    assert.equal(settled.value, true)
    assert.deepEqual(settled.reads, [])
  } finally {
    closeDb(db)
  }
})

test("storage fingerprint errors remain explicit", async (t) => {
  t.mock.method(fs, "stat", async () => {
    const error = new Error("blocked")
    error.code = "EACCES"
    throw error
  })
  await assert.rejects(
    fileStatOrNull("/blocked/index.sqlite-wal"),
    (error) => error.code === "EACCES" && error.message === "blocked",
  )
})
