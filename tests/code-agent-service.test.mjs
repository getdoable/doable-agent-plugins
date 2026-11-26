import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { maskSecrets } from "../plugins/doable-code-context/scripts/code-agent-page.mjs";
import {
  ASKED_WAIT,
  NEW_START_SCRIPT,
  browser,
  launchdPlist,
  limitedRun,
  parseArgs,
  remove,
  runScript,
  selfUpdate,
  serviceDir,
  setup,
  start,
  status,
  stop,
  updateRequest,
} from "../plugins/doable-code-context/scripts/code-agent-service.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(root, "plugins", "doable-code-context");
const script = join(pluginRoot, "scripts", "code-agent-service.mjs");
const RELEASE = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).version;
// Built from parts, so that the release verifier's check for keys in the repository does not find a test key.
const PREFIX = ["sk", "doable", ""].join("-");
const KEY = `${PREFIX}test0123456789abcdefghijkl`;

// A value in single quotes, as the service script writes it into the start script (shellQuote), and a regex of that.
const q = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const quotedPattern = (value) => q(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The folder of the node that runs the tests: each PATH that a start script runs with holds it, because the start
// script runs this script's step after each session with the node of that PATH.
const NODE_DIR = dirname(process.execPath);
// The PATH of the terminal that ran an older setup.
const SETUP_TERMINAL_PATH = `/srv/setup-terminal/bin:${NODE_DIR}:/usr/bin:/bin`;

// An entry of `claude plugin list --json`, as Claude Code 2.1.326 writes it, for the plugin installed at `installPath`.
const listEntry = (installPath, version = RELEASE) => ({
  id: "doable-code-context@doable",
  version,
  scope: "user",
  enabled: true,
  installPath,
  installedAt: "2026-11-25T10:00:00.000Z",
  lastUpdated: "2026-11-25T10:00:00.000Z",
});

// A fake `claude` at `path`. `claude plugin list` runs the bash lines `list`, `claude plugin marketplace` the lines
// `marketplace`, `claude plugin update` the lines `update`, and any other call is the serving session, which runs the
// lines `session`. With `calls`, it writes the words of each call to that file, and "session" for a session. It runs
// each command by its full path: start can run it from a shell with another PATH.
function fakeClaude(path, { list, marketplace = ":", update = ":", session = ":", calls = null }) {
  mkdirSync(dirname(path), { recursive: true });
  const note = (words) => (calls === null ? "" : `printf '%s\\n' ${words} >> ${q(calls)}\n`);
  writeFileSync(
    path,
    `#!/bin/bash
if [ "$1" = plugin ]; then
${note('"$*"')}case "$2" in
list) ${list} ;;
marketplace) ${marketplace} ;;
update) ${update} ;;
esac
exit 0
fi
${note("session")}${session}
`,
    { mode: 0o700 },
  );
}

// A machine's home for the service, a folder with repositories, a fake `claude` that lists this checkout's plugin as
// installed (in a folder whose name holds a quote), and no launch: the tests write the files that setup writes and
// check them, and never start launchd or a session. The fakes `oldClaude` and `otherClaude` are the claude commands of
// the terminal that ran an older setup, and of another shell. PATH holds node: the start script's steps run it.
function machine() {
  const base = mkdtempSync(join(tmpdir(), "code-agent-service-"));
  const folder = join(base, "repos");
  mkdirSync(join(folder, ".doable"), { recursive: true });
  const prompt = join(base, "prompt.md");
  writeFileSync(prompt, "Serve Doable requests in this folder with the `doable-code-agent` skill.\n\nRules for this session:\n- Never write to production.\n");
  const listFile = join(base, "plugin-list.json");
  writeFileSync(listFile, JSON.stringify([listEntry(pluginRoot)]));
  const claude = join(base, "claude's bin", "claude");
  const oldClaude = join(base, "setup terminal's", "bin", "claude");
  const otherClaude = join(base, "other", "claude");
  for (const path of [claude, oldClaude, otherClaude]) fakeClaude(path, { list: `/bin/cat ${q(listFile)}` });
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    DOABLE_API_KEY: KEY,
    DOABLE_CODE_AGENT_HOME: join(base, "home"),
    DOABLE_CLAUDE_BIN: claude,
    DOABLE_CODE_AGENT_NO_LAUNCH: "1",
    // No config file of Claude Code, so no chosen Chrome. Without it, the tests would read the developer's own file.
    CLAUDE_CONFIG_DIR: join(base, "claude-config"),
  };
  return { base, folder, prompt, env, claude, oldClaude, otherClaude, listFile };
}

// A key of an MCP server in Claude Code's config file, next to the choice of the Chrome.
const CONFIG_SECRET = "mcp-server-secret";

// Claude Code's config file on the machine, with this choice of a Chrome (undefined: none).
function writeClaudeConfig(m, chromeExtension) {
  mkdirSync(m.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const config = { mcpServers: { tracker: { env: { TOKEN: CONFIG_SECRET } } }, chromeExtension, numStartups: 7 };
  writeFileSync(join(m.env.CLAUDE_CONFIG_DIR, ".claude.json"), JSON.stringify(config, null, 2));
}

const CHOSEN_CHROME = { pairedDeviceId: "0b6c2a4e-1111-4222-8333-944445555666", pairedDeviceName: "QA Mac" };

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

const NOT_STARTED = 'The code agent "mac-mini-1": not started (DOABLE_CODE_AGENT_NO_LAUNCH is set).';
const KEEP_CHROME_OPEN =
  "It uses Claude in Chrome: keep Chrome open on this machine with the Claude in Chrome extension connected.";
// The note of a machine on which the person chose no Chrome in Claude Code.
const CHOOSE_CHROME =
  "close Chrome on your other computers, run `claude --chrome`, then /chrome, \"Select browser\", and choose this machine's Chrome. Then run stop and start.";
const CHROME_NOTE = `${KEEP_CHROME_OPEN} No Chrome is chosen in Claude Code on this machine, so it does not use the browser. To choose one, ${CHOOSE_CHROME}`;

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
  assert.match(run, sessionLine(quotedPattern(m.claude)));
  assertNoAllowRules(run);
  assert.match(run, /while \[ ! -e "\$dir\/stopped" \]; do/);
  assert.ok(run.includes('sleep "${DOABLE_CODE_AGENT_RESTART_WAIT_S:-300}"'), run);
  assert.match(run, /unset ANTHROPIC_API_KEY/);
  assert.match(run, /^export MCP_CONNECTION_NONBLOCKING=false$/m);
  // The session's output can hold a test login's password: the files that the script makes are the owner's only.
  assert.match(run, /^umask 077$/m);
  assert.match(run, new RegExp(`cd '${m.folder.replaceAll("/", "\\/")}' \\|\\| exit 1`));
  // The script is valid bash.
  execFileSync("bash", ["-n", join(dir, "run.sh")]);
  // config.json keeps no allow list and no Chrome switch: every session allows every tool and has Chrome.
  const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.deepEqual(Object.keys(config).sort(), ["autoUpdate", "claude", "folder", "machine", "path", "pluginDir", "wake"]);
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
  assert.match(readFileSync(join(dir, "run.sh"), "utf8"), sessionLine(quotedPattern(m.claude)));
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

test("each command refuses the machine names '.' and '..', so that remove deletes neither the folder of all machines nor the one above it", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const home = m.env.DOABLE_CODE_AGENT_HOME;
  const beside = join(dirname(home), "beside.txt");
  writeFileSync(beside, "a file next to the folder of the machines\n");
  const refusal = /^Error: --machine must be 1 to 64 characters, each a letter, a digit, '\.', '_' or '-', and not '\.' or '\.\.'\.$/;
  for (const name of [".", ".."]) {
    assert.throws(() => remove(name, m.env, () => {}), refusal, name);
    for (const command of [stop, start, status]) assert.throws(() => command(name, m.env, () => {}), refusal, `${command.name} ${name}`);
    assert.throws(() => setup({ folder: m.folder, machine: name, promptFile: m.prompt }, m.env, () => {}), refusal);
  }
  assert.ok(existsSync(join(serviceDir(m.env, "mac-mini-1"), "env")));
  assert.equal(existsSync(join(home, "stopped")), false);
  assert.ok(existsSync(beside));

  // A name with dots in it is a machine's name.
  setup({ folder: m.folder, machine: "..qa.mac", promptFile: m.prompt }, m.env, () => {});
  remove("..qa.mac", m.env, () => {});
  assert.equal(existsSync(serviceDir(m.env, "..qa.mac")), false);
  assert.ok(existsSync(join(serviceDir(m.env, "mac-mini-1"), "env")));
});

