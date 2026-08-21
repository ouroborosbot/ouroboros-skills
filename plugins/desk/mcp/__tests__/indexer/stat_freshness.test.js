import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as os from "node:os"
import * as path from "node:path"
import { promises as fs } from "node:fs"

import { closeDb, getMeta, openDb, setMeta } from "../../src/db/init.js"
import { discover } from "../../src/indexer/discover.js"
import { isIndexFresh, rebuildIndex } from "../../src/indexer/index.js"
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

test("mtime-only drift triggers one exact refresh and then returns to stat-only freshness", async () => {
  const root = await mkRoot()
  const docPath = await writeFile(root, "trackA/task-1/task.md", "same task body")
  await rebuildIndex(root, indexOpts)
  const stat = await fs.stat(docPath)
  const changed = new Date(stat.mtimeMs + 5000)
  await fs.utimes(docPath, changed, changed)

  const first = await captureMarkdownReads(root, () => ensureIndex(root, indexOpts))
  assert.equal(first.value.built, true)
  assert.equal(first.value.reason, "stale")
  assert.ok(first.reads.includes("trackA/task-1/task.md"))

  const second = await captureMarkdownReads(root, () => ensureIndex(root, indexOpts))
  assert.equal(second.value.built, false)
  assert.equal(second.value.reason, "fresh")
  assert.deepEqual(second.reads, [])
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
    assert.equal(Number.isNaN(Date.parse(getMeta(db, "last_indexed_at"))), false)
  } finally {
    closeDb(db)
  }
})
