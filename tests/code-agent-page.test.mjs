import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import {
  DEFAULT_PORT,
  PageData,
  SessionLogs,
  maskSecrets,
  pageHtml,
  pageView,
  startPageServer,
} from "../plugins/doable-code-context/scripts/code-agent-page.mjs";
import { parseArgs, serviceDir } from "../plugins/doable-code-context/scripts/code-agent-service.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "plugins", "doable-code-context", "scripts", "code-agent-service.mjs");

// Secrets that a serving session's output can hold. Each is built from parts, so that the release verifier's check for
// keys and credentials in the repository finds none in this file.
const KEY = ["sk", "doable", "page0123456789abcdefghij"].join("-");
const BEARER_TOKEN = ["eyJhbGciOiJIUzI1NiJ9", "cGFnZQ", "c2lnbmF0dXJl"].join(".");
const BEARER_HEADER = ["Authorization:", "Bearer", BEARER_TOKEN].join(" ");
const MASKED_BEARER_HEADER = ["Authorization:", "Bearer", "****"].join(" ");
// The password of a login that a result holds: only the mask of collected passwords finds it in a command or a text.
const LOGIN_PASSWORD = "Tq7!vaporMaple42";
// A password that only a command names, after its name.
const NAMED_PASSWORD = "Blue-Heron-9931";
const DB_SECRET = "s3cr3t-db-value";
// The value of an environment variable whose name holds KEY but no other secret's name.
const SIGNING_KEY = "k3y-value-777";
const LOG_PASSWORD = "hunter-two-77";
const LOG_TOKEN = "abc123def456";
const URL_PASSWORD = "pw-db-4411";
const BASIC_CREDENTIAL = "dXNlcjpwYXNz";
const SECRETS = [KEY, BEARER_TOKEN, LOGIN_PASSWORD, NAMED_PASSWORD, DB_SECRET, SIGNING_KEY, LOG_PASSWORD, LOG_TOKEN, URL_PASSWORD, BASIC_CREDENTIAL];

// What the page and its command say about who can open the page and what it hides (README, "The code agent's page").
const PAGE_ACCESS = "Other computers cannot open it, but any account or program on this computer can, not only you.";
const PAGE_MASK =
  "It shows **** in place of each password of a login in a result, each Doable API key, and secrets in known forms " +
  "(NAME=value, password: value, --password value, -u user:password, a URL's password, Bearer and Basic headers). " +
  "A secret in another form can still show: for example a password in a sentence, or a new login's password as a " +
  "script's argument until the result names that login.";

const PLUGIN = "mcp__plugin_doable-code-context_doable__";
const USER_SCOPED = "mcp__doable__";
const MODEL = "claude-opus-5-5";
const CHAT_URL = "https://app.getdoable.ai/org/acme/suites/ts-kfpwqzra/chat/0199c1a2-7b1e-7c55-9c0f-3c1d5a6f2b90";
// The routes of the page's data, and a path of each that the server answers.
const DATA_PATHS = ["/data.json", "/request.json?id=CA-AAAAA1", "/sessions.json?page=1&size=10&open=s-1", "/session.json?id=s-1", "/log.json?page=1", "/search.json?q=login"];
const NOT_FOUND = "Not found. This page has only /, /data.json, /request.json, /sessions.json, /session.json, /log.json and /search.json.\n";
const SESSIONS_TAKES = "/sessions.json takes page, a whole number from 1, size: 10, 25 or 50, and open, the id of a session: 1 to 100 letters, digits, '.', '_' or '-'.";
const SESSION_TAKES = "/session.json takes id, the id of a session: 1 to 100 letters, digits, '.', '_' or '-'.";
const SEARCH_TAKES = "/search.json takes q, the words to search for: 1 to 200 characters.";
// The time of the page's server in the tests: three hours after the logs' first times, so that no question that waits
// is 24 hours old. A test of that age gives its own clock.
const CLOCK = () => Date.parse("2026-11-25T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
// Doable's ask for a newer plugin, in the answer of a wait for a request.
const ASK =
  "Doable needs the plugin 0.6.4 on this machine. End the session now, and call no other tool. An Always on service updates the plugin and starts the session again.";

// A request as Doable MCP returns it (CodeAgentTask), in the field order of the recorded sessions.
function task(id, fields = {}) {
  return {
    status: "working",
    kind: null,
    asked_by: "chat",
    asked_by_user: null,
    machine: "mac-mini-1",
    cancel_requested: false,
    organization: { slug: "acme" },
    suite: { id: "ts-kfpwqzra", name: "Time off" },
    chat: { id: "0199c1a2-7b1e-7c55-9c0f-3c1d5a6f2b90", url: CHAT_URL },
    environment: {
      id: "0199c1a0-11aa-7c01-8a55-0d7a3f6f1c22",
      name: "Staging",
      entry_url: "https://timeoff.staging.acme.example/login",
      hosts: ["timeoff.staging.acme.example"],
    },
    accounts: [{ username: "qa-manager@acme.example", note: "manager of qa-employee" }],
    test_inbox: "acme-tests@mail.getdoable.ai",
    tests: [],
    run: null,
    question: null,
    answer: null,
    id,
    asked_at: "2026-11-25T08:55:00Z",
    request: `The request ${id}, in the asker's words.`,
    ...fields,
  };
}

// A direct request from a person's Claude Code: no suite, no chat, no environment.
function directTask(id, user, fields = {}) {
  return task(id, { asked_by: "claude_code", asked_by_user: user, suite: null, chat: null, environment: null, accounts: [], ...fields });
}

// The lines of a serving session's output, as `claude -p --output-format stream-json --verbose` (Claude Code 2.1.326)
// wrote them in recorded sessions: an init line with no time, assistant lines with a tool call or a text and the call's
// input again in wire_tool_inputs, user lines with the call's result and that result again in tool_use_result, and
// lines with no time (thinking tokens, rate limits). `prefix` is the Doable MCP server's prefix of the tool names.
class Log {
  constructor(prefix = PLUGIN, start = "2026-11-25T09:00:01.000Z") {
    this.prefix = prefix;
    this.lines = [];
    this.clock = Date.parse(start);
    this.calls = 0;
    this.session = null;
  }

  at(time) {
    this.clock = Date.parse(time);
    return this;
  }

  tick() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  event(fields) {
    this.lines.push(JSON.stringify(fields));
    return this;
  }

  init(session, { server = "plugin:doable-code-context:doable", status = "connected", permissionMode = "bypassPermissions" } = {}) {
    this.session = session;
    return this.event({
      type: "system",
      subtype: "init",
      cwd: "/srv/repos/acme-timeoff",
      session_id: session,
      tools: ["Bash", "Read", `${this.prefix}wait_for_code_agent_request`, `${this.prefix}update_code_agent_request`],
      mcp_servers: [
        { name: server, status, source: "dynamic" },
        { name: "claude-in-chrome", status: "connected", source: "dynamic" },
      ],
      model: MODEL,
      permissionMode,
      apiKeySource: "none",
      claude_code_version: "2.1.326",
      uuid: `init-${session}`,
    });
  }

  quiet(status = "allowed") {
    this.event({ type: "system", subtype: "thinking_tokens", estimated_tokens: 50, estimated_tokens_delta: 50, session_id: this.session, uuid: "t" });
    return this.event({
      type: "rate_limit_event",
      rate_limit_info: { status, resetsAt: 1795881600, rateLimitType: "seven_day" },
      uuid: "r",
      session_id: this.session,
    });
  }

  assistant(content, extra = {}) {
    return this.event({
      type: "assistant",
      message: { model: MODEL, id: `msg_${this.lines.length}`, type: "message", role: "assistant", content, stop_reason: null },
      parent_tool_use_id: null,
      session_id: this.session,
      uuid: `a-${this.lines.length}`,
      timestamp: this.tick(),
      ...extra,
    });
  }

  // A tool call, and its result unless `answer` is undefined (a call that waits for its result now).
  call(name, input, answer, { isError = false } = {}) {
    this.calls += 1;
    const id = `toolu_${String(this.calls).padStart(4, "0")}`;
    this.assistant([{ type: "tool_use", id, name, input, caller: { type: "direct" } }], { wire_tool_inputs: { [id]: input } });
    if (answer === undefined) return this;
    return this.event({
      type: "user",
      message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: answer, is_error: isError }] },
      parent_tool_use_id: null,
      session_id: this.session,
      uuid: `u-${id}`,
      timestamp: this.tick(),
      tool_use_result: isError ? `Error: ${answer}` : { content: answer },
    });
  }

  wait(found = null) {
    return this.call(`${this.prefix}wait_for_code_agent_request`, { wait_seconds: 290 }, JSON.stringify({ request: found, capabilities_missing: false }));
  }

  // A wait for a request whose result has not come yet: the session waits now.
  waiting() {
    return this.call(`${this.prefix}wait_for_code_agent_request`, { wait_seconds: 290 }, undefined);
  }

  update(input, answer) {
    return this.call(`${this.prefix}update_code_agent_request`, input, JSON.stringify(answer));
  }

  refuse(input, reason) {
    return this.call(`${this.prefix}update_code_agent_request`, input, reason, { isError: true });
  }

  bash(description, command) {
    return this.call("Bash", { command, description }, "ok");
  }

  read(path) {
    return this.call("Read", { file_path: path }, "1\tthe file");
  }

  say(text) {
    return this.assistant([{ type: "text", text }]);
  }

  end(subtype, result, isError) {
    return this.event({ type: "result", subtype, is_error: isError, duration_ms: 61000, num_turns: 12, result, session_id: this.session, uuid: "end" });
  }

  text() {
    return `${this.lines.join("\n")}\n`;
  }
}

// A machine's folder for the service, with no launch: the page's state comes from the stop file and the start script's
// pid, as on a machine without launchd.
function machine(t, name = "mac-mini-1") {
  const base = mkdtempSync(join(tmpdir(), "code-agent-page-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { PATH: "/usr/bin:/bin", DOABLE_CODE_AGENT_HOME: join(base, "home"), DOABLE_CODE_AGENT_NO_LAUNCH: "1" };
  const dir = serviceDir(env, name);
  mkdirSync(dir, { recursive: true });
  // The part of setup's config.json that the page reads: self-update is on, for the installed plugin.
  writeFileSync(join(dir, "config.json"), `${JSON.stringify({ machine: name, autoUpdate: true, pluginDir: null })}\n`);
  return { base, env, dir, name };
}

// The service on: a start script that runs, named by the pid file. The script ends with the test.
function turnOn(t, m) {
  writeFileSync(join(m.dir, "run.sh"), "#!/bin/bash\nsleep 120\nexit 0\n");
  const child = spawn("/bin/bash", [join(m.dir, "run.sh")], { detached: true, stdio: "ignore" });
  child.unref();
  writeFileSync(join(m.dir, "pid"), `${child.pid}\n`);
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // The script ended already.
    }
  });
}

// /data.json of the machine's page.
function summaryOf(m, now = CLOCK) {
  return JSON.parse(new PageData({ machine: m.name, env: m.env, now }).json());
}

// Every route's answer for the machine's page: /data.json (summary), /request.json of each request (newest first),
// /session.json of each session (current: the newest; earlier: the others, newest first), the lines of /log.json's
// first page, and the text of all these answers.
function routes(m, now = CLOCK) {
  const page = new PageData({ machine: m.name, env: m.env, now });
  const texts = [page.json(), page.sessionsJson(1, 50), page.logJson(1)];
  const summary = JSON.parse(texts[0]);
  const requests = summary.requests.map((row) => {
    texts.push(page.requestJson(row.id));
    return JSON.parse(texts.at(-1));
  });
  const sessions = [];
  for (const { ref } of JSON.parse(texts[1]).sessions.reverse()) {
    texts.push(page.sessionJson(ref));
    sessions.push(JSON.parse(texts.at(-1)));
  }
  return {
    text: texts.join("\n"),
    summary,
    requests,
    current: sessions.at(-1) ?? null,
    earlier: sessions.slice(0, -1).reverse(),
    logLines: JSON.parse(texts[2]).lines,
  };
}

const byId = (requests) => Object.fromEntries(requests.map((request) => [request.id, request]));

// One session that serves six requests, one of each status a session that runs can show.
function sixRequests() {
  const madeLogin = {
    outcome: "done",
    summary: `**Answer:** made one manager login in Staging.\n\n**Evidence**\n- \`scripts/seed.js:12\`: the seed script makes a user.`,
    logins: [{ username: "qa-new@acme.example", password: LOGIN_PASSWORD, note: "manager, one pending request" }],
    records: [{ name: "pending time-off request", value: "tor-1786000000000" }],
  };
  const command =
    `curl -s -X POST https://timeoff.staging.acme.example/api/users -H '${BEARER_HEADER}' ` +
    `-d '{"username":"qa-new@acme.example","password":"${LOGIN_PASSWORD}"}' && DOABLE_API_KEY=${KEY} DB_SECRET=${DB_SECRET} ./seed --password=${NAMED_PASSWORD} SIGNING_KEY=${SIGNING_KEY}`;
  const log = new Log().init("s-1").quiet();
  log.call("Skill", { skill: "doable-code-context:doable-code-agent" }, "Launching skill: doable-code-context:doable-code-agent");
  log.bash("Look at the folder", "git log --oneline | head");
  // Chat request, done, with a refused result first.
  const login = task("CA-AAAAA1", { request: "Make a manager login with one pending request for the approval tests." });
  log.wait(login);
  log.say("Serving Doable code agent requests under the rules you gave.");
  log.update({ request_id: "CA-AAAAA1", progress: "Reading the seed script" }, login);
  log.bash("Make the login in Staging", command);
  log.say(`Made qa-new@acme.example with the password ${LOGIN_PASSWORD}; the old key ${KEY} is not used.`);
  log.refuse(
    { request_id: "CA-AAAAA1", result: { ...madeLogin, summary: "a summary with a code block" } },
    "doable_error: summary: Value error, it holds code (a code block or a diff): say in words what the code does, and send it again",
  );
  log.update({ request_id: "CA-AAAAA1", result: madeLogin }, { ...login, status: "done" });
  log.say("CA-AAAAA1: done, made one login.");
  log.wait(null);
  // A person's Claude Code, with a question and its answer, then failed.
  const asked = directTask("CA-BBBBB2", "dev@acme.example", { request: "Which build runs in Staging?" });
  log.wait(asked);
  log.update(
    { request_id: "CA-BBBBB2", question: "Which environment do you mean: Staging or QA?", wait_seconds: 50 },
    { ...asked, status: "needs_answer", question: "Which environment do you mean: Staging or QA?" },
  );
  log.wait(null);
  log.update({ request_id: "CA-BBBBB2", wait_seconds: 0 }, { ...asked, answer: "Staging." });
  log.update({ request_id: "CA-BBBBB2", progress: "Got the answer" }, { ...asked, answer: "Staging." });
  log.read("/srv/repos/acme-timeoff/deploy/staging.yml");
  log.update(
    { request_id: "CA-BBBBB2", result: { outcome: "failed", summary: "The deploy files do not name the build." } },
    { ...asked, answer: "Staging.", status: "failed" },
  );
  // Declined.
  const forbidden = task("CA-CCCCC3", { request: "Delete the production users." });
  log.wait(forbidden);
  log.update(
    { request_id: "CA-CCCCC3", result: { outcome: "declined", summary: "This machine never writes to production." } },
    { ...forbidden, status: "declined" },
  );
  // Cancelled by a person while it worked.
  log.wait(task("CA-DDDDD4"));
  log.update({ request_id: "CA-DDDDD4", progress: "Reading the approvals" }, task("CA-DDDDD4", { cancel_requested: true }));
  // Waits for an answer.
  log.wait(task("CA-EEEEE5"));
  log.update(
    { request_id: "CA-EEEEE5", question: "Should the request be for half a day?", wait_seconds: 50 },
    task("CA-EEEEE5", { status: "needs_answer", question: "Should the request be for half a day?" }),
  );
  // Working now, with a read of the test inbox that Doable refused.
  log.wait(task("CA-FFFFF6"));
  log.update({ request_id: "CA-FFFFF6", progress: "Reading the holidays" }, task("CA-FFFFF6"));
  log.call(`${PLUGIN}read_code_agent_mail`, { request_id: "CA-FFFFF6", to: "acme-tests+f@mail.getdoable.ai", wait_seconds: 60 }, "doable_error: no_test_inbox: The organization has no test inbox.", {
    isError: true,
  });
  log.read("/srv/repos/acme-timeoff/config/holidays.json");
  return log;
}

