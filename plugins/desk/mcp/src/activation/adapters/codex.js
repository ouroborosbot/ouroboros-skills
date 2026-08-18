import {
  applyActivationArtifacts,
  deactivateActivationArtifacts,
} from "../artifact-ledger.js"
import { resolveActivationChain } from "../validate.js"

const CODEX_CAPABILITIES = new Set(["Read", "Write", "Interactive"])
const CODEX_ACTIVATION_LEDGER_PATH = ".codex/desk-activation-ledger.json"
const OWNED_BLOCK_BEGIN_PATTERN = /^# BEGIN desk activation: [^\r\n]* owner=desk-activation\r?$/gm
const OWNED_BLOCK_END_PATTERN = /^# END desk activation\r?$/gm
const DESK_MCP_HEALTH_GUARD = "Desk MCP health guard: before treating session start as healthy, run the `desk:session-start` MCP availability checkpoint: verify the active host tool list exposes Desk MCP tools, especially `desk_status`. If `desk_status` or the Desk MCP namespace is missing, do not silently continue in local-only mode; explain what Desk MCP provides, ask whether to fix/reload now or continue without reminders, and route repairs to `desk:codex-onboarding` when that skill is available or the Codex repair checklist. Once tools are visible, call `desk_status` to distinguish degraded index/vector/snapshot state from an absent MCP."

const MODE_CONFIG = {
  "global-personal": {
    scope: "global",
    configPath: "~/.codex/config.toml",
    instructionsPath: "~/.codex/AGENTS.md",
    activationConfigPath: "~/.codex/desk.activation.json",
    workerContext: "by default",
    pluginMcpEnabled: true,
    directMcp: true,
  },
  "project-local": {
    scope: "project",
    configPath: ".codex/config.toml",
    instructionsPath: "AGENTS.md",
    activationConfigPath: ".codex/desk.activation.json",
    workerContext: "by default in this project",
    pluginMcpEnabled: false,
    directMcp: true,
  },
  "manual-only": {
    scope: "global",
    configPath: "~/.codex/config.toml",
    instructionsPath: null,
    activationConfigPath: null,
    workerContext: "",
    pluginMcpEnabled: false,
    directMcp: false,
  },
}

function tomlString(value) {
  const escaped = String(value)
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, "\\\"")
    .replace(/\u0008/gu, "\\b")
    .replace(/\t/gu, "\\t")
    .replace(/\n/gu, "\\n")
    .replace(/\f/gu, "\\f")
    .replace(/\r/gu, "\\r")
    .replace(/[\u0000-\u0007\u000B\u000E-\u001F\u007F]/gu, (char) => (
      `\\u${char.codePointAt(0).toString(16).padStart(4, "0")}`
    ))
  return `"${escaped}"`
}

function tomlArray(values) {
  return `[${values.map(tomlString).join(", ")}]`
}

function tomlBool(value) {
  return value ? "true" : "false"
}

function assertCodexCapabilities(manifest) {
  for (const capability of manifest.permissions.requested_capabilities) {
    if (!CODEX_CAPABILITIES.has(capability)) {
      throw new Error(`unsupported capability: permission ${capability} not declared by Codex adapter`)
    }
  }
}

function findOwnedActivationBlock(content) {
  const begins = [...content.matchAll(OWNED_BLOCK_BEGIN_PATTERN)]
  const ends = [...content.matchAll(OWNED_BLOCK_END_PATTERN)]

  if (begins.length > 1 || ends.length > 1) {
    throw new Error("multiple owned desk activation blocks found")
  }
  if (begins.length !== ends.length) {
    throw new Error("malformed owned desk activation block")
  }
  if (begins.length === 0) {
    return null
  }

  const begin = begins[0]
  const end = ends[0]
  if (end.index < begin.index) {
    throw new Error("malformed owned desk activation block")
  }

  let blockEnd = end.index + end[0].length
  if (content[blockEnd] === "\n") {
    blockEnd += 1
  }
  return {
    start: begin.index,
    end: blockEnd,
  }
}

