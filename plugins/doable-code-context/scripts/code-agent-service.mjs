#!/usr/bin/env node

// Runs the Doable code agent in the background on this machine: one serving session of Claude Code in the bypass
// permission mode (no permission check) with Claude in Chrome, started again when it stops (a plan limit, a crash),
// kept awake on a Mac, and started at login by launchd on a Mac. A person runs `setup` (the README's "Always on"),
// then `status`, `stop`, `start` and `remove`. `start` writes the start script again with the command line of the
// plugin release that runs it, so a plugin update, then `stop` and `start`, gives the serving session the new release
// and its command line. Fixed code does these steps, not the model: they must be the same on every machine.
//
// Self-update (on unless setup or start got `--auto-update off`): before each start of the serving session, the start
// script runs `self-update`, which updates the plugin with Claude Code's own commands. When Claude Code installed a new
// release, that release writes the start script again (`write-start-script`), and the loop goes on in the new script.
// Doable asks for an update through the wait for a request: the session then ends, and the next start updates it. With
// self-update off, or with a development plugin folder, `update-request` writes to service.log that a person must
// update the plugin when Doable asked for a newer one.
//
// Usage:
//   DOABLE_API_KEY=... node code-agent-service.mjs setup --folder DIR --machine NAME --prompt-file FILE [--auto-update on|off]
//   node code-agent-service.mjs start --machine NAME [--auto-update on|off]
//   node code-agent-service.mjs status|stop|remove --machine NAME
//   node code-agent-service.mjs page --machine NAME [--port N]
//   node code-agent-service.mjs browser
// The start script runs these (DIR is the machine's folder):
//   node code-agent-service.mjs self-update --dir DIR --plugin doable-code-context@MARKETPLACE --scope SCOPE
//   node code-agent-service.mjs write-start-script --dir DIR
//   node code-agent-service.mjs update-request --dir DIR --from BYTES
//
// `page` serves a page at http://127.0.0.1:N/ (N is 47615 unless --port gives another) that other computers cannot open
// (any account of this computer can): the serving session and the requests that it served, from its files on this
// computer (code-agent-page.mjs). It runs until Ctrl-C. `browser` prints the Chrome that the person chose in Claude Code: the serving session runs it
// before it uses the browser (the Skill's "The browser").
//
// The serving session can use every tool with no permission check, and Claude in Chrome, so that it can open a page in
// this machine's Chrome, for example the link of a sign-up mail from the request's test inbox. Only the rules of its
// prompt and of the Skill keep it from a write to production. It cannot load Doable MCP's `ask_code_agent`, with which
// a person's Claude Code asks a machine, under the plugin's server name or under `doable` (a user-scoped or
// project-scoped Doable MCP server of that name), so that the session cannot send a request to itself with it.
//
// For development, DOABLE_CODE_AGENT_PLUGIN_DIR at setup makes the serving session load the plugin from that folder
// (`claude --plugin-dir`) in place of the installed plugin. For tests, DOABLE_CODE_AGENT_NO_LAUNCH writes the files and
// starts nothing, DOABLE_CODE_AGENT_NO_LAUNCHD starts the start script on a Mac as on a machine without launchd, and
// DOABLE_CODE_AGENT_WAIT_S sets how many seconds (a whole number) setup and start wait for the session's first wait for a
// request.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Not '.' or '..': the machine's folder would be the folder of all machines or the one above it, which `page` would
// read and `remove` would delete.
const MACHINE_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,64}$/;
// An organization API key: the code agent tools refuse a personal key and a login token.
const ORGANIZATION_KEY = /^sk-doable-(?!personal-)[A-Za-z0-9_-]{16,}$/;
// Any Doable API key: `status` and the page (code-agent-page.mjs) mask each one in what they show.
export const ANY_DOABLE_KEY = /sk-doable-[A-Za-z0-9_-]+/;
// The prefix of the tool names of the plugin's Doable MCP server: the server that sends the key and the machine name of
// this setup (the env file) to Doable.
const PLUGIN_TOOLS = "mcp__plugin_doable-code-context_doable__";
// The tool that the serving session cannot load (README, "With nobody at the terminal"): the tool with which a person's
// Claude Code asks a machine. With it, the session could send a request to itself. It has one name for each server that
// gives it: the plugin's server, and a user-scoped or project-scoped server named `doable` (Doable MCP's README and the
// connection recovery of doable-connect add one). A name of a server that this machine does not have does nothing.
// Claude Code loads a server of the person's settings that has the plugin server's address in place of the plugin's
// server, whatever its name. The session then calls Doable with that server's key and headers, not with this setup's:
// setup and start say so (printStart), and the README says to remove such a server.
const ASKING_TOOLS = [`${PLUGIN_TOOLS}ask_code_agent`, "mcp__doable__ask_code_agent"];
// The wait for a request of a Doable MCP server under any server name, and under the plugin's server.
const WAIT_TOOL = /^mcp__.+__wait_for_code_agent_request$/;
const PLUGIN_WAIT_TOOL = `${PLUGIN_TOOLS}wait_for_code_agent_request`;
// The options that this release refuses with the reason, because the session allows every tool and has Chrome on:
// `--allow`, the option of plugin 0.6.0's setup for its allow rules, and `--chrome`, which no released setup took (a
// draft of this release did), but which a person can give because Claude Code has an option of that name.
const RETIRED_OPTIONS = ["--allow", "--chrome"];
const RESTART_WAIT_S = 300;
const LOG_MAX_BYTES = 20 * 1024 * 1024;
// This script, and the plugin's folder above scripts/: for an installed plugin, the `installPath` that
// `claude plugin list --json` names.
const SCRIPT = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(SCRIPT), "..");
const PLUGIN_NAME = "doable-code-context";
// The time limits of the commands of the self-update: a command that hangs (for example a git fetch with no answer)
// must not keep the serving session from its start.
const UPDATE_LIMIT_S = 300;
const LIST_LIMIT_S = 60;
const WRITE_LIMIT_S = 120;
// The exit code of `self-update` when a new release wrote the start script: the start script then runs the new one.
export const NEW_START_SCRIPT = 3;
// The installation scopes of Claude Code (`claude plugin update --scope`).
const SCOPES = ["user", "project", "local", "managed"];
const PLUGIN_ID = /^doable-code-context@[A-Za-z0-9._-]{1,100}$/;
// Escape sequences of colors in a command's output.
const COLORS = /\x1b\[[0-9;]*[A-Za-z]/g;
// Plugin 0.3.0's policy file in the workspace. A session takes its rules from its prompt now, so setup deletes the
// file: a person who reads it would think that it still applies. The name is built from parts, so that the release
// verifier's check for texts that name it does not find this file.
const RETIRED_POLICY_FILE = join(".doable", ["code-agent", "md"].join("."));

export function serviceDir(env, machine) {
  return join(env.DOABLE_CODE_AGENT_HOME || join(homedir(), ".doable", "code-agent"), machine);
}

export function launchdLabel(machine) {
  return `ai.getdoable.code-agent.${machine}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function fail(message) {
  throw new Error(message);
}

function checkMachine(machine) {
  if (!machine || !MACHINE_NAME.test(machine)) {
    fail("--machine must be 1 to 64 characters, each a letter, a digit, '.', '_' or '-', and not '.' or '..'.");
  }
}

// The Claude Code executable on PATH, so that launchd, which starts with a short PATH, runs the same one.
export function findClaude(env) {
  if (env.DOABLE_CLAUDE_BIN) return env.DOABLE_CLAUDE_BIN;
  for (const dir of (env.PATH || "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "claude");
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this folder of PATH: the next one may hold it.
    }
  }
  fail("Claude Code (`claude`) is not on PATH. Install it, sign in on the Claude plan, and run setup again.");
}

// The lines of the start script's loop before the session starts, when self-update is on. `update` names the installed
// plugin (`doable-code-context@<marketplace>`) and its scope, from `claude plugin list --json` when this release wrote
// the script. Bash reads a script while it runs, but it has read the whole loop before the loop runs: so the new
// release writes the new script (by a rename, see writeRunScript) while this loop runs, and `exec` then leaves this
// script for the new one before bash reads more of it.
function selfUpdateStep(update, version) {
  return `  # Self-update: Claude Code updates ${update.plugin} (${update.scope} scope, ${version} when this script was written).
  # When it installed a new release, that release wrote this script again: the loop goes on in the new script.
  node ${shellQuote(SCRIPT)} self-update --dir "$dir" --plugin ${shellQuote(update.plugin)} --scope ${shellQuote(update.scope)} >> "$dir/service.log" 2>&1
  updated=$?
  case $updated in
    0) ;;
    ${NEW_START_SCRIPT})
      /bin/bash -n "$dir/run.sh" && exec /bin/bash "$dir/run.sh"
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) self-update: the new release's start script is not valid bash; this script goes on" >> "$dir/service.log" ;;
    *) echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) self-update: the step failed with code $updated; this release starts the session" >> "$dir/service.log" ;;
  esac
