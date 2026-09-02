---
name: peer-pr-review
description: Invoke ONLY when the operator hands worker a PR URL or ID and asks to review it — phrases like "review this", "let's review", "review Doris's PR", "review PR <id>". The PR is authored by someone else (not the operator). Do NOT invoke for the operator's own PRs (those use pr-self-review or pr-feedback-on-own-pr), for hypothetical PRs, or for general code-review questions divorced from a specific PR.
---

# peer-pr-review

This skill inherits all invariants in `../../principles.md`. Read
them first if they are not already in context.

Eleven-phase workflow for reviewing **someone else's** PR — scaffold,
read, walkthrough, backlog, full-line pass, voice-strip + verify
pass, confidence check, post, vote, promote, archive. Sibling skills
cover the operator's OWN PRs (`pr-self-review`, `pr-feedback-on-own-pr`,
`pr-surface-hygiene`); this one starts when the PR's author is
someone other than the operator.

The workspace layout this skill drives — `_reviews/<slug>/` with
`task.md` + `notes.md` and the connection-lens model — is documented
at the operator's `$DESK/_reviews/README.md`. This skill
references that layout; it does not duplicate the lens taxonomy.

## Hard rules

These eight rules apply across phases. A single violation is enough
to make a review untrustworthy, so each one is restated in the phase
where it actually bites.

1. **No test-file reading or referencing.** Worker fetches the PR's
   production diff only and never opens, quotes, or anchors a comment
   to a test file. The rule binds Phase 2 (read) and every comment
   produced in Phases 3-8. Rationale: the recipient acting on a
   comment cares about production code; reading test names tends to
   slide back into test-file analysis; tests are an implementation
   detail of the production change.

2. **At least one non-`direct-work` lens must be real.** When deciding
   connection lenses in Phase 1, an honest "career / cross-team /
   pattern" lens is more trustworthy than an overclaimed
   `direct-work` lens. Don't manufacture `direct-work` to make the
   review feel weightier.

3. **No pre-formed verdict before the walkthrough.** Phase 3's job is
   to surface observations, ask questions, and let the operator's
   judgment shape what becomes a backlog item. A pre-formed verdict
   turns the walk into validation, not exploration.

4. **All operator-voice content goes through
   `../operator-voice-comments/SKILL.md` rules** at every draft-time
   touchpoint (Phases 3-8). Voice rules and verification rules apply
   to every comment that will land on the PR under the operator's
   name.

5. **Below-90% confidence claims get verified, softened, or cut**
   before posting (Phase 7, or inline before a teaching-mode Phase-3
   post). The bar: worker can articulate "this is
   right because [evidence], and the recipient pushing back would be
   answered by [verification source]."

6. **Comments anchor to method names, not line numbers.** Per
   `../pr-surface-hygiene/SKILL.md` PSH-002 — line numbers drift on
   reformat / refactor / extract; method names survive. Applies to
   every comment authored in Phases 3-8.

7. **Empty `promotions:` at archive is a smell.** A review that
   surfaces no durable insight is rare; usually the insight wasn't
   captured. Phase 10-11 enforces this — if `promotions:` is empty
   at archive time, go back and either find the insight or make
   skip-by-design explicit.

8. **A candidate finding must survive an explicit disproof pass
   before the operator sees it as a conclusion.** Verify external
   platform contracts independently of the PR, trace alternate and
   fallback paths to their terminal outcome, and enumerate relevant
   feature-flag states. If the strongest benign explanation remains
   plausible, keep investigating or cut the finding. Never ask the
   operator to validate worker's technical reading; their role is
   product judgment after worker has proved the mechanism.

## Workspace layout

Reviews live under `_reviews/<slug>/` in the operator's
`$DESK/` workspace. Each review directory contains two
files:

- `task.md` — frontmatter (PR identifying metadata, connection
  lenses, promotions, verdict at archive time) plus a short body.
  Schema lives in `$DESK/_reviews/README.md`.
- `notes.md` — running walkthrough log, scratch observations, the
  backlog of decided-to-post items, and the captured verdict prose.

The connection-lens model (which lenses exist, when each applies,
the rule that most reviews will not have a `direct-work` lens) is
canonical at `$DESK/_reviews/README.md`. This skill drives
the workflow that produces the layout; it does not restate the lens
definitions.

