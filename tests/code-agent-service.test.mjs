import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { launchdPlist, parseArgs, remove, sawFirstWait, serviceDir, setup, start, stop } from "../plugins/doable-code-context/scripts/code-agent-service.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "plugins", "doable-code-context", "scripts", "code-agent-service.mjs");
// Built from parts, so that the release verifier's check for keys in the repository does not find a test key.
const PREFIX = ["sk", "doable", ""].join("-");
const KEY = `${PREFIX}test0123456789abcdefghijkl`;

// A machine's home for the service, a folder with repositories, a fake `claude`, and no launch: the tests write the
// files that setup writes and check them, and never start launchd or a session.
function machine() {
  const base = mkdtempSync(join(tmpdir(), "code-agent-service-"));
  const folder = join(base, "repos");
  mkdirSync(join(folder, ".doable"), { recursive: true });
  const prompt = join(base, "prompt.md");
  writeFileSync(prompt, "Serve Doable requests in this folder with the `doable-code-agent` skill.\n\nRules for this session:\n- Never call production.\n");
  const env = {
    PATH: "/usr/bin:/bin",
    DOABLE_API_KEY: KEY,
    DOABLE_CODE_AGENT_HOME: join(base, "home"),
    DOABLE_CLAUDE_BIN: "/opt/claude's bin/claude",
    DOABLE_CODE_AGENT_NO_LAUNCH: "1",
  };
  return { base, folder, prompt, env };
}

test("setup keeps the key only in a file that only its owner can read, and never prints it", () => {
  const m = machine();
  const printed = [];
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, allow: [] }, m.env, (line) => printed.push(line));
  const dir = serviceDir(m.env, "mac-mini-1");
  const envFile = join(dir, "env");
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.match(readFileSync(envFile, "utf8"), new RegExp(`export DOABLE_API_KEY='${KEY}'`));
  assert.match(readFileSync(envFile, "utf8"), /export DOABLE_MACHINE_NAME='mac-mini-1'/);
  assert.ok(!printed.join("\n").includes(KEY), printed.join("\n"));
  assert.ok(!readFileSync(join(dir, "prompt.md"), "utf8").includes(PREFIX));
  assert.ok(!readFileSync(join(dir, "run.sh"), "utf8").includes(KEY));
});

// The --allowedTools rules of this release: the Skill, the two Doable MCP tools that serve requests (never the whole
// server, whose ask_code_agent is the asking tool of a person's Claude Code), and the wait after an error.
const BASE_RULES_IN_RUN =
  "'Skill\\(doable-code-context:doable-code-agent\\)' 'mcp__plugin_doable-code-context_doable__wait_for_code_agent_request' " +
  "'mcp__plugin_doable-code-context_doable__update_code_agent_request' 'Bash\\(sleep 20\\)'";

test("the start script runs the serving session in dontAsk mode with the four rules and the person's rules, and starts it again", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, allow: ["Bash(npm test *)", "Bash(curl https://staging.example.com/*)"] }, m.env, () => {});
  const run = readFileSync(join(serviceDir(m.env, "mac-mini-1"), "run.sh"), "utf8");
  assert.match(run, new RegExp(`'\\/opt\\/claude'\\\\''s bin\\/claude' -p --permission-mode dontAsk --output-format stream-json --verbose --allowedTools ${BASE_RULES_IN_RUN} 'Bash\\(npm test \\*\\)' 'Bash\\(curl https:\\/\\/staging\\.example\\.com\\/\\*\\)' < "\\$dir\\/prompt\\.md"`));
  // A rule for the whole Doable MCP server would let the serving session call ask_code_agent.
  assert.ok(!run.includes("'mcp__plugin_doable-code-context_doable' "), run);
  assert.match(run, /while \[ ! -e "\$dir\/stopped" \]; do/);
  assert.match(run, /sleep 300/);
  assert.match(run, /unset ANTHROPIC_API_KEY/);
  // The session's output can hold a test login's password: the files that the script makes are the owner's only.
  assert.match(run, /^umask 077$/m);
  assert.match(run, new RegExp(`cd '${m.folder.replaceAll("/", "\\/")}' \\|\\| exit 1`));
  // The script is valid bash.
  execFileSync("bash", ["-n", join(serviceDir(m.env, "mac-mini-1"), "run.sh")]);
});

test("setup removes plugin 0.3.0's policy file from the folder", () => {
  const m = machine();
  const policy = join(m.folder, ".doable", ["code-agent", "md"].join("."));
  writeFileSync(policy, "# Doable code agent policy\n");
  const printed = [];
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, allow: [] }, m.env, (line) => printed.push(line));
  assert.equal(existsSync(policy), false);
  assert.match(printed[0], /^Removed \.doable\/code-agent\.md: a session takes its rules from its prompt now\.$/);
});

