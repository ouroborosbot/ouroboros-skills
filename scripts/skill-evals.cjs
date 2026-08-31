#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const schemaVersion = 1;
const polarities = new Set(["must", "must_not"]);
const evidenceTypes = new Set(["response", "tool_call", "file", "git", "state", "timing"]);

function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  throw new Error(message);
}

function unique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (!hasText(value)) fail(`${label} must be a non-empty string`);
    if (seen.has(value)) fail(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function normalizeSource(content) {
  return content.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
}

function contractFingerprint(suite) {
  return crypto.createHash("sha256").update(JSON.stringify(suite)).digest("hex");
}

function utcTimestamp(value, field) {
  const match = hasText(value) && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u);
  if (!match) fail(`result receipt run.${field} must be a valid UTC ISO timestamp`);
  const [, year, month, day, hour, minute, second, fraction = "0"] = match;
  const parts = [year, month, day, hour, minute, second, fraction.padEnd(3, "0")].map(Number);
  const date = new Date(0);
  date.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  date.setUTCHours(parts[3], parts[4], parts[5], parts[6]);
  if ([date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()].some((part, index) => part !== parts[index])) {
    fail(`result receipt run.${field} must be a valid UTC ISO timestamp`);
  }
  return date.getTime();
}

function escapes(root, target) {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function sourceFile(repoRoot, source) {
  if (!hasText(source) || path.isAbsolute(source)) fail(`source path must be repo-relative: ${source}`);
  const root = fs.realpathSync(repoRoot);
  const candidate = path.resolve(root, source);
  if (escapes(root, candidate)) fail(`source path escapes repo root: ${source}`);
  if (!fs.existsSync(candidate)) fail(`missing source: ${source}`);
  const resolved = fs.realpathSync(candidate);
  if (escapes(root, resolved)) fail(`source path resolves outside repo root: ${source}`);
  if (!fs.statSync(resolved).isFile()) fail(`missing source: ${source}`);
  return resolved;
}

function sourceFingerprint(sources, repoRoot = process.cwd()) {
  if (!Array.isArray(sources) || sources.length === 0) fail("sources must be a non-empty array");
  unique(sources, "source path");
  const entries = sources.slice().sort().map((source) => {
    const file = sourceFile(repoRoot, source);
    const hash = crypto.createHash("sha256").update(normalizeSource(fs.readFileSync(file, "utf8"))).digest("hex");
    return `${source.replaceAll(path.sep, "/")}\n${hash}\n`;
  });
  return crypto.createHash("sha256").update(entries.join("")).digest("hex");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`invalid JSON in ${file}: ${error.message}`);
  }
}

function loadSuites(repoRoot) {
  const directory = path.join(repoRoot, "evals");
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) fail(`missing evals directory: ${directory}`);
  const files = fs.readdirSync(directory).filter((file) => file.endsWith(".json")).sort();
  if (files.length === 0) fail("no eval suites found");
  return files.map((file) => ({ file: path.join(directory, file), suite: readJson(path.join(directory, file)) }));
}

