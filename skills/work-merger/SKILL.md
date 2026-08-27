---
name: work-merger
description: Drive an authorized finished branch through current-target sync, exact-head checks, verified remote outcome, release or install, smoke, cleanup, and continuation.
---

# Work Merger

## Before remote writes

Before push, PR, merge, release, or deploy:

1. Verify the approved contribution path, required identity, and remote-action authority.
2. Resolve the actual target from the PR base or repository default; support `main`, `master`, release branches, and explicit bases without assuming one.
3. Fetch that target and classify local changes. Preserve unrelated dirty work; stop only before an operation would overwrite it.
4. Treat partner-operated mutation as unauthorized until an owner SOP or explicit delegation covers it.

## Drive

1. Integrate the current target, resolve conflicts by preserving both intents, and run the repository's existing gates.
2. Push the branch and create or update a PR using the repository's template or recent convention.
3. Use `stay-in-turn` for required checks. Read and fix real failures; push and repeat.
4. Immediately before merge, verify the successful checks belong to the exact PR source SHA.
5. Merge with the repository's enabled method.
6. Separate command exit from remote outcome:
   - nonzero command plus remote `MERGED` continues to verification;
   - nonzero command plus remote open preserves the branch and worktree for repair;
   - zero command plus remote open or queued also preserves state and keeps waiting.
7. Verify remote `MERGED`, then verify the landed commit and tree on the actual target before cleanup.
8. Complete the applicable release or install refresh, including publish/deploy when required, and smoke the consuming surface.
9. Only after landed verification, delete the PR branch and disposable worktree, return the canonical clone to clean current target, and update durable state.
10. Run the continuation scan and start the next ready item instead of returning a menu.

## Stops

Use normal git and `gh` behavior already present in the repository. Do not build orchestration around orchestration.

A policy state named `needs-human-approval` maps to `needs reviewer gate` by default and becomes a hard exception only when genuinely human-only. Keep reviewer-gated lanes blocking while other ready work continues. A real credential wall or unrecoverable destructive shared-state action may return control.
