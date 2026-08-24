# Desk Snapshot Artifacts

Committed snapshot artifacts live under:

```text
plugins/desk/artifacts/snapshots/<embedding-spec-id>/<snapshot-id>.sqlite.zst
plugins/desk/artifacts/snapshots/<embedding-spec-id>/<snapshot-id>.manifest.json
plugins/desk/artifacts/snapshots/<embedding-spec-id>/<snapshot-id>.sha256
```

Snapshots are compressed SQLite index caches. They are derivative artifacts and
must be validated before restore. The sidecar manifest records the embedding
spec, chunker and normalization IDs, DB schema, sqlite-vec/runtime
compatibility, artifact source-scope hash, document tree hash, included vector
pack IDs, creation time, artifact checksum, provenance, and source paths.

Source-scope or document-tree hash mismatches are freshness signals, not hard
compatibility failures. Schema, embedding, runtime, artifact checksum, unsafe
path, or provenance failures make the snapshot incompatible.

Local indexing can represent all allowed Markdown and may therefore include non-secret personal content. Local index eligibility does not grant permission to publish or share artifacts. Preserve the existing secret exclusions, and require explicit human review and approval before any snapshot is shared, published, or committed.
