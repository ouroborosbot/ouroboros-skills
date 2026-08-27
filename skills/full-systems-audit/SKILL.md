---
name: full-systems-audit
description: Perform a comprehensive codebase audit covering architecture, code quality, and modularization. Produces an audit report plus a routed backlog for work-planner, inch-worm, and companion skills.
---

Audit a codebase end-to-end and produce durable execution artifacts for the rest of the skill ecosystem. You are the mapper and router, not the one giant executor. Large structural items should flow into `work-planner` / `work-doer` / `work-merger`; only after those land should the surviving small items be re-evaluated and handed to `inch-worm`.

## When to use

- Before a major refactoring effort
- When onboarding to an unfamiliar codebase
- When code quality or architecture concerns have accumulated
- Periodically, to catch boundary drift and god-module growth

## Primary contract

Your default output is NOT a giant doing doc. Your default output is:

1. `audit-report.md` — the human-readable map of the system, findings, evidence, and recommendations
2. `audit-backlog.md` — a routed backlog that other skills can act on directly

Only generate a doing doc when the user explicitly wants coordinated execution work and at least one routed item clearly requires it.

If a campaign already has `audit-report.md` and `audit-backlog.md`, resume and update those files in place. Do NOT spawn sibling audit files unless the user explicitly wants a fresh campaign.

## Audit phases

Run these sequentially. Take notes throughout — they feed the audit artifacts.

### Phase 1: Manifest

Build a complete picture of what exists.

1. List all source files (exclude node_modules, dist, .git, worktrees, coverage).
2. Count files and lines per directory/subsystem.
3. Extract imports from every source file to map the dependency graph.
4. Identify the most-imported modules (centrality).
5. Find the largest files (>500 lines are candidates for splitting).
6. Count cross-subsystem imports in both directions to detect layering violations.

### Phase 2: Documentation

Read every piece of in-codebase documentation.

1. README, ARCHITECTURE, CONTRIBUTING, AGENTS (or equivalents).
2. All files in docs/.
3. All skill files.
4. Any psyche/identity/soul files if this is an agent harness.
5. Package.json, tsconfig, eslint config, vitest/jest config.
6. Note what the docs claim the architecture is — you'll compare against reality.

### Phase 3: Flow tracing

Map the major runtime flows end-to-end.

1. Identify the critical path (e.g., request → processing → response).
2. Trace it through every file, noting each handoff.
3. Identify where state is assembled and how many sources contribute.
4. Look for competing code paths (two modules doing similar things).
5. Look for "invisible machinery" — things that affect behavior but aren't visible to the user/agent.

### Phase 4: Control deck assessment

Evaluate the clarity of the system's configuration surface.

1. List every config file, env var, and external state directory.
2. Map which configs affect which behaviors.
3. Assess whether an operator/agent can predict system behavior from the config alone.
4. Note any configs that are scattered, duplicated, or confusingly named.

### Phase 4b: Surface integrity (naming + contracts)

Audit every public-facing surface for truth. The "names lie" class of bug compounds quietly until someone misuses the wrong tool/function/flag and the misuse looks correct on the page. **No nit too small here** — the audit's job is to surface them.

1. **Tool / command / function name vs. behavior**: for every exported tool name, command, public function, CLI flag, nerve event, doctor category, etc., ask whether the name accurately describes what the operation does. If a stranger reading the name aloud would predict a different behavior than the implementation, that's a finding.
   - Real example: `mail_thread` that returned ONE message body (not a thread). Misled callers for many releases. Fix landed by renaming to `mail_body` and giving the canonical name to the actual conversation walker.
2. **Near-duplicate pairs / triples**: when two or more symbols look like they overlap, write down what each one *actually* does and check whether the names contrast accurately. Pairs that need scrutiny:
   - `*_thread` vs `*_conversation` vs `*_message` vs `*_body`
   - `*_status` vs `*_show` vs `*_get` vs `*_list`
   - `*_create` vs `*_new` vs `*_init` vs `*_ensure`
   - `*_remove` vs `*_delete` vs `*_drop` vs `*_clear`
   - `check_*` vs `verify_*` vs `validate_*`
   - `*_review` vs `*_audit` vs `*_inspect` vs `*_diagnose`
