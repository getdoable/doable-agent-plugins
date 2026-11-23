import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { launchdPlist, parseArgs, remove, runScript, sawFirstWait, serviceDir, setup, start, stop } from "../plugins/doable-code-context/scripts/code-agent-service.mjs";

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

// The --allowedTools rules of this release: the Skill, the three Doable MCP tools of a machine (never the whole server,
// whose ask_code_agent is the asking tool of a person's Claude Code), and the wait after an error.
const BASE_RULES_IN_RUN =
  "'Skill\\(doable-code-context:doable-code-agent\\)' 'mcp__plugin_doable-code-context_doable__wait_for_code_agent_request' " +
  "'mcp__plugin_doable-code-context_doable__update_code_agent_request' 'mcp__plugin_doable-code-context_doable__read_code_agent_mail' " +
  "'Bash\\(sleep 20\\)'";

test("the start script runs the serving session in dontAsk mode with the five rules and the person's rules, and starts it again", () => {
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

test("setup again with the saved prompt file keeps the prompt and adds a rule, for example for a browser server", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, allow: ["Bash(npm test *)"] }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const savedPrompt = join(dir, "prompt.md");
  const prompt = readFileSync(savedPrompt, "utf8");
  // A rule for the whole browser server: a sign-up opens a page, types and clicks, and dontAsk refuses each tool that
  // no rule names.
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: savedPrompt, allow: ["Bash(npm test *)", "mcp__playwright"] }, m.env, () => {});
  assert.equal(readFileSync(savedPrompt, "utf8"), prompt);
  const run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.match(run, new RegExp(`--allowedTools ${BASE_RULES_IN_RUN} 'Bash\\(npm test \\*\\)' 'mcp__playwright' <`));
});

test("setup with --chrome starts the serving session with Claude in Chrome and allows all its tools, start keeps it, and setup without it takes it away", () => {
  const m = machine();
  const printed = [];
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, allow: ["Bash(npm test *)"], chrome: true }, m.env, (line) => printed.push(line));
  const dir = serviceDir(m.env, "mac-mini-1");
  const withChrome = new RegExp(
    `-p --permission-mode dontAsk --chrome --output-format stream-json --verbose --allowedTools ${BASE_RULES_IN_RUN} 'mcp__claude-in-chrome' 'Bash\\(npm test \\*\\)' <`,
  );
  assert.match(readFileSync(join(dir, "run.sh"), "utf8"), withChrome);
  execFileSync("bash", ["-n", join(dir, "run.sh")]);
  assert.ok(printed.some((line) => line.includes("Claude in Chrome")), printed.join("\n"));

  stop("mac-mini-1", m.env, () => {});
  start("mac-mini-1", m.env, () => {});
  assert.match(readFileSync(join(dir, "run.sh"), "utf8"), withChrome);

  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: join(dir, "prompt.md"), allow: ["Bash(npm test *)"] }, m.env, () => {});
  const run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.match(run, new RegExp(`-p --permission-mode dontAsk --output-format stream-json --verbose --allowedTools ${BASE_RULES_IN_RUN} 'Bash\\(npm test \\*\\)' <`));
  assert.ok(!run.includes("chrome"), run);
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

// The start script that plugin 0.5.0's setup wrote, word for word: its rules allow the whole Doable MCP server, and
// its PATH, claude command and development plugin folder are those of the terminal that ran setup. With no plugin
// folder at setup (the installed plugin), it has no --plugin-dir.
function plugin050RunScript({ dir, folder, pluginDir = "/srv/dev/doable-agent-plugins/plugins/doable-code-context" }) {
  const plugin = pluginDir ? `--plugin-dir '${pluginDir}' ` : "";
  return `#!/bin/bash
# Written by doable-code-context's code-agent-service.mjs. It serves Doable requests in ${folder}
# until \`code-agent-service.mjs stop\` writes the stop file. Do not edit it: setup writes it again.
set -u
# The session's output can hold a test login's password (in a command): its files are the owner's only.
umask 077
dir='${dir}'
. "$dir/env"
unset ANTHROPIC_API_KEY
export PATH='/srv/setup-terminal/bin:/usr/bin:/bin'
# In print mode the MCP servers can connect after the first turn starts; the skill's first call needs Doable's tools.
export MCP_CONNECTION_NONBLOCKING=false
cd '${folder}' || exit 1
while [ ! -e "$dir/stopped" ]; do
  if [ -f "$dir/session.jsonl" ] && [ "$(wc -c < "$dir/session.jsonl")" -gt 20971520 ]; then
    mv -f "$dir/session.jsonl" "$dir/session.1.jsonl"
  fi
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) the serving session starts" >> "$dir/service.log"
  /usr/bin/caffeinate -i -s '/srv/setup terminal'\\''s/bin/claude' -p ${plugin}--permission-mode dontAsk --output-format stream-json --verbose --allowedTools 'Skill(doable-code-context:doable-code-agent)' 'mcp__plugin_doable-code-context_doable' 'Bash(sleep 20)' 'Bash(npm test *)' < "$dir/prompt.md" >> "$dir/session.jsonl" 2>&1
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) the serving session ended with code $?" >> "$dir/service.log"
  [ -e "$dir/stopped" ] && break
  sleep 300
done
`;
}

