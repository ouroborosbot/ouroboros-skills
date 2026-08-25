import { strict as assert } from "node:assert"
import { test } from "node:test"
import { createRequire } from "node:module"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const require = createRequire(import.meta.url)
const validator = require(path.join(repoRoot, "scripts", "validate-skills.cjs"))

const expectedSkillNames = [
  "autopilot",
  "deep-research",
  "inch-worm",
  "stay-in-turn",
  "visual-qa-dogfood",
  "watchdog-mode",
  "work-doer",
  "work-ideator",
  "work-merger",
  "work-planner",
]

const requiredPackageScripts = {
  "activation:support-matrix:generate": "node scripts/generate-support-matrix.js",
  "activation:copilot-bundle:generate": "node scripts/generate-copilot-bundle.js",
  "runtime:deps-pack:build": "node scripts/build-runtime-deps-pack.js",
  "runtime:deps-pack:verify": "node scripts/verify-runtime-deps-pack.js",
  "artifact:vector-pack:build": "node scripts/build-vector-pack.js",
  "artifact:snapshot:build": "node scripts/build-snapshot.js",
  "artifact:snapshot:verify": "node scripts/verify-snapshot.js",
  "artifact:validate": "node scripts/validate-artifacts.js",
}

function writeText(root, relativePath, content) {
  const filePath = path.join(root, relativePath)
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, "utf8")
}

function writeJson(root, relativePath, value) {
  writeText(root, relativePath, `${JSON.stringify(value, null, 2)}\n`)
}

function removePath(root, relativePath) {
  rmSync(path.join(root, relativePath), { force: true, recursive: true })
}

function skillBody(name) {
  return `---\nname: ${name}\ndescription: fixture skill\n---\n# ${name}\n`
}

function createFixtureRepo(root) {
  writeJson(root, "manifest.json", {
    skills: expectedSkillNames.map((name) => ({
      name,
      path: `skills/${name}/SKILL.md`,
      description: `${name} fixture`,
      tags: ["fixture"],
    })),
  })

  for (const name of expectedSkillNames) {
    writeText(root, `skills/${name}/SKILL.md`, skillBody(name))
    writeText(root, `plugins/work-suite/skills/${name}/SKILL.md`, skillBody(name))
  }

  writeText(root, "plugins/no-host-metadata/README.md", "fixture\n")
  writeJson(root, "plugins/desk/.claude-plugin/plugin.json", {
    name: "desk",
    version: "1.7.3",
  })
  writeJson(root, "plugins/desk/.codex-plugin/plugin.json", {
    name: "desk",
    version: "1.7.3",
  })
  writeJson(root, "plugins/work-suite/.claude-plugin/plugin.json", {
    name: "work-suite",
    version: "1.4.9",
  })
  writeJson(root, "plugins/work-suite/.codex-plugin/plugin.json", {
    name: "work-suite",
    version: "1.4.9",
  })
  writeJson(root, ".claude-plugin/marketplace.json", {
    plugins: [
      { name: "ignored", version: "0.0.0", source: false },
      { name: "desk", version: "1.7.3", source: "plugins/desk" },
    ],
  })
  writeJson(root, ".agents/plugins/marketplace.json", {
    name: "ourostack",
    plugins: [
      { source: { source: "local", path: "plugins/ignored-without-name" } },
      { name: "ignored", source: false },
      { name: "desk", source: { source: "local", path: "plugins/desk" } },
      { name: "work-suite", source: { source: "local", path: "plugins/work-suite" } },
    ],
  })

  writeJson(root, "plugins/desk/mcp/package.json", {
    scripts: requiredPackageScripts,
  })
  for (const command of Object.values(requiredPackageScripts)) {
    writeText(
      root,
      path.join("plugins", "desk", "mcp", command.replace(/^node\s+scripts\//u, "scripts/")),
      "#!/usr/bin/env node\nprocess.exit(0)\n",
    )
  }
}

async function withFixtureRepo(fn) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "desk-validate-skills-unit-"))
  const fixtureRoot = path.join(tempRoot, "repo")
  try {
    createFixtureRepo(fixtureRoot)
    return await fn(fixtureRoot)
  } finally {
    rmSync(tempRoot, { force: true, recursive: true })
  }
}

function spawnSequence(statuses, calls = []) {
  const queue = [...statuses]
  return (command, args, options) => {
    calls.push({ command, args, options })
    const next = queue.length > 0 ? queue.shift() : 0
    return typeof next === "object" ? next : { status: next, stdout: "", stderr: "" }
  }
}

