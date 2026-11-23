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
  writeFileSync(prompt, "Serve Doable requests in this folder with the `doable-code-agent` skill.\n\nRules for this session:\n- Never write to production.\n");
  const env = {
    PATH: "/usr/bin:/bin",
    DOABLE_API_KEY: KEY,
    DOABLE_CODE_AGENT_HOME: join(base, "home"),
    DOABLE_CLAUDE_BIN: "/opt/claude's bin/claude",
    DOABLE_CODE_AGENT_NO_LAUNCH: "1",
  };
  return { base, folder, prompt, env };
}

// The rest of the serving session's command line in this release, after the claude command and the plugin folder:
// the bypass permission mode (no permission check), Claude in Chrome, and no ask_code_agent (with which a person's
// Claude Code asks a machine, so the session could send a request to itself) under the plugin's server name and under
// `doable`, the name of a user-scoped or project-scoped Doable MCP server. No --allowedTools.
const SESSION_FLAGS =
  "--permission-mode bypassPermissions --chrome " +
  "--disallowedTools 'mcp__plugin_doable-code-context_doable__ask_code_agent' 'mcp__doable__ask_code_agent' " +
  "--output-format stream-json --verbose < \"\\$dir\\/prompt\\.md\" >> \"\\$dir\\/session\\.jsonl\" 2>&1$";

// The session's command line of a start script that this release wrote, with this claude command (a regex of it, as
// shellQuote writes it) and no plugin folder.
function sessionLine(claudeQuoted) {
  return new RegExp(`^  (?:\\/usr\\/bin\\/caffeinate -i -s )?${claudeQuoted} -p ${SESSION_FLAGS}`, "m");
}

const SETUP_CLAUDE = "'\\/opt\\/claude'\\\\''s bin\\/claude'";
const NOT_STARTED = 'The code agent "mac-mini-1": not started (DOABLE_CODE_AGENT_NO_LAUNCH is set).';
const CHROME_NOTE =
  "It uses Claude in Chrome: keep Chrome open on this machine with the Claude in Chrome extension connected, and let the extension act on the test sites without asking.";

// Nothing of an allow list or of plugin 0.6.0's permission mode is left in a start script of this release.
function assertNoAllowRules(run) {
  for (const old of ["--allowedTools", "dontAsk", "Bash(", "Skill(", "mcp__claude-in-chrome"]) {
    assert.ok(!run.includes(old), `${old} in the start script:\n${run}`);
  }
}

test("setup keeps the key only in a file that only its owner can read, and never prints it", () => {
  const m = machine();
  const printed = [];
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, (line) => printed.push(line));
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

test("the start script runs the serving session with no permission check, with Claude in Chrome and without ask_code_agent under either server name, and starts it again", () => {
  const m = machine();
  const printed = [];
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, (line) => printed.push(line));
  const dir = serviceDir(m.env, "mac-mini-1");
  const run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.match(run, sessionLine(SETUP_CLAUDE));
  assertNoAllowRules(run);
  assert.match(run, /while \[ ! -e "\$dir\/stopped" \]; do/);
  assert.match(run, /sleep 300/);
  assert.match(run, /unset ANTHROPIC_API_KEY/);
  assert.match(run, /^export MCP_CONNECTION_NONBLOCKING=false$/m);
  // The session's output can hold a test login's password: the files that the script makes are the owner's only.
  assert.match(run, /^umask 077$/m);
  assert.match(run, new RegExp(`cd '${m.folder.replaceAll("/", "\\/")}' \\|\\| exit 1`));
  // The script is valid bash.
  execFileSync("bash", ["-n", join(dir, "run.sh")]);
  // config.json keeps no allow list and no Chrome switch: every session allows every tool and has Chrome.
  const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.deepEqual(Object.keys(config).sort(), ["claude", "folder", "machine", "path", "pluginDir", "wake"]);
  // Nobody answers the extension's prompt, and nothing but the rules keeps the session from production: setup says so.
  assert.ok(printed.includes(CHROME_NOTE), printed.join("\n"));
  assert.ok(printed.some((line) => line.startsWith("It runs in the bypass permission mode: ")), printed.join("\n"));
});