test("the page shows each request, newest first, with its asker, progress, question and answer, refused call, result and status", (t) => {
  const m = machine(t);
  turnOn(t, m);
  writeFileSync(join(m.dir, "session.jsonl"), sixRequests().text());
  const { summary, requests: all, current, earlier } = routes(m);

  assert.equal(summary.service.state, "on");
  assert.deepEqual(
    all.map((request) => [request.id, request.status]),
    [
      ["CA-FFFFF6", "working"],
      ["CA-EEEEE5", "waiting for an answer"],
      ["CA-DDDDD4", "cancelled"],
      ["CA-CCCCC3", "declined"],
      ["CA-BBBBB2", "failed"],
      ["CA-AAAAA1", "done"],
    ],
  );
  const requests = byId(all);

  const made = requests["CA-AAAAA1"];
  assert.equal(made.askedBy, "chat");
  assert.equal(made.suite, "Time off");
  assert.equal(made.environment, "Staging");
  assert.equal(made.chatUrl, CHAT_URL);
  assert.equal(made.askedAt, "2026-11-25T08:55:00Z");
  assert.equal(made.text, "Make a manager login with one pending request for the approval tests.");
  assert.deepEqual(
    made.events.map((event) => [event.kind, event.what, event.text]),
    [
      ["taken", null, null],
      ["progress", null, "Reading the seed script"],
      [
        "refused",
        "result",
        "doable_error: summary: Value error, it holds code (a code block or a diff): say in words what the code does, and send it again",
      ],
      ["result", null, "done"],
    ],
  );
  for (const event of made.events) assert.match(event.at, /^2026-11-25T09:\d\d:\d\d\.000Z$/);
  // Only the accepted result: its records, and its logins with the username and the note only. Doable kept it: the
  // request that the result call returned is done, as the outcome.
  assert.equal(made.result.outcome, "done");
  assert.equal(made.result.kept, true);
  assert.match(made.result.summary, /^\*\*Answer:\*\* made one manager login in Staging\./);
  assert.deepEqual(made.result.records, [{ name: "pending time-off request", value: "tor-1786000000000" }]);
  assert.deepEqual(made.result.logins, [{ username: "qa-new@acme.example", note: "manager, one pending request" }]);
  assert.equal(made.finishedAt, made.result.at);

  const direct = requests["CA-BBBBB2"];
  assert.equal(direct.askedBy, "claude_code");
  assert.equal(direct.askedByUser, "dev@acme.example");
  assert.equal(direct.chatUrl, null);
  assert.deepEqual(
    direct.events.map((event) => [event.kind, event.text]),
    [
      ["taken", null],
      ["question", "Which environment do you mean: Staging or QA?"],
      ["answer", "Staging."],
      ["progress", "Got the answer"],
      ["result", "failed"],
    ],
  );
  assert.equal(requests["CA-CCCCC3"].result.summary, "This machine never writes to production.");
  assert.equal(requests["CA-EEEEE5"].events.at(-1).kind, "question");

  // The steps go to the request that the session served; the steps before the first request go to the session's start.
  assert.deepEqual(
    current.steps.map((step) => [step.tool, step.target]),
    [
      ["Skill", "doable-code-context:doable-code-agent"],
      ["Bash", "Look at the folder"],
    ],
  );
  assert.deepEqual(direct.steps.map((step) => [step.kind, step.tool, step.target]), [["tool", "Read", "/srv/repos/acme-timeoff/deploy/staging.yml"]]);
  assert.deepEqual(
    made.steps.map((step) => [step.kind, step.tool ?? null, step.target ?? step.text]),
    [
      ["text", null, "Serving Doable code agent requests under the rules you gave."],
      ["tool", "Bash", "Make the login in Staging"],
      ["text", null, "Made qa-new@acme.example with the password ****; the old key sk-doable-**** is not used."],
      ["text", null, "CA-AAAAA1: done, made one login."],
    ],
  );

  assert.equal(current.running, true);
  assert.equal(current.model, MODEL);
  assert.equal(current.permissionMode, "bypassPermissions");
  assert.equal(current.claudeCodeVersion, "2.1.326");
  assert.deepEqual(current.doableServers, [{ name: "plugin:doable-code-context:doable", status: "connected" }]);
  assert.deepEqual(earlier, []);
});

test("/data.json gives one short line of each request, the request in progress with its newest steps, and no other steps, so its size does not grow with the steps", (t) => {
  const m = machine(t);
  turnOn(t, m);
  const long = `${"A request with many words. ".repeat(40)}LAST WORDS`;
  const log = new Log().init("s-1").wait(task("CA-AAAAA1", { request: long }));
  for (let i = 0; i < 40; i += 1) log.read(`/repo/file-${i}.ts`);
  log.update({ request_id: "CA-AAAAA1", result: { outcome: "done", summary: "Answered." } }, task("CA-AAAAA1", { request: long, status: "done" }));
  log.wait(task("CA-BBBBB2")).update({ request_id: "CA-BBBBB2", progress: "Reading" }, task("CA-BBBBB2"));
  for (let i = 0; i < 6; i += 1) log.read(`/repo/b-${i}.ts`);
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const page = new PageData({ machine: m.name, env: m.env });
  const before = page.json();
  const summary = JSON.parse(before);

  const [working, done] = summary.requests;
  assert.deepEqual(Object.keys(done).sort(), [
    "askedAt", "askedBy", "askedByUser", "environment", "finishedAt", "id", "organization", "outcome", "question", "questionAt", "refused",
    "servedAt", "status", "stepCount", "suite", "takenAt", "text",
  ]);
  assert.equal(done.text, `${long.slice(0, 300)}…`);
  assert.equal(done.stepCount, 40);
  assert.equal(working.stepCount, 6);
  // The request in progress: its lines and its three newest steps.
  assert.deepEqual(summary.now.map((request) => [request.id, request.steps.map((step) => step.target)]), [["CA-BBBBB2", ["/repo/b-3.ts", "/repo/b-4.ts", "/repo/b-5.ts"]]]);
  assert.equal(summary.session.stepCount, 0);
  assert.equal(summary.session.steps, undefined);
  // /request.json gives the whole text and every step.
  const detail = JSON.parse(page.requestJson("CA-AAAAA1"));
  assert.equal(detail.text, long);
  assert.equal(detail.steps.length, 40);

  // 200 more steps of the request that ended do not reach /data.json; only its count changes.
  const more = new Log().init("s-1").wait(task("CA-AAAAA1", { request: long }));
  for (let i = 0; i < 240; i += 1) more.read(`/repo/file-${i}.ts`);
  more.update({ request_id: "CA-AAAAA1", result: { outcome: "done", summary: "Answered." } }, task("CA-AAAAA1", { request: long, status: "done" }));
  more.wait(task("CA-BBBBB2")).update({ request_id: "CA-BBBBB2", progress: "Reading" }, task("CA-BBBBB2"));
  for (let i = 0; i < 6; i += 1) more.read(`/repo/b-${i}.ts`);
  // A new file, as the start script's move gives: the page reads it from its start.
  writeFileSync(join(m.dir, "next.jsonl"), more.text());
  renameSync(join(m.dir, "next.jsonl"), join(m.dir, "session.jsonl"));
  const after = page.json();
  assert.equal(JSON.parse(after).requests[1].stepCount, 240);
  assert.ok(Math.abs(after.length - before.length) < 200, `${before.length} -> ${after.length}`);
  assert.ok(!after.includes("/repo/file-"), "a step of a request that ended is in /data.json");
  assert.equal(JSON.parse(page.requestJson("CA-AAAAA1")).steps.length, 240);
});

test("no password, key, token or named secret of the logs reaches any route of the page, and the names stay", (t) => {
  const m = machine(t);
  writeFileSync(join(m.dir, "session.jsonl"), sixRequests().text());
  writeFileSync(
    join(m.dir, "service.log"),
    "2026-11-25T08:59:58Z the serving session starts\n" +
      `DOABLE_API_KEY=${KEY} password: ${LOG_PASSWORD} token=${LOG_TOKEN}\n` +
      `the key ${KEY} came back\n` +
      `connecting to postgres://qa:${URL_PASSWORD}@db.staging.acme.example/timeoff with Authorization: Basic ${BASIC_CREDENTIAL}\n`,
  );
  const { text, requests, logLines } = routes(m);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `the page's data holds ${secret}`);
  // No login keeps a password field, also with no value.
  assert.ok(!/"password"\s*:\s*"[^*"]/.test(text.replaceAll('\\"', '"')), text);
  for (const request of requests) {
    for (const login of request.result?.logins ?? []) assert.deepEqual(Object.keys(login), ["username", "note"]);
  }

  // The Bash step: the login's password where the logs name it, a key, a Bearer token, and a value after a secret's name.
  const bash = byId(requests)["CA-AAAAA1"].steps.find((step) => step.tool === "Bash");
  assert.equal(
    bash.detail,
    `curl -s -X POST https://timeoff.staging.acme.example/api/users -H '${MASKED_BEARER_HEADER}' ` +
      `-d '{"username":"qa-new@acme.example","password":"****"}' && DOABLE_API_KEY=**** DB_SECRET=**** ./seed --password=**** SIGNING_KEY=****`,
  );
  assert.deepEqual(logLines, [
    "2026-11-25T08:59:58Z the serving session starts",
    "DOABLE_API_KEY=**** password: **** token=****",
    "the key sk-doable-**** came back",
    "connecting to postgres://qa:****@db.staging.acme.example/timeoff with Authorization: Basic ****",
  ]);
});

test("a session that ended while it held a request leaves the request, and an earlier session shows its start, its end and how it ended", (t) => {
  const m = machine(t);
  turnOn(t, m);
  const log = new Log()
    .init("s-1")
    .wait(task("CA-GGGGG7"))
    .update({ request_id: "CA-GGGGG7", progress: "Building the app" }, task("CA-GGGGG7"));
  log.at("2026-11-25T09:08:01.000Z").init("s-2").wait(task("CA-HHHHH8")).update({ request_id: "CA-HHHHH8", progress: "Reading" }, task("CA-HHHHH8"));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  writeFileSync(
    join(m.dir, "service.log"),
    [
      "2026-11-25T09:00:00Z the serving session starts",
      "2026-11-25T09:03:00Z the serving session ended with code 1",
      "2026-11-25T09:08:00Z the serving session starts",
    ].join("\n") + "\n",
  );

  let { summary, current, earlier } = routes(m);
  assert.deepEqual(
    summary.requests.map((request) => [request.id, request.status]),
    [
      ["CA-HHHHH8", "working"],
      ["CA-GGGGG7", "left when its session ended"],
    ],
  );
  assert.equal(current.startedAt, "2026-11-25T09:08:00.000Z");
  assert.equal(current.running, true);
  assert.equal(earlier.length, 1);
  const [first] = earlier;
  assert.equal(first.startedAt, "2026-11-25T09:00:00.000Z");
  assert.equal(first.endedAt, "2026-11-25T09:03:00.000Z");
  assert.equal(first.ending, "The start script saw it end with code 1.");
  assert.equal(first.endedHow, "ended with code 1");
  assert.equal(first.requests, 1);
  assert.equal(first.running, false);

  // A stop ends the current session too: its request is left, and the session shows its end.
  writeFileSync(join(m.dir, "stopped"), "now\n");
  ({ summary, current } = routes(m));
  assert.equal(summary.service.state, "stopped");
  assert.equal(byId(summary.requests)["CA-HHHHH8"].status, "left when its session ended");
  assert.equal(current.running, false);
  assert.equal(current.ending, "Its log has no end: it was stopped, or Claude Code or the computer stopped it.");

  // Contrast: the next session takes the left request again (Doable gave it back to the queue), and works on it.
  rmSync(join(m.dir, "stopped"));
  log.at("2026-11-25T09:30:01.000Z").init("s-3").wait(task("CA-GGGGG7", { answer: null }));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  let requests;
  ({ requests, earlier } = routes(m));
  const again = byId(requests)["CA-GGGGG7"];
  assert.equal(again.status, "working");
  assert.deepEqual(again.events.map((event) => event.kind), ["taken", "progress", "taken again"]);
  // It is served since the session took it again.
  assert.equal(again.servedAt, again.events.at(-1).at);
  assert.equal(byId(requests)["CA-HHHHH8"].status, "left when its session ended");
  assert.equal(earlier.length, 2);
});

test("a session that wrote its result event has ended: its words say how", (t) => {
  const m = machine(t);
  turnOn(t, m);
  const log = new Log().init("s-1").wait(task("CA-JJJJJ9")).quiet("rejected");
  log.end("success", "Claude AI usage limit reached|1795881600", true);
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const { summary, current } = routes(m);
  assert.equal(current.running, false);
  assert.equal(current.ending, "It stopped with an error. Its last message: Claude AI usage limit reached|1795881600");
  assert.equal(current.endedHow, "stopped at the plan limit");
  assert.deepEqual(current.planLimit, { status: "rejected", resetsAt: "2026-11-28T16:00:00.000Z" });
  assert.equal(summary.requests[0].status, "left when its session ended");
});

test("the page reads session.1.jsonl, then session.jsonl, parses session.1.jsonl again only when it changed, and follows a move of the log", (t) => {
  const m = machine(t);
  turnOn(t, m);
  const older = new Log().init("s-1").wait(task("CA-KKKKK1")).update(
    { request_id: "CA-KKKKK1", result: { outcome: "done", summary: "Answered." } },
    task("CA-KKKKK1", { status: "done" }),
  );
  const current = new Log(PLUGIN, "2026-11-25T10:00:01.000Z").init("s-2").wait(task("CA-MMMMM2"));
  writeFileSync(join(m.dir, "session.1.jsonl"), older.text());
  writeFileSync(join(m.dir, "session.jsonl"), current.text());

  const page = new PageData({ machine: m.name, env: m.env });
  const earlierIds = () => JSON.parse(page.sessionsJson(1, 50)).sessions.slice(1).map((session) => session.id);
  let data = JSON.parse(page.json());
  assert.deepEqual(
    data.requests.map((request) => [request.id, request.status]),
    [
      ["CA-MMMMM2", "working"],
      ["CA-KKKKK1", "done"],
    ],
  );
  assert.equal(data.session.id, "s-2");
  assert.deepEqual(earlierIds(), ["s-1"]);
  const read = page.logs.stats.bytesRead;
  assert.equal(read, statSync(join(m.dir, "session.1.jsonl")).size + statSync(join(m.dir, "session.jsonl")).size);

  // Nothing changed: nothing is read again.
  page.json();
  assert.equal(page.logs.stats.bytesRead, read);
  assert.equal(page.logs.stats.olderParses, 1);

  // The start script moves session.jsonl to session.1.jsonl at a session's start, and the new session writes a new one.
  renameSync(join(m.dir, "session.jsonl"), join(m.dir, "session.1.jsonl"));
  data = JSON.parse(page.json());
  assert.deepEqual(data.requests.map((request) => request.id), ["CA-MMMMM2"]);
  writeFileSync(join(m.dir, "session.jsonl"), new Log(PLUGIN, "2026-11-25T11:00:01.000Z").init("s-3").wait(task("CA-NNNNN3")).text());
  data = JSON.parse(page.json());
  assert.deepEqual(
    data.requests.map((request) => [request.id, request.status]),
    [
      ["CA-NNNNN3", "working"],
      ["CA-MMMMM2", "left when its session ended"],
    ],
  );
  assert.deepEqual(earlierIds(), ["s-2"]);
  assert.equal(page.logs.stats.olderParses, 2);
});

