#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const changedSkills = ["autopilot", "work-ideator", "work-planner", "work-doer", "work-merger"];
const workSuiteSkillNames = [
  "autopilot",
  "deep-research",
  "inch-worm",
  "stay-in-turn",
  "visual-qa-dogfood",
  "watchdog-mode",
  "work-doer",
  "work-ideator",
  "work-merger",
  "work-planner",
];
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
    contractFailures.push(`${label}: ${error.message.split("\n", 1)[0]}`);
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

for (const file of [
  "skills/work-merger/SKILL.md",
  "plugins/work-suite/skills/work-merger/SKILL.md",
]) {
  requires(file, "merger verifies remote authority before writes", /before[\s\S]{0,120}(push|PR|merge|deploy)[\s\S]{0,160}(authority|contribution path|identity)|(?:authority|contribution path|identity)[\s\S]{0,160}before[\s\S]{0,120}(push|PR|merge|deploy)/iu);
  requires(file, "merger resolves the actual target", /actual target|PR base[\s\S]+main[\s\S]+master[\s\S]+release/iu);
  requires(file, "merger preserves unrelated dirty work", /unrelated[\s\S]+dirty[\s\S]+preserv/iu);
  requires(file, "merger binds checks to the exact source SHA", /checks?[\s\S]+exact[\s\S]+(?:source )?SHA/iu);
  requires(file, "merger verifies command and remote outcome", /command exit[\s\S]+remote (?:state|outcome)|remote (?:state|outcome)[\s\S]+command exit/iu);
  requires(file, "merger handles successful commands with open PRs", /zero[\s\S]+(?:open|queued)/iu);
  requires(file, "merger handles failed commands with merged PRs", /nonzero[\s\S]+MERGED/iu);
  requires(file, "merger verifies landed commit and tree before cleanup", /landed[\s\S]+commit[\s\S]+tree[\s\S]+before[\s\S]+cleanup/iu);
  requires(file, "merger composes same-turn waiting", /stay-in-turn/u);
  requires(file, "merger preserves explicit human approval", /needs-human-approval[\s\S]+hard exception/iu);
  contract("merger never downgrades explicit human approval", () => {
    assert.doesNotMatch(text(file), /needs-human-approval[\s\S]{0,120}maps to `needs reviewer gate`/iu);
  });
}

