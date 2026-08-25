---
name: plain-language
description: Apply reader-centered plain-language principles to human-readable agent output while preserving facts, uncertainty, attribution, safety, accessibility, technical precision, schemas, and source-preserved content.
---

# Plain Language

Apply this to human-readable replies, explanations, status, reviews, plans, and handoffs.

## Write for the reader

1. **Relevant:** Identify what this reader needs to know, decide, or do. Answer that question first and remove detail that serves neither the task nor a higher-authority requirement.
2. **Findable:** Front-load the answer, decision, blocker, or warning. Group distinct information only when the grouping helps the reader scan or follow a sequence.
3. **Understandable:** Use familiar words when they stay accurate. Keep required technical terms, define only unfamiliar ones, use one term per concept, name the actor, and state important relationships explicitly.
4. **Usable:** State the action, decision, verification, or terminal evidence when it exists. Put a warning before the instruction it governs and say what remains open without inventing work or certainty.

These are reader outcomes, not readability scores. Do not optimize for sentence length, grade level, or fewer words.

## Never simplify away

Preserve facts, quantities, evidence state, uncertainty, attribution, safety warnings, accessibility requirements, technical precision, required schemas, blockers, and completion state. If a clearer rewrite changes the claim, keep the precise wording and explain around it.

Do not restyle internal reasoning, code, commands, logs, stack traces, diffs, exact quotations, tool arguments, identifiers, or schema-bound payloads. Apply Plain Language only inside human-readable prose fields.

When correcting an earlier answer, name what changed, supersede the error, and retain prior context that is still true. In agent handoffs, preserve owners, evidence, blocked state, and next-action meaning while leaving structured fields to their schema.

## Compose with installed owners

When present, `interaction-style` owns live operator voice and decision cadence; Desk's prose invariant owns hard wrapping; `evidence-discipline` and `preflight-actions` own evidence and action safety; `status` and `autopilot` own progress and completion truth; `operator-voice-comments` owns approved wording, register, formatting, punctuation, and public vocabulary. Plain Language improves presentation without overriding them.

## Source basis

This is original Ourostack guidance informed by pinned public MIT sources from `GaZmagik/iso-24495` and `nikdumroese/plain-language-skill`. Exact source files, commits, hashes, and licenses are recorded in `upstream-sources.lock.json`.

This skill does not claim ISO conformance and does not reproduce protected standard text. Evaluate whether readers can find, understand, and use the output through representative review and dogfood, not mechanical prose scores.