test("the page finds the Doable tools under the plugin's server name and under a server named doable", (t) => {
  const steps = (prefix) =>
    new Log(prefix)
      .init("s-1", { server: prefix === PLUGIN ? "plugin:doable-code-context:doable" : "doable", status: "failed" })
      .wait(task("CA-PPPPP1"))
      .update({ request_id: "CA-PPPPP1", progress: "Reading" }, task("CA-PPPPP1"))
      .call(`${prefix}read_code_agent_mail`, { request_id: "CA-PPPPP1", to: "acme-tests+ca1@mail.getdoable.ai", wait_seconds: 60 }, "doable_error: no_test_inbox: The organization has no test inbox.", { isError: true })
      .update({ request_id: "CA-PPPPP1", result: { outcome: "failed", summary: "No mail came." } }, task("CA-PPPPP1", { status: "failed" }));
  const seen = [];
  for (const prefix of [PLUGIN, USER_SCOPED]) {
    const m = machine(t);
    writeFileSync(join(m.dir, "session.jsonl"), steps(prefix).text());
    const { requests, current } = routes(m);
    const [request] = requests;
    seen.push([request.id, request.status, request.events.map((event) => [event.kind, event.what]), request.steps.map((step) => [step.tool, step.target, step.failed])]);
    assert.equal(current.doableServers[0].status, "failed");
  }
  assert.deepEqual(seen[0], [
    "CA-PPPPP1",
    "failed",
    [
      ["taken", null],
      ["progress", null],
      ["refused", "read of the test inbox"],
      ["result", null],
    ],
    [[`${PLUGIN}read_code_agent_mail`, "acme-tests+ca1@mail.getdoable.ai", true]],
  ]);
  assert.deepEqual(seen[1], [
    "CA-PPPPP1",
    "failed",
    seen[0][2],
    [[`${USER_SCOPED}read_code_agent_mail`, "acme-tests+ca1@mail.getdoable.ai", true]],
  ]);
});

test("a growing session.jsonl is read from where the last read ended, a half-written line waits, and a log that shrank is read again from its start", (t) => {
  const m = machine(t);
  const path = join(m.dir, "session.jsonl");
  const log = new Log().init("s-1").wait(task("CA-QQQQQ1"));
  writeFileSync(path, log.text());
  const logs = new SessionLogs(m.dir);
  logs.refresh();
  assert.equal(logs.stats.bytesRead, statSync(path).size);

  // Lines added: only they are read, and the page shows them.
  const before = log.text();
  log.update({ request_id: "CA-QQQQQ1", progress: "First step" }, task("CA-QQQQQ1"));
  const added = log.text().slice(before.length);
  // A line that the session writes now: half of it is in the file.
  const next = new Log(PLUGIN, "2026-11-25T09:30:00.000Z").init("s-x").say("Half written").lines.at(-1);
  const half = next.slice(0, 40);
  appendFileSync(path, added + half);
  let state = logs.refresh();
  assert.equal(logs.stats.bytesRead, Buffer.byteLength(before) + Buffer.byteLength(added) + Buffer.byteLength(half));
  assert.deepEqual(state.requests.get("CA-QQQQQ1").events.map((event) => [event.kind, event.text ?? null]), [
    ["taken", null],
    ["progress", "First step"],
  ]);
  assert.equal(logs.stats.currentStarts, 1);

  // The rest of the line: the half is read again with it, once.
  appendFileSync(path, `${next.slice(40)}\n`);
  state = logs.refresh();
  assert.equal(
    logs.stats.bytesRead,
    Buffer.byteLength(before) + Buffer.byteLength(added) + 2 * Buffer.byteLength(half) + Buffer.byteLength(next.slice(40)) + 1,
  );
  assert.deepEqual(state.requests.get("CA-QQQQQ1").steps.map((step) => step.text), ["Half written"]);
  assert.equal(state.requests.get("CA-QQQQQ1").events.length, 2);

  // A shorter log (written again in place): the page starts over, and the old requests are gone.
  writeFileSync(path, new Log().init("s-2").wait(task("CA-RRRRR2")).text());
  state = logs.refresh();
  assert.deepEqual([...state.requests.keys()], ["CA-RRRRR2"]);
  assert.equal(logs.stats.currentStarts, 2);
});

test("the page shows that no log and no request is there yet", (t) => {
  const m = machine(t);
  const { summary, logLines } = routes(m);
  assert.equal(summary.service.state, "not running");
  assert.equal(summary.serving.state, "not running");
  assert.equal(summary.logFound, false);
  assert.equal(summary.session, null);
  assert.equal(summary.sessionCount, 0);
  assert.deepEqual(summary.requests, []);
  assert.deepEqual(logLines, []);
  // A view with no log is the same from pageView itself.
  const view = pageView(
    { sessions: [], requests: new Map(), passwords: new Set(), otherOutput: [] },
    { machine: "m", serviceState: "on", serviceLog: { lines: [], entries: [] }, currentLogTime: null, logFound: false },
  );
  assert.deepEqual(view.requests, []);
  assert.deepEqual(view.serving, { state: "no log", requestId: null, lines: [] });
});

// ---------------------------------------------------------------------------------------------------------------------
// The session's state in the header, Doable's ask, and the files that a result names
// ---------------------------------------------------------------------------------------------------------------------

test("the header's state says what the session does now: working on a request, waiting for an answer, serving, cannot reach Doable, starting, cannot start, at the plan limit, between sessions, stopped or not running", (t) => {
  const stateOf = (text, { on = true, serviceLog = null, stopped = false } = {}) => {
    const m = machine(t);
    if (on) turnOn(t, m);
    if (stopped) writeFileSync(join(m.dir, "stopped"), "now\n");
    if (text !== null) writeFileSync(join(m.dir, "session.jsonl"), text);
    if (serviceLog !== null) writeFileSync(join(m.dir, "service.log"), `${serviceLog.join("\n")}\n`);
    const { serving } = summaryOf(m);
    return serving.lines.length ? serving : { state: serving.state, requestId: serving.requestId };
  };
  assert.deepEqual(stateOf(sixRequests().text()), { state: "working", requestId: "CA-FFFFF6" });
  const asking = new Log().init("s-1").wait(task("CA-EEEEE5"));
  asking.update({ request_id: "CA-EEEEE5", question: "Half a day?", wait_seconds: 50 }, task("CA-EEEEE5", { status: "needs_answer", question: "Half a day?" }));
  assert.deepEqual(stateOf(asking.text()), { state: "waiting for an answer", requestId: "CA-EEEEE5" });
  // The session waits for its next request: a wait call with no result yet, or a wait that returned no request.
  const done = () => new Log().init("s-1").wait(task("CA-AAAAA1")).update({ request_id: "CA-AAAAA1", result: { outcome: "done", summary: "Answered." } }, task("CA-AAAAA1", { status: "done" }));
  assert.deepEqual(stateOf(done().waiting().text()), { state: "serving", requestId: null });
  assert.deepEqual(stateOf(new Log().init("s-1").wait(null).text()), { state: "serving", requestId: null });
  assert.deepEqual(stateOf(new Log().init("s-1").waiting().text()), { state: "serving", requestId: null });
  // A session that has not called the wait yet.
  const skill = new Log().init("s-1").call("Skill", { skill: "doable-code-context:doable-code-agent" }, "Launching skill");
  assert.deepEqual(stateOf(skill.text()), { state: "starting", requestId: null });
  // Only errors in the log, and a session that ended before its first wait for a request.
  assert.deepEqual(stateOf("Invalid API key · Please run /login\n"), { state: "cannot start", requestId: null, lines: ["Invalid API key · Please run /login"] });
  const noWait = new Log().init("s-1").call("Skill", { skill: "doable-code-context:doable-code-agent" }, "Launching skill").end("error_during_execution", "No Doable tool.", true);
  assert.deepEqual(stateOf(noWait.text()), { state: "cannot start", requestId: null });
  // A start of the start script after the newest session's last event, then its end, and errors after the last event:
  // the new start wrote no event before it ended.
  const ended = done().end("success", "Served.", false);
  const restart = ["2026-11-25T09:00:00Z the serving session starts", "2026-11-25T09:00:30Z the serving session ended with code 0", "2026-11-25T09:05:30Z the serving session starts"];
  assert.deepEqual(stateOf(`${ended.text()}error: unknown option '--chrome'\n`, { serviceLog: [...restart, "2026-11-25T09:05:31Z the serving session ended with code 1"] }), {
    state: "cannot start",
    requestId: null,
    lines: ["error: unknown option '--chrome'"],
  });
  // Contrast: with no end after that start, the new session can still be connecting, and the output before the start
  // line can be the earlier session's own: it starts.
  assert.deepEqual(
    stateOf(`${ended.text()}Error: MCP server "doable" closed the connection\n`, { serviceLog: restart }),
    { state: "starting", requestId: null },
  );
  // Contrast: the same start before the session's events is the session's own start.
  assert.deepEqual(
    stateOf(`${ended.text()}error: unknown option '--chrome'\n`, {
      serviceLog: ["2026-11-25T09:00:00Z the serving session starts", "2026-11-25T09:00:30Z the serving session ended with code 0"],
    }),
    { state: "between sessions", requestId: null },
  );
  // Each wait for a request fails: the session cannot reach Doable, also when no wait ever worked. One wait that works
  // makes it serve again.
  const failing = (log) => log.call(`${PLUGIN}wait_for_code_agent_request`, { wait_seconds: 290 }, "doable_server_error: 503 Service Unavailable", { isError: true });
  assert.deepEqual(stateOf(failing(failing(done().wait(null))).text()), { state: "cannot reach Doable", requestId: null });
  assert.deepEqual(stateOf(failing(new Log().init("s-1")).bash("Wait before the next call", "sleep 20").text()), { state: "cannot reach Doable", requestId: null });
  assert.deepEqual(stateOf(failing(failing(done())).wait(null).text()), { state: "serving", requestId: null });
  const limit = new Log().init("s-1").wait(null).quiet("rejected").end("success", "Claude AI usage limit reached|1795881600", true);
  assert.deepEqual(stateOf(limit.text()), { state: "plan limit", requestId: null });
  assert.deepEqual(stateOf(sixRequests().text(), { stopped: true }), { state: "stopped", requestId: null });
  assert.deepEqual(stateOf(sixRequests().text(), { on: false }), { state: "not running", requestId: null });
});

test("the page shows the version that Doable asked for while update-asked holds it, and a session that got Doable's ask ends at it", (t) => {
  const m = machine(t);
  turnOn(t, m);
  const log = new Log().init("s-1").wait(task("CA-AAAAA1", { request: ASK }));
  log.update({ request_id: "CA-AAAAA1", result: { outcome: "done", summary: "It is Doable's message to a machine." } }, task("CA-AAAAA1", { request: ASK, status: "done" }));
  log.call(`${PLUGIN}wait_for_code_agent_request`, { wait_seconds: 290 }, JSON.stringify({ request: null, capabilities_missing: false, update: ASK }));
  log.end("success", "Doable needs the plugin 0.6.4.", false);
  log.at("2026-11-25T09:40:01.000Z").init("s-2").wait(null);
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  let page = routes(m);
  assert.equal(page.summary.service.askedUpdate, null);
  const [asked, now] = [page.earlier[0], page.current];
  assert.equal(asked.updateAsked, "0.6.4");
  assert.equal(asked.endedHow, "ended at Doable's ask for the plugin 0.6.4");
  assert.match(asked.ending, /^Doable asked for the plugin 0\.6\.4, and the session ended at that ask\. It ended its turn\./);
  // A request whose text holds the ask's words is the asker's text, not Doable's ask.
  const onlyRequest = new Log().init("s-1").wait(task("CA-AAAAA1", { request: ASK })).end("success", "Done.", false);
  const other = machine(t);
  writeFileSync(join(other.dir, "session.jsonl"), onlyRequest.text());
  assert.equal(routes(other).current.updateAsked, null);
  assert.equal(now.updateAsked, null);

  writeFileSync(join(m.dir, "update-asked"), "0.6.4\n");
  utimesSync(join(m.dir, "update-asked"), new Date("2026-11-25T09:31:00Z"), new Date("2026-11-25T09:31:00Z"));
  page = routes(m);
  assert.deepEqual(page.summary.service.askedUpdate, { version: "0.6.4", at: "2026-11-25T09:31:00.000Z" });
  // A file that holds no version fails, as the service's status does.
  writeFileSync(join(m.dir, "update-asked"), "soon\n");
  assert.throws(() => summaryOf(m), /update-asked does not hold a version \(MAJOR\.MINOR\.PATCH\): "soon"\.$/);
});

test("a result's files show their repository, commit and path, and the page shows them under the result", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  const files = [
    { repository: "acme/timeoff", commit: "3f2a91c4d5e6f708192a3b4c5d6e7f8091a2b3c4", path: "src/app/api/time-off/route.ts" },
    { repository: "acme/timeoff", commit: "3f2a91c4d5e6f708192a3b4c5d6e7f8091a2b3c4", path: "config/time-off.json" },
  ];
  const log = new Log().init("s-1").wait(task("CA-AAAAA1"));
  log.update({ request_id: "CA-AAAAA1", result: { outcome: "done", summary: "The limit is 15 days.", code_files: files } }, task("CA-AAAAA1", { status: "done" }));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const { requests } = routes(m);
  assert.deepEqual(requests[0].result.codeFiles, files);

  const page = await scriptPage(t, m, "#requests&open=CA-AAAAA1");
  const list = find(page.parts.content, (node) => node.tagName === "UL" && node.className === "files");
  assert.deepEqual(
    list.childNodes.map((item) => item.textContent),
    ["acme/timeoff src/app/api/time-off/route.ts at 3f2a91c4d5e6", "acme/timeoff config/time-off.json at 3f2a91c4d5e6"],
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// The server and its routes
// ---------------------------------------------------------------------------------------------------------------------

function get(port, path, { host = `127.0.0.1:${port}`, method = "GET" } = {}) {
  return new Promise((resolvePromise, reject) => {
    const sent = httpRequest({ host: "127.0.0.1", port, path, method, setHost: false, headers: host === null ? {} : { Host: host } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolvePromise({ status: response.statusCode, headers: response.headers, body }));
    });
    sent.on("error", reject);
    sent.end();
  });
}

async function serve(t, m, now = CLOCK) {
  const server = await startPageServer({ machine: m.name, env: m.env, port: 0, now });
  t.after(() => server.close());
  return server.address().port;
}

async function servedPage(t) {
  const m = machine(t);
  writeFileSync(join(m.dir, "session.jsonl"), sixRequests().text());
  const port = await serve(t, m);
  return { m, port };
}

test("the server listens on 127.0.0.1 only, and each route answers only a Host of 127.0.0.1 or localhost with its port", async (t) => {
  const m = machine(t);
  writeFileSync(join(m.dir, "session.jsonl"), sixRequests().text());
  const server = await startPageServer({ machine: m.name, env: m.env, port: 0 });
  t.after(() => server.close());
  const port = server.address().port;
  assert.equal(server.address().address, "127.0.0.1");
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
    for (const path of DATA_PATHS) {
      const answer = await get(port, path, { host });
      assert.equal(answer.status, 200, `${host} ${path}`);
      assert.equal(answer.headers["content-type"], "application/json; charset=utf-8");
    }
    assert.equal(JSON.parse((await get(port, "/data.json", { host })).body).requests.length, 6);
  }
  // A web site's name that resolves to this computer (DNS rebinding), another port, and no port.
  for (const host of [`attacker.example:${port}`, `127.0.0.1:${port + 1}`, "127.0.0.1", `127.0.0.1.attacker.example:${port}`]) {
    for (const path of ["/", ...DATA_PATHS]) {
      const answer = await get(port, path, { host });
      assert.equal(answer.status, 403, `${host} ${path}`);
      assert.equal(answer.body, `This page answers only at http://127.0.0.1:${port}/ on this computer.\n`);
    }
  }
  // With no Host, Node's server refuses the request itself.
  const noHost = await get(port, "/request.json?id=CA-AAAAA1", { host: null });
  assert.equal(noHost.status, 400);
  assert.ok(!noHost.body.includes("CA-"), noHost.body);
});

