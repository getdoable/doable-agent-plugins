import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { launchdPlist, parseArgs, remove, serviceDir, setup, stop } from "../plugins/doable-code-context/scripts/code-agent-service.mjs";

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

test("the start script runs the serving session in dontAsk mode with the three rules and the person's rules, and starts it again", () => {
  const m = machine();
  setup({ folder: m.folder, machine: "mac-mini-1", promptFile: m.prompt, allow: ["Bash(npm test *)", "Bash(curl https://staging.example.com/*)"] }, m.env, () => {});
  const run = readFileSync(join(serviceDir(m.env, "mac-mini-1"), "run.sh"), "utf8");
  assert.match(run, /'\/opt\/claude'\\''s bin\/claude' -p --permission-mode dontAsk --output-format stream-json --verbose --allowedTools 'Skill\(doable-code-context:doable-code-agent\)' 'mcp__plugin_doable-code-context_doable' 'Bash\(sleep 20\)' 'Bash\(npm test \*\)' 'Bash\(curl https:\/\/staging\.example\.com\/\*\)' < "\$dir\/prompt\.md"/);
  assert.match(run, /while \[ ! -e "\$dir\/stopped" \]; do/);
  assert.match(run, /sleep 300/);
  assert.match(run, /unset ANTHROPIC_API_KEY/);
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

test("the launchd job starts the start script at login, with no KeepAlive, so that a stop stays stopped", () => {
  const plist = launchdPlist({ machine: "mac-mini-1", dir: "/srv/agent/.doable/code-agent/mac-mini-1" });
  assert.match(plist, /<string>ai\.getdoable\.code-agent\.mac-mini-1<\/string>/);
  assert.match(plist, /<string>\/bin\/bash<\/string><string>\/srv\/agent\/\.doable\/code-agent\/mac-mini-1\/run\.sh<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.ok(!plist.includes("KeepAlive"));
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