test("the serving session's claude gets each name of ask_code_agent as its own word after --disallowedTools, and an option after them", () => {
  // --disallowedTools takes each word after it as a tool name: a name that the shell joins to another, or a prompt
  // word after the names, would not remove the tool. A fake claude writes the words it gets, one per line, and stops
  // the loop.
  const m = machine();
  const dir = join(m.base, "agent");
  mkdirSync(dir);
  writeFileSync(join(dir, "env"), "export DOABLE_MACHINE_NAME='mac-mini-1'\n");
  writeFileSync(join(dir, "prompt.md"), "Serve Doable requests.\n");
  const claude = join(m.base, "fake claude");
  writeFileSync(claude, `#!/bin/bash\nprintf '%s\\n' "$@" > '${join(dir, "argv")}'\ntouch '${join(dir, "stopped")}'\n`, { mode: 0o700 });
  writeFileSync(join(dir, "run.sh"), runScript({ dir, folder: m.folder, claude, path: "/usr/bin:/bin", wake: false }));
  execFileSync("/bin/bash", [join(dir, "run.sh")], { stdio: "pipe" });
  const words = readFileSync(join(dir, "argv"), "utf8").trim().split("\n");
  const at = words.indexOf("--disallowedTools");
  assert.deepEqual(words.slice(at + 1, at + 4), [
    "mcp__plugin_doable-code-context_doable__ask_code_agent",
    "mcp__doable__ask_code_agent",
    "--output-format",
  ]);
  assert.deepEqual(words.slice(0, 4), ["-p", "--permission-mode", "bypassPermissions", "--chrome"]);
});

test("a development plugin folder goes between the claude command and the permission mode", () => {
  const run = runScript({ dir: "/srv/agent", folder: "/srv/repos", claude: "/srv/bin/claude", path: "/usr/bin", wake: false, pluginDir: "/srv/dev/plugin" });
  assert.match(run, new RegExp(`^  '\\/srv\\/bin\\/claude' -p --plugin-dir '\\/srv\\/dev\\/plugin' ${SESSION_FLAGS}`, "m"));
});

test("setup again with the saved prompt file keeps the prompt", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const savedPrompt = join(dir, "prompt.md");
  const prompt = readFileSync(savedPrompt, "utf8");
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: savedPrompt }, m.env, () => {});
  assert.equal(readFileSync(savedPrompt, "utf8"), prompt);
  assert.match(readFileSync(join(dir, "run.sh"), "utf8"), sessionLine(SETUP_CLAUDE));
});

test("setup and start refuse --allow and --chrome: this release allows every tool and has Chrome on", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const before = readFileSync(join(dir, "run.sh"), "utf8");
  const run = (args) => {
    try {
      execFileSync(process.execPath, [script, ...args], { stdio: "pipe", env: m.env });
    } catch (error) {
      return error;
    }
    assert.fail(`${args.join(" ")} did not fail`);
  };
  for (const [args, option] of [
    [["setup", "--folder", m.folder, "--machine", "mac-mini-1", "--prompt-file", m.prompt, "--allow", "Bash(npm test *)"], "--allow"],
    [["setup", "--chrome", "--folder", m.folder, "--machine", "mac-mini-1", "--prompt-file", m.prompt], "--chrome"],
    [["start", "--machine", "mac-mini-1", "--chrome"], "--chrome"],
    [["start", "--allow", "Bash(npm test *)", "--machine", "mac-mini-1"], "--allow"],
  ]) {
    const failed = run(args);
    assert.equal(failed.status, 1, args.join(" "));
    assert.equal(failed.stderr.toString(), `${option} is not needed: this release allows every tool and has Chrome on.\n`);
  }
  // A refused command changes nothing.
  assert.equal(readFileSync(join(dir, "run.sh"), "utf8"), before);
  assert.throws(() => parseArgs(["setup", "--machine", "m", "--allow", "Bash(a *)"]), /^Error: --allow is not needed/);
  assert.throws(() => parseArgs(["setup", "--chrome"]), /^Error: --chrome is not needed/);
});

