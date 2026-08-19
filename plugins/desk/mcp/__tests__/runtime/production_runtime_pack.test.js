import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../../../..", import.meta.url)),
)
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")
const packageJsonPath = path.join(mcpRoot, "package.json")
const packageLockPath = path.join(mcpRoot, "package-lock.json")
const generatedArtifactsScriptPath = path.join(repoRoot, "scripts", "test-desk-generated-artifacts.cjs")
const workflowPath = path.join(repoRoot, ".github", "workflows", "desk-mcp-tests.yml")
const require = createRequire(import.meta.url)
const generatedArtifacts = require(generatedArtifactsScriptPath)

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"))
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function repoPath(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/")
}

function makeTempPackExpectation(baseExpectation) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-pack-"))
  const packDir = path.join(tempDir, "pack")
  mkdirSync(packDir, { recursive: true })
  const paths = {
    packDir,
    archivePath: path.join(packDir, "runtime-deps.tgz"),
    manifestPath: path.join(packDir, "runtime-deps.manifest.json"),
    checksumPath: path.join(packDir, "runtime-deps.sha256"),
  }
  copyFileSync(baseExpectation.paths.archivePath, paths.archivePath)
  copyFileSync(baseExpectation.paths.manifestPath, paths.manifestPath)
  copyFileSync(baseExpectation.paths.checksumPath, paths.checksumPath)
  return {
    tempDir,
    expectation: {
      ...baseExpectation,
      paths,
      relativePackDir: path.relative(repoRoot, packDir).replaceAll(path.sep, "/"),
      requiredFiles: [
        paths.archivePath,
        paths.manifestPath,
        paths.checksumPath,
      ].map((filePath) => ({
        path: filePath,
        repoPath: path.relative(repoRoot, filePath).replaceAll(path.sep, "/"),
      })),
    },
  }
}

function withTrackedFiles() {
  return { status: 0, stdout: "", stderr: "" }
}