function removeOwnedActivationBlock(content) {
  const ownedBlock = findOwnedActivationBlock(content)
  if (!ownedBlock) {
    return content
  }
  return `${content.slice(0, ownedBlock.start)}${content.slice(ownedBlock.end)}`
}

function trimTrailingLineBreaks(content) {
  return content.replace(/(?:\r?\n)+$/u, "")
}

function mergeOwnedActivationBlock(existingContent, ownedBlock) {
  const userContent = trimTrailingLineBreaks(removeOwnedActivationBlock(existingContent))
  if (!userContent) {
    return ownedBlock
  }
  return `${userContent}\n\n${ownedBlock}`
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function stripTomlComment(line) {
  let quote = null
  let escaped = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (quote === "\"" && escaped) {
        escaped = false
      } else if (quote === "\"" && char === "\\") {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
    } else if (char === "\"" || char === "'") {
      quote = char
    } else if (char === "#") {
      return line.slice(0, index)
    }
  }

  return line
}

function splitTomlTopLevel(input, separator) {
  const parts = []
  let quote = null
  let escaped = false
  let depth = 0
  let start = 0

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quote) {
      if (quote === "\"" && escaped) {
        escaped = false
      } else if (quote === "\"" && char === "\\") {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === "\"" || char === "'") {
      quote = char
    } else if (char === "{" || char === "[") {
      depth += 1
    } else if (char === "}" || char === "]") {
      depth -= 1
    } else if (char === separator && depth === 0) {
      parts.push(input.slice(start, index))
      start = index + 1
    }
  }

  parts.push(input.slice(start))
  return parts
}

function findTomlTopLevelEquals(input) {
  let quote = null
  let escaped = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quote) {
      if (quote === "\"" && escaped) {
        escaped = false
      } else if (quote === "\"" && char === "\\") {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === "\"" || char === "'") {
      quote = char
    } else if (char === "=") {
      return index
    }
  }

  return -1
}

function parseTomlBasicString(value) {
  return value.slice(1, -1)
    .replace(/\\U([0-9A-Fa-f]{8})/gu, (_, codePoint) => (
      String.fromCodePoint(Number.parseInt(codePoint, 16))
    ))
    .replace(/\\u([0-9A-Fa-f]{4})/gu, (_, codePoint) => (
      String.fromCodePoint(Number.parseInt(codePoint, 16))
    ))
    .replace(/\\(["\\])/gu, "$1")
}

function parseTomlKeySegment(segment) {
  const trimmed = segment.trim()
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return parseTomlBasicString(trimmed)
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }
  if (/^[A-Za-z0-9_-]+$/u.test(trimmed)) {
    return trimmed
  }
  return null
}

function parseTomlDottedKey(key) {
  const segments = splitTomlTopLevel(key, ".")
  const parsedSegments = []

  for (const segment of segments) {
    const parsedSegment = parseTomlKeySegment(segment)
    if (parsedSegment === null) {
      return null
    }
    parsedSegments.push(parsedSegment)
  }

  return parsedSegments
}

function setObjectPath(object, path, value) {
  let current = object
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]
    if (!hasOwn(current, segment) || typeof current[segment] !== "object" || current[segment] === null) {
      current[segment] = Object.create(null)
    }
    current = current[segment]
  }
  current[path[path.length - 1]] = value
}

function parseTomlValue(value) {
  const trimmed = value.trim()
  if (trimmed === "false") {
    return false
  }
  if (trimmed === "true") {
    return true
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return parseTomlInlineTable(trimmed)
  }
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return parseTomlBasicString(trimmed)
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }
  return undefined
}

