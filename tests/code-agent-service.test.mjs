import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { maskSecrets } from "../plugins/doable-code-context/scripts/code-agent-page.mjs";
import {
  ASKED_WAIT,
  DEFAULT_PAGE_PORT,
  NEW_START_SCRIPT,
  PAGE_NOT_RUNNING,
  browser,
  checkPage,
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
  writeStartScript,
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
  assert.deepEqual(Object.keys(config).sort(), ["autoUpdate", "claude", "folder", "machine", "page", "pagePort", "path", "pluginDir", "wake"]);
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
// stops the start script's loop, or with `keepRunning` stays on as a session that serves, and ends with the exit code
// `code`. `launching` is the
// environment of a real launch: the start script runs in the background as on a machine without launchd (on a Mac
// too), and setup and start wait 2 seconds at most for the session's first wait for a request. A test that launches a
// start script and does not test the page sets it up with `page: false`: else its page would listen on the default
// port of this computer.
function servedMachine(output, { keepRunning = false, code = 0 } = {}) {
  const m = machine();
  const dir = serviceDir(m.env, "mac-mini-1");
  const outputFile = join(m.base, "output.jsonl");
  writeFileSync(outputFile, output);
  const claude = join(m.base, "fake-claude");
  const then = keepRunning ? "/bin/sleep 30" : `/usr/bin/touch '${join(dir, "stopped")}'`;
  // The plugin commands of the self-update before the session answer as for an installed plugin with no newer release.
  fakeClaude(claude, { list: `/bin/cat ${q(m.listFile)}`, session: `/bin/cat '${outputFile}'\n${then}\nexit ${code}` });
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
const readLogs = (dir) => `Read ${join(dir, "session.jsonl")} and ${join(dir, "service.log")}.`;
// What setup and start say when the session ended before its first wait for a request returned: at once, with its exit
// code, and with why when its output says it.
const endedBeforeWait = (dir, code, why = null) =>
  [`The session ended with code ${code} before it started to wait for requests.`, why, readLogs(dir)].filter((part) => part !== null).join(" ");

test("start says connected when the plugin's wait for a request returned, and reads past a line that is not JSON", () => {
  // The session's stderr goes to the same output.
  const m = servedMachine(`Warning: a line of stderr\n${WAITED}`);
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print)), [STARTED, CHROME_NOTE, CONNECTED]);
});

test("start does not count a wait of the session before the launch", () => {
  // session.jsonl keeps the output of the earlier sessions, with their waits and the results.
  const m = servedMachine(initLine());
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
  writeFileSync(join(m.dir, "session.jsonl"), WAITED);
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print)), [STARTED, CHROME_NOTE, endedBeforeWait(m.dir, 0)]);
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
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print)), [STARTED, CHROME_NOTE, endedBeforeWait(m.dir, 0)]);
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
    const printed = printedBy((print) => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.launching, print));
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
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print)), [
    STARTED,
    CHROME_NOTE,
    'It waits for Doable\'s requests through another Doable MCP server of your Claude Code settings (its tool mcp__doable__wait_for_code_agent_request), not through the plugin\'s server, so it does not use this setup\'s key and machine name. Remove that server (README, "With nobody at the terminal"), then run stop and start.',
  ]);
});

test("start reads all of the new output when the start script moved a large earlier output away", () => {
  const m = servedMachine(WAITED);
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
  // Larger than the 20 MB at which the start script moves the output to session.1.jsonl.
  writeFileSync(join(m.dir, "session.jsonl"), `${"x".repeat(20 * 1024 * 1024)}\n`);
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print)), [STARTED, CHROME_NOTE, CONNECTED]);
  assert.ok(existsSync(join(m.dir, "session.1.jsonl")));
});

// The output of `claude -p --output-format stream-json --verbose` when Claude Code is not signed in (the Linux check of
// 2026-11-27): the turn ends at once with an error result, and the session ends with code 1.
const NOT_SIGNED_IN = "Not logged in · Please run /login";
const NOT_SIGNED_IN_OUTPUT =
  initLine() +
  jsonLine({ type: "assistant", message: { content: [{ type: "text", text: NOT_SIGNED_IN }] } }) +
  jsonLine({ type: "result", subtype: "success", is_error: true, result: NOT_SIGNED_IN });
// Claude Code's refusal of the bypass mode for root, on stderr before any event (the same check).
const ROOT_REFUSAL = "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons";

test("setup and start say at once that the session ended before its first wait, with its exit code and the text of its result: Claude Code's error when Claude Code is not signed in, else its last message", () => {
  // A line of stderr before the events: the result's text comes first.
  let m = servedMachine(`Warning: a line of stderr\n${NOT_SIGNED_IN_OUTPUT}`, { code: 1 });
  // A wait longer than the time that the test allows: only the session's end ends it in time.
  let launching = { ...m.launching, DOABLE_CODE_AGENT_WAIT_S: "60" };
  const ended = endedBeforeWait(m.dir, 1, `Claude Code's error: "${NOT_SIGNED_IN}".`);
  const begun = Date.now();
  const atSetup = printedBy((print) => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, launching, print, maskSecrets));
  assert.ok(atSetup.includes(ended), atSetup.join("\n"));
  assert.ok(!atSetup.includes(CONNECTED), atSetup.join("\n"));
  assert.deepEqual(printedBy((print) => start("mac-mini-1", launching, print, {}, maskSecrets)), [STARTED, CHROME_NOTE, ended]);

  // A turn that ended with no error and no wait (for example the model found no Skill): its last message.
  const message = "I cannot find the doable-code-agent skill, so I cannot serve requests.";
  m = servedMachine(`${initLine()}${jsonLine({ type: "result", subtype: "success", is_error: false, result: message })}`);
  launching = { ...m.launching, DOABLE_CODE_AGENT_WAIT_S: "60" };
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
  assert.deepEqual(printedBy((print) => start("mac-mini-1", launching, print, {}, maskSecrets)), [
    STARTED,
    CHROME_NOTE,
    endedBeforeWait(m.dir, 0, `Its last message: "${message}".`),
  ]);
  assert.ok(Date.now() - begun < 30000, `${Date.now() - begun} ms`);
});

test("when the session's output has no result, setup and start give its last three lines that are no event, masked: at its end, and after the wait while it runs", (t) => {
  // Four lines of stderr, a half-written event, and a line with a URL's password and a Doable key.
  const stderr = [
    "Warning: an early line",
    "Fetching https://qa-bot:hunter2-secret@proxy.example.com/plugins",
    `\x1b[31mError: the key ${KEY} was not accepted\x1b[0m`,
    '{"type":"assistant","message":{"content":[',
    ROOT_REFUSAL,
  ].join("\n");
  const why = `The last lines of its output: "Fetching https://qa-bot:****@proxy.example.com/plugins | Error: the key sk-doable-**** was not accepted | ${ROOT_REFUSAL}".`;
  let m = servedMachine(`${stderr}\n`, { code: 1 });
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print, {}, maskSecrets)), [STARTED, CHROME_NOTE, endedBeforeWait(m.dir, 1, why)]);

  // The session runs, has written the same lines, and no wait returned in the wait (2 seconds here).
  m = servedMachine(`${initLine()}${stderr}\n`, { keepRunning: true });
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
  const pidFile = join(m.dir, "pid");
  t.after(() => existsSync(pidFile) && endGroup(readFileSync(pidFile, "utf8").trim()));
  const printed = printedBy((print) => start("mac-mini-1", m.launching, print, {}, maskSecrets));
  assert.deepEqual(printed, [STARTED, CHROME_NOTE, `It did not start to wait in 2 minutes. ${why} ${readLogs(m.dir)}`]);
  assert.ok(!printed.join("\n").includes("hunter2") && !printed.join("\n").includes(KEY), printed.join("\n"));
});