`;
}

// The start script. `service` is null in a script with no self-update and no check for Doable's request of an update
// (the tests of the session's command line). Else it gives the installed plugin to update (`update`, see
// selfUpdateStep), or null: self-update is off, or the session loads the plugin from a development folder. Then, after
// each session, `update-request` writes to service.log when Doable asked for a newer plugin.
export function runScript({ dir, folder, claude, path, wake, pluginDir = null, service = null }) {
  const plugin = pluginDir ? `--plugin-dir ${shellQuote(pluginDir)} ` : "";
  const wakeLock = wake ? "/usr/bin/caffeinate -i -s " : "";
  // --disallowedTools takes each word after it as a tool name, so an option must come next.
  const disallowed = ASKING_TOOLS.map(shellQuote).join(" ");
  let before = "";
  let after = "";
  if (service !== null && service.update !== null) before = selfUpdateStep(service.update, ownVersion());
  else if (service !== null) {
    before = `  # The size of the session's output before this session: update-request reads only what this session adds.
  from=0
  [ -f "$dir/session.jsonl" ] && from=$(wc -c < "$dir/session.jsonl" | tr -d ' ')
`;
    after = `  node ${shellQuote(SCRIPT)} update-request --dir "$dir" --from "$from" >> "$dir/service.log" 2>&1
`;
  }
  return `#!/bin/bash
# Written by doable-code-context's code-agent-service.mjs. It serves Doable requests in ${folder}
# until \`code-agent-service.mjs stop\` writes the stop file. Do not edit it: setup writes it again.
set -u
# The session's output can hold a test login's password (in a command): its files are the owner's only.
umask 077
dir=${shellQuote(dir)}
. "$dir/env"
unset ANTHROPIC_API_KEY
export PATH=${shellQuote(path)}
# In print mode the MCP servers can connect after the first turn starts; the skill's first call needs Doable's tools.
export MCP_CONNECTION_NONBLOCKING=false
cd ${shellQuote(folder)} || exit 1
while [ ! -e "$dir/stopped" ]; do
  if [ -f "$dir/session.jsonl" ] && [ "$(wc -c < "$dir/session.jsonl")" -gt ${LOG_MAX_BYTES} ]; then
    mv -f "$dir/session.jsonl" "$dir/session.1.jsonl"
  fi
${before}  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) the serving session starts" >> "$dir/service.log"
  ${wakeLock}${shellQuote(claude)} -p ${plugin}--permission-mode bypassPermissions --chrome --disallowedTools ${disallowed} --output-format stream-json --verbose < "$dir/prompt.md" >> "$dir/session.jsonl" 2>&1
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) the serving session ended with code $?" >> "$dir/service.log"
${after}  [ -e "$dir/stopped" ] && break
  sleep ${RESTART_WAIT_S}