function parseTomlInlineTable(value) {
  const body = value.trim().slice(1, -1).trim()
  const object = Object.create(null)
  if (!body) {
    return object
  }

  for (const part of splitTomlTopLevel(body, ",")) {
    const assignment = part.trim()
    const equalsIndex = findTomlTopLevelEquals(assignment)
    if (equalsIndex === -1) {
      continue
    }
    const keyPath = parseTomlDottedKey(assignment.slice(0, equalsIndex))
    if (!keyPath) {
      continue
    }
    const parsedValue = parseTomlValue(assignment.slice(equalsIndex + 1))
    if (parsedValue !== undefined) {
      setObjectPath(object, keyPath, parsedValue)
    }
  }

  return object
}

function parseTomlTableHeader(line) {
  if (line.startsWith("[[") && line.endsWith("]]")) {
    return parseTomlDottedKey(line.slice(2, -2))
  }
  if (line.startsWith("[") && line.endsWith("]")) {
    return parseTomlDottedKey(line.slice(1, -1))
  }
  return null
}

function pathEquals(left, right) {
  return left.length === right.length && left.every((segment, index) => segment === right[index])
}

function pathStartsWith(path, prefix) {
  return prefix.length <= path.length && prefix.every((segment, index) => segment === path[index])
}

function getObjectPath(object, path) {
  let current = object
  for (const segment of path) {
    if (!current || typeof current !== "object" || !hasOwn(current, segment)) {
      return undefined
    }
    current = current[segment]
  }
  return current
}

function tomlValueAtPath(content, targetPath) {
  let sectionPath = []
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim()
    if (!line) {
      continue
    }

    const tablePath = parseTomlTableHeader(line)
    if (tablePath) {
      sectionPath = tablePath
      continue
    }

    const equalsIndex = findTomlTopLevelEquals(line)
    if (equalsIndex === -1) {
      continue
    }
    const keyPath = parseTomlDottedKey(line.slice(0, equalsIndex))
    if (!keyPath) {
      continue
    }
    const parsedValue = parseTomlValue(line.slice(equalsIndex + 1))
    if (parsedValue === undefined) {
      continue
    }

    const fullPath = [...sectionPath, ...keyPath]
    if (pathEquals(fullPath, targetPath)) {
      return parsedValue
    }
    if (typeof parsedValue === "object" && parsedValue !== null && pathStartsWith(targetPath, fullPath)) {
      const nested = getObjectPath(parsedValue, targetPath.slice(fullPath.length))
      if (nested !== undefined) {
        return nested
      }
    }
  }
  return undefined
}

function hasTomlBoolean(content, path, value) {
  return tomlValueAtPath(content, path) === value
}

function pluginRef(pluginId, namespace) {
  return `${pluginId}@${namespace}`
}

function deskPluginPath(namespace) {
  return ["plugins", pluginRef("desk", namespace)]
}

function deskPluginMcpPath(namespace) {
  return [...deskPluginPath(namespace), "mcp_servers", "desk"]
}

function activationNamespace(input) {
  return input.marketplaceNamespace ?? input.marketplace_namespace ?? "ourostack"
}

function hasDisabledPluginValue(path, value, namespace) {
  const deskPath = deskPluginPath(namespace)
  const deskMcpPath = deskPluginMcpPath(namespace)
  if (pathEquals(path, [...deskPath, "enabled"])) {
    return value === false
  }
  if (pathEquals(path, [...deskMcpPath, "enabled"])) {
    return value === false
  }
  if (pathEquals(path, deskPath)) {
    return getObjectPath(value, ["enabled"]) === false ||
      getObjectPath(value, ["mcp_servers", "desk", "enabled"]) === false
  }
  if (pathEquals(path, [...deskPath, "mcp_servers"])) {
    return getObjectPath(value, ["desk", "enabled"]) === false
  }
  if (pathEquals(path, deskMcpPath)) {
    return getObjectPath(value, ["enabled"]) === false
  }
  return false
}

