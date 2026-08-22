import { realpathSync } from "node:fs"
import * as path from "node:path"

export function resolveRootIdentity(deskRoot, {
  nativeRealpath = realpathSync.native,
} = {}) {
  const root = resolveRootPath(deskRoot)
  try {
    const physicalRoot = nativeRealpath(root)
    return {
      path: root,
      key: `physical:${normalizePhysicalRoot(
        physicalRoot,
        nativeRealpath,
      )}`,
    }
  } catch {
    return {
      path: root,
      key: `unresolved:${root}`,
    }
  }
}

export function physicalRootKey(deskRoot) {
  return resolveRootIdentity(deskRoot).key
}

export function resolveRootPath(deskRoot) {
  if (typeof deskRoot !== "string" || deskRoot.trim() === "") {
    throw new Error("deskRoot is required")
  }
  return path.resolve(deskRoot)
}

function normalizePhysicalRoot(physicalRoot, nativeRealpath) {
  const caseAlias = physicalRoot.replace(
    /[A-Za-z](?!.*[A-Za-z])/u,
    (character) =>
      character === character.toLowerCase()
        ? character.toUpperCase()
        : character.toLowerCase(),
  )
  if (caseAlias === physicalRoot) return physicalRoot
  try {
    if (nativeRealpath(caseAlias) === physicalRoot) {
      return physicalRoot.toLowerCase()
    }
  } catch {}
  return physicalRoot
}
