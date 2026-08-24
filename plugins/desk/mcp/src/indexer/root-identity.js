import { realpathSync } from "node:fs"
import * as path from "node:path"

export function resolveRootIdentity(deskRoot, {
  nativeRealpath = realpathSync.native,
  normalizePath = path.normalize,
  resolvePath = path.resolve,
} = {}) {
  const root = resolveRootPath(deskRoot, { resolvePath })
  try {
    return Object.freeze({
      path: root,
      key: canonicalRootPath(root, {
        nativeRealpath,
        normalizePath,
        resolvePath,
      }),
    })
  } catch {
    throw rootIdentityError(
      "desk_root_identity_unavailable",
      "desk root identity is unavailable",
    )
  }
}

export function physicalRootKey(deskRoot) {
  return resolveRootIdentity(deskRoot).key
}

export function validateRootIdentity(rootIdentity, {
  nativeRealpath = realpathSync.native,
  normalizePath = path.normalize,
  resolvePath = path.resolve,
} = {}) {
  let currentKey
  try {
    currentKey = canonicalRootPath(rootIdentity.path, {
      nativeRealpath,
      normalizePath,
      resolvePath,
    })
  } catch {
    throw rootIdentityError(
      "desk_root_identity_unavailable",
      "desk root identity is unavailable",
    )
  }
  if (currentKey !== rootIdentity.key) {
    throw rootIdentityError(
      "desk_root_identity_changed",
      "desk root identity changed during maintenance",
    )
  }
  return rootIdentity
}

export function resolveRootPath(deskRoot, {
  resolvePath = path.resolve,
} = {}) {
  if (typeof deskRoot !== "string" || deskRoot.trim() === "") {
    throw new Error("deskRoot is required")
  }
  return resolvePath(deskRoot)
}

function canonicalRootPath(root, {
  nativeRealpath,
  normalizePath,
  resolvePath,
}) {
  return normalizePath(resolvePath(nativeRealpath(root)))
}

function rootIdentityError(code, message) {
  return Object.assign(new Error(message), { code })
}
