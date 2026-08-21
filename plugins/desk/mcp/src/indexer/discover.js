// discover.js — walk a desk root and enumerate the .md files that get indexed.
//
// Every allowed Markdown file is in scope after gitignore, sensitive-path, hidden-path, node_modules, .state, .git, and .bak exclusions. Specialized path shapes keep stable kinds; unmatched Markdown is indexed as reference. Docs under any _archive/ ancestor are indexed but flagged `is_archived: true` so search tools can scope them in or out.
//
// 1.1 rationale: archive = preserve for future recall, not delete. The
// reason we move things to _archive/ is precisely so we can come back to
// them later — making them searchable is the whole point. v1.0 erroneously
// skipped archive at index time, which made historical recall impossible.
// 1.1 indexes everything; per-tool defaults in search.js decide whether
// archive is included by default (desk_recall: yes, desk_search: no).
//
// For each match we compute kind/track/task_slug from the path shape, parse
// frontmatter (tolerant — falls back to {} on parse failure), hash the
// contents (sha256) for dirty-detection, and capture mtime as document
// metadata.

import { promises as fs } from "node:fs"
import { createHash } from "node:crypto"
import * as path from "node:path"
import matter from "gray-matter"
import {
  exclusionForPath,
  loadExclusionRules,
} from "./exclusions.js"
import { canonicalDocumentPath } from "./document-tree.js"

export const DISCOVERY_GRAMMAR_VERSION = 2

/** Filenames we always pick up regardless of where they sit in the tree. */
const TASK_DOC_BASENAMES = new Set([
  "task.md",
  "planning.md",
  "doing.md",
  "feedback.md",
])

/** Directory names that short-circuit recursion (we never descend in). */
const SKIP_DIRS = new Set([
  "node_modules",
  ".state",
  ".git",
])

function splitPathSegments(relPath) {
  return String(relPath).split(/[\\/]/u)
}

/**
 * Shared-workspace transparency: under the `--person <alias>` write-prefix,
 * docs live at `desks/<alias>/<rest…>`. Strip the two leading `desks/<alias>`
 * segments so isIndexable/classify operate on the same path shapes they always
 * have. A bare `desks/` with nothing after the alias is left untouched (no
 * meaningful doc lives directly at `desks/<alias>`). Pure + idempotent —
 * top-level (OFF-mode) paths pass through unchanged because they don't start
 * with `desks/`.
 *
 * Exposed for tests.
 */
export function stripPersonPrefix(relPath) {
  const segments = splitPathSegments(relPath)
  if (segments.length > 2 && segments[0] === "desks") {
    return segments.slice(2).join(path.sep)
  }
  return relPath
}

/**
 * Walk `deskRoot` and return an array of indexable doc descriptors.
 *
 * @param {string} deskRoot — absolute path to desk workspace.
 * @returns {Promise<Array<DocDescriptor>>}
 *
 * Each descriptor: { path (relative), absPath, kind, track, task_slug,
 *                    status, schema_version, created_at, updated_at,
 *                    hash, mtime, frontmatter, body }
 */
export async function discover(deskRoot, { signal } = {}) {
  return collectDocuments(deskRoot, describeDoc, { signal })
}

export async function discoverStatInventory(deskRoot, { signal } = {}) {
  return collectDocuments(deskRoot, describeStat, { signal })
}

async function collectDocuments(deskRoot, describe, { signal } = {}) {
  throwIfAborted(signal)
  const results = []
  const exclusionRules = await loadExclusionRules({ deskRoot })
  await walk(deskRoot, deskRoot, results, signal, exclusionRules, describe)
  throwIfAborted(signal)
  results.sort((a, b) => a.path.localeCompare(b.path))
  return results
}

async function walk(deskRoot, dir, out, signal, exclusionRules, describe) {
  throwIfAborted(signal)
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === "ENOENT") return
    throw err
  }
  throwIfAborted(signal)
  for (const ent of entries) {
    throwIfAborted(signal)
    const name = ent.name
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue
      // 1.1: archive dirs DO get walked. Docs under them are flagged
      // is_archived=true in describeDoc and per-tool search defaults
      // decide whether to include them.
      const sub = path.join(dir, name)
      const relDir = canonicalDocumentPath(path.relative(deskRoot, sub))
      if (shouldSkipDirectory(relDir, exclusionRules)) continue
      await walk(deskRoot, sub, out, signal, exclusionRules, describe)
      continue
    }
    if (!ent.isFile()) continue
    if (name.endsWith(".bak")) continue
    if (!name.endsWith(".md")) continue

    const abs = path.join(dir, name)
    const rel = canonicalDocumentPath(path.relative(deskRoot, abs))
    if (isExcluded(rel, exclusionRules)) continue

    const desc = await describe(deskRoot, abs, rel, signal)
    if (desc) out.push(desc)
  }
}

function isExcluded(relPath, rules) {
  return exclusionForPath(relPath, rules).excluded
}

function shouldSkipDirectory(relPath, rules) {
  return exclusionForPath(relPath, rules).excluded
}

/**
 * Decide whether a relative path is Markdown that can be indexed. Exposed for tests. Filesystem/privacy exclusions run before this function.
 */
export function isIndexable(relPath) {
  const segments = splitPathSegments(relPath)
  const base = segments[segments.length - 1]
  return base.endsWith(".md")
}

/**
 * Classify a relative path. Pure function — exposed for tests.
 *
 * @returns {{ kind: string, track: string|null, task_slug: string|null }}
 */