test("a session whose first wait returned stays connected, with no reason, also when it then ended with an error and wrote stderr", () => {
  // Contrast to the two tests above: the same error result and stderr line after the session's first wait.
  const m = servedMachine(`${WAITED}${ROOT_REFUSAL}\n${jsonLine({ type: "result", subtype: "success", is_error: true, result: NOT_SIGNED_IN })}`, { code: 1 });
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print, {}, maskSecrets)), [STARTED, CHROME_NOTE, CONNECTED]);
});

test("when Claude Code's error result has no text in `result`, setup and start give the texts of its `errors` as Claude Code's error", () => {
  // The result of a turn that failed while it ran: no `result`, its texts in `errors`, and no stderr.
  const errors = ["queryParams builder failed: no value for wait_seconds", "The turn ended before its first tool call."];
  let m = servedMachine(`${initLine()}${jsonLine({ type: "result", subtype: "error_during_execution", is_error: true, errors })}`, { code: 1 });
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print, {}, maskSecrets)), [
    STARTED,
    CHROME_NOTE,
    endedBeforeWait(m.dir, 1, `Claude Code's error: "queryParams builder failed: no value for wait_seconds | The turn ended before its first tool call.".`),
  ]);

  // Contrast: an error result with no text in `result` and none in `errors` says no reason.
  m = servedMachine(`${initLine()}${jsonLine({ type: "result", subtype: "error_during_execution", is_error: true, errors: [] })}`, { code: 1 });
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print, {}, maskSecrets)), [STARTED, CHROME_NOTE, endedBeforeWait(m.dir, 1)]);
});

test("setup and start mask the secrets in the text of the session's result, and cut a text over 500 characters", () => {
  // A proxy's address with a password, and a Doable key, in Claude Code's error.
  const error = `API Error: no connection through https://qa-bot:hunter2-secret@proxy.example.com/v1 with the key ${KEY}`;
  let m = servedMachine(`${initLine()}${jsonLine({ type: "result", subtype: "success", is_error: true, result: error })}`, { code: 1 });
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
  const printed = printedBy((print) => start("mac-mini-1", m.launching, print, {}, maskSecrets));
  assert.deepEqual(printed, [
    STARTED,
    CHROME_NOTE,
    endedBeforeWait(m.dir, 1, `Claude Code's error: "API Error: no connection through https://qa-bot:****@proxy.example.com/v1 with the key sk-doable-****".`),
  ]);

  // A last message of 507 characters: its first 500, then the ellipsis.
  const first = "x".repeat(500);
  m = servedMachine(`${initLine()}${jsonLine({ type: "result", subtype: "success", is_error: false, result: `${first} THE END` })}`);
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print, {}, maskSecrets)), [
    STARTED,
    CHROME_NOTE,
    endedBeforeWait(m.dir, 0, `Its last message: "${first}…".`),
  ]);
});

// The error of setup or start (`command`) as root.
const refusal = (command) => ({
  message: `Run ${command} as a normal user, not as root and not with sudo. The session runs in the bypass permission mode, which Claude Code refuses for root, so the session would never start. Use the account that is signed in to Claude Code on the Claude plan.`,
});

test("setup and start refuse at once to run as root, say why, and change nothing; as another user they go on", () => {
  const m = machine();
  const dir = serviceDir(m.env, "mac-mini-1");
  assert.throws(() => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, uid: 0 }, m.env, () => {}), refusal("setup"));
  assert.equal(existsSync(dir), false);
  // Contrast: the same setup as another user.
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, uid: 501 }, m.env, () => {});
  assert.ok(existsSync(join(dir, "run.sh")));

  stop("mac-mini-1", m.env, () => {});
  const before = "#!/bin/bash\n# the start script before\n";
  writeFileSync(join(dir, "run.sh"), before);
  assert.throws(() => start("mac-mini-1", m.env, () => {}, { uid: 0 }), refusal("start"));
  assert.equal(readFileSync(join(dir, "run.sh"), "utf8"), before);
  assert.ok(existsSync(join(dir, "stopped")));
  // Contrast: start as another user writes the start script again.
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.env, print, { uid: 501 })), [NOT_STARTED, CHROME_NOTE]);
  assert.match(readFileSync(join(dir, "run.sh"), "utf8"), sessionLine(quotedPattern(m.claude)));
});

test("on a machine without launchd, setup and start let root through in Claude Code's sandbox: IS_SANDBOX=1, or a CLAUDE_CODE_BUBBLEWRAP that is not empty", () => {
  // The start script gets the environment of setup and start there, so Claude Code sees the same values.
  for (const sandbox of [{ IS_SANDBOX: "1" }, { CLAUDE_CODE_BUBBLEWRAP: "1" }]) {
    const m = machine();
    const env = { ...m.env, DOABLE_CODE_AGENT_NO_LAUNCHD: "1", ...sandbox };
    const dir = serviceDir(env, "mac-mini-1");
    setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, uid: 0 }, env, () => {});
    assert.match(readFileSync(join(dir, "run.sh"), "utf8"), sessionLine(quotedPattern(m.claude)));
    assert.deepEqual(printedBy((print) => start("mac-mini-1", env, print, { uid: 0 })), [NOT_STARTED, CHROME_NOTE]);
  }
  // Contrast: values that Claude Code does not take as a sandbox.
  for (const other of [{ IS_SANDBOX: "true" }, { CLAUDE_CODE_BUBBLEWRAP: "" }]) {
    const m = machine();
    const env = { ...m.env, DOABLE_CODE_AGENT_NO_LAUNCHD: "1", ...other };
    assert.throws(() => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, uid: 0 }, env, () => {}), refusal("setup"));
    assert.equal(existsSync(serviceDir(env, "mac-mini-1")), false);
    assert.throws(() => start("mac-mini-1", env, () => {}, { uid: 0 }), refusal("start"));
  }
});

test(
  "on a Mac under launchd, setup and start refuse root also in Claude Code's sandbox: the launchd job does not get their environment",
  { skip: process.platform !== "darwin" && "launchd runs only on a Mac" },
  () => {
    const m = machine();
    // No key and no machine set up: if root were let through, setup and start would stop at their next check, before a
    // launch by launchd.
    const { DOABLE_CODE_AGENT_NO_LAUNCH: _noLaunch, DOABLE_API_KEY: _key, ...underLaunchd } = m.env;
    for (const sandbox of [{ IS_SANDBOX: "1" }, { CLAUDE_CODE_BUBBLEWRAP: "1" }]) {
      const env = { ...underLaunchd, ...sandbox };
      assert.throws(() => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, uid: 0 }, env, () => {}), refusal("setup"));
      assert.throws(() => start("mac-mini-1", env, () => {}, { uid: 0 }), refusal("start"));
      // Contrast: the same sandbox as on a machine without launchd lets root through to those checks.
      const withoutLaunchd = { ...env, DOABLE_CODE_AGENT_NO_LAUNCHD: "1" };
      assert.throws(() => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, uid: 0 }, withoutLaunchd, () => {}), {
        message: "Set DOABLE_API_KEY to an organization API key from Doable's Settings > MCP (it starts with sk-doable-, not sk-doable-personal-).",
      });
      assert.throws(() => start("mac-mini-1", withoutLaunchd, () => {}, { uid: 0 }), {
        message: 'No code agent "mac-mini-1" is set up on this machine: run setup first.',
      });
    }
    assert.equal(existsSync(serviceDir(m.env, "mac-mini-1")), false);
  },
);