test("the server takes only GET of its routes, and refuses a path that is no route and a parameter that a route does not take", async (t) => {
  const { port } = await servedPage(t);
  for (const path of ["/", ...DATA_PATHS]) {
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      const answer = await get(port, path, { method });
      assert.equal(answer.status, 405, `${method} ${path}`);
      assert.equal(answer.headers.allow, "GET");
    }
  }
  for (const path of ["/favicon.ico", "/session.jsonl", "/../service.log", "/data.json/", "/request.json/CA-AAAAA1", "/sessions", "//data.json"]) {
    const answer = await get(port, path);
    assert.equal(answer.status, 404, path);
    assert.equal(answer.body, NOT_FOUND);
  }
  const refused = {
    "/?x=1": "/ takes no parameter.\n",
    "/data.json?x=1": "/data.json takes no parameter.\n",
    "/sessions.json?page=0": `${SESSIONS_TAKES}\n`,
    "/sessions.json?size=7": `${SESSIONS_TAKES}\n`,
    "/sessions.json?page=1&page=2": `${SESSIONS_TAKES}\n`,
    "/sessions.json?open=../x": `${SESSIONS_TAKES}\n`,
    "/session.json": `${SESSION_TAKES}\n`,
    "/session.json?n=1": `${SESSION_TAKES}\n`,
    "/session.json?id=": `${SESSION_TAKES}\n`,
    "/session.json?id=s%201": `${SESSION_TAKES}\n`,
    [`/session.json?id=${"s".repeat(101)}`]: `${SESSION_TAKES}\n`,
    "/log.json?page=x": "/log.json takes page, a whole number from 1.\n",
    "/log.json?page=%E0%A4%A": "/log.json takes page, a whole number from 1.\n",
    "/search.json": `${SEARCH_TAKES}\n`,
    "/search.json?q=%20%20": `${SEARCH_TAKES}\n`,
    [`/search.json?q=${"a".repeat(201)}`]: `${SEARCH_TAKES}\n`,
  };
  for (const [path, body] of Object.entries(refused)) {
    const answer = await get(port, path);
    assert.equal(answer.status, 400, path);
    assert.equal(answer.body, body, path);
  }
  // Contrast: the same routes with their parameters answer.
  for (const path of ["/sessions.json", "/sessions.json?page=2&size=25", "/sessions.json?open=nobody", "/log.json", "/session.json?id=s-1", `/search.json?q=${"a".repeat(200)}`]) {
    assert.equal((await get(port, path)).status, 200, path);
  }
  const unknown = await get(port, "/session.json?id=s-9");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body, "No session s-9 is in the logs on this computer.\n");
});

test("/request.json gives one request, refuses an id that is not a request's id, and says when the logs hold no such request", async (t) => {
  const { port } = await servedPage(t);
  const answer = await get(port, "/request.json?id=CA-BBBBB2");
  assert.equal(answer.status, 200);
  const request = JSON.parse(answer.body);
  assert.equal(request.id, "CA-BBBBB2");
  assert.deepEqual(request.steps.map((step) => step.target), ["/srv/repos/acme-timeoff/deploy/staging.yml"]);
  for (const path of ["/request.json", "/request.json?id=", "/request.json?id=ca-bbbbb2", "/request.json?id=CA-BBBBB", "/request.json?id=CA-BBBBB22", "/request.json?id=../x", "/request.json?id=CA-BBBBB2&x=1"]) {
    const refused = await get(port, path);
    assert.equal(refused.status, 400, path);
    assert.equal(refused.body, "/request.json takes id, the id of a request: CA- and 6 capital letters or digits.\n", path);
  }
  const unknown = await get(port, "/request.json?id=CA-ZZZZZ9");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body, "No request CA-ZZZZZ9 is in the logs on this computer.\n");
  // The answer of a request holds no secret of the logs.
  const made = await get(port, "/request.json?id=CA-AAAAA1");
  for (const secret of SECRETS) assert.ok(!made.body.includes(secret), secret);
  assert.ok(made.body.includes("DOABLE_API_KEY=****"));
});

test("/sessions.json gives the sessions newest first in pages, /session.json one session with its steps, and /log.json service.log in pages with the newest lines on page 1", (t) => {
  const m = machine(t);
  const log = new Log();
  for (let i = 1; i <= 23; i += 1) log.at(`2026-11-25T${String(i).padStart(2, "0")}:00:01.000Z`).init(`s-${i}`).bash("Look at the folder", "ls");
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  writeFileSync(join(m.dir, "service.log"), `${Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
  const page = new PageData({ machine: m.name, env: m.env });
  const sessions = (n, size) => JSON.parse(page.sessionsJson(n, size));

  const first = sessions(1, 10);
  assert.deepEqual([first.page, first.pages, first.total, first.size], [1, 3, 23, 10]);
  assert.deepEqual(first.sessions.map((session) => session.n), [23, 22, 21, 20, 19, 18, 17, 16, 15, 14]);
  assert.deepEqual(first.sessions.map((session) => [session.id, session.ref]).slice(0, 2), [["s-23", "s-23"], ["s-22", "s-22"]]);
  assert.equal(first.sessions[0].steps, undefined);
  assert.deepEqual(sessions(3, 10).sessions.map((session) => session.n), [3, 2, 1]);
  // A page after the last gives the last.
  assert.equal(sessions(9, 10).page, 3);
  assert.equal(sessions(1, 25).sessions.length, 23);
  // With an open session, the page that holds it, whatever page was asked; with an id that no session has, the page asked.
  assert.equal(JSON.parse(page.sessionsJson(1, 10, "s-3")).page, 3);
  assert.equal(JSON.parse(page.sessionsJson(1, 10, "s-14")).page, 1);
  assert.equal(JSON.parse(page.sessionsJson(2, 10, "s-99")).page, 2);

  const one = JSON.parse(page.sessionJson("s-5"));
  assert.equal(one.n, 5);
  assert.equal(one.id, "s-5");
  assert.deepEqual(one.steps.map((step) => step.target), ["Look at the folder"]);
  assert.throws(() => page.sessionJson("s-24"), { status: 404, message: "No session s-24 is in the logs on this computer." });

  const newest = JSON.parse(page.logJson(1));
  assert.deepEqual([newest.page, newest.pages, newest.total, newest.from, newest.to], [1, 3, 450, 251, 450]);
  assert.deepEqual([newest.lines[0], newest.lines.at(-1)], ["line 251", "line 450"]);
  const oldest = JSON.parse(page.logJson(3));
  assert.deepEqual([oldest.from, oldest.to, oldest.lines.length, oldest.lines[0]], [1, 50, 50, "line 1"]);
  assert.equal(JSON.parse(page.logJson(7)).page, 3);
});

test("each answer has a Content-Security-Policy with its own nonce for the one inline script and style, the page reads only its own routes, and it writes no data as HTML", async (t) => {
  const { port } = await servedPage(t);
  const first = await get(port, "/");
  const second = await get(port, "/");
  const nonces = [];
  for (const answer of [first, second]) {
    assert.equal(answer.status, 200);
    assert.equal(answer.headers["content-type"], "text/html; charset=utf-8");
    const policy = answer.headers["content-security-policy"];
    const nonce = policy.match(/script-src 'nonce-([A-Za-z0-9+/=]+)'/)?.[1];
    assert.ok(nonce, policy);
    assert.equal(
      policy,
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
    );
    assert.equal(answer.headers["x-content-type-options"], "nosniff");
    assert.equal(answer.headers["referrer-policy"], "no-referrer");
    assert.equal(answer.headers["cache-control"], "no-store");
    assert.equal(answer.headers["x-frame-options"], "DENY");
    assert.equal(answer.headers["cross-origin-resource-policy"], "same-origin");
    // One script and one style, each with this answer's nonce, and nothing from another place.
    assert.deepEqual([...answer.body.matchAll(/<script[^>]*>/g)].map((tag) => tag[0]), [`<script nonce="${nonce}">`]);
    assert.deepEqual([...answer.body.matchAll(/<style[^>]*>/g)].map((tag) => tag[0]), [`<style nonce="${nonce}">`]);
    assert.ok(!/<link|\bsrc=|@import|url\(|https?:\/\/[a-z]/i.test(answer.body), "the page loads nothing from another place");
    for (const htmlSink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) assert.ok(!answer.body.includes(htmlSink), htmlSink);
    for (const secret of SECRETS) assert.ok(!answer.body.includes(secret));
    // The script reads only the page's own data routes.
    assert.deepEqual([...new Set([...answer.body.matchAll(/"(\/[a-z]+\.json)/g)].map((match) => match[1]))].sort(), [
      "/data.json",
      "/log.json",
      "/request.json",
      "/search.json",
      "/session.json",
      "/sessions.json",
    ]);
    nonces.push(nonce);
  }
  assert.notEqual(nonces[0], nonces[1]);
  // Each data route's answer and each refusal carry the same headers.
  for (const answer of [
    ...(await Promise.all(DATA_PATHS.map((path) => get(port, path)))),
    await get(port, "/", { host: "attacker.example" }),
    await get(port, "/x"),
    await get(port, "/request.json?id=x"),
    await get(port, "/data.json", { method: "POST" }),
  ]) {
    assert.match(answer.headers["content-security-policy"], /^default-src 'none'; /);
    assert.equal(answer.headers["x-content-type-options"], "nosniff");
    assert.equal(answer.headers["cache-control"], "no-store");
    assert.equal(answer.headers["x-frame-options"], "DENY");
  }
});

test("the page command takes --machine and --port, and refuses a port that is not a whole number from 1 to 65535", () => {
  assert.deepEqual(parseArgs(["page", "--machine", "mac-mini-1", "--port", "48001"]), {
    command: "page",
    options: { machine: "mac-mini-1", port: 48001 },
  });
  assert.deepEqual(parseArgs(["page", "--machine", "mac-mini-1"]), { command: "page", options: { machine: "mac-mini-1" } });
  for (const port of ["0", "65536", "80a", "-1", "4.5", ""]) {
    assert.throws(() => parseArgs(["page", "--machine", "m", "--port", port]), /^Error: --port must be a whole number from 1 to 65535\.$/, port);
  }
  assert.equal(DEFAULT_PORT, 47615);
});

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

function runFailing(args, env) {
  try {
    execFileSync(process.execPath, [script, ...args], { stdio: "pipe", env, timeout: 20000 });
  } catch (error) {
    return error;
  }
  assert.fail(`${args.join(" ")} did not fail`);
}

test("the page command fails as the other commands do for a machine that is not set up, and names --port when its port is in use", async (t) => {
  const m = machine(t);
  const unknown = runFailing(["page", "--machine", "nobody"], m.env);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stderr.toString(), 'No code agent "nobody" is set up on this machine.\n');
  const badName = runFailing(["page", "--machine", "bad name"], m.env);
  assert.match(badName.stderr.toString(), /^--machine must be 1 to 64 characters/);
  // '.' and '..' name the folder of all machines and the one above it: the page reads neither.
  writeFileSync(join(m.base, "session.jsonl"), new Log().init("s-x").wait(task("CA-OUTSID")).text());
  for (const name of [".", ".."]) {
    const refused = runFailing(["page", "--machine", name], m.env);
    assert.equal(refused.status, 1, name);
    assert.equal(refused.stderr.toString(), "--machine must be 1 to 64 characters, each a letter, a digit, '.', '_' or '-', and not '.' or '..'.\n");
  }

  const taken = createServer();
  await new Promise((done) => taken.listen(0, "127.0.0.1", done));
  t.after(() => taken.close());
  const port = taken.address().port;
  const inUse = runFailing(["page", "--machine", m.name, "--port", String(port)], m.env);
  assert.equal(inUse.status, 1);
  assert.equal(inUse.stderr.toString(), `Port ${port} is in use on this computer. Start the page on another port with --port <number>.\n`);
});

test("the page command prints its address and how to stop it, serves the page, and ends at Ctrl-C", { timeout: 30000 }, async (t) => {
  const m = machine(t);
  writeFileSync(join(m.dir, "session.jsonl"), sixRequests().text());
  const port = await freePort();
  const child = spawn(process.execPath, [script, "page", "--machine", m.name, "--port", String(port)], { env: m.env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  const ended = new Promise((done) => child.on("exit", (code, signal) => done({ code, signal })));
  const printed = await new Promise((done, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("Ctrl-C")) done(out);
    });
    ended.then(({ code }) => reject(new Error(`the page ended with ${code}: ${out}`)));
  });
  // It does not say that only the person can open it, nor that it never shows a password or a key: any account of this
  // computer can, and the mask finds secrets only in known forms.
  assert.equal(
    printed,
    `The page of the code agent "${m.name}": http://127.0.0.1:${port}/\n` +
      `${PAGE_ACCESS}\n${PAGE_MASK}\n` +
      "Stop the page with Ctrl-C. The code agent goes on.\n",
  );
  const answer = await get(port, "/data.json");
  assert.equal(answer.status, 200);
  assert.equal(JSON.parse(answer.body).machine, m.name);
  child.kill("SIGINT");
  assert.deepEqual(await ended, { code: 0, signal: null });
});

// ---------------------------------------------------------------------------------------------------------------------
// The mask: what it hides, and what it leaves
// ---------------------------------------------------------------------------------------------------------------------

test("the mask hides a password in the known forms of a command, and leaves options that only look like them", () => {
  const masked = [
    ["acme-cli users create --email qa@acme.example --password ReproPw-222x", "acme-cli users create --email qa@acme.example --password ****"],
    ["acme-cli login --pass 'Repro Pw 223' --pwd Pwd-224x", "acme-cli login --pass '****' --pwd ****"],
    ["curl -s -u admin:AdminPw-333x https://timeoff.staging.acme.example/api", "curl -s -u admin:**** https://timeoff.staging.acme.example/api"],
    ["curl --user=qa@acme.example:UserPw-334x https://x.example", "curl --user=qa@acme.example:**** https://x.example"],
    [
      String.raw`curl -d "{\"email\":\"qa3@acme.example\",\"password\":\"JsonPw-555x\",\"access_token\":\"tok-556x\"}"`,
      String.raw`curl -d "{\"email\":\"qa3@acme.example\",\"password\":\"****\",\"access_token\":\"****\"}"`,
    ],
    ["https://timeoff.staging.acme.example/login?user=qa&pw=NavPw-4x", "https://timeoff.staging.acme.example/login?user=qa&pw=****"],
    ["open https://x.example/?pass=NavPass-5x then pwd=Pwd-6x", "open https://x.example/?pass=**** then pwd=****"],
  ];
  for (const [text, expected] of masked) assert.equal(maskSecrets(text), expected);
  // -p is a port, a folder's parents or a thread option; -u is a user with no password, a user and a group, or UTC time;
  // a name that holds "pass" is not "pass"; a file of a password is no password.
  for (const text of [
    "mkdir -p build/acme && ssh -p 22 qa@host && docker run -p 8080:80 -u 1000:1000 acme",
    "find . -name '*.ts' -print && gcc -pthread main.c && mysql -u root timeoff",
    "date -u +%Y-%m-%dT%H:%M:%SZ && sudo -u postgres psql && compass=north bypass=on",
    "node scripts/seed.js --password-file /run/acme/seed-password",
  ]) {
    assert.equal(maskSecrets(text), text);
  }
});

test("the mask leaves a value after a secret's name that is no secret: a number, a word that says there is none, and the first word of a sentence", () => {
  for (const text of [
    "- password: at least 8 characters, one digit",
    "The reset token: valid for 30 minutes, one use.",
    "Set SESSION_TOKEN_TTL=3600 in .env to change it.",
    "token: none; password: required.",
  ]) {
    assert.equal(maskSecrets(text), text);
  }
  // A secret in the same places is masked.
  assert.equal(maskSecrets("- password: Hunter-two-77, one digit"), "- password: ****, one digit");
  assert.equal(maskSecrets("The reset token: tok3n9x for 30 minutes"), "The reset token: **** for 30 minutes");
  assert.equal(maskSecrets("Set SESSION_TOKEN=3600abc in .env"), "Set SESSION_TOKEN=**** in .env");
  assert.equal(maskSecrets("token: letmein"), "token: ****");
});

