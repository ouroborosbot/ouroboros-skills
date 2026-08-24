import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises"
import * as path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { zstdDecompressSync } from "node:zlib"

import {
  buildSnapshotFromLocalDb,
  buildVectorPackFromLocalDb,
} from "../../src/artifacts/artifact-scripts.js"
import {
  evaluateArtifactPublication,
} from "../../src/artifacts/policy.js"
import { closeDb, indexDbPath, openDb } from "../../src/db/init.js"
import { discover } from "../../src/indexer/discover.js"
import { rebuildIndex } from "../../src/indexer/index.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"
import { validateVectorPackFile } from "../../src/indexer/vector-packs.js"
import {
  ensureIndex,
  resolveEnsureIndexOptions,
} from "../../src/server-helpers.js"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")
const pluginRoot = path.join(repoRoot, "plugins", "desk")
const fixtureRoot = path.join(mcpRoot, "__tests__", "fixtures", "widened-corpus")
const policySchemaPath = path.join(pluginRoot, "artifacts", "publication-policy.schema.json")
const productionNotesPath = path.join(
  repoRoot,
  "desk",
  "tasks",
  "2026-06-14-1335-doing-desk-dependency-activation",
  "production-artifacts.md",
)
const require = createRequire(import.meta.url)
const generatedArtifacts = require(path.join(repoRoot, "scripts", "test-desk-generated-artifacts.cjs"))

const ALLOWED_PATHS = Object.freeze([
  "nested/visible.md",
  "references/cache-only.md",
  "references/deleted.md",
  "references/frontmatter.md",
  "references/guide.md",
  "references/malformed.md",
  "references/personal-note.md",
  "references/redacted.md",
  "sample-track/_planning/architecture.md",
  "sample-track/sample-task/planning.md",
  "sample-track/track.md",
])
const EXCLUDED_PATHS = Object.freeze([
  ".git/internal.md",
  ".state/local-cache.md",
  "_secrets/ignored.md",
  "credentials/ignored.md",
  "nested/private-notes/ignored.md",
  "node_modules/example/README.md",
  "references/customer-secrets.md",
])
const EXCLUDED_MARKERS = Object.freeze([
  "SYNTHETIC_EXCLUDED_CREDENTIAL_BODY",
  "SYNTHETIC_EXCLUDED_GIT_BODY",
  "SYNTHETIC_EXCLUDED_NESTED_BODY",
  "SYNTHETIC_EXCLUDED_NODE_MODULE_BODY",
  "SYNTHETIC_EXCLUDED_SECRET_BODY",
  "SYNTHETIC_EXCLUDED_SENSITIVE_NAME_BODY",
  "SYNTHETIC_EXCLUDED_STATE_BODY",
])
const WIDENED_SOURCE_SCOPE_PATHS = Object.freeze([
  "plugins/desk/mcp/src/artifacts/tombstones.js",
  "plugins/desk/mcp/src/indexer/chunk.js",
  "plugins/desk/mcp/src/indexer/discover.js",
  "plugins/desk/mcp/src/indexer/document-tree.js",
  "plugins/desk/mcp/src/indexer/exclusions.js",
  "plugins/desk/mcp/src/indexer/index.js",
  "plugins/desk/mcp/src/indexer/refs.js",
  "plugins/desk/mcp/src/indexer/vector-packs.js",
  "plugins/desk/mcp/src/snapshots/manifest.js",
  "plugins/desk/mcp/src/snapshots/restore.js",
  "plugins/desk/mcp/src/artifacts/artifact-scripts.js",
  "plugins/desk/mcp/src/artifacts/policy.js",
  "plugins/desk/mcp/src/server-helpers.js",
  "plugins/desk/mcp/scripts/build-vector-pack.js",
  "plugins/desk/mcp/scripts/build-snapshot.js",
  "plugins/desk/mcp/scripts/verify-snapshot.js",
  "plugins/desk/mcp/scripts/validate-artifacts.js",
  "plugins/desk/mcp/src/db/schema.sql",
  "plugins/desk/mcp/package.json",
  "plugins/desk/mcp/package-lock.json",
])
const PUBLICATION_GUIDANCE_DOCS = Object.freeze([
  "plugins/desk/README.md",
  "plugins/desk/mcp/README.md",
  "plugins/desk/activation/README.md",
])
const PUBLIC_MANIFEST_PATHS = Object.freeze([
  path.join(
    pluginRoot,
    "artifacts",
    "vector-packs",
    ACTIVE_EMBEDDING_SPEC.id,
    "repo-public-bootstrap-2026-06-15.manifest.json",
  ),
  path.join(
    pluginRoot,
    "artifacts",
    "snapshots",
    ACTIVE_EMBEDDING_SPEC.id,
    "repo-public-bootstrap-2026-06-15.manifest.json",
  ),
])

