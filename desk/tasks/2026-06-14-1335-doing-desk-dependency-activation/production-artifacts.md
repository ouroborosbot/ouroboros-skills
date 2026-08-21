# Production Shared Artifacts

Status: published in Unit 22e.

This note records the expected verification shape for the first committed Desk production vector pack and snapshot. The artifacts must live under the active embedding-spec directories:

- `plugins/desk/artifacts/vector-packs/<embedding-spec-id>/`
- `plugins/desk/artifacts/snapshots/<embedding-spec-id>/`

Required release-maintenance commands:

- `npm --prefix plugins/desk/mcp run artifact:vector-pack:build -- --desk-root <desk-root> --pack-id <pack-id> --from-local-db`
- `npm --prefix plugins/desk/mcp run artifact:snapshot:build -- --desk-root <desk-root> --snapshot-id <snapshot-id> --included-pack-id <pack-id> --from-local-db`
- `npm --prefix plugins/desk/mcp run artifact:validate -- --desk-root <desk-root>`
- `node scripts/test-desk-generated-artifacts.cjs`

Commands run:

- Updated-source force reindex of `<repo>/desk` with `desk_reindex({ force: true })`, snapshot restore disabled, and vector-pack import disabled so the committed snapshot is rebuilt from a compact current-source DB.
- `npm --prefix plugins/desk/mcp run artifact:vector-pack:build -- --desk-root <repo>/desk --pack-id repo-public-bootstrap-2026-06-15 --from-local-db`
- `npm --prefix plugins/desk/mcp run artifact:snapshot:build -- --desk-root <repo>/desk --snapshot-id repo-public-bootstrap-2026-06-15 --included-pack-id repo-public-bootstrap-2026-06-15 --from-local-db`
- `npm --prefix plugins/desk/mcp run artifact:validate -- --desk-root <repo>/desk`
- `npm --prefix plugins/desk/mcp run artifact:snapshot:verify -- --snapshot-id repo-public-bootstrap-2026-06-15`
- `node scripts/test-desk-generated-artifacts.cjs`

Current freshness anchors:

- current_artifact_source_scope_hash: sha256:bb07ee3a92c89a91fe5bd5c97ff88976415f356469fc0fad32d7b542ffea15b7
- current_document_tree_hash: sha256:b8268841c4877dfe293de7c463eadf38339c741daa6416ffd5b1ec652087fba8

Published vector pack:

- Path: `plugins/desk/artifacts/vector-packs/nomic-embed-text-v1_5-desk-md-h2-paragraph-v1-unicode-whitespace-v1-768/repo-public-bootstrap-2026-06-15.jsonl`
- Manifest: `plugins/desk/artifacts/vector-packs/nomic-embed-text-v1_5-desk-md-h2-paragraph-v1-unicode-whitespace-v1-768/repo-public-bootstrap-2026-06-15.manifest.json`
- Checksum: `plugins/desk/artifacts/vector-packs/nomic-embed-text-v1_5-desk-md-h2-paragraph-v1-unicode-whitespace-v1-768/repo-public-bootstrap-2026-06-15.sha256`
- `pack_id`: `repo-public-bootstrap-2026-06-15`
- `row_count`: 2
- `rows_sha256`: `d0c07f02e1acda61962e4f2232fa68d7f5cc9802510c29aebb604cabfca1dfda`
- `artifact_source_scope_hash`: `sha256:bb07ee3a92c89a91fe5bd5c97ff88976415f356469fc0fad32d7b542ffea15b7`
- `document_tree_hash`: `sha256:b8268841c4877dfe293de7c463eadf38339c741daa6416ffd5b1ec652087fba8`
- `discovery_grammar_version`: `2`
- `represented_document_count`: 1
- Represented document: `tasks/dependency-activation/task.md` at `sha256:3886140d5ca53b11e39d670572bce11535d9f980e4d168dbdcbbd72bc10edf59`
- Provenance commit: `579a055c8761d5cad862c8a5edf8a6e766f96f4a`

Published snapshot:

- Path: `plugins/desk/artifacts/snapshots/nomic-embed-text-v1_5-desk-md-h2-paragraph-v1-unicode-whitespace-v1-768/repo-public-bootstrap-2026-06-15.sqlite.zst`
- Manifest: `plugins/desk/artifacts/snapshots/nomic-embed-text-v1_5-desk-md-h2-paragraph-v1-unicode-whitespace-v1-768/repo-public-bootstrap-2026-06-15.manifest.json`
- Checksum: `plugins/desk/artifacts/snapshots/nomic-embed-text-v1_5-desk-md-h2-paragraph-v1-unicode-whitespace-v1-768/repo-public-bootstrap-2026-06-15.sha256`
- `snapshot_id`: `repo-public-bootstrap-2026-06-15`
- `artifact_source_scope_hash`: `sha256:bb07ee3a92c89a91fe5bd5c97ff88976415f356469fc0fad32d7b542ffea15b7`
- `document_tree_hash`: `sha256:b8268841c4877dfe293de7c463eadf38339c741daa6416ffd5b1ec652087fba8`
- `discovery_grammar_version`: `2`
- `included_pack_ids`: `repo-public-bootstrap-2026-06-15`
- `represented_document_count`: 1
- Represented document: `tasks/dependency-activation/task.md` at `sha256:3886140d5ca53b11e39d670572bce11535d9f980e4d168dbdcbbd72bc10edf59`
- Artifact sha256: `sha256:c943ea41473356d70e226cd2e9ee9cd29615ea680ac76055299193f9ae686124`
- Runtime: `portable-portable-portable`
- Provenance commit: `579a055c8761d5cad862c8a5edf8a6e766f96f4a`

