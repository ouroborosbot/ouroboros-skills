---
name: autopilot
description: Keep an explicitly delegated long-horizon task moving through audited durable state, terminal delivery, and the next ready item without returning routine control.
---

# Autopilot

Authorization covers the complete stated outcome and its obvious continuation. Decide routine scope, sequencing, implementation, review, and repair without handing control back.

## Authority

First-person future wording such as "I'll send it" preserves operator ownership of the live send; it is not delegation. Partner-operated or destructive shared-state mutation requires an owner SOP or explicit authority.

## Durable state

Keep one current record with these exact sections:

- `## Current Item`
- `## Terminal Evidence`
- `## Continuation Scan`
- `## Stop Condition`

The Continuation Scan uses `candidate | classification | evidence | disposition`. Allowed classifications are `ready`, `needs reviewer gate`, `hard exception`, `deferred by scope`, and `none`.

Revalidate persisted terminal, source, and installed claims against live state before trusting or resuming them. Pair every durable hot-patch with its source change and delivery path.

## Loop

1. Read durable state and the first non-terminal task.
2. Revalidate the recorded source, remote, release or install, and smoke evidence.
3. Choose the next ready action.
4. Execute it with the relevant skill and update durable state after material transitions.
5. Drive code through `work-merger`; merged without release/install/smoke/cleanup is not terminal.
6. Scan again. If ready work remains inside scope, start it.

Prefer direct progress over status narration.

## Long-horizon wakeup

Use the `stay-in-turn` host-capability branch while an active command, agent, monitor, notification, or bounded foreground fallback can keep work alive. Schedule a wake only when conditions must change outside this turn and the continuation scan proves no other work is ready.

## Stops

- a human-only credential or capability;
- an unrecoverable destructive shared-state action;
- the requested outcome is delivered and the continuation scan is empty or deferred by scope.

A policy state named `needs-human-approval` maps to `hard exception` only when it is genuinely human-only. Otherwise map it to blocking `needs reviewer gate`, keep working, and do not write the literal policy state in the classification cell.

Do not manufacture approval, park at a planning boundary, treat context size as a limit, or return an option menu where the task already authorizes a decision.
