---
name: task-lifecycle
description: The 8-state task lifecycle machine — states, valid transitions, the state-change protocol, and handling of adopted tasks with pre-completed planning. Use whenever a task changes state, or when checking whether a proposed transition is valid.
---

# Task lifecycle

Every task moves through a state machine with 8 states. The `status` field in `task.md` tracks the current state.

## States

| State | Description | Workflow phase |
|-------|-------------|----------------|
| `drafting` | Clarifying scope and choosing the route; a clear task can remain task-card-only | `work-orchestration` |
| `processing` | Writing code, running tests, implementing | `work-doer` |
| `validating` | Driving PR, required checks, merge, release/install, smoke, and cleanup | `work-merger` |
| `collaborating` | Human gate — waiting for operator input/review/approval | Paused for human |
| `paused` | Temporarily suspended by operator | No active work |
| `blocked` | External dependency, unclear requirement | No active work |
| `done` | Terminal delivery verified and archived | Terminal |
| `cancelled` | Abandoned by operator | Terminal |

## Checkpoint-type annotations on transitions (folded in from AIDLC 2026-05-18)

Each transition has a checkpoint type declaring how humans interact at that gate. AIDLC's `feature-orchestration` skill used 5 types (GATE / CHECKPOINT / AUTO / CONFIRM / NOTIFY); desk adopts them as a sibling layer on the existing state machine (annotations, not a replacement).

| Transition | Checkpoint type | What it means |
|------------|-----------------|---------------|
| → `drafting` | GATE | Entry point; operator must approve task creation OR worker creates autonomously per agent-initiated path |
| `drafting` → `processing` | AUTO | The request already authorizes implementation and the task card or optional plan gives enough direction. Use `collaborating` only when a real unresolved decision needs the operator. |
| `processing` → `validating` | AUTO | Worker self-attests that implementation is complete; opens PR; no human gate |
| `validating` → `done` | AUTO | Work Merger verifies the exact green merge plus applicable release/install, consuming-surface smoke, cleanup, and durable state. Explicit owner policies can still route a required approval through `collaborating`. |
| Any → `collaborating` | NOTIFY | Worker pauses + tells operator what's needed; resumption is operator-initiated |
| Any → `paused` | NOTIFY | Operator-requested pause; worker emits a clean handoff state |
| Any → `blocked` | NOTIFY | External blocker; worker emits the blocker reason + escalation path |
| Any → `cancelled` | CONFIRM | Operator confirms abandonment; rare; worker doesn't auto-cancel |
| `done` / `cancelled` → (terminal) | (n/a) | Terminal states; no further transitions |

**Why annotate:** the checkpoint type makes human interaction explicit. AUTO transitions proceed under the task's authorization; NOTIFY transitions explain a real pause. Do not manufacture a checkpoint because a planning document exists.

## Valid transitions

```
                    +---> collaborating ---+
                    |         ^            |
                    |         |            v
  drafting --> processing --> validating --> done
    |  ^          |              |
    |  |          v              v
    |  +--- collaborating   collaborating
    |
    v
  cancelled

  Any non-terminal state --> paused --> (return to previous state)
  Any non-terminal state --> blocked --> (return to previous state when resolved)
  Any non-terminal state --> cancelled
```

## State-change protocol

Every transition writes the applicable durable surfaces in order. Commit-message-only is not sufficient—a new session must reconstruct what happened from the task and track, plus a doing document when one exists.

### 1. Task card (`task.md`)

- Update `status` field.
- Update `updated` timestamp to ISO 8601 UTC.
- Body updates as transition dictates:
  - Transitioning to `processing`: add a "Current work" line pointing at the active branch and either the doing document or task card.
  - Transitioning to `validating`: add a "PRs" section listing every PR URL that represents this task (one per repo in multi-repo tasks), with repo name + PR title + status.
  - Transitioning to `done`: move the PR list to a "Landed" section with merge shas and record applicable release/install, smoke, and cleanup evidence.
  - Transitioning to `blocked` / `collaborating`: a "Blocker" / "Waiting on" line with the specific reason.

### 2. Doing doc, when present (for `processing`, `validating`, `done` transitions)

Clear tasks can execute from the task card without a doing document. When a doing document exists, keep it current. At minimum:

- Check off unit checkboxes (`- [ ]` → `- [x]`) for units completed.
- If work-doer produced a "progress log" at the top, append the current transition.
- On `validating`: record the PR URL at the top of the doing doc.

### 3. Track card (`track.md`)

- Update the relevant row in the Tasks table:
  - `State` column to the new status
  - `PR` column if a PR was opened (URL, one per repo in multi-repo)
- If transitioning to `done`: move the row into the "Landed" section or strike it; track the merge.

### 4. Commit + push

After the three artifact updates above:

```
cd $DESK && git add <specific-files> && git commit -m "task(<slug>): <old> -> <new>" && git push origin main
```

Auth and push convention is consumer-specific: corporate-worker overlays push under whatever enterprise-managed identity the org requires (the overlay's git-identity skill handles this); ouroboros agents push under whatever account their bundle's git remote is configured for; personal agents per their setup.

### 5. Downstream triggers

- If transitioning to `done` or `cancelled` → invoke `archive-workflow`.
- (Optional, overlay context) If the transition is shiproom-relevant (`processing`, `validating`, `done`, `blocked`) → invoke the consumer overlay's status-update skill to refresh the parent work-item's status note. Skip for non-coding / non-tracker contexts.

### Why the applicable writes

Commit messages are not a handoff format. A new session reading the task card must see current state, active branch/artifact, open PRs, blockers, and terminal evidence without shell archaeology. Keep the track card aligned and update a doing document only when the task has one.

## Adopted tasks with completed planning

When a task comes in from an external bundle with planning + doing docs already written, it still starts in `drafting` (consistent with the state machine). But the planning work is NOT re-done — worker jumps directly to `work-doer`.

Signal via task card frontmatter:

```yaml
status: drafting
planning_complete: true
```

When resuming a task with `planning_complete: true` and `status: drafting`, transition straight to `processing`—skip `work-ideator` and `work-planner`. Preserve the `planning_complete` flag through the transition for audit trail. A clear task without planning documents follows the same direct transition without needing this adoption flag.

## Dispatch is work-doer's call

Work-doer decides its own dispatch shape per unit based on task content — sequential vs sub-agent fan-out vs operator-gated. There is no pre-declared `Execution Mode` header on the doing doc; that field was removed because it was over-prescriptive and rarely matched the dispatch shape work-doer would actually pick. Adopted doing docs may still carry historical mode headers — work-doer ignores them.
