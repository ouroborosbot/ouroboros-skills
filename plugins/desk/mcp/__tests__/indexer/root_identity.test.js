import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"

import {
  physicalRootKey,
  resolveRootIdentity,
  resolveRootPath,
} from "../../src/indexer/root-identity.js"
import { createModeledCaseCollisionRootIdentity } from "../fixtures/root_identity_fixture.js"

function failingFilesystemCall(code, message) {
  return () => {
    throw Object.assign(new Error(message), { code })
  }
}

test("canonical realpaths merge an alias without merging a distinct case-variant root or reused inode", () => {
  const fixture = createModeledCaseCollisionRootIdentity()
  const rootA = fixture.resolveIdentity(fixture.rootA)
  const aliasA = fixture.resolveIdentity(fixture.aliasA)
  const rootB = fixture.resolveIdentity(fixture.rootB)

  assert.equal(rootA.path, fixture.rootA)
  assert.equal(aliasA.path, fixture.aliasA)
  assert.equal(rootB.path, fixture.rootB)
  assert.equal(rootA.key, aliasA.key)
  assert.notEqual(
    rootA.key,
    rootB.key,
    "distinct case-variant realpaths must remain independent even when a file ID is reused",
  )
  assert.equal(rootA.key, path.normalize(fixture.rootA))
  assert.equal(rootB.key, path.normalize(fixture.rootB))
  const freshnessByRoot = new Map([
    [rootA.key, { statInventoryHash: "root-a" }],
  ])
  assert.strictEqual(
    freshnessByRoot.get(aliasA.key),
    freshnessByRoot.get(rootA.key),
  )
  assert.equal(freshnessByRoot.has(rootB.key), false)
  assert.deepEqual(fixture.statCalls, [])
})

test("successful realpath ignores stat failure for direct and symlink aliases", () => {
  const fixture = createModeledCaseCollisionRootIdentity()
  const statFailure = failingFilesystemCall("EIO", "stat failed")
  const identity = (deskRoot) =>
    resolveRootIdentity(deskRoot, {
      nativeRealpath: fixture.nativeRealpath,
      nativeStat: statFailure,
    })
  const rootA = identity(fixture.rootA)
  const aliasA = identity(fixture.aliasA)

  assert.equal(rootA.key, path.normalize(fixture.rootA))
  assert.equal(aliasA.key, rootA.key)
})

test("realpath failure fails closed without creating an unresolved identity", () => {
  const fixture = createModeledCaseCollisionRootIdentity()
  const missingA = path.join(fixture.rootA, "..", "MissingA")
  const realpathFailure = failingFilesystemCall("ENOENT", "not found")

  assert.throws(
    () => resolveRootIdentity(missingA, {
      nativeRealpath: realpathFailure,
    }),
    (error) => {
      assert.equal(error.code, "desk_root_identity_unavailable")
      assert.equal(error.message, "desk root identity is unavailable")
      return true
    },
  )
})

test("canonical identity honors native path normalization without case folding", () => {
  const windowsResolve = (candidate) =>
    path.win32.resolve("C:\\workspace", candidate)
  const windowsRoot = windowsResolve("Desk\\Root\\..\\Data")
  const identity = resolveRootIdentity("Desk\\Root\\..\\Data", {
    resolvePath: windowsResolve,
    normalizePath: path.win32.normalize,
    nativeRealpath: () => "C:\\Desk\\Data\\.\\",
    nativeStat: failingFilesystemCall("EIO", "stat must not be sampled"),
  })

  assert.deepEqual(identity, {
    path: windowsRoot,
    key: "C:\\Desk\\Data\\",
  })
  assert.equal(
    resolveRootPath(path.join("Desk", "Root", "..", "Data")),
    path.resolve("Desk", "Data"),
  )
  assert.equal(typeof physicalRootKey(path.parse(path.resolve(".")).root), "string")
})