done
`;
}

export function launchdPlist({ machine, dir }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(launchdLabel(machine))}</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>${xmlEscape(join(dir, "run.sh"))}</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(join(dir, "service.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(dir, "service.log"))}</string>
</dict>
</plist>
`;
}

// What the start script runs with: setup takes it from its environment and keeps it in config.json.
// `kept` holds the values that an older start script gives (scriptEnvironment): they win over the environment.
function runEnvironment(env, kept = {}) {
  return {
    claude: kept.claude ?? findClaude(env),
    path: kept.path ?? (env.PATH || ""),
    wake: process.platform === "darwin" && existsSync("/usr/bin/caffeinate"),
    pluginDir: kept.pluginDir !== undefined ? kept.pluginDir : env.DOABLE_CODE_AGENT_PLUGIN_DIR || null,
  };
}

// A value as shellQuote writes it: in single quotes, with each single quote of the value written as '\''.
const SHELL_QUOTED = String.raw`'[^']*'(?:\\''[^']*')*`;

function shellUnquote(quoted) {
  return quoted.slice(1, -1).replaceAll(`'\\''`, "'");
}

// What a start script that runScript wrote runs with: the PATH of its `export PATH=` line, and the claude command and
// the development plugin folder of its session's command line. A value that the script does not hold is left out.
// The permission mode after them is `dontAsk` in a start script of plugin 0.5.0 or 0.6.0, and `bypassPermissions` in
// one of this release.
function scriptEnvironment(script) {
  const kept = {};
  const path = script.match(new RegExp(`^export PATH=(${SHELL_QUOTED})$`, "m"));
  if (path) kept.path = shellUnquote(path[1]);
  const session = script.match(
    new RegExp(
      `^\\s*(?:/usr/bin/caffeinate -i -s )?(${SHELL_QUOTED}) -p (?:--plugin-dir (${SHELL_QUOTED}) )?--permission-mode (?:dontAsk|bypassPermissions) `,
      "m",
    ),
  );
  if (session) {
    kept.claude = shellUnquote(session[1]);
    kept.pluginDir = session[2] === undefined ? null : shellUnquote(session[2]);
  }
  return kept;
}

// The start script, from config.json and this release's command line, with the self-update step for `update` (the
// installed plugin, or null: see runScript). A config.json of plugin 0.5.0 or 0.6.0 also holds the person's `allow`
// list: this release does not use it, because the session allows every tool. The new script takes the place of the old
// one by a rename: a start script that runs keeps reading its own file, which does not change.
function writeRunScript(dir, config, update) {
  const script = runScript({
    dir,
    folder: config.folder,
    claude: config.claude,
    path: config.path,
    wake: config.wake,
    pluginDir: config.pluginDir,
    service: { update },
  });
  const next = join(dir, "run.sh.next");
  writeFileSync(next, script, { mode: 0o700 });
  chmodSync(next, 0o700);
  renameSync(next, join(dir, "run.sh"));
}

// "on", "off", or "development folder" (the session loads the plugin from a folder: no update). A config.json from
// before self-update has no `autoUpdate`: self-update is on there, as it is by default.
function selfUpdateOf(config) {
  if (config.pluginDir) return "development folder";
  return config.autoUpdate === false ? "off" : "on";
}

// The version of this release, from its manifest.
function ownVersion() {
  return JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")).version;
}

// Runs a command of Claude Code's plugins (`claude plugin ...`) in the folder of the repositories (a project-scoped
// install belongs to a folder), with a time limit. It never asks: no command reads an answer from the terminal.
function claudePlugin(claude, folder, args, seconds, env) {
  return limitedRun(claude, ["plugin", ...args], { cwd: folder, seconds, env });
}

// Runs a command with a time limit: after `seconds`, the command is killed (SIGKILL: a command that hangs can ignore
// SIGTERM, and spawnSync waits until it ends). A Mac has no `timeout` command, so the limit is node's.
export function limitedRun(command, args, { cwd, seconds, env }) {
  return spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: seconds * 1000,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  });
}

// How a command that did not end with code 0 ended, or null when it did, with the last lines of its output (masked:
// a command's output can hold a URL with a password, or a key).
function failureWords(run, seconds, mask) {
  let how;
  if (run.error?.code === "ETIMEDOUT") how = `did not end in ${seconds} seconds and was stopped`;
  else if (run.error) how = `could not run (${run.error.code})`;
  else if (run.signal) how = `was stopped by ${run.signal}`;
  else if (run.status !== 0) how = `ended with code ${run.status}`;
  else return null;
  const lines = `${run.stdout ?? ""}\n${run.stderr ?? ""}`
    .replace(COLORS, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3);
  if (lines.length === 0) return `${how}, with no output`;
  const last = mask(lines.join(" | "));
  return `${how}; its last lines: ${last.length > 500 ? `${last.slice(0, 500)}…` : last}`;
}

function samePath(a, b) {
  return existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b);
}

// The plugin that self-update updates: this release as Claude Code installed it (its `installPath` is this script's
// plugin folder), with its id and scope; null when self-update is off or the session loads the plugin from a
// development folder. setup, start and write-start-script fail when self-update is on and Claude Code lists no install
// of this release: the start script could not update a plugin that it cannot name.
function pluginToUpdate(config, env) {
  if (selfUpdateOf(config) !== "on") return null;
  const { list, problem } = readPluginList(config.claude, config.folder, env, maskBasic);
  if (problem !== undefined) fail(`${problem}. Self-update reads it to find the installed plugin; to start with no self-update, use --auto-update off.`);
  const mine = list.filter(
    (entry) =>
      typeof entry.id === "string" &&
      entry.id.startsWith(`${PLUGIN_NAME}@`) &&
      typeof entry.installPath === "string" &&
      samePath(entry.installPath, PLUGIN_ROOT),
  );
  // Claude Code can list one folder in two scopes; the user scope is the README's.
  const entry = mine.length === 1 ? mine[0] : mine.find((one) => one.scope === "user");
  if (entry === undefined) {
    const where = mine.length === 0 ? "names no install of it in this folder" : `names it in the scopes ${mine.map((one) => one.scope).join(", ")}`;
    fail(
      `Self-update updates the plugin that Claude Code installed, and \`claude plugin list --json\` ${where} (${PLUGIN_ROOT}). Run this script from the installPath that \`claude plugin list --json\` names for ${PLUGIN_NAME}, or turn self-update off with --auto-update off.`,
    );
  }
  if (!PLUGIN_ID.test(entry.id) || !SCOPES.includes(entry.scope)) {
    fail(`\`claude plugin list --json\` names this plugin as ${JSON.stringify(entry.id)} in the scope ${JSON.stringify(entry.scope)}: self-update cannot update it. Turn self-update off with --auto-update off.`);
  }
  return { plugin: entry.id, scope: entry.scope };
}