Approval state:

- `plugins/desk/artifacts/publication-policy.json` keeps `default_publication: deny`, `repo_visibility: public`, `sensitive_repo: true`, and `approval_required: true`.
- `vector-pack` and `snapshot` publication are explicitly approved by `human-directed-codex` at `2026-06-16T06:09:03.000Z` for repo-local public Desk documents only.

Privacy and redaction checks:

- Exclusion checks ran through the vector-pack and snapshot artifact writers before bytes were written.
- Tombstone/redaction checks ran through the artifact writers and `artifact:validate`.
- Active artifacts represent only `tasks/dependency-activation/task.md`; the repo Desk's historical evidence bundle is explicitly gitignored from bootstrap publication so expanded all-Markdown discovery does not change the approved artifact scope, and no sensitive-path, deleted, redacted, personal global desk, or absolute-path content is represented.

## Personal Desk Artifacts

Status: published to the private `$DESK` workspace repo at commit `7f0f37b`.

These artifacts are private workspace artifacts, not public plugin release artifacts. They live under `$DESK/artifacts/` so cloned private Desk workspaces can warm-start without regenerating embeddings on each machine.

Commands run:

- Updated-source reindex of `$DESK` with `reembedMissing: true`.
- `npm --prefix plugins/desk/mcp run artifact:vector-pack:build -- --desk-root $DESK --plugin-root $DESK --pack-id ari-desk-2026-06-17 --from-local-db --provenance-commit 78de0eb181d54a18d999ffcfdb61f0a5d4f3041b`
- `npm --prefix plugins/desk/mcp run artifact:snapshot:build -- --desk-root $DESK --plugin-root $DESK --snapshot-id ari-desk-2026-06-17 --included-pack-id ari-desk-2026-06-17 --from-local-db --provenance-commit 78de0eb181d54a18d999ffcfdb61f0a5d4f3041b`
- `npm --prefix plugins/desk/mcp run artifact:validate -- --desk-root $DESK --plugin-root $DESK`
- `npm --prefix plugins/desk/mcp run artifact:snapshot:verify -- --desk-root $DESK --plugin-root $DESK --snapshot-id ari-desk-2026-06-17`

Published private vector pack:

- Path: `$DESK/artifacts/vector-packs/nomic-embed-text-v1_5-desk-md-h2-paragraph-v1-unicode-whitespace-v1-768/ari-desk-2026-06-17.jsonl`
- `pack_id`: `ari-desk-2026-06-17`
- `row_count`: 363
- `artifact_source_scope_hash`: `sha256:248add5bba8eb662ac8654ac8d6fb3fe024f4278e2d8d01408600f9047a4368e`
- `document_tree_hash`: `sha256:3268b445c09b1e1515650af09d7580d89418bc2ef2fafc41831adacdb9ff3dd2`
- `represented_document_count`: 38
- Source provenance commit: `78de0eb181d54a18d999ffcfdb61f0a5d4f3041b`

Published private snapshot:

- Path: `$DESK/artifacts/snapshots/nomic-embed-text-v1_5-desk-md-h2-paragraph-v1-unicode-whitespace-v1-768/ari-desk-2026-06-17.sqlite.zst`
- `snapshot_id`: `ari-desk-2026-06-17`
- `included_pack_ids`: `ari-desk-2026-06-17`
- `artifact_source_scope_hash`: `sha256:248add5bba8eb662ac8654ac8d6fb3fe024f4278e2d8d01408600f9047a4368e`
- `document_tree_hash`: `sha256:3268b445c09b1e1515650af09d7580d89418bc2ef2fafc41831adacdb9ff3dd2`
- `represented_document_count`: 38
- Artifact sha256: `sha256:a963bced8dd83fa5944df3f76ea1ef0af25a1800e667cad23d38d95452e5e7a9`
- Source provenance commit: `78de0eb181d54a18d999ffcfdb61f0a5d4f3041b`

Private cold-start checks:

- Snapshot restore with no `.state/`: `snapshot_restored`, 363 chunks, 363 vectors, 0 missing vectors, no live embeddings.
- Vector-pack-only rebuild with snapshots disabled: imported 363 rows, 363 chunks, 363 vectors, 0 missing vectors, no live embeddings.
