#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repoRootArg = process.argv.indexOf("--repo-root");
const repoRoot = repoRootArg >= 0
  ? path.resolve(process.argv[repoRootArg + 1])
  : path.resolve(__dirname, "..");
const vendorRoot = path.join(repoRoot, "plugins", "plain-language", "vendor");
const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "upstream-sources.lock.json"), "utf8"));
const expectedPins = {
  "gazmagik-iso-24495": "58077fc4dd70daeedafc273f2abb9d341e6e5960",
  "nikdumroese-plain-language-skill": "6d6a69d91ff95b07073f65393e56e2a734b670b7",
};

function hash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `vendor symlink is not allowed: ${file}`);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

assert.equal(lock.schemaVersion, 1);
assert.equal(lock.sources.length, 2);
const generated = new Set(["plugins/plain-language/vendor/NOTICE.md"]);

for (const source of lock.sources) {
  assert.equal(source.commit, expectedPins[source.id], `${source.id} pin drifted`);
  assert.equal(source.license, "MIT");
  assert.ok(source.files.some((file) => file.sourcePath === "LICENSE"));

  for (const file of source.files) {
    assert.match(file.generatedPath, /^plugins\/plain-language\/vendor\//u);
    assert.notEqual(path.basename(file.generatedPath), "SKILL.md");
    assert.ok(["instruction", "inert-metadata"].includes(file.payload));
    const generatedFile = path.join(repoRoot, file.generatedPath);
    assert.equal(fs.statSync(generatedFile).isFile(), true);
    assert.equal(hash(generatedFile), file.sha256, `${file.generatedPath} hash drifted`);
    assert.equal(generated.has(file.generatedPath), false, `duplicate generated path: ${file.generatedPath}`);
    generated.add(file.generatedPath);
  }
}

const actual = filesUnder(vendorRoot)
  .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
  .sort();
assert.deepEqual(actual, [...generated].sort());
assert.equal(
  fs.existsSync(path.join(vendorRoot, "nikdumroese", "skills", "plain-language-iso-24495", "references", "principles.md")),
  false,
);

const notice = fs.readFileSync(path.join(vendorRoot, "NOTICE.md"), "utf8");
assert.match(notice, /GaZmagik\/iso-24495/u);
assert.match(notice, /nikdumroese\/plain-language-skill/u);
assert.match(notice, /does not claim or imply conformance with ISO 24495/u);

console.log(`plain-language plugin tests passed (${generated.size} vendor files).`);
