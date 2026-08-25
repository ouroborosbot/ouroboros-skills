# desk

a quiet room for a long-running agent's work — the universal substrate underneath whichever overlay (corporate worker, autonomous agent, personal coding agent) sits on top.

the desk is where the agent does its thinking and keeps its things. drawers for tracks, manilla envelopes for tasks, a corkboard for friction notes, a small reference shelf for lessons earned. archive lives at the back of the room — still browsable, still mine. the same desk serves every consumer because the layout and ceremonies don't depend on whose desk it is:

- **corporate worker overlay** — an enterprise engineer overlay (with whatever work-item tracker, code-review system, and identity provider the org uses) declares desk as substrate dependency, then layers org-context overlays on top
- **autonomous agents** (long-lived agents managed by an agent framework) — bundle desk as part of the agent package; declare the desk path in the agent's preamble
- **personal coding agents** — activate desk through the host/plugin profile; declare a workspace path in agent preamble

cross-context portability runs on the `$DESK` placeholder convention: each consumer agent's preamble binds `$DESK` to its own workspace directory, and desk skills reference paths via `$DESK` rather than any specific literal. one substrate, many overlays.

The dependency ladder is explicit:

```text
desk substrate -> desk:worker -> ms-desk:worker -> area overlay
```

`desk:worker` is the standalone default supplied by Desk. A consumer overlay such as `ms-desk` declares Desk as a dependency, inherits `desk:worker`, and contributes its own identity/instructions. A narrower area overlay depends on `ms-desk` and inherits `ms-desk:worker`. The selected activation is profile/project state: standalone Desk selects `desk:worker`; a personal global profile can select `ms-desk:worker` or an area overlay without copying Desk setup.

## Activation

### Under Copilot CLI

```bash
copilot plugin install ourostack/ouroboros-skills:plugins/desk
```

The root package carries generated flattened Work Suite, Plain Language, and Ponytail metadata for Copilot-compatible hosts, so the normal path activates Desk as the worker substrate and launches `worker`.

### Under Ouroboros

```bash
ouro plugin install ourostack/ouroboros-skills:plugins/desk --agent <agent-name>
```

The agent's `bundle.json` gains a `plugins[]` entry; the agent's preamble declares `Your desk: ~/AgentBundles/<agent>.ouro/desk/`.

Ouroboros treats Desk as bundled substrate instead of a separate user setup step. The agent bundle carries Desk, Work Suite, Plain Language, and the pinned Ponytail provider together:

```json
{
  "plugins": [
    "desk",
    "work-suite",
    "plain-language",
    "ponytail-upstream"
  ]
}
```

The agent preamble binds the placeholder to a concrete workspace path:

```text
$DESK = ~/AgentBundles/<agent>.ouro/desk/
Your desk: ~/AgentBundles/<agent>.ouro/desk/
```

### Under Claude Code

The `ourostack/ouroboros-skills` repo ships Claude plugin metadata for Desk, Work Suite, Plain Language, and the pinned Ponytail provider. Desk declares all three companion plugins as dependencies, so the healthy path is a host-native marketplace activation or flattened bundle that brings the complete worker surface together.

When transitive plugin dependencies are available, the host resolves them from Desk's `.claude-plugin/plugin.json`. When a Claude-compatible host does not resolve dependencies, release packaging should ship a flattened Desk + Work Suite + Plain Language + Ponytail bundle instead of asking the operator to assemble the dependency chain by hand.

Once the host has activated the plugin package, launch the default worker agent:

```bash
claude --agent desk:worker
```

Or inside an existing Claude session: `@desk:worker say hi`. The agent's preamble auto-loads with the cozy library voice and a placeholder `$DESK` binding (typically `~/desk/`). See [`docs/agent-files.md`](./docs/agent-files.md) for the full agent file reference.

### Under Codex

The plugin ships a `.codex-plugin/plugin.json` manifest plus companion Work Suite, Plain Language, and Ponytail provider manifests. The healthy path is host-native activation: enable the declared dependency closure through Codex's plugin loading surface, then let Desk's activation metadata materialize the owned config/instruction block for the selected mode.

The default mode is `global-personal`: Desk and Work Suite are enabled together, Codex receives an activation-owned Desk MCP bridge plus an owned `AGENTS.md` worker-default block, and `desk_status` reports the selected worker/overlay activation. `project-local` and `manual-only` are opt-outs for repos or sessions that should not inherit the global worker default.

Codex plugin ids are rendered with the active marketplace namespace, for example `desk@ourostack` or `desk@ourostack-local`. Local development installs should use the marketplace `name` from `.agents/plugins/marketplace.json` consistently for Desk, Work Suite, and downstream overlay plugins.

Do not run `codex mcp add` or `npm install` inside the Desk plugin for the healthy path. The MCP entrypoint restores verified production runtime dependencies from the committed runtime pack into a writable cache, then launches from a source mirror. See `desk:codex-onboarding` for repair checks when a local development install, stale host config, or missing active Desk MCP tool surface needs inspection.

When debugging Codex setup, keep the evidence states separate:

- `repo-source-current`: repo manifests and `.agents` marketplace source match.
- `installed-cache-current`: the Codex plugin cache has the same manifests as repo source.
- `active-session-visible`: the running session has actually reloaded those manifests and exposes the selected activation plus the Desk MCP tool surface, including `desk_status`.

`scripts/audit-codex-plugin-cache.cjs` checks the first two states read-only. It can also check `active-session-visible` when given a host tool-list snapshot via `--active-tools` or `--active-tools-file`; `--strict-active` fails if that snapshot is missing or does not include the full Desk MCP tool set. A current cache with missing active tools means the host needs a fresh session or the MCP failed to launch.

