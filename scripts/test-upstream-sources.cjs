#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  createGitHubClient,
  inspectSource,
  inspectSources,
  main,
  selectedPayloadDigest,
} = require("./check-upstream-sources.cjs");

const lockedCommit = "1".repeat(40);
const candidateCommit = "2".repeat(40);

function hash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function source(content = "locked") {
  return {
    id: "example",
    repository: "owner/repo",
    commit: lockedCommit,
    license: "MIT",
    files: [
      {
        sourcePath: "skills/example/SKILL.md",
        generatedPath: "plugins/example/skills/example/SKILL.md",
        sha256: hash(content),
      },
    ],
  };
}

function github({
  actualContent = "locked",
  candidate = lockedCommit,
  compareStatus = "ahead",
  releaseCandidate = candidate,
  releaseCompareStatus = compareStatus,
  fullName = "owner/repo",
  license = "MIT",
  release = null,
  failure = null,
} = {}) {
  return {
    repository() {
      if (failure === "repository") throw new Error("HTTP 403 rate limit");
      return {
        full_name: fullName,
        default_branch: "main",
        html_url: "https://github.com/owner/repo",
        license: { spdx_id: license },
      };
    },
    latestRelease() {
      return release;
    },
    commit(_repository, ref) {
      assert.ok(ref === "main" || ref === release?.tag_name);
      return { sha: release && ref === release.tag_name ? releaseCandidate : candidate };
    },
    compare(_repository, base, head) {
      assert.equal(base, lockedCommit);
      if (release && head === releaseCandidate) return { status: releaseCompareStatus };
      assert.equal(head, candidate);
      return { status: compareStatus };
    },
    file(_repository, sourcePath, ref) {
      assert.equal(sourcePath, "skills/example/SKILL.md");
      assert.equal(ref, candidate);
      return Buffer.from(actualContent);
    },
  };
}

{
  const result = inspectSource(source(), github());
  assert.equal(result.classification, "current");
  assert.equal(result.tracking.strategy, "default-branch");
  assert.deepEqual(result.changed_paths, []);
}

{
  const endpoints = [];
  const client = createGitHubClient((command, args, options) => {
    assert.equal(command, "gh");
    assert.equal(args[0], "api");
    assert.equal(options.encoding, "utf8");
    assert.equal(options.maxBuffer, 20 * 1024 * 1024);
    const endpoint = args[1];
    endpoints.push(endpoint);
    if (endpoint.includes("/releases?")) {
      return {
        status: 0,
        stdout: JSON.stringify([{
          endpoint,
          draft: false,
          prerelease: false,
          tag_name: "v1.0.0",
          html_url: "https://github.com/owner/repo/releases/tag/v1.0.0",
        }]),
        stderr: "",
      };
    }
    if (endpoint.includes("/contents/")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          type: "file",
          encoding: "base64",
          content: `${Buffer.from("content").toString("base64")}\n`,
        }),
        stderr: "",
      };
    }
    return { status: 0, stdout: JSON.stringify({ endpoint }), stderr: "" };
  });
  assert.match(client.repository("owner/repo").endpoint, /repos\/owner\/repo$/u);
  assert.match(client.latestRelease("owner/repo").endpoint, /releases\?per_page=100$/u);
  assert.match(client.commit("owner/repo", "v 1").endpoint, /commits\/v%201$/u);
  assert.match(client.compare("owner/repo", lockedCommit, candidateCommit).endpoint, /compare/u);
  assert.equal(client.file("owner/repo", "path with space/file.md", candidateCommit).toString(), "content");
  assert.equal(endpoints.length, 5);

  const noReleases = createGitHubClient(() => ({
    status: 0,
    stdout: "[]",
    stderr: "",
  }));
  assert.equal(noReleases.latestRelease("owner/repo"), null);
}

