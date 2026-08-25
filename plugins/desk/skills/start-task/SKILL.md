---
name: start-task
description: >-
  Start a new task in the workspace from either an operator description or an
  agent-initiated proposal. Produces a task card in the appropriate track
  directory. Use when the operator says "start a new task: <description>",
  "work on X", "I need to do Y", "track this", "this is worth tracking", or
  when an agent recognizes mid-conversation that it's working on something
  task-worthy ("I'm investigating Z; let me track this") and proposes creating
  a task.
---

# Start a task

A task enters the workspace through one of two paths. Both end in the same
place: a new `task.md` under a track directory in `$DESK/`.

For overlays with their own work-item tracker (and a work-item ID),
consumer overlays typically ship a tracker-aware `start-task` variant
that also captures the tracker's ID + URL and walks the work-item-
relations chain to find the parent Feature's track.

## Path A — operator-described

Triggers: "start a new task: …", "work on …", "I need to add X to Y",
"let's track …", "new task: …".

1. **Propose the slug first.** kebab-case from the description. Wait for
   operator confirmation before creating any directory (slug permanence —
   see `desk:interaction-style` if it exists in this plugin, otherwise
   match the workspace's slug conventions).
2. **Pick the track.** Show existing track directories under `$DESK/`. If
   none fit, propose a new track slug and create a `track.md` first using
   `desk:track-card-format`.
3. **Create the task directory** at `$DESK/<track>/<slug>/` and write
   `task.md` per `desk:task-card-format` with:
   - `title: <slug>`
   - `status: drafting`
   - `created` / `updated`: now (UTC ISO-8601)
   - `track: <track-slug>`
   - `initiated_by: operator`
   - `repos: []` — populate only if the description names code repos;
     otherwise ask, or leave empty for non-coding tasks.
4. **Commit + push** the new task card to the workspace repo.
5. Hand off to `work-orchestration`. Clear work can transition directly to `processing`; create planning/doing documents only when coordination, novelty, or risk makes them useful.

## Path B — agent-initiated

Triggers: the agent notices mid-conversation that it's doing something
worth tracking ("I'm digging into Z — this is a real task, not a
one-shot answer"), OR the operator mentions something in passing that's
clearly task-shaped ("oh, worth tracking that").

1. **Propose, don't assume.** Surface the proposal in one line:
   `Proposing new task <slug> in track <track>. Confirm?` — unless the
   agent's scope explicitly authorizes self-initiated task creation, in
   which case proceed and announce.
2. **Same task.md shape as Path A**, except:
   - `initiated_by: agent`
   - Include a one-line `origin_note:` field summarizing what the agent
     was doing when it noticed (e.g. "spawned from investigation in
     `<other-task>` on 2026-05-18").
3. Track selection, directory creation, commit, push: same as Path A.
4. Resume the in-flight conversation; the task card is now the durable
   anchor for the work.

## Output shape (both paths)

```yaml
---
title: <slug>
status: drafting
created: <UTC-ISO-8601>
updated: <UTC-ISO-8601>
track: <track-slug>
initiated_by: operator | agent
# origin_note: "<context>"   # Path B only
repos: []                    # optional; only if coding work
---
```

See `desk:task-card-format` for the full schema (adoption signals,
iterations history, repo `local_path` portability), `desk:track-card-format`
for the parent track shape, and `desk:directory-structure` for where this
all lands under `$DESK/`.

## Linking later

Either path can be linked to an external tracker (GitHub Issue, Jira,
or an enterprise work-item tracker) after creation by appending the
relevant fields to `task.md`. No state transition required.
