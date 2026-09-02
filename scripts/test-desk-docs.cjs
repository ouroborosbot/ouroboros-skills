#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const defaultRepoRoot = path.resolve(__dirname, "..");

const DOCS = Object.freeze([
  "plugins/desk/README.md",
  "plugins/desk/docs/agent-files.md",
  "plugins/desk/mcp/README.md",
  "plugins/desk/activation/README.md",
  "plugins/desk/docs/dependency-activation-stories-and-criteria.md",
  "desk/tasks/2026-06-14-1335-planning-desk-dependency-activation.md",
]);

const PRIVACY_REQUIRED_DOCS = Object.freeze([
  "plugins/desk/README.md",
  "plugins/desk/mcp/README.md",
  "plugins/desk/activation/README.md",
]);

const TOPIC_REQUIREMENTS = Object.freeze([
  Object.freeze({
    label: "Codex global personal activation",
    docs: Object.freeze([
      "plugins/desk/README.md",
      "plugins/desk/docs/agent-files.md",
    ]),
    terms: Object.freeze([
      "codex",
      "global-personal",
      "project-local",
      "manual-only",
      "desk mcp bridge",
    ]),
  }),
  Object.freeze({
    label: "Claude native dependency activation",
    docs: Object.freeze([
      "plugins/desk/README.md",
      "plugins/desk/docs/agent-files.md",
    ]),
    terms: Object.freeze([
      "claude",
      "dependency",
      "desk + work suite",
      "flattened",
    ]),
  }),
  Object.freeze({
    label: "Copilot root flattened bundle",
    docs: Object.freeze([
      "plugins/desk/README.md",
      "plugins/desk/docs/agent-files.md",
    ]),
    terms: Object.freeze([
      "copilot",
      "flattened work suite metadata",
      "worker",
    ]),
  }),
  Object.freeze({
    label: "Ouroboros autonomous-agent bundle",
    docs: Object.freeze([
      "plugins/desk/README.md",
      "plugins/desk/activation/README.md",
    ]),
    terms: Object.freeze([
      "ouroboros",
      "autonomous-agent",
      "bundle",
      "$desk",
    ]),
  }),
  Object.freeze({
    label: "Generic stdio MCP-only fallback",
    docs: Object.freeze([
      "plugins/desk/mcp/README.md",
      "plugins/desk/activation/README.md",
    ]),
    terms: Object.freeze([
      "generic stdio",
      "mcp-only",
      "does not activate",
      "does not resolve plugin dependencies",
    ]),
  }),
  Object.freeze({
    label: "Desk overlay activation ladder",
    docs: Object.freeze([
      "plugins/desk/README.md",
      "plugins/desk/docs/agent-files.md",
      "plugins/desk/activation/README.md",
    ]),
    terms: Object.freeze([
      "desk:worker",
      "ms-desk",
      "area overlay",
      "selected activation",
      "active-session-visible",
    ]),
  }),
  Object.freeze({
    label: "Vector pack publication",
    docs: Object.freeze([
      "plugins/desk/README.md",
      "plugins/desk/mcp/README.md",
      "plugins/desk/docs/dependency-activation-stories-and-criteria.md",
      "desk/tasks/2026-06-14-1335-planning-desk-dependency-activation.md",
    ]),
    terms: Object.freeze([
      "vector pack",
      "publication",
      "policy",
    ]),
  }),
  Object.freeze({
    label: "Snapshot warm boot restore",
    docs: Object.freeze([
      "plugins/desk/README.md",
      "plugins/desk/mcp/README.md",
      "plugins/desk/docs/dependency-activation-stories-and-criteria.md",
      "desk/tasks/2026-06-14-1335-planning-desk-dependency-activation.md",
    ]),
    terms: Object.freeze([
      "snapshot",
      "warm boot",
      ".state",
      "restore",
    ]),
  }),
  Object.freeze({
    label: "Redaction cleanup",
    docs: Object.freeze([
      "plugins/desk/docs/dependency-activation-stories-and-criteria.md",
      "desk/tasks/2026-06-14-1335-planning-desk-dependency-activation.md",
    ]),
    terms: Object.freeze([
      "redaction",
      "tombstone",
      "artifact rotation",
    ]),
  }),
  Object.freeze({
    label: "Publication policy approval",
    docs: Object.freeze([
      "plugins/desk/README.md",
      "plugins/desk/mcp/README.md",
      "desk/tasks/2026-06-14-1335-planning-desk-dependency-activation.md",
    ]),
    terms: Object.freeze([
      "publication",
      "policy",
      "public",
      "sensitive",
      "approval",
    ]),
  }),
]);

