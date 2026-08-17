# crew

The **multi-person shared-workspace** layer on top of the `desk` substrate. Where `desk` is a single
operator's workspace, `crew` is what turns one git repo into a shared workspace for N teammates:

- **read-across / write-own** -- every teammate reads the whole repo (all `desks/<alias>/` + `_shared/`),
  but writes only their own `desks/<alias>/` subtree, so concurrent work merges cleanly.
- **the attribution taxonomy** -- facts (team-neutral, in `_shared/landscape/`) vs perspectives (one
  person's view, in their desk, attributed) vs decisions (what the team actually agreed, in
  `_shared/decisions/`). Never present one person's view as the team's.
- **the conflict-safe write protocol** -- direct push to your own desk; a shared path goes through a
  pull-latest -> branch -> PR -> merge-now serialization (no human review gate; the PR is a concurrency
  primitive).
- **perspective queries** -- answer "what would `<person>` think about X", "what's `<person>` working
  on", "what's actually agreed vs just a fact", read from the right home and attributed honestly.
- **crew onboarding** -- clone a shared workspace through an overlay-supplied identity, resolve the
  committed identity-to-alias mapping, seed a new member from the complete repo template, and bind writes
  to that member's desk.

Vendor-neutral. Layers on top of `desk` + `work-suite`. A corporate overlay supplies
the identity skin (how a teammate's writes authenticate); this plugin is the substrate-neutral core.

## Skills

- `shared-desk-conventions` -- the layout, the taxonomy, and the write protocol.
- `perspective-query` -- the read side: answer perspective- and status-shaped questions honestly.
- `join-crew` -- vendor-neutral onboarding; an overlay supplies identity, transport, and private tooling.
