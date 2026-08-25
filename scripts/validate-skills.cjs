#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync: defaultSpawnSync } = require("node:child_process");

const maxCodexSkillDescriptionLength = 1024;
const maxCodexDefaultPromptCount = 3;
const maxCodexDefaultPromptLength = 128;
const requiredDeskMcpPackageScripts = {
  "activation:support-matrix:generate": "node scripts/generate-support-matrix.js",
  "activation:copilot-bundle:generate": "node scripts/generate-copilot-bundle.js",
  "runtime:deps-pack:build": "node scripts/build-runtime-deps-pack.js",
  "runtime:deps-pack:verify": "node scripts/verify-runtime-deps-pack.js",
  "artifact:vector-pack:build": "node scripts/build-vector-pack.js",
  "artifact:snapshot:build": "node scripts/build-snapshot.js",
  "artifact:snapshot:verify": "node scripts/verify-snapshot.js",
  "artifact:validate": "node scripts/validate-artifacts.js",
};
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
const canonicalPluginCopies = {
  "work-suite": workSuiteSkillNames,
  "plain-language": ["plain-language"],
};

function repoPath(filePath, { repoRoot = process.cwd() } = {}) {
  return path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
}

function readText(filePath, options = {}) {
  const fsImpl = options.fs ?? fs;
  return fsImpl.readFileSync(repoPath(filePath, options), "utf8");
}

function readJson(filePath, options = {}) {
  return JSON.parse(readText(filePath, options));
}

function exists(filePath, options = {}) {
  const fsImpl = options.fs ?? fs;
  return fsImpl.existsSync(repoPath(filePath, options));
}

function readDir(filePath, options = {}) {
  const fsImpl = options.fs ?? fs;
  return fsImpl.readdirSync(repoPath(filePath, options));
}

function stat(filePath, options = {}) {
  const fsImpl = options.fs ?? fs;
  return fsImpl.statSync(repoPath(filePath, options));
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function frontmatterBlock(body) {
  return body.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? null;
}

function frontmatterScalar(frontmatter, key) {
  const lines = frontmatter.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(new RegExp(`^${key}:\\s*(.*)$`, "u"));
    if (!match) {
      continue;
    }
    const value = match[1].trim();
    if (["|", "|-", ">", ">-"].includes(value)) {
      const blockLines = [];
      for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
        if (/^\S[^:]*:\s*/u.test(lines[blockIndex])) {
          break;
        }
        blockLines.push(lines[blockIndex].replace(/^\s{2,}/u, ""));
      }
      return blockLines.join("\n").trim();
    }
    if (!isQuotedYamlScalar(value) && /:\s/u.test(value)) {
      throw new Error(`${key} inline scalar contains ': '; quote it or use a block scalar`);
    }
    return value.replace(/^"|"$/gu, "").replace(/^'|'$/gu, "");
  }
  return null;
}

function isQuotedYamlScalar(value) {
  return /^(['"]).*\1$/u.test(value);
}

function validateManifest(options = {}) {
  const manifest = readJson("manifest.json", options);
  if (!Array.isArray(manifest.skills)) {
    throw new Error("manifest.skills must be an array");
  }

  const names = new Set();
  for (const skill of manifest.skills) {
    if (!skill || typeof skill !== "object") {
      throw new Error("every skill entry must be an object");
    }
    if (typeof skill.name !== "string" || skill.name.trim() === "") {
      throw new Error(`invalid skill name: ${JSON.stringify(skill)}`);
    }
    if (names.has(skill.name)) {
      throw new Error(`duplicate skill name: ${skill.name}`);
    }
    names.add(skill.name);

    if (typeof skill.path !== "string" || !skill.path.endsWith("/SKILL.md")) {
      throw new Error(`${skill.name}: path must point at SKILL.md`);
    }
    if (!exists(skill.path, options)) {
      throw new Error(`${skill.name}: missing ${skill.path}`);
    }
    if (typeof skill.description !== "string" || skill.description.trim() === "") {
      throw new Error(`${skill.name}: description is required`);
    }
    if (!Array.isArray(skill.tags) || skill.tags.length === 0) {
      throw new Error(`${skill.name}: tags must be a non-empty array`);
    }

    const body = readText(skill.path, options);
    const frontmatter = body.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter) {
      throw new Error(`${skill.name}: missing YAML frontmatter`);
    }
    const declaredName = frontmatter[1].match(/^name:\s*"?([^"\n]+)"?\s*$/m)?.[1];
    if (declaredName !== skill.name) {
      throw new Error(`${skill.name}: frontmatter name is ${declaredName ?? "missing"}`);
    }
  }

  console.log(`Validated ${manifest.skills.length} skills.`);
}