function hasUserDisabledDeskConfig(content, namespace) {
  let sectionPath = []
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim()
    if (!line) {
      continue
    }

    const tablePath = parseTomlTableHeader(line)
    if (tablePath) {
      sectionPath = tablePath
      continue
    }

    const equalsIndex = findTomlTopLevelEquals(line)
    if (equalsIndex === -1) {
      continue
    }
    const keyPath = parseTomlDottedKey(line.slice(0, equalsIndex))
    if (!keyPath) {
      continue
    }
    const parsedValue = parseTomlValue(line.slice(equalsIndex + 1))
    if (parsedValue === undefined) {
      continue
    }

    if (hasDisabledPluginValue([...sectionPath, ...keyPath], parsedValue, namespace)) {
      return true
    }
  }
  return false
}

function assertNoUserDisabledDeskConfig(config, namespace) {
  if (hasUserDisabledDeskConfig(config, namespace)) {
    throw new Error(
      "user-authored disabled Desk config must be removed before automatic Desk activation",
    )
  }
}

function assertNoUserDisabledDirectDeskMcpConfig(config) {
  if (hasTomlBoolean(config, ["mcp_servers", "desk", "enabled"], false)) {
    throw new Error(
      "user-authored disabled Desk MCP config must be removed before automatic Desk activation",
    )
  }
}

function removeUnownedDeskMcpConfig(content) {
  const directMcpPath = ["mcp_servers", "desk"]
  const keptLines = []
  let sectionPath = []
  let droppingDeskMcpSection = false

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim()
    const tablePath = line ? parseTomlTableHeader(line) : null

    if (tablePath) {
      sectionPath = tablePath
      droppingDeskMcpSection = pathStartsWith(sectionPath, directMcpPath)
      if (!droppingDeskMcpSection) {
        keptLines.push(rawLine)
      }
      continue
    }

    if (droppingDeskMcpSection) {
      continue
    }

    if (!line) {
      keptLines.push(rawLine)
      continue
    }

    const equalsIndex = findTomlTopLevelEquals(line)
    if (equalsIndex === -1) {
      keptLines.push(rawLine)
      continue
    }

    const keyPath = parseTomlDottedKey(line.slice(0, equalsIndex))
    if (!keyPath) {
      keptLines.push(rawLine)
      continue
    }

    const fullPath = [...sectionPath, ...keyPath]
    if (pathStartsWith(fullPath, directMcpPath)) {
      continue
    }

    const parsedValue = parseTomlValue(line.slice(equalsIndex + 1))
    if (
      parsedValue !== undefined &&
      pathStartsWith(directMcpPath, fullPath) &&
      getObjectPath(parsedValue, directMcpPath.slice(fullPath.length)) !== undefined
    ) {
      if (
        pathEquals(fullPath, ["mcp_servers"]) &&
        Object.keys(parsedValue).length === 1 &&
        hasOwn(parsedValue, "desk")
      ) {
        continue
      }
      throw new Error(
        "user-authored inline mcp_servers.desk config must be moved out before automatic Desk activation",
      )
    }

    keptLines.push(rawLine)
  }

  return keptLines.join("\n")
}

function selectedDependencyIds(selectedActivation) {
  const ids = []
  for (const entry of selectedActivation.chain) {
    for (const id of entry.depends_on ?? []) {
      if (!ids.includes(id)) ids.push(id)
    }
  }
  return ids
}

function orderedCodexPluginIds(input, selectedActivation) {
  const dependencyIds = selectedDependencyIds(selectedActivation)
  const dependencyMap = new Map(input.manifest.dependencies.map((dependency) => [
    dependency.id,
    dependency,
  ]))
  const preferred = ["work-suite", input.manifest.id]
  const pluginIds = []
  for (const id of [...preferred, ...dependencyIds]) {
    const dependency = dependencyMap.get(id)
    if (!dependency) continue
    if (!["plugin", "substrate"].includes(dependency.kind)) continue
    if (!pluginIds.includes(id)) pluginIds.push(id)
  }
  return pluginIds
}

