import { promises as fs } from "node:fs"
import { createHash } from "node:crypto"
import * as path from "node:path"
import { ACTIVE_EMBEDDING_SPEC } from "../indexer/spec.js"

const TOMBSTONE_LEDGER_PATH = path.join("artifacts", "tombstones", "tombstones.jsonl")
const TOMBSTONE_FIELDS = new Set([
  "schema_version",
  "document_path",
  "document_hash",
  "reason",
  "redacted_at",
  "effective_from",
  "artifact_rotation_id",
  "actor",
])
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u
const HASH_RE = /^sha256:[a-f0-9]{64}$/u

export function validateTombstoneRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return ["tombstone row must be an object"]
  }

  const diagnostics = []
  for (const field of TOMBSTONE_FIELDS) {
    if (!Object.hasOwn(row, field)) {
      diagnostics.push(`tombstone row missing ${field}`)
    }
  }
  for (const field of Object.keys(row)) {
    if (!TOMBSTONE_FIELDS.has(field)) {
      diagnostics.push(`tombstone row has unsupported field ${field}`)
    }
  }
  if (Object.hasOwn(row, "schema_version") && row.schema_version !== 1) {
    diagnostics.push("tombstone row schema_version is unsupported")
  }
  if (Object.hasOwn(row, "document_path") && !isNormalizedRelativePath(row.document_path)) {
    diagnostics.push("tombstone row document_path must be a normalized relative path")
  }
  if (Object.hasOwn(row, "document_hash") && !isSha256(row.document_hash)) {
    diagnostics.push("tombstone row document_hash must be a sha256 digest")
  }
  if (Object.hasOwn(row, "reason") && !["deleted", "redacted"].includes(row.reason)) {
    diagnostics.push("tombstone row reason is unsupported")
  }
  if (Object.hasOwn(row, "redacted_at") && !isDateTime(row.redacted_at)) {
    diagnostics.push("tombstone row redacted_at must be a date-time string")
  }
  if (Object.hasOwn(row, "effective_from") && !isDateTime(row.effective_from)) {
    diagnostics.push("tombstone row effective_from must be a date-time string")
  }
  if (Object.hasOwn(row, "artifact_rotation_id") && !hasNonEmptyText(row.artifact_rotation_id)) {
    diagnostics.push("tombstone row artifact_rotation_id must be non-empty text")
  }
  if (Object.hasOwn(row, "actor") && !hasNonEmptyText(row.actor)) {
    diagnostics.push("tombstone row actor must be non-empty text")
  }
  return diagnostics
}

export async function loadTombstoneLedger({ pluginRoot } = {}) {
  if (typeof pluginRoot !== "string" || pluginRoot.trim() === "") {
    return {
      valid: true,
      present: false,
      rows: [],
      diagnostics: [],
      ledger_path: null,
    }
  }
  const ledgerPath = path.join(pluginRoot, TOMBSTONE_LEDGER_PATH)
  let body
  try {
    body = await fs.readFile(ledgerPath, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        valid: true,
        present: false,
        rows: [],
        diagnostics: [],
        ledger_path: ledgerPath,
      }
    }
    return invalidLedger({
      diagnostics: ["tombstone ledger file could not be read"],
      ledgerPath,
      present: true,
    })
  }

  const rows = []
  const diagnostics = []
  const lines = body.split(/\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === "") continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      diagnostics.push(`tombstone ledger line ${index + 1} must be valid JSON`)
      continue
    }
    diagnostics.push(...validateTombstoneRow(row))
    rows.push(row)
  }

  if (diagnostics.length > 0) {
    return invalidLedger({ diagnostics, ledgerPath, present: true })
  }
  return {
    valid: true,
    present: true,
    rows,
    diagnostics: [],
    ledger_path: ledgerPath,
  }
}

export function tombstoneDecisionForDoc({ ledger, doc } = {}) {
  if (!ledger?.valid || !Array.isArray(ledger.rows) || !doc) {
    return { tombstoned: false }
  }
  const docHash = canonicalDocumentHash(doc.hash)
  let latest = null
  for (const row of ledger.rows) {
    if (row.document_path === doc.path && row.document_hash === docHash) {
      latest = row
    }
  }
  if (!latest) return { tombstoned: false }
  return {
    tombstoned: true,
    reason: latest.reason,
    artifact_rotation_id: latest.artifact_rotation_id,
  }
}

