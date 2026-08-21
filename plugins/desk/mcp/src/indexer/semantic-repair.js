import * as path from "node:path"

import { closeDb, openDb } from "../db/init.js"
import {
  embedChunkDetailed as defaultEmbedChunkDetailed,
  isChunkLocalEmbeddingFailure,
} from "./embed.js"
import { ACTIVE_EMBEDDING_SPEC } from "./spec.js"

const DEFAULT_BATCH_CHUNKS = 100
const DEFAULT_BATCH_MS = 5000
const SAFE_REPAIR_ERRORS = new Map([
  [
    "embedding_service_unavailable",
    {
      reason: "embedding_service_unavailable",
      message: "embedding endpoint unavailable",
    },
  ],
  [
    "semantic_repair_no_progress",
    {
      reason: "semantic_repair_no_progress",
      message: "semantic repair made no progress",
    },
  ],
])
const GENERIC_REPAIR_ERROR = {
  reason: "semantic_repair_failed",
  message: "semantic repair failed",
}
const ACTIVE_FAILURE_JOIN = `
  f.chunk_key = c.chunk_key AND
  f.text_hash = c.text_hash AND
  f.embedding_spec_id = c.embedding_spec_id AND
  f.chunker_id = c.chunker_id AND
  f.normalization_id = c.normalization_id
`

export function createSemanticRepairCoordinator({
  repairBatch = repairMissingVectorBatch,
  schedule = setTimeout,
  clearScheduled = clearTimeout,
} = {}) {
  const inFlight = new Map()
  const statuses = new Map()

  function status(deskRoot) {
    const root = canonicalRoot(deskRoot)
    const current = statuses.get(root) ?? repairStatus("idle")
    return {
      ...current,
      last_error: current.last_error === null
        ? null
        : { ...current.last_error },
    }
  }

  function finish(entry, nextStatus) {
    if (entry.settled) return
    entry.settled = true
    if (entry.timer !== undefined) {
      clearScheduled(entry.timer)
      entry.timer = undefined
    }
    statuses.set(entry.deskRoot, nextStatus)
    if (inFlight.get(entry.deskRoot) === entry) {
      inFlight.delete(entry.deskRoot)
    }
    entry.resolve(nextStatus)
  }

  function scheduleNext(entry) {
    try {
      const handle = schedule(() => {
        if (entry.settled || entry.controller.signal.aborted) {
          finish(entry, repairStatus("idle"))
          return undefined
        }
        entry.timer = undefined
        const active = runBatch(entry)
        entry.active = active
        return active.finally(() => {
          if (entry.active !== active) return
          entry.active = undefined
          if (entry.controller.signal.aborted) {
            finish(entry, repairStatus("idle"))
          }
        })
      }, 0)
      entry.timer = handle
      handle?.unref?.()
    } catch (error) {
      finish(entry, repairStatus("failed", compactError(error)))
    }
  }

  async function runBatch(entry) {
    try {
      const result = await repairBatch({
        ...entry.repairOptions,
        deskRoot: entry.deskRoot,
        batchChunks: entry.batchChunks,
        batchMs: entry.batchMs,
        signal: entry.controller.signal,
      })
      if (
        entry.controller.signal.aborted ||
        result?.cancelled === true
      ) {
        finish(entry, repairStatus("idle"))
      } else if (result?.remaining_chunks > 0) {
        if (
          !Number.isFinite(result?.processed_chunks) ||
          result.processed_chunks <= 0
        ) {
          finish(
            entry,
            repairStatus(
              "failed",
              compactError({ code: "semantic_repair_no_progress" }),
            ),
          )
        } else {
          scheduleNext(entry)
        }
      } else {
        finish(entry, repairStatus("complete"))
      }
    } catch (error) {
      if (entry.controller.signal.aborted) {
        finish(entry, repairStatus("idle"))
      } else {
        finish(entry, repairStatus("failed", compactError(error)))
      }
    }
  }

  function start({
    deskRoot,
    batchChunks = DEFAULT_BATCH_CHUNKS,
    batchMs = DEFAULT_BATCH_MS,
    ...repairOptions
  } = {}) {
    const root = canonicalRoot(deskRoot)
    const existing = inFlight.get(root)
    if (existing) return existing.promise

    let resolve
    const promise = new Promise((settle) => {
      resolve = settle
    })
    const entry = {
      active: undefined,
      batchChunks,
      batchMs,
      controller: new AbortController(),
      deskRoot: root,
      promise,
      repairOptions,
      resolve,
      settled: false,
      timer: undefined,
    }
    inFlight.set(root, entry)
    statuses.set(root, repairStatus("running"))
    scheduleNext(entry)
    return promise
  }

  async function cancel(deskRoot) {
    const root = canonicalRoot(deskRoot)
    const entry = inFlight.get(root)
    if (!entry) {
      return { ...status(root), cancelled: false }
    }

    entry.controller.abort()
    if (entry.timer !== undefined) {
      clearScheduled(entry.timer)
      entry.timer = undefined
    }
    if (!entry.active) {
      finish(entry, repairStatus("idle"))
    }
    await entry.promise
    return { ...repairStatus("idle"), cancelled: true }
  }

  return { cancel, start, status }
}

