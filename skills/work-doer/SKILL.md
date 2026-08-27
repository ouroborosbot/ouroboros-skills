---
name: work-doer
description: Execute an authorized engineering task with strict TDD, complete changed-production coverage, and the smallest implementation that reaches a tested branch.
---

# Work Doer

Read the task or doing document, current source, and repository instructions. Work in the task branch/worktree and keep durable state current.

## Before writes

Verify that the request authorizes writes to this repository and that an approved contribution path and required identity exist before editing. Read-only requests, unapproved repositories, and identity mismatches make no writes. First-person future wording such as "I'll send it" preserves operator ownership; it does not delegate a live send.

## Build each slice

For every behavior change:

1. Trace the real flow and callers before editing.
2. Write the smallest falsifiable test or deterministic fixture first.
3. Run it and observe the intended red, then freeze the test.
4. Apply Ponytail's ladder and implement the minimal green vertical change.
5. Refactor only while the frozen test remains green.

Every behavior change uses strict TDD: test first, record the observed red, freeze the test, implement the minimal green, then refactor while green. Declarative skill or manifest behavior starts with a failing contract or behavioral fixture rather than a manufactured production module.

New and modified production logic requires 100% statements, branches, and functions coverage, including error, null, empty, boundary, and negative paths. Do not exclude a changed production file from coverage. For outbound adapters, capture and assert the actual request shape separately from response handling. UI and rendered-output changes also invoke `visual-qa-dogfood`.

Never simplify away requested scope, error handling, validation, accessibility, evidence, or terminal delivery. Never create an abstraction for one implementation or a dependency for a few clear lines. Commit meaningful behavior changes, not process-only or no-change checkpoints.

## Finish

Keep durable state current at meaningful checkpoints: update the doing document when one exists; otherwise update the task card.

At the branch boundary, record the exact build and full suite commands and results, confirm no new warnings, and run one fresh branch review. Fix blocker and major findings once and rerun affected proof. Then invoke `work-merger` and keep control through PR, CI repair, merge, release/install, consuming-surface smoke, cleanup, and continuation scan.
