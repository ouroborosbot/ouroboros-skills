// Unit 18a: red contract for explicit artifact publication policy and approval.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import manifestContracts from "../../src/artifacts/manifest-contracts.cjs"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"
import { ensureIndex } from "../../src/server-helpers.js"

const mcpRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))
const { ARTIFACT_SOURCE_PATHS } = manifestContracts
const repoRoot = path.resolve(mcpRoot, "..", "..", "..")
const deskPluginRoot = path.join(repoRoot, "plugins", "desk")
const policyPath = path.join(deskPluginRoot, "artifacts", "publication-policy.json")
const schemaPath = path.join(deskPluginRoot, "artifacts", "publication-policy.schema.json")
const REQUIRED_POLICY_FIELDS = [
  "schema_version",
  "default_publication",
  "repo_visibility",
  "sensitive_repo",
  "approved_artifact_types",
  "approval_required",
  "approvals",
  "updated_at",
]

async function loadPolicyModule() {
  return import(pathToFileURL(path.join(mcpRoot, "src", "artifacts", "policy.js")))
}

async function loadVectorPackModule() {
  return import(pathToFileURL(path.join(mcpRoot, "src", "indexer", "vector-packs.js")))
}

async function loadSnapshotManifestModule() {
  return import(pathToFileURL(path.join(mcpRoot, "src", "snapshots", "manifest.js")))
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"))
}

async function tmpRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function writePolicyFixture(pluginRoot, policy) {
  const artifactsRoot = path.join(pluginRoot, "artifacts")
  await fs.mkdir(artifactsRoot, { recursive: true })
  await fs.writeFile(
    path.join(artifactsRoot, "publication-policy.json"),
    `${JSON.stringify(policy, null, 2)}\n`,
    "utf8",
  )
  await fs.copyFile(schemaPath, path.join(artifactsRoot, "publication-policy.schema.json"))
}

async function writeSchemaFixture(pluginRoot) {
  const artifactsRoot = path.join(pluginRoot, "artifacts")
  await fs.mkdir(artifactsRoot, { recursive: true })
  await fs.copyFile(schemaPath, path.join(artifactsRoot, "publication-policy.schema.json"))
}

async function safeDeskRoot() {
  return tmpRoot("desk-publication-policy-desk-")
}

function validPolicy(overrides = {}) {
  return {
    schema_version: 1,
    default_publication: "deny",
    repo_visibility: "private",
    sensitive_repo: false,
    approved_artifact_types: [],
    approval_required: true,
    approvals: [],
    updated_at: "2026-06-15T00:00:00.000Z",
    ...overrides,
  }
}

function repoApproval(artifactType, overrides = {}) {
  return {
    scope: "repo",
    artifact_type: artifactType,
    approved_by: "unit-test-reviewer",
    approved_at: "2026-06-15T00:00:00.000Z",
    reason: "explicit publication approval for test fixture",
    ...overrides,
  }
}

