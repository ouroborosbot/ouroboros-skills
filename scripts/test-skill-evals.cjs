#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { contractFingerprint, sourceFingerprint, validateRepo, verifyReceipt } = require("./skill-evals.cjs");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "scripts", "skill-evals.cjs");
const tempDirs = [];

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(root, ".skill-evals-test-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "evals"));
  fs.writeFileSync(path.join(dir, "source.txt"), "original\n");
  const suite = {
    schemaVersion: 1,
    id: "fixture",
    description: "Fixture suite.",
    sources: ["source.txt"],
    reviewedSourceFingerprint: sourceFingerprint(["source.txt"], dir),
    requirements: [
      { id: "r1", description: "First requirement." },
      { id: "r2", description: "Second requirement." },
    ],
    cases: [{
      id: "case-1",
      description: "Fixture case.",
      prompt: "Evaluate the fixture.",
      checks: [
        { id: "check-must", polarity: "must", evidenceType: "response", covers: ["r1"], description: "Required evidence." },
        { id: "check-must-not", polarity: "must_not", evidenceType: "tool_call", covers: ["r2"], description: "Forbidden evidence." },
      ],
    }],
  };
  fs.writeFileSync(path.join(dir, "evals", "fixture.json"), `${JSON.stringify(suite, null, 2)}\n`);
  return { dir, suite };
}

function receipt(suite) {
  return {
    schemaVersion: 1,
    suiteId: suite.id,
    sourceFingerprint: suite.reviewedSourceFingerprint,
    contractFingerprint: contractFingerprint(suite),
    run: {
      actor: "fixture actor",
      model: "fixture model",
      runtimeRevision: "fixture revision",
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString(),
    },
    cases: suite.cases.map((testCase) => ({
      id: testCase.id,
      checks: testCase.checks.map((check) => ({ id: check.id, passed: true, evidence: "External harness receipt." })),
    })),
  };
}

try {
  assert.doesNotThrow(() => validateRepo(root));
  const validation = spawnSync(process.execPath, [cli, "validate"], { cwd: root, encoding: "utf8" });
  assert.equal(validation.status, 0, validation.stderr);
  assert.match(validation.stdout, /behavior: UNVERIFIED - validation does not run or judge an agent/u);

  const fingerprint = spawnSync(
    process.execPath,
    [cli, "fingerprint", "evals/investigation-boundaries.json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(fingerprint.status, 0, fingerprint.stderr);
  const currentFingerprints = JSON.parse(fingerprint.stdout);
  assert.match(currentFingerprints.sourceFingerprint, /^[a-f0-9]{64}$/u);
  assert.match(currentFingerprints.contractFingerprint, /^[a-f0-9]{64}$/u);

  {
    const { dir } = makeFixture();
    fs.writeFileSync(path.join(dir, "source.txt"), "changed\n");
    assert.throws(() => validateRepo(dir), /reviewedSourceFingerprint/u);
  }

  {
    const { dir, suite } = makeFixture();
    suite.requirements.push({ id: "uncovered", description: "Uncovered requirement." });
    fs.writeFileSync(path.join(dir, "evals", "fixture.json"), `${JSON.stringify(suite, null, 2)}\n`);
    assert.throws(() => validateRepo(dir), /uncovered requirement/u);
  }

  {
    const { dir, suite } = makeFixture();
    suite.cases[0].checks[1].id = "check-must";
    fs.writeFileSync(path.join(dir, "evals", "fixture.json"), `${JSON.stringify(suite, null, 2)}\n`);
    assert.throws(() => validateRepo(dir), /duplicate check id/u);
  }

  {
    const { dir, suite } = makeFixture();
    suite.sources = ["../outside.txt"];
    fs.writeFileSync(path.join(dir, "evals", "fixture.json"), `${JSON.stringify(suite, null, 2)}\n`);
    assert.throws(() => validateRepo(dir), /source path escapes repo root/u);
  }

  {
    const { dir, suite } = makeFixture();
    const resultFile = path.join(dir, "result.json");
    fs.writeFileSync(resultFile, `${JSON.stringify(receipt(suite), null, 2)}\n`);
    assert.doesNotThrow(() => verifyReceipt(resultFile, dir));
    const verification = spawnSync(process.execPath, [cli, "verify", resultFile, dir], { encoding: "utf8" });
    assert.equal(verification.status, 0, verification.stderr);
    assert.match(verification.stdout, /receipt is complete\/current and evidence was not judged/u);
  }

  {
    const { dir, suite } = makeFixture();
    const result = receipt(suite);
    suite.cases[0].checks[0].description = "Changed requirement evidence.";
    fs.writeFileSync(path.join(dir, "evals", "fixture.json"), `${JSON.stringify(suite, null, 2)}\n`);
    const resultFile = path.join(dir, "result.json");
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    assert.throws(() => verifyReceipt(resultFile, dir), /contractFingerprint/u);
  }

  {
    const { dir, suite } = makeFixture();
    const result = receipt(suite);
    result.cases[0].checks.pop();
    const resultFile = path.join(dir, "result.json");
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    assert.throws(() => verifyReceipt(resultFile, dir), /missing check/u);
  }

  {
    const { dir, suite } = makeFixture();
    const result = receipt(suite);
    result.sourceFingerprint = "stale";
    const resultFile = path.join(dir, "result.json");
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    assert.throws(() => verifyReceipt(resultFile, dir), /sourceFingerprint/u);
  }

  {
    const { dir, suite } = makeFixture();
    const result = receipt(suite);
    result.run.startedAt = "2026-02-30T12:00:00Z";
    const resultFile = path.join(dir, "result.json");
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    assert.throws(() => verifyReceipt(resultFile, dir), /valid UTC ISO timestamp/u);
  }

  {
    const { dir, suite } = makeFixture();
    const result = receipt(suite);
    result.cases[0].checks[0].passed = false;
    const resultFile = path.join(dir, "result.json");
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    assert.throws(() => verifyReceipt(resultFile, dir), /failed check/u);
  }

  console.log("Skill eval tests passed.");
} finally {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
}
