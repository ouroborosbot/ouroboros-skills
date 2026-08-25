# ouroboros-skills

Shared skill repository for the Ouroboros agent ecosystem. Skills are reusable instruction sets (stored as `SKILL.md` files) that teach AI agents how to perform specific workflows -- from task planning and execution to video editing and repository management.

Any agent with the **skill-management** skill installed can browse, install, update, and contribute skills from this repo.

## Repository Structure

```
ouroboros-skills/
  manifest.json              # Machine-readable index of all skills
  README.md
  skills/
    skill-management/        # Bootstrap skill for managing other skills
      SKILL.md
    autopilot/               # Full-delivery execution doctrine
      SKILL.md
    work-ideator/            # Resolve material ambiguity only when needed
      SKILL.md
    work-planner/            # Risk-scaled planner for coordinated work
      SKILL.md
    work-doer/               # Smallest complete implementation with proportionate proof
      SKILL.md
    work-merger/             # PR through release/install, smoke, and cleanup
      SKILL.md
    inch-worm/               # Open-ended improvement loop
      SKILL.md
    video-editing/           # Remotion-based video production
      SKILL.md
    word-docs/               # Markdown to Word doc conversion
      SKILL.md
      md_to_docx.py
```

Each skill lives in its own directory under `skills/` and contains a `SKILL.md` file with YAML frontmatter (`name`, `description`) followed by the skill's workflow instructions.

## Discovering Skills

The [`manifest.json`](manifest.json) file at the repo root is the machine-readable index. It lists every skill with its name, file path, description, and tags. Agents can fetch it at:

```
https://raw.githubusercontent.com/ourostack/ouroboros-skills/main/manifest.json
```

## Installing a Skill

The **skill-management** skill (`skills/skill-management/SKILL.md`) is the bootstrap skill. Once an agent has it installed, it can self-serve all other skills. The workflow:

1. Fetch `manifest.json` to discover available skills.
2. Fetch the desired skill's `SKILL.md` via raw GitHub URL.
3. Save it to the agent's local skills directory.
4. Track provenance in a local `_registry.json` file.

For full installation, update, and contribution instructions, see [`skills/skill-management/SKILL.md`](skills/skill-management/SKILL.md).

## Contributing a New Skill

1. Fork this repository.
2. Create a new directory: `skills/<your-skill-name>/`
3. Add a `SKILL.md` with YAML frontmatter (`name`, `description`) and clear workflow instructions.
4. Add an entry to `manifest.json`.
5. Open a pull request.

See the **Contribute** section in [`skills/skill-management/SKILL.md`](skills/skill-management/SKILL.md) for detailed guidance.

## Available Skills

| Skill | Description |
|-------|-------------|
| **skill-management** | Browse, install, update, and contribute skills from this repo. |
| **autopilot** | Keep authorized long-horizon work moving through terminal delivery and the continuation scan. |
| **stay-in-turn** | Keep long-running work in the same turn with monitor-style waiting instead of background wakeup deferral. |
| **work-ideator** | Resolve material ambiguity and choose the smallest viable shape; skip when the task is clear. |
| **work-planner** | Plan coordinated or risky work; skip when the task description is sufficient. |
| **work-doer** | Implement the smallest complete vertical change with proof proportional to risk. |
| **work-merger** | Drive a branch through PR, merge, release/install, smoke, cleanup, and continuation. |
| **visual-qa-dogfood** | Screenshot-backed dogfooding for UI/rendering work so visual absurdity cannot hide behind passing metrics. |
| **workbench-operator** | Use Ouro Workbench as the native control room for terminal/TUI agents, Desk mirrors, and boss-agent check-ins. |
| **inch-worm** | Open-ended codebase improvement loop. Seed → fix → log side discoveries → pick next. Each fix is its own PR. |
| **full-systems-audit** | End-to-end repo audit that produces an audit report plus a routed backlog for the rest of the skill ecosystem. |
| **dragon-hunt** | Adversarial end-to-end bug hunt across product, backend, auth, data, integrations, MCP/agent surfaces, and deployment assumptions. |
| **design** | Design and build production-grade frontend interfaces from scratch. |
| **frontend-design** | Create distinctive, production-grade frontend interfaces with high design quality. |
| **build-native-apple-app** | Plan, build, audit, and ship native Apple apps for iOS, iPadOS, macOS, watchOS, tvOS, and visionOS. |
| **seo-titles** | Write HTML title tags that rank and get clicked. |
| **book-fetch** | Search for ebooks on libgen, download EPUBs, and optionally deliver them to an e-reader or Calibre library. |
| **video-editing** | Build and edit videos using Remotion with kinetic typography and VO-synced timing. |
| **word-docs** | Convert markdown drafts into shareable Word documents using a bundled helper script. |
| **product-cloner** | Clone an existing app's look, feel, and behavior from shipped source as ground truth. |