function safeSourceDocs() {
  return [{
    path: "visible-track/task-1/task.md",
    hash: sha256("public body"),
    body: "public body",
  }]
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function documentTreeHash(documents) {
  const hash = createHash("sha256")
  for (const document of documents) {
    hash.update(`${document.path}\0sha256:${document.hash}\0`)
  }
  return `sha256:${hash.digest("hex")}`
}

function artifactPayload(artifactType, artifactId) {
  const sourceDocs = safeSourceDocs()
  const primaryBytes = artifactType === "vector-pack"
    ? Buffer.alloc(0)
    : Buffer.from("sqlite bytes", "utf8")
  const artifactHash = sha256(primaryBytes)
  const common = {
    schema_version: 1,
    embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id,
    dimension: ACTIVE_EMBEDDING_SPEC.dimension,
    artifact_source_scope_hash: `sha256:${"a".repeat(64)}`,
    document_tree_hash: documentTreeHash(sourceDocs),
    discovery_grammar_version: 2,
    represented_documents: sourceDocs.map(({ path: documentPath, hash }) => ({
      path: documentPath,
      hash: `sha256:${hash}`,
    })),
    created_at: "2026-06-15T00:00:00.000Z",
    source_paths: ARTIFACT_SOURCE_PATHS,
  }
  const manifest = artifactType === "vector-pack"
    ? {
        ...common,
        pack_id: artifactId,
        encoding: "float32-json",
        row_count: 0,
        rows_sha256: artifactHash,
        provenance: {
          builder: "plugins/desk/mcp/scripts/build-vector-pack.js",
          source: "local-db",
          commit: "0123456789abcdef0123456789abcdef01234567",
        },
      }
    : {
        ...common,
        snapshot_id: artifactId,
        chunker_id: ACTIVE_EMBEDDING_SPEC.chunker_id,
        normalization_id: ACTIVE_EMBEDDING_SPEC.normalization_id,
        db_schema: { id: "desk-index-sqlite-v1", version: 1 },
        sqlite_vec: { package: "sqlite-vec", version: "0.1.6", table: "vec0" },
        runtime: { platform: "portable", arch: "portable", node_abi: "portable" },
        included_pack_ids: [],
        artifact: {
          file: `${artifactId}.sqlite.zst`,
          format: "sqlite-zstd",
          sha256: `sha256:${artifactHash}`,
          compressed: true,
        },
        provenance: {
          builder: "plugins/desk/mcp/scripts/build-snapshot.js",
          source: "local-db",
          commit: "0123456789abcdef0123456789abcdef01234567",
        },
      }
  return {
    primaryBytes,
    manifestBytes: `${JSON.stringify(manifest, null, 2)}\n`,
    checksumBytes: `${
      artifactType === "vector-pack"
        ? artifactHash
        : `sha256:${artifactHash}`
    }  ${
      artifactType === "vector-pack"
        ? `${artifactId}.jsonl`
        : `${artifactId}.sqlite.zst`
    }\n`,
    sourceDocs,
  }
}

async function fileHashes(root) {
  const hashes = {}
  async function walk(current) {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch (error) {
      if (error.code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (entry.isFile()) {
        const relativePath = path.relative(root, abs).split(path.sep).join("/")
        hashes[relativePath] = sha256(await fs.readFile(abs))
      }
    }
  }
  await walk(root)
  return Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)))
}

async function seedCommittedArtifactFixture(artifactsRoot) {
  const packDir = path.join(artifactsRoot, "vector-packs", ACTIVE_EMBEDDING_SPEC.id)
  await fs.mkdir(packDir, { recursive: true })
  const packId = "committed-empty-pack"
  const packBody = ""
  const packSha = sha256(packBody)
  await fs.writeFile(path.join(packDir, `${packId}.jsonl`), packBody, "utf8")
  await fs.writeFile(
    path.join(packDir, `${packId}.manifest.json`),
    `${JSON.stringify({
      schema_version: 1,
      pack_id: packId,
      embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id,
      dimension: ACTIVE_EMBEDDING_SPEC.dimension,
      encoding: "float32-json",
      row_count: 0,
      rows_sha256: packSha,
      artifact_source_scope_hash: `sha256:${"a".repeat(64)}`,
      document_tree_hash: `sha256:${sha256("")}`,
      discovery_grammar_version: 2,
      represented_documents: [],
      created_at: "2026-06-15T00:00:00.000Z",
      provenance: {
        builder: "plugins/desk/mcp/scripts/build-vector-pack.js",
        source: "local-db",
        commit: "0123456789abcdef0123456789abcdef01234567",
      },
      source_paths: ARTIFACT_SOURCE_PATHS,
    }, null, 2)}\n`,
    "utf8",
  )
  await fs.writeFile(path.join(packDir, `${packId}.sha256`), `${packSha}  ${packId}.jsonl\n`, "utf8")

  const snapshotDir = path.join(artifactsRoot, "snapshots", ACTIVE_EMBEDDING_SPEC.id)
  await fs.mkdir(snapshotDir, { recursive: true })
  const snapshotId = "committed-incompatible-snapshot"
  const snapshotBytes = Buffer.from("committed snapshot bytes", "utf8")
  const snapshotSha = `sha256:${sha256(snapshotBytes)}`
  await fs.writeFile(path.join(snapshotDir, `${snapshotId}.sqlite.zst`), snapshotBytes)
  await fs.writeFile(
    path.join(snapshotDir, `${snapshotId}.manifest.json`),
    `${JSON.stringify({
      schema_version: 1,
      snapshot_id: snapshotId,
      embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id,
      dimension: ACTIVE_EMBEDDING_SPEC.dimension,
      chunker_id: ACTIVE_EMBEDDING_SPEC.chunker_id,
      normalization_id: ACTIVE_EMBEDDING_SPEC.normalization_id,
      db_schema: { id: "intentionally-incompatible", version: 1 },
      sqlite_vec: { package: "sqlite-vec", version: "0.1.6", table: "vec0" },
      runtime: {
        platform: process.platform,
        arch: process.arch,
        node_abi: `node-${process.versions.modules}`,
      },
      artifact_source_scope_hash: `sha256:${"a".repeat(64)}`,
      document_tree_hash: `sha256:${"b".repeat(64)}`,
      discovery_grammar_version: 2,
      represented_documents: [],
      included_pack_ids: [packId],
      created_at: "2026-06-15T00:00:00.000Z",
      artifact: {
        file: `${snapshotId}.sqlite.zst`,
        format: "sqlite-zstd",
        sha256: snapshotSha,
        compressed: true,
      },
      provenance: {
        builder: "plugins/desk/mcp/scripts/build-snapshot.js",
        source: "local-db",
        commit: "0123456789abcdef0123456789abcdef01234567",
      },
      source_paths: ARTIFACT_SOURCE_PATHS,
    }, null, 2)}\n`,
    "utf8",
  )
  await fs.writeFile(
    path.join(snapshotDir, `${snapshotId}.sha256`),
    `${snapshotSha}  ${snapshotId}.sqlite.zst\n`,
    "utf8",
  )
}

