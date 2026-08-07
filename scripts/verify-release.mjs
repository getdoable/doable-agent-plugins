import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(root, "plugins", "doable-trd-context");
const skillRoot = join(pluginRoot, "skills", "doable-trd-intake");
const failures = [];

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

const required = [
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/marketplace.json",
  "plugins/doable-trd-context/.codex-plugin/plugin.json",
  "plugins/doable-trd-context/.claude-plugin/plugin.json",
  "plugins/doable-trd-context/.cursor-plugin/plugin.json",
  "plugins/doable-trd-context/assets/logo.png",
  "plugins/doable-trd-context/skills/doable-trd-intake/SKILL.md",
  "plugins/doable-trd-context/skills/doable-trd-intake/agents/openai.yaml",
  "plugins/doable-trd-context/skills/doable-trd-intake/assets/doable-intake.schema.json",
  "plugins/doable-trd-context/skills/doable-trd-intake/references/intake-field-guide.md",
  "plugins/doable-trd-context/skills/doable-trd-intake/references/multi-repo-and-seams.md",
  "plugins/doable-trd-context/skills/doable-trd-intake/references/privacy-and-approval.md",
  "plugins/doable-trd-context/skills/doable-trd-intake/scripts/validate-and-render.mjs",
  "LICENSE",
  "PRIVACY.md",
  "README.md",
  "SECURITY.md"
];

for (const path of required) {
  assert(existsSync(join(root, path)), `missing required file: ${path}`);
}

const packageJson = readJson(join(root, "package.json"));
const codexPlugin = readJson(join(pluginRoot, ".codex-plugin", "plugin.json"));
const claudePlugin = readJson(join(pluginRoot, ".claude-plugin", "plugin.json"));
const cursorPlugin = readJson(join(pluginRoot, ".cursor-plugin", "plugin.json"));
const codexMarketplace = readJson(join(root, ".agents", "plugins", "marketplace.json"));
const claudeMarketplace = readJson(join(root, ".claude-plugin", "marketplace.json"));
const cursorMarketplace = readJson(join(root, ".cursor-plugin", "marketplace.json"));
readJson(join(skillRoot, "assets", "doable-intake.schema.json"));

const pluginName = "doable-trd-context";
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

for (const [host, manifest] of [
  ["Codex", codexPlugin],
  ["Claude Code", claudePlugin],
  ["Cursor", cursorPlugin]
]) {
  assert(manifest.name === pluginName, `${host} plugin name must be ${pluginName}`);
  for (const forbidden of ["mcpServers", "apps", "hooks"]) {
    assert(!(forbidden in manifest), `${host} plugin must not declare ${forbidden}`);
  }
}

assert(semver.test(codexPlugin.version ?? ""), "Codex version must be strict semver");
assert(semver.test(cursorPlugin.version ?? ""), "Cursor version must be strict semver");
assert(codexPlugin.version === cursorPlugin.version, "Codex and Cursor versions must match");
assert(packageJson.version === codexPlugin.version, "package and plugin versions must match");
assert(!("version" in claudePlugin), "Claude plugin version must be omitted during beta to use the Git commit SHA");
assert(codexPlugin.skills === "./skills/", "Codex skills path must be ./skills/");
assert(cursorPlugin.skills === "./skills/", "Cursor skills path must be ./skills/");
assert(codexPlugin.license === "MIT" && cursorPlugin.license === "MIT", "public manifests must use the root MIT license");
assert(codexPlugin.author?.name === "Doable AI", "Codex publisher name must be Doable AI");
assert(codexPlugin.interface?.privacyPolicyURL === "https://qa.getdoable.ai/privacy-policy", "Codex privacy URL must use the QA policy");
assert(Array.isArray(codexPlugin.interface?.defaultPrompt) && codexPlugin.interface.defaultPrompt.length <= 3, "Codex must have at most three starter prompts");

const codexEntry = codexMarketplace.plugins?.find((entry) => entry.name === pluginName);
const claudeEntry = claudeMarketplace.plugins?.find((entry) => entry.name === pluginName);
const cursorEntry = cursorMarketplace.plugins?.find((entry) => entry.name === pluginName);
assert(codexMarketplace.name === "getdoable", "Codex marketplace name must remain getdoable");
assert(codexEntry?.source?.path === "./plugins/doable-trd-context", "Codex marketplace source is incorrect");
assert(codexEntry?.policy?.installation === "AVAILABLE", "Codex plugin must be available, not forced");
assert(codexEntry?.policy?.authentication === "ON_USE", "Codex authentication policy must be ON_USE");
assert(JSON.stringify(codexEntry?.policy?.products) === JSON.stringify(["CODEX"]), "Codex plugin must be gated to CODEX");
assert(claudeMarketplace.name === "doable", "Claude marketplace name must remain doable");
assert(claudeEntry?.source === "./plugins/doable-trd-context", "Claude marketplace source is incorrect");
assert(cursorEntry?.source === "./plugins/doable-trd-context", "Cursor marketplace source is incorrect");

