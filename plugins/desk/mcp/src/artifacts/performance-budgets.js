import { promises as fs } from "node:fs"
import * as path from "node:path"

export const DEFAULT_PERFORMANCE_BUDGETS = Object.freeze({
  schema_version: 1,
  search: Object.freeze({
    semantic_repair_batch_chunks: 100,
    semantic_repair_batch_ms: 5000,
  }),
  startup: Object.freeze({
    ensure_index_ms: 250,
    snapshot_restore_ms: 250,
    vector_pack_import_ms: 250,
  }),
  rebuild: Object.freeze({
    vector_pack_rebuild_ms: 1000,
    snapshot_build_ms: 1000,
  }),
  artifacts: Object.freeze({
    snapshot_verify_ms: 1000,
    validate_ms: 1000,
  }),
})

export async function loadPerformanceBudgets({
  configPath,
  mcpRoot,
  fsReadFile = fs.readFile,
} = {}) {
  const resolvedConfigPath = configPath ?? path.join(requiredPath(mcpRoot, "mcpRoot"), "config", "performance-budgets.json")
  let raw
  try {
    raw = await fsReadFile(resolvedConfigPath, "utf8")
  } catch (error) {
    if (error.code === "ENOENT" && !configPath) {
      return cloneBudgets(DEFAULT_PERFORMANCE_BUDGETS)
    }
    throw budgetConfigError("performance budget config could not be read")
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw budgetConfigError("performance budget config must be valid JSON")
  }

  validateBudgets(parsed)
  return {
    ...parsed,
    search: {
      ...DEFAULT_PERFORMANCE_BUDGETS.search,
      ...parsed.search,
    },
  }
}

export function budgetValue(budgets, section, key) {
  const value = budgets?.[section]?.[key]
  if (!Number.isInteger(value) || value < 0) {
    throw budgetConfigError(`performance budget ${section}.${key} must be a non-negative integer`)
  }
  return value
}

export function assertBudgetAllowsStart({ budgetMs, label }) {
  if (budgetMs > 0) return
  throw budgetExceededError({ label, budgetMs, elapsedMs: 0 })
}

export function assertWithinBudget({ startedAt, budgetMs, label, now = Date.now }) {
  const elapsedMs = Math.max(0, now() - startedAt)
  if (elapsedMs <= budgetMs) return elapsedMs
  throw budgetExceededError({ label, budgetMs, elapsedMs })
}

function validateBudgets(budgets) {
  const diagnostics = []
  if (!budgets || typeof budgets !== "object" || Array.isArray(budgets)) {
    diagnostics.push("performance budget config must be an object")
  } else if (budgets.schema_version !== 1) {
    diagnostics.push("performance budget config schema_version must be 1")
  } else {
    if (
      budgets.search !== undefined &&
      (!budgets.search ||
        typeof budgets.search !== "object" ||
        Array.isArray(budgets.search))
    ) {
      diagnostics.push("performance budget search must be an object")
    } else if (budgets.search) {
      for (const key of [
        "semantic_repair_batch_chunks",
        "semantic_repair_batch_ms",
      ]) {
        if (
          budgets.search[key] !== undefined &&
          (!Number.isInteger(budgets.search[key]) || budgets.search[key] <= 0)
        ) {
          diagnostics.push(
            `performance budget search.${key} must be a positive integer`,
          )
        }
      }
    }
    for (const [section, keys] of Object.entries({
      startup: ["ensure_index_ms", "snapshot_restore_ms", "vector_pack_import_ms"],
      rebuild: ["vector_pack_rebuild_ms", "snapshot_build_ms"],
      artifacts: ["snapshot_verify_ms", "validate_ms"],
    })) {
      if (!budgets[section] || typeof budgets[section] !== "object" || Array.isArray(budgets[section])) {
        diagnostics.push(`performance budget ${section} must be an object`)
        continue
      }
      for (const key of keys) {
        const value = budgets[section][key]
        if (!Number.isInteger(value) || value < 0) {
          diagnostics.push(`performance budget ${section}.${key} must be a non-negative integer`)
        }
      }
    }
  }
  if (diagnostics.length === 0) return
  const error = budgetConfigError("performance budget config is invalid")
  error.diagnostics = diagnostics
  throw error
}

function budgetConfigError(message) {
  const error = new Error(message)
  error.code = "performance_budget_config_invalid"
  return error
}

function budgetExceededError({ label, budgetMs, elapsedMs }) {
  const error = new Error(`${label} exceeded performance budget`)
  error.code = "performance_budget_exceeded"
  error.budget_ms = budgetMs
  error.elapsed_ms = elapsedMs
  return error
}

function requiredPath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`)
  }
  return value
}

function cloneBudgets(budgets) {
  return JSON.parse(JSON.stringify(budgets))
}

export const __performanceBudgetInternalsForTests = {
  requiredPath,
}
