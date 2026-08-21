// Unit 22d: red contract for production vector-pack and snapshot artifacts.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")
const pluginRoot = path.join(repoRoot, "plugins", "desk")
const productionNotesPath = path.join(
  repoRoot,
  "desk",
  "tasks",
  "2026-06-14-1335-doing-desk-dependency-activation",
  "production-artifacts.md",
)
const require = createRequire(import.meta.url)
const generatedArtifacts = require(path.join(repoRoot, "scripts", "test-desk-generated-artifacts.cjs"))

function repoPath(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/")
}

function writeFile(root, rel, body) {
  const filePath = path.join(root, rel)
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, body)
  return filePath
}

function writeJson(root, rel, value) {
  return writeFile(root, rel, `${JSON.stringify(value, null, 2)}\n`)
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function docTree(docs) {
  return generatedArtifacts.documentTreeHash(docs)
}

function artifactSourceScopeHash() {
  return generatedArtifacts.artifactSourceScopeHash(mcpRoot)
}

function validApproval(artifactType) {
  return {
    scope: "repo",
    artifact_type: artifactType,
    approved_by: "unit-test-reviewer",
    approved_at: "2026-06-15T00:00:00.000Z",
    reason: `approve ${artifactType} publication fixture`,
  }
}

function validPublicationPolicy(overrides = {}) {
  return {
    schema_version: 1,
    default_publication: "deny",
    repo_visibility: "public",
    sensitive_repo: true,
    approved_artifact_types: ["vector-pack", "snapshot"],
    approval_required: true,
    approvals: [validApproval("vector-pack"), validApproval("snapshot")],
    updated_at: "2026-06-15T00:00:00.000Z",
    ...overrides,
  }
}

function writeProductionPolicy(pluginRoot, policy) {
  writeJson(pluginRoot, "artifacts/publication-policy.json", policy)
  writeFile(
    pluginRoot,
    "artifacts/publication-policy.schema.json",
    readFileSync(path.join(repoRoot, "plugins", "desk", "artifacts", "publication-policy.schema.json")),
  )
}

function writeProductionNotes(filePath, { artifactSourceScopeHash, documentTreeHash }) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, [
    "# Production Shared Artifacts",
    "",
    "Verification:",
    "- `node scripts/test-desk-generated-artifacts.cjs`",
    "- `npm --prefix plugins/desk/mcp run artifact:vector-pack:build -- --desk-root <desk-root> --pack-id <pack-id> --from-local-db`",
    "- `npm --prefix plugins/desk/mcp run artifact:snapshot:build -- --desk-root <desk-root> --snapshot-id <snapshot-id> --included-pack-id <pack-id> --from-local-db`",
    "- `npm --prefix plugins/desk/mcp run artifact:validate -- --desk-root <desk-root>`",
    `- current_artifact_source_scope_hash: ${artifactSourceScopeHash}`,
    `- current_document_tree_hash: ${documentTreeHash}`,
    "- publication-policy approval recorded",
    "- tombstone and exclusion checks ran",
    "",
  ].join("\n"))
}

function writeAmbiguousProductionNotes(filePath, { sourceHash, staleDocumentTreeHash }) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, [
    "# Production Shared Artifacts",
    "",
    "Verification:",
    "- `node scripts/test-desk-generated-artifacts.cjs`",
    "- `npm --prefix plugins/desk/mcp run artifact:vector-pack:build -- --desk-root <desk-root> --pack-id <pack-id> --from-local-db`",
    "- `npm --prefix plugins/desk/mcp run artifact:snapshot:build -- --desk-root <desk-root> --snapshot-id <snapshot-id> --included-pack-id <pack-id> --from-local-db`",
    "- `npm --prefix plugins/desk/mcp run artifact:validate -- --desk-root <desk-root>`",
    `- vector pack artifact_source_scope_hash: ${sourceHash}`,
    `- vector pack document_tree_hash: ${staleDocumentTreeHash}`,
    `- snapshot artifact_source_scope_hash: ${sourceHash}`,
    `- snapshot document_tree_hash: ${staleDocumentTreeHash}`,
    "- publication-policy approval recorded",
    "- tombstone and exclusion checks ran",
    "",
  ].join("\n"))
}

function writePrimaryWithSidecars({ dir, id, primarySuffix, manifest }) {
  writeFile(dir, `${id}${primarySuffix}`, "artifact bytes\n")
  writeJson(dir, `${id}.manifest.json`, manifest)
  writeFile(dir, `${id}.sha256`, `${sha256("artifact bytes\n")}  ${id}${primarySuffix}\n`)
}

function writePrimaryWithBadChecksum({ dir, id, primarySuffix, manifest }) {
  writeFile(dir, `${id}${primarySuffix}`, "artifact bytes\n")
  writeJson(dir, `${id}.manifest.json`, manifest)
  writeFile(dir, `${id}.sha256`, `${sha256("wrong artifact bytes\n")}  ${id}${primarySuffix}\n`)
}

