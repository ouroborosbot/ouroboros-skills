---
name: work-orchestration
description: "Route authorized work through only the phases it needs, validate cross-repo dependencies, isolate parallel worktrees, and leave lifecycle state to Desk."
---

# Work Orchestration

Worker remains the engineer; the `work-*` skills are optional workflow tools.

| Shape | Route |
| --- | --- |
| Clear, local, low risk | `work-doer` → `work-merger` |
| Coordinated behavior change | short `work-planner` → `work-doer` → `work-merger` |
| Ambiguous, novel, or high risk | `work-ideator` → `work-planner` → `work-doer` → `work-merger` |

Apply Ponytail inside coding and review. Skip a phase when its output would only restate what is already known. Use one fresh cold branch review at the diff boundary; planning-stage review follows the Planner rule below.

## Before mutation

Verify repository authority and the approved contribution path before any branch, worktree, or source edit. A read-only request or unapproved repository does not mutate.

## Cross-repo execution

The cross-repo plan owns an explicit DAG. `repos[]` order is never dependency order.

Before mutation, reject a dependency cycle or unknown dependency. A failed predecessor blocks its dependents while independent ready nodes continue.

Each repository gets its own branch and merge cycle. Independent parallel branches use separate worktrees and explicit `git -C <worktree>` commands. Shared and version files serialize or merge; never force-push through a coordinated-file conflict.

An explicit producer state named `needs-human-approval` is a `hard exception`; do not replace required human approval with agent review. Use `needs reviewer gate` only when the producer explicitly permits machine review.

Mechanical review uses the Planner reviewer rule. A nested host emits the required briefs and returns review to its parent rather than self-certifying.

Desk owns task, iteration, and archive state. Work Orchestration routes child skills and does not duplicate that lifecycle.

The terminal state is merged, released or installed as applicable, smoked through the consuming surface, cleaned, and followed by an empty or out-of-scope continuation scan.
