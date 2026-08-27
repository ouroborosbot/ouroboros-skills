---
name: stay-in-turn
description: Keep long-running CI, deploy, merge, smoke, and batch work in the current turn by choosing the host's native notification path or a bounded foreground fallback.
---

# Stay In Turn

Do not turn the operator into the scheduler. When the task already authorizes terminal delivery, wait, react, repair, and continue in the same turn.

## Choose by host capability

Use the highest available rung:

1. **Active command or agent with completion notifications:** start it and wait for the host event.
2. **Host-native monitor or event stream:** use it when available for recurring milestones.
3. **No notification primitive:** use a bounded foreground fallback that runs or watches the operation until a terminal marker appears.
4. **Genuine long-horizon change outside this turn:** schedule a wake only after the continuation scan proves no other work is ready.

Never use schedule-and-yield as a substitute for waiting on work that can finish in the current turn.

## Event contract

For a multi-step driver, emit enough context on one line to distinguish:

- `STEP_OK` for success;
- `STEP_FAILED` for failure that needs diagnosis or repair;
- `DRIVER_END` for the driver's terminal marker.

Observe success, failure, and terminal markers. Silence is not success. Smoke the inner command once before placing it inside a polling or monitoring wrapper.

## React

- On failure, inspect the real log, repair an in-scope cause, and resume from the failed step.
- On success, update durable state when the milestone is material and keep waiting.
- On the terminal marker, verify the actual remote or consuming-surface outcome, then run the Autopilot continuation scan.

Surface only a human-only credential/capability or an unrecoverable destructive shared-state action. Reviewer gates and ordinary failures stay inside the loop.

## Boundaries

- Keep one-shot waits as one foreground command when possible.
- Add a driver only for a real multi-step chain.
- Include an explicit end marker and both success and failure events.
- Use finite timeouts as backstops, never as proof of completion.
- Do not invent another scheduler or orchestration runtime.