// A start script that plugin 0.5.0 or 0.6.0 wrote, word for word: the dontAsk mode with `rules` in --allowedTools, and
// the PATH, the claude command and the development plugin folder of the terminal that ran setup. With no plugin
// folder at setup (the installed plugin), it has no --plugin-dir. With the installed plugin, start reads the installed
// plugins with that claude command (self-update): a test gives it a fake.
function olderRunScript({
  dir,
  folder,
  rules,
  pluginDir = "/srv/dev/doable-agent-plugins/plugins/doable-code-context",
  claude = "/srv/setup terminal's/bin/claude",
}) {
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
export PATH=${q(SETUP_TERMINAL_PATH)}
# In print mode the MCP servers can connect after the first turn starts; the skill's first call needs Doable's tools.
export MCP_CONNECTION_NONBLOCKING=false
cd '${folder}' || exit 1
while [ ! -e "$dir/stopped" ]; do
  if [ -f "$dir/session.jsonl" ] && [ "$(wc -c < "$dir/session.jsonl")" -gt 20971520 ]; then
    mv -f "$dir/session.jsonl" "$dir/session.1.jsonl"
  fi
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) the serving session starts" >> "$dir/service.log"
  /usr/bin/caffeinate -i -s ${q(claude)} -p ${plugin}--permission-mode dontAsk --output-format stream-json --verbose --allowedTools ${rules} < "$dir/prompt.md" >> "$dir/session.jsonl" 2>&1
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) the serving session ended with code $?" >> "$dir/service.log"
  [ -e "$dir/stopped" ] && break
  sleep 300
done
`;
}

// Plugin 0.5.0's rules allow the whole Doable MCP server.
function plugin050RunScript({ dir, folder, pluginDir, claude }) {
  const rules = "'Skill(doable-code-context:doable-code-agent)' 'mcp__plugin_doable-code-context_doable' 'Bash(sleep 20)' 'Bash(npm test *)'";
  return olderRunScript({ dir, folder, rules, pluginDir, claude });
}

// Plugin 0.6.0's rules name only the wait and the update of a request.
function plugin060RunScript({ dir, folder, pluginDir, claude }) {
  const rules =
    "'Skill(doable-code-context:doable-code-agent)' 'mcp__plugin_doable-code-context_doable__wait_for_code_agent_request' " +
    "'mcp__plugin_doable-code-context_doable__update_code_agent_request' 'Bash(sleep 20)' 'Bash(npm test *)'";
  return olderRunScript({ dir, folder, rules, pluginDir, claude });
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
  assert.match(run, sessionLine(quotedPattern(m.claude)));
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
    claude: m.oldClaude,
    path: SETUP_TERMINAL_PATH,
    wake: true,
    pluginDir: null,
  };
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(config060, null, 2)}\n`);
  writeFileSync(join(dir, "run.sh"), plugin060RunScript({ dir, folder: m.folder, pluginDir: null, claude: m.oldClaude }));
  const promptBefore = readFileSync(join(dir, "prompt.md"), "utf8");

  stop("mac-mini-1", m.env, () => {});
  const printed = [];
  start("mac-mini-1", m.env, (line) => printed.push(line));
  const run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.match(run, new RegExp(`^  \\/usr\\/bin\\/caffeinate -i -s ${quotedPattern(m.oldClaude)} -p ${SESSION_FLAGS}`, "m"));
  assertNoAllowRules(run);
  assert.ok(run.includes(`\nexport PATH=${q(SETUP_TERMINAL_PATH)}\n`), run);
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
  assert.ok(run.includes(`\nexport PATH=${q(SETUP_TERMINAL_PATH)}\n`), run);
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
  assert.equal(config.path, SETUP_TERMINAL_PATH);
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
          path: SETUP_TERMINAL_PATH,
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
    assert.equal(config.path, SETUP_TERMINAL_PATH, name);
  }
});

test("start on a machine that plugin 0.5.0 set up with the installed plugin takes no plugin folder from its environment", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  asPlugin050Setup(m, dir, plugin050RunScript({ dir, folder: m.folder, pluginDir: null, claude: m.oldClaude }));
  // The shell that runs start has a development plugin folder set, for example for work on another checkout.
  const devShell = { ...m.env, DOABLE_CODE_AGENT_PLUGIN_DIR: "/srv/dev/doable-agent-plugins/plugins/doable-code-context" };

  stop("mac-mini-1", devShell, () => {});
  start("mac-mini-1", devShell, () => {});
  const run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.match(run, sessionLine(quotedPattern(m.oldClaude)));
  assert.ok(!run.includes("--plugin-dir"), run);
  assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).pluginDir, null);
});

test("start on a machine that plugin 0.5.0 set up takes from its environment what its start script does not hold", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  // A start script that a person changed by hand: no PATH line, and a claude command that is not quoted.
  asPlugin050Setup(m, dir, "#!/bin/bash\nclaude -p --permission-mode dontAsk --allowedTools 'mcp__plugin_doable-code-context_doable' 'Bash(sleep 20)'\n");
  const laterPath = `/srv/other/bin:${NODE_DIR}:/usr/bin`;
  const later = { ...m.env, DOABLE_CLAUDE_BIN: m.otherClaude, PATH: laterPath };

  stop("mac-mini-1", later, () => {});
  const printed = [];
  start("mac-mini-1", later, (line) => printed.push(line));
  const run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.ok(run.includes(`\nexport PATH=${q(laterPath)}\n`), run);
  assert.match(run, sessionLine(quotedPattern(m.otherClaude)));
  assertNoAllowRules(run);
  assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).claude, m.otherClaude);
  assert.match(printed[2], REMINDER);
});