async function scratchRoot(prefix) {
  return mkdtemp(path.join(mcpRoot, `.${prefix}-`))
}

async function writeText(root, relativePath, body) {
  const filePath = path.join(root, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, body, "utf8")
  return filePath
}

async function copyCorpusFixture(targetRoot) {
  await cp(fixtureRoot, targetRoot, { recursive: true })
  await writeText(targetRoot, ".git/internal.md", "# Synthetic git internal\n\nSYNTHETIC_EXCLUDED_GIT_BODY")
  await writeText(
    targetRoot,
    ".state/local-cache.md",
    "# Synthetic local state\n\nSYNTHETIC_EXCLUDED_STATE_BODY",
  )
  await writeText(
    targetRoot,
    "node_modules/example/README.md",
    "# Synthetic dependency doc\n\nSYNTHETIC_EXCLUDED_NODE_MODULE_BODY",
  )
}

async function copyDeskWithoutLocalState(sourceRoot, targetRoot) {
  await cp(sourceRoot, targetRoot, {
    recursive: true,
    filter: (source) => {
      const relativePath = path.relative(sourceRoot, source)
      if (relativePath === "") return true
      const [first] = relativePath.split(path.sep)
      return ![".git", ".state", "node_modules"].includes(first)
    },
  })
}

function embedFetch(prompts = []) {
  return async (_url, request) => {
    prompts.push(JSON.parse(request.body).prompt)
    return {
      ok: true,
      json: async () => ({
        embedding: Array.from(
          { length: ACTIVE_EMBEDDING_SPEC.dimension },
          (_, index) => (index % 31) / 31,
        ),
      }),
    }
  }
}

function publicationPolicy({ approved = false } = {}) {
  const approvedTypes = ["snapshot", "vector-pack"]
  return {
    schema_version: 1,
    default_publication: "deny",
    repo_visibility: "public",
    sensitive_repo: true,
    approved_artifact_types: approvedTypes,
    approval_required: true,
    approvals: approved
      ? approvedTypes.map((artifactType) => ({
          scope: "repo",
          artifact_type: artifactType,
          approved_by: "synthetic-reviewer",
          approved_at: "2026-08-24T00:00:00.000Z",
          reason: "Synthetic widened-corpus fixture reviewed and approved for artifact contract testing.",
        }))
      : [],
    updated_at: "2026-08-24T00:00:00.000Z",
  }
}