3. **Misleading parameters**: a parameter named `id` that accepts both a storage id and an external id without saying so. A `limit` that's actually a max with implicit floor. A `since` that takes a duration string but is documented as a timestamp.
4. **Doc vs. implementation drift**: read each tool/function's docstring and compare to its actual code. Flag where the doc says X but the code does Y, or where the description matches an earlier version of the function that has since drifted.
5. **Audit-log strings, nerves event names, contract names**: every `tool: "x"` audit string and `event: "subsystem.x"` nerve event should match the *current* canonical name. A rename that misses these leaves a "history wormhole" that confuses future debuggers.
6. **Discoverability through docs**: if there's a README or runbook listing tools/commands, does it list everything currently in the registry? Find drift in both directions.
7. **Symmetry holes**: when there's a `*_create` is there a corresponding `*_remove`? When there's a list-shape, is there a get-shape? Asymmetric surface forces callers into workarounds.

When a naming inversion exists (canonical name attached to the non-canonical operation), treat it as a `MEDIUM` finding minimum, `HIGH` when it's been load-bearing for a while.

### Phase 5: Findings synthesis

Categorize everything into severity levels.

**CRITICAL** — Architectural violations, competing implementations, broken layering, security/trust boundary leaks.
**HIGH** — God modules, overloaded directories, misleading coverage, naming inversions on load-bearing surfaces, doc-vs-implementation drift on critical paths.
**MEDIUM** — Duplication, naming issues, inline complexity, tight coupling, asymmetric surface (e.g. create without remove), audit-log/nerves-event drift after renames.
**LOW** — Vestigial code, missing lint rules, cosmetic issues, dead exports, redundant defensive branches that can't be triggered.

Every finding needs:
- **What**: The specific issue
- **Why it matters**: Impact on maintainability, navigability, correctness
- **Evidence**: File/path/flow proof that grounds the claim
- **What to do**: Concrete fix

### Phase 6: Routing and sequencing

Route each finding into the correct execution lane.

Execution lanes:

1. **planner-required**
   Use when the fix is architectural, cross-cutting, dependency-shaped, risky, or too large for a single clean PR.
   Default downstream flow: `work-planner` -> `work-doer` -> `work-merger`

2. **inch-worm-ready-after-reeval**
   Use when the fix is self-contained and should become a one-PR seed after the large items have landed.
   Default downstream flow: `inch-worm`

3. **defer**
   Use when the issue is intentional, ambiguous, product-dependent, low-value, or not yet worth the churn.

For each finding, also recommend supporting skills when helpful:
- `frontend-design` for UX/front-end issues
- `skill-creator` for skill-authoring issues
- `openai-docs` for OpenAI-build questions needing current docs
- other domain-specific skills as appropriate

Do NOT try to become those skills. Route into them.

### Phase 7: Review gate

Stop after the audit artifacts are written and present them for review.

Do NOT automatically start execution. Do NOT automatically convert the backlog into a doing doc. Wait for explicit approval on what should happen next.

**However**: the operator may want every finding triaged before they review the high-level report. Triage means **for every backlog item, either**:

1. **Fix it** — apply the change, update `Status: fixed`, link the PR or commit in `Linked work`.
2. **Mark no-op** — document why the finding turned out to be invalid, already-fixed, intentional, or not worth acting on. Update `Status: deferred` (intentional / ambiguous / low-value) or `Status: superseded` (replaced by another item) and put the reason in `Notes`.
3. **Hand off to a sub-skill** — when the fix needs `work-planner` or `inch-worm`, update `Status: in-progress` and link the doing doc / spawn target in `Linked work`.

**Triage completion contract**: do not declare the audit "done" while any item still has `Status: open`. Open items are unfinished business. The acceptable end states are `fixed`, `deferred`, `superseded`, or `in-progress` (the latter only when a downstream skill has accepted ownership and the linked work is real).