Phase 1 creates `task.md` and `notes.md`; Phases 2-9 mostly write
to `notes.md` (diff opener, walkthrough log, backlog, draft column,
thread IDs, recommended-and-final vote); Phases 10-11 update
`task.md` (promotions[] applied, status → done, verdict block) and
move the directory to `_reviews/_archive/<slug>/` per
`../archive-workflow/SKILL.md`.

## Phase 1 — Scaffold

Operator hands worker a PR URL or ID. Phase 1 produces the review
directory and frontmatter; nothing on the diff itself is read yet.

1. **Fetch identifying metadata.** Title, author, repo, source
   branch, current vote state, size label, linked work item. Use
   the available PR-fetch tool — engine-specific. The skill
   references the action category, not a specific tool identifier;
   the underlying call shape is a thin wrapper over the platform's
   PR-read REST API.

2. **Propose a slug, default-accept framing.** Content-first — the
   theme of the PR, not the PR number, not the author's name.
   Phrase the proposal as "going with `<slug>` unless you object"
   rather than "what should the slug be?", then proceed to scaffold
   immediately. The operator can override before the first
   `git commit + push` of the scaffolded directory; renames before
   that point are cheap. After the first push, slug permanence
   binds per the same rule
   `../interaction-style/SKILL.md` applies to track and task slugs.

   Why this isn't a forced round-trip: a content-first slug for a
   peer review is mostly mechanical (title → slugify, light judgment
   on which words to keep). Worker proposing and proceeding cuts a
   per-review wait without giving up the override. Slug permanence
   is a real cost — but it lives at the first-commit boundary, not
   at the proposal moment.

3. **Decide connection lenses.** Walk the operator through which
   lenses fit and at what depth. Hard rule: at least one
   non-`direct-work` lens must be real. An honest "career" or
   "cross-team" framing is more trustworthy than an overclaimed
   `direct-work` lens that the review can't actually carry.

   **Note rejected lenses.** Capture the lenses worker considered
   but didn't take, with one line on why each was passed over. The
   rejected set lives in `task.md` under a brief "Lenses considered
   but not taken:" block. Audit value: a future reader (or a future
   review of a similar PR) can short-circuit the same considerations
   instead of re-deriving them.

4. **Create the directory.** `_reviews/<slug>/` with:
   - `task.md` — frontmatter populated per the schema at
     `$DESK/_reviews/README.md` (PR block, connections[],
     empty promotions[]). Status starts at `reviewing`.
   - `notes.md` — empty walkthrough scaffold (a top heading and
     placeholder sections for the diff opener, the walkthrough log,
     and the backlog).

   Commit + push to the desk-workspace repo per `../git-hygiene/SKILL.md`. The
   directory existing on disk before Phase 2 starts is the signal
   that the review is in flight; later phases assume it.

## Phase 2 — Read

Fetch the PR's substance — production diff and threads — into the
review's working set. **Hard rule (binds this phase and every
comment produced downstream): do NOT read or reference test files.**

Why the rule is hard:

- The recipient acting on a comment cares about the production
  change, not which test does or doesn't cover it. Test-name
  anchoring drains signal from the comment.
- Reading test names tends to slide back into test-file analysis,
  pulling worker into the very surface it should not be reviewing.
- Tests are an implementation detail of the production change. The
  conversation worth having lives on the production code; the test
  layer takes care of itself once the production layer is right.

What to fetch:

- **PR description body and any author-supplied review-tour
  comments.** Capture the author's framing for context, but treat
  it as a subject of the review rather than as authoritative.
- **Active threads first.** Filter to `status=Active` on the first
  pass. Resolved/closed threads carry historical decisions and can
  be fetched separately once the active-thread set is in hand. A
  long-running PR (20+ iterations) can have hundreds of system
  threads (vote/policy state changes); the full unfiltered listing
  routinely blows the tool-result token cap. Worker absorbs the
  full thread set only when there's evidence the resolved-thread
  history matters for a specific question.
- **Production diff only.** Exclude test paths via the platform's
  pathspec exclusion. The exact glob is language- and repo-specific
  (test directory layout varies); a typical shape:

  ```
  git diff <merge-base>..<branch> -- ':!**/*Tests*' ':!**/*test*'
  ```

  The merge base is usually `origin/main` (or the branch the PR
  targets). Check the PR's `targetRefName` to confirm.

### Diff acquisition when no local clone exists