export async function filterTombstonedDocuments({ pluginRoot, docs = [] } = {}) {
  const ledger = await validTombstoneLedger({ pluginRoot })
  const ledgerFingerprint = tombstoneLedgerFingerprint(ledger)
  if (!ledger.present) {
    return {
      docs: [...docs],
      tombstoned_count: 0,
      ledger_fingerprint: ledgerFingerprint,
    }
  }

  const kept = []
  let tombstonedCount = 0
  for (const doc of docs) {
    const decision = tombstoneDecisionForDoc({ ledger, doc })
    if (decision.tombstoned) {
      tombstonedCount += 1
    } else {
      kept.push(doc)
    }
  }
  return {
    docs: kept,
    tombstoned_count: tombstonedCount,
    ledger_fingerprint: ledgerFingerprint,
  }
}

export async function tombstoneStatusForDocuments({ pluginRoot, docs = [] } = {}) {
  const filtered = await filterTombstonedDocuments({ pluginRoot, docs })
  return {
    tombstoned: filtered.tombstoned_count > 0,
    tombstoned_count: filtered.tombstoned_count,
    ledger_fingerprint: filtered.ledger_fingerprint,
  }
}

export function tombstoneLedgerFingerprint(ledger) {
  if (!ledger?.valid || !Array.isArray(ledger.rows)) return null
  const hash = createHash("sha256")
  for (const row of ledger.rows) {
    hash.update(`${JSON.stringify(row)}\0`)
  }
  return `sha256:${hash.digest("hex")}`
}

export async function assertArtifactDoesNotRepresentTombstones({
  pluginRoot,
  artifact_type,
  represented_documents,
} = {}) {
  const ledger = await loadTombstoneLedger({ pluginRoot })
  if (!ledger.valid) {
    throw artifactTombstoneLedgerInvalidError({ artifact_type, diagnostics: ledger.diagnostics })
  }
  if (!ledger.present) {
    return { allowed: true, redacted_count: 0 }
  }
  const representedDiagnostics = validateRepresentedDocuments(represented_documents)
  if (representedDiagnostics.length > 0) {
    throw representedDocumentsInvalidError({ artifact_type, diagnostics: representedDiagnostics })
  }

  let redactedCount = 0
  for (const doc of represented_documents) {
    const decision = tombstoneDecisionForDoc({ ledger, doc })
    if (decision.tombstoned) redactedCount += 1
  }
  if (redactedCount === 0) return { allowed: true, redacted_count: 0 }

  const error = new Error("artifact represents redacted documents")
  error.code = "artifact_represents_redacted_document"
  error.artifact_type = artifact_type
  error.redacted_count = redactedCount
  throw error
}

export async function assertArtifactInputsDoNotContainTombstones({
  pluginRoot,
  artifact_type,
  sourceDocs,
} = {}) {
  const ledger = await loadTombstoneLedger({ pluginRoot })
  if (!ledger.valid) {
    throw artifactTombstoneLedgerInvalidError({ artifact_type, diagnostics: ledger.diagnostics })
  }
  if (!ledger.present) {
    return { allowed: true, redacted_count: 0 }
  }
  const representedDiagnostics = validateRepresentedDocuments(sourceDocs)
  if (representedDiagnostics.length > 0) {
    throw representedDocumentsInvalidError({ artifact_type, diagnostics: representedDiagnostics })
  }

  let redactedCount = 0
  for (const doc of sourceDocs) {
    const decision = tombstoneDecisionForDoc({ ledger, doc })
    if (decision.tombstoned) redactedCount += 1
  }
  if (redactedCount === 0) return { allowed: true, redacted_count: 0 }

  const error = new Error("artifact input includes redacted documents")
  error.code = "artifact_input_redacted"
  error.artifact_type = artifact_type
  error.redacted_count = redactedCount
  throw error
}

