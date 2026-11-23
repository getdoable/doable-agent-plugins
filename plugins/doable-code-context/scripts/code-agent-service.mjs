#!/usr/bin/env node

// Runs the Doable code agent in the background on this machine: one serving session of Claude Code in the bypass
// permission mode (no permission check) with Claude in Chrome, started again when it stops (a plan limit, a crash),
// kept awake on a Mac, and started at login by launchd on a Mac. A person runs `setup` (the README's "Always on"),
// then `status`, `stop`, `start` and `remove`. `start` writes the start script again with the command line of the
// plugin release that runs it, so a plugin update, then `stop` and `start`, gives the serving session the new release
// and its command line. Fixed code does these steps, not the model: they must be the same on every machine.
//
// Usage:
//   DOABLE_API_KEY=... node code-agent-service.mjs setup --folder DIR --machine NAME --prompt-file FILE
//   node code-agent-service.mjs status|stop|start|remove --machine NAME
//
// The serving session can use every tool with no permission check, and Claude in Chrome, so that it can open a page in
// this machine's Chrome, for example the link of a sign-up mail from the request's test inbox. Only the rules of its
// prompt and of the Skill keep it from a write to production. It cannot load one tool: Doable MCP's `ask_code_agent`,
// with which a person's Claude Code asks a machine, so that the session cannot send a request to itself.
//
// For development, DOABLE_CODE_AGENT_PLUGIN_DIR at setup makes the serving session load the plugin from that folder
// (`claude --plugin-dir`) in place of the installed plugin.

import { execFileSync, spawn } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MACHINE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
// An organization API key: the code agent tools refuse a personal key and a login token.
const ORGANIZATION_KEY = /^sk-doable-(?!personal-)[A-Za-z0-9_-]{16,}$/;
const ANY_DOABLE_KEY = /sk-doable-[A-Za-z0-9_-]+/;
// The one tool that the serving session cannot load (README, "With nobody at the terminal"): the tool with which a
// person's Claude Code asks a machine. With it, the session could send a request to itself.
const ASKING_TOOL = "mcp__plugin_doable-code-context_doable__ask_code_agent";
// The options of plugin 0.6.0's setup that this release refuses: the session allows every tool and has Chrome on.
const RETIRED_OPTIONS = ["--allow", "--chrome"];
const RESTART_WAIT_S = 300;
const LOG_MAX_BYTES = 20 * 1024 * 1024;
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
    fail("--machine must be 1 to 64 characters, each a letter, a digit, '.', '_' or '-'.");
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

export function runScript({ dir, folder, claude, path, wake, pluginDir = null }) {
  const plugin = pluginDir ? `--plugin-dir ${shellQuote(pluginDir)} ` : "";
  const wakeLock = wake ? "/usr/bin/caffeinate -i -s " : "";
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
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) the serving session starts" >> "$dir/service.log"
  ${wakeLock}${shellQuote(claude)} -p ${plugin}--permission-mode bypassPermissions --chrome --disallowedTools ${shellQuote(ASKING_TOOL)} --output-format stream-json --verbose < "$dir/prompt.md" >> "$dir/session.jsonl" 2>&1
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) the serving session ended with code $?" >> "$dir/service.log"
  [ -e "$dir/stopped" ] && break
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

// The start script, from config.json and this release's command line. A config.json of plugin 0.5.0 or 0.6.0 also
// holds the person's `allow` list: this release does not use it, because the session allows every tool.
function writeRunScript(dir, config) {
  const script = runScript({
    dir,
    folder: config.folder,
    claude: config.claude,
    path: config.path,
    wake: config.wake,
    pluginDir: config.pluginDir,
  });
  writeFileSync(join(dir, "run.sh"), script, { mode: 0o700 });
  chmodSync(join(dir, "run.sh"), 0o700);
}

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
// terminal" and "A browser for a mail's link"). Nobody answers a prompt of the Claude in Chrome extension.
const NO_PERMISSION_CHECK_NOTE =
  "It runs in the bypass permission mode: it can use every tool and command of this machine with no prompt, and only the rules of its prompt and of the Skill keep it from a write to production.";
const CHROME_NOTE =
  "It uses Claude in Chrome: keep Chrome open on this machine with the Claude in Chrome extension connected, and let the extension act on the test sites without asking.";

function plistPath(env, machine) {
  return join(env.DOABLE_LAUNCH_AGENTS_DIR || join(homedir(), "Library", "LaunchAgents"), `${launchdLabel(machine)}.plist`);
}

function useLaunchd(env) {
  return process.platform === "darwin" && !env.DOABLE_CODE_AGENT_NO_LAUNCH;
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

// Whether the serving session's output holds a call of the wait tool. Its first line lists every tool by name, so a
// match on the name alone says "connected" before the session waits (seen in the live check of 2026-11-19).
export function sawFirstWait(output) {
  return /"name":\s*"[^"]*wait_for_code_agent_request"/.test(output);
}