// The mask of setup's and start's messages: the person reads them at the terminal. The page's mask (makeMasker) knows
// more forms, and self-update uses it.
function maskBasic(text) {
  return text.replace(new RegExp(ANY_DOABLE_KEY.source, "g"), "sk-doable-****").replace(/(\/\/[^\s/:@]+:)[^\s/@]+@/g, "$1****@");
}

const SELF_UPDATE_WORDS = {
  on: (machine) =>
    `Self-update is on: before each start of the session, the start script updates the plugin with Claude Code's own commands, and when Doable needs a newer release, the session ends and starts again with it. To turn it off, run stop, then start --machine ${machine} --auto-update off.`,
  off: (machine) =>
    `Self-update is off: when Doable needs a newer release of the plugin, the session ends at once, and a person must update the plugin (README, "Self-update"). To turn it on, run stop, then start --machine ${machine} --auto-update on.`,
  "development folder": () =>
    "Self-update is off: the session loads the plugin from a development folder (DOABLE_CODE_AGENT_PLUGIN_DIR at setup). When Doable needs a newer release, the session ends at once, and a person must update that folder.",
};

function writeConfig(dir, config) {
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

// config.json of a machine that setup set up, and whether plugin 0.5.0's setup wrote it. That setup kept only the
// folder, the machine and the person's allow rules (which this release does not use). It wrote the rest into the start
// script, from the person's terminal, and the shell that runs start can have another PATH (for example over SSH). So
// the rest comes from that start script, else from this environment, and is kept from now on.
function savedConfig(dir, env) {
  const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  if ("claude" in config) return { config, fromOlderSetup: false };
  const runFile = join(dir, "run.sh");
  const kept = existsSync(runFile) ? scriptEnvironment(readFileSync(runFile, "utf8")) : {};
  Object.assign(config, runEnvironment(env, kept));
  writeConfig(dir, config);
  return { config, fromOlderSetup: true };
}

// The sentence of the README's start prompt that lets a new test login's password go in the result. A 0.5.0 prompt's
// secret rule has no such exception, so its session cannot hand a new login to Doable.
const PASSWORD_EXCEPTION = "The one exception: the password of a new test login goes in that login of the result.";

// What setup and start tell the person about the session's permissions and its browser (README, "With nobody at the
// terminal" and "A browser for a mail's link"). The person allows no site in the Claude in Chrome extension: in the
// bypass mode, Claude Code tells the extension not to ask.
const NO_PERMISSION_CHECK_NOTE =
  "It runs in the bypass permission mode: it can use every tool and command of this machine with no prompt, and only the rules of its prompt and of the Skill keep it from a write to production.";
const CHROME_NOTE =
  "It uses Claude in Chrome: keep Chrome open on this machine with the Claude in Chrome extension connected.";

// The Chrome that the person chose in Claude Code (`/chrome`, "Select browser"), or null when the person chose none.
// Claude Code keeps the choice in its config file, and each later session uses that Chrome when it is connected. When it
// is not, a session uses the one Chrome that is connected to the Claude account, with no question, also when that one is
// on another computer. So the Skill uses the browser only when it is this one, and it reads the choice from here: the
// config file can hold keys (of MCP servers), and neither the choice nor an error may carry another value of it.
export function chosenBrowser(env) {
  const file = join(env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    // The error of JSON.parse quotes the text that it could not read.
    fail(`${file}, the config file of Claude Code, is not valid JSON.`);
  }
  const chosen = config.chromeExtension;
  if (!chosen?.pairedDeviceId) return null;
  return { deviceId: chosen.pairedDeviceId, name: chosen.pairedDeviceName };
}

// Claude Code names a Chrome with no name of its own "Browser 1", "Browser 2" by its place in the list, so a name alone
// does not say which computer it is on: the list holds only this machine's Chrome while it is closed on the others.
const CHOOSE_CHROME =
  'close Chrome on your other computers, run `claude --chrome`, then /chrome, "Select browser", and choose this machine\'s Chrome. Then run stop and start.';

function chromeNote(chosen) {
  if (chosen === null) {
    return `${CHROME_NOTE} No Chrome is chosen in Claude Code on this machine, so it does not use the browser. To choose one, ${CHOOSE_CHROME}`;
  }
  return `${CHROME_NOTE} It uses only the Chrome that you chose in Claude Code, "${chosen.name}". If that can be the Chrome of another computer, ${CHOOSE_CHROME}`;
}

function plistPath(env, machine) {
  return join(env.DOABLE_LAUNCH_AGENTS_DIR || join(homedir(), "Library", "LaunchAgents"), `${launchdLabel(machine)}.plist`);
}

function useLaunchd(env) {
  return process.platform === "darwin" && !env.DOABLE_CODE_AGENT_NO_LAUNCH && !env.DOABLE_CODE_AGENT_NO_LAUNCHD;
}

// The pid of the start script that the `pid` file names, while that script runs (on a machine without launchd), else
// null. A process that took the pid after the script ended (for example after a reboot) does not count.
function runningScript(dir) {
  const pidFile = join(dir, "pid");
  if (!existsSync(pidFile)) return null;
  const pid = readFileSync(pidFile, "utf8").trim();
  let command;
  try {
    command = execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    // ps exits with 1 when no process has the pid: the script ended.
    if (error.status === 1) return null;
    throw error;
  }
  return command.includes(join(dir, "run.sh")) ? pid : null;
}

// On a machine without launchd, a launch while the session runs would start a second session with the same machine
// name, and `stop` would end only the one in the `pid` file. A launch by launchd ends the job's session first
// (bootout), and a session that `stop` ended (the stop file) does not start again.
function checkNotRunning(env, machine, dir) {
  if (env.DOABLE_CODE_AGENT_NO_LAUNCH || useLaunchd(env) || existsSync(join(dir, "stopped"))) return;
  const pid = runningScript(dir);
  if (pid !== null) fail(`The code agent "${machine}" runs (process ${pid}). Run stop first: stop --machine ${machine}`);
}

function launchctl(args, { quiet = false } = {}) {
  try {
    execFileSync("launchctl", args, { stdio: quiet ? "ignore" : "pipe" });
    return true;
  } catch (error) {
    if (quiet) return false;
    throw error;
  }
}

function launch(env, machine, dir) {
  rmSync(join(dir, "stopped"), { force: true });
  if (env.DOABLE_CODE_AGENT_NO_LAUNCH) return "not started (DOABLE_CODE_AGENT_NO_LAUNCH is set)";
  if (useLaunchd(env)) {
    const uid = process.getuid();
    // A job of an earlier setup is replaced: bootout fails when none is loaded, which is fine.
    launchctl(["bootout", `gui/${uid}/${launchdLabel(machine)}`], { quiet: true });
    launchctl(["bootstrap", `gui/${uid}`, plistPath(env, machine)]);
    return "started by launchd, and started again at each login";
  }
  const child = spawn("/bin/bash", [join(dir, "run.sh")], { detached: true, stdio: "ignore" });
  child.unref();
  writeFileSync(join(dir, "pid"), `${child.pid}\n`, { mode: 0o600 });
  return "started in the background; after a reboot, run `start` again";
}

// What the output of a serving session (`claude -p --output-format stream-json`) says about its start: the permission
// mode of its `system` `init` line (null when the output has none), and the name of the first wait tool whose call
// returned with no error (null when none did). Claude Code writes the line of a call before it checks the call's
// permission and before the call runs: only the call's result (a `tool_result` with the call's id) says that the session
// waits. The result of a refused call, or of a call that Doable refused (for example a revoked key), has
// `"is_error": true`. The init line also names each tool, so a tool's name alone says nothing.
function sessionStart(output) {
  let permissionMode = null;
  let waitTool = null;
  const waitCalls = new Map();
  for (const line of output.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      // The output also holds the session's stderr, and its last line can be half written: such a line says nothing.
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (event === null || typeof event !== "object") continue;
    if (event.type === "system" && event.subtype === "init" && permissionMode === null) permissionMode = event.permissionMode ?? null;
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type === "tool_use" && WAIT_TOOL.test(part.name)) waitCalls.set(part.id, part.name);
      if (part.type === "tool_result" && waitCalls.has(part.tool_use_id) && part.is_error !== true && waitTool === null) {
        waitTool = waitCalls.get(part.tool_use_id);
      }
    }
  }
  return { permissionMode, waitTool };
}

