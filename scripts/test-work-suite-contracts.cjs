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

function subsection(file, heading) {
  const body = text(file).split(`### ${heading}\n`, 2)[1];
  assert.ok(body, `${file} is missing subsection ${heading}`);
  return body.split(/\n#{2,3} /u, 1)[0];
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
assert.match(
  text("plugins/desk/skills/git-hygiene/SKILL.md").split("---", 3)[1],
  /after every ref change[\s\S]+required check fails[\s\S]+validation proof may be reused/iu,
);
contract("git hygiene attributes failures only after they occur", () => {
  assert.match(
    subsection("plugins/desk/skills/git-hygiene/SKILL.md", "Attribute failures after they happen"),
    /do not establish[\s\S]+baseline preemptively[\s\S]+check fails[\s\S]+may be\s+pre-existing[\s\S]+target CI[\s\S]+exact target SHA[\s\S]+same command[\s\S]+clean merge-base worktree[\s\S]+recorded[\s\S]+reproducible baseline[\s\S]+commit[\s\S]+unknown remains failed/iu,
  );
});
contract("git hygiene reuses proof only while its inputs match", () => {
  assert.match(
    subsection("plugins/desk/skills/git-hygiene/SKILL.md", "Reuse proof only while inputs match"),
    /reuse[\s\S]+only while[\s\S]+source\/diff\s+fingerprint[\s\S]+exact command and selection[\s\S]+dependency and[\s\S]+configuration fingerprint[\s\S]+environment all match[\s\S]+input\s+changed[\s\S]+rerun/iu,
  );
});
contract("git hygiene rechecks executable repository configuration after ref changes", () => {
  const body = subsection("plugins/desk/skills/git-hygiene/SKILL.md", "Folder trust is path trust, not revision trust");
  assert.match(
    body,
    /after every ref change[\s\S]+inspect[\s\S]+repository-owned\s+executable[\s\S]+before[\s\S]+(?:load|run)/iu,
  );
  assert.match(
    body,
    /command-bearing file[\s\S]+diff it against[\s\S]+protected base[\s\S]+explicit approval[\s\S]+before executing/iu,
  );
});
contract("runtime investigation proves causality and removes diagnostic changes", () => {
  assert.match(
    subsection("plugins/desk/skills/runtime-symptom-investigation/SKILL.md", "Prove the cause before changing behavior"),
    /do not change product behavior[\s\S]+counterfactual[\s\S]+symptom[\s\S]+record every temporary diagnostic change[\s\S]+before handback[\s\S]+reverse only that diagnostic delta[\s\S]+verify[\s\S]+absent[\s\S]+preserve unrelated concurrent changes[\s\S]+fingerprint is evidence, not ownership[\s\S]+never[\s\S]+concurrent user or tool change/iu,
  );
});
requires(
  "plugins/desk/skills/curator/SKILL.md",
  "curator triages existing rules before encoding",
  /already have covered[\s\S]+loading[\s\S]+placement[\s\S]+enforcement[\s\S]+regression evidence[\s\S]+instead of writing the rule twice/iu,
);
requires(
  "plugins/desk/skills/curator/SKILL.md",
  "curator consolidates governing rules before adding prose",
  /conflict[\s\S]+consolidate[\s\S]+one owner[\s\S]+buried[\s\S]+cut or simplify[\s\S]+before adding[\s\S]+root cause/iu,
);
requires(
  "plugins/desk/skills/friction-management/SKILL.md",
  "friction captures question-shaped workflow failures",
  /operator asks why[\s\S]+omitted[\s\S]+diverged[\s\S]+unexpected[\s\S]+rule already exists[\s\S]+loaded[\s\S]+verified cause[\s\S]+existing rules did not prevent/iu,
);

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
  contract(`planner preserves confirmed customer decisions in ${file}`, () => {
    assert.match(
      subsection(file, "Preserve confirmed customer decisions"),
      /customer-visible[\s\S]+canonical value[\s\S]+customer situation[\s\S]+inclusion harm[\s\S]+exclusion harm[\s\S]+evidence[\s\S]+recommendation[\s\S]+counterargument[\s\S]+confirmed outcome[\s\S]+confirming authority[\s\S]+implementation (?:is|was) easier[\s\S]+unresolved conflict[\s\S]+not ready/iu,
    );
    assert.match(
      subsection(file, "Preserve confirmed customer decisions"),
      /reconcile every confirmed decision and acceptance criterion[\s\S]+chosen design[\s\S]+implementation slice[\s\S]+falsifiable test[\s\S]+consuming-surface proof/iu,
    );
    assert.match(
      subsection(file, "Preserve confirmed customer decisions"),
      /derive that inventory from the producing or owning contract[\s\S]+not from a display label[\s\S]+UI grouping[\s\S]+umbrella term[\s\S]+different customer purposes/iu,
    );
    assert.match(
      subsection(file, "Preserve confirmed customer decisions"),
      /confirmed component boundary[\s\S]+public contract[\s\S]+state owner[\s\S]+trust model[\s\S]+compatibility policy[\s\S]+do not silently replace[\s\S]+reviewer consensus[\s\S]+confirming authority/iu,
    );
  });
  contract(`planner settles durable contracts before propagation in ${file}`, () => {
    const body = subsection(file, "Settle durable contracts before propagation");
    assert.match(body, /before creating a durable contract or generating its consumers/iu);
    assert.match(
      body,
      /proposed name and shape[\s\S]+call site[\s\S]+without implementation context[\s\S]+resolve material ambiguity before it propagates[\s\S]+generated clients[\s\S]+tests[\s\S]+telemetry[\s\S]+documentation[\s\S]+downstream consumers[\s\S]+internal consistency[\s\S]+not evidence/iu,
    );
  });
  contract(`planner requires inactive configuration containment in ${file}`, () => {
    const body = text(file).split("Every behavior-changing slice names:", 2)[1]?.split("\n\nStrict TDD", 1)[0];
    assert.ok(body, `${file} is missing the behavior-changing slice contract`);
    assert.match(
      body,
      /default-off[\s\S]+configuration-gated[\s\S]+owning contract[\s\S]+activation seam[\s\S]+inactive state[\s\S]+real routing boundary[\s\S]+proves the pre-change path survives/iu,
    );
    assert.match(
      body,
      /changed boundary[\s\S]+success[\s\S]+when applicable[\s\S]+invalid input[\s\S]+dependency failure[\s\S]+timeout[\s\S]+cancellation[\s\S]+partial mutation[\s\S]+retry[\s\S]+duplication[\s\S]+error translation/iu,
    );
  });
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
  contract(`doer places behavior at its canonical owner in ${file}`, () => {
    assert.match(
      subsection(file, "Place behavior at its owner"),
      /canonical owner[\s\S]+repository evidence[\s\S]+nearest caller[\s\S]+currently open file[\s\S]+narrowest visibility[\s\S]+current production consumers[\s\S]+solely for tests[\s\S]+anticipated reuse/iu,
    );
  });
  contract(`doer contains inactive configuration paths in ${file}`, () => {
    const body = subsection(file, "Contain configuration-gated behavior");
    assert.match(
      body,
      /default-off[\s\S]+configuration-gated[\s\S]+inactive state[\s\S]+owning contract[\s\S]+real routing boundary/iu,
    );
    assert.match(
      body,
      /false[\s\S]+missing[\s\S]+malformed[\s\S]+unavailable[\s\S]+stale[\s\S]+unsupported[\s\S]+pre-change behavior[\s\S]+contract defines them as inactive/iu,
    );
    assert.match(body, /mutation-test[\s\S]+fails when the preserved route changes/iu);
    assert.match(body, /calls the new code directly is not containment evidence/iu);
    assert.match(
      body,
      /mutation[\s\S]+weakening production code[\s\S]+mock[\s\S]+shared boundary[\s\S]+activation seam[\s\S]+exceptional[\s\S]+existing consumer/iu,
    );
  });
  contract(`doer proves changed-boundary failure contracts in ${file}`, () => {
    const body = subsection(file, "Prove changed-boundary failure contracts");
    assert.match(
      body,
      /changed boundary[\s\S]+success[\s\S]+when applicable[\s\S]+invalid input[\s\S]+dependency failure[\s\S]+timeout[\s\S]+cancellation[\s\S]+partial mutation[\s\S]+retry[\s\S]+duplication[\s\S]+error translation/iu,
    );
    assert.match(body, /translate errors at the boundary[\s\S]+outgoing contract/iu);
  });
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
  contract(`merger reconciles confirmed customer decisions in ${file}`, () => {
    assert.match(
      subsection(file, "Reconcile confirmed customer decisions"),
      /before merge[\s\S]+after release\/install[\s\S]+separately recorded confirmed customer decision and acceptance criterion[\s\S]+confirmed component boundary[\s\S]+public contract[\s\S]+state owner[\s\S]+trust model[\s\S]+compatibility policy[\s\S]+shipped behavior[\s\S]+technical constraint[\s\S]+mismatch[\s\S]+recorded authority/iu,
    );
  });
  contract(`merger retargets stacked work without inherited diffs in ${file}`, () => {
    assert.match(
      subsection(file, "Retarget stacked work without inherited diffs"),
      /record the base PR[\s\S]+base branch[\s\S]+exact base source SHA[\s\S]+original merge base[\s\S]+base merges[\s\S]+ancestry[\s\S]+recompute the merge base[\s\S]+complete intended diff[\s\S]+retarget only[\s\S]+feature changes[\s\S]+squash[\s\S]+replacement branch[\s\S]+final target[\s\S]+replacement PR[\s\S]+do not force-push[\s\S]+published history[\s\S]+rerun[\s\S]+review and validation/iu,
    );
  });
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
  contract(`${file} releases Desk 3.1.1`, () => {
    assert.equal(json(file).version, "3.1.1");
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

contract("Work Suite CI includes skill evaluation contracts", () => {
  assert.match(
    text(".github/workflows/validate-skills.yml"),
    /name: Validate skill eval contracts[\s\S]+node scripts\/test-skill-evals\.cjs && node scripts\/skill-evals\.cjs validate/u,
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
    ["scripts/audit-work-suite-runtime.cjs", "scripts/skill-evals.cjs", "scripts/validate-skills.cjs"],
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