test("on a machine without launchd, setup and start refuse while the session runs, but not after stop", () => {
  const m = servedMachine(WAITED, { keepRunning: true });
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
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
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
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
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
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
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
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

// Doable MCP's words when Doable needs a newer release. A client that passes only the text of the wait's answer gives
// the session these words alone.
const askText = (version) =>
  `Doable needs the plugin ${version} on this machine. End the session now, and call no other tool. An Always on service updates the plugin and starts the session again; in a session that a person started, the person updates the plugin and starts the session again.`;
// The same answer as Claude Code gives it to the session and writes it in the session's output: Doable MCP's structured
// content as compact JSON, with no request and the words in `update`.
const askAnswer = (version) => JSON.stringify({ request: null, capabilities_missing: false, update: askText(version) });
// A normal answer that holds a request whose text quotes those words: the asker's words, not Doable's ask.
const QUOTING_ANSWER = JSON.stringify({
  request: { id: "CA-ABC123", request: `Why does service.log say "${askText("9.9.9")}"? Explain it to me.` },
  capabilities_missing: false,
});
// That answer with Doable's words in `update` too: an answer that holds a request is never the ask, whatever it holds.
const REQUEST_WITH_UPDATE = JSON.stringify({ ...JSON.parse(QUOTING_ANSWER), update: askText("9.9.9") });
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
  const outputs = [QUOTING_ANSWER, askAnswer("9.9.9"), askAnswer("9.9.9"), '{"request":null,"capabilities_missing":false}'];
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
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, withFakeSleep(m, calls), () => {});
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
  writeFileSync(join(dir, "session.jsonl"), waitedWith("toolu_1", askAnswer("9.9.9")));
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
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, autoUpdate: false, page: false }, withFakeSleep(m, calls), () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  // The first session gets Doable's ask, and the second one ends the loop. No plugin command runs.
  writeFileSync(join(m.base, "output-1.jsonl"), waitedWith("toolu_1", askAnswer("9.9.9")));
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
  // The ask in the other forms: a JSON record with no `request` field, and the words alone (a client that passes only
  // the answer's text), as a list of text parts, after a blank line.
  for (const content of [JSON.stringify({ update: askText("9.9.9") }), [{ type: "text", text: `\n${askText("9.9.9")}` }]]) {
    writeFileSync(log, `${callLine("toolu_2")}${jsonLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_2", content }] } })}`);
    assert.deepEqual(step(0), { code: ASKED_WAIT, printed: [asked, needs("Self-update is off")] });
  }
  // Contrasts: the ask before the session's start (before `from`); an answer that holds a request whose text quotes
  // the words; that answer with the words in `update` too; a text that has the words after other words; a record with
  // no request whose `update` has the words after other words, or is not a text; the answer of a call that failed; and
  // the answer of another tool.
  const earlier = waitedWith("toolu_3", askAnswer("9.9.9"));
  writeFileSync(
    log,
    earlier +
      callLine("toolu_4") +
      resultLine("toolu_4", { text: QUOTING_ANSWER }) +
      callLine("toolu_5") +
      resultLine("toolu_5", { text: REQUEST_WITH_UPDATE }) +
      callLine("toolu_6") +
      resultLine("toolu_6", { text: `Note: ${askText("9.9.9")}` }) +
      callLine("toolu_7") +
      resultLine("toolu_7", { text: JSON.stringify({ request: null, capabilities_missing: false, update: `Note: ${askText("9.9.9")}` }) }) +
      callLine("toolu_8") +
      resultLine("toolu_8", { text: JSON.stringify({ request: null, capabilities_missing: false, update: [askText("9.9.9")] }) }) +
      callLine("toolu_9") +
      resultLine("toolu_9", { isError: true, text: askAnswer("9.9.9") }) +
      jsonLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_10", name: "Bash", input: { command: "cat notes" } }] } }) +
      resultLine("toolu_10", { text: askAnswer("9.9.9") }),
  );
  assert.deepEqual(step(Buffer.byteLength(earlier)), { code: 0, printed: [] });
  assert.deepEqual(step(0), { code: ASKED_WAIT, printed: [asked, needs("Self-update is off")] });
  // An ask for a release that is not above this one: the line, and no wait of 30 minutes.
  rmSync(join(dir, "update-asked"));
  writeFileSync(log, waitedWith("toolu_11", askAnswer(RELEASE)));
  assert.deepEqual(step(0), { code: 0, printed: [`Doable asked for the plugin ${RELEASE}; this release is ${RELEASE}.`] });
  assert.equal(existsSync(join(dir, "update-asked")), false);

  // A development plugin folder says so.
  const dev = machine();
  setup({ folder: dev.folder, machine: "mac-mini-1", promptFile: dev.prompt }, { ...dev.env, DOABLE_CODE_AGENT_PLUGIN_DIR: "/srv/dev/plugin" }, () => {});
  const devDir = serviceDir(dev.env, "mac-mini-1");
  writeFileSync(join(devDir, "session.jsonl"), waitedWith("toolu_1", askAnswer("9.9.9")));
  const printed = [];
  assert.equal(updateRequest({ dir: devDir, from: 0 }, { PATH: dev.env.PATH }, (line) => printed.push(line.replace(/^\S+ /, "")), maskSecrets), ASKED_WAIT);
  assert.deepEqual(printed, [asked, needs("The session loads the plugin from a development folder")]);
});

test("service.log holds the exit code of each serving session, not the code of the command that writes the time", () => {
  // In the line that the session ended, $? after $(date ...) is the code of date: 0 for each session.
  const m = machine();
  const calls = join(m.base, "calls");
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, withFakeSleep(m, calls), () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  // The first session ends with code 3; the second one with code 0, and it ends the loop.
  const count = q(join(m.base, "sessions"));
  fakeClaude(m.claude, {
    list: `/bin/cat ${q(m.listFile)}`,
    session: `n=$(( $(/bin/cat ${count} 2>/dev/null || echo 0) + 1 )); echo $n > ${count}
if [ $n = 2 ]; then /usr/bin/touch ${q(join(dir, "stopped"))}; exit 0; fi
exit 3`,
    calls,
  });
  writeFileSync(calls, "");
  execFileSync("/bin/bash", [join(dir, "run.sh")], { env: { PATH: "/usr/bin:/bin" }, stdio: "pipe", timeout: 60000 });
  assert.deepEqual(logLines(dir), [
    "the serving session starts",
    "the serving session ended with code 3",
    "the serving session starts",
    "the serving session ended with code 0",
  ]);
  // The code of the step after the session still chooses the wait: no ask, so 5 minutes.
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["session", "sleep 300", "session"]);
});

test("setup and start say that Doable needs a newer plugin, not that the session is connected, when its first wait got Doable's ask", () => {
  const asks = (next) => `Doable needs the plugin 9.9.9 on this machine, so the session ended at its first wait for a request. ${next}`;
  const updatesNow = asks("The start script updates the plugin now and starts the new release; service.log says how each step went.");
  // Self-update on: start says that the start script updates now.
  let m = servedMachine(waitedWith("toolu_1", askAnswer("9.9.9")));
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.launching, print)), [STARTED, CHROME_NOTE, updatesNow]);
  // Self-update off: setup says that a person updates. The answer is the words alone (a client that passes only the
  // answer's text).
  m = servedMachine(waitedWith("toolu_1", askText("9.9.9")));
  const printed = printedBy((print) => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, autoUpdate: false, page: false }, m.launching, print));
  assert.ok(
    printed.includes(
      asks(
        'Self-update is off: update the plugin by hand, then run stop and start (README, "Self-update"). Until then, a session starts every 30 minutes and ends at its first wait for a request.',
      ),
    ),
    printed.join("\n"),
  );
  assert.ok(!printed.includes(CONNECTED), printed.join("\n"));
  // Contrast: an answer that holds a request, with the same words in the request's text and in `update`. The session
  // waits for requests.
  m = servedMachine(waitedWith("toolu_1", REQUEST_WITH_UPDATE));
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false }, m.env, () => {});
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

// ---------------------------------------------------------------------------------------------------------------------
// The page that the start script runs next to the serving session
// ---------------------------------------------------------------------------------------------------------------------

const pageAddress = (port) => `http://127.0.0.1:${port}/`;
// What setup, and start with --page or --page-port, say about the page.
const pageOn = (port) =>
  `The page: ${pageAddress(port)}. It runs while the code agent runs, and stops with it (README, "The code agent's page"). Other computers cannot open it, but any account or program on this computer can, not only you. To turn it off, run stop, then start --machine mac-mini-1 --page off.`;