## Work-Suite Autopilot Loop

Work-suite autopilot includes an exit preflight: before an agent reports done, it must verify terminal merge/deploy/install/smoke state, refresh durable state, write down the continuation scan, and start any ready or reviewer-gated next item. This keeps "what's next?" from becoming a manual operator loop.

For skill or plugin changes, "done" also requires runtime refresh and dogfooding: sync the consuming skill/plugin copy, prove the installed copy contains the new contract, and run the next real task under that contract. If the current host will not refresh its active skill menu until a new session, the agent should read the installed file directly, record that fact, and keep working from the source-of-truth copy.

### Runtime Visibility Audit

Use `scripts/audit-work-suite-runtime.cjs` to prove the work-suite contract across source, installed roots, and the active host menu snapshot:

```bash
node scripts/audit-work-suite-runtime.cjs --repo-root .
node scripts/audit-work-suite-runtime.cjs --repo-root . \
  --skill-root ~/.agents/skills \
  --skill-root ~/.codex/skills \
  --active-skills autopilot,work-ideator,work-planner,work-doer,work-merger,stay-in-turn,inch-worm,visual-qa-dogfood \
  --strict-active
```

The audit always hard-fails source-of-truth problems: missing manifest entries, missing canonical skill files, or plugin copies that drift from `skills/`. Installed roots and active-menu visibility are reported separately because a host session can lag behind disk installs. With `--strict-installed`, installed roots must also have `_registry.json` provenance whose shared work-suite skill commits match the latest source commits; run from a real git checkout so commit provenance can be proven. Under autopilot, a missing active-menu skill is still actionable evidence: re-read the installed `SKILL.md` directly, record the mismatch in durable state, and refresh or restart the host before relying on menu discovery.

### Upstream Source Steward

Run the read-only steward to compare every selected public source against `upstream-sources.lock.json`:

```bash
node scripts/check-upstream-sources.cjs
```

The report records repository identity, license, candidate ref and SHA, forward ancestry, selected-file hashes, an aggregate payload digest, changed paths, and one classification per source. `current` and `candidate-no-selected-payload-change` exit successfully. A selected instruction or executable change exits with `needs-human-approval`; repository, auth, network, rate-limit, missing evidence, license, or ancestry failures exit as `blocked`. The command never updates the lock or vendored files.

### Autopilot State Audit

Use `scripts/audit-autopilot-state.cjs` before a final response under autopilot. It checks the durable `AUTOPILOT-STATE.md` proof and fails if the continuation scan still has `ready` or `needs reviewer gate` work:

```bash
node scripts/audit-autopilot-state.cjs --state-file /path/to/AUTOPILOT-STATE.md
```

The required table columns are `candidate`, `classification`, `evidence`, and `disposition`. Valid classifications are `ready`, `needs reviewer gate`, `hard exception`, `deferred by scope`, and `none`. Use `none` only as a single sentinel row when the scan found no candidates at all; terminal final-state audits fail while any listed candidate is `ready` or `needs reviewer gate`.
