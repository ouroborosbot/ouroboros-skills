// embed.test.js — Ollama soft-fail + happy path with a mocked fetch.

import { test } from "node:test"
import { strict as assert } from "node:assert"

import {
  embedChunk,
  embedChunkDetailed,
  embedChunks,
  EMBEDDING_DIM,
  probeEmbeddingService,
  resolveEmbeddingEndpoints,
  resolveEmbeddingModel,
} from "../../src/indexer/embed.js"

function mockOkFetch(vec) {
  return async (_url, _opts) => ({
    ok: true,
    json: async () => ({ embedding: vec }),
  })
}

function mockHttpErrorFetch(status) {
  return async () => ({ ok: false, status })
}

function mockNetworkErrorFetch() {
  return async () => {
    const err = new Error("ECONNREFUSED")
    err.code = "ECONNREFUSED"
    throw err
  }
}

function makeAbortError(message = "embedding response body aborted") {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}

function createTrackedAbortController() {
  const controller = new AbortController()
  const { signal } = controller
  const addEventListener = signal.addEventListener.bind(signal)
  const removeEventListener = signal.removeEventListener.bind(signal)
  const listeners = new Set()
  let added = 0
  let removed = 0
  signal.addEventListener = (type, listener, options) => {
    if (type === "abort") {
      added += 1
      listeners.add(listener)
    }
    return addEventListener(type, listener, options)
  }
  signal.removeEventListener = (type, listener, options) => {
    if (type === "abort") {
      removed += 1
      listeners.delete(listener)
    }
    return removeEventListener(type, listener, options)
  }
  return {
    abort: () => controller.abort(),
    signal,
    stats() {
      return { added, removed, listeners: listeners.size }
    },
  }
}

function installManualTimers() {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const handles = []
  globalThis.setTimeout = (callback, delay, ...args) => {
    const handle = {
      args,
      callback,
      clearCalls: 0,
      delay,
      fired: false,
    }
    handles.push(handle)
    return handle
  }
  globalThis.clearTimeout = (handle) => {
    if (!handles.includes(handle)) {
      originalClearTimeout(handle)
      return
    }
    handle.clearCalls += 1
  }
  return {
    fire(handle) {
      assert.ok(handle)
      assert.equal(handle.clearCalls, 0)
      assert.equal(handle.fired, false)
      handle.fired = true
      handle.callback(...handle.args)
    },
    handles,
    pendingCount() {
      return handles.filter(
        (handle) => !handle.fired && handle.clearCalls === 0,
      ).length
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    },
  }
}

function createHeadersThenAbortFetch(response = {}) {
  let call
  let forceRejectBody
  let markBodyStarted
  const bodyStarted = new Promise((resolve) => {
    markBodyStarted = resolve
  })
  const fetch = async (url, request) => {
    call = { request, url }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      ...response,
      json: () => {
        markBodyStarted()
        return new Promise((_resolve, reject) => {
          const rejectForAbort = () => {
            reject(makeAbortError())
          }
          forceRejectBody = () => {
            reject(makeAbortError("test cleanup"))
          }
          if (request.signal?.aborted) rejectForAbort()
          else {
            request.signal?.addEventListener("abort", rejectForAbort, {
              once: true,
            })
          }
        })
      },
    }
  }
  return {
    bodyStarted,
    fetch,
    forceRejectBody() {
      forceRejectBody?.()
    },
    get call() {
      return call
    },
  }
}