test("a result's record whose name names a password, a secret, a token or an API key shows ****, and the other records show their value", (t) => {
  const m = machine(t);
  const records = [
    { name: "admin password", value: "RecPw-888x" },
    { name: "API key of the test app", value: "app-key-123x" },
    { name: "reset token", value: "rt-9x" },
    { name: "Jira issue key", value: "QA-123" },
    { name: "pending time-off request", value: "tor-1786000000000" },
    { name: "token count", value: "1200" },
  ];
  const log = new Log().init("s-1").wait(task("CA-RECRD1"));
  log.update({ request_id: "CA-RECRD1", result: { outcome: "done", summary: "Made the records.", records } }, task("CA-RECRD1", { status: "done" }));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const { text, requests } = routes(m);
  assert.deepEqual(
    requests[0].result.records.map((record) => [record.name, record.value]),
    [
      ["admin password", "****"],
      ["API key of the test app", "****"],
      ["reset token", "****"],
      ["Jira issue key", "QA-123"],
      ["pending time-off request", "tor-1786000000000"],
      ["token count", "1200"],
    ],
  );
  for (const secret of ["RecPw-888x", "app-key-123x", "rt-9x"]) assert.ok(!text.includes(secret), secret);
});

test("a new login's password in a known form never shows, also before the result; as a script's argument it shows until the result names it", (t) => {
  const m = machine(t);
  const covered = "NewLoginPw-4242x";
  const positional = "NewLoginPw-5353x";
  const log = new Log().init("s-1").wait(task("CA-NEWLG1"));
  log.bash("Make the manager login in Staging", `node scripts/create-user.js --email doable-ca-1@acme.example --password ${covered} --role manager`);
  log.bash("Make the employee login in Staging", `node scripts/create-user.js doable-ca-2@acme.example ${positional} employee`);
  log.update({ request_id: "CA-NEWLG1", progress: "Waiting for the sign-up mail" }, task("CA-NEWLG1"));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const page = new PageData({ machine: m.name, env: m.env });
  // The request in progress: /data.json gives its newest steps, and /request.json all of them.
  let text = `${page.json()}\n${page.requestJson("CA-NEWLG1")}`;
  assert.ok(!text.includes(covered), "the password after --password shows while the request works");
  assert.match(JSON.parse(page.requestJson("CA-NEWLG1")).steps[0].detail, /--password \*\*\*\* --role manager$/);
  // The README's limit: a password as a script's argument is in no known form.
  assert.ok(text.includes(positional));

  log.update(
    {
      request_id: "CA-NEWLG1",
      result: {
        outcome: "done",
        summary: "Made two logins.",
        logins: [
          { username: "doable-ca-1@acme.example", password: covered, note: "manager" },
          { username: "doable-ca-2@acme.example", password: positional, note: "employee" },
        ],
      },
    },
    task("CA-NEWLG1", { status: "done" }),
  );
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  text = `${page.json()}\n${page.requestJson("CA-NEWLG1")}`;
  for (const password of [covered, positional]) assert.ok(!text.includes(password), password);
});

