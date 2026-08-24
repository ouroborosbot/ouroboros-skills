# Desk Vector Packs

Committed vector packs live under:

`plugins/desk/artifacts/vector-packs/<embedding-spec-id>/<pack-id>.jsonl`

Each pack must have adjacent `<pack-id>.manifest.json` and `<pack-id>.sha256`
sidecars. Runtime import validates the sidecars, row metadata, active embedding
spec, dimensions, and local chunk text hashes before inserting vectors into the
local Desk index.

Local indexing can represent all allowed Markdown and may therefore include non-secret personal content. Local index eligibility does not grant permission to publish or share artifacts. Preserve the existing secret exclusions, and require explicit human review and approval before any vector pack is shared, published, or committed.
