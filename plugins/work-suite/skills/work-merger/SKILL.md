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

### Reconcile confirmed customer decisions

Before merge, and again after release/install on the consuming surface, reconcile every separately recorded confirmed customer decision and acceptance criterion, plus every confirmed component boundary, public contract, state owner, trust model, and compatibility policy, to the shipped behavior. A technical constraint that drops a confirmed value is a mismatch, not an implicit scope cut. Keep the branch and task unresolved until the recorded authority confirms a changed outcome.

### Retarget stacked work without inherited diffs

For a stacked PR, record the base PR, base branch, exact base source SHA, and original merge base. After the base merges, inspect ancestry, recompute the merge base, and review the complete intended diff before changing the PR target. Retarget only when the resulting PR contains only the feature changes.

If a squash merge leaves base changes in the retargeted PR, create a replacement branch from the final target, move only the feature changes, and open a replacement PR. Do not force-push or rewrite published history. Recompute the merge base on the replacement and rerun any review and validation invalidated by the base change.

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

An explicit producer state named `needs-human-approval` is a hard exception; do not replace required human approval with agent review. Use `needs reviewer gate` only when the producer explicitly permits machine review. A real credential wall or unrecoverable destructive shared-state action may return control.