async function assertPendingBodyAbortLifecycle({
  response,
  timeoutMs,
  trigger,
}) {
  const endpoint = "http://127.0.0.1:11434/api/embeddings"
  const model = "body-read-model"
  const caller = createTrackedAbortController()
  const timers = installManualTimers()
  const pendingResponse = createHeadersThenAbortFetch(response)
  const embedding = embedChunkDetailed("body-read-prompt", {
    endpoint,
    fetch: pendingResponse.fetch,
    model,
    signal: caller.signal,
    timeoutMs,
  })

  try {
    await pendingResponse.bodyStarted
    const [timer] = timers.handles
    assert.equal(pendingResponse.call.url, endpoint)
    assert.equal(pendingResponse.call.request.method, "POST")
    assert.deepEqual(pendingResponse.call.request.headers, {
      "content-type": "application/json",
    })
    assert.deepEqual(JSON.parse(pendingResponse.call.request.body), {
      model,
      prompt: "body-read-prompt",
    })
    assert.equal(timers.handles.length, 1)
    assert.equal(timer.delay, timeoutMs)
    assert.equal(timer.clearCalls, 0)
    assert.deepEqual(caller.stats(), {
      added: 1,
      removed: 0,
      listeners: 1,
    })

    if (trigger === "caller") caller.abort()
    else timers.fire(timer)
    assert.equal(pendingResponse.call.request.signal.aborted, true)
    assert.deepEqual(await embedding, {
      available: false,
      diagnostic: {
        endpoint,
        message: "embedding response body aborted",
        model,
        reason: "timeout",
      },
      vector: null,
    })
    assert.deepEqual(caller.stats(), {
      added: 1,
      removed: 1,
      listeners: 0,
    })
    assert.equal(timer.clearCalls, 1)
    assert.equal(timers.pendingCount(), 0)
  } finally {
    caller.abort()
    pendingResponse.forceRejectBody()
    await Promise.allSettled([embedding])
    timers.restore()
  }
}

test("embedChunk returns a 768-dim array on success", async () => {
  const vec = Array.from({ length: EMBEDDING_DIM }, (_, i) => i / EMBEDDING_DIM)
  const out = await embedChunk("hello world", { fetch: mockOkFetch(vec) })
  assert.ok(Array.isArray(out))
  assert.equal(out.length, EMBEDDING_DIM)
  assert.equal(out[0], 0)
  assert.equal(out[100], 100 / EMBEDDING_DIM)
})

test("embedChunk returns null when Ollama refuses the connection", async () => {
  const out = await embedChunk("x", { fetch: mockNetworkErrorFetch() })
  assert.equal(out, null)
})

test("embedChunk returns null on HTTP error (model not pulled, etc.)", async () => {
  const out = await embedChunk("x", { fetch: mockHttpErrorFetch(404) })
  assert.equal(out, null)
})

test("embedChunkDetailed reports endpoint/model diagnostics on failure", async () => {
  const res = await embedChunkDetailed("x", {
    endpoint: "http://127.0.0.1:11434",
    model: "missing-model",
    fetch: mockHttpErrorFetch(404),
  })
  assert.equal(res.available, false)
  assert.equal(res.vector, null)
  assert.equal(res.diagnostic.endpoint, "http://127.0.0.1:11434/api/embeddings")
  assert.equal(res.diagnostic.model, "missing-model")
  assert.equal(res.diagnostic.reason, "http_404")
})

test("embedChunkDetailed reports fetch-unavailable diagnostics", async () => {
  const res = await embedChunkDetailed("x", {
    endpoint: "http://127.0.0.1:11434",
    fetch: "not a function",
  })
  assert.equal(res.available, false)
  assert.equal(res.vector, null)
  assert.equal(res.diagnostic.endpoint, "http://127.0.0.1:11434/api/embeddings")
  assert.equal(res.diagnostic.reason, "fetch_unavailable")
})

test("embedChunkDetailed reports invalid JSON responses", async () => {
  const res = await embedChunkDetailed("x", {
    endpoint: "http://127.0.0.1:11434",
    fetch: async () => ({
      ok: true,
      json: async () => {
        throw new Error("not json")
      },
    }),
  })
  assert.equal(res.available, false)
  assert.equal(res.vector, null)
  assert.equal(res.diagnostic.reason, "invalid_json")
  assert.match(res.diagnostic.message, /not json/u)
})