Some repos are too large to clone on demand for a one-off review
(4GB+ monorepos, multi-binary repos that don't matter beyond the
slice this PR touches). For those, the local-`git diff` path is
not available. Worker reaches for a diff-via-API path instead of
pausing to ask the operator how to proceed:

1. **Fork a `gather-diff` sub-agent** that fetches each non-test
   changed file's base + head content via the platform's file-
   content API (engine-agnostic; GitHub has
   `GET /repos/{owner}/{repo}/contents/{path}?ref=...`; other PR
   hosts have equivalents).
2. **For each file, pick the right shape:**
   - Added file → head-only.
   - Edited file → fetch base + head, run `diff -u` locally on the
     saved files.
   - Deleted file → base-only.
3. **Save the unified-diff text** to `_reviews/<slug>/diff/` as one
   file per changed production file (or one combined file if the
   diff is small enough). The artifact is the input to Phase 3
   (walkthrough) and Phase 5 (full-line pass).
4. **Don't pull the artifact's full contents into the main agent's
   context.** Read selectively — file-by-file, hunk-by-hunk —
   when the walkthrough or full-line pass needs a specific section.

This preserves autonomy on PRs against repos worker can't clone:
the review proceeds to walkthrough without a "I can't read this
without cloning, what do you want to do" pause.

Capture the diff's scope opener at the top of `notes.md`: file
count, line count, and a one-sentence framing of what the change
does. The opener is the orientation the operator and worker share
when the walkthrough starts in Phase 3.

## Phase 3 — Walkthrough

Interactive walk-through with the operator. Worker reads the diff in
order, surfaces observations, and asks questions; the operator's
judgment shapes what becomes a backlog item. Output: the walkthrough
log under `notes.md`.

**Hard rule: no pre-formed verdict before the walkthrough.** Worker
does not enter Phase 3 with a vote in mind, a "this is fine" / "this
is concerning" framing, or a list of issues already classified. A
pre-formed verdict turns the walk into validation rather than
exploration — the operator's surfacing-questions get framed as
either supporting or undermining a conclusion worker has already
drawn, rather than as the source material for reaching a conclusion
together.

The walkthrough log is conversational: file by file (or hunk by
hunk for large files), worker names what changed and surfaces
questions; the operator reacts; the conversation produces decisions
that end up in `notes.md` as backlog candidates (Phase 4) or as
walked-through-and-no-action notes.

### Finding reality gate before the walkthrough

Before worker presents a privately discovered candidate finding,
builds a walkthrough around it, or asks the operator for judgment,
try to disprove it:

1. State the strongest intentional or benign explanation for the
   observed code.
2. Trace every alternate, legacy, cached, and fallback path far
   enough to determine the actual user-visible or persisted outcome.
   The absence of the new path is not a failure when an existing
   path still produces the required result.
3. If the claim depends on an SDK, API, host, deployment, or other
   system outside the repository, verify that system's authoritative
   contract independently. The PR description, its design doc, and
   comments in the changed code are subjects of review, not proof.
4. For feature-flag or version-skew findings, enumerate the relevant
   state combinations and trace each one. Do not infer failure merely
   because an intermediate state bypasses the newly added path.
5. Write the concrete failing input and terminal outcome. If either
   remains assumed, the finding is not ready for the operator.

This gate exits in one of two states: the candidate has a verified
failure mechanism, or it is cut. "Does this match your reading?" is
not a valid technical gate when the operator relies on worker to
read the code. Ask them only for the product decision the verified
mechanism actually needs.

### Teaching mode for an unfamiliar codebase

When the operator says they have not worked much in the repo, wants
to understand the architecture while reviewing, or asks worker to
teach them the code, Phase 3 changes order. **Start at the runtime
entry point, not at the changed helper or a finding worker already
knows about.**

1. Map the external request into the repo: caller/service boundary →
   workflow entry point → composition root / dispatcher → selected
   scenario or handler → model-callable tool → nested workflow /
   downstream dependency.
2. Open those source locations in the authenticated browser and
   drive one slice at a time. Define overloaded local vocabulary
   before asking the operator to judge it.
3. Only after the operator understands the normal path, layer the PR
   diff onto it: what changed, what stayed inherited, and which
   alternate routes bypass or override the changed code.
4. Keep privately discovered findings in `notes.md`; do not lead the
   walkthrough with them, draft a comment, or ask for posting
   approval before the operator reaches the relevant code and forms
   their own judgment.