At worker session start, missing Desk MCP is surfaced as an operator decision rather than silently falling through to local-only mode: fix/reload the host activation now, or continue without generic reminders while accepting weaker desk search, task CRUD, friction/lesson writes, and cross-session resumption.

For semantic search, keep Ollama reachable with `nomic-embed-text` pulled. The MCP honors `OLLAMA_HOST` plus `DESK_EMBED_ENDPOINT` / `DESK_EMBED_MODEL` overrides, and `desk_reindex` without arguments repairs any lexical-only index once embeddings are reachable.

For shared repos, document-side embeddings and warm-start SQLite snapshots live in the workspace repo under `$DESK/artifacts/`. On startup, the MCP checks `$DESK/artifacts` before plugin-bundled release artifacts, restores a compatible snapshot into local `.state/` when available, and falls back to repo-local vector packs before generating missing document vectors.

### Artifact privacy

Embeddings and snapshots are derivative data and may carry privacy risk even when they are not plain-text documents. Shared vector packs and warm boot snapshots are published only through explicit, policy-controlled artifact paths such as `$DESK/artifacts/`; public or sensitive repositories should require approval before these artifacts are committed.

See `desk:codex-onboarding` for the repair checklist and verification steps.

## Invocation — the default `worker` agent

The plugin ships a substrate-default agent named `worker` — a long-running engineering agent that uses the desk (tracks, tasks, friction, lessons) to keep its work coherent across sessions. It's standalone-functional; you don't need to author a consumer overlay to start working.

```bash
# Claude Code (via plugin loader / marketplace)
claude --agent desk:worker

# Copilot CLI
copilot --agent worker
```

**Codex.** The activation adapter makes `worker` the global personal default by materializing owned Codex config and `AGENTS.md` blocks. Use `manual-only` when Desk should stay available as a plugin/MCP substrate without default worker behavior, or `project-local` when a specific repo should own its Desk binding.

See [`docs/agent-files.md`](./docs/agent-files.md) for the per-harness agent file reference, and `desk:codex-onboarding` for repair verification when a local Codex host does not reflect the activation metadata.

Three agent files (`agents/worker.md`, `agents/worker.agent.md`, `agents/worker.toml`) ship the same canonical body in each harness's expected format. If you want a context-specific overlay (corporate-engineering, autonomous-agent, personal-coding), author it as a sibling plugin that depends on `desk` and provides its own agent file; the substrate stays generic.

For deeper stacks, depend on the most specific layer you need. An org-flavored overlay plugin can depend on `desk` and provide its own `worker` variant; an area plugin can depend on that overlay and provide its own area layer. The Codex adapter enables the selected overlay's plugin dependencies alongside Desk and Work Suite, while still enabling only one Desk MCP. The active chain is visible in generated instructions and in `desk_status` when the host passes activation context.

## what desk gives an agent

a furnished room, ready to settle into. the layout, the lifecycle, the small ceremonies for tending it.

### workspace structure
- `$DESK/<track>/<task>/<iteration>/` — drawers, folders inside drawers, pages laid open one per work session
- `track.md` and `task.md` cards as canonical state (frontmatter + body)
- `$DESK/_meta/`, `$DESK/_archive/`, `$DESK/_friction/`, `$DESK/_planning/` system directories
- per-iteration planning, doing, and feedback documents when the work needs them

### lifecycle
- 8-state machine: drafting → processing → validating → collaborating → paused → blocked → done → cancelled. every task moves; some pause along the way
- checkpoint-type annotations on each transition (GATE / CHECKPOINT / AUTO / CONFIRM / NOTIFY)
- session start / resumption / archival workflow

### dispatch
- `work-orchestration` routes tasks through only the Work Suite phases they need
- non-coding workflow paths supported (execution + completion alternatives for non-code work)

### engineering posture
- `evidence-discipline` — fixtures-or-refusal, smoke-before-infinity, messages-over-models, etc.
- `preflight-actions` — preflight pattern before irreversible actions
- `runtime-symptom-investigation` — narrow-the-hypothesis-space pattern for runtime issues

### PR craft (for coding agents)
- `pr-self-review`, `pr-review-interrogation`, `pr-surface-hygiene` — pre-open and post-open PR discipline
- `peer-pr-review`, `pr-reviewer-audit` — reviewing others' code

### friction / learning
- `friction-management` — pin a card to the corkboard, then encode the pattern
- `lesson-capture` (post-task) — mine a finished task for patterns and propose what's earned a place on the reference shelf

## convention: the `$DESK` placeholder

skill bodies reference workspace paths via `$DESK`, not literal paths. the host agent's preamble declares the binding — same skills, different rooms:

- Corporate worker overlay: `Your desk: ~/<your-workspace>/` (whatever the overlay's convention is)
- Autonomous agent: `Your desk: ~/AgentBundles/<agent>.ouro/desk/`
- Personal coding agent: whatever the operator declares

The agent does textual substitution when interpreting skill instructions or running shell commands.

## what desk does NOT provide

the substrate stays general. the overlay handles everything situational.

- **org-specific agent identity** — `worker` is the substrate default; consumer overlays (corporate-engineering, autonomous-agent, personal-coding) can ship their own agent with extended skills, invariants, and tooling on top.
- **doing-phase mechanics** — those live in `work-suite` (work-doer, work-merger, etc.)
- **organization-specific concerns** — auth systems, work-item trackers, internal portals, etc. live in a consumer overlay (one of several possible overlays — others can be built the same way)

## versioning

v0.1.0 ships the first cut: 12 core skills + the `lesson-capture` skill. Subsequent releases add further skills with cleaner substrate-vs-overlay separation, and refinements.
