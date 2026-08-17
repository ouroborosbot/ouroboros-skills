---
name: join-crew
description: Agent-driven onboarding to a shared crew workspace. Use when an operator wants to join a crew repo, the workspace is not cloned locally, or the operator provides a crew-repo pointer. The engine discovers or resolves the workspace, offers once, clones through an overlay-supplied identity provider, maps stable identity to alias through `_meta/desks.md`, copies and verifies the complete `desks/_template/` tree for a new member before registry mutation, scopes writes to `desks/<alias>/`, installs declared tooling, loads repo context, and restarts only when required. Vendor-neutral; identity, transport, and private plugin details come from an overlay.
---

# Join a crew workspace

Bring an operator into a shared workspace without asking them to perform work the agent can do. This
skill owns the vendor-neutral flow. An overlay supplies identity, authentication, clone transport,
default alias policy, and any private tooling details.

Read `desk:first-run-bootstrap` and `crew:shared-desk-conventions` first.

## Inputs from the overlay

Before starting, obtain:

- a stable authenticated identity;
- a clone command or equivalent transport;
- the default alias rule for a brand-new identity;
- the target local path;
- the crew plugin locator and any overlay-specific declared dependencies.

If the overlay cannot prove authenticated remote access, stop before touching the filesystem. Do not
create an offline or local-only copy of a shared workspace.

## Step 1: resolve the crew workspace

Use either:

1. a repo pointer supplied by the operator; or
2. an overlay-provided discovery mechanism that lists accessible shared workspaces.

A candidate is a crew workspace when its root contains `_meta/desks.md` together with `desks/` and
`_shared/`. Confirm the remote exists and the authenticated identity can read it.

If the workspace already exists at the target path, do not clone it again. Hand off to session-start
sync and scan.

## Step 2: offer once, then clone

Ask one yes-or-no question:

> I found the `<workspace>` crew workspace and you have access. Want me to clone it and set up your desk?

On yes, run the overlay-supplied clone transport. On no, stop without filesystem changes.

## Step 3: resolve identity to alias

Read the committed `_meta/desks.md` registry after cloning.

- If a row's stable `identity` matches the authenticated identity, use that row's `alias`.
- If no row matches, derive a candidate alias with the overlay's default alias rule.

The registry is authoritative. Do not cache the alias in a machine-local marker, and do not derive a
new alias for a returning member whose identity already has a row.

## Step 4: seed a brand-new member's desk

Skip this step for an existing registry row.

Require `desks/_template/` to exist and contain at least one path. If it is absent or empty, stop before
creating the member row.

### Copy the complete committed template tree

Copy the entire contents of `desks/_template/` to `desks/<alias>/`, including hidden files and nested
directories. Do not enumerate expected furniture in this skill. The committed template is the source of
truth and may grow over time.

Use a copy mechanism that preserves the complete tree. For example:

```bash
mkdir -p "desks/<alias>"
cp -R "desks/_template/." "desks/<alias>/"
```

Apply overlay substitutions only after the copy when the template contains explicit placeholders.

### Verify every template path

Before editing `_meta/desks.md`, enumerate every path relative to `desks/_template/` and require the
corresponding path under `desks/<alias>/` to exist. Contents may differ only where the overlay applied
an explicit placeholder substitution.

```bash
find "desks/_template" -mindepth 1 -print |
  while IFS= read -r source; do
    relative=${source#"desks/_template/"}
    test -e "desks/<alias>/$relative" || exit 1
  done
```

If verification fails, remove only the incomplete new `desks/<alias>/` tree and stop. Do not mutate the
registry.

## Step 5: register the new identity

After the template copy passes:

1. commit and push the new `desks/<alias>/` tree as the new member's own-desk write;
2. add the `identity` to `alias` row in `_meta/desks.md` through the shared-path conflict-safe protocol;
3. update any repository-owned authority snapshot required by that workspace in the same shared-path PR.

Never add the registry row first. A row without a complete desk creates a valid-looking broken binding.

## Step 6: bind workspace authority

Bind the specialist worker to the crew repo and launch Desk with `--person <alias>`. Reads remain
repo-wide; writes are rooted under `desks/<alias>/`.

Confirm the active binding reports:

- the crew repository root;
- person scope;
- the resolved alias.

## Step 7: install declared tooling

Install the crew plugin from the workspace's canonical remote source, then install or resolve its
declared dependencies through the host's normal plugin mechanism. The generic engine does not name a
specific corporate overlay or reverse dependency direction.

## Step 8: load repo context

Read the crew repo's `AGENTS.md`. If the specialist agent supports load-time imports, use the standard
clone path expected by that agent. An on-demand read remains the fallback for non-standard paths.

## Step 9: restart only when required

If the host can load the installed plugin immediately, continue in the crew workspace. Otherwise ask
for one restart and state the resolved workspace and alias.

## Completion check

Onboarding is complete only when:

- remote authentication is healthy;
- the workspace exists at the target path;
- the identity maps to exactly one alias;
- every template path exists for a newly created desk;
- the registry row exists only after the desk verification passed;
- the authority binding reports the crew root and resolved alias;
- declared tooling and repo context are available.

## Cross-references

- `desk:first-run-bootstrap`: the single-operator bootstrap shape.
- `crew:shared-desk-conventions`: layout, ownership, and shared-path protocol.
- The active overlay's identity and transport skill: authentication, clone command, and alias defaults.
