import * as path from "node:path"

import { resolveRootIdentity } from "../../src/indexer/root-identity.js"

export function createModeledCaseCollisionRootIdentity() {
  const volumeRoot = path.parse(path.resolve(".")).root
  const rootA = path.join(volumeRoot, "srv", "FooA")
  const aliasA = path.join(volumeRoot, "srv", "Fooa")
  const rootB = path.join(volumeRoot, "srv", "fooa")
  const referents = new Map([
    [rootA, rootA],
    [aliasA, rootA],
    [rootB, rootB],
  ])
  const stats = new Map([
    [
      rootA,
      {
        dev: 9007199254740993n,
        ino: 18446744073709551617n,
      },
    ],
    [
      rootB,
      {
        dev: 9007199254740993n,
        ino: 18446744073709551618n,
      },
    ],
  ])
  const statCalls = []

  function nativeRealpath(candidate) {
    const referent = referents.get(candidate)
    if (referent !== undefined) return referent
    throw Object.assign(new Error(`missing modeled root: ${candidate}`), {
      code: "ENOENT",
    })
  }

  function nativeStat(candidate, options) {
    statCalls.push({ candidate, options })
    const stat = stats.get(candidate)
    if (stat !== undefined) return stat
    throw Object.assign(new Error(`missing modeled stat: ${candidate}`), {
      code: "ENOENT",
    })
  }

  const resolveIdentity = (deskRoot) =>
    resolveRootIdentity(deskRoot, {
      nativeRealpath,
      nativeStat,
    })

  return {
    aliasA,
    nativeRealpath,
    nativeStat,
    resolveIdentity,
    rootA,
    rootB,
    statCalls,
  }
}
