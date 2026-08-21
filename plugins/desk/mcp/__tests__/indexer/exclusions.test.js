// Unit 19a: red contract for gitignore and sensitive-path exclusion before
// indexing, embedding, or artifact publication can collect document text.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { closeDb, openDb } from "../../src/db/init.js"
import { discover } from "../../src/indexer/discover.js"
import { rebuildIndex } from "../../src/indexer/index.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"

const mcpRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))
const repoRoot = path.resolve(mcpRoot, "..", "..", "..")
const deskPluginRoot = path.join(repoRoot, "plugins", "desk")
const policySchemaPath = path.join(
  deskPluginRoot,
  "artifacts",
  "publication-policy.schema.json",
)
const SENSITIVE_ACTIVE_PATHS = Object.freeze([
  "trackA/secrets/task.md",
  "trackA/credentials/task.md",
  "trackA/private/task.md",
  "trackA/api-keys/task.md",
])
const SENSITIVE_ARCHIVED_PATHS = Object.freeze([
  "trackA/_archive/secrets/old-note.md",
  "trackA/_archive/credentials/old-note.md",
  "trackA/_archive/2026-01-private-key-rotation.md",
  "trackA/_archive/2026-01-credential-note.md",
])

async function tmpRoot(prefix = "desk-exclusions-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function writeFile(root, rel, body) {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, "utf8")
}

async function loadExclusionsModule() {
  return import(pathToFileURL(path.join(mcpRoot, "src", "indexer", "exclusions.js")))
}

async function loadVectorPackModule() {
  return import(pathToFileURL(path.join(mcpRoot, "src", "indexer", "vector-packs.js")))
}

async function loadSnapshotModule() {
  return import(pathToFileURL(path.join(mcpRoot, "src", "snapshots", "manifest.js")))
}

async function writePolicySchemaFixture(pluginRoot) {
  const artifactsRoot = path.join(pluginRoot, "artifacts")
  await fs.mkdir(artifactsRoot, { recursive: true })
  await fs.copyFile(policySchemaPath, path.join(artifactsRoot, "publication-policy.schema.json"))
}

async function fileHashes(root) {
  const hashes = {}
  async function walk(current) {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch (error) {
      if (error.code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (entry.isFile()) {
        hashes[path.relative(root, abs).split(path.sep).join("/")] =
          await fs.readFile(abs, "utf8")
      }
    }
  }
  await walk(root)
  return Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)))
}

function embedding(seed = 1) {
  return Array.from(
    { length: ACTIVE_EMBEDDING_SPEC.dimension },
    (_, index) => ((seed + index) % 23) / 23,
  )
}

function approvedPublicationPolicy() {
  return {
    schema_version: 1,
    default_publication: "deny",
    repo_visibility: "public",
    sensitive_repo: true,
    approved_artifact_types: ["snapshot", "vector-pack"],
    approval_required: true,
    approvals: [
      {
        scope: "repo",
        artifact_type: "vector-pack",
        approved_by: "unit-test-reviewer",
        approved_at: "2026-06-15T00:00:00.000Z",
        reason: "explicit vector-pack approval for test fixture",
      },
      {
        scope: "repo",
        artifact_type: "snapshot",
        approved_by: "unit-test-reviewer",
        approved_at: "2026-06-15T00:00:00.000Z",
        reason: "explicit snapshot approval for test fixture",
      },
    ],
    updated_at: "2026-06-15T00:00:00.000Z",
  }
}

function publicErrorShape(value, seen = new Set()) {
  if (value == null || typeof value !== "object") return value
  if (seen.has(value)) return "[Circular]"
  seen.add(value)

  if (value instanceof Error) {
    const shape = { message: value.message }
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === "stack" || key === "message") continue
      shape[key] = publicErrorShape(value[key], seen)
    }
    return shape
  }

  if (Array.isArray(value)) {
    return value.map((item) => publicErrorShape(item, seen))
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, publicErrorShape(item, seen)]),
  )
}

function assertPublicErrorDoesNotLeak(error) {
  const serialized = JSON.stringify(publicErrorShape(error))
  assert.doesNotMatch(serialized, /GITIGNORED_SECRET_PAYLOAD|SENSITIVE_PATH_PAYLOAD/u)
  assert.doesNotMatch(serialized, /ignored-track|secrets|credentials|api-keys|private-key/u)
}