const PAGE_OFF = `The page is off. To turn it on, run stop, then start --machine mac-mini-1 --page on. To run it by hand until Ctrl-C: node ${script} page --machine mac-mini-1`;
// The start script's line that starts the page of this release, with the node of its PATH and the folder of all
// machines (launchd's environment does not hold DOABLE_CODE_AGENT_HOME).
const pageStartLine = (dir, port) =>
  `  DOABLE_CODE_AGENT_HOME=${q(dirname(dir))} ${q(NODE)} ${q(script)} page --machine 'mac-mini-1' --port ${port} --pid-file "$dir/page.pid" >> "$dir/page.log" 2>&1 &\n`;
const CHECK_PAGE = `  ${q(NODE)} ${q(script)} check-page --dir "$dir" >> "$dir/service.log" 2>&1\n  [ $? = 5 ] && start_page\n`;
const STOP_PAGE = `${q(NODE)} ${q(script)} stop-page --dir "$dir" >> "$dir/service.log" 2>&1\n`;
// The page's command line, as ps shows the page that a start script of this release started.
const pageCommand = (dir, port) => `${NODE} ${script} page --machine mac-mini-1 --port ${port} --pid-file ${join(dir, "page.pid")}`;
const notRunning = (port) =>
  `the page at ${pageAddress(port)} does not run (README, "The code agent's page"); the start script starts it again.`;
// What the page that the start script runs writes to page.log when its port is in use: the service's own steps.
const portInUse = (port) =>
  `Port ${port} is in use on this computer. Run stop, then start --machine mac-mini-1 --page-port <number>, or stop the program that uses the port.`;
// What status says of a page that is on and does not run while the code agent is stopped or not running.
const ONLY_WHILE_ON = (port) => `The page: on, at ${pageAddress(port)}; it runs only while the code agent runs.`;

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

// The session part of a fake `claude` for the page's tests: the n-th session runs the lines of the file
// `session-<n>.sh` of `base` when there is one, and the session `last` ends the start script's loop.
const sessionsWithLines = (base, dir, last) => {
  const count = q(join(base, "sessions"));
  return `n=$(( $(/bin/cat ${count} 2>/dev/null || echo 0) + 1 )); echo $n > ${count}
if [ -f ${q(base)}/session-$n.sh ]; then . ${q(base)}/session-$n.sh; fi
if [ $n = ${last} ]; then /usr/bin/touch ${q(join(dir, "stopped"))}; fi`;
};

// Lines of a session that write to `seen` what it sees of the page: the process id in page.pid, the HTTP status of the
// page's address, and the command line of that process.
const lookAtPage = (dir, port, seen) => `pid=$(/bin/cat ${q(join(dir, "page.pid"))})
code=$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' ${pageAddress(port)})
printf '%s\\t%s\\t%s\\n' "$pid" "$code" "$(/bin/ps -ww -o command= -p "$pid")" >> ${q(seen)}
`;

// Lines of a session that wait, up to 10 seconds, until the page answers 200. The start script waits for its first
// page to listen or end (check-page), but not for a page that it starts again right before a session.
const waitForPage = (port) => `i=0
while [ "$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' ${pageAddress(port)})" != 200 ] && [ $i -lt 100 ]; do /bin/sleep 0.1; i=$((i + 1)); done
`;

// Lines of a session that wait, up to 10 seconds, until the process of page.pid no longer runs a page.
const waitForPageEnd = (dir) => `i=0
while /bin/ps -ww -o command= -p "$(/bin/cat ${q(join(dir, "page.pid"))})" | /usr/bin/grep -q 'code-agent-service.mjs page' && [ $i -lt 100 ]; do /bin/sleep 0.1; i=$((i + 1)); done
`;

function looks(seen) {
  return readFileSync(seen, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, code, command] = line.split("\t");
      return { pid, code, command };
    });
}

