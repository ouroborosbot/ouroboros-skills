import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"

import {
  canonicalDocumentHash,
  canonicalDocumentPath,
  compareDocumentPaths,
  documentStatInventoryHash,
  documentTreeHash,
  documentTreesEqual,
  representedDocumentTreeHash,
} from "../../src/indexer/document-tree.js"

function expectedHash(docs) {
  const hash = createHash("sha256")
  for (const doc of docs) {
    hash.update(`${doc.path}\0${doc.hash}\0`)
  }
  return `sha256:${hash.digest("hex")}`
}

test("document tree canonicalization is portable and deterministic", () => {
  assert.equal(canonicalDocumentPath("track\\task.md"), "track/task.md")
  assert.equal(canonicalDocumentPath(null), "")
  assert.equal(canonicalDocumentHash("a".repeat(64)), `sha256:${"a".repeat(64)}`)
  assert.equal(
    canonicalDocumentHash(`sha256:${"b".repeat(64)}`),
    `sha256:${"b".repeat(64)}`,
  )
  assert.equal(canonicalDocumentHash(null), "sha256:")
  assert.equal(compareDocumentPaths("a.md", "b.md"), -1)
  assert.equal(compareDocumentPaths("b.md", "a.md"), 1)
  assert.equal(compareDocumentPaths("a\\b.md", "a/b.md"), 0)

  const docs = [
    { path: "z\\doc.md", hash: "a".repeat(64) },
    { path: "a.md", hash: `sha256:${"b".repeat(64)}` },
  ]
  const expected = expectedHash([
    { path: "a.md", hash: `sha256:${"b".repeat(64)}` },
    { path: "z/doc.md", hash: `sha256:${"a".repeat(64)}` },
  ])
  assert.equal(representedDocumentTreeHash(docs), expected)
  assert.equal(documentTreeHash(docs), expected)
})

test("represented document tree hashing rejects malformed and duplicate entries", () => {
  for (const docs of [
    null,
    [null],
    ["invalid"],
    [[]],
    [{ path: 1, hash: "a" }],
    [{ path: "a.md", hash: 1 }],
    [
      { path: "a/b.md", hash: "a" },
      { path: "a\\b.md", hash: "a" },
    ],
  ]) {
    assert.equal(representedDocumentTreeHash(docs), null)
  }
  assert.throws(
    () => documentTreeHash(null),
    /document tree requires path\/hash document entries/u,
  )
})

test("stat inventory hashing is canonical across ordering and separators", () => {
  const expected = createHash("sha256")
    .update(
      `a.md\0${10}\0${10.1}\0${11.1}\0${12}\0` +
      `z/doc.md\0${20}\0${20.9}\0${21.9}\0${22}\0`,
    )
    .digest("hex")

  assert.equal(
    documentStatInventoryHash([
      {
        path: "z\\doc.md",
        mtime: 20,
        mtime_ms: 20.9,
        ctime_ms: 21.9,
        size: 22,
      },
      {
        path: "a.md",
        mtime: 10,
        mtime_ms: 10.1,
        ctime_ms: 11.1,
        size: 12,
      },
    ]),
    `sha256:${expected}`,
  )
  assert.equal(
    documentStatInventoryHash([]),
    `sha256:${createHash("sha256").digest("hex")}`,
  )
})

test("stat inventory hashing rejects malformed and duplicate entries", () => {
  for (const docs of [
    null,
    [null],
    ["invalid"],
    [[]],
    [{ path: 1, mtime: 1, mtime_ms: 1, ctime_ms: 1, size: 1 }],
    [{ path: "", mtime: 1, mtime_ms: 1, ctime_ms: 1, size: 1 }],
    [{ path: "a.md", mtime: "1", mtime_ms: 1, ctime_ms: 1, size: 1 }],
    [{ path: "a.md", mtime: 1, mtime_ms: Number.NaN, ctime_ms: 1, size: 1 }],
    [{ path: "a.md", mtime: 1, mtime_ms: 1, ctime_ms: Number.NaN, size: 1 }],
    [{ path: "a.md", mtime: 1, mtime_ms: 1, ctime_ms: 1, size: Number.NaN }],
    [
      { path: "a/b.md", mtime: 1, mtime_ms: 1, ctime_ms: 1, size: 1 },
      { path: "a\\b.md", mtime: 2, mtime_ms: 2, ctime_ms: 2, size: 2 },
    ],
  ]) {
    assert.equal(documentStatInventoryHash(docs), null)
  }
})

test("document tree equality ignores ordering and separators but rejects drift", () => {
  const left = [
    { path: "z\\doc.md", hash: "a".repeat(64) },
    { path: "a.md", hash: `sha256:${"b".repeat(64)}` },
  ]
  const right = [
    { path: "a.md", hash: "b".repeat(64) },
    { path: "z/doc.md", hash: `sha256:${"a".repeat(64)}` },
  ]
  assert.equal(documentTreesEqual(left, right), true)
  assert.equal(documentTreesEqual(left, right.slice(1)), false)
  assert.equal(
    documentTreesEqual(left, right.map((doc, index) =>
      index === 0 ? { ...doc, hash: "c".repeat(64) } : doc
    )),
    false,
  )
  assert.equal(documentTreesEqual(null, right), false)
  assert.equal(documentTreesEqual(left, null), false)
})