test("setup removes plugin 0.3.0's policy file from the folder", () => {
  const m = machine();
  const policy = join(m.folder, ".doable", ["code-agent", "md"].join("."));
  writeFileSync(policy, "# Doable code agent policy\n");
  const printed = [];
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, (line) => printed.push(line));
  assert.equal(existsSync(policy), false);
  assert.match(printed[0], /^Removed \.doable\/code-agent\.md: a session takes its rules from its prompt now\.$/);
});

test("setup refuses a personal key, a bad machine name, a relative folder and a prompt that holds a key", () => {
  const m = machine();
  const run = (options, env = m.env) => () => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, ...options }, env, () => {});
  assert.throws(run({}, { ...m.env, DOABLE_API_KEY: `${PREFIX}personal-0123456789abcdef` }), /not sk-doable-personal-/);
  assert.throws(run({}, { ...m.env, DOABLE_API_KEY: "" }), /Set DOABLE_API_KEY/);
  assert.throws(run({ machine: "mac mini" }), /--machine must be 1 to 64 characters/);
  assert.throws(run({ folder: "repos" }), /--folder must be the absolute path/);
  const withKey = join(m.base, "with-key.md");
  writeFileSync(withKey, `Rules\n${KEY}\n`);
  assert.throws(run({ promptFile: withKey }), /holds a Doable API key/);
});

test("stop writes the stop file that ends the restart loop, and remove deletes the files with the key", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  stop("mac-mini-1", m.env, () => {});
  assert.ok(existsSync(join(dir, "stopped")));
  const printed = [];
  remove("mac-mini-1", m.env, (line) => printed.push(line));
  assert.equal(existsSync(dir), false);
  assert.match(printed[0], /Revoke the key in Doable's Settings > API Keys/);
});

// A start script that plugin 0.5.0 or 0.6.0 wrote, word for word: the dontAsk mode with `rules` in --allowedTools, and
// the PATH, the claude command and the development plugin folder of the terminal that ran setup. With no plugin
// folder at setup (the installed plugin), it has no --plugin-dir.
function olderRunScript({ dir, folder, rules, pluginDir = "/srv/dev/doable-agent-plugins/plugins/doable-code-context" }) {
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
  /usr/bin/caffeinate -i -s '/srv/setup terminal'\\''s/bin/claude' -p ${plugin}--permission-mode dontAsk --output-format stream-json --verbose --allowedTools ${rules} < "$dir/prompt.md" >> "$dir/session.jsonl" 2>&1
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) the serving session ended with code $?" >> "$dir/service.log"
  [ -e "$dir/stopped" ] && break
  sleep 300
