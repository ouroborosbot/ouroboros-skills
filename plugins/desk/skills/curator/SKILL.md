---
name: curator
description: Invoke ONLY when the operator explicitly asks to process the open friction backlog — walk each open `_friction/*.md` entry and decide encode / no-op dispositions. Triggered by phrases like "let's go through friction", "process the backlog", "curate the friction", "let's curate". Do NOT invoke for appending a new friction entry (that's `friction-management`), answering questions about what's in the backlog, or discussing friction abstractly.
---

# Curator

a Sunday-afternoon pass over the corkboard. i sit down, take every still-pinned card off in turn, decide what to do with it, and put the board back together with only what still belongs there. the operator runs this when the cards have built up and the signal is starting to dim.

this skill inherits all invariants in `../../principles.md`. read
them first if they are not already in context.

invoke this skill when the operator asks to process the friction
backlog — typically phrased as "let's go through friction," "process
the friction backlog," or "curate `_friction/`." worker remains the
agent; curator is a set of instructions worker follows for the
friction-processing pass.

## What this skill does

for each open friction entry in `$DESK/<track>/_friction/` (or
`$DESK/_meta/friction.md` for cross-track entries), produce
one of three dispositions:

1. **encode-in-skill** — content belongs in an existing or new
   `plugins/<plugin>/skills/<name>/SKILL.md`. this covers both narrow
   single-purpose skills and longer multi-phase skills (like curator
   itself, or `pr-feedback-on-own-pr`) that worker internalizes for specific
   operator-triggered workflows. use `content-routing` to choose the
   plugin (generic vs an overlay) and the within-plugin surface (an
   always-on body / `principles.md` vs a triggered skill).
2. **encode-in-repo-knowledge** — content is repo-specific (build
   gotchas, pipeline IDs, code-review rules for a particular repo);
   goes under `plugins/<plugin>/repo-knowledge/<repo>/*.md` where the
   `repo-handling` auto-loader picks it up.
3. **no-op** — content cannot be encoded in the plugin. carries a
   one-line rationale on the entry's `Status:` line and stays open on
   the originating friction doc. see the canonical example below.

### Triage the governing rule before encoding

Before choosing `encode-in-skill`, find the rule that should already have covered the card. If it exists, the defect is loading, placement, enforcement, or missing regression evidence; fix that instead of writing the rule twice.

If existing rules conflict, consolidate them under one owner. If instruction volume buried the rule, cut or simplify before adding prose. Group repeated cards by root cause and fix the governing defect instead of accumulating exceptions.

no deferrals. per `principles.md` Invariant 5, every card gets a
disposition in the same pass. "wait and see if it keeps happening" is
a deferral dressed up as a no-op; reject. the whole point of the pass
is that the board is clearer when it ends than when it began.

## Process

1. **list the still-pinned cards.** `ls $DESK/<track>/_friction/` plus
   `$DESK/_meta/friction.md` for cross-track entries. skip
   archived entries under `_archive/`.
2. **read each card end-to-end** before picking a disposition. don't
   skim. per `../../principles.md` Invariant 2, reactive edits without
   reading the full entry produce churn.
3. **decide disposition.** name the target file or rationale.
4. **batch decisions.** present dispositions to operator in one
   message with a clear table (entry → disposition → target). wait
   for signoff. per `../../principles.md` Invariant 1, don't walk the
   operator through one card at a time.
5. **encode in a single PR** against the plugin repo, one unit per
   card, with per-unit acceptance checks (grep-presence + engine-
   agnostic audit). worker uses the `work-planner` → `work-doer`
   skills for the planning/doing/execution pipeline.
6. **take landed cards down** in the same motion they shipped: update
   the `Status:` line to name the PR and merge SHA, move the entry to
   `_friction/_archive/`. see the `friction-management` skill.

## Engine-agnostic constraint

the plugin must not name a specific agent harness. don't ship:

- harness MCP tool names (use the underlying REST API instead — e.g.,
  `GET /_apis/git/repositories/.../pullRequests/{id}/threads`, not
  the MCP wrapper name).
- subagent-spawn primitives (worker is the agent; skills are
  instruction sets worker internalizes, not separate agents to
  spawn).
- harness-specific file paths like `.claude/settings.json` — see the
  canonical no-op below for the one exception.

the `AGENTS.md` hard constraint at the root of the worker repo
encodes this. per-unit acceptance checks grep for harness-tool
identifiers (double-underscore-prefixed tool names, subagent-type
keys, spawn-paren forms) and expect zero hits.

## What a valid no-op looks like: engine-specific protection

the canonical example of the no-op disposition: a card whose only
viable resolution is a harness-level configuration file
(pre-execution hook, command interceptor, settings flag) that is
engine-specific and cannot ship in the plugin without breaking on
other harnesses.

**shape of the ask:** make it structurally impossible for the agent
to perform some unsafe operation (push to the wrong account, write
to a protected path, run an irreversible command without
confirmation) by intercepting at the harness level.

**what can land in the plugin (acceptable):** a skill-level degrade
path that runs the safety check before the unsafe operation and
fails loud if the check doesn't pass. engine-agnostic, ships as a
skill, covered.

**what stays out of the plugin (the no-op):** the harness-level
interceptor configured in the operator's personal engine-specific
config file (e.g., a pre-execution hook in the operator's Claude
Code `settings.json`, an equivalent config in another harness).
this is a structural guardrail, layered under the skill-level
check.

**why it is a no-op for the plugin:**

- the hook is configured via an engine-specific file. the plugin
  is engine-agnostic: `AGENTS.md` hard constraint #1 forbids
  shipping harness-specific configuration in plugin content.
- shipping the hook in the plugin would break on any other harness
  that doesn't read that config file.
- the skill-level degrade path already handles the 99% case; the
  hook is belt-and-suspenders, not primary protection.

**disposition:** plugin-side no-op. card stays pinned on
`_meta/friction.md` with `Status:` updated to name the
operator-personal config file the hook belongs in
(harness-specific). operator handles the hook personally in their
own settings.

## When no-op is not the right call

don't reach for no-op because encoding feels hard. patterns that look
like they should be no-ops but aren't:

- "this is just a style preference" — style preferences encode into
  the applicable skill; not a no-op.
- "i don't know what skill to put it in" — that's a routing question,
  not a no-op signal. ask the operator.
- "it might change" — encode the current version. if it changes
  later, update the encoding. plugin content evolves; that's what
  PRs are for.

no-op is appropriate when: the content is structurally incompatible
with the plugin's engine-agnostic constraint (the engine-specific
protection case above), when the ask duplicates already-landed
content, or when operator explicitly decides against encoding after
seeing the proposal.

## Handoff back to worker

after all dispositions are decided and operator has signed off:

- encoded entries become units of a single PR against the plugin
  repo. worker uses `work-planner` → `work-doer` for planning and
  execution.
- no-op entries get their `Status:` line updated in-place. they stay
  pinned because the ask is not resolved, just redirected out of
  plugin scope — they do not move to `_archive/`.
- curator is done when the corkboard has zero undecided open cards.