test("committed publication policy and schema declare conservative privacy defaults", async () => {
  const { loadPublicationPolicy } = await loadPolicyModule()

  const [policy, schema, loaded] = await Promise.all([
    readJson(policyPath),
    readJson(schemaPath),
    loadPublicationPolicy({ pluginRoot: deskPluginRoot }),
  ])

  for (const field of REQUIRED_POLICY_FIELDS) {
    assert.ok(Object.hasOwn(policy, field), `publication policy missing ${field}`)
  }
  assert.equal(policy.schema_version, 1)
  assert.equal(policy.default_publication, "deny")
  assert.equal(policy.repo_visibility, "public")
  assert.equal(policy.sensitive_repo, true)
  assert.deepEqual([...policy.approved_artifact_types].sort(), ["snapshot", "vector-pack"])
  assert.equal(policy.approval_required, true)
  assert.equal(policy.approvals.length, 2)
  for (const artifactType of ["snapshot", "vector-pack"]) {
    const approval = policy.approvals.find((entry) => entry.artifact_type === artifactType)
    assert.ok(approval, `publication policy missing ${artifactType} approval`)
    assert.equal(approval.scope, "repo")
    assert.match(approval.approved_by, /\S/u)
    assert.match(approval.approved_at, /^\d{4}-\d{2}-\d{2}T/u)
    assert.match(approval.reason, /repo-local public Desk documents/u)
  }
  assert.match(policy.updated_at, /^\d{4}-\d{2}-\d{2}T/u)
  assert.equal(schema.properties.schema_version.const, 1)
  assert.equal(loaded.valid, true)
  assert.deepEqual(loaded.diagnostics, [])
})

