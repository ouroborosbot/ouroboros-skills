---
name: work-merger
description: Drive a finished branch through sync, PR, required checks, merge, release or install refresh, consuming-surface smoke, cleanup, and continuation. Use after implementation; never report an open or merely merged PR as done.
---

# Work Merger

1. Fetch `origin/main`, merge it into the task branch, resolve conflicts by preserving both intents, and run the repository's existing gates.
2. Push the branch and create or update a PR using the repository's template or recent convention.
3. Wait for required checks. Read and fix real failures; push and repeat.
4. Merge the exact green head using the repository's enabled merge method.
5. Verify the merge on `origin/main`.
6. Complete the applicable release, publish, deploy, or local install refresh.
7. Smoke the deployed or installed consuming surface.
8. Delete the PR branch and disposable worktree, return the canonical clone to clean current `main`, and update durable task state.
9. Run the continuation scan; start the next ready item instead of returning a menu.

Use normal git and `gh` behavior already present in the repository. Do not build orchestration around orchestration. Retry transient races, but stop at `needs-human-approval`, a real credential wall, or an unrecoverable destructive shared-state action.
