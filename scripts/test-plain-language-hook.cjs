#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const hook = path.join(repoRoot, "plugins", "plain-language", "hooks", "inject.cjs");

function run(file, event) {
  return spawnSync(process.execPath, [file, event], {
    cwd: os.tmpdir(),
    encoding: "utf8",
  });
}

for (const event of ["SessionStart", "SubagentStart"]) {
  const result = run(hook, event);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, event);
  assert.match(output.hookSpecificOutput.additionalContext, /^\[PLAIN_LANGUAGE_CONTRACT\]/u);
  assert.match(output.hookSpecificOutput.additionalContext, /## Serve the reader/u);
  assert.match(output.hookSpecificOutput.additionalContext, /## Report work precisely/u);
  assert.match(output.hookSpecificOutput.additionalContext, /## Check before sending/u);
  assert.match(output.hookSpecificOutput.additionalContext, /The integration test is still running/u);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /^---/u);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /vendor|upstream-sources|conformance/iu);
}

const missingEvent = run(hook, "");
assert.notEqual(missingEvent.status, 0);
assert.match(missingEvent.stderr, /unsupported Plain Language hook event/u);

const flattened = fs.mkdtempSync(path.join(os.tmpdir(), "plain-language-hook-"));
fs.mkdirSync(path.join(flattened, "hooks"), { recursive: true });
fs.copyFileSync(hook, path.join(flattened, "hooks", "inject.cjs"));
const missingSkill = run(path.join(flattened, "hooks", "inject.cjs"), "SessionStart");
assert.notEqual(missingSkill.status, 0);
assert.match(missingSkill.stderr, /could not load/u);

console.log("plain-language hook tests passed.");
