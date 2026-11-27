#!/usr/bin/env node

// Runs the Doable code agent in the background on this machine: one serving session of Claude Code in the bypass
// permission mode (no permission check) with Claude in Chrome, started again when it stops (a plan limit, a crash),
// kept awake on a Mac, and started at login by launchd on a Mac. A person runs `setup` (the README's "Always on"),
// then `status`, `stop`, `start` and `remove`. `start` writes the start script again with the command line of the
// plugin release that runs it, so a plugin update, then `stop` and `start`, gives the serving session the new release
// and its command line. Fixed code does these steps, not the model: they must be the same on every machine.
//
// Self-update (on unless setup or start got `--auto-update off`) runs only when Doable asks. Doable asks through the
// wait for a request: its answer then has no request, and its `update` is the words "Doable needs the plugin X.Y.Z on
// this machine. ...", and the session ends. After each session, the start script runs `update-request`, which reads
// that session's output. When a wait got Doable's ask, it writes the asked version to `update-asked` in the machine's
// folder and a line to service.log. With self-update on, it updates the plugin with Claude Code's own commands; when
// Claude Code installed a new release, that release writes the start script again (`write-start-script`), and the loop
// goes on in the new script at once. When the machine still runs a lower release than the asked one, or with
// self-update off or a development plugin folder, a line says that a person must act, and the next session starts 30
// minutes later, not 5. The first start (setup, start) never updates.
//
// Usage:
//   DOABLE_API_KEY=... node code-agent-service.mjs setup --folder DIR --machine NAME --prompt-file FILE [--auto-update on|off] [--page on|off] [--page-port N]
//   node code-agent-service.mjs start --machine NAME [--auto-update on|off] [--page on|off] [--page-port N]
//   node code-agent-service.mjs status|stop|remove --machine NAME
//   node code-agent-service.mjs page --machine NAME [--port N]
//   node code-agent-service.mjs browser
// Each command refuses an option that it does not take (COMMAND_OPTIONS): for example the page command takes its port
// as --port, and setup and start take the page's port as --page-port. setup and start refuse to run as root, except in a
// sandbox on a machine without launchd (refuseRoot): Claude Code refuses the bypass permission mode for root.
// The start script runs these (DIR is the machine's folder; --plugin and --scope only with self-update on):
//   node code-agent-service.mjs update-request --dir DIR --from BYTES [--plugin doable-code-context@MARKETPLACE --scope SCOPE]
//   node code-agent-service.mjs write-start-script --dir DIR
//   node code-agent-service.mjs stop-page|check-page --dir DIR
//   node code-agent-service.mjs page --machine NAME --port N --pid-file DIR/page.pid
//
// `page` serves a page at http://127.0.0.1:N/ (N is 47615 unless --port gives another) that other computers cannot open
// (any account of this computer can): the serving session and the requests that it served, from its files on this
// computer (code-agent-page.mjs). The start script runs it next to the serving session, unless setup or start got
// `--page off` (N is `--page-port`, else 47615), and starts it again when it ended; `stop` and `remove` stop it. With
// `--pid-file`, the page writes its own process id to that file, and its messages name the service's steps. A person
// runs it by hand, until Ctrl-C, for a machine with the page off or on another port. `browser` prints the Chrome that
// the person chose in Claude Code: the serving session runs it before it uses the browser (the Skill's "The browser").
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
// request. In the environment of the start script, DOABLE_CODE_AGENT_RESTART_WAIT_S and DOABLE_CODE_AGENT_ASKED_WAIT_S
// take the place of its waits of 5 and 30 minutes between two sessions.

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
// The wait after a session that Doable asked for a release that this machine does not run (no update, or an update that
// did not give it): each session then ends at its first wait, and uses the Claude plan for nothing.
const ASKED_WAIT_S = 1800;
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
// The exit codes of `update-request` that are not 0: a new release wrote the start script (the start script then runs
// the new one), or Doable asked for a release that this machine does not run (the start script waits ASKED_WAIT_S).
export const NEW_START_SCRIPT = 3;
export const ASKED_WAIT = 4;
// The file in the machine's folder that holds the version that Doable asked for last, until a release at or above it
// writes the start script.
const UPDATE_ASKED = "update-asked";
const VERSION = /^\d+\.\d+\.\d+$/;
// The installation scopes of Claude Code (`claude plugin update --scope`).
const SCOPES = ["user", "project", "local", "managed"];
const PLUGIN_ID = /^doable-code-context@[A-Za-z0-9._-]{1,100}$/;
// Escape sequences of colors in a command's output.
const COLORS = /\x1b\[[0-9;]*[A-Za-z]/g;
// The page's port when setup and start get no `--page-port`, and the page command's when it gets no `--port`
// (code-agent-page.mjs takes it from here).
export const DEFAULT_PAGE_PORT = 47615;
// The files of the page that the start script runs, in the machine's folder: its process id, and its output.
const PAGE_PID = "page.pid";
const PAGE_LOG = "page.log";
// The exit code of `check-page` when the page does not run: the start script then starts it again.
export const PAGE_NOT_RUNNING = 5;
// How long `check-page` waits for a page that has just started to listen (its address line in page.log) or to end, and
// how long `stop-page`, `stop` and `remove` wait for the page to end after SIGTERM.
const PAGE_START_S = 10;
const PAGE_END_S = 10;
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

// An executable named `name` in a folder of `path` (a PATH value), as that folder names it: a link is not resolved, so
// that a link that a package manager keeps (for example /opt/homebrew/bin/node) still works after an upgrade; or null.
function onPath(path, name) {
  for (const dir of (path || "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this folder of PATH: the next one may hold it.
    }
  }
  return null;
}

// The Claude Code executable on PATH, so that launchd, which starts with a short PATH, runs the same one.
export function findClaude(env) {
  if (env.DOABLE_CLAUDE_BIN) return env.DOABLE_CLAUDE_BIN;
  const claude = onPath(env.PATH, "claude");
  if (claude === null) fail("Claude Code (`claude`) is not on PATH. Install it, sign in on the Claude plan, and run setup again.");
  return claude;
}

// The node executable on the PATH that the start script runs with (config.json's `path`): the start script runs this
// script's `update-request` with it after each session.
function findNode(path) {
  const node = onPath(path, "node");
  if (node === null) {
    fail(
      `Node.js (\`node\`) is not on the PATH that the start script runs with (${path}). Run setup again from a shell whose PATH holds node and claude.`,
    );
  }
  return node;
}

// The lines of the start script's loop after each session: `update-request` reads what Doable answered this session's
// waits for a request, and its exit code gives the next step. `update` names the installed plugin
// (`doable-code-context@<marketplace>`) and its scope, from `claude plugin list --json` when this release wrote the
// script, or is null: self-update is off, or the session loads the plugin from a development folder. Bash reads a
// script while it runs, but it has read the whole loop before the loop runs: so the new release writes the new script
// (by a rename, see writeRunScript) while this loop runs, and `exec` then leaves this script for the new one before
// bash reads more of it. A session that ended after `stop` gets no step.
function afterSessionStep(node, update) {
  const target = update === null ? "" : ` --plugin ${shellQuote(update.plugin)} --scope ${shellQuote(update.scope)}`;
  const comment =
    update === null
      ? "  # When Doable asked for a newer plugin, update-request says that a person must update it.\n"
      : `  # When Doable asked for a newer plugin, Claude Code updates ${update.plugin} (${update.scope} scope, ${ownVersion()} when this
  # script was written). When it installed a new release, that release wrote this script again: the loop goes on in it.
`;
  const restart = `sleep "\${DOABLE_CODE_AGENT_RESTART_WAIT_S:-${RESTART_WAIT_S}}"`;
  const askedWait = `sleep "\${DOABLE_CODE_AGENT_ASKED_WAIT_S:-${ASKED_WAIT_S}}"`;
  return `  [ -e "$dir/stopped" ] && break
${comment}  ${shellQuote(node)} ${shellQuote(SCRIPT)} update-request --dir "$dir" --from "$from"${target} >> "$dir/service.log" 2>&1
  after=$?
  case $after in
    0) ${restart} ;;
    ${NEW_START_SCRIPT})
      /bin/bash -n "$dir/run.sh" && exec /bin/bash "$dir/run.sh"
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) self-update: the new release's start script is not valid bash; this script goes on" >> "$dir/service.log"
      ${askedWait} ;;
    ${ASKED_WAIT}) ${askedWait} ;;
    *)
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) update-request: the step failed with code $after" >> "$dir/service.log"
      ${restart} ;;
  esac
`;
}

function pageAddress(port) {
  return `http://127.0.0.1:${port}/`;
}

// The start script's lines for the page (README, "The code agent's page") before its loop. `page` is null with the page
// off, else the machine's name and the page's port. Each start script first stops the page that an earlier one started
// (`stop-page`): also the page of an older release, after a self-update's exec. With the page on, it then starts this
// release's page in the background with the start script's node, unless the stop file is there (launchd runs the start
// script of a stopped machine at each login): its output goes to page.log, which each start empties, and its process
// id to page.pid. The page also writes its own process id there (`--pid-file`): the node of the start script's PATH can
// be a program that runs node as its child (for example a version manager's shim), and then `$!` names that program,
// not the page. Each write of page.pid is a rename, so that no reader (check-page, stop) finds the file empty. The page
// finds the machine's folder in DOABLE_CODE_AGENT_HOME, which the environment of launchd does not hold.
//
// Keep these in each release: after a self-update's exec, the start script of the new release stops the page that the
// start script of the old release started. They are the page's process id in page.pid of the machine's folder; the
// stop-page step before the page starts; a page command line that holds
// `code-agent-service.mjs page --machine <machine> --port ` (pageCommand); and the keys `page` and `pagePort` of
// config.json, where a missing key means on and 47615 (pageOf).
function pageStart(node, dir, page) {
  const stopEarlier = `${shellQuote(node)} ${shellQuote(SCRIPT)} stop-page --dir "$dir" >> "$dir/service.log" 2>&1\n`;
  if (page === null) return `# The page is off (--page off): a page that an earlier start script started stops.\n${stopEarlier}`;
  return `# The page runs next to the serving session, from this release. A page that an earlier start script started stops
# first: also the page of an older release, after a self-update. After \`stop\` (the stop file), no page starts.
start_page() {
  : > "$dir/${PAGE_LOG}"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) the page starts at ${pageAddress(page.port)}" >> "$dir/service.log"
  DOABLE_CODE_AGENT_HOME=${shellQuote(dirname(resolve(dir)))} ${shellQuote(node)} ${shellQuote(SCRIPT)} page --machine ${shellQuote(page.machine)} --port ${page.port} --pid-file "$dir/${PAGE_PID}" >> "$dir/${PAGE_LOG}" 2>&1 &
  echo $! > "$dir/${PAGE_PID}.start"
  mv -f "$dir/${PAGE_PID}.start" "$dir/${PAGE_PID}"
  # Else bash writes a line with the page's command to its stderr (service.log under launchd) when the page is stopped.
  disown
}
${stopEarlier}[ -e "$dir/stopped" ] || start_page
`;
}

// The start script's step for the page before each session's start, with the page on.
function pageCheck(node) {
  return `  # When the page does not run (it ended, or its port is in use), check-page writes why to service.log, and the page
  # starts again. The session starts in any case.
  ${shellQuote(node)} ${shellQuote(SCRIPT)} check-page --dir "$dir" >> "$dir/service.log" 2>&1
  [ $? = ${PAGE_NOT_RUNNING} ] && start_page
`;
}

// The start script. `service` is null in a script with no step after a session and no page (the tests of the session's
// command line). Else it gives `node` (findNode), the installed plugin to update (`update`, see afterSessionStep), and
// the page (`page`, see pageStart).
export function runScript({ dir, folder, claude, path, wake, pluginDir = null, service = null }) {
  const plugin = pluginDir ? `--plugin-dir ${shellQuote(pluginDir)} ` : "";
  const wakeLock = wake ? "/usr/bin/caffeinate -i -s " : "";
  // --disallowedTools takes each word after it as a tool name, so an option must come next.
  const disallowed = ASKING_TOOLS.map(shellQuote).join(" ");
  let start = "";
  let before = "";
  let after = `  [ -e "$dir/stopped" ] && break
  sleep ${RESTART_WAIT_S}
`;
  let end = "";
  if (service !== null) {
    start = pageStart(service.node, dir, service.page);
    before = `${service.page === null ? "" : pageCheck(service.node)}  # The size of the session's output before this session: update-request reads only what this session adds.
  from=0
  [ -f "$dir/session.jsonl" ] && from=$(wc -c < "$dir/session.jsonl" | tr -d ' ')
`;
    after = afterSessionStep(service.node, service.update);
    // The loop ended (the stop file): the page stops too.
    end = `${shellQuote(service.node)} ${shellQuote(SCRIPT)} stop-page --dir "$dir" >> "$dir/service.log" 2>&1\n`;
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
${start}while [ ! -e "$dir/stopped" ]; do
  if [ -f "$dir/session.jsonl" ] && [ "$(wc -c < "$dir/session.jsonl")" -gt ${LOG_MAX_BYTES} ]; then
    mv -f "$dir/session.jsonl" "$dir/session.1.jsonl"
  fi
${before}  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) the serving session starts" >> "$dir/service.log"
  ${wakeLock}${shellQuote(claude)} -p ${plugin}--permission-mode bypassPermissions --chrome --disallowedTools ${disallowed} --output-format stream-json --verbose < "$dir/prompt.md" >> "$dir/session.jsonl" 2>&1
  # Kept on the next line: each later command, and each command substitution such as $(date), sets $? again.
  session_code=$?
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) the serving session ended with code $session_code" >> "$dir/service.log"
${after}done
${end}`;
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

// The start script, from config.json and this release's command line, with `node` (findNode) and the installed plugin
// to update (`update`, or null: see afterSessionStep). A config.json of plugin 0.5.0 or 0.6.0 also holds the person's
// `allow` list: this release does not use it, because the session allows every tool. The new script takes the place of
// the old one by a rename: a start script that runs keeps reading its own file, which does not change. A release at or
// above the version that Doable asked for removes `update-asked`.
function writeRunScript(dir, config, update, node) {
  const page = pageOf(config);
  const script = runScript({
    dir,
    folder: config.folder,
    claude: config.claude,
    path: config.path,
    wake: config.wake,
    pluginDir: config.pluginDir,
    service: { node, update, page: page.on ? { machine: config.machine, port: page.port } : null },
  });
  const next = join(dir, "run.sh.next");
  writeFileSync(next, script, { mode: 0o700 });
  chmodSync(next, 0o700);
  renameSync(next, join(dir, "run.sh"));
  const asked = askedRelease(dir);
  if (asked !== null && compareVersions(ownVersion(), asked) >= 0) rmSync(join(dir, UPDATE_ASKED));
}

// The version that Doable asked this machine for last (`update-asked`), or null when it asked for none that the machine
// does not run.
function askedRelease(dir) {
  const file = join(dir, UPDATE_ASKED);
  if (!existsSync(file)) return null;
  const version = readFileSync(file, "utf8").trim();
  if (!VERSION.test(version)) fail(`${file} does not hold a version (MAJOR.MINOR.PATCH): ${JSON.stringify(version.slice(0, 40))}.`);
  return version;
}

// Below 0, 0 or above 0 when the version `a` is lower than, the same as or higher than `b` (each MAJOR.MINOR.PATCH).
function compareVersions(a, b) {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

// "on", "off", or "development folder" (the session loads the plugin from a folder: no update). A config.json from
// before self-update has no `autoUpdate`: self-update is on there, as it is by default.
function selfUpdateOf(config) {
  if (config.pluginDir) return "development folder";
  return config.autoUpdate === false ? "off" : "on";
}

// Whether the start script runs the page, and on which port. A config.json of plugin 0.6.3 or older has neither: the
// page is on there, at its default port, as it is by default.
function pageOf(config) {
  return { on: config.page !== false, port: config.pagePort ?? DEFAULT_PAGE_PORT };
}

// What setup, and start with `--page` or `--page-port`, say about the page. `look` is what they saw of the page after
// the launch (pageAfterLaunch): null when they launched nothing, else whether the page runs, and why not. start also
// says it with no option when the page does not run.
function pageWords(machine, page, look) {
  if (!page.on) {
    return `The page is off. To turn it on, run stop, then start --machine ${machine} --page on. To run it by hand until Ctrl-C: node ${SCRIPT} page --machine ${machine}`;
  }
  const access = `Other computers cannot open it, but any account or program on this computer can, not only you. To turn it off, run stop, then start --machine ${machine} --page off.`;
  if (look !== null && !look.runs) {
    return `The page at ${pageAddress(page.port)} does not run now. ${look.why} The code agent serves all the same, and its start script starts the page again before each session (README, "The code agent's page"). ${access}`;
  }
  return `The page: ${pageAddress(page.port)}. It runs while the code agent runs, and stops with it (README, "The code agent's page"). ${access}`;
}

// Waits `ms` milliseconds: the commands of this script are synchronous.
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The part of the command line of each page that a start script started for `machine`, of any release: the start
// script of a later release finds an older release's page by it. Keep it in each release (see pageStart).
function pageCommand(machine) {
  return `code-agent-service.mjs page --machine ${machine} --port `;
}

// Whether the process `pid` runs the page command of `machine`. A process id can be reused after the page ended (for
// example after a reboot), so a process with another command line is not the page.
function runsPage(pid, machine) {
  let command;
  try {
    command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    // ps exits with 1 when no process has the pid: the page ended.
    if (error.status === 1) return false;
    throw error;
  }
  return command.includes(pageCommand(machine));
}

// The process id of the page that a start script started for `machine` (page.pid), while that process runs this
// machine's page command (runsPage); else null. Keep page.pid in each release (see pageStart).
function runningPage(dir, machine) {
  const file = join(dir, PAGE_PID);
  if (!existsSync(file)) return null;
  const pid = readFileSync(file, "utf8").trim();
  // A file that holds no process id (a write that a crash cut) names no page.
  if (!/^\d+$/.test(pid)) return null;
  return runsPage(pid, machine) ? Number(pid) : null;
}

// The child processes of `pid` that run the page command of `machine`. page.pid can name a program that runs node as
// its child and passes no signal on (for example a version manager's shim): the page writes its own process id to
// page.pid, but the start script's write of `$!` can come after it. The child is then the page that listens.
function pageChildren(pid, machine) {
  const children = [];
  const table = execFileSync("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  for (const line of table.split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (row !== null && Number(row[2]) === pid && row[3].includes(pageCommand(machine))) children.push(Number(row[1]));
  }
  return children;
}

// Stops the page that a start script started for `machine` (runningPage), and its child that runs the page command
// (pageChildren), waits until they ended, and removes page.pid. Returns their process ids: none when no page ran.
function stopPage(dir, machine) {
  const pid = runningPage(dir, machine);
  const pids = pid === null ? [] : [pid, ...pageChildren(pid, machine)];
  for (const one of pids) {
    try {
      process.kill(one, "SIGTERM");
    } catch (error) {
      // The process ended after ps looked.
      if (error.code !== "ESRCH") throw error;
    }
  }
  const until = Date.now() + PAGE_END_S * 1000;
  while (pids.some((one) => runsPage(one, machine))) {
    if (Date.now() >= until) {
      fail(`The page of the code agent "${machine}" (${processWords(pids)}) did not end in ${PAGE_END_S} seconds. End it with: kill -9 ${pids.join(" ")}`);
    }
    pause(100);
  }
  rmSync(join(dir, PAGE_PID), { force: true });
  return pids;
}

function processWords(pids) {
  return pids.length === 1 ? `process ${pids[0]}` : `processes ${pids.join(" and ")}`;
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
  return `${how}; its last lines: ${oneLine(lines, mask)}`;
}

// `lines` as one line of a message: joined with " | ", masked with `mask`, and cut after 500 characters.
function oneLine(lines, mask) {
  const text = mask(lines.join(" | "));
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function samePath(a, b) {
  return existsSync(a) && existsSync(b) && realpathSync(a) === realpathSync(b);
}

// Whether an install that `claude plugin list --json` lists applies in the folder of the repositories, where the start
// script runs: a project or local install belongs to its own folder (`projectPath`), and Claude Code lists those of
// every folder.
function appliesIn(entry, folder) {
  return entry.projectPath === undefined || (typeof entry.projectPath === "string" && samePath(entry.projectPath, folder));
}

// The plugin that self-update updates: this release as Claude Code installed it (its `installPath` is this script's
// plugin folder) for the folder of the repositories, with its id and scope; null when self-update is off or the session
// loads the plugin from a development folder. setup, start and write-start-script fail when self-update is on and
// Claude Code lists no install of this release: the start script could not update a plugin that it cannot name.
function pluginToUpdate(config, env) {
  if (selfUpdateOf(config) !== "on") return null;
  const { list, problem } = readPluginList(config.claude, config.folder, env, maskBasic);
  if (problem !== undefined) fail(`${problem}. Self-update reads it to find the installed plugin; to start with no self-update, use --auto-update off.`);
  const mine = list.filter(
    (entry) =>
      typeof entry.id === "string" &&
      entry.id.startsWith(`${PLUGIN_NAME}@`) &&
      typeof entry.installPath === "string" &&
      samePath(entry.installPath, PLUGIN_ROOT) &&
      appliesIn(entry, config.folder),
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
    `Self-update is on: when Doable asks for a newer release of the plugin, the session ends, and the start script updates the plugin with Claude Code's own commands and starts the new release. It updates at no other time. To turn it off, run stop, then start --machine ${machine} --auto-update off.`,
  off: (machine) =>
    `Self-update is off: when Doable asks for a newer release of the plugin, each session ends at its first wait for a request, and the next one starts 30 minutes later, until a person updates the plugin (README, "Self-update"). To turn it on, run stop, then start --machine ${machine} --auto-update on.`,
  "development folder": () =>
    "Self-update is off: the session loads the plugin from a development folder (DOABLE_CODE_AGENT_PLUGIN_DIR at setup). When Doable asks for a newer release, each session ends at its first wait for a request, and the next one starts 30 minutes later, until a person updates that folder.",
};