test("discover excludes gitignored markdown before indexing", async () => {
  const root = await tmpRoot()
  await writeFile(root, ".gitignore", "ignored-track/\nignored-too\n*.pem\n")
  await writeFile(root, "visible-track/task-1/task.md", "# Visible\n\npublic body")
  await writeFile(root, "ignored-track/leaked-task/task.md", "# Ignored\n\nfixture secret")
  await writeFile(root, "ignored-too/leaked-task/task.md", "# Ignored\n\nfixture secret")
  await writeFile(root, "outer/ignored-track/leaked-task/task.md", "# Ignored\n\nfixture secret")
  await writeFile(root, "outer/ignored-too/leaked-task/task.md", "# Ignored\n\nfixture secret")

  const paths = (await discover(root)).map((doc) => doc.path)

  assert.equal(paths.includes("visible-track/task-1/task.md"), true)
  assert.equal(
    paths.includes("ignored-track/leaked-task/task.md"),
    false,
    "gitignored task.md files must not be discovered",
  )
  assert.equal(
    paths.includes("ignored-too/leaked-task/task.md"),
    false,
    "gitignored bare directory names must exclude descendants",
  )
  assert.equal(
    paths.includes("outer/ignored-track/leaked-task/task.md"),
    false,
    "gitignored directory patterns must exclude nested directory descendants",
  )
  assert.equal(
    paths.includes("outer/ignored-too/leaked-task/task.md"),
    false,
    "gitignored bare directory names must exclude nested directory descendants",
  )
})

test("discover fails closed when root gitignore cannot be read", async () => {
  const root = await tmpRoot()
  await writeFile(root, ".gitignore/rules", "ignored-track/**\n")

  await assert.rejects(
    () => discover(root),
    (error) => {
      assert.equal(error.code, "exclusion_rules_unavailable")
      assert.equal(error.reason, "gitignore_unreadable")
      assertPublicErrorDoesNotLeak(error)
      return true
    },
  )
})

test("loadExclusionRules fails closed on unexpected gitignore filesystem errors", async (t) => {
  const { loadExclusionRules } = await loadExclusionsModule()
  const root = await tmpRoot()

  t.mock.method(fs, "stat", async () => {
    const error = new Error("blocked")
    error.code = "EACCES"
    throw error
  })

  await assert.rejects(
    () => loadExclusionRules({ deskRoot: root }),
    (error) => {
      assert.equal(error.code, "exclusion_rules_unavailable")
      assert.equal(error.reason, "gitignore_unreadable")
      return true
    },
  )
})

test("loadExclusionRules fails closed when gitignore bytes become unreadable", async (t) => {
  const { loadExclusionRules } = await loadExclusionsModule()
  const root = await tmpRoot()
  await writeFile(root, ".gitignore", "ignored-track/**\n")

  t.mock.method(fs, "readFile", async () => {
    const error = new Error("blocked")
    error.code = "EACCES"
    throw error
  })

  await assert.rejects(
    () => loadExclusionRules({ deskRoot: root }),
    (error) => {
      assert.equal(error.code, "exclusion_rules_unavailable")
      assert.equal(error.reason, "gitignore_unreadable")
      return true
    },
  )
})

test("loadExclusionRules surfaces unexpected directory scan errors", async (t) => {
  const { loadExclusionRules } = await loadExclusionsModule()
  const root = await tmpRoot()

  t.mock.method(fs, "readdir", async () => {
    const error = new Error("blocked")
    error.code = "EACCES"
    throw error
  })

  await assert.rejects(
    () => loadExclusionRules({ deskRoot: root }),
    (error) => error.code === "EACCES" && error.message === "blocked",
  )
})

