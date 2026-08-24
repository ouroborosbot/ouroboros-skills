import { existsSync, rmSync } from "node:fs"

import {
  closeDb as defaultCloseDb,
  indexDbPath,
  openDb as defaultOpenDb,
} from "../db/init.js"
import { ensureIndex as defaultEnsureIndex } from "../server-helpers.js"
import {
  createSemanticRepairCoordinator,
  projectSemanticRepairStatus,
  repairMissingVectorBatch,
} from "./semantic-repair.js"
import {
  resolveRootIdentity,
  validateRootIdentity,
} from "./root-identity.js"

const COMPLETE_REPAIR = Object.freeze({
  state: "complete",
  last_error: null,
})
const maintenanceCoordinators = new WeakSet()
const runtimeBindings = new WeakMap()

export function createRootMaintenanceQueue({
  resolveIdentity = resolveRootIdentity,
  validateIdentity = resolveIdentity === resolveRootIdentity
    ? validateRootIdentity
    : () => {},
} = {}) {
  const tails = new Map()

  function run(deskRootOrIdentity, operation) {
    const rootIdentity = typeof deskRootOrIdentity === "string"
      ? resolveIdentity(deskRootOrIdentity)
      : deskRootOrIdentity
    const previous = tails.get(rootIdentity.key) ?? Promise.resolve()
    const result = previous.then(() => {
      validateIdentity(rootIdentity)
      return operation(rootIdentity)
    })
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    tails.set(rootIdentity.key, tail)
    tail.then(() => {
      if (tails.get(rootIdentity.key) === tail) {
        tails.delete(rootIdentity.key)
      }
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
  resolveIdentity = resolveRootIdentity,
  validateIdentity = resolveIdentity === resolveRootIdentity
    ? validateRootIdentity
    : () => {},
  rootQueue = createRootMaintenanceQueue({
    resolveIdentity,
    validateIdentity,
  }),
  openIndex = defaultOpenDb,
  closeIndex = defaultCloseDb,
} = {}) {
  const reindexGenerations = new Map()
  const rootLeases = new WeakMap()
  const repairCoordinator = createRepairCoordinator({
    repairBatch: (options) =>
      rootQueue.run(options.rootIdentity, () =>
        repairBatch({
          ...options,
          deskRoot: options.rootIdentity.key,
        })),
    resolveIdentity,
    validateIdentity,
  })

  function currentReindexGeneration(rootKey) {
    return reindexGenerations.get(rootKey) ?? 0
  }

  function acquireRootLease(deskRoot) {
    const rootLease = Object.freeze({})
    rootLeases.set(rootLease, resolveIdentity(deskRoot))
    return rootLease
  }

  function resolveFreshReadIdentity(deskRoot, rootLease) {
    if (rootLease === undefined) {
      return resolveIdentity(deskRoot)
    }
    const rootIdentity = rootLeases.get(rootLease)
    if (rootIdentity === undefined) {
      throw Object.assign(
        new Error("maintenance root lease is unavailable"),
        { code: "maintenance_root_lease_unavailable" },
      )
    }
    return rootIdentity
  }

  function registerBackgroundRepair({
    rootIdentity,
    index,
    ensureOptions,
    readGeneration,
  }) {
    if (readGeneration !== currentReindexGeneration(rootIdentity.key)) {
      return Promise.resolve({ ...COMPLETE_REPAIR })
    }
    const repairableMissing = repairableMissingVectors(index)
    return repairableMissing > 0
      ? repairCoordinator.start({
          deskRoot: rootIdentity.key,
          rootIdentity,
          embed: ensureOptions.embed ?? {},
        })
      : Promise.resolve({ ...COMPLETE_REPAIR })
  }

  function ensureSearchFreshness({
    deskRoot,
    ensureOptions = {},
  } = {}) {
    const rootIdentity = resolveIdentity(deskRoot)
    const readGeneration = currentReindexGeneration(rootIdentity.key)
    return rootQueue.run(rootIdentity, async () => {
      const root = rootIdentity.key
      const index = await ensureIndex(root, {
        ...ensureOptions,
        skipEmbed: true,
      }, rootIdentity)
      const repair = registerBackgroundRepair({
        rootIdentity,
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
    const rootIdentity = resolveIdentity(deskRoot)
    return rootQueue.run(rootIdentity, () =>
      ensureIndex(rootIdentity.key, ensureOptions, rootIdentity))
  }

  function runFreshRead({
    deskRoot,
    rootLease,
    ensureOptions = {},
    read,
  } = {}) {
    const rootIdentity = resolveFreshReadIdentity(deskRoot, rootLease)
    const readGeneration = currentReindexGeneration(rootIdentity.key)
    return rootQueue.run(rootIdentity, async () => {
      const root = rootIdentity.key
      const index = await ensureIndex(root, {
        ...ensureOptions,
        skipEmbed: true,
      }, rootIdentity)
      validateIdentity(rootIdentity)
      const db = openIndex(root)
      let result
      try {
        result = await read(db, index, { deskRoot: root })
      } finally {
        closeIndex(db)
      }
      registerBackgroundRepair({
        rootIdentity,
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
    const rootIdentity = resolveIdentity(deskRoot)
    const root = rootIdentity.key
    const rootKey = rootIdentity.key
    reindexGenerations.set(
      rootKey,
      currentReindexGeneration(rootKey) + 1,
    )
    const initialCancellation = repairCoordinator.cancel(root, rootIdentity)
    return rootQueue.run(rootIdentity, async () => {
      await initialCancellation
      await repairCoordinator.cancel(root, rootIdentity)
      repairCoordinator.beginExplicitReindex?.(root, rootIdentity)
      try {
        validateIdentity(rootIdentity)
        if (force) {
          await resetIndex({ deskRoot: root })
          validateIdentity(rootIdentity)
        }
        const index = await ensureIndex(root, ensureOptions, rootIdentity)
        repairCoordinator.finishExplicitReindex?.(
          root,
          repairableMissingVectors(index),
          rootIdentity,
        )
        return index
      } catch (error) {
        repairCoordinator.failExplicitReindex?.(root, error, rootIdentity)
        throw error
      }
    })
  }

  function cancelBackgroundRepair(deskRoot) {
    const rootIdentity = resolveIdentity(deskRoot)
    return repairCoordinator.cancel(rootIdentity.key, rootIdentity)
  }

  function semanticRepairSnapshot({
    deskRoot,
    rootLease,
  } = {}) {
    const rootIdentity = rootLease === undefined
      ? null
      : resolveFreshReadIdentity(deskRoot, rootLease)
    return {
      rootIdentity,
      status: projectSemanticRepairStatus(
        repairCoordinator.status(rootIdentity ?? deskRoot),
      ),
    }
  }

  const coordinator = Object.freeze({
    acquireRootLease,
    cancelBackgroundRepair,
    ensureSearchFreshness,
    runExplicitReindex,
    runFreshRead,
    runStartupEnsureIndex,
    semanticRepairSnapshot,
  })
  maintenanceCoordinators.add(coordinator)
  return coordinator
}

function repairableMissingVectors(index) {
  return index?.semantic?.repairable_missing_vectors ??
    index?.semantic?.missing_vectors
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
