#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootArg = process.argv.indexOf("--repo-root");
const repoRoot = rootArg >= 0 ? path.resolve(process.argv[rootArg + 1]) : path.resolve(__dirname, "..");
const vendorRoot = path.join(repoRoot, "plugins", "plain-language", "vendor");
const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "upstream-sources.lock.json"), "utf8"));
const skillManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifest.json"), "utf8"));
const pluginSkill = fs.readFileSync(path.join(repoRoot, "plugins", "plain-language", "skills", "plain-language", "SKILL.md"), "utf8");
const manifests = [
  "plugins/plain-language/plugin.json",
  "plugins/plain-language/.claude-plugin/plugin.json",
  "plugins/plain-language/.codex-plugin/plugin.json",
].map((file) => JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8")));
const vendorFiles = fs.existsSync(vendorRoot)
  ? fs.readdirSync(vendorRoot, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
  : [];

assert.equal(fs.existsSync(path.join(repoRoot, "skills", "plain-language", "SKILL.md")), false);
assert.equal(
  skillManifest.skills.find((skill) => skill.name === "plain-language")?.path,
  "plugins/plain-language/skills/plain-language/SKILL.md",
);
assert.equal(vendorFiles.length, 0);
assert.equal(lock.sources.some((source) => source.files.some((file) => file.generatedPath.startsWith("plugins/plain-language/"))), false);
assert.equal(lock.sources.some((source) => source.id === "dietrichgebert-ponytail"), true);
for (const manifest of manifests) {
  assert.equal(manifest.version, "0.2.0");
  assert.match(manifest.description, /first-party output policy/u);
}
assert.match(pluginSkill, /## Serve the reader/u);
assert.match(pluginSkill, /## Make the answer easy to find/u);
assert.match(pluginSkill, /## Report work precisely/u);
assert.match(pluginSkill, /## Preserve meaning/u);
assert.match(pluginSkill, /## Check before sending/u);
assert.match(pluginSkill, /The integration test is still running/u);
assert.doesNotMatch(pluginSkill, /vendor|upstream-sources|conformance/iu);

console.log("plain-language first-party plugin verified.");