const WORKFLOW_REQUIREMENTS = Object.freeze([
  Object.freeze({
    path: ".github/workflows/validate-skills.yml",
    command: "node scripts/test-desk-docs.cjs",
  }),
  Object.freeze({
    path: ".github/workflows/desk-mcp-tests.yml",
    command: "node scripts/test-desk-docs.cjs",
    paths: [
      "plugins/desk/README.md",
      "plugins/desk/docs/**",
      "plugins/desk/mcp/README.md",
      "plugins/desk/activation/README.md",
      "desk/tasks/2026-06-14-1335-planning-desk-dependency-activation.md",
      "scripts/test-desk-docs.cjs",
    ],
  }),
]);

const MCP_TOOL_NAMES = Object.freeze([
  "desk_status",
  "desk_doctor",
  "task_create",
  "task_update",
  "task_archive",
  "track_create",
  "track_update",
  "friction_add",
  "lesson_add",
  "desk_search",
  "desk_recall",
  "desk_similar",
  "desk_timeline",
  "desk_thread",
  "desk_reindex",
]);

function readRepoFile(relativePath, {
  repoRoot = defaultRepoRoot,
} = {}) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function markdownLines(relativePath, options = {}) {
  const readFile = options.readFile ?? ((file) => readRepoFile(file, options));
  const lines = readFile(relativePath).split(/\r?\n/u);
  const records = [];
  const headings = [];
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    if (/^\s*```/u.test(text)) inFence = !inFence;
    if (!inFence) {
      const heading = text.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/u);
      if (heading) {
        const depth = heading[1].length;
        headings.length = depth - 1;
        headings.push(heading[2]);
      }
    }
    records.push({
      file: relativePath,
      line: index + 1,
      text,
      lower: text.toLowerCase(),
      headingPath: [...headings],
      inFence,
    });
  }
  return records;
}

function lineRef(record) {
  return `${record.file}:${record.line}`;
}

function headingText(record) {
  return record.headingPath.join(" > ").toLowerCase();
}

function isDeveloperOrTroubleshooting(record) {
  return /\b(troubleshoot|troubleshooting|repair|developer|development|contributor|direct development|local development)\b/u
    .test(headingText(record));
}

function isMcpOnlyFallback(record) {
  return /\b(generic stdio|mcp-only|run it directly|direct launch)\b/u.test(headingText(record));
}

function isNegatedGuidance(record) {
  return /\b(do not|don't|never|without|no |not |rather than|instead of|fails?|rejects?|avoids?|does not|must not)\b/u
    .test(record.lower);
}

function isStrictNegativeGuidance(record) {
  return /\b(do not|don't|never|must not|should not|not part of the healthy path|without manual|without requiring|without (?:me |the operator |users? )?(?:installing|running|copying|appending)|does not require|do not require|no healthy-path|no (?:normal |manual )?(?:need|requirement|manual|copy|append|mcp registration)|avoid(?:s|ing)? manual)\b/u
    .test(record.lower);
}

function isAllowedManualContext(record) {
  return isDeveloperOrTroubleshooting(record) || isMcpOnlyFallback(record) || isNegatedGuidance(record);
}

function isAllowedManualCommandContext(record) {
  return isDeveloperOrTroubleshooting(record) || isStrictNegativeGuidance(record);
}

function hasUncontrolledWorkerInstructionGuidance(record) {
  const mentionsInstructionTarget =
    /\b(?:agents\.md|codex instructions?|codex worker instructions?|worker default(?: instruction)? block|worker-default(?: instruction)? block|agent files?|worker\.toml)\b/u
      .test(record.lower);
  const hasManualEditVerb =
    /\b(?:append|copy|copied|paste|write|drop|place|add|hand-edit|hand edit|manually edit)\b/u
      .test(record.lower);
  return mentionsInstructionTarget && hasManualEditVerb;
}

function hasManualPluginDependencyInstall(record) {
  return /\/plugin\s+install\s+(?:desk|work-suite)(?:@|\b)/u.test(record.lower) ||
    /\binstall(?:s|ed|ing)?\s+`?(?:desk|work-suite)`?\s+(?:explicitly|separately)\b/u.test(record.lower);
}

function validateHealthyPathRecord(errors, record) {
  if (
    !record.inFence &&
    /\binstall(?:s|ed|ing)?\s+desk\b/u.test(record.lower) &&
    !isAllowedManualContext(record)
  ) {
    errors.push(`${lineRef(record)} frames Desk as something to install manually in healthy-path prose`);
  }

  if (
    /\bnpm\s+install\b/u.test(record.lower) &&
    !isAllowedManualCommandContext(record)
  ) {
    errors.push(`${lineRef(record)} mentions npm install outside troubleshooting/developer notes`);
  }

  if (
    /\bcodex\s+mcp\s+add\b/u.test(record.lower) &&
    !isAllowedManualCommandContext(record)
  ) {
    errors.push(`${lineRef(record)} presents codex mcp add outside troubleshooting/developer notes`);
  }

  if (
    hasManualPluginDependencyInstall(record) &&
    !isAllowedManualCommandContext(record)
  ) {
    errors.push(`${lineRef(record)} presents manual Desk/Work Suite plugin dependency installation outside troubleshooting/developer notes`);
  }

  if (
    hasUncontrolledWorkerInstructionGuidance(record) &&
    !isDeveloperOrTroubleshooting(record) &&
    !isStrictNegativeGuidance(record)
  ) {
    errors.push(`${lineRef(record)} presents uncontrolled AGENTS/worker copy or append guidance`);
  }
}

function validateHealthyPathLanguage(errors, {
  docs = DOCS,
  readFile,
  repoRoot = defaultRepoRoot,
} = {}) {
  for (const doc of docs) {
    for (const record of markdownLines(doc, { readFile, repoRoot })) {
      validateHealthyPathRecord(errors, record);
    }
  }
}

function validatePrivacyNotes(errors, {
  docs = PRIVACY_REQUIRED_DOCS,
  readFile = (file) => readRepoFile(file),
} = {}) {
  for (const doc of docs) {
    const lower = readFile(doc).toLowerCase();
    const hasPrivacyNote =
      lower.includes("derivative data") &&
      lower.includes("privacy risk") &&
      lower.includes("embedding") &&
      lower.includes("snapshot");
    if (!hasPrivacyNote) {
      errors.push(`${doc} must state that embeddings and snapshots are derivative data and may carry privacy risk`);
    }
  }
}

function validateTopicCoverage(errors, {
  requirements = TOPIC_REQUIREMENTS,
  readFile,
  repoRoot = defaultRepoRoot,
} = {}) {
  const loadFile = readFile ?? ((file) => readRepoFile(file, { repoRoot }));
  for (const requirement of requirements) {
    const body = requirement.docs.map((doc) => loadFile(doc).toLowerCase()).join("\n");
    const missing = requirement.terms.filter((term) => !body.includes(term.toLowerCase()));
    if (missing.length > 0) {
      errors.push(`docs must cover ${requirement.label}: missing ${missing.join(", ")} in ${requirement.docs.join(", ")}`);
    }
  }
}

function validateWorkflowWiring(errors, {
  requirements = WORKFLOW_REQUIREMENTS,
  readFile = (file) => readRepoFile(file),
} = {}) {
  for (const requirement of requirements) {
    const body = readFile(requirement.path);
    if (!body.includes(requirement.command)) {
      errors.push(`${requirement.path} must run ${requirement.command}`);
    }
    for (const requiredPath of requirement.paths ?? []) {
      const pathPattern = new RegExp(`^\\s*-\\s+["']?${escapeRegExp(requiredPath)}["']?\\s*$`, "mu");
      if (!pathPattern.test(body)) {
        errors.push(`${requirement.path} path filters must include ${requiredPath}`);
      }
    }
  }
}