function renderPluginEnableBlocks(input, selectedActivation, namespace, existingConfig) {
  return orderedCodexPluginIds(input, selectedActivation)
    .filter((id) => !hasTomlBoolean(existingConfig, [...deskPluginPathFor(id, namespace), "enabled"], true))
    .map((id) => `[plugins."${pluginRef(id, namespace)}"]\nenabled = true`)
    .join("\n\n")
}

function deskPluginPathFor(pluginId, namespace) {
  return ["plugins", pluginRef(pluginId, namespace)]
}

function renderConfigBlock(input, modeConfig, selectedActivation, existingConfig) {
  const { manifest } = input
  const namespace = activationNamespace(input)
  const pluginMcpPolicy = `[plugins."${pluginRef(manifest.id, namespace)}".mcp_servers.desk]
enabled = ${tomlBool(modeConfig.pluginMcpEnabled)}`
  const approvalPolicy = modeConfig.pluginMcpEnabled
    ? `
default_tools_approval_mode = "prompt"`
    : ""
  const directMcp = modeConfig.directMcp
    ? `

[mcp_servers.desk]
command = "node"
args = ${tomlArray([
    `${input.pluginRoot}/mcp/index.js`,
    "--activation-config",
    modeConfig.activationConfigPath,
  ])}
cwd = "."
enabled = true
default_tools_approval_mode = "prompt"`
    : ""

  return `# BEGIN desk activation: ${manifest.id}@${manifest.version} mode=${input.mode} owner=desk-activation
${renderPluginEnableBlocks(input, selectedActivation, namespace, existingConfig)}

${pluginMcpPolicy}${approvalPolicy}${directMcp}
# END desk activation
`
}

function renderActivationConfig(input, selectedActivation) {
  return `${JSON.stringify({
    schema_version: 1,
    desk: {
      root: input.deskRoot,
    },
    runtimeCacheDir: input.runtimeCacheDir,
    activation: {
      selected_id: selectedActivation.id,
      launch_as: selectedActivation.launchAs,
      mode: input.mode,
      chain: selectedActivation.chain.map((entry) => entry.id),
    },
  }, null, 2)}\n`
}

function renderInstructionsBlock(input, modeConfig, selectedActivation) {
  if (!modeConfig.instructionsPath) {
    return ""
  }
  const identity = selectedActivation.identity
  const activationChain = selectedActivation.chain.map((entry) => `\`${entry.id}\``).join(" -> ")
  const overlayAddenda = selectedActivation.chain
    .filter((entry) => entry.instructions)
    .map((entry) => `${entry.instructions.identity}: ${entry.instructions.addendum}`)
  const overlaySection = overlayAddenda.length > 0
    ? `
Active Desk activation: ${activationChain}.

${overlayAddenda.join("\n")}
`
    : ""

  return `# BEGIN desk activation: ${input.manifest.id}@${input.manifest.version} mode=${input.mode} owner=desk-activation
You are the ${identity} ${modeConfig.workerContext}.

Run the \`desk:session-start\` skill before other work. Treat \`$DESK\` as \`${input.deskRoot}\`. Keep durable tracks, tasks, friction, and lessons there. ${DESK_MCP_HEALTH_GUARD} Never hard-wrap authored prose: keep each paragraph, list item, blockquote, message, task card paragraph, commit body paragraph, and PR body paragraph on one physical line; use newlines only for real structure or source-preserved semantic breaks. Before finishing, inspect authored/changed prose and join column-wrap continuations without rewriting third-party or historical source. Use Work Suite skills (\`work-ideator\`, \`work-planner\`, \`work-doer\`, \`work-merger\`) for substantial engineering work, with harsh sub-agent reviewer gates when the task calls for them.${overlaySection}
# END desk activation
`
}

function hostRelativePath(artifactPath) {
  return artifactPath.startsWith("~/")
    ? artifactPath.slice(2)
    : artifactPath
}

function generatedArtifactContent(activation, artifact) {
  if (artifact.kind === "owned-codex-instructions") {
    return activation.generatedInstructions
  }
  if (artifact.path === activation.activationConfigPath) {
    return activation.generatedActivationConfig
  }
  return activation.generatedConfig
}