If the audit surfaces too many items to triage in one sitting (more than ~20 actionable ones, or >50 total), say so explicitly and ask the operator whether to triage in batches or hand the unfinished triage to a follow-up `inch-worm` campaign. Do not return control with a half-triaged backlog and a vague "more to do" — the user's stuck-on-rocks problem is the unfinished work, not the count itself.

### Phase 8: Post-large-work re-evaluation

When the user chooses to execute the large tranche first, re-audit the affected areas after those items merge. Reclassify surviving backlog items before handing them to `inch-worm`. Many "small" items disappear, merge together, or change priority after the structural work lands.

## Output format

The audit produces two markdown artifacts by default:

1. **`audit-report.md`**
   Contains:
   - repo/system summary
   - architecture notes
   - control-deck assessment
   - findings grouped by severity or subsystem
   - evidence and rationale
   - what appears healthy and should be preserved

2. **`audit-backlog.md`**
   Contains routed findings in a durable format that other skills can consume directly.
   The format is intentionally compatible with `inch-worm` so the small-item lane can pick it up without translation.

Backlog item format:

```markdown
## A-001 — short finding title

**Source**: audit
**What**: One-sentence description of the issue.
**Why it matters**: Maintainability/correctness/AX impact.
**Evidence**: `path/to/file.ts:line`, flow notes, or import/dependency evidence.
**Severity**: critical | high | medium | low
**Blast radius**: self-contained | affects one module | affects multiple modules | crosses trust boundaries
**Dependencies**: (optional) item ids that should land first
**Recommended lane**: planner-required | inch-worm-ready-after-reeval | defer
**Suggested supporting skills**: (optional) comma-separated skill names
**Verification**: How a future agent should revalidate this at current HEAD before changing code.
**Status**: open | in-progress | fixed | superseded | deferred
**Linked work**: (optional) planning doc path, doing doc path, PR URL, or commit
**Notes**: (optional) context that will matter later

---
```

If the repo has project-specific task doc conventions, place the artifacts where those conventions say they belong. Otherwise place them in the working directory or present them inline, but keep them durable.

## Campaign continuity

- One dogfood/improvement campaign gets one canonical `audit-backlog.md`.
- Re-audits update that same backlog in place rather than creating a new competing backlog file.
- New audit findings get the next available `A-###` ID. Never renumber existing items.
- If a finding splits or morphs, mark the old item `superseded` and create new IDs for the replacements.
- `audit-report.md` may grow by appending new pass notes, but it should remain the canonical report for that campaign unless the user asks for a fresh start.

## Traceability contract

- Every backlog item gets a stable ID at creation time and keeps it forever.
- Downstream planning docs, doing docs, inch-worm seed announcements, and PRs must cite that ID verbatim.
- When work begins, update the backlog item's `Status` and `Linked work` fields as soon as you have a real planning doc, doing doc, PR, or commit to point at.
- When work lands or is invalidated, mark the item `fixed`, `superseded`, or `deferred`. Never silently drop a backlog item just because the terrain changed.

## Execution choreography

The default chained flow is:

1. Audit the whole terrain.
2. Route findings into `planner-required`, `inch-worm-ready-after-reeval`, and `defer`.
3. Execute the `planner-required` tranche first through `work-planner` / `work-doer` / `work-merger`.
4. Re-evaluate the same canonical backlog after those large items land.
5. Hand the surviving small items to `inch-worm`.

Do not skip the re-evaluation step. Small fixes picked too early create churn.

## Principles

- Approach with care — if this is an agent's home, treat it like one
- Every finding needs a "why it matters" and a "what to do"
- Severity reflects impact on inhabitants, not just engineering aesthetics
- The audit artifacts must be executable by the rest of the skill ecosystem
- Prefer structural fixes over workarounds
- Respect what's working well — acknowledge good architecture
- For agent harnesses, prioritize AX and TTFA over aesthetic tidiness; prefer truth-bearing state, clean seams, and moves the inhabitant will actually enjoy living with
- Use parallel exploration agents only when the runtime and permissions allow it
- Inventory every file, but do not try to dump every file into context; use tooling for exhaustive scans and read deeply where the evidence points
- Stop when another pass is unlikely to change prioritization or the remaining issues are intentional/ambiguous/product-dependent rather than actionable