function validateMcpReadmeToolSurface(errors, {
  readFile = (file) => readRepoFile(file),
  tools = MCP_TOOL_NAMES,
} = {}) {
  const body = readFile("plugins/desk/mcp/README.md");
  const expectedCount = tools.length;
  if (!body.includes(`## Tools exposed (${expectedCount})`)) {
    errors.push(`plugins/desk/mcp/README.md must advertise ${expectedCount} exposed tools`);
  }
  if (!body.includes(`All ${expectedCount} tools are wired to real implementations.`)) {
    errors.push(`plugins/desk/mcp/README.md must state all ${expectedCount} tools are wired`);
  }
  for (const tool of tools) {
    if (!body.includes(`\`${tool}\``)) {
      errors.push(`plugins/desk/mcp/README.md must list ${tool}`);
    }
  }
  if (/\b(?:12|13)\s+tools?\b/u.test(body)) {
    errors.push("plugins/desk/mcp/README.md must not contain stale 12/13 tool counts");
  }
}

function validateBrowserFocusPolicy(errors, {
  readFile = (file) => readRepoFile(file),
} = {}) {
  const body = readFile("plugins/desk/skills/cdp-headed-browser/SKILL.md");
  if (!body.includes("Target.createTarget") || !/background:\s*true/u.test(body)) {
    errors.push("cdp-headed-browser must document background target creation");
  }
  if (/curl[^\n]*\/json\/(?:new|activate)/u.test(body)) {
    errors.push("cdp-headed-browser must not present foregrounding CDP HTTP endpoints as executable recipes");
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function fixtureRecord(text, headingPath = [], options = {}) {
  return {
    file: options.file ?? "fixture.md",
    line: options.line ?? 1,
    text,
    lower: text.toLowerCase(),
    headingPath,
    inFence: options.inFence ?? false,
  };
}

function fixtureErrors(text, headingPath = []) {
  const errors = [];
  validateHealthyPathRecord(errors, fixtureRecord(text, headingPath));
  return errors;
}

function assertFixtureFails(errors, text, expected) {
  const found = fixtureErrors(text);
  if (!found.some((error) => error.includes(expected))) {
    errors.push(`docs validator self-test failed: expected ${JSON.stringify(text)} to fail with ${expected}`);
  }
}

function assertFixturePasses(errors, text, headingPath = []) {
  const found = fixtureErrors(text, headingPath);
  if (found.length > 0) {
    errors.push(`docs validator self-test failed: expected ${JSON.stringify(text)} to pass, got ${found.join("; ")}`);
  }
}

const DEFAULT_FAILING_FIXTURES = Object.freeze([
  Object.freeze({
    text: "If activation fails, run `codex mcp add desk` from the repo.",
    expected: "codex mcp add",
  }),
  Object.freeze({
    text: "Run `npm install` instead of using the runtime pack.",
    expected: "npm install",
  }),
  Object.freeze({
    text: "Paste the worker default block into your Codex instructions.",
    expected: "AGENTS/worker copy or append",
  }),
  Object.freeze({
    text: "Append the worker-default instruction block to AGENTS.md.",
    expected: "AGENTS/worker copy or append",
  }),
  Object.freeze({
    text: "/plugin install desk@ouroboros-skills",
    expected: "manual Desk/Work Suite plugin dependency installation",
  }),
  Object.freeze({
    text: "Claude Code requires you to install `work-suite` explicitly.",
    expected: "manual Desk/Work Suite plugin dependency installation",
  }),
]);

const DEFAULT_PASSING_FIXTURES = Object.freeze([
  Object.freeze({ text: "Do not run `codex mcp add` for the healthy path." }),
  Object.freeze({
    text: "If activation fails, run `codex mcp add desk` from the repo.",
    headingPath: ["Troubleshooting"],
  }),
  Object.freeze({
    text: "Direct development checkouts can still run `npm install` when intentionally working on the MCP package.",
    headingPath: ["Developer notes"],
  }),
  Object.freeze({
    text: "/plugin install desk@ouroboros-skills",
    headingPath: ["Troubleshooting"],
  }),
  Object.freeze({ text: "Copied agent files are not part of the healthy path." }),
]);

function validateValidatorFixtures(errors, {
  failingFixtures = DEFAULT_FAILING_FIXTURES,
  passingFixtures = DEFAULT_PASSING_FIXTURES,
} = {}) {
  for (const fixture of failingFixtures) {
    assertFixtureFails(errors, fixture.text, fixture.expected);
  }
  for (const fixture of passingFixtures) {
    assertFixturePasses(errors, fixture.text, fixture.headingPath ?? []);
  }
}

function validateAll({
  docs = DOCS,
  privacyRequiredDocs = PRIVACY_REQUIRED_DOCS,
  topicRequirements = TOPIC_REQUIREMENTS,
  workflowRequirements = WORKFLOW_REQUIREMENTS,
  readFile,
  repoRoot = defaultRepoRoot,
} = {}) {
  const errors = [];
  validateValidatorFixtures(errors);
  validateWorkflowWiring(errors, { requirements: workflowRequirements, readFile });
  validateHealthyPathLanguage(errors, { docs, readFile, repoRoot });
  validateMcpReadmeToolSurface(errors, { readFile });
  validateBrowserFocusPolicy(errors, { readFile });
  validatePrivacyNotes(errors, { docs: privacyRequiredDocs, readFile });
  validateTopicCoverage(errors, { requirements: topicRequirements, readFile, repoRoot });
  return errors;
}

function run({
  stderr = process.stderr,
  stdout = process.stdout,
  ...options
} = {}) {
  const errors = validateAll(options);

  if (errors.length > 0) {
    stderr.write("Desk docs validation failed:\n");
    for (const error of errors) stderr.write(`- ${error}\n`);
    return 1;
  }
  stdout.write("Desk docs validation passed.\n");
  return 0;
}

function startCli({
  isMain = require.main === module,
  setExitCode = (code) => {
    process.exitCode = code;
  },
  runFn = run,
} = {}) {
  if (!isMain) return null;
  const code = runFn();
  setExitCode(code);
  return code;
}

module.exports = {
  DOCS,
  MCP_TOOL_NAMES,
  PRIVACY_REQUIRED_DOCS,
  TOPIC_REQUIREMENTS,
  WORKFLOW_REQUIREMENTS,
  fixtureRecord,
  fixtureErrors,
  markdownLines,
  run,
  startCli,
  validateAll,
  validateBrowserFocusPolicy,
  validateHealthyPathLanguage,
  validateHealthyPathRecord,
  validateMcpReadmeToolSurface,
  validatePrivacyNotes,
  validateTopicCoverage,
  validateValidatorFixtures,
  validateWorkflowWiring,
};

startCli();
