// thread.test.js — desk_thread provenance walk via refs_graph (Unit 6).
//
// Strategy: build small fixture desks on disk, run the real indexer (with
// skipEmbed: true — desk_thread doesn't need embeddings), then exercise
// desk_thread directly. A few tests bypass the indexer and inject synthetic
// refs_graph edges via direct SQL — useful for stressing the BFS itself
// (deep chains, cycles) without depending on the indexer's edge inference.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  __threadInternalsForTests,
  desk_thread,
  describeRefKind,
} from "../../src/tools/thread.js"
import { openDb, closeDb } from "../../src/db/init.js"
import { rebuildIndex } from "../../src/indexer/index.js"
import { createMaintenanceCoordinator } from "../../src/indexer/maintenance.js"

async function mkTempDeskRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "desk-thread-test-"))
}

async function writeFile(root, rel, body) {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, "utf8")
}

/**
 * Index a fixture desk without touching Ollama. Returns nothing useful;
 * desk_thread will open the same DB.
 */
async function indexNoEmbed(root) {
  return rebuildIndex(root, { skipEmbed: true })
}

/**
 * Insert a filesystem-backed synthetic doc into the DB. Returns the row id.
 * Used by tests that want to craft refs_graph by hand.
 */
async function insertSyntheticDoc(
  root,
  db,
  { path: docPath, kind, updated_at, track, task_slug },
) {
  const body = `synthetic ${docPath}\n`
  await writeFile(root, docPath, body)
  const row = db
    .prepare(
      `INSERT INTO docs (path, kind, track, task_slug, status, schema_version,
                         created_at, updated_at, hash, mtime, frontmatter)
       VALUES (?, ?, ?, ?, NULL, 1, NULL, ?, ?, ?, '{}')
       RETURNING id`,
    )
    .get(
      docPath,
      kind,
      track ?? null,
      task_slug ?? null,
      updated_at ?? null,
      createHash("sha256").update(body).digest("hex"),
      0,
    )
  return row.id
}

function insertEdge(db, srcId, dstId, refKind) {
  db.prepare(
    "INSERT INTO refs_graph (src_doc_id, dst_doc_id, ref_kind) VALUES (?, ?, ?)",
  ).run(srcId, dstId, refKind)
}

// ---------------------------------------------------------------------------
// Happy path — task.md and planning.md, walk one hop.
// ---------------------------------------------------------------------------

test("desk_thread — one hop forward: planning.md → task.md", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/my-task/task.md",
    "---\nstatus: processing\nschema_version: 1\nupdated: 2026-04-23\n---\ntask body\n",
  )
  await writeFile(
    root,
    "trackA/my-task/planning.md",
    "---\nschema_version: 1\nupdated: 2026-04-21\n---\nplanning body\n",
  )
  await indexNoEmbed(root)

  const res = await desk_thread({
    deskRoot: root,
    input: { start_path: "trackA/my-task/planning.md", direction: "forward" },
  })

  assert.equal(res.start.path, "trackA/my-task/planning.md")
  assert.equal(res.start.kind, "planning")
  // chain[0] is the start doc; chain[1] is the task.md (hop 1).
  assert.equal(res.chain.length, 2)
  assert.equal(res.chain[0].path, "trackA/my-task/planning.md")
  assert.equal(res.chain[0].hop_distance, 0)
  assert.equal(res.chain[1].path, "trackA/my-task/task.md")
  assert.equal(res.chain[1].hop_distance, 1)
  assert.equal(res.chain[1].ref_kind, "planning_of")
  assert.match(res.chain[1].why_connected, /planning doc of my-task/)
})

// ---------------------------------------------------------------------------
// 2-hop chain (via iteration history).
// ---------------------------------------------------------------------------

