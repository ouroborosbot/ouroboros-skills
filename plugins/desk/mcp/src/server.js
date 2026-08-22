// desk MCP server registration.
//
// Registers all 15 tools as stdio MCP handlers. Units 3 + 5 + 6 wire every
// tool to a real implementation:
//   - Unit 3: task_create, task_update, task_archive, track_create,
//             track_update, friction_add, lesson_add
//   - Unit 5: desk_search, desk_recall, desk_similar, desk_timeline
//   - Unit 6: desk_thread (refs_graph provenance walk)
//   - Index mgmt: desk_reindex (wraps ensureIndex + force-rebuild)
//   - Health/status: desk_status and desk_doctor (session-start-safe, non-mutating)

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

import { TOOL_NAMES, TOOL_DESCRIPTIONS } from "./tool-names.js"
import {
  task_create,
  task_update,
  task_archive,
} from "./tools/task.js"
import { track_create, track_update } from "./tools/track.js"
import { friction_add } from "./tools/friction.js"
import { lesson_add } from "./tools/lesson.js"
import {
  desk_search,
  desk_recall,
  desk_similar,
  desk_timeline,
} from "./tools/search.js"
import { desk_thread } from "./tools/thread.js"
import { desk_reindex } from "./tools/reindex.js"
import { desk_status } from "./tools/status.js"
import { doctorRuntime } from "./tools/doctor.js"
import {
  createMaintenanceRuntimeContext,
  maintenanceCoordinator,
} from "./indexer/maintenance.js"
import {
  configureRuntimeArtifacts,
  ensureIndex,
} from "./server-helpers.js"

export { TOOL_NAMES, TOOL_DESCRIPTIONS }
export {
  configureRuntimeArtifacts,
  createMaintenanceRuntimeContext,
  ensureIndex,
  maintenanceCoordinator,
}

// Map tool name → implementation. Every tool now has a real body.
// Exported so tests can register a probe impl to assert dispatch threading.
export const TOOL_IMPLS = {
  task_create,
  task_update,
  task_archive,
  track_create,
  track_update,
  friction_add,
  lesson_add,
  desk_search,
  desk_recall,
  desk_similar,
  desk_timeline,
  desk_thread,
  desk_reindex,
  desk_status,
  desk_doctor: doctorRuntime,
}

/**
 * Dispatch a single MCP call. Pulled out from startServer so tests can
 * exercise the dispatch table directly (no stdio transport needed).
 */
export async function callTool({
  deskRoot,
  name,
  input,
  person = null,
  runtimeContext,
  statusContext = {},
}) {
  if (!TOOL_NAMES.includes(name)) {
    return {
      content: [{ type: "text", text: `unknown tool: ${name}` }],
      isError: true,
    }
  }
  const impl = TOOL_IMPLS[name]
  if (!impl) {
    // All 15 tools wired; this branch only fires if a name exists in
    // TOOL_NAMES but is missing from TOOL_IMPLS — i.e. a wiring bug.
    // Return a structured payload that points at the cause.
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            tool: name,
            note: `tool registered in TOOL_NAMES but missing from TOOL_IMPLS (wiring bug). desk root = ${deskRoot}`,
          }),
        },
      ],
    }
  }
  try {
    const result = await impl({
      deskRoot,
      input: input ?? {},
      person,
      runtimeContext: createMaintenanceRuntimeContext(runtimeContext),
      statusContext,
    })
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    }
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            tool: name,
            message: err?.message ?? String(err),
          }),
        },
      ],
      isError: true,
    }
  }
}

export function createMcpServer() {
  return new Server(
    {
      name: "desk-mcp",
      version: "1.3.3",
    },
    {
      capabilities: { tools: {} },
    },
  )
}

export function createMcpTransport() {
  return new StdioServerTransport()
}

export async function startServer({
  deskRoot,
  person = null,
  statusContext = {},
  runtimeContext,
  server,
  transport,
  createServer = createMcpServer,
  createTransport = createMcpTransport,
}) {
  const boundRuntimeContext = createMaintenanceRuntimeContext(runtimeContext)
  const activeServer = server ?? createServer()
  const activeTransport = transport ?? createTransport()
  activeServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_NAMES.map((name) => ({
      name,
      description: TOOL_DESCRIPTIONS[name],
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
    })),
  }))

  activeServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params?.name
    const input = request.params?.arguments ?? {}
    return callTool({
      deskRoot,
      name,
      input,
      person,
      runtimeContext: boundRuntimeContext,
      statusContext,
    })
  })

  await activeServer.connect(activeTransport)
}