test("discover excludes sensitive active and archived paths", async () => {
  const root = await tmpRoot()
  await writeFile(root, "trackA/task-1/task.md", "# Visible\n\npublic body")
  await writeFile(root, "trackA/_archive/old-note.md", "# Archive\n\npublic history")
  for (const rel of [...SENSITIVE_ACTIVE_PATHS, ...SENSITIVE_ARCHIVED_PATHS]) {
    await writeFile(root, rel, "# Sensitive\n\nfixture secret")
  }

  const paths = (await discover(root)).map((doc) => doc.path)

  assert.equal(paths.includes("trackA/task-1/task.md"), true)
  assert.equal(paths.includes("trackA/_archive/old-note.md"), true)
  for (const rel of SENSITIVE_ACTIVE_PATHS) {
    assert.equal(paths.includes(rel), false, "sensitive active paths must not be discovered")
  }
  for (const rel of SENSITIVE_ARCHIVED_PATHS) {
    assert.equal(
      paths.includes(rel),
      false,
      "sensitive archived paths must remain excluded despite archive indexing",
    )
  }
})

test("discover applies nested gitignore files and negated rules", async () => {
  const root = await tmpRoot()
  await writeFile(
    root,
    ".gitignore",
    "root-ignored/\n/anchored-ignored\n!root-ignored/reincluded/task.md\n!public/task.md\n",
  )
  await writeFile(
    root,
    "trackA/.gitignore",
    "local-ignored/\n!local-ignored/reincluded/task.md\n",
  )
  await writeFile(root, "trackA/visible/task.md", "# Visible\n\npublic body")
  await writeFile(root, "root-ignored/private/task.md", "# Root ignored\n\nfixture secret")
  await writeFile(root, "anchored-ignored/leaked/task.md", "# Anchored ignored\n\nfixture secret")
  await writeFile(root, "root-ignored/reincluded/task.md", "# Root reinclude\n\npublic body")
  await writeFile(root, "public/task.md", "# Public\n\npublic body")
  await writeFile(root, "trackA/local-ignored/private/task.md", "# Local ignored\n\nfixture secret")
  await writeFile(root, "trackA/local-ignored/reincluded/task.md", "# Local reinclude\n\npublic body")

  const paths = (await discover(root)).map((doc) => doc.path)

  assert.equal(paths.includes("trackA/visible/task.md"), true)
  assert.equal(paths.includes("public/task.md"), true)
  assert.equal(paths.includes("root-ignored/private/task.md"), false)
  assert.equal(paths.includes("anchored-ignored/leaked/task.md"), false)
  assert.equal(paths.includes("trackA/local-ignored/private/task.md"), false)
  assert.equal(paths.includes("root-ignored/reincluded/task.md"), true)
  assert.equal(paths.includes("trackA/local-ignored/reincluded/task.md"), true)
})

test("discover honors standard gitignore question, class, and recursive wildcards", async () => {
  const root = await tmpRoot()
  await writeFile(
    root,
    ".gitignore",
    [
      "notes?.md",
      "draft[0-9].md",
      "**/private-*.md",
      "reports/**/secret.md",
      "",
    ].join("\n"),
  )
  for (const rel of [
    "notes1.md",
    "draft7.md",
    "private-root.md",
    "nested/private-note.md",
    "reports/secret.md",
    "reports/2026/q1/secret.md",
  ]) {
    await writeFile(root, rel, "# Ignored\n\nfixture secret")
  }
  for (const rel of [
    "notes10.md",
    "draftx.md",
    "nested/public-note.md",
    "reports/2026/q1/public.md",
  ]) {
    await writeFile(root, rel, "# Visible\n\npublic body")
  }

  const paths = (await discover(root)).map((doc) => doc.path)

  assert.deepEqual(paths, [
    "draftx.md",
    "nested/public-note.md",
    "notes10.md",
    "reports/2026/q1/public.md",
  ])
})

test("discover honors escaped gitignore markers and negated character classes", async () => {
  const root = await tmpRoot()
  await writeFile(
    root,
    ".gitignore",
    [
      "\\#private.md",
      "\\!private.md",
      "literal\\?.md",
      "draft[!a].md",
      "hyphen[a\\-c].md",
      "posix[[:digit:]].md",
      "space\\ name.md",
      "trimmed.md   ",
      "",
    ].join("\n"),
  )
  for (const rel of [
    "#private.md",
    "!private.md",
    "literal?.md",
    "draftb.md",
    "hyphen-.md",
    "posix7.md",
    "space name.md",
    "trimmed.md",
  ]) {
    await writeFile(root, rel, "# Ignored\n\nfixture secret")
  }
  for (const rel of [
    "literal1.md",
    "drafta.md",
    "hyphenb.md",
    "posixx.md",
    "public.md",
  ]) {
    await writeFile(root, rel, "# Visible\n\npublic body")
  }

  assert.deepEqual(
    (await discover(root)).map((doc) => doc.path),
    ["drafta.md", "hyphenb.md", "literal1.md", "posixx.md", "public.md"],
  )
})

