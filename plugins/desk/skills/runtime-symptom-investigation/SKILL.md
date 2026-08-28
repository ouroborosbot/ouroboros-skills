---
name: runtime-symptom-investigation
description: Invoke ONLY when the operator describes a runtime symptom that seems wrong — error responses, things that worked before now don't, unexpected outputs, performance changes — and worker would otherwise default to depth-first source-code reading. Triggered by phrases like "X is returning Y but shouldn't", "this used to work", "do not return until you understand exactly why X". Do NOT invoke for implementation tasks, design questions, or generic code-walking questions where no runtime behavior is in question.
---

# Runtime-symptom investigation

This skill inherits all invariants in `../../principles.md`. Read
them first if they are not already in context.

Invoke this skill when the operator describes a runtime behavior
that seems wrong: error responses, unexpected outputs, things that
worked before but don't now, performance changes. Worker remains the
agent; runtime-symptom-investigation is a set of instructions worker
follows for the diagnostic task.

## The principle

The work of debugging is to narrow the hypothesis space to a single
cause. Understanding the system is INSTRUMENTAL to that goal, not
the goal itself.

Code analysis builds models of MECHANISM. Many mechanisms produce
similar symptoms — mechanism alone doesn't narrow hypotheses.
Hypotheses narrow when EVIDENCE about runtime state discriminates
among them. Reframe the prioritization question from "what do I
learn next?" to "what observation maximally reduces my hypothesis
space?"

## The procedure

1. **Enumerate the hypothesis space.** Even rough buckets — for a
   runtime symptom, the rough hypothesis space almost always
   includes:
   - **State of system**: deployed version, config loaded, feature
     flag.
   - **Identity / authorization**: user role, tenant membership, app
     permissions, scope claims.
   - **Routing / reachability**: did the request reach the code, or
     bounce earlier (auth middleware, edge route, dev-server proxy,
     DNS).
   - **Code-level bug**: actual mechanism in the code path being
     exercised.
   - **Downstream**: backend rejected the proxied call.

   Skipping enumeration biases toward the bucket worker has
   cheapest access to (usually source code in a local clone), not
   the one most likely to be true.

2. **For each pair of hypotheses, identify a discriminating
   observation.** What single observation tells me A vs B?

3. **Rank observations by cost-per-discrimination.** Discrimination
   beats raw cost. An observation that costs more but discriminates
   many pairs beats one that costs less and discriminates none.

4. **Take the highest-ranked observation.** This may be:
   - Asking the operator a one-sentence discriminating question.
   - Comparing against the closest-neighbor "control" request — the
     gold-standard discriminator for "some routes work, this one
     doesn't."
   - Verifying state assumptions (deployment version, config
     loaded, feature-flag state).
   - Inspecting recent changes (git log, deploy/release records,
     recent incidents on chat).

5. **Update the hypothesis space.** Repeat step 4 until one
   hypothesis remains.

6. **Only THEN go deep on code mechanism.** Use code analysis to
   confirm and explain the surviving hypothesis, not to discover
   it.

### Prove the cause before changing behavior

Do not change product behavior while the cause remains a hypothesis. A surviving hypothesis is not proof: confirm it counterfactually by changing the one suspected input or condition and observing the symptom appear and disappear with it. If the symptom does not track, return to step 1 because the hypothesis space was incomplete.

Record every temporary diagnostic change before use. Before handback, reverse only that diagnostic delta and verify its added content and artifacts are absent. Preserve unrelated concurrent changes; a pre-investigation fingerprint is evidence, not ownership. Never restore a fingerprint by undoing a concurrent user or tool change. A diagnosis leaves no logging, probes, injected failures, temporary configuration, or other diagnostic edits in the worktree.

## Asking the operator IS one of the cheapest observations

The operator has:

- An authenticated session worker can't replicate.
- Knowledge of recent operational issues ("deploys are stuck,"
  "X service is degraded today").
- Knowledge of what they've already tried.
- Knowledge of which environments are healthy.

A one-sentence question drawing on any of those is the cheapest
move available. Treat "ask the operator a discriminating question"
as a first-class action, not a fallback. If the operator volunteers
a hint mid-investigation ("the old path still works, by the way"),
treat it as a high-priority observation, not a side note.

## Don't dismiss hypotheses without evidence

Hand-wave dismissals — "Phase 1 is presumably deployed somewhere,"
"that pipeline hasn't broken before" — fail when wrong. The
reasoning is thin: it cites assumption rather than evidence, and
when the assumption is the load-bearing one, dismissing it costs
the rest of the investigation.

