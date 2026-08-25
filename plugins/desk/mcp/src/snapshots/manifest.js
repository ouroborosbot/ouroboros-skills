import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import manifestContracts from "../artifacts/manifest-contracts.cjs"
import {
  assertArtifactPublicationAllowed,
  policyForArtifactWrite,
} from "../artifacts/policy.js"
import { publishArtifactSet } from "../artifacts/publication.js"
import {
  assertArtifactDoesNotRepresentTombstones,
  assertArtifactInputsDoNotContainTombstones,
} from "../artifacts/tombstones.js"
import { assertArtifactInputsAllowed } from "../indexer/exclusions.js"
import { ACTIVE_EMBEDDING_SPEC } from "../indexer/spec.js"
import { representedDocumentTreeHash } from "../indexer/document-tree.js"

const { validateArtifactManifest } = manifestContracts

export function deriveSnapshotPaths({
  pluginRoot,
  embeddingSpecId = ACTIVE_EMBEDDING_SPEC.id,
  snapshotId,
} = {}) {
  assertPathSafeId(embeddingSpecId, "embedding_spec_id")
  assertPathSafeId(snapshotId, "snapshot_id")
  const snapshotDir = path.join(pluginRoot, "artifacts", "snapshots", embeddingSpecId)
  const snapshotPath = path.join(snapshotDir, `${snapshotId}.sqlite.zst`)
  return {
    snapshotDir,
    snapshotPath,
    manifestPath: path.join(snapshotDir, `${snapshotId}.manifest.json`),
    checksumPath: path.join(snapshotDir, `${snapshotId}.sha256`),
    relativeSnapshotPath: normalizePath(path.join(
      "plugins",
      "desk",
      "artifacts",
      "snapshots",
      embeddingSpecId,
      `${snapshotId}.sqlite.zst`,
    )),
  }
}

export async function writeSnapshotArtifact({
  pluginRoot,
  embeddingSpecId = ACTIVE_EMBEDDING_SPEC.id,
  snapshotId,
  snapshotBytes,
  manifestBytes,
  checksumBytes,
  policy,
  deskRoot,
  sourceDocs,
  signal,
  publication,
} = {}) {
  const paths = deriveSnapshotPaths({ pluginRoot, embeddingSpecId, snapshotId })
  await assertArtifactInputsAllowed({
    deskRoot,
    artifact_type: "snapshot",
    docs: sourceDocs,
  })
  await assertArtifactInputsDoNotContainTombstones({
    pluginRoot,
    artifact_type: "snapshot",
    sourceDocs,
  })
  const publicationPolicy = await policyForArtifactWrite({ pluginRoot, policy })
  await assertArtifactPublicationAllowed({
    policy: publicationPolicy,
    artifact_type: "snapshot",
    operation: "write",
    relative_path: paths.relativeSnapshotPath,
  })
  await fs.mkdir(paths.snapshotDir, { recursive: true })
  const manifest = parseManifestBytes(manifestBytes)
  await publishArtifactSet({
    ...publication,
    artifactId: snapshotId,
    signal,
    files: [
      { name: "primary", path: paths.snapshotPath, bytes: snapshotBytes },
      { name: "manifest", path: paths.manifestPath, bytes: manifestBytes },
      { name: "checksum", path: paths.checksumPath, bytes: checksumBytes },
    ],
    validateStaged: async (stagedPaths) => {
      await validateSnapshotArtifact({
        pluginRoot,
        snapshotPath: stagedPaths.primary,
        manifestPath: stagedPaths.manifest,
        checksumPath: stagedPaths.checksum,
        expectedSpec: ACTIVE_EMBEDDING_SPEC,
        expectedDbSchema: manifest.db_schema,
        expectedSqliteVec: manifest.sqlite_vec,
        expectedRuntime: manifest.runtime,
        expectedArtifactSourceScopeHash: manifest.artifact_source_scope_hash,
        expectedDocumentTreeHash: manifest.document_tree_hash,
        expectedDiscoveryGrammarVersion: manifest.discovery_grammar_version,
        expectedDocuments: sourceDocs,
      })
    },
  })
  return paths
}

