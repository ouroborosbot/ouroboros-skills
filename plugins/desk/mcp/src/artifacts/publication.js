import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"

const DEFAULT_LOCK_RETRY_MS = 10
const DEFAULT_LOCK_TIMEOUT_MS = 5000

export async function publishArtifactSet({
  artifactId,
  files,
  validateStaged,
  signal,
  hooks = {},
  fileSystem = fs,
  makeId = randomUUID,
  lockRetryMs = DEFAULT_LOCK_RETRY_MS,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
} = {}) {
  assertPublicationInputs({ artifactId, files, validateStaged })
  const directory = path.dirname(files[0].path)
  const publicationId = makeId()
  const lockPath = path.join(directory, `.${artifactId}.publish.lock`)
  const stageDirectory = path.join(
    directory,
    `.${artifactId}.${publicationId}.stage`,
  )
  const backupDirectory = path.join(
    directory,
    `.${artifactId}.${publicationId}.backup`,
  )
  await fileSystem.mkdir(directory, { recursive: true })
  const releaseLock = await acquirePublicationLock({
    lockPath,
    signal,
    fileSystem,
    lockRetryMs,
    lockTimeoutMs,
  })
  const staged = files.map((file) => ({
    ...file,
    stagedPath: path.join(stageDirectory, path.basename(file.path)),
    backupPath: path.join(backupDirectory, path.basename(file.path)),
  }))
  const backedUp = []
  const published = []
  let operationError
  try {
    await fileSystem.mkdir(stageDirectory, { recursive: true })
    for (const file of staged) {
      throwIfAborted(signal)
      await fileSystem.writeFile(file.stagedPath, file.bytes)
    }
    await validateStaged(Object.fromEntries(
      staged.map((file) => [file.name, file.stagedPath]),
    ))
    await hooks.beforeCommit?.()
    throwIfAborted(signal)
    await fileSystem.mkdir(backupDirectory, { recursive: true })
    await fileSystem.mkdir(backupDirectory, { recursive: true })
    for (const file of staged) {
      if (await fileExists(file.path, fileSystem)) {
        await fileSystem.rename(file.path, file.backupPath)
        backedUp.push(file)
      }
    }
    for (let index = 0; index < staged.length; index += 1) {
      const file = staged[index]
      await hooks.beforeCommitFile?.({
        index,
        name: file.name,
        targetPath: file.path,
      })
      throwIfAborted(signal)
      await fileSystem.rename(file.stagedPath, file.path)
      published.push(file)
    }
  } catch (error) {
    operationError = error
    const rollbackErrors = await rollbackPublication({
      backedUp,
      published,
      fileSystem,
    })
    if (rollbackErrors.length > 0) {
      operationError = new AggregateError(
        [error, ...rollbackErrors],
        "artifact publication failed and rollback was incomplete",
      )
    }
  }

  const cleanupErrors = []
  for (const cleanupPath of [stageDirectory, backupDirectory]) {
    try {
      await fileSystem.rm(cleanupPath, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  try {
    await releaseLock()
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      operationError ? [operationError, ...cleanupErrors] : cleanupErrors,
      "artifact publication cleanup failed",
    )
  }
  if (operationError) throw operationError
}

async function acquirePublicationLock({
  lockPath,
  signal,
  fileSystem,
  lockRetryMs,
  lockTimeoutMs,
}) {
  const startedAt = Date.now()
  let handle
  while (handle === undefined) {
    throwIfAborted(signal)
    try {
      handle = await fileSystem.open(lockPath, "wx")
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      if (Date.now() - startedAt >= lockTimeoutMs) {
        const timeout = new Error("artifact publication lock timed out")
        timeout.code = "artifact_publication_lock_timeout"
        throw timeout
      }
      await delay(lockRetryMs, signal)
    }
  }
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8")
  } catch (error) {
    const cleanupErrors = []
    try {
      await handle.close()
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    try {
      await fileSystem.rm(lockPath, { force: true })
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "artifact publication lock initialization failed",
      )
    }
    throw error
  }
  return async () => {
    let closeError
    try {
      await handle.close()
    } catch (error) {
      closeError = error
    }
    let removeError
    try {
      await fileSystem.rm(lockPath, { force: true })
    } catch (error) {
      removeError = error
    }
    if (closeError || removeError) {
      throw new AggregateError(
        [closeError, removeError].filter(Boolean),
        "artifact publication lock cleanup failed",
      )
    }
  }
}

async function rollbackPublication({
  backedUp,
  published,
  fileSystem,
}) {
  const errors = []
  for (const file of published) {
    try {
      await fileSystem.rm(file.path, { force: true })
    } catch (error) {
      errors.push(error)
    }
  }
  for (const file of backedUp) {
    try {
      await fileSystem.rename(file.backupPath, file.path)
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

async function fileExists(filePath, fileSystem) {
  try {
    await fileSystem.access(filePath)
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

async function delay(milliseconds, signal) {
  throwIfAborted(signal)
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
  throwIfAborted(signal)
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const error = new Error("artifact publication aborted")
  error.name = "AbortError"
  throw error
}

function assertPublicationInputs({ artifactId, files, validateStaged }) {
  if (typeof artifactId !== "string" || artifactId.trim() === "") {
    throw new Error("artifact publication id is required")
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("artifact publication files are required")
  }
  if (typeof validateStaged !== "function") {
    throw new Error("artifact staged-generation validator is required")
  }
  const directories = new Set(files.map((file) => path.dirname(file.path)))
  const names = new Set(files.map((file) => file.name))
  const targets = new Set(files.map((file) => file.path))
  if (
    directories.size !== 1 ||
    names.size !== files.length ||
    targets.size !== files.length ||
    files.some((file) =>
      typeof file.name !== "string" ||
      typeof file.path !== "string" ||
      file.bytes === undefined
    )
  ) {
    throw new Error("artifact publication files must be unique named siblings")
  }
}