test("the README, the page and the page command say that any account of this computer can open the page and which secrets it hides, and claim no more", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8").replace(/\s+/g, " ");
  const html = pageHtml("nonce");
  assert.ok(html.includes(`This page reads only the code agent's files on this computer. ${PAGE_ACCESS} ${PAGE_MASK}`));
  assert.ok(readme.includes(PAGE_ACCESS));
  assert.ok(readme.includes(PAGE_MASK.replace("It shows **** in place", "It shows `****` in place")), "the README's words of the mask");
  for (const text of [readme, html]) {
    for (const claim of ["never shows a password", "no password and no", "nly this computer can open it", "or an API key"]) {
      assert.ok(!text.includes(claim), claim);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Requests: refusals, which request the steps go to, results, questions and answers
// ---------------------------------------------------------------------------------------------------------------------

test("a request that Doable refuses as taken by another machine, cancelled, ended or not claimed is no longer the session's, and the steps after it go to the request that the session serves", (t) => {
  const m = machine(t);
  turnOn(t, m);
  // The MCP library can put words before Doable's text.
  const before = "Error executing tool update_code_agent_request: doable_error: ";
  const asking = task("CA-CCCCC1");
  const log = new Log().init("s-1").wait(asking);
  log.update({ request_id: "CA-CCCCC1", question: "Which role?", wait_seconds: 50 }, { ...asking, status: "needs_answer", question: "Which role?" });
  log.wait(task("CA-AAAAA1")).refuse({ request_id: "CA-AAAAA1", progress: "Reading" }, `${before}CA-AAAAA1 is claimed by another machine.`);
  log.wait(task("CA-BBBBB2"));
  log.call(
    `${PLUGIN}read_code_agent_mail`,
    { request_id: "CA-BBBBB2", to: "acme-tests+b@mail.getdoable.ai", wait_seconds: 60 },
    "doable_error: CA-BBBBB2 was cancelled: stop the work.",
    { isError: true },
  );
  log.wait(task("CA-DDDDD3")).refuse({ request_id: "CA-DDDDD3", progress: "Reading" }, `${before}CA-DDDDD3 has ended (timed_out).`);
  log.wait(task("CA-EEEEE4")).refuse({ request_id: "CA-EEEEE4", progress: "Reading" }, `${before}CA-EEEEE4 is not claimed: take it with next.`);
  // The answer comes, and the session serves the answered request with no wait between.
  log.update({ request_id: "CA-CCCCC1", wait_seconds: 0 }, { ...asking, question: "Which role?", answer: "The manager." });
  log.read("/repo/roles.ts");
  log.update({ request_id: "CA-CCCCC1", progress: "Reading the roles" }, { ...asking, question: "Which role?", answer: "The manager." });
  writeFileSync(join(m.dir, "session.jsonl"), log.text());

  const statuses = (summary) => summary.requests.map((request) => [request.id, request.status]);
  let { summary, requests } = routes(m);
  assert.deepEqual(statuses(summary), [
    ["CA-EEEEE4", "given back to the queue"],
    ["CA-DDDDD3", "timed out"],
    ["CA-BBBBB2", "cancelled"],
    ["CA-AAAAA1", "taken by another machine"],
    ["CA-CCCCC1", "working"],
  ]);
  const byRequest = byId(requests);
  assert.deepEqual(byRequest["CA-CCCCC1"].steps.map((step) => step.target), ["/repo/roles.ts"]);
  assert.deepEqual(byRequest["CA-EEEEE4"].steps, []);
  for (const id of ["CA-AAAAA1", "CA-DDDDD3", "CA-EEEEE4"]) assert.equal(byRequest[id].events.at(-1).kind, "refused");
  assert.deepEqual(summary.requests.map((row) => row.refused), [1, 1, 1, 1, 0]);

  // When the service stops, a request that was no longer the session's keeps its status: the session did not leave it.
  writeFileSync(join(m.dir, "stopped"), "now\n");
  ({ summary } = routes(m));
  assert.deepEqual(statuses(summary), [
    ["CA-EEEEE4", "given back to the queue"],
    ["CA-DDDDD3", "timed out"],
    ["CA-BBBBB2", "cancelled"],
    ["CA-AAAAA1", "taken by another machine"],
    ["CA-CCCCC1", "left when its session ended"],
  ]);
});

test("a refusal while the request's question waits for its answer, or of a field that Doable does not take, leaves the request the session's", (t) => {
  const m = machine(t);
  turnOn(t, m);
  const asking = task("CA-FFFFF1");
  const log = new Log().init("s-1").wait(asking);
  log.update({ request_id: "CA-FFFFF1", question: "Which role?", wait_seconds: 50 }, { ...asking, status: "needs_answer", question: "Which role?" });
  log.refuse(
    { request_id: "CA-FFFFF1", progress: "Still waiting" },
    "doable_error: CA-FFFFF1 waits for the answer to its question: read it with a long poll of the request.",
  );
  log.wait(task("CA-GGGGG2"));
  log.refuse(
    { request_id: "CA-GGGGG2", result: { outcome: "done", summary: "a summary with a code block" } },
    "doable_error: summary: Value error, it holds code (a code block or a diff): say in words what the code does, and send it again",
  );
  log.read("/repo/g.ts");
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const requests = byId(routes(m).requests);
  assert.equal(requests["CA-FFFFF1"].status, "waiting for an answer");
  assert.equal(requests["CA-FFFFF1"].question, "Which role?");
  assert.equal(requests["CA-GGGGG2"].status, "working");
  assert.equal(requests["CA-GGGGG2"].question, null);
  assert.deepEqual(requests["CA-GGGGG2"].steps.map((step) => step.target), ["/repo/g.ts"]);
});

test("the steps after a request ended and before the next request are the session's own, also hours later", (t) => {
  const m = machine(t);
  turnOn(t, m);
  const log = new Log().init("s-1").wait(task("CA-AAAAA1"));
  log.update({ request_id: "CA-AAAAA1", result: { outcome: "done", summary: "Answered." } }, task("CA-AAAAA1", { status: "done" }));
  log.say("CA-AAAAA1: done, answered.");
  // Two hours later Doable answers the waits with server errors, and the session waits 20 seconds after each (the Skill).
  log.at("2026-11-25T11:00:00.000Z");
  for (let i = 0; i < 3; i += 1) {
    log.call(`${PLUGIN}wait_for_code_agent_request`, { wait_seconds: 290 }, "doable_server_error: 503 Service Unavailable", { isError: true });
    log.bash("Wait before the next call", "sleep 20");
  }
  log.say("Doable has answered with server errors for more than 10 minutes.");
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const { requests, current } = routes(m);
  assert.deepEqual(byId(requests)["CA-AAAAA1"].steps.map((step) => step.text ?? step.target), ["CA-AAAAA1: done, answered."]);
  assert.deepEqual(current.steps.map((step) => step.text ?? step.target), [
    "Wait before the next call",
    "Wait before the next call",
    "Wait before the next call",
    "Doable has answered with server errors for more than 10 minutes.",
  ]);
  assert.deepEqual(current.failedCalls.map((call) => call.what), ["wait for a request", "wait for a request", "wait for a request"]);
});

test("when a request ends while the answer of another one waits, the steps that follow are the answered request's, and the closing line stays with the request that ended", (t) => {
  const m = machine(t);
  turnOn(t, m);
  const asking = task("CA-AAAAA1");
  const log = new Log().init("s-1").wait(asking);
  log.update({ request_id: "CA-AAAAA1", question: "Which role?", wait_seconds: 50 }, { ...asking, status: "needs_answer", question: "Which role?" });
  log.wait(task("CA-BBBBB2"));
  log.read("/repo/b.ts");
  // A check of A brings its answer while the session serves B.
  log.update({ request_id: "CA-AAAAA1", wait_seconds: 0 }, { ...asking, question: "Which role?", answer: "The manager." });
  log.update({ request_id: "CA-BBBBB2", result: { outcome: "done", summary: "B answered." } }, task("CA-BBBBB2", { status: "done" }));
  log.say("CA-BBBBB2: done.");
  log.read("/repo/roles.ts");
  log.bash("Make the manager login in Staging", "node scripts/create-user.js --role manager");
  log.update({ request_id: "CA-AAAAA1", progress: "Made the login" }, { ...asking, question: "Which role?", answer: "The manager." });
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const requests = byId(routes(m).requests);
  const steps = (id) => requests[id].steps.map((step) => step.text ?? step.target);
  assert.deepEqual(steps("CA-BBBBB2"), ["/repo/b.ts", "CA-BBBBB2: done."]);
  assert.deepEqual(steps("CA-AAAAA1"), ["/repo/roles.ts", "Make the manager login in Staging"]);
});

test("a check that brings the answer while the session serves no request gives the steps after it to the answered request", (t) => {
  const m = machine(t);
  turnOn(t, m);
  const asking = task("CA-AAAAA1");
  const log = new Log().init("s-1").wait(asking);
  log.update({ request_id: "CA-AAAAA1", question: "Which role?", wait_seconds: 50 }, { ...asking, status: "needs_answer", question: "Which role?" });
  log.wait(null);
  log.bash("Look at the folder", "git status");
  log.update({ request_id: "CA-AAAAA1", wait_seconds: 0 }, { ...asking, question: "Which role?", answer: "The manager." });
  log.read("/repo/roles.ts");
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const { requests, current } = routes(m);
  assert.deepEqual(byId(requests)["CA-AAAAA1"].steps.map((step) => step.target), ["/repo/roles.ts"]);
  assert.deepEqual(current.steps.map((step) => step.target), ["Look at the folder"]);
});

test("a result that the result call got back as cancelled shows that Doable did not keep it, with the usernames of its logins", (t) => {
  const m = machine(t);
  turnOn(t, m);
  const log = new Log().init("s-1").wait(task("CA-AAAAA1"));
  log.update({ request_id: "CA-AAAAA1", progress: "Making the login" }, task("CA-AAAAA1"));
  log.update(
    {
      request_id: "CA-AAAAA1",
      result: { outcome: "done", summary: "Made one login.", logins: [{ username: "qa@acme.example", password: "NotKeptPw-77x", note: "manager" }] },
    },
    task("CA-AAAAA1", { status: "cancelled", cancel_requested: true }),
  );
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const { text, requests } = routes(m);
  const [request] = requests;
  assert.equal(request.status, "cancelled");
  assert.equal(request.result.kept, false);
  assert.deepEqual(request.events.at(-1), { kind: "result not kept", at: request.result.at, what: null, text: "done" });
  assert.deepEqual(request.result.logins, [{ username: "qa@acme.example", note: "manager" }]);
  assert.ok(!text.includes("NotKeptPw-77x"));
});

test("a request taken with a question and its answer shows the question before the answer, and a question of this session shows once", (t) => {
  const m = machine(t);
  turnOn(t, m);
  const question = "Do you need the rule of the current version only, or also a change that the team plans?";
  const log = new Log().init("s-1").wait(task("CA-QQQQQ1", { question, answer: "The current version only." }));
  // This session asks, and the check gives back the question with its answer.
  const asking = task("CA-RRRRR2");
  log.wait(asking);
  log.update({ request_id: "CA-RRRRR2", question: "Which role?", wait_seconds: 50 }, { ...asking, status: "needs_answer", question: "Which role?" });
  log.update({ request_id: "CA-RRRRR2", wait_seconds: 0 }, { ...asking, question: "Which role?", answer: "The manager." });
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const requests = byId(routes(m).requests);
  const lines = (id) => requests[id].events.map((event) => [event.kind, event.text]);
  assert.deepEqual(lines("CA-QQQQQ1"), [
    ["taken", null],
    ["question", question],
    ["answer", "The current version only."],
  ]);
  assert.deepEqual(lines("CA-RRRRR2"), [
    ["taken", null],
    ["question", "Which role?"],
    ["answer", "The manager."],
  ]);
});

test("a request held when its session ended says what Doable does with it: a question waits for its answer, and an answered request waits 30 minutes", (t) => {
  const m = machine(t);
  const asking = task("CA-AAAAA1");
  const answered = task("CA-CCCCC3");
  const log = new Log().init("s-1").wait(asking);
  log.update({ request_id: "CA-AAAAA1", question: "Which role?", wait_seconds: 50 }, { ...asking, status: "needs_answer", question: "Which role?" });
  log.wait(task("CA-BBBBB2")).update({ request_id: "CA-BBBBB2", progress: "Reading" }, task("CA-BBBBB2"));
  log.wait(answered);
  log.update({ request_id: "CA-CCCCC3", question: "Which build?", wait_seconds: 50 }, { ...answered, status: "needs_answer", question: "Which build?" });
  log.update({ request_id: "CA-CCCCC3", wait_seconds: 0 }, { ...answered, question: "Which build?", answer: "Build 512." });
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  writeFileSync(join(m.dir, "stopped"), "now\n");
  const requests = byId(routes(m).requests);
  assert.deepEqual(
    ["CA-AAAAA1", "CA-BBBBB2", "CA-CCCCC3"].map((id) => [requests[id].status, requests[id].note]),
    [
      [
        "waiting for an answer; no session serves it",
        "No session serves it now. It waits up to 24 hours for the asker's answer. When the answer comes, Doable keeps it for this machine for 30 minutes, then gives it back to the queue, and the next session can take it.",
      ],
      [
        "left when its session ended",
        "No session serves it now. Doable gives it back to the queue 10 minutes after the last word from the session, and the next session can take it.",
      ],
      [
        "left when its session ended",
        "No session serves it now. Doable keeps it for this machine until 30 minutes after the answer, or 10 minutes after the last word from the session when that is later. Then it gives it back to the queue, and the next session can take it.",
      ],
    ],
  );
  // The question that waits with no session shows in the list's line, for the "Needs attention" part.
  assert.equal(requests["CA-AAAAA1"].question, "Which role?");
});

test("an answer longer than the kept length shows whole, and another long text shows a mark where it was cut", (t) => {
  const m = machine(t);
  turnOn(t, m);
  const answer = `${"The approval rule, in words. ".repeat(200)}LAST SENTENCE: do not touch the payroll records.`;
  const progress = "p".repeat(5000);
  const asking = task("CA-AAAAA1");
  const log = new Log().init("s-1").wait(asking);
  log.update({ request_id: "CA-AAAAA1", question: "Which rule?", wait_seconds: 50 }, { ...asking, status: "needs_answer", question: "Which rule?" });
  log.update({ request_id: "CA-AAAAA1", wait_seconds: 0 }, { ...asking, question: "Which rule?", answer });
  log.update({ request_id: "CA-AAAAA1", progress }, { ...asking, question: "Which rule?", answer });
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const events = routes(m).requests[0].events;
  assert.equal(events.find((event) => event.kind === "answer").text, answer);
  const shown = events.find((event) => event.kind === "progress").text;
  assert.equal(shown, `${"p".repeat(4000)}…`);
});

test("output of the session that is no event shows in the page's data, masked, with the time of the event before it", (t) => {
  const m = machine(t);
  turnOn(t, m);
  const log = new Log().init("s-1").wait(task("CA-AAAAA1"));
  log.end("success", "Stopped.", false);
  const lastAt = new Date(log.clock).toISOString();
  const errors = "error: unknown option '--chrome'\n".repeat(3);
  writeFileSync(join(m.dir, "session.jsonl"), `${log.text()}${errors}DB_PASSWORD=Hunter-9x is not set\n`);
  const { summary, current } = routes(m);
  assert.equal(current.id, "s-1");
  assert.deepEqual(summary.otherOutput, [
    { after: lastAt, text: "error: unknown option '--chrome'" },
    { after: lastAt, text: "error: unknown option '--chrome'" },
    { after: lastAt, text: "error: unknown option '--chrome'" },
    { after: lastAt, text: "DB_PASSWORD=**** is not set" },
  ]);

  // A log with no event at all: the page has found a log, but no session in it.
  writeFileSync(join(m.dir, "session.jsonl"), "Invalid API key · Please run /login\n/bin/bash: /opt/claude: No such file or directory\n");
  const empty = summaryOf(m);
  assert.equal(empty.logFound, true);
  assert.equal(empty.session, null);
  assert.deepEqual(empty.otherOutput.map((line) => [line.after, line.text]), [
    [null, "Invalid API key · Please run /login"],
    [null, "/bin/bash: /opt/claude: No such file or directory"],
  ]);
});

test("a line that a cut write or stderr text with no newline joins to the next session's start loses only itself", (t) => {
  const m = machine(t);
  turnOn(t, m);
  const first = new Log().init("s-1").wait(task("CA-AAAAA1")).update({ request_id: "CA-AAAAA1", progress: "Reading" }, task("CA-AAAAA1"));
  const second = new Log(PLUGIN, "2026-11-25T09:30:01.000Z").init("s-2").wait(task("CA-BBBBB2"));
  const cutEvent = first.lines.at(-2).slice(0, 30);
  for (const [joined, other] of [
    [cutEvent, []],
    ["error: the write of the output failed", ["error: the write of the output failed"]],
  ]) {
    writeFileSync(join(m.dir, "session.jsonl"), `${first.text()}${joined}${second.text()}`);
    const { summary, current, earlier } = routes(m);
    assert.equal(current.id, "s-2");
    assert.deepEqual(earlier.map((session) => session.id), ["s-1"]);
    assert.deepEqual(summary.requests.map((request) => [request.id, request.status]), [
      ["CA-BBBBB2", "working"],
      ["CA-AAAAA1", "left when its session ended"],
    ]);
    assert.deepEqual(summary.otherOutput.map((line) => line.text), other);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The page's script, in a small DOM: elements with their children, text, classes, attributes, data keys, folds and
// listeners, and a layout in which each row or card (an element with a data key) is 100 px high, one under the other.
// The script reads the real page server of the machine.
// ---------------------------------------------------------------------------------------------------------------------

class FakeText {
  constructor(text) {
    this.text = text;
    this.parentNode = null;
    this.childNodes = [];
    this.dataset = {};
  }

  get textContent() {
    return this.text;
  }
}

class FakeElement {
  constructor(tagName, page) {
    this.tagName = tagName.toUpperCase();
    this.page = page;
    this.childNodes = [];
    this.parentNode = null;
    this.className = "";
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.open = false;
    this.title = "";
    this.value = "";
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    const names = () => this.className.split(" ").filter(Boolean);
    this.classList = {
      add: (name) => {
        if (!names().includes(name)) this.className = [...names(), name].join(" ");
      },
      remove: (name) => {
        this.className = names().filter((item) => item !== name).join(" ");
      },
      contains: (name) => names().includes(name),
    };
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  // As in a browser: the text becomes one text node, which later children follow.
  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (String(value) !== "") this.append(new FakeText(String(value)));
  }

  get lastChild() {
    return this.childNodes.at(-1) ?? null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.parentNode) node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.textContent = "";
    this.append(...nodes);
  }

  contains(node) {
    for (let item = node; item; item = item.parentNode) if (item === this) return true;
    return false;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, target: this });
  }

  click() {
    this.dispatch("click");
  }

  focus() {
    this.page.document.activeElement = this;
  }

  scrollIntoView() {
    this.page.scrolledTo = this;
  }

  getBoundingClientRect() {
    const top = this.page.cards().indexOf(this) * 100 - this.page.window.scrollY;
    return { top, bottom: top + 100 };
  }
}

function descendants(node) {
  return node.childNodes.flatMap((child) => [child, ...descendants(child)]);
}

// This tab's session storage, kept in a map (a reload in the same tab keeps it).
class FakeStorage {
  constructor() {
    this.items = new Map();
  }

  getItem(name) {
    return this.items.get(name) ?? null;
  }

  setItem(name, value) {
    this.items.set(name, String(value));
  }

  removeItem(name) {
    this.items.delete(name);
  }
}

// The page's script on the machine's real page server, with the address `hash`. `page.fail` makes each read fail:
// "unreachable" (no answer) or { status, body }. `now` is the server's clock, and `storage` the tab's session storage
// (none: a browser that refuses it).
async function scriptPage(t, m, hash = "", { now = CLOCK, storage = null } = {}) {
  const port = await serve(t, m, now);
  const page = { fail: null, reading: 0, scrolledTo: null };
  const element = (tag) => new FakeElement(tag, page);
  const body = element("body");
  const parts = { title: element("h1"), updated: element("span"), status: element("div"), problem: element("p"), content: element("main") };
  parts.problem.hidden = true;
  body.append(...Object.values(parts));
  page.window = {
    scrollY: 0,
    selection: null,
    getSelection: () => page.window.selection,
    scrollBy: (x, y) => (page.window.scrollY += y),
    location: { hash },
    history: { replaceState: (state, title, address) => (page.window.location.hash = address) },
    addEventListener: () => {},
    ...(storage === null ? {} : { sessionStorage: storage }),
  };
  page.cards = () => descendants(body).filter((node) => node.dataset.key !== undefined);
  page.parts = parts;
  page.body = body;
  page.document = { title: "", activeElement: null, createElement: element, getElementById: (id) => parts[id] };
  page.paths = [];
  const fetch = async (path) => {
    page.paths.push(path);
    if (page.fail === "unreachable") throw new TypeError("Failed to fetch");
    page.reading += 1;
    try {
      const answer = page.fail ?? (await get(port, path));
      const text = answer.body;
      return { ok: answer.status === 200, status: answer.status, text: async () => text };
    } finally {
      page.reading -= 1;
    }
  };
  const source = /<script nonce="nonce">([\s\S]*)<\/script>/.exec(pageHtml("nonce"))[1];
  const context = { document: page.document, window: page.window, fetch, setInterval: () => 0, console };
  runInNewContext(source, context);
  page.load = async () => {
    await context.load();
  };
  // Until each read that a click started has its answer.
  page.idle = async () => {
    do await new Promise((done) => setTimeout(done, 20));
    while (page.reading > 0);
    await new Promise((done) => setTimeout(done, 20));
  };
  await page.idle();
  return page;
}

const find = (node, test) => descendants(node).find(test);
const byKey = (page, key) => find(page.body, (node) => node.dataset.key === key);
const rowOf = (page, id) => byKey(page, `request:${id}`);
const rowIds = (page) => descendants(page.parts.content).filter((node) => node.dataset.key?.startsWith("request:")).map((node) => node.dataset.key.slice(8));
const buttonOf = (node, text) => find(node, (item) => item.tagName === "BUTTON" && item.textContent === text);
const headOf = (row) => row.childNodes[0];
const factOf = (node, name) => {
  const term = find(node, (item) => item.tagName === "DT" && item.textContent === name);
  return term.parentNode.childNodes[term.parentNode.childNodes.indexOf(term) + 1].textContent;
};
const headings = (node, tag) => descendants(node).filter((item) => item.tagName === tag).map((item) => item.textContent);

test("the page shows what needs a person first, then the request in progress, then the tabs", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  writeFileSync(join(m.dir, "session.jsonl"), sixRequests().text());
  writeFileSync(join(m.dir, "update-asked"), "0.6.4\n");
  const page = await scriptPage(t, m);
  const { content, status } = page.parts;
  assert.equal(find(status, (node) => node.className?.includes("big")).textContent, "Working on CA-FFFFF6");
  assert.deepEqual(headings(content, "H2"), ["Needs attention", "Now"]);
  assert.deepEqual(headings(content.childNodes[0], "H3"), ["CA-EEEEE5 waits for an answer", "Doable asked for the plugin 0.6.4", "Doable did not take 1 call of CA-FFFFF6"]);
  assert.ok(content.childNodes[0].textContent.includes("Should the request be for half a day?"));
  // Now: the request in progress, and its lines.
  const now = byKey(page, "now:CA-FFFFF6");
  assert.ok(content.childNodes[1].contains(now));
  assert.ok(now.textContent.includes("Reading the holidays"));
  assert.deepEqual(
    find(content, (node) => node.getAttribute?.("role") === "tablist").childNodes.map((tab) => [tab.textContent, tab.getAttribute("aria-selected")]),
    [
      ["Requests6", "true"],
      ["Sessions1", "false"],
      ["Service log0", "false"],
    ],
  );
  assert.deepEqual(rowIds(page), ["CA-FFFFF6", "CA-EEEEE5", "CA-DDDDD4", "CA-CCCCC3", "CA-BBBBB2", "CA-AAAAA1"]);
  // The page read only /data.json: no line is open.
  assert.deepEqual([...new Set(page.paths)], ["/data.json"]);

  // "Open" in the "Needs attention" part opens that request's line.
  buttonOf(content.childNodes[0], "Open CA-EEEEE5").click();
  await page.idle();
  assert.equal(page.window.location.hash, "#requests&open=CA-EEEEE5");
  assert.equal(headOf(rowOf(page, "CA-EEEEE5")).getAttribute("aria-expanded"), "true");
  assert.ok(page.paths.includes("/request.json?id=CA-EEEEE5"));

  // Contrast: with nothing that needs a person, the part is not there.
  const quiet = machine(t);
  turnOn(t, quiet);
  writeFileSync(join(quiet.dir, "session.jsonl"), new Log().init("s-1").wait(task("CA-AAAAA1")).text());
  const calm = await scriptPage(t, quiet);
  assert.deepEqual(headings(calm.parts.content, "H2"), ["Now"]);
});

test("the requests come in pages of 10, the address keeps the page, Previous, Next and the size of a page move through them, and a reload on the Service log tab keeps the size", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  const log = new Log().init("s-1");
  const ids = Array.from({ length: 25 }, (_, i) => `CA-R${String(i + 1).padStart(5, "0")}`);
  for (const id of ids) log.wait(task(id)).update({ request_id: id, result: { outcome: "done", summary: "Answered." } }, task(id, { status: "done" }));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const newest = [...ids].reverse();
  const page = await scriptPage(t, m, "#requests&page=2");
  const range = () => find(page.parts.content, (node) => node.className === "range").textContent;
  assert.deepEqual(rowIds(page), newest.slice(10, 20));
  assert.equal(range(), "11–20 of 25");

  buttonOf(page.parts.content, "Next").click();
  assert.deepEqual(rowIds(page), newest.slice(20));
  assert.equal(range(), "21–25 of 25");
  assert.equal(page.window.location.hash, "#requests&page=3");
  assert.equal(buttonOf(page.parts.content, "Next").disabled, true);
  buttonOf(page.parts.content, "1").click();
  assert.deepEqual(rowIds(page), newest.slice(0, 10));
  assert.equal(page.window.location.hash, "#requests");
  assert.equal(buttonOf(page.parts.content, "Previous").disabled, true);

  // The size of a page: three buttons, the chosen one pressed.
  const sizes = () => find(page.parts.content, (node) => node.getAttribute?.("aria-label") === "Rows on a page").childNodes.filter((node) => node.tagName === "BUTTON");
  assert.deepEqual(sizes().map((node) => [node.textContent, node.getAttribute("aria-pressed")]), [["10", "true"], ["25", "false"], ["50", "false"]]);
  sizes()[1].click();
  assert.deepEqual(rowIds(page), newest);
  assert.equal(page.window.location.hash, "#requests&size=25");
  assert.equal(range(), "1–25 of 25");
  assert.deepEqual(sizes().map((node) => node.getAttribute("aria-pressed")), ["false", "true", "false"]);
  await page.idle();

  // The next read with new data keeps the place, and the focus on the size that the person chose.
  const before = sizes()[1];
  before.focus();
  log.wait(task("CA-R00026"));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  await page.load();
  assert.deepEqual(rowIds(page), ["CA-R00026", ...newest.slice(0, 24)]);
  assert.ok(sizes()[1] !== before, "the read did not build the list again");
  assert.ok(page.document.activeElement === sizes()[1], "the focus left the size of a page");

  // The Service log tab's address keeps the size too: a reload there, then the Requests tab, shows 25 rows again.
  buttonOf(page.parts.content, "Service log0").click();
  assert.equal(page.window.location.hash, "#log&size=25");
  await page.idle();
  const reloaded = await scriptPage(t, m, page.window.location.hash);
  buttonOf(reloaded.parts.content, "Requests26").click();
  assert.equal(rowIds(reloaded).length, 25);
  assert.equal(reloaded.window.location.hash, "#requests&size=25");
  await reloaded.idle();
});

test("the status chips and the search box narrow the list, and a list that nothing matches says so", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  writeFileSync(join(m.dir, "session.jsonl"), sixRequests().text());
  const page = await scriptPage(t, m);
  const chips = () => find(page.parts.content, (node) => node.className === "chips").childNodes.map((chip) => [chip.textContent, chip.getAttribute("aria-pressed")]);
  assert.deepEqual(chips(), [
    ["All6", "true"],
    ["Open2", "false"],
    ["Done1", "false"],
    ["Failed1", "false"],
    ["Declined1", "false"],
    ["Other1", "false"],
  ]);
  buttonOf(page.parts.content, "Open2").click();
  assert.deepEqual(rowIds(page), ["CA-FFFFF6", "CA-EEEEE5"]);
  assert.equal(page.window.location.hash, "#requests&filter=open");
  buttonOf(page.parts.content, "Other1").click();
  assert.deepEqual(rowIds(page), ["CA-DDDDD4"]);
  buttonOf(page.parts.content, "All6").click();

  // The search box looks in the id, the asker and the text.
  const search = find(page.parts.content, (node) => node.tagName === "INPUT");
  const type = (words) => {
    search.value = words;
    search.dispatch("input");
  };
  type("dev@acme");
  assert.deepEqual(rowIds(page), ["CA-BBBBB2"]);
  type("production");
  assert.deepEqual(rowIds(page), ["CA-CCCCC3"]);
  type("ca-ddddd4");
  assert.deepEqual(rowIds(page), ["CA-DDDDD4"]);
  type("nothing like this");
  assert.deepEqual(rowIds(page), []);
  assert.ok(page.parts.content.textContent.includes("No request matches the filter and the search."));
  buttonOf(page.parts.content, "Show all requests").click();
  assert.equal(rowIds(page).length, 6);
  assert.equal(search.value, "");
  await page.idle();
});