function assertThrowsWith(repoMutator, fn, expected) {
  return withFixtureRepo((fixtureRoot) => {
    repoMutator(fixtureRoot)
    assert.throws(() => fn(fixtureRoot), expected)
  })
}

test("validate-skills exports a testable CLI contract and validates a healthy repo", async () => {
  for (const exportName of [
    "readJson",
    "run",
    "runDeskFreshnessChecks",
    "runRuntimeAudit",
    "startCli",
    "validateAll",
    "validateAppleDistributionKitSkill",
    "validateCanonicalPluginCopies",
    "validateDeskMcpPackageScripts",
    "validateManifest",
    "validatePluginMetadata",
    "validateWorkSuiteCopies",
  ]) {
    assert.equal(typeof validator[exportName], "function", `${exportName} must be exported`)
  }

  await withFixtureRepo((fixtureRoot) => {
    const calls = []
    validator.validateAll({
      repoRoot: fixtureRoot,
      childStdio: "pipe",
      spawnSync: spawnSequence([0, 0, 0, 0, 0, 0, 0], calls),
    })

    assert.deepEqual(calls.map((call) => call.args.join(" ")), [
      "scripts/check-apple-distribution-kit-skill.cjs",
      "scripts/test-desk-host-manifests.cjs",
      "scripts/test-desk-generated-artifacts.cjs",
      "scripts/test-codex-plugin-cache-audit.cjs",
      "scripts/test-autopilot-state-audit.cjs",
      "scripts/test-work-suite-runtime-audit.cjs",
      "scripts/audit-work-suite-runtime.cjs --repo-root .",
    ])
    assert.ok(calls.every((call) => call.options.cwd === fixtureRoot))
    assert.deepEqual(
      validator.readJson(path.join(fixtureRoot, "manifest.json")).skills.map((skill) => skill.name),
      expectedSkillNames,
    )

    const stderr = []
    const stdout = []
    assert.equal(
      validator.run({
        repoRoot: fixtureRoot,
        childStdio: "pipe",
        spawnSync: spawnSequence([0, 0, 0, 0, 0, 0, 0]),
        stdout: { write: (text) => stdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
      }),
      0,
    )
    assert.equal(stdout.join(""), "")
    assert.equal(stderr.join(""), "")
  })
})

test("validateManifest reports every schema and skill-copy failure mode", async () => {
  await assertThrowsWith(
    (root) => writeJson(root, "manifest.json", { skills: {} }),
    (root) => validator.validateManifest({ repoRoot: root }),
    /manifest\.skills must be an array/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, "manifest.json", { skills: [null] }),
    (root) => validator.validateManifest({ repoRoot: root }),
    /every skill entry/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, "manifest.json", { skills: [{ name: " ", path: "skills/x/SKILL.md" }] }),
    (root) => validator.validateManifest({ repoRoot: root }),
    /invalid skill name/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, "manifest.json", {
      skills: [
        { name: "autopilot", path: "skills/autopilot/SKILL.md", description: "a", tags: ["x"] },
        { name: "autopilot", path: "skills/autopilot/SKILL.md", description: "b", tags: ["x"] },
      ],
    }),
    (root) => validator.validateManifest({ repoRoot: root }),
    /duplicate skill name/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, "manifest.json", {
      skills: [{ name: "bad", path: "skills/bad/README.md", description: "bad", tags: ["x"] }],
    }),
    (root) => validator.validateManifest({ repoRoot: root }),
    /path must point at SKILL\.md/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, "manifest.json", {
      skills: [{ name: "missing", path: "skills/missing/SKILL.md", description: "missing", tags: ["x"] }],
    }),
    (root) => validator.validateManifest({ repoRoot: root }),
    /missing skills\/missing\/SKILL\.md/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, "manifest.json", {
      skills: [{ name: "autopilot", path: "skills/autopilot/SKILL.md", description: " ", tags: ["x"] }],
    }),
    (root) => validator.validateManifest({ repoRoot: root }),
    /description is required/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, "manifest.json", {
      skills: [{ name: "autopilot", path: "skills/autopilot/SKILL.md", description: "x", tags: [] }],
    }),
    (root) => validator.validateManifest({ repoRoot: root }),
    /tags must be a non-empty array/u,
  )
  await assertThrowsWith(
    (root) => writeText(root, "skills/autopilot/SKILL.md", "# missing frontmatter\n"),
    (root) => validator.validateManifest({ repoRoot: root }),
    /missing YAML frontmatter/u,
  )
  await assertThrowsWith(
    (root) => writeText(root, "skills/autopilot/SKILL.md", "---\ndescription: no declared name\n---\n# autopilot\n"),
    (root) => validator.validateManifest({ repoRoot: root }),
    /frontmatter name is missing/u,
  )
  await assertThrowsWith(
    (root) => writeText(root, "skills/autopilot/SKILL.md", skillBody("not-autopilot")),
    (root) => validator.validateManifest({ repoRoot: root }),
    /frontmatter name is not-autopilot/u,
  )
})

