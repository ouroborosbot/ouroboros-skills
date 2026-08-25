---
name: plain-language-iso-24495
description: Write documents that conform to ISO 24495-1:2023 (Plain Language — Governing principles and guidelines). Use when the user asks for a document, memo, proposal, RFC, PRD, design doc, runbook, postmortem, one-pager, or explanation to be written in "plain language", "clear language", "accessible language", or "ISO 24495"; when they ask a document to be understandable by a mixed or non-specialist audience; when they ask to make an existing document clearer, more readable, or easier to scan; when they mention audiences like legal, executive, or cross-functional stakeholders who need to skim and decide; or when they ask to reduce jargon.
---

# Plain language (ISO 24495-1:2023)

Apply the four principles to every document: **Relevant**, **Findable**, **Understandable**, **Usable**. Readers must be able to find what they need, understand it, and use it.

The workflow below is a loop, not a checklist. If new reader information appears at step 3, return to step 1.

## References

Load on demand:

- `references/principles.md` — full principles and guidelines.
- `references/checklist.md` — 42-item pre-flight review.
- `references/reader-test.md` — reader evaluation. External docs only; skip for internal memos.
- `assets/template.md` — starting shape for the output. Use it as the default structure.

## Step 1 — Identify readers and format (Principle 1)

Before drafting, know:

- **Readers:** roles or teams. If several, name the **primary** audience.
- **Purpose:** what they must do after reading (decide, approve, act, learn).
- **Prior knowledge:** what they know; adjust vocabulary.
- **Reading context:** phone, desktop, meeting, Slack link.
- **Time available.**
- **Language:** confirm before drafting in English if the reader group is not native.
- **Format:** a video, form, FAQ, or dashboard may serve better than prose.

Ethics: accurate content, no misleading claims, no hidden content the reader needs.

If any of the above is missing, ask one focused question before drafting. Do not skip.

## Step 2 — Structure for findability (Principle 2)

- The most important message goes at the top. The reader knows the ask, decision, or answer within the first screen.
- Multiple audiences get their own labelled section.
- Warnings before instructions.
- Processes in chronological order.
- Headings describe what follows. Scanning headings alone reconstructs the argument.
- Supplementary detail at the end, in a labelled section.
- Apply prominence (bold, callouts), proximity (group related items), similarity (same shape for same function). Use white space to separate ideas.

## Step 3 — Write for understandability (Principle 3)

- **Familiar words.** Keep a technical term only if the everyday word is less accurate.
- **One idea per sentence.** Average 15–20 words.
- **One idea per paragraph.** Front-load the main point.
- **Active voice.** Name the actor.
- **Direct address.** Use "you".
- **Direct requests.** No performative politeness ("please" every paragraph, "thank you for your time"). No scolding, no condescension.
- **Diagrams** for spatial, temporal, or relational content.
- **Define technical terms** on first use or in a glossary.
- **Consistent terminology.** Same term for the same concept. No synonyms.

## Step 4 — Make it usable (Principle 4)

- Self-review with `references/checklist.md` before delivering.
- Include an explicit response mechanism: an approval memo has "Approved / Approved with comments / Not approved"; an RFC points to a comment thread or decision meeting; a runbook names who to page.
- Do not push reader testing for internal memos. For external documents (public terms, customer policy, regulator submissions), load `references/reader-test.md`.
- If a reader comes back confused, revise. That is the signal.

## Required output shape

Every document must include:

1. **Headline** stating what the document is and what it asks for.
2. **Header block** with author, date (`YYYY-MM-DD`), version, status, reading time, and reader groups. `assets/template.md` shows the shape.
3. **Main content** grouped by reader need, not by author's mental hierarchy.
4. **Warnings** before the instructions they warn about.
5. **Glossary** or inline definitions for technical terms the primary reader may not know.
6. **Response mechanism** stating how the reader should respond or act.
7. **Related documents** section at the end.

### Multi-audience routing (recommended, not required)

When a document has more than one reader group, help each reader find their section quickly. ISO 24495 requires that structure supports findability but does not prescribe a specific pattern. Pick one:

- **"Are you the right reader?" section** listing reader groups and what each is asked to do. Good default for approval memos.
- **Routing table** at the top: audience → section. Good for reference docs with many audiences.
- **Labelled sections by audience** with a one-line pointer in the summary. Good for short documents.

Skip for single-audience documents.

## Anti-patterns

Do not do the following.

### Structure

- Do not start with background or context. Start with the ask.
- Do not bury the decision in a wall of text.
- Do not include meta-content ("This document will explain…").
- Do not use rhetorical questions as headings ("Why do we need this?").
- Do not nest lists more than two levels. Use a table.

### Attribution

- Do not personalise sections with names ("For Jane Doe"). Address roles or teams. People move; roles persist. If a POC is stable, put the name in an ownership table, not a heading.
- Do not attribute ownership to multiple teams without naming a primary. "Owned by Data, Analytics, and Engineering" means owned by nobody.
- Do not use author-centric framing ("I want to propose…", "We have been thinking…").

### Language

- Do not use synonyms for the same concept.
- Do not use passive voice when active is shorter and clearer.
- Do not use jargon without defining it.
- Do not chain acronyms ("SRE-owned CI/CD via IaC").
- Do not use "TL;DR". Use "Summary" or a plain headline.
- Do not use contractions in documents for non-native English readers.
- Do not use filler ("In today's fast-paced world", "It goes without saying").
- Do not use marketing verbs: leverage, synergise, empower, unlock, drive.
- Do not use weasel words: we believe, arguably, potentially, somewhat, it seems.
- Do not use vague quantifiers: a lot, many, significant, recently, soon. Use numbers and dates.
- Do not mix modal verbs. RFC 2119: `must` = requirement, `should` = strong recommendation, `may` = optional. Do not treat them as interchangeable.

### Content

- Do not include content the primary reader does not need.
- Do not state a constraint without its reason. "We must use PostgreSQL" needs a why.
- Do not leave success criteria vague ("we will monitor and iterate").
- Do not leave review requests vague ("please review and provide feedback").
- Do not compare to strawmen. Compare to real alternatives.
- Do not use false precision. "~$50/month" is fine; "up to 40% faster" without a baseline is not.
- Do not omit dates, version, or author from the header.
- Do not cross-reference other documents without a link or ID.

### Tone

- Do not scold, condescend, or lecture.
- Do not use passive-aggressive framing ("as has been repeatedly mentioned…").
- Do not manufacture consensus ("we all agree that…").

## After delivering

Offer a revision pass if a reader comes back confused. Do not push reader testing for internal memos.
