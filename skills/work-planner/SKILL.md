---
name: work-planner
description: Turn substantial or ambiguous engineering work into one executable plan and doing document. Skip for trivial or already-obvious changes; use the existing task description directly.
---

# Work Planner

Plan only when the plan prevents a real mistake.

## Choose the path

- **Clear, local, low risk:** skip planning and implement.
- **Several coordinated files or a behavior change:** write a short doing document.
- **Cross-cutting, novel, or high risk:** write one planning document, then one doing document.

## Plan

Ground the plan in current source and existing patterns before inventing anything. Apply Ponytail: reuse, stdlib, native features, and installed dependencies before custom machinery.

The planning document records objective, evidence, chosen design, scope, non-goals, risks, validation, and decisions. The doing document contains dependency-ordered vertical slices with concrete acceptance.

Use one cold review for cross-cutting or high-risk work. Fix blocker/major findings and re-check the changed surface; do not run a fixed ladder of reviewer personas, create no-change commits, or seek human approval under an authorized autopilot task.

Mark the doing document ready and hand it to `work-doer`. A planning document is a tool, not a prerequisite.
