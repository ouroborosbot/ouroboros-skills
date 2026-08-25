import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import {
  buildSnapshotFromLocalDb,
} from "../../src/artifacts/artifact-scripts.js"
import manifestContracts from "../../src/artifacts/manifest-contracts.cjs"
import { closeDb, openDb } from "../../src/db/init.js"
import { rebuildIndex } from "../../src/indexer/index.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"
import {
  writeVectorPackArtifact,
} from "../../src/indexer/vector-packs.js"
import {
  writeSnapshotArtifact,
} from "../../src/snapshots/manifest.js"

const { ARTIFACT_SOURCE_PATHS } = manifestContracts
const mcpRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))
const repoRoot = path.resolve(mcpRoot, "..", "..", "..")
const sourcePluginRoot = path.join(repoRoot, "plugins", "desk")
const publicationSchemaPath = path.join(
  sourcePluginRoot,
  "artifacts",
  "publication-policy.schema.json",
)
const publicPackManifestPath = path.join(
  sourcePluginRoot,
  "artifacts",
  "vector-packs",
  ACTIVE_EMBEDDING_SPEC.id,
  "repo-public-bootstrap-2026-06-15.manifest.json",
)
const publicPackPath = publicPackManifestPath.replace(
  /\.manifest\.json$/u,
  ".jsonl",
)
const publicSnapshotManifestPath = path.join(
  sourcePluginRoot,
  "artifacts",
  "snapshots",
  ACTIVE_EMBEDDING_SPEC.id,
  "repo-public-bootstrap-2026-06-15.manifest.json",
)

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function approvedPolicy() {
  return {
    schema_version: 1,
    default_publication: "deny",
    repo_visibility: "public",
    sensitive_repo: true,
    approved_artifact_types: ["vector-pack", "snapshot"],
    approval_required: true,
    approvals: ["vector-pack", "snapshot"].map((artifactType) => ({
      scope: "repo",
      artifact_type: artifactType,
      approved_by: "unit-test-reviewer",
      approved_at: "2026-08-24T00:00:00.000Z",
      reason: "Exercise atomic artifact publication.",
    })),
    updated_at: "2026-08-24T00:00:00.000Z",
  }
}

async function scratchRoot(prefix) {
  return mkdtemp(path.join(mcpRoot, `.${prefix}-`))
}

async function preparePluginRoot(root) {
  const pluginRoot = path.join(root, "plugin")
  await mkdir(path.join(pluginRoot, "artifacts"), { recursive: true })
  await cp(
    publicationSchemaPath,
    path.join(pluginRoot, "artifacts", "publication-policy.schema.json"),
  )
  await writeFile(
    path.join(pluginRoot, "artifacts", "publication-policy.json"),
    `${JSON.stringify(approvedPolicy(), null, 2)}\n`,
    "utf8",
  )
  return pluginRoot
}

function pathsFor(pluginRoot, artifactType, artifactId) {
  const directory = path.join(
    pluginRoot,
    "artifacts",
    artifactType === "vector-pack" ? "vector-packs" : "snapshots",
    ACTIVE_EMBEDDING_SPEC.id,
  )
  return {
    directory,
    primary: path.join(
      directory,
      artifactType === "vector-pack"
        ? `${artifactId}.jsonl`
        : `${artifactId}.sqlite.zst`,
    ),
    manifest: path.join(directory, `${artifactId}.manifest.json`),
    checksum: path.join(directory, `${artifactId}.sha256`),
  }
}