5. Once the operator states a judgment, draft the narrow comment in
   their voice. Before any mid-walkthrough post, explicitly invoke
   `operator-voice-comments`, verify every load-bearing claim, and run
   the Phase-7 confidence plus validator-parrot / landscape-gap value
   filters inline. Post only when those gates pass and the operator
   explicitly approves that exact text and destination; record the
   thread ID in `notes.md` and continue teaching. Otherwise place it
   in the Phase-4 backlog.

The anti-pattern is "finding-first teaching": dropping an operator
into the line worker wants to critique, explaining just enough to
justify a prewritten comment, then treating agreement as approval.
That teaches the finding, not the system, and turns the walkthrough
into verdict validation.

**When to invoke `pr-review-interrogation`.** If a thread or design
choice surfaces a design-premise question — "is this abstraction
needed at all?" / "is this the right place for this logic?" /
"where did this type come from?" — invoke
`../pr-review-interrogation/SKILL.md` for that section. Don't accept
the PR's own xmldoc, commit message, or PR description as the
answer. The interrogation skill's two rules (diff-first for
provenance questions; prove novelty for new abstractions) apply
directly to peer review.

### Default file-read order for engine + integration + UI diffs

When the diff has the shape "engine logic + integration callsite +
UI surface" (a common shape in layered codebases), default to this
file-read order rather than top-to-bottom-of-the-file-tree:

