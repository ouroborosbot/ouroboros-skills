---
name: work-planner
description: Turn coordinated or risky engineering work into the smallest executable planning contract. Skip trivial work, reuse existing planning artifacts, and review in proportion to risk.
---

# Work Planner

Plan only when the plan prevents a real mistake.

## Route

- **Clear, local, low risk:** skip planning and implement.
- **Several coordinated files or a behavior change:** write or update a short doing-only document.
- **Cross-cutting, novel, or high risk:** write one planning document, then one doing document.

If a planning/doing pair already exists, reuse it. Update the current artifacts instead of creating competing plans.

## Ground

Before drafting, fetch every relevant repository and verify the checkout against the current target base. Read current source and repository instructions, then record the source refs and requirements that make the plan true.

Resolve only material unknowns. Choose one design. Apply Ponytail: reuse existing code, standard-library and native features, and installed dependencies before custom machinery.

## Write the contract

The planning document records objective, evidence, chosen design, scope, non-goals, risks, validation, and decisions. The doing document contains dependency-ordered vertical slices with concrete acceptance.

Every behavior-changing slice names:

- the test or fixture written before implementation and its observed red;
- the minimum green behavior;
- 100% statements, branches, and functions coverage for new and modified production logic, including error, null, empty, boundary, and negative paths with no changed-file exclusion;
- the build, full-suite, and consuming-surface proof required before completion.

Strict TDD requires an observed red: test first, record the intended failure, freeze the test, implement the minimal green, then refactor while green. UI or rendered-output work also invokes `visual-qa-dogfood`.

### Preserve confirmed customer decisions

When customer-visible behavior differs by status, lifecycle state, type, origin, role, host, platform, permission, or feature configuration, record each canonical value separately with the customer situation, inclusion harm, exclusion harm, evidence, recommendation, strongest counterargument, confirmed outcome, and exact confirming authority. Never combine distinct values or select or exclude one because implementation is easier. An unresolved conflict means the planning document is not ready.

Before marking a doing document ready, reconcile every confirmed decision and acceptance criterion to the chosen design, a planned implementation slice, its falsifiable test, and consuming-surface proof. Missing, contradictory, or implementation-narrowed entries remain unresolved.

## Review

Review matches the route:

- **Doing-only:** run one fresh cold reviewer selected by the dominant risk. Use **Tinfoil Hat** for omissions, dependencies, failure paths, and trust boundaries; use **Stranger With Candy** for plausible-but-false semantics, ownership, and canonical-state claims.
- **Cross-cutting, novel, or high risk:** run both Tinfoil Hat and Stranger With Candy as fresh zero-context reviewers against the same source and document hashes.

A top-level host uses native subagents or fresh isolated subprocess sessions. A nested host emits complete reviewer briefs, marks the artifact not ready, and returns the obligation to its parent. Inline self-review does not satisfy the gate.

Fix blocker and major findings, then recheck the changed surface once. Do not add generic review ladders, no-change commits, or default operator approval.

## Hand off

Mark the doing document ready and hand it to `work-doer`. A planning document is a tool, not a prerequisite.