async function generation({ artifactType, artifactId, marker }) {
  const template = JSON.parse(await readFile(
    artifactType === "vector-pack"
      ? publicPackManifestPath
      : publicSnapshotManifestPath,
    "utf8",
  ))
  let primaryBytes
  if (artifactType === "vector-pack") {
    const row = JSON.parse(
      (await readFile(publicPackPath, "utf8")).trim().split("\n")[0],
    )
    row.vector[0] = marker === "old" ? 0.125 : 0.875
    primaryBytes = Buffer.from(`${JSON.stringify(row)}\n`, "utf8")
  } else {
    primaryBytes = Buffer.from(`${artifactType}:${marker}\n`, "utf8")
  }
  const rawSha = sha256(primaryBytes)
  const manifest = artifactType === "vector-pack"
    ? {
        ...template,
        pack_id: artifactId,
        row_count: 1,
        rows_sha256: rawSha,
        created_at: marker === "old"
          ? "2026-08-24T00:00:00.000Z"
          : "2026-08-24T00:01:00.000Z",
          source_paths: ARTIFACT_SOURCE_PATHS,
        }
    : {
        ...template,
        snapshot_id: artifactId,
        created_at: marker === "old"
          ? "2026-08-24T00:00:00.000Z"
          : "2026-08-24T00:01:00.000Z",
        artifact: {
          ...template.artifact,
          file: `${artifactId}.sqlite.zst`,
          sha256: `sha256:${rawSha}`,
        },
        source_paths: ARTIFACT_SOURCE_PATHS,
      }
  return {
    primaryBytes,
    manifestBytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    checksumBytes: Buffer.from(
      `${artifactType === "vector-pack" ? rawSha : `sha256:${rawSha}`}  ${
        artifactType === "vector-pack"
          ? `${artifactId}.jsonl`
          : `${artifactId}.sqlite.zst`
      }\n`,
      "utf8",
    ),
    sourceDocs: manifest.represented_documents,
  }
}

async function publish({
  artifactType,
  artifactId,
  pluginRoot,
  deskRoot,
  marker,
  publication,
  signal,
}) {
  const bytes = await generation({ artifactType, artifactId, marker })
  const common = {
    pluginRoot,
    embeddingSpecId: ACTIVE_EMBEDDING_SPEC.id,
    policy: approvedPolicy(),
    deskRoot,
    sourceDocs: bytes.sourceDocs,
    publication,
    signal,
  }
  if (artifactType === "vector-pack") {
    return writeVectorPackArtifact({
      ...common,
      packId: artifactId,
      packBytes: bytes.primaryBytes,
      manifestBytes: bytes.manifestBytes,
      checksumBytes: bytes.checksumBytes,
    })
  }
  return writeSnapshotArtifact({
    ...common,
    snapshotId: artifactId,
    snapshotBytes: bytes.primaryBytes,
    manifestBytes: bytes.manifestBytes,
    checksumBytes: bytes.checksumBytes,
  })
}

async function readTriplet(paths) {
  return Promise.all([
    readFile(paths.primary),
    readFile(paths.manifest),
    readFile(paths.checksum),
  ])
}

async function assertOnlyConsumerPaths(paths) {
  assert.deepEqual(
    (await readdir(paths.directory)).sort(),
    [
      path.basename(paths.checksum),
      path.basename(paths.manifest),
      path.basename(paths.primary),
    ].sort(),
  )
}

