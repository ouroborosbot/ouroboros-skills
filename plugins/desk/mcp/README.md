# desk MCP server

Spawned by consumers (Claude Code, Copilot CLI, ouroboros daemon) to expose a uniform tool surface for working with a desk workspace. Tools include task / track / friction / lesson CRUD and hybrid lexical+semantic search.

## Run it directly

```sh
node ./index.js --root ~/AgentBundles/<agent>.ouro/desk
```

Or via environment:

```sh
DESK=~/<your-workspace> node ./index.js
```

## Tools exposed (15)

**Runtime CRUD:**
- `task_create`, `task_update`, `task_archive`
- `track_create`, `track_update`
- `friction_add`, `lesson_add`

**Status:**
- `desk_status` — session-start-safe MCP health, root, activation, index, snapshot, and vector-pack status
- `desk_doctor` — healthy-runtime confirmation or precise first-boot failure diagnosis and remediation

**Search:**
- `desk_search` — hybrid lexical + semantic
- `desk_recall` — semantic-only loose recall with auto-clustering
- `desk_similar` — find docs similar to a given path
- `desk_timeline` — temporal queries
- `desk_thread` — provenance walk via refs_graph
- `desk_reindex` — rebuild or repair the local search index

All 15 tools are wired to real implementations.

## How consumers wire this up

Desk ships host-specific declarations for hosts with different plugin-root
contracts. Copilot loads `.mcp.copilot.json`:

```json
{
  "mcpServers": {
    "desk": {
      "type": "stdio",
      "command": "node",
      "args": ["${COPILOT_PLUGIN_ROOT}/mcp/index.js"],
      "env": {}
    }
  }
}
```

Copilot expands `${COPILOT_PLUGIN_ROOT}` to the installed plugin directory before
launching the server, so startup is independent of the session working directory.
Claude Code, Codex, and generic Ouroboros consumers continue to use `.mcp.json`,
whose relative entrypoint is resolved by their host-specific activation path.

Codex global activation writes an owned `~/.codex/desk.activation.json` file in the default Codex profile. When that file exists, the MCP entrypoint auto-loads it at startup so `desk_status` can report the selected activation target, overlay chain, desk root, and runtime cache. Project-local Codex activation passes the same config explicitly with `--activation-config .codex/desk.activation.json`.

## Generic stdio MCP launch

Generic stdio hosts can launch Desk as an MCP-only server, but generic stdio does not activate `worker` and does not resolve plugin dependencies for Work Suite.

Bind the root explicitly:

```sh
DESK=~/desk
node /path/to/plugins/desk/mcp/index.js --root "$DESK"
```

If the host cannot pass environment variables, pass the same concrete path directly:

```sh
node /path/to/plugins/desk/mcp/index.js --root ~/desk
```

This path provides MCP tools only; there is no worker activation, default agent preamble, or plugin dependency closure.

## Dependencies

- `@modelcontextprotocol/sdk` — MCP server framework
- `better-sqlite3` — local SQLite for the search index
- `sqlite-vec` — vector search extension
- `gray-matter` — YAML frontmatter parser

`sqlite-vec` and `better-sqlite3` are native deps. Healthy plugin activation restores the committed production runtime pack into a writable cache.

Desk validates the committed runtime support matrix before loading production dependencies. If the host's Node ABI is unsupported, Desk searches only bounded local Node locations (the active executable, `PATH`, and standard NVM, Volta, asdf, and mise locations) and performs at most one guarded stdio-preserving handoff to a compatible runtime. It never installs, downloads, or reaches the network during startup. If no healthy local path exists, a dependency-free diagnostic MCP remains live with `desk_status` and `desk_doctor`; all mutation tools fail closed with the same diagnosis and offline remediation instead of crashing the host.

### Developer notes

Direct development checkouts can still run `npm install` when intentionally working on the MCP package.

Semantic ranking requires Ollama with `nomic-embed-text` pulled. The MCP resolves the embedding endpoint in this order: explicit test/tool `endpoint`, `DESK_EMBED_ENDPOINT`, `DESK_OLLAMA_ENDPOINT`, `OLLAMA_HOST`, `http://127.0.0.1:11434`, then `http://localhost:11434`. Set `DESK_EMBED_MODEL` to override `nomic-embed-text`, and `DESK_EMBED_TIMEOUT_MS` to adjust the per-endpoint timeout.

If Ollama is unavailable, search soft-falls-back to FTS5-only with `semantic_unavailable` plus `semantic_diagnostic` and `semantic_repair` fields in the response. If a desk was indexed while Ollama was down, `desk_reindex` without arguments now repairs missing vectors automatically once embeddings are reachable; `force:true` is only needed when you intentionally want to drop and rebuild the whole DB.

## Shared Workspace Artifacts

The local index remains machine-local at `$DESK/.state/desk-index.sqlite`. Shared document embeddings and warm-start snapshots live outside `.state/` under `$DESK/artifacts/`:

- `$DESK/artifacts/vector-packs/<embedding-spec-id>/<pack-id>.jsonl`
- `$DESK/artifacts/snapshots/<embedding-spec-id>/<snapshot-id>.sqlite.zst`

Runtime startup prefers workspace artifacts over plugin release artifacts. It restores compatible snapshots by copying them into `.state/`, falls back to vector packs when needed, and only generates document embeddings for chunks not covered by committed artifacts.

## Artifact privacy

Embeddings and snapshots are derivative data and may carry privacy risk. Vector packs store document-side embedding data, and snapshots may preserve searchable index state, so artifact publication is explicit, policy-checked, and separate from ordinary MCP startup.

## Tests

```sh
npm test
```

Boots the server with temp roots, asserts the tool surface registers, and exercises the real tool bodies via the dispatcher and fixture desks.
