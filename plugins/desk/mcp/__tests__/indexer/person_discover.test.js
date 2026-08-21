// person_discover — Unit 1.3: indexer read-transparency under the --person
// write-prefix.
//
// When content lives at `desks/<alias>/<track>/<slug>/task.md`, discovery must
// still find it (the walker is recursive by filename), AND classify() must
// attribute the correct `track`/`task_slug` — stripping the two leading
// `desks/<alias>` segments rather than reporting track="desks".

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { discover, classify } from "../../src/indexer/discover.js"

async function writeFile(root, rel, body) {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, "utf8")
  return abs
}

async function mkRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "desk-person-discover-"))
}

// ── classify() under the person prefix ───────────────────────────────────────

test("classify strips desks/<alias>/ and reports the real track + slug", () => {
  const c = classify(path.join("desks", "ari", "europe-trip", "book-flights", "task.md"))
  assert.equal(c.kind, "task")
  assert.equal(c.track, "europe-trip", "track must be the real track, not 'desks'")
  assert.equal(c.task_slug, "book-flights")
})

test("classify still works for the OFF (non-person) shape", () => {
  const c = classify(path.join("europe-trip", "book-flights", "task.md"))
  assert.equal(c.kind, "task")
  assert.equal(c.track, "europe-trip")
  assert.equal(c.task_slug, "book-flights")
})

test("classify attributes person-prefixed track.md to the real track", () => {
  const c = classify(path.join("desks", "ari", "europe-trip", "track.md"))
  assert.equal(c.kind, "track")
  assert.equal(c.track, "europe-trip")
  assert.equal(c.task_slug, null)
})

test("classify attributes track-local friction under desks/<alias>/ correctly", () => {
  const c = classify(path.join("desks", "ari", "europe-trip", "_friction", "2026-06-10-x.md"))
  assert.equal(c.kind, "friction")
  assert.equal(c.track, "europe-trip", "friction track must skip the desks/<alias> prefix")
})

test("classify keeps cross-cutting friction under desks/<alias>/_meta/friction.md as friction", () => {
  const c = classify(path.join("desks", "ari", "_meta", "friction.md"))
  assert.equal(c.kind, "friction")
  assert.equal(c.track, null)
})

test("classify keeps lessons under desks/<alias>/_meta/tips/<topic>.md as lesson", () => {
  const c = classify(path.join("desks", "ari", "_meta", "tips", "emu.md"))
  assert.equal(c.kind, "lesson")
})

// ── discover() spans every person's subtree ───────────────────────────────────

test("discover finds task docs across multiple persons' desks", async () => {
  const root = await mkRoot()
  await writeFile(root, path.join("desks", "ari", "t", "s", "task.md"), "---\ntitle: A\n---\nbody")
  await writeFile(root, path.join("desks", "bob", "t2", "s2", "task.md"), "---\ntitle: B\n---\nbody")

  const docs = await discover(root)
  const byPath = new Map(docs.map((d) => [d.path, d]))

  const ariPath = path.join("desks", "ari", "t", "s", "task.md")
  const bobPath = path.join("desks", "bob", "t2", "s2", "task.md")
  assert.ok(byPath.has(ariPath), "ari's task.md must be discovered")
  assert.ok(byPath.has(bobPath), "bob's task.md must be discovered")

  // ...and correctly attributed (track is the real track, not "desks").
  assert.equal(byPath.get(ariPath).track, "t")
  assert.equal(byPath.get(ariPath).task_slug, "s")
  assert.equal(byPath.get(bobPath).track, "t2")
  assert.equal(byPath.get(bobPath).task_slug, "s2")
})

test("discover still finds + attributes OFF-mode (top-level) task docs unchanged", async () => {
  const root = await mkRoot()
  await writeFile(root, path.join("legacy-track", "legacy-slug", "task.md"), "---\ntitle: L\n---\nx")
  const docs = await discover(root)
  const d = docs.find((x) => x.path === path.join("legacy-track", "legacy-slug", "task.md"))
  assert.ok(d)
  assert.equal(d.track, "legacy-track")
  assert.equal(d.task_slug, "legacy-slug")
})

test("discover finds person-prefixed track cards", async () => {
  const root = await mkRoot()
  const trackPath = path.join("desks", "ari", "europe-trip", "track.md")
  await writeFile(root, trackPath, "---\nstatus: active\n---\n# Europe trip")

  const docs = await discover(root)
  const track = docs.find((doc) => doc.path === trackPath)
  assert.ok(track)
  assert.equal(track.kind, "track")
  assert.equal(track.track, "europe-trip")
  assert.equal(track.task_slug, null)
})