for (const artifactType of ["vector-pack", "snapshot"]) {
  test(`${artifactType} publication restores the previous generation after every commit-step failure`, async () => {
    const root = await scratchRoot(`artifact-publication-${artifactType}`)
    const deskRoot = path.join(root, "desk")
    const pluginRoot = await preparePluginRoot(root)
    const artifactId = `${artifactType}-rollback`
    const paths = pathsFor(pluginRoot, artifactType, artifactId)
    try {
      await mkdir(deskRoot, { recursive: true })
      await publish({
        artifactType,
        artifactId,
        pluginRoot,
        deskRoot,
        marker: "old",
      })
      const previous = await readTriplet(paths)

      for (let failingIndex = 0; failingIndex < 3; failingIndex += 1) {
        await assert.rejects(
          () => publish({
            artifactType,
            artifactId,
            pluginRoot,
            deskRoot,
            marker: `new-${failingIndex}`,
            publication: {
              hooks: {
                beforeCommitFile({ index }) {
                  if (index === failingIndex) {
                    throw new Error(`synthetic commit failure ${failingIndex}`)
                  }
                },
              },
            },
          }),
          new RegExp(`synthetic commit failure ${failingIndex}`, "u"),
        )
        const restored = await readTriplet(paths)
        for (let index = 0; index < previous.length; index += 1) {
          assert.equal(Buffer.compare(restored[index], previous[index]), 0)
        }
        await assertOnlyConsumerPaths(paths)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test(`${artifactType} same-ID publishers serialize complete generations without mixing sidecars`, async () => {
    const root = await scratchRoot(`artifact-concurrency-${artifactType}`)
    const deskRoot = path.join(root, "desk")
    const pluginRoot = await preparePluginRoot(root)
    const artifactId = `${artifactType}-concurrent`
    const paths = pathsFor(pluginRoot, artifactType, artifactId)
    let releaseFirst
    let firstReachedCommit
    const firstCommit = new Promise((resolve) => {
      firstReachedCommit = resolve
    })
    const firstRelease = new Promise((resolve) => {
      releaseFirst = resolve
    })
    try {
      await mkdir(deskRoot, { recursive: true })
      const first = publish({
        artifactType,
        artifactId,
        pluginRoot,
        deskRoot,
        marker: "old",
        publication: {
          hooks: {
            async beforeCommit() {
              firstReachedCommit()
              await firstRelease
            },
          },
        },
      })
      await Promise.race([
        firstCommit,
        first.then(() => assert.fail("first publisher did not pause before commit")),
      ])

      let secondReachedCommit = false
      const second = publish({
        artifactType,
        artifactId,
        pluginRoot,
        deskRoot,
        marker: "new",
        publication: {
          hooks: {
            beforeCommit() {
              secondReachedCommit = true
            },
          },
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 25))
      assert.equal(secondReachedCommit, false, "same-ID publisher bypassed the publication lock")

      releaseFirst()
      await Promise.all([first, second])
      assert.equal(secondReachedCommit, true)
      const expected = await generation({ artifactType, artifactId, marker: "new" })
      const actual = await readTriplet(paths)
      for (const [index, bytes] of [
        expected.primaryBytes,
        expected.manifestBytes,
        expected.checksumBytes,
      ].entries()) {
        assert.equal(Buffer.compare(actual[index], bytes), 0)
      }
      await assertOnlyConsumerPaths(paths)
    } finally {
      releaseFirst?.()
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("snapshot build checks cancellation after sanitization and immediately before publication commit", async () => {
  const root = await scratchRoot("artifact-abort")
  const deskRoot = path.join(root, "desk")
  const pluginRoot = await preparePluginRoot(root)
  const snapshotId = "abort-before-commit"
  const paths = pathsFor(pluginRoot, "snapshot", snapshotId)
  const controller = new AbortController()
  try {
    const documentPath = path.join(deskRoot, "track", "task", "task.md")
    await mkdir(path.dirname(documentPath), { recursive: true })
    await writeFile(documentPath, "---\nstatus: processing\n---\nabort fixture\n", "utf8")
    await rebuildIndex(deskRoot, { skipEmbed: true })
    await buildSnapshotFromLocalDb({
      deskRoot,
      pluginRoot,
      mcpRoot,
      snapshotId,
      policy: approvedPolicy(),
      provenanceCommit: "1".repeat(40),
      now: () => Date.parse("2026-08-24T00:00:00.000Z"),
    })
    const previous = await readTriplet(paths)

    await assert.rejects(
      () => buildSnapshotFromLocalDb({
        deskRoot,
        pluginRoot,
        mcpRoot,
        snapshotId,
        policy: approvedPolicy(),
        provenanceCommit: "2".repeat(40),
        now: () => Date.parse("2026-08-24T00:01:00.000Z"),
        signal: controller.signal,
        publication: {
          hooks: {
            beforeCommit() {
              controller.abort()
            },
          },
        },
      }),
      (error) => error.name === "AbortError",
    )

    const restored = await readTriplet(paths)
    for (let index = 0; index < previous.length; index += 1) {
      assert.equal(Buffer.compare(restored[index], previous[index]), 0)
    }
    await assertOnlyConsumerPaths(paths)
    const db = openDb(deskRoot)
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM docs").get().count, 1)
    } finally {
      closeDb(db)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