test("the launchd job starts the start script at login, with no KeepAlive, so that a stop stays stopped", () => {
  const plist = launchdPlist({ machine: "mac-mini-1", dir: "/srv/agent/.doable/code-agent/mac-mini-1" });
  assert.match(plist, /<string>ai\.getdoable\.code-agent\.mac-mini-1<\/string>/);
  assert.match(plist, /<string>\/bin\/bash<\/string><string>\/srv\/agent\/\.doable\/code-agent\/mac-mini-1\/run\.sh<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.ok(!plist.includes("KeepAlive"));
});

// Lines of `claude -p --output-format stream-json`, as Claude Code 2.1.326 writes them. The init line names each tool
// (seen in the live check of 2026-11-19: the script said "connected" before the session waited) and the permission
// mode. The line of a call comes before Claude Code checks its permission and before it runs; its result line says
// whether it ran (`is_error`).
const PLUGIN_WAIT = "mcp__plugin_doable-code-context_doable__wait_for_code_agent_request";
const jsonLine = (event) => `${JSON.stringify(event)}\n`;
const initLine = (permissionMode = "bypassPermissions") =>
  jsonLine({ type: "system", subtype: "init", permissionMode, tools: ["Bash", PLUGIN_WAIT, "mcp__doable__wait_for_code_agent_request"] });
const callLine = (id, name = PLUGIN_WAIT) =>
  jsonLine({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: { wait_seconds: 0 } }] } });
const resultLine = (id, { isError = false, text = '{"request":null,"capabilities_missing":false}' } = {}) =>
  jsonLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] } });
const WAITED = `${initLine()}${callLine("toolu_1")}${resultLine("toolu_1")}`;

// A machine set up with no launch, whose `claude` is a fake: it writes `output` as the serving session's output, then
// stops the start script's loop, or with `keepRunning` stays on as a session that serves. `launching` is the
// environment of a real launch: the start script runs in the background as on a machine without launchd (on a Mac
// too), and setup and start wait 2 seconds at most for the session's first wait for a request.
function servedMachine(output, { keepRunning = false } = {}) {
  const m = machine();
  const dir = serviceDir(m.env, "mac-mini-1");
  const outputFile = join(m.base, "output.jsonl");
  writeFileSync(outputFile, output);
  const claude = join(m.base, "fake-claude");
  const then = keepRunning ? "/bin/sleep 30" : `/usr/bin/touch '${join(dir, "stopped")}'`;
  // The plugin commands of the self-update before the session answer as for an installed plugin with no newer release.
  fakeClaude(claude, { list: `/bin/cat ${q(m.listFile)}`, session: `/bin/cat '${outputFile}'\n${then}` });
  const env = { ...m.env, DOABLE_CLAUDE_BIN: claude };
  const { DOABLE_CODE_AGENT_NO_LAUNCH: _noLaunch, ...withLaunch } = env;
  const launching = { ...withLaunch, DOABLE_CODE_AGENT_NO_LAUNCHD: "1", DOABLE_CODE_AGENT_WAIT_S: "2" };
  return { ...m, dir, env, launching };
}

function printedBy(command) {
  const printed = [];
  command((line) => printed.push(line));
  return printed;
}

// Ends a start script that a test launched, with the processes of its group.
function endGroup(pid) {
  try {
    process.kill(-Number(pid), "SIGTERM");
  } catch {
    // The script ended already.
  }
}

const STARTED = 'The code agent "mac-mini-1": started in the background; after a reboot, run `start` again.';
const CONNECTED = "It is connected: it waits for Doable's requests.";
const notWaiting = (dir) => `It did not start to wait in 2 minutes. Read ${join(dir, "session.jsonl")} and ${join(dir, "service.log")}.`;

test("start says connected when the plugin's wait for a request returned, and reads past a line that is not JSON", () => {
  // The session's stderr goes to the same output.
  const m = servedMachine(`Warning: a line of stderr\n${WAITED}`);
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print)), [STARTED, CHROME_NOTE, CONNECTED]);
});

test("start does not count a wait of the session before the launch", () => {
  // session.jsonl keeps the output of the earlier sessions, with their waits and the results.
  const m = servedMachine(initLine());
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  writeFileSync(join(m.dir, "session.jsonl"), WAITED);
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print)), [STARTED, CHROME_NOTE, notWaiting(m.dir)]);
});

test("start does not count a wait call that Claude Code refused or that Doable refused, nor the result of another call", () => {
  const m = servedMachine(
    initLine() +
      callLine("toolu_1") +
      resultLine("toolu_1", { isError: true, text: `Permission to use ${PLUGIN_WAIT} has been denied.` }) +
      jsonLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "ls" } }] } }) +
      resultLine("toolu_2", { text: "repos" }) +
      callLine("toolu_3") +
      resultLine("toolu_3", { isError: true, text: "doable_auth_error: The API key was revoked." }),
  );
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print)), [STARTED, CHROME_NOTE, notWaiting(m.dir)]);
});

test("setup says when the session runs in another permission mode than the bypass mode, and then not that it runs in the bypass mode", () => {
  const otherMode =
    'It runs in the default permission mode, not in the bypass mode, so with nobody at the terminal it cannot do the work of a request. Settings of this machine can turn the bypass mode off (`disableBypassPermissionsMode`): read the README\'s "With nobody at the terminal".';
  const bypassNote = (line) => line.startsWith("It runs in the bypass permission mode: ");
  // Settings that turn the bypass mode off: Claude Code goes on in the default mode, and the Skill's allowed-tools let
  // the wait through. Contrast: the session that runs in the bypass mode.
  for (const [mode, expected] of [
    ["default", { bypass: false, other: true }],
    ["bypassPermissions", { bypass: true, other: false }],
  ]) {
    const m = servedMachine(`${initLine(mode)}${callLine("toolu_1")}${resultLine("toolu_1")}`);
    const printed = printedBy((print) => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.launching, print));
    const at = printed.indexOf(CONNECTED);
    assert.ok(at > 0, printed.join("\n"));
    assert.equal(printed.some(bypassNote), expected.bypass, `${mode}:\n${printed.join("\n")}`);
    assert.equal(printed.includes(otherMode), expected.other, `${mode}:\n${printed.join("\n")}`);
    assert.ok(printed[at + (expected.other ? 2 : 1)].startsWith("Its files are in "), printed.join("\n"));
  }
});

test("start says when the session waits through another Doable MCP server than the plugin's, and not that it is connected", () => {
  // A server of the person's settings with the plugin server's address takes the place of the plugin's server, with
  // its own key and machine header.
  const m = servedMachine(`${initLine()}${callLine("toolu_1", "mcp__doable__wait_for_code_agent_request")}${resultLine("toolu_1")}`);
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print)), [
    STARTED,
    CHROME_NOTE,
    'It waits for Doable\'s requests through another Doable MCP server of your Claude Code settings (its tool mcp__doable__wait_for_code_agent_request), not through the plugin\'s server, so it does not use this setup\'s key and machine name. Remove that server (README, "With nobody at the terminal"), then run stop and start.',
  ]);
});

test("start reads all of the new output when the start script moved a large earlier output away", () => {
  const m = servedMachine(WAITED);
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  // Larger than the 20 MB at which the start script moves the output to session.1.jsonl.
  writeFileSync(join(m.dir, "session.jsonl"), `${"x".repeat(20 * 1024 * 1024)}\n`);
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print)), [STARTED, CHROME_NOTE, CONNECTED]);
  assert.ok(existsSync(join(m.dir, "session.1.jsonl")));
});

