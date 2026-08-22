import { existsSync, rmSync } from "node:fs"

import {
  closeDb as defaultCloseDb,
  indexDbPath,
  openDb as defaultOpenDb,
} from "../db/init.js"
import { ensureIndex as defaultEnsureIndex } from "../server-helpers.js"
import {
  createSemanticRepairCoordinator,
  repairMissingVectorBatch,
} from "./semantic-repair.js"
import { resolveRootIdentity } from "./root-identity.js"

const COMPLETE_REPAIR = Object.freeze({
  state: "complete",
  last_error: null,
})
const maintenanceCoordinators = new WeakSet()
const runtimeBindings = new WeakMap()

export function createRootMaintenanceQueue() {
  const tails = new Map()

  function run(deskRoot, operation) {
    const rootKey = resolveRootIdentity(deskRoot).key
    const previous = tails.get(rootKey) ?? Promise.resolve()
    const result = previous.then(() => operation())
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    tails.set(rootKey, tail)
    tail.then(() => {
      if (tails.get(rootKey) === tail) tails.delete(rootKey)
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
  openIndex = defaultOpenDb,
  closeIndex = defaultCloseDb,
} = {}) {
  const reindexGenerations = new Map()
  const repairCoordinator = createRepairCoordinator({
    repairBatch: (options) =>
      rootQueue.run(options.deskRoot, () => repairBatch(options)),
  })

  function currentReindexGeneration(rootKey) {
    return reindexGenerations.get(rootKey) ?? 0
  }

  function registerBackgroundRepair({
    root,
    rootKey,
    index,
    ensureOptions,
    readGeneration,
  }) {
    if (readGeneration !== currentReindexGeneration(rootKey)) {
      return Promise.resolve({ ...COMPLETE_REPAIR })
    }
    const repairableMissing =
      index?.semantic?.repairable_missing_vectors ??
      index?.semantic?.missing_vectors ??
      0
    return repairableMissing > 0
      ? repairCoordinator.start({
          deskRoot: root,
          embed: ensureOptions.embed ?? {},
        })
      : Promise.resolve({ ...COMPLETE_REPAIR })
  }

  function ensureSearchFreshness({
    deskRoot,
    ensureOptions = {},
  } = {}) {
    const { path: root, key: rootKey } = resolveRootIdentity(deskRoot)
    const readGeneration = currentReindexGeneration(rootKey)
    return rootQueue.run(root, async () => {
      const index = await ensureIndex(root, {
        ...ensureOptions,
        skipEmbed: true,
      })
      const repair = registerBackgroundRepair({
        root,
        rootKey,
        index,
        ensureOptions,
        readGeneration,
      })
      return { index, repair }
    })
  }

  function runStartupEnsureIndex({
    deskRoot,
    ensureOptions = {},
  } = {}) {
    const { path: root } = resolveRootIdentity(deskRoot)
    return rootQueue.run(root, () => ensureIndex(root, ensureOptions))
  }

  function runFreshRead({
    deskRoot,
    ensureOptions = {},
    read,
  } = {}) {
    const { path: root, key: rootKey } = resolveRootIdentity(deskRoot)
    const readGeneration = currentReindexGeneration(rootKey)
    return rootQueue.run(root, async () => {
      const index = await ensureIndex(root, {
        ...ensureOptions,
        skipEmbed: true,
      })
      const db = openIndex(root)
      let result
      try {
        result = await read(db, index)
      } finally {
        closeIndex(db)
      }
      registerBackgroundRepair({
        root,
        rootKey,
        index,
        ensureOptions,
        readGeneration,
      })
      return result
    })
  }

  async function runExplicitReindex({
    deskRoot,
    force = false,
    ensureOptions = {},
  } = {}) {
    const { path: root, key: rootKey } = resolveRootIdentity(deskRoot)
    reindexGenerations.set(
      rootKey,
      currentReindexGeneration(rootKey) + 1,
    )
    const initialCancellation = repairCoordinator.cancel(root)
    return rootQueue.run(root, async () => {
      await initialCancellation
      await repairCoordinator.cancel(root)
      if (force) await resetIndex({ deskRoot: root })
      return ensureIndex(root, ensureOptions)
    })
  }

  function cancelBackgroundRepair(deskRoot) {
    return repairCoordinator.cancel(resolveRootIdentity(deskRoot).path)
  }

  const coordinator = Object.freeze({
    cancelBackgroundRepair,
    ensureSearchFreshness,
    runExplicitReindex,
    runFreshRead,
    runStartupEnsureIndex,
  })
  maintenanceCoordinators.add(coordinator)
  return coordinator
}

function resetIndexFiles({ deskRoot }) {
  const dbPath = indexDbPath(deskRoot)
  if (!existsSync(dbPath)) return
  rmSync(dbPath, { force: true })
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
}

export let maintenanceCoordinator = createMaintenanceCoordinator()

export function isMaintenanceCoordinator(coordinator) {
  return maintenanceCoordinators.has(coordinator)
}

export function createMaintenanceRuntimeBinding(coordinator) {
  if (!isMaintenanceCoordinator(coordinator)) {
    throw new Error("maintenance coordinator is unavailable")
  }
  const runtimeBinding = Object.freeze({
    maintenanceCoordinator: coordinator,
  })
  runtimeBindings.set(runtimeBinding, coordinator)
  return runtimeBinding
}

function isMaintenanceRuntimeBinding(runtimeBinding) {
  const coordinator = runtimeBindings.get(runtimeBinding)
  return coordinator !== undefined &&
    runtimeBinding.maintenanceCoordinator === coordinator &&
    isMaintenanceCoordinator(coordinator)
}

export function resolveRuntimeMaintenance(options = {}) {
  const { opts, runtimeContext } = options
  if (Object.hasOwn(opts ?? {}, "maintenance")) {
    throw new Error(
      "per-tool maintenance override is unsupported; bind one runtime coordinator at server construction",
    )
  }
  const runtimeContextProvided =
    options.runtimeContextProvided ??
    Object.hasOwn(options, "runtimeContext")
  if (runtimeContextProvided) {
    if (!isMaintenanceRuntimeBinding(runtimeContext)) {
      throw new Error("maintenance runtime binding is unavailable or untrusted")
    }
    return runtimeContext.maintenanceCoordinator
  }
  return maintenanceCoordinator
}

export function __setMaintenanceCoordinatorForTests(coordinator) {
  if (!isMaintenanceCoordinator(coordinator)) {
    throw new Error("maintenance coordinator is unavailable")
  }
  const previous = maintenanceCoordinator
  maintenanceCoordinator = coordinator
  return () => {
    maintenanceCoordinator = previous
  }
}