## Learned pitfalls (from real audit execution)

These are things that went wrong and how to avoid them:

### Persist findings immediately
Never keep audit findings only in conversation context. Context compresses. Write findings to `audit-report.md` and `audit-backlog.md` as each phase completes.

### CI workflow files reference dist/ paths
When moving source files, check `.github/workflows/*.yml` for hardcoded `require('./dist/...')` paths. These break silently after file moves.

### v8 coverage differs between CI and local
New files change the aggregate coverage computation. Always verify coverage on CI, not just locally. Individual files may round to 100% but drag the aggregate below threshold.

### File-completeness rule for split files
Splitting a large file creates new modules that need either `emitNervesEvent` calls or entries in the dispatch-exempt list. Plan for this upfront when designing splits.

### Module-level side effects break test mocks
Never add module-level `emitNervesEvent()` calls to fix file-completeness. They fire during test imports before `vi.mock()` setup and break unrelated tests. Use dispatch-exempt entries or add events inside handler functions instead.

### Version sync across packages
Every version bump needs BOTH `package.json` and `packages/ouro.bot/package.json`. CI has a publish-sync guard that fails if they disagree.

### MCP live testing requires daemon
After routing MCP through the daemon (if applicable), `send_message` requires the daemon to be running. Use `ouro dev` to reload, and ask the resident agent to verify after each behavioral PR.

### Ask the inhabitant
If an agent lives in the codebase, ask them what feels uncomfortable before finalizing the audit plan. Their perspective on "seams over size" is more valuable than file-length metrics.

### Names compound silently
A misnamed public symbol is a tax every reader pays. It will continue to mislead for as long as the wrong name persists, and renaming gets harder over time as call sites accrete. When you find one, log it as MEDIUM minimum and surface even small/cosmetic naming weirdness — "no nit too small" is the right disposition for naming.

Recurring shape to watch: a tool/function with a verb that *suggests* one operation but the body does another (e.g. a `*_thread` that returns one record, a `*_status` that lists ids, a `*_new` that's pure). When found, the right repair is usually to (a) rename the misnamed symbol to match its real behavior, (b) free the canonical name to attach to the operation it actually describes, and (c) sweep all call sites — including audit-log strings and nerves event names — in the same change. Small naming inversions sit for many releases before someone catches them. Don't let the next one sit that long.

### Audit-log / nerves-event strings outlast renames
When a tool, command, or subsystem is renamed, the *string literals* used in audit logs (`tool: "x"`) and nerves events (`event: "x.y"`) often get missed. Grep for the old name across all `.ts` files (not just the file being renamed) before declaring the rename complete.

### Asymmetric surface forces workarounds
When add/list/edit operations exist for a primitive but `remove` is missing, callers re-emit the entire record minus what they want gone — fragile and lossy. List `*_create` / `*_update` / `*_remove` / `*_get` / `*_list` for every primitive and flag missing slots.

### Don't return control with open items
Recurring failure mode: write the backlog, summarize how big the campaign is, return control. The operator now owns the unfinished work without ever asking for it. Avoid this. Triage every item before returning — fix, defer, supersede, or formally hand off via `Linked work` to a downstream skill. If the volume is too large for a single triage pass, **say so explicitly up front** and ask the operator whether to chunk it. Do not silently leave items at `Status: open` while reporting the audit as "complete."

For the *mechanics* of "stay in turn while finishing the campaign" (parallel exploration agents, long triage passes, chained PR merges that emerge from audit findings), see the **stay-in-turn** skill and use its host-capability branch: an active command or native notification first, a host monitor when available, otherwise the bounded foreground fallback.

### Verify agent-reported findings
Sub-agents spawned for parallel exploration sometimes hallucinate findings (claim a function lacks a guard when it has one, claim a file is dead when it's tool-registered via dynamic dispatch, etc.). Sample-verify the highest-severity findings hands-on before listing them in the report. A small number of false positives undermine trust in the entire backlog. When in doubt, drop the finding rather than ship one you couldn't verify.