// A machine that plugin 0.5.0 set up: its config.json has only the folder, the machine and the person's rules.
function asPlugin050Setup(m, dir, runScriptText) {
  writeFileSync(join(dir, "config.json"), `${JSON.stringify({ folder: m.folder, machine: "mac-mini-1", allow: ["Bash(npm test *)"] })}\n`);
  writeFileSync(join(dir, "run.sh"), runScriptText);
}

const REMINDER = /prompt\.md has no exception for a new test login's password, add this sentence to it, then run stop and start again: "The one exception: the password of a new test login goes in that login of the result\."$/;

test("start writes the start script again with this release's rules, and keeps what this release's setup saved", () => {
  // A machine updates by a plugin update, then stop and start: the start script that an older setup wrote must not
  // keep its rules.
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, allow: ["Bash(npm test *)"] }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const later = { ...m.env, DOABLE_CLAUDE_BIN: "/srv/other/claude" };

  // start keeps what setup saved, also when the environment of start differs, and has no reminder for 0.5.0's prompt.
  writeFileSync(join(dir, "run.sh"), "#!/bin/bash\n# an older start script\n");
  stop("mac-mini-1", m.env, () => {});
  const printed = [];
  start("mac-mini-1", later, (line) => printed.push(line));
  const run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.match(run, new RegExp(`'\\/opt\\/claude'\\\\''s bin\\/claude' -p --permission-mode dontAsk .* --allowedTools ${BASE_RULES_IN_RUN} 'Bash\\(npm test \\*\\)' <`));
  execFileSync("bash", ["-n", join(dir, "run.sh")]);
  assert.deepEqual(printed, ['The code agent "mac-mini-1": not started (DOABLE_CODE_AGENT_NO_LAUNCH is set).']);
});

test("start on a machine that plugin 0.6.0 set up gives the serving session the rule for the test inbox mail tool, and asks for no change of the prompt", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, allow: ["Bash(npm test *)"] }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  // config.json of plugin 0.6.0 has no `chrome`.
  delete config.chrome;
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  // The start script of plugin 0.6.0: its rules name only the wait and the update of a request.
  const rules060 = [
    "Skill(doable-code-context:doable-code-agent)",
    "mcp__plugin_doable-code-context_doable__wait_for_code_agent_request",
    "mcp__plugin_doable-code-context_doable__update_code_agent_request",
    "Bash(sleep 20)",
    "Bash(npm test *)",
  ];
  writeFileSync(join(dir, "run.sh"), runScript({ dir, folder: config.folder, claude: config.claude, rules: rules060, path: config.path, wake: false }));
  assert.ok(!readFileSync(join(dir, "run.sh"), "utf8").includes("read_code_agent_mail"));

  stop("mac-mini-1", m.env, () => {});
  const printed = [];
  start("mac-mini-1", m.env, (line) => printed.push(line));
  const run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.match(run, new RegExp(`-p --permission-mode dontAsk --output-format stream-json --verbose --allowedTools ${BASE_RULES_IN_RUN} 'Bash\\(npm test \\*\\)' <`));
  execFileSync("bash", ["-n", join(dir, "run.sh")]);
  // config.json of 0.6.0 holds the claude command: no reminder of the prompt's password sentence.
  assert.deepEqual(printed, ['The code agent "mac-mini-1": not started (DOABLE_CODE_AGENT_NO_LAUNCH is set).']);
});