// What setup and start say when the session's first wait got Doable's ask for a newer release: what happens next.
const ASKED_NEXT = {
  on: "The start script updates the plugin now and starts the new release; service.log says how each step went.",
  off: 'Self-update is off: update the plugin by hand, then run stop and start (README, "Self-update"). Until then, a session starts every 30 minutes and ends at its first wait for a request.',
  "development folder": "The session loads the plugin from a development folder: update that folder, then run stop and start.",
};

// What setup prints under its Status and Stop lines: their paths name this release's folder.
const INSTALL_PATH_NOTE =
  "Each update of the plugin, a self-update too, changes its folder: run these commands from the installPath that `claude plugin list --json` names at that time.";

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

// The text of a tool's result: a string, or the text parts of a list.
function toolText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

// The first sentence of Doable MCP's ask, with the version that Doable needs: a contract with Doable MCP.
const ASK_SENTENCE = /^Doable needs the plugin (\d+\.\d+\.\d+) on this machine\./;

// The version that one answer of the wait for a request asks for, or null. Doable MCP's ask is the words "Doable needs
// the plugin 0.6.4 on this machine. End the session now, ...". Claude Code gives the session, and writes in its output,
// the answer's structured content as compact JSON: {"request":null,"capabilities_missing":false,"update":"Doable needs
// the plugin 0.6.4 on this machine. ..."}. A client that passes only the answer's text block gives the words alone.
// So the ask is a text that starts with that sentence, or a JSON record with no request (`request` null or absent)
// whose `update` is a text that starts with it. A record that holds a request is never the ask, whatever its texts
// hold: the same words in a request's text are the asker's words, not Doable's ask.
function updateVersion(text) {
  const words = ASK_SENTENCE.exec(text.trim());
  if (words !== null) return words[1];
  let answer;
  try {
    answer = JSON.parse(text);
  } catch (error) {
    // Not JSON, and not the words: a text of another kind.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return null;
  if (Object.hasOwn(answer, "request") && answer.request !== null) return null;
  if (typeof answer.update !== "string") return null;
  return ASK_SENTENCE.exec(answer.update)?.[1] ?? null;
}

// What the output of a serving session (`claude -p --output-format stream-json`) says about its start: the permission
// mode of its `system` `init` line (null when the output has none), the name of the first wait tool whose call
// returned with no error (null when none did), and the version that Doable asked for in that call's answer (null when it
// asked for none). Claude Code writes the line of a call before it checks the call's permission and before the call
// runs: only the call's result (a `tool_result` with the call's id) says that the session waits. The result of a
// refused call, or of a call that Doable refused (for example a revoked key), has `"is_error": true`. The init line also
// names each tool, so a tool's name alone says nothing.
function sessionStart(output) {
  let permissionMode = null;
  let waitTool = null;
  let updateAsked = null;
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
        updateAsked = updateVersion(toolText(part.content));
      }
    }
  }
  return { permissionMode, waitTool, updateAsked };
}

