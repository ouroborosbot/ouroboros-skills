import { test } from "node:test"
import { strict as assert } from "node:assert"

import {
  __artifactScriptInternalsForTests,
} from "../../src/artifacts/artifact-scripts.js"

const { readSanitizedSnapshotBytes } = __artifactScriptInternalsForTests

function helperOptions(overrides = {}) {
  return {
    db: {},
    deskRoot: "/synthetic/private/desk",
    makeId: () => "opaque-id",
    readFile: async () => Buffer.from("sanitized sqlite", "utf8"),
    removeFile: async () => {},
    vacuumInto: () => {},
    openSanitizedDb: () => ({}),
    closeSanitizedDb: () => {},
    purgeOrphanVectors: () => 0,
    ...overrides,
  }
}

test("sanitized snapshot copies clean up on success without exposing their path", async () => {
  const calls = []
  const bytes = await readSanitizedSnapshotBytes(helperOptions({
    readFile: async (filePath) => {
      calls.push(["read", filePath])
      return Buffer.from("sanitized sqlite", "utf8")
    },
    removeFile: async (filePath, options) => {
      calls.push(["remove", filePath, options])
    },
    vacuumInto: (_db, filePath) => {
      calls.push(["vacuum", filePath])
    },
    openSanitizedDb: ({ filePath }) => {
      calls.push(["open", filePath])
      return { copy: true }
    },
    purgeOrphanVectors: (db) => {
      calls.push(["purge", db])
    },
    closeSanitizedDb: (db) => {
      calls.push(["close", db])
    },
  }))

  assert.equal(bytes.toString("utf8"), "sanitized sqlite")
  assert.deepEqual(calls, [
    ["vacuum", "/synthetic/private/desk/.state/.desk-snapshot-sanitized-opaque-id.sqlite"],
    ["open", "/synthetic/private/desk/.state/.desk-snapshot-sanitized-opaque-id.sqlite"],
    ["purge", { copy: true }],
    [
      "vacuum",
      "/synthetic/private/desk/.state/.desk-snapshot-sanitized-opaque-id.sqlite.compacted.sqlite",
    ],
    ["close", { copy: true }],
    [
      "read",
      "/synthetic/private/desk/.state/.desk-snapshot-sanitized-opaque-id.sqlite.compacted.sqlite",
    ],
    [
      "remove",
      "/synthetic/private/desk/.state/.desk-snapshot-sanitized-opaque-id.sqlite",
      { force: true },
    ],
    [
      "remove",
      "/synthetic/private/desk/.state/.desk-snapshot-sanitized-opaque-id.sqlite-wal",
      { force: true },
    ],
    [
      "remove",
      "/synthetic/private/desk/.state/.desk-snapshot-sanitized-opaque-id.sqlite-shm",
      { force: true },
    ],
    [
      "remove",
      "/synthetic/private/desk/.state/.desk-snapshot-sanitized-opaque-id.sqlite.compacted.sqlite",
      { force: true },
    ],
    [
      "remove",
      "/synthetic/private/desk/.state/.desk-snapshot-sanitized-opaque-id.sqlite.compacted.sqlite-wal",
      { force: true },
    ],
    [
      "remove",
      "/synthetic/private/desk/.state/.desk-snapshot-sanitized-opaque-id.sqlite.compacted.sqlite-shm",
      { force: true },
    ],
  ])
})

test("sanitized snapshot copies clean up after errors and redact diagnostics", async () => {
  for (const readFailure of [
    new Error("private path and body must not escape"),
    null,
  ]) {
    let removed = false
    await assert.rejects(
      () => readSanitizedSnapshotBytes(helperOptions({
        readFile: async () => {
          throw readFailure
        },
        removeFile: async () => {
          removed = true
        },
      })),
      (error) => {
        assert.equal(error.code, "snapshot_sanitization_failed")
        assert.equal(error.message, "snapshot sanitized logical copy failed")
        assert.doesNotMatch(error.message, /private path|body/u)
        return true
      },
    )
    assert.equal(removed, true)
  }
})

test("sanitized snapshot copies clean up after cancellation", async () => {
  const controller = new AbortController()
  controller.abort()
  let removed = false
  let vacuumed = false
  await assert.rejects(
    () => readSanitizedSnapshotBytes(helperOptions({
      signal: controller.signal,
      removeFile: async () => {
        removed = true
      },
      vacuumInto: () => {
        vacuumed = true
      },
    })),
    (error) => error.name === "AbortError" && error.message === "snapshot build aborted",
  )
  assert.equal(vacuumed, false)
  assert.equal(removed, true)
})

test("sanitized snapshot cleanup failures redact diagnostics, including cancellation", async () => {
  for (const scenario of [
    {},
    {
      readFile: async () => {
        throw new Error("private read path must not escape")
      },
    },
    { signal: AbortSignal.abort() },
  ]) {
    await assert.rejects(
      () => readSanitizedSnapshotBytes(helperOptions({
        ...scenario,
        removeFile: async () => {
          throw new Error("private cleanup path must not escape")
        },
      })),
      (error) => {
        assert.equal(error.code, "snapshot_sanitization_cleanup_failed")
        assert.equal(error.message, "snapshot sanitized database cleanup failed")
        assert.equal(error.name, scenario.signal ? "AbortError" : "Error")
        assert.doesNotMatch(error.message, /private (?:read|cleanup) path/u)
        return true
      },
    )
  }
})