test("loadPublicationPolicy validates policy JSON against the committed schema", async () => {
  const {
    loadPublicationPolicy,
    validatePublicationPolicy,
  } = await loadPolicyModule()
  const pluginRoot = await tmpRoot("desk-publication-policy-invalid-")
  const schema = await readJson(schemaPath)
  const policy = validPolicy({
    approved_artifact_types: ["vector-pack", "vector-pack", "runtime-deps"],
    approvals: [
      { artifact_type: "vector-pack" },
      {
        scope: "team",
        artifact_type: "runtime-deps",
        approved_by: "",
        approved_at: "not-a-date",
        reason: "",
        extra: true,
      },
      null,
      [],
    ],
    extra: true,
    sensitive_repo: "yes",
  })
  delete policy.default_publication
  await writePolicyFixture(pluginRoot, policy)

  const loaded = await loadPublicationPolicy({ pluginRoot })

  assert.equal(loaded.valid, false)
  assert.ok(loaded.diagnostics.includes("publication policy missing default_publication"))
  assert.ok(loaded.diagnostics.includes("publication policy sensitive_repo must be boolean"))
  assert.ok(loaded.diagnostics.includes("publication policy has unsupported field extra"))
  assert.ok(loaded.diagnostics.includes("publication policy approved_artifact_types duplicates vector-pack"))
  assert.ok(loaded.diagnostics.includes("publication policy approved_artifact_types includes unsupported runtime-deps"))
  assert.ok(loaded.diagnostics.includes("publication policy approvals[0] missing scope"))
  assert.ok(loaded.diagnostics.includes("publication policy approvals[0] missing approved_by"))
  assert.ok(loaded.diagnostics.includes("publication policy approvals[0] missing approved_at"))
  assert.ok(loaded.diagnostics.includes("publication policy approvals[0] missing reason"))
  assert.ok(loaded.diagnostics.includes("publication policy approvals[1].scope is unsupported"))
  assert.ok(loaded.diagnostics.includes("publication policy approvals[1].artifact_type is unsupported"))
  assert.ok(loaded.diagnostics.includes("publication policy approvals[1].approved_by must be non-empty text"))
  assert.ok(loaded.diagnostics.includes("publication policy approvals[1].approved_at must be a date-time string"))
  assert.ok(loaded.diagnostics.includes("publication policy approvals[1].reason must be non-empty text"))
  assert.ok(loaded.diagnostics.includes("publication policy approvals[1] has unsupported field extra"))
  assert.ok(loaded.diagnostics.includes("publication policy approvals[2] must be an object"))
  assert.ok(loaded.diagnostics.includes("publication policy approvals[3] must be an object"))

  await writePolicyFixture(pluginRoot, validPolicy({
    approved_artifact_types: "vector-pack",
  }))
  const invalidApprovedTypes = await loadPublicationPolicy({ pluginRoot })
  assert.equal(invalidApprovedTypes.valid, false)
  assert.ok(
    invalidApprovedTypes.diagnostics.includes(
      "publication policy approved_artifact_types must be an array",
    ),
  )

  await writePolicyFixture(pluginRoot, validPolicy({
    updated_at: 42,
  }))
  const invalidDateType = await loadPublicationPolicy({ pluginRoot })
  assert.equal(invalidDateType.valid, false)
  assert.ok(
    invalidDateType.diagnostics.includes(
      "publication policy updated_at must be a date-time string",
    ),
  )
  assert.ok(
    validatePublicationPolicy({
      policy: validPolicy({ updated_at: "" }),
      schema,
    }).includes("publication policy updated_at must be a date-time string"),
  )
  assert.ok(
    validatePublicationPolicy({
      policy: validPolicy({ updated_at: "2026-99-99T00:00:00Z" }),
      schema,
    }).includes("publication policy updated_at must be a date-time string"),
  )

  await writePolicyFixture(pluginRoot, validPolicy({
    approvals: [
      repoApproval("vector-pack", {
        approved_at: "2026-06-15T00:00:00Z",
      }),
    ],
    updated_at: "2026-06-15T00:00:00Z",
  }))
  const validNoMillisDateTimes = await loadPublicationPolicy({ pluginRoot })
  assert.equal(validNoMillisDateTimes.valid, true)

  await writePolicyFixture(pluginRoot, validPolicy({
    updated_at: "2026-99-99Tnot-a-real-date",
    approvals: [
      repoApproval("vector-pack", {
        approved_at: "2026-99-99Tnot-a-real-date",
      }),
    ],
  }))
  const invalidDateTimes = await loadPublicationPolicy({ pluginRoot })
  assert.equal(invalidDateTimes.valid, false)
  assert.ok(
    invalidDateTimes.diagnostics.includes(
      "publication policy updated_at must be a date-time string",
    ),
  )
  assert.ok(
    invalidDateTimes.diagnostics.includes(
      "publication policy approvals[0].approved_at must be a date-time string",
    ),
  )
})