test("a click on a line opens the request's details from /request.json, and they stay open and new through the next reads", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  const roles = task("CA-AAAAA1", { request: "Which roles can approve a request?" });
  const log = new Log().init("s-1").wait(roles);
  log.update({ request_id: "CA-AAAAA1", progress: "Reading the roles" }, roles);
  log.read("/repo/roles.ts");
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const page = await scriptPage(t, m);
  const head = () => headOf(rowOf(page, "CA-AAAAA1"));
  assert.equal(head().getAttribute("aria-expanded"), "false");
  assert.ok(!page.paths.some((path) => path.startsWith("/request.json")));

  head().click();
  await page.idle();
  assert.equal(head().getAttribute("aria-expanded"), "true");
  assert.equal(page.window.location.hash, "#requests&open=CA-AAAAA1");
  const detail = () => rowOf(page, "CA-AAAAA1").childNodes[1];
  assert.equal(detail().id, "detail-CA-AAAAA1");
  assert.equal(factOf(detail(), "Asker").startsWith("Asked from a Doable chat of the suite “Time off”"), true);
  assert.ok(detail().textContent.includes("Which roles can approve a request?"));
  assert.ok(detail().textContent.includes("Reading the roles"));
  // The focus stays on the line's button. assert.ok, not assert.equal: a diff of two elements prints the whole page.
  assert.ok(page.document.activeElement === head(), "the focus left the line's button");

  // New lines of the open request: the next read shows them, and the line stays open.
  log.update({ request_id: "CA-AAAAA1", progress: "Found the approver rule" }, roles);
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  await page.load();
  assert.equal(head().getAttribute("aria-expanded"), "true");
  assert.ok(detail().textContent.includes("Found the approver rule"));

  // A second click closes it.
  head().click();
  assert.equal(head().getAttribute("aria-expanded"), "false");
  assert.equal(rowOf(page, "CA-AAAAA1").childNodes.length, 1);
  assert.equal(page.window.location.hash, "#requests");
  await page.idle();
});

test("the Sessions tab lists the sessions one line each, newest first, with how each ended, and a line opens the session's facts", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  const log = new Log().init("s-1").wait(task("CA-AAAAA1"));
  log.update({ request_id: "CA-AAAAA1", result: { outcome: "done", summary: "Answered." } }, task("CA-AAAAA1", { status: "done" }));
  log.end("success", "Served one request.", false);
  // Three sessions at the plan limit, one each 5 minutes.
  for (const [i, start] of ["2026-11-25T10:00:01.000Z", "2026-11-25T10:05:01.000Z", "2026-11-25T10:10:01.000Z"].entries()) {
    log.at(start).init(`limit-${i}`).quiet("rejected");
    log.say("Claude AI usage limit reached").end("success", "Claude AI usage limit reached|1795881600", true);
  }
  log.at("2026-11-25T10:15:01.000Z").init("s-5").wait(task("CA-BBBBB2"));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const page = await scriptPage(t, m);
  buttonOf(page.parts.content, "Sessions5").click();
  await page.idle();
  assert.equal(page.window.location.hash, "#sessions");
  const lines = descendants(page.parts.content).filter((node) => node.dataset.key?.startsWith("session:"));
  assert.deepEqual(
    lines.map((line) => [line.dataset.key, find(line, (node) => node.className === "c-how").textContent, find(line, (node) => node.className === "c-count").textContent]),
    [
      ["session:s-5", "runs now", "1 request"],
      ["session:limit-2", "stopped at the plan limit", "0 requests"],
      ["session:limit-1", "stopped at the plan limit", "0 requests"],
      ["session:limit-0", "stopped at the plan limit", "0 requests"],
      ["session:s-1", "ended its turn", "1 request"],
    ],
  );
  headOf(lines[1]).click();
  await page.idle();
  // The address names the session by its id, which a move of the log does not change.
  assert.equal(page.window.location.hash, "#sessions&open=limit-2");
  const opened = byKey(page, "session:limit-2");
  assert.equal(factOf(opened, "How it ended"), "It stopped with an error. Its last message: Claude AI usage limit reached|1795881600");
  // The plan limit's time has its time zone.
  const resets = new Date(1795881600 * 1000);
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(resets).find((part) => part.type === "timeZoneName").value;
  const plan = factOf(opened, "Plan limit");
  assert.match(plan, /^reached; it resets at /);
  assert.ok(plan.endsWith(zone), plan);
});

test("a new request above the line that the person reads keeps that line in its place, and a selection holds the new data", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  const log = new Log().init("s-1").wait(task("CA-AAAAA1")).wait(task("CA-BBBBB2"));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const page = await scriptPage(t, m);
  // The person scrolls until the line of CA-AAAAA1 is at the top of the window.
  page.window.scrollY = rowOf(page, "CA-AAAAA1").getBoundingClientRect().top;
  assert.equal(rowOf(page, "CA-AAAAA1").getBoundingClientRect().top, 0);

  log.wait(task("CA-CCCCC3"));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  await page.load();
  assert.ok(rowOf(page, "CA-CCCCC3"));
  assert.equal(rowOf(page, "CA-AAAAA1").getBoundingClientRect().top, 0);

  // The person selects text in a line: the new data waits until the selection ends.
  const selected = rowOf(page, "CA-AAAAA1");
  page.window.selection = { isCollapsed: false, anchorNode: selected.childNodes[0] };
  log.wait(task("CA-DDDDD4"));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  await page.load();
  // assert.ok, not assert.equal: a diff of two elements prints the whole page.
  assert.ok(rowOf(page, "CA-DDDDD4") === undefined, "the page shows the new request while text is selected");
  assert.ok(rowOf(page, "CA-AAAAA1") === selected, "the page built the selected line again");
  assert.equal(page.parts.updated.textContent, "New data waits while you select text on the page.");
  page.window.selection = { isCollapsed: true, anchorNode: null };
  await page.load();
  assert.ok(rowOf(page, "CA-DDDDD4"));
  assert.equal(page.parts.updated.textContent, "Updated now");
});

test("when the page cannot read its data, a note that stays in view says why, and the old data is marked as old", async (t) => {
  const m = machine(t);
  writeFileSync(join(m.dir, "session.jsonl"), sixRequests().text());
  const page = await scriptPage(t, m);
  const { problem, content } = page.parts;
  assert.equal(problem.hidden, true);

  page.fail = "unreachable";
  await page.load();
  assert.equal(problem.hidden, false);
  assert.equal(problem.textContent, "The page cannot reach its server. Start the page command again on this computer. The data below is from the last read.");
  assert.ok(content.classList.contains("stale"));

  // The server answers with its reason, for example after `remove`: the page shows only that reason.
  page.fail = { status: 500, body: `No code agent "${m.name}" is set up on this machine.\n` };
  await page.load();
  assert.equal(problem.textContent, `No code agent "${m.name}" is set up on this machine.`);

  page.fail = null;
  await page.load();
  assert.equal(problem.hidden, true);
  assert.ok(!content.classList.contains("stale"));
  // The note stays at the top of the window when the person scrolls.
  assert.match(pageHtml("nonce"), /\.problem \{ position: sticky; top: 0;/);
});

test("the page's words: one step, a request whose asking time is not known, a long text with Show more, a summary in the body's font, a result that Doable did not keep, and an address with an open line brings that line into view", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  const long = `${"The approval rule, in words. ".repeat(60)}LAST`;
  const log = new Log().init("s-1").quiet("rejected");
  log.wait(task("CA-AAAAA1", { request: long })).read("/repo/a.ts");
  log.update(
    { request_id: "CA-AAAAA1", result: { outcome: "done", summary: "**Answer:** the limit is 8.", logins: [{ username: "qa@acme.example", password: "Pw-1x", note: "manager" }] } },
    task("CA-AAAAA1", { request: long, status: "cancelled", cancel_requested: true }),
  );
  // A request that the logs know only from a refused call.
  log.refuse({ request_id: "CA-ZZZZZ9", progress: "Reading" }, "doable_error: CA-ZZZZZ9 waits for the answer to its question: read it with a long poll of the request.");
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const page = await scriptPage(t, m, "#requests&open=CA-AAAAA1");
  const row = rowOf(page, "CA-AAAAA1");
  // A reload of the address: the page shows the open line, not the top of the page.
  assert.ok(page.scrolledTo === headOf(row), "the open line is not in view");
  assert.ok(find(row, (node) => node.tagName === "SUMMARY" && node.textContent === "What the session did for it (1 step)"));
  const summary = find(row, (node) => node.textContent === "**Answer:** the limit is 8." && node.childNodes.every((child) => child instanceof FakeText));
  assert.equal(summary.tagName, "DIV");
  assert.equal(summary.className, "summary");
  assert.ok(find(row, (node) => node.tagName === "H4" && node.textContent === "Result sent after the cancel: Doable did not keep it"));
  assert.ok(find(row, (node) => node.tagName === "TD" && node.textContent === "qa@acme.example"));
  // The long request text shows its first lines, and "Show more" shows it whole.
  const text = () => find(row, (node) => node.textContent === long && node.childNodes.every((child) => child instanceof FakeText));
  assert.equal(text().className, "clamped lines-6");
  const more = buttonOf(rowOf(page, "CA-AAAAA1"), "Show more");
  assert.equal(more.getAttribute("aria-expanded"), "false");
  more.click();
  assert.equal(find(rowOf(page, "CA-AAAAA1"), (node) => node.textContent === long && node.childNodes.every((child) => child instanceof FakeText)).className, "");
  assert.equal(buttonOf(rowOf(page, "CA-AAAAA1"), "Show less").getAttribute("aria-expanded"), "true");

  // The request that the logs know only from a refused call: its asking time is not known.
  headOf(rowOf(page, "CA-ZZZZZ9")).click();
  await page.idle();
  assert.equal(factOf(rowOf(page, "CA-ZZZZZ9"), "Asked"), "not in the logs");

  // A log that holds only other output: the page says that the session cannot start, with that output.
  writeFileSync(join(m.dir, "session.jsonl"), "Invalid API key · Please run /login\n");
  await page.load();
  const words = page.parts.content.textContent;
  assert.ok(words.includes("The session cannot start"), words);
  assert.ok(words.includes("Invalid API key · Please run /login"));
  assert.equal(find(page.parts.status, (node) => node.className?.includes("big")).textContent, "Cannot start");
});

test("the page says whether self-update is on, and what happens when it is off, and reads the choice again when it changes", async (t) => {
  const m = machine(t);
  const words = {
    on: "Self-update is on: when Doable asks for a newer plugin, the session ends, and the start script updates the plugin with Claude Code and starts the new release. It updates at no other time. The service's log below shows each ask, each update and each failure.",
    off: "Self-update is off: when Doable asks for a newer plugin, each session ends at its first wait for a request, and the next one starts 30 minutes later, until a person updates the plugin on this computer.",
    "development folder":
      "Self-update is off: the session loads the plugin from a development folder. When Doable asks for a newer plugin, each session ends at its first wait for a request, and the next one starts 30 minutes later, until a person updates that folder.",
  };
  const short = { on: "Self-update on", off: "Self-update off", "development folder": "Self-update off (development folder)" };
  // One page's data, as the page command keeps it: it reads config.json again at each read.
  const data = new PageData({ machine: m.name, env: m.env });
  for (const [config, state] of [
    [{ autoUpdate: true, pluginDir: null }, "on"],
    [{ autoUpdate: false, pluginDir: null }, "off"],
    // A config.json from before self-update: on, as by default.
    [{ pluginDir: null }, "on"],
    [{ autoUpdate: true, pluginDir: "/srv/dev/plugin" }, "development folder"],
  ]) {
    writeFileSync(join(m.dir, "config.json"), `${JSON.stringify({ machine: m.name, ...config })}\n`);
    assert.equal(JSON.parse(data.json()).service.selfUpdate, state, JSON.stringify(config));
    const page = await scriptPage(t, m, "#log");
    const notes = descendants(page.parts.content).filter((node) => node.tagName === "P" && node.textContent.startsWith("Self-update"));
    assert.deepEqual(notes.map((node) => node.textContent), [words[state]], JSON.stringify(config));
    const fact = find(page.parts.status, (node) => node.tagName === "LI" && node.textContent.startsWith("Self-update"));
    assert.deepEqual([fact.textContent, fact.title], [short[state], words[state]]);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The person's place and focus through the reads every 5 seconds, and what the page says of requests that no session
// serves
// ---------------------------------------------------------------------------------------------------------------------

// The time zone's short name of a time, as the page shows it.
const zoneOf = (iso) => new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date(iso)).find((part) => part.type === "timeZoneName").value;

test("the focus stays on a fold's summary, the chat link and the service log's box when a read with new data builds the page again", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  const log = new Log().init("s-1").wait(task("CA-AAAAA1", { request: "Which roles can approve a request?" }));
  log.read("/repo/roles.ts");
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  writeFileSync(join(m.dir, "service.log"), "2026-11-25T09:00:00Z the serving session starts\n");
  const page = await scriptPage(t, m, "#requests&open=CA-AAAAA1");
  const summary = () => find(rowOf(page, "CA-AAAAA1"), (node) => node.tagName === "SUMMARY");
  const chat = () => find(rowOf(page, "CA-AAAAA1"), (node) => node.tagName === "A");
  assert.equal(chat().href, CHAT_URL);
  for (const [i, part] of [summary, chat].entries()) {
    const before = part();
    before.focus();
    log.read(`/repo/more-${i}.ts`);
    writeFileSync(join(m.dir, "session.jsonl"), log.text());
    await page.load();
    // assert.ok, not assert.equal: a diff of two elements prints the whole page.
    assert.ok(part() !== before, "the read did not build the line again");
    assert.ok(page.document.activeElement === part(), `the focus left ${before.tagName}`);
  }

  buttonOf(page.parts.content, "Service log1").click();
  await page.idle();
  const box = () => find(page.parts.content, (node) => node.tagName === "PRE");
  const before = box();
  before.focus();
  appendFileSync(join(m.dir, "service.log"), "2026-11-25T09:30:00Z the serving session ended with code 0\n");
  await page.load();
  assert.ok(box() !== before, "the read did not build the log's box again");
  assert.ok(page.document.activeElement === box(), "the focus left the log's box");
});

test("an open request stays open on the page that holds it when a new request moves it to the next page, and so does an open session when a new session starts", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  const log = new Log().init("s-1");
  const ids = Array.from({ length: 20 }, (_, i) => `CA-R${String(i + 1).padStart(5, "0")}`);
  for (const id of ids) log.wait(task(id)).update({ request_id: id, result: { outcome: "done", summary: "Answered." } }, task(id, { status: "done" }));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  // The last line of page 2, open.
  const page = await scriptPage(t, m, "#requests&page=2&open=CA-R00001");
  assert.equal(rowIds(page).at(-1), "CA-R00001");
  assert.equal(headOf(rowOf(page, "CA-R00001")).getAttribute("aria-expanded"), "true");

  log.wait(task("CA-NEW001"));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  await page.load();
  await page.idle();
  assert.deepEqual(rowIds(page), ["CA-R00001"]);
  assert.equal(headOf(rowOf(page, "CA-R00001")).getAttribute("aria-expanded"), "true");
  assert.ok(rowOf(page, "CA-R00001").textContent.includes("Answered."));
  assert.equal(page.window.location.hash, "#requests&page=3&open=CA-R00001");

  // Ten sessions: the oldest is the last line of page 1. An eleventh session moves it to page 2.
  const other = machine(t);
  turnOn(t, other);
  const sessions = new Log();
  for (let i = 1; i <= 10; i += 1) sessions.at(`2026-11-25T${String(i).padStart(2, "0")}:00:01.000Z`).init(`s-${i}`).bash("Look at the folder", "ls");
  writeFileSync(join(other.dir, "session.jsonl"), sessions.text());
  const list = await scriptPage(t, other, "#sessions&open=s-1");
  const sessionKeys = () => descendants(list.parts.content).filter((node) => node.dataset.key?.startsWith("session:")).map((node) => node.dataset.key);
  assert.equal(sessionKeys().at(-1), "session:s-1");
  assert.equal(headOf(byKey(list, "session:s-1")).getAttribute("aria-expanded"), "true");
  sessions.at("2026-11-25T11:00:01.000Z").init("s-11").bash("Look at the folder", "ls");
  writeFileSync(join(other.dir, "session.jsonl"), sessions.text());
  await list.load();
  await list.idle();
  assert.deepEqual(sessionKeys(), ["session:s-1"]);
  assert.equal(headOf(byKey(list, "session:s-1")).getAttribute("aria-expanded"), "true");
  assert.equal(list.window.location.hash, "#sessions&page=2&open=s-1");
});