test("desk_thread — 2-hop forward chain: doing.md → task.md → iteration entry doc", async () => {
  const root = await mkTempDeskRoot()
  // task.md with an iterations.history entry pointing at planning.md.
  // The indexer's refs.js will draw planning.md -> task.md (planning_of) AND
  // also draw an edge from the history entry path -> task.md, but since the
  // history path points to planning.md, the planning_of edge is what we get.
  // To exercise a real 2-hop chain we use a "predecessor" task linked from
  // the body — but Unit 4's refs only handles structural edges, so the
  // simplest 2-hop is task.md → its planning AND task.md → its doing, with
  // BFS reaching from one sibling to the other through the task hub.
  await writeFile(
    root,
    "trackA/hubbed/task.md",
    "---\nstatus: processing\nschema_version: 1\nupdated: 2026-04-23\n---\nhub body\n",
  )
  await writeFile(
    root,
    "trackA/hubbed/planning.md",
    "---\nschema_version: 1\nupdated: 2026-04-21\n---\nplanning body\n",
  )
  await writeFile(
    root,
    "trackA/hubbed/doing.md",
    "---\nschema_version: 1\nupdated: 2026-04-22\n---\ndoing body\n",
  )
  await indexNoEmbed(root)

  // Start from planning.md, walk both directions to depth 2. We should see
  // planning (hop 0) → task (hop 1, via planning_of forward edge) →
  // doing (hop 2, via doing_of backward edge).
  const res = await desk_thread({
    deskRoot: root,
    input: { start_path: "trackA/hubbed/planning.md", depth: 2, direction: "both" },
  })

  const byPath = new Map(res.chain.map((r) => [r.path, r]))
  assert.equal(byPath.get("trackA/hubbed/planning.md").hop_distance, 0)
  assert.equal(byPath.get("trackA/hubbed/task.md").hop_distance, 1)
  assert.equal(byPath.get("trackA/hubbed/doing.md").hop_distance, 2)
  assert.equal(byPath.get("trackA/hubbed/doing.md").ref_kind, "doing_of")
})

// ---------------------------------------------------------------------------
// Backward direction.
// ---------------------------------------------------------------------------

test("desk_thread — backward from task.md surfaces planning + doing + feedback", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/full/task.md",
    "---\nstatus: processing\nschema_version: 1\nupdated: 2026-04-25\n---\ntask body\n",
  )
  await writeFile(
    root,
    "trackA/full/planning.md",
    "---\nschema_version: 1\nupdated: 2026-04-21\n---\nplanning\n",
  )
  await writeFile(
    root,
    "trackA/full/doing.md",
    "---\nschema_version: 1\nupdated: 2026-04-23\n---\ndoing\n",
  )
  await writeFile(
    root,
    "trackA/full/feedback.md",
    "---\nschema_version: 1\nupdated: 2026-04-24\n---\nfeedback\n",
  )
  await indexNoEmbed(root)

  const res = await desk_thread({
    deskRoot: root,
    input: { start_path: "trackA/full/task.md", direction: "backward" },
  })

  const paths = res.chain.map((r) => r.path)
  assert.ok(paths.includes("trackA/full/task.md"))
  assert.ok(paths.includes("trackA/full/planning.md"))
  assert.ok(paths.includes("trackA/full/doing.md"))
  assert.ok(paths.includes("trackA/full/feedback.md"))
  // Start doc is first.
  assert.equal(res.chain[0].path, "trackA/full/task.md")
  assert.equal(res.chain[0].hop_distance, 0)

  // why_connected references the task slug.
  const planning = res.chain.find((r) => r.path === "trackA/full/planning.md")
  assert.match(planning.why_connected, /planning doc of full/)
  const doing = res.chain.find((r) => r.path === "trackA/full/doing.md")
  assert.match(doing.why_connected, /doing iteration of full/)
  const feedback = res.chain.find((r) => r.path === "trackA/full/feedback.md")
  assert.match(feedback.why_connected, /feedback on full/)
})

// ---------------------------------------------------------------------------
// Both directions: combined.
// ---------------------------------------------------------------------------

test("desk_thread — both direction returns union of forward + backward", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/both/task.md",
    "---\nstatus: processing\nschema_version: 1\nupdated: 2026-04-23\n---\ntask body\n",
  )
  await writeFile(
    root,
    "trackA/both/planning.md",
    "---\nschema_version: 1\nupdated: 2026-04-21\n---\nplanning\n",
  )
  await writeFile(
    root,
    "trackA/both/doing.md",
    "---\nschema_version: 1\nupdated: 2026-04-22\n---\ndoing\n",
  )
  await indexNoEmbed(root)

  // Forward-only from task.md finds nothing (no outgoing edges from task.md
  // in Unit 4's structural-only graph).
  const fwd = await desk_thread({
    deskRoot: root,
    input: { start_path: "trackA/both/task.md", direction: "forward" },
  })
  assert.equal(fwd.chain.length, 1, "forward-only from task.md = just the start")

  // Backward-only finds planning + doing.
  const bwd = await desk_thread({
    deskRoot: root,
    input: { start_path: "trackA/both/task.md", direction: "backward" },
  })
  assert.equal(bwd.chain.length, 3)

  // both = the union; equal to backward here.
  const both = await desk_thread({
    deskRoot: root,
    input: { start_path: "trackA/both/task.md", direction: "both" },
  })
  assert.equal(both.chain.length, 3)
})