test("publication policy loading fails closed for missing and malformed policy files", async () => {
  const { loadPublicationPolicy } = await loadPolicyModule()
  const { writeVectorPackArtifact } = await loadVectorPackModule()

  const missingPolicyRoot = await tmpRoot("desk-publication-policy-missing-")
  await writeSchemaFixture(missingPolicyRoot)
  const missingPolicyBefore = await fileHashes(path.join(missingPolicyRoot, "artifacts"))
  const missingPolicy = await loadPublicationPolicy({ pluginRoot: missingPolicyRoot })
  assert.equal(missingPolicy.valid, false)
  assert.ok(missingPolicy.diagnostics.includes("publication policy file is missing"))
  await assert.rejects(
    async () => writeVectorPackArtifact({
      pluginRoot: missingPolicyRoot,
      packId: "missing-policy-pack",
      packBytes: "",
      manifestBytes: "{}\n",
      checksumBytes: "sha256:missing  missing-policy-pack.jsonl\n",
      deskRoot: await safeDeskRoot(),
      sourceDocs: safeSourceDocs(),
    }),
    (error) => {
      assert.equal(error.code, "artifact_publication_policy_invalid")
      assert.ok(error.diagnostics.includes("publication policy file is missing"))
      return true
    },
  )
  assert.deepEqual(await fileHashes(path.join(missingPolicyRoot, "artifacts")), missingPolicyBefore)

  const malformedPolicyRoot = await tmpRoot("desk-publication-policy-malformed-")
  await writeSchemaFixture(malformedPolicyRoot)
  await fs.writeFile(
    path.join(malformedPolicyRoot, "artifacts", "publication-policy.json"),
    "{not-json",
    "utf8",
  )
  const malformedPolicy = await loadPublicationPolicy({ pluginRoot: malformedPolicyRoot })
  assert.equal(malformedPolicy.valid, false)
  assert.ok(malformedPolicy.diagnostics.includes("publication policy JSON is malformed"))

  const nonObjectPolicyRoot = await tmpRoot("desk-publication-policy-shape-")
  await writeSchemaFixture(nonObjectPolicyRoot)
  await fs.writeFile(
    path.join(nonObjectPolicyRoot, "artifacts", "publication-policy.json"),
    "[]\n",
    "utf8",
  )
  const nonObjectPolicy = await loadPublicationPolicy({ pluginRoot: nonObjectPolicyRoot })
  assert.equal(nonObjectPolicy.valid, false)
  assert.ok(nonObjectPolicy.diagnostics.includes("publication policy must be an object"))

  const unreadablePolicyRoot = await tmpRoot("desk-publication-policy-unreadable-")
  await writeSchemaFixture(unreadablePolicyRoot)
  await fs.mkdir(path.join(unreadablePolicyRoot, "artifacts", "publication-policy.json"))
  const unreadablePolicy = await loadPublicationPolicy({ pluginRoot: unreadablePolicyRoot })
  assert.equal(unreadablePolicy.valid, false)
  assert.ok(unreadablePolicy.diagnostics.includes("publication policy file could not be read"))
})

test("publication policy schema-version drift fails closed before artifact writes", async () => {
  const { loadPublicationPolicy } = await loadPolicyModule()
  const { writeVectorPackArtifact } = await loadVectorPackModule()
  const pluginRoot = await tmpRoot("desk-publication-policy-drift-")
  await writePolicyFixture(pluginRoot, validPolicy({
    schema_version: 2,
    default_publication: "allow",
    approved_artifact_types: ["vector-pack"],
    approval_required: false,
  }))
  const before = await fileHashes(path.join(pluginRoot, "artifacts"))

  const loaded = await loadPublicationPolicy({ pluginRoot })
  assert.equal(loaded.valid, false)
  assert.ok(loaded.diagnostics.includes("publication policy schema_version is unsupported"))
  await assert.rejects(
    async () => writeVectorPackArtifact({
      pluginRoot,
      packId: "schema-drift-pack",
      packBytes: "",
      manifestBytes: "{}\n",
      checksumBytes: "sha256:drift  schema-drift-pack.jsonl\n",
      deskRoot: await safeDeskRoot(),
      sourceDocs: safeSourceDocs(),
    }),
    (error) => {
      assert.equal(error.code, "artifact_publication_policy_invalid")
      assert.ok(error.diagnostics.includes("publication policy schema_version is unsupported"))
      return true
    },
  )
  assert.deepEqual(await fileHashes(path.join(pluginRoot, "artifacts")), before)
})

test("publication policy schema requires approval and repository-sensitivity fields", async () => {
  const schema = await readJson(schemaPath)

  assert.equal(schema.type, "object")
  assert.deepEqual([...schema.required].sort(), [...REQUIRED_POLICY_FIELDS].sort())
  assert.deepEqual(schema.properties.default_publication.enum.sort(), ["allow", "deny"])
  assert.deepEqual(
    schema.properties.repo_visibility.enum.sort(),
    ["internal", "private", "public", "unknown"],
  )
  assert.equal(schema.properties.sensitive_repo.type, "boolean")
  assert.equal(schema.properties.approval_required.type, "boolean")
  assert.deepEqual(
    schema.properties.approved_artifact_types.items.enum.sort(),
    ["snapshot", "vector-pack"],
  )
  assert.deepEqual(
    schema.properties.approvals.items.required.sort(),
    ["approved_at", "approved_by", "artifact_type", "reason", "scope"],
  )
  assert.deepEqual(schema.properties.approvals.items.properties.scope.enum.sort(), ["org", "repo"])
})