test("on a machine without launchd, setup and start refuse while the session runs, but not after stop", () => {
  const m = servedMachine(WAITED, { keepRunning: true });
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const pids = [];
  // Each launch's pid, kept before any assertion, so that the test ends each script that it launched.
  const startAndKeepPid = () => {
    const printed = printedBy((print) => start("mac-mini-1", m.launching, print));
    pids.push(readFileSync(join(m.dir, "pid"), "utf8").trim());
    return printed;
  };
  try {
    assert.deepEqual(startAndKeepPid(), [STARTED, CHROME_NOTE, CONNECTED]);
    const refusal = new RegExp(`^Error: The code agent "mac-mini-1" runs \\(process ${pids[0]}\\)\\. Run stop first: stop --machine mac-mini-1$`);
    const run = readFileSync(join(m.dir, "run.sh"), "utf8");
    assert.throws(() => start("mac-mini-1", m.launching, () => {}), refusal);
    assert.throws(() => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.launching, () => {}), refusal);
    // A refused command launches nothing and changes nothing.
    assert.equal(readFileSync(join(m.dir, "pid"), "utf8").trim(), pids[0]);
    assert.equal(readFileSync(join(m.dir, "run.sh"), "utf8"), run);
    // After `stop` (its stop file), the session ends by itself, and start goes on while it ends.
    writeFileSync(join(m.dir, "stopped"), "now\n");
    assert.deepEqual(startAndKeepPid(), [STARTED, CHROME_NOTE, CONNECTED]);
    assert.notEqual(pids[1], pids[0]);
  } finally {
    // Also the script of a launch that a refusal did not stop.
    for (const pid of new Set([...pids, readFileSync(join(m.dir, "pid"), "utf8").trim()])) endGroup(pid);
  }
});

test("on a machine without launchd, start goes on when another process has the pid of the ended start script", () => {
  // After a reboot, another process can have the pid that the `pid` file names.
  const m = servedMachine(WAITED);
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  writeFileSync(join(m.dir, "pid"), `${process.pid}\n`);
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print)), [STARTED, CHROME_NOTE, CONNECTED]);
});

test("setup and start say which Chrome the person chose in Claude Code, and when none is chosen", () => {
  const m = machine();
  writeClaudeConfig(m, CHOSEN_CHROME);
  const chosenNote = `${KEEP_CHROME_OPEN} It uses only the Chrome that you chose in Claude Code, "QA Mac". If that can be the Chrome of another computer, ${CHOOSE_CHROME}`;
  const atSetup = printedBy((print) => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, print));
  assert.ok(atSetup.includes(chosenNote), atSetup.join("\n"));
  stop("mac-mini-1", m.env, () => {});
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.env, print)), [NOT_STARTED, chosenNote]);
  assert.ok(!atSetup.join("\n").includes(CONFIG_SECRET), atSetup.join("\n"));

  // Contrast: the same config file with no choice, also after the person started Claude Code many times.
  writeClaudeConfig(m, undefined);
  stop("mac-mini-1", m.env, () => {});
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.env, print)), [NOT_STARTED, CHROME_NOTE]);
});

test("the browser command prints the deviceId of the Chrome that the person chose in Claude Code, and nothing else of its config file", () => {
  const m = machine();
  const run = () => execFileSync(process.execPath, [script, "browser"], { env: m.env, stdio: "pipe" }).toString();
  assert.equal(run(), "No Chrome is chosen in Claude Code on this machine.\n");
  for (const none of [undefined, {}]) {
    writeClaudeConfig(m, none);
    assert.equal(run(), "No Chrome is chosen in Claude Code on this machine.\n");
  }
  writeClaudeConfig(m, CHOSEN_CHROME);
  assert.equal(run(), `The chosen Chrome: deviceId ${CHOSEN_CHROME.pairedDeviceId}, name "QA Mac".\n`);
  // Without CLAUDE_CONFIG_DIR, Claude Code keeps the file in the home folder.
  const { CLAUDE_CONFIG_DIR: home, ...env } = m.env;
  const inHome = execFileSync(process.execPath, [script, "browser"], { env: { ...env, HOME: home }, stdio: "pipe" }).toString();
  assert.equal(inHome, `The chosen Chrome: deviceId ${CHOSEN_CHROME.pairedDeviceId}, name "QA Mac".\n`);
  // The session names the script by a path that can hold a link (a linked ~/.claude).
  const link = join(m.base, "linked-scripts");
  symlinkSync(dirname(script), link);
  const linked = execFileSync(process.execPath, [join(link, "code-agent-service.mjs"), "browser"], { env: m.env, stdio: "pipe" }).toString();
  assert.equal(linked, `The chosen Chrome: deviceId ${CHOSEN_CHROME.pairedDeviceId}, name "QA Mac".\n`);
});

test("a config file of Claude Code that is not valid JSON stops the browser command, setup and start before they change anything, and none of its text is printed", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  stop("mac-mini-1", m.env, () => {});
  mkdirSync(m.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const file = join(m.env.CLAUDE_CONFIG_DIR, ".claude.json");
  // The error of JSON.parse would quote the text at the place that it could not read.
  writeFileSync(file, CONFIG_SECRET);
  const refusal = { message: `${file}, the config file of Claude Code, is not valid JSON.` };
  assert.throws(() => browser(m.env, () => {}), refusal);

  const dir = serviceDir(m.env, "mac-mini-1");
  writeFileSync(join(dir, "run.sh"), "#!/bin/bash\n# the start script before\n");
  assert.throws(() => start("mac-mini-1", m.env, () => {}), refusal);
  const otherPrompt = join(m.base, "other-prompt.md");
  writeFileSync(otherPrompt, "Another prompt.\n");
  assert.throws(() => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: otherPrompt }, m.env, () => {}), refusal);
  assert.equal(readFileSync(join(dir, "run.sh"), "utf8"), "#!/bin/bash\n# the start script before\n");
  assert.ok(!readFileSync(join(dir, "prompt.md"), "utf8").includes("Another prompt."));
  assert.ok(existsSync(join(dir, "stopped")));
});

test("start refuses a wait time that is not a whole number of seconds, and launches nothing", () => {
  // "2s" is not a number: with it, start waited for ever for a session that never waits. The command runs in its own
  // process with a time limit, so that a start that waits for ever fails the test and does not stop it.
  const m = servedMachine(initLine());
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  let failed;
  try {
    execFileSync(process.execPath, [script, "start", "--machine", "mac-mini-1"], {
      stdio: "pipe",
      env: { ...m.launching, DOABLE_CODE_AGENT_WAIT_S: "2s" },
      timeout: 20000,
    });
  } catch (error) {
    failed = error;
  }
  assert.ok(failed, "start did not fail");
  assert.equal(failed.status, 1, `status ${failed.status}, signal ${failed.signal}`);
  assert.equal(failed.stderr.toString(), "DOABLE_CODE_AGENT_WAIT_S must be a whole number of seconds.\n");
  assert.equal(existsSync(join(m.dir, "pid")), false);
});

