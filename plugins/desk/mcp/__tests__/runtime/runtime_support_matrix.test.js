import { test } from "node:test"
import { strict as assert } from "node:assert"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")

async function loadRuntimeDeps() {
  return import(pathToFileURL(path.join(mcpRoot, "src", "runtime", "runtime-deps.js")))
}

function loadJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

function clone(value) {
  return structuredClone(value)
}

test("committed runtime support matrix equals the physically shipped runtime packs", async () => {
  const {
    buildRuntimeSupportMatrix,
    deriveRuntimeSupportMatrixPath,
    validateRuntimeSupportMatrix,
  } = await loadRuntimeDeps()
  const packageJson = loadJson(path.join(mcpRoot, "package.json"))
  const matrixPath = deriveRuntimeSupportMatrixPath({
    mcpRoot,
    packageJson,
  })
  const committed = loadJson(matrixPath)
  const generated = buildRuntimeSupportMatrix({
    mcpRoot,
    packageJson,
  })

  assert.deepEqual(committed, generated)
  assert.deepEqual(
    validateRuntimeSupportMatrix({
      matrix: committed,
      mcpRoot,
      packageJson,
    }),
    [],
  )
  assert.deepEqual(committed, {
    schema_version: 1,
    plugin: {
      name: "@ourostack/desk-mcp",
      version: "1.3.3",
    },
    targets: [
      {
        id: "darwin-arm64-node-127",
        platform: "darwin",
        arch: "arm64",
        node_abi: "127",
        prod_dependency_lock_hash: "e28611fabac02b7d88a0ad71cd7e282de1ec09e86cefab01e6d4e572136896be",
        archive_sha256: "85a7481dd775988812dccf9613c477270248805e28e0b99b9b73b672edd0d654",
        artifact_path: "darwin-arm64-node-127/e28611fabac02b7d88a0ad71cd7e282de1ec09e86cefab01e6d4e572136896be",
      },
      {
        id: "win32-x64-node-137",
        platform: "win32",
        arch: "x64",
        node_abi: "137",
        prod_dependency_lock_hash: "e28611fabac02b7d88a0ad71cd7e282de1ec09e86cefab01e6d4e572136896be",
        archive_sha256: "2b9bed8508bb16e171254bce218565e411adb4dd7caf65000718ef3713d59d17",
        artifact_path: "win32-x64-node-137/e28611fabac02b7d88a0ad71cd7e282de1ec09e86cefab01e6d4e572136896be",
      },
    ],
  })
})

test("runtime support matrix validation catches omitted, phantom, and metadata-drifted targets", async () => {
  const {
    buildRuntimeSupportMatrix,
    validateRuntimeSupportMatrix,
  } = await loadRuntimeDeps()
  const packageJson = loadJson(path.join(mcpRoot, "package.json"))
  const generated = buildRuntimeSupportMatrix({
    mcpRoot,
    packageJson,
  })
  const cases = [
    {
      name: "omitted target",
      mutate: (matrix) => {
        matrix.targets = []
      },
      pattern: /must exactly match physically shipped runtime packs/u,
    },
    {
      name: "phantom target",
      mutate: (matrix) => {
        matrix.targets.push({
          ...matrix.targets[0],
          id: "linux-x64-node-127",
          platform: "linux",
          arch: "x64",
          artifact_path: "linux-x64-node-127/not-shipped",
        })
      },
      pattern: /must exactly match physically shipped runtime packs/u,
    },
    {
      name: "plugin version drift",
      mutate: (matrix) => {
        matrix.plugin.version = "0.0.0"
      },
      pattern: /plugin\.version/u,
    },
    {
      name: "platform drift",
      mutate: (matrix) => {
        matrix.targets[0].platform = "linux"
      },
      pattern: /platform/u,
    },
    {
      name: "architecture drift",
      mutate: (matrix) => {
        matrix.targets[0].arch = "x64"
      },
      pattern: /arch/u,
    },
    {
      name: "ABI drift",
      mutate: (matrix) => {
        matrix.targets[0].node_abi = "115"
      },
      pattern: /node_abi/u,
    },
    {
      name: "production lock hash drift",
      mutate: (matrix) => {
        matrix.targets[0].prod_dependency_lock_hash = "0".repeat(64)
      },
      pattern: /prod_dependency_lock_hash/u,
    },
    {
      name: "archive checksum drift",
      mutate: (matrix) => {
        matrix.targets[0].archive_sha256 = "0".repeat(64)
      },
      pattern: /archive_sha256/u,
    },
    {
      name: "artifact path drift",
      mutate: (matrix) => {
        matrix.targets[0].artifact_path = "darwin-arm64-node-127/not-the-pack"
      },
      pattern: /artifact_path/u,
    },
  ]

  for (const item of cases) {
    const matrix = clone(generated)
    item.mutate(matrix)
    const errors = validateRuntimeSupportMatrix({
      matrix,
      mcpRoot,
      packageJson,
    })
    assert.ok(errors.length > 0, item.name)
    assert.match(errors.join("\n"), item.pattern, item.name)
  }
})

