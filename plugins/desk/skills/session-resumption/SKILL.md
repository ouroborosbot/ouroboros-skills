---
name: session-resumption
description: Resume a specific non-terminal task the operator selected from the session-start status block. Reads the task card, checks the repo workspaces' git state, and re-enters the right workflow phase based on the task's current `status`. Use when the operator picks one of the listed active tasks.
---

# Session resumption

at the desk again. the operator picked an active task to resume — a manilla envelope already part-filled, papers laid out where the last session left them. pick up where things were, don't start over.

## Step 1 — Read the task card

```
$DESK/<track>/<task>/task.md
```

note: `status`, `planning_complete` (if set), `repos[]`, any `collaborating`/`blocked` reason fields. the card is the memory of what was happening; read it before reaching for anything else.

## Step 2 — Check repo workspaces

for each `mode: local` repo: `git status` for uncommitted changes, `git rev-list @{u}..` for unpushed commits, and the current branch. if anything surprises you (unclean tree, branch not matching the doing doc's expectation), surface it before doing anything else.

## Step 2.5 — Required MCPs hard-gate

if the resumption target's iteration doc (e.g., the active iteration's
`doing.md`, an `investigation.md`, or any per-iteration doc named in
the task card's `iterations.active`) declares `required_mcps:` in
frontmatter, treat that list as a **hard requirement** for resuming —
not a recommendation. the previous session committed to needing these
hands; opening the envelope without them just wastes everyone's time.

`required_mcps:` is a list of MCP keys matching aliased entries in
the workspace's runtime MCP config — either under
`[mcps.builtins.<alias>]` (runtime-proxied builtins) or
`[mcps.servers.<alias>]` (external stdio MCPs). both namespaces are
valid sources; the key just needs to be loaded at runtime. example
frontmatter snippet:

```yaml
required_mcps:
  - analytics-store
```

**check**: for each entry in `required_mcps`, consult the runtime's
loaded-MCP registry to confirm the key is currently loaded —
engine-specific. (implementations may probe the harness's own
loaded-MCP listing, an introspection MCP, or a tool-name-prefix
scan; encode the principle, not the API.)

**hard-stop**: if any required MCP key isn't loaded, **STOP at the
resumption prompt before proceeding to Step 3**. don't start the
phase, don't begin tool work, don't silently continue. print:

1. the list of required MCP keys that are missing.
2. the likely root cause: the runtime's workspace MCP config link
   absent, broken, or pointing somewhere else; or the MCP isn't
   declared in the workspace MCP config. reference session-start
   Step 4.7's link check.
3. a note that the agent will not proceed with this resumption
   until restarted with the required MCPs loaded.

example stop message:

```
Required MCPs not loaded for this iteration: [analytics-store]

Likely cause: workspace MCP-config link absent or broken.
session-start will create it on the next launch if the workspace
MCP config exists. Confirm the MCP is declared there, then restart
the agent.

Resumption paused until the required MCPs are available.
```

**why hard-stop, not recommendation**: when an iteration doc declares
`required_mcps`, the planning pass already determined the work
cannot proceed without those tools. letting the agent continue and
discover the missing tool mid-investigation wastes operator time
and contaminates the iteration's audit trail with abandoned work.
session-start's Step 4.7 is the soft self-healing path (creates the
symlink so MCPs auto-load next time); this gate is the hard
requirement at the resumption boundary.

if the iteration doc has no `required_mcps:` field, this step is a
no-op — proceed to Step 3.

## Step 3 — Re-enter the right phase

| Status | Resume action |
|--------|---------------|
| `drafting` (default) | Check for existing planning/doing docs. Resume one if present; otherwise use `work-orchestration` and transition clear work directly to `processing`. |
| `drafting` + `planning_complete: true` | Adoption case — skip ideator/planner. Transition directly to `processing` and dispatch `work-doer`. Preserve the flag through the transition for audit trail. |
| `processing` | Resume `work-doer` from the task card and branch, consulting the doing document when one exists. |
| `validating` | Resume `work-merger` through PR, checks, merge, release/install, smoke, cleanup, and terminal state. |
| `collaborating` | Show what was waiting on the operator. Ask for the specific input needed and wait. |
| `paused` | Ask the operator whether they want to resume (go back to the pre-pause state) or update the status. |
| `blocked` | Show the blocker description + when/why. Ask whether it's resolved. If yes, go back to the pre-block state. |

full transition rules and state machine live in the `task-lifecycle` skill.

## Step 4 — Commit any state changes

if resuming caused a status transition (e.g., `drafting` → `processing` because `planning_complete: true`), follow the state-change protocol in `task-lifecycle`: update the `updated` timestamp, commit, push, and trigger any downstream actions (status tweet, archive) as applicable.