test("discover fails closed on unsupported gitignore character-class syntax", async () => {
  const root = await tmpRoot()
  await writeFile(root, ".gitignore", "private[[.a.]].md\n")
  await writeFile(root, "public.md", "# Visible\n\npublic body")

  await assert.rejects(
    () => discover(root),
    (error) => {
      assert.equal(error.code, "exclusion_rules_unavailable")
      assert.equal(error.reason, "gitignore_unsupported")
      assertPublicErrorDoesNotLeak(error)
      return true
    },
  )
})

test("discover excludes symlink and hidden docs while preserving person and shared docs", async () => {
  const root = await tmpRoot()
  await writeFile(root, "trackA/task-1/task.md", "# Visible\n\npublic body")
  await writeFile(root, ".hidden/task.md", "# Hidden dir\n\nfixture secret")
  await writeFile(root, "trackA/_archive/.hidden.md", "# Hidden archive\n\nfixture secret")
  await writeFile(root, "_shared/.hidden.md", "# Hidden shared\n\nfixture secret")
  await writeFile(root, "desks/ari/trackP/task-3/task.md", "# Person\n\npublic body")
  await writeFile(root, "_shared/landscape/glossary.md", "# Shared\n\npublic body")

  let symlinkCreated = false
  try {
    await fs.mkdir(path.join(root, "trackA", "symlink-task"), { recursive: true })
    await fs.symlink(
      path.join(root, "trackA", "task-1", "task.md"),
      path.join(root, "trackA", "symlink-task", "task.md"),
    )
    symlinkCreated = true
  } catch {
    // Some filesystems disallow symlinks; hidden/person/shared coverage still runs.
  }

  const docs = await discover(root)
  const byPath = Object.fromEntries(docs.map((doc) => [doc.path, doc]))

  assert.ok(byPath["trackA/task-1/task.md"])
  assert.equal(byPath[".hidden/task.md"], undefined)
  assert.equal(byPath["trackA/_archive/.hidden.md"], undefined)
  assert.equal(byPath["_shared/.hidden.md"], undefined)
  if (symlinkCreated) {
    assert.equal(byPath["trackA/symlink-task/task.md"], undefined)
  }
  assert.equal(byPath["desks/ari/trackP/task-3/task.md"].kind, "task")
  assert.equal(byPath["desks/ari/trackP/task-3/task.md"].track, "trackP")
  assert.equal(byPath["desks/ari/trackP/task-3/task.md"].task_slug, "task-3")
  assert.equal(byPath["_shared/landscape/glossary.md"].kind, "shared")
  assert.equal(byPath["_shared/landscape/glossary.md"].track, null)
})

test("discover keeps ordinary archive recall while excluding archived sensitive paths", async () => {
  const root = await tmpRoot()
  await writeFile(root, "trackA/_archive/old-note.md", "# Archive\n\npublic history")
  await writeFile(root, "trackA/_archive/private-key-rotation.md", "# Old key\n\nfixture secret")

  const paths = (await discover(root)).map((doc) => doc.path)

  assert.equal(paths.includes("trackA/_archive/old-note.md"), true)
  assert.equal(
    paths.includes("trackA/_archive/private-key-rotation.md"),
    false,
    "archive indexing must not override sensitive-path exclusion",
  )
})