{
  const notFound = createGitHubClient(() => ({
    status: 1,
    stdout: "",
    stderr: "gh: Not Found (HTTP 404)",
  }));
  assert.throws(() => notFound.latestRelease("owner/repo"), /HTTP 404/u);

  for (const result of [
    { status: 1, stdout: "", stderr: "gh: Forbidden (HTTP 403)" },
    { status: 1, stdout: "stdout failure", stderr: "" },
    { status: null, stdout: "", stderr: "", error: new Error("spawn gh ENOENT") },
    { status: 7, stdout: "", stderr: "" },
  ]) {
    const failing = createGitHubClient(() => result);
    assert.throws(() => failing.repository("owner/repo"), /gh api .* failed/u);
  }

  const invalidJson = createGitHubClient(() => ({
    status: 0,
    stdout: "not json",
    stderr: "",
  }));
  assert.throws(() => invalidJson.repository("owner/repo"), /returned invalid JSON/u);

  const invalidReleases = createGitHubClient(() => ({
    status: 0,
    stdout: JSON.stringify({ tag_name: "v1.0.0" }),
    stderr: "",
  }));
  assert.throws(() => invalidReleases.latestRelease("owner/repo"), /did not return an array/u);

  const malformedRelease = createGitHubClient(() => ({
    status: 0,
    stdout: JSON.stringify([{ draft: false }]),
    stderr: "",
  }));
  assert.throws(
    () => malformedRelease.latestRelease("owner/repo"),
    /malformed release metadata/u,
  );

  const missingPublishedEvidence = createGitHubClient(() => ({
    status: 0,
    stdout: JSON.stringify([{ draft: false, prerelease: false }]),
    stderr: "",
  }));
  assert.throws(
    () => missingPublishedEvidence.latestRelease("owner/repo"),
    /missing tag or URL evidence/u,
  );

  const filteredReleases = createGitHubClient(() => {
    const releases = [
      {
        draft: true,
        prerelease: false,
        tag_name: "draft",
        html_url: "https://github.com/owner/repo/releases/draft",
      },
      {
        draft: false,
        prerelease: true,
        tag_name: "v2.0.0-rc.1",
        html_url: "https://github.com/owner/repo/releases/tag/v2.0.0-rc.1",
      },
      {
        draft: false,
        prerelease: false,
        tag_name: "v1.9.0",
        html_url: "https://github.com/owner/repo/releases/tag/v1.9.0",
      },
    ];
    return { status: 0, stdout: JSON.stringify(releases), stderr: "" };
  });
  assert.equal(filteredReleases.latestRelease("owner/repo").tag_name, "v1.9.0");

  const invalidFile = createGitHubClient(() => ({
    status: 0,
    stdout: JSON.stringify({ type: "dir", encoding: "none" }),
    stderr: "",
  }));
  assert.throws(
    () => invalidFile.file("owner/repo", "file.md", lockedCommit),
    /did not resolve to base64 file content/u,
  );

  assert.equal(typeof createGitHubClient().repository, "function");
}

for (const [mutate, expected] of [
  [(value) => { value.repository = "invalid"; }, /invalid repository identity/u],
  [(value) => { value.commit = "invalid"; }, /invalid locked commit/u],
  [(value) => { value.files = []; }, /has no selected files/u],
]) {
  const value = source();
  mutate(value);
  assert.throws(() => inspectSource(value, github()), expected);
}

assert.throws(
  () => inspectSource(source(), github({ license: "Apache-2.0" })),
  /MIT license evidence missing/u,
);
assert.throws(
  () => inspectSource(source(), github({ license: null })),
  /got unknown/u,
);
for (const license of ["Apache-2.0", null]) {
  const value = source();
  value.license = license;
  assert.throws(
    () => inspectSource(value, github({ license })),
    /unsupported locked license/u,
  );
}
assert.throws(
  () => inspectSource(source(), github({ candidate: "invalid" })),
  /invalid candidate commit/u,
);

{
  const result = inspectSource(source(), github({
    candidate: candidateCommit,
    release: {
      tag_name: "v2.0.0",
      html_url: "https://github.com/owner/repo/releases/tag/v2.0.0",
    },
  }));
  assert.equal(result.classification, "candidate-no-selected-payload-change");
  assert.equal(result.ancestry, "ahead");
  assert.equal(result.tracking.strategy, "latest-release");
  assert.equal(result.tracking.ref, "v2.0.0");
}

{
  const result = inspectSource(source(), github({
    release: {
      tag_name: "v1.0.0",
      html_url: "https://github.com/owner/repo/releases/tag/v1.0.0",
    },
    releaseCandidate: lockedCommit,
  }));
  assert.equal(result.classification, "current");
  assert.equal(result.tracking.strategy, "latest-release");
  assert.equal(result.tracking.release_considered.ancestry, "identical");
}

{
  const result = inspectSource(source(), github({
    release: {
      tag_name: "v0.9.0",
      html_url: "https://github.com/owner/repo/releases/tag/v0.9.0",
    },
    releaseCandidate: "0".repeat(40),
    releaseCompareStatus: "behind",
  }));
  assert.equal(result.classification, "current");
  assert.equal(result.tracking.strategy, "default-branch");
  assert.equal(result.tracking.release_considered.ancestry, "behind");
}

{
  const result = inspectSource(source(), github({
    actualContent: "changed",
    candidate: candidateCommit,
  }));
  assert.equal(result.classification, "needs-human-approval");
  assert.deepEqual(result.changed_paths, ["skills/example/SKILL.md"]);
  assert.notEqual(result.selected_files[0].locked_sha256, result.selected_files[0].candidate_sha256);
  assert.equal(
    result.selected_payload_digest,
    selectedPayloadDigest(result.selected_files),
  );
}

{
  const result = inspectSource(source(), github({
    candidate: candidateCommit,
    compareStatus: "diverged",
  }));
  assert.equal(result.classification, "blocked");
  assert.match(result.reason, /not a forward update/u);
}

{
  const results = inspectSources(
    { schemaVersion: 1, sources: [source()] },
    github({ fullName: "new-owner/repo" }),
  );
  assert.equal(results[0].classification, "blocked");
  assert.match(results[0].reason, /repository identity mismatch/u);
}