function validateCanonicalPluginCopies(options = {}) {
  const copyMap = options.copyMap ?? canonicalPluginCopies;
  let validatedCopies = 0;

  for (const [plugin, skills] of Object.entries(copyMap)) {
    const pluginRoot = path.join("plugins", plugin, "skills");
    const pluginEntries = readDir(pluginRoot, options)
      .filter((name) => stat(path.join(pluginRoot, name), options).isDirectory())
      .sort();
    const expectedEntries = [...skills].sort();
    const missing = expectedEntries.filter((name) => !pluginEntries.includes(name));
    const extra = pluginEntries.filter((name) => !expectedEntries.includes(name));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(`${plugin} skill set mismatch: missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`);
    }

    for (const skill of skills) {
      const canonicalPath = path.join("skills", skill, "SKILL.md");
      const pluginPath = path.join(pluginRoot, skill, "SKILL.md");
      if (!exists(canonicalPath, options)) {
        throw new Error(`${plugin} skill ${skill}: missing canonical ${canonicalPath}`);
      }
      if (!exists(pluginPath, options)) {
        throw new Error(`${plugin} skill ${skill}: missing plugin copy ${pluginPath}`);
      }
      const canonical = readText(canonicalPath, options);
      const pluginCopy = readText(pluginPath, options);
      if (canonical !== pluginCopy) {
        throw new Error(`${plugin} skill ${skill}: ${pluginPath} is out of sync with ${canonicalPath}`);
      }
      validatedCopies += 1;
    }
  }

  console.log(`Validated ${validatedCopies} canonical plugin copies across ${Object.keys(copyMap).length} plugin(s).`);
}