test("an open request that ends while the Open chip is on stays in the list, open, with a note that it no longer matches", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  const log = new Log().init("s-1").wait(task("CA-BBBBB2")).update({ request_id: "CA-BBBBB2", result: { outcome: "done", summary: "Answered." } }, task("CA-BBBBB2", { status: "done" }));
  log.wait(task("CA-AAAAA1")).update({ request_id: "CA-AAAAA1", progress: "Reading the roles" }, task("CA-AAAAA1"));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const page = await scriptPage(t, m, "#requests&filter=open&open=CA-AAAAA1");
  assert.deepEqual(rowIds(page), ["CA-AAAAA1"]);
  const note = "It no longer matches the chosen status or the search. It stays in the list while it is open.";
  assert.ok(!rowOf(page, "CA-AAAAA1").textContent.includes(note));

  log.update({ request_id: "CA-AAAAA1", result: { outcome: "done", summary: "The managers approve." } }, task("CA-AAAAA1", { status: "done" }));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  await page.load();
  await page.idle();
  // Only the open line stays: the other request that is done is not in the Open list.
  assert.deepEqual(rowIds(page), ["CA-AAAAA1"]);
  assert.equal(headOf(rowOf(page, "CA-AAAAA1")).getAttribute("aria-expanded"), "true");
  assert.ok(rowOf(page, "CA-AAAAA1").textContent.includes("The managers approve."));
  assert.ok(rowOf(page, "CA-AAAAA1").textContent.includes(note));
  assert.equal(page.window.location.hash, "#requests&filter=open&open=CA-AAAAA1");
  // Closed, it leaves the list.
  headOf(rowOf(page, "CA-AAAAA1")).click();
  assert.deepEqual(rowIds(page), []);
  await page.idle();
});

test("a session whose waits for a request fail shows that it cannot reach Doable, with the newest failed waits, until a wait works", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  const log = new Log().init("s-1").wait(null);
  for (let i = 1; i <= 4; i += 1) {
    log.call(`${PLUGIN}wait_for_code_agent_request`, { wait_seconds: 290 }, `doable_server_error: 503 Service Unavailable (try ${i})`, { isError: true });
    log.bash("Wait before the next call", "sleep 20");
  }
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const page = await scriptPage(t, m);
  const { content, status } = page.parts;
  assert.equal(find(status, (node) => node.className?.includes("big")).textContent, "Cannot reach Doable");
  assert.deepEqual(headings(content, "H2"), ["Needs attention", "Now"]);
  const item = byKey(page, "attention:waits");
  assert.equal(find(item, (node) => node.tagName === "H3").textContent, "The session cannot reach Doable");
  assert.ok(item.textContent.includes("4 waits for a request have failed since the last one that worked."));
  assert.deepEqual(
    find(item, (node) => node.tagName === "UL").childNodes.map((line) => line.childNodes.at(-1).textContent),
    [2, 3, 4].map((i) => `doable_server_error: 503 Service Unavailable (try ${i})`),
  );

  // A wait that works: the session serves again, and nothing needs a person.
  log.wait(null);
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  await page.load();
  assert.equal(find(status, (node) => node.className?.includes("big")).textContent, "Serving");
  assert.deepEqual(headings(content, "H2"), ["Now"]);
});

// A session that asked a question and ended, and a later session that waits for requests. `at` is the question's time.
function endedWithQuestion() {
  const log = new Log().init("s-1").wait(task("CA-AAAAA1"));
  log.update({ request_id: "CA-AAAAA1", question: "Which role?", wait_seconds: 50 }, task("CA-AAAAA1", { status: "needs_answer", question: "Which role?" }));
  const at = Date.parse("2026-11-25T09:00:04.000Z");
  log.at("2026-11-25T09:30:01.000Z").init("s-2").wait(null);
  return { log, at };
}

test("a question that no session serves and that got no answer in 24 hours is probably expired: not open, not under Needs attention, with an end, also when no file changed", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  const { log, at } = endedWithQuestion();
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  let now = at + 23 * HOUR;
  const data = new PageData({ machine: m.name, env: m.env, now: () => now });
  let [row] = JSON.parse(data.json()).requests;
  assert.equal(new Date(Date.parse(row.questionAt)).getTime(), at);
  assert.deepEqual([row.status, row.finishedAt, row.question], ["waiting for an answer; no session serves it", null, "Which role?"]);

  // One hour after the 24 hours: the same files give the new status.
  now = at + 25 * HOUR;
  [row] = JSON.parse(data.json()).requests;
  assert.deepEqual([row.status, row.finishedAt, row.question], ["probably expired: no answer in 24 hours", new Date(at + 24 * HOUR).toISOString(), null]);
  assert.equal(
    JSON.parse(data.requestJson("CA-AAAAA1")).note,
    "No session served it after its question, and the logs on this computer show no answer in 24 hours. By Doable's rules, the request has expired, or the answer came and another machine took it. The asker sees in Doable how it stands.",
  );

  const page = await scriptPage(t, m, "", { now: () => at + 25 * HOUR });
  assert.deepEqual(headings(page.parts.content, "H2"), ["Now"]);
  const chips = find(page.parts.content, (node) => node.className === "chips").childNodes.map((chip) => chip.textContent);
  assert.deepEqual(chips, ["All1", "Other1"]);
  assert.equal(find(headOf(rowOf(page, "CA-AAAAA1")), (node) => node.className === "c-took").textContent, "");
  // Contrast: before the 24 hours, the question is under "Needs attention" and the request is open.
  const before = await scriptPage(t, m, "", { now: () => at + 23 * HOUR });
  assert.deepEqual(headings(before.parts.content, "H2"), ["Needs attention", "Now"]);
  assert.deepEqual(find(before.parts.content, (node) => node.className === "chips").childNodes.map((chip) => chip.textContent), ["All1", "Open1"]);
});

test("the details of a request that waits for its answer say since when it waits, and count on only while a session holds it", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  const { log, at } = endedWithQuestion();
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const page = await scriptPage(t, m, "#requests&open=CA-AAAAA1");
  const row = rowOf(page, "CA-AAAAA1");
  const asked = new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" });
  assert.equal(factOf(row, "Question asked"), asked);
  assert.equal(find(row, (node) => node.tagName === "DT" && node.textContent === "Working"), undefined);
  assert.equal(find(headOf(row), (node) => node.className === "c-took").textContent, "");
  // The times of its lines carry their time zone.
  const times = descendants(row).filter((node) => node.className === "time").map((node) => node.textContent);
  assert.ok(times.length > 0 && times.every((text) => text.endsWith(zoneOf(at))), times.join(" | "));

  // Contrast: while the running session holds the request, the time counts on.
  const held = machine(t);
  turnOn(t, held);
  const asking = new Log().init("s-1").wait(task("CA-AAAAA1"));
  asking.update({ request_id: "CA-AAAAA1", question: "Which role?", wait_seconds: 50 }, task("CA-AAAAA1", { status: "needs_answer", question: "Which role?" }));
  writeFileSync(join(held.dir, "session.jsonl"), asking.text());
  const live = await scriptPage(t, held, "#requests&open=CA-AAAAA1");
  assert.match(factOf(rowOf(live, "CA-AAAAA1"), "Waiting for the answer"), /^for \d+ (s|min|h|d)/);
  assert.match(find(headOf(rowOf(live, "CA-AAAAA1")), (node) => node.className === "c-took").textContent, /^\d+ (s|min|h|d)/);
});

test("Now names the request that ended last, and shows the question and its answer above the newest lines", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  // CA-AAAAA1 asks; CA-BBBBB2, taken later, ends first; CA-AAAAA1 ends after its answer.
  const asking = task("CA-AAAAA1");
  const log = new Log().init("s-1").wait(asking);
  log.update({ request_id: "CA-AAAAA1", question: "Which role?", wait_seconds: 50 }, { ...asking, status: "needs_answer", question: "Which role?" });
  log.wait(task("CA-BBBBB2")).update({ request_id: "CA-BBBBB2", result: { outcome: "done", summary: "B answered." } }, task("CA-BBBBB2", { status: "done" }));
  log.update({ request_id: "CA-AAAAA1", wait_seconds: 0 }, { ...asking, question: "Which role?", answer: "The manager." });
  log.update({ request_id: "CA-AAAAA1", result: { outcome: "done", summary: "A answered." } }, { ...asking, question: "Which role?", answer: "The manager.", status: "done" });
  log.wait(null);
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const page = await scriptPage(t, m);
  const idle = find(page.parts.content, (node) => node.className === "idle").textContent;
  assert.match(idle, /The last one, CA-AAAAA1, ended /);

  // A request in progress with a question, its answer and four more lines.
  const other = machine(t);
  turnOn(t, other);
  const working = new Log().init("s-1").wait(asking);
  working.update({ request_id: "CA-AAAAA1", question: "Which role?", wait_seconds: 50 }, { ...asking, status: "needs_answer", question: "Which role?" });
  working.update({ request_id: "CA-AAAAA1", wait_seconds: 0 }, { ...asking, question: "Which role?", answer: "The manager." });
  for (let i = 1; i <= 4; i += 1) working.update({ request_id: "CA-AAAAA1", progress: `Step ${i}` }, { ...asking, question: "Which role?", answer: "The manager." });
  writeFileSync(join(other.dir, "session.jsonl"), working.text());
  const now = byKey(await scriptPage(t, other), "now:CA-AAAAA1");
  assert.deepEqual(headings(now, "H4").slice(0, 2), ["Question and answer", "Latest lines"]);
  const [qa, latest] = descendants(now).filter((node) => node.tagName === "OL");
  assert.deepEqual(qa.childNodes.map((line) => line.childNodes[1].textContent), ["Question to the askerWhich role?", "Answer from the askerThe manager."]);
  assert.deepEqual(latest.childNodes.map((line) => line.childNodes[1].textContent), ["ProgressStep 1", "ProgressStep 2", "ProgressStep 3", "ProgressStep 4"]);
  assert.ok(buttonOf(now, "Show all 5 lines"));
});

test("a session keeps its id in /session.json and in the address when the start script moves the log and the session's number changes", (t) => {
  const m = machine(t);
  turnOn(t, m);
  const older = new Log().init("s-1").bash("Look at the folder", "ls").at("2026-11-25T10:00:01.000Z").init("s-2").bash("Look at the folder", "ls");
  writeFileSync(join(m.dir, "session.1.jsonl"), older.text());
  writeFileSync(join(m.dir, "session.jsonl"), new Log(PLUGIN, "2026-11-25T11:00:01.000Z").init("s-3").bash("Look at the folder", "ls").text());
  const data = new PageData({ machine: m.name, env: m.env, now: CLOCK });
  assert.deepEqual([JSON.parse(data.sessionJson("s-3")).n, JSON.parse(data.sessionJson("s-3")).id], [3, "s-3"]);

  // The move: session.jsonl replaces session.1.jsonl, and a new session writes a new session.jsonl.
  renameSync(join(m.dir, "session.jsonl"), join(m.dir, "session.1.jsonl"));
  writeFileSync(join(m.dir, "session.jsonl"), new Log(PLUGIN, "2026-11-25T12:00:01.000Z").init("s-4").bash("Look at the folder", "ls").text());
  assert.deepEqual([JSON.parse(data.sessionJson("s-3")).n, JSON.parse(data.sessionJson("s-3")).id], [1, "s-3"]);
  assert.throws(() => data.sessionJson("s-1"), { status: 404, message: "No session s-1 is in the logs on this computer." });

  // A session whose start is not in the logs, and two sessions with one id, are named by their place.
  const odd = machine(t);
  const log = new Log().bash("Look at the folder", "ls").at("2026-11-25T10:00:01.000Z").init("same").at("2026-11-25T11:00:01.000Z").init("same").at("2026-11-25T12:00:01.000Z").init("s-4");
  writeFileSync(join(odd.dir, "session.jsonl"), log.text());
  const refs = JSON.parse(new PageData({ machine: odd.name, env: odd.env, now: CLOCK }).sessionsJson(1, 10)).sessions.map((session) => session.ref);
  assert.deepEqual(refs, ["s-4", "position-3", "position-2", "position-1"]);
});

test("a page number past the last page of the sessions or of service.log adds no copy of the last page to the page's memory", (t) => {
  const m = machine(t);
  const log = new Log();
  for (let i = 1; i <= 12; i += 1) log.at(`2026-11-25T${String(i).padStart(2, "0")}:00:01.000Z`).init(`s-${i}`);
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  writeFileSync(join(m.dir, "service.log"), `${Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
  const data = new PageData({ machine: m.name, env: m.env, now: CLOCK });
  const kept = () => data.cached.texts.size;
  data.logJson(3);
  data.sessionsJson(2, 10);
  const size = kept();
  for (const page of [4, 1000, 1001, 999999999]) {
    assert.equal(JSON.parse(data.logJson(page)).page, 3);
    assert.equal(JSON.parse(data.sessionsJson(page, 10)).page, 2);
  }
  assert.equal(kept(), size);
  // Contrast: pages that exist are kept, one copy each.
  data.logJson(2);
  data.sessionsJson(1, 10);
  assert.equal(kept(), size + 2);
});

test("the search finds words anywhere in a request's text through the server, keeps its words out of the address, and a reload in the same tab keeps them", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  const long = `Platform shows the wrong week. ${"The calendar's query reads the week. ".repeat(10)}Also say whether the payroll export reads the same query, password=Hunter-77x.`;
  const log = new Log().init("s-1");
  for (const [id, request] of [["CA-AAAAA1", long], ["CA-BBBBB2", "Which roles approve?"]]) {
    log.wait(task(id, { request })).update({ request_id: id, result: { outcome: "done", summary: "Answered." } }, task(id, { request, status: "done" }));
  }
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  // The server searches the whole text, masked: a secret that the page hides cannot be found.
  const data = new PageData({ machine: m.name, env: m.env, now: CLOCK });
  assert.ok(long.indexOf("payroll") > 300);
  assert.deepEqual(JSON.parse(data.searchJson("PAYROLL export")).ids, ["CA-AAAAA1"]);
  assert.deepEqual(JSON.parse(data.searchJson("Hunter-77x")).ids, []);

  const storage = new FakeStorage();
  const page = await scriptPage(t, m, "", { storage });
  const box = find(page.parts.content, (node) => node.tagName === "INPUT");
  box.value = "payroll";
  box.dispatch("input");
  await page.idle();
  assert.deepEqual(rowIds(page), ["CA-AAAAA1"]);
  assert.equal(page.window.location.hash, "#requests");
  assert.ok(page.paths.includes("/search.json?q=payroll"));
  // The asker's cell shows its whole words on hover.
  assert.equal(find(headOf(rowOf(page, "CA-AAAAA1")), (node) => node.className === "c-asker").title, "Chat: Time off");

  // A reload in the same tab: the search comes back from the tab's storage.
  const reloaded = await scriptPage(t, m, page.window.location.hash, { storage });
  assert.equal(find(reloaded.parts.content, (node) => node.tagName === "INPUT").value, "payroll");
  assert.deepEqual(rowIds(reloaded), ["CA-AAAAA1"]);
  // Contrast: a browser that refuses the storage starts with no search.
  const refused = await scriptPage(t, m, page.window.location.hash);
  assert.deepEqual(rowIds(refused), ["CA-BBBBB2", "CA-AAAAA1"]);
});

test("a machine whose session has not written anything says so once in the header", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  const page = await scriptPage(t, m);
  assert.equal(page.parts.status.childNodes[0].textContent, "No log yetThe serving session has not written anything on this computer. When it runs, its steps show here.");
});