const allPaths = walk(root);
for (const path of allPaths) {
  assert(!lstatSync(path).isSymbolicLink(), `release must not contain symlinks: ${relative(root, path)}`);
}

const skillManifests = allPaths.filter((path) => statSync(path).isFile() && path.endsWith(`${sep}SKILL.md`));
assert(skillManifests.length === 1, `release must contain exactly one Skill; found ${skillManifests.length}`);

const skillText = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
const frontmatter = skillText.match(/^---\n([\s\S]*?)\n---/);
assert(frontmatter, "SKILL.md must contain YAML frontmatter");
assert(/^name:\s*doable-trd-intake\s*$/m.test(frontmatter?.[1] ?? ""), "Skill name must remain doable-trd-intake");
const description = (frontmatter?.[1] ?? "").match(/^description:\s*(.+)$/m)?.[1] ?? "";
assert(description.length > 0 && description.length <= 1024, "Skill description must be 1-1024 characters");

const markdownPaths = allPaths.filter((path) => statSync(path).isFile() && extname(path).toLowerCase() === ".md");
for (const path of markdownPaths) {
  const text = readFileSync(path, "utf8");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, "");
    if (!rawTarget || /^(?:https?:|mailto:|#)/.test(rawTarget)) continue;
    const target = resolve(dirname(path), decodeURIComponent(rawTarget.split("#", 1)[0]));
    assert(insideRoot(target, root), `Markdown link escapes release root in ${relative(root, path)}: ${rawTarget}`);
    assert(existsSync(target), `broken Markdown link in ${relative(root, path)}: ${rawTarget}`);
  }
}

const textExtensions = new Set([".json", ".md", ".mjs", ".yaml", ".yml", ".gitignore", ""]);
const secretPatterns = [
  [/(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/, "secret-looking sk- token"],
  [/gh[opusr]_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/Authorization:\s*Bearer\s+\S+/i, "Bearer credential"],
  [/(?:^|[\s"'`])\/Users\//m, "absolute macOS user path"],
  [/(?:^|[\s"'`])\/tmp\//m, "absolute temporary path"],
  [/C:\\Users\\/i, "absolute Windows user path"],
  [new RegExp(["doable-trd-intake-" + "mcp", "sale" + "or", "me" + "mos-\\d+"].join("|"), "i"), "internal development or benchmark reference"]
];

for (const path of allPaths) {
  if (!statSync(path).isFile() || !textExtensions.has(extname(path))) continue;
  const text = readFileSync(path, "utf8");
  for (const [pattern, label] of secretPatterns) {
    assert(!pattern.test(text), `${label} found in ${relative(root, path)}`);
  }
}

const forbiddenReleaseFiles = allPaths.filter((path) => {
  const name = path.split(sep).at(-1);
  return name === ".mcp.json" || name === ".app.json" || name === ".env";
});
assert(forbiddenReleaseFiles.length === 0, `forbidden integration files found: ${forbiddenReleaseFiles.map((path) => relative(root, path)).join(", ")}`);

const rendererPath = join(skillRoot, "scripts", "validate-and-render.mjs");
const rendererText = readFileSync(rendererPath, "utf8");
for (const [pattern, label] of [
  [/\bfetch\s*\(/, "fetch"],
  [/\bhttps?\.request\s*\(/, "HTTP request"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\b(?:axios|undici)\b/, "network package"],
  [/\bcurl\b/, "curl"]
]) {
  assert(!pattern.test(rendererText), `renderer must remain network-free; found ${label}`);
}
for (const match of rendererText.matchAll(/from\s+["']([^"']+)["']/g)) {
  assert(match[1].startsWith("node:"), `renderer imports a non-built-in dependency: ${match[1]}`);
}

const syntax = spawnSync(process.execPath, ["--check", rendererPath], { encoding: "utf8" });
assert(syntax.status === 0, `renderer syntax check failed: ${syntax.stderr.trim()}`);

const logo = readFileSync(join(pluginRoot, "assets", "logo.png"));
assert(logo.subarray(1, 4).toString("ascii") === "PNG", "logo must be a PNG");
const width = logo.readUInt32BE(16);
const height = logo.readUInt32BE(20);
assert(width === height && width >= 48 && width <= 4096, `logo must be square and 48-4096 px; got ${width}x${height}`);
assert(logo.length <= 5 * 1024 * 1024, "logo must be at most 5 MiB");

const skillFiles = walk(skillRoot).filter((path) => statSync(path).isFile()).sort();
const digest = createHash("sha256");
for (const path of skillFiles) {
  digest.update(relative(skillRoot, path));
  digest.update("\0");
  digest.update(readFileSync(path));
  digest.update("\0");
}

if (failures.length > 0) {
  console.error(`Release verification failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Release verification passed: ${pluginName}@${codexPlugin.version}`);
console.log(`Skill files: ${skillFiles.length}`);
console.log(`Skill digest: ${digest.digest("hex")}`);
console.log("Hosts: Codex, Claude Code, Cursor");
console.log("Network/MCP integrations: none");