test("publication policy denies public and sensitive repo artifact publication without approval", async () => {
  const { evaluateArtifactPublication } = await loadPolicyModule()

  for (const policy of [
    validPolicy({
      repo_visibility: "public",
      sensitive_repo: false,
      approved_artifact_types: ["vector-pack"],
    }),
    validPolicy({
      repo_visibility: "private",
      sensitive_repo: true,
      approved_artifact_types: ["snapshot"],
    }),
  ]) {
    const decision = evaluateArtifactPublication({
      policy,
      artifact_type: policy.approved_artifact_types[0],
      operation: "write",
    })
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, "approval_required")
    assert.match(decision.message, /explicit approval/u)
  }
})

test("publication policy default allow is limited to private or internal nonsensitive repos", async () => {
  const { evaluateArtifactPublication } = await loadPolicyModule()
  const { writeVectorPackArtifact } = await loadVectorPackModule()

  for (const repoVisibility of ["private", "internal"]) {
    const policy = validPolicy({
      default_publication: "allow",
      repo_visibility: repoVisibility,
      sensitive_repo: false,
      approved_artifact_types: ["vector-pack"],
      approval_required: false,
    })
    assert.deepEqual(
      evaluateArtifactPublication({ policy, artifact_type: "vector-pack", operation: "write" }),
      {
        allowed: true,
        reason: "default_allowed",
      },
    )
  }

  const pluginRoot = await tmpRoot("desk-publication-policy-default-allow-")
  await writePolicyFixture(pluginRoot, validPolicy({
    default_publication: "allow",
    repo_visibility: "private",
    sensitive_repo: false,
    approved_artifact_types: ["vector-pack"],
    approval_required: false,
  }))
  const payload = artifactPayload("vector-pack", "default-allowed-pack")
  const paths = await writeVectorPackArtifact({
    pluginRoot,
    packId: "default-allowed-pack",
    packBytes: payload.primaryBytes,
    manifestBytes: payload.manifestBytes,
    checksumBytes: payload.checksumBytes,
    deskRoot: await safeDeskRoot(),
    sourceDocs: payload.sourceDocs,
  })
  assert.equal(await fs.readFile(paths.packPath, "utf8"), "")
})

test("publication policy explicit deny and uncertain repository state fail closed", async () => {
  const { evaluateArtifactPublication } = await loadPolicyModule()

  const defaultDenied = evaluateArtifactPublication({
    policy: validPolicy({
      default_publication: "deny",
      repo_visibility: "private",
      sensitive_repo: false,
      approved_artifact_types: ["vector-pack"],
      approval_required: false,
    }),
    artifact_type: "vector-pack",
    operation: "write",
  })
  assert.equal(defaultDenied.allowed, false)
  assert.equal(defaultDenied.reason, "default_denied")
  assert.match(defaultDenied.message, /denies/u)

  for (const policy of [
    validPolicy({
      default_publication: "allow",
      repo_visibility: "unknown",
      sensitive_repo: false,
      approved_artifact_types: ["vector-pack"],
      approval_required: false,
    }),
    validPolicy({
      default_publication: "allow",
      repo_visibility: "public",
      sensitive_repo: false,
      approved_artifact_types: ["vector-pack"],
      approval_required: false,
    }),
    validPolicy({
      default_publication: "allow",
      repo_visibility: "private",
      sensitive_repo: true,
      approved_artifact_types: ["vector-pack"],
      approval_required: false,
    }),
  ]) {
    const decision = evaluateArtifactPublication({
      policy,
      artifact_type: "vector-pack",
      operation: "write",
    })
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, "approval_required")
    assert.match(decision.message, /explicit approval/u)
  }
})