function outputSize(dir) {
  const log = join(dir, "session.jsonl");
  return existsSync(log) ? statSync(log).size : 0;
}

// The session's output after its first `from` bytes (its size at the launch), which the sessions before the launch
// wrote, with their own calls. Output that is shorter than `from` is all new: the start script moved the earlier output
// to session.1.jsonl because it grew too large.
function outputAfter(log, from) {
  let fd;
  try {
    fd = openSync(log, "r");
  } catch (error) {
    // No output yet: the session did not start, or the start script has just moved the earlier output away.
    if (error.code === "ENOENT") return "";
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    const offset = size < from ? 0 : from;
    const bytes = Buffer.alloc(size - offset);
    return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, offset)).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// How many seconds setup and start wait for the session's first wait for a request: 2 minutes, or for tests
// DOABLE_CODE_AGENT_WAIT_S.
function waitSeconds(env) {
  const value = env.DOABLE_CODE_AGENT_WAIT_S;
  if (value === undefined) return 120;
  if (!/^\d+$/.test(value)) fail("DOABLE_CODE_AGENT_WAIT_S must be a whole number of seconds.");
  return Number(value);
}

// What the output of the session that the launch started says about its start (sessionStart), once a wait for a request
// returned or after `seconds`. The Skill's first wait has `wait_seconds: 0`, so it returns at once.
function waitForStart(dir, from, seconds) {
  const log = join(dir, "session.jsonl");
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const seen = sessionStart(outputAfter(log, from));
    if (seen.waitTool !== null || Date.now() >= until) return seen;
    execFileSync("sleep", ["1"]);
  }
}

// Launches the start script, and waits for the session's start (waitForStart), unless nothing was launched (then
// `seen` is null).
function launchAndWait(env, machine, dir) {
  const seconds = waitSeconds(env);
  const from = outputSize(dir);
  const how = launch(env, machine, dir);
  const seen = env.DOABLE_CODE_AGENT_NO_LAUNCH ? null : waitForStart(dir, from, seconds);
  return { how, seen };
}

function printStart(seen, dir, print) {
  if (seen === null) return;
  const { permissionMode, waitTool } = seen;
  if (waitTool === PLUGIN_WAIT_TOOL) print("It is connected: it waits for Doable's requests.");
  else if (waitTool !== null) {
    print(
      `It waits for Doable's requests through another Doable MCP server of your Claude Code settings (its tool ${waitTool}), not through the plugin's server, so it does not use this setup's key and machine name. Remove that server (README, "With nobody at the terminal"), then run stop and start.`,
    );
  } else print(`It did not start to wait in 2 minutes. Read ${join(dir, "session.jsonl")} and ${join(dir, "service.log")}.`);
  if (permissionMode !== null && permissionMode !== "bypassPermissions") {
    print(
      `It runs in the ${permissionMode} permission mode, not in the bypass mode, so with nobody at the terminal it cannot do the work of a request. Settings of this machine can turn the bypass mode off (\`disableBypassPermissionsMode\`): read the README's "With nobody at the terminal".`,
    );
  }
}