// ---------------------------------------------------------------------------
// Depth limit.
// ---------------------------------------------------------------------------

test("desk_thread — depth limit truncates a long chain", async () => {
  // Synthetic 6-doc chain A -> B -> C -> D -> E -> F (all linked via
  // body refs, simulated by manual refs_graph inserts).
  const root = await mkTempDeskRoot()
  // Write one trivial file so the indexer creates the DB + schema.
  await writeFile(
    root,
    "_meta/friction.md",
    "---\nschema_version: 1\n---\nseed\n",
  )
  await indexNoEmbed(root)
  await fs.rm(path.join(root, "_meta", "friction.md"))

  const db = openDb(root)
  try {
    // Wipe the synthetic seed; we want a clean slate.
    db.exec("DELETE FROM refs_graph; DELETE FROM docs;")
    const ids = []
    for (const name of ["A", "B", "C", "D", "E", "F"]) {
      ids.push(
        await insertSyntheticDoc(root, db, {
          path: `chain/${name}.md`,
          kind: "reference",
          updated_at: `2026-04-2${ids.length}`,
        }),
      )
    }
    // A → B → C → D → E → F
    for (let i = 0; i < ids.length - 1; i++) {
      insertEdge(db, ids[i], ids[i + 1], "linked_from_body")
    }
  } finally {
    closeDb(db)
  }
  const maintenance = createMaintenanceCoordinator({
    ensureIndex: async () => ({ built: false, reason: "fresh" }),
  })

  // Depth 2 from A: should reach A, B, C only.
  const res = await desk_thread({
    deskRoot: root,
    input: { start_path: "chain/A.md", depth: 2, direction: "forward" },
    runtimeContext: { maintenanceCoordinator: maintenance },
  })
  const paths = res.chain.map((r) => r.path)
  assert.deepEqual(paths.sort(), ["chain/A.md", "chain/B.md", "chain/C.md"])
  // hop_distances 0, 1, 2.
  const byPath = new Map(res.chain.map((r) => [r.path, r]))
  assert.equal(byPath.get("chain/A.md").hop_distance, 0)
  assert.equal(byPath.get("chain/B.md").hop_distance, 1)
  assert.equal(byPath.get("chain/C.md").hop_distance, 2)
})

// ---------------------------------------------------------------------------
// Cycle: A → B → A doesn't infinite-loop.
// ---------------------------------------------------------------------------

test("desk_thread — cycle in refs_graph doesn't infinite-loop", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "_meta/friction.md",
    "---\nschema_version: 1\n---\nseed\n",
  )
  await indexNoEmbed(root)
  await fs.rm(path.join(root, "_meta", "friction.md"))

  const db = openDb(root)
  try {
    db.exec("DELETE FROM refs_graph; DELETE FROM docs;")
    const aId = await insertSyntheticDoc(root, db, {
      path: "cycle/A.md",
      kind: "reference",
      updated_at: "2026-04-20",
    })
    const bId = await insertSyntheticDoc(root, db, {
      path: "cycle/B.md",
      kind: "reference",
      updated_at: "2026-04-21",
    })
    insertEdge(db, aId, bId, "linked_from_body")
    insertEdge(db, bId, aId, "linked_from_body") // cycle!
  } finally {
    closeDb(db)
  }
  const maintenance = createMaintenanceCoordinator({
    ensureIndex: async () => ({ built: false, reason: "fresh" }),
  })

  const res = await desk_thread({
    deskRoot: root,
    input: { start_path: "cycle/A.md", depth: 10, direction: "forward" },
    runtimeContext: { maintenanceCoordinator: maintenance },
  })
  // Two distinct nodes, BFS terminates, A at hop 0, B at hop 1.
  assert.equal(res.chain.length, 2)
  const byPath = new Map(res.chain.map((r) => [r.path, r]))
  assert.equal(byPath.get("cycle/A.md").hop_distance, 0)
  assert.equal(byPath.get("cycle/B.md").hop_distance, 1)
})

// ---------------------------------------------------------------------------
// not_indexed error.
// ---------------------------------------------------------------------------