test("validateWorkSuiteCopies catches set, missing file, and drift errors", async () => {
  await assertThrowsWith(
    (root) => {
      removePath(root, "plugins/work-suite/skills/autopilot")
      writeText(root, "plugins/work-suite/skills/extra/SKILL.md", skillBody("extra"))
    },
    (root) => validator.validateWorkSuiteCopies({ repoRoot: root }),
    /work-suite skill set mismatch/u,
  )
  await assertThrowsWith(
    (root) => removePath(root, "skills/autopilot/SKILL.md"),
    (root) => validator.validateWorkSuiteCopies({ repoRoot: root }),
    /missing canonical/u,
  )
  await assertThrowsWith(
    (root) => removePath(root, "plugins/work-suite/skills/autopilot/SKILL.md"),
    (root) => validator.validateWorkSuiteCopies({ repoRoot: root }),
    /missing plugin copy/u,
  )
  await assertThrowsWith(
    (root) => writeText(root, "plugins/work-suite/skills/autopilot/SKILL.md", skillBody("autopilot").replace("# autopilot", "# changed")),
    (root) => validator.validateWorkSuiteCopies({ repoRoot: root }),
    /out of sync/u,
  )
})

test("canonical plugin copy validation is declared and reusable without Plain Language", async () => {
  assert.deepEqual(
    validator.canonicalPluginCopyGroups.map((group) => ({
      id: group.id,
      pluginRoot: group.pluginRoot,
      names: group.copies.map((copy) => copy.name),
    })),
    [{
      id: "work-suite",
      pluginRoot: "plugins/work-suite/skills",
      names: expectedSkillNames,
    }],
  )

  await withFixtureRepo((fixtureRoot) => {
    const copies = [
      {
        name: "alpha",
        canonicalPath: "canonical/alpha.md",
        pluginPath: "plugins/example/copies/alpha.md",
      },
      {
        name: "beta",
        canonicalPath: "canonical/beta.md",
        pluginPath: "plugins/example/copies/beta.md",
      },
    ]
    writeText(fixtureRoot, copies[0].canonicalPath, "alpha\n")
    writeText(fixtureRoot, copies[0].pluginPath, "alpha\n")
    writeText(fixtureRoot, copies[1].canonicalPath, "beta\n")
    writeText(fixtureRoot, copies[1].pluginPath, "beta\n")

    validator.validateCanonicalPluginCopies({
      repoRoot: fixtureRoot,
      copyGroups: [{
        id: "example",
        pluginRoot: "plugins/example/copies",
        copies,
      }],
    })

    writeText(fixtureRoot, copies[1].pluginPath, "drift\n")
    assert.throws(
      () => validator.validateCanonicalPluginCopies({
        repoRoot: fixtureRoot,
        copyGroups: [{
          id: "example",
          pluginRoot: "plugins/example/copies",
          copies,
        }],
      }),
      /example copy beta: .* is out of sync with canonical\/beta\.md/u,
    )
  })
})