export async function repairMissingVectorBatch({
  deskRoot,
  db,
  dbPath,
  batchChunks = DEFAULT_BATCH_CHUNKS,
  batchMs = DEFAULT_BATCH_MS,
  signal,
  embed,
  embedChunkDetailed = defaultEmbedChunkDetailed,
  now = Date.now,
} = {}) {
  requirePositiveInteger(batchChunks, "batchChunks")
  requirePositiveInteger(batchMs, "batchMs")
  const ownsDb = !db
  const database = db ?? openDb(canonicalRoot(deskRoot), { dbPath })

  try {
    const startedAt = now()
    let attemptedChunks = 0
    let processedChunks = 0
    let vectorsIndexed = 0
    let stoppedBy = signal?.aborted ? "cancelled" : null
    const candidates = database.prepare(
      `SELECT
         c.id,
         c.text,
         c.chunk_key,
         c.text_hash,
         c.embedding_spec_id,
         c.chunker_id,
         c.normalization_id
       FROM chunks c
       JOIN docs d ON d.id = c.doc_id
       LEFT JOIN chunk_vecs v ON v.chunk_id = c.id
       LEFT JOIN chunk_embedding_failures f ON ${ACTIVE_FAILURE_JOIN}
       WHERE v.chunk_id IS NULL
         AND f.chunk_key IS NULL
         AND c.embedding_spec_id = ?
         AND c.chunker_id = ?
         AND c.normalization_id = ?
       ORDER BY
         d.is_archived ASC,
         d.updated_at IS NULL ASC,
         d.updated_at DESC,
         c.chunk_index ASC,
         d.path ASC,
         c.id ASC
       LIMIT ?`,
    ).all(
      ACTIVE_EMBEDDING_SPEC.id,
      ACTIVE_EMBEDDING_SPEC.chunker_id,
      ACTIVE_EMBEDDING_SPEC.normalization_id,
      batchChunks,
    )
    const insertVector = database.prepare(
      "INSERT INTO chunk_vecs (chunk_id, embedding) VALUES (?, ?)",
    )
    const currentRepairableCandidate = database.prepare(
      `SELECT 1
       FROM chunks c
       JOIN docs d ON d.id = c.doc_id
       WHERE c.id = @id
         AND c.chunk_key IS @chunk_key
         AND c.text_hash IS @text_hash
         AND c.embedding_spec_id IS @embedding_spec_id
         AND c.chunker_id IS @chunker_id
         AND c.normalization_id IS @normalization_id
         AND NOT EXISTS (
           SELECT 1
           FROM chunk_vecs v
           WHERE v.chunk_id = c.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM chunk_embedding_failures f
           WHERE f.chunk_key IS c.chunk_key
             AND f.text_hash IS c.text_hash
             AND f.embedding_spec_id IS c.embedding_spec_id
             AND f.chunker_id IS c.chunker_id
             AND f.normalization_id IS c.normalization_id
         )`,
    )
    const deleteFailure = database.prepare(
      `DELETE FROM chunk_embedding_failures
       WHERE chunk_key = @chunk_key
         AND text_hash = @text_hash
         AND embedding_spec_id = @embedding_spec_id
         AND chunker_id = @chunker_id
         AND normalization_id = @normalization_id`,
    )
    const upsertFailure = database.prepare(
      `INSERT INTO chunk_embedding_failures (
         chunk_key,
         text_hash,
         embedding_spec_id,
         chunker_id,
         normalization_id,
         reason,
         message,
         failed_at
       )
       VALUES (
         @chunk_key,
         @text_hash,
         @embedding_spec_id,
         @chunker_id,
         @normalization_id,
         @reason,
         @message,
         @failed_at
       )
       ON CONFLICT (
         chunk_key,
         text_hash,
         embedding_spec_id,
         chunker_id,
         normalization_id
       ) DO UPDATE SET
         reason = excluded.reason,
         message = excluded.message,
         failed_at = excluded.failed_at`,
    )
    const persistCandidateResult = database.transaction(
      (candidate, result) => {
        if (!currentRepairableCandidate.get(candidate)) return "stale"

        if (result.vector != null) {
          insertVector.run(
            BigInt(candidate.id),
            new Float32Array(result.vector),
          )
          deleteFailure.run(candidate)
          return "vector"
        }

        upsertFailure.run({
          ...candidate,
          reason: result.diagnostic.reason,
          message: result.diagnostic.message,
          failed_at: new Date().toISOString(),
        })
        return "failure"
      },
    )

    for (const candidate of candidates) {
      if (signal?.aborted) {
        stoppedBy = "cancelled"
        break
      }
      if (attemptedChunks > 0 && now() - startedAt >= batchMs) {
        stoppedBy = "time_limit"
        break
      }

      let result
      try {
        attemptedChunks += 1
        result = await embedChunkDetailed(candidate.text, {
          ...(embed ?? {}),
          signal,
        })
      } catch (error) {
        if (signal?.aborted) {
          stoppedBy = "cancelled"
          break
        }
        throw error
      }

      if (signal?.aborted) {
        stoppedBy = "cancelled"
        break
      }

      if (result?.vector == null) {
        if (!isChunkLocalEmbeddingFailure(result?.diagnostic)) {
          throw embeddingUnavailableError(result?.diagnostic)
        }
      }

      // Lock writers before revalidation so reindex cannot replace the chunk between the identity check and persistence.
      const persistence = persistCandidateResult.immediate(candidate, result)
      if (persistence === "stale") continue
      processedChunks += 1
      if (persistence === "vector") vectorsIndexed += 1

      if (processedChunks >= batchChunks) {
        stoppedBy = "chunk_limit"
        break
      }
      if (now() - startedAt >= batchMs) {
        stoppedBy = "time_limit"
        break
      }
    }

    const remainingChunks = countRepairableMissingVectors(database)
    if (stoppedBy === "cancelled") {
      return {
        processed_chunks: processedChunks,
        vectors_indexed: vectorsIndexed,
        remaining_chunks: remainingChunks,
        stopped_by: "cancelled",
        cancelled: true,
      }
    }
    return {
      processed_chunks: processedChunks,
      vectors_indexed: vectorsIndexed,
      remaining_chunks: remainingChunks,
      stopped_by: remainingChunks === 0
        ? "complete"
        : stoppedBy ?? "chunk_limit",
    }
  } finally {
    if (ownsDb) closeDb(database)
  }
}

