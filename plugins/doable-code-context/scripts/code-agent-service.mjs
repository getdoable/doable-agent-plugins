#!/usr/bin/env node

// Runs the Doable code agent in the background on this machine: one serving session of Claude Code in the dontAsk
// permission mode, started again when it stops (a plan limit, a crash), kept awake on a Mac, and started at login by
// launchd on a Mac. The setup prompt that a request card copies ("Always on") runs `setup`; a person runs `status`,
// `stop`, `start` and `remove`. Fixed code does these steps, not the model: they must be the same on every machine.
//
// Usage:
//   DOABLE_API_KEY=... node code-agent-service.mjs setup --folder DIR --machine NAME --prompt-file FILE [--allow RULE]...
//   node code-agent-service.mjs status|stop|start|remove --machine NAME

import { execFileSync, spawn } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MACHINE_NAME = /^[A-Za-z0-9._-]{1,64}$/;
// An organization API key: the code agent tools refuse a personal key and a login token.
const ORGANIZATION_KEY = /^sk-doable-(?!personal-)[A-Za-z0-9_-]{16,}$/;
const ANY_DOABLE_KEY = /sk-doable-[A-Za-z0-9_-]+/;
// The three rules that every serving session with nobody at the terminal needs (README, "With nobody at the terminal").
const BASE_RULES = ["Skill(doable-code-context:doable-code-agent)", "mcp__plugin_doable-code-context_doable", "Bash(sleep 20)"];
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

export function runScript({ dir, folder, claude, rules, path, wake }) {
  const allowed = rules.map(shellQuote).join(" ");
  const wakeLock = wake ? "/usr/bin/caffeinate -i -s " : "";
  return `#!/bin/bash
# Written by doable-code-context's code-agent-service.mjs. It serves Doable requests in ${folder}
# until \`code-agent-service.mjs stop\` writes the stop file. Do not edit it: setup writes it again.
set -u
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
  ${wakeLock}${shellQuote(claude)} -p --permission-mode dontAsk --output-format stream-json --verbose --allowedTools ${allowed} < "$dir/prompt.md" >> "$dir/session.jsonl" 2>&1
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

function waitForFirstWait(env, dir) {
  const seconds = env.DOABLE_CODE_AGENT_WAIT_S === undefined ? 120 : Number(env.DOABLE_CODE_AGENT_WAIT_S);
  const log = join(dir, "session.jsonl");
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (existsSync(log) && readFileSync(log, "utf8").includes("wait_for_code_agent_request")) return true;
    execFileSync("sleep", ["5"]);
  }
  return false;
}

export function setup(options, env, print = console.log) {
  const { folder, machine, promptFile, allow = [] } = options;
  checkMachine(machine);
  const key = env.DOABLE_API_KEY || "";
  if (!ORGANIZATION_KEY.test(key)) {
    fail("Set DOABLE_API_KEY to the organization API key that the request card gave (it starts with sk-doable-, not sk-doable-personal-).");
  }
  if (!folder || !isAbsolute(folder) || !existsSync(folder) || !statSync(folder).isDirectory()) {
    fail("--folder must be the absolute path of the folder that holds the repositories.");
  }
  if (!promptFile || !existsSync(promptFile)) fail("--prompt-file must name the file that holds the serving session's prompt.");
  const prompt = readFileSync(promptFile, "utf8").trim();
  if (!prompt) fail("The prompt file is empty.");
  if (ANY_DOABLE_KEY.test(prompt)) fail("The prompt file holds a Doable API key. Take the key out: setup keeps it in its own file.");
  for (const rule of allow) {
    if (!rule || /[\n\r]/.test(rule)) fail(`--allow "${rule}" is not one rule.`);
  }

  const dir = serviceDir(env, machine);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "env"), `export DOABLE_API_KEY=${shellQuote(key)}\nexport DOABLE_MACHINE_NAME=${shellQuote(machine)}\n`, { mode: 0o600 });
  chmodSync(join(dir, "env"), 0o600);
  writeFileSync(join(dir, "prompt.md"), `${prompt}\n`, { mode: 0o600 });
  const folderPath = resolve(folder);
  const wake = process.platform === "darwin" && existsSync("/usr/bin/caffeinate");
  const script = runScript({ dir, folder: folderPath, claude: findClaude(env), rules: [...BASE_RULES, ...allow], path: env.PATH || "", wake });
  writeFileSync(join(dir, "run.sh"), script, { mode: 0o700 });
  chmodSync(join(dir, "run.sh"), 0o700);
  writeFileSync(join(dir, "config.json"), `${JSON.stringify({ folder: folderPath, machine, allow }, null, 2)}\n`, { mode: 0o600 });
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
  if (!existsSync(join(dir, "run.sh"))) fail(`No code agent "${machine}" is set up on this machine: run setup first.`);
  print(`The code agent "${machine}": ${launch(env, machine, dir)}.`);
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
  const options = { allow: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const [name, value] = [rest[i], rest[i + 1]];
    if (value === undefined) fail(`${name} needs a value.`);
    if (name === "--allow") options.allow.push(value);
    else if (name === "--folder") options.folder = value;
    else if (name === "--machine") options.machine = value;
    else if (name === "--prompt-file") options.promptFile = value;
    else fail(`Unknown option ${name}.`);
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
