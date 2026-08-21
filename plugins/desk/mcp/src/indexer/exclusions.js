import { promises as fs } from "node:fs"
import * as path from "node:path"

const GITIGNORE_PATH = ".gitignore"
const SKIP_GITIGNORE_SCAN_DIRS = new Set([
  "node_modules",
  ".state",
  ".git",
])
const SENSITIVE_SEGMENTS = new Set([
  ".env",
  "api-keys",
  "api_keys",
  "credential",
  "credentials",
  "private",
  "secret",
  "secrets",
])
const SENSITIVE_NAME_RE = /(?:^|[-_.])(api[-_]?key|credential|credentials|private[-_]?key|secret|secrets)(?:[-_.]|$)/u
const POSIX_CHARACTER_CLASSES = Object.freeze({
  alnum: "A-Za-z0-9",
  alpha: "A-Za-z",
  blank: " \\t",
  cntrl: "\\x00-\\x1F\\x7F",
  digit: "0-9",
  graph: "\\x21-\\x2E\\x30-\\x7E",
  lower: "a-z",
  print: "\\x20-\\x2E\\x30-\\x7E",
  punct: "\\x21-\\x2E\\x3A-\\x40\\x5B-\\x60\\x7B-\\x7E",
  space: " \\t\\r\\n\\v\\f",
  upper: "A-Z",
  xdigit: "A-Fa-f0-9",
})

export async function loadExclusionRules({ deskRoot } = {}) {
  if (!deskRoot) return { gitignore: [] }
  const gitignore = []
  await collectGitignoreRules(deskRoot, "", gitignore)
  return {
    gitignore,
  }
}

export function exclusionForPath(relPath, rules = {}) {
  const normalized = normalizeRelPath(relPath)
  if (matchesGitignore(normalized, rules.gitignore ?? [])) {
    return { excluded: true, reason: "gitignore" }
  }
  if (isSensitivePath(normalized)) {
    return { excluded: true, reason: "sensitive_path" }
  }
  if (isHiddenPath(normalized)) {
    return { excluded: true, reason: "hidden_path" }
  }
  return { excluded: false, reason: null }
}

export function hasGitignoreNegation(rules = {}) {
  return (rules.gitignore ?? [])
    .some((rule) => normalizeGitignoreRule(rule).negated)
}

export async function assertArtifactInputsAllowed({
  deskRoot,
  artifact_type,
  docs = [],
  rules,
} = {}) {
  if (!Array.isArray(docs) || docs.length === 0) {
    throw artifactInputUnknownError(artifact_type)
  }
  if (typeof deskRoot !== "string" || deskRoot.trim() === "") {
    throw artifactInputUnknownError(artifact_type)
  }
  for (const doc of docs) {
    if (!hasKnownRelativeDocPath(doc)) {
      throw artifactInputUnknownError(artifact_type)
    }
  }
  const resolvedRules = rules ?? await loadExclusionRules({ deskRoot })
  const reasons = new Set()
  let excludedCount = 0
  for (const doc of docs) {
    const decision = exclusionForPath(doc.path, resolvedRules)
    if (!decision.excluded) continue
    excludedCount += 1
    reasons.add(decision.reason)
  }
  if (excludedCount === 0) return { allowed: true }

  const error = new Error("artifact input includes excluded documents")
  error.code = "artifact_input_excluded"
  error.artifact_type = artifact_type
  error.excluded_count = excludedCount
  error.reasons = reasons
  throw error
}

function artifactInputUnknownError(artifact_type) {
  const error = new Error("artifact input source documents are required")
  error.code = "artifact_input_unknown"
  error.artifact_type = artifact_type
  return error
}

function hasKnownRelativeDocPath(doc) {
  if (doc == null) return false
  if (typeof doc !== "object") return false
  if (Array.isArray(doc)) return false
  if (typeof doc.path !== "string") return false
  const rawPath = doc.path.trim()
  if (rawPath === "") return false
  if (path.isAbsolute(rawPath)) return false
  if (path.win32.isAbsolute(rawPath)) return false
  return true
}

async function collectGitignoreRules(deskRoot, baseDir, out) {
  const gitignore = await readGitignoreAtBase(deskRoot, baseDir)
  if (!gitignore.valid) {
    const error = new Error("gitignore exclusion rules could not be read")
    error.code = "exclusion_rules_unavailable"
    error.reason = "gitignore_unreadable"
    throw error
  }
  out.push(...parseGitignore(gitignore.body, baseDir))

  const dir = baseDir ? path.join(deskRoot, baseDir) : deskRoot
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") return
    throw error
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (SKIP_GITIGNORE_SCAN_DIRS.has(entry.name)) continue
    const relDir = joinRel(baseDir, entry.name)
    if (isSensitivePath(relDir) || isHiddenPath(relDir)) continue
    await collectGitignoreRules(deskRoot, relDir, out)
  }
}