export async function cleanupRotatedArtifacts({
  pluginRoot,
  embeddingSpecId = ACTIVE_EMBEDDING_SPEC.id,
  activeVectorPackIds = [],
  activeSnapshotIds = [],
} = {}) {
  const vectorDir = path.join(pluginRoot, "artifacts", "vector-packs", embeddingSpecId)
  const snapshotDir = path.join(pluginRoot, "artifacts", "snapshots", embeddingSpecId)
  const summary = {
    vector_packs_removed: 0,
    snapshots_removed: 0,
    sidecars_removed: 0,
  }

  summary.sidecars_removed += await cleanupArtifactDir({
    dir: vectorDir,
    primarySuffix: ".jsonl",
    activeIds: new Set(activeVectorPackIds),
    sidecarSuffixes: [".manifest.json", ".sha256"],
    onPrimaryRemoved: () => {
      summary.vector_packs_removed += 1
    },
  })
  summary.sidecars_removed += await cleanupArtifactDir({
    dir: snapshotDir,
    primarySuffix: ".sqlite.zst",
    activeIds: new Set(activeSnapshotIds),
    sidecarSuffixes: [".manifest.json", ".sha256"],
    onPrimaryRemoved: () => {
      summary.snapshots_removed += 1
    },
  })
  return summary
}

async function validTombstoneLedger({ pluginRoot }) {
  const ledger = await loadTombstoneLedger({ pluginRoot })
  if (ledger.valid) return ledger
  throw tombstoneLedgerInvalidError({ diagnostics: ledger.diagnostics })
}

function invalidLedger({ diagnostics, ledgerPath, present }) {
  return {
    valid: false,
    present,
    rows: [],
    diagnostics,
    ledger_path: ledgerPath,
  }
}

function tombstoneLedgerInvalidError({ diagnostics }) {
  const error = new Error("tombstone ledger is invalid")
  error.code = "tombstone_ledger_invalid"
  error.diagnostics = diagnostics
  return error
}

function artifactTombstoneLedgerInvalidError({ artifact_type, diagnostics }) {
  const error = new Error("artifact tombstone ledger is invalid")
  error.code = "artifact_tombstone_ledger_invalid"
  error.artifact_type = artifact_type
  error.diagnostics = diagnostics
  return error
}

function representedDocumentsInvalidError({ artifact_type, diagnostics }) {
  const error = new Error("artifact represented documents are invalid")
  error.code = "artifact_represented_documents_invalid"
  error.artifact_type = artifact_type
  error.diagnostics = diagnostics
  return error
}

function validateRepresentedDocuments(docs) {
  if (!Array.isArray(docs)) return ["artifact represented_documents must be an array"]
  const diagnostics = []
  for (const doc of docs) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      diagnostics.push("artifact represented document must be an object")
      continue
    }
    if (!isNormalizedRelativePath(doc.path)) {
      diagnostics.push("artifact represented document path must be a normalized relative path")
    }
    if (!isSha256(doc.hash)) {
      diagnostics.push("artifact represented document hash must be a sha256 digest")
    }
  }
  return diagnostics
}

async function cleanupArtifactDir({
  dir,
  primarySuffix,
  activeIds,
  sidecarSuffixes,
  onPrimaryRemoved,
}) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") return 0
    throw error
  }

  let sidecarsRemoved = 0
  const primaryNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(primarySuffix))
    .map((entry) => entry.name)
    .sort()
  for (const primaryName of primaryNames) {
    const id = primaryName.slice(0, -primarySuffix.length)
    if (activeIds.has(id)) continue
    await fs.rm(path.join(dir, primaryName), { force: true })
    onPrimaryRemoved()
    for (const suffix of sidecarSuffixes) {
      const sidecar = path.join(dir, `${id}${suffix}`)
      if (await removeIfExists(sidecar)) sidecarsRemoved += 1
    }
  }
  return sidecarsRemoved
}

async function removeIfExists(filePath) {
  try {
    await fs.rm(filePath)
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

function isNormalizedRelativePath(value) {
  if (typeof value !== "string") return false
  if (value.trim() === "" || value !== value.trim()) return false
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false
  if (value.includes("\\") || value.includes("//")) return false
  const segments = value.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false
  }
  return path.posix.normalize(value) === value
}

function isSha256(value) {
  return typeof value === "string" && HASH_RE.test(value)
}

function canonicalDocumentHash(value) {
  return String(value).startsWith("sha256:") ? value : `sha256:${value}`
}

function isDateTime(value) {
  if (typeof value !== "string" || !DATE_TIME_RE.test(value)) return false
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return false
  return new Date(parsed).toISOString() === normalizeDateTime(value)
}

function normalizeDateTime(value) {
  return value.includes(".") ? value : value.replace(/Z$/u, ".000Z")
}

function hasNonEmptyText(value) {
  return typeof value === "string" && value.trim() !== ""
}