test("on a machine without launchd, status says on while the start script runs, and not running when the pid file names another process", () => {
  // After a reboot, no stop file is there, and another process can have the pid that the `pid` file names.
  const m = servedMachine(WAITED, { keepRunning: true });
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  start("mac-mini-1", m.launching, () => {});
  const pid = readFileSync(join(m.dir, "pid"), "utf8").trim();
  try {
    assert.equal(printedBy((print) => status("mac-mini-1", m.launching, print))[0], 'Code agent "mac-mini-1": on.');
    writeFileSync(join(m.dir, "pid"), `${process.pid}\n`);
    assert.equal(printedBy((print) => status("mac-mini-1", m.launching, print))[0], 'Code agent "mac-mini-1": not running.');
  } finally {
    endGroup(pid);
  }
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

// What setup, start (with --auto-update) and status say about self-update.
const SELF_UPDATE_ON =
  "Self-update is on: when Doable asks for a newer release of the plugin, the session ends, and the start script updates the plugin with Claude Code's own commands and starts the new release. It updates at no other time. To turn it off, run stop, then start --machine mac-mini-1 --auto-update off.";
const SELF_UPDATE_OFF =
  'Self-update is off: when Doable asks for a newer release of the plugin, each session ends at its first wait for a request, and the next one starts 30 minutes later, until a person updates the plugin (README, "Self-update"). To turn it on, run stop, then start --machine mac-mini-1 --auto-update on.';
const SELF_UPDATE_DEV =
  "Self-update is off: the session loads the plugin from a development folder (DOABLE_CODE_AGENT_PLUGIN_DIR at setup). When Doable asks for a newer release, each session ends at its first wait for a request, and the next one starts 30 minutes later, until a person updates that folder.";
// The start script's step after each session, with the node of its PATH: with self-update on, for the plugin that
// Claude Code installed in the user scope from the marketplace doable; and with self-update off.
const NODE = join(NODE_DIR, "node");
const UPDATE_STEP = `${q(NODE)} ${q(script)} update-request --dir "$dir" --from "$from" --plugin 'doable-code-context@doable' --scope 'user' >> "$dir/service.log" 2>&1`;
const REQUEST_STEP = `${q(NODE)} ${q(script)} update-request --dir "$dir" --from "$from" >> "$dir/service.log" 2>&1`;
// service.log's lines with no time.
const logLines = (dir) =>
  readFileSync(join(dir, "service.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ /, ""));

test("setup turns self-update on and says how to turn it off, start keeps or changes the choice, and status shows it", () => {
  const m = machine();
  const atSetup = printedBy((print) => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, print));
  assert.ok(atSetup.includes(SELF_UPDATE_ON), atSetup.join("\n"));
  const dir = serviceDir(m.env, "mac-mini-1");
  const run = () => readFileSync(join(dir, "run.sh"), "utf8");
  const saved = () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).autoUpdate;
  assert.equal(saved(), true);
  // The step comes after the session, never before its first start, and once in the loop.
  assert.ok(run().includes(UPDATE_STEP), run());
  assert.ok(run().indexOf(UPDATE_STEP) > run().indexOf("the serving session ended"), run());
  assert.equal(run().split("update-request --dir").length, 2, run());
  execFileSync("bash", ["-n", join(dir, "run.sh")]);
  assert.equal(printedBy((print) => status("mac-mini-1", m.env, print))[1], SELF_UPDATE_ON);

  // start --auto-update off: kept in config.json, and the start script's step names no plugin to update.
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.env, print, { autoUpdate: false })), [NOT_STARTED, CHROME_NOTE, SELF_UPDATE_OFF]);
  assert.equal(saved(), false);
  assert.ok(run().includes(REQUEST_STEP) && !run().includes("--scope"), run());
  assert.ok(run().indexOf(REQUEST_STEP) > run().indexOf("the serving session ended"), run());
  execFileSync("bash", ["-n", join(dir, "run.sh")]);
  // start without the option keeps the choice, and says nothing of it.
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.env, print)), [NOT_STARTED, CHROME_NOTE]);
  assert.equal(saved(), false);
  assert.ok(run().includes(REQUEST_STEP), run());
  assert.equal(printedBy((print) => status("mac-mini-1", m.env, print))[1], SELF_UPDATE_OFF);
  start("mac-mini-1", m.env, () => {}, { autoUpdate: true });
  assert.equal(saved(), true);
  assert.ok(run().includes(UPDATE_STEP), run());

  // setup with --auto-update off.
  const other = machine();
  const off = printedBy((print) => setup({ folder: other.folder, machine: "mac-mini-1", promptFile: other.prompt, autoUpdate: false }, other.env, print));
  assert.ok(off.includes(SELF_UPDATE_OFF), off.join("\n"));
  assert.equal(JSON.parse(readFileSync(join(serviceDir(other.env, "mac-mini-1"), "config.json"), "utf8")).autoUpdate, false);

  // The command line takes on or off, and nothing else.
  assert.equal(parseArgs(["start", "--machine", "m", "--auto-update", "off"]).options.autoUpdate, false);
  assert.equal(parseArgs(["setup", "--auto-update", "on"]).options.autoUpdate, true);
  assert.throws(() => parseArgs(["start", "--auto-update", "yes"]), /^Error: --auto-update must be on or off\.$/);
});

test("a development plugin folder has no self-update, and setup reads no installed plugin for it", () => {
  const m = machine();
  const calls = join(m.base, "calls");
  fakeClaude(m.claude, { list: `/bin/cat ${q(m.listFile)}`, calls });
  const dev = { ...m.env, DOABLE_CODE_AGENT_PLUGIN_DIR: "/srv/dev/doable-agent-plugins/plugins/doable-code-context" };
  const printed = printedBy((print) => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, dev, print));
  assert.ok(printed.includes(SELF_UPDATE_DEV), printed.join("\n"));
  const dir = serviceDir(m.env, "mac-mini-1");
  const run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.ok(run.includes(REQUEST_STEP) && !run.includes("--scope"), run);
  assert.equal(existsSync(calls), false);
  assert.equal(printedBy((print) => status("mac-mini-1", m.env, print))[1], SELF_UPDATE_DEV);
});

test("with self-update on, setup and start refuse, and change nothing, when Claude Code lists no install of this release or cannot list", () => {
  const m = machine();
  // Claude Code lists the plugin in another folder: this script runs from a checkout, not from its installPath.
  writeFileSync(m.listFile, JSON.stringify([listEntry(join(m.base, "plugins", "cache", "doable", "doable-code-context", RELEASE))]));
  const refusal =
    /^Error: Self-update updates the plugin that Claude Code installed, and `claude plugin list --json` names no install of it in this folder \(.+\)\. Run this script from the installPath that `claude plugin list --json` names for doable-code-context, or turn self-update off with --auto-update off\.$/;
  assert.throws(() => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {}), refusal);
  const dir = serviceDir(m.env, "mac-mini-1");
  assert.equal(existsSync(dir), false);

  // With self-update off, setup reads no list; start that turns it on refuses as setup did.
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, autoUpdate: false }, m.env, () => {});
  const before = readFileSync(join(dir, "run.sh"), "utf8");
  assert.throws(() => start("mac-mini-1", m.env, () => {}, { autoUpdate: true }), refusal);
  assert.equal(readFileSync(join(dir, "run.sh"), "utf8"), before);
  assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).autoUpdate, false);

  // A list command that fails: its reason, with no secret of its output.
  fakeClaude(m.claude, { list: `echo "fatal: could not read https://qa-bot:hunter2-secret@git.example.com/x.git" >&2; exit 1` });
  assert.throws(
    () => start("mac-mini-1", m.env, () => {}, { autoUpdate: true }),
    (error) => {
      assert.equal(
        error.message,
        "`claude plugin list --json` ended with code 1; its last lines: fatal: could not read https://qa-bot:****@git.example.com/x.git. Self-update reads it to find the installed plugin; to start with no self-update, use --auto-update off.",
      );
      return true;
    },
  );
  assert.equal(readFileSync(join(dir, "run.sh"), "utf8"), before);
});