export async function validateSnapshotArtifact({
  pluginRoot,
  snapshotPath,
  manifestPath,
  checksumPath,
  expectedSpec = ACTIVE_EMBEDDING_SPEC,
  expectedDbSchema,
  expectedSqliteVec,
  expectedRuntime,
  expectedArtifactSourceScopeHash,
  expectedDocumentTreeHash,
  expectedDiscoveryGrammarVersion,
  expectedDocuments,
} = {}) {
  const label =
    typeof snapshotPath === "string" && snapshotPath.trim() !== ""
      ? path.basename(snapshotPath)
      : "snapshot"
  if (typeof snapshotPath !== "string" || snapshotPath.trim() === "") {
    throw new Error(`${label} snapshot path is required`)
  }
  if (!snapshotPath.endsWith(".sqlite.zst")) {
    throw new Error(`${label} snapshot path must end with .sqlite.zst`)
  }
  const resolvedManifestPath = manifestPath ?? sidecarPath(snapshotPath, ".manifest.json")
  const resolvedChecksumPath = checksumPath ?? sidecarPath(snapshotPath, ".sha256")
  const artifactBytes = await readRequiredFile(snapshotPath, `${label} snapshot`)
  const artifactSha256 = `sha256:${sha256(artifactBytes)}`
  const manifest = await readRequiredJson(resolvedManifestPath, `${label} manifest`)
  const checksum = await readRequiredChecksum(resolvedChecksumPath, `${label} checksum`)

  if (checksum !== artifactSha256) {
    throw new Error(`${label}: checksum mismatch for snapshot artifact`)
  }

  await assertArtifactDoesNotRepresentTombstones({
    pluginRoot,
    artifact_type: "snapshot",
    represented_documents: manifest.represented_documents,
  })
  const result = validateSnapshotManifest({
    manifest,
    artifactSha256,
    expectedSpec,
    expectedDbSchema,
    expectedSqliteVec,
    expectedRuntime,
    expectedArtifactSourceScopeHash,
    expectedDocumentTreeHash,
    expectedDiscoveryGrammarVersion,
    expectedDocuments,
  })
  if (manifest.artifact.file !== path.basename(snapshotPath)) {
    throw new Error(`${label}: manifest artifact file must match snapshot file`)
  }
  return result
}

export function validateSnapshotManifest({
  manifest,
  artifactSha256,
  expectedSpec = ACTIVE_EMBEDDING_SPEC,
  expectedDbSchema,
  expectedSqliteVec,
  expectedRuntime,
  expectedArtifactSourceScopeHash,
  expectedDocumentTreeHash,
  expectedDiscoveryGrammarVersion,
  expectedDocuments,
} = {}) {
  for (const [value, label] of [
    [expectedDbSchema, "DB schema"],
    [expectedSqliteVec, "sqlite-vec"],
    [expectedRuntime, "runtime"],
  ]) {
    if (value === undefined) {
      throw new Error(`expected ${label} must be provided`)
    }
  }
  validateArtifactManifest({
    artifactType: "snapshot",
    manifest,
    artifactSha256,
    expectedSpec,
    expectedDbSchema,
    expectedSqliteVec,
    expectedRuntime,
    expectedDocuments,
  })

  const representedHash =
    representedDocumentTreeHash(manifest.represented_documents)
  const freshness = {
    artifact_source_scope:
      manifest.artifact_source_scope_hash === expectedArtifactSourceScopeHash
        ? "fresh"
        : "stale",
    document_tree:
      representedHash !== null &&
      representedHash === manifest.document_tree_hash &&
      representedHash === expectedDocumentTreeHash
        ? "fresh"
        : "stale",
  }
  if (expectedDiscoveryGrammarVersion !== undefined) {
    freshness.discovery_grammar =
      manifest.discovery_grammar_version === expectedDiscoveryGrammarVersion
        ? "fresh"
        : "stale"
  }

  return {
    compatible: true,
    snapshot_id: manifest.snapshot_id,
    embedding_spec_id: manifest.embedding_spec_id,
    included_pack_ids: [...manifest.included_pack_ids],
    manifest,
    freshness,
  }
}

async function readRequiredFile(filePath, label) {
  try {
    return await fs.readFile(filePath)
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} missing`)
    }
    throw error
  }
}

async function readRequiredJson(filePath, label) {
  const bytes = await readRequiredFile(filePath, label)
  try {
    return JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error(`${label} must be valid JSON`)
  }
}

async function readRequiredChecksum(filePath, label) {
  const bytes = await readRequiredFile(filePath, label)
  const match = bytes.toString("utf8").match(/^\s*(sha256:[a-f0-9]{64}|[a-f0-9]{64})\b/u)
  if (!match) {
    throw new Error(`${label} must start with a sha256 digest`)
  }
  return match[1].startsWith("sha256:") ? match[1] : `sha256:${match[1]}`
}

function sidecarPath(snapshotPath, suffix) {
  return snapshotPath.replace(/\.sqlite\.zst$/u, suffix)
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function assertPathSafeId(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    path.isAbsolute(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("..")
  ) {
    throw new Error(`invalid ${label}: path traversal is not allowed`)
  }
}

function normalizePath(value) {
  return value.replaceAll(path.sep, "/")
}

function parseManifestBytes(bytes) {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"))
  } catch {
    throw new Error("snapshot manifest must be valid JSON")
  }
}