export function setup(options, env, print = console.log) {
  const { folder, machine, promptFile, autoUpdate = true } = options;
  checkMachine(machine);
  const key = env.DOABLE_API_KEY || "";
  if (!ORGANIZATION_KEY.test(key)) {
    fail("Set DOABLE_API_KEY to an organization API key from Doable's Settings > MCP (it starts with sk-doable-, not sk-doable-personal-).");
  }
  if (!folder || !isAbsolute(folder) || !existsSync(folder) || !statSync(folder).isDirectory()) {
    fail("--folder must be the absolute path of the folder that holds the repositories.");
  }
  if (!promptFile || !existsSync(promptFile)) fail("--prompt-file must name the file that holds the serving session's prompt.");
  const prompt = readFileSync(promptFile, "utf8").trim();
  if (!prompt) fail("The prompt file is empty.");
  if (ANY_DOABLE_KEY.test(prompt)) fail("The prompt file holds a Doable API key. Take the key out: setup keeps it in its own file.");
  const chosen = chosenBrowser(env);
  const folderPath = resolve(folder);
  const config = { folder: folderPath, machine, autoUpdate, ...runEnvironment(env) };
  const update = pluginToUpdate(config, env);

  const dir = serviceDir(env, machine);
  checkNotRunning(env, machine, dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "env"), `export DOABLE_API_KEY=${shellQuote(key)}\nexport DOABLE_MACHINE_NAME=${shellQuote(machine)}\n`, { mode: 0o600 });
  chmodSync(join(dir, "env"), 0o600);
  writeFileSync(join(dir, "prompt.md"), `${prompt}\n`, { mode: 0o600 });
  writeRunScript(dir, config, update);
  writeConfig(dir, config);
  if (useLaunchd(env)) {
    mkdirSync(join(plistPath(env, machine), ".."), { recursive: true });
    writeFileSync(plistPath(env, machine), launchdPlist({ machine, dir }));
  }

  const policyFile = join(folderPath, RETIRED_POLICY_FILE);
  if (existsSync(policyFile)) {
    rmSync(policyFile);
    print(`Removed ${RETIRED_POLICY_FILE}: a session takes its rules from its prompt now.`);
  }

  const { how, seen } = launchAndWait(env, machine, dir);
  print(`The Doable code agent "${machine}" serves ${folderPath}: ${how}.`);
  // When the session says that it runs in another mode, printStart says so in place of this note.
  if (seen === null || seen.permissionMode === null || seen.permissionMode === "bypassPermissions") print(NO_PERMISSION_CHECK_NOTE);
  print(chromeNote(chosen));
  printStart(seen, dir, print);
  print(`Its files are in ${dir} (the key is in ${join(dir, "env")}, readable only by you).`);
  print(SELF_UPDATE_WORDS[selfUpdateOf(config)](machine));
  print(`Status: node ${SCRIPT} status --machine ${machine}`);
  print(`Stop: node ${SCRIPT} stop --machine ${machine}`);
}

export function stop(machine, env, print = console.log) {
  checkMachine(machine);
  const dir = serviceDir(env, machine);
  if (!existsSync(dir)) fail(`No code agent "${machine}" is set up on this machine.`);
  writeFileSync(join(dir, "stopped"), `${new Date().toISOString()}\n`, { mode: 0o600 });
  if (!env.DOABLE_CODE_AGENT_NO_LAUNCH) {
    if (useLaunchd(env)) launchctl(["bootout", `gui/${process.getuid()}/${launchdLabel(machine)}`], { quiet: true });
    else if (existsSync(join(dir, "pid"))) {
      try {
        process.kill(-Number(readFileSync(join(dir, "pid"), "utf8").trim()), "SIGTERM");
      } catch {
        // The process ended already: the stop file keeps it from starting again.
      }
    }
  }
  print(`Stopped the code agent "${machine}". Start it again with: start --machine ${machine}`);
}

// `autoUpdate` is the choice of `--auto-update`, or undefined: start keeps the choice of config.json.
export function start(machine, env, print = console.log, { autoUpdate } = {}) {
  checkMachine(machine);
  const dir = serviceDir(env, machine);
  if (!existsSync(join(dir, "config.json"))) fail(`No code agent "${machine}" is set up on this machine: run setup first.`);
  checkNotRunning(env, machine, dir);
  const chosen = chosenBrowser(env);
  const { config, fromOlderSetup } = savedConfig(dir, env);
  if (autoUpdate !== undefined) config.autoUpdate = autoUpdate;
  const update = pluginToUpdate(config, env);
  writeConfig(dir, config);
  writeRunScript(dir, config, update);
  // A new command line can fail where the old one worked: the person who starts the session learns, as at setup,
  // whether it waits for requests, in which permission mode it runs (settings can turn the bypass mode off), and
  // whether it waits through the plugin's server.
  const { how, seen } = launchAndWait(env, machine, dir);
  print(`The code agent "${machine}": ${how}.`);
  print(chromeNote(chosen));
  printStart(seen, dir, print);
  // A changed choice says what it does now; `status` and the page always show it.
  if (autoUpdate !== undefined) print(SELF_UPDATE_WORDS[selfUpdateOf(config)](machine));
  if (fromOlderSetup) {
    print(
      `If the secret rule in ${join(dir, "prompt.md")} has no exception for a new test login's password, add this sentence to it, then run stop and start again: "${PASSWORD_EXCEPTION}"`,
    );
  }
}