test("embedChunkDetailed uses the default invalid JSON diagnostic message", async () => {
  const res = await embedChunkDetailed("x", {
    endpoint: "http://127.0.0.1:11434",
    fetch: async () => ({
      ok: true,
      json: async () => {
        throw "not-json"
      },
    }),
  })
  assert.equal(res.available, false)
  assert.equal(res.diagnostic.reason, "invalid_json")
  assert.equal(res.diagnostic.message, "embedding response was not JSON")
})

test("embedChunkDetailed reports timeout diagnostics", async () => {
  const fetchImpl = async (_url, request) => new Promise((_resolve, reject) => {
    request.signal.addEventListener("abort", () => {
      const err = new Error("aborted")
      err.name = "AbortError"
      reject(err)
    })
  })

  const res = await embedChunkDetailed("x", {
    endpoint: "http://127.0.0.1:11434",
    fetch: fetchImpl,
    timeoutMs: 1,
  })
  assert.equal(res.available, false)
  assert.equal(res.vector, null)
  assert.equal(res.diagnostic.reason, "timeout")
})

test("embedChunkDetailed keeps caller abort active through successful body JSON", async () => {
  await assertPendingBodyAbortLifecycle({
    timeoutMs: 10000,
    trigger: "caller",
  })
})

test("embedChunkDetailed keeps timeout active through error body JSON", async () => {
  await assertPendingBodyAbortLifecycle({
    response: {
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    },
    timeoutMs: 25,
    trigger: "timeout",
  })
})

test("embedChunkDetailed propagates caller cancellation to the outgoing request", async () => {
  const controller = new AbortController()
  let capturedRequest
  let markRequestStarted
  let rejectFetch
  const requestStarted = new Promise((resolve) => {
    markRequestStarted = resolve
  })
  const embedding = embedChunkDetailed("x", {
    endpoint: "http://127.0.0.1:11434",
    fetch: async (_url, request) => {
      capturedRequest = request
      markRequestStarted()
      return new Promise((_resolve, reject) => {
        rejectFetch = reject
      })
    },
    signal: controller.signal,
    timeoutMs: 10000,
  })

  try {
    await requestStarted
    assert.equal(capturedRequest.signal.aborted, false)
    controller.abort()
    assert.equal(capturedRequest.signal.aborted, true)
  } finally {
    const error = new Error("aborted")
    error.name = "AbortError"
    rejectFetch?.(error)
    await embedding
  }
})

test("embedChunkDetailed sends an already-aborted caller signal", async () => {
  const controller = new AbortController()
  controller.abort()
  const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.25)
  let capturedRequest

  const res = await embedChunkDetailed("x", {
    endpoint: "http://127.0.0.1:11434",
    fetch: async (_url, request) => {
      capturedRequest = request
      return { ok: true, json: async () => ({ embedding: vec }) }
    },
    signal: controller.signal,
  })

  assert.equal(capturedRequest.signal.aborted, true)
  assert.equal(res.available, true)
})

test("embedChunkDetailed removes the caller abort listener after response body settles", async () => {
  const listeners = new Set()
  let added = 0
  let removed = 0
  const signal = {
    aborted: false,
    addEventListener(type, listener) {
      assert.equal(type, "abort")
      added += 1
      listeners.add(listener)
    },
    removeEventListener(type, listener) {
      assert.equal(type, "abort")
      removed += 1
      listeners.delete(listener)
    },
  }
  const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.25)
  let capturedRequest

  const res = await embedChunkDetailed("x", {
    endpoint: "http://127.0.0.1:11434",
    fetch: async (_url, request) => {
      capturedRequest = request
      return { ok: true, json: async () => ({ embedding: vec }) }
    },
    signal,
  })

  assert.equal(res.available, true)
  assert.ok(capturedRequest.signal)
  assert.equal(added, 1)
  assert.equal(removed, 1)
  assert.equal(listeners.size, 0)
})