Load-bearing assumptions deserve verification, not dismissal.
"Presumably deployed" should be "verifiable in two tracker queries."
If a hypothesis is cheap to verify, verify it before ruling it out
— even when current intuition rates it unlikely.

## Predict before observing

Before each tool call in a debugging investigation, complete the
sentence: "If this observation returns X, my top hypothesis becomes
Y; if it returns X', it becomes Y'."

If you can't fill it in, the observation isn't discriminating
anything. Either the wrong observation is about to be taken, or the
hypothesis space isn't articulated enough yet. Switch to a
different probe, or back up and re-enumerate.

This is the runtime check on step 4 of the procedure: an
observation that can't be predicted is one that won't narrow.

## Anti-patterns

- Going deep on source code before enumerating hypotheses.
- Running an observation without being able to predict the branches
  ("if X, then Y; if X', then Y'").
- Dismissing a hypothesis with reasoning rather than verification.
- Building a model of mechanism without ground-of-evidence — a
  correct mechanism that doesn't discriminate among hypotheses
  doesn't move the investigation forward.
- Treating "do not return until you understand" as "go deep" when
  it actually means "narrow to one cause."

## Poll vs inspect — switch when the metric stops moving

The "narrow hypothesis space" principle has a specific runtime corollary
that's worth naming explicitly: when polling a single metric stops being
informative, switch to inspecting runtime state directly.

**One-sentence statement.** When a polled metric (e.g. `iter-count`) is
unchanged across N consecutive polls, worker switches from polling to
inspecting runtime state (logs, processes, file mtimes, scheduled-task
LastTaskResult) — does NOT keep polling.

**Trigger phrase.** "I've polled the same number twice and it didn't
move." Or: "The progress counter looks stuck."

**What to do.** Stop polling. Inspect, in this order, whichever applies:
(1) the supervisor's last-result code (`Get-ScheduledTask | Get-ScheduledTaskInfo`,
`systemctl status`, `kubectl describe cronjob`); (2) the most recent
iter log file's tail; (3) any orphan process list; (4) `ls -lt` on the
artifact directory to see if anything wrote in the last N minutes. The
question shifts from "what's the count?" to "what is the runtime
ACTUALLY doing?"

**Anti-pattern.** Polling `iter-count=0` for 90 minutes while assuming
"any minute now." Polling is for change-detection on a known-healthy
runtime, not for diagnosis of a maybe-stuck one.

**Why this rule lives here.** This skill's core principle is "narrow
the hypothesis space; pick cheap discriminators." Continued polling on
a stuck metric narrows nothing — every subsequent poll gives the same
zero-information observation. The runtime-state inspect is a different
observation type (state of supervisor, freshness of artifacts, presence
of orphans) and discriminates between hypotheses ("is the supervisor
firing iterations at all?" / "are iterations firing but failing
silently?" / "did the runtime exit and not get restarted?").

**Cross-link.** Pairs with `../evidence-discipline/SKILL.md` "smoke
before infinity" — if the smoke gate caught the per-iter failure, the
polled metric would never be reading zero in the first place.

## The control-plane view is not the inside ground-truth

When the question is "is this system alive or wedged?", the control-plane / outside view — an orchestrator's status fields, a cloud provider's power/provisioning state, an "is it running" API — is NOT the inside ground-truth. Control-plane state-machine fields routinely stick in a transitional value (`Updating`, `Pending`, `Terminating`) for many minutes while the system underneath keeps operating normally. Treating the outside view as authoritative produces the classic over-diagnosis — "it's wedged, restart it!" — when the truth is "it's fine, the control plane is just lagging."

Before declaring a system wedged or reaching for aggressive recovery (force-restart, redeploy, hard-stop), find the **authoritative inside signal** and check that first:

1. Identify the signal the system emits from the *inside* — a heartbeat it writes, a health endpoint it serves, a log line it appends, a queue it drains. That is ground-truth; the control-plane status is hearsay about it.
2. Is the inside signal fresh (within its expected cadence)? If yes → the system is alive; pivot to non-destructive diagnosis (read its logs, its error fields) instead of restarting.
3. Only if the inside signal is genuinely stale — well past its expected cadence — is the system actually down and aggressive recovery justified.

The inside-signal check is cheap; the mistake it prevents — restarting a healthy-but-slow system and making things worse — is expensive. This is the source-of-truth variant of [§Poll vs inspect](#poll-vs-inspect--switch-when-the-metric-stops-moving): that section is about watching the right *metric*; this one is about trusting the right *source*.