// Doable MCP's answer to a wait for a request when Doable needs a newer release: only these words, with no JSON record.
const askText = (version) =>
  `Doable needs the plugin ${version} on this machine. End the session now, and call no other tool. An Always on service updates the plugin and starts the session again; in a session that a person started, the person updates the plugin and starts the session again.`;
// A normal answer that holds a request whose text quotes those words: the asker's words, not Doable's ask.
const QUOTING_ANSWER = JSON.stringify({
  request: { id: "CA-ABC123", request: `Why does service.log say "${askText("9.9.9")}"? Explain it to me.` },
  capabilities_missing: false,
});
// The output of a session whose first wait got `text`.
const waitedWith = (id, text) => `${initLine()}${callLine(id)}${resultLine(id, { text })}`;
// The run of a start script with fakes: the session's `claude` and `sleep`, which write each call to `calls` and do not
// wait. The start script finds `sleep` first on its PATH (setup's PATH).
function withFakeSleep(m, calls) {
  const bin = join(m.base, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "sleep"), `#!/bin/bash\nprintf 'sleep %s\\n' "$1" >> ${q(calls)}\n`, { mode: 0o700 });
  return { ...m.env, PATH: `${bin}:${m.env.PATH}` };
}
// The session part of a fake `claude`: the n-th session writes the file `output-<n>.jsonl` of `base`, and the session
// `last` ends the start script's loop.
const sessionsInTurn = (base, dir, last) => {
  const count = q(join(base, "sessions"));
  return `n=$(( $(/bin/cat ${count} 2>/dev/null || echo 0) + 1 )); echo $n > ${count}
/bin/cat ${q(base)}/output-$n.jsonl
if [ $n = ${last} ]; then /usr/bin/touch ${q(join(dir, "stopped"))}; fi`;
};

test("after a session whose wait got Doable's ask, the start script updates the plugin and goes on in the new release's start script; never at the first start, nor for the same words in a request", () => {
  const m = machine();
  const calls = join(m.base, "calls");
  // The new release as Claude Code installs it: a folder of its own, with its version in its manifest.
  const next = join(m.base, "plugins", "cache", "doable", "doable-code-context", "9.9.9");
  cpSync(pluginRoot, next, { recursive: true });
  const manifest = join(next, ".claude-plugin", "plugin.json");
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version: "9.9.9" }));
  const newList = join(m.base, "new-list.json");
  writeFileSync(newList, JSON.stringify([listEntry(next, "9.9.9")]));
  const dir = serviceDir(m.env, "mac-mini-1");
  // The sessions in turn: (1) a request whose text quotes Doable's ask; (2) Doable's ask while the marketplace has no
  // newer release; (3) Doable's ask after the release came to the marketplace; (4) the new release's session.
  const outputs = [QUOTING_ANSWER, askText("9.9.9"), askText("9.9.9"), '{"request":null,"capabilities_missing":false}'];
  outputs.forEach((text, i) => writeFileSync(join(m.base, `output-${i + 1}.jsonl`), waitedWith(`toolu_${i + 1}`, text)));
  const published = join(m.base, "published");
  const updated = join(m.base, "updated");
  // `claude plugin update` installs the new release only after the third session's start, when it is published.
  fakeClaude(m.claude, {
    list: `if [ -e ${q(updated)} ]; then /bin/cat ${q(newList)}; else /bin/cat ${q(m.listFile)}; fi`,
    update: `if [ -e ${q(published)} ]; then /usr/bin/touch ${q(updated)}; fi`,
    session: `if [ -e ${q(join(m.base, "sessions"))} ] && [ "$(/bin/cat ${q(join(m.base, "sessions"))})" = 2 ]; then /usr/bin/touch ${q(published)}; fi\n${sessionsInTurn(m.base, dir, 4)}`,
    calls,
  });
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, withFakeSleep(m, calls), () => {});
  writeFileSync(calls, "");
  execFileSync("/bin/bash", [join(dir, "run.sh")], { env: { PATH: "/usr/bin:/bin" }, stdio: "pipe", timeout: 60000 });

  const update = ["plugin marketplace update doable", "plugin update doable-code-context@doable --scope user", "plugin list --json"];
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
    // The first start does not update, and a request's text that quotes the words is not Doable's ask.
    "session",
    "sleep 300",
    // Doable asks, and the marketplace has no newer release: the next session starts 30 minutes later.
    "session",
    ...update,
    "sleep 1800",
    // Doable asks, and Claude Code installs the new release, which reads the list to write its start script: the loop
    // goes on in that script at once.
    "session",
    ...update,
    "plugin list --json",
    "session",
  ]);
  const asked = `Doable asked for the plugin 9.9.9; this release is ${RELEASE}.`;
  const ran = [
    "self-update: `claude plugin marketplace update doable` ended with no error.",
    "self-update: `claude plugin update doable-code-context@doable --scope user` ended with no error.",
  ];
  const session = ["the serving session starts", "the serving session ended with code 0"];
  assert.deepEqual(logLines(dir), [
    ...session,
    ...session,
    asked,
    ...ran,
    `self-update: doable-code-context@doable is at ${RELEASE}, the release of this start script.`,
    `self-update: this release (${RELEASE}) is still lower than 9.9.9, which Doable asked for: a person must act (README, "Self-update"). The next session starts in 30 minutes.`,
    ...session,
    asked,
    ...ran,
    `self-update: doable-code-context@doable went from ${RELEASE} to 9.9.9: the new release writes the start script again.`,
    "self-update: 9.9.9 wrote the start script: the session starts with it.",
    ...session,
  ]);
  const run = readFileSync(join(dir, "run.sh"), "utf8");
  // Node names the script that it runs by its real path.
  assert.ok(run.includes(`${q(NODE)} ${q(join(realpathSync(next), "scripts", "code-agent-service.mjs"))} update-request --dir "$dir"`), run);
  assert.ok(run.includes("(user scope, 9.9.9 when this"), run);
  // The new release is at the version that Doable asked for: it removed update-asked.
  assert.equal(existsSync(join(dir, "update-asked")), false);
  assert.ok(!readFileSync(join(dir, "service.log"), "utf8").includes(KEY));
});