// The text of one result event of Claude Code, as { error, lines }, or null when it has none. A result has its text in
// `result`: `success` with is_error (for example when Claude Code is not signed in) or an error kind is an error. An
// error kind can have no `result` and hold its texts in `errors`, for example {"type":"result","subtype":
// "error_during_execution","is_error":true,"errors":["queryParams builder failed: ..."]}.
function resultWords(event) {
  if (typeof event.result === "string" && event.result.trim()) {
    return { error: event.is_error === true || event.subtype !== "success", lines: [event.result.trim()] };
  }
  const errors = Array.isArray(event.errors) ? event.errors.filter((text) => typeof text === "string" && text.trim()).map((text) => text.trim()) : [];
  return errors.length > 0 ? { error: true, lines: errors } : null;
}

// Why the session did not start to wait for a request, as its output (`output`, as sessionStart reads it) says it, in a
// short line masked with `mask`; or null when the output does not say. First the text of Claude Code's last result with
// a text (resultWords), which Claude Code writes when the turn ends, also when it cannot start the turn (for example
// "Not logged in · Please run /login" when Claude Code is not signed in). Else the last lines that are no event: an
// error that Claude Code or another program wrote to stderr, for example Claude Code's refusal of the bypass mode for
// root, before any event.
function notWaitingWhy(output, mask) {
  let result = null;
  const other = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(COLORS, "").trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // A half-written event (it starts with {") is no output of its own.
      if (!line.startsWith('{"')) other.push(line);
      continue;
    }
    if (event?.type === "result") result = resultWords(event) ?? result;
  }
  if (result !== null) return `${result.error ? "Claude Code's error" : "Its last message"}: "${oneLine(result.lines, mask)}".`;
  if (other.length > 0) return `The last lines of its output: "${oneLine(other.slice(-3), mask)}".`;
  return null;
}

