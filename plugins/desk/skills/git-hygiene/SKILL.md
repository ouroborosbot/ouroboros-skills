---
name: git-hygiene
description: Keep the code repos the agent touches synced and never leave state behind. Use at session start, before starting work in a code repo, after every ref change, when a required check fails or previous validation proof may be reused, before every push, and at session end.
---

# Git hygiene

> **overlay users**: consumer overlays may add their own state-sync workflow for the `$DESK/` repo, identity context (e.g. enterprise-managed git accounts), and overlay-specific anti-patterns. This skill stays generic.

The agent's pushes must reach the remote intact and on the right branch. This skill covers source-as-evidence reads, the pre-push CI-parity gate, merge-conflict EOL/BOM rules, force-push safe-conditions, and the post-commit verify gate.

## Code repos

These are the actual project repos where implementation happens (paths resolved via the `repo-handling` skill).

**Before starting work**:
```bash
cd <repo-local-path>
git fetch origin                          # ALWAYS first — see the stale-status trap below
git rev-list --count HEAD..origin/main    # how far behind is the base you'd branch from?
# If on a feature branch from prior work:
git rebase origin/main   # or `git merge origin/main`, per repo convention
# If on main:
git pull origin main
git status               # check for uncommitted changes; warn, don't silently overwrite
```

### The stale-status trap — `git status` lies without a fetch

`git fetch` is not an optional first line of the recipe above — it is the **load-bearing** one, and the failure mode when it's skipped is silent and expensive.

`git status` reports your branch as "up to date with 'origin/main'" by comparing against the **last-fetched** remote-tracking ref — a local cache that can be arbitrarily old. With no `git fetch` first, "up to date" only means "up to date with a possibly-ancient local copy of the remote," **not** "current with what's actually on the server." A clone that's been idle (or that another machine has been pushing to) can read "up to date" while sitting dozens of commits and several releases behind reality.

Branch off that stale base and the entire unit of work lands on dead code: the diff is computed against an old tree, the PR opens against a base that no longer reflects `main`, conventions may have drifted underneath you, and — worst — if the work targets a running artifact, you can "fix" something the operator already moved past, or even ship a **downgrade**. The cost is invisible until the work lands on the wrong base, and by then recovery is a full redo plus a credibility hit ("you said it was done").

The rule:

1. **Treat a no-fetch `git status` as `unknown`, never as `current`.** `git fetch` (or `git pull --rebase`) before branching or starting work in ANY code repo — every session, even for a one-line fix. Staleness scales with how long since the clone was last touched; you cannot eyeball it.
2. **Quantify the gap before branching.** `git rev-list --count HEAD..origin/main` — a non-zero count means your local base is behind; sync (`git checkout main && git pull --rebase`, or branch from `origin/main` directly) before doing anything else. Don't trust a green-looking `status`; trust the count after a fresh fetch.
3. **Cross-check HEAD against the real artifact when the work targets one.** If you're changing something with a deployed/published form (an installed app, a released package, a live service), compare the clone's version/HEAD against what's actually running (installed version, latest release tag, live response). A gap between the clone and reality is a second, independent staleness signal — stop and sync first.
4. **"Done" means the operator's real artifact changed — not "a PR exists" or "a harness passed."** Verify the outcome against the thing the operator actually uses (the installed binary, the live endpoint, the rendered output), not only a synthetic test or an open PR. A green proxy can hide that the operator's experience is unchanged.

### Folder trust is path trust, not revision trust

A host may use path-level folder trust to load repository-owned
executable configuration. After every ref change, inspect that
repository-owned executable configuration before the host can load
or run it. A trusted path does not make a new revision trusted. For
read-only inspection of untrusted source, use the remote source API
instead of trusting the checkout only to read it.

When a checked-out branch modifies a command-bearing file, such as a
hook, pipeline, task runner, package script, or policy, diff it against
the protected base and verify explicit approval before executing the
changed command. Reading a branch is not running it.

