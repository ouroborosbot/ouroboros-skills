#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const ancestryStates = new Set(["identical", "ahead", "behind", "diverged"]);

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function selectedPayloadDigest(files) {
  const content = [...files]
    .sort((left, right) => left.source_path.localeCompare(right.source_path))
    .map((file) => `${file.source_path}\0${file.candidate_sha256}\n`)
    .join("");
  return sha256(content);
}

function createGitHubClient(run = spawnSync) {
  function get(endpoint) {
    const result = run("gh", ["api", endpoint], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.status !== 0) {
      const error = String(
        result.stderr || result.stdout || result.error?.message || `exit ${result.status}`,
      ).trim();
      throw new Error(`gh api ${endpoint} failed: ${error}`);
    }
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`gh api ${endpoint} returned invalid JSON: ${error.message}`);
    }
  }

  function repository(repository) {
    return get(`repos/${repository}`);
  }

  function latestRelease(repository) {
    const releases = get(`repos/${repository}/releases?per_page=100`);
    if (!Array.isArray(releases)) {
      throw new Error(`${repository} releases endpoint did not return an array`);
    }
    for (const release of releases) {
      if (
        typeof release?.draft !== "boolean" ||
        typeof release?.prerelease !== "boolean"
      ) {
        throw new Error(`${repository} releases endpoint returned malformed release metadata`);
      }
    }
    const published = releases.find((release) => !release.draft && !release.prerelease) ?? null;
    if (
      published &&
      (typeof published.tag_name !== "string" || typeof published.html_url !== "string")
    ) {
      throw new Error(`${repository} published release is missing tag or URL evidence`);
    }
    return published;
  }

  function commit(repository, ref) {
    return get(`repos/${repository}/commits/${encodeURIComponent(ref)}`);
  }

  function compare(repository, base, head) {
    return get(`repos/${repository}/compare/${base}...${head}`);
  }

  function file(repository, sourcePath, ref) {
    const encodedPath = sourcePath.split("/").map(encodeURIComponent).join("/");
    const response = get(`repos/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`);
    if (response.type !== "file" || response.encoding !== "base64" || typeof response.content !== "string") {
      throw new Error(`${repository}:${sourcePath}@${ref} did not resolve to base64 file content`);
    }
    return Buffer.from(response.content.replace(/\s/gu, ""), "base64");
  }

  return { repository, latestRelease, commit, compare, file };
}

function compareAncestry(github, repository, base, head) {
  const status = github.compare(repository, base, head).status;
  if (!ancestryStates.has(status)) {
    throw new Error(`unknown ancestry status for ${repository}: ${status ?? "missing"}`);
  }
  return status;
}