// The start script's line in service.log when a session ended, with its exit code (runScript). After the launch, it is
// the line of the session that the launch started: `stop`, and on a Mac the launch itself (bootout), end an earlier
// start script together with its session, before that script writes the line.
const SESSION_END = /^\S+ the serving session ended with code (\d+)$/m;

function sizeOf(file) {
  return existsSync(file) ? statSync(file).size : 0;
}

// The text of the file `log` (the session's output, or service.log) after its first `from` bytes (its size at the
// launch), which the sessions before the launch wrote. Output that is shorter than `from` is all new: the start script
// moved the earlier output to session.1.jsonl because it grew too large.
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
// returned, once the session ended (its line in service.log), or after `seconds`. The Skill's first wait has
// `wait_seconds: 0`, so it returns at once. `from` holds the sizes of session.jsonl and service.log at the launch. When
// no wait returned, `ended` is the session's exit code (null while it runs), and `why` what its output says about why
// (notWaitingWhy, masked with `mask`).
function waitForStart(dir, from, seconds, mask) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    // service.log first: when it holds the session's end, the session's output is complete.
    const end = SESSION_END.exec(outputAfter(join(dir, "service.log"), from.log));
    const output = outputAfter(join(dir, "session.jsonl"), from.output);
    const seen = sessionStart(output);
    if (seen.waitTool !== null) return { ...seen, ended: null, why: null };
    if (end !== null || Date.now() >= until) return { ...seen, ended: end === null ? null : Number(end[1]), why: notWaitingWhy(output, mask) };
    execFileSync("sleep", ["1"]);
  }
}