async function writePublicationPolicy(targetPluginRoot, policy) {
  await mkdir(path.join(targetPluginRoot, "artifacts"), { recursive: true })
  await cp(
    policySchemaPath,
    path.join(targetPluginRoot, "artifacts", "publication-policy.schema.json"),
  )
  await writeFile(
    path.join(targetPluginRoot, "artifacts", "publication-policy.json"),
    `${JSON.stringify(policy, null, 2)}\n`,
    "utf8",
  )
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

async function writeTombstone(targetPluginRoot, relativePath, body) {
  const ledgerPath = path.join(
    targetPluginRoot,
    "artifacts",
    "tombstones",
    "tombstones.jsonl",
  )
  await mkdir(path.dirname(ledgerPath), { recursive: true })
  await writeFile(
    ledgerPath,
    `${JSON.stringify({
      schema_version: 1,
      document_path: relativePath,
      document_hash: sha256(body),
      reason: "redacted",
      redacted_at: "2026-08-24T00:00:00.000Z",
      effective_from: "2026-08-24T00:00:00.000Z",
      artifact_rotation_id: "synthetic-unit-6a-rotation",
      actor: "synthetic-reviewer",
    })}\n`,
    "utf8",
  )
}

function indexedPaths(deskRoot) {
  const db = openDb(deskRoot)
  try {
    return db.prepare("SELECT path FROM docs ORDER BY path").all().map((row) => row.path)
  } finally {
    closeDb(db)
  }
}

function indexedText(deskRoot) {
  const db = openDb(deskRoot)
  try {
    return db.prepare("SELECT text FROM chunks ORDER BY id").all().map((row) => row.text).join("\n")
  } finally {
    closeDb(db)
  }
}

function artifactPaths(targetPluginRoot, artifactType, artifactId) {
  const artifactDir = path.join(
    targetPluginRoot,
    "artifacts",
    artifactType === "vector-pack" ? "vector-packs" : "snapshots",
    ACTIVE_EMBEDDING_SPEC.id,
  )
  const primarySuffix = artifactType === "vector-pack" ? ".jsonl" : ".sqlite.zst"
  return {
    primary: path.join(artifactDir, `${artifactId}${primarySuffix}`),
    manifest: path.join(artifactDir, `${artifactId}.manifest.json`),
    checksum: path.join(artifactDir, `${artifactId}.sha256`),
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"))
}

function assertManifestIsMetadataOnly(manifest, scratch, expectedPaths) {
  const serialized = JSON.stringify(manifest)
  assert.doesNotMatch(serialized, /"(?:absPath|body|frontmatter|raw)"\s*:/u)
  assert.equal(serialized.includes(scratch), false)
  for (const marker of EXCLUDED_MARKERS) assert.equal(serialized.includes(marker), false)
  for (const excludedPath of EXCLUDED_PATHS) assert.equal(serialized.includes(excludedPath), false)
  assert.deepEqual(
    manifest.represented_documents.map((doc) => doc.path).sort(),
    [...expectedPaths].sort(),
  )
  assert.ok(
    manifest.represented_documents.every((doc) => (
      Object.keys(doc).sort().join(",") === "hash,path" &&
      /^sha256:[a-f0-9]{64}$/u.test(doc.hash)
    )),
  )
  assert.equal(manifest.discovery_grammar_version, 2)
  assert.equal(new Set(manifest.source_paths).size, manifest.source_paths.length)
  for (const sourcePath of WIDENED_SOURCE_SCOPE_PATHS) {
    assert.ok(manifest.source_paths.includes(sourcePath), `source scope must include ${sourcePath}`)
  }
  assert.ok(manifest.source_paths.every((sourcePath) => (
    sourcePath.startsWith("plugins/desk/mcp/") &&
    !sourcePath.includes("\\") &&
    !sourcePath.includes(".state") &&
    !sourcePath.includes("benchmark") &&
    !sourcePath.includes("canary")
  )))
}

async function publicArtifactFiles() {
  const out = []
  for (const root of [
    path.join(pluginRoot, "artifacts", "vector-packs"),
    path.join(pluginRoot, "artifacts", "snapshots"),
  ]) {
    const specs = await readdir(root, { withFileTypes: true })
    for (const spec of specs) {
      if (!spec.isDirectory()) continue
      const files = await readdir(path.join(root, spec.name), { withFileTypes: true })
      for (const file of files) {
        if (file.isFile()) out.push(path.join(root, spec.name, file.name))
      }
    }
  }
  return out
}

test("directory-form and nested exclusions run before discovery, chunking, embedding, and local index writes", async () => {
  const scratch = await scratchRoot("unit-6a-discovery")
  const deskRoot = path.join(scratch, "desk")
  try {
    await copyCorpusFixture(deskRoot)
    const docs = await discover(deskRoot)
    assert.deepEqual(docs.map((doc) => doc.path), ALLOWED_PATHS)
    assert.equal(docs.find((doc) => doc.path === "sample-track/track.md").kind, "track")
    assert.equal(
      docs.find((doc) => doc.path === "sample-track/sample-task/planning.md").kind,
      "planning",
    )
    assert.equal(
      docs.find((doc) => doc.path === "sample-track/_planning/architecture.md").kind,
      "reference",
    )
    const malformed = docs.find((doc) => doc.path === "references/malformed.md")
    assert.equal(malformed.kind, "reference")
    assert.equal(malformed.status, null)
    assert.match(malformed.body, /SYNTHETIC_ALLOWED_MALFORMED_BODY/u)

    const prompts = []
    await rebuildIndex(deskRoot, { embed: { fetch: embedFetch(prompts) } })
    assert.deepEqual(indexedPaths(deskRoot), ALLOWED_PATHS)
    const embeddedText = prompts.join("\n")
    assert.match(embeddedText, /SYNTHETIC_ALLOWED_REFERENCE_BODY/u)
    for (const marker of EXCLUDED_MARKERS) assert.equal(embeddedText.includes(marker), false)
    const chunkText = indexedText(deskRoot)
    for (const marker of EXCLUDED_MARKERS) assert.equal(chunkText.includes(marker), false)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test("widened local index eligibility never bypasses snapshot or vector-pack approval decisions", async () => {
  const scratch = await scratchRoot("unit-6a-policy")
  const deskRoot = path.join(scratch, "desk")
  const deniedPluginRoot = path.join(scratch, "plugin")
  try {
    await copyCorpusFixture(deskRoot)
    await rebuildIndex(deskRoot, { embed: { fetch: embedFetch() } })
    const policy = publicationPolicy()
    await writePublicationPolicy(deniedPluginRoot, policy)
    assert.ok(indexedPaths(deskRoot).includes("references/personal-note.md"))

    for (const artifactType of ["vector-pack", "snapshot"]) {
      assert.deepEqual(
        evaluateArtifactPublication({
          policy,
          artifact_type: artifactType,
          operation: "publish",
        }),
        {
          allowed: false,
          reason: "approval_required",
          message: `${artifactType} publication requires explicit approval`,
        },
      )
    }

    await assert.rejects(
      () => buildVectorPackFromLocalDb({
        deskRoot,
        pluginRoot: deniedPluginRoot,
        mcpRoot,
        packId: "synthetic-denied-pack",
      }),
      (error) => (
        error.code === "artifact_publication_not_approved" &&
        error.reason === "approval_required" &&
        error.artifact_type === "vector-pack"
      ),
    )
    await assert.rejects(
      () => buildSnapshotFromLocalDb({
        deskRoot,
        pluginRoot: deniedPluginRoot,
        mcpRoot,
        snapshotId: "synthetic-denied-snapshot",
      }),
      (error) => (
        error.code === "artifact_publication_not_approved" &&
        error.reason === "approval_required" &&
        error.artifact_type === "snapshot"
      ),
    )
    await assert.rejects(
      () => readdir(path.join(deniedPluginRoot, "artifacts", "vector-packs")),
      (error) => error.code === "ENOENT",
    )
    await assert.rejects(
      () => readdir(path.join(deniedPluginRoot, "artifacts", "snapshots")),
      (error) => error.code === "ENOENT",
    )
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test("tombstones and deletions cannot reappear through packs, snapshots, restored caches, or regenerated manifests", async () => {
  const scratch = await scratchRoot("unit-6a-artifacts")
  const deskRoot = path.join(scratch, "desk")
  const restoredRoot = path.join(scratch, "restored-desk")
  const targetPluginRoot = path.join(scratch, "plugin")
  const embed = { fetch: embedFetch() }
  try {
    await copyCorpusFixture(deskRoot)
    await writePublicationPolicy(targetPluginRoot, publicationPolicy({ approved: true }))
    await rebuildIndex(deskRoot, {
      embed,
      tombstones: { pluginRoot: targetPluginRoot },
    })

    const historicalPackId = "synthetic-before-redaction"
    await buildVectorPackFromLocalDb({
      deskRoot,
      pluginRoot: targetPluginRoot,
      mcpRoot,
      packId: historicalPackId,
    })
    const redactedPath = "references/redacted.md"
    const redactedBody = await readFile(path.join(deskRoot, redactedPath), "utf8")
    await writeTombstone(targetPluginRoot, redactedPath, redactedBody)
    const historicalPack = artifactPaths(targetPluginRoot, "vector-pack", historicalPackId)
    await assert.rejects(
      () => validateVectorPackFile({
        pluginRoot: targetPluginRoot,
        packPath: historicalPack.primary,
        manifestPath: historicalPack.manifest,
        checksumPath: historicalPack.checksum,
      }),
      (error) => (
        error.code === "artifact_represents_redacted_document" &&
        error.artifact_type === "vector-pack" &&
        error.redacted_count === 1
      ),
    )

    await unlink(path.join(deskRoot, "references", "deleted.md"))
    await ensureIndex(deskRoot, {
      embed,
      snapshots: false,
      vectorPacks: false,
      tombstones: { pluginRoot: targetPluginRoot },
    })
    assert.equal(indexedPaths(deskRoot).includes(redactedPath), false)
    assert.equal(indexedPaths(deskRoot).includes("references/deleted.md"), false)

    const cacheSnapshotId = "synthetic-before-cache-delete"
    await buildSnapshotFromLocalDb({
      deskRoot,
      pluginRoot: targetPluginRoot,
      mcpRoot,
      snapshotId: cacheSnapshotId,
    })
    await unlink(path.join(deskRoot, "references", "cache-only.md"))
    await ensureIndex(deskRoot, {
      embed,
      snapshots: false,
      vectorPacks: false,
      tombstones: { pluginRoot: targetPluginRoot },
    })

    await copyDeskWithoutLocalState(deskRoot, restoredRoot)
    const restored = await ensureIndex(restoredRoot, {
      embed,
      snapshots: { pluginRoot: targetPluginRoot },
      vectorPacks: false,
      tombstones: { pluginRoot: targetPluginRoot },
    })
    assert.equal(restored.reason, "stale_snapshot_reconciled")
    assert.equal(restored.snapshot?.snapshot_id, cacheSnapshotId)
    for (const removedPath of [
      "references/cache-only.md",
      "references/deleted.md",
      redactedPath,
    ]) {
      assert.equal(indexedPaths(restoredRoot).includes(removedPath), false)
      assert.equal(indexedText(restoredRoot).includes(removedPath), false)
    }

    const currentPackId = "synthetic-current-pack"
    const currentSnapshotId = "synthetic-current-snapshot"
    await buildVectorPackFromLocalDb({
      deskRoot,
      pluginRoot: targetPluginRoot,
      mcpRoot,
      packId: currentPackId,
    })
    await buildSnapshotFromLocalDb({
      deskRoot,
      pluginRoot: targetPluginRoot,
      mcpRoot,
      snapshotId: currentSnapshotId,
      includedPackIds: [currentPackId],
    })

    const expectedPaths = ALLOWED_PATHS.filter((docPath) => ![
      "references/cache-only.md",
      "references/deleted.md",
      redactedPath,
    ].includes(docPath))
    const currentPack = artifactPaths(targetPluginRoot, "vector-pack", currentPackId)
    const currentSnapshot = artifactPaths(targetPluginRoot, "snapshot", currentSnapshotId)
    const [packManifest, snapshotManifest, packBytes, snapshotBytes] = await Promise.all([
      readJson(currentPack.manifest),
      readJson(currentSnapshot.manifest),
      readFile(currentPack.primary),
      readFile(currentSnapshot.primary),
    ])
    assertManifestIsMetadataOnly(packManifest, scratch, expectedPaths)
    assertManifestIsMetadataOnly(snapshotManifest, scratch, expectedPaths)
    assert.equal(
      packManifest.artifact_source_scope_hash,
      generatedArtifacts.artifactSourceScopeHash(mcpRoot),
    )
    assert.equal(
      snapshotManifest.artifact_source_scope_hash,
      generatedArtifacts.artifactSourceScopeHash(mcpRoot),
    )
    const portableRuntimeScope = resolveEnsureIndexOptions(
      { vectorPacks: { pluginRoot: targetPluginRoot } },
      { deskRoot },
    ).vectorPacks.expectedArtifactSourceScopeHash
    assert.equal(portableRuntimeScope, packManifest.artifact_source_scope_hash)

    const decompressedSnapshot = zstdDecompressSync(snapshotBytes).toString("utf8")
    for (const marker of EXCLUDED_MARKERS) {
      assert.equal(packBytes.includes(marker), false)
      assert.equal(decompressedSnapshot.includes(marker), false)
    }
    for (const excludedPath of EXCLUDED_PATHS) {
      assert.equal(packBytes.includes(excludedPath), false)
      assert.equal(decompressedSnapshot.includes(excludedPath), false)
    }
    for (const removedPath of [
      "references/cache-only.md",
      "references/deleted.md",
      redactedPath,
    ]) {
      assert.equal(packBytes.includes(removedPath), false)
      assert.equal(decompressedSnapshot.includes(removedPath), false)
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test("artifact source-scope hashing invalidates deterministically when restored-cache behavior changes", async () => {
  const scratch = await scratchRoot("unit-6a-source-scope")
  const scratchMcpRoot = path.join(scratch, "plugins", "desk", "mcp")
  const discoverPath = path.join(scratchMcpRoot, "src", "indexer", "discover.js")
  const helpersPath = path.join(scratchMcpRoot, "src", "server-helpers.js")
  try {
    await writeText(scratchMcpRoot, "src/indexer/discover.js", "discover-v1\n")
    await writeText(scratchMcpRoot, "src/server-helpers.js", "restore-v1\n")
    const baseline = generatedArtifacts.artifactSourceScopeHash(scratchMcpRoot)

    await writeFile(discoverPath, "discover-v2\n", "utf8")
    const discoveryChanged = generatedArtifacts.artifactSourceScopeHash(scratchMcpRoot)
    assert.notEqual(discoveryChanged, baseline)
    await writeFile(discoverPath, "discover-v1\n", "utf8")
    assert.equal(generatedArtifacts.artifactSourceScopeHash(scratchMcpRoot), baseline)

    await writeFile(helpersPath, "restore-v2\n", "utf8")
    const restoredCacheChanged = generatedArtifacts.artifactSourceScopeHash(scratchMcpRoot)
    assert.notEqual(
      restoredCacheChanged,
      baseline,
      "source scope must change when server-helpers.js restored-cache behavior changes",
    )
    await writeFile(helpersPath, "restore-v1\n", "utf8")
    assert.equal(generatedArtifacts.artifactSourceScopeHash(scratchMcpRoot), baseline)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

for (const relativeDocPath of PUBLICATION_GUIDANCE_DOCS) {
  test(`${relativeDocPath} discloses widened-corpus review and approval requirements`, async () => {
    const body = (await readFile(path.join(repoRoot, relativeDocPath), "utf8")).toLowerCase()
    assert.ok(
      /\ball allowed markdown\b/u.test(body),
      `${relativeDocPath} must disclose that local discovery covers all allowed Markdown`,
    )
    assert.ok(
      /\bnon-secret personal content\b/u.test(body),
      `${relativeDocPath} must disclose that allowed Markdown may contain non-secret personal content`,
    )
    assert.ok(
      /\blocal index(?:ing| eligibility)?\b[\s\S]{0,180}\b(?:does not|never|not)\b[\s\S]{0,100}\b(?:publish|share)/u.test(body),
      `${relativeDocPath} must separate local index eligibility from publishability`,
    )
    assert.ok(
      /\breview(?:ed)?\b[\s\S]{0,180}\bapprov(?:al|ed)\b[\s\S]{0,180}\b(?:share|publish|commit)/u.test(body),
      `${relativeDocPath} must require review and approval before sharing artifacts`,
    )
  })
}

test("committed public artifacts identify widened production scope without private corpus data", async () => {
  const manifests = await Promise.all(PUBLIC_MANIFEST_PATHS.map(readJson))
  const sourceScopeHash = generatedArtifacts.artifactSourceScopeHash(mcpRoot)
  for (const manifest of manifests) {
    assert.equal(manifest.artifact_source_scope_hash, sourceScopeHash)
    assert.equal(manifest.discovery_grammar_version, 2)
    for (const sourcePath of WIDENED_SOURCE_SCOPE_PATHS) {
      assert.ok(manifest.source_paths.includes(sourcePath), `source scope must include ${sourcePath}`)
    }
    assert.deepEqual(
      manifest.represented_documents.map((doc) => doc.path),
      ["tasks/dependency-activation/task.md"],
    )
    const serialized = JSON.stringify(manifest)
    assert.doesNotMatch(serialized, /(?:^|[\\/])\.state(?:[\\/]|$)|queries-blind|release-partition|private-canary/u)
    assert.doesNotMatch(serialized, /"(?:absPath|body|frontmatter|raw)"\s*:/u)
  }

  const notes = (await readFile(productionNotesPath, "utf8")).toLowerCase()
  assert.ok(
    /repo-local public desk documents only/u.test(notes),
    "production artifact notes must retain the approved public-document boundary",
  )
  assert.ok(
    /synthetic|de-identified/u.test(notes),
    "production artifact notes must identify committed public inputs as synthetic or de-identified",
  )
  assert.ok(
    /all allowed markdown/u.test(notes),
    "production artifact notes must disclose the wider local discovery corpus",
  )

  const tracked = spawnSync("git", ["ls-files"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  assert.equal(tracked.status, 0, tracked.stderr)
  assert.doesNotMatch(
    tracked.stdout,
    /(?:^|\/)\.state(?:\/|$)|queries-blind|release-partition|private-canary/u,
  )
  for (const artifactPath of await publicArtifactFiles()) {
    const bytes = await readFile(artifactPath)
    assert.equal(bytes.includes(".state/benchmarks"), false)
    assert.equal(bytes.includes("queries-blind"), false)
    assert.equal(bytes.includes("release-partition"), false)
    assert.equal(bytes.includes("private-canary"), false)
  }
})