// The state and the full command line (-ww: Linux's ps cuts it to COLUMNS) of the process `pid` as ps shows them, or
// null when no process has the pid. A process that ended and whose parent has not read its end yet (a zombie) has a
// state that starts with Z, and ps shows its command line as `<defunct>` on macOS and as `[node] <defunct>` on Linux.
function processRow(pid) {
  let row;
  try {
    row = execFileSync("ps", ["-ww", "-o", "stat=", "-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
  const [, state, command] = /^(\S+)\s*(.*)$/.exec(row);
  return { state, command };
}

// The command line of a process while it runs, else null: no process has the pid, or it ended and waits for its parent
// to read its end (a zombie). This test process reads the end of its own children only when its event loop runs, so a
// child of the test that a stop ended stays a zombie until the test's next await. On Linux, a process that is ending
// can show a state that is not Z yet (R, for example) with only its name in brackets as its command line (`[node]`):
// this waits for it, up to 5 seconds and with no await, until its state is Z or no process has the pid.
function commandOf(pid) {
  const until = Date.now() + 5000;
  let row = processRow(pid);
  while (row !== null && !row.state.startsWith("Z") && /^\[[^\]]*\]$/.test(row.command) && Date.now() < until) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    row = processRow(pid);
  }
  return row === null || row.state.startsWith("Z") ? null : row.command;
}

// Waits, with no await (at an await, this test process reads the end of its children), until the process `pid` of a
// child of this test has ended and waits for the test to read its end.
function untilZombie(pid) {
  const until = Date.now() + 10000;
  while (!processRow(pid)?.state.startsWith("Z")) {
    if (Date.now() > until) assert.fail(`process ${pid} did not end in 10 seconds`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

// Ends each page of these process ids that still runs, so that a failed assertion leaves no page on this computer.
function endPages(pids) {
  for (const pid of pids) {
    if (commandOf(pid)?.includes("code-agent-service.mjs page")) process.kill(Number(pid), "SIGKILL");
  }
}

function endPagesOf(dir, seen) {
  const pids = existsSync(seen) ? looks(seen).map((look) => look.pid) : [];
  if (existsSync(join(dir, "page.pid"))) pids.push(readFileSync(join(dir, "page.pid"), "utf8").trim());
  endPages(pids);
}

// A process whose command line is the page command of `machineName`, as ps shows it: node, waiting, with the words of
// the page command as its arguments. It serves nothing: only its command line counts.
function processWithCommand(t, machineName) {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", "/srv/plugin/scripts/code-agent-service.mjs", "page", "--machine", machineName, "--port", "47615"],
    { stdio: "ignore" },
  );
  t.after(() => child.kill("SIGKILL"));
  return child;
}

// Waits until the page at `port` answers 200.
async function answered(port) {
  const until = Date.now() + 10000;
  for (;;) {
    const code = await new Promise((done) => {
      const sent = httpRequest({ host: "127.0.0.1", port, path: "/" }, (response) => {
        response.resume();
        done(response.statusCode);
      });
      sent.on("error", () => done(null));
      sent.end();
    });
    if (code === 200) return;
    if (Date.now() > until) assert.fail(`nothing answered 200 at port ${port}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

test("setup turns the page on at port 47615 and says its address, who can open it and how to turn it off; start keeps or changes the choice; status shows it", () => {
  const m = machine();
  const atSetup = printedBy((print) => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, print));
  assert.ok(atSetup.includes(pageOn(47615)), atSetup.join("\n"));
  assert.equal(DEFAULT_PAGE_PORT, 47615);
  const dir = serviceDir(m.env, "mac-mini-1");
  const run = () => readFileSync(join(dir, "run.sh"), "utf8");
  const saved = () => {
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    return [config.page, config.pagePort];
  };
  assert.deepEqual(saved(), [true, 47615]);
  // Before the loop it stops a page that an earlier start script started, then starts its own; it checks the page
  // before each session's start; and after the loop it stops the page.
  assert.ok(run().includes(pageStartLine(dir, 47615)), run());
  // The page's process id goes in place of page.pid by a rename: check-page and stop never read an emptied file.
  assert.ok(run().includes(`${pageStartLine(dir, 47615)}  echo $! > "$dir/page.pid.start"\n  mv -f "$dir/page.pid.start" "$dir/page.pid"\n`), run());
  assert.ok(run().includes(`${STOP_PAGE}[ -e "$dir/stopped" ] || start_page\nwhile [ ! -e "$dir/stopped" ]; do\n`), run());
  assert.ok(run().includes(CHECK_PAGE), run());
  assert.ok(run().indexOf(CHECK_PAGE) < run().indexOf("the serving session starts"), run());
  assert.ok(run().endsWith(`done\n${STOP_PAGE}`), run());
  execFileSync("bash", ["-n", join(dir, "run.sh")]);
  const pageLine = () => printedBy((print) => status("mac-mini-1", m.env, print)).find((line) => line.startsWith("The page"));
  // Nothing was launched: the code agent does not run.
  assert.equal(pageLine(), ONLY_WHILE_ON(47615));

  // start --page off: kept in config.json and said. The start script starts and checks no page, but still stops one
  // that an earlier start script started.
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.env, print, { page: false })), [NOT_STARTED, CHROME_NOTE, PAGE_OFF]);
  assert.deepEqual(saved(), [false, 47615]);
  assert.ok(!run().includes("page --machine") && !run().includes("check-page"), run());
  assert.ok(run().includes(`${STOP_PAGE}while [ ! -e "$dir/stopped" ]; do\n`) && run().endsWith(`done\n${STOP_PAGE}`), run());
  execFileSync("bash", ["-n", join(dir, "run.sh")]);
  assert.equal(pageLine(), "The page: off. To turn it on, run stop, then start --machine mac-mini-1 --page on.");
  // start without the options keeps the choice, and says nothing of it.
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.env, print)), [NOT_STARTED, CHROME_NOTE]);
  assert.deepEqual(saved(), [false, 47615]);
  assert.deepEqual(printedBy((print) => start("mac-mini-1", m.env, print, { page: true, pagePort: 48001 })), [NOT_STARTED, CHROME_NOTE, pageOn(48001)]);
  assert.deepEqual(saved(), [true, 48001]);
  assert.ok(run().includes(pageStartLine(dir, 48001)), run());
  start("mac-mini-1", m.env, () => {});
  assert.deepEqual(saved(), [true, 48001]);

  // A config.json of plugin 0.6.3 has no page keys: write-start-script, which 0.6.3's self-update runs from this
  // release's folder, writes a start script with the page on at 47615.
  const { page: _page, pagePort: _pagePort, ...config063 } = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(config063));
  writeStartScript({ dir }, m.env);
  assert.ok(run().includes(pageStartLine(dir, 47615)) && run().includes(CHECK_PAGE), run());

  // setup with --page off.
  const other = machine();
  const off = printedBy((print) => setup({ folder: other.folder, machine: "mac-mini-1", promptFile: other.prompt, page: false }, other.env, print));
  assert.ok(off.includes(PAGE_OFF), off.join("\n"));
  assert.ok(!off.includes(pageOn(47615)), off.join("\n"));

  // The command line takes on or off, and a port from 1 to 65535.
  assert.deepEqual(parseArgs(["start", "--machine", "m", "--page", "off", "--page-port", "48001"]).options, { machine: "m", page: false, pagePort: 48001 });
  assert.throws(() => parseArgs(["start", "--page", "no"]), /^Error: --page must be on or off\.$/);
  assert.throws(() => parseArgs(["setup", "--page-port", "0"]), /^Error: --page-port must be a whole number from 1 to 65535\.$/);
});

test("the start script runs the page of its release next to the session, starts it again when it ended, and stops it when its loop ends", { timeout: 60000 }, async (t) => {
  const m = machine();
  const port = await freePort();
  const dir = serviceDir(m.env, "mac-mini-1");
  const calls = join(m.base, "calls");
  const seen = join(m.base, "seen");
  t.after(() => endPagesOf(dir, seen));
  // The first session looks at the page and kills it, as a crash would; the second one looks at it again, once it
  // answers.
  writeFileSync(join(m.base, "session-1.sh"), `${lookAtPage(dir, port, seen)}kill -9 "$pid"\n`);
  writeFileSync(join(m.base, "session-2.sh"), `${waitForPage(port)}${lookAtPage(dir, port, seen)}`);
  fakeClaude(m.claude, { list: `/bin/cat ${q(m.listFile)}`, session: sessionsWithLines(m.base, dir, 2), calls });
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, pagePort: port }, withFakeSleep(m, calls), () => {});
  writeFileSync(calls, "");
  execFileSync("/bin/bash", [join(dir, "run.sh")], { env: { PATH: "/usr/bin:/bin" }, stdio: "pipe", timeout: 60000 });

  const [first, second] = looks(seen);
  assert.deepEqual([first.code, first.command], ["200", pageCommand(dir, port)]);
  assert.deepEqual([second.code, second.command], ["200", pageCommand(dir, port)]);
  assert.notEqual(second.pid, first.pid);
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["session", "sleep 300", "session"]);
  const started = `the page starts at ${pageAddress(port)}`;
  const session = ["the serving session starts", "the serving session ended with code 0"];
  const logged = logLines(dir);
  assert.deepEqual(logged.slice(0, 3), [started, ...session]);
  // The page's own lines are the last lines of its page.log: it was killed, and wrote no error.
  const ended = `${notRunning(port)} The last lines of page.log: The page of the code agent "mac-mini-1": ${pageAddress(port)} | Other computers cannot open it`;
  assert.ok(logged[3].startsWith(ended), logged[3]);
  assert.deepEqual(logged.slice(4), [started, ...session, `the page (process ${second.pid}) stopped.`]);
  // After the loop, no page runs.
  assert.equal(existsSync(join(dir, "page.pid")), false);
  assert.deepEqual([commandOf(first.pid), commandOf(second.pid)], [null, null]);
});

test("a page whose port is in use never keeps the session from its start: service.log says why before each start", { timeout: 60000 }, async (t) => {
  const m = machine();
  const taken = createServer();
  await new Promise((done) => taken.listen(0, "127.0.0.1", done));
  t.after(() => taken.close());
  const port = taken.address().port;
  const dir = serviceDir(m.env, "mac-mini-1");
  const calls = join(m.base, "calls");
  t.after(() => endPagesOf(dir, join(m.base, "seen")));
  // The last session waits until the page that the start script started again before it has ended, so that the loop's
  // end finds no page to stop.
  writeFileSync(join(m.base, "session-2.sh"), waitForPageEnd(dir));
  fakeClaude(m.claude, { list: `/bin/cat ${q(m.listFile)}`, session: sessionsWithLines(m.base, dir, 2), calls });
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, pagePort: port }, withFakeSleep(m, calls), () => {});
  writeFileSync(calls, "");
  execFileSync("/bin/bash", [join(dir, "run.sh")], { env: { PATH: "/usr/bin:/bin" }, stdio: "pipe", timeout: 60000 });

  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["session", "sleep 300", "session"]);
  const started = `the page starts at ${pageAddress(port)}`;
  // The page's words name the service's option (--page-port of start), not the page command's --port.
  const inUse = `${notRunning(port)} The last lines of page.log: ${portInUse(port)}`;
  const session = ["the serving session starts", "the serving session ended with code 0"];
  // The page that could not start is said before the first session too: check-page waits for a page that has just
  // started to listen or to end.
  assert.deepEqual(logLines(dir), [started, inUse, started, ...session, inUse, started, ...session]);
  assert.equal(existsSync(join(dir, "page.pid")), false);
});

test("a new start script, as after a self-update's exec, stops the page that an earlier one started from another release's folder, and starts its own", { timeout: 60000 }, async (t) => {
  const m = machine();
  const port = await freePort();
  const dir = serviceDir(m.env, "mac-mini-1");
  const calls = join(m.base, "calls");
  const seen = join(m.base, "seen");
  t.after(() => endPagesOf(dir, seen));
  writeFileSync(join(m.base, "session-1.sh"), lookAtPage(dir, port, seen));
  fakeClaude(m.claude, { list: `/bin/cat ${q(m.listFile)}`, session: sessionsWithLines(m.base, dir, 1), calls });
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, pagePort: port }, withFakeSleep(m, calls), () => {});
  // The page that the start script of an older release started: from that release's folder, on the same port, with its
  // process id in page.pid.
  const older = join(m.base, "plugins", "cache", "doable", "doable-code-context", "0.6.3");
  cpSync(pluginRoot, older, { recursive: true });
  const earlier = spawn(process.execPath, [join(older, "scripts", "code-agent-service.mjs"), "page", "--machine", "mac-mini-1", "--port", String(port)], {
    env: m.env,
    stdio: "ignore",
  });
  t.after(() => earlier.kill("SIGKILL"));
  writeFileSync(join(dir, "page.pid"), `${earlier.pid}\n`);
  await answered(port);
  assert.ok(commandOf(earlier.pid).includes(join(older, "scripts", "code-agent-service.mjs")));
  execFileSync("/bin/bash", [join(dir, "run.sh")], { env: { PATH: "/usr/bin:/bin" }, stdio: "pipe", timeout: 60000 });

  const [look] = looks(seen);
  assert.equal(commandOf(earlier.pid), null);
  assert.deepEqual([look.code, look.command], ["200", pageCommand(dir, port)]);
  assert.notEqual(look.pid, String(earlier.pid));
  assert.deepEqual(logLines(dir), [
    `the page (process ${earlier.pid}) stopped.`,
    `the page starts at ${pageAddress(port)}`,
    "the serving session starts",
    "the serving session ended with code 0",
    `the page (process ${look.pid}) stopped.`,
  ]);
});

test("stop and remove stop the page of page.pid only when its process runs this machine's page command, and status says whether it runs", (t) => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const pageLine = () => printedBy((print) => status("mac-mini-1", m.env, print)).find((line) => line.startsWith("The page"));
  const notNow = ONLY_WHILE_ON(47615);
  // The page of another machine whose name starts with this one's: the process id of page.pid can be reused.
  const other = processWithCommand(t, "mac-mini-10");
  writeFileSync(join(dir, "page.pid"), `${other.pid}\n`);
  assert.equal(pageLine(), notNow);
  stop("mac-mini-1", m.env, () => {});
  assert.match(commandOf(other.pid), / page --machine mac-mini-10 --port 47615$/);
  assert.equal(existsSync(join(dir, "page.pid")), false);

  // This machine's page: status says that it runs, and stop ends it.
  const own = processWithCommand(t, "mac-mini-1");
  writeFileSync(join(dir, "page.pid"), `${own.pid}\n`);
  assert.equal(pageLine(), `The page: on, at ${pageAddress(47615)}; it runs now.`);
  stop("mac-mini-1", m.env, () => {});
  assert.equal(commandOf(own.pid), null);
  assert.equal(pageLine(), notNow);

  // remove ends it too.
  start("mac-mini-1", m.env, () => {});
  const again = processWithCommand(t, "mac-mini-1");
  writeFileSync(join(dir, "page.pid"), `${again.pid}\n`);
  remove("mac-mini-1", m.env, () => {});
  assert.equal(commandOf(again.pid), null);
  assert.equal(existsSync(dir), false);
  assert.notEqual(commandOf(other.pid), null);
});

test("check-page says in one masked line that the page does not run, with the end of page.log, and says nothing while it runs", (t) => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const check = () => {
    const printed = [];
    const code = checkPage({ dir }, (line) => printed.push(line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ /, "")), maskSecrets);
    return { code, printed };
  };
  // page.pid names a process that is not a page (this test's), and page.log ends with an error that holds a URL's
  // password and a Doable key.
  writeFileSync(join(dir, "page.pid"), `${process.pid}\n`);
  writeFileSync(
    join(dir, "page.log"),
    `The page of the code agent "mac-mini-1": ${pageAddress(47615)}\nError: could not read https://qa-bot:hunter2-secret@git.example.com/x.git\n    at read (${KEY})\n`,
  );
  assert.deepEqual(check(), {
    code: PAGE_NOT_RUNNING,
    printed: [
      `${notRunning(47615)} The last lines of page.log: The page of the code agent "mac-mini-1": ${pageAddress(47615)} | Error: could not read https://qa-bot:****@git.example.com/x.git | at read (sk-doable-****)`,
    ],
  });
  rmSync(join(dir, "page.log"));
  assert.deepEqual(check(), { code: PAGE_NOT_RUNNING, printed: [`${notRunning(47615)} Its page.log is empty.`] });

  // Contrast: a process that runs this machine's page command, whose page.log has the page's address line.
  const own = processWithCommand(t, "mac-mini-1");
  writeFileSync(join(dir, "page.pid"), `${own.pid}\n`);
  writeFileSync(join(dir, "page.log"), `The page of the code agent "mac-mini-1": ${pageAddress(47615)}\n`);
  assert.deepEqual(check(), { code: 0, printed: [] });
});

// What setup and start say of a page that does not run after the launch.
const pageNotRunning = (port, why) =>
  `The page at ${pageAddress(port)} does not run now. ${why} The code agent serves all the same, and its start script starts the page again before each session (README, "The code agent's page"). Other computers cannot open it, but any account or program on this computer can, not only you. To turn it off, run stop, then start --machine mac-mini-1 --page off.`;

// The processes that run the page command of mac-mini-1 at `port`: node, or a program that runs node.
function pageProcesses(port) {
  return execFileSync("ps", ["-A", "-ww", "-o", "pid=", "-o", "command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+)\s(.*)$/.exec(line))
    .filter((row) => row !== null && row[2].includes(`code-agent-service.mjs page --machine mac-mini-1 --port ${port} `))
    .map((row) => ({ pid: row[1], command: row[2] }));
}

// The child of `pid` once its command line holds `text` (a child of bash runs bash's command line until its exec).
async function childOf(pid, text) {
  const until = Date.now() + 10000;
  for (;;) {
    const row = execFileSync("ps", ["-A", "-ww", "-o", "pid=", "-o", "ppid=", "-o", "command="], { encoding: "utf8" })
      .split("\n")
      .map((line) => /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line))
      .find((one) => one !== null && one[2] === String(pid) && one[3].includes(text));
    if (row !== undefined) return Number(row[1]);
    if (Date.now() > until) assert.fail(`process ${pid} has no child that runs ${text}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

// A version manager's shim at `path`: a program named node that runs node as its child (no exec), and passes no signal
// on to it.
function writeShim(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/bash\n${q(NODE)} "$@"\n`, { mode: 0o700 });
}

test("setup and start refuse the page command's --port and name --page-port, and each command refuses an option of another command", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, pagePort: 48001 }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const files = () => ["config.json", "run.sh"].map((name) => readFileSync(join(dir, name), "utf8"));
  const before = files();
  const refused = (args) => {
    try {
      execFileSync(process.execPath, [script, ...args], { stdio: "pipe", env: m.env });
    } catch (error) {
      return { status: error.status, stderr: error.stderr.toString() };
    }
    assert.fail(`${args.join(" ")} did not fail`);
  };
  // The words of a page whose port is in use named --port: start took it with no error and kept the page's port.
  assert.deepEqual(refused(["start", "--machine", "mac-mini-1", "--port", "47700"]), {
    status: 1,
    stderr: "start does not take --port: it takes --machine, --auto-update, --page, --page-port. The page's port is --page-port <number>.\n",
  });
  assert.deepEqual(refused(["setup", "--folder", m.folder, "--machine", "mac-mini-1", "--prompt-file", m.prompt, "--port", "47700"]), {
    status: 1,
    stderr: "setup does not take --port: it takes --folder, --machine, --prompt-file, --auto-update, --page, --page-port. The page's port is --page-port <number>.\n",
  });
  assert.deepEqual(files(), before);
  assert.throws(() => parseArgs(["page", "--machine", "m", "--page-port", "47700"]), /^Error: page does not take --page-port: it takes --machine, --port, --pid-file\.$/);
  assert.throws(() => parseArgs(["status", "--machine", "m", "--page", "off"]), /^Error: status does not take --page: it takes --machine\.$/);
  assert.throws(() => parseArgs(["browser", "--machine", "m"]), /^Error: browser does not take --machine: it takes no option\.$/);
  // Contrast: each command takes its own options.
  assert.deepEqual(parseArgs(["start", "--machine", "m", "--page-port", "47700"]).options, { machine: "m", pagePort: 47700 });
  assert.deepEqual(parseArgs(["page", "--machine", "m", "--port", "47700", "--pid-file", "/srv/m/page.pid"]).options, {
    machine: "m",
    port: 47700,
    pidFile: "/srv/m/page.pid",
  });
  assert.deepEqual(parseArgs(["stop-page", "--dir", "/srv/m"]).options, { dir: "/srv/m" });
});

test("setup and start look at the page after the launch, and say why it does not run, with the service's option to move it", { timeout: 90000 }, async (t) => {
  const m = servedMachine(WAITED, { keepRunning: true });
  // A wait longer than the start script's steps before its first session, which run node four times.
  const launching = { ...m.launching, DOABLE_CODE_AGENT_WAIT_S: "20" };
  const taken = createServer();
  await new Promise((done) => taken.listen(0, "127.0.0.1", done));
  const port = taken.address().port;
  const pids = [];
  t.after(() => {
    if (taken.listening) taken.close();
    for (const pid of pids) endGroup(pid);
    endPages(pageProcesses(port).map((row) => row.pid));
  });
  // Each launch's pid, kept before any assertion, so that the test ends each script that it launched.
  const launched = (command) => {
    const printed = printedBy(command);
    pids.push(readFileSync(join(m.dir, "pid"), "utf8").trim());
    return printed;
  };
  const inUse = pageNotRunning(port, `The last lines of page.log: ${portInUse(port)}`);
  const atSetup = launched((print) => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, pagePort: port }, launching, print));
  assert.ok(atSetup.includes(inUse), atSetup.join("\n"));
  assert.ok(!atSetup.includes(pageOn(port)), atSetup.join("\n"));
  // start says it with no option too.
  stop("mac-mini-1", launching, () => {});
  assert.deepEqual(
    launched((print) => start("mac-mini-1", launching, print)),
    [STARTED, CHROME_NOTE, CONNECTED, inUse],
  );

  // Contrast: with the port free, start says nothing of the page, and status says that it runs.
  stop("mac-mini-1", launching, () => {});
  await new Promise((done) => taken.close(done));
  assert.deepEqual(launched((print) => start("mac-mini-1", launching, print)), [STARTED, CHROME_NOTE, CONNECTED]);
  const pageLine = printedBy((print) => status("mac-mini-1", launching, print)).find((line) => line.startsWith("The page"));
  assert.equal(pageLine, `The page: on, at ${pageAddress(port)}; it runs now.`);
  stop("mac-mini-1", launching, () => {});
});

test("a start script that starts after stop, as launchd runs it at each login, starts no page and keeps page.log", { timeout: 60000 }, async (t) => {
  const m = machine();
  const port = await freePort();
  const dir = serviceDir(m.env, "mac-mini-1");
  t.after(() => endPages(pageProcesses(port).map((row) => row.pid)));
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, pagePort: port }, m.env, () => {});
  stop("mac-mini-1", m.env, () => {});
  // The reason why the page of the last run ended, which check-page had not read yet.
  writeFileSync(join(dir, "page.log"), "Error: the reason of the last run\n");
  execFileSync("/bin/bash", [join(dir, "run.sh")], { env: { PATH: "/usr/bin:/bin" }, stdio: "pipe", timeout: 60000 });
  assert.equal(readFileSync(join(dir, "service.log"), "utf8"), "");
  assert.equal(readFileSync(join(dir, "page.log"), "utf8"), "Error: the reason of the last run\n");
  assert.equal(existsSync(join(dir, "page.pid")), false);
});