// Launches the start script, and waits for the session's start (waitForStart), unless nothing was launched (then
// `seen` is null).
function launchAndWait(env, machine, dir, mask) {
  const seconds = waitSeconds(env);
  const from = { output: sizeOf(join(dir, "session.jsonl")), log: sizeOf(join(dir, "service.log")) };
  const how = launch(env, machine, dir);
  const seen = env.DOABLE_CODE_AGENT_NO_LAUNCH ? null : waitForStart(dir, from, seconds, mask);
  return { how, seen };
}

// What setup and start say when the session did not start to wait for a request: at once when it ended, with its exit
// code, else after the wait; with why, when its output says it.
function notWaitingWords({ ended, why }, dir) {
  const what = ended === null ? "It did not start to wait in 2 minutes." : `The session ended with code ${ended} before it started to wait for requests.`;
  return [what, why, `Read ${join(dir, "session.jsonl")} and ${join(dir, "service.log")}.`].filter((part) => part !== null).join(" ");
}

// `selfUpdate` is the machine's self-update: "on", "off" or "development folder" (selfUpdateOf).
function printStart(seen, dir, print, selfUpdate) {
  if (seen === null) return;
  const { permissionMode, waitTool, updateAsked } = seen;
  if (waitTool === null) print(notWaitingWords(seen, dir));
  // Doable records no machine whose wait it answers with its ask: the session ended, and it is not connected.
  else if (updateAsked !== null) {
    print(`Doable needs the plugin ${updateAsked} on this machine, so the session ended at its first wait for a request. ${ASKED_NEXT[selfUpdate]}`);
  } else if (waitTool === PLUGIN_WAIT_TOOL) print("It is connected: it waits for Doable's requests.");
  if (waitTool !== null && waitTool !== PLUGIN_WAIT_TOOL) {
    print(
      `It waits for Doable's requests through another Doable MCP server of your Claude Code settings (its tool ${waitTool}), not through the plugin's server, so it does not use this setup's key and machine name. Remove that server (README, "With nobody at the terminal"), then run stop and start.`,
    );
  }
  if (permissionMode !== null && permissionMode !== "bypassPermissions") {
    print(
      `It runs in the ${permissionMode} permission mode, not in the bypass mode, so with nobody at the terminal it cannot do the work of a request. Settings of this machine can turn the bypass mode off (\`disableBypassPermissionsMode\`): read the README's "With nobody at the terminal".`,
    );
  }
}

// Claude Code refuses the bypass permission mode for root ("--dangerously-skip-permissions cannot be used with root/sudo
// privileges"), unless its environment has IS_SANDBOX=1 or a CLAUDE_CODE_BUBBLEWRAP that is not empty (a sandbox), so
// a session that root runs elsewhere ends at once. setup and start refuse first, before they change anything. The
// start script of a machine without launchd gets their environment (`env`), so there they let root through in such a
// sandbox. A launchd job does not get it: on a Mac under launchd they refuse root in any case. `uid` is the user id of
// the process (process.getuid): the tests give one.
function refuseRoot(command, uid, env) {
  const sandbox = env.IS_SANDBOX === "1" || Boolean(env.CLAUDE_CODE_BUBBLEWRAP);
  if (uid === 0 && !(sandbox && !useLaunchd(env))) {
    fail(
      `Run ${command} as a normal user, not as root and not with sudo. The session runs in the bypass permission mode, which Claude Code refuses for root, so the session would never start. Use the account that is signed in to Claude Code on the Claude plan.`,
    );
  }
}