**During work**: `work-doer` handles commit + push per its own protocol.

**After merge**: `work-merger` handles the PR + merge flow; on completion, verify main is current.

## Clone hygiene — `main` is the resting state; do work in worktrees

A code clone is shared infrastructure: many sessions, machines, and agents touch the same checkout over time. Its **resting state is `main`** — clean, current, predictable. An agent that parks a clone on its own feature branch and walks away forces the next session into archaeology ("what is this branch, is it safe to build on?") before it can start.

The discipline:

1. **The canonical clone stays on `main`.** Never leave it checked out on a feature branch between units of work. At session start, if a clone is sitting on a feature branch from prior work, return it to `main` once that work is resolved (merged — or explicitly preserved, see verify-before-delete below).
2. **Do each unit of work in a git worktree off `main`**, not by checking out a branch in the canonical clone:
   ```bash
   git -C <clone> fetch origin
   git -C <clone> worktree add -b <branch> /tmp/<name> origin/main
   # edit / commit / push / PR / review / merge from the worktree
   # (use `git -C <worktree>` for EVERY git command — see work-orchestration
   #  "Worktree-isolated sub-agent dispatch" for the cwd-reset trap)
   ```
   The worktree isolates the work: parallel units never collide in the working tree, and the canonical clone's resting state is never perturbed.
3. **Clean up after yourself — but verify the merge landed first.** Cleanup is GATED on a confirmed merge, never chained unconditionally after `gh pr merge`. The merge CAN fail — a flipped auth identity, a newly-required status check, a mid-air race — and cleanup that assumes success will delete the worktree + branch on a false premise. So: after `gh pr merge`, confirm `gh pr view <id> --json state --jq .state` returns `MERGED`. ONLY then: `git worktree remove <path>`, delete the local branch (`--delete-branch` on the merge removes the remote), and `git -C <clone> pull --ff-only origin main` so the canonical clone absorbs the merge and returns to a clean `main`. The end state has **zero stray worktrees and zero stray `user/*` branches.** If the merge did NOT land, nothing is lost — the commit is safe on the remote branch and the PR stays open; fix the cause and re-merge before cleaning up.

**Why:** the clone's checked-out state is cattle, not a pet — only `main` and the remote are durable. This is the working-copy layer of "Never leave state behind" (below) and the branch → PR → merge drive-to-merge motion: branch in a worktree → PR → merge → delete branch → remove worktree → clone back on clean `main`, no residue at any layer.

### Verify before delete — cleanup is not destroy

Before deleting a leftover branch found at session start, confirm its content is actually on `main`:

```bash
git -C <clone> fetch origin
git -C <clone> diff origin/main..<branch> --stat
```

Empty diff → the branch's content is fully upstream → safe to delete (use `git branch -D`, since a squash-merge leaves the branch "ahead" in ancestry even when its content is fully merged — trust the content diff, not the commit count). Non-empty diff → the branch carries **real unmerged work**; do NOT delete it. Drive it to merge if it's ready, or preserve it and surface it to the operator. "These were probably just left behind" is a hypothesis to verify, not a license to delete unexamined work.

## Reading source as evidence

The `## Code repos` rules above cover keeping a checkout current
across a session. The runtime-investigation companion to that
rule: when the agent is reading source to inform a runtime question,
the local working tree is not a trustworthy substrate by default —
`origin/<branch>` is.

### Default to `origin/<branch>`, not the working tree

When reading source to inform a runtime question — any "why does
X behave this way?" investigation — default to reading from
`origin`, not from the local working tree:

1. Run `git fetch` first (cheap, always safe).
2. Read via `git show origin/<branch>:<path>` rather than the
   filesystem. This avoids the stale-checkout failure mode where
   the local branch is N commits behind and the agent doesn't
   realize it.
3. If the agent does read from the filesystem, confirm
   `git rev-list --count HEAD..origin/<branch>` is `0` first. If
   non-zero, `git pull` or fall back to step 2.

