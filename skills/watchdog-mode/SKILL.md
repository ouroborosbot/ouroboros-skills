---
name: watchdog-mode
description: Invoke when the operator activates a watchdog mandate -- phrases like "keep an eye on X", "watchdog this", "monitor Y across silences", "keep watching", "let me know if anything smells off". Watchdog mode is autonomous monitoring + repair across operator silences, with a strict scope of what worker takes action on vs. what worker surfaces. The skill encodes the cadence, the scope of acting-vs-surfacing, the carve-outs that keep watchdog from overreaching, and the exit signal.
---

# watchdog-mode

When the operator activates watchdog mandate, worker enters a sustained monitoring-and-repair posture across operator silences. The skill encodes the protocol so each watchdog activation pulls in the same canonical shape -- no re-deriving cadence and carve-outs every time.

## Trigger phrases

Operator says one of:

- "keep an eye on X / Y / both"
- "watch over X while I'm out"
- "watchdog this"
- "monitor Y across silences"
- "keep watching"
- "let me know if anything smells off / regresses / breaks"
- "i want you to take care of it" (in the context of monitoring; not single-action)
- Any equivalent "stay attentive across my silences and act when you see X" framing

The mandate carries autopilot semantics -- see `autopilot` for the parallel rule about sub-agent review IS confirmation, never wait for human review under autopilot mandates. Watchdog is a stricter sub-mode of autopilot (see "Relationship to autopilot" below for how the two compose).

## What to do -- the cycle

Watchdog mode is a loop, not a one-shot action:

1. **Pull state.** Periodically (cadence below) pull main on workspace + canonical clones; canonical-clone-sync propagates writes from other hosts.
2. **Watch the configured surfaces.** What to monitor is operator-specified at activation:
   - Long-running compute (long-running agent runs, investigator runs, supervised reboots, autopilot iterations)
   - Persistent surfaces (chat channels for new posts, dashboards for visible regressions, issue trackers for new bug filings)
   - Substrate health (vm-side processes, scheduled tasks firing, expected heartbeats arriving)
3. **Detect smells.** What counts as a "smell": regressions, broken state, unhealthy signal, repeated spam, unexpected silences, missing heartbeats, runs in unexpected states.
4. **Investigate + act** on in-scope smells (see carve-outs). Surface out-of-scope smells with the diagnosis prepared, but don't take action without explicit operator approval.
5. **Schedule the next check** at the appropriate cadence.

## Cadence

Invoke `stay-in-turn` and use its host-capability branch for active checks: native notifications first, then a host monitor when available, otherwise the bounded foreground fallback. For genuine future checks after no ready work remains, use Autopilot's long-horizon wakeup section.

What's watchdog-specific is **tuning the cadence to match what's being watched**:

- Default for typical substrate workloads: **~30 min between checks**.
- If watched iterations run every ~90 min, check at ~30-min cadence (catch each iteration's posting + status near completion).
- If runs are sub-minute, the natural check cadence is "after each notification" -- no fixed wake-up needed.
- If watching for a specific scheduled event (a midnight rotation, a daily report), schedule a wake-up just before it, not on a fixed interval.

Don't poll faster than necessary -- the watchdog cycle's tax is in operator-attention-cost-per-check, not just wall clock.

## Probe the authoritative source, not a lagging local replica

The watchdog's worst false alarm is mistaking a system's *documented self-protection* for a failure. The classic case: a system that deliberately defers syncing its local clone to the shared remote during an active work cycle, so the local `main` lags the remote by up to one cycle's duration. A watchdog probing the LOCAL replica ("newest run on local main") reads a stall that isn't there -- the work is live on the remote.

So when checking "is the monitored system alive / making progress?":

1. **Probe the authoritative source, not the lagging local replica.** Fetch from the remote directly (e.g. `gh api repos/<owner>/<repo>/contents/<path>?ref=main`) rather than reading a local clone that may be mid-deferred-sync.
2. **Treat the system's own freshly-emitted signal as the primary liveness check** -- a heartbeat / sidecar it writes every few minutes -- not a derived view ("newest artifact on main") that only updates on a sync that may be deferred. (This is the watchdog form of `desk:runtime-symptom-investigation` "the control-plane view is not the inside ground-truth.")
3. **Model the known sync-lag windows explicitly.** If the system defers sync during an active cycle, expect the local replica to lag by up to one cycle's duration after a publish; do NOT escalate a "no new progress on local main" alarm during that window. A documented trade-off is not a failure mode.

## Attribution -- default to the fleet, not the operator

In supervised / autonomous-fleet mode the operator is **supervising, not implementing** -- workspace and repo activity is overwhelmingly the fleet's (peer agents); the operator drops in only to redirect. So **default to attributing workspace/repo activity to the fleet / a peer agent, not to the operator**, unless the operator's own text channel shows they're actively driving.

Why it matters: misattributing peer-agent work to the operator lies to them about who's doing what, loads them with bookkeeping that isn't theirs, and corrupts the watchdog's own situational picture -- "operator-active" read as "operator-on-task" hides that the operator may be AFK and that an escalation needs to be *louder*.

Git author doesn't disambiguate (peer agents often commit under the operator's configured identity). Heuristics that do: cadence (an agent commits faster than a human), commit-message shape (verbose "what + why"), and parallel-track breadth (a human is usually focused on one thread; a fleet spreads across many in the same window). **Sweep snapshots should label "workspace activity (fleet)" distinctly from "operator messages"** -- listing commits without attribution is what breeds the lazy default.