async function readGitignoreAtBase(deskRoot, baseDir) {
  const gitignorePath = path.join(deskRoot, baseDir, GITIGNORE_PATH)
  let stat
  try {
    stat = await fs.stat(gitignorePath)
  } catch (error) {
    if (error.code === "ENOENT") return { valid: true, body: "" }
    return { valid: false, body: "" }
  }
  if (!stat.isFile()) return { valid: false, body: "" }
  try {
    return {
      valid: true,
      body: await fs.readFile(gitignorePath, "utf8"),
    }
  } catch (error) {
    return { valid: false, body: "" }
  }
}

function parseGitignore(raw, baseDir = "") {
  return raw
    .split(/\r?\n/u)
    .map((line) => parseGitignoreLine(line, baseDir))
    .filter(Boolean)
}

function parseGitignoreLine(line, baseDir) {
  const normalizedLine = stripUnescapedTrailingSpaces(line)
  if (normalizedLine === "") return null
  let negated = false
  let pattern = normalizedLine
  if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) {
    pattern = pattern.slice(1)
  } else if (pattern.startsWith("#")) {
    return null
  } else if (pattern.startsWith("!")) {
    negated = true
    pattern = pattern.slice(1)
  }
  if (pattern === "") return null
  validateGitignorePattern(pattern)
  return {
    baseDir: normalizeRelPath(baseDir),
    pattern,
    negated,
  }
}

function validateGitignorePattern(pattern, match = matchesGitignorePattern) {
  try {
    match("", pattern)
  } catch (error) {
    if (error?.code === "exclusion_rules_unavailable") throw error
    throw unsupportedGitignorePatternError()
  }
}

function matchesGitignore(relPath, patterns) {
  const segments = normalizeRelPath(relPath).split("/").filter(Boolean)
  for (let end = 1; end <= segments.length; end += 1) {
    const candidate = segments.slice(0, end).join("/")
    let excluded = false
    for (const pattern of patterns) {
      const rule = normalizeGitignoreRule(pattern)
      if (matchesGitignoreRule(candidate, rule)) {
        excluded = !rule.negated
      }
    }
    if (excluded) return true
  }
  return false
}

function normalizeGitignoreRule(rule) {
  if (rule != null && typeof rule === "object" && !Array.isArray(rule)) {
    return {
      baseDir: normalizeRelPath(rule.baseDir),
      pattern: rule.pattern,
      negated: rule.negated === true,
    }
  }
  const raw = String(rule ?? "")
  const negated = raw.startsWith("!")
  return {
    baseDir: "",
    pattern: negated ? raw.slice(1).trim() : raw,
    negated,
  }
}

function matchesGitignoreRule(relPath, rule) {
  const baseDir = normalizeRelPath(rule.baseDir)
  if (baseDir && relPath !== baseDir && !relPath.startsWith(`${baseDir}/`)) {
    return false
  }
  const relFromBase = baseDir && relPath !== baseDir
    ? relPath.slice(baseDir.length + 1)
    : baseDir ? "" : relPath
  return matchesGitignorePattern(relFromBase, rule.pattern)
}

function matchesGitignorePattern(relPath, pattern) {
  const rawPattern = normalizePattern(pattern)
  const anchored = rawPattern.startsWith("/")
  const normalizedPattern = rawPattern.replace(/^\/+/u, "")
  if (normalizedPattern === "") return false
  if (normalizedPattern.endsWith("/")) {
    const prefix = normalizedPattern.replace(/\/+$/u, "")
    if (!anchored && !prefix.includes("/")) {
      return pathContainsMatchingSegment(relPath, prefix)
    }
    return relPath === prefix || relPath.startsWith(`${prefix}/`)
  }
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3)
    return relPath === prefix || relPath.startsWith(`${prefix}/`)
  }
  if (anchored && !normalizedPattern.includes("/")) {
    return firstSegmentMatches(relPath, normalizedPattern)
  }
  if (!anchored && !normalizedPattern.includes("/")) {
    return pathContainsMatchingSegment(relPath, normalizedPattern)
  }
  return globPathToRegExp(normalizedPattern).test(relPath)
}

function firstSegmentMatches(relPath, pattern) {
  const [firstSegment] = relPath.split("/").filter(Boolean)
  return firstSegment != null && globSegmentToRegExp(pattern).test(firstSegment)
}

function pathContainsMatchingSegment(relPath, pattern) {
  const segmentPattern = globSegmentToRegExp(pattern)
  return relPath
    .split("/")
    .filter(Boolean)
    .some((segment) => segmentPattern.test(segment))
}

function isSensitivePath(relPath) {
  return relPath
    .split("/")
    .filter(Boolean)
    .some((segment) => {
      const lower = segment.toLowerCase()
      return SENSITIVE_SEGMENTS.has(lower) || SENSITIVE_NAME_RE.test(lower)
    })
}

