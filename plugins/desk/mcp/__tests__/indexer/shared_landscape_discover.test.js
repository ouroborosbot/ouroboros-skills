// shared_landscape_discover — shared-workspace read-across: docs under
// `_shared/` (the team-neutral facts + agreed decisions) must be indexed and
// searchable, so `desk_search` spans the whole crew repo, not just the
// task-doc vocabulary.
//
// This is the read side of the shared-workspace model: every agent READS all
// of `desks/*/` AND all of `_shared/`. The write side (`--person` prefix) was
// already covered; this proves the indexer actually picks up `_shared/`
// content, which has arbitrary filenames (`glossary.md`, `nova-and-twa.md`)
// that don't match the task-doc basename vocabulary.
//
// Behavior-preserving guarantee: single-desk workspaces have NO `_shared/`
// dir, so this is purely additive — a no-op for existing consumers.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  discover,
  classify,
  isIndexable,
} from "../../src/indexer/discover.js"

async function writeFile(root, rel, body) {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, "utf8")
  return abs
}

async function mkRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "desk-shared-discover-"))
}

// ── isIndexable: _shared/ docs count regardless of filename ───────────────────

test("isIndexable accepts arbitrary .md under _shared/landscape/", () => {
  assert.ok(isIndexable(path.join("_shared", "landscape", "glossary.md")))
  assert.ok(isIndexable(path.join("_shared", "landscape", "nova-and-twa.md")))
})

test("isIndexable accepts .md under _shared/decisions/", () => {
  assert.ok(isIndexable(path.join("_shared", "decisions", "README.md")))
})

test("isIndexable accepts nested .md under _shared/", () => {
  assert.ok(
    isIndexable(path.join("_shared", "landscape", "_raw", "deep", "note.md")),
  )
})

test("isIndexable still rejects non-md under _shared/", () => {
  assert.equal(
    isIndexable(path.join("_shared", "landscape", "_raw", "transcript.txt")),
    false,
  )
})

// ── classify: _shared/ docs report kind=shared (track-less) ───────────────────

test("classify reports a _shared/landscape doc as kind=shared", () => {
  const c = classify(path.join("_shared", "landscape", "glossary.md"))
  assert.equal(c.kind, "shared")
  assert.equal(c.track, null)
  assert.equal(c.task_slug, null)
})

test("classify reports a _shared/decisions doc as kind=shared", () => {
  const c = classify(path.join("_shared", "decisions", "README.md"))
  assert.equal(c.kind, "shared")
})

// ── discover spans _shared/ alongside desks/ ──────────────────────────────────

test("discover finds _shared/landscape facts AND person desk tasks together", async () => {
  const root = await mkRoot()
  await writeFile(
    root,
    path.join("desks", "ari", "t", "s", "task.md"),
    "---\ntitle: A\n---\nbody",
  )
  await writeFile(
    root,
    path.join("_shared", "landscape", "glossary.md"),
    "---\ntitle: Glossary\n---\nCCA = Customer Connect Agent",
  )
  await writeFile(
    root,
    path.join("_shared", "landscape", "nova-and-twa.md"),
    "Nova control flow is a model-driven loop",
  )

  const docs = await discover(root)
  const paths = new Set(docs.map((d) => d.path))

  assert.ok(
    paths.has(path.join("desks", "ari", "t", "s", "task.md")),
    "person task must be discovered",
  )
  assert.ok(
    paths.has(path.join("_shared", "landscape", "glossary.md")),
    "_shared/landscape glossary must be discovered (read-across)",
  )
  assert.ok(
    paths.has(path.join("_shared", "landscape", "nova-and-twa.md")),
    "_shared/landscape facts must be discovered",
  )

  const glossary = docs.find(
    (d) => d.path === path.join("_shared", "landscape", "glossary.md"),
  )
  assert.equal(glossary.kind, "shared")
})

// ── specialized classification remains stable without _shared/ ────────────────

test("discover keeps task classification stable in a single desk", async () => {
  const root = await mkRoot()
  await writeFile(
    root,
    path.join("legacy-track", "legacy-slug", "task.md"),
    "---\ntitle: L\n---\nx",
  )
  const docs = await discover(root)
  assert.equal(docs.length, 1)
  assert.equal(docs[0].kind, "task")
})