function countRepairableMissingVectors(db) {
  return db.prepare(
    `SELECT COUNT(*) AS count
     FROM chunks c
     LEFT JOIN chunk_vecs v ON v.chunk_id = c.id
     LEFT JOIN chunk_embedding_failures f ON ${ACTIVE_FAILURE_JOIN}
     WHERE v.chunk_id IS NULL
       AND f.chunk_key IS NULL
       AND c.embedding_spec_id = ?
       AND c.chunker_id = ?
       AND c.normalization_id = ?`,
  ).get(
    ACTIVE_EMBEDDING_SPEC.id,
    ACTIVE_EMBEDDING_SPEC.chunker_id,
    ACTIVE_EMBEDDING_SPEC.normalization_id,
  ).count
}

function canonicalRoot(deskRoot) {
  if (typeof deskRoot !== "string" || deskRoot.trim() === "") {
    throw new Error("deskRoot is required")
  }
  return path.resolve(deskRoot)
}

function compactError(error) {
  const key = [error?.code, error?.reason, error?.name].find(
    (value) => typeof value === "string",
  )
  return { ...(SAFE_REPAIR_ERRORS.get(key) ?? GENERIC_REPAIR_ERROR) }
}

function embeddingUnavailableError(diagnostic) {
  const error = new Error(
    diagnostic?.message ?? "semantic embedding is unavailable",
  )
  error.code = diagnostic?.reason ?? "semantic_unavailable"
  return error
}

function repairStatus(state, lastError = null) {
  return {
    state,
    last_error: lastError,
  }
}

function requirePositiveInteger(value, label) {
  if (Number.isInteger(value) && value > 0) return
  throw new Error(`${label} must be a positive integer`)
}