test("validatePluginMetadata catches host manifest and marketplace drift", async () => {
  await withFixtureRepo((fixtureRoot) => {
    writeJson(fixtureRoot, ".claude-plugin/marketplace.json", {})
    validator.validatePluginMetadata({ repoRoot: fixtureRoot })
  })
  await withFixtureRepo((fixtureRoot) => {
    writeJson(fixtureRoot, "plugins/desk/.codex-plugin/plugin.json", {
      name: "desk",
      version: "1.7.3",
      skills: "./skills/",
      interface: {
        defaultPrompt: ["short prompt"],
      },
    })
    writeText(
      fixtureRoot,
      "plugins/desk/skills/evidence-discipline/SKILL.md",
      "---\nname: evidence-discipline\ndescription: >-\n  Folded trigger text that stays under the Codex metadata limit.\ntags:\n  - worker\n---\n# Evidence discipline\n",
    )
    writeText(fixtureRoot, "plugins/desk/skills/notes/README.md", "not a skill\n")
    validator.validatePluginMetadata({ repoRoot: fixtureRoot })
  })
  await withFixtureRepo((fixtureRoot) => {
    writeJson(fixtureRoot, "plugins/desk/.codex-plugin/plugin.json", {
      name: "desk",
      version: "1.7.3",
      skills: "./skills/",
      interface: {},
    })
    writeText(
      fixtureRoot,
      "plugins/desk/skills/evidence-discipline/SKILL.md",
      "---\nname: evidence-discipline\ndescription: \"High-risk scenarios: wrappers and warnings\"\n---\n# Evidence discipline\n",
    )
    validator.validatePluginMetadata({ repoRoot: fixtureRoot })
  })
  await withFixtureRepo((fixtureRoot) => {
    writeJson(fixtureRoot, "plugins/desk/.codex-plugin/plugin.json", {
      name: "desk",
      version: "1.7.3",
      skills: "./skills/",
    })
    writeText(
      fixtureRoot,
      "plugins/desk/skills/evidence-discipline/SKILL.md",
      "---\nname: evidence-discipline\ndescription: 'High-risk scenarios: wrappers and warnings'\n---\n# Evidence discipline\n",
    )
    validator.validatePluginMetadata({ repoRoot: fixtureRoot })
  })
  await assertThrowsWith(
    (root) => writeJson(root, "plugins/desk/.codex-plugin/plugin.json", { name: "desk-other", version: "1.7.3" }),
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /does not match Codex plugin name/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, "plugins/desk/.codex-plugin/plugin.json", { name: "desk", version: "9.9.9" }),
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /does not match Codex plugin version/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, "plugins/work-suite/.codex-plugin/plugin.json", {
      name: "work-suite",
      version: "1.4.9",
      interface: {
        defaultPrompt: ["x".repeat(129)],
      },
    }),
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /defaultPrompt\[0\] exceeds 128 characters/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, "plugins/work-suite/.codex-plugin/plugin.json", {
      name: "work-suite",
      version: "1.4.9",
      interface: {
        defaultPrompt: ["one", "two", "three", "four"],
      },
    }),
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /defaultPrompt must contain at most 3 prompts/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, "plugins/work-suite/.codex-plugin/plugin.json", {
      name: "work-suite",
      version: "1.4.9",
      interface: {
        defaultPrompt: "go",
      },
    }),
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /defaultPrompt must be an array/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, "plugins/work-suite/.codex-plugin/plugin.json", {
      name: "work-suite",
      version: "1.4.9",
      interface: {
        defaultPrompt: [42],
      },
    }),
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /defaultPrompt\[0\] must be a string/u,
  )
  await assertThrowsWith(
    (root) => {
      writeJson(root, "plugins/desk/.codex-plugin/plugin.json", {
        name: "desk",
        version: "1.7.3",
        skills: "./skills/",
      })
      writeText(root, "plugins/desk/skills/evidence-discipline/SKILL.md", "# missing frontmatter\n")
    },
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /evidence-discipline: missing YAML frontmatter/u,
  )
  await assertThrowsWith(
    (root) => {
      writeJson(root, "plugins/desk/.codex-plugin/plugin.json", {
        name: "desk",
        version: "1.7.3",
        skills: "./skills/",
      })
      writeText(root, "plugins/desk/skills/evidence-discipline/SKILL.md", "---\nname: evidence-discipline\n---\n# Evidence discipline\n")
    },
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /evidence-discipline: frontmatter description is required/u,
  )
  await assertThrowsWith(
    (root) => {
      writeJson(root, "plugins/desk/.codex-plugin/plugin.json", {
        name: "desk",
        version: "1.7.3",
        skills: "./skills/",
      })
      writeText(
        root,
        "plugins/desk/skills/evidence-discipline/SKILL.md",
        "---\nname: evidence-discipline\ndescription: High-risk scenarios: wrappers and warnings\n---\n# Evidence discipline\n",
      )
    },
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /evidence-discipline: description inline scalar contains ': '/u,
  )
  await assertThrowsWith(
    (root) => {
      writeJson(root, "plugins/desk/.codex-plugin/plugin.json", {
        name: "desk",
        version: "1.7.3",
        skills: "./skills/",
      })
      writeText(
        root,
        "plugins/desk/skills/evidence-discipline/SKILL.md",
        `---\nname: evidence-discipline\ndescription: ${"x".repeat(1025)}\n---\n# Evidence discipline\n`,
      )
    },
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /evidence-discipline: frontmatter description exceeds 1024 characters/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, ".claude-plugin/marketplace.json", {
      plugins: [{ name: "missing", version: "1.0.0", source: "plugins/missing" }],
    }),
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /marketplace source is missing/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, ".claude-plugin/marketplace.json", {
      plugins: [{ name: "desk-wrong", version: "1.7.3", source: "plugins/desk" }],
    }),
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /marketplace name does not match/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, ".claude-plugin/marketplace.json", {
      plugins: [{ name: "desk", version: "9.9.9", source: "plugins/desk" }],
    }),
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /marketplace version/u,
  )
  await assertThrowsWith(
    (root) => removePath(root, ".agents/plugins/marketplace.json"),
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /Codex marketplace is missing/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, ".agents/plugins/marketplace.json", {
      plugins: [],
    }),
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /Codex marketplace name is required/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, ".agents/plugins/marketplace.json", {
      name: "ourostack",
      plugins: { desk: true },
    }),
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /Codex marketplace plugins must be an array/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, ".agents/plugins/marketplace.json", {
      name: "ourostack",
      plugins: [
        { name: "desk", source: { source: "local", path: "plugins/desk" } },
        { name: "desk", source: { source: "local", path: "plugins/desk" } },
      ],
    }),
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /duplicate Codex marketplace plugin entry/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, ".agents/plugins/marketplace.json", {
      name: "ourostack",
      plugins: [
        { name: "desk", source: { source: "local", path: "plugins/desk" } },
      ],
    }),
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /work-suite: Codex marketplace missing plugin entry/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, ".agents/plugins/marketplace.json", {
      name: "ourostack",
      plugins: [
        { name: "desk", source: false },
        { name: "work-suite", source: { source: "local", path: "plugins/work-suite" } },
      ],
    }),
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /desk: Codex marketplace source\.path is required/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, ".agents/plugins/marketplace.json", {
      name: "ourostack",
      plugins: [
        { name: "desk", source: { source: "registry", path: "plugins/desk" } },
        { name: "work-suite", source: { source: "local", path: "plugins/work-suite" } },
      ],
    }),
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /desk: Codex marketplace source\.source must be local/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, ".agents/plugins/marketplace.json", {
      name: "ourostack",
      plugins: [
        { name: "desk", source: { source: "local", path: "plugins/missing" } },
        { name: "work-suite", source: { source: "local", path: "plugins/work-suite" } },
      ],
    }),
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /Codex marketplace source is missing/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, ".agents/plugins/marketplace.json", {
      name: "ourostack",
      plugins: [
        { name: "desk", source: { source: "local", path: "plugins/work-suite" } },
        { name: "work-suite", source: { source: "local", path: "plugins/work-suite" } },
      ],
    }),
    (root) => validator.validatePluginMetadata({ repoRoot: root }),
    /Codex marketplace name does not match/u,
  )
})