### When the operator says "pull latest"

Treat it as applying to ALL repos involved in the current
investigation, not just one. State repos and code repos (the
project repos the agent is reading source from) all need to be
current — code repos most of all when their source is being used
as evidence for runtime behavior. Code repos are managed manually
and may sit on feature branches; they're easy to forget.

If unsure which repos the operator means, ask.

### The smell

Any time the agent finds itself thinking **"the source says X but
the runtime behavior is Y, so there must be a non-source
mechanism"** — stop. The most common explanation for that gap is
"I'm reading stale source," not "there's hidden runtime
machinery."

Verify with `git log origin/<branch>..` or
`git show origin/<branch>:<path>` before theorizing about
non-source mechanisms.

### Why it matters

Theories built on stale source are very expensive to retract. By
the time the operator catches them, the agent has burned operator
trust ("the agent doesn't know what's in main"), drafted code or
PRs based on bad assumptions, sometimes opened those PRs, and
built a wrong mental model that propagates to the iteration doc
and friction log. The corrective work is much more expensive than
`git fetch` would have been at the start. Cheap gate; expensive
failure mode if skipped.

### Cross-link

This is the source-currency variant of the broader
hypothesis-narrowing principle in
`../runtime-symptom-investigation/SKILL.md`. The diagnostic skill
captures the meta-rule ("debugging is hypothesis-narrowing, not
system-understanding"); this section is one concrete recurring
trap that surfaces under that rule.

## Pre-push gate

Every `git push` that carries code changes is a CI-parity boundary.
The agent reproduces every gate the CI pipelines will run, locally,
**before** the push — not after, not in parallel, not optimistically.

Three layers, all mandatory, all green:

1. **Build.** Compile the affected project(s) in the same
   configuration CI uses. For .NET, that's `--configuration Release`,
   which enables `TreatWarningsAsErrors` /
   `CodeAnalysisTreatWarningsAsErrors` + analyzer + formatter
   MSBuild targets. Debug config skips several gates; it is not a
   substitute. Language-equivalent rules for other stacks —
   whatever posture the CI pipeline uses, the local build matches
   it.
2. **Test.** Run the test projects that cover the touched code. The
   scope is set by the diff, not by the closest test project (see
   `## Test scope — cover consumers` below). If the full suite is
   too slow, filter — but filter across every test project touched
   by the change, not one.
3. **Formatter.** Run the style gate the CI pipeline enforces
   (`dotnet csharpier --check`, `prettier --check`, `gofmt -l`,
   `rustfmt --check`, etc.). A Release .NET build that invokes
   csharpier-as-MSBuild-target covers this inside layer 1;
   standalone formatter runs are the fallback when the build config
   doesn't.

All three green → push. Any red → fix locally, re-run all three,
then push. **Never push red.** The pipelines will reject the push,
you'll wait 20–40 minutes for CI to report what you could have
learned in 60 seconds, and every reviewer-visible red pipeline on
the PR erodes the signal that green ones are meaningful.

### Pre-push gate is not an iteration gate

The pre-push gate runs before every `git push`. It does **not**
run between every edit in a local iteration loop — drafting,
exploring, and mid-iteration fix-ups are exempt. The distinction is
the push boundary: inside the loop, the agent iterates freely; at
the push, CI-parity is the only correct posture.

A corollary: **do not wait for CI pipelines to finalize before
starting the next iteration.** Local gates have already established
that the push won't red the pipeline. Trust that and keep moving.
Waiting on CI between iterations multiplies queue time by iteration
count — a 5-iteration loop with one 20-minute CI wait per iteration
becomes a two-hour human-facing latency for what could have been
~10 minutes of contiguous agent work plus one end-of-loop CI wait.

At end-of-loop (convergence reached, findings drained, or operator
interrupt), wait for the most recent push's pipelines to finalize.
If any pipeline goes red, treat it as a new finding — fix, push,
wait again. Only when all pipelines are green does the loop exit.

### Attribute failures after they happen

Do not establish a separate baseline preemptively. When a required
build, test, or formatter check fails and the failure may be
pre-existing, preserve the current tree and classify it in this
order:

1. Current target CI at the exact target SHA.
2. The same command in a clean merge-base worktree.
3. A previously recorded, reproducible baseline tied to a commit.

Unknown remains failed evidence. Do not fix an unrelated baseline
failure unless the task scope requires it.

### Reuse proof only while inputs match

Reuse a previous validation result only while its source/diff
fingerprint, exact command and selection, dependency and
configuration fingerprint, and environment all match the current
run. Record the reused run or artifact. If any relevant input
changed, rerun the affected proof.

### Commands are repo-specific

Exact build / test / formatter commands live under
`../repo-knowledge/<repo>/` (see `repo-handling` for the
auto-loader). Each repo's `pre-push-gates.md` (or equivalent)
captures the safe-default build line, test-project cut-lines, and
formatter fallback. For repos without `repo-knowledge` content,
consult the repo's own build / test docs before the first push.

## Test scope — cover consumers, not just the unit under change

A filtered test run only discovers tests in the csproj / test
project you point it at. That's a silent coverage gap when the
change touches an interface, signature, or public surface that
other projects consume: the consumer projects' tests never get run,
and locally-green pushes go red on CI.

The rule: when the change touches a public surface, the pre-push
test scope must cover **every** consumer project's tests — not just
the co-located test project.

### Detection heuristic

```bash
# Enumerate touched files across the branch vs. the merge base:
git diff --name-only origin/<base>...HEAD
```

Map each touched production file to its paired test project, using
the conventions the repo documents in `repo-knowledge/<repo>/`:
- Sibling-directory convention:
  `Src/Foo/Foo/Bar.cs` → tests under `Src/Foo/FooTests/`.
- Same-library convention:
  `Src/Common/Common/X.cs` → tests under `Src/Common/CommonTests/`.
- Package-prefix convention:
  `Src/.../Partners/SMB/Models/Y.cs` →
  `Src/.../PartnersTests/SMBTests/ModelsTests/`.

Collect the distinct test csproj files across all mapped test
paths. Run the test command once per csproj, filtering
appropriately.

### Public-surface changes widen the default

When the diff touches a signature / interface / abstract type / DTO
shape, widen the scope further: the safe default becomes the full
solution (or equivalent monorepo-spanning test scope). A
service-only solution does not include sibling tests, and sibling
tests are exactly where interface-drift surfaces.

Repo-specific cut-lines live in `../repo-knowledge/<repo>/`. When
a repo defines a "broad" test target for public-surface changes,
default to it for any diff that touches signatures / interfaces /
DTOs; fall back to per-service solutions only when the change is
provably internal (no public-API touch, no shared DTO edit).

## Test-count sanity check

"All tests pass" on a stale DLL is not a successful gate — it's a
silent failure. Before trusting a pre-push test-count, verify the
passed-count matches the expected delta.

Lightweight mechanism:

1. Track the expected count through the iteration:
   `expected = previous_count + tests_added − tests_removed`.
2. After the pre-push test layer runs, diff reported-count vs.
   expected.
3. If they match: proceed to push.
4. If they don't: the gate silently failed to rebuild or to
   discover the new test. Do **not** push.

Recovery when the counts disagree:

1. Force-rebuild the test project explicitly — drop `--no-build`
   on the test run; run `dotnet build <tests>.csproj --configuration
   Release` (or the equivalent for the stack) first so the compiled
   binary reflects the current source.
2. Re-run the gate.
3. If the count still doesn't match, diagnose the discovery issue
   before pushing.

Typical culprits for a stale or missing-test gate:
- `--no-build` flag + stale binary left over from a prior iteration.
- Build incremental-cache confusion after heavy file operations
  (large rename, tree move, reverted merges).
- Discovery filter pattern doesn't match the new test's
  fully-qualified name (test landed in a namespace the filter
  doesn't cover).
- Test method not annotated with `[Fact]` / `[Theory]` / the
  runner's equivalent — it's a plain method and no runner picks it
  up.

A silently-skipped test is a latent regression: the push succeeds,
the pipeline stays green (same stale DLL on CI in the worst case),
but the code path the test was supposed to cover is uncovered. The
next iteration's change can break it with no alarm and no reviewer
signal.

## Merge-conflict resolution — EOL / BOM artifacts

On Windows clones of repos with `text eol=*` attributes, a
merge-from-main can produce conflicts on files whose only
"difference" is BOM / CRLF vs. no-BOM / LF. The working-tree bytes
disagree with origin's stored blob because `git add` runs the
check-in filter, producing an index entry that looks changed even
though the underlying content is identical.

Committing that normalized version **"resolves" the conflict but
pollutes the PR diff**: origin's blob is unchanged, so every line
of the file shows up as insertion+deletion. CODEOWNERS for the path
gets added to the PR's reviewer list even though the change was
pure filter noise, and reviewers get pulled into a diff that has
no semantic content.

### Detection

```bash
# After a merge, inspect the diff-stat. A file with equal
# insertions and deletions AND not in the semantic change set is
# the signature of an EOL / BOM filter artifact:
git diff --stat origin/<base>...HEAD
```

If a file outside the task's stated scope shows up with insertions
equal to deletions, suspect EOL / BOM artifact before suspecting a
real change.

### Wrong fix

```bash
# DO NOT DO THIS for filter-artifact conflicts:
git add <path>
git commit -m "normalize EOL"
```

`git add` runs the check-in filter and writes a new blob — shipping
the artifact straight into the PR diff. `git stash`,
`git checkout origin/<base> -- <path>`, and
`git update-index --skip-worktree` all round-trip through the same
filter and fail the same way: they "work" in the sense that the
merge completes, but the index disagrees with origin and the
reviewer-visible diff is 100% noise.

### Right fix

Rewrite the index entry directly to origin's blob hash, bypassing
the check-in filter:

```bash
# Preserve origin/<base>'s exact bytes in the index regardless of
# any eol=* attribute:
BLOB=$(git rev-parse origin/<base>:<path>)
git update-index --cacheinfo 100644,$BLOB,<path>
```

The working tree still shows "M" because checkout-time conversion
runs — that's cosmetic and PR-invisible. The index now matches
origin exactly; the file shows zero diff on the PR, and CODEOWNERS
for that path is not pulled in.

Apply this per conflicted file that is a filter artifact. Files
with real semantic conflicts get resolved normally.

## Never leave state behind

If the agent changed a file, it's committed and pushed **before the session ends**. Applies to:
- Task cards and planning/doing docs in any state repo
- Code changes in code repos (via `work-doer`)

At session start, if git status in any repo shows unexpected uncommitted changes, surface them to the operator before doing anything else — they may represent orphaned work from a previous session.

(overlay users: consumer overlays often ship a state-repo-specific
anti-pattern note — never branch/PR on a state repo even when
push-to-main is denied; the denial is a permission config problem,
not a workflow problem.)

## Pre-commit scans (authorship, diff-scope)

Two mandatory scans run before every commit, both procedural (no
shipped git hook — the plugin is engine-agnostic and does not ship
engine-specific `.git/hooks/` content). Operators who want structural
enforcement can install a local hook using the recipes below as a
starting point.

### AI-attribution strip

Per `../principles.md` Invariant 4 (operator authorship overrides
repo conventions), no AI-attribution trailer appears in any commit
message or PR description the agent authors.

**Forbidden trailers — scan for these before every commit:**

```bash
# Scan the staged commit message before finalizing the commit:
git diff --cached --format=%B HEAD 2>/dev/null | \
  grep -nE "Co-Authored-By: Claude|Co-authored with Claude|Generated with Claude Code|AI-assisted"
```

- `Co-Authored-By: Claude ...`
- `Co-authored with Claude ...`
- `Generated with Claude Code`
- `AI-assisted`
- Any variant naming the agent or harness as a contributor.

If any hit: abort the commit; strip the offending trailer; redo.

Same pattern applies to PR descriptions — run the scan on the
proposed `pr-description.md` before `gh pr create` or
`gh pr edit --body-file`.

**Why a procedure, not a hook:** the plugin ships engine-agnostic
content. A `.git/hooks/commit-msg` file is machine-local and
per-repo; operators choose whether to install it. Optional local
hook recipe (operator-installable, not shipped):

```bash
#!/usr/bin/env bash
# ~/.config/git/hooks/commit-msg  (enable via core.hooksPath)
if grep -qE "Co-Authored-By: Claude|Co-authored with Claude|Generated with Claude Code|AI-assisted" "$1"; then
  echo "error: commit message contains a forbidden AI-attribution trailer" >&2
  grep -nE "Co-Authored-By: Claude|Co-authored with Claude|Generated with Claude Code|AI-assisted" "$1" >&2
  exit 1
fi
```

### Targeted staging — never `git add -A` in a shared or multi-track workspace

In a workspace where parallel agents (or other tracks) leave
untracked or modified state across multiple directories, **stage the
explicit list of files your unit wrote** — `git add <path> <path>`,
never `git add -A` or `git add .` from a workspace root. `-A` sweeps
in another track's or another agent's in-flight untracked file and
bundles it into your commit: the commit message then lies by omission
(`git show` reveals content the message never mentions), and if that
file was being kept untracked intentionally, you've frozen it
mid-thought. `git add -A` is convenient for a solo-track repo and
dangerous for a shared one. When in doubt, `git status` first and
stage by name. (This is the prevention; the diff-scope scan below is
the detection.)

### Diff-scope scan

Per `../principles.md` Invariant 2b (lean diffs), every commit
contains exactly the lines required for its stated scope and nothing
more. Before every commit, scan the staged diff for prose / xmldoc /
comment edits that are not named in the current unit's scope:

```bash
# Inspect the staged diff; look for changes outside the unit's
# stated file/line scope — especially to xmldoc <summary>, inline
# comments, adjacent prose in the same file:
git diff --cached
```

Decision rule:

- If the diff contains edits NOT required by the stated scope
  (adjacent xmldoc rewrite, "while I'm here" prose polish, comment
  restructuring unrelated to the unit's goal) → **revert those hunks**
  before committing. They are drive-by churn and violate lean-diffs.
- Polish is a separate, named activity. If a prose edit is genuinely
  worth doing, it earns its own unit and its own commit; it does not
  ride along on a scoped edit.

No ship-ready script for this one — the scan is a review of the
staged diff against the unit's stated scope by the agent itself,
informed by the unit's `What` and `Output` fields in the doing doc.

### Pre-PR diff-scope check

The same diff-scope discipline applies at the PR boundary — once
more broadly, against the whole branch rather than a single
commit. Before opening (or syncing) a PR via `work-merger`, the
agent inspects the full branch diff against the base:

```bash
git diff --stat origin/<base>...HEAD
```

Every file in the output should be either:
- Named in the task card's `repos[].paths`, or
- A direct consequence of one of those paths (regenerated
  lockfile, adjacent test touched because the change required it,
  etc.).

Files outside that expected set are a stop signal. Investigate
before the PR opens. Common culprits:

- EOL / BOM filter artifacts from a merge-from-main (see
  `## Merge-conflict resolution — EOL / BOM artifacts` above for
  the detection + fix). A file with equal insertions and
  deletions that is not in the semantic change set is almost
  always this.
- Accidental cross-area commits (a `git add -A` that scooped up
  an orphaned edit from a different concern).
- Drive-by churn (formatting, xmldoc polish) that should have
  been caught by the per-commit `### Diff-scope scan` but wasn't.

Cost: one `git diff --stat` invocation. Value: catches an entire
class of PR-surface bugs before human reviewers see the diff —
unrelated CODEOWNERS get pulled in, reviewer trust erodes, the PR
description ends up describing something the diff doesn't match.

## Post-commit verify gate

After every `git commit`, before claiming the work is shipped or
running `git push`, verify the commit's actual contents match the
commit message's claims. The minimum gate:

```bash
git show --stat HEAD
```

Or equivalently `git log -1 --stat`. Audit each named bucket in the
commit message against the file list:

- "feedback.md updates" → does the file list include
  `.../feedback.md`?
- "new friction entry" → does the file list include
  `.../_friction/<entry>.md`?
- "regenerated artifacts" → do the artifact paths appear?

Mismatch on any → the commit was incomplete. Stage the missing
items, create a NEW commit (do not amend, especially if the prior
commit was already pushed), and re-verify. Only after the file list
matches the message do `git push` and declare the work landed.

This gate is more rigorous than `git status` immediately after the
commit because:

- `git status` shows the *next* state (unstaged, untracked) — useful,
  but doesn't directly answer "did the commit I just made carry what
  I claimed?"
- `git show --stat HEAD` shows the *commit's contents* directly. The
  staged-vs-committed distinction collapses there.

Applies to every repo the agent writes to — state repos, code
repos, and plugin repos. The cost of one `git show --stat` per
commit is tiny; the cost of an operator catching a partial commit on
the next session (trust hit + extra cycle) is high.

---

## Force-push — safe-conditions procedure

Force-push is destructive. Most of the time the agent should stop
and hand the push to the operator. The procedure below documents
when force-push is safe for the agent to run without operator
re-approval.

If the trigger for considering force-push is a **parallel-PR
conflict on a coordinated file** (e.g., version-file conflicts on
a runtime manifest or `plugin.json` after another PR in the same
batch merged first), the right shape is usually merge + regular push, not
rebase + force-push. See `work-orchestration` →
"Parallel-batch dispatch discipline" → "Version-file conflicts on
parallel PRs — merge, don't rebase" before applying the safe-
conditions procedure below.

### Safe conditions (ALL must hold)

1. **Personal branch pattern.** The branch name matches
   `user/<alias>/...` (operator's personal namespace). Never force-
   push to `main`, `master`, a shared feature branch, or a release
   branch.
2. **`--force-with-lease`, not `--force`.** The `--force-with-lease`
   variant refuses to push if the remote has moved since the last
   fetch, so someone else's push cannot be silently overwritten.
3. **`git cherry` clean.** Every remote commit is either present
   locally (by content, not by SHA — the rewrite is deliberate), or
   explicitly intended to be dropped. Verify:
   ```bash
   git cherry origin/<branch>
   ```
   Lines beginning with `-` (patch already upstream) are fine. Lines
   beginning with `+` that you did NOT intentionally drop are a stop
   signal — investigate before pushing.

### Exact command

```bash
git push --force-with-lease=<branch>:<expected-remote-sha> origin <branch>
```

The `<expected-remote-sha>` is the SHA the operator's local branch
most recently saw at the remote. Including it is stricter than plain
`--force-with-lease` (which uses the local ref-cache) and is the
safest form.

### Stop and hand to operator when

- Any safe-condition above fails.
- Branch is `main`, `master`, or any shared/protected branch.
- Force-push would drop a commit that landed via someone else's push.
- The harness permission layer denies the push (signal: push returns
  non-zero with a permission / authorization error) — the denial is
  correct by design; reversing it without authorization is
  destructive. Do not retry; surface the blocker to the operator
  with the exact command they'd paste to complete it themselves.

### Common use case — AI-attribution cleanup

History rewrites to strip AI-attribution trailers from committed
history need a force-push. Sequence:

1. Rewrite history locally with `git filter-branch --msg-filter` or
   `git rebase -i` + trailer-strip.
2. Verify `git log --format=%B origin/main..HEAD | grep -E "Co-Authored-By: Claude|..."` → zero hits.
3. Apply safe-conditions check above (especially the **upstream-currency check** below if rewriting on a shared branch).
4. Force-push. If harness denies, surface the exact command.

### Mass history rewrites — upstream-currency check is load-bearing

A history rewrite that replaces a swath of commit SHAs (mailmap
author rename, `git filter-repo`, BFG, `git filter-branch`, etc.)
followed by a force-push to a shared branch will **silently drop**
any commits that landed on origin since the local clone last synced.

The trap: the rewrite runs cleanly, the force-push succeeds, every
SHA matches what the operator expected — and any commits the
upstream advanced past the local snapshot are now orphaned. The
"git cherry" safe-condition above catches this only if the local
branch knew about those commits; if origin advanced after the last
local fetch, `git cherry` has nothing to compare against.

**Standing rule.** Before force-pushing rewritten history to a
shared branch (including the rare authorized force-push to `main`):

1. **Upstream-currency check** — must return empty:
   ```bash
   git fetch origin && git log HEAD..origin/<branch>
   ```
   If non-empty, origin has commits the local clone hasn't seen.
   Stop. Sync (or recover, below) before pushing.

2. **Even better: start from a fresh mirror clone.** For
   `git filter-repo` runs in particular:
   ```bash
   git clone --mirror https://github.com/<owner>/<repo>.git /tmp/<repo>-rewrite.git
   cd /tmp/<repo>-rewrite.git
   git filter-repo --mailmap /path/to/mailmap.txt --force
   # …verify, re-add origin, push…
   ```
   The mirror IS origin's current state at clone time — no
   stale-checkout window. Still re-run the upstream-currency check
   right before pushing (origin may have advanced again during the
   rewrite).

3. **Recovery if commits did get dropped.** GitHub keeps orphaned
   objects for ~90 days, fetchable by SHA. Rebase the orphan chain
   onto the rewritten base; force-push again:
   ```bash
   git fetch origin <orphaned-sha>:refs/recovered/old-tip
   git checkout refs/recovered/old-tip
   git rebase --onto <new-rewritten-base> <old-rewritten-base>
   git branch -f <branch> HEAD
   # then re-apply force-push (after upstream-currency check)
   ```
   The rebase is clean when the rewrite only changed metadata
   (mailmap, AI-attribution strip, etc.) — each commit's tree is
   identical to its rewritten counterpart, so diffs apply on the
   rewritten base without conflicts.

---

## Cross-shell invocation gotcha (bash → PowerShell)

On Windows, you may shell out to `powershell` from within a bash (Git Bash / WSL) Bash tool call to run Windows-only commands. Variables like `$env:PATH`, `$env:LOCALAPPDATA`, `$PSVersionTable` are PowerShell syntax — but bash interpolates them inside double-quoted strings BEFORE handing the command off, leaving garbled syntax.

**Wrong** — bash treats `$env` as an empty shell variable and expands it away:
```bash
powershell -NoProfile -Command "$env:PATH -split ';' | Select-String WindowsApps"
# Becomes: powershell -NoProfile -Command ":PATH -split ';' | Select-String WindowsApps"
# Error: The term ':PATH' is not recognized...
```

**Right** — single-quote the outer string so bash leaves PowerShell's `$` alone:
```bash
powershell -NoProfile -Command '$env:PATH -split ";" | Select-String WindowsApps'
```

If inner single quotes are needed, swap them to double-quotes or escape inside. If you need bash-side variables interpolated too, use mixed quoting: bash interpolates `"$foo"` parts while `'$env:VAR'` parts stay literal for PowerShell.

This also applies when Copilot/Claude's Bash tool on Windows is running bash-compatible shell and you invoke PowerShell from it.