function validateSuite(suite, repoRoot, label) {
  if (!isObject(suite)) fail(`${label}: suite must be an object`);
  if (suite.schemaVersion !== schemaVersion) fail(`${label}: schemaVersion must be ${schemaVersion}`);
  if (!hasText(suite.id)) fail(`${label}: suite id must be a non-empty string`);
  if (!hasText(suite.description)) fail(`${label}: suite description must be a non-empty string`);
  if (!Array.isArray(suite.sources) || suite.sources.length === 0) fail(`${label}: sources must be a non-empty array`);
  if (!/^[a-f0-9]{64}$/u.test(suite.reviewedSourceFingerprint)) fail(`${label}: reviewedSourceFingerprint must be a SHA-256 hex string`);
  if (!Array.isArray(suite.requirements) || suite.requirements.length === 0) fail(`${label}: requirements must be a non-empty array`);
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) fail(`${label}: cases must be a non-empty array`);

  const requirements = new Set();
  for (const requirement of suite.requirements) {
    if (!isObject(requirement) || !hasText(requirement.id) || !hasText(requirement.description)) {
      fail(`${label}: every requirement needs an id and description`);
    }
    if (requirements.has(requirement.id)) fail(`${label}: duplicate requirement id: ${requirement.id}`);
    requirements.add(requirement.id);
  }

  const caseIds = new Set();
  const checkIds = new Set();
  const covered = new Set();
  let checks = 0;
  for (const testCase of suite.cases) {
    if (!isObject(testCase) || !hasText(testCase.id) || !hasText(testCase.description) || !hasText(testCase.prompt) || !Array.isArray(testCase.checks)) {
      fail(`${label}: every case needs an id, description, prompt, and checks`);
    }
    if (caseIds.has(testCase.id)) fail(`${label}: duplicate case id: ${testCase.id}`);
    caseIds.add(testCase.id);
    let must = 0;
    let mustNot = 0;
    for (const check of testCase.checks) {
      if (!isObject(check) || !hasText(check.id) || !polarities.has(check.polarity) || !evidenceTypes.has(check.evidenceType) || !hasText(check.description) || !Array.isArray(check.covers) || check.covers.length === 0) {
        fail(`${label}: every check needs id, polarity, evidenceType, covers, and description`);
      }
      if (checkIds.has(check.id)) fail(`${label}: duplicate check id: ${check.id}`);
      checkIds.add(check.id);
      unique(check.covers, "covered requirement id");
      for (const requirement of check.covers) {
        if (!requirements.has(requirement)) fail(`${label}: check ${check.id} covers unknown requirement: ${requirement}`);
        covered.add(requirement);
      }
      if (check.polarity === "must") must += 1;
      if (check.polarity === "must_not") mustNot += 1;
      checks += 1;
    }
    if (must === 0 || mustNot === 0) fail(`${label}: case ${testCase.id} needs at least one must and one must_not check`);
  }
  for (const requirement of requirements) {
    if (!covered.has(requirement)) fail(`${label}: uncovered requirement: ${requirement}`);
  }

  const fingerprint = sourceFingerprint(suite.sources, repoRoot);
  if (fingerprint !== suite.reviewedSourceFingerprint) fail(`${label}: reviewedSourceFingerprint does not match current sources`);
  return {
    requirements: requirements.size,
    cases: caseIds.size,
    checks,
    requirementIds: [...requirements],
    caseIds: [...caseIds],
    checkIds: [...checkIds],
    fingerprint,
  };
}

function validateRepo(repoRoot = process.cwd()) {
  const root = path.resolve(repoRoot);
  const suites = loadSuites(root);
  const suiteIds = new Set();
  const requirementIds = new Set();
  const caseIds = new Set();
  const checkIds = new Set();
  const totals = { suites: 0, requirements: 0, cases: 0, checks: 0, entries: [] };
  for (const entry of suites) {
    const result = validateSuite(entry.suite, root, path.relative(root, entry.file));
    if (suiteIds.has(entry.suite.id)) fail(`duplicate suite id: ${entry.suite.id}`);
    suiteIds.add(entry.suite.id);
    for (const [label, ids, seen] of [
      ["requirement", result.requirementIds, requirementIds],
      ["case", result.caseIds, caseIds],
      ["check", result.checkIds, checkIds],
    ]) {
      for (const id of ids) {
        if (seen.has(id)) fail(`duplicate ${label} id: ${id}`);
        seen.add(id);
      }
    }
    totals.suites += 1;
    totals.requirements += result.requirements;
    totals.cases += result.cases;
    totals.checks += result.checks;
    totals.entries.push({ ...entry, fingerprint: result.fingerprint });
  }
  return totals;
}

