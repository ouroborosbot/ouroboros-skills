#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { gunzipSync } = require("node:zlib");

const defaultRepoRoot = path.resolve(__dirname, "..");
const defaultMcpRoot = path.join(defaultRepoRoot, "plugins", "desk", "mcp");
const embeddedArchiveShaMarker = "<archive-sha256-recorded-in-sidecar>";
const defaultPublishedRuntimePackTargets = Object.freeze([
  Object.freeze({ platform: "darwin", arch: "arm64", nodeAbi: "127" }),
  Object.freeze({ platform: "win32", arch: "x64", nodeAbi: "137" }),
]);
const defaultProductionNotesPath = path.join(
  "desk",
  "tasks",
  "2026-06-14-1335-doing-desk-dependency-activation",
  "production-artifacts.md",
);
const productionCurrentSourceHashField = "current_artifact_source_scope_hash";
const productionCurrentDocumentHashField = "current_document_tree_hash";
const productionArtifactTypes = Object.freeze(["vector-pack", "snapshot"]);
const snapshotSourceScopePaths = Object.freeze([
  "plugins/desk/mcp/src/indexer/index.js",
  "plugins/desk/mcp/src/indexer/vector-packs.js",
  "plugins/desk/mcp/src/snapshots/manifest.js",
  "plugins/desk/mcp/src/snapshots/restore.js",
  "plugins/desk/mcp/src/artifacts/artifact-scripts.js",
  "plugins/desk/mcp/src/artifacts/policy.js",
  "plugins/desk/mcp/scripts/build-vector-pack.js",
  "plugins/desk/mcp/scripts/build-snapshot.js",
  "plugins/desk/mcp/scripts/verify-snapshot.js",
  "plugins/desk/mcp/scripts/validate-artifacts.js",
  "plugins/desk/mcp/src/db/schema.sql",
  "plugins/desk/mcp/package.json",
  "plugins/desk/mcp/package-lock.json",
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizePath(filePath) {
  return filePath.replaceAll(path.sep, "/");
}

function relativeToRepo(repoRoot, filePath) {
  return normalizePath(path.relative(repoRoot, filePath));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadRuntimeDeps(mcpRoot = defaultMcpRoot) {
  return import(pathToFileURL(path.join(mcpRoot, "src", "runtime", "runtime-deps.js")).href);
}

async function loadProductionArtifactModules(mcpRoot = defaultMcpRoot) {
  const [spec, artifactScripts, policy] = await Promise.all([
    import(pathToFileURL(path.join(mcpRoot, "src", "indexer", "spec.js")).href),
    import(pathToFileURL(path.join(mcpRoot, "src", "artifacts", "artifact-scripts.js")).href),
    import(pathToFileURL(path.join(mcpRoot, "src", "artifacts", "policy.js")).href),
  ]);
  return {
    activeEmbeddingSpec: spec.ACTIVE_EMBEDDING_SPEC,
    evaluateArtifactPublication: policy.evaluateArtifactPublication,
    loadPublicationPolicy: policy.loadPublicationPolicy,
    validateArtifacts: artifactScripts.validateArtifacts,
  };
}

function publishedRuntimePackTargets(options = {}) {
  return (options.targets ?? defaultPublishedRuntimePackTargets)
    .map((target) => ({
      platform: target.platform,
      arch: target.arch,
      nodeAbi: target.nodeAbi,
    }));
}

async function productionRuntimePackExpectations(options = {}) {
  const targets = options.targets !== undefined
    ? publishedRuntimePackTargets(options)
    : options.platform === undefined
      ? publishedRuntimePackTargets(options)
      : publishedRuntimePackTargets({
      targets: [{
        platform: options.platform,
        arch: options.arch,
        nodeAbi: options.nodeAbi,
      }],
    });
  return Promise.all(targets.map((target) => productionRuntimePackExpectation({
    ...options,
    platform: target.platform,
    arch: target.arch,
    nodeAbi: target.nodeAbi,
  })));
}

async function productionRuntimePackExpectation(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const mcpRoot = options.mcpRoot ?? path.join(repoRoot, "plugins", "desk", "mcp");
  const runtimeDeps = options.runtimeDeps ?? await loadRuntimeDeps(mcpRoot);
  const packageJson = readJson(path.join(mcpRoot, "package.json"));
  const packageLock = readJson(path.join(mcpRoot, "package-lock.json"));
  const [defaultTarget] = publishedRuntimePackTargets(options);
  const platform = options.platform ?? defaultTarget.platform;
  const arch = options.arch ?? defaultTarget.arch;
  const nodeAbi = options.nodeAbi ?? defaultTarget.nodeAbi;
  const prodDependencyLockHash = runtimeDeps.productionDependencyLockHash({
    packageJson,
    packageLock,
  });
  const paths = runtimeDeps.deriveRuntimeDependencyPackPaths({
    mcpRoot,
    packageJson,
    packageLock,
    platform,
    arch,
    nodeAbi,
  });
  const target = `${platform}-${arch}-node-${nodeAbi}`;
  const requiredFiles = [
    paths.archivePath,
    paths.manifestPath,
    paths.checksumPath,
  ].map((filePath) => ({
    path: filePath,
    repoPath: relativeToRepo(repoRoot, filePath),
  }));

  return {
    repoRoot,
    mcpRoot,
    packageJson,
    packageLock,
    paths,
    platform,
    arch,
    nodeAbi,
    target,
    prodDependencyLockHash,
    relativePackDir: relativeToRepo(repoRoot, paths.packDir),
    requiredFiles,
    runtimeDeps,
  };
}

function gitTracksFile({ repoRoot, repoPath, spawn = spawnSync }) {
  const result = spawn("git", ["ls-files", "--error-unmatch", "--", repoPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return (result.status ?? 1) === 0;
}

function readJsonIfPresent(filePath, errors, label) {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return readJson(filePath);
  } catch (error) {
    errors.push(`${label} must be readable JSON: ${formatErrorMessage(error)}`);
    return undefined;
  }
}

function readFileIfPresent(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : undefined;
}

function readChecksum(filePath, errors) {
  const checksumBytes = readFileIfPresent(filePath);
  if (checksumBytes === undefined) return undefined;
  const checksum = checksumBytes.toString("utf8").trim().split(/\s+/u)[0];
  if (!/^[a-f0-9]{64}$/u.test(checksum)) {
    errors.push("runtime dependency pack checksum runtime-deps.sha256 must start with a sha256 hex digest");
    return undefined;
  }
  return checksum;
}

function parseArchiveJson(bytes, label, errors) {
  if (bytes === undefined) {
    errors.push(`runtime dependency archive must include root ${label}`);
    return undefined;
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    errors.push(`runtime dependency archive ${label} must be readable JSON: ${formatErrorMessage(error)}`);
    return undefined;
  }
}

function embeddedManifestForArchive(manifest) {
  const embeddedManifest = structuredClone(manifest);
  embeddedManifest.archive.sha256 = embeddedArchiveShaMarker;
  return embeddedManifest;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function extractTarGzContents(archivePath) {
  const data = gunzipSync(fs.readFileSync(archivePath));
  const entries = new Map();
  for (let offset = 0; offset < data.length;) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = readTarString(header, 0, 100);
    const rawPrefix = readTarString(header, 345, 155);
    const rawSize = readTarString(header, 124, 12).trim();
    const type = header.toString("ascii", 156, 157);
    const size = Number.parseInt(rawSize || "0", 8);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    const name = rawPrefix.length > 0 ? `${rawPrefix}/${rawName}` : rawName;
    if (type === "0" || type === "\0") {
      entries.set(name, Buffer.from(data.subarray(bodyStart, bodyEnd)));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTarString(header, offset, length) {
  return header.toString("utf8", offset, offset + length).replace(/\0.*$/u, "");
}

function packageRootFromArchiveEntry(entry) {
  if (!entry.startsWith("node_modules/")) return undefined;
  const marker = "/node_modules/";
  const markerIndex = entry.lastIndexOf(marker);
  const rootPrefix = markerIndex === -1 ? "node_modules/" : entry.slice(0, markerIndex + marker.length);
  const remainder = entry.slice(rootPrefix.length).split("/");
  if (remainder[0]?.startsWith("@")) {
    if (remainder.length < 2) return undefined;
    return `${rootPrefix}${remainder[0]}/${remainder[1]}`;
  }
  if (!remainder[0]) return undefined;
  return `${rootPrefix}${remainder[0]}`;
}

function isRuntimeArchiveEntry(entry) {
  return !entry.endsWith("/package.json") && /\.(?:js|cjs|mjs|json|node|dylib|so|dll)$/u.test(entry);
}

function isMutableMcpSourceEntry(entry) {
  return entry === "index.js"
    || entry.startsWith("src/")
    || entry.startsWith("scripts/")
    || entry.startsWith("__tests__/")
    || entry.startsWith("plugins/desk/mcp/");
}

function validatePublishedArchiveShape({ entries, productionDependencies }) {
  const errors = [];
  const entrySet = new Set(entries);
  const expectedLockPaths = new Set(productionDependencies.map((dependency) => dependency.lock_path));

  for (const rootEntry of ["package.json", "package-lock.json", "runtime-deps.manifest.json"]) {
    if (!entrySet.has(rootEntry)) {
      errors.push(`runtime dependency archive must include root ${rootEntry}`);
    }
  }

  for (const dependency of productionDependencies) {
    if (!entrySet.has(`${dependency.lock_path}/package.json`)) {
      errors.push(`runtime dependency archive must include dependency package marker ${dependency.lock_path}/package.json`);
      continue;
    }
    const runtimeEntries = entries.filter((entry) => (
      entry.startsWith(`${dependency.lock_path}/`) && isRuntimeArchiveEntry(entry)
    ));
    if (runtimeEntries.length === 0) {
      errors.push(`runtime dependency archive must include at least one runtime file for ${dependency.name}`);
    }
  }

  for (const entry of entries) {
    if (["package.json", "package-lock.json", "runtime-deps.manifest.json"].includes(entry)) {
      continue;
    }
    if (isMutableMcpSourceEntry(entry)) {
      errors.push(`runtime dependency archive must not include mutable MCP source ${entry}`);
      continue;
    }
    if (entry.startsWith("node_modules/")) {
      const packageRoot = packageRootFromArchiveEntry(entry);
      if (packageRoot === undefined || !expectedLockPaths.has(packageRoot)) {
        errors.push(`runtime dependency archive must not include non-production dependency ${packageRoot ?? entry}`);
      }
      continue;
    }
    errors.push(`runtime dependency archive must not include unexpected root path ${entry}`);
  }

  return errors;
}

function verifyPublishedRuntimeDependencyPack({ expectation, existsSync = fs.existsSync, spawn = spawnSync } = {}) {
  const errors = [];
  for (const artifact of expectation.requiredFiles) {
    if (!existsSync(artifact.path)) {
      errors.push(`generated artifact missing: ${artifact.repoPath}`);
      continue;
    }
    if (!gitTracksFile({ repoRoot: expectation.repoRoot, repoPath: artifact.repoPath, spawn })) {
      errors.push(`generated artifact must be tracked by git: ${artifact.repoPath}`);
    }
  }

  const manifest = readJsonIfPresent(expectation.paths.manifestPath, errors, "runtime dependency pack manifest");
  const archiveBytes = readFileIfPresent(expectation.paths.archivePath);
  const archiveSha = archiveBytes === undefined ? undefined : sha256(archiveBytes);
  const checksumSha = readChecksum(expectation.paths.checksumPath, errors);

  if (archiveBytes === undefined) {
    errors.push("runtime dependency pack archive runtime-deps.tgz is missing");
  }
  if (checksumSha === undefined) {
    errors.push("runtime dependency pack checksum runtime-deps.sha256 is missing");
  } else if (archiveSha !== undefined && checksumSha !== archiveSha) {
    errors.push("runtime dependency pack checksum mismatch for runtime-deps.tgz");
  }

  if (manifest !== undefined) {
    errors.push(...expectation.runtimeDeps.validateRuntimeDependencyPackManifest({
      manifest,
      mcpRoot: expectation.mcpRoot,
      packageJson: expectation.packageJson,
      packageLock: expectation.packageLock,
      platform: expectation.platform,
      arch: expectation.arch,
      nodeAbi: expectation.nodeAbi,
    }));
    if (archiveSha !== undefined && manifest.archive?.sha256 !== archiveSha) {
      errors.push("runtime dependency pack manifest archive.sha256 must match runtime-deps.tgz");
    }
  }

  let archiveContents;
  if (archiveBytes !== undefined) {
    try {
      archiveContents = extractTarGzContents(expectation.paths.archivePath);
    } catch {
      errors.push("runtime dependency archive runtime-deps.tgz must be a readable gzip tar archive");
    }
  }
  if (archiveContents !== undefined && manifest !== undefined) {
    const archivePackageLockBytes = archiveContents.get("package-lock.json");
    parseArchiveJson(archiveContents.get("package.json"), "package.json", errors);
    parseArchiveJson(archivePackageLockBytes, "package-lock.json", errors);
    const embeddedManifest = parseArchiveJson(archiveContents.get("runtime-deps.manifest.json"), "runtime-deps.manifest.json", errors);
    if (archivePackageLockBytes !== undefined && sha256(archivePackageLockBytes) !== manifest.package_lock?.sha256) {
      errors.push("runtime dependency archive package-lock.json sha256 must match sidecar manifest");
    }
    if (embeddedManifest !== undefined && stableStringify(embeddedManifest) !== stableStringify(embeddedManifestForArchive(manifest))) {
      errors.push("runtime dependency archive embedded manifest must match sidecar manifest metadata");
    }
    errors.push(...validatePublishedArchiveShape({
      entries: [...archiveContents.keys()].sort(),
      productionDependencies: manifest.production_dependencies ?? [],
    }));
  }

  return {
    ok: errors.length === 0,
    errors,
    manifest,
  };
}

async function productionSharedArtifactExpectation(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const mcpRoot = options.mcpRoot ?? path.join(repoRoot, "plugins", "desk", "mcp");
  const pluginRoot = options.pluginRoot ?? path.join(repoRoot, "plugins", "desk");
  const deskRoot = options.deskRoot ?? path.join(repoRoot, "desk");
  const defaultModules = await loadProductionArtifactModules(mcpRoot);
  const modules = {
    ...defaultModules,
    ...(options.productionArtifactModules ?? {}),
  };
  const embeddingSpecId = options.embeddingSpecId ?? modules.activeEmbeddingSpec.id;
  const relativeVectorPackDir = normalizePath(path.join(
    "plugins",
    "desk",
    "artifacts",
    "vector-packs",
    embeddingSpecId,
  ));
  const relativeSnapshotDir = normalizePath(path.join(
    "plugins",
    "desk",
    "artifacts",
    "snapshots",
    embeddingSpecId,
  ));
  return {
    repoRoot,
    mcpRoot,
    pluginRoot,
    deskRoot,
    modules,
    embeddingSpecId,
    vectorPackDir: path.join(pluginRoot, "artifacts", "vector-packs", embeddingSpecId),
    snapshotDir: path.join(pluginRoot, "artifacts", "snapshots", embeddingSpecId),
    relativeVectorPackDir,
    relativeSnapshotDir,
    policyPath: path.join(pluginRoot, "artifacts", "publication-policy.json"),
    notesPath: options.notesPath ?? path.join(repoRoot, defaultProductionNotesPath),
    relativeNotesPath: normalizePath(defaultProductionNotesPath),
  };
}

async function verifyProductionSharedArtifacts({
  expectation,
  existsSync = fs.existsSync,
  spawn = spawnSync,
} = {}) {
  const errors = [];
  const vectorPackFiles = primaryArtifactFiles({
    dir: expectation.vectorPackDir,
    suffix: ".jsonl",
  });
  const snapshotFiles = primaryArtifactFiles({
    dir: expectation.snapshotDir,
    suffix: ".sqlite.zst",
  });

  verifyProductionNotes({ expectation, errors, existsSync, spawn });
  await verifyPublicationPolicyApprovals({ expectation, errors, existsSync });
  verifyPrimaryArtifactSet({
    errors,
    files: vectorPackFiles,
    label: "production vector pack",
    dirRepoPath: expectation.relativeVectorPackDir,
    primarySuffix: ".jsonl",
    expectation,
    existsSync,
    spawn,
  });
  verifyPrimaryArtifactSet({
    errors,
    files: snapshotFiles,
    label: "production snapshot",
    dirRepoPath: expectation.relativeSnapshotDir,
    primarySuffix: ".sqlite.zst",
    expectation,
    existsSync,
    spawn,
  });

  let validation = { vector_packs: { count: vectorPackFiles.length, artifacts: [] }, snapshots: { count: snapshotFiles.length, artifacts: [] } };
  try {
    validation = await expectation.modules.validateArtifacts({
      pluginRoot: expectation.pluginRoot,
      mcpRoot: expectation.mcpRoot,
    });
  } catch (error) {
    errors.push(`production shared artifact validation failed: ${formatErrorMessage(error)}`);
  }

  const expectedHashes = verifyProductionHashes({ expectation, errors, existsSync });
  verifyFreshnessManifests({
    errors,
    expectation,
    expectedHashes,
    vectorPackFiles,
    snapshotFiles,
  });
  propagateValidationFreshness({
    artifacts: validation.vector_packs?.artifacts,
    errors,
    idField: "pack_id",
    label: "production vector pack",
  });
  propagateValidationFreshness({
    artifacts: validation.snapshots?.artifacts,
    errors,
    idField: "snapshot_id",
    label: "production snapshot",
  });

  return {
    ok: errors.length === 0,
    errors,
    vector_packs: {
      count: vectorPackFiles.length,
      files: vectorPackFiles.map((filePath) => relativeToRepo(expectation.repoRoot, filePath)),
      validation: validation.vector_packs,
    },
    snapshots: {
      count: snapshotFiles.length,
      files: snapshotFiles.map((filePath) => relativeToRepo(expectation.repoRoot, filePath)),
      validation: validation.snapshots,
    },
  };
}

function propagateValidationFreshness({ artifacts, errors, idField, label }) {
  for (const artifact of artifacts ?? []) {
    if (artifact.freshness === undefined) continue;
    const artifactId = artifact[idField] ?? "<unknown>";
    if (artifact.freshness.artifact_source_scope !== "fresh") {
      errors.push(`${label} ${artifactId} artifact_source_scope_hash is stale`);
    }
    if (artifact.freshness.document_tree !== "fresh") {
      errors.push(`${label} ${artifactId} document_tree_hash is stale`);
    }
  }
}

function primaryArtifactFiles({ dir, suffix }) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function verifyProductionNotes({ expectation, errors, existsSync, spawn }) {
  if (!existsSync(expectation.notesPath)) {
    errors.push(`production-artifacts.md verification notes missing: ${expectation.relativeNotesPath}`);
    return;
  }
  const repoPath = relativeToRepo(expectation.repoRoot, expectation.notesPath);
  if (!gitTracksFile({ repoRoot: expectation.repoRoot, repoPath, spawn })) {
    errors.push(`production-artifacts.md verification notes must be tracked by git: ${repoPath}`);
  }
  const body = fs.readFileSync(expectation.notesPath, "utf8").toLowerCase();
  for (const required of [
    "node scripts/test-desk-generated-artifacts.cjs",
    "artifact:vector-pack:build",
    "artifact:snapshot:build",
    "artifact:validate",
    productionCurrentSourceHashField,
    productionCurrentDocumentHashField,
    "publication-policy",
    "approval",
    "tombstone",
    "exclusion",
  ]) {
    if (!body.includes(required)) {
      errors.push(`production-artifacts.md must mention ${required}`);
    }
  }
}

async function verifyPublicationPolicyApprovals({ expectation, errors, existsSync }) {
  if (!existsSync(expectation.policyPath)) {
    errors.push("production artifact publication policy missing: plugins/desk/artifacts/publication-policy.json");
    return;
  }
  const loaded = await expectation.modules.loadPublicationPolicy({ pluginRoot: expectation.pluginRoot });
  if (!loaded.valid) {
    errors.push(...loaded.diagnostics);
    return;
  }
  const policy = loaded.policy;
  for (const artifactType of productionArtifactTypes) {
    const decision = expectation.modules.evaluateArtifactPublication({
      policy,
      artifact_type: artifactType,
      operation: "publish",
    });
    if (!decision.allowed) {
      errors.push(`production artifact publication policy must approve ${artifactType}: ${decision.reason}`);
    }
  }
  if (policy.approval_required !== true) {
    errors.push("production artifact publication policy must require explicit approval");
  }
}

function verifyPrimaryArtifactSet({
  errors,
  files,
  label,
  dirRepoPath,
  primarySuffix,
  expectation,
  existsSync,
  spawn,
}) {
  if (files.length === 0) {
    errors.push(`${label} artifact missing under ${dirRepoPath}`);
    return;
  }
  for (const primaryPath of files) {
    for (const filePath of [
      primaryPath,
      sidecarPath(primaryPath, primarySuffix, ".manifest.json"),
      sidecarPath(primaryPath, primarySuffix, ".sha256"),
    ]) {
      const repoPath = relativeToRepo(expectation.repoRoot, filePath);
      if (!existsSync(filePath)) {
        errors.push(`${label} sidecar missing: ${repoPath}`);
        continue;
      }
      if (!gitTracksFile({ repoRoot: expectation.repoRoot, repoPath, spawn })) {
        errors.push(`${label} artifact must be tracked by git: ${repoPath}`);
      }
    }
    verifyProductionArtifactChecksum({
      errors,
      label: `${label} ${path.basename(primaryPath)}`,
      primaryPath,
      checksumPath: sidecarPath(primaryPath, primarySuffix, ".sha256"),
      existsSync,
      repoRoot: expectation.repoRoot,
      primaryRepoPath: relativeToRepo(expectation.repoRoot, primaryPath),
      checksumRepoPath: relativeToRepo(
        expectation.repoRoot,
        sidecarPath(primaryPath, primarySuffix, ".sha256"),
      ),
      spawn,
    });
  }
}

function verifyProductionArtifactChecksum({
  errors,
  label,
  primaryPath,
  checksumPath,
  existsSync,
  repoRoot,
  primaryRepoPath,
  checksumRepoPath,
  spawn,
}) {
  if (!existsSync(primaryPath) || !existsSync(checksumPath)) return;
  if (
    workingTreeDiffersFromTracked({ repoRoot, repoPath: primaryRepoPath, spawn }) ||
    workingTreeDiffersFromTracked({ repoRoot, repoPath: checksumRepoPath, spawn })
  ) {
    errors.push(`${label} working tree must match tracked artifact bytes`);
  }
  const primaryBytes =
    readTrackedFileBytes({ repoRoot, repoPath: primaryRepoPath, spawn }) ??
    fs.readFileSync(primaryPath);
  const checksumBytes =
    readTrackedFileBytes({ repoRoot, repoPath: checksumRepoPath, spawn }) ??
    fs.readFileSync(checksumPath);
  const checksum = readProductionArtifactChecksumBytes(checksumBytes, errors, label);
  if (!checksum) return;
  const artifactSha = `sha256:${sha256(primaryBytes)}`;
  if (checksum !== artifactSha) {
    errors.push(`${label} checksum must match artifact bytes`);
  }
}

function readProductionArtifactChecksumBytes(bytes, errors, label) {
  const match = bytes.toString("utf8").match(/^\s*(sha256:[a-f0-9]{64}|[a-f0-9]{64})\b/u);
  if (!match) {
    errors.push(`${label} checksum must start with a sha256 digest`);
    return undefined;
  }
  return match[1].startsWith("sha256:") ? match[1] : `sha256:${match[1]}`;
}

function readTrackedFileBytes({ repoRoot, repoPath, spawn }) {
  const result = spawn("git", ["show", `:${repoPath}`], {
    cwd: repoRoot,
    encoding: "buffer",
    maxBuffer: 100 * 1024 * 1024,
  });
  if ((result.status ?? 1) !== 0) return undefined;
  if (Buffer.isBuffer(result.stdout)) {
    return result.stdout.length > 0 ? result.stdout : undefined;
  }
  if (typeof result.stdout === "string" && result.stdout.length > 0) {
    return Buffer.from(result.stdout, "utf8");
  }
  return undefined;
}

function workingTreeDiffersFromTracked({ repoRoot, repoPath, spawn }) {
  const result = spawn("git", ["diff", "--quiet", "--", repoPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.status === 1;
}

function verifyProductionHashes({ expectation, errors, existsSync }) {
  const expectedArtifactSourceScopeHash = artifactSourceScopeHash(expectation.mcpRoot);
  const out = {
    artifactSourceScopeHash: expectedArtifactSourceScopeHash,
    documentTreeHash: null,
  };
  if (!existsSync(expectation.notesPath)) return out;
  const notes = fs.readFileSync(expectation.notesPath, "utf8");
  const notedSourceHash = hashFieldFromNotes({
    notes,
    field: productionCurrentSourceHashField,
    errors,
  });
  const notedDocumentTreeHash = hashFieldFromNotes({
    notes,
    field: productionCurrentDocumentHashField,
    errors,
  });
  if (!notedSourceHash) {
    errors.push(`production-artifacts.md must record ${productionCurrentSourceHashField} as sha256:<hex>`);
  } else if (notedSourceHash !== expectedArtifactSourceScopeHash) {
    errors.push(`production-artifacts.md ${productionCurrentSourceHashField} must match current source scope`);
  }
  if (!notedDocumentTreeHash) {
    errors.push(`production-artifacts.md must record ${productionCurrentDocumentHashField} as sha256:<hex>`);
  } else {
    out.documentTreeHash = notedDocumentTreeHash;
  }
  return out;
}

function hashFieldFromNotes({ notes, field, errors }) {
  const lineMatches = [...notes.matchAll(new RegExp(
    `^\\s*(?:[-*]\\s*)?${escapeRegExp(field)}\\s*:\\s*([^\\r\\n]*)$`,
    "gimu",
  ))];
  if (lineMatches.length > 1) {
    errors.push(`production-artifacts.md must record exactly one ${field}`);
    return undefined;
  }
  const value = lineMatches[0]?.[1]?.trim().toLowerCase();
  return /^sha256:[a-f0-9]{64}$/u.test(value) ? value : undefined;
}

function verifyFreshnessManifests({ errors, expectation, expectedHashes, vectorPackFiles, snapshotFiles }) {
  for (const packPath of vectorPackFiles) {
    const manifestPath = sidecarPath(packPath, ".jsonl", ".manifest.json");
    const manifest = readJsonIfPresent(manifestPath, errors, "production vector pack manifest");
    if (manifest === undefined) continue;
    verifyFreshnessFields({
      errors,
      label: `production vector pack ${path.basename(packPath)}`,
      manifest,
      expectedHashes,
    });
    verifyCurrentRepresentedDocuments({
      errors,
      expectation,
      label: `production vector pack ${path.basename(packPath)}`,
      manifest,
      expectedHashes,
    });
  }
  for (const snapshotPath of snapshotFiles) {
    const manifestPath = sidecarPath(snapshotPath, ".sqlite.zst", ".manifest.json");
    const manifest = readJsonIfPresent(manifestPath, errors, "production snapshot manifest");
    if (manifest === undefined) continue;
    verifyFreshnessFields({
      errors,
      label: `production snapshot ${path.basename(snapshotPath)}`,
      manifest,
      expectedHashes,
    });
    verifyCurrentRepresentedDocuments({
      errors,
      expectation,
      label: `production snapshot ${path.basename(snapshotPath)}`,
      manifest,
      expectedHashes,
    });
  }
}

function verifyFreshnessFields({ errors, label, manifest, expectedHashes }) {
  if (manifest.artifact_source_scope_hash !== expectedHashes.artifactSourceScopeHash) {
    errors.push(`${label} artifact_source_scope_hash must match current source scope`);
  }
  if (
    expectedHashes.documentTreeHash &&
    manifest.document_tree_hash !== expectedHashes.documentTreeHash
  ) {
    errors.push(`${label} document_tree_hash must match production-artifacts.md`);
  }
}

function verifyCurrentRepresentedDocuments({ errors, expectation, label, manifest, expectedHashes }) {
  if (!Array.isArray(manifest.represented_documents) || manifest.represented_documents.length === 0) {
    errors.push(`${label} represented_documents must be a non-empty array`);
    return;
  }
  const currentDocs = [];
  for (const doc of manifest.represented_documents) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      errors.push(`${label} represented document must be an object`);
      continue;
    }
    const docPath = normalizedRelativeDocPath(doc.path);
    if (!docPath) {
      errors.push(`${label} represented document path must be a normalized relative path`);
      continue;
    }
    const currentPath = path.join(expectation.deskRoot, docPath);
    const currentBytes = readFileIfPresent(currentPath);
    if (currentBytes === undefined) {
      errors.push(`${label} represented document ${docPath} must exist in current repo desk`);
      continue;
    }
    const currentHash = `sha256:${sha256(currentBytes)}`;
    currentDocs.push({ path: docPath, hash: currentHash });
    const manifestHash = canonicalSha(doc.hash);
    if (manifestHash !== currentHash) {
      errors.push(`${label} represented document ${docPath} hash must match current repo document (manifest ${manifestHash}, current ${currentHash})`);
    }
  }
  if (expectedHashes.documentTreeHash && currentDocs.length > 0) {
    const currentTreeHash = documentTreeHash(currentDocs);
    if (currentTreeHash !== expectedHashes.documentTreeHash) {
      errors.push(`${label} current repo document tree must match production-artifacts.md ${productionCurrentDocumentHashField}`);
    }
  }
}

function normalizedRelativeDocPath(value) {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    return undefined;
  }
  if (path.isAbsolute(value) || value.includes("\\") || value.includes("\0")) {
    return undefined;
  }
  const normalized = normalizePath(path.posix.normalize(value));
  const segments = value.split("/");
  if (
    normalized !== value ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    segments.some((segment) => (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      /^[a-z]:$/iu.test(segment)
    ))
  ) {
    return undefined;
  }
  return normalized;
}

function artifactSourceScopeHash(mcpRoot) {
  const hash = createHash("sha256");
  for (const repoPath of snapshotSourceScopePaths) {
    const relFromMcp = repoPath.replace(/^plugins\/desk\/mcp\//u, "");
    hash.update(`${repoPath}\0`);
    hash.update(readFileIfPresent(path.join(mcpRoot, relFromMcp)) ?? Buffer.alloc(0));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function documentTreeHash(docs) {
  const hash = createHash("sha256");
  for (const doc of [...docs].sort((left, right) => String(left.path).localeCompare(String(right.path)))) {
    hash.update(`${normalizePath(doc.path)}\0${canonicalSha(doc.hash)}\0`);
  }
  return `sha256:${hash.digest("hex")}`;
}

function canonicalSha(value) {
  return String(value).startsWith("sha256:") ? String(value) : `sha256:${value}`;
}

function sidecarPath(primaryPath, primarySuffix, sidecarSuffix) {
  return primaryPath.replace(new RegExp(`${escapeRegExp(primarySuffix)}$`, "u"), sidecarSuffix);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function verifyGeneratedArtifacts(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const mcpRoot = options.mcpRoot ?? path.join(repoRoot, "plugins", "desk", "mcp");
  const pluginRoot = options.pluginRoot ?? path.join(repoRoot, "plugins", "desk");
  const exists = options.existsSync ?? fs.existsSync;
  const spawn = options.spawn ?? spawnSync;
  const io = options.io ?? {
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const expectations = await productionRuntimePackExpectations({
    ...options,
    repoRoot,
    mcpRoot,
  });
  const productionSharedExpectation = await productionSharedArtifactExpectation({
    ...options,
    repoRoot,
    mcpRoot,
    pluginRoot,
  });
  const errors = [];
  const verifications = expectations.map((expectation) => verifyPublishedRuntimeDependencyPack({
    expectation,
    existsSync: exists,
    spawn,
  }));
  for (const verification of verifications) {
    errors.push(...verification.errors);
  }
  const productionSharedArtifacts = await verifyProductionSharedArtifacts({
    expectation: productionSharedExpectation,
    existsSync: exists,
    spawn,
  });
  errors.push(...productionSharedArtifacts.errors);
  const labels = [
    ...expectations.map((expectation) => expectation.relativePackDir),
    productionSharedExpectation.relativeVectorPackDir,
    productionSharedExpectation.relativeSnapshotDir,
  ].join(", ");

  if (errors.length > 0) {
    io.stderr.write(`Desk generated artifact verification failed for ${labels}\n`);
    for (const error of errors) {
      io.stderr.write(`- ${error}\n`);
    }
  } else {
    io.stdout.write(`Desk generated artifacts verified for ${labels}\n`);
  }

  return {
    ok: errors.length === 0,
    errors,
    expectations,
    productionSharedExpectation,
    productionSharedArtifacts,
    verifications,
  };
}

async function runCli(options = {}) {
  try {
    const verifyGeneratedArtifactsFn =
      options.verifyGeneratedArtifactsFn ?? verifyGeneratedArtifacts;
    const result = await verifyGeneratedArtifactsFn(options);
    return result.ok ? 0 : 1;
  } catch (error) {
    const io = options.io ?? { stderr: process.stderr };
    io.stderr.write(`${formatErrorMessage(error)}\n`);
    return 1;
  }
}

function setProcessExitCode(exitCode) {
  process.exitCode = exitCode;
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function startCli(options = {}) {
  const isMain = options.isMain ?? require.main === module;
  if (!isMain) return null;
  const run = options.run ?? runCli;
  const setExitCode = options.setExitCode ?? setProcessExitCode;
  return Promise.resolve(run(options)).then(setExitCode);
}

startCli({ isMain: require.main === module });

module.exports = {
  __generatedArtifactVerifierInternalsForTests: {
    canonicalSha,
    formatErrorMessage,
    gitTracksFile,
    packageRootFromArchiveEntry,
    parseArchiveJson,
    primaryArtifactFiles,
    propagateValidationFreshness,
    readJsonIfPresent,
    readTrackedFileBytes,
    validatePublishedArchiveShape,
    verifyProductionArtifactChecksum,
  },
  defaultMcpRoot,
  defaultPublishedRuntimePackTargets,
  defaultProductionNotesPath,
  defaultRepoRoot,
  artifactSourceScopeHash,
  documentTreeHash,
  extractTarGzContents,
  gitTracksFile,
  loadProductionArtifactModules,
  loadRuntimeDeps,
  productionSharedArtifactExpectation,
  productionRuntimePackExpectations,
  productionRuntimePackExpectation,
  publishedRuntimePackTargets,
  runCli,
  startCli,
  verifyGeneratedArtifacts,
  verifyProductionSharedArtifacts,
  verifyPublishedRuntimeDependencyPack,
};