export function materializeCodexActivation(input) {
  const modeConfig = MODE_CONFIG[input.mode]
  assertCodexCapabilities(input.manifest)
  const selectedActivation = selectedActivationFor(input)
  const namespace = activationNamespace(input)
  const configWithoutOwnedBlock = removeOwnedActivationBlock(input.existingConfig)
  assertNoUserDisabledDirectDeskMcpConfig(configWithoutOwnedBlock)
  const configWithoutUnownedDeskMcp = removeUnownedDeskMcpConfig(configWithoutOwnedBlock)
  assertNoUserDisabledDeskConfig(configWithoutUnownedDeskMcp, namespace)
  const generatedConfig = mergeOwnedActivationBlock(
    configWithoutUnownedDeskMcp,
    renderConfigBlock(input, modeConfig, selectedActivation, configWithoutUnownedDeskMcp),
  )
  const instructionsBlock = renderInstructionsBlock(input, modeConfig, selectedActivation)
  const generatedInstructions = instructionsBlock
    ? mergeOwnedActivationBlock(input.existingInstructions, instructionsBlock)
    : ""
  const instructionArtifacts = modeConfig.instructionsPath
    ? [
        {
          owner: "desk-activation",
          kind: "owned-codex-instructions",
          path: modeConfig.instructionsPath,
        },
      ]
    : []
  const activationConfigArtifacts = modeConfig.activationConfigPath
    ? [
        {
          owner: "desk-activation",
          kind: "owned-host-config",
          path: modeConfig.activationConfigPath,
        },
      ]
    : []

  return {
    mode: input.mode,
    scope: modeConfig.scope,
    configPath: modeConfig.configPath,
    instructionsPath: modeConfig.instructionsPath,
    activationConfigPath: modeConfig.activationConfigPath,
    manualSetupSteps: [],
    permissions: {
      requestedCapabilities: input.manifest.permissions.requested_capabilities,
      neverDelete: input.manifest.permissions.never_delete,
    },
    selectedActivation,
    generatedArtifacts: [
      {
        owner: "desk-activation",
        kind: "owned-host-config",
        path: modeConfig.configPath,
      },
      ...activationConfigArtifacts,
      ...instructionArtifacts,
    ],
    generatedConfig,
    generatedActivationConfig: modeConfig.activationConfigPath
      ? renderActivationConfig(input, selectedActivation)
      : "",
    generatedInstructions,
  }
}

function selectedActivationFor(input) {
  const chain = resolveActivationChain(input.manifest, input.selectedActivationId ?? "desk:worker")
  const selected = chain.at(-1)
  const selectedInstructions = selected.instructions
  return {
    id: selected.id,
    launchAs: selected.launch_as ?? selected.id,
    identity: selectedInstructions?.identity ?? "desk worker",
    chain,
  }
}

export function applyCodexActivation(input) {
  const activation = materializeCodexActivation(input)
  const { ledger } = applyActivationArtifacts({
    hostRoot: input.hostRoot,
    ledgerPath: input.ledgerPath ?? CODEX_ACTIVATION_LEDGER_PATH,
    activation: {
      id: input.manifest.id,
      version: input.manifest.version,
      host: "codex",
      mode: input.mode,
      owner: "desk-activation",
      generatedBy: "codex-adapter",
    },
    neverDelete: input.manifest.permissions.never_delete,
    now: input.now ?? new Date().toISOString(),
    artifacts: activation.generatedArtifacts.map((artifact) => ({
      ...artifact,
      path: hostRelativePath(artifact.path),
      content: generatedArtifactContent(activation, artifact),
    })),
  })

  return { activation, ledger }
}

export function deactivateCodexActivation({ hostRoot, ledgerPath = CODEX_ACTIVATION_LEDGER_PATH }) {
  return deactivateActivationArtifacts({ hostRoot, ledgerPath })
}