test("a self-update step that fails says how it failed, with no secret, writes no start script, and the start script waits 30 minutes", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const calls = join(m.base, "calls");
  const noTime = (line) => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ /, "");
  const step = (options = {}) => {
    const printed = [];
    writeFileSync(calls, "");
    const updated = selfUpdate({ dir, plugin: "doable-code-context@doable", scope: "user", ...options }, { PATH: m.env.PATH }, (line) => printed.push(line), maskSecrets);
    return { updated, lines: printed.map(noTime), calls: readFileSync(calls, "utf8").trim().split("\n") };
  };
  const ran = (args) => `self-update: \`claude plugin ${args}\` ended with no error.`;
  const run = readFileSync(join(dir, "run.sh"), "utf8");

  // The marketplace update fails, with a URL's password and a Doable key in its output: no plugin update follows.
  fakeClaude(m.claude, {
    list: `/bin/cat ${q(m.listFile)}`,
    marketplace: `echo "Fetching https://qa-bot:hunter2-secret@git.example.com/x.git"; echo "fatal: could not read ${KEY}" >&2; exit 1`,
    calls,
  });
  const marketplaceFailed =
    "self-update: `claude plugin marketplace update doable` ended with code 1; its last lines: Fetching https://qa-bot:****@git.example.com/x.git | fatal: could not read sk-doable-****.";
  let result = step();
  assert.equal(result.updated, false);
  assert.deepEqual(result.lines, [marketplaceFailed]);
  assert.deepEqual(result.calls, ["plugin marketplace update doable"]);
  // After a session that Doable asked: the same failure, then the line that a person must act, and the code of the
  // start script's wait of 30 minutes.
  writeFileSync(join(dir, "session.jsonl"), waitedWith("toolu_1", askText("9.9.9")));
  const printed = [];
  const code = updateRequest({ dir, from: 0, plugin: "doable-code-context@doable", scope: "user" }, { PATH: m.env.PATH }, (line) => printed.push(line), maskSecrets);
  assert.equal(code, ASKED_WAIT);
  assert.deepEqual(printed.map(noTime), [
    `Doable asked for the plugin 9.9.9; this release is ${RELEASE}.`,
    marketplaceFailed,
    `self-update: this release (${RELEASE}) is still lower than 9.9.9, which Doable asked for: a person must act (README, "Self-update"). The next session starts in 30 minutes.`,
  ]);
  assert.equal(readFileSync(join(dir, "update-asked"), "utf8"), "9.9.9\n");

  // Claude Code lists no such plugin in that scope, or prints no JSON: the list's text is not shown.
  for (const [list, problem] of [
    ["echo '[]'", "`claude plugin list --json` names no doable-code-context@doable in the user scope"],
    [`echo "not json ${KEY}"`, "`claude plugin list --json` did not print JSON"],
  ]) {
    fakeClaude(m.claude, { list, calls });
    result = step();
    assert.equal(result.updated, false);
    assert.deepEqual(result.lines, [ran("marketplace update doable"), ran("update doable-code-context@doable --scope user"), `self-update: ${problem}.`]);
  }

  // The new release cannot write its start script: its folder holds no script, then a script that fails. The start
  // script stays.
  const broken = join(m.base, "plugins", "cache", "doable", "doable-code-context", "9.9.9");
  const brokenScript = join(broken, "scripts", "code-agent-service.mjs");
  mkdirSync(dirname(brokenScript), { recursive: true });
  const brokenList = join(m.base, "broken-list.json");
  writeFileSync(brokenList, JSON.stringify([listEntry(broken, "9.9.9")]));
  fakeClaude(m.claude, { list: `/bin/cat ${q(brokenList)}`, calls });
  const wentTo = `self-update: doable-code-context@doable went from ${RELEASE} to 9.9.9: the new release writes the start script again.`;
  result = step();
  assert.equal(result.updated, false);
  assert.deepEqual(result.lines.slice(2), [wentTo, `self-update: 9.9.9 has no ${brokenScript}.`]);
  writeFileSync(brokenScript, 'console.error("Unknown command write-start-script");\nprocess.exit(2);\n');
  result = step();
  assert.equal(result.updated, false);
  assert.deepEqual(result.lines.slice(2), [wentTo, "self-update: `write-start-script` of 9.9.9 ended with code 2; its last lines: Unknown command write-start-script."]);
  assert.equal(readFileSync(join(dir, "run.sh"), "utf8"), run);

  // A start script with an option of another form fails, and runs no command.
  assert.throws(() => step({ scope: "everywhere" }), /^Error: --scope must be one of user, project, local, managed\.$/);
  assert.throws(() => step({ plugin: "other-plugin@doable" }), /^Error: --plugin must be doable-code-context@<marketplace>\.$/);
  assert.equal(NEW_START_SCRIPT, 3);
});

test("each command of the self-update has a time limit: a command that hangs is killed, also when it ignores SIGTERM", () => {
  const begun = Date.now();
  const hung = limitedRun("/bin/bash", ["-c", "trap '' TERM; /bin/sleep 30"], { cwd: tmpdir(), seconds: 1, env: { PATH: "/usr/bin:/bin" } });
  assert.equal(hung.error?.code, "ETIMEDOUT");
  assert.equal(hung.signal, "SIGKILL");
  assert.ok(Date.now() - begun < 10000, `${Date.now() - begun} ms`);
  // Contrast: a command that ends in time.
  const quick = limitedRun("/bin/echo", ["done"], { cwd: tmpdir(), seconds: 5, env: { PATH: "/usr/bin:/bin" } });
  assert.equal(quick.status, 0);
  assert.equal(quick.stdout, "done\n");
});

