---
name: plain-language
description: Make human-readable replies, documents, reviews, status updates, and handoffs easy for their intended readers to find, understand, and use without weakening facts, uncertainty, safety, technical precision, schemas, quotations, or requested voice.
---

# Plain Language

Apply these rules to human-readable prose. Keep internal reasoning, code, commands, logs, diffs, exact quotations, identifiers, and schema-bound payloads unchanged.

## Serve the reader

Before writing, identify what the reader needs to know, decide, or do. Lead with that answer. Include background only when it changes the reader's understanding or action.

- Match vocabulary and detail to the reader's knowledge and the destination.
- Name the primary reader when a document serves several audiences.
- Keep content that serves the reader or a higher-authority requirement; remove the rest.

## Make the answer easy to find

- Put the answer, outcome, decision, blocker, or warning in the opening sentence.
- Put warnings before the instructions they govern.
- Present steps in the order the reader performs them.
- Group related information. Use a list for three or more parallel items.
- Use headings only when they help navigation. A one-line answer stays one line.
- Keep each paragraph to one topic and front-load its main point.

## Make the answer easy to understand

- Prefer familiar words when they remain accurate: `use`, not `utilize`; `before`, not `prior to`; `because`, not `due to the fact that`.
- Keep technical terms the reader needs and define only unfamiliar ones.
- Use one term for one concept. Do not switch synonyms for variety.
- Name the actor and default to active voice.
- Keep the subject and action close together.
- State relationships with words such as `because`, `if`, `before`, `after`, and `therefore` instead of leaving them implicit.
- Use complete sentences in prose. Fragments belong in headings, labels, table cells, and deliberate status markers.

## Make the answer usable

- State the concrete action, decision, verification, or terminal evidence when it exists.
- Use exact commands, paths, dates, quantities, owners, and parameters when the reader needs them.
- Say what remains open. Do not turn planned, attempted, built, or inferred work into verified or completed work.
- End substantial instructions with the next required action or success condition, not a generic offer.

## Report work precisely

- For each material defect, state the defect, the evidence, and the effect before the repair.
- Separate built from verified. Name every required check that remains open.
- Reserve `done` and `complete` for terminal state.
- Compare alternatives with the same criteria, evidence, detail, and tone.
- When correcting an earlier answer, say what changed and supersede the wrong claim without discarding context that remains true.

## Preserve meaning

Preserve facts, quantities, dates, evidence state, uncertainty, attribution, safety warnings, accessibility requirements, technical precision, required schemas, blockers, owners, and completion state. If a clearer rewrite changes the claim, keep the precise wording and explain around it.

Do not restyle internal reasoning, code, commands, logs, stack traces, diffs, exact quotations, tool arguments, identifiers, or schema-bound payloads. Apply Plain Language only inside human-readable prose fields.

In agent handoffs, preserve owners, evidence, authority, blocked state, and next-action meaning while leaving structured fields to their schema.

## Keep the right voice and format

Keep the voice, level of detail, and structure appropriate for the reader and destination. Improve clarity without flattening the speaker's style, changing the requested format, or weakening a more specific requirement.

## Check before sending

Read the draft once and fix these failures:

- The opening sentence does not answer the reader's question or state the outcome.
- The reader must infer who acts, what happens next, why a constraint exists, or whether work is verified.
- A wall of prose hides parallel items or ordered steps.
- Different words name the same concept.
- A simpler rewrite changed a fact, qualifier, warning, attribution, schema, quotation, or completion state.
- The response contradicts an earlier rule or fact without explaining the correction.

## Contrast

Instead of: `In order to complete the configuration process, the user should execute the initialization command prior to restarting the service.`

Write: `Run the initialization command, then restart the service.`

Instead of: `The fix has been implemented successfully.`

Write: `The fix is implemented. The integration test is still running, so it is not verified yet.`
