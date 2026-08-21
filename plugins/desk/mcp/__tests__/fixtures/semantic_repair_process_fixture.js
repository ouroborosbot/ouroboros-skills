import { strict as assert } from "node:assert"
import {
  readFileSync,
  writeFileSync,
} from "node:fs"

import { closeDb, openDb } from "../../src/db/init.js"
import { deterministicProcessRepairVector } from "./semantic_repair_test_vectors.js"

const semanticRepairModuleUrl = new URL(
  "../../src/indexer/semantic-repair.js",
  import.meta.url,
)

function readObservation(observationPath) {
  try {
    return JSON.parse(readFileSync(observationPath, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return {}
    throw error
  }
}

function writeObservation(observationPath, phase, value) {
  const observation = readObservation(observationPath)
  observation[phase] = value
  writeFileSync(
    observationPath,
    `${JSON.stringify(observation, null, 2)}\n`,
    "utf8",
  )
}

function createExitScheduler(onSecondScheduled) {
  const scheduled = []
  const schedule = (callback, delay) => {
    const timer = setTimeout(callback, delay)
    const handle = {
      timer,
      unrefCalls: 0,
      hasRef() {
        return timer.hasRef()
      },
      unref() {
        this.unrefCalls += 1
        timer.unref()
        return this
      },
    }
    const entry = { delay, handle }
    scheduled.push(entry)
    if (scheduled.length === 2) {
      onSecondScheduled(entry)
    }
    return handle
  }
  const clearScheduled = (handle) => {
    clearTimeout(handle.timer)
  }
  return { clearScheduled, schedule, scheduled }
}

function createKeepingAliveScheduler() {
  const handles = new Set()
  const scheduled = []
  let rejectCallback
  const callbackFailure = new Promise((_, reject) => {
    rejectCallback = reject
  })
  const schedule = (callback, delay) => {
    const handle = {
      timer: undefined,
      unrefCalls: 0,
      unref() {
        this.unrefCalls += 1
        // Phase 2 records the unref contract but keeps the native timer referenced.
        return this
      },
    }
    handle.timer = setTimeout(() => {
      handles.delete(handle)
      Promise.resolve().then(callback).catch(rejectCallback)
    }, delay)
    handles.add(handle)
    scheduled.push({ delay, handle })
    return handle
  }
  const clearScheduled = (handle) => {
    clearTimeout(handle.timer)
    handles.delete(handle)
  }
  const clearAll = () => {
    for (const handle of handles) {
      clearTimeout(handle.timer)
    }
    handles.clear()
  }
  return {
    callbackFailure,
    clearAll,
    clearScheduled,
    schedule,
    scheduled,
  }
}

async function runPhaseOne({
  createSemanticRepairCoordinator,
  repairMissingVectorBatch,
}, deskRoot, observationPath) {
  const db = openDb(deskRoot)
  let repairCalls = 0
  let repairSettled = false
  const embeddedTexts = []
  let resolveSecondScheduled
  let rejectSecondScheduled
  const secondScheduled = new Promise((resolve, reject) => {
    resolveSecondScheduled = resolve
    rejectSecondScheduled = reject
  })
  const scheduler = createExitScheduler(resolveSecondScheduled)
  const watchdog = setTimeout(() => {
    rejectSecondScheduled(
      new Error("phase 1 did not schedule the second repair batch"),
    )
  }, 2000)

  try {
    const coordinator = createSemanticRepairCoordinator({
      repairBatch: (options) => {
        repairCalls += 1
        return repairMissingVectorBatch({
          ...options,
          db,
          embedChunkDetailed: async (text) => {
            embeddedTexts.push(text)
            return {
              vector: deterministicProcessRepairVector(
                "phase1",
                embeddedTexts.length,
              ),
              available: true,
              diagnostic: null,
            }
          },
        })
      },
      schedule: scheduler.schedule,
      clearScheduled: scheduler.clearScheduled,
    })
    const repair = coordinator.start({
      deskRoot,
      batchChunks: 1,
      batchMs: 5000,
    })
    repair.then(
      () => {
        repairSettled = true
      },
      (error) => {
        repairSettled = true
        rejectSecondScheduled(error)
      },
    )

    const nextBatch = await secondScheduled
    await Promise.resolve()
    clearTimeout(watchdog)
    assert.equal(repairCalls, 1)
    assert.equal(repairSettled, false)
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM chunk_vecs").get().count,
      1,
    )
    assert.equal(nextBatch.delay, 0)
    assert.equal(nextBatch.handle.unrefCalls, 1)
    assert.equal(nextBatch.handle.hasRef(), false)
    writeObservation(observationPath, "phase1", {
      repair_calls: repairCalls,
      repair_settled: repairSettled,
      embedded_texts: embeddedTexts,
      scheduled: scheduler.scheduled.map(({ delay, handle }) => ({
        delay,
        unref_calls: handle.unrefCalls,
        has_ref: handle.hasRef(),
      })),
    })
  } finally {
    clearTimeout(watchdog)
    closeDb(db)
  }
}

async function runPhaseTwo({
  createSemanticRepairCoordinator,
  repairMissingVectorBatch,
}, deskRoot, observationPath) {
  const db = openDb(deskRoot)
  const scheduler = createKeepingAliveScheduler()
  const embeddedTexts = []
  let repairCalls = 0
  let timeout

  try {
    const coordinator = createSemanticRepairCoordinator({
      repairBatch: (options) => {
        repairCalls += 1
        return repairMissingVectorBatch({
          ...options,
          db,
          embedChunkDetailed: async (text) => {
            embeddedTexts.push(text)
            return {
              vector: deterministicProcessRepairVector(
                "phase2",
                embeddedTexts.length,
              ),
              available: true,
              diagnostic: null,
            }
          },
        })
      },
      schedule: scheduler.schedule,
      clearScheduled: scheduler.clearScheduled,
    })
    const repair = coordinator.start({
      deskRoot,
      batchChunks: 1,
      batchMs: 5000,
    })
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error("phase 2 repair did not settle"))
      }, 5000)
    })
    const result = await Promise.race([
      repair,
      scheduler.callbackFailure,
      timedOut,
    ])
    clearTimeout(timeout)
    assert.equal(result.state, "complete")
    writeObservation(observationPath, "phase2", {
      state: result.state,
      repair_calls: repairCalls,
      embedded_texts: embeddedTexts,
      scheduled: scheduler.scheduled.map(({ delay, handle }) => ({
        delay,
        unref_calls: handle.unrefCalls,
      })),
    })
  } finally {
    clearTimeout(timeout)
    scheduler.clearAll()
    closeDb(db)
  }
}

async function main() {
  const [phase, deskRoot, observationPath] = process.argv.slice(2)
  assert.ok(
    phase === "phase1" || phase === "phase2",
    `unknown semantic repair fixture phase: ${String(phase)}`,
  )
  assert.ok(deskRoot, "semantic repair fixture requires a Desk root")
  assert.ok(
    observationPath,
    "semantic repair fixture requires an observation path",
  )
  const semanticRepair = await import(semanticRepairModuleUrl.href)
  if (phase === "phase1") {
    await runPhaseOne(semanticRepair, deskRoot, observationPath)
    return
  }
  await runPhaseTwo(semanticRepair, deskRoot, observationPath)
}

main().catch((error) => {
  console.error(error?.stack ?? error)
  process.exitCode = 1
})