function inspectSource(source, github) {
  if (!/^[^/]+\/[^/]+$/u.test(source.repository)) {
    throw new Error(`invalid repository identity: ${source.repository}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(source.commit)) {
    throw new Error(`invalid locked commit for ${source.id}: ${source.commit}`);
  }
  if (!Array.isArray(source.files) || source.files.length === 0) {
    throw new Error(`source ${source.id} has no selected files`);
  }
  if (source.license !== "MIT") {
    throw new Error(`unsupported locked license for ${source.id}: ${source.license ?? "missing"}`);
  }

  const repository = github.repository(source.repository);
  if (repository.full_name !== source.repository) {
    throw new Error(`repository identity mismatch: expected ${source.repository}, got ${repository.full_name}`);
  }
  const actualLicense = repository.license?.spdx_id ?? null;
  if (actualLicense !== "MIT") {
    throw new Error(`MIT license evidence missing for ${source.repository}: got ${actualLicense ?? "unknown"}`);
  }

  const release = github.latestRelease(source.repository);
  let candidateRef = repository.default_branch;
  let candidateRefType = "default-branch";
  let candidateCommit;
  let releaseConsidered = null;
  if (release) {
    const releaseCommit = github.commit(source.repository, release.tag_name).sha;
    const releaseAncestry = releaseCommit === source.commit
      ? "identical"
      : compareAncestry(github, source.repository, source.commit, releaseCommit);
    releaseConsidered = {
      ref: release.tag_name,
      commit: releaseCommit,
      ancestry: releaseAncestry,
      url: release.html_url,
    };
    if (releaseAncestry === "identical" || releaseAncestry === "ahead") {
      candidateRef = release.tag_name;
      candidateRefType = "latest-release";
      candidateCommit = releaseCommit;
    }
  }
  candidateCommit ??= github.commit(source.repository, candidateRef).sha;
  if (!/^[0-9a-f]{40}$/u.test(candidateCommit)) {
    throw new Error(`invalid candidate commit for ${source.repository}:${candidateRef}`);
  }

  const ancestry = candidateCommit === source.commit
    ? "identical"
    : compareAncestry(github, source.repository, source.commit, candidateCommit);

  const selectedFiles = source.files.map((file) => {
    const candidateSha256 = sha256(github.file(source.repository, file.sourcePath, candidateCommit));
    return {
      source_path: file.sourcePath,
      generated_path: file.generatedPath,
      locked_sha256: file.sha256,
      candidate_sha256: candidateSha256,
      changed: candidateSha256 !== file.sha256,
    };
  });
  const changedPaths = selectedFiles.filter((file) => file.changed).map((file) => file.source_path);

  let classification;
  let reason;
  if (candidateCommit === source.commit && changedPaths.length === 0) {
    classification = "current";
    reason = "candidate and selected payload match the lock";
  } else if (candidateCommit === source.commit) {
    classification = "blocked";
    reason = "selected payload at the locked commit does not match the recorded hashes";
  } else if (ancestry !== "ahead") {
    classification = "blocked";
    reason = `candidate is not a forward update from the locked commit (${ancestry})`;
  } else if (changedPaths.length === 0) {
    classification = "candidate-no-selected-payload-change";
    reason = "repository advanced without changing selected payload";
  } else {
    classification = "needs-human-approval";
    reason = "forward candidate changes selected payload";
  }

  return {
    id: source.id,
    repository: source.repository,
    repository_identity: repository.full_name,
    license: actualLicense,
    tracking: {
      strategy: candidateRefType,
      ref: candidateRef,
      url: candidateRefType === "latest-release"
        ? release.html_url
        : `${repository.html_url}/commit/${candidateCommit}`,
      release_considered: releaseConsidered,
    },
    locked_commit: source.commit,
    candidate_commit: candidateCommit,
    ancestry,
    selected_payload_digest: selectedPayloadDigest(selectedFiles),
    changed_paths: changedPaths,
    classification,
    reason,
    selected_files: selectedFiles,
  };
}

function inspectSources(lock, github) {
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.sources) || lock.sources.length === 0) {
    throw new Error("upstream source lock must use schemaVersion 1 with a non-empty sources array");
  }
  return lock.sources.map((source) => {
    try {
      return inspectSource(source, github);
    } catch (error) {
      return {
        id: source?.id ?? null,
        repository: source?.repository ?? null,
        locked_commit: source?.commit ?? null,
        classification: "blocked",
        reason: error.message,
      };
    }
  });
}

function parseArgs(argv) {
  let lockPath = path.join(repoRoot, "upstream-sources.lock.json");
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--lock" && argv[index + 1]) {
      lockPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`unknown or incomplete argument: ${argv[index]}`);
  }
  return { lockPath };
}

function main(
  argv = process.argv.slice(2),
  {
    github = createGitHubClient(),
    now = () => new Date().toISOString(),
    stdout = process.stdout,
  } = {},
) {
  const { lockPath } = parseArgs(argv);
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const sources = inspectSources(lock, github);
  const summary = sources.reduce((counts, source) => {
    counts[source.classification] = (counts[source.classification] ?? 0) + 1;
    return counts;
  }, {});
  const report = {
    schema_version: 1,
    checked_at: now(),
    lock_path: path.relative(repoRoot, lockPath),
    summary,
    sources,
  };
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (sources.some((source) => source.classification === "blocked")) return 1;
  if (sources.some((source) => source.classification === "needs-human-approval")) return 2;
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  createGitHubClient,
  inspectSource,
  inspectSources,
  main,
  selectedPayloadDigest,
  sha256,
};