test("rebuildIndex never stores or embeds excluded document text", async () => {
  const root = await tmpRoot()
  await writeFile(root, ".gitignore", "ignored-track/**\n")
  await writeFile(root, "visible-track/task-1/task.md", "# Visible\n\npublic vector text")
  await writeFile(root, "ignored-track/leaked-task/task.md", "# Ignored\n\nGITIGNORED_SECRET_PAYLOAD")
  await writeFile(root, "visible-track/secrets/task.md", "# Sensitive\n\nSENSITIVE_PATH_PAYLOAD")

  const prompts = []
  const fetch = async (_url, request) => {
    prompts.push(JSON.parse(request.body).prompt)
    return {
      ok: true,
      json: async () => ({ embedding: embedding(prompts.length) }),
    }
  }

  const summary = await rebuildIndex(root, {
    embed: { fetch },
  })

  assert.equal(summary.docs_indexed, 1)
  assert.equal(prompts.length, 1)
  assert.equal(
    prompts.some((prompt) => /GITIGNORED_SECRET_PAYLOAD|SENSITIVE_PATH_PAYLOAD/u.test(prompt)),
    false,
    "excluded document text must not be sent to embedding fetch",
  )

  const db = openDb(root)
  try {
    const rows = db.prepare("SELECT path FROM docs ORDER BY path").all()
    assert.deepEqual(rows.map((row) => row.path), ["visible-track/task-1/task.md"])
    const chunks = db.prepare("SELECT text FROM chunks ORDER BY id").all()
    assert.equal(
      chunks.some((row) => /GITIGNORED_SECRET_PAYLOAD|SENSITIVE_PATH_PAYLOAD/u.test(row.text)),
      false,
      "excluded document text must not be stored in chunks",
    )
  } finally {
    closeDb(db)
  }
})

test("artifact publication guard rejects excluded inputs without leaking content", async () => {
  const { assertArtifactInputsAllowed, loadExclusionRules } = await loadExclusionsModule()
  const root = await tmpRoot()
  await writeFile(root, ".gitignore", "ignored-track/**\n")

  const rules = await loadExclusionRules({ deskRoot: root })

  await assert.rejects(
    () => assertArtifactInputsAllowed({
      deskRoot: root,
      artifact_type: "vector-pack",
      docs: [
        {
          path: "visible-track/task-1/task.md",
          body: "public body",
        },
        {
          path: "ignored-track/leaked-task/task.md",
          body: "GITIGNORED_SECRET_PAYLOAD",
        },
        {
          path: "visible-track/secrets/task.md",
          body: "SENSITIVE_PATH_PAYLOAD",
        },
      ],
      rules,
    }),
    (error) => {
      assert.equal(error.code, "artifact_input_excluded")
      assert.equal(error.artifact_type, "vector-pack")
      assert.equal(error.excluded_count, 2)
      assert.deepEqual([...error.reasons].sort(), ["gitignore", "sensitive_path"])
      assertPublicErrorDoesNotLeak(error)
      return true
    },
  )
})

test("artifact publication guard honors nested gitignore files and negated rules", async () => {
  const { assertArtifactInputsAllowed } = await loadExclusionsModule()
  const root = await tmpRoot()
  await writeFile(
    root,
    "trackA/.gitignore",
    "local-ignored/\n/anchored-local\n!local-ignored/reincluded/task.md\n!public/task.md\n",
  )

  assert.deepEqual(
    await assertArtifactInputsAllowed({
      deskRoot: root,
      artifact_type: "snapshot",
      docs: [{ path: "trackA/local-ignored/reincluded/task.md", body: "public body" }],
    }),
    { allowed: true },
  )

  await assert.rejects(
    () => assertArtifactInputsAllowed({
      deskRoot: root,
      artifact_type: "snapshot",
      docs: [
        { path: "trackA/local-ignored/private/task.md", body: "fixture secret" },
        { path: "trackA/anchored-local/leaked/task.md", body: "fixture secret" },
        { path: "trackA/_archive/.hidden.md", body: "fixture secret" },
      ],
    }),
    (error) => {
      assert.equal(error.code, "artifact_input_excluded")
      assert.equal(error.artifact_type, "snapshot")
      assert.equal(error.excluded_count, 3)
      assert.deepEqual([...error.reasons].sort(), ["gitignore", "hidden_path"])
      assertPublicErrorDoesNotLeak(error)
      return true
    },
  )
})