// `mask` masks the last lines of page.log and of the session's output that setup prints when the page does not run or
// the session does not start: main gives the page's mask. `options.uid` is the user id of the process (refuseRoot).
export function setup(options, env, print = console.log, mask = maskBasic) {
  const { folder, machine, promptFile, autoUpdate = true, uid = process.getuid() } = options;
  refuseRoot("setup", uid, env);
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
  const dir = serviceDir(env, machine);
  // The setup again (the README's way to change the folder or the key) keeps the page's choice of config.json unless an
  // option changes it, as start does: a page that a person turned off or moved stays so.
  const saved = existsSync(join(dir, "config.json")) ? JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) : {};
  const page = options.page ?? pageOf(saved).on;
  const pagePort = options.pagePort ?? pageOf(saved).port;
  const config = { folder: folderPath, machine, autoUpdate, page, pagePort, ...runEnvironment(env) };
  const node = findNode(config.path);
  const update = pluginToUpdate(config, env);

  checkNotRunning(env, machine, dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "env"), `export DOABLE_API_KEY=${shellQuote(key)}\nexport DOABLE_MACHINE_NAME=${shellQuote(machine)}\n`, { mode: 0o600 });
  chmodSync(join(dir, "env"), 0o600);
  writeFileSync(join(dir, "prompt.md"), `${prompt}\n`, { mode: 0o600 });
  writeRunScript(dir, config, update, node);
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

  const { how, seen } = launchAndWait(env, machine, dir, mask);
  const look = pageAfterLaunch(dir, config, seen, mask);
  print(`The Doable code agent "${machine}" serves ${folderPath}: ${how}.`);
  // When the session says that it runs in another mode, printStart says so in place of this note.
  if (seen === null || seen.permissionMode === null || seen.permissionMode === "bypassPermissions") print(NO_PERMISSION_CHECK_NOTE);
  print(chromeNote(chosen));
  printStart(seen, dir, print, selfUpdateOf(config));
  print(`Its files are in ${dir} (the key is in ${join(dir, "env")}, readable only by you).`);
  print(SELF_UPDATE_WORDS[selfUpdateOf(config)](machine));
  print(pageWords(machine, pageOf(config), look));
  print(`Status: node ${SCRIPT} status --machine ${machine}`);
  print(`Stop: node ${SCRIPT} stop --machine ${machine}`);
  print(INSTALL_PATH_NOTE);
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
  // After the start script: it starts no page once the stop file is there, also when launchd runs it at a login. Also
  // with DOABLE_CODE_AGENT_NO_LAUNCH: the page is not a launch, and the process check stops only this machine's page.
  stopPage(dir, machine);
  print(`Stopped the code agent "${machine}". Start it again with: start --machine ${machine}`);
}