test("embedChunkDetailed uses global fetch when no fetch override is passed", async () => {
  const oldFetch = globalThis.fetch
  const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.25)
  globalThis.fetch = mockOkFetch(vec)
  try {
    const res = await embedChunkDetailed("x", {
      endpoint: "http://127.0.0.1:11434",
    })
    assert.equal(res.available, true)
    assert.equal(res.vector.length, EMBEDDING_DIM)
  } finally {
    globalThis.fetch = oldFetch
  }
})

test("embedChunkDetailed works when AbortController is unavailable", async () => {
  const oldAbortController = globalThis.AbortController
  const controller = new AbortController()
  const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.25)
  let capturedRequest
  globalThis.AbortController = undefined
  try {
    const res = await embedChunkDetailed("x", {
      endpoint: "http://127.0.0.1:11434",
      fetch: async (_url, request) => {
        capturedRequest = request
        return { ok: true, json: async () => ({ embedding: vec }) }
      },
      signal: controller.signal,
    })
    assert.equal(res.available, true)
    assert.equal(res.vector.length, EMBEDDING_DIM)
    assert.strictEqual(capturedRequest.signal, controller.signal)
  } finally {
    globalThis.AbortController = oldAbortController
  }
})

test("embedChunkDetailed stringifies non-Error network failures", async () => {
  const res = await embedChunkDetailed("x", {
    endpoint: "http://127.0.0.1:11434",
    fetch: async () => {
      throw "offline"
    },
  })
  assert.equal(res.available, false)
  assert.equal(res.diagnostic.reason, "network_error")
  assert.equal(res.diagnostic.message, "offline")
})

test("embedChunkDetailed reports a null response as an HTTP error", async () => {
  const res = await embedChunkDetailed("x", {
    endpoint: "http://127.0.0.1:11434",
    fetch: async () => null,
  })
  assert.equal(res.available, false)
  assert.equal(res.diagnostic.reason, "http_error")
  assert.equal(res.diagnostic.message, "no response")
})

test("embedChunkDetailed falls back to statusText for non-JSON errors", async () => {
  const res = await embedChunkDetailed("x", {
    endpoint: "http://127.0.0.1:11434",
    fetch: async () => ({
      ok: false,
      status: 500,
      statusText: "plain failure",
      json: async () => {
        throw new Error("not json")
      },
    }),
  })
  assert.equal(res.available, false)
  assert.equal(res.diagnostic.reason, "http_500")
  assert.equal(res.diagnostic.message, "plain failure")
})

test("probeEmbeddingService returns availability diagnostics", async () => {
  const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.5)
  const res = await probeEmbeddingService({
    endpoint: "http://127.0.0.1:11434",
    fetch: mockOkFetch(vec),
  })
  assert.equal(res.available, true)
  assert.equal(res.diagnostic.reason, "ok")
})

test("embedChunk tries OLLAMA_HOST before default localhost fallbacks", async () => {
  const oldHost = process.env.OLLAMA_HOST
  const oldEndpoint = process.env.DESK_EMBED_ENDPOINT
  const oldOllamaEndpoint = process.env.DESK_OLLAMA_ENDPOINT
  delete process.env.DESK_EMBED_ENDPOINT
  delete process.env.DESK_OLLAMA_ENDPOINT
  process.env.OLLAMA_HOST = "http://10.0.0.8:11434"
  const calls = []
  const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.25)
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.includes("10.0.0.8")) throw new Error("not reachable")
    return { ok: true, json: async () => ({ embedding: vec }) }
  }

  try {
    const out = await embedChunk("hello", { fetch: fetchImpl })
    assert.equal(out.length, EMBEDDING_DIM)
    assert.equal(calls[0], "http://10.0.0.8:11434/api/embeddings")
    assert.equal(calls[1], "http://127.0.0.1:11434/api/embeddings")
  } finally {
    if (oldHost == null) delete process.env.OLLAMA_HOST
    else process.env.OLLAMA_HOST = oldHost
    if (oldEndpoint == null) delete process.env.DESK_EMBED_ENDPOINT
    else process.env.DESK_EMBED_ENDPOINT = oldEndpoint
    if (oldOllamaEndpoint == null) delete process.env.DESK_OLLAMA_ENDPOINT
    else process.env.DESK_OLLAMA_ENDPOINT = oldOllamaEndpoint
  }
})