test("publication policy accepts explicit repo and organization approvals for allowed artifact types", async () => {
  const { evaluateArtifactPublication } = await loadPolicyModule()
  const { writeVectorPackArtifact } = await loadVectorPackModule()
  const { writeSnapshotArtifact } = await loadSnapshotManifestModule()
  const pluginRoot = await tmpRoot("desk-publication-policy-approved-")
  const policy = validPolicy({
    repo_visibility: "public",
    sensitive_repo: true,
    approved_artifact_types: ["vector-pack", "snapshot"],
    approvals: [
      repoApproval("vector-pack"),
      repoApproval("snapshot", {
        scope: "org",
        approved_by: "security-review",
        reason: "organization artifact publication exception",
      }),
    ],
  })
  await writePolicyFixture(pluginRoot, policy)

  assert.deepEqual(
    evaluateArtifactPublication({ policy, artifact_type: "vector-pack", operation: "write" }),
    {
      allowed: true,
      reason: "approved",
      approval_scope: "repo",
      approval_actor: "unit-test-reviewer",
    },
  )
  assert.deepEqual(
    evaluateArtifactPublication({ policy, artifact_type: "snapshot", operation: "write" }),
    {
      allowed: true,
      reason: "approved",
      approval_scope: "org",
      approval_actor: "security-review",
    },
  )
  assert.equal(
    evaluateArtifactPublication({ policy, artifact_type: "runtime-deps", operation: "write" }).reason,
    "artifact_type_not_approved",
  )

  const vectorPayload = artifactPayload("vector-pack", "approved-pack")
  const vectorPaths = await writeVectorPackArtifact({
    pluginRoot,
    packId: "approved-pack",
    packBytes: vectorPayload.primaryBytes,
    manifestBytes: vectorPayload.manifestBytes,
    checksumBytes: vectorPayload.checksumBytes,
    deskRoot: await safeDeskRoot(),
    sourceDocs: vectorPayload.sourceDocs,
  })
  assert.equal(await fs.readFile(vectorPaths.packPath, "utf8"), "")

  const snapshotPayload = artifactPayload("snapshot", "approved-snapshot")
  const snapshotPaths = await writeSnapshotArtifact({
    pluginRoot,
    snapshotId: "approved-snapshot",
    snapshotBytes: snapshotPayload.primaryBytes,
    manifestBytes: snapshotPayload.manifestBytes,
    checksumBytes: snapshotPayload.checksumBytes,
    deskRoot: await safeDeskRoot(),
    policy,
    sourceDocs: snapshotPayload.sourceDocs,
  })
  assert.equal(await fs.readFile(snapshotPaths.snapshotPath, "utf8"), "sqlite bytes")
})

test("organization policy approvals override repo-scoped approvals for the same artifact type", async () => {
  const { evaluateArtifactPublication } = await loadPolicyModule()
  const policy = validPolicy({
    repo_visibility: "public",
    sensitive_repo: true,
    approved_artifact_types: ["snapshot"],
    approvals: [
      repoApproval("snapshot", {
        scope: "repo",
        approved_by: "repo-review",
        reason: "repo scoped approval",
      }),
      repoApproval("snapshot", {
        scope: "org",
        approved_by: "org-security-review",
        reason: "organization override approval",
      }),
    ],
  })

  assert.deepEqual(
    evaluateArtifactPublication({ policy, artifact_type: "snapshot", operation: "write" }),
    {
      allowed: true,
      reason: "approved",
      approval_scope: "org",
      approval_actor: "org-security-review",
    },
  )
})

test("artifact write guard blocks vector-pack and snapshot writes without approval", async () => {
  const { writeVectorPackArtifact } = await loadVectorPackModule()
  const { writeSnapshotArtifact } = await loadSnapshotManifestModule()
  const pluginRoot = await tmpRoot("desk-publication-policy-blocked-")
  const policy = validPolicy({
    repo_visibility: "public",
    sensitive_repo: true,
    approved_artifact_types: ["vector-pack", "snapshot"],
  })
  await writePolicyFixture(pluginRoot, policy)
  const before = await fileHashes(path.join(pluginRoot, "artifacts"))

  for (const [artifactType, relativePath, write] of [
    [
      "vector-pack",
      `plugins/desk/artifacts/vector-packs/${ACTIVE_EMBEDDING_SPEC.id}/blocked-pack.jsonl`,
      async () => writeVectorPackArtifact({
        pluginRoot,
        packId: "blocked-pack",
        packBytes: "",
        manifestBytes: "{}\n",
        checksumBytes: "sha256:blocked  blocked-pack.jsonl\n",
        deskRoot: await safeDeskRoot(),
        policy,
        sourceDocs: safeSourceDocs(),
      }),
    ],
    [
      "snapshot",
      `plugins/desk/artifacts/snapshots/${ACTIVE_EMBEDDING_SPEC.id}/blocked-snapshot.sqlite.zst`,
      async () => writeSnapshotArtifact({
        pluginRoot,
        snapshotId: "blocked-snapshot",
        snapshotBytes: "sqlite bytes",
        manifestBytes: "{}\n",
        checksumBytes: "sha256:blocked  blocked-snapshot.sqlite.zst\n",
        deskRoot: await safeDeskRoot(),
        policy,
        sourceDocs: safeSourceDocs(),
      }),
    ],
  ]) {
    await assert.rejects(
      write,
      (error) => {
        assert.equal(error.code, "artifact_publication_not_approved")
        assert.equal(error.artifact_type, artifactType)
        assert.equal(error.relative_path, relativePath)
        assert.doesNotMatch(error.message, /secret|chunk text|document body/iu)
        return true
      },
    )
  }
  assert.deepEqual(await fileHashes(path.join(pluginRoot, "artifacts")), before)
})