// Whether the code agent of `machine` is "on", "stopped" (a `stop` wrote the stop file) or "not running". `status` prints
// it, and the page (code-agent-page.mjs) shows it. It fails for a machine that is not set up, as the other commands do.
export function serviceState(machine, env) {
  checkMachine(machine);
  const dir = serviceDir(env, machine);
  if (!existsSync(dir)) fail(`No code agent "${machine}" is set up on this machine.`);
  if (existsSync(join(dir, "stopped"))) return "stopped";
  // With no launchd, the agent is on only while the start script of the `pid` file runs: nothing starts it after a reboot.
  const running = useLaunchd(env)
    ? launchctl(["print", `gui/${process.getuid()}/${launchdLabel(machine)}`], { quiet: true })
    : runningScript(dir) !== null;
  return running ? "on" : "not running";
}

// Whether self-update is "on", "off", or off for a "development folder", from the machine's config.json. `status` prints
// it, and the page shows it.
export function selfUpdateState(machine, env) {
  checkMachine(machine);
  const file = join(serviceDir(env, machine), "config.json");
  if (!existsSync(file)) fail(`No code agent "${machine}" is set up on this machine: run setup first.`);
  return selfUpdateOf(JSON.parse(readFileSync(file, "utf8")));
}

export function status(machine, env, print = console.log) {
  const state = serviceState(machine, env);
  const dir = serviceDir(env, machine);
  print(`Code agent "${machine}": ${state}.`);
  print(SELF_UPDATE_WORDS[selfUpdateState(machine, env)](machine));
  const session = join(dir, "session.jsonl");
  if (existsSync(session)) print(`Last activity: ${statSync(session).mtime.toISOString()} (${session}).`);
  const log = join(dir, "service.log");
  if (existsSync(log)) {
    for (const line of readFileSync(log, "utf8").trim().split("\n").slice(-5)) print(`  ${line.replace(ANY_DOABLE_KEY, "sk-doable-****")}`);
  }
}

export function browser(env, print = console.log) {
  const chosen = chosenBrowser(env);
  if (chosen === null) print("No Chrome is chosen in Claude Code on this machine.");
  else print(`The chosen Chrome: deviceId ${chosen.deviceId}, name "${chosen.name}".`);
}

export function remove(machine, env, print = console.log) {
  checkMachine(machine);
  const dir = serviceDir(env, machine);
  if (existsSync(dir)) stop(machine, env, () => {});
  if (!env.DOABLE_CODE_AGENT_NO_LAUNCH) rmSync(plistPath(env, machine), { force: true });
  rmSync(dir, { recursive: true, force: true });
  print(`Removed the code agent "${machine}" and its files, its key too. Revoke the key in Doable's Settings > API Keys.`);
}

// The config.json of the machine's folder that the start script names (`--dir`). The start script's commands take the
// folder, not the machine's name: setup can have put the folder of all machines in another place
// (DOABLE_CODE_AGENT_HOME), which the start script's environment does not hold.
function machineConfig(dir) {
  if (!dir || !isAbsolute(dir) || !existsSync(join(dir, "config.json"))) fail("--dir must be the folder of a code agent that setup set up.");
  return JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
}

// A time as the start script writes it to service.log: UTC, in whole seconds.
function logTime() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// The installed plugins that Claude Code lists, as `{ list }`: entries with `id` (name@marketplace), `version`, `scope`
// and `installPath`, and other fields that this script does not read (they can name an MCP server's headers, so no
// message shows the list's text). Or `{ problem }`: why the list could not be read.
function readPluginList(claude, folder, env, mask) {
  const run = claudePlugin(claude, folder, ["list", "--json"], LIST_LIMIT_S, env);
  const failed = failureWords(run, LIST_LIMIT_S, mask);
  if (failed !== null) return { problem: `\`claude plugin list --json\` ${failed}` };
  let list;
  try {
    list = JSON.parse(run.stdout);
  } catch (error) {
    // The error of JSON.parse quotes the text that it could not read.
    if (!(error instanceof SyntaxError)) throw error;
    return { problem: "`claude plugin list --json` did not print JSON" };
  }
  if (!Array.isArray(list)) return { problem: "`claude plugin list --json` did not print a list" };
  return { list: list.filter((entry) => entry !== null && typeof entry === "object") };
}

// `self-update`: the start script's step before each start of the serving session, when self-update is on. Claude Code
// updates the plugin's marketplace, then the plugin in its scope, each with a time limit. Then this step reads which
// release Claude Code lists for the plugin. When that is another release than this one (its installPath is not this
// release's folder), the new release writes the start script again, and this step returns NEW_START_SCRIPT: the start
// script then runs the new script. Each step prints one line for service.log: what ran, the versions, or how a command
// failed and its last lines, masked with `mask`. When a step fails, it returns 0, and this release starts the session:
// the session serves, Doable asks again at its next wait for a request, and the start script tries again after its wait.
export function selfUpdate({ dir, plugin, scope }, env, print, mask) {
  const config = machineConfig(dir);
  if (!PLUGIN_ID.test(plugin ?? "")) fail(`--plugin must be ${PLUGIN_NAME}@<marketplace>.`);
  if (!SCOPES.includes(scope)) fail(`--scope must be one of ${SCOPES.join(", ")}.`);
  const say = (words) => print(`${logTime()} self-update: ${words}`);
  const marketplace = plugin.slice(PLUGIN_NAME.length + 1);
  for (const args of [
    ["marketplace", "update", marketplace],
    ["update", plugin, "--scope", scope],
  ]) {
    const failed = failureWords(claudePlugin(config.claude, config.folder, args, UPDATE_LIMIT_S, env), UPDATE_LIMIT_S, mask);
    if (failed !== null) {
      say(`\`claude plugin ${args.join(" ")}\` ${failed}. This release starts the session.`);
      return 0;
    }
    say(`\`claude plugin ${args.join(" ")}\` ended with no error.`);
  }
  const own = ownVersion();
  const { list, problem } = readPluginList(config.claude, config.folder, env, mask);
  // A project or local install belongs to a folder: the one of the repositories, where the start script runs.
  const entry = list?.find(
    (one) => one.id === plugin && one.scope === scope && (one.projectPath === undefined || samePath(one.projectPath, config.folder)),
  );
  if (problem !== undefined || typeof entry?.installPath !== "string") {
    say(`${problem ?? `\`claude plugin list --json\` names no ${plugin} in the ${scope} scope`}. This release (${own}) starts the session.`);
    return 0;
  }
  if (samePath(entry.installPath, PLUGIN_ROOT)) {
    say(`${plugin} is at ${own}, the release of this start script.`);
    return 0;
  }
  say(`${plugin} went from ${own} to ${entry.version}: the new release writes the start script again.`);
  const newScript = join(entry.installPath, "scripts", "code-agent-service.mjs");
  if (!existsSync(newScript)) {
    say(`${entry.version} has no ${newScript}. This release (${own}) starts the session.`);
    return 0;
  }
  const write = limitedRun(process.execPath, [newScript, "write-start-script", "--dir", dir], { cwd: config.folder, seconds: WRITE_LIMIT_S, env });
  const failed = failureWords(write, WRITE_LIMIT_S, mask);
  if (failed !== null) {
    say(`\`write-start-script\` of ${entry.version} ${failed}. This release (${own}) starts the session.`);
    return 0;
  }
  say(`${entry.version} wrote the start script: the session starts with it.`);
  return NEW_START_SCRIPT;
}

