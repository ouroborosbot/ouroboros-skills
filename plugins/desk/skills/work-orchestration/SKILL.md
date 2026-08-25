---
name: work-orchestration
description: "Route engineering work through only the phases it needs: direct implementation for clear changes, planning for coordinated or risky work, then merge and terminal delivery."
---

# Work Orchestration

Worker remains the engineer; the `work-*` skills are optional workflow tools.

| Shape | Route |
| --- | --- |
| Clear, local, low risk | `work-doer` → `work-merger` |
| Coordinated behavior change | short `work-planner` → `work-doer` → `work-merger` |
| Ambiguous, novel, or high risk | `work-ideator` → `work-planner` → `work-doer` → `work-merger` |

Apply Ponytail inside coding and review. Skip a phase when its output would only restate what is already known. Use one cold branch review, escalating only a concrete high-risk finding.

Each repository gets its own branch and merge cycle. Independent parallel branches use separate worktrees and explicit `git -C <worktree>` commands. Human-only gates belong as late as possible and never interrupt ordinary authorized work.

The terminal state is merged, released or installed as applicable, smoked through the consuming surface, cleaned, and followed by an empty or out-of-scope continuation scan.