// `autoUpdate`, `page` and `pagePort` are the choices of `--auto-update`, `--page` and `--page-port`, or undefined:
// start keeps the choice of config.json. `uid` and `mask` are setup's.
export function start(machine, env, print = console.log, { autoUpdate, page, pagePort, uid = process.getuid() } = {}, mask = maskBasic) {
  refuseRoot("start", uid, env);
  checkMachine(machine);
  const dir = serviceDir(env, machine);
  if (!existsSync(join(dir, "config.json"))) fail(`No code agent "${machine}" is set up on this machine: run setup first.`);
  checkNotRunning(env, machine, dir);
  const chosen = chosenBrowser(env);
  const { config, fromOlderSetup } = savedConfig(dir, env);
  if (autoUpdate !== undefined) config.autoUpdate = autoUpdate;
  if (page !== undefined) config.page = page;
  if (pagePort !== undefined) config.pagePort = pagePort;
  const node = findNode(config.path);
  const update = pluginToUpdate(config, env);
  writeConfig(dir, config);
  writeRunScript(dir, config, update, node);
  // A new command line can fail where the old one worked: the person who starts the session learns, as at setup,
  // whether it waits for requests, in which permission mode it runs (settings can turn the bypass mode off), and
  // whether it waits through the plugin's server.
  const { how, seen } = launchAndWait(env, machine, dir, mask);
  const look = pageAfterLaunch(dir, config, seen, mask);
  print(`The code agent "${machine}": ${how}.`);
  print(chromeNote(chosen));
  printStart(seen, dir, print, selfUpdateOf(config));
  // A changed choice says what it does now; `status` and the page always show it. A page that does not run is said
  // with no option too.
  if (autoUpdate !== undefined) print(SELF_UPDATE_WORDS[selfUpdateOf(config)](machine));
  if (page !== undefined || pagePort !== undefined || look?.runs === false) print(pageWords(machine, pageOf(config), look));
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

// The machine's config.json. It fails for a machine that is not set up, as the other commands do.
function setupConfig(machine, env) {
  checkMachine(machine);
  const file = join(serviceDir(env, machine), "config.json");
  if (!existsSync(file)) fail(`No code agent "${machine}" is set up on this machine: run setup first.`);
  return JSON.parse(readFileSync(file, "utf8"));
}

// Whether self-update is "on", "off", or off for a "development folder", from the machine's config.json. `status` prints
// it, and the page shows it.
export function selfUpdateState(machine, env) {
  return selfUpdateOf(setupConfig(machine, env));
}

// Whether the start script runs the page, and the page's address, from the machine's config.json (pageOf). The page
// shows it; `status` says it with pageState.
export function pageSetting(machine, env) {
  const page = pageOf(setupConfig(machine, env));
  return { on: page.on, address: pageAddress(page.port) };
}

// What `status` says about the page, with the code agent's `state` (serviceState). service.log and page.log say why the
// page does not run only while the code agent is on: it runs only while the code agent runs. A start script of plugin
// 0.6.3 or older runs no page, while a config.json of that release (no page keys) means on: a person updated the
// plugin by hand and did not run stop and start.
function pageState(dir, machine, state) {
  const page = pageOf(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")));
  const address = pageAddress(page.port);
  if (!page.on) return `The page: off. To turn it on, run stop, then start --machine ${machine} --page on.`;
  if (runningPage(dir, machine) !== null) return `The page: on, at ${address}; it runs now.`;
  if (!readFileSync(join(dir, "run.sh"), "utf8").includes("start_page")) {
    return `The page: on, at ${address}, but the start script of this machine is from an older release, which runs no page. To start the page, run stop, then start --machine ${machine} (a self-update starts it too).`;
  }
  if (state !== "on") return `The page: on, at ${address}; it runs only while the code agent runs.`;
  return `The page: on, at ${address}; it does not run now (service.log and ${join(dir, PAGE_LOG)} say why).`;
}

export function status(machine, env, print = console.log) {
  const state = serviceState(machine, env);
  const dir = serviceDir(env, machine);
  print(`Code agent "${machine}": ${state}.`);
  print(SELF_UPDATE_WORDS[selfUpdateState(machine, env)](machine));
  print(pageState(dir, machine, state));
  const asked = askedRelease(dir);
  if (asked !== null) {
    print(`Doable asked for the plugin ${asked} at ${statSync(join(dir, UPDATE_ASKED)).mtime.toISOString()}: service.log says what the start script did.`);
  }
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

// The values of `--plugin` and `--scope` that `update-request` passes to Claude Code.
function checkUpdateTarget(plugin, scope) {
  if (!PLUGIN_ID.test(plugin ?? "")) fail(`--plugin must be ${PLUGIN_NAME}@<marketplace>.`);
  if (!SCOPES.includes(scope)) fail(`--scope must be one of ${SCOPES.join(", ")}.`);
}

// The update of the plugin after a session whose wait got Doable's ask, with self-update on. Claude Code updates the
// plugin's marketplace, then the plugin in its scope, each with a time limit. Then this step reads which release Claude
// Code lists for the plugin. When that is another release than this one (its installPath is not this release's
// folder), the new release writes the start script again, and this step returns true: the start script then runs the
// new script. Else it returns false. Each step prints one line for service.log: what ran, the versions, or how a
// command failed and its last lines, masked with `mask`.
export function selfUpdate({ dir, plugin, scope }, env, print, mask) {
  const config = machineConfig(dir);
  checkUpdateTarget(plugin, scope);
  const say = (words) => print(`${logTime()} self-update: ${words}`);
  const marketplace = plugin.slice(PLUGIN_NAME.length + 1);
  for (const args of [
    ["marketplace", "update", marketplace],
    ["update", plugin, "--scope", scope],
  ]) {
    const failed = failureWords(claudePlugin(config.claude, config.folder, args, UPDATE_LIMIT_S, env), UPDATE_LIMIT_S, mask);
    if (failed !== null) {
      say(`\`claude plugin ${args.join(" ")}\` ${failed}.`);
      return false;
    }
    say(`\`claude plugin ${args.join(" ")}\` ended with no error.`);
  }
  const own = ownVersion();
  const { list, problem } = readPluginList(config.claude, config.folder, env, mask);
  const entry = list?.find((one) => one.id === plugin && one.scope === scope && appliesIn(one, config.folder));
  if (problem !== undefined || typeof entry?.installPath !== "string") {
    say(`${problem ?? `\`claude plugin list --json\` names no ${plugin} in the ${scope} scope`}.`);
    return false;
  }
  if (samePath(entry.installPath, PLUGIN_ROOT)) {
    say(`${plugin} is at ${own}, the release of this start script.`);
    return false;
  }
  say(`${plugin} went from ${own} to ${entry.version}: the new release writes the start script again.`);
  const newScript = join(entry.installPath, "scripts", "code-agent-service.mjs");
  if (!existsSync(newScript)) {
    say(`${entry.version} has no ${newScript}.`);
    return false;
  }
  const write = limitedRun(process.execPath, [newScript, "write-start-script", "--dir", dir], { cwd: config.folder, seconds: WRITE_LIMIT_S, env });
  const failed = failureWords(write, WRITE_LIMIT_S, mask);
  if (failed !== null) {
    say(`\`write-start-script\` of ${entry.version} ${failed}.`);
    return false;
  }
  say(`${entry.version} wrote the start script: the session starts with it.`);
  return true;
}

// `write-start-script`: writes the start script with this release's command line, as `start` does, and starts nothing.
// An older release's self-update runs it, from the new release's folder, after Claude Code installed the new release:
// keep this command and its --dir option in each release.
export function writeStartScript({ dir }, env) {
  const config = machineConfig(dir);
  writeRunScript(dir, config, pluginToUpdate(config, env), findNode(config.path));
}

// `stop-page`: the start script's step at its start and after its loop. It stops the page that a start script started
// (page.pid), of this release or of another one, and prints a line for service.log when it stopped one.
export function stopPageStep({ dir }, print) {
  const config = machineConfig(dir);
  const pids = stopPage(dir, config.machine);
  if (pids.length > 0) print(`${logTime()} the page (${processWords(pids)}) stopped.`);
}

// The page's address line in page.log: the page prints it when it listens.
const PAGE_LISTENS = /^The page of the code agent ".+": http:\/\/127\.0\.0\.1:\d+\/$/m;

// The last lines of page.log, masked with `mask` (the page's output holds the error that ended it, and can hold
// another text of a log). Eight lines keep the error's message above a short stack.
function pageLogEnd(dir, mask) {
  const file = join(dir, PAGE_LOG);
  const lines = (existsSync(file) ? readFileSync(file, "utf8") : "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8);
  if (lines.length === 0) return "Its page.log is empty.";
  return `The last lines of page.log: ${oneLine(lines, mask)}`;
}

// The process id of the page that the start script started (runningPage) once that page listens (its address line in
// page.log), or null once it ended. A page that has just started can still end, for example when its port is in use:
// this waits up to PAGE_START_S seconds for one or the other.
function settledPage(dir, machine) {
  const log = join(dir, PAGE_LOG);
  const until = Date.now() + PAGE_START_S * 1000;
  let pid = runningPage(dir, machine);
  while (pid !== null && Date.now() < until && !(existsSync(log) && PAGE_LISTENS.test(readFileSync(log, "utf8")))) {
    pause(100);
    pid = runningPage(dir, machine);
  }
  return pid;
}

// What setup and start saw of the page after the launch, for pageWords: null when they launched nothing (then the start
// script has not run) or the page is off. Else whether the page runs (settledPage), and when it does not, the last
// lines of page.log, masked with `mask`. When the session's first wait returned, the start script has checked its page
// before that session's start (check-page), and started it again when it did not run.
function pageAfterLaunch(dir, config, seen, mask) {
  if (seen === null || !pageOf(config).on) return null;
  if (settledPage(dir, config.machine) !== null) return { runs: true };
  return { runs: false, why: pageLogEnd(dir, mask) };
}

// `check-page`: the start script's step before each session's start, with the page on. It returns 0 while the page
// that the start script started (page.pid) runs, once it listens (settledPage). When the page does not run, it prints
// one line for service.log, with the last lines of page.log masked with `mask`, and returns PAGE_NOT_RUNNING: the start
// script then starts the page again.
export function checkPage({ dir }, print, mask) {
  const config = machineConfig(dir);
  if (settledPage(dir, config.machine) !== null) return 0;
  print(
    `${logTime()} the page at ${pageAddress(pageOf(config).port)} does not run (README, "The code agent's page"); the start script starts it again. ${pageLogEnd(dir, mask)}`,
  );
  return PAGE_NOT_RUNNING;
}

// The version that Doable asked for in the output of a serving session (as sessionStart reads it): the last answer of a
// wait for a request that returned with no error and that is Doable's ask (updateVersion); null when none is.
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

// `update-request`: the start script's step after each session. It reads the session's output after its first `from`
// bytes. When a wait got Doable's ask for a release above this one, it keeps the asked version in `update-asked` and
// prints a line for service.log. With self-update on (`plugin` and `scope` given), it then updates the plugin
// (selfUpdate), and returns NEW_START_SCRIPT when a new release wrote the start script. When this machine still runs a
// lower release, or with self-update off or a development folder, it prints that a person must act and returns
// ASKED_WAIT: the next session starts 30 minutes later. It returns 0 when Doable did not ask.
export function updateRequest({ dir, from, plugin, scope }, env, print, mask) {
  const config = machineConfig(dir);
  if (!Number.isInteger(from)) fail("--from must be a whole number of bytes.");
  const updating = plugin !== undefined || scope !== undefined;
  if (updating) checkUpdateTarget(plugin, scope);
  const asked = askedVersion(outputAfter(join(dir, "session.jsonl"), from));
  if (asked === null) return 0;
  const own = ownVersion();
  print(`${logTime()} Doable asked for the plugin ${asked}; this release is ${own}.`);
  // Doable asks only a machine whose release is lower than the one that it needs.
  if (compareVersions(asked, own) <= 0) return 0;
  writeFileSync(join(dir, UPDATE_ASKED), `${asked}\n`, { mode: 0o600 });
  if (updating) {
    if (selfUpdate({ dir, plugin, scope }, env, print, mask)) return NEW_START_SCRIPT;
    print(
      `${logTime()} self-update: this release (${own}) is still lower than ${asked}, which Doable asked for: a person must act (README, "Self-update"). The next session starts in 30 minutes.`,
    );
  } else {
    const why = selfUpdateOf(config) === "development folder" ? "The session loads the plugin from a development folder" : "Self-update is off";
    print(
      `${logTime()} ${why}: a person must update the plugin to ${asked}, then run stop and start (README, "Self-update"). Until then, each session ends at its first wait for a request, and the next session starts in 30 minutes.`,
    );
  }
  return ASKED_WAIT;
}

// The options that each command takes. A command refuses an option of another command, and names the options that it
// takes: it would not use that option, and the person would think that it did (for example the page command's --port,
// given to start to move the service's page). main refuses a command that this list does not name.
const COMMAND_OPTIONS = {
  setup: ["--folder", "--machine", "--prompt-file", "--auto-update", "--page", "--page-port"],
  start: ["--machine", "--auto-update", "--page", "--page-port"],
  status: ["--machine"],
  stop: ["--machine"],
  remove: ["--machine"],
  page: ["--machine", "--port", "--pid-file"],
  browser: [],
  "update-request": ["--dir", "--from", "--plugin", "--scope"],
  "write-start-script": ["--dir"],
  "stop-page": ["--dir"],
  "check-page": ["--dir"],
};
const KNOWN_OPTIONS = new Set(Object.values(COMMAND_OPTIONS).flat());

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  let i = 0;
  while (i < rest.length) {
    const name = rest[i];
    if (RETIRED_OPTIONS.includes(name)) fail(`${name} is not needed: this release allows every tool and has Chrome on.`);
    if (!KNOWN_OPTIONS.has(name)) fail(`Unknown option ${name}.`);
    if (Object.hasOwn(COMMAND_OPTIONS, command) && !COMMAND_OPTIONS[command].includes(name)) {
      const takes = COMMAND_OPTIONS[command];
      const pagePort = name === "--port" && takes.includes("--page-port") ? " The page's port is --page-port <number>." : "";
      fail(`${command} does not take ${name}: it takes ${takes.length === 0 ? "no option" : takes.join(", ")}.${pagePort}`);
    }
    const value = rest[i + 1];
    if (value === undefined) fail(`${name} needs a value.`);
    if (name === "--folder") options.folder = value;
    else if (name === "--machine") options.machine = value;
    else if (name === "--prompt-file") options.promptFile = value;
    else if (name === "--port") options.port = portNumber(name, value);
    else if (name === "--pid-file") options.pidFile = value;
    else if (name === "--auto-update") options.autoUpdate = onOrOff(name, value);
    else if (name === "--page") options.page = onOrOff(name, value);
    else if (name === "--page-port") options.pagePort = portNumber(name, value);
    else if (name === "--dir") options.dir = value;
    else if (name === "--plugin") options.plugin = value;
    else if (name === "--scope") options.scope = value;
    else if (name === "--from") options.from = byteCount(value);
    else fail(`Unknown option ${name}.`);
    i += 2;
  }
  return { command, options };
}

function onOrOff(name, value) {
  if (value !== "on" && value !== "off") fail(`${name} must be on or off.`);
  return value === "on";
}

function byteCount(value) {
  if (!/^\d+$/.test(value)) fail("--from must be a whole number of bytes.");
  return Number(value);
}

// The port of the page's address (`page --port`, and `--page-port` of setup and start).
function portNumber(name, value) {
  const port = /^\d{1,5}$/.test(value) ? Number(value) : 0;
  if (port < 1 || port > 65535) fail(`${name} must be a whole number from 1 to 65535.`);
  return port;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const env = process.env;
  if (command === "setup" || command === "start") {
    // The page's mask for the last lines of page.log that they print, loaded only for these commands, as for `page`.
    const { maskSecrets } = await import("./code-agent-page.mjs");
    const mask = (text) => maskSecrets(text);
    if (command === "setup") setup(options, env, console.log, mask);
    else start(options.machine, env, console.log, options, mask);
  } else if (command === "stop") stop(options.machine, env);
  else if (command === "status") status(options.machine, env);
  else if (command === "remove") remove(options.machine, env);
  else if (command === "browser") browser(env);
  else if (command === "page") {
    // Loaded only for this command: the page's module imports this one.
    const { page } = await import("./code-agent-page.mjs");
    await page(options, env);
  } else if (command === "update-request") {
    // The page's mask, loaded only for this command, as for `page`.
    const { maskSecrets } = await import("./code-agent-page.mjs");
    process.exitCode = updateRequest(options, env, console.log, (text) => maskSecrets(text));
  } else if (command === "write-start-script") writeStartScript(options, env);
  else if (command === "stop-page") stopPageStep(options, console.log);
  else if (command === "check-page") {
    // The page's mask, loaded only for this command, as for `page`.
    const { maskSecrets } = await import("./code-agent-page.mjs");
    process.exitCode = checkPage(options, console.log, (text) => maskSecrets(text));
  } else fail("Use setup, status, stop, start, remove, page or browser (see the comment at the top of this file).");
}

// The real path: with a link in the path (a linked ~/.claude), the script must run, not end with no output.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
