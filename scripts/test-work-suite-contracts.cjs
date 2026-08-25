#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const changedSkills = ["autopilot", "work-ideator", "work-planner", "work-doer", "work-merger"];

function text(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function json(file) {
  return JSON.parse(text(file));
}

for (const skill of changedSkills) {
  const canonical = text(`skills/${skill}/SKILL.md`);
  assert.equal(canonical, text(`plugins/work-suite/skills/${skill}/SKILL.md`));
  assert.doesNotMatch(canonical, /100% coverage on all new code|mandatory reviewer ladder|five-section narrative/iu);
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

console.log("work-suite 2 contracts passed.");
