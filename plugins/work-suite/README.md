# work-suite

Work Suite 2 is the portable Ourostack workflow bundle. It keeps the useful lifecycle—understand, plan when needed, implement, merge, and verify—without making ceremony the default.

| Skill | Purpose |
|-------|---------|
| `work-ideator` | Resolve the unknowns that would materially change implementation |
| `work-planner` | Plan coordinated or risky work; skip planning when the change is already clear |
| `work-doer` | Implement the smallest correct vertical slice and validate the changed behavior |
| `work-merger` | Open, drive, merge, release or install, smoke, and clean up |
| `visual-qa-dogfood` | Use screenshot-backed dogfooding for UI/rendering work |
| `autopilot` | Keep authorized long-horizon work moving until terminal state |
| `stay-in-turn` | Keep CI, deploy, smoke, and multi-PR waits inside the same turn |
| `inch-worm` | Repeat an open-ended improvement loop while each next step remains justified |

## Ponytail dependency

Work Suite depends on the packaged upstream `ponytail-upstream` plugin, pinned to Ponytail v4.9.0. Coding work follows Ponytail's ladder: question whether code needs to exist, reuse the codebase, prefer standard-library/native/already-installed capabilities, choose the simplest viable approach, and write custom machinery only when necessary.

Ponytail applies to coding work, including implementation, refactoring, debugging, tests, and code review. It does not truncate requested research, documentation, analysis, or operational work. Plain Language remains the authority for human-readable output.

The upstream files are vendored unmodified and hash-locked in `upstream-sources.lock.json`; Ourostack owns only the provider manifests and integration.

## Autopilot mode

When the principal delegates sustained autonomy, `autopilot` keeps selecting ready work until the requested outcome is terminal. It stops only for a true human-only access wall, an uncovered irreversible action, or `needs-human-approval`.

Terminal state includes merged changes, green required checks, applicable release/install/deploy and smoke evidence, current durable state, and no stale branch, PR, or worktree from the run. Reviews are risk-driven rather than a fixed ladder: use one cold review for cross-cutting or high-risk work, fix meaningful findings, and continue.

### Runtime visibility audit

The work-suite contract includes a small source/runtime audit:

```bash
node scripts/audit-work-suite-runtime.cjs --repo-root /path/to/ouroboros-skills \
  --skill-root ~/.agents/skills \
  --skill-root ~/.codex/skills \
  --active-skills autopilot,work-ideator,work-planner,work-doer,work-merger,visual-qa-dogfood,stay-in-turn,inch-worm
```

Use it when a skill was installed or updated but the current host menu may be stale. Source drift is a hard failure. Installed-root drift and active-menu gaps are explicit runtime evidence: read the installed `SKILL.md` directly for the current run, record the mismatch in durable state, and refresh or restart the host before relying on menu discovery.

### Autopilot state audit

Before a final response under autopilot, run the durable-state preflight when this repo tooling is available:

```bash
node scripts/audit-autopilot-state.cjs --state-file /path/to/AUTOPILOT-STATE.md
```

The state file must record `Current Item`, `Terminal Evidence`, `Continuation Scan`, and `Stop Condition`. The continuation scan table uses `candidate`, `classification`, `evidence`, and `disposition`; final-state audits fail while any candidate remains `ready` or `needs reviewer gate`. Use a single `none` sentinel row when the scan found no candidates at all.

## Install

Pick the command for your engine:

```bash
# Anthropic Claude Code (native)
# Needs a marketplace manifest. Add one alongside this plugin, or consume via the
# top-level skills/ directory using the skill-management flow instead.
```

Copilot-compatible hosts normally receive Work Suite through Desk's generated flattened bundle metadata. Install this plugin directly only when you want the workflow skills without Desk.

## Relationship to `skills/`

These SKILL.md files are **copies** of the matching top-level `ouroboros-skills/skills/*/SKILL.md` workflow skills. The top-level `skills/` directory remains the canonical edit surface for the `skill-management` flow and for direct-curl consumers. This plugin exists to make the same workflow suite installable across plugin-managed sessions.

**Keep in sync**: when you edit a skill at the top level, also update its copy here (and vice versa). CI fails when any bundled Work Suite skill copy differs from its canonical top-level skill.

## Why a plugin, not just loose skills

- Claude Code's loose skill path is `~/.claude/skills/` — Claude-only.
- Copilot CLI has **no loose-skill path**; skills reach Copilot only via installed plugins.

Shipping this bundle as a plugin is the only way to deliver the full workflow suite to plugin-only operators. Operators who only use Claude Code and are already on the `skill-management` flow can ignore this plugin entirely.

## Vendor-neutral by design

The `.claude-plugin/plugin.json` manifest is the shared cross-vendor format (originated by Anthropic's Claude Code spec, accepted verbatim by Copilot CLI).