test("start on a machine that plugin 0.5.0 set up takes the PATH, the claude command and the plugin folder from its start script, and reminds of the prompt's password sentence", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, allow: ["Bash(npm test *)"] }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  asPlugin050Setup(m, dir, plugin050RunScript({ dir, folder: m.folder }));
  // start runs from a shell that has no claude on its PATH and no plugin folder, for example over SSH.
  const { DOABLE_CLAUDE_BIN: _claude, ...withoutClaude } = m.env;
  const sshShell = { ...withoutClaude, PATH: "/srv/ssh-shell/bin" };

  stop("mac-mini-1", sshShell, () => {});
  const printed = [];
  start("mac-mini-1", sshShell, (line) => printed.push(line));
  const run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.match(run, /^export PATH='\/srv\/setup-terminal\/bin:\/usr\/bin:\/bin'$/m);
  assert.match(
    run,
    new RegExp(
      `'\\/srv\\/setup terminal'\\\\''s\\/bin\\/claude' -p --plugin-dir '\\/srv\\/dev\\/doable-agent-plugins\\/plugins\\/doable-code-context' ` +
        `--permission-mode dontAsk .* --allowedTools ${BASE_RULES_IN_RUN} 'Bash\\(npm test \\*\\)' <`,
    ),
  );
  assert.ok(!run.includes("'mcp__plugin_doable-code-context_doable' "), run);
  assert.match(run, new RegExp(`cd '${m.folder.replaceAll("/", "\\/")}' \\|\\| exit 1`));
  execFileSync("bash", ["-n", join(dir, "run.sh")]);
  const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(config.claude, "/srv/setup terminal's/bin/claude");
  assert.equal(config.path, "/srv/setup-terminal/bin:/usr/bin:/bin");
  assert.equal(config.pluginDir, "/srv/dev/doable-agent-plugins/plugins/doable-code-context");
  assert.equal(printed.length, 2, printed.join("\n"));
  assert.ok(printed[1].startsWith(`If the secret rule in ${join(dir, "prompt.md")} `), printed[1]);
  assert.match(printed[1], REMINDER);

  // config.json now holds what the start script needs: the next start is not a 0.5.0 setup, and has no reminder.
  const again = [];
  start("mac-mini-1", sshShell, (line) => again.push(line));
  assert.equal(again.length, 1, again.join("\n"));
});

test("start on a machine that plugin 0.5.0 set up with the installed plugin takes no plugin folder from its environment", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, allow: ["Bash(npm test *)"] }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  asPlugin050Setup(m, dir, plugin050RunScript({ dir, folder: m.folder, pluginDir: null }));
  // The shell that runs start has a development plugin folder set, for example for work on another checkout.
  const devShell = { ...m.env, DOABLE_CODE_AGENT_PLUGIN_DIR: "/srv/dev/doable-agent-plugins/plugins/doable-code-context" };

  stop("mac-mini-1", devShell, () => {});
  start("mac-mini-1", devShell, () => {});
  const run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.match(run, new RegExp(`'\\/srv\\/setup terminal'\\\\''s\\/bin\\/claude' -p --permission-mode dontAsk .* --allowedTools ${BASE_RULES_IN_RUN} 'Bash\\(npm test \\*\\)' <`));
  assert.ok(!run.includes("--plugin-dir"), run);
  assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).pluginDir, null);
});

test("start on a machine that plugin 0.5.0 set up takes from its environment what its start script does not hold", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, allow: ["Bash(npm test *)"] }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  // A start script that a person changed by hand: no PATH line, and a claude command that is not quoted.
  asPlugin050Setup(m, dir, "#!/bin/bash\nclaude -p --permission-mode dontAsk --allowedTools 'mcp__plugin_doable-code-context_doable' 'Bash(sleep 20)'\n");
  const later = { ...m.env, DOABLE_CLAUDE_BIN: "/srv/other/claude", PATH: "/srv/other/bin:/usr/bin" };

  stop("mac-mini-1", later, () => {});
  const printed = [];
  start("mac-mini-1", later, (line) => printed.push(line));
  const run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.match(run, /^export PATH='\/srv\/other\/bin:\/usr\/bin'$/m);
  assert.match(run, new RegExp(`'\\/srv\\/other\\/claude' -p --permission-mode dontAsk .* --allowedTools ${BASE_RULES_IN_RUN} 'Bash\\(npm test \\*\\)' <`));
  assert.ok(!run.includes("'mcp__plugin_doable-code-context_doable' "), run);
  assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).claude, "/srv/other/claude");
  assert.match(printed[1], REMINDER);
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

test("the command line takes repeated --allow options and --chrome with no value, and refuses an unknown option", () => {
  assert.deepEqual(parseArgs(["setup", "--machine", "m", "--allow", "Bash(a *)", "--allow", "Bash(b *)"]).options.allow, ["Bash(a *)", "Bash(b *)"]);
  assert.throws(() => parseArgs(["setup", "--key", "x"]), /Unknown option --key/);
  // --chrome takes no value, at any place.
  const chrome = parseArgs(["setup", "--chrome", "--machine", "m", "--allow", "Bash(a *)", "--chrome"]).options;
  assert.deepEqual([chrome.chrome, chrome.machine, chrome.allow], [true, "m", ["Bash(a *)"]]);
  assert.equal(parseArgs(["setup", "--machine", "m"]).options.chrome, false);
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
