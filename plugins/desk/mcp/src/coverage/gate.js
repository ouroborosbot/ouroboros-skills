import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import * as path from "node:path"

const COVERAGE_SCRIPT = "node scripts/run-coverage.js"
const REQUIRED_WORKFLOW_PATH_FILTER = "scripts/*.cjs"
const REQUIRED_WORKFLOW_EVENTS = ["pull_request", "push"]
const REQUIRED_ROOT_VALIDATION_SCRIPTS = new Set([
  "scripts/test-desk-docs.cjs",
  "scripts/test-desk-generated-artifacts.cjs",
])
const DEFAULT_THRESHOLDS = {
  lines: 100,
  branches: 100,
  functions: 100,
  statements: 100,
}

export function evaluateCoverageReport({
  repoRoot,
  reportPath,
  requiredFiles,
  exclusions = [],
  thresholds = DEFAULT_THRESHOLDS,
}) {
  const issues = []
  const checkedFiles = []
  const excludedFiles = []
  const normalizedRequired = normalizePathList(requiredFiles)

  if (!existsSync(reportPath)) {
    return {
      ok: false,
      issues: [`coverage report is missing: ${reportPath}`],
      checkedFiles,
      excludedFiles,
    }
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8"))
  const reportEntries = normalizeReportEntries(repoRoot, report)
  const exclusionMap = normalizeExclusions(exclusions)

  for (const file of normalizedRequired) {
    const exclusion = exclusionMap.get(file)
    if (exclusion) {
      if (!hasText(exclusion.owner) || !hasText(exclusion.reason)) {
        issues.push(`coverage exclusion for ${file} requires owner and reason`)
      } else {
        excludedFiles.push(file)
      }
      continue
    }

    checkedFiles.push(file)
    const entry = reportEntries.get(file)
    if (!entry) {
      issues.push(`missing coverage for ${file}`)
      continue
    }

    for (const metric of Object.keys(thresholds)) {
      const pct = entry?.[metric]?.pct
      if (typeof pct !== "number" || pct < thresholds[metric]) {
        issues.push(
          `${file} ${metric} coverage ${String(pct)} is below ${thresholds[metric]}`,
        )
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    checkedFiles,
    excludedFiles,
  }
}

export function assertCoverageCommandParity({ packageJsonPath, workflowPath }) {
  const issues = []
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"))
  const script = packageJson.scripts?.["test:coverage"]
  if (script !== COVERAGE_SCRIPT) {
    issues.push(`package.json test:coverage must be ${COVERAGE_SCRIPT}; got ${script}`)
  }

  const workflow = readFileSync(workflowPath, "utf8")
  if (!workflow.includes("npm run test:coverage")) {
    issues.push("desk MCP CI must run npm run test:coverage")
  }
  if (/run:\s*npm test\b/.test(workflow)) {
    issues.push("desk MCP CI still runs npm test instead of npm run test:coverage")
  }
  const pathFilters = extractWorkflowPathFilters(workflow)
  for (const eventName of REQUIRED_WORKFLOW_EVENTS) {
    const eventPaths = pathFilters.get(eventName) ?? []
    if (!eventPaths.includes(REQUIRED_WORKFLOW_PATH_FILTER)) {
      issues.push(
        `desk MCP CI ${eventName}.paths must include ${REQUIRED_WORKFLOW_PATH_FILTER}`,
      )
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  }
}

export function collectCoverageRequiredFiles({ repoRoot }) {
  return normalizePathList([
    ...collectFiles(path.join(repoRoot, "plugins", "desk", "mcp"), ".js")
      .filter((file) => isDirectChild(file, path.join(repoRoot, "plugins", "desk", "mcp")))
      .filter(isProductionJs),
    ...collectFiles(path.join(repoRoot, "plugins", "desk", "mcp", "src"), ".js")
      .filter(isProductionJs),
    ...collectFiles(path.join(repoRoot, "plugins", "desk", "mcp", "src"), ".cjs")
      .filter(isProductionCjs),
    ...collectFiles(path.join(repoRoot, "plugins", "desk", "mcp", "scripts"), ".js")
      .filter(isProductionJs),
    ...collectFiles(path.join(repoRoot, "scripts"), ".cjs")
      .filter(isProductionCjs),
  ].map((file) => normalizeRelative(repoRoot, file)))
}

function normalizePathList(files) {
  return [...new Set(files.map((file) => normalizePath(file)))].sort()
}

function normalizeReportEntries(repoRoot, report) {
  const entries = new Map()
  for (const [rawFile, metrics] of Object.entries(report)) {
    if (rawFile === "total") continue
    const file = path.isAbsolute(rawFile)
      ? normalizeRelative(repoRoot, rawFile)
      : normalizePath(rawFile)
    entries.set(file, metrics)
  }
  return entries
}

function normalizeExclusions(exclusions) {
  const out = new Map()
  for (const exclusion of exclusions) {
    out.set(normalizePath(exclusion.path ?? ""), exclusion)
  }
  return out
}

function extractWorkflowPathFilters(workflow) {
  const filters = new Map()
  const stack = []
  for (const line of workflow.split("\n")) {
    const clean = stripYamlComment(line)
    if (!clean.trim()) continue
    const indent = clean.match(/^ */)[0].length
    const trimmed = clean.trim()

    if (trimmed.startsWith("- ")) {
      const keys = stack.map((entry) => entry.key)
      if (keys.at(-1) === "paths" && keys.at(-3) === "on") {
        const eventName = keys.at(-2)
        if (REQUIRED_WORKFLOW_EVENTS.includes(eventName)) {
          const existing = filters.get(eventName) ?? []
          existing.push(unquoteYamlScalar(trimmed.slice(2).trim()))
          filters.set(eventName, existing)
        }
      }
      continue
    }

    const keyMatch = trimmed.match(/^(['"]?)([A-Za-z0-9_-]+)\1:\s*(?:.*)?$/)
    if (!keyMatch) continue
    while (stack.length && stack.at(-1).indent >= indent) stack.pop()
    stack.push({ indent, key: keyMatch[2] })
  }
  return filters
}

function collectFiles(dir, extension) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry)
    const stat = statSync(file)
    if (stat.isDirectory()) {
      out.push(...collectFiles(file, extension))
    } else if (stat.isFile() && file.endsWith(extension)) {
      out.push(file)
    }
  }
  return out
}

function isProductionJs(file) {
  const normalized = normalizePath(file)
  return (
    !normalized.includes("/__tests__/") &&
    !normalized.endsWith(".test.js") &&
    !path.basename(normalized).startsWith("test-")
  )
}

function isProductionCjs(file) {
  const normalized = normalizePath(file)
  return isRequiredRootValidationScript(normalized) ||
    !path.basename(normalized).startsWith("test-")
}

function isRequiredRootValidationScript(normalizedPath) {
  return [...REQUIRED_ROOT_VALIDATION_SCRIPTS].some((script) =>
    normalizedPath === script || normalizedPath.endsWith(`/${script}`),
  )
}

function isDirectChild(file, dir) {
  return path.dirname(file) === dir
}

function normalizeRelative(root, file) {
  return normalizePath(path.relative(root, file))
}

function normalizePath(file) {
  return file.replaceAll(path.sep, "/")
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0
}

function stripYamlComment(line) {
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if ((char === "\"" || char === "'") && line[index - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char
    }
    if (char === "#" && !quote) return line.slice(0, index)
  }
  return line
}

function unquoteYamlScalar(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}