test("embedding endpoints normalize host and API path variants", () => {
  const oldEndpoint = process.env.DESK_EMBED_ENDPOINT
  const oldOllamaEndpoint = process.env.DESK_OLLAMA_ENDPOINT
  const oldHost = process.env.OLLAMA_HOST
  process.env.DESK_EMBED_ENDPOINT = "0.0.0.0:11434/api/embed"
  process.env.DESK_OLLAMA_ENDPOINT = "http://example.test:11434/api/embeddings"
  process.env.OLLAMA_HOST = "http://other.test:11434/api/embeddings"
  try {
    const endpoints = resolveEmbeddingEndpoints()
    assert.equal(endpoints[0], "http://127.0.0.1:11434/api/embeddings")
    assert.equal(endpoints[1], "http://example.test:11434/api/embeddings")
    assert.equal(endpoints[2], "http://other.test:11434/api/embeddings")
    assert.deepEqual(resolveEmbeddingEndpoints({ endpoint: "http://[" }), [
      "http://[",
    ])
    assert.deepEqual(resolveEmbeddingEndpoints({ endpoint: "   " }), ["   "])
  } finally {
    if (oldEndpoint == null) delete process.env.DESK_EMBED_ENDPOINT
    else process.env.DESK_EMBED_ENDPOINT = oldEndpoint
    if (oldOllamaEndpoint == null) delete process.env.DESK_OLLAMA_ENDPOINT
    else process.env.DESK_OLLAMA_ENDPOINT = oldOllamaEndpoint
    if (oldHost == null) delete process.env.OLLAMA_HOST
    else process.env.OLLAMA_HOST = oldHost
  }
})

test("embedding endpoint and model can be resolved from environment", () => {
  const oldEndpoint = process.env.DESK_EMBED_ENDPOINT
  const oldModel = process.env.DESK_EMBED_MODEL
  const oldOllamaModel = process.env.OLLAMA_EMBED_MODEL
  process.env.DESK_EMBED_ENDPOINT = "http://example.test:11434"
  process.env.DESK_EMBED_MODEL = "custom-embed"
  try {
    assert.equal(resolveEmbeddingModel(), "custom-embed")
    assert.equal(
      resolveEmbeddingEndpoints()[0],
      "http://example.test:11434/api/embeddings",
    )
  } finally {
    if (oldEndpoint == null) delete process.env.DESK_EMBED_ENDPOINT
    else process.env.DESK_EMBED_ENDPOINT = oldEndpoint
    if (oldModel == null) delete process.env.DESK_EMBED_MODEL
    else process.env.DESK_EMBED_MODEL = oldModel
    if (oldOllamaModel == null) delete process.env.OLLAMA_EMBED_MODEL
    else process.env.OLLAMA_EMBED_MODEL = oldOllamaModel
  }

  delete process.env.DESK_EMBED_MODEL
  process.env.OLLAMA_EMBED_MODEL = "ollama-custom-embed"
  try {
    assert.equal(resolveEmbeddingModel(), "ollama-custom-embed")
  } finally {
    if (oldModel == null) delete process.env.DESK_EMBED_MODEL
    else process.env.DESK_EMBED_MODEL = oldModel
    if (oldOllamaModel == null) delete process.env.OLLAMA_EMBED_MODEL
    else process.env.OLLAMA_EMBED_MODEL = oldOllamaModel
  }
})

test("embedChunk returns null when embedding dimensionality is wrong", async () => {
  const out = await embedChunk("x", { fetch: mockOkFetch([0, 1, 2]) })
  assert.equal(out, null)
})

