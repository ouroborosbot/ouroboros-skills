---
name: autopilot
description: Keep control of an explicitly delegated long-horizon task through implementation, merge, release or install refresh, smoke, cleanup, and the next ready item. Use when the user says autopilot, keep going, do not return control, ship it, or equivalent.
---

# Autopilot

Authorization covers the complete stated outcome and its obvious continuation. Decide routine scope, sequencing, implementation, review, and repair without handing control back.

## Loop

1. Read durable state and the first non-terminal task.
2. Choose the next ready action.
3. Execute it with the relevant skill and update durable state after material transitions.
4. Drive code through `work-merger`; merged without release/install/smoke/cleanup is not terminal.
5. Scan again. If ready work remains inside scope, start it.

Prefer direct progress over status narration. Use scheduled wakes only when the runtime cannot notify you and no active command or agent can keep the turn alive.

## Stops

- a human-only credential or capability;
- an unrecoverable destructive shared-state action;
- a `needs-human-approval` state explicitly owned by another policy;
- the requested outcome is delivered and the continuation scan is empty or out of scope.

Do not manufacture approval, park at a planning boundary, treat context size as a limit, or return an option menu where the task already authorizes a decision.