test("with self-update off, service.log says that Doable asked for a newer plugin and that a person must update it, and the next session starts 30 minutes later; only Doable's own answer counts", () => {
  const asked = `Doable asked for the plugin 9.9.9; this release is ${RELEASE}.`;
  const needs = (why) =>
    `${why}: a person must update the plugin to 9.9.9, then run stop and start (README, "Self-update"). Until then, each session ends at its first wait for a request, and the next session starts in 30 minutes.`;
  const m = machine();
  const calls = join(m.base, "calls");
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, autoUpdate: false }, withFakeSleep(m, calls), () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  // The first session gets Doable's ask, and the second one ends the loop. No plugin command runs.
  writeFileSync(join(m.base, "output-1.jsonl"), waitedWith("toolu_1", askText("9.9.9")));
  writeFileSync(join(m.base, "output-2.jsonl"), waitedWith("toolu_2", QUOTING_ANSWER));
  fakeClaude(m.claude, { list: `/bin/cat ${q(m.listFile)}`, session: sessionsInTurn(m.base, dir, 2), calls });
  writeFileSync(calls, "");
  execFileSync("/bin/bash", [join(dir, "run.sh")], { env: { PATH: "/usr/bin:/bin" }, stdio: "pipe", timeout: 60000 });
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["session", "sleep 1800", "session"]);
  const session = ["the serving session starts", "the serving session ended with code 0"];
  assert.deepEqual(logLines(dir), [...session, asked, needs("Self-update is off"), ...session]);
  assert.equal(readFileSync(join(dir, "update-asked"), "utf8"), "9.9.9\n");

  const step = (from) => {
    const printed = [];
    const code = updateRequest({ dir, from }, { PATH: m.env.PATH }, (line) => printed.push(line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ /, "")), maskSecrets);
    return { code, printed };
  };
  const log = join(dir, "session.jsonl");
  // In words, as a list of text parts, after a blank line.
  writeFileSync(
    log,
    `${callLine("toolu_2")}${jsonLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: `\n${askText("9.9.9")}` }] }] } })}`,
  );
  assert.deepEqual(step(0), { code: ASKED_WAIT, printed: [asked, needs("Self-update is off")] });
  // Contrasts: the ask before the session's start (before `from`); an answer that holds a request whose text quotes
  // the words; a JSON answer that holds the words in another field; a text that has the words after other words; the
  // answer of a call that failed; and the answer of another tool.
  const earlier = waitedWith("toolu_3", askText("9.9.9"));
  writeFileSync(
    log,
    earlier +
      callLine("toolu_4") +
      resultLine("toolu_4", { text: QUOTING_ANSWER }) +
      callLine("toolu_5") +
      resultLine("toolu_5", { text: JSON.stringify({ request: null, capabilities_missing: false, update: askText("9.9.9") }) }) +
      callLine("toolu_6") +
      resultLine("toolu_6", { text: `Note: ${askText("9.9.9")}` }) +
      callLine("toolu_7") +
      resultLine("toolu_7", { isError: true, text: askText("9.9.9") }) +
      jsonLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_8", name: "Bash", input: { command: "cat notes" } }] } }) +
      resultLine("toolu_8", { text: askText("9.9.9") }),
  );
  assert.deepEqual(step(Buffer.byteLength(earlier)), { code: 0, printed: [] });
  assert.deepEqual(step(0), { code: ASKED_WAIT, printed: [asked, needs("Self-update is off")] });
  // An ask for a release that is not above this one: the line, and no wait of 30 minutes.
  rmSync(join(dir, "update-asked"));
  writeFileSync(log, waitedWith("toolu_9", askText(RELEASE)));
  assert.deepEqual(step(0), { code: 0, printed: [`Doable asked for the plugin ${RELEASE}; this release is ${RELEASE}.`] });
  assert.equal(existsSync(join(dir, "update-asked")), false);

  // A development plugin folder says so.
  const dev = machine();
  setup({ folder: dev.folder, machine: "mac-mini-1", promptFile: dev.prompt }, { ...dev.env, DOABLE_CODE_AGENT_PLUGIN_DIR: "/srv/dev/plugin" }, () => {});
  const devDir = serviceDir(dev.env, "mac-mini-1");
  writeFileSync(join(devDir, "session.jsonl"), waitedWith("toolu_1", askText("9.9.9")));
  const printed = [];
  assert.equal(updateRequest({ dir: devDir, from: 0 }, { PATH: dev.env.PATH }, (line) => printed.push(line.replace(/^\S+ /, "")), maskSecrets), ASKED_WAIT);
  assert.deepEqual(printed, [asked, needs("The session loads the plugin from a development folder")]);
});

test("setup and start say that Doable needs a newer plugin, not that the session is connected, when its first wait got Doable's ask", () => {
  const asks = (next) => `Doable needs the plugin 9.9.9 on this machine, so the session ended at its first wait for a request. ${next}`;
  const updatesNow = asks("The start script updates the plugin now and starts the new release; service.log says how each step went.");
  // Self-update on: start says that the start script updates now.
  let m = servedMachine(waitedWith("toolu_1", askText("9.9.9")));
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print)), [STARTED, CHROME_NOTE, updatesNow]);
  // Self-update off: setup says that a person updates.
  m = servedMachine(waitedWith("toolu_1", askText("9.9.9")));
  const printed = printedBy((print) => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, autoUpdate: false }, m.launching, print));
  assert.ok(
    printed.includes(
      asks(
        'Self-update is off: update the plugin by hand, then run stop and start (README, "Self-update"). Until then, a session starts every 30 minutes and ends at its first wait for a request.',
      ),
    ),
    printed.join("\n"),
  );
  assert.ok(!printed.includes(CONNECTED), printed.join("\n"));
  // Contrast: the same words in a request's text. The session waits for requests.
  m = servedMachine(waitedWith("toolu_1", QUOTING_ANSWER));
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print)), [STARTED, CHROME_NOTE, CONNECTED]);
});

test("setup and start find node on the start script's PATH as that PATH names it, and refuse, with no change, when it holds none", () => {
  const m = machine();
  // A link to node, as a package manager keeps one (for example /opt/homebrew/bin/node): the start script names the
  // link, which still works after the package manager moves node to the folder of a new version.
  const linkBin = join(m.base, "link-bin");
  mkdirSync(linkBin);
  symlinkSync(process.execPath, join(linkBin, "node"));
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, { ...m.env, PATH: `${linkBin}:/usr/bin:/bin` }, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const run = readFileSync(join(dir, "run.sh"), "utf8");
  assert.ok(run.includes(`\n  ${q(join(linkBin, "node"))} ${q(script)} update-request --dir "$dir"`), run);

  // No node on that PATH.
  const empty = join(m.base, "empty-bin");
  mkdirSync(empty);
  const refusal = { message: `Node.js (\`node\`) is not on the PATH that the start script runs with (${empty}). Run setup again from a shell whose PATH holds node and claude.` };
  const other = machine();
  assert.throws(() => setup({ folder: other.folder, machine: "mac-mini-1", promptFile: other.prompt }, { ...other.env, PATH: empty }, () => {}), refusal);
  assert.equal(existsSync(serviceDir(other.env, "mac-mini-1")), false);
  // start reads the PATH of config.json.
  const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ ...config, path: empty }));
  stop("mac-mini-1", m.env, () => {});
  assert.throws(() => start("mac-mini-1", m.env, () => {}, { autoUpdate: false }), refusal);
  assert.equal(readFileSync(join(dir, "run.sh"), "utf8"), run);
  assert.equal(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).autoUpdate, true);
});

test("with self-update on, setup takes only an install of the plugin that applies in the folder of the repositories", () => {
  const m = machine();
  const otherFolder = join(m.base, "other-repos");
  mkdirSync(otherFolder);
  const local = (projectPath) => ({ ...listEntry(pluginRoot), scope: "local", projectPath });
  // Claude Code lists every folder's local install: here only one of another folder, which a session here does not load.
  writeFileSync(m.listFile, JSON.stringify([local(otherFolder)]));
  assert.throws(() => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {}), /names no install of it in this folder/);
  // Contrast: a local install of the folder of the repositories, beside the one of the other folder.
  writeFileSync(m.listFile, JSON.stringify([local(otherFolder), local(m.folder)]));
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  assert.ok(readFileSync(join(serviceDir(m.env, "mac-mini-1"), "run.sh"), "utf8").includes("--plugin 'doable-code-context@doable' --scope 'local'"));
});

test("status shows the version that Doable asked for while update-asked names one, and a release at or above it removes the file", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const file = join(dir, "update-asked");
  const askedLines = () => printedBy((print) => status("mac-mini-1", m.env, print)).filter((line) => line.startsWith("Doable asked"));
  assert.deepEqual(askedLines(), []);
  writeFileSync(file, "9.9.9\n");
  assert.deepEqual(askedLines(), [`Doable asked for the plugin 9.9.9 at ${statSync(file).mtime.toISOString()}: service.log says what the start script did.`]);
  // start of this release, which is lower than the asked one, keeps the file; at the asked version, start removes it.
  stop("mac-mini-1", m.env, () => {});
  start("mac-mini-1", m.env, () => {});
  assert.equal(readFileSync(file, "utf8"), "9.9.9\n");
  writeFileSync(file, `${RELEASE}\n`);
  start("mac-mini-1", m.env, () => {});
  assert.equal(existsSync(file), false);
  assert.deepEqual(askedLines(), []);
});