test("desk_thread — not_indexed when start_path is missing", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/seed/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\nbody\n",
  )
  await indexNoEmbed(root)

  const res = await desk_thread({
    deskRoot: root,
    input: { start_path: "trackA/missing/task.md" },
  })
  assert.equal(res.error, "not_indexed")
  assert.match(res.note, /isn't in the desk-index/)
})

test("desk_thread — invalid_input when start_path is empty", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/seed/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\nbody\n",
  )
  await indexNoEmbed(root)

  const res = await desk_thread({
    deskRoot: root,
    input: {},
  })
  assert.equal(res.error, "invalid_input")
})

// ---------------------------------------------------------------------------
// Ordering: start first, then hop_distance asc, then updated_at desc.
// ---------------------------------------------------------------------------

test("desk_thread — ordering: start first, then hop_distance asc, then updated_at desc", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "_meta/friction.md",
    "---\nschema_version: 1\n---\nseed\n",
  )
  await indexNoEmbed(root)
  await fs.rm(path.join(root, "_meta", "friction.md"))

  const db = openDb(root)
  try {
    db.exec("DELETE FROM refs_graph; DELETE FROM docs;")
    const startId = await insertSyntheticDoc(root, db, {
      path: "start.md",
      kind: "task",
      updated_at: "2026-05-01",
      task_slug: "start",
    })
    // Two hop-1 neighbours with different updated_at dates; the newer one
    // must come before the older one.
    const newerId = await insertSyntheticDoc(root, db, {
      path: "hop1-newer.md",
      kind: "doing",
      updated_at: "2026-04-25",
      task_slug: "start",
    })
    const olderId = await insertSyntheticDoc(root, db, {
      path: "hop1-older.md",
      kind: "planning",
      updated_at: "2026-04-10",
      task_slug: "start",
    })
    // Hop-2 doc reachable via newerId.
    const farId = await insertSyntheticDoc(root, db, {
      path: "hop2-far.md",
      kind: "reference",
      updated_at: "2026-04-30",
    })
    insertEdge(db, newerId, startId, "doing_of")
    insertEdge(db, olderId, startId, "planning_of")
    insertEdge(db, newerId, farId, "linked_from_body")
  } finally {
    closeDb(db)
  }
  const maintenance = createMaintenanceCoordinator({
    ensureIndex: async () => ({ built: false, reason: "fresh" }),
  })

  const res = await desk_thread({
    deskRoot: root,
    input: { start_path: "start.md", depth: 5, direction: "both" },
    runtimeContext: { maintenanceCoordinator: maintenance },
  })

  // Element 0 must be start.
  assert.equal(res.chain[0].path, "start.md")
  assert.equal(res.chain[0].hop_distance, 0)
  // hop_distance non-decreasing.
  for (let i = 1; i < res.chain.length; i++) {
    assert.ok(
      res.chain[i].hop_distance >= res.chain[i - 1].hop_distance,
      `hop_distance non-decreasing (idx ${i})`,
    )
  }
  // Within hop=1 the newer doc precedes the older one.
  const hop1 = res.chain.filter((r) => r.hop_distance === 1)
  assert.equal(hop1[0].path, "hop1-newer.md")
  assert.equal(hop1[1].path, "hop1-older.md")
})

// ---------------------------------------------------------------------------
// Path normalization: absolute start_path is accepted.
// ---------------------------------------------------------------------------

test("desk_thread — absolute start_path is relativized to deskRoot", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/abs/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\nbody\n",
  )
  await writeFile(
    root,
    "trackA/abs/planning.md",
    "---\nschema_version: 1\n---\nplan\n",
  )
  await indexNoEmbed(root)

  const abs = path.join(root, "trackA/abs/planning.md")
  const res = await desk_thread({
    deskRoot: root,
    input: { start_path: abs, direction: "forward" },
  })
  assert.equal(res.start.path, "trackA/abs/planning.md")
  assert.equal(res.chain[0].path, "trackA/abs/planning.md")
})

test("desk_thread — relative Windows separators resolve to canonical indexed paths", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/windows/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\nbody\n",
  )
  await indexNoEmbed(root)

  const res = await desk_thread({
    deskRoot: root,
    input: {
      start_path: "trackA\\windows\\task.md",
      direction: "forward",
    },
  })
  assert.equal(res.start.path, "trackA/windows/task.md")
})

// ---------------------------------------------------------------------------
// describeRefKind unit.
// ---------------------------------------------------------------------------

