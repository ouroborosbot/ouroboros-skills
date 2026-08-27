#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const changedSkills = ["autopilot", "work-ideator", "work-planner", "work-doer", "work-merger"];
const contractFailures = [];

function text(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function json(file) {
  return JSON.parse(text(file));
}

function contract(label, check) {
  try {
    check();
  } catch (error) {
    contractFailures.push(`${label}: ${error.message}`);
  }
}

function requires(file, label, pattern) {
  contract(label, () => assert.match(text(file), pattern));
}

for (const skill of changedSkills) {
  const canonical = text(`skills/${skill}/SKILL.md`);
  assert.equal(canonical, text(`plugins/work-suite/skills/${skill}/SKILL.md`));
  assert.doesNotMatch(canonical, /mandatory reviewer ladder|five-section narrative/iu);
  const description = canonical.match(/^description:\s*(?<description>.+)$/mu)?.groups?.description;
  assert.equal(json("manifest.json").skills.find((entry) => entry.name === skill)?.description, description);
}

assert.match(text("skills/work-doer/SKILL.md"), /Apply Ponytail's ladder/u);
assert.match(text("skills/work-planner/SKILL.md"), /skip planning and implement/u);
assert.match(text("skills/work-merger/SKILL.md"), /release or install refresh/u);
assert.match(text("skills/autopilot/SKILL.md"), /needs-human-approval/u);
assert.match(text("plugins/desk/skills/work-orchestration/SKILL.md"), /Clear, local, low risk/u);
assert.match(text("plugins/desk/skills/task-lifecycle/SKILL.md"), /clear task can remain task-card-only/u);
assert.match(text("plugins/desk/skills/task-lifecycle/SKILL.md"), /release\/install, consuming-surface smoke, cleanup/u);
assert.doesNotMatch(text("plugins/desk/skills/task-lifecycle/SKILL.md"), /Operator approves the planning doc/u);
assert.match(text("plugins/desk/skills/start-task/SKILL.md"), /Hand off to `work-orchestration`/u);
assert.match(text("plugins/desk/skills/session-resumption/SKILL.md"), /transition clear work directly to `processing`/u);

for (const file of [
  "skills/work-planner/SKILL.md",
  "plugins/work-suite/skills/work-planner/SKILL.md",
]) {
  requires(file, "planner fetches and verifies the current base", /fetch[\s\S]{0,120}(current|base)|current[\s\S]{0,120}fetch/iu);
  requires(file, "planner reuses an existing planning pair", /existing planning\/doing pair|reuse[\s\S]{0,80}planning/iu);
  requires(file, "planner keeps the two adversarial lenses", /Tinfoil Hat[\s\S]+Stranger With Candy/iu);
  requires(file, "planner grades review by lane", /doing-only[\s\S]+one[\s\S]+review|one[\s\S]+review[\s\S]+doing-only/iu);
  requires(file, "planner returns nested review to its parent", /nested[\s\S]+parent/iu);
  requires(file, "planner requires strict TDD", /strict TDD[\s\S]+observed red/iu);
  requires(file, "planner requires complete changed-production coverage", /100%[\s\S]+statements[\s\S]+branches[\s\S]+functions/iu);
  requires(file, "planner composes visual QA", /visual-qa-dogfood/u);
  contract("planner no longer prescribes one review for high-risk work", () => {
    assert.doesNotMatch(text(file), /one cold review for cross-cutting or high-risk work/iu);
  });
}

requires(
  "plugins/work-suite/README.md",
  "README documents the lane-graded reviewer contract",
  /Tinfoil Hat[\s\S]+Stranger With Candy[\s\S]+doing-only/iu,
);
contract("README no longer prescribes one review for high-risk work", () => {
  assert.doesNotMatch(
    text("plugins/work-suite/README.md"),
    /one cold review for cross-cutting or high-risk work/iu,
  );
});

for (const file of [
  "skills/work-doer/SKILL.md",
  "plugins/work-suite/skills/work-doer/SKILL.md",
]) {
  requires(file, "doer checks authority before writes", /before[\s\S]{0,100}(write|edit)[\s\S]{0,120}(authority|contribution path)|authority[\s\S]{0,120}before[\s\S]{0,80}(write|edit)/iu);
  requires(file, "doer applies strict TDD to every behavior change", /every behavior change[\s\S]+observed red[\s\S]+minimal green/iu);
  requires(file, "doer freezes tests after red", /freeze|frozen/iu);
  requires(file, "doer requires complete changed-production coverage", /100%[\s\S]+statements[\s\S]+branches[\s\S]+functions/iu);
  requires(file, "doer covers negative and boundary paths", /error[\s\S]+null[\s\S]+empty[\s\S]+boundar[\s\S]+negative/iu);
  requires(file, "doer forbids changed-file coverage exclusions", /no (?:changed-file )?coverage exclusion|do not exclude/iu);
  requires(file, "doer asserts outbound request shape", /request shape/iu);
  requires(file, "doer records build and full-suite proof", /record[\s\S]+build[\s\S]+full (?:existing )?suite/iu);
  requires(file, "doer composes visual QA", /visual-qa-dogfood/u);
  requires(file, "doer preserves operator ownership of future sends", /I'll send|I’ll send/iu);
}

for (const [file, hooks] of [
  ["plugins/ponytail-upstream/plugin.json", "./hooks/copilot-hooks.json"],
  ["plugins/ponytail-upstream/.claude-plugin/plugin.json", "./hooks/claude-codex-hooks.json"],
  ["plugins/ponytail-upstream/.codex-plugin/plugin.json", "./hooks/claude-codex-hooks.json"],
]) {
  const plugin = json(file);
  assert.equal(plugin.version, "4.9.0");
  assert.equal(plugin.author.name, "Dietrich Gebert");
  assert.equal(plugin.repository, "https://github.com/DietrichGebert/ponytail");
  assert.equal(plugin.skills, "./skills/");
  assert.equal(plugin.hooks, hooks);
  assert.equal(fs.statSync(path.join(root, "plugins/ponytail-upstream", plugin.skills)).isDirectory(), true);
  assert.equal(fs.statSync(path.join(root, "plugins/ponytail-upstream", hooks)).isFile(), true);
}

for (const file of [
  "plugins/work-suite/plugin.json",
  "plugins/work-suite/.claude-plugin/plugin.json",
  "plugins/work-suite/.codex-plugin/plugin.json",
]) {
  const plugin = json(file);
  const dependencyVersion = plugin.dependencies?.find((dependency) => (
    dependency.name === "ponytail-upstream"
  ))?.version ?? plugin.activation?.codex?.dependencies?.["ponytail-upstream"]?.version;
  assert.equal(dependencyVersion, "4.9.0");
}

const hookData = fs.mkdtempSync(path.join(os.tmpdir(), "ponytail-provider-"));
try {
  const hook = spawnSync(
    process.execPath,
    [path.join(root, "plugins/ponytail-upstream/hooks/ponytail-activate.js")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        COPILOT_PLUGIN_DATA: hookData,
        PONYTAIL_DEFAULT_MODE: "full",
        XDG_CONFIG_HOME: path.join(hookData, "config"),
      },
    },
  );
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(JSON.parse(hook.stdout).additionalContext, /PONYTAIL MODE/u);
  assert.equal(fs.readFileSync(path.join(hookData, ".ponytail-active"), "utf8"), "full");
} finally {
  fs.rmSync(hookData, { recursive: true, force: true });
}

for (const file of [
  "plugins/desk/agents/worker.md",
  "plugins/desk/agents/worker.agent.md",
  "plugins/desk/agents/worker.toml",
  "plugins/desk/output-styles/worker.md",
]) {
  const body = text(file);
  assert.match(body, /Ponytail coding/u);
  assert.match(body, /never requested research|never use it to truncate requested research/u);
  assert.doesNotMatch(body, /four-phase doing skills|Phase 1.4 dispatch|strict TDD|after signoff/iu);
}

assert.equal(
  contractFailures.length,
  0,
  `Work Suite capability contracts failed:\n${contractFailures.join("\n")}`,
);

console.log("work-suite 2 contracts passed.");
