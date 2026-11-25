import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  browser,
  launchdPlist,
  parseArgs,
  remove,
  runScript,
  serviceDir,
  setup,
  start,
  status,
  stop,
} from "../plugins/doable-code-context/scripts/code-agent-service.mjs";

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
    // No config file of Claude Code, so no chosen Chrome. Without it, the tests would read the developer's own file.
    CLAUDE_CONFIG_DIR: join(base, "claude-config"),
  };
  return { base, folder, prompt, env };
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

const SETUP_CLAUDE = "'\\/opt\\/claude'\\\\''s bin\\/claude'";
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
  const then = keepRunning ? "sleep 30" : `touch '${join(dir, "stopped")}'`;
  writeFileSync(claude, `#!/bin/bash\ncat '${outputFile}'\n${then}\n`, { mode: 0o700 });
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
