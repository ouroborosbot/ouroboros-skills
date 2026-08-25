---
name: work-doer
description: Execute an engineering task to a tested branch using the smallest complete implementation. Applies Ponytail to coding, uses proof proportional to risk, and hands the finished branch to work-merger.
---

# Work Doer

Read the task or doing document, current source, and repository instructions. Work in the task branch/worktree and keep durable state current.

## Build

For every slice:

1. Trace the real flow and callers before editing.
2. Apply Ponytail's ladder and reuse the highest rung that works.
3. Make the smallest complete vertical change.
4. Leave the smallest falsifiable check that would catch its regression.
5. Commit a meaningful behavior change; do not commit process-only or no-change checkpoints.

Use test-first development for reproduced bugs, non-trivial logic, adapters, trust boundaries, security, destructive/data-loss paths, and public contracts. Trivial declarative edits need validation, not a ritual red/green/refactor triplet. Widen from targeted tests to the full existing suite at the branch boundary.

Never simplify away requested scope, error handling, validation, accessibility, evidence, or terminal delivery. Never create an abstraction for one implementation or a dependency for a few clear lines.

## Finish

Keep durable state current at meaningful checkpoints: update the doing document when one exists; otherwise update the task card. Run one fresh branch review when the diff is ready; fix blocker/major findings once and rerun affected proof. Then invoke `work-merger` and keep control through PR, CI repair, merge, release/install, consuming-surface smoke, cleanup, and continuation scan.
