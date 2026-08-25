const CLAUDE_WORKER_AGENT_PATH = "./agents/worker.md"
const CLAUDE_WORKER_SOURCE = "agents/worker.md"
const WORK_SUITE_DEPENDENCY_NAME = "work-suite"
const WORK_SUITE_DEPENDENCY_RANGE = "^2.0.0"
const SUPPORTED_SESSION_STATUSES = new Set([
  "supported",
  "supported-with-version-floor",
  "validated",
])
const DISPATCHED_SESSION_SMOKE_RE =
  /(?:dispatched-session smoke|background session loads|unit-\d+[a-z]? .*smoke)/iu

export function validateClaudePackagingContract(input) {
  const errors = []
  const workSuiteDependency = input.deskPlugin.dependencies.find((dependency) => (
    dependency.name === WORK_SUITE_DEPENDENCY_NAME
  ))
  const lockedWorkSuiteVersion = input.activation.dependencies.find((dependency) => (
    dependency.id === WORK_SUITE_DEPENDENCY_NAME
  )).lock.version

  if (workSuiteDependency === undefined) {
    errors.push("missing Work Suite dependency in Claude plugin metadata")
  } else if (workSuiteDependency.version !== WORK_SUITE_DEPENDENCY_RANGE) {
    errors.push("Claude Work Suite dependency range must be ^2.0.0")
  }

  if (input.workSuitePlugin.version !== lockedWorkSuiteVersion) {
    errors.push(`Work Suite Claude version must match activation lock ${lockedWorkSuiteVersion}`)
  }

  if (!input.deskPlugin.agents.includes(CLAUDE_WORKER_AGENT_PATH)) {
    errors.push("Claude plugin metadata must expose ./agents/worker.md")
  }

  if (input.claudeActivation.targets["desk:worker"].source !== CLAUDE_WORKER_SOURCE) {
    errors.push("Claude activation target desk:worker must use agents/worker.md")
  }

  for (const pluginManifest of [input.deskPlugin, input.workSuitePlugin]) {
    if (Object.hasOwn(pluginManifest, "activation")) {
      errors.push("Claude plugin manifest must not include host activation metadata")
    }
  }

  for (const [label, disposition] of [
    ["Agent View", input.claudeActivation.agentView],
    ["background-session", input.claudeActivation.backgroundSessionInheritance],
  ]) {
    if (claimsSupportedPluginContext(disposition)) {
      if (!hasDispatchedSessionSmokeEvidence(disposition)) {
        errors.push(`${label} support requires dispatched-session smoke evidence`)
      }
    }
  }

  return errors
}

function claimsSupportedPluginContext(disposition) {
  return SUPPORTED_SESSION_STATUSES.has(disposition.status)
    && disposition.inheritsPluginContext === true
}

function hasDispatchedSessionSmokeEvidence(disposition) {
  return DISPATCHED_SESSION_SMOKE_RE.test([
    disposition.evidence,
    disposition.evidenceCommandOrDoc,
    disposition.validatedBy,
    disposition.validation,
  ].join("\n"))
}
