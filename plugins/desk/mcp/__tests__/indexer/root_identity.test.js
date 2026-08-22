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

test("referent IDs merge a case-only symlink alias without merging a distinct case-variant root", () => {
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
    "a distinct case-variant inode must not collide with the aliased referent",
  )
  const freshnessByRoot = new Map([
    [rootA.key, { statInventoryHash: "root-a" }],
  ])
  assert.strictEqual(
    freshnessByRoot.get(aliasA.key),
    freshnessByRoot.get(rootA.key),
  )
  assert.equal(freshnessByRoot.has(rootB.key), false)
  assert.match(rootA.key, /9007199254740993/u)
  assert.match(rootA.key, /18446744073709551617/u)
  assert.match(rootB.key, /18446744073709551618/u)
  assert.deepEqual(fixture.statCalls, [
    {
      candidate: fixture.rootA,
      options: { bigint: true },
    },
    {
      candidate: fixture.rootA,
      options: { bigint: true },
    },
    {
      candidate: fixture.rootB,
      options: { bigint: true },
    },
  ])
})

test("zero or unreliable file IDs fall back to exact normalized referent paths", () => {
  const fixture = createModeledCaseCollisionRootIdentity()
  const unreliableStats = [
    { dev: 1n, ino: 0n },
    { dev: 0n, ino: 1n },
    { dev: 1, ino: Number.MAX_SAFE_INTEGER + 1 },
    { dev: "1", ino: "2" },
  ]

  for (const stat of unreliableStats) {
    const identity = (deskRoot) =>
      resolveRootIdentity(deskRoot, {
        nativeRealpath: fixture.nativeRealpath,
        nativeStat: () => stat,
      })
    const rootA = identity(fixture.rootA)
    const aliasA = identity(fixture.aliasA)
    const rootB = identity(fixture.rootB)
    assert.equal(rootA.key, aliasA.key)
    assert.notEqual(rootA.key, rootB.key)
    assert.equal(rootA.key, `physical-path:${path.normalize(fixture.rootA)}`)
    assert.equal(rootB.key, `physical-path:${path.normalize(fixture.rootB)}`)
  }
})

test("realpath, stat, and nonexistent-root errors preserve distinct normalized lexical keys", () => {
  const fixture = createModeledCaseCollisionRootIdentity()
  const missingA = path.join(fixture.rootA, "..", "MissingA")
  const missingB = path.join(fixture.rootA, "..", "missinga")
  const realpathFailure = failingFilesystemCall("ENOENT", "not found")

  assert.deepEqual(
    resolveRootIdentity(missingA, {
      nativeRealpath: realpathFailure,
    }),
    {
      path: path.resolve(missingA),
      key: `unresolved:${path.resolve(missingA)}`,
    },
  )
  assert.notEqual(
    resolveRootIdentity(missingA, {
      nativeRealpath: realpathFailure,
    }).key,
    resolveRootIdentity(missingB, {
      nativeRealpath: failingFilesystemCall("EACCES", "denied"),
    }).key,
  )

  const statFailure = failingFilesystemCall("EIO", "stat failed")
  const statErrorA = resolveRootIdentity(fixture.rootA, {
    nativeRealpath: fixture.nativeRealpath,
    nativeStat: statFailure,
  })
  const statErrorAlias = resolveRootIdentity(fixture.aliasA, {
    nativeRealpath: fixture.nativeRealpath,
    nativeStat: statFailure,
  })
  const statErrorB = resolveRootIdentity(fixture.rootB, {
    nativeRealpath: fixture.nativeRealpath,
    nativeStat: statFailure,
  })
  assert.deepEqual(
    new Set([statErrorA.key, statErrorAlias.key, statErrorB.key]),
    new Set([
      `unresolved:${fixture.rootA}`,
      `unresolved:${fixture.aliasA}`,
      `unresolved:${fixture.rootB}`,
    ]),
  )
})

test("identity fallback honors platform path normalization without case folding", () => {
  const windowsResolve = (candidate) =>
    path.win32.resolve("C:\\workspace", candidate)
  const windowsRoot = windowsResolve("Desk\\Root\\..\\Data")
  const identity = resolveRootIdentity("Desk\\Root\\..\\Data", {
    resolvePath: windowsResolve,
    normalizePath: path.win32.normalize,
    nativeRealpath: () => "C:\\Desk\\Data\\.\\",
    nativeStat: () => ({ dev: 1n, ino: 0n }),
  })

  assert.deepEqual(identity, {
    path: windowsRoot,
    key: "physical-path:C:\\Desk\\Data\\",
  })
  assert.equal(
    resolveRootPath(path.join("Desk", "Root", "..", "Data")),
    path.resolve("Desk", "Data"),
  )
  assert.equal(typeof physicalRootKey(path.parse(path.resolve(".")).root), "string")
})