test("runtime support matrix generation and verification are wired into artifact validation", () => {
  const packageJson = loadJson(path.join(mcpRoot, "package.json"))
  assert.equal(
    packageJson.scripts["runtime:support-matrix:generate"],
    "node scripts/generate-runtime-support-matrix.js",
  )
  assert.equal(
    packageJson.scripts["runtime:support-matrix:verify"],
    "node scripts/verify-runtime-support-matrix.js",
  )
  const validator = readFileSync(
    path.join(mcpRoot, "scripts", "validate-artifacts.js"),
    "utf8",
  )
  assert.match(validator, /verifyRuntimeSupportMatrix/u)
})

test("runtime support matrix generation ignores incomplete layouts and reads complete packs", async () => {
  const { buildRuntimeSupportMatrix } = await loadRuntimeDeps()
  const root = mkdtempSync(path.join(tmpdir(), "desk-support-matrix-layout-"))
  const packageJson = { name: "@fixture/desk-mcp", version: "9.9.9" }
  const versionRoot = path.join(root, "artifacts", "runtime-deps", packageJson.version)
  try {
    assert.deepEqual(buildRuntimeSupportMatrix({ mcpRoot: root, packageJson }).targets, [])

    mkdirSync(versionRoot, { recursive: true })
    writeFileSync(path.join(versionRoot, "not-a-target-directory"), "fixture", "utf8")

    const targetWithFile = path.join(versionRoot, "darwin-x64-node-127")
    mkdirSync(targetWithFile)
    writeFileSync(path.join(targetWithFile, "not-a-lock-directory"), "fixture", "utf8")

    mkdirSync(path.join(versionRoot, "linux-arm64-node-127", "missing-pack"), { recursive: true })

    const packDir = path.join(versionRoot, "linux-x64-node-127", "fixture-lock")
    mkdirSync(packDir, { recursive: true })
    writeFileSync(path.join(packDir, "runtime-deps.tgz"), "archive", "utf8")
    writeFileSync(path.join(packDir, "runtime-deps.manifest.json"), JSON.stringify({
      platform: {
        os: "linux",
        arch: "x64",
        node_abi: 127,
      },
      package_lock: {
        prod_dependency_lock_hash: "fixture-lock",
      },
    }), "utf8")

    const secondPackDir = path.join(versionRoot, "darwin-arm64-node-127", "second-lock")
    mkdirSync(secondPackDir, { recursive: true })
    writeFileSync(path.join(secondPackDir, "runtime-deps.tgz"), "second archive", "utf8")
    writeFileSync(path.join(secondPackDir, "runtime-deps.manifest.json"), JSON.stringify({
      platform: {
        os: "darwin",
        arch: "arm64",
        node_abi: 127,
      },
      package_lock: {
        prod_dependency_lock_hash: "second-lock",
      },
    }), "utf8")

    assert.deepEqual(buildRuntimeSupportMatrix({ mcpRoot: root, packageJson }).targets, [
      {
        id: "darwin-arm64-node-127",
        platform: "darwin",
        arch: "arm64",
        node_abi: "127",
        prod_dependency_lock_hash: "second-lock",
        archive_sha256: "cb7469f44122ba751d137a8fef6a36b8e56c6b524a35d7abfa7677955a252a4d",
        artifact_path: "darwin-arm64-node-127/second-lock",
      },
      {
        id: "linux-x64-node-127",
        platform: "linux",
        arch: "x64",
        node_abi: "127",
        prod_dependency_lock_hash: "fixture-lock",
        archive_sha256: "0eb3e36bfb24dcd9bb1d1bece1531216b59539a8fde17ee80224af0653c92aa3",
        artifact_path: "linux-x64-node-127/fixture-lock",
      },
    ])

    writeFileSync(path.join(packDir, "runtime-deps.manifest.json"), "{", "utf8")
    assert.throws(
      () => buildRuntimeSupportMatrix({ mcpRoot: root, packageJson }),
      SyntaxError,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("runtime support matrix rejects malformed schema and reports load failures", async () => {
  const {
    loadRuntimeSupportMatrix,
    validateRuntimeSupportMatrix,
    verifyRuntimeSupportMatrix,
  } = await loadRuntimeDeps()
  const root = mkdtempSync(path.join(tmpdir(), "desk-support-matrix-invalid-"))
  const packageJson = { name: "@fixture/desk-mcp", version: "9.9.9" }
  const matrixPath = path.join(
    root,
    "artifacts",
    "runtime-deps",
    packageJson.version,
    "support-matrix.json",
  )
  try {
    assert.deepEqual(validateRuntimeSupportMatrix({
      matrix: [],
      mcpRoot: root,
      packageJson,
    }), ["runtime support matrix must be a JSON object"])

    const invalid = {
      schema_version: 2,
      plugin: {},
      targets: [
        [],
        {
          id: "duplicate",
        },
        {
          id: "duplicate",
          platform: "linux",
          arch: "x64",
          node_abi: "127",
          prod_dependency_lock_hash: "hash",
          archive_sha256: "sha",
          artifact_path: "path",
        },
      ],
    }
    const errors = validateRuntimeSupportMatrix({
      matrix: invalid,
      mcpRoot: root,
      packageJson,
    })
    assert.match(errors.join("\n"), /schema_version must be 1/u)
    assert.match(errors.join("\n"), /plugin\.name/u)
    assert.match(errors.join("\n"), /plugin\.version/u)
    assert.match(errors.join("\n"), /target entries must be JSON objects/u)
    assert.match(errors.join("\n"), /is missing platform/u)
    assert.match(errors.join("\n"), /duplicate target duplicate/u)
    assert.match(errors.join("\n"), /target id must match/u)

    assert.deepEqual(validateRuntimeSupportMatrix({
      matrix: { schema_version: 1, plugin: packageJson, targets: null },
      mcpRoot: root,
      packageJson,
    }), ["runtime support matrix targets must be an array"])

    assert.throws(
      () => loadRuntimeSupportMatrix({ mcpRoot: root, packageJson }),
      /runtime support matrix is missing/u,
    )

    mkdirSync(path.dirname(matrixPath), { recursive: true })
    writeFileSync(matrixPath, JSON.stringify({
      schema_version: 2,
      plugin: packageJson,
      targets: [],
    }), "utf8")
    assert.throws(
      () => loadRuntimeSupportMatrix({ mcpRoot: root, packageJson }),
      /schema_version must be 1/u,
    )
    assert.equal(verifyRuntimeSupportMatrix({ mcpRoot: root, packageJson }).ok, false)

    const throwingPackageJson = {}
    Object.defineProperty(throwingPackageJson, "version", {
      get() {
        throw "version unavailable"
      },
    })
    assert.deepEqual(verifyRuntimeSupportMatrix({
      mcpRoot: root,
      packageJson: throwingPackageJson,
    }), {
      ok: false,
      errors: ["version unavailable"],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