test("status says why the page does not run: the code agent is stopped or not running, the logs while it is on, or a start script of an older release", (t) => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const lines = () => printedBy((print) => status("mac-mini-1", m.env, print)).filter((line) => /^(Code agent|The page)/.test(line));
  // Nothing was launched, then stop: neither log says why, because the page runs only while the code agent runs.
  assert.deepEqual(lines(), ['Code agent "mac-mini-1": not running.', ONLY_WHILE_ON(47615)]);
  stop("mac-mini-1", m.env, () => {});
  assert.deepEqual(lines(), ['Code agent "mac-mini-1": stopped.', ONLY_WHILE_ON(47615)]);

  // The code agent is on (the pid file names a process of its start script), and its page does not run.
  rmSync(join(dir, "stopped"));
  const running = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", join(dir, "run.sh")], { stdio: "ignore" });
  t.after(() => running.kill("SIGKILL"));
  writeFileSync(join(dir, "pid"), `${running.pid}\n`);
  assert.deepEqual(lines(), [
    'Code agent "mac-mini-1": on.',
    `The page: on, at ${pageAddress(47615)}; it does not run now (service.log and ${join(dir, "page.log")} say why).`,
  ]);

  // A person updated the plugin by hand and did not run stop and start: the start script of the older release runs no
  // page, while its config.json, with no page keys, means on.
  writeFileSync(join(dir, "run.sh"), runScript({ dir, folder: m.folder, claude: m.claude, path: m.env.PATH, wake: false }));
  const { page: _page, pagePort: _pagePort, ...older } = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(older));
  assert.deepEqual(lines(), [
    'Code agent "mac-mini-1": on.',
    `The page: on, at ${pageAddress(47615)}, but the start script of this machine is from an older release, which runs no page. To start the page, run stop, then start --machine mac-mini-1 (a self-update starts it too).`,
  ]);
});

