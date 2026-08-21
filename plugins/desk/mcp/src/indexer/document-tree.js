import { createHash } from "node:crypto"

export function canonicalDocumentPath(value) {
  return String(value ?? "").replace(/\\/gu, "/")
}

export function canonicalDocumentHash(value) {
  const hash = String(value ?? "")
  return hash.startsWith("sha256:") ? hash : `sha256:${hash}`
}

export function compareDocumentPaths(left, right) {
  const leftPath = canonicalDocumentPath(left)
  const rightPath = canonicalDocumentPath(right)
  if (leftPath < rightPath) return -1
  if (leftPath > rightPath) return 1
  return 0
}

export function representedDocumentTreeHash(docs) {
  const normalized = normalizeDocuments(docs)
  if (normalized === null) return null
  const hash = createHash("sha256")
  for (const doc of normalized) {
    hash.update(`${doc.path}\0${doc.hash}\0`)
  }
  return `sha256:${hash.digest("hex")}`
}

export function documentTreeHash(docs) {
  const hash = representedDocumentTreeHash(docs)
  if (hash === null) {
    throw new TypeError("document tree requires path/hash document entries")
  }
  return hash
}

export function documentStatInventoryHash(docs) {
  if (!Array.isArray(docs)) return null
  const normalized = []
  const paths = new Set()
  for (const doc of docs) {
    if (
      !doc ||
      typeof doc !== "object" ||
      Array.isArray(doc) ||
      typeof doc.path !== "string" ||
      !Number.isFinite(doc.mtime)
    ) {
      return null
    }
    const path = canonicalDocumentPath(doc.path)
    if (paths.has(path)) return null
    paths.add(path)
    normalized.push({ path, mtime: Math.floor(doc.mtime) })
  }
  normalized.sort((left, right) => compareDocumentPaths(left.path, right.path))
  const hash = createHash("sha256")
  for (const doc of normalized) {
    hash.update(`${doc.path}\0${doc.mtime}\0`)
  }
  return `sha256:${hash.digest("hex")}`
}

export function documentTreesEqual(leftDocs, rightDocs) {
  const left = documentMap(leftDocs)
  const right = documentMap(rightDocs)
  if (left === null || right === null || left.size !== right.size) return false
  for (const [path, hash] of left) {
    if (right.get(path) !== hash) return false
  }
  return true
}

function normalizeDocuments(docs) {
  if (!Array.isArray(docs)) return null
  const normalized = []
  const paths = new Set()
  for (const doc of docs) {
    if (
      !doc ||
      typeof doc !== "object" ||
      Array.isArray(doc) ||
      typeof doc.path !== "string" ||
      typeof doc.hash !== "string"
    ) {
      return null
    }
    const path = canonicalDocumentPath(doc.path)
    if (paths.has(path)) return null
    paths.add(path)
    normalized.push({
      path,
      hash: canonicalDocumentHash(doc.hash),
    })
  }
  return normalized.sort((left, right) =>
    compareDocumentPaths(left.path, right.path)
  )
}

function documentMap(docs) {
  const normalized = normalizeDocuments(docs)
  if (normalized === null) return null
  return new Map(normalized.map((doc) => [doc.path, doc.hash]))
}