done
`;
}

// Plugin 0.5.0's rules allow the whole Doable MCP server.
function plugin050RunScript({ dir, folder, pluginDir }) {
  const rules = "'Skill(doable-code-context:doable-code-agent)' 'mcp__plugin_doable-code-context_doable' 'Bash(sleep 20)' 'Bash(npm test *)'";
  return olderRunScript({ dir, folder, rules, pluginDir });
}

// Plugin 0.6.0's rules name only the wait and the update of a request.
function plugin060RunScript({ dir, folder, pluginDir }) {
  const rules =
    "'Skill(doable-code-context:doable-code-agent)' 'mcp__plugin_doable-code-context_doable__wait_for_code_agent_request' " +
    "'mcp__plugin_doable-code-context_doable__update_code_agent_request' 'Bash(sleep 20)' 'Bash(npm test *)'";
  return olderRunScript({ dir, folder, rules, pluginDir });
}

// A machine that plugin 0.5.0 set up: its config.json has only the folder, the machine and the person's rules.
function asPlugin050Setup(m, dir, runScriptText) {
  writeFileSync(join(dir, "config.json"), `${JSON.stringify({ folder: m.folder, machine: "mac-mini-1", allow: ["Bash(npm test *)"] })}\n`);
  writeFileSync(join(dir, "run.sh"), runScriptText);
}

const SETUP_TERMINAL_CLAUDE = "'\\/srv\\/setup terminal'\\\\''s\\/bin\\/claude'";
const REMINDER = /prompt\.md has no exception for a new test login's password, add this sentence to it, then run stop and start again: "The one exception: the password of a new test login goes in that login of the result\."$/;

test("start writes the start script again with this release's command line, and keeps what this release's setup saved", () => {
  // A machine updates by a plugin update, then stop and start: the start script that an older setup wrote must not
  // keep its command line.
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const later = { ...m.env, DOABLE_CLAUDE_BIN: "/srv/other/claude" };

  // start keeps what setup saved, also when the environment of start differs, and has no reminder for 0.5.0's prompt.
  writeFileSync(join(dir, "run.sh"), "#!/bin/bash\n# an older start script\n");
  stop("mac-mini-1", m.env, () => {});
  const printed = [];
  start("mac-mini-1", later, (line) => printed.push(line));
  const run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.match(run, sessionLine(SETUP_CLAUDE));
  execFileSync("bash", ["-n", join(dir, "run.sh")]);
  assert.deepEqual(printed, [NOT_STARTED, CHROME_NOTE]);
});

test("the update from plugin 0.6.0 (stop, plugin update, start) gives the session this release's command line, and does not use the allow list of 0.6.0's config.json", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  // config.json and run.sh of plugin 0.6.0, word for word: an allow list, no `chrome`, and a dontAsk start script with
  // the person's rules.
  const config060 = {
    folder: m.folder,
    machine: "mac-mini-1",
    allow: ["Bash(npm test *)"],
    claude: "/srv/setup terminal's/bin/claude",
    path: "/srv/setup-terminal/bin:/usr/bin:/bin",
    wake: true,
    pluginDir: null,
  };
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(config060, null, 2)}\n`);
  writeFileSync(join(dir, "run.sh"), plugin060RunScript({ dir, folder: m.folder, pluginDir: null }));
  const promptBefore = readFileSync(join(dir, "prompt.md"), "utf8");

  stop("mac-mini-1", m.env, () => {});
  const printed = [];
  start("mac-mini-1", m.env, (line) => printed.push(line));
  const run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.match(run, new RegExp(`^  \\/usr\\/bin\\/caffeinate -i -s ${SETUP_TERMINAL_CLAUDE} -p ${SESSION_FLAGS}`, "m"));
  assertNoAllowRules(run);
  assert.match(run, /^export PATH='\/srv\/setup-terminal\/bin:\/usr\/bin:\/bin'$/m);
  execFileSync("bash", ["-n", join(dir, "run.sh")]);
  // The prompt does not change, and config.json of 0.6.0 holds the claude command: no reminder of the password sentence.
  assert.equal(readFileSync(join(dir, "prompt.md"), "utf8"), promptBefore);
  assert.deepEqual(printed, [NOT_STARTED, CHROME_NOTE]);
});

test("start on a machine that plugin 0.5.0 set up takes the PATH, the claude command and the plugin folder from its start script, and reminds of the prompt's password sentence", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
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
    new RegExp(`${SETUP_TERMINAL_CLAUDE} -p --plugin-dir '\\/srv\\/dev\\/doable-agent-plugins\\/plugins\\/doable-code-context' ${SESSION_FLAGS}`, "m"),
  );
  assertNoAllowRules(run);
  assert.ok(!run.includes("'mcp__plugin_doable-code-context_doable' "), run);
  assert.match(run, new RegExp(`cd '${m.folder.replaceAll("/", "\\/")}' \\|\\| exit 1`));
  execFileSync("bash", ["-n", join(dir, "run.sh")]);
  const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(config.claude, "/srv/setup terminal's/bin/claude");
  assert.equal(config.path, "/srv/setup-terminal/bin:/usr/bin:/bin");
  assert.equal(config.pluginDir, "/srv/dev/doable-agent-plugins/plugins/doable-code-context");
  assert.equal(printed.length, 3, printed.join("\n"));
  assert.deepEqual(printed.slice(0, 2), [NOT_STARTED, CHROME_NOTE]);
  assert.ok(printed[2].startsWith(`If the secret rule in ${join(dir, "prompt.md")} `), printed[2]);
  assert.match(printed[2], REMINDER);

  // config.json now holds what the start script needs: the next start is not a 0.5.0 setup, and has no reminder.
  const again = [];
  start("mac-mini-1", sshShell, (line) => again.push(line));
  assert.deepEqual(again, [NOT_STARTED, CHROME_NOTE]);
});