test("exclusion helpers cover path globs and benign artifact inputs", async () => {
  const {
    assertArtifactInputsAllowed,
    exclusionForPath,
    hasGitignoreNegation,
    loadExclusionRules,
  } = await loadExclusionsModule()
  const root = await tmpRoot()
  await writeFile(
    root,
    ".gitignore",
    "# comments ignored\n!\n!negations-covered-later\ntrackA/*.md\n*.pem\n",
  )

  const rules = await loadExclusionRules({ deskRoot: root })

  assert.deepEqual(await loadExclusionRules({}), { gitignore: [] })
  assert.deepEqual(await loadExclusionRules({ deskRoot: path.join(root, "missing") }), { gitignore: [] })
  assert.equal(hasGitignoreNegation({}), false)
  assert.equal(hasGitignoreNegation({ gitignore: ["!ignored-track/"] }), true)
  assert.equal(
    exclusionForPath("ignored-track/task.md", {
      gitignore: ["!ignored-track/"],
    }).excluded,
    false,
  )
  assert.equal(
    exclusionForPath("visible-track/task-1/task.md", {
      gitignore: [null, { baseDir: "trackA", negated: true }, { pattern: null }],
    }).excluded,
    false,
  )
  for (const docs of [
    undefined,
    [],
    "not-an-array",
    [null],
    ["not-a-doc"],
    [[]],
    [{ body: "GITIGNORED_SECRET_PAYLOAD" }],
    [{ path: "" }],
    [{ path: "   " }],
    [{ path: "/absolute/task.md" }],
    [{ path: "C:\\absolute\\task.md" }],
  ]) {
    await assert.rejects(
      () => assertArtifactInputsAllowed({
        deskRoot: root,
        artifact_type: "snapshot",
        docs,
      }),
      (error) => {
        assert.equal(error.code, "artifact_input_unknown")
        assert.equal(error.artifact_type, "snapshot")
        assertPublicErrorDoesNotLeak(error)
        return true
      },
    )
  }
  await assert.rejects(
    () => assertArtifactInputsAllowed({
      artifact_type: "snapshot",
      docs: [{ path: "visible-track/task-1/task.md", body: "public body" }],
    }),
    (error) => {
      assert.equal(error.code, "artifact_input_unknown")
      assert.equal(error.artifact_type, "snapshot")
      assertPublicErrorDoesNotLeak(error)
      return true
    },
  )
  assert.equal(exclusionForPath(null, rules).excluded, false)
  assert.equal(exclusionForPath("visible-track/task-1/task.md").excluded, false)
  assert.equal(exclusionForPath("/trackA/task.md", rules).reason, "gitignore")
  assert.equal(exclusionForPath("cert.pem", rules).reason, "gitignore")
  assert.equal(
    exclusionForPath("outer/ignored-track/leaked-task/task.md", {
      gitignore: ["ignored-track/"],
    }).reason,
    "gitignore",
  )
  assert.equal(
    exclusionForPath("outer/ignored-too/leaked-task/task.md", {
      gitignore: ["ignored-too"],
    }).reason,
    "gitignore",
  )
  assert.equal(
    exclusionForPath("top/ignored-track", {
      gitignore: ["top/ignored-track/"],
    }).reason,
    "gitignore",
  )
  assert.equal(
    exclusionForPath("top/ignored-track/leaked-task/task.md", {
      gitignore: ["top/ignored-track/"],
    }).reason,
    "gitignore",
  )
  assert.equal(
    exclusionForPath("other/ignored-track/leaked-task/task.md", {
      gitignore: ["top/ignored-track/"],
    }).excluded,
    false,
  )
  assert.equal(
    exclusionForPath("ignored-track/leaked-task/task.md", {
      gitignore: ["ignored-track/"],
    }).reason,
    "gitignore",
  )
  assert.equal(
    exclusionForPath("ignored-track", {
      gitignore: ["ignored-track/**"],
    }).reason,
    "gitignore",
  )
  assert.equal(
    exclusionForPath("ignored-track/leaked-task/task.md", {
      gitignore: ["ignored-track/**"],
    }).reason,
    "gitignore",
  )
  assert.equal(
    exclusionForPath("other-track/leaked-task/task.md", {
      gitignore: ["ignored-track/**"],
    }).excluded,
    false,
  )
  assert.equal(
    exclusionForPath("other-track/leaked-task/task.md", {
      gitignore: ["ignored-too"],
    }).excluded,
    false,
  )
  assert.equal(exclusionForPath("trackA/deep/task.md", rules).excluded, false)
  assert.deepEqual(
    await assertArtifactInputsAllowed({
      deskRoot: root,
      artifact_type: "snapshot",
      docs: [{ path: "visible-track/task-1/task.md", body: "public body" }],
      rules,
    }),
    { allowed: true },
  )
})