export function classify(relPath) {
  // Shared-workspace facts/decisions: `_shared/**.md` is team-neutral content
  // (read by everyone, owned by no single desk). Report kind=shared,
  // track-less. Checked against the raw relPath because `_shared/` lives at
  // the repo root, not under any `desks/<alias>/` prefix.
  const rawSegments = splitPathSegments(relPath)
  if (rawSegments[0] === "_shared" && rawSegments.length > 1) {
    return { kind: "shared", track: null, task_slug: null }
  }

  // Remap-transparency: attribute against the desk-relative remainder, so a
  // doc at `desks/<alias>/<track>/<slug>/task.md` reports track=<track>, not
  // "desks". OFF-mode top-level paths pass through unchanged.
  const segments = splitPathSegments(stripPersonPrefix(relPath))
  const base = segments[segments.length - 1]

  if (TASK_DOC_BASENAMES.has(base)) {
    // task docs always live at <track>/<slug>/<base>.
    if (segments.length >= 3) {
      const track = segments[0]
      const task_slug = segments[segments.length - 2]
      const kind = base.replace(/\.md$/, "")
      return { kind, track, task_slug }
    }
    return { kind: base.replace(/\.md$/, ""), track: null, task_slug: null }
  }

  if (base === "track.md" && segments.length === 2) {
    return { kind: "track", track: segments[0], task_slug: null }
  }

  // 1.1: archived legacy filenames. Infer kind from the basename pattern
  // (`<date>-planning-<topic>.md`, `<date>-doing-<topic>.md`); fall back to
  // `archive` for anything else.
  const underArchive = segments.some((s) => s === "_archive" || s.startsWith("_archive"))
  if (underArchive && base.endsWith(".md")) {
    const stem = base.replace(/\.md$/, "")
    let kind = "archive"
    if (/-planning-/.test(stem) || stem.startsWith("planning-")) kind = "planning"
    else if (/-doing-/.test(stem) || stem.startsWith("doing-")) kind = "doing"
    else if (/-feedback-/.test(stem) || stem.startsWith("feedback-")) kind = "feedback"
    return { kind, track: null, task_slug: null }
  }

  // Lessons under _meta/tips/.
  if (segments.includes("_meta") && segments.includes("tips")) {
    return { kind: "lesson", track: null, task_slug: null }
  }

  // Cross-cutting friction: _meta/friction.md.
  if (segments[0] === "_meta" && base === "friction.md") {
    return { kind: "friction", track: null, task_slug: null }
  }

  // Track-local friction: <track>/_friction/<file>.md.
  const fricIdx = segments.indexOf("_friction")
  if (fricIdx > 0) {
    return { kind: "friction", track: segments[0], task_slug: null }
  }

  return { kind: "reference", track: null, task_slug: null }
}

async function describeDoc(deskRoot, abs, rel, signal) {
  throwIfAborted(signal)
  let raw
  let stat
  try {
    raw = await fs.readFile(abs, "utf8")
    throwIfAborted(signal)
    stat = await fs.stat(abs)
  } catch (err) {
    if (err.name === "AbortError") throw err
    // File vanished or unreadable mid-walk; skip silently.
    return null
  }

  throwIfAborted(signal)
  let parsed
  try {
    parsed = matter(raw)
  } catch {
    // Malformed frontmatter — index anyway, just with empty metadata.
    parsed = { data: {}, content: raw }
  }
  const fm = parsed.data
  const body = parsed.content
  const hash = createHash("sha256").update(raw).digest("hex")
  const { kind, track, task_slug } = classify(rel)
  // is_archived: any ancestor directory in the path is named `_archive`
  // (or starts with `_archive`). Matches the v1.0 skip predicate but
  // now stored as a flag instead of an exclusion.
  const segments = splitPathSegments(rel)
  const is_archived = segments
    .slice(0, -1) // exclude the filename itself
    .some((s) => s === "_archive" || s.startsWith("_archive"))

  return {
    path: rel,
    absPath: abs,
    kind,
    track,
    task_slug,
    status: typeof fm.status === "string" ? fm.status : null,
    schema_version:
      typeof fm.schema_version === "number" ? fm.schema_version : 0,
    created_at: normalizeDate(fm.created ?? fm.created_at ?? null),
    updated_at: normalizeDate(fm.updated ?? fm.updated_at ?? null),
    hash,
    mtime: Math.floor(stat.mtimeMs),
    is_archived,
    frontmatter: fm,
    body,
    raw,
  }
}

async function describeStat(_deskRoot, abs, rel, signal) {
  throwIfAborted(signal)
  try {
    const stat = await fs.stat(abs)
    throwIfAborted(signal)
    return {
      path: rel,
      mtime: Math.floor(stat.mtimeMs),
    }
  } catch (err) {
    if (err.name === "AbortError") throw err
    return null
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const err = new Error("operation aborted")
  err.name = "AbortError"
  throw err
}

/**
 * Normalize a frontmatter date value to a string. gray-matter (via js-yaml)
 * eagerly parses unquoted ISO-shaped dates (e.g. `2026-05-01`) into Date
 * objects; we want the on-disk representation as a string so SQLite stores a
 * stable TEXT value and downstream comparisons stay string-based.
 *
 * Exposed for tests.
 */
export function normalizeDate(value) {
  if (value == null) return null
  if (value instanceof Date) {
    // YYYY-MM-DD when the original looked date-only (midnight UTC), else
    // full ISO. The heuristic: if time component is exactly midnight UTC,
    // emit YYYY-MM-DD; gray-matter parses bare date-only strings to that.
    const iso = value.toISOString()
    if (iso.endsWith("T00:00:00.000Z")) return iso.slice(0, 10)
    return iso
  }
  if (typeof value === "string") return value
  return String(value)
}