test("setup again keeps the page's choice of config.json unless an option changes it", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, page: false, pagePort: 48001 }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const saved = () => {
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    return [config.page, config.pagePort];
  };
  assert.deepEqual(saved(), [false, 48001]);
  // The README's way to change the folder or the key: stop, then the setup again with the saved prompt, and no option
  // of the page.
  stop("mac-mini-1", m.env, () => {});
  const again = printedBy((print) => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: join(dir, "prompt.md") }, m.env, print));
  assert.deepEqual(saved(), [false, 48001]);
  assert.ok(again.includes(PAGE_OFF), again.join("\n"));
  assert.ok(!readFileSync(join(dir, "run.sh"), "utf8").includes("start_page"));
  // An option changes the choice, and the port stays.
  const on = printedBy((print) => setup({ folder: m.folder, machine: "mac-mini-1", promptFile: join(dir, "prompt.md"), page: true }, m.env, print));
  assert.deepEqual(saved(), [true, 48001]);
  assert.ok(on.includes(pageOn(48001)), on.join("\n"));
});

test("with a node on the start script's PATH that runs node as its child, page.pid names the page that listens, and the stop at the loop's end ends it", { timeout: 60000 }, async (t) => {
  const m = machine();
  const port = await freePort();
  const dir = serviceDir(m.env, "mac-mini-1");
  const calls = join(m.base, "calls");
  const seen = join(m.base, "seen");
  t.after(() => endPages(pageProcesses(port).map((row) => row.pid)));
  const shimBin = join(m.base, "shim-bin");
  writeShim(join(shimBin, "node"));
  writeFileSync(join(m.base, "session-1.sh"), lookAtPage(dir, port, seen));
  fakeClaude(m.claude, { list: `/bin/cat ${q(m.listFile)}`, session: sessionsWithLines(m.base, dir, 1), calls });
  setup(
    { folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, pagePort: port },
    withFakeSleep({ ...m, env: { ...m.env, PATH: `${shimBin}:${m.env.PATH}` } }, calls),
    () => {},
  );
  assert.ok(readFileSync(join(dir, "run.sh"), "utf8").includes(`${q(join(shimBin, "node"))} ${q(script)} page --machine`));
  execFileSync("/bin/bash", [join(dir, "run.sh")], { env: { PATH: "/usr/bin:/bin" }, stdio: "pipe", timeout: 60000 });

  // The session saw node itself in page.pid, not the shim: the page wrote its own process id.
  const [look] = looks(seen);
  assert.deepEqual([look.code, look.command], ["200", pageCommand(dir, port)]);
  // After the loop, no process runs the page: neither node nor the shim, which ends after its child.
  const until = Date.now() + 5000;
  while (pageProcesses(port).length > 0 && Date.now() < until) await new Promise((done) => setTimeout(done, 100));
  assert.deepEqual(pageProcesses(port), []);
});