function validatePluginMetadata(options = {}) {
  const pluginsDir = "plugins";
  const pluginNames = readDir(pluginsDir, options)
    .filter((name) => stat(path.join(pluginsDir, name), options).isDirectory())
    .sort();

  for (const name of pluginNames) {
    const claudePath = path.join(pluginsDir, name, ".claude-plugin", "plugin.json");
    const codexPath = path.join(pluginsDir, name, ".codex-plugin", "plugin.json");
    if (!exists(claudePath, options) || !exists(codexPath, options)) {
      continue;
    }
    const claude = readJson(claudePath, options);
    const codex = readJson(codexPath, options);
    if (claude.name !== codex.name) {
      throw new Error(`${name}: Claude plugin name ${claude.name} does not match Codex plugin name ${codex.name}`);
    }
    if (claude.version !== codex.version) {
      throw new Error(`${name}: Claude plugin version ${claude.version} does not match Codex plugin version ${codex.version}`);
    }
    const defaultPrompts = codex.interface?.defaultPrompt ?? [];
    if (!Array.isArray(defaultPrompts)) {
      throw new Error(`${name}: Codex interface.defaultPrompt must be an array`);
    }
    if (defaultPrompts.length > maxCodexDefaultPromptCount) {
      throw new Error(`${name}: Codex interface.defaultPrompt must contain at most ${maxCodexDefaultPromptCount} prompts`);
    }
    for (const [index, prompt] of defaultPrompts.entries()) {
      if (typeof prompt !== "string") {
        throw new Error(`${name}: Codex interface.defaultPrompt[${index}] must be a string`);
      }
      if (prompt.length > maxCodexDefaultPromptLength) {
        throw new Error(`${name}: Codex interface.defaultPrompt[${index}] exceeds ${maxCodexDefaultPromptLength} characters`);
      }
    }
    if (hasText(codex.skills)) {
      const skillsDir = path.join(pluginsDir, name, codex.skills.replace(/^\.\//u, ""));
      for (const skillName of readDir(skillsDir, options)) {
        const skillPath = path.join(skillsDir, skillName, "SKILL.md");
        if (!exists(skillPath, options)) {
          continue;
        }
        const frontmatter = frontmatterBlock(readText(skillPath, options));
        if (!frontmatter) {
          throw new Error(`${name}/${skillName}: missing YAML frontmatter`);
        }
        let description;
        try {
          description = frontmatterScalar(frontmatter, "description");
        } catch (error) {
          throw new Error(`${name}/${skillName}: ${error.message}`);
        }
        if (!hasText(description)) {
          throw new Error(`${name}/${skillName}: frontmatter description is required`);
        }
        if (description.length > maxCodexSkillDescriptionLength) {
          throw new Error(`${name}/${skillName}: frontmatter description exceeds ${maxCodexSkillDescriptionLength} characters`);
        }
      }
    }
  }

  const marketplacePath = path.join(".claude-plugin", "marketplace.json");
  const marketplace = readJson(marketplacePath, options);
  for (const plugin of marketplace.plugins ?? []) {
    if (typeof plugin.source !== "string") {
      continue;
    }
    const pluginPath = path.join(plugin.source, ".claude-plugin", "plugin.json");
    if (!exists(pluginPath, options)) {
      throw new Error(`${plugin.name}: marketplace source is missing ${pluginPath}`);
    }
    const manifest = readJson(pluginPath, options);
    if (plugin.name !== manifest.name) {
      throw new Error(`${plugin.name}: marketplace name does not match ${pluginPath} name ${manifest.name}`);
    }
    if (plugin.version !== manifest.version) {
      throw new Error(`${plugin.name}: marketplace version ${plugin.version} does not match ${pluginPath} version ${manifest.version}`);
    }
  }

  const codexPluginNames = pluginNames
    .filter((name) => exists(path.join(pluginsDir, name, ".codex-plugin", "plugin.json"), options));
  const codexMarketplacePath = path.join(".agents", "plugins", "marketplace.json");
  if (codexPluginNames.length > 0) {
    if (!exists(codexMarketplacePath, options)) {
      throw new Error(`Codex marketplace is missing ${codexMarketplacePath}`);
    }
    const codexMarketplace = readJson(codexMarketplacePath, options);
    if (!hasText(codexMarketplace.name)) {
      throw new Error("Codex marketplace name is required for plugin cache namespace checks");
    }
    if (!Array.isArray(codexMarketplace.plugins)) {
      throw new Error("Codex marketplace plugins must be an array");
    }

    const codexEntries = new Map();
    for (const plugin of codexMarketplace.plugins) {
      if (!hasText(plugin?.name)) {
        continue;
      }
      if (codexEntries.has(plugin.name)) {
        throw new Error(`${plugin.name}: duplicate Codex marketplace plugin entry`);
      }
      codexEntries.set(plugin.name, plugin);
    }

    for (const name of codexPluginNames) {
      const plugin = codexEntries.get(name);
      if (!plugin) {
        throw new Error(`${name}: Codex marketplace missing plugin entry`);
      }
      if (!isObject(plugin.source) || !hasText(plugin.source.path)) {
        throw new Error(`${name}: Codex marketplace source.path is required`);
      }
      if (plugin.source.source !== "local") {
        throw new Error(`${name}: Codex marketplace source.source must be local`);
      }
      const pluginPath = path.join(plugin.source.path, ".codex-plugin", "plugin.json");
      if (!exists(pluginPath, options)) {
        throw new Error(`${name}: Codex marketplace source is missing ${pluginPath}`);
      }
      const manifest = readJson(pluginPath, options);
      if (name !== manifest.name) {
        throw new Error(`${name}: Codex marketplace name does not match ${pluginPath} name ${manifest.name}`);
      }
    }
  }

  console.log("Validated plugin metadata.");
}

function validateDeskMcpPackageScripts(options = {}) {
  const packagePath = path.join("plugins", "desk", "mcp", "package.json");
  const packageJson = readJson(packagePath, options);
  for (const [scriptName, command] of Object.entries(requiredDeskMcpPackageScripts)) {
    if (packageJson.scripts?.[scriptName] !== command) {
      throw new Error(`desk MCP package script ${scriptName} must be ${command}`);
    }
    const targetPath = path.join("plugins", "desk", "mcp", command.replace(/^node\s+scripts\//u, "scripts/"));
    if (!exists(targetPath, options)) {
      throw new Error(`desk MCP package script ${scriptName} target is missing: ${targetPath}`);
    }
  }

  console.log(`Validated ${Object.keys(requiredDeskMcpPackageScripts).length} desk MCP package scripts.`);
}

function runDeskFreshnessChecks(options = {}) {
  const {
    childStdio = "inherit",
    repoRoot = process.cwd(),
    spawnSync = defaultSpawnSync,
  } = options;
  validateDeskMcpPackageScripts(options);

  const hostManifestResult = spawnSync(process.execPath, ["scripts/test-desk-host-manifests.cjs"], {
    cwd: repoRoot,
    stdio: childStdio,
  });
  if ((hostManifestResult.status ?? 1) !== 0) {
    throw new Error("desk host manifest freshness tests failed");
  }

  const generatedArtifactResult = spawnSync(process.execPath, ["scripts/test-desk-generated-artifacts.cjs"], {
    cwd: repoRoot,
    stdio: childStdio,
  });
  if ((generatedArtifactResult.status ?? 1) !== 0) {
    throw new Error("desk generated artifact freshness tests failed");
  }

  const codexCacheAuditResult = spawnSync(process.execPath, ["scripts/test-codex-plugin-cache-audit.cjs"], {
    cwd: repoRoot,
    stdio: childStdio,
  });
  if ((codexCacheAuditResult.status ?? 1) !== 0) {
    throw new Error("codex plugin cache audit tests failed");
  }
}

function runRuntimeAudit(options = {}) {
  const {
    childStdio = "inherit",
    repoRoot = process.cwd(),
    spawnSync = defaultSpawnSync,
  } = options;
  const autopilotStateResult = spawnSync(process.execPath, ["scripts/test-autopilot-state-audit.cjs"], {
    cwd: repoRoot,
    stdio: childStdio,
  });
  if ((autopilotStateResult.status ?? 1) !== 0) {
    throw new Error("autopilot state audit tests failed");
  }

  const testResult = spawnSync(process.execPath, ["scripts/test-work-suite-runtime-audit.cjs"], {
    cwd: repoRoot,
    stdio: childStdio,
  });
  if ((testResult.status ?? 1) !== 0) {
    throw new Error("work-suite runtime visibility audit tests failed");
  }

  const result = spawnSync(process.execPath, ["scripts/audit-work-suite-runtime.cjs", "--repo-root", "."], {
    cwd: repoRoot,
    stdio: childStdio,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error("work-suite runtime visibility contract audit failed");
  }
}

function listSkillFiles(dir, options, out) {
  let entries;
  try {
    entries = readDir(dir, options);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") {
      continue;
    }
    const full = path.join(dir, entry);
    if (stat(full, options).isDirectory()) {
      listSkillFiles(full, options, out);
    } else if (entry === "SKILL.md") {
      out.push(full);
    }
  }
  return out;
}

// Enforces the Agent Skills spec frontmatter limits on EVERY skill in the repo
// (https://agentskills.io/specification): name <=64 chars + matches its directory,
// description non-empty + <=1024 chars. A description over 1024 chars fails to load
// in the Copilot CLI and other Agent Skills runtimes. The authoring rubric for
// writing tight descriptions lives in the skill-management skill.
function validateSkillDescriptionLimits(options = {}) {
  const maxLen = maxCodexSkillDescriptionLength;
  const maxNameLen = 64;
  const files = [];
  for (const root of ["skills", "plugins"]) {
    if (exists(root, options)) {
      listSkillFiles(root, options, files);
    }
  }
  for (const file of files) {
    const frontmatter = frontmatterBlock(readText(file, options));
    if (!frontmatter) {
      throw new Error(`${file}: missing YAML frontmatter`);
    }
    const name = frontmatterScalar(frontmatter, "name");
    const description = frontmatterScalar(frontmatter, "description");
    const dir = path.basename(path.dirname(file));
    if (!hasText(name)) {
      throw new Error(`${file}: frontmatter name is missing`);
    }
    if (name.length > maxNameLen) {
      throw new Error(`${file}: frontmatter name exceeds ${maxNameLen} characters (${name.length})`);
    }
    if (name !== dir) {
      throw new Error(`${file}: frontmatter name "${name}" does not match directory "${dir}"`);
    }
    if (!hasText(description)) {
      throw new Error(`${file}: frontmatter description is missing`);
    }
    if (description.length > maxLen) {
      throw new Error(`${file}: frontmatter description exceeds ${maxLen} characters (${description.length})`);
    }
  }
  console.log(`Validated ${files.length} skill descriptions within ${maxLen} characters.`);
}

function validateAll(options = {}) {
  validateSkillDescriptionLimits(options);
  validateManifest(options);
  validateCanonicalPluginCopies(options);
  validatePluginMetadata(options);
  validateAppleDistributionKitSkill(options);
  runDeskFreshnessChecks(options);
  runRuntimeAudit(options);
}

function validateAppleDistributionKitSkill(options = {}) {
  const {
    childStdio = "inherit",
    repoRoot = process.cwd(),
    spawnSync = defaultSpawnSync,
  } = options;
  const result = spawnSync(process.execPath, ["scripts/check-apple-distribution-kit-skill.cjs"], {
    cwd: repoRoot,
    stdio: childStdio,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error("apple distribution kit skill guidance check failed");
  }
}

function run({
  stderr = process.stderr,
  stdout = process.stdout,
  validateAllFn = validateAll,
  ...options
} = {}) {
  try {
    validateAllFn({ ...options, stderr, stdout });
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function startCli({
  isMain = require.main === module,
  runFn = run,
  setExitCode = (code) => {
    process.exitCode = code;
  },
} = {}) {
  if (!isMain) return null;
  const code = runFn();
  setExitCode(code);
  return code;
}

module.exports = {
  canonicalPluginCopies,
  readJson,
  run,
  runDeskFreshnessChecks,
  runRuntimeAudit,
  startCli,
  validateAll,
  validateAppleDistributionKitSkill,
  validateCanonicalPluginCopies,
  validateDeskMcpPackageScripts,
  validateManifest,
  validatePluginMetadata,
  validateSkillDescriptionLimits,
};

startCli();