test("validateDeskMcpPackageScripts catches missing scripts, command drift, and missing targets", async () => {
  await assertThrowsWith(
    (root) => writeJson(root, "plugins/desk/mcp/package.json", {}),
    (root) => validator.validateDeskMcpPackageScripts({ repoRoot: root }),
    /desk MCP package script activation:support-matrix:generate/u,
  )
  await assertThrowsWith(
    (root) => writeJson(root, "plugins/desk/mcp/package.json", {
      scripts: { ...requiredPackageScripts, "artifact:validate": "node scripts/validate-artifacts-stale.js" },
    }),
    (root) => validator.validateDeskMcpPackageScripts({ repoRoot: root }),
    /artifact:validate must be node scripts\/validate-artifacts\.js/u,
  )
  await assertThrowsWith(
    (root) => removePath(root, "plugins/desk/mcp/scripts/validate-artifacts.js"),
    (root) => validator.validateDeskMcpPackageScripts({ repoRoot: root }),
    /target is missing/u,
  )
  for (const [scriptName, command] of Object.entries(requiredPackageScripts)) {
    await assertThrowsWith(
      (root) => removePath(
        root,
        path.join(
          "plugins",
          "desk",
          "mcp",
          command.replace(/^node\s+scripts\//u, "scripts/"),
        ),
      ),
      (root) => validator.validateDeskMcpPackageScripts({ repoRoot: root }),
      new RegExp(`${scriptName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} target is missing`, "u"),
    )
  }
})

test("freshness and runtime child checks propagate child process failures", async () => {
  await withFixtureRepo((fixtureRoot) => {
    assert.throws(
      () => validator.runDeskFreshnessChecks({
        repoRoot: fixtureRoot,
        childStdio: "pipe",
        spawnSync: spawnSequence([1]),
      }),
      /desk host manifest freshness tests failed/u,
    )
    assert.throws(
      () => validator.runDeskFreshnessChecks({
        repoRoot: fixtureRoot,
        childStdio: "pipe",
        spawnSync: spawnSequence([0, 1]),
      }),
      /desk generated artifact freshness tests failed/u,
    )
    assert.throws(
      () => validator.runDeskFreshnessChecks({
        repoRoot: fixtureRoot,
        childStdio: "pipe",
        spawnSync: spawnSequence([{}]),
      }),
      /desk host manifest freshness tests failed/u,
    )
    assert.throws(
      () => validator.runDeskFreshnessChecks({
        repoRoot: fixtureRoot,
        childStdio: "pipe",
        spawnSync: spawnSequence([0, {}]),
      }),
      /desk generated artifact freshness tests failed/u,
    )
    assert.throws(
      () => validator.runDeskFreshnessChecks({
        repoRoot: fixtureRoot,
        childStdio: "pipe",
        spawnSync: spawnSequence([0, 0, 1]),
      }),
      /codex plugin cache audit tests failed/u,
    )
    assert.throws(
      () => validator.runDeskFreshnessChecks({
        repoRoot: fixtureRoot,
        childStdio: "pipe",
        spawnSync: spawnSequence([0, 0, {}]),
      }),
      /codex plugin cache audit tests failed/u,
    )

    assert.throws(
      () => validator.runRuntimeAudit({
        repoRoot: fixtureRoot,
        childStdio: "pipe",
        spawnSync: spawnSequence([1]),
      }),
      /autopilot state audit tests failed/u,
    )
    assert.throws(
      () => validator.runRuntimeAudit({
        repoRoot: fixtureRoot,
        childStdio: "pipe",
        spawnSync: spawnSequence([{}]),
      }),
      /autopilot state audit tests failed/u,
    )
    assert.throws(
      () => validator.runRuntimeAudit({
        repoRoot: fixtureRoot,
        childStdio: "pipe",
        spawnSync: spawnSequence([0, 1]),
      }),
      /work-suite runtime visibility audit tests failed/u,
    )
    assert.throws(
      () => validator.runRuntimeAudit({
        repoRoot: fixtureRoot,
        childStdio: "pipe",
        spawnSync: spawnSequence([0, {}]),
      }),
      /work-suite runtime visibility audit tests failed/u,
    )
    assert.throws(
      () => validator.runRuntimeAudit({
        repoRoot: fixtureRoot,
        childStdio: "pipe",
        spawnSync: spawnSequence([0, 0, 1]),
      }),
      /work-suite runtime visibility contract audit failed/u,
    )
    assert.throws(
      () => validator.runRuntimeAudit({
        repoRoot: fixtureRoot,
        childStdio: "pipe",
        spawnSync: spawnSequence([0, 0, {}]),
      }),
      /work-suite runtime visibility contract audit failed/u,
    )
  })
})

test("run and startCli expose success, Error, non-Error, and no-op CLI paths", async () => {
  await withFixtureRepo((fixtureRoot) => {
    const errorStderr = []
    assert.equal(
      validator.run({
        repoRoot: fixtureRoot,
        childStdio: "pipe",
        spawnSync: spawnSequence([1]),
        stderr: { write: (text) => errorStderr.push(text) },
      }),
      1,
    )
    assert.match(errorStderr.join(""), /apple distribution kit skill guidance check failed/u)

    const stringStderr = []
    assert.equal(
      validator.run({
        validateAllFn: () => {
          throw "plain failure"
        },
        stderr: { write: (text) => stringStderr.push(text) },
      }),
      1,
    )
    assert.equal(stringStderr.join(""), "plain failure\n")
  })

  assert.equal(validator.startCli({ isMain: false }), null)
  const exitCodes = []
  assert.equal(
    validator.startCli({
      isMain: true,
      runFn: () => 3,
      setExitCode: (code) => exitCodes.push(code),
    }),
    3,
  )
  assert.deepEqual(exitCodes, [3])

  const previousExitCode = process.exitCode
  try {
    assert.equal(validator.startCli({ isMain: true, runFn: () => 0 }), 0)
    assert.equal(process.exitCode, 0)
  } finally {
    process.exitCode = previousExitCode
  }
})