{
  const results = inspectSources(
    { schemaVersion: 1, sources: [source()] },
    github({ failure: "repository" }),
  );
  assert.equal(results[0].classification, "blocked");
  assert.match(results[0].reason, /HTTP 403 rate limit/u);
}

{
  const result = inspectSource(source(), github({ actualContent: "drifted" }));
  assert.equal(result.classification, "blocked");
  assert.match(result.reason, /locked commit does not match/u);
}

{
  const results = inspectSources(
    { schemaVersion: 1, sources: [null] },
    github(),
  );
  assert.equal(results[0].id, null);
  assert.equal(results[0].repository, null);
  assert.equal(results[0].locked_commit, null);
  assert.equal(results[0].classification, "blocked");
  assert.match(results[0].reason, /null|repository/iu);
}

{
  const results = inspectSources(
    { schemaVersion: 1, sources: [source()] },
    github({
      candidate: candidateCommit,
      compareStatus: null,
    }),
  );
  assert.equal(results[0].classification, "blocked");
  assert.match(results[0].reason, /unknown ancestry status/u);
}

assert.throws(
  () => inspectSources({ schemaVersion: 2, sources: [] }, github()),
  /schemaVersion 1/u,
);
assert.throws(
  () => inspectSources({ schemaVersion: 1, sources: [] }, github()),
  /non-empty sources array/u,
);

{
  const files = [
    { source_path: "b.md", candidate_sha256: "b" },
    { source_path: "a.md", candidate_sha256: "a" },
  ];
  assert.equal(selectedPayloadDigest(files), selectedPayloadDigest([...files].reverse()));
}

{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-source-main-"));
  try {
    const lockPath = path.join(tempRoot, "lock.json");
    fs.writeFileSync(lockPath, JSON.stringify({
      schemaVersion: 1,
      sources: [source(), { ...source(), id: "example-2" }],
    }));

    let output = "";
    const currentStatus = main(
      ["--lock", lockPath],
      {
        github: github(),
        now: () => "2026-08-25T00:00:00.000Z",
        stdout: { write(value) { output += value; } },
      },
    );
    assert.equal(currentStatus, 0);
    const report = JSON.parse(output);
    assert.equal(report.checked_at, "2026-08-25T00:00:00.000Z");
    assert.equal(report.summary.current, 2);
    assert.match(report.lock_path, /upstream-source-main-/u);

    fs.writeFileSync(lockPath, JSON.stringify({
      schemaVersion: 1,
      sources: [source()],
    }));
    assert.equal(main(["--lock", lockPath], {
      github: github({ actualContent: "changed", candidate: candidateCommit }),
      stdout: { write() {} },
    }), 2);
    assert.equal(main(["--lock", lockPath], {
      github: github({ failure: "repository" }),
      stdout: { write() {} },
    }), 1);

    const fakeBin = path.join(tempRoot, "bin");
    fs.mkdirSync(fakeBin);
    const fakeGh = path.join(fakeBin, "gh");
    fs.writeFileSync(fakeGh, `#!/usr/bin/env node
const endpoint = process.argv[3];
const locked = "${lockedCommit}";
let value;
if (endpoint === "repos/owner/repo") {
  value = { full_name: "owner/repo", default_branch: "main", html_url: "https://github.com/owner/repo", license: { spdx_id: "MIT" } };
} else if (endpoint === "repos/owner/repo/releases?per_page=100") {
  value = [];
} else if (endpoint === "repos/owner/repo/commits/main") {
  value = { sha: locked };
} else if (endpoint.startsWith("repos/owner/repo/contents/skills/example/SKILL.md?ref=")) {
  value = { type: "file", encoding: "base64", content: Buffer.from("locked").toString("base64") };
} else {
  process.stderr.write("gh: Not Found (HTTP 404)");
  process.exit(1);
}
process.stdout.write(JSON.stringify(value));
`);
    fs.chmodSync(fakeGh, 0o755);
    const cliSuccess = spawnSync(process.execPath, [
      path.join(__dirname, "check-upstream-sources.cjs"),
      "--lock",
      lockPath,
    ], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
    });
    assert.equal(cliSuccess.status, 0, cliSuccess.stderr);
    assert.equal(JSON.parse(cliSuccess.stdout).summary.current, 1);

    assert.throws(
      () => main(["--unknown"], { github: github(), stdout: { write() {} } }),
      /unknown or incomplete argument/u,
    );
    assert.throws(
      () => main(["--lock"], { github: github(), stdout: { write() {} } }),
      /unknown or incomplete argument/u,
    );
    fs.writeFileSync(lockPath, "not json");
    assert.throws(
      () => main(["--lock", lockPath], { github: github(), stdout: { write() {} } }),
      /Unexpected token/u,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

{
  const cli = spawnSync(process.execPath, [
    path.join(__dirname, "check-upstream-sources.cjs"),
    "--unknown",
  ], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /unknown or incomplete argument/u);
}

console.log("upstream source steward tests passed.");
