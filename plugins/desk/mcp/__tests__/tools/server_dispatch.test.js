// server_dispatch — sanity-check that server.callTool routes every tool
// to its real implementation (no remaining stubs after Unit 6).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { callTool, createMcpServer, createMcpTransport, startServer, TOOL_IMPLS } from "../../src/server.js"
import { mkTempDeskRoot } from "./_helpers.js"

function parseResult(res) {
  return JSON.parse(res.content[0].text)
}

test("server.callTool routes task_create to the real implementation", async () => {
  const root = await mkTempDeskRoot()
  const res = await callTool({
    deskRoot: root,
    name: "task_create",
    input: { track: "t", slug: "s", title: "T" },
  })
  assert.ok(!res.isError)
  const body = parseResult(res)
  assert.equal(body.status, "created")
  assert.equal(body.path, path.join("t", "s", "task.md"))
})

test("server.callTool surfaces tool errors as isError with structured body", async () => {
  const root = await mkTempDeskRoot()
  const res = await callTool({
    deskRoot: root,
    name: "task_update",
    input: { track: "nope", slug: "nada", frontmatter: { status: "x" } },
  })
  assert.ok(res.isError, "missing-task should surface as isError")
  const body = parseResult(res)
  assert.equal(body.status, "error")
  assert.match(body.message, /does not exist/)
})