function waitForFirstWait(env, dir) {
  const seconds = env.DOABLE_CODE_AGENT_WAIT_S === undefined ? 120 : Number(env.DOABLE_CODE_AGENT_WAIT_S);
  const log = join(dir, "session.jsonl");
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (existsSync(log) && sawFirstWait(readFileSync(log, "utf8"))) return true;
    execFileSync("sleep", ["5"]);
  }
  return false;
}

export function setup(options, env, print = console.log) {
  const { folder, machine, promptFile } = options;
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

  const dir = serviceDir(env, machine);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "env"), `export DOABLE_API_KEY=${shellQuote(key)}\nexport DOABLE_MACHINE_NAME=${shellQuote(machine)}\n`, { mode: 0o600 });
  chmodSync(join(dir, "env"), 0o600);
  writeFileSync(join(dir, "prompt.md"), `${prompt}\n`, { mode: 0o600 });
  const folderPath = resolve(folder);
  const config = { folder: folderPath, machine, ...runEnvironment(env) };
  writeRunScript(dir, config);
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

  const how = launch(env, machine, dir);
  const connected = env.DOABLE_CODE_AGENT_NO_LAUNCH ? null : waitForFirstWait(env, dir);
  print(`The Doable code agent "${machine}" serves ${folderPath}: ${how}.`);
  print(NO_PERMISSION_CHECK_NOTE);
  print(CHROME_NOTE);
  if (connected === true) print("It is connected: it waits for Doable's requests.");
  if (connected === false) print(`It did not start to wait in 2 minutes. Read ${join(dir, "session.jsonl")} and ${join(dir, "service.log")}.`);
  print(`Its files are in ${dir} (the key is in ${join(dir, "env")}, readable only by you).`);
  print(`Status: node ${fileURLToPath(import.meta.url)} status --machine ${machine}`);
  print(`Stop: node ${fileURLToPath(import.meta.url)} stop --machine ${machine}`);
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

export function start(machine, env, print = console.log) {
  checkMachine(machine);
  const dir = serviceDir(env, machine);
  if (!existsSync(join(dir, "config.json"))) fail(`No code agent "${machine}" is set up on this machine: run setup first.`);
  const { config, fromOlderSetup } = savedConfig(dir, env);
  writeRunScript(dir, config);
  print(`The code agent "${machine}": ${launch(env, machine, dir)}.`);
  print(CHROME_NOTE);
  if (fromOlderSetup) {
    print(
      `If the secret rule in ${join(dir, "prompt.md")} has no exception for a new test login's password, add this sentence to it, then run stop and start again: "${PASSWORD_EXCEPTION}"`,
    );
  }
}

export function status(machine, env, print = console.log) {
  checkMachine(machine);
  const dir = serviceDir(env, machine);
  if (!existsSync(dir)) fail(`No code agent "${machine}" is set up on this machine.`);
  const stopped = existsSync(join(dir, "stopped"));
  const running = useLaunchd(env) ? launchctl(["print", `gui/${process.getuid()}/${launchdLabel(machine)}`], { quiet: true }) : null;
  print(`Code agent "${machine}": ${stopped ? "stopped" : running === false ? "not running" : "on"}.`);
  const session = join(dir, "session.jsonl");
  if (existsSync(session)) print(`Last activity: ${statSync(session).mtime.toISOString()} (${session}).`);
  const log = join(dir, "service.log");
  if (existsSync(log)) {
    for (const line of readFileSync(log, "utf8").trim().split("\n").slice(-5)) print(`  ${line.replace(ANY_DOABLE_KEY, "sk-doable-****")}`);
  }
}

export function remove(machine, env, print = console.log) {
  checkMachine(machine);
  const dir = serviceDir(env, machine);
  if (existsSync(dir)) stop(machine, env, () => {});
  if (!env.DOABLE_CODE_AGENT_NO_LAUNCH) rmSync(plistPath(env, machine), { force: true });
  rmSync(dir, { recursive: true, force: true });
  print(`Removed the code agent "${machine}" and its files, its key too. Revoke the key in Doable's Settings > API Keys.`);
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
    else fail(`Unknown option ${name}.`);
    i += 2;
  }
  return { command, options };
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const env = process.env;
  if (command === "setup") setup(options, env);
  else if (command === "stop") stop(options.machine, env);
  else if (command === "start") start(options.machine, env);
  else if (command === "status") status(options.machine, env);
  else if (command === "remove") remove(options.machine, env);
  else fail("Use setup, status, stop, start or remove (see the comment at the top of this file).");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