function writeMutatedManifest(expectation, mutate) {
  const manifest = loadJson(expectation.paths.manifestPath)
  mutate(manifest)
  writeFileSync(expectation.paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  return manifest
}

function verifyTempPack(expectation) {
  return generatedArtifacts.verifyPublishedRuntimeDependencyPack({
    expectation,
    spawn: withTrackedFiles,
  })
}

function writeArchiveWithExtraEntry(expectation, entry, body) {
  const contents = generatedArtifacts.extractTarGzContents(expectation.paths.archivePath)
  contents.set(entry, Buffer.from(body, "utf8"))
  const archiveBytes = createTarGz(contents)
  writeFileSync(expectation.paths.archivePath, archiveBytes)
  const archiveSha = sha256(archiveBytes)
  writeFileSync(expectation.paths.checksumPath, `${archiveSha}  runtime-deps.tgz\n`, "utf8")
  writeMutatedManifest(expectation, (manifest) => {
    manifest.archive.sha256 = archiveSha
    contents.set(
      "runtime-deps.manifest.json",
      Buffer.from(JSON.stringify(embeddedManifestForArchive(manifest), null, 2), "utf8"),
    )
  })
  writeFileSync(expectation.paths.archivePath, createTarGz(contents))
}

function writeArchiveContents(expectation, contents) {
  const manifest = loadJson(expectation.paths.manifestPath)
  contents.set(
    "runtime-deps.manifest.json",
    Buffer.from(JSON.stringify(embeddedManifestForArchive(manifest), null, 2), "utf8"),
  )
  let archiveBytes = createTarGz(contents)
  manifest.archive.sha256 = sha256(archiveBytes)
  contents.set(
    "runtime-deps.manifest.json",
    Buffer.from(JSON.stringify(embeddedManifestForArchive(manifest), null, 2), "utf8"),
  )
  archiveBytes = createTarGz(contents)
  manifest.archive.sha256 = sha256(archiveBytes)
  writeFileSync(expectation.paths.archivePath, archiveBytes)
  writeFileSync(expectation.paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  writeFileSync(expectation.paths.checksumPath, `${sha256(archiveBytes)}  runtime-deps.tgz\n`, "utf8")
}

function embeddedManifestForArchive(manifest) {
  const embeddedManifest = structuredClone(manifest)
  embeddedManifest.archive.sha256 = "<archive-sha256-recorded-in-sidecar>"
  return embeddedManifest
}

function createTarGz(contents) {
  const blocks = []
  for (const [name, body] of [...contents.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    blocks.push(tarHeader({ name, size: body.length }))
    blocks.push(body)
    const padding = (512 - (body.length % 512)) % 512
    if (padding > 0) {
      blocks.push(Buffer.alloc(padding))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function tarHeader({ name, size }) {
  const { headerName, prefix } = splitTarPath(name)
  const header = Buffer.alloc(512, 0)
  header.write(headerName, 0, 100, "utf8")
  header.write("0000644\0", 100, 8, "ascii")
  header.write("0000000\0", 108, 8, "ascii")
  header.write("0000000\0", 116, 8, "ascii")
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii")
  header.write("00000000000\0", 136, 12, "ascii")
  header.fill(0x20, 148, 156)
  header.write("0", 156, 1, "ascii")
  header.write("ustar\0", 257, 6, "ascii")
  header.write("00", 263, 2, "ascii")
  if (prefix.length > 0) {
    header.write(prefix, 345, 155, "utf8")
  }
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii")
  return header
}

function splitTarPath(name) {
  if (Buffer.byteLength(name) <= 100) {
    return { headerName: name, prefix: "" }
  }
  const parts = name.split("/")
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join("/")
    const headerName = parts.slice(index).join("/")
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(headerName) <= 100) {
      return { headerName, prefix }
    }
  }
  throw new Error(`test tar path is too long: ${name}`)
}

function gitTracksFile(filePath) {
  const result = spawnSync(
    "git",
    ["ls-files", "--error-unmatch", "--", repoPath(filePath)],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  )
  return (result.status ?? 1) === 0
}

function workflowJob(workflow, jobName) {
  const lines = workflow.split(/\r?\n/u)
  const jobStart = lines.findIndex((line) => line === `  ${jobName}:`)
  assert.notEqual(jobStart, -1, `workflow must define job ${jobName}`)
  const jobEnd = lines.findIndex((line, index) => (
    index > jobStart
    && /^  [A-Za-z0-9_-]+:\s*$/u.test(line)
  ))
  return lines.slice(jobStart, jobEnd === -1 ? lines.length : jobEnd).join("\n")
}

function workflowStepBlocks(jobSection) {
  const blocks = []
  let currentBlock
  for (const line of jobSection.split(/\r?\n/u)) {
    if (/^      - /u.test(line)) {
      if (currentBlock !== undefined) {
        blocks.push(currentBlock.join("\n"))
      }
      currentBlock = [line]
      continue
    }
    if (currentBlock !== undefined) {
      currentBlock.push(line)
    }
  }
  if (currentBlock !== undefined) {
    blocks.push(currentBlock.join("\n"))
  }
  return blocks
}

function workflowStepRunText(stepBlock) {
  const lines = stepBlock.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const inline = lines[index].match(/^\s*run:\s+(.+?)\s*$/u)
    if (inline !== null && inline[1] !== "|" && inline[1] !== ">") {
      return inline[1]
    }
    if (/^\s*run:\s*[|>]\s*$/u.test(lines[index])) {
      return lines
        .slice(index + 1)
        .filter((line) => /^\s{10,}\S/u.test(line))
        .map((line) => line.replace(/^\s{10}/u, ""))
        .join("\n")
    }
  }
  return ""
}

function workflowStepWorkingDirectory(stepBlock) {
  const match = stepBlock.match(/^\s*working-directory:\s+(.+?)\s*$/mu)
  return match?.[1]?.replace(/^["']|["']$/gu, "")
}

function workflowStepAllowsFailure(stepBlock) {
  const match = stepBlock.match(/^\s*continue-on-error:\s+(.+?)\s*$/mu)
  return match !== null && !/^["']?false["']?$/iu.test(match[1])
}

function workflowScriptArgsAreReal(args) {
  return !/(?:^|\s)--help(?:\s|$)/u.test(args)
    && !/(?:^|\s)(?:\|\||&&|\||;)(?:\s|$)/u.test(args)
}

function workflowLineRunsGeneratedArtifactVerifier(line) {
  const envPrefix = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*`
  const match = line.match(new RegExp(`^${envPrefix}node\\s+scripts/test-desk-generated-artifacts\\.cjs(?:\\s+(?<args>.*)|$)`, "u"))
  return match !== null && workflowScriptArgsAreReal(match.groups?.args ?? "")
}

function workflowLineRunsMcpScript(line, scriptName, { requirePrefix = false } = {}) {
  const envPrefix = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*`
  const escapedScriptName = scriptName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  const prefixPattern = String.raw`npm\s+--prefix\s+plugins/desk/mcp\s+run\s+${escapedScriptName}(?:\s+(?<prefixArgs>.*)|$)`
  const workingDirPattern = String.raw`npm\s+run\s+${escapedScriptName}(?:\s+(?<workingDirArgs>.*)|$)`
  const match = line.match(new RegExp(`^${envPrefix}(?:${prefixPattern}${requirePrefix ? "" : `|${workingDirPattern}`})`, "u"))
  const args = match?.groups?.prefixArgs ?? match?.groups?.workingDirArgs ?? ""
  return match !== null && workflowScriptArgsAreReal(args)
}

function workflowStepRunsGeneratedArtifactVerifier(stepBlock) {
  if (workflowStepAllowsFailure(stepBlock)) {
    return false
  }
  const workingDirectory = workflowStepWorkingDirectory(stepBlock)
  if (workingDirectory !== undefined && workingDirectory !== ".") {
    return false
  }
  return workflowStepRunText(stepBlock)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .some((line) => workflowLineRunsGeneratedArtifactVerifier(line))
}

function workflowStepRunsMcpScript(stepBlock, scriptName) {
  if (workflowStepAllowsFailure(stepBlock)) {
    return false
  }
  const runLines = workflowStepRunText(stepBlock)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
  const runsCommand = runLines.some((line) => workflowLineRunsMcpScript(line, scriptName))
  if (!runsCommand) {
    return false
  }
  return (
    workflowStepWorkingDirectory(stepBlock) === "plugins/desk/mcp"
    || runLines.some((line) => workflowLineRunsMcpScript(line, scriptName, { requirePrefix: true }))
  )
}

function workflowStepOrder(jobSection) {
  const blocks = workflowStepBlocks(jobSection)
  return {
    generatedArtifactCheck: blocks.findIndex((stepBlock) => workflowStepRunsGeneratedArtifactVerifier(stepBlock)),
    runtimePackBuild: blocks.findIndex((stepBlock) => workflowStepRunsMcpScript(stepBlock, "runtime:deps-pack:build")),
  }
}

test("production runtime dependency pack is committed at the current canonical path", async () => {
  const packageJson = loadJson(packageJsonPath)
  const expectations = await generatedArtifacts.productionRuntimePackExpectations({
    repoRoot,
    mcpRoot,
  })

  assert.deepEqual(
    expectations.map((expectation) => expectation.target),
    ["darwin-arm64-node-127", "win32-x64-node-137"],
  )
  for (const expectation of expectations) {
    const expectedPackDir = path.join(
      mcpRoot,
      "artifacts",
      "runtime-deps",
      packageJson.version,
      expectation.target,
      expectation.prodDependencyLockHash,
    )
    const requiredFiles = [
      expectation.paths.archivePath,
      expectation.paths.manifestPath,
      expectation.paths.checksumPath,
    ]

    assert.equal(expectation.paths.packDir, expectedPackDir)
    assert.equal(repoPath(expectation.paths.packDir).startsWith("plugins/desk/mcp/artifacts/runtime-deps/"), true)
    assert.equal(repoPath(expectation.paths.packDir).includes("__tests__/fixtures"), false)
    assert.deepEqual(
      requiredFiles.filter((filePath) => !existsSync(filePath)).map(repoPath),
      [],
      "production runtime dependency pack files must be present under the canonical current lock path",
    )
    assert.deepEqual(
      requiredFiles.filter((filePath) => !gitTracksFile(filePath)).map(repoPath),
      [],
      "production runtime dependency pack files must be tracked by git, not generated only in a local workspace",
    )

    const verification = generatedArtifacts.verifyPublishedRuntimeDependencyPack({ expectation })
    assert.deepEqual(verification.errors, [])
    assert.equal(verification.ok, true)
  }
})

test("production runtime dependency pack manifest records freshness and dependency-only provenance", async () => {
  const [expectation] = await generatedArtifacts.productionRuntimePackExpectations({
    repoRoot,
    mcpRoot,
  })
  assert.equal(
    existsSync(expectation.paths.manifestPath),
    true,
    `production runtime dependency pack manifest must exist at ${repoPath(expectation.paths.manifestPath)}`,
  )
  const manifest = loadJson(expectation.paths.manifestPath)
  const packageJson = loadJson(packageJsonPath)

  assert.equal(manifest.schema_version, 1)
  assert.equal(manifest.plugin.name, packageJson.name)
  assert.equal(manifest.plugin.version, packageJson.version)
  assert.equal(manifest.platform.os, expectation.platform)
  assert.equal(manifest.platform.arch, expectation.arch)
  assert.equal(manifest.platform.node_abi, expectation.nodeAbi)
  assert.equal(manifest.package_lock.path, "plugins/desk/mcp/package-lock.json")
  assert.equal(manifest.package_lock.sha256, sha256(readFileSync(packageLockPath)))
  assert.equal(manifest.package_lock.prod_dependency_lock_hash, expectation.prodDependencyLockHash)
  assert.match(manifest.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  assert.equal(manifest.provenance.builder, "runtime:deps-pack:build")
  assert.match(manifest.provenance.source, /\S/u)
  assert.doesNotMatch(manifest.provenance.source, /fixture|test-only/u)
  assert.equal(manifest.archive.file, "runtime-deps.tgz")
  assert.equal(manifest.archive.sha256, sha256(readFileSync(expectation.paths.archivePath)))
  assert.equal(manifest.archive.contains_server_source, false)
  assert.deepEqual(
    [...manifest.archive.root_entries].sort(),
    [
      "node_modules/",
      "package.json",
      "package-lock.json",
      "runtime-deps.manifest.json",
    ].sort(),
  )
})

test("generated artifact freshness script verifies the production runtime dependency pack", () => {
  const result = spawnSync(
    process.execPath,
    [generatedArtifactsScriptPath],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  )

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
})

test("runtime archive extraction handles tar prefixes, blank sizes, and null file types", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "desk-production-pack-tar-"))
  try {
    const longEntry = `node_modules/${"a".repeat(90)}/index.js`
    const prefixedArchive = path.join(tempDir, "prefixed.tgz")
    writeFileSync(prefixedArchive, createTarGz(new Map([
      [longEntry, Buffer.from("prefixed file", "utf8")],
    ])))

    const prefixedEntries = generatedArtifacts.extractTarGzContents(prefixedArchive)
    assert.equal(prefixedEntries.get(longEntry).toString("utf8"), "prefixed file")

    const nullTypeHeader = Buffer.alloc(512, 0)
    nullTypeHeader.write("empty-null-type.json", 0, 100, "utf8")
    const nullTypeArchive = path.join(tempDir, "null-type.tgz")
    writeFileSync(nullTypeArchive, gzipSync(Buffer.concat([
      nullTypeHeader,
      Buffer.alloc(1024),
    ])))

    const nullTypeEntries = generatedArtifacts.extractTarGzContents(nullTypeArchive)
    assert.deepEqual([...nullTypeEntries.keys()], ["empty-null-type.json"])
    assert.equal(nullTypeEntries.get("empty-null-type.json").length, 0)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test("generated artifact verification uses explicit published targets instead of the verifier host", async () => {
  const expectations = await generatedArtifacts.productionRuntimePackExpectations({
    repoRoot,
    mcpRoot,
  })
  const platformOptionExpectations = await generatedArtifacts.productionRuntimePackExpectations({
    repoRoot,
    mcpRoot,
    platform: "linux",
    arch: "arm64",
    nodeAbi: "127",
  })
  const linuxHostExpectation = await generatedArtifacts.productionRuntimePackExpectation({
    repoRoot,
    mcpRoot,
    platform: "linux",
    arch: "x64",
    nodeAbi: "127",
  })
  const explicitTargetExpectations = await generatedArtifacts.productionRuntimePackExpectations({
    repoRoot,
    mcpRoot,
    targets: [{ platform: "linux", arch: "x64", nodeAbi: "127" }],
  })
  const stdout = []
  const stderr = []

  assert.deepEqual(
    generatedArtifacts.publishedRuntimePackTargets(),
    [
      { platform: "darwin", arch: "arm64", nodeAbi: "127" },
      { platform: "win32", arch: "x64", nodeAbi: "137" },
    ],
  )
  assert.equal(expectations[0].target, "darwin-arm64-node-127")
  assert.equal(expectations[1].target, "win32-x64-node-137")
  assert.deepEqual(platformOptionExpectations.map((expectation) => expectation.target), ["linux-arm64-node-127"])
  assert.equal(linuxHostExpectation.target, "linux-x64-node-127")
  assert.deepEqual(explicitTargetExpectations.map((expectation) => expectation.target), ["linux-x64-node-127"])
  assert.notEqual(linuxHostExpectation.paths.packDir, expectations[0].paths.packDir)

  const result = await generatedArtifacts.verifyGeneratedArtifacts({
    repoRoot,
    mcpRoot,
    io: {
      stdout: { write: (text) => stdout.push(text) },
      stderr: { write: (text) => stderr.push(text) },
    },
  })

  assert.equal(result.ok, true)
  assert.deepEqual(
    result.expectations.map((expectation) => expectation.target),
    ["darwin-arm64-node-127", "win32-x64-node-137"],
  )
  assert.match(stdout.join(""), /darwin-arm64-node-127/u)
  assert.match(stdout.join(""), /win32-x64-node-137/u)
  assert.equal(stderr.join(""), "")
})

test("published runtime pack verifier rejects stale, unsafe, or fixture-only artifacts", async () => {
  const [baseExpectation] = await generatedArtifacts.productionRuntimePackExpectations({
    repoRoot,
    mcpRoot,
  })
  const tempDirs = []
  const tempCopy = () => {
    const fixture = makeTempPackExpectation(baseExpectation)
    tempDirs.push(fixture.tempDir)
    return fixture.expectation
  }

  try {
    const missingDir = mkdtempSync(path.join(tmpdir(), "desk-production-pack-missing-"))
    tempDirs.push(missingDir)
    const missingPackDir = path.join(missingDir, "pack")
    const missingExpectation = {
      ...baseExpectation,
      paths: {
        packDir: missingPackDir,
        archivePath: path.join(missingPackDir, "runtime-deps.tgz"),
        manifestPath: path.join(missingPackDir, "runtime-deps.manifest.json"),
        checksumPath: path.join(missingPackDir, "runtime-deps.sha256"),
      },
      requiredFiles: [
        path.join(missingPackDir, "runtime-deps.tgz"),
        path.join(missingPackDir, "runtime-deps.manifest.json"),
        path.join(missingPackDir, "runtime-deps.sha256"),
      ].map((filePath) => ({ path: filePath, repoPath: repoPath(filePath) })),
    }
    assert.match(
      verifyTempPack(missingExpectation).errors.join("\n"),
      /generated artifact missing: .*runtime-deps\.tgz[\s\S]*runtime dependency pack checksum runtime-deps\.sha256 is missing/u,
    )

    const checksumMismatch = tempCopy()
    writeFileSync(checksumMismatch.paths.checksumPath, `${"0".repeat(64)}  runtime-deps.tgz\n`, "utf8")
    assert.match(
      verifyTempPack(checksumMismatch).errors.join("\n"),
      /runtime dependency pack checksum mismatch for runtime-deps\.tgz/u,
    )

    const stalePackageLock = tempCopy()
    writeMutatedManifest(stalePackageLock, (manifest) => {
      manifest.package_lock.sha256 = "0".repeat(64)
    })
    assert.match(
      verifyTempPack(stalePackageLock).errors.join("\n"),
      /package_lock\.sha256 must match plugins\/desk\/mcp\/package-lock\.json/u,
    )

    const staleProductionHash = tempCopy()
    writeMutatedManifest(staleProductionHash, (manifest) => {
      manifest.package_lock.prod_dependency_lock_hash = "1".repeat(64)
    })
    assert.match(
      verifyTempPack(staleProductionHash).errors.join("\n"),
      /prod_dependency_lock_hash must match production dependency closure/u,
    )

    const staleTarget = tempCopy()
    writeMutatedManifest(staleTarget, (manifest) => {
      manifest.platform.os = "linux"
    })
    assert.match(
      verifyTempPack(staleTarget).errors.join("\n"),
      /platform\.os must match target platform/u,
    )

    const malformedManifest = tempCopy()
    writeFileSync(malformedManifest.paths.manifestPath, "{", "utf8")
    assert.match(
      verifyTempPack(malformedManifest).errors.join("\n"),
      /runtime dependency pack manifest must be readable JSON/u,
    )

    const malformedChecksum = tempCopy()
    writeFileSync(malformedChecksum.paths.checksumPath, "not-a-sha  runtime-deps.tgz\n", "utf8")
    assert.match(
      verifyTempPack(malformedChecksum).errors.join("\n"),
      /runtime dependency pack checksum runtime-deps\.sha256 must start with a sha256 hex digest/u,
    )

    const untrackedArtifact = tempCopy()
    const untracked = generatedArtifacts.verifyPublishedRuntimeDependencyPack({
      expectation: untrackedArtifact,
      spawn: () => ({ status: 1, stdout: "", stderr: "" }),
    })
    assert.match(
      untracked.errors.join("\n"),
      /generated artifact must be tracked by git:/u,
    )

    const bundledSource = tempCopy()
    writeArchiveWithExtraEntry(bundledSource, "src/server.js", "export default 'mutable source'\n")
    assert.match(
      verifyTempPack(bundledSource).errors.join("\n"),
      /runtime dependency archive must not include mutable MCP source src\/server\.js/u,
    )

    const missingArchiveRoots = tempCopy()
    writeArchiveContents(missingArchiveRoots, new Map([
      ["package-lock.json", readFileSync(packageLockPath)],
    ]))
    assert.match(
      verifyTempPack(missingArchiveRoots).errors.join("\n"),
      /runtime dependency archive must include root package\.json/u,
    )

    const malformedArchiveJson = tempCopy()
    writeArchiveContents(malformedArchiveJson, new Map([
      ["package.json", Buffer.from("{", "utf8")],
      ["package-lock.json", readFileSync(packageLockPath)],
    ]))
    assert.match(
      verifyTempPack(malformedArchiveJson).errors.join("\n"),
      /runtime dependency archive package\.json must be readable JSON/u,
    )

    const noProductionDependencies = tempCopy()
    writeMutatedManifest(noProductionDependencies, (manifest) => {
      delete manifest.production_dependencies
    })
    writeArchiveContents(noProductionDependencies, new Map([
      ["package.json", readFileSync(packageJsonPath)],
      ["package-lock.json", readFileSync(packageLockPath)],
    ]))
    assert.ok(
      verifyTempPack(noProductionDependencies).errors.length > 0,
      "runtime packs without production dependency metadata must fail closed",
    )

    const missingDependencyMarkers = tempCopy()
    writeArchiveContents(missingDependencyMarkers, new Map([
      ["package.json", readFileSync(packageJsonPath)],
      ["package-lock.json", readFileSync(packageLockPath)],
    ]))
    assert.match(
      verifyTempPack(missingDependencyMarkers).errors.join("\n"),
      /runtime dependency archive must include dependency package marker/u,
    )

    const emptyDependencyRuntime = tempCopy()
    const emptyRuntimeManifest = loadJson(emptyDependencyRuntime.paths.manifestPath)
    writeArchiveContents(emptyDependencyRuntime, new Map([
      ["package.json", readFileSync(packageJsonPath)],
      ["package-lock.json", readFileSync(packageLockPath)],
      ...emptyRuntimeManifest.production_dependencies.map((dependency) => [
        `${dependency.lock_path}/package.json`,
        Buffer.from("{}", "utf8"),
      ]),
    ]))
    assert.match(
      verifyTempPack(emptyDependencyRuntime).errors.join("\n"),
      /runtime dependency archive must include at least one runtime file/u,
    )

    const unexpectedArchiveEntries = tempCopy()
    writeArchiveContents(unexpectedArchiveEntries, new Map([
      ["package.json", readFileSync(packageJsonPath)],
      ["package-lock.json", readFileSync(packageLockPath)],
      ["node_modules/@scope", Buffer.from("bad scoped marker", "utf8")],
      ["node_modules/not-prod/index.js", Buffer.from("not prod", "utf8")],
      ["unexpected-root.txt", Buffer.from("surprise", "utf8")],
    ]))
    assert.match(
      verifyTempPack(unexpectedArchiveEntries).errors.join("\n"),
      /runtime dependency archive must not include non-production dependency/u,
    )
    assert.match(
      verifyTempPack(unexpectedArchiveEntries).errors.join("\n"),
      /runtime dependency archive must not include unexpected root path unexpected-root\.txt/u,
    )

    const stdout = []
    const stderr = []
    const fixtureOnly = await generatedArtifacts.verifyGeneratedArtifacts({
      repoRoot,
      mcpRoot,
      targets: [{ platform: "linux", arch: "x64", nodeAbi: "127" }],
      io: {
        stdout: { write: (text) => stdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
      },
    })
    assert.equal(fixtureOnly.ok, false)
    assert.match(stderr.join(""), /linux-x64-node-127/u)
    assert.match(stderr.join(""), /generated artifact missing/u)
    assert.doesNotMatch(stderr.join(""), /__tests__\/fixtures/u)
    assert.equal(stdout.join(""), "")
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }
})

test("CI checks committed generated artifacts before rebuilding runtime dependency packs", () => {
  const workflow = readFileSync(workflowPath, "utf8")
  const order = workflowStepOrder(workflowJob(workflow, "desk-mcp-tests"))

  assert.notEqual(order.generatedArtifactCheck, -1, "desk MCP workflow must run the generated artifact verifier")
  assert.notEqual(order.runtimePackBuild, -1, "desk MCP workflow must still build runtime dependency packs")
  assert.ok(
    order.generatedArtifactCheck < order.runtimePackBuild,
    "committed generated artifacts must be checked before CI creates fresh local runtime dependency packs",
  )

  const fakeWorkflow = [
    "  desk-mcp-tests:",
    "    steps:",
    "      - name: Fake verifier",
    "        run: echo node scripts/test-desk-generated-artifacts.cjs",
    "      - name: Failure-masked verifier",
    "        continue-on-error: true",
    "        run: node scripts/test-desk-generated-artifacts.cjs",
    "      - name: Comment-only verifier",
    "        run: |",
    "          # node scripts/test-desk-generated-artifacts.cjs",
    "          npm run runtime:deps-pack:build",
    "      - name: Real verifier",
    "        run: node scripts/test-desk-generated-artifacts.cjs",
    "      - name: Build runtime dependency pack",
    "        working-directory: plugins/desk/mcp",
    "        run: npm run runtime:deps-pack:build",
  ].join("\n")
  assert.deepEqual(workflowStepOrder(fakeWorkflow), {
    generatedArtifactCheck: 3,
    runtimePackBuild: 4,
  })
})
