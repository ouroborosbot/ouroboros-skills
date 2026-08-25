#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const event = process.argv[2];
if (!["SessionStart", "SubagentStart"].includes(event)) {
  console.error(`unsupported Plain Language hook event: ${event || "missing"}`);
  process.exit(1);
}

const skillPath = path.join(__dirname, "..", "skills", "plain-language", "SKILL.md");
let body;
try {
  body = fs.readFileSync(skillPath, "utf8").replace(/^---[\s\S]*?---\s*/u, "");
} catch (error) {
  console.error(`Plain Language hook could not load ${skillPath}: ${error.message}`);
  process.exit(1);
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: event,
    additionalContext: `[PLAIN_LANGUAGE_CONTRACT]\n${body}`,
  },
}));
