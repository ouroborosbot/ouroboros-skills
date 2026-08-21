import { existsSync, rmSync } from "node:fs"
import * as path from "node:path"

import { indexDbPath } from "../db/init.js"
import { ensureIndex as defaultEnsureIndex } from "../server-helpers.js"
import {
  createSemanticRepairCoordinator,
  repairMissingVectorBatch,
} from "./semantic-repair.js"

const COMPLETE_REPAIR = Object.freeze({
  state: "complete",
  last_error: null,
})

export function createRootMaintenanceQueue() {
  const tails = new Map()

  function run(deskRoot, operation) {
    const root = canonicalRoot(deskRoot)
    const previous = tails.get(root) ?? Promise.resolve()
    const result = previous.then(() => operation())
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    tails.set(root, tail)
    tail.then(() => {
      if (tails.get(root) === tail) tails.delete(root)
    })
    return result
  }

  return { run }
}

export function createMaintenanceCoordinator({
  ensureIndex = defaultEnsureIndex,
  repairBatch = repairMissingVectorBatch,
  createRepairCoordinator = createSemanticRepairCoordinator,
  resetIndex = resetIndexFiles,
  rootQueue = createRootMaintenanceQueue(),
} = {}) {
  const repairCoordinator = createRepairCoordinator({
    repairBatch: (options) =>
      rootQueue.run(options.deskRoot, () => repairBatch(options)),
  })

  async function ensureSearchFreshness({
    deskRoot,
    ensureOptions = {},
  } = {}) {
    const root = canonicalRoot(deskRoot)
    const index = await rootQueue.run(root, () =>
      ensureIndex(root, {
        ...ensureOptions,
        skipEmbed: true,
      }),
    )
    const repairableMissing =
      index?.semantic?.repairable_missing_vectors ??
      index?.semantic?.missing_vectors ??
      0
    const repair = repairableMissing > 0
      ? repairCoordinator.start({
          deskRoot: root,
          embed: ensureOptions.embed ?? {},
        })
      : Promise.resolve({ ...COMPLETE_REPAIR })
    return { index, repair }
  }

  async function runExplicitReindex({
    deskRoot,
    force = false,
    ensureOptions = {},
  } = {}) {
    const root = canonicalRoot(deskRoot)
    await repairCoordinator.cancel(root)
    return rootQueue.run(root, async () => {
      if (force) await resetIndex({ deskRoot: root })
      return ensureIndex(root, ensureOptions)
    })
  }

  function cancelBackgroundRepair(deskRoot) {
    return repairCoordinator.cancel(canonicalRoot(deskRoot))
  }

  return {
    cancelBackgroundRepair,
    ensureSearchFreshness,
    runExplicitReindex,
  }
}

function resetIndexFiles({ deskRoot }) {
  const dbPath = indexDbPath(deskRoot)
  if (!existsSync(dbPath)) return
  rmSync(dbPath, { force: true })
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
}

function canonicalRoot(deskRoot) {
  if (typeof deskRoot !== "string" || deskRoot.trim() === "") {
    throw new Error("deskRoot is required")
  }
  return path.resolve(deskRoot)
}

export let maintenanceCoordinator = createMaintenanceCoordinator()

export function __setMaintenanceCoordinatorForTests(coordinator) {
  const previous = maintenanceCoordinator
  maintenanceCoordinator = coordinator
  return () => {
    maintenanceCoordinator = previous
  }
}