test("artifact write paths fail closed when the publication policy is invalid", async () => {
  const { writeVectorPackArtifact } = await loadVectorPackModule()
  const pluginRoot = await tmpRoot("desk-publication-policy-invalid-write-")
  const policy = validPolicy()
  delete policy.approvals
  await writePolicyFixture(pluginRoot, policy)

  await assert.rejects(
    async () => writeVectorPackArtifact({
      pluginRoot,
      packId: "invalid-policy-pack",
      packBytes: "",
      manifestBytes: "{}\n",
      checksumBytes: "sha256:invalid  invalid-policy-pack.jsonl\n",
      deskRoot: await safeDeskRoot(),
      sourceDocs: safeSourceDocs(),
    }),
    (error) => {
      assert.equal(error.code, "artifact_publication_policy_invalid")
      assert.ok(error.diagnostics.includes("publication policy missing approvals"))
      return true
    },
  )

  await assert.rejects(
    async () => writeVectorPackArtifact({
      pluginRoot,
      packId: "invalid-supplied-policy-pack",
      packBytes: "",
      manifestBytes: "{}\n",
      checksumBytes: "sha256:invalid  invalid-supplied-policy-pack.jsonl\n",
      deskRoot: await safeDeskRoot(),
      sourceDocs: safeSourceDocs(),
      policy: validPolicy({
        approved_artifact_types: ["vector-pack"],
        approvals: [{ artifact_type: "vector-pack" }],
      }),
    }),
    (error) => {
      assert.equal(error.code, "artifact_publication_policy_invalid")
      assert.ok(error.diagnostics.includes("publication policy approvals[0] missing scope"))
      assert.ok(error.diagnostics.includes("publication policy approvals[0] missing approved_by"))
      assert.ok(error.diagnostics.includes("publication policy approvals[0] missing approved_at"))
      assert.ok(error.diagnostics.includes("publication policy approvals[0] missing reason"))
      return true
    },
  )

  await assert.rejects(
    async () => writeVectorPackArtifact({
      pluginRoot,
      packId: "invalid-date-policy-pack",
      packBytes: "",
      manifestBytes: "{}\n",
      checksumBytes: "sha256:invalid  invalid-date-policy-pack.jsonl\n",
      deskRoot: await safeDeskRoot(),
      sourceDocs: safeSourceDocs(),
      policy: validPolicy({
        approved_artifact_types: ["vector-pack"],
        approvals: [
          repoApproval("vector-pack", {
            approved_at: "2026-99-99Tnot-a-real-date",
          }),
        ],
        updated_at: "2026-99-99Tnot-a-real-date",
      }),
    }),
    (error) => {
      assert.equal(error.code, "artifact_publication_policy_invalid")
      assert.ok(
        error.diagnostics.includes(
          "publication policy updated_at must be a date-time string",
        ),
      )
      assert.ok(
        error.diagnostics.includes(
          "publication policy approvals[0].approved_at must be a date-time string",
        ),
      )
      return true
    },
  )
})

test("ordinary startup does not write committed artifact files", async () => {
  const tempRoot = await tmpRoot("desk-publication-startup-")
  const deskRoot = path.join(tempRoot, "desk")
  const pluginRoot = path.join(tempRoot, "plugins", "desk")
  const artifactsRoot = path.join(pluginRoot, "artifacts")
  await fs.mkdir(path.join(deskRoot, "track", "task"), { recursive: true })
  await fs.writeFile(path.join(deskRoot, "track", "task", "task.md"), "# Startup\n", "utf8")
  await seedCommittedArtifactFixture(artifactsRoot)
  const before = await fileHashes(artifactsRoot)

  await ensureIndex(deskRoot, {
    startup: true,
    skipEmbed: true,
    snapshots: { pluginRoot },
    vectorPacks: { pluginRoot },
  })

  assert.deepEqual(await fileHashes(artifactsRoot), before)
})
