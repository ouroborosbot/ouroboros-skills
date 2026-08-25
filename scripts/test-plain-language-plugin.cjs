#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const rootArg = process.argv.indexOf("--repo-root");
const repoRoot = rootArg >= 0 ? path.resolve(process.argv[rootArg + 1]) : path.resolve(__dirname, "..");
const vendorRoot = path.join(repoRoot, "plugins", "plain-language", "vendor");
const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "upstream-sources.lock.json"), "utf8"));
const expected = new Set(["plugins/plain-language/vendor/NOTICE.md"]);

for (const source of lock.sources) {
  assert.match(source.repository, /^[^/]+\/[^/]+$/u);
  assert.match(source.commit, /^[0-9a-f]{40}$/u);
  assert.equal(source.license, "MIT");
  for (const file of source.files) {
    assert.match(file.generatedPath, /^plugins\/(?:plain-language\/vendor|ponytail-upstream)\//u);
    if (file.generatedPath.startsWith("plugins/plain-language/vendor/")) {
      assert.notEqual(path.basename(file.generatedPath), "SKILL.md");
    }
    assert.equal(expected.has(file.generatedPath), false, `duplicate path: ${file.generatedPath}`);
    const generated = path.join(repoRoot, file.generatedPath);
    assert.equal(fs.statSync(generated).isFile(), true);
    assert.equal(
      crypto.createHash("sha256").update(fs.readFileSync(generated)).digest("hex"),
      file.sha256,
      `${file.generatedPath} hash drifted`,
    );
    expected.add(file.generatedPath);
  }
}

const actual = fs.readdirSync(vendorRoot, { recursive: true, withFileTypes: true })
  .map((entry) => {
    assert.equal(entry.isSymbolicLink(), false, `vendor symlink is not allowed: ${entry.name}`);
    return entry.isFile()
      ? path.relative(repoRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")
      : null;
  })
  .filter(Boolean)
  .sort();
assert.deepEqual(
  actual,
  [...expected].filter((file) => file.startsWith("plugins/plain-language/vendor/")).sort(),
);

const ponytailRoot = path.join(repoRoot, "plugins", "ponytail-upstream");
const ponytailActual = fs.readdirSync(ponytailRoot, { recursive: true, withFileTypes: true })
  .map((entry) => (
    entry.isFile()
      ? path.relative(repoRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")
      : null
  ))
  .filter((file) => file && !file.includes("/.claude-plugin/") && !file.includes("/.codex-plugin/"))
  .filter((file) => file !== "plugins/ponytail-upstream/plugin.json")
  .sort();
assert.deepEqual(
  ponytailActual,
  [...expected].filter((file) => file.startsWith("plugins/ponytail-upstream/")).sort(),
);

const notice = fs.readFileSync(path.join(vendorRoot, "NOTICE.md"), "utf8");
assert.match(notice, /GaZmagik\/iso-24495/u);
assert.match(notice, /nikdumroese\/plain-language-skill/u);
assert.match(notice, /does not claim or imply conformance with ISO 24495/u);

console.log(`plain-language source snapshot verified (${expected.size} files).`);
