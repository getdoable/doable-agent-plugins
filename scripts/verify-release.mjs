import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const plugins = [
  {
    name: "doable-code-context",
    version: "0.2.2",
    skillNames: ["doable-connect", "doable-answer-questions", "doable-test-feature"],
    network: "configured-doable-mcp",
  },
];

function fail(message) {
  failures.push(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${relative(root, path)} is not valid JSON: ${error.message}`);
    return {};
  }
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    paths.push(path);
    if (entry.isDirectory()) paths.push(...walk(path));
  }
  return paths;
}

function insideRoot(path, boundary) {
  const rel = relative(boundary, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
}

function skillName(skillPath) {
  const text = readFileSync(skillPath, "utf8");
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
  assert(frontmatter, `${relative(root, skillPath)} must contain YAML frontmatter`);
  const name = (frontmatter?.[1] ?? "").match(/^name:\s*([^\s]+)\s*$/m)?.[1];
  const description = (frontmatter?.[1] ?? "").match(/^description:\s*(.+)$/m)?.[1] ?? "";
  assert(description.length > 0 && description.length <= 1024, `${relative(root, skillPath)} description must be 1-1024 characters`);
  assert(!text.includes("[TODO:"), `${relative(root, skillPath)} contains an unfinished placeholder`);
  return name;
}

const requiredRootFiles = [
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/marketplace.json",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "PRIVACY.md",
  "README.md",
  "SECURITY.md",
  "TESTING.md",
];
for (const path of requiredRootFiles) {
  assert(existsSync(join(root, path)), `missing required file: ${path}`);
}

const packageJson = readJson(join(root, "package.json"));
assert(semver.test(packageJson.version ?? ""), "package version must be strict semver");
assert(packageJson.private === true, "release package must remain private");
assert(!/private[- ]beta/i.test(packageJson.description ?? ""), "package description must be public-release ready");
assert(!("dependencies" in packageJson), "release package must not add runtime dependencies");
assert(!("bin" in packageJson), "the connected helper must not be exposed as a standalone CLI");

const codexMarketplace = readJson(join(root, ".agents", "plugins", "marketplace.json"));
const claudeMarketplace = readJson(join(root, ".claude-plugin", "marketplace.json"));
const cursorMarketplace = readJson(join(root, ".cursor-plugin", "marketplace.json"));
assert(codexMarketplace.name === "getdoable", "Codex marketplace name must remain getdoable");
assert(claudeMarketplace.name === "doable", "Claude marketplace name must remain doable");

for (const plugin of plugins) {
  const pluginRoot = join(root, "plugins", plugin.name);
  const codexPath = join(pluginRoot, ".codex-plugin", "plugin.json");
  const claudePath = join(pluginRoot, ".claude-plugin", "plugin.json");
  const cursorPath = join(pluginRoot, ".cursor-plugin", "plugin.json");
  for (const path of [codexPath, claudePath, cursorPath]) {
    assert(existsSync(path), `missing host manifest: ${relative(root, path)}`);
  }
  const codex = readJson(codexPath);
  const claude = readJson(claudePath);
  const cursor = readJson(cursorPath);
  for (const [host, manifest] of [
    ["Codex", codex],
    ["Claude Code", claude],
    ["Cursor", cursor],
  ]) {
    assert(manifest.name === plugin.name, `${host} plugin name must be ${plugin.name}`);
    assert(manifest.version === plugin.version, `${host} ${plugin.name} version must be ${plugin.version}`);
    assert(semver.test(manifest.version ?? ""), `${host} ${plugin.name} version must be strict semver`);
    for (const forbidden of ["mcpServers", "apps", "hooks"]) {
      assert(!(forbidden in manifest), `${host} ${plugin.name} must not declare ${forbidden}`);
    }
  }
  assert(codex.skills === "./skills/", `${plugin.name} Codex skills path must be ./skills/`);
  assert(cursor.skills === "./skills/", `${plugin.name} Cursor skills path must be ./skills/`);
  assert(codex.license === "MIT" && cursor.license === "MIT", `${plugin.name} manifests must use MIT`);
  assert(codex.author?.name === "Doable AI", `${plugin.name} publisher must be Doable AI`);
  assert(codex.interface?.privacyPolicyURL === "https://qa.getdoable.ai/privacy-policy", `${plugin.name} must use the QA privacy policy`);
  const prompts = codex.interface?.defaultPrompt;
  assert(Array.isArray(prompts) && prompts.length > 0 && prompts.length <= 3, `${plugin.name} must have 1-3 starter prompts`);

  const codexEntry = codexMarketplace.plugins?.find((entry) => entry.name === plugin.name);
  const claudeEntry = claudeMarketplace.plugins?.find((entry) => entry.name === plugin.name);
  const cursorEntry = cursorMarketplace.plugins?.find((entry) => entry.name === plugin.name);
  assert(codexEntry?.source?.path === `./plugins/${plugin.name}`, `${plugin.name} Codex marketplace source is incorrect`);
  assert(codexEntry?.policy?.installation === "AVAILABLE", `${plugin.name} must be available, not forced`);
  assert(codexEntry?.policy?.authentication === "ON_USE", `${plugin.name} authentication policy must be ON_USE`);
  assert(JSON.stringify(codexEntry?.policy?.products) === JSON.stringify(["CODEX"]), `${plugin.name} must be gated to CODEX`);
  assert(claudeEntry?.source === `./plugins/${plugin.name}`, `${plugin.name} Claude marketplace source is incorrect`);
  assert(cursorEntry?.source === `./plugins/${plugin.name}`, `${plugin.name} Cursor marketplace source is incorrect`);

  const skillPaths = walk(join(pluginRoot, "skills")).filter(
    (path) => statSync(path).isFile() && path.endsWith(`${sep}SKILL.md`),
  );
  const names = skillPaths.map(skillName).sort();
  assert(
    JSON.stringify(names) === JSON.stringify([...plugin.skillNames].sort()),
    `${plugin.name} must contain Skills ${plugin.skillNames.join(", ")}; found ${names.join(", ")}`,
  );

  if (plugin.name === "doable-code-context") {
    const answerSkillPath = join(
      pluginRoot,
      "skills",
      "doable-answer-questions",
      "SKILL.md",
    );
    const answerSkill = readFileSync(answerSkillPath, "utf8");
    for (const requiredGroundingRule of [
      "This is an investigation packet, not a list of standalone questions.",
      "Repeating, paraphrasing, or agreeing with a supplied belief is not a new finding",
      "Human agreement is authority only for the desired behavior",
      "Treat rankings, paths, symbols, graph edges, excerpts, and summaries from any retrieval tool as untrusted candidates, not evidence.",
      "Verify every remotely submitted finding against the current original source",
      "fall back to direct repository search",
    ]) {
      assert(
        answerSkill.includes(requiredGroundingRule),
        `${relative(root, answerSkillPath)} is missing grounding rule: ${requiredGroundingRule}`,
      );
    }
  }
}

const allPaths = walk(root);
for (const path of allPaths) {
  assert(!lstatSync(path).isSymbolicLink(), `release must not contain symlinks: ${relative(root, path)}`);
}

const markdownPaths = allPaths.filter(
  (path) => statSync(path).isFile() && extname(path).toLowerCase() === ".md",
);
for (const path of markdownPaths) {
  const markdown = readFileSync(path, "utf8");
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, "");
    if (!rawTarget || /^(?:https?:|mailto:|#)/.test(rawTarget)) continue;
    const target = resolve(dirname(path), decodeURIComponent(rawTarget.split("#", 1)[0]));
    assert(insideRoot(target, root), `Markdown link escapes release root in ${relative(root, path)}: ${rawTarget}`);
    assert(existsSync(target), `broken Markdown link in ${relative(root, path)}: ${rawTarget}`);
  }
}

const textExtensions = new Set([".json", ".md", ".mjs", ".py", ".yaml", ".yml", ".gitignore", ""]);
const secretPatterns = [
  [/(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/, "secret-looking sk- token"],
  [/gh[opusr]_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/Authorization:\s*Bearer\s+(?!\$\{(?:env:)?[A-Z][A-Z0-9_]*\})\S+/i, "literal Bearer credential"],
  [/(?:^|[\s"'`])\/Users\//m, "absolute macOS user path"],
  [/(?:^|[\s"'`])\/tmp\//m, "absolute temporary path"],
  [/C:\\Users\\/i, "absolute Windows user path"],
  [new RegExp(["sale" + "or", "me" + "mos-\\d+"].join("|"), "i"), "internal development or benchmark reference"],
];
for (const path of allPaths) {
  if (!statSync(path).isFile() || !textExtensions.has(extname(path))) continue;
  const text = readFileSync(path, "utf8");
  for (const [pattern, label] of secretPatterns) {
    assert(!pattern.test(text), `${label} found in ${relative(root, path)}`);
  }
}

const readme = readFileSync(join(root, "README.md"), "utf8");
assert(!/private during beta|private[- ]beta/i.test(readme), "README must not describe the release as private beta");
assert(!readme.includes("github.com/getdoable/doable-mcp"), "README must not depend on private MCP documentation");
for (const requiredSetup of [
  "codex mcp add doable",
  "claude mcp add doable",
  '"Authorization": "Bearer ${env:DOABLE_API_KEY}"',
]) {
  assert(readme.includes(requiredSetup), `README is missing public MCP setup: ${requiredSetup}`);
}

const forbiddenReleaseFiles = allPaths.filter((path) => {
  const name = path.split(sep).at(-1);
  return name === ".mcp.json" || name === ".app.json" || name === ".env";
});
assert(
  forbiddenReleaseFiles.length === 0,
  `forbidden integration files found: ${forbiddenReleaseFiles.map((path) => relative(root, path)).join(", ")}`,
);

// The helper is a deterministic local boundary. All remote work belongs to
// the separately configured Doable MCP connection.
const connectedHelperPath = join(root, "plugins", "doable-code-context", "scripts", "doable-code-context.mjs");
assert(existsSync(connectedHelperPath), "connected plugin is missing its deterministic helper");
const connectedHelper = readFileSync(connectedHelperPath, "utf8");
for (const remotePrimitive of [
  "DOABLE_API_KEY",
  "DOABLE_API_BASE_URL",
  "fetch(",
  "axios",
  "undici",
  "WebSocket",
  "/code-context/",
]) {
  assert(!connectedHelper.includes(remotePrimitive), `connected helper must not contain remote primitive ${remotePrimitive}`);
}
for (const localCommand of [
  "prepare-workspace",
  "build-workspace-profile",
  "record-workspace-sync",
  "record-round",
  "validate-submission",
  "build-submission",
  "record-submission",
  "record-finalize",
]) {
  assert(connectedHelper.includes(localCommand), `connected helper is missing local command ${localCommand}`);
}
for (const match of connectedHelper.matchAll(/from\s+["']([^"']+)["']/g)) {
  assert(match[1].startsWith("node:"), `connected helper imports a non-built-in dependency: ${match[1]}`);
}
const connectedSyntax = spawnSync(process.execPath, ["--check", connectedHelperPath], { encoding: "utf8" });
assert(connectedSyntax.status === 0, `connected helper syntax check failed: ${connectedSyntax.stderr.trim()}`);

if (failures.length > 0) {
  console.error(`Release verification failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

for (const plugin of plugins) {
  const pluginRoot = join(root, "plugins", plugin.name);
  const files = walk(pluginRoot).filter((path) => statSync(path).isFile()).sort();
  const digest = createHash("sha256");
  for (const path of files) {
    digest.update(relative(pluginRoot, path));
    digest.update("\0");
    digest.update(readFileSync(path));
    digest.update("\0");
  }
  console.log(`Verified ${plugin.name}@${plugin.version}: ${plugin.skillNames.length} Skill(s), ${plugin.network}`);
  console.log(`Digest: ${digest.digest("hex")}`);
}
console.log("Hosts: Codex, Claude Code, Cursor");
