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
  const reusedStat = {
    dev: 9007199254740993n,
    ino: 18446744073709551617n,
  }
  const realpathCalls = []
  const statCalls = []

  function nativeRealpath(candidate) {
    realpathCalls.push(candidate)
    const referent = referents.get(candidate)
    if (referent !== undefined) return referent
    throw Object.assign(new Error(`missing modeled root: ${candidate}`), {
      code: "ENOENT",
    })
  }

  function nativeStat(candidate, options) {
    statCalls.push({ candidate, options })
    return reusedStat
  }

  const resolveIdentity = (deskRoot) =>
    resolveRootIdentity(deskRoot, {
      nativeRealpath,
      nativeStat,
    })

  function retargetAlias(target) {
    referents.set(aliasA, target)
  }

  function validateIdentity(identity) {
    const currentKey = path.normalize(nativeRealpath(identity.path))
    if (currentKey === identity.key) return identity
    const error = new Error("desk root identity changed during maintenance")
    error.code = "desk_root_identity_changed"
    throw error
  }

  return {
    aliasA,
    nativeRealpath,
    nativeStat,
    realpathCalls,
    resolveIdentity,
    retargetAlias,
    rootA,
    rootB,
    statCalls,
    validateIdentity,
  }
}