test("stop also ends the page that a program in page.pid runs as its child, when that program passes no signal on", async (t) => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const shim = join(m.base, "shim", "node");
  writeShim(shim);
  // page.pid names the shim when the start script's write of `$!` comes after the page's own write.
  const args = ["-e", "setInterval(() => {}, 1000)", "/srv/plugin/scripts/code-agent-service.mjs", "page", "--machine", "mac-mini-1", "--port", "47615"];
  const wrapper = spawn(shim, args, { stdio: "ignore" });
  const child = await childOf(wrapper.pid, "page --machine mac-mini-1 --port 47615");
  t.after(() => endPages([wrapper.pid, child]));
  writeFileSync(join(dir, "page.pid"), `${wrapper.pid}\n`);
  stop("mac-mini-1", m.env, () => {});
  assert.deepEqual([commandOf(wrapper.pid), commandOf(child)], [null, null]);
});

test("with COLUMNS in the environment, whose width Linux's ps cuts a command line to, status, check-page and stop-page still find the start script and the page that run", async (t) => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const narrow = { ...m.env, COLUMNS: "40" };
  // The code agent is on: the pid file names a process of its start script.
  const startScript = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", join(dir, "run.sh")], { stdio: "ignore" });
  t.after(() => startScript.kill("SIGKILL"));
  writeFileSync(join(dir, "pid"), `${startScript.pid}\n`);
  // page.pid names a program that runs the page as its child (a version manager's shim), and the page listens.
  const shim = join(m.base, "shim", "node");
  writeShim(shim);
  const args = ["-e", "setInterval(() => {}, 1000)", "/srv/plugin/scripts/code-agent-service.mjs", "page", "--machine", "mac-mini-1", "--port", "47615"];
  const wrapper = spawn(shim, args, { stdio: "ignore" });
  const child = await childOf(wrapper.pid, "page --machine mac-mini-1 --port 47615");
  t.after(() => endPages([wrapper.pid, child]));
  writeFileSync(join(dir, "page.pid"), `${wrapper.pid}\n`);
  writeFileSync(join(dir, "page.log"), `The page of the code agent "mac-mini-1": ${pageAddress(47615)}\n`);
  // Contrast: on Linux, ps without -ww cuts each of their command lines to 40 characters, also into a pipe, and so cuts
  // off the words by which the service knows them. macOS's ps prints the full line into a pipe whatever COLUMNS says,
  // so on macOS this test passes with or without -ww, and only its run on Linux proves the fix.
  if (process.platform === "linux") {
    const cut = (pid) => execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", env: narrow }).trimEnd();
    assert.deepEqual(
      [cut(startScript.pid), cut(wrapper.pid), cut(child)].map((line) => [line.length, line.includes("run.sh") || line.includes(" page --machine ")]),
      [[40, false], [40, false], [40, false]],
    );
  }

  const run = (words) => spawnSync(process.execPath, [script, ...words], { encoding: "utf8", env: narrow });
  const said = run(["status", "--machine", "mac-mini-1"]).stdout.split("\n").filter((line) => /^(Code agent|The page)/.test(line));
  assert.deepEqual(said, ['Code agent "mac-mini-1": on.', `The page: on, at ${pageAddress(47615)}; it runs now.`]);
  const checked = run(["check-page", "--dir", dir]);
  assert.deepEqual([checked.status, checked.stdout], [0, ""]);
  // stop-page ends the program of page.pid and its child, the page (pageChildren).
  const stopped = run(["stop-page", "--dir", dir]);
  assert.match(stopped.stdout, new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ the page \\(processes ${wrapper.pid} and ${child}\\) stopped\\.\\n$`));
  assert.deepEqual([commandOf(wrapper.pid), commandOf(child)], [null, null]);
});

test("a start script and a page that ended, and whose parent has not read their end yet (a zombie), do not run for status, check-page and stop-page", (t) => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const lines = () => printedBy((print) => status("mac-mini-1", m.env, print)).filter((line) => /^(Code agent|The page)/.test(line));
  // This test process is the parent of both, and it has no await: it does not read their end.
  const startScript = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", join(dir, "run.sh")], { stdio: "ignore" });
  t.after(() => startScript.kill("SIGKILL"));
  writeFileSync(join(dir, "pid"), `${startScript.pid}\n`);
  const page = processWithCommand(t, "mac-mini-1");
  writeFileSync(join(dir, "page.pid"), `${page.pid}\n`);
  writeFileSync(join(dir, "page.log"), `The page of the code agent "mac-mini-1": ${pageAddress(47615)}\n`);
  // Contrast: while they run, the code agent is on and its page runs.
  assert.deepEqual(lines(), ['Code agent "mac-mini-1": on.', `The page: on, at ${pageAddress(47615)}; it runs now.`]);
  assert.equal(checkPage({ dir }, () => {}, maskSecrets), 0);

  startScript.kill("SIGKILL");
  page.kill("SIGKILL");
  untilZombie(startScript.pid);
  untilZombie(page.pid);
  assert.deepEqual(lines(), ['Code agent "mac-mini-1": not running.', ONLY_WHILE_ON(47615)]);
  assert.equal(checkPage({ dir }, () => {}, maskSecrets), PAGE_NOT_RUNNING);
  // stop-page finds no page to stop: it prints no line and does not wait.
  assert.equal(execFileSync(process.execPath, [script, "stop-page", "--dir", dir], { encoding: "utf8", env: m.env }), "");
  assert.equal(existsSync(join(dir, "page.pid")), false);
  // Both stayed zombies through each look.
  assert.deepEqual([processRow(startScript.pid)?.state[0], processRow(page.pid)?.state[0]], ["Z", "Z"]);
});

// The command line of the page that the start script of 0.6.4 starts, word for word but for its node and its folders.
// After a self-update's exec, the start script of each later release must stop such a page: keep this text as it is.
const PAGE_OF_0_6_4 = [
  "/x/plugins/cache/doable/doable-code-context/0.6.4/scripts/code-agent-service.mjs",
  "page",
  "--machine",
  "mac-mini-1",
  "--port",
  "47615",
  "--pid-file",
  "/x/home/mac-mini-1/page.pid",
];

test("the stop-page step of this release ends a page whose command line is the one that 0.6.4's start script gave it", (t) => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt }, m.env, () => {});
  const dir = serviceDir(m.env, "mac-mini-1");
  const older = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...PAGE_OF_0_6_4], { stdio: "ignore" });
  t.after(() => older.kill("SIGKILL"));
  writeFileSync(join(dir, "page.pid"), `${older.pid}\n`);
  const printed = execFileSync(process.execPath, [script, "stop-page", "--dir", dir], { encoding: "utf8", env: m.env });
  assert.match(printed, new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ the page \\(process ${older.pid}\\) stopped\\.\\n$`));
  assert.equal(commandOf(older.pid), null);
  assert.equal(existsSync(join(dir, "page.pid")), false);
});