async function assertArtifactWriterRejectsExcludedSourceDocs({ artifactType, write }) {
  const deskRoot = await tmpRoot("desk-exclusions-writer-desk-")
  const pluginRoot = await tmpRoot("desk-exclusions-writer-plugin-")
  const artifactsRoot = path.join(pluginRoot, "artifacts")
  await writeFile(deskRoot, ".gitignore", "ignored-track/**\n")
  await writePolicySchemaFixture(pluginRoot)
  const before = await fileHashes(artifactsRoot)

  const sourceDocs = [
    {
      path: "visible-track/task-1/task.md",
      body: "public body",
    },
    {
      path: "ignored-track/leaked-task/task.md",
      body: "GITIGNORED_SECRET_PAYLOAD",
    },
    {
      path: "visible-track/secrets/task.md",
      body: "SENSITIVE_PATH_PAYLOAD",
    },
  ]

  await assert.rejects(
    () => write({
      pluginRoot,
      deskRoot,
      policy: approvedPublicationPolicy(),
      sourceDocs,
    }),
    (error) => {
      assert.equal(error.code, "artifact_input_excluded")
      assert.equal(error.artifact_type, artifactType)
      assertPublicErrorDoesNotLeak(error)
      return true
    },
  )

  assert.deepEqual(await fileHashes(artifactsRoot), before)
}

async function assertArtifactWriterRejectsUnknownSourceContext({ artifactType, write }) {
  const pluginRoot = await tmpRoot("desk-exclusions-writer-plugin-")
  const artifactsRoot = path.join(pluginRoot, "artifacts")
  await writePolicySchemaFixture(pluginRoot)
  const before = await fileHashes(artifactsRoot)

  await assert.rejects(
    () => write({
      pluginRoot,
      policy: approvedPublicationPolicy(),
      sourceDocs: [{ path: "visible-track/task-1/task.md", body: "public body" }],
    }),
    (error) => {
      assert.equal(error.code, "artifact_input_unknown")
      assert.equal(error.artifact_type, artifactType)
      assertPublicErrorDoesNotLeak(error)
      return true
    },
  )

  assert.deepEqual(await fileHashes(artifactsRoot), before)
}

test("vector-pack writer rejects excluded source docs before writing bytes", async () => {
  const { writeVectorPackArtifact } = await loadVectorPackModule()
  await assertArtifactWriterRejectsExcludedSourceDocs({
    artifactType: "vector-pack",
    write: (args) => writeVectorPackArtifact({
      ...args,
      packId: "excluded-pack",
      packBytes: "",
      manifestBytes: "{}\n",
      checksumBytes: "sha256:excluded  excluded-pack.jsonl\n",
    }),
  })
  await assertArtifactWriterRejectsUnknownSourceContext({
    artifactType: "vector-pack",
    write: (args) => writeVectorPackArtifact({
      ...args,
      packId: "unknown-source-pack",
      packBytes: "",
      manifestBytes: "{}\n",
      checksumBytes: "sha256:unknown  unknown-source-pack.jsonl\n",
    }),
  })
})

test("snapshot writer rejects excluded source docs before writing bytes", async () => {
  const { writeSnapshotArtifact } = await loadSnapshotModule()
  await assertArtifactWriterRejectsExcludedSourceDocs({
    artifactType: "snapshot",
    write: (args) => writeSnapshotArtifact({
      ...args,
      snapshotId: "excluded-snapshot",
      snapshotBytes: "sqlite bytes",
      manifestBytes: "{}\n",
      checksumBytes: "sha256:excluded  excluded-snapshot.sqlite.zst\n",
    }),
  })
  await assertArtifactWriterRejectsUnknownSourceContext({
    artifactType: "snapshot",
    write: (args) => writeSnapshotArtifact({
      ...args,
      snapshotId: "unknown-source-snapshot",
      snapshotBytes: "sqlite bytes",
      manifestBytes: "{}\n",
      checksumBytes: "sha256:unknown  unknown-source-snapshot.sqlite.zst\n",
    }),
  })
})