// `write-start-script`: writes the start script with this release's command line, as `start` does, and starts nothing.
// An older release's self-update runs it, from the new release's folder, after Claude Code installed the new release:
// keep this command and its --dir option in each release.
export function writeStartScript({ dir }, env) {
  const config = machineConfig(dir);
  writeRunScript(dir, config, pluginToUpdate(config, env));
}

// The text of a tool's result: a string, or the text parts of a list.
function toolText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

// The version that one answer of the wait for a request asks for, or null. Doable MCP's answer says it in words, as
// its whole text or as its `update` in JSON: "Doable needs the plugin 0.6.4 on this machine. End the session now ...".
function updateVersion(text) {
  return /Doable needs the plugin\W{0,3}(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}

// The version that Doable asked for in the output of a serving session (as sessionStart reads it), from the result of
// a wait for a request that returned with no error; null when no answer asked for one.
function askedVersion(output) {
  let version = null;
  const waitCalls = new Set();
  for (const line of output.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      // The output also holds the session's stderr, and its last line can be half written: such a line says nothing.
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "tool_use" && WAIT_TOOL.test(part.name)) waitCalls.add(part.id);
      if (part?.type === "tool_result" && waitCalls.has(part.tool_use_id) && part.is_error !== true) {
        version = updateVersion(toolText(part.content)) ?? version;
      }
    }
  }
  return version;
}

// `update-request`: the start script's step after each session when self-update is off, or when the session loads the
// plugin from a development folder. It prints a line for service.log when the session's output after its first `from`
// bytes holds Doable's answer that it needs a newer release of the plugin: a person must update it.
export function updateRequest({ dir, from }, print) {
  const config = machineConfig(dir);
  if (!Number.isInteger(from)) fail("--from must be a whole number of bytes.");
  const version = askedVersion(outputAfter(join(dir, "session.jsonl"), from));
  if (version === null) return;
  const why = selfUpdateOf(config) === "development folder" ? "the session loads the plugin from a development folder" : "self-update is off";
  print(
    `${logTime()} Doable needs the plugin ${version} on this machine, and ${why}: a person must update the plugin, then run stop and start (README, "Self-update"). Until then, each session ends at its first wait for a request.`,
  );
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  let i = 0;
  while (i < rest.length) {
    const name = rest[i];
    if (RETIRED_OPTIONS.includes(name)) fail(`${name} is not needed: this release allows every tool and has Chrome on.`);
    const value = rest[i + 1];
    if (value === undefined) fail(`${name} needs a value.`);
    if (name === "--folder") options.folder = value;
    else if (name === "--machine") options.machine = value;
    else if (name === "--prompt-file") options.promptFile = value;
    else if (name === "--port") options.port = portNumber(value);
    else if (name === "--auto-update") options.autoUpdate = onOrOff(value);
    else if (name === "--dir") options.dir = value;
    else if (name === "--plugin") options.plugin = value;
    else if (name === "--scope") options.scope = value;
    else if (name === "--from") options.from = byteCount(value);
    else fail(`Unknown option ${name}.`);
    i += 2;
  }
  return { command, options };
}

function onOrOff(value) {
  if (value !== "on" && value !== "off") fail("--auto-update must be on or off.");
  return value === "on";
}

function byteCount(value) {
  if (!/^\d+$/.test(value)) fail("--from must be a whole number of bytes.");
  return Number(value);
}

// The port of the page's address (`page --port`).
function portNumber(value) {
  const port = /^\d{1,5}$/.test(value) ? Number(value) : 0;
  if (port < 1 || port > 65535) fail("--port must be a whole number from 1 to 65535.");
  return port;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const env = process.env;
  if (command === "setup") setup(options, env);
  else if (command === "stop") stop(options.machine, env);
  else if (command === "start") start(options.machine, env, console.log, options);
  else if (command === "status") status(options.machine, env);
  else if (command === "remove") remove(options.machine, env);
  else if (command === "browser") browser(env);
  else if (command === "page") {
    // Loaded only for this command: the page's module imports this one.
    const { page } = await import("./code-agent-page.mjs");
    await page(options, env);
  } else if (command === "self-update") {
    // The page's mask, loaded only for this command, as for `page`.
    const { maskSecrets } = await import("./code-agent-page.mjs");
    process.exitCode = selfUpdate(options, env, console.log, (text) => maskSecrets(text));
  } else if (command === "write-start-script") writeStartScript(options, env);
  else if (command === "update-request") updateRequest(options, console.log);
  else fail("Use setup, status, stop, start, remove, page or browser (see the comment at the top of this file).");
}

// The real path: with a link in the path (a linked ~/.claude), the script must run, not end with no output.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