## Carve-outs -- what's IN-scope vs. OUT-of-scope

**In-scope (worker can act without further approval):**

- Bookkeeping: archive completed tasks, sync mirrors, push pending state, commit cards.
- Workspace hygiene: clean up stale local branches, run `git pull` on agreed repos, fold finished iterations.
- State-sync: write known-state.json updates, dashboard-state.json updates, run-record commits.
- Substrate self-heal: restart a stalled scheduled task, refresh a stale token **on a worker-owned per-host credential cache only** (NOT on shared / pooled credentials where the refresh could revoke a peer agent's session or trip lockout policies), retry a flaky probe.
- Investigation: spawn sub-agents to dig into smells; produce findings; capture as friction entries.

**Out-of-scope (worker must surface, not act):**

- **Destructive social actions** -- posting to chat channels, reassigning issues to people, force-pushing, deleting branches, sending email or chat messages. Surface findings; let the operator decide.
- **Substrate-product fixes** -- when the smell is a product bug in the system worker is watching (e.g., a retrieval miss in the monitored service), that's the owning team's domain, not watchdog's. File a tracking note + surface; don't try to fix the product.
- **Anything irreversible against shared state** -- drop tables, prod database modifications, ACL changes, cert rotations.

The line between in-scope and out-of-scope is the boundary of "actions worker can fully undo or that affect only worker's own substrate." Cross that line and the action requires explicit operator approval.

### Relationship to autopilot

Autopilot's social-action stance is *"most 'social action' cases are already covered by the mandate when it's been given"* -- i.e., under a generic autopilot mandate, the agent IS expected to take social actions the mandate covers (chat posts, reassignments, etc.).

**Watchdog narrows autopilot's social-action license.** Under watchdog semantics, destructive social actions surface to the operator even if the parent autopilot mandate would have authorized them. The reason: watchdog is a sustained loop running across silences with no operator-in-the-moment to course-correct, so social-action mistakes compound. The parent autopilot's social-action license re-applies the moment watchdog exits.

If both mandates are active and the in-scope/out-of-scope lines disagree, **watchdog wins** for the duration of the monitoring loop.

## Exit signal

Watchdog continues until the operator says one of:

- "stop watching"
- "I've got this from here"
- "watchdog off"
- "no need to keep monitoring"
- Or any equivalent stand-down framing

Until then, keep watching. The exit signal is **always explicit** -- don't decide on your own that "watchdog is probably done now." If you're unsure whether the operator wants you to keep watching, ASK; don't unilaterally stop.

## Pairing with other skills

- `autopilot` -- watchdog mandates carry autopilot semantics; sub-agent review IS confirmation; never wait for human review for in-scope work.
- `friction-management` -- substrate-product issues worker watches but can't fix get captured as friction entries (track-scoped or cross-track per the friction's shape).
- `evidence-discipline` -- when investigating a smell, apply the scenarios (especially "messages over models" for explicit warning lines + "smoke before infinity" before any auto-restart wrapper + "verify-precedent-against-HEAD" when the smell prompts a "this used to work" claim about a prior change).
- `interaction-style` §6 + §7 -- "lead with action; no trailing offers" applies in watchdog reports; surface findings cleanly, no "want me to keep watching?" framings.

## Anti-pattern

Watchdog mode without explicit scope-of-action discipline drifts into either:

- **Over-acting** -- worker posts to channels, reassigns bugs, takes destructive social actions because "I see the smell, I should fix it." The carve-outs above are non-negotiable; surface the finding instead.
- **Under-acting** -- worker watches, sees smells, surfaces them, but never takes the bookkeeping / state-sync / self-heal actions that ARE in scope. Operator wakes up to a pile of findings and zero ground covered. The point of watchdog is that worker ships the in-scope actions itself.

The discipline is: **drive the in-scope cycle; surface the out-of-scope findings; let the operator do the social/destructive actions**.