test("describeRefKind — known ref_kinds produce expected phrasing", () => {
  assert.equal(describeRefKind("planning_of", "foo"), "planning doc of foo")
  assert.equal(describeRefKind("doing_of", "foo"), "doing iteration of foo")
  assert.equal(describeRefKind("feedback_of", "foo"), "feedback on foo")
  assert.equal(describeRefKind("iteration_of", "foo"), "iteration entry of foo")
  assert.equal(describeRefKind("linked_from_body", "foo"), "linked from body of foo")
  assert.equal(describeRefKind("predecessor", "foo"), "predecessor of foo")
  // Generic <kind>_of fallback.
  assert.equal(describeRefKind("custom_of", "foo"), "custom entry of foo")
  // Missing slug → defaults to "task".
  assert.equal(describeRefKind("planning_of", null), "planning doc of task")
  assert.equal(describeRefKind(null, null), "connected to task")
})

test("thread internals cover depth, path, hydration, and ordering boundaries", () => {
  const {
    buildThreadRows,
    clampDepth,
    compareThreadRows,
    normalizeStartPath,
  } = __threadInternalsForTests
  const root = path.resolve("/tmp/desk-thread-root")

  assert.equal(clampDepth(undefined), 4)
  assert.equal(clampDepth(Number.POSITIVE_INFINITY), 4)
  assert.equal(clampDepth(0), 1)
  assert.equal(clampDepth(99), 32)
  assert.equal(clampDepth(2.9), 2)

  assert.equal(normalizeStartPath(root, ""), "")
  assert.equal(normalizeStartPath(root, "./track/task.md"), "track/task.md")
  assert.equal(normalizeStartPath(root, ".\\track\\task.md"), "track/task.md")
  assert.equal(
    normalizeStartPath(root, path.join(root, "track", "task.md")),
    "track/task.md",
  )
  assert.equal(normalizeStartPath(root, root), "")
  const outside = path.resolve(root, "..", "outside.md")
  assert.equal(normalizeStartPath(root, outside), outside)

  const visited = new Map([
    [1, { hop_distance: 0, ref_kind: null, edge_other_id: null }],
    [2, { hop_distance: 1, ref_kind: "custom_of", edge_other_id: 1 }],
    [3, { hop_distance: 1, ref_kind: null, edge_other_id: 99 }],
    [4, { hop_distance: 1, ref_kind: null, edge_other_id: 99 }],
  ])
  const metaById = new Map([
    [2, {
      path: "self-slug.md",
      kind: "reference",
      task_slug: "self",
      updated_at: null,
    }],
    [3, {
      path: "default-slug.md",
      kind: "reference",
      task_slug: null,
      updated_at: null,
    }],
  ])
  assert.deepEqual(buildThreadRows(visited, metaById, 1), [
    {
      path: "self-slug.md",
      kind: "reference",
      ref_kind: "custom_of",
      hop_distance: 1,
      why_connected: "custom entry of self",
      updated_at: null,
    },
    {
      path: "default-slug.md",
      kind: "reference",
      ref_kind: null,
      hop_distance: 1,
      why_connected: "connected to task",
      updated_at: null,
    },
  ])
  assert.deepEqual(
    buildThreadRows(
      new Map([[1, { hop_distance: 0, ref_kind: null, edge_other_id: null }]]),
      new Map([[1, {
        path: "start.md",
        kind: "task",
        task_slug: "start",
        updated_at: null,
      }]]),
      1,
    ),
    [{
      path: "start.md",
      kind: "task",
      ref_kind: null,
      hop_distance: 0,
      why_connected: "start",
      updated_at: null,
    }],
  )

  const row = (pathValue, hop, updated_at) => ({
    path: pathValue,
    hop_distance: hop,
    updated_at,
  })
  assert.ok(compareThreadRows(row("b", 2, "2026-01-01"), row("a", 1, "2026-01-01")) > 0)
  assert.ok(compareThreadRows(row("a", 1, null), row("b", 1, "2026-01-01")) > 0)
  assert.ok(compareThreadRows(row("a", 1, "2026-01-01"), row("b", 1, null)) < 0)
  assert.ok(compareThreadRows(row("a", 1, null), row("b", 1, null)) < 0)
  assert.ok(
    compareThreadRows(
      row("a", 1, "2026-01-02"),
      row("b", 1, "2026-01-01"),
    ) < 0,
  )
})
