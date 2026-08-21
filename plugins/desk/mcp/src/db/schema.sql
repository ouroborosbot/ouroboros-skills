-- desk MCP indexer schema. Created on first run at <root>/.state/desk-index.sqlite.
-- W6 Unit 4: full schema + FTS5 + sqlite-vec virtual tables wired up.

-- ---------------------------------------------------------------------------
-- meta: single-row table that tracks index-wide state (last_indexed_at etc.).
-- Used by the boot-time staleness check.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- ---------------------------------------------------------------------------
-- docs: one row per file under <root>/ that gets indexed (task.md,
-- planning.md, doing.md, friction notes, lessons, etc.).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,                -- relative to deskRoot
  kind TEXT NOT NULL,                       -- task | track | planning | doing | feedback | friction | lesson | shared | archive | reference
  track TEXT,                               -- nullable; null for top-level _meta/ docs
  task_slug TEXT,                           -- nullable; null for non-task docs
  status TEXT,                              -- task status field (null for non-task)
  schema_version INTEGER DEFAULT 0,
  created_at TEXT,                          -- ISO 8601, from frontmatter
  updated_at TEXT,                          -- ISO 8601, from frontmatter
  hash TEXT NOT NULL,                       -- sha256 of file content for dirty-detection
  mtime INTEGER NOT NULL,                   -- filesystem mtime retained as indexed document metadata
  is_archived INTEGER NOT NULL DEFAULT 0,   -- 1 if the doc lives under any _archive/ ancestor
  frontmatter TEXT                          -- raw JSON of full frontmatter object
);

CREATE INDEX IF NOT EXISTS idx_docs_track ON docs(track);
CREATE INDEX IF NOT EXISTS idx_docs_kind ON docs(kind);
CREATE INDEX IF NOT EXISTS idx_docs_status ON docs(status);
CREATE INDEX IF NOT EXISTS idx_docs_updated_at ON docs(updated_at);

-- ---------------------------------------------------------------------------
-- chunks: one row per semantic chunk extracted from a doc.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,             -- 0-based position within doc
  chunk_key TEXT,
  text_hash TEXT,
  embedding_spec_id TEXT,
  chunker_id TEXT,
  normalization_id TEXT,
  text TEXT NOT NULL,
  heading TEXT,                             -- nearest preceding heading, if any
  start_offset INTEGER,                     -- byte offset into doc
  end_offset INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id);

-- ---------------------------------------------------------------------------
-- embedding_specs: versioned embedding/chunker identity metadata.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS embedding_specs (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  chunker_id TEXT NOT NULL,
  normalization_id TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_embedding_specs_is_active ON embedding_specs(is_active);

-- ---------------------------------------------------------------------------
-- refs_graph: directed edges between docs (e.g., task.md → its planning.md,
-- doing.md → its task.md). Powers desk_thread (provenance walk) in Unit 6.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refs_graph (
  src_doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  dst_doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  ref_kind TEXT NOT NULL,                   -- planning_of | doing_of | feedback_of | linked_from_body | predecessor | etc.
  PRIMARY KEY (src_doc_id, dst_doc_id, ref_kind)
);

CREATE INDEX IF NOT EXISTS idx_refs_src ON refs_graph(src_doc_id);
CREATE INDEX IF NOT EXISTS idx_refs_dst ON refs_graph(dst_doc_id);

-- ---------------------------------------------------------------------------
-- chunks_fts: FTS5 virtual table over chunks.text, content-linked to chunks
-- so we can search the text without duplicating it. Kept in sync by triggers
-- below.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='id'
);

-- Trigger fan-out: keep chunks_fts in lockstep with chunks.
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

-- ---------------------------------------------------------------------------
-- chunk_vecs: sqlite-vec virtual table for dense embeddings. 768-dim,
-- matching nomic-embed-text-v1.5's output. Synced manually from the indexer
-- (vec0 virtual tables don't support triggers).
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vecs USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding FLOAT[768]
);

-- ---------------------------------------------------------------------------
-- chunk_embedding_failures: stable tombstones for chunks that the active
-- embedding provider rejected for chunk-local reasons (for example context
-- length). These rows prevent every startup/search from retrying known
-- unembeddable chunks while still letting text changes or spec changes retry.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chunk_embedding_failures (
  chunk_key TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  embedding_spec_id TEXT NOT NULL,
  chunker_id TEXT NOT NULL,
  normalization_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  message TEXT,
  failed_at TEXT NOT NULL,
  PRIMARY KEY (
    chunk_key,
    text_hash,
    embedding_spec_id,
    chunker_id,
    normalization_id
  )
);

CREATE INDEX IF NOT EXISTS idx_chunk_embedding_failures_spec
  ON chunk_embedding_failures(embedding_spec_id, chunker_id, normalization_id);
