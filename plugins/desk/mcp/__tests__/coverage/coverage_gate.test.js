// Unit 0a: red tests for the coverage gate that protects new Desk MCP work.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../../../..", import.meta.url)),
)
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")

async function loadGate() {
  return import(pathToFileURL(path.join(mcpRoot, "src", "coverage", "gate.js")))
}

async function loadRunner() {
  return import(pathToFileURL(path.join(mcpRoot, "src", "coverage", "runner.js")))
}

function makeTempDir() {
  return mkdtempSync(path.join(tmpdir(), "desk-coverage-gate-"))
}

function metrics({ lines = 100, branches = 100, functions = 100, statements = 100 } = {}) {
  return {
    lines: { pct: lines },
    branches: { pct: branches },
    functions: { pct: functions },
    statements: { pct: statements },
  }
}

function writeCoverageSummary(dir, entries) {
  const file = path.join(dir, "coverage-summary.json")
  writeFileSync(
    file,
    JSON.stringify({ total: metrics(), ...entries }, null, 2),
    "utf8",
  )
  return file
}

function writeFixture(dir, name, text) {
  const file = path.join(dir, name)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text, "utf8")
  return file
}

function normalizePaths(paths) {
  return [...paths].map((file) => file.replaceAll(path.sep, "/")).sort()
}

function coverageTable(rows) {
  return [
    "# start of coverage report",
    "# --------------------------------------------------------------",
    "# file          | line % | branch % | funcs % | uncovered lines",
    "# --------------------------------------------------------------",
    ...rows,
    "# --------------------------------------------------------------",
    "# all files     | 100.00 |   100.00 |  100.00 | ",
    "# --------------------------------------------------------------",
    "# end of coverage report",
  ].join("\n")
}

