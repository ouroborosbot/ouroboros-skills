import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import manifestContracts from "../../src/artifacts/manifest-contracts.cjs"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"

const {
  ARTIFACT_SOURCE_PATHS,
  validateArtifactManifest,
} = manifestContracts
const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const artifactRoot = path.join(repoRoot, "plugins", "desk", "artifacts")

async function productionManifest(artifactType) {
  const directory = artifactType === "vector-pack"
    ? "vector-packs"
    : "snapshots"
  return JSON.parse(await readFile(path.join(
    artifactRoot,
    directory,
    ACTIVE_EMBEDDING_SPEC.id,
    "repo-public-bootstrap-2026-06-15.manifest.json",
  ), "utf8"))
}

function validate(artifactType, manifest, overrides = {}) {
  return validateArtifactManifest({
    artifactType,
    manifest,
    expectedSpec: ACTIVE_EMBEDDING_SPEC,
    expectedSourcePaths: ARTIFACT_SOURCE_PATHS,
    ...overrides,
  })
}

test("manifest contract rejects unsupported types and malformed root objects", async () => {
  const vector = await productionManifest("vector-pack")
  assert.throws(
    () => validateArtifactManifest({ artifactType: "other", manifest: vector }),
    /type must be snapshot or vector-pack/u,
  )
  assert.throws(
    () => validateArtifactManifest({ manifest: vector }),
    /type must be snapshot or vector-pack/u,
  )
  for (const manifest of [null, [], "manifest"]) {
    assert.throws(
      () => validate("vector-pack", manifest),
      /manifest must be an object/u,
    )
  }
})

test("manifest contract rejects malformed hashes, versions, and included pack sets", async () => {
  const vector = await productionManifest("vector-pack")
  for (const rows_sha256 of [123, "not-a-digest"]) {
    assert.throws(
      () => validate("vector-pack", { ...vector, rows_sha256 }),
      /rows_sha256/u,
    )
  }

  const snapshot = await productionManifest("snapshot")
  for (const version of [123, "not-semver"]) {
    assert.throws(
      () => validate("snapshot", {
        ...snapshot,
        sqlite_vec: { ...snapshot.sqlite_vec, version },
      }),
      /sqlite_vec\.version/u,
    )
  }
  assert.throws(
    () => validate("snapshot", {
      ...snapshot,
      included_pack_ids: "pack",
    }),
    /included_pack_ids must be an array/u,
  )
  assert.throws(
    () => validate("snapshot", {
      ...snapshot,
      included_pack_ids: ["pack", "pack"],
    }),
    /included_pack_ids must be unique/u,
  )
})

test("manifest contract requires the canonical source list and expected documents", async () => {
  const vector = await productionManifest("vector-pack")
  assert.throws(
    () => validate("vector-pack", { ...vector, source_paths: "paths" }),
    /source_paths must be an array/u,
  )
  for (const expectedSourcePaths of [null, []]) {
    assert.throws(
      () => validateArtifactManifest({
        artifactType: "vector-pack",
        manifest: vector,
        expectedSpec: ACTIVE_EMBEDDING_SPEC,
        expectedSourcePaths,
      }),
      /expected source paths must be provided/u,
    )
  }
  assert.throws(
    () => validate("vector-pack", vector, { expectedDocuments: null }),
    /expected documents must be an array/u,
  )
  const [represented] = vector.represented_documents
  assert.throws(
    () => validate("vector-pack", vector, {
      expectedDocuments: [represented, { ...represented }],
    }),
    /duplicate expected document/u,
  )
  assert.throws(
    () => validate("vector-pack", vector, {
      expectedDocuments: [{
        ...represented,
        hash: `sha256:${"0".repeat(64)}`,
      }],
    }),
    /must match expected documents/u,
  )
  assert.doesNotThrow(
    () => validate("vector-pack", vector, {
      expectedDocuments: [{
        path: represented.path,
        hash: represented.hash.slice("sha256:".length),
      }],
    }),
  )
})

test("manifest contract rejects private and unsafe scalar values", async () => {
  const snapshot = await productionManifest("snapshot")
  for (const platform of [
    "portable\0private",
    ".state/private.json",
    "/private/absolute.json",
    "C:\\private\\absolute.json",
    "../private/traversal.json",
  ]) {
    assert.throws(
      () => validate("snapshot", {
        ...snapshot,
        runtime: { ...snapshot.runtime, platform },
      }),
      /null bytes|private \.state|unsafe paths/u,
    )
  }
})