function verifyReceipt(resultFile, repoRoot = process.cwd()) {
  const root = path.resolve(repoRoot);
  const corpus = validateRepo(root);
  const receipt = readJson(path.resolve(root, resultFile));
  if (!isObject(receipt) || receipt.schemaVersion !== schemaVersion || !hasText(receipt.suiteId) || !hasText(receipt.sourceFingerprint) || !hasText(receipt.contractFingerprint) || !Array.isArray(receipt.cases)) {
    fail("result receipt needs schemaVersion, suiteId, sourceFingerprint, contractFingerprint, and cases");
  }
  const entry = corpus.entries.find(({ suite }) => suite.id === receipt.suiteId);
  if (!entry) fail(`result receipt names unknown suite: ${receipt.suiteId}`);
  if (receipt.sourceFingerprint !== entry.fingerprint) fail("result receipt sourceFingerprint does not match current sources");
  if (receipt.contractFingerprint !== contractFingerprint(entry.suite)) fail("result receipt contractFingerprint does not match the current contract");
  if (!isObject(receipt.run)) fail("result receipt needs a run object");
  for (const field of ["actor", "model", "runtimeRevision"]) {
    if (!hasText(receipt.run[field])) fail(`result receipt run.${field} must be a non-empty string`);
  }
  const timestamps = ["startedAt", "completedAt"].map((field) => utcTimestamp(receipt.run[field], field));
  if (timestamps[1] < timestamps[0]) fail("result receipt run.completedAt must be at or after run.startedAt");

  const expectedCases = new Map(entry.suite.cases.map((testCase) => [testCase.id, testCase]));
  const resultCases = new Set();
  for (const caseResult of receipt.cases) {
    if (!isObject(caseResult) || !hasText(caseResult.id) || !Array.isArray(caseResult.checks)) fail("every result case needs an id and checks");
    if (resultCases.has(caseResult.id)) fail(`duplicate result case id: ${caseResult.id}`);
    resultCases.add(caseResult.id);
    const expectedCase = expectedCases.get(caseResult.id);
    if (!expectedCase) fail(`extra result case: ${caseResult.id}`);
    const expectedChecks = new Set(expectedCase.checks.map((check) => check.id));
    const resultChecks = new Set();
    for (const checkResult of caseResult.checks) {
      if (!isObject(checkResult) || !hasText(checkResult.id) || typeof checkResult.passed !== "boolean" || !hasText(checkResult.evidence)) {
        fail("every result check needs an id, boolean passed, and non-empty evidence");
      }
      if (resultChecks.has(checkResult.id)) fail(`duplicate result check id: ${checkResult.id}`);
      resultChecks.add(checkResult.id);
      if (!expectedChecks.has(checkResult.id)) fail(`extra result check: ${checkResult.id}`);
      if (!checkResult.passed) fail(`failed check: ${checkResult.id}`);
    }
    for (const checkId of expectedChecks) {
      if (!resultChecks.has(checkId)) fail(`missing check: ${caseResult.id}.${checkId}`);
    }
  }
  for (const caseId of expectedCases.keys()) {
    if (!resultCases.has(caseId)) fail(`missing result case: ${caseId}`);
  }
  return { suiteId: entry.suite.id, cases: expectedCases.size, checks: entry.suite.cases.reduce((total, testCase) => total + testCase.checks.length, 0) };
}

function usage() {
  return "usage: node scripts/skill-evals.cjs validate [repoRoot] | fingerprint <suite-file> [repoRoot] | verify <result-file> [repoRoot]";
}

function main(args) {
  const [command, first, second, extra] = args;
  if (extra || !command) fail(usage());
  if (command === "validate" && !second) {
    const totals = validateRepo(first);
    console.log(`Validated ${totals.suites} suite(s), ${totals.requirements} requirement(s), ${totals.cases} case(s), ${totals.checks} check(s). behavior: UNVERIFIED - validation does not run or judge an agent.`);
    return;
  }
  if (command === "fingerprint" && first && !extra) {
    const root = path.resolve(second ?? process.cwd());
    const suite = readJson(path.resolve(root, first));
    console.log(JSON.stringify({
      sourceFingerprint: sourceFingerprint(suite.sources, root),
      contractFingerprint: contractFingerprint(suite),
    }));
    return;
  }
  if (command === "verify" && first && !extra) {
    const result = verifyReceipt(first, second);
    console.log(`Verified ${result.suiteId}: ${result.cases} case(s), ${result.checks} check(s); receipt is complete/current and evidence was not judged.`);
    return;
  }
  fail(usage());
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`skill-evals: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { normalizeSource, contractFingerprint, sourceFingerprint, validateRepo, verifyReceipt };