test("coverage gate reports a missing coverage report as a hard failure", async () => {
  const { evaluateCoverageReport } = await loadGate()
  const tmp = makeTempDir()
  try {
    const result = evaluateCoverageReport({
      repoRoot,
      reportPath: path.join(tmp, "missing-coverage-summary.json"),
      requiredFiles: ["plugins/desk/mcp/src/activation/schema.js"],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    })

    assert.equal(result.ok, false)
    assert.match(result.issues.join("\n"), /coverage report.*missing/i)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("coverage gate requires 100% coverage for new MCP entrypoints, source, MCP scripts, and root scripts", async () => {
  const { evaluateCoverageReport } = await loadGate()
  const tmp = makeTempDir()
  try {
    const coveredEntrypoint = "plugins/desk/mcp/index.js"
    const coveredSource = "plugins/desk/mcp/src/activation/schema.js"
    const uncoveredSource = "plugins/desk/mcp/src/activation/validate.js"
    const coveredMcpScript = "plugins/desk/mcp/scripts/activation-support-matrix.js"
    const uncoveredRootScript = "scripts/validate-desk-activation.cjs"
    const reportPath = writeCoverageSummary(tmp, {
      [path.join(repoRoot, coveredEntrypoint)]: metrics(),
      [path.join(repoRoot, coveredSource)]: metrics(),
      [path.join(repoRoot, uncoveredSource)]: metrics({ lines: 99.99 }),
      [path.join(repoRoot, coveredMcpScript)]: metrics(),
      [path.join(repoRoot, uncoveredRootScript)]: metrics({ branches: 50 }),
    })

    const result = evaluateCoverageReport({
      repoRoot,
      reportPath,
      requiredFiles: [
        coveredEntrypoint,
        coveredSource,
        uncoveredSource,
        coveredMcpScript,
        uncoveredRootScript,
      ],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    })

    assert.equal(result.ok, false)
    assert.deepEqual(result.checkedFiles.sort(), [
      coveredEntrypoint,
      coveredMcpScript,
      coveredSource,
      uncoveredRootScript,
      uncoveredSource,
    ].sort())
    assert.match(result.issues.join("\n"), /activation\/validate\.js.*lines.*99\.99/i)
    assert.match(result.issues.join("\n"), /validate-desk-activation\.cjs.*branches.*50/i)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("coverage gate fails when a required new file is absent from the report", async () => {
  const { evaluateCoverageReport } = await loadGate()
  const tmp = makeTempDir()
  try {
    const reportPath = writeCoverageSummary(tmp, {
      [path.join(repoRoot, "plugins/desk/mcp/src/activation/schema.js")]: metrics(),
    })

    const result = evaluateCoverageReport({
      repoRoot,
      reportPath,
      requiredFiles: [
        "plugins/desk/mcp/src/activation/schema.js",
        "plugins/desk/mcp/src/activation/validate.js",
      ],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    })

    assert.equal(result.ok, false)
    assert.match(result.issues.join("\n"), /missing coverage.*activation\/validate\.js/i)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("coverage gate accepts relative report keys and flags missing metric blocks", async () => {
  const { evaluateCoverageReport } = await loadGate()
  const tmp = makeTempDir()
  try {
    const relativeFile = "plugins/desk/mcp/src/activation/schema.js"
    const missingMetricFile = "plugins/desk/mcp/src/activation/validate.js"
    const reportPath = writeCoverageSummary(tmp, {
      [relativeFile]: metrics(),
      [missingMetricFile]: {
        lines: { pct: 100 },
        branches: { pct: 100 },
        functions: { pct: 100 },
      },
    })

    const result = evaluateCoverageReport({
      repoRoot,
      reportPath,
      requiredFiles: [relativeFile, missingMetricFile],
    })

    assert.equal(result.ok, false)
    assert.match(result.issues.join("\n"), /validate\.js.*statements.*undefined/i)
    assert.deepEqual(result.checkedFiles, [relativeFile, missingMetricFile].sort())
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("coverage exclusions require an explicit owner and reason", async () => {
  const { evaluateCoverageReport } = await loadGate()
  const tmp = makeTempDir()
  try {
    const generatedFile = "plugins/desk/mcp/src/activation/generated-support-matrix.js"
    const reportPath = writeCoverageSummary(tmp, {})

    const allowed = evaluateCoverageReport({
      repoRoot,
      reportPath,
      requiredFiles: [generatedFile],
      exclusions: [
        {
          path: generatedFile,
          owner: "Unit 0 coverage gate",
          reason: "generated fixture intentionally verified by freshness tests",
        },
      ],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    })
    assert.equal(allowed.ok, true)
    assert.deepEqual(allowed.excludedFiles, [generatedFile])

    const undocumented = evaluateCoverageReport({
      repoRoot,
      reportPath,
      requiredFiles: [generatedFile],
      exclusions: [{ path: generatedFile }],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    })
    assert.equal(undocumented.ok, false)
    assert.match(undocumented.issues.join("\n"), /exclusion.*owner.*reason/i)

    const missingReason = evaluateCoverageReport({
      repoRoot,
      reportPath,
      requiredFiles: [generatedFile],
      exclusions: [{ path: generatedFile, owner: "Unit 0 coverage gate" }],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    })
    assert.equal(missingReason.ok, false)
    assert.match(missingReason.issues.join("\n"), /exclusion.*owner.*reason/i)

    const blankOwner = evaluateCoverageReport({
      repoRoot,
      reportPath,
      requiredFiles: [generatedFile],
      exclusions: [{ path: generatedFile, owner: " ", reason: "blank owner fixture" }],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    })
    assert.equal(blankOwner.ok, false)
    assert.match(blankOwner.issues.join("\n"), /exclusion.*owner.*reason/i)

    const missingPathExclusion = evaluateCoverageReport({
      repoRoot,
      reportPath,
      requiredFiles: [generatedFile],
      exclusions: [{ owner: "Unit 0 coverage gate", reason: "missing path fixture" }],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    })
    assert.equal(missingPathExclusion.ok, false)
    assert.match(missingPathExclusion.issues.join("\n"), /missing coverage/i)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("coverage command parity rejects CI/local drift", async () => {
  const { assertCoverageCommandParity } = await loadGate()
  const tmp = makeTempDir()
  try {
    const packageJsonPath = writeFixture(
      tmp,
      "package.json",
      JSON.stringify({
        scripts: {
          "test:coverage": "node scripts/run-coverage.js",
        },
      }, null, 2),
    )
    const goodWorkflowPath = writeFixture(
      tmp,
      "good.yml",
      [
        "on:",
        "  pull_request:",
        "    paths:",
        "      - \"plugins/desk/mcp/**\"",
        "      - \"scripts/*.cjs\"",
        "      - \".github/workflows/desk-mcp-tests.yml\"",
        "  push:",
        "    branches:",
        "      - main",
        "    paths:",
        "      - \"plugins/desk/mcp/**\"",
        "      - \"scripts/*.cjs\"",
        "      - \".github/workflows/desk-mcp-tests.yml\"",
        "jobs:",
        "  desk-mcp-tests:",
        "    steps:",
        "      - name: Run Desk MCP coverage",
        "        run: |",
        "          echo preparing coverage gate",
        "          npm run test:coverage",
      ].join("\n"),
    )
    const badWorkflowPath = writeFixture(
      tmp,
      "bad.yml",
      [
        "jobs:",
        "  desk-mcp-tests:",
        "    steps:",
        "      - name: Run Desk MCP tests",
        "        run: npm test",
      ].join("\n"),
    )

    const good = assertCoverageCommandParity({ packageJsonPath, workflowPath: goodWorkflowPath })
    assert.equal(good.ok, true)

    const quotedAndCommentedWorkflowPath = writeFixture(
      tmp,
      "quoted-and-commented.yml",
      [
        "on:",
        "  pull_request:",
        "    paths:",
        "      - plugins/desk/mcp/**",
        "      - scripts/*.cjs # root validation scripts must trigger coverage",
        "      - .github/workflows/desk-mcp-tests.yml",
        "  push:",
        "    paths:",
        "      - plugins/desk/mcp/**",
        "      - 'scripts/*.cjs'",
        "      - .github/workflows/desk-mcp-tests.yml",
        "jobs:",
        "  desk-mcp-tests:",
        "    steps:",
        "      - run: npm run test:coverage",
      ].join("\n"),
    )
    const quotedAndCommented = assertCoverageCommandParity({
      packageJsonPath,
      workflowPath: quotedAndCommentedWorkflowPath,
    })
    assert.equal(quotedAndCommented.ok, true)

    const bad = assertCoverageCommandParity({ packageJsonPath, workflowPath: badWorkflowPath })
    assert.equal(bad.ok, false)
    assert.match(bad.issues.join("\n"), /test:coverage/i)
    assert.match(bad.issues.join("\n"), /npm test/i)

    const badPackageJsonPath = writeFixture(
      tmp,
      "bad-package.json",
      JSON.stringify({
        scripts: {
          "test:coverage": "npm test",
        },
      }, null, 2),
    )
    const badPackage = assertCoverageCommandParity({
      packageJsonPath: badPackageJsonPath,
      workflowPath: goodWorkflowPath,
    })
    assert.equal(badPackage.ok, false)
    assert.match(badPackage.issues.join("\n"), /node scripts\/run-coverage\.js/i)

    const missingRootScriptPathFilter = writeFixture(
      tmp,
      "missing-root-scripts.yml",
      [
        "on:",
        "  pull_request:",
        "    paths:",
        "      - \"plugins/desk/mcp/**\"",
        "      - \".github/workflows/desk-mcp-tests.yml\"",
        "jobs:",
        "  desk-mcp-tests:",
        "    steps:",
        "      - name: Run Desk MCP coverage",
        "        run: npm run test:coverage",
      ].join("\n"),
    )
    const badPathFilter = assertCoverageCommandParity({
      packageJsonPath,
      workflowPath: missingRootScriptPathFilter,
    })
    assert.equal(badPathFilter.ok, false)
    assert.match(badPathFilter.issues.join("\n"), /scripts\/\*\.cjs/i)

    const falsePositiveMention = writeFixture(
      tmp,
      "false-positive-mention.yml",
      [
        "on:",
        "  pull_request:",
        "    paths:",
        "      - \"plugins/desk/mcp/**\"",
        "      - \".github/workflows/desk-mcp-tests.yml\"",
        "  push:",
        "    paths:",
        "      - \"plugins/desk/mcp/**\"",
        "      - \".github/workflows/desk-mcp-tests.yml\"",
        "jobs:",
        "  desk-mcp-tests:",
        "    steps:",
        "      - name: Mention root script glob",
        "        run: echo 'scripts/*.cjs belongs in path filters'",
        "      - name: Run Desk MCP coverage",
        "        run: npm run test:coverage",
      ].join("\n"),
    )
    const falsePositive = assertCoverageCommandParity({
      packageJsonPath,
      workflowPath: falsePositiveMention,
    })
    assert.equal(falsePositive.ok, false)
    assert.match(falsePositive.issues.join("\n"), /pull_request.*scripts\/\*\.cjs/i)
    assert.match(falsePositive.issues.join("\n"), /push.*scripts\/\*\.cjs/i)

    const oneEventOnly = writeFixture(
      tmp,
      "one-event-only.yml",
      [
        "on:",
        "  pull_request:",
        "    paths:",
        "      - \"plugins/desk/mcp/**\"",
        "      - \"scripts/*.cjs\"",
        "      - \".github/workflows/desk-mcp-tests.yml\"",
        "  push:",
        "    paths:",
        "      - \"plugins/desk/mcp/**\"",
        "      - \".github/workflows/desk-mcp-tests.yml\"",
        "jobs:",
        "  desk-mcp-tests:",
        "    steps:",
        "      - name: Run Desk MCP coverage",
        "        run: npm run test:coverage",
      ].join("\n"),
    )
    const partialPathFilter = assertCoverageCommandParity({
      packageJsonPath,
      workflowPath: oneEventOnly,
    })
    assert.equal(partialPathFilter.ok, false)
    assert.doesNotMatch(partialPathFilter.issues.join("\n"), /pull_request.*scripts\/\*\.cjs/i)
    assert.match(partialPathFilter.issues.join("\n"), /push.*scripts\/\*\.cjs/i)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("coverage runner discovers changed files from git state and falls back from origin/main to main", async () => {
  const { collectChangedFiles, collectChangedCoverageFiles, changedSinceMergeBase } = await loadRunner()
  const tmp = makeTempDir()
  try {
    const fixtureRoot = path.join(tmp, "repo")
    const included = [
      "plugins/desk/mcp/index.js",
      "plugins/desk/mcp/src/coverage/gate.js",
      "plugins/desk/mcp/src/coverage/runner.js",
      "plugins/desk/mcp/src/artifacts/manifest-contracts.cjs",
      "plugins/desk/mcp/scripts/run-coverage.js",
      "scripts/test-desk-docs.cjs",
      "scripts/test-desk-generated-artifacts.cjs",
      "scripts/validate-desk-activation.cjs",
    ]
    for (const file of included) writeFixture(fixtureRoot, file, "export {}\n")

    const spawn = (_cmd, args) => {
      const key = args.join(" ")
      if (key === "merge-base origin/main HEAD") {
        return { status: 1, stdout: "", stderr: "no origin/main" }
      }
      if (key === "merge-base main HEAD") {
        return { status: 0, stdout: "base-main\n", stderr: "" }
      }
      if (key === "diff --name-only --diff-filter=AM base-main..HEAD") {
        return {
          status: 0,
          stdout: [
            "plugins/desk/mcp/index.js",
            "plugins/desk/mcp/src/artifacts/manifest-contracts.cjs",
            "plugins/desk/mcp/src/coverage/gate.js",
            "scripts/test-desk-docs.cjs",
            "scripts/test-desk-generated-artifacts.cjs",
            "scripts/validate-desk-activation.cjs",
          ].join("\n"),
          stderr: "",
        }
      }
      if (key === "diff --name-only --diff-filter=AM") {
        return { status: 0, stdout: "plugins/desk/mcp/src/coverage/runner.js\n", stderr: "" }
      }
      if (key === "diff --cached --name-only --diff-filter=AM") {
        return { status: 0, stdout: "plugins/desk/mcp/scripts/run-coverage.js\n", stderr: "" }
      }
      if (key === "ls-files --others --exclude-standard") {
        return { status: 0, stdout: "plugins/desk/mcp/__tests__/coverage/coverage_gate.test.js\n", stderr: "" }
      }
      throw new Error(`unexpected git args: ${key}`)
    }

    assert.deepEqual(
      normalizePaths(changedSinceMergeBase({ repoRoot: fixtureRoot, spawn })),
      [
        "plugins/desk/mcp/index.js",
        "plugins/desk/mcp/src/artifacts/manifest-contracts.cjs",
        "plugins/desk/mcp/src/coverage/gate.js",
        "scripts/test-desk-docs.cjs",
        "scripts/test-desk-generated-artifacts.cjs",
        "scripts/validate-desk-activation.cjs",
      ],
    )
    assert.deepEqual(
      normalizePaths(collectChangedFiles({ repoRoot: fixtureRoot, spawn })),
      [
        "plugins/desk/mcp/__tests__/coverage/coverage_gate.test.js",
        "plugins/desk/mcp/index.js",
        "plugins/desk/mcp/scripts/run-coverage.js",
        "plugins/desk/mcp/src/artifacts/manifest-contracts.cjs",
        "plugins/desk/mcp/src/coverage/gate.js",
        "plugins/desk/mcp/src/coverage/runner.js",
        "scripts/test-desk-docs.cjs",
        "scripts/test-desk-generated-artifacts.cjs",
        "scripts/validate-desk-activation.cjs",
      ],
    )
    assert.deepEqual(
      normalizePaths(collectChangedCoverageFiles({ repoRoot: fixtureRoot, spawn })),
      included.sort(),
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("coverage runner reports no merge-base diff when neither main ref resolves", async () => {
  const { changedSinceMergeBase } = await loadRunner()
  const spawn = () => ({ status: 1, stdout: "", stderr: "missing ref" })
  assert.deepEqual(changedSinceMergeBase({ repoRoot, spawn }), [])
})

test("coverage runner invokes node coverage with include filters and child no-op environment", async () => {
  const { runNodeCoverage } = await loadRunner()
  let captured = null
  const spawn = (cmd, args, options) => {
    captured = { cmd, args, options }
    return { status: 0, stdout: "ok", stderr: "" }
  }

  const result = runNodeCoverage({
    repoRoot: "/fixture/repo",
    requiredFiles: [
      "plugins/desk/mcp/index.js",
      "plugins/desk/mcp/src/coverage/gate.js",
      "plugins/desk/mcp/scripts/run-coverage.js",
    ],
    spawn,
    env: { CUSTOM_ENV: "1" },
  })

  assert.equal(result.status, 0)
  assert.equal(captured.cmd, process.execPath)
  assert.ok(captured.args.includes("--experimental-test-coverage"))
  assert.ok(captured.args.includes("--test-coverage-lines=0"))
  assert.ok(captured.args.includes("--test-coverage-branches=0"))
  assert.ok(captured.args.includes("--test-coverage-functions=0"))
  assert.ok(captured.args.includes("--test-coverage-include=plugins/desk/mcp/index.js"))
  assert.ok(captured.args.includes("--test-coverage-include=plugins/desk/mcp/src/coverage/gate.js"))
  assert.ok(captured.args.includes("--test-coverage-include=plugins/desk/mcp/scripts/run-coverage.js"))
  assert.equal(captured.options.cwd, "/fixture/repo")
  assert.equal(captured.options.env.CUSTOM_ENV, "1")
  assert.equal(captured.options.env.DESK_COVERAGE_RUNNER_CHILD, "1")
})

test("coverage runner include filter removes exclusions without mutating required files", async () => {
  const { filterCoverageIncludeFiles } = await loadRunner()
  const requiredFiles = [
    "plugins/desk/mcp/src/coverage/gate.js",
    "scripts/audit-work-suite-runtime.cjs",
  ]

  assert.deepEqual(filterCoverageIncludeFiles({ requiredFiles }), requiredFiles)
  assert.deepEqual(
    filterCoverageIncludeFiles({
      requiredFiles,
      exclusions: [
        { path: "scripts/audit-work-suite-runtime.cjs" },
        { owner: "missing path fixture", reason: "ignored by include filtering" },
      ],
    }),
    ["plugins/desk/mcp/src/coverage/gate.js"],
  )
  assert.deepEqual(requiredFiles, [
    "plugins/desk/mcp/src/coverage/gate.js",
    "scripts/audit-work-suite-runtime.cjs",
  ])
})

test("coverage runner filters documented exclusions before native Node coverage", async () => {
  const { runCoverageCommand } = await loadRunner()
  const tmp = makeTempDir()
  try {
    const fixtureRoot = path.join(tmp, "repo")
    const configPath = writeFixture(
      fixtureRoot,
      "plugins/desk/mcp/config/coverage-gate.json",
      JSON.stringify({
        thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
        exclusions: [
          {
            path: "scripts/audit-work-suite-runtime.cjs",
            owner: "Work Suite runtime audit",
            reason: "covered by the root work-suite runtime audit test harness",
          },
        ],
      }),
    )
    const packageJsonPath = writeFixture(
      fixtureRoot,
      "plugins/desk/mcp/package.json",
      JSON.stringify({ scripts: { "test:coverage": "node scripts/run-coverage.js" } }),
    )
    const workflowPath = writeFixture(
      fixtureRoot,
      ".github/workflows/desk-mcp-tests.yml",
      [
        "on:",
        "  pull_request:",
        "    paths:",
        "      - \"plugins/desk/mcp/**\"",
        "      - \"scripts/*.cjs\"",
        "      - \".github/workflows/desk-mcp-tests.yml\"",
        "  push:",
        "    paths:",
        "      - \"plugins/desk/mcp/**\"",
        "      - \"scripts/*.cjs\"",
        "      - \".github/workflows/desk-mcp-tests.yml\"",
        "jobs:",
        "  desk-mcp-tests:",
        "    steps:",
        "      - run: npm run test:coverage",
      ].join("\n"),
    )
    writeFixture(fixtureRoot, "plugins/desk/mcp/src/coverage/gate.js", "export {}\n")
    writeFixture(fixtureRoot, "scripts/audit-work-suite-runtime.cjs", "module.exports = {}\n")

    let nodeCoverageArgs = null
    const spawn = (_cmd, args) => {
      const key = args.join(" ")
      if (args[0] === "--test") {
        nodeCoverageArgs = args
        return {
          status: 0,
          stdout: coverageTable([
            "# plugins       |        |          |         | ",
            "#  desk         |        |          |         | ",
            "#   mcp         |        |          |         | ",
            "#    src        |        |          |         | ",
            "#     coverage  |        |          |         | ",
            "#      gate.js  | 100.00 |   100.00 |  100.00 | ",
          ]),
          stderr: "",
        }
      }
      if (key === "merge-base origin/main HEAD") return { status: 0, stdout: "base\n", stderr: "" }
      if (key === "diff --name-only --diff-filter=AM base..HEAD") {
        return {
          status: 0,
          stdout: [
            "plugins/desk/mcp/src/coverage/gate.js",
            "scripts/audit-work-suite-runtime.cjs",
          ].join("\n"),
          stderr: "",
        }
      }
      return { status: 0, stdout: "", stderr: "" }
    }
    const writes = { stdout: "", stderr: "" }
    const fsOps = {
      makeTempDir: () => path.join(tmp, `run-${Date.now()}-${Math.random()}`),
      removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
      readText: (file) => readFileSync(file, "utf8"),
      writeText: (file, text) => writeFixture(path.dirname(file), path.basename(file), text),
    }
    const result = runCoverageCommand({
      paths: {
        repoRoot: fixtureRoot,
        mcpRoot: path.join(fixtureRoot, "plugins/desk/mcp"),
        configPath,
        packageJsonPath,
        workflowPath,
      },
      spawn,
      fsOps,
      io: {
        stdout: { write: (text) => { writes.stdout += text } },
        stderr: { write: (text) => { writes.stderr += text } },
      },
      env: {},
    })

    assert.equal(result, 0)
    assert.ok(nodeCoverageArgs.includes(
      "--test-coverage-include=plugins/desk/mcp/src/coverage/gate.js",
    ))
    assert.ok(!nodeCoverageArgs.includes(
      "--test-coverage-include=scripts/audit-work-suite-runtime.cjs",
    ))
    assert.match(writes.stdout, /passed for 1 changed production file/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("coverage runner parses Node's tree coverage report", async () => {
  const { parseNodeCoverageReport } = await loadRunner()
  const report = parseNodeCoverageReport(coverageTable([
    "# malformed coverage row",
    "# malformed | row",
    "# plugins       |        |          |         | ",
    "#  desk         |        |          |         | ",
    "#   mcp         |        |          |         | ",
    "#    src        |        |          |         | ",
    "#     coverage  |        |          |         | ",
    "#      gate.js  | 100.00 |   100.00 |  100.00 | ",
    "#      runner.js |  98.50 |    75.00 |  100.00 | 12",
    "#      weird.js  | NaN    |   100.00 |  100.00 | ",
  ]))

  assert.equal(report["plugins/desk/mcp/src/coverage/gate.js"].lines.pct, 100)
  assert.equal(report["plugins/desk/mcp/src/coverage/runner.js"].branches.pct, 75)
  assert.equal(report["plugins/desk/mcp/src/coverage/runner.js"].statements.pct, 98.5)
  assert.equal(report["plugins/desk/mcp/src/coverage/weird.js"].lines.pct, null)
  assert.equal(report.total.lines.pct, 100)
})

test("coverage runner returns child status, coverage failures, and success codes", async () => {
  const { runCoverageCommand } = await loadRunner()
  const tmp = makeTempDir()
  try {
    const fixtureRoot = path.join(tmp, "repo")
    const configPath = writeFixture(
      fixtureRoot,
      "plugins/desk/mcp/config/coverage-gate.json",
      JSON.stringify({
        thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
        exclusions: [],
      }),
    )
    const packageJsonPath = writeFixture(
      fixtureRoot,
      "plugins/desk/mcp/package.json",
      JSON.stringify({ scripts: { "test:coverage": "node scripts/run-coverage.js" } }),
    )
    const workflowPath = writeFixture(
      fixtureRoot,
      ".github/workflows/desk-mcp-tests.yml",
      [
        "on:",
        "  pull_request:",
        "    paths:",
        "      - \"plugins/desk/mcp/**\"",
        "      - \"scripts/*.cjs\"",
        "      - \".github/workflows/desk-mcp-tests.yml\"",
        "  push:",
        "    paths:",
        "      - \"plugins/desk/mcp/**\"",
        "      - \"scripts/*.cjs\"",
        "      - \".github/workflows/desk-mcp-tests.yml\"",
        "jobs:",
        "  desk-mcp-tests:",
        "    steps:",
        "      - run: npm run test:coverage",
      ].join("\n"),
    )
    writeFixture(fixtureRoot, "plugins/desk/mcp/src/coverage/gate.js", "export {}\n")

    const makeSpawn = (coverageRows, testStatus = 0) => (_cmd, args) => {
      const key = args.join(" ")
      if (args[0] === "--test") {
        return { status: testStatus, stdout: coverageTable(coverageRows), stderr: "" }
      }
      if (key === "merge-base origin/main HEAD") return { status: 0, stdout: "base\n", stderr: "" }
      if (key === "diff --name-only --diff-filter=AM base..HEAD") {
        return { status: 0, stdout: "plugins/desk/mcp/src/coverage/gate.js\n", stderr: "" }
      }
      return { status: 0, stdout: "", stderr: "" }
    }
    const makeIo = () => {
      const writes = { stdout: "", stderr: "" }
      return {
        writes,
        io: {
          stdout: { write: (text) => { writes.stdout += text } },
          stderr: { write: (text) => { writes.stderr += text } },
        },
      }
    }
    const fsOps = {
      makeTempDir: () => path.join(tmp, `run-${Date.now()}-${Math.random()}`),
      removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
      readText: (file) => readFileSync(file, "utf8"),
      writeText: (file, text) => writeFixture(path.dirname(file), path.basename(file), text),
    }
    const paths = {
      repoRoot: fixtureRoot,
      mcpRoot: path.join(fixtureRoot, "plugins/desk/mcp"),
      configPath,
      packageJsonPath,
      workflowPath,
    }

    const spawnMissingChildStatus = (_cmd, args) => {
      if (args[0] === "--test") return {}
      return makeSpawn([], 0)(_cmd, args)
    }
    assert.equal(
      runCoverageCommand({
        paths,
        spawn: spawnMissingChildStatus,
        fsOps,
        io: makeIo().io,
        env: {},
      }),
      1,
    )

    const failingChild = runCoverageCommand({
      paths,
      spawn: makeSpawn([], 7),
      fsOps,
      io: makeIo().io,
      env: {},
    })
    assert.equal(failingChild, 7)

    const missingCoverageReport = runCoverageCommand({
      paths,
      spawn: (_cmd, args) => {
        if (args[0] === "--test") return { status: 0 }
        return makeSpawn([], 0)(_cmd, args)
      },
      fsOps,
      io: makeIo().io,
      env: {},
    })
    assert.equal(missingCoverageReport, 1)

    const badCoverageIo = makeIo()
    const badCoverage = runCoverageCommand({
      paths,
      spawn: makeSpawn([
        "# plugins       |        |          |         | ",
        "#  desk         |        |          |         | ",
        "#   mcp         |        |          |         | ",
        "#    src        |        |          |         | ",
        "#     coverage  |        |          |         | ",
        "#      gate.js  |  90.00 |   100.00 |  100.00 | 1",
      ]),
      fsOps,
      io: badCoverageIo.io,
      env: {},
    })
    assert.equal(badCoverage, 1)
    assert.match(badCoverageIo.writes.stderr, /coverage-gate.*failed/i)
    assert.match(badCoverageIo.writes.stderr, /gate\.js lines coverage 90/i)

    const successIo = makeIo()
    const success = runCoverageCommand({
      paths,
      spawn: makeSpawn([
        "# plugins       |        |          |         | ",
        "#  desk         |        |          |         | ",
        "#   mcp         |        |          |         | ",
        "#    src        |        |          |         | ",
        "#     coverage  |        |          |         | ",
        "#      gate.js  | 100.00 |   100.00 |  100.00 | ",
      ]),
      fsOps,
      io: successIo.io,
      env: {},
    })
    assert.equal(success, 0)
    assert.match(successIo.writes.stdout, /passed for 1 changed production file/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("coverage runner default wiring uses repo paths, temp files, and stdio", async () => {
  const { runCoverageCommand } = await loadRunner()
  const spawn = (_cmd, args) => {
    const key = args.join(" ")
    if (args[0] === "--test") {
      return {
        status: 0,
        stdout: coverageTable([
          "# plugins              |        |          |         | ",
          "#  desk                |        |          |         | ",
          "#   mcp                |        |          |         | ",
          "#    scripts           |        |          |         | ",
          "#     run-coverage.js  | 100.00 |   100.00 |  100.00 | ",
          "#    src               |        |          |         | ",
          "#     coverage         |        |          |         | ",
          "#      runner.js       | 100.00 |   100.00 |  100.00 | ",
        ]),
        stderr: "",
      }
    }
    if (key === "merge-base origin/main HEAD") return { status: 0, stdout: "base\n", stderr: "" }
    if (key === "diff --name-only --diff-filter=AM base..HEAD") {
      return {
        status: 0,
        stdout: [
          "plugins/desk/mcp/scripts/run-coverage.js",
          "plugins/desk/mcp/src/coverage/runner.js",
        ].join("\n"),
        stderr: "",
      }
    }
    return { status: 0, stdout: "", stderr: "" }
  }

  assert.equal(runCoverageCommand({ spawn, env: {} }), 0)
})

test("coverage runner no-ops when imported by the child coverage process", async () => {
  const { runCoverageCommand } = await loadRunner()
  assert.equal(
    runCoverageCommand({ env: { DESK_COVERAGE_RUNNER_CHILD: "1" } }),
    0,
  )

  const previous = process.env.DESK_COVERAGE_RUNNER_CHILD
  process.env.DESK_COVERAGE_RUNNER_CHILD = "1"
  try {
    assert.equal(runCoverageCommand(), 0)
    await import(`${pathToFileURL(path.join(mcpRoot, "scripts", "run-coverage.js")).href}?child-noop=${Date.now()}`)
  } finally {
    if (previous == null) delete process.env.DESK_COVERAGE_RUNNER_CHILD
    else process.env.DESK_COVERAGE_RUNNER_CHILD = previous
  }
})

test("coverage required-file discovery includes production targets and excludes tests", async () => {
  const { collectCoverageRequiredFiles } = await loadGate()
  const tmp = makeTempDir()
  try {
    const fixtureRoot = path.join(tmp, "repo")
    const included = [
      "plugins/desk/mcp/src/activation/schema.js",
      "plugins/desk/mcp/src/activation/validate.js",
      "plugins/desk/mcp/src/artifacts/manifest-contracts.cjs",
      "plugins/desk/mcp/scripts/activation-support-matrix.js",
      "scripts/test-desk-docs.cjs",
      "scripts/test-desk-generated-artifacts.cjs",
      "scripts/validate-desk-activation.cjs",
    ]
    const excluded = [
      "plugins/desk/mcp/__tests__/coverage/coverage_gate.test.js",
      "plugins/desk/mcp/src/activation/validate.test.js",
      "plugins/desk/mcp/scripts/activation-support-matrix.test.js",
      "plugins/desk/mcp/scripts/test-helper.js",
      "scripts/test-desk-activation.cjs",
      "scripts/test-desk-generated-artifacts.test.cjs",
    ]

    for (const file of [...included, ...excluded]) {
      writeFixture(fixtureRoot, file, "export {}\n")
    }
    writeFixture(fixtureRoot, "plugins/desk/mcp/src/activation/README.md", "docs\n")

    assert.equal(typeof collectCoverageRequiredFiles, "function")
    assert.deepEqual(
      normalizePaths(collectCoverageRequiredFiles({ repoRoot: fixtureRoot })),
      included.sort(),
    )

    assert.deepEqual(
      collectCoverageRequiredFiles({ repoRoot: path.join(tmp, "empty-repo") }),
      [],
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("coverage runner exists and delegates to the coverage gate", () => {
  const runnerPath = path.join(mcpRoot, "scripts", "run-coverage.js")
  const runnerModulePath = path.join(mcpRoot, "src", "coverage", "runner.js")

  assert.ok(
    existsSync(runnerPath),
    "scripts/run-coverage.js must exist as the non-recursive local coverage entrypoint",
  )

  const runner = readFileSync(runnerPath, "utf8")
  const runnerModule = readFileSync(runnerModulePath, "utf8")
  assert.match(
    runner,
    /from\s+["'][^"']*src\/coverage\/runner\.js["']/,
    "coverage runner script must delegate to the tested runner module",
  )
  assert.match(
    runnerModule,
    /(?:from\s+["'][^"']*\.\/gate\.js["']|import\([^)]*\.\/gate\.js[^)]*\))/,
    "coverage runner module must import the coverage gate module",
  )
  assert.match(
    runnerModule,
    /\bcollectCoverageRequiredFiles\s*\(/,
    "coverage runner module must discover required files through the gate",
  )
  assert.match(
    runnerModule,
    /\bevaluateCoverageReport\s*\(/,
    "coverage runner module must evaluate the generated coverage report through the gate",
  )
  assert.match(
    runnerModule,
    /\bassertCoverageCommandParity\s*\(/,
    "coverage runner module must keep local and CI coverage commands in parity through the gate",
  )
  assert.doesNotMatch(
    runner,
    /\bnpm\s+(?:run\s+)?test:coverage\b/,
    "coverage runner must not recursively invoke npm run test:coverage",
  )
})

test("Desk MCP package exposes the local test:coverage command contract", () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(mcpRoot, "package.json"), "utf8"),
  )

  assert.equal(
    packageJson.scripts?.["test:coverage"],
    "node scripts/run-coverage.js",
  )
})

test("Desk MCP CI uses the same local coverage command", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github", "workflows", "desk-mcp-tests.yml"),
    "utf8",
  )

  assert.match(workflow, /npm run test:coverage/)
  assert.match(workflow, /scripts\/\*\.cjs/)
  assert.doesNotMatch(workflow, /run:\s*npm test\b/)
})