function greenValidation() {
  return {
    vector_packs: { count: 1, artifacts: [{ pack_id: "unit-pack", rows: 1 }] },
    snapshots: {
      count: 1,
      artifacts: [{
        snapshot_id: "unit-snapshot",
        freshness: {
          artifact_source_scope: "fresh",
          document_tree: "fresh",
        },
      }],
    },
  }
}

function trackedArtifactSpawn({ blobs = new Map(), dirty = new Set() } = {}) {
  return (_command, args) => {
    if (args[0] === "ls-files") {
      return { status: 0, stdout: "", stderr: "" }
    }
    if (args[0] === "show") {
      const repoPath = String(args[1]).replace(/^:/u, "")
      const bytes = blobs.get(repoPath)
      return bytes === undefined
        ? { status: 1, stdout: Buffer.alloc(0), stderr: "" }
        : { status: 0, stdout: Buffer.from(bytes), stderr: "" }
    }
    if (args[0] === "diff" && args[1] === "--quiet") {
      const repoPath = args.at(-1)
      return { status: dirty.has(repoPath) ? 1 : 0, stdout: "", stderr: "" }
    }
    return { status: 1, stdout: "", stderr: "" }
  }
}

async function tempExpectation({ tempDir, modules } = {}) {
  return generatedArtifacts.productionSharedArtifactExpectation({
    repoRoot,
    mcpRoot,
    pluginRoot: path.join(tempDir, "plugins", "desk"),
    deskRoot: path.join(tempDir, "desk"),
    notesPath: path.join(tempDir, "production-artifacts.md"),
    productionArtifactModules: modules,
  })
}

test("production shared artifact expectation uses canonical active-spec repo paths", async () => {
  assert.equal(typeof generatedArtifacts.productionSharedArtifactExpectation, "function")
  assert.equal(typeof generatedArtifacts.verifyProductionSharedArtifacts, "function")

  const expectation = await generatedArtifacts.productionSharedArtifactExpectation({
    repoRoot,
    mcpRoot,
    pluginRoot,
  })

  assert.match(expectation.embeddingSpecId, /^nomic-embed-text/u)
  assert.equal(
    repoPath(expectation.vectorPackDir),
    `plugins/desk/artifacts/vector-packs/${expectation.embeddingSpecId}`,
  )
  assert.equal(
    repoPath(expectation.snapshotDir),
    `plugins/desk/artifacts/snapshots/${expectation.embeddingSpecId}`,
  )
  assert.equal(expectation.notesPath, productionNotesPath)
  assert.equal(expectation.vectorPackDir.includes("__tests__"), false)
  assert.equal(expectation.snapshotDir.includes("__tests__"), false)
})

test("production artifact verification notes declare commands, hashes, policy, and redaction checks", () => {
  const body = readFileSync(productionNotesPath, "utf8").toLowerCase()
  for (const required of [
    "node scripts/test-desk-generated-artifacts.cjs",
    "artifact:vector-pack:build",
    "artifact:snapshot:build",
    "artifact:validate",
    "current_artifact_source_scope_hash",
    "current_document_tree_hash",
    "publication-policy",
    "approval",
    "tombstone",
    "exclusion",
  ]) {
    assert.ok(body.includes(required), `production-artifacts.md must mention ${required}`)
  }
})

test("production shared artifacts are committed, approved, policy-checked, and fresh", async () => {
  const result = await generatedArtifacts.verifyGeneratedArtifacts({
    repoRoot,
    mcpRoot,
    pluginRoot,
  })

  assert.equal(result.ok, true, result.errors.join("\n"))
  assert.ok(
    result.productionSharedArtifacts.vector_packs.count >= 1,
    "at least one production vector pack must be committed",
  )
  assert.ok(
    result.productionSharedArtifacts.snapshots.count >= 1,
    "at least one production snapshot must be committed",
  )
})