test("embedChunk coerces non-number vector entries to zero", async () => {
  const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.5)
  vec[10] = "bad"
  const out = await embedChunk("x", { fetch: mockOkFetch(vec) })
  assert.equal(out[10], 0)
})

test("embedChunk returns null when embedding field is missing", async () => {
  const out = await embedChunk("x", {
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  })
  assert.equal(out, null)
})

test("embedChunks stops calling fetch after the first failure", async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    const err = new Error("nope")
    err.code = "ECONNREFUSED"
    throw err
  }
  const out = await embedChunks(["a", "b", "c", "d"], {
    endpoint: "http://127.0.0.1:11434",
    fetch: fetchImpl,
  })
  assert.equal(out.length, 4)
  for (const e of out) assert.equal(e, null)
  // The implementation may probe a chunk or two before giving up; we want
  // it to bail short of doing all 4.
  assert.equal(calls, 1, `expected single call before bail-out, got ${calls}`)
})

test("embedChunks aborts after a non-oversize HTTP failure", async () => {
  let calls = 0
  const out = await embedChunks(["missing model", "small"], {
    endpoint: "http://127.0.0.1:11434",
    fetch: async () => {
      calls += 1
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: "model not found" }),
      }
    },
  })
  assert.equal(calls, 1)
  assert.deepEqual(out, [null, null])
})

test("embedChunks aborts after an HTTP failure with no diagnostic message", async () => {
  let calls = 0
  const out = await embedChunks(["missing model", "small"], {
    endpoint: "http://127.0.0.1:11434",
    fetch: async () => {
      calls += 1
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
      }
    },
  })
  assert.equal(calls, 1)
  assert.deepEqual(out, [null, null])
})

test("embedChunks continues after an oversized chunk failure", async () => {
  const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.75)
  const calls = []
  const fetchImpl = async (_url, request) => {
    const prompt = JSON.parse(request.body).prompt
    calls.push(prompt)
    if (prompt === "too large") {
      return {
        ok: false,
        status: 500,
        json: async () => ({
          error: "the input length exceeds the context length",
        }),
      }
    }
    return { ok: true, json: async () => ({ embedding: vec }) }
  }

  const out = await embedChunks(["too large", "small one", "small two"], {
    endpoint: "http://127.0.0.1:11434",
    fetch: fetchImpl,
  })

  assert.deepEqual(calls, ["too large", "small one", "small two"])
  assert.equal(out[0], null)
  assert.equal(out[1].length, EMBEDDING_DIM)
  assert.equal(out[2].length, EMBEDDING_DIM)
})

test("embedChunks keeps context-length failures chunk-local when a fallback endpoint is down", async () => {
  const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.25)
  const calls = []
  const fetchImpl = async (url, request) => {
    const prompt = JSON.parse(request.body).prompt
    calls.push({ url, prompt })
    if (prompt === "too large" && url.includes("127.0.0.1")) {
      return {
        ok: false,
        status: 500,
        json: async () => ({
          error: "the input length exceeds the context length",
        }),
      }
    }
    if (prompt === "too large") {
      throw new Error("fallback endpoint unavailable")
    }
    return { ok: true, json: async () => ({ embedding: vec }) }
  }

  const out = await embedChunks(["too large", "small"], { fetch: fetchImpl })

  assert.deepEqual(calls.map((call) => call.prompt), [
    "too large",
    "too large",
    "small",
  ])
  assert.equal(out[0], null)
  assert.equal(out[1].length, EMBEDDING_DIM)
})

test("embedChunks happy path returns one vector per chunk", async () => {
  const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.5)
  const out = await embedChunks(["a", "b"], { fetch: mockOkFetch(vec) })
  assert.equal(out.length, 2)
  assert.equal(out[0].length, EMBEDDING_DIM)
  assert.equal(out[1].length, EMBEDDING_DIM)
})