function isHiddenPath(relPath) {
  return relPath
    .split("/")
    .filter(Boolean)
    .some((segment) => segment.startsWith("."))
}

function globPathToRegExp(pattern) {
  return new RegExp(`^${globToRegexSource(pattern, { pathPattern: true })}$`, "u")
}

function globSegmentToRegExp(pattern) {
  return new RegExp(`^${globToRegexSource(pattern)}$`, "u")
}

function globToRegexSource(pattern, { pathPattern = false } = {}) {
  let source = ""
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === "\\") {
      const next = pattern[index + 1]
      if (next === undefined) {
        source += "\\\\"
      } else {
        source += escapeRegExp(next)
        index += 1
      }
      continue
    }
    if (char === "*") {
      let end = index + 1
      while (pattern[end] === "*") end += 1
      const doubleStar =
        pathPattern &&
        end - index >= 2 &&
        (index === 0 || pattern[index - 1] === "/") &&
        (end === pattern.length || pattern[end] === "/")
      if (doubleStar && pattern[end] === "/") {
        source += "(?:[^/]+/)*"
        index = end
      } else if (doubleStar) {
        source += ".*"
        index = end - 1
      } else {
        source += "[^/]*"
        index = end - 1
      }
      continue
    }
    if (char === "?") {
      source += "[^/]"
      continue
    }
    if (char === "[") {
      const characterClass = parseCharacterClass(pattern, index)
      if (characterClass !== null) {
        source += characterClass.source
        index = characterClass.end
        continue
      }
    }
    source += escapeRegExp(char)
  }
  return source
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

function normalizeRelPath(relPath) {
  return String(relPath ?? "")
    .replace(/\\/gu, "/")
    .replace(/^\/+/u, "")
}

function normalizePattern(pattern) {
  return String(pattern ?? "")
}

function joinRel(baseDir, name) {
  return baseDir ? `${normalizeRelPath(baseDir)}/${name}` : name
}

function parseCharacterClass(pattern, start) {
  let cursor = start + 1
  if (pattern[cursor] === "!" || pattern[cursor] === "^") cursor += 1
  if (pattern[cursor] === "]") cursor += 1
  let end = cursor
  while (end < pattern.length) {
    if (pattern.startsWith("[:", end)) {
      const posixEnd = pattern.indexOf(":]", end + 2)
      if (posixEnd === -1) throw unsupportedGitignorePatternError()
      end = posixEnd + 2
      continue
    }
    if (pattern.startsWith("[.", end) || pattern.startsWith("[=", end)) {
      throw unsupportedGitignorePatternError()
    }
    if (pattern[end] === "]") break
    if (pattern[end] === "\\" && end + 1 < pattern.length) end += 1
    end += 1
  }
  if (end >= pattern.length || end === start + 1) return null
  let body = pattern.slice(start + 1, end)
  let negated = false
  if (body.startsWith("!") || body.startsWith("^")) {
    negated = true
    body = body.slice(1)
  }
  const escapedBody = translateCharacterClassBody(body)
  return {
    source: negated ? `[^/${escapedBody}]` : `[${escapedBody}]`,
    end,
  }
}

function translateCharacterClassBody(body) {
  let source = ""
  for (let index = 0; index < body.length; index += 1) {
    if (body.startsWith("[:", index)) {
      const end = body.indexOf(":]", index + 2)
      if (end === -1) throw unsupportedGitignorePatternError()
      const name = body.slice(index + 2, end)
      const characterClass = POSIX_CHARACTER_CLASSES[name]
      if (characterClass === undefined) throw unsupportedGitignorePatternError()
      source += characterClass
      index = end + 1
      continue
    }
    const char = body[index]
    if (char === "/") throw unsupportedGitignorePatternError()
    if (char === "\\") {
      const next = body[index + 1]
      source += next.replace(/[\\\]^\-]/gu, "\\$&")
      index += 1
      continue
    }
    source += escapeCharacterClassLiteral(char)
  }
  return source
}

function escapeCharacterClassLiteral(value) {
  return value.replace(/[\\\]^]/gu, "\\$&")
}

function unsupportedGitignorePatternError() {
  const error = new Error("gitignore exclusion rules use an unsupported pattern")
  error.code = "exclusion_rules_unavailable"
  error.reason = "gitignore_unsupported"
  return error
}

function stripUnescapedTrailingSpaces(line) {
  let end = line.length
  while (end > 0 && line[end - 1] === " ") {
    let backslashes = 0
    for (let index = end - 2; index >= 0 && line[index] === "\\"; index -= 1) {
      backslashes += 1
    }
    if (backslashes % 2 === 1) break
    end -= 1
  }
  return line.slice(0, end)
}

export const __exclusionInternalsForTests = {
  globToRegexSource,
  parseCharacterClass,
  stripUnescapedTrailingSpaces,
  translateCharacterClassBody,
  validateGitignorePattern,
}