1. Public type contract (`.types.ts` or named type exports;
   equivalent in C# / Go / Java).
2. Public barrel / index.
3. Orchestrator / main logic.
4. BRS / config / flag-handling utilities.
5. Integration callsite.
6. UI surfaces (skim only — most logic bugs are upstream).
7. Small files (resources, constants, build plumbing).

Each pass narrows the question scope. Types-first means the later
reads have the type contract already in context, so behavioral
questions about callsites resolve faster. UI-skim-only is
deliberate: most UI hunks just plumb props through, and bugs in
that layer surface as visible regressions; they don't reward deep
reading.

Override the default when the diff genuinely doesn't match the
shape (a pure docs PR, a config-only change, a UI-only refactor).
The order is a useful default, not a hard rule.

## Phase 4 — Backlog

As the walkthrough surfaces decided-to-post items, accumulate them
in `notes.md` under a clear "Backlog" heading. Each backlog item
carries:

- **Anchor** — file path and method / class name. Never line
  numbers, per `../pr-surface-hygiene/SKILL.md` PSH-002. Line
  numbers drift on reformat / refactor / extract; method names
  survive.
- **The ask** — one sentence. What the operator wants to surface
  on the PR. Not the rationale, not the full comment draft —
  the ask itself.
- **Rough confidence** — high / medium / low for now. Phase 7
  refines this against the 90% bar.
- **Connection lens** — which lens the item connects to. Phase 10
  promotes durable insights into the target artifact, and that
  promotion needs source material; tagging the lens at backlog
  time is what makes that step honest later.

The backlog is alive across the walk. Items can be added, removed,
or merged as later parts of the diff inform earlier parts — a
question raised at the top of a file may resolve at the bottom; a
nit flagged in one hunk may turn out to be the dominant pattern of
the change and not worth surfacing per-site.

## Phase 5 — Full-line pass

Before locking the backlog, re-walk every line of the non-test diff
in order. The walkthrough conversation in Phase 3 follows the
operator's attention; the full-line pass is worker reading the diff
straight through to catch what attention missed.

Three things to look for:

1. **Items the walkthrough missed.** Hunks the operator was thinking
   about something else during, sections worker glossed over because
   they "looked routine."
2. **Items the walkthrough flagged but later parts resolved.** A
   concern raised in hunk 2 sometimes dissolves when hunk 7 makes
   the broader pattern visible. De-dupe.
3. **Cross-cutting patterns visible only at the end.** A naming
   inconsistency or repeated nullability shape that's invisible
   per-hunk but obvious across the diff as a whole.

Update `notes.md` backlog accordingly: add, remove, or merge items
based on the full-line read. After Phase 5, the backlog is locked
for Phase 6 voice-strip + verify.

### Grep-then-read for large files

For large files (>500 changed lines), default to **grep-then-read**
rather than read-then-think. Worker comes in with hypotheses (from
the PR description claims, thread refs, type contract from Phase 3),
greps for relevant identifiers, reads the neighborhoods that came
back. A 500+-line engine file is rarely worth a top-to-bottom read
during a review; the bugs that matter cluster around specific
identifiers (timeout-related, error-class names, threshold
constants).

Concrete shape:

1. Form 2–3 hypotheses about where bugs would live based on Phase 3
   context (e.g., "any timeout-handling on this engine's main
   loop?", "any case-sensitivity around extension filtering?").
2. For each hypothesis, run a targeted grep (e.g.,
   `timeoutMs|setTimeout|Promise.race|abort|signal`).
3. Read the neighborhoods (~50 lines around each match) that came
   back. Many hypotheses resolve in the negative — zero matches
   confirms a gap; that's a real review finding.
4. Re-grep for related concepts as the read surfaces new
   identifiers worth chasing.

A 1900-line engine can be reviewed responsibly with ~150 lines ever
in context if the grep choices are good. The full-read default
costs 1900-line context budget and rarely produces better findings
than the targeted-grep approach.

### Cross-file consistency: new constants adjacent to existing ones

When the diff INTRODUCES a new constant, type alias, helper, or
config key adjacent to an existing one with overlapping purpose,
trace every consumer of BOTH names and confirm they're using the
right one. The bug pattern: a wizard or callsite that imported the
existing name continues to import it after the new name is
introduced — but the new name is the one that should be used post-
diff. Lowercase vs uppercase, singular vs plural, and tighter-vs-
looser-typing pairs are the most common shapes.

Concrete shape:

1. After the small-file pass surfaces a constant pair (e.g.,
   `EVALUABLE_EXTENSIONS` newly introduced next to existing
   `DEFAULT_ALLOWED_UPLOAD_FILE_EXTENSIONS`), grep both names'
   importers across the diff scope.
2. For each importer, read the surrounding code and confirm the
   intended choice (case-normalized? exact match? superset?).
3. A consumer importing the wrong one is a bug — typically a
   high-severity finding, because the bug only surfaces at
   runtime and is invisible per-file.

This is a cross-file consistency pass that complements the per-
file walkthrough. Per-file analysis cannot see the relationship
between files; cross-file analysis cannot see the per-file detail.
Both passes together catch what either alone misses.

## Phase 6 — Voice-strip + verify pass

Apply `../operator-voice-comments/SKILL.md` rules to every comment
in the locked backlog. That skill is the canonical rule set; this
phase invokes it at the peer-review draft-time touchpoint.

**Use the Skill tool to explicitly invoke `operator-voice-comments`
at the start of Phase 6 — don't just apply its rules ambiently from
context.** The explicit invocation creates a checkpoint that surfaces
leaks (especially the "operator-internal tracking vocabulary"
category — track-card slugs, phase numbers, deliverable / surface
labels, named reviewer groups) that ambient rule-following can miss
when worker has rich track-card context in mind. Ambient context
makes the internal labels feel like the most precise way to say
something; the explicit pass forces the reader's-eye check.

Two specific passes in Phase 6:

- **Voice-strip** per the `no-sycophantic-padding` and
  `match-operator-voice` sections. Strip preemptive accommodation,
  scope-defense, and concession. Match the operator's voice:
  direct, lean, lowercase nit prefix where the operator uses it,
  em-dash to join ask + reason.
- **Verify load-bearing factual claims** per the `no-fabrication`
  "code mechanism" sub-rule and the `verify before posting`
  section. A claim of the form "X handler returns Y on Z" is
  load-bearing — read the exact lines in the cited file and
  confirm the chain end to end.

Phase 6 exits when every draft has passed both the voice test (read
aloud as the operator) and the dial test (read as the recipient).

## Phase 7 — Confidence check

Assign honest confidence per comment. The bar to clear before
posting:

> Worker can articulate "this is right because [evidence], and the
> recipient pushing back would be answered by [verification
> source]."

If worker can articulate that for a comment, confidence is high
enough. If worker cannot, the comment is below the bar.

**Below-90% confidence claims get resolved before posting** —
verified, softened, or cut. The 90% framing is a working
threshold, not a precise probability; the practical test is "would
worker stand behind this comment if challenged, with the evidence
already in hand?"

Three common 70-89% cases that need resolution before the comment
ships:

- **Mechanism inference.** Drafts containing "I think the typical
  pattern is..." or "based on similar code elsewhere..." are
  flagging that the claim was inferred, not read. Resolve by
  reading the exact lines and converting to a verified claim, or
  cut the comment if reading doesn't support it.
- **Architectural inference.** Drafts citing "based on similar code
  elsewhere..." without naming the elsewhere are gestural rather
  than evidenced. Resolve by citing the specific elsewhere (file +
  method name), or cut.
- **History inference.** Drafts shaped as "this might be a
  regression from..." or "I think this changed when..." are
  unverified history claims. Resolve with `git log` on the file
  (or the operator's prior planning / friction notes) and cite the
  specific source, or cut.

Hedging language pasted onto an unverified claim ("I think,"
"probably," "if I'm reading this right") makes the comment worse,
not better; per `../operator-voice-comments/SKILL.md`, hedge-and-keep
is not a valid resolution.

### Two value filters — even a true finding can be worthless

Confidence answers "is this right?" These two filters answer "even
if right, is it worth surfacing?" — run both before a comment ships:

1. **Validator-parrot.** Will an automated validator on either side
   (a coverage check, a build, a policy gate, CI) already flag this?
   If yes, cut it. The author reads the same report; echoing it adds
   nothing and dilutes the signal of any real finding. (This filter
   also applies to reviewing one's own PR — see `pr-self-review`.)
2. **Landscape-gap-as-finding.** Is this only a concern because
   worker is missing the deployment / access-model / who-can-reach-
   this-flow context? If maybe, verify the landscape BEFORE drafting
   (the entry points, which flags gate it, who actually reaches this
   path). If it checks out, the disposition is **"no finding"** — not
   "ask the author." A risk that's only a risk because worker doesn't
   understand the system advertises that gap and wastes the author's
   time on a question worker should have answered itself.

A review that surfaces nothing beyond what the validators already
catch is a **legitimate, valuable outcome** — sign off. The instinct
to "find something to say" after the one real finding lands is exactly
what pushes toward both failure modes.

After Phase 7, every backlog comment is either above the bar or
gone. There is no "post this with caveats" path.

## Phase 8 — Post

Post the surviving backlog as PR comments via the available
PR-comment-create tool — engine-specific. The skill references the
action category, not a specific tool identifier; the underlying
call shape is a thin wrapper over the platform's PR-thread-create
REST API. Exclude items already posted inline during a teaching-mode
walkthrough; their thread IDs are already in `notes.md`.

Two kinds of comments:

- **File-thread comment.** Anchored to a file (per PSH-002, not to
  a specific line — line numbers drift on reformat / refactor /
  extract). When the comment needs more precision than the file as
  a whole, name the method or class in the comment body. The
  thread itself anchors the location; the body carries the ask.
- **Top-level comment.** Short context-setter for the review as a
  whole. The shape that reads cleanly to the recipient: one
  sentence framing the overall posture ("couple of small things,
  otherwise looks good" / "two questions on the data flow,
  otherwise the change shape is right"). Top-level comments do not
  carry per-item asks; those live in the file-threads.

After each comment posts, capture the resulting thread ID in
`notes.md` so the archive trail is auditable. Thread IDs flow into
the verdict block at Phase 11.

If a draft was edited between Phase 6 and Phase 8 (operator
suggested a change), re-run the voice test and the dial test on the
edited shape before the comment lands.

### Platform link syntax

When a comment body references another PR or work item, use the
platform's auto-link syntax — not raw URLs and not "PR <id>"
prose. The exact syntax is platform-specific:

- **GitHub**: `#<id>` for both PRs and issues (e.g., `#1234`).
  GitHub renders it as a styled link with the title.
- Other PR hosts have their own conventions (e.g., `!<id>` for
  PRs / MRs on some, `#<id>` for work items on others).

Examples (GitHub shape):

- Bad: `"...lines up with the PATCH endpoint landing in PR 1234..."`
- Good: `"...lines up with the PATCH endpoint landing in #1234..."`
- Bad: `"see PR https://github.com/<org>/<repo>/pull/1234"`
- Good: `"see #1234"`

Use raw URLs only when you specifically want the URL visible
(e.g., link to a wiki page, dashboard, log). For PRs and work
items, the auto-link form is shorter, renders better, and stays
correct if the title changes. Pick the syntax that matches the
platform hosting the PR being reviewed.

## Phase 9 — Vote

Cast the worker-recommended vote on the PR. The vote values mirror
the platform's review-vote API:

- **`Approved`** — the review surfaced no concerns worth blocking
  on.
- **`ApprovedWithSuggestions`** — comments to address, but worker
  is not blocking merge on them. The author can take or leave the
  suggestions; the review-with-suggestions vote signals "I read
  this and I'm fine with it shipping."
- **`NoVote`** — worker can't endorse without resolution. Used
  when design-premise questions surfaced in Phase 3 are unresolved
  and the operator hasn't decided yet whether the answer matters
  enough to block.
- **`WaitingForAuthor`** — major mechanism error or scope
  mismatch. The author needs to come back to the PR before another
  reviewer pass is useful.

Heuristic for the recommendation:

| Backlog shape | Recommend |
|---|---|
| All comments are nits + author has a track record of clean follow-through | `Approved` |
| Real bug or substantive change requested | `ApprovedWithSuggestions` |
| Design-premise questions unresolved | `NoVote` |
| Major mechanism error or scope mismatch | `WaitingForAuthor` |

The operator may override the recommendation. Capture both the
recommended and the final vote in `notes.md` so the archive
preserves the disagreement (when there was one) along with the
decision.

## Phase 10 — Promote

Update target workspace docs based on each `promotions[]` entry in
`task.md`. The promotion target is named on the entry; the entry's
note becomes (or seeds) the bullet that lands in the target. Common
targets:

- **`<track>/track.md`** — a context bullet about the reviewed PR
  if it touches the track's surface area (e.g., "first known
  external consumer of [shape]; schema breaks regress this path").
- **`_landscape/<topic>.md`** — an insight if the review surfaced
  a new architectural fact about the topic (delivery sequencing,
  rollout flag dependencies, cross-team contracts).

Promotions are not always applied. **Skip-by-design** is the right
disposition when the connection lens was honest about being thin
and there's nothing durable to capture. Mark such entries
`applied: skip-by-design` rather than deleting them — the skip
itself is information for a future reader.

**Empty `promotions:` at archive is a smell** — restated from the
hard rules section because Phase 10 is where the smell either gets
resolved or shipped. Two failure modes the smell signals:

- The review didn't surface anything durable. Rare. Before
  archiving on this disposition, re-read the walkthrough log and
  the backlog. Most reviews surface at least one fact worth
  promoting somewhere.
- The insight wasn't captured. Common. Go back to `notes.md`,
  write the insight down, and add the promotion entry to
  `task.md` before archiving.

## Phase 11 — Archive

Move `_reviews/<slug>/` to `_reviews/_archive/<slug>/` per
`../archive-workflow/SKILL.md`. The archive operation preserves
the directory as a unit — `task.md`, `notes.md`, and any artifacts
travel together.

Update `task.md` before the move:

- `status:` → `done`.
- `verdict:` block written per the schema below.
- `promotions[].applied:` resolved to `true` or `skip-by-design`
  on every entry (no `pending` entries at archive time).
- `closed_decision:` short prose summary (e.g.,
  `approved-with-suggestions-3-comments-posted`,
  `signed-off-no-comment`).

The final `task.md` should let a future reader reconstruct the
review's outcome without opening `notes.md`: vote cast, comments
posted (and where they live as thread IDs), promotions applied,
closing posture.

After the move, commit + push to the desk-workspace repo per
`../git-hygiene/SKILL.md`. The archive is read-only after this
point; if the review needs to be revisited, open a new review.

## Verdict shape

The verdict block lives in `task.md` frontmatter at archive time
(Phase 11). Schema:

```yaml
verdict:
  vote: <Approved|ApprovedWithSuggestions|NoVote|WaitingForAuthor>
  comments_posted: <count>
  thread_ids: [<thread-id-1>, <thread-id-2>, ...]
  signed_off_at: <ISO-8601 timestamp>
```

Field rules:

- **`vote`** — the cast vote (operator-final). Capture
  recommendation-vs-final disagreement in `notes.md`.
- **`comments_posted`** — count of worker-authored file-thread
  plus top-level comments. Bot threads don't count.
- **`thread_ids`** — IDs returned from Phase 8's create calls.
  Empty list on `signed-off-no-comment`.
- **`signed_off_at`** — ISO-8601 timestamp of the final vote.
  Scopes the review's claims to the PR state at sign-off; later
  commits are out of scope of this review.

`notes.md` carries the reasoning trail; the verdict block carries
the result.
