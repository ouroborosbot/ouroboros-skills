import { realpathSync, statSync } from "node:fs"
import * as path from "node:path"

export function resolveRootIdentity(deskRoot, {
  nativeRealpath = realpathSync.native,
  nativeStat = statSync,
  normalizePath = path.normalize,
  resolvePath = path.resolve,
} = {}) {
  const root = resolveRootPath(deskRoot, { resolvePath })
  let physicalRoot
  try {
    physicalRoot = nativeRealpath(root)
  } catch {
    return unresolvedRootIdentity(root)
  }

  try {
    const stat = nativeStat(physicalRoot, { bigint: true })
    const fileId = stableFileId(stat)
    return {
      path: root,
      key: fileId === null
        ? `physical-path:${normalizePath(physicalRoot)}`
        : `physical-id:${fileId}`,
    }
  } catch {
    return unresolvedRootIdentity(root)
  }
}

export function physicalRootKey(deskRoot) {
  return resolveRootIdentity(deskRoot).key
}

export function resolveRootPath(deskRoot, {
  resolvePath = path.resolve,
} = {}) {
  if (typeof deskRoot !== "string" || deskRoot.trim() === "") {
    throw new Error("deskRoot is required")
  }
  return resolvePath(deskRoot)
}

function unresolvedRootIdentity(root) {
  return {
    path: root,
    key: `unresolved:${root}`,
  }
}

function stableFileId(stat) {
  const dev = stablePositiveInteger(stat?.dev)
  const ino = stablePositiveInteger(stat?.ino)
  return dev === null || ino === null
    ? null
    : `${dev}:${ino}`
}

function stablePositiveInteger(value) {
  if (typeof value === "bigint") {
    return value > 0n ? value.toString(10) : null
  }
  return Number.isSafeInteger(value) && value > 0
    ? String(value)
    : null
}