test("server.callTool routes desk_thread to the real implementation", async () => {
  const root = await mkTempDeskRoot()
  const res = await callTool({
    deskRoot: root,
    name: "desk_thread",
    input: { start_path: "nope/does/not/exist.md" },
  })
  // No isError — desk_thread returns a structured `not_indexed` payload
  // for an unknown path, not a thrown error.
  const body = parseResult(res)
  assert.equal(body.error, "not_indexed")
  assert.match(body.note, /isn't in the desk-index/)
})

test("server.callTool rejects unknown tool names", async () => {
  const root = await mkTempDeskRoot()
  const res = await callTool({
    deskRoot: root,
    name: "this_does_not_exist",
    input: {},
  })
  assert.ok(res.isError)
  assert.match(res.content[0].text, /unknown tool/)
})

// Unit 1.2c: the unknown-tool + error branches must still behave with a
// `person` present on the dispatch call (the new threaded field).

test("server.callTool rejects unknown tool names even with person set", async () => {
  const root = await mkTempDeskRoot()
  const res = await callTool({
    deskRoot: root,
    name: "this_does_not_exist",
    input: {},
    person: "ari",
  })
  assert.ok(res.isError)
  assert.match(res.content[0].text, /unknown tool/)
})

test("server.callTool reports registered tools missing from the implementation table", async () => {
  const root = await mkTempDeskRoot()
  const original = TOOL_IMPLS.desk_status
  delete TOOL_IMPLS.desk_status
  try {
    const res = await callTool({
      deskRoot: root,
      name: "desk_status",
      input: {},
    })
    const body = JSON.parse(res.content[0].text)
    assert.equal(body.status, "not_implemented")
    assert.equal(body.tool, "desk_status")
    assert.match(body.note, /wiring bug/)
  } finally {
    TOOL_IMPLS.desk_status = original
  }
})

test("server.callTool surfaces tool errors as isError with person set", async () => {
  const root = await mkTempDeskRoot()
  const res = await callTool({
    deskRoot: root,
    name: "task_update",
    input: { track: "nope", slug: "nada", frontmatter: { status: "x" } },
    person: "ari",
  })
  assert.ok(res.isError)
  const body = JSON.parse(res.content[0].text)
  assert.equal(body.status, "error")
  assert.match(body.message, /does not exist/)
})

test("server.callTool surfaces non-Error throws as string messages", async () => {
  const root = await mkTempDeskRoot()
  const original = TOOL_IMPLS.task_create
  TOOL_IMPLS.task_create = async () => {
    throw "string boom"
  }
  try {
    const res = await callTool({
      deskRoot: root,
      name: "task_create",
      input: {},
    })
    assert.ok(res.isError)
    const body = JSON.parse(res.content[0].text)
    assert.equal(body.status, "error")
    assert.equal(body.message, "string boom")
  } finally {
    TOOL_IMPLS.task_create = original
  }
})

test("server.callTool defaults omitted input to an empty object", async () => {
  const root = await mkTempDeskRoot()
  let received
  const original = TOOL_IMPLS.task_create
  TOOL_IMPLS.task_create = async (arg) => {
    received = arg
    return { status: "probed" }
  }
  try {
    const res = await callTool({
      deskRoot: root,
      name: "task_create",
    })
    assert.equal(res.isError, undefined)
    assert.deepEqual(received.input, {})
  } finally {
    TOOL_IMPLS.task_create = original
  }
})

test("server.callTool routes a person-scoped write end-to-end (path shows desks/<alias>/)", async () => {
  const root = await mkTempDeskRoot()
  const res = await callTool({
    deskRoot: root,
    name: "task_create",
    input: { track: "t", slug: "s", title: "T" },
    person: "ari",
  })
  assert.ok(!res.isError)
  const body = JSON.parse(res.content[0].text)
  assert.equal(body.status, "created")
  assert.equal(body.path, path.join("desks", "ari", "t", "s", "task.md"))
})

test("server.callTool surfaces an invalid-alias throw as isError", async () => {
  const root = await mkTempDeskRoot()
  const res = await callTool({
    deskRoot: root,
    name: "task_create",
    input: { track: "t", slug: "s", title: "T" },
    person: "../evil",
  })
  assert.ok(res.isError)
  const body = JSON.parse(res.content[0].text)
  assert.equal(body.status, "error")
  assert.match(body.message, /alias/i)
})

test("server.startServer registers list/call handlers and forwards status context", async () => {
  const root = await mkTempDeskRoot()
  const handlers = []
  const transport = { kind: "fake-stdio" }
  const server = {
    setRequestHandler(schema, handler) {
      handlers.push({ schema, handler })
    },
    async connect(receivedTransport) {
      assert.equal(receivedTransport, transport)
    },
  }
  const statusContext = {
    root: { source: "unit-test", tried: [{ source: "unit-test", path: root }] },
    runtime: { runtime_cache_dir: "/tmp/runtime", source_mirror_path: "/tmp/runtime/source-mirror/hash" },
  }

  await startServer({ deskRoot: root, person: "ari", statusContext, server, transport })

  assert.equal(handlers.length, 2)
  const listed = await handlers[0].handler()
  assert.ok(listed.tools.some((tool) => tool.name === "desk_status"))

  const called = await handlers[1].handler({
    params: {
      name: "desk_status",
      arguments: {},
    },
  })
  const body = JSON.parse(called.content[0].text)
  assert.equal(body.root.source, "unit-test")
  assert.equal(body.runtime.runtime_cache_dir, "/tmp/runtime")
  assert.equal(body.runtime.loaded_from_source_mirror, true)
  assert.deepEqual(body.write_scope, {
    mode: "person",
    person: "ari",
    relative_path: "desks/ari",
  })

  const defaultArgs = await handlers[1].handler({
    params: {
      name: "desk_status",
    },
  })
  const defaultArgsBody = JSON.parse(defaultArgs.content[0].text)
  assert.equal(defaultArgsBody.status, "ok")

  const missingParams = await handlers[1].handler({})
  assert.ok(missingParams.isError)
  assert.match(missingParams.content[0].text, /unknown tool/)
})

test("server.startServer binds one runtime coordinator through dispatch without changing tool results", async () => {
  const root = await mkTempDeskRoot()
  const handlers = []
  const maintenanceCalls = []
  const runtimeContext = {
    maintenanceCoordinator: {
      async runExplicitReindex(args) {
        maintenanceCalls.push(args)
        return {
          built: false,
          reason: "fresh",
          semantic: {
            chunks_total: 0,
            vectors_indexed: 0,
            missing_vectors: 0,
            embedding_available: true,
          },
        }
      },
    },
  }
  const server = {
    setRequestHandler(schema, handler) {
      handlers.push({ schema, handler })
    },
    async connect() {},
  }

  await startServer({
    deskRoot: root,
    runtimeContext,
    server,
    transport: { kind: "runtime-context-test" },
  })
  const called = await handlers[1].handler({
    params: {
      name: "desk_reindex",
      arguments: {},
    },
  })
  const body = JSON.parse(called.content[0].text)

  assert.equal(called.isError, undefined)
  assert.equal(body.status, "ok")
  assert.equal(body.built, false)
  assert.equal(body.reason, "fresh")
  assert.deepEqual(maintenanceCalls, [
    {
      deskRoot: path.resolve(root),
      force: false,
      ensureOptions: {},
    },
  ])
})

test("server.startServer can construct its default transport", async () => {
  const root = await mkTempDeskRoot()
  const server = {
    setRequestHandler() {},
    async connect(receivedTransport) {
      assert.equal(typeof receivedTransport, "object")
    },
  }
  await startServer({ deskRoot: root, server })
})

test("server.startServer can construct server and transport through injected factories", async () => {
  const root = await mkTempDeskRoot()
  const transport = { kind: "factory-transport" }
  const server = {
    setRequestHandler() {},
    async connect(receivedTransport) {
      assert.equal(receivedTransport, transport)
    },
  }
  await startServer({
    deskRoot: root,
    createServer: () => server,
    createTransport: () => transport,
  })
})

test("server MCP factory helpers construct default SDK instances", () => {
  assert.equal(typeof createMcpServer().setRequestHandler, "function")
  assert.equal(typeof createMcpTransport(), "object")
})