test("production shared artifact verifier rejects missing or fixture-only artifacts", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-artifacts-"))
  try {
    const expectation = await generatedArtifacts.productionSharedArtifactExpectation({
      repoRoot,
      mcpRoot,
      pluginRoot: path.join(tempDir, "plugins", "desk"),
      notesPath: path.join(tempDir, "production-artifacts.md"),
    })
    const result = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: () => ({ status: 1, stdout: "", stderr: "" }),
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join("\n"), /production vector pack artifact missing/u)
    assert.match(result.errors.join("\n"), /production snapshot artifact missing/u)
    assert.match(result.errors.join("\n"), /publication policy/u)
    assert.match(result.errors.join("\n"), /production-artifacts\.md/u)
    assert.doesNotMatch(result.errors.join("\n"), /__tests__\/fixtures/u)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("production policy approval must pass the committed publication-policy schema", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-policy-"))
  try {
    const expectation = await tempExpectation({
      tempDir,
      modules: {
        activeEmbeddingSpec: { id: "unit-spec" },
        validateArtifacts: async () => ({
          vector_packs: { count: 0, artifacts: [] },
          snapshots: { count: 0, artifacts: [] },
        }),
      },
    })
    writeProductionNotes(expectation.notesPath, {
      artifactSourceScopeHash: sha256("source"),
      documentTreeHash: docTree([]),
    })
    writeProductionPolicy(expectation.pluginRoot, validPublicationPolicy({
      approvals: [
        { artifact_type: "vector-pack" },
        validApproval("snapshot"),
      ],
    }))

    const result = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join("\n"), /publication policy approvals\[0\] missing reason/u)
    assert.match(result.errors.join("\n"), /publication policy approvals\[0\]\.scope is unsupported/u)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("production policy must require explicit publication approval", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-policy-approval-required-"))
  try {
    const expectation = await tempExpectation({
      tempDir,
      modules: {
        activeEmbeddingSpec: { id: "unit-spec" },
        validateArtifacts: async () => ({
          vector_packs: { count: 0, artifacts: [] },
          snapshots: { count: 0, artifacts: [] },
        }),
      },
    })
    writeProductionNotes(expectation.notesPath, {
      artifactSourceScopeHash: sha256("source"),
      documentTreeHash: docTree([]),
    })
    writeProductionPolicy(expectation.pluginRoot, validPublicationPolicy({
      approval_required: false,
    }))

    const result = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join("\n"), /production artifact publication policy must require explicit approval/u)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("production document freshness compares manifests to the published current document tree", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-doc-tree-"))
  try {
    const staleDocs = [{ path: "track/stale/task.md", hash: sha256("old") }]
    const currentDocs = [{ path: "track/current/task.md", hash: sha256("new") }]
    const expectation = await tempExpectation({
      tempDir,
      modules: {
        activeEmbeddingSpec: { id: "unit-spec" },
        validateArtifacts: async () => ({
          vector_packs: { count: 1, artifacts: [{ pack_id: "unit-pack", rows: 1 }] },
          snapshots: {
            count: 1,
            artifacts: [{
              snapshot_id: "unit-snapshot",
              freshness: {
                artifact_source_scope: "fresh",
                document_tree: "fresh",
              },
            }],
          },
        }),
      },
    })
    writeProductionNotes(expectation.notesPath, {
      artifactSourceScopeHash: sha256("source"),
      documentTreeHash: docTree(currentDocs),
    })
    writeProductionPolicy(expectation.pluginRoot, validPublicationPolicy())
    const manifest = {
      artifact_source_scope_hash: sha256("source"),
      document_tree_hash: docTree(staleDocs),
      represented_documents: staleDocs,
    }
    writePrimaryWithSidecars({
      dir: path.join(expectation.vectorPackDir),
      id: "unit-pack",
      primarySuffix: ".jsonl",
      manifest,
    })
    writePrimaryWithSidecars({
      dir: path.join(expectation.snapshotDir),
      id: "unit-snapshot",
      primarySuffix: ".sqlite.zst",
      manifest,
    })

    const result = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join("\n"), /production vector pack unit-pack\.jsonl document_tree_hash must match production-artifacts\.md/u)
    assert.match(result.errors.join("\n"), /production snapshot unit-snapshot\.sqlite\.zst document_tree_hash must match production-artifacts\.md/u)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("production artifact sidecars must exist, be tracked, and start with valid checksums", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-sidecars-"))
  try {
    const sourceHash = artifactSourceScopeHash()
    const currentDocs = [{ path: "tasks/dependency-activation/task.md", hash: sha256("current") }]
    const expectation = await tempExpectation({
      tempDir,
      modules: {
        activeEmbeddingSpec: { id: "unit-spec" },
        validateArtifacts: async () => greenValidation(),
      },
    })
    writeFile(
      tempDir,
      path.join("desk", "tasks", "dependency-activation", "task.md"),
      "current",
    )
    writeProductionNotes(expectation.notesPath, {
      artifactSourceScopeHash: sourceHash,
      documentTreeHash: docTree(currentDocs),
    })
    writeProductionPolicy(expectation.pluginRoot, validPublicationPolicy())
    const manifest = {
      artifact_source_scope_hash: sourceHash,
      document_tree_hash: docTree(currentDocs),
      represented_documents: currentDocs,
    }
    writePrimaryWithSidecars({
      dir: path.join(expectation.vectorPackDir),
      id: "unit-pack",
      primarySuffix: ".jsonl",
      manifest,
    })
    writePrimaryWithSidecars({
      dir: path.join(expectation.snapshotDir),
      id: "unit-snapshot",
      primarySuffix: ".sqlite.zst",
      manifest,
    })
    rmSync(path.join(expectation.vectorPackDir, "unit-pack.manifest.json"))
    writeFile(expectation.snapshotDir, "unit-snapshot.sha256", "not-a-digest  unit-snapshot.sqlite.zst\n")

    const missingOrMalformed = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })
    assert.equal(missingOrMalformed.ok, false)
    assert.match(missingOrMalformed.errors.join("\n"), /production vector pack sidecar missing:/u)
    assert.match(missingOrMalformed.errors.join("\n"), /production snapshot unit-snapshot\.sqlite\.zst checksum must start with a sha256 digest/u)

    const untracked = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: () => ({ status: 1, stdout: "", stderr: "" }),
    })
    assert.equal(untracked.ok, false)
    assert.match(untracked.errors.join("\n"), /production vector pack artifact must be tracked by git:/u)
    assert.match(untracked.errors.join("\n"), /production snapshot artifact must be tracked by git:/u)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("production verifier reports plain validation failures", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-plain-validation-failure-"))
  try {
    const sourceHash = artifactSourceScopeHash()
    const currentDocs = [{ path: "tasks/dependency-activation/task.md", hash: sha256("current") }]
    const expectation = await tempExpectation({
      tempDir,
      modules: {
        activeEmbeddingSpec: { id: "unit-spec" },
        validateArtifacts: async () => {
          throw "plain validation failure"
        },
      },
    })
    writeFile(
      tempDir,
      path.join("desk", "tasks", "dependency-activation", "task.md"),
      "current",
    )
    writeProductionNotes(expectation.notesPath, {
      artifactSourceScopeHash: sourceHash,
      documentTreeHash: docTree(currentDocs),
    })
    writeProductionPolicy(expectation.pluginRoot, validPublicationPolicy())
    const manifest = {
      artifact_source_scope_hash: sourceHash,
      document_tree_hash: docTree(currentDocs),
      represented_documents: currentDocs,
    }
    writePrimaryWithSidecars({
      dir: path.join(expectation.vectorPackDir),
      id: "unit-pack",
      primarySuffix: ".jsonl",
      manifest,
    })
    writePrimaryWithSidecars({
      dir: path.join(expectation.snapshotDir),
      id: "unit-snapshot",
      primarySuffix: ".sqlite.zst",
      manifest,
    })

    const result = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join("\n"), /production shared artifact validation failed: plain validation failure/u)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("production freshness manifests fail closed when snapshot sidecar JSON is unreadable", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-malformed-snapshot-manifest-"))
  try {
    const sourceHash = artifactSourceScopeHash()
    const currentDocs = [{ path: "tasks/dependency-activation/task.md", hash: sha256("current") }]
    const expectation = await tempExpectation({
      tempDir,
      modules: {
        activeEmbeddingSpec: { id: "unit-spec" },
        validateArtifacts: async () => greenValidation(),
      },
    })
    writeFile(
      tempDir,
      path.join("desk", "tasks", "dependency-activation", "task.md"),
      "current",
    )
    writeProductionNotes(expectation.notesPath, {
      artifactSourceScopeHash: sourceHash,
      documentTreeHash: docTree(currentDocs),
    })
    writeProductionPolicy(expectation.pluginRoot, validPublicationPolicy())
    const manifest = {
      artifact_source_scope_hash: sourceHash,
      document_tree_hash: docTree(currentDocs),
      represented_documents: currentDocs,
    }
    writePrimaryWithSidecars({
      dir: path.join(expectation.vectorPackDir),
      id: "unit-pack",
      primarySuffix: ".jsonl",
      manifest,
    })
    writePrimaryWithSidecars({
      dir: path.join(expectation.snapshotDir),
      id: "unit-snapshot",
      primarySuffix: ".sqlite.zst",
      manifest,
    })
    writeFile(expectation.snapshotDir, "unit-snapshot.manifest.json", "{")

    const result = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join("\n"), /production snapshot manifest must be readable JSON/u)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("production artifact checksums can be validated from string git blobs", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-string-git-blobs-"))
  try {
    const sourceHash = artifactSourceScopeHash()
    const currentDocs = [{ path: "tasks/dependency-activation/task.md", hash: sha256("current") }]
    let validationArgs
    const expectation = await tempExpectation({
      tempDir,
      modules: {
        activeEmbeddingSpec: { id: "unit-spec" },
        validateArtifacts: async (args) => {
          validationArgs = args
          return greenValidation()
        },
      },
    })
    writeFile(
      tempDir,
      path.join("desk", "tasks", "dependency-activation", "task.md"),
      "current",
    )
    writeProductionNotes(expectation.notesPath, {
      artifactSourceScopeHash: sourceHash,
      documentTreeHash: docTree(currentDocs),
    })
    writeProductionPolicy(expectation.pluginRoot, validPublicationPolicy())
    const manifest = {
      artifact_source_scope_hash: sourceHash,
      document_tree_hash: docTree(currentDocs),
      represented_documents: currentDocs,
    }
    const vectorPrimaryPath = writeFile(expectation.vectorPackDir, "unit-pack.jsonl", "artifact bytes\n")
    const vectorChecksumPath = writeFile(
      expectation.vectorPackDir,
      "unit-pack.sha256",
      `${sha256("artifact bytes\n")}  unit-pack.jsonl\n`,
    )
    writeJson(expectation.vectorPackDir, "unit-pack.manifest.json", manifest)
    const snapshotPrimaryPath = writeFile(expectation.snapshotDir, "unit-snapshot.sqlite.zst", "artifact bytes\n")
    const snapshotChecksumPath = writeFile(
      expectation.snapshotDir,
      "unit-snapshot.sha256",
      `${sha256("artifact bytes\n")}  unit-snapshot.sqlite.zst\n`,
    )
    writeJson(expectation.snapshotDir, "unit-snapshot.manifest.json", manifest)
    const blobs = new Map([
      [repoPath(vectorPrimaryPath), "artifact bytes\n"],
      [repoPath(vectorChecksumPath), `${sha256("artifact bytes\n")}  unit-pack.jsonl\n`],
      [repoPath(snapshotPrimaryPath), "artifact bytes\n"],
      [repoPath(snapshotChecksumPath), `${sha256("artifact bytes\n")}  unit-snapshot.sqlite.zst\n`],
    ])

    const result = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: (_command, args) => {
        if (args[0] === "ls-files" || (args[0] === "diff" && args[1] === "--quiet")) {
          return { status: 0, stdout: "", stderr: "" }
        }
        if (args[0] === "show") {
          const repoPath = String(args[1]).replace(/^:/u, "")
          return { status: 0, stdout: blobs.get(repoPath) ?? "", stderr: "" }
        }
        return { status: 1, stdout: "", stderr: "" }
      },
    })

    assert.equal(result.ok, true, result.errors.join("\n"))
    assert.equal(validationArgs.deskRoot, expectation.deskRoot)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("production verifier propagates validator freshness for vector packs and snapshots", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-validator-freshness-"))
  try {
    const sourceHash = artifactSourceScopeHash()
    const currentDocs = [{ path: "tasks/dependency-activation/task.md", hash: sha256("current") }]
    const expectation = await tempExpectation({
      tempDir,
      modules: {
        activeEmbeddingSpec: { id: "unit-spec" },
        validateArtifacts: async () => ({
          vector_packs: {
            count: 1,
            artifacts: [{
              pack_id: "unit-pack",
              rows: 1,
              freshness: {
                artifact_source_scope: "stale",
                document_tree: "stale",
                discovery_grammar: "stale",
              },
            }],
          },
          snapshots: {
            count: 1,
            artifacts: [{
              snapshot_id: "unit-snapshot",
              freshness: {
                artifact_source_scope: "stale",
                document_tree: "stale",
                discovery_grammar: "stale",
              },
            }],
          },
        }),
      },
    })
    writeFile(
      tempDir,
      path.join("desk", "tasks", "dependency-activation", "task.md"),
      "current",
    )
    writeProductionNotes(expectation.notesPath, {
      artifactSourceScopeHash: sourceHash,
      documentTreeHash: docTree(currentDocs),
    })
    writeProductionPolicy(expectation.pluginRoot, validPublicationPolicy())
    const manifest = {
      artifact_source_scope_hash: sourceHash,
      document_tree_hash: docTree(currentDocs),
      represented_documents: currentDocs,
    }
    writePrimaryWithSidecars({
      dir: path.join(expectation.vectorPackDir),
      id: "unit-pack",
      primarySuffix: ".jsonl",
      manifest,
    })
    writePrimaryWithSidecars({
      dir: path.join(expectation.snapshotDir),
      id: "unit-snapshot",
      primarySuffix: ".sqlite.zst",
      manifest,
    })

    const result = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join("\n"), /production vector pack unit-pack artifact_source_scope_hash is stale/u)
    assert.match(result.errors.join("\n"), /production vector pack unit-pack document_tree_hash is stale/u)
    assert.match(result.errors.join("\n"), /production vector pack unit-pack discovery_grammar_version is stale/u)
    assert.match(result.errors.join("\n"), /production snapshot unit-snapshot artifact_source_scope_hash is stale/u)
    assert.match(result.errors.join("\n"), /production snapshot unit-snapshot document_tree_hash is stale/u)
    assert.match(result.errors.join("\n"), /production snapshot unit-snapshot discovery_grammar_version is stale/u)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("production notes must use canonical current freshness hash fields", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-current-hashes-"))
  try {
    const staleDocs = [{ path: "track/stale/task.md", hash: sha256("old") }]
    const sourceHash = artifactSourceScopeHash()
    const expectation = await tempExpectation({
      tempDir,
      modules: {
        activeEmbeddingSpec: { id: "unit-spec" },
        validateArtifacts: async () => ({
          vector_packs: { count: 1, artifacts: [{ pack_id: "unit-pack", rows: 1 }] },
          snapshots: {
            count: 1,
            artifacts: [{
              snapshot_id: "unit-snapshot",
              freshness: {
                artifact_source_scope: "fresh",
                document_tree: "fresh",
              },
            }],
          },
        }),
      },
    })
    writeAmbiguousProductionNotes(expectation.notesPath, {
      sourceHash,
      staleDocumentTreeHash: docTree(staleDocs),
    })
    writeProductionPolicy(expectation.pluginRoot, validPublicationPolicy())
    const manifest = {
      artifact_source_scope_hash: sourceHash,
      document_tree_hash: docTree(staleDocs),
      represented_documents: staleDocs,
    }
    writePrimaryWithSidecars({
      dir: path.join(expectation.vectorPackDir),
      id: "unit-pack",
      primarySuffix: ".jsonl",
      manifest,
    })
    writePrimaryWithSidecars({
      dir: path.join(expectation.snapshotDir),
      id: "unit-snapshot",
      primarySuffix: ".sqlite.zst",
      manifest,
    })

    const result = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join("\n"), /production-artifacts\.md must record current_artifact_source_scope_hash as sha256:<hex>/u)
    assert.match(result.errors.join("\n"), /production-artifacts\.md must record current_document_tree_hash as sha256:<hex>/u)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("production notes reject duplicate canonical current hash placeholders", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-duplicate-hashes-"))
  try {
    const currentDocs = [{ path: "track/current/task.md", hash: sha256("new") }]
    const sourceHash = artifactSourceScopeHash()
    const expectation = await tempExpectation({
      tempDir,
      modules: {
        activeEmbeddingSpec: { id: "unit-spec" },
        validateArtifacts: async () => ({
          vector_packs: { count: 0, artifacts: [] },
          snapshots: { count: 0, artifacts: [] },
        }),
      },
    })
    writeProductionNotes(expectation.notesPath, {
      artifactSourceScopeHash: sourceHash,
      documentTreeHash: docTree(currentDocs),
    })
    writeFileSync(expectation.notesPath, [
      readFileSync(expectation.notesPath, "utf8"),
      "- current_artifact_source_scope_hash: pending Unit 22e",
      "- current_document_tree_hash: pending Unit 22e",
      "",
    ].join("\n"))
    writeProductionPolicy(expectation.pluginRoot, validPublicationPolicy())

    const result = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join("\n"), /production-artifacts\.md must record exactly one current_artifact_source_scope_hash/u)
    assert.match(result.errors.join("\n"), /production-artifacts\.md must record exactly one current_document_tree_hash/u)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("production artifact sidecar checksums must match committed bytes", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-checksum-"))
  try {
    const sourceHash = artifactSourceScopeHash()
    const currentDocs = [{ path: "tasks/dependency-activation/task.md", hash: sha256("current") }]
    const expectation = await tempExpectation({
      tempDir,
      modules: {
        activeEmbeddingSpec: { id: "unit-spec" },
        validateArtifacts: async () => greenValidation(),
      },
    })
    writeFile(
      tempDir,
      path.join("desk", "tasks", "dependency-activation", "task.md"),
      "current",
    )
    writeProductionNotes(expectation.notesPath, {
      artifactSourceScopeHash: sourceHash,
      documentTreeHash: docTree(currentDocs),
    })
    writeProductionPolicy(expectation.pluginRoot, validPublicationPolicy())
    const manifest = {
      artifact_source_scope_hash: sourceHash,
      document_tree_hash: docTree(currentDocs),
      represented_documents: currentDocs,
    }
    writePrimaryWithBadChecksum({
      dir: path.join(expectation.vectorPackDir),
      id: "unit-pack",
      primarySuffix: ".jsonl",
      manifest,
    })
    writePrimaryWithBadChecksum({
      dir: path.join(expectation.snapshotDir),
      id: "unit-snapshot",
      primarySuffix: ".sqlite.zst",
      manifest,
    })

    const result = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join("\n"), /production vector pack unit-pack\.jsonl checksum must match artifact bytes/u)
    assert.match(result.errors.join("\n"), /production snapshot unit-snapshot\.sqlite\.zst checksum must match artifact bytes/u)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("production artifacts fail when repo-local represented docs changed after publication", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-current-docs-"))
  try {
    const sourceHash = artifactSourceScopeHash()
    const publishedDocs = [{ path: "tasks/dependency-activation/task.md", hash: sha256("old body\n") }]
    const currentDocHash = sha256("new body\n")
    const expectation = await tempExpectation({
      tempDir,
      modules: {
        activeEmbeddingSpec: { id: "unit-spec" },
        validateArtifacts: async () => greenValidation(),
      },
    })
    writeFile(
      tempDir,
      path.join("desk", "tasks", "dependency-activation", "task.md"),
      "new body\n",
    )
    writeProductionNotes(expectation.notesPath, {
      artifactSourceScopeHash: sourceHash,
      documentTreeHash: docTree(publishedDocs),
    })
    writeProductionPolicy(expectation.pluginRoot, validPublicationPolicy())
    const manifest = {
      artifact_source_scope_hash: sourceHash,
      document_tree_hash: docTree(publishedDocs),
      represented_documents: publishedDocs,
    }
    writePrimaryWithSidecars({
      dir: path.join(expectation.vectorPackDir),
      id: "unit-pack",
      primarySuffix: ".jsonl",
      manifest,
    })
    writePrimaryWithSidecars({
      dir: path.join(expectation.snapshotDir),
      id: "unit-snapshot",
      primarySuffix: ".sqlite.zst",
      manifest,
    })

    const result = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join("\n"), /represented document tasks\/dependency-activation\/task\.md hash must match current repo document/u)
    assert.match(result.errors.join("\n"), new RegExp(`current ${currentDocHash.slice(0, 18)}`, "u"))
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("production artifacts require represented document metadata independent of artifact validation", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-missing-docs-"))
  try {
    const sourceHash = artifactSourceScopeHash()
    const currentDocs = [{ path: "tasks/dependency-activation/task.md", hash: sha256("current") }]
    const expectation = await tempExpectation({
      tempDir,
      modules: {
        activeEmbeddingSpec: { id: "unit-spec" },
        validateArtifacts: async () => greenValidation(),
      },
    })
    writeFile(
      tempDir,
      path.join("desk", "tasks", "dependency-activation", "task.md"),
      "current",
    )
    writeProductionNotes(expectation.notesPath, {
      artifactSourceScopeHash: sourceHash,
      documentTreeHash: docTree(currentDocs),
    })
    writeProductionPolicy(expectation.pluginRoot, validPublicationPolicy())
    const manifest = {
      artifact_source_scope_hash: sourceHash,
      document_tree_hash: docTree(currentDocs),
    }
    writePrimaryWithSidecars({
      dir: path.join(expectation.vectorPackDir),
      id: "unit-pack",
      primarySuffix: ".jsonl",
      manifest,
    })
    writePrimaryWithSidecars({
      dir: path.join(expectation.snapshotDir),
      id: "unit-snapshot",
      primarySuffix: ".sqlite.zst",
      manifest,
    })

    const result = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join("\n"), /production vector pack unit-pack\.jsonl represented_documents must be a non-empty array/u)
    assert.match(result.errors.join("\n"), /production snapshot unit-snapshot\.sqlite\.zst represented_documents must be a non-empty array/u)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("production artifacts reject traversal syntax in represented document paths", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-doc-traversal-"))
  try {
    const sourceHash = artifactSourceScopeHash()
    const currentDocs = [{ path: "tasks/dependency-activation/task.md", hash: sha256("current") }]
    const representedDocuments = [{
      path: "x/../tasks/dependency-activation/task.md",
      hash: sha256("current"),
    }]
    const expectation = await tempExpectation({
      tempDir,
      modules: {
        activeEmbeddingSpec: { id: "unit-spec" },
        validateArtifacts: async () => greenValidation(),
      },
    })
    writeFile(
      tempDir,
      path.join("desk", "tasks", "dependency-activation", "task.md"),
      "current",
    )
    writeProductionNotes(expectation.notesPath, {
      artifactSourceScopeHash: sourceHash,
      documentTreeHash: docTree(currentDocs),
    })
    writeProductionPolicy(expectation.pluginRoot, validPublicationPolicy())
    const manifest = {
      artifact_source_scope_hash: sourceHash,
      document_tree_hash: docTree(currentDocs),
      represented_documents: representedDocuments,
    }
    writePrimaryWithSidecars({
      dir: path.join(expectation.vectorPackDir),
      id: "unit-pack",
      primarySuffix: ".jsonl",
      manifest,
    })
    writePrimaryWithSidecars({
      dir: path.join(expectation.snapshotDir),
      id: "unit-snapshot",
      primarySuffix: ".sqlite.zst",
      manifest,
    })

    const result = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join("\n"), /represented document path must be a normalized relative path/u)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("production artifacts reject malformed represented document entries", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-doc-entry-shape-"))
  try {
    const sourceHash = artifactSourceScopeHash()
    const currentDocs = [{ path: "tasks/dependency-activation/task.md", hash: sha256("current") }]
    const representedDocuments = [
      null,
      [],
      { path: " ", hash: sha256("current") },
      { path: path.join(tempDir, "desk", "tasks", "dependency-activation", "task.md"), hash: sha256("current") },
      { path: "tasks\\dependency-activation\\task.md", hash: sha256("current") },
    ]
    const expectation = await tempExpectation({
      tempDir,
      modules: {
        activeEmbeddingSpec: { id: "unit-spec" },
        validateArtifacts: async () => greenValidation(),
      },
    })
    writeFile(
      tempDir,
      path.join("desk", "tasks", "dependency-activation", "task.md"),
      "current",
    )
    writeProductionNotes(expectation.notesPath, {
      artifactSourceScopeHash: sourceHash,
      documentTreeHash: docTree(currentDocs),
    })
    writeProductionPolicy(expectation.pluginRoot, validPublicationPolicy())
    const manifest = {
      artifact_source_scope_hash: sourceHash,
      document_tree_hash: docTree(currentDocs),
      represented_documents: representedDocuments,
    }
    writePrimaryWithSidecars({
      dir: path.join(expectation.vectorPackDir),
      id: "unit-pack",
      primarySuffix: ".jsonl",
      manifest,
    })
    writePrimaryWithSidecars({
      dir: path.join(expectation.snapshotDir),
      id: "unit-snapshot",
      primarySuffix: ".sqlite.zst",
      manifest,
    })

    const result = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join("\n"), /represented document must be an object/u)
    assert.match(result.errors.join("\n"), /represented document path must be a normalized relative path/u)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("production artifact checksums are compared against tracked bytes, not dirty working-tree bytes", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-tracked-bytes-"))
  try {
    const sourceHash = artifactSourceScopeHash()
    const currentDocs = [{ path: "tasks/dependency-activation/task.md", hash: sha256("current") }]
    const expectation = await tempExpectation({
      tempDir,
      modules: {
        activeEmbeddingSpec: { id: "unit-spec" },
        validateArtifacts: async () => greenValidation(),
      },
    })
    writeFile(
      tempDir,
      path.join("desk", "tasks", "dependency-activation", "task.md"),
      "current",
    )
    writeProductionNotes(expectation.notesPath, {
      artifactSourceScopeHash: sourceHash,
      documentTreeHash: docTree(currentDocs),
    })
    writeProductionPolicy(expectation.pluginRoot, validPublicationPolicy())
    const manifest = {
      artifact_source_scope_hash: sourceHash,
      document_tree_hash: docTree(currentDocs),
      represented_documents: currentDocs,
    }
    const trackedPrimaryBytes = "tracked artifact bytes\n"
    const dirtyPrimaryBytes = "dirty artifact bytes\n"
    const vectorPrimaryPath = writeFile(
      expectation.vectorPackDir,
      "unit-pack.jsonl",
      dirtyPrimaryBytes,
    )
    const vectorChecksumPath = writeFile(
      expectation.vectorPackDir,
      "unit-pack.sha256",
      `${sha256(dirtyPrimaryBytes)}  unit-pack.jsonl\n`,
    )
    writeJson(expectation.vectorPackDir, "unit-pack.manifest.json", manifest)
    const snapshotPrimaryPath = writeFile(
      expectation.snapshotDir,
      "unit-snapshot.sqlite.zst",
      dirtyPrimaryBytes,
    )
    const snapshotChecksumPath = writeFile(
      expectation.snapshotDir,
      "unit-snapshot.sha256",
      `${sha256(dirtyPrimaryBytes)}  unit-snapshot.sqlite.zst\n`,
    )
    writeJson(expectation.snapshotDir, "unit-snapshot.manifest.json", manifest)
    const blobs = new Map([
      [repoPath(vectorPrimaryPath), trackedPrimaryBytes],
      [repoPath(vectorChecksumPath), `${sha256(trackedPrimaryBytes)}  unit-pack.jsonl\n`],
      [repoPath(snapshotPrimaryPath), trackedPrimaryBytes],
      [repoPath(snapshotChecksumPath), `${sha256(trackedPrimaryBytes)}  unit-snapshot.sqlite.zst\n`],
    ])
    const dirty = new Set([
      repoPath(vectorPrimaryPath),
      repoPath(vectorChecksumPath),
      repoPath(snapshotPrimaryPath),
      repoPath(snapshotChecksumPath),
    ])

    const result = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: trackedArtifactSpawn({ blobs, dirty }),
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join("\n"), /production vector pack unit-pack\.jsonl working tree must match tracked artifact bytes/u)
    assert.match(result.errors.join("\n"), /production snapshot unit-snapshot\.sqlite\.zst working tree must match tracked artifact bytes/u)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("production verifier reports stale source scope, policy denial, and tombstoned validation failures", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-hardening-"))
  try {
    const sourceHash = artifactSourceScopeHash()
    const currentDocs = [{ path: "tasks/dependency-activation/task.md", hash: sha256("current") }]
    const tombstoneError = new Error("artifact represents redacted documents")
    const expectation = await tempExpectation({
      tempDir,
      modules: {
        activeEmbeddingSpec: { id: "unit-spec" },
        validateArtifacts: async () => {
          throw tombstoneError
        },
      },
    })
    writeFile(
      tempDir,
      path.join("desk", "tasks", "dependency-activation", "task.md"),
      "current",
    )
    writeProductionNotes(expectation.notesPath, {
      artifactSourceScopeHash: sourceHash,
      documentTreeHash: docTree(currentDocs),
    })
    writeProductionPolicy(expectation.pluginRoot, validPublicationPolicy({
      approved_artifact_types: ["vector-pack"],
      approvals: [validApproval("vector-pack")],
    }))
    const manifest = {
      artifact_source_scope_hash: sha256("stale source"),
      document_tree_hash: docTree(currentDocs),
      represented_documents: currentDocs,
    }
    writePrimaryWithSidecars({
      dir: path.join(expectation.vectorPackDir),
      id: "unit-pack",
      primarySuffix: ".jsonl",
      manifest,
    })
    writePrimaryWithSidecars({
      dir: path.join(expectation.snapshotDir),
      id: "unit-snapshot",
      primarySuffix: ".sqlite.zst",
      manifest,
    })

    const result = await generatedArtifacts.verifyProductionSharedArtifacts({
      expectation,
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    })

    assert.equal(result.ok, false)
    assert.match(result.errors.join("\n"), /production artifact publication policy must approve snapshot/u)
    assert.match(result.errors.join("\n"), /production shared artifact validation failed: artifact represents redacted documents/u)
    assert.match(result.errors.join("\n"), /production vector pack unit-pack\.jsonl artifact_source_scope_hash must match current source scope/u)
    assert.match(result.errors.join("\n"), /production snapshot unit-snapshot\.sqlite\.zst artifact_source_scope_hash must match current source scope/u)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
