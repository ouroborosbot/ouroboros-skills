import { existsSync, rmSync } from "node:fs"
import * as path from "node:path"

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
  openIndex = defaultOpenDb,
  closeIndex = defaultCloseDb,
} = {}) {
  const reindexGenerations = new Map()
  const repairCoordinator = createRepairCoordinator({
    repairBatch: (options) =>
      rootQueue.run(options.deskRoot, () => repairBatch(options)),
  })

  function currentReindexGeneration(root) {
    return reindexGenerations.get(root) ?? 0
  }

  function registerBackgroundRepair({
    root,
    index,
    ensureOptions,
    readGeneration,
  }) {
    if (readGeneration !== currentReindexGeneration(root)) {
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
    const root = canonicalRoot(deskRoot)
    const readGeneration = currentReindexGeneration(root)
    return rootQueue.run(root, async () => {
      const index = await ensureIndex(root, {
        ...ensureOptions,
        skipEmbed: true,
      })
      const repair = registerBackgroundRepair({
        root,
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
    const root = canonicalRoot(deskRoot)
    return rootQueue.run(root, () => ensureIndex(root, ensureOptions))
  }

  function runFreshRead({
    deskRoot,
    ensureOptions = {},
    read,
  } = {}) {
    const root = canonicalRoot(deskRoot)
    const readGeneration = currentReindexGeneration(root)
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
    const root = canonicalRoot(deskRoot)
    reindexGenerations.set(root, currentReindexGeneration(root) + 1)
    const initialCancellation = repairCoordinator.cancel(root)
    return rootQueue.run(root, async () => {
      await initialCancellation
      await repairCoordinator.cancel(root)
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
    runFreshRead,
    runStartupEnsureIndex,
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

const REQUIRED_COORDINATOR_METHODS = Object.freeze([
  "cancelBackgroundRepair",
  "ensureSearchFreshness",
  "runExplicitReindex",
  "runFreshRead",
  "runStartupEnsureIndex",
])
const RUNTIME_BINDING_BRAND = Symbol("desk-maintenance-runtime-binding")

export function isMaintenanceCoordinator(coordinator) {
  return coordinator !== null &&
    typeof coordinator === "object" &&
    REQUIRED_COORDINATOR_METHODS.every(
      (method) => typeof coordinator[method] === "function",
    )
}

export function createMaintenanceRuntimeBinding(coordinator) {
  if (!isMaintenanceCoordinator(coordinator)) {
    throw new Error("maintenance coordinator is unavailable")
  }
  const runtimeBinding = { maintenanceCoordinator: coordinator }
  Object.defineProperty(runtimeBinding, RUNTIME_BINDING_BRAND, {
    value: coordinator,
  })
  return Object.freeze(runtimeBinding)
}

function isMaintenanceRuntimeBinding(runtimeBinding) {
  return runtimeBinding !== null &&
    typeof runtimeBinding === "object" &&
    Object.isFrozen(runtimeBinding) &&
    runtimeBinding[RUNTIME_BINDING_BRAND] ===
      runtimeBinding.maintenanceCoordinator &&
    isMaintenanceCoordinator(runtimeBinding.maintenanceCoordinator)
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
  if (!isMaintenanceCoordinator(maintenanceCoordinator)) {
    throw new Error("maintenance coordinator is unavailable")
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