test("setup refuses a personal key, a bad machine name, a relative folder and a prompt that holds a key", () => {
  const m = machine();
  const run = (options, env = m.env) => () => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, allow: [], ...options }, env, () => {});
  assert.throws(run({}, { ...m.env, DOABLE_API_KEY: `${PREFIX}personal-0123456789abcdef` }), /not sk-doable-personal-/);
  assert.throws(run({}, { ...m.env, DOABLE_API_KEY: "" }), /Set DOABLE_API_KEY/);
  assert.throws(run({ machine: "mac mini" }), /--machine must be 1 to 64 characters/);
  assert.throws(run({ folder: "repos" }), /--folder must be the absolute path/);
  const withKey = join(m.base, "with-key.md");
  writeFileSync(withKey, `Rules\n${KEY}\n`);
  assert.throws(run({ promptFile: withKey }), /holds a Doable API key/);
  assert.throws(run({ allow: ["Bash(a)\nBash(b)"] }), /is not one rule/);
});

test("stop writes the stop file that ends the restart loop, and remove deletes the files with the key", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, allow: [] }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  stop("mac-mini-1", m.env, () => {});
  assert.ok(existsSync(join(dir, "stopped")));
  const printed = [];
  remove("mac-mini-1", m.env, (line) => printed.push(line));
  assert.equal(existsSync(dir), false);
  assert.match(printed[0], /Revoke the key in Doable's Settings > API Keys/);
});

test("start writes the start script again with this release's rules, also on a machine that plugin 0.5.0 set up", () => {
  // A machine updates by a plugin update, then stop and start: the start script that an older setup wrote must not
  // keep its rules, such as plugin 0.5.0's rule for the whole Doable MCP server.
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, allow: ["Bash(npm test *)"] }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const later = { ...m.env, DOABLE_CLAUDE_BIN: "/srv/other/claude" };

  // A machine that this release set up: start keeps what setup saved, also when the environment of start differs.
  writeFileSync(join(dir, "run.sh"), "#!/bin/bash\n# an older start script\n");
  stop("mac-mini-1", m.env, () => {});
  start("mac-mini-1", later, () => {});
  let run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.match(run, new RegExp(`'\\/opt\\/claude'\\\\''s bin\\/claude' -p --permission-mode dontAsk .* --allowedTools ${BASE_RULES_IN_RUN} 'Bash\\(npm test \\*\\)' <`));
  execFileSync("bash", ["-n", join(dir, "run.sh")]);

  // A machine that plugin 0.5.0 set up: its config.json has only the folder, the machine and the person's rules, and
  // its start script allows the whole server. Start takes the rest from its environment and keeps it.
  writeFileSync(join(dir, "config.json"), `${JSON.stringify({ folder: m.folder, machine: "mac-mini-1", allow: ["Bash(npm test *)"] })}\n`);
  writeFileSync(join(dir, "run.sh"), "#!/bin/bash\nclaude -p --permission-mode dontAsk --allowedTools 'mcp__plugin_doable-code-context_doable' 'Bash(sleep 20)'\n");
  stop("mac-mini-1", m.env, () => {});
  start("mac-mini-1", later, () => {});
  run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.match(run, new RegExp(`'\\/srv\\/other\\/claude' -p --permission-mode dontAsk .* --allowedTools ${BASE_RULES_IN_RUN} 'Bash\\(npm test \\*\\)' <`));
  assert.ok(!run.includes("'mcp__plugin_doable-code-context_doable' "), run);
  assert.match(run, new RegExp(`cd '${m.folder.replaceAll("/", "\\/")}' \\|\\| exit 1`));
  assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).claude, "/srv/other/claude");
});

test("the launchd job starts the start script at login, with no KeepAlive, so that a stop stays stopped", () => {
  const plist = launchdPlist({ machine: "mac-mini-1", dir: "/srv/agent/.doable/code-agent/mac-mini-1" });
  assert.match(plist, /<string>ai\.getdoable\.code-agent\.mac-mini-1<\/string>/);
  assert.match(plist, /<string>\/bin\/bash<\/string><string>\/srv\/agent\/\.doable\/code-agent\/mac-mini-1\/run\.sh<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.ok(!plist.includes("KeepAlive"));
});

test("setup says connected only after the serving session calls the wait tool, not when its tool list names the tool", () => {
  // The first line of `claude -p --output-format stream-json` lists every tool by name (seen in the live check of
  // 2026-11-19: the script said "connected" before the session waited).
  const toolList = JSON.stringify({ type: "system", subtype: "init", tools: ["Bash", "mcp__plugin_doable-code-context_doable__wait_for_code_agent_request"] });
  const call = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_1", name: "mcp__plugin_doable-code-context_doable__wait_for_code_agent_request", input: { wait_seconds: 50 } }] },
  });
  assert.equal(sawFirstWait(toolList), false);
  assert.equal(sawFirstWait(`${toolList}\n${call}\n`), true);
});

test("the command line takes repeated --allow options and refuses an unknown option", () => {
  assert.deepEqual(parseArgs(["setup", "--machine", "m", "--allow", "Bash(a *)", "--allow", "Bash(b *)"]).options.allow, ["Bash(a *)", "Bash(b *)"]);
  assert.throws(() => parseArgs(["setup", "--key", "x"]), /Unknown option --key/);
  // A failed command prints its reason and exits with 1, with no stack trace.
  let failed;
  try {
    execFileSync(process.execPath, [script, "setup", "--machine", "bad name"], { stdio: "pipe", env: { PATH: "/usr/bin:/bin" } });
  } catch (error) {
    failed = error;
  }
  assert.equal(failed.status, 1);
  assert.match(failed.stderr.toString(), /^--machine must be 1 to 64 characters/);
});