test("start with a config.json that holds no claude command reads it and the plugin folder from a start script of 0.6.0 and of this release", () => {
  for (const [name, text] of [
    ["0.6.0", (dir, folder) => plugin060RunScript({ dir, folder })],
    [
      "this release",
      (dir, folder) =>
        runScript({
          dir,
          folder,
          claude: "/srv/setup terminal's/bin/claude",
          path: "/srv/setup-terminal/bin:/usr/bin:/bin",
          wake: true,
          pluginDir: "/srv/dev/doable-agent-plugins/plugins/doable-code-context",
        }),
    ],
  ]) {
    const m = machine();
    setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
    const dir = serviceDir(m.env, "mac-mini-1");
    asPlugin050Setup(m, dir, text(dir, m.folder));
    const { DOABLE_CLAUDE_BIN: _claude, ...withoutClaude } = m.env;
    start("mac-mini-1", { ...withoutClaude, PATH: "/srv/ssh-shell/bin" }, () => {});
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.equal(config.claude, "/srv/setup terminal's/bin/claude", name);
    assert.equal(config.pluginDir, "/srv/dev/doable-agent-plugins/plugins/doable-code-context", name);
    assert.equal(config.path, "/srv/setup-terminal/bin:/usr/bin:/bin", name);
  }
});

test("start on a machine that plugin 0.5.0 set up with the installed plugin takes no plugin folder from its environment", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  asPlugin050Setup(m, dir, plugin050RunScript({ dir, folder: m.folder, pluginDir: null }));
  // The shell that runs start has a development plugin folder set, for example for work on another checkout.
  const devShell = { ...m.env, DOABLE_CODE_AGENT_PLUGIN_DIR: "/srv/dev/doable-agent-plugins/plugins/doable-code-context" };

  stop("mac-mini-1", devShell, () => {});
  start("mac-mini-1", devShell, () => {});
  const run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.match(run, sessionLine(SETUP_TERMINAL_CLAUDE));
  assert.ok(!run.includes("--plugin-dir"), run);
  assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).pluginDir, null);
});

test("start on a machine that plugin 0.5.0 set up takes from its environment what its start script does not hold", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  // A start script that a person changed by hand: no PATH line, and a claude command that is not quoted.
  asPlugin050Setup(m, dir, "#!/bin/bash\nclaude -p --permission-mode dontAsk --allowedTools 'mcp__plugin_doable-code-context_doable' 'Bash(sleep 20)'\n");
  const later = { ...m.env, DOABLE_CLAUDE_BIN: "/srv/other/claude", PATH: "/srv/other/bin:/usr/bin" };

  stop("mac-mini-1", later, () => {});
  const printed = [];
  start("mac-mini-1", later, (line) => printed.push(line));
  const run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.match(run, /^export PATH='\/srv\/other\/bin:\/usr\/bin'$/m);
  assert.match(run, sessionLine("'\\/srv\\/other\\/claude'"));
  assertNoAllowRules(run);
  assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).claude, "/srv/other/claude");
  assert.match(printed[2], REMINDER);
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

test("the command line takes the folder, the machine and the prompt file, and refuses an unknown option", () => {
  assert.deepEqual(parseArgs(["setup", "--machine", "m", "--folder", "/srv/repos", "--prompt-file", "/srv/p.md"]).options, {
    machine: "m",
    folder: "/srv/repos",
    promptFile: "/srv/p.md",
  });
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