for (const file of [
  "skills/autopilot/SKILL.md",
  "plugins/work-suite/skills/autopilot/SKILL.md",
]) {
  requires(file, "autopilot preserves operator-owned live sends", /I'll send|I’ll send/iu);
  requires(file, "autopilot preserves partner-operated boundaries", /partner-operated|partner owned/iu);
  requires(file, "autopilot emits the audited state headings", /Current Item[\s\S]+Terminal Evidence[\s\S]+Continuation Scan[\s\S]+Stop Condition/iu);
  requires(file, "autopilot emits the audited table", /candidate[\s\S]+classification[\s\S]+evidence[\s\S]+disposition/iu);
  requires(file, "autopilot revalidates persisted claims", /revalidat[\s\S]+persist/iu);
  requires(file, "autopilot compares source and installed state", /source[\s\S]+installed/iu);
  requires(file, "autopilot pairs hot patches with source", /hot.patch[\s\S]+source/iu);
  requires(file, "autopilot owns long-horizon wakeups", /^## Long-horizon wakeup$/mu);
  requires(file, "autopilot preserves explicit human approval", /needs-human-approval[\s\S]+hard exception/iu);
  requires(file, "autopilot keeps machine review as a distinct state", /needs reviewer gate[\s\S]+machine review|machine review[\s\S]+needs reviewer gate/iu);
  requires(file, "autopilot emits an auditor-compatible stop condition", /continuation scan is empty or out of scope/iu);
  contract("autopilot never downgrades explicit human approval", () => {
    assert.doesNotMatch(text(file), /needs-human-approval[\s\S]{0,120}(?:otherwise )?map(?:s)? it to blocking `needs reviewer gate`/iu);
  });
}

for (const file of [
  "skills/stay-in-turn/SKILL.md",
  "plugins/work-suite/skills/stay-in-turn/SKILL.md",
]) {
  requires(file, "stay-in-turn chooses by host capability", /host[\s\S]+capabilit/iu);
  requires(file, "stay-in-turn has a foreground fallback", /foreground[\s\S]+fallback/iu);
  requires(file, "stay-in-turn observes success and failure", /success[\s\S]+failure[\s\S]+terminal/iu);
}

for (const file of [
  "skills/inch-worm/SKILL.md",
  "plugins/work-suite/skills/inch-worm/SKILL.md",
  "skills/watchdog-mode/SKILL.md",
  "plugins/work-suite/skills/watchdog-mode/SKILL.md",
  "skills/full-systems-audit/SKILL.md",
]) {
  requires(file, "waiting callers use the host-capability branch", /stay-in-turn[\s\S]+host[\s\S]+capabilit/iu);
  contract("waiting callers do not prescribe Monitor unconditionally", () => {
    assert.doesNotMatch(text(file), /right shape is[\s\S]{0,160}(?:a driver script \+ `Monitor`|driver-plus-Monitor)/iu);
  });
}

for (const file of [
  "plugins/desk/skills/work-orchestration/SKILL.md",
]) {
  requires(file, "orchestration checks authority before mutation", /before[\s\S]{0,100}(branch|worktree|source edit)[\s\S]{0,140}(authority|contribution path)|(?:authority|contribution path)[\s\S]{0,140}before[\s\S]{0,100}(branch|worktree|source edit)/iu);
  requires(file, "orchestration uses an explicit DAG", /explicit DAG/iu);
  requires(file, "orchestration rejects array-order inference", /repos\[\][\s\S]+never[\s\S]+(?:order|dependency)/iu);
  requires(file, "orchestration rejects invalid dependency graphs", /cycle[\s\S]+unknown dependenc[\s\S]+failed predecessor/iu);
  requires(file, "orchestration coordinates shared version files", /shared[\s\S]+version[\s\S]+serializ|version[\s\S]+conflict/iu);
  requires(file, "orchestration leaves task lifecycle to Desk", /Desk[\s\S]+task[\s\S]+iteration[\s\S]+state/iu);
  requires(file, "orchestration returns nested review to its parent", /nested[\s\S]+parent/iu);
  requires(file, "orchestration preserves explicit human approval", /needs-human-approval[\s\S]+hard exception/iu);
  requires(file, "orchestration scopes branch review to the diff boundary", /fresh cold branch review[\s\S]+diff boundary/iu);
  contract("orchestration never downgrades explicit human approval", () => {
    assert.doesNotMatch(text(file), /needs-human-approval[\s\S]{0,120}(?:otherwise )?map(?:s)? it to blocking `needs reviewer gate`/iu);
  });
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
  "plugins/work-suite/.claude-plugin/plugin.json",
  "plugins/work-suite/.codex-plugin/plugin.json",
]) {
  const plugin = json(file);
  const dependencyVersion = plugin.dependencies?.find((dependency) => (
    dependency.name === "ponytail-upstream"
  ))?.version ?? plugin.activation?.codex?.dependencies?.["ponytail-upstream"]?.version;
  assert.equal(dependencyVersion, "4.9.0");
}

contract("Work Suite root manifest omits inert dependency metadata", () => {
  const plugin = json("plugins/work-suite/plugin.json");
  assert.equal(plugin.version, "3.0.0");
  assert.equal(Object.hasOwn(plugin, "dependencies"), false);
  assert.equal(Object.hasOwn(plugin, "activation"), false);
});

for (const file of [
  "plugins/work-suite/.claude-plugin/plugin.json",
  "plugins/work-suite/.codex-plugin/plugin.json",
]) {
  contract(`${file} releases Work Suite 3.0.0`, () => {
    assert.equal(json(file).version, "3.0.0");
  });
}

for (const file of [
  "plugins/desk/plugin.json",
  "plugins/desk/.claude-plugin/plugin.json",
  "plugins/desk/.codex-plugin/plugin.json",
]) {
  contract(`${file} releases Desk 3.0.0`, () => {
    assert.equal(json(file).version, "3.0.0");
  });
}

contract("direct Copilot companion versions match their manifests", () => {
  const readme = text("plugins/work-suite/README.md");
  const plainLanguageVersion = json("plugins/plain-language/plugin.json").version;
  const ponytailVersion = json("plugins/ponytail-upstream/plugin.json").version;
  assert.match(readme, new RegExp(`Plain Language v${plainLanguageVersion.replaceAll(".", "\\.")}`, "u"));
  assert.match(readme, new RegExp(`Ponytail v${ponytailVersion.replaceAll(".", "\\.")}`, "u"));
});

for (const file of ["README.md", "plugins/work-suite/README.md"]) {
  contract(`${file} runtime audit names every Work Suite skill`, () => {
    const activeSkills = (text(file).match(/--active-skills (?<skills>[^\n\\]+)/u)?.groups?.skills ?? "").trim();
    for (const skill of workSuiteSkillNames) assert.match(activeSkills, new RegExp(`(?:^|,)${skill}(?:,|$)`, "u"));
  });
}

contract("Work Suite CI includes the Autopilot state audit", () => {
  assert.match(
    text(".github/workflows/validate-skills.yml"),
    /node scripts\/test-autopilot-state-audit\.cjs/u,
  );
});

contract("marketplace metadata no longer advertises Work Suite 2", () => {
  assert.doesNotMatch(text(".claude-plugin/marketplace.json"), /Work Suite 2\b/u);
});

requires(
  "README.md",
  "README documents complete Doer proof",
  /work-doer[\s\S]{0,160}test-first[\s\S]{0,120}complete coverage/iu,
);
requires(
  "README.md",
  "README documents host-portable waiting",
  /stay-in-turn[\s\S]{0,180}native notification[\s\S]{0,120}foreground fallback/iu,
);

contract("coverage exclusion list has no campaign additions", () => {
  assert.deepEqual(
    json("plugins/desk/mcp/config/coverage-gate.json").exclusions.map(({ path: file }) => file).sort(),
    ["scripts/audit-work-suite-runtime.cjs", "scripts/validate-skills.cjs"],
  );
});

assert.equal(json("plugins/plain-language/plugin.json").version, "0.2.0");
assert.equal(json("plugins/ponytail-upstream/plugin.json").version, "4.9.0");
assert.equal(json("plugins/desk/mcp/package.json").version, "1.3.3");

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
  assert.doesNotMatch(body, /proof proportional to risk/iu);
}

assert.equal(
  contractFailures.length,
  0,
  `Work Suite capability contracts failed:\n${contractFailures.join("\n")}`,
);

console.log("Work Suite contracts passed.");
