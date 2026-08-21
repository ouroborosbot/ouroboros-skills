import test from "node:test"
import assert from "node:assert/strict"

import { computeRefs } from "../../src/indexer/refs.js"

test("computeRefs covers structural, historical, missing, and duplicate edges", () => {
  const docs = [
    {
      id: "task-a",
      path: "track-a/task-a/task.md",
      kind: "task",
      track: "track-a",
      task_slug: "task-a",
      frontmatter: {
        iterations: {
          history: [
            null,
            "invalid",
            {},
            { path: "" },
            { path: "planning.md", kind: "predecessor" },
            { path: "planning.md" },
            { path: "planning.md" },
            { path: "/track-a/task-a/doing.md", kind: "doing" },
            { path: "missing.md", kind: "missing" },
          ],
        },
      },
    },
    {
      id: "planning-a",
      path: "track-a/task-a/planning.md",
      kind: "planning",
      track: "track-a",
      task_slug: "task-a",
    },
    {
      id: "doing-a",
      path: "track-a/task-a/doing.md",
      kind: "doing",
      track: "track-a",
      task_slug: "task-a",
    },
    {
      id: "feedback-a",
      path: "track-a/task-a/feedback.md",
      kind: "feedback",
      track: "track-a",
      task_slug: "task-a",
    },
    {
      id: "task-no-history",
      path: "track-b/task-b/task.md",
      kind: "task",
      track: "track-b",
      task_slug: "task-b",
      frontmatter: {},
    },
    {
      id: "planning-without-task",
      path: "track-c/task-c/planning.md",
      kind: "planning",
      track: "track-c",
      task_slug: "task-c",
    },
    {
      id: "doing-without-task",
      path: "track-c/task-c/doing.md",
      kind: "doing",
      track: "track-c",
      task_slug: "task-c",
    },
    {
      id: "feedback-without-task",
      path: "track-c/task-c/feedback.md",
      kind: "feedback",
      track: "track-c",
      task_slug: "task-c",
    },
    {
      id: "missing-track",
      path: "orphan/planning.md",
      kind: "planning",
      track: null,
      task_slug: "orphan",
    },
    {
      id: "missing-slug",
      path: "orphan/doing.md",
      kind: "doing",
      track: "orphan",
      task_slug: null,
    },
    {
      id: "reference",
      path: "references/note.md",
      kind: "reference",
      track: null,
      task_slug: null,
    },
  ]

  assert.deepEqual(computeRefs(docs), [
    {
      from: "track-a/task-a/planning.md",
      to: "track-a/task-a/task.md",
      ref_kind: "predecessor_of",
    },
    {
      from: "track-a/task-a/planning.md",
      to: "track-a/task-a/task.md",
      ref_kind: "iteration_of",
    },
    {
      from: "track-a/task-a/doing.md",
      to: "track-a/task-a/task.md",
      ref_kind: "doing_of",
    },
    {
      from: "track-a/task-a/planning.md",
      to: "track-a/task-a/task.md",
      ref_kind: "planning_of",
    },
    {
      from: "track-a/task-a/feedback.md",
      to: "track-a/task-a/task.md",
      ref_kind: "feedback_of",
    },
  ])
})

test("computeRefs ignores missing structural and historical targets", () => {
  const docs = [
    {
      path: "track-a/task-a/task.md",
      kind: "task",
      track: "track-a",
      task_slug: "task-a",
      frontmatter: { iterations: { history: [{ path: "missing.md" }] } },
    },
    {
      id: "planning-a",
      path: "orphan-a/planning.md",
      kind: "planning",
      track: null,
      task_slug: "task-a",
    },
    {
      id: "doing-a",
      path: "orphan-b/doing.md",
      kind: "doing",
      track: "track-a",
      task_slug: null,
    },
  ]

  assert.deepEqual(computeRefs(docs), [])
})

test("computeRefs preserves person-scoped shared-workspace prefixes", () => {
  const docs = [
    {
      path: "desks/ari/track-a/task-a/task.md",
      kind: "task",
      track: "track-a",
      task_slug: "task-a",
      frontmatter: {
        iterations: {
          history: [{ path: "planning.md", kind: "predecessor" }],
        },
      },
    },
    {
      path: "desks/ari/track-a/task-a/planning.md",
      kind: "planning",
      track: "track-a",
      task_slug: "task-a",
    },
    {
      path: "desks/ari/track-a/task-a/doing.md",
      kind: "doing",
      track: "track-a",
      task_slug: "task-a",
    },
  ]

  assert.deepEqual(computeRefs(docs), [
    {
      from: "desks/ari/track-a/task-a/planning.md",
      to: "desks/ari/track-a/task-a/task.md",
      ref_kind: "predecessor_of",
    },
    {
      from: "desks/ari/track-a/task-a/planning.md",
      to: "desks/ari/track-a/task-a/task.md",
      ref_kind: "planning_of",
    },
    {
      from: "desks/ari/track-a/task-a/doing.md",
      to: "desks/ari/track-a/task-a/task.md",
      ref_kind: "doing_of",
    },
  ])
})
