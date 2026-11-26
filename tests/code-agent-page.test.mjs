import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  init(session, { server = "plugin:doable-code-context:doable", status = "connected" } = {}) {
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
      permissionMode: "bypassPermissions",
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

  call(name, input, answer, { isError = false } = {}) {
    this.calls += 1;
    const id = `toolu_${String(this.calls).padStart(4, "0")}`;
    this.assistant([{ type: "tool_use", id, name, input, caller: { type: "direct" } }], { wire_tool_inputs: { [id]: input } });
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

function pageData(m) {
  const text = new PageData({ machine: m.name, env: m.env }).json();
  return { text, data: JSON.parse(text) };
}

const byId = (data) => Object.fromEntries(data.requests.map((request) => [request.id, request]));

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
  // Working now.
  log.wait(task("CA-FFFFF6"));
  log.update({ request_id: "CA-FFFFF6", progress: "Reading the holidays" }, task("CA-FFFFF6"));
  log.read("/srv/repos/acme-timeoff/config/holidays.json");
  return log;
}

test("the page shows each request, newest first, with its asker, progress, question and answer, refused call, result and status", (t) => {
  const m = machine(t);
  turnOn(t, m);
  writeFileSync(join(m.dir, "session.jsonl"), sixRequests().text());
  const { data } = pageData(m);

  assert.equal(data.service.state, "on");
  assert.deepEqual(
    data.requests.map((request) => [request.id, request.status]),
    [
      ["CA-FFFFF6", "working"],
      ["CA-EEEEE5", "waiting for an answer"],
      ["CA-DDDDD4", "cancelled"],
      ["CA-CCCCC3", "declined"],
      ["CA-BBBBB2", "failed"],
      ["CA-AAAAA1", "done"],
    ],
  );
  const requests = byId(data);

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
    data.current.steps.map((step) => [step.tool, step.target]),
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

  assert.equal(data.current.running, true);
  assert.equal(data.current.model, MODEL);
  assert.equal(data.current.permissionMode, "bypassPermissions");
  assert.equal(data.current.claudeCodeVersion, "2.1.326");
  assert.deepEqual(data.current.doableServers, [{ name: "plugin:doable-code-context:doable", status: "connected" }]);
  assert.deepEqual(data.earlier, []);
});

test("no password, key, token or named secret of the logs reaches the page's data, and the names stay", (t) => {
  const m = machine(t);
  writeFileSync(join(m.dir, "session.jsonl"), sixRequests().text());
  writeFileSync(
    join(m.dir, "service.log"),
    "2026-11-25T08:59:58Z the serving session starts\n" +
      `DOABLE_API_KEY=${KEY} password: ${LOG_PASSWORD} token=${LOG_TOKEN}\n` +
      `the key ${KEY} came back\n` +
      `connecting to postgres://qa:${URL_PASSWORD}@db.staging.acme.example/timeoff with Authorization: Basic ${BASIC_CREDENTIAL}\n`,
  );
  const { text, data } = pageData(m);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `the page's data holds ${secret}`);
  // No login keeps a password field, also with no value.
  assert.ok(!/"password"\s*:\s*"[^*"]/.test(text.replaceAll('\\"', '"')), text);
  for (const request of data.requests) {
    for (const login of request.result?.logins ?? []) assert.deepEqual(Object.keys(login), ["username", "note"]);
  }

  // The Bash step: the login's password where the logs name it, a key, a Bearer token, and a value after a secret's name.
  const bash = byId(data)["CA-AAAAA1"].steps.find((step) => step.tool === "Bash");
  assert.equal(
    bash.detail,
    `curl -s -X POST https://timeoff.staging.acme.example/api/users -H '${MASKED_BEARER_HEADER}' ` +
      `-d '{"username":"qa-new@acme.example","password":"****"}' && DOABLE_API_KEY=**** DB_SECRET=**** ./seed --password=**** SIGNING_KEY=****`,
  );
  assert.deepEqual(data.service.logLines, [
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

  let { data } = pageData(m);
  assert.deepEqual(
    data.requests.map((request) => [request.id, request.status]),
    [
      ["CA-HHHHH8", "working"],
      ["CA-GGGGG7", "left when its session ended"],
    ],
  );
  assert.equal(data.current.startedAt, "2026-11-25T09:08:00.000Z");
  assert.equal(data.current.running, true);
  assert.equal(data.earlier.length, 1);
  const [earlier] = data.earlier;
  assert.equal(earlier.startedAt, "2026-11-25T09:00:00.000Z");
  assert.equal(earlier.endedAt, "2026-11-25T09:03:00.000Z");
  assert.equal(earlier.ending, "The start script saw it end with code 1.");
  assert.equal(earlier.requests, 1);
  assert.equal(earlier.running, false);

  // A stop ends the current session too: its request is left, and the session shows its end.
  writeFileSync(join(m.dir, "stopped"), "now\n");
  ({ data } = pageData(m));
  assert.equal(data.service.state, "stopped");
  assert.equal(byId(data)["CA-HHHHH8"].status, "left when its session ended");
  assert.equal(data.current.running, false);
  assert.equal(data.current.ending, "Its log has no end: it was stopped, or Claude Code or the computer stopped it.");

  // Contrast: the next session takes the left request again (Doable gave it back to the queue), and works on it.
  rmSync(join(m.dir, "stopped"));
  log.at("2026-11-25T09:30:01.000Z").init("s-3").wait(task("CA-GGGGG7", { answer: null }));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  ({ data } = pageData(m));
  const again = byId(data)["CA-GGGGG7"];
  assert.equal(again.status, "working");
  assert.deepEqual(again.events.map((event) => event.kind), ["taken", "progress", "taken again"]);
  assert.equal(byId(data)["CA-HHHHH8"].status, "left when its session ended");
  assert.equal(data.earlier.length, 2);
});

test("a session that wrote its result event has ended: its words say how", (t) => {
  const m = machine(t);
  turnOn(t, m);
  const log = new Log().init("s-1").wait(task("CA-JJJJJ9")).quiet("rejected");
  log.end("success", "Claude AI usage limit reached|1795881600", true);
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const { data } = pageData(m);
  assert.equal(data.current.running, false);
  assert.equal(data.current.ending, "It stopped with an error. Its last message: Claude AI usage limit reached|1795881600");
  assert.deepEqual(data.current.planLimit, { status: "rejected", resetsAt: "2026-11-28T16:00:00.000Z" });
  assert.equal(data.requests[0].status, "left when its session ended");
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
  let data = JSON.parse(page.json());
  assert.deepEqual(
    data.requests.map((request) => [request.id, request.status]),
    [
      ["CA-MMMMM2", "working"],
      ["CA-KKKKK1", "done"],
    ],
  );
  assert.equal(data.current.id, "s-2");
  assert.deepEqual(data.earlier.map((session) => session.id), ["s-1"]);
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
  assert.deepEqual(data.earlier.map((session) => session.id), ["s-2"]);
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
    const { data } = pageData(m);
    const [request] = data.requests;
    seen.push([request.id, request.status, request.events.map((event) => [event.kind, event.what]), request.steps.map((step) => [step.tool, step.target, step.failed])]);
    assert.equal(data.current.doableServers[0].status, "failed");
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
  const { data } = pageData(m);
  assert.equal(data.service.state, "not running");
  assert.equal(data.logFound, false);
  assert.equal(data.current, null);
  assert.deepEqual(data.requests, []);
  assert.deepEqual(data.service.logLines, []);
  // A view with no log is the same from pageView itself.
  assert.deepEqual(
    pageView({ sessions: [], requests: new Map(), passwords: new Set(), otherOutput: [] }, { machine: "m", serviceState: "on", serviceLog: { lines: [], entries: [] }, currentLogTime: null, logFound: false }).requests,
    [],
  );
});

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

async function servedPage(t) {
  const m = machine(t);
  writeFileSync(join(m.dir, "session.jsonl"), sixRequests().text());
  const server = await startPageServer({ machine: m.name, env: m.env, port: 0 });
  t.after(() => server.close());
  return { m, server, port: server.address().port };
}

test("the server listens on 127.0.0.1 only, and answers only a Host of 127.0.0.1 or localhost with its port", async (t) => {
  const { server, port } = await servedPage(t);
  assert.equal(server.address().address, "127.0.0.1");
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
    const answer = await get(port, "/data.json", { host });
    assert.equal(answer.status, 200, host);
    assert.equal(answer.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(JSON.parse(answer.body).requests.length, 6);
  }
  // A web site's name that resolves to this computer (DNS rebinding), another port, and no port.
  for (const host of [`attacker.example:${port}`, `127.0.0.1:${port + 1}`, "127.0.0.1", `127.0.0.1.attacker.example:${port}`]) {
    for (const path of ["/", "/data.json"]) {
      const answer = await get(port, path, { host });
      assert.equal(answer.status, 403, `${host} ${path}`);
      assert.equal(answer.body, `This page answers only at http://127.0.0.1:${port}/ on this computer.\n`);
    }
  }
  // With no Host, Node's server refuses the request itself.
  const noHost = await get(port, "/data.json", { host: null });
  assert.equal(noHost.status, 400);
  assert.ok(!noHost.body.includes("CA-"), noHost.body);
});

test("the server takes only GET of / and /data.json", async (t) => {
  const { port } = await servedPage(t);
  for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
    const answer = await get(port, "/data.json", { method });
    assert.equal(answer.status, 405, method);
    assert.equal(answer.headers.allow, "GET");
  }
  for (const path of ["/data.json?x=1", "/favicon.ico", "/session.jsonl", "/../service.log", "/data.json/"]) {
    const answer = await get(port, path);
    assert.equal(answer.status, 404, path);
    assert.equal(answer.body, "Not found. This page has only / and /data.json.\n");
  }
});

test("each answer has a Content-Security-Policy with its own nonce for the one inline script and style, and the page writes no data as HTML", async (t) => {
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
    // One script and one style, each with this answer's nonce, and nothing from another place.
    assert.deepEqual([...answer.body.matchAll(/<script[^>]*>/g)].map((tag) => tag[0]), [`<script nonce="${nonce}">`]);
    assert.deepEqual([...answer.body.matchAll(/<style[^>]*>/g)].map((tag) => tag[0]), [`<style nonce="${nonce}">`]);
    assert.ok(!/<link|\bsrc=|@import|url\(/i.test(answer.body), "the page loads nothing from another place");
    for (const htmlSink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) assert.ok(!answer.body.includes(htmlSink), htmlSink);
    for (const secret of SECRETS) assert.ok(!answer.body.includes(secret));
    nonces.push(nonce);
  }
  assert.notEqual(nonces[0], nonces[1]);
  // The data's answer and a refusal carry the same headers.
  for (const answer of [await get(port, "/data.json"), await get(port, "/", { host: "attacker.example" }), await get(port, "/x")]) {
    assert.match(answer.headers["content-security-policy"], /^default-src 'none'; /);
    assert.equal(answer.headers["x-content-type-options"], "nosniff");
    assert.equal(answer.headers["cache-control"], "no-store");
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
  const { text, data } = pageData(m);
  assert.deepEqual(
    data.requests[0].result.records.map((record) => [record.name, record.value]),
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
  let text = page.json();
  assert.ok(!text.includes(covered), "the password after --password shows while the request works");
  assert.match(JSON.parse(text).requests[0].steps[0].detail, /--password \*\*\*\* --role manager$/);
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
  text = page.json();
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

  const statuses = (data) => data.requests.map((request) => [request.id, request.status]);
  let { data } = pageData(m);
  assert.deepEqual(statuses(data), [
    ["CA-EEEEE4", "given back to the queue"],
    ["CA-DDDDD3", "timed out"],
    ["CA-BBBBB2", "cancelled"],
    ["CA-AAAAA1", "taken by another machine"],
    ["CA-CCCCC1", "working"],
  ]);
  const requests = byId(data);
  assert.deepEqual(requests["CA-CCCCC1"].steps.map((step) => step.target), ["/repo/roles.ts"]);
  assert.deepEqual(requests["CA-EEEEE4"].steps, []);
  for (const id of ["CA-AAAAA1", "CA-DDDDD3", "CA-EEEEE4"]) assert.equal(requests[id].events.at(-1).kind, "refused");

  // When the service stops, a request that was no longer the session's keeps its status: the session did not leave it.
  writeFileSync(join(m.dir, "stopped"), "now\n");
  ({ data } = pageData(m));
  assert.deepEqual(statuses(data), [
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
  const requests = byId(pageData(m).data);
  assert.equal(requests["CA-FFFFF1"].status, "waiting for an answer");
  assert.equal(requests["CA-GGGGG2"].status, "working");
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
  const { data } = pageData(m);
  assert.deepEqual(byId(data)["CA-AAAAA1"].steps.map((step) => step.text ?? step.target), ["CA-AAAAA1: done, answered."]);
  assert.deepEqual(data.current.steps.map((step) => step.text ?? step.target), [
    "Wait before the next call",
    "Wait before the next call",
    "Wait before the next call",
    "Doable has answered with server errors for more than 10 minutes.",
  ]);
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
  const requests = byId(pageData(m).data);
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
  const { data } = pageData(m);
  assert.deepEqual(byId(data)["CA-AAAAA1"].steps.map((step) => step.target), ["/repo/roles.ts"]);
  assert.deepEqual(data.current.steps.map((step) => step.target), ["Look at the folder"]);
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
  const { text, data } = pageData(m);
  const [request] = data.requests;
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
  const requests = byId(pageData(m).data);
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
  const requests = byId(pageData(m).data);
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
  const events = pageData(m).data.requests[0].events;
  assert.equal(events.find((event) => event.kind === "answer").text, answer);
  const shown = events.find((event) => event.kind === "progress").text;
  assert.equal(shown, `${"p".repeat(4000)}…`);
});

test("output of the session that is no event shows under the service's log, masked, with the time of the event before it", (t) => {
  const m = machine(t);
  turnOn(t, m);
  const log = new Log().init("s-1").wait(task("CA-AAAAA1"));
  log.end("success", "Stopped.", false);
  const lastAt = new Date(log.clock).toISOString();
  const errors = "error: unknown option '--chrome'\n".repeat(3);
  writeFileSync(join(m.dir, "session.jsonl"), `${log.text()}${errors}DB_PASSWORD=Hunter-9x is not set\n`);
  const { data } = pageData(m);
  assert.equal(data.current.id, "s-1");
  assert.deepEqual(data.service.otherOutput, [
    { after: lastAt, text: "error: unknown option '--chrome'" },
    { after: lastAt, text: "error: unknown option '--chrome'" },
    { after: lastAt, text: "error: unknown option '--chrome'" },
    { after: lastAt, text: "DB_PASSWORD=**** is not set" },
  ]);

  // A log with no event at all: the page has found a log, but no session in it.
  writeFileSync(join(m.dir, "session.jsonl"), "Invalid API key · Please run /login\n/bin/bash: /opt/claude: No such file or directory\n");
  const empty = pageData(m).data;
  assert.equal(empty.logFound, true);
  assert.equal(empty.current, null);
  assert.deepEqual(empty.service.otherOutput.map((line) => [line.after, line.text]), [
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
    const { data } = pageData(m);
    assert.equal(data.current.id, "s-2");
    assert.deepEqual(data.earlier.map((session) => session.id), ["s-1"]);
    assert.deepEqual(data.requests.map((request) => [request.id, request.status]), [
      ["CA-BBBBB2", "working"],
      ["CA-AAAAA1", "left when its session ended"],
    ]);
    assert.deepEqual(data.service.otherOutput.map((line) => line.text), other);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The page's script, in a small DOM: elements with their children, text, classes, data keys and folds, and a layout in
// which each card (an element with a data key) is 100 px high, one under the other.
// ---------------------------------------------------------------------------------------------------------------------

class FakeElement {
  constructor(tagName, page) {
    this.tagName = tagName.toUpperCase();
    this.page = page;
    this.childNodes = [];
    this.parentNode = null;
    this.className = "";
    this.ownText = "";
    this.dataset = {};
    this.hidden = false;
    this.open = false;
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
    return this.childNodes.length ? this.childNodes.map((child) => child.textContent).join("") : this.ownText;
  }

  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.ownText = String(value);
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

  addEventListener() {}

  getBoundingClientRect() {
    const top = this.page.cards().indexOf(this) * 100 - this.page.window.scrollY;
    return { top, bottom: top + 100 };
  }
}

function descendants(node) {
  return node.childNodes.flatMap((child) => [child, ...descendants(child)]);
}

// The page's script, run on `answer()` as /data.json's answer: { status, body }, or "unreachable" for a failed fetch.
async function scriptPage(answer) {
  const page = { answer };
  const element = (tag) => new FakeElement(tag, page);
  const body = element("body");
  const parts = { title: element("h1"), updated: element("p"), problem: element("p"), content: element("div") };
  parts.problem.hidden = true;
  body.append(...Object.values(parts));
  page.window = { scrollY: 0, selection: null, getSelection: () => page.window.selection, scrollBy: (x, y) => (page.window.scrollY += y) };
  page.cards = () => descendants(body).filter((node) => node.dataset.key !== undefined);
  page.parts = parts;
  const document = { title: "", createElement: element, getElementById: (id) => parts[id] };
  const fetch = async () => {
    if (page.answer === "unreachable") throw new TypeError("Failed to fetch");
    return { ok: page.answer.status === 200, status: page.answer.status, text: async () => page.answer.body };
  };
  const script = /<script nonce="nonce">([\s\S]*)<\/script>/.exec(pageHtml("nonce"))[1];
  const context = { document, window: page.window, fetch, setInterval: () => 0, console };
  runInNewContext(script, context);
  page.load = async () => {
    await context.load();
  };
  // The first read, which the script starts itself.
  await new Promise((done) => setImmediate(done));
  return page;
}

const ok = (text) => ({ status: 200, body: text });
const find = (node, test) => descendants(node).find(test);
const cardOf = (page, id) => find(page.parts.content, (node) => node.tagName === "ARTICLE" && node.childNodes[0].childNodes[0].textContent === id);
const factOf = (node, name) => {
  const term = find(node, (item) => item.tagName === "DT" && item.textContent === name);
  return term.parentNode.childNodes[term.parentNode.childNodes.indexOf(term) + 1].textContent;
};

test("the page shows the requests before the earlier sessions, and folds the earlier sessions into one line each", async (t) => {
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
  const page = await scriptPage(ok(pageData(m).text));
  const sections = page.parts.content.childNodes;
  assert.deepEqual(sections.map((section) => section.childNodes[0].textContent), ["The serving session", "Requests", "Earlier sessions"]);
  const [fold] = sections[2].childNodes.slice(1);
  assert.equal(fold.tagName, "DETAILS");
  assert.equal(fold.open, false);
  assert.equal(fold.childNodes[0].textContent, "4 earlier sessions, newest first");
  const lines = fold.childNodes[1].childNodes.map((item) => item.childNodes[0].textContent.split(": ").at(-1));
  assert.deepEqual(lines, ["0 requests, stopped at the plan limit", "0 requests, stopped at the plan limit", "0 requests, stopped at the plan limit", "1 request, ended its turn"]);
});

test("a new request above the card that the person reads keeps that card in its place, and a selection holds the new data", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  const log = new Log().init("s-1").wait(task("CA-AAAAA1")).wait(task("CA-BBBBB2"));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const page = await scriptPage(ok(pageData(m).text));
  // The person scrolls until the card of CA-AAAAA1 is at the top of the window.
  page.window.scrollY = cardOf(page, "CA-AAAAA1").getBoundingClientRect().top;
  assert.equal(cardOf(page, "CA-AAAAA1").getBoundingClientRect().top, 0);

  log.wait(task("CA-CCCCC3"));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  page.answer = ok(pageData(m).text);
  await page.load();
  assert.ok(cardOf(page, "CA-CCCCC3"));
  assert.equal(cardOf(page, "CA-AAAAA1").getBoundingClientRect().top, 0);

  // The person selects text in a card: the new data waits until the selection ends.
  const selected = cardOf(page, "CA-AAAAA1");
  page.window.selection = { isCollapsed: false, anchorNode: selected.childNodes[0] };
  log.wait(task("CA-DDDDD4"));
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  page.answer = ok(pageData(m).text);
  await page.load();
  // assert.ok, not assert.equal: a diff of two elements prints the whole page.
  assert.ok(cardOf(page, "CA-DDDDD4") === undefined, "the page shows the new request while text is selected");
  assert.ok(cardOf(page, "CA-AAAAA1") === selected, "the page built the selected card again");
  assert.equal(page.parts.updated.textContent, "New data waits while you select text on the page.");
  page.window.selection = { isCollapsed: true, anchorNode: null };
  await page.load();
  assert.ok(cardOf(page, "CA-DDDDD4"));
});

test("when the page cannot read its data, a note that stays in view says why, and the old data is marked as old", async (t) => {
  const m = machine(t);
  writeFileSync(join(m.dir, "session.jsonl"), sixRequests().text());
  const page = await scriptPage(ok(pageData(m).text));
  const { problem, content } = page.parts;
  assert.equal(problem.hidden, true);

  page.answer = "unreachable";
  await page.load();
  assert.equal(problem.hidden, false);
  assert.equal(problem.textContent, "The page cannot reach its server. Start the page command again on this computer. The data below is from the last read.");
  assert.ok(content.classList.contains("stale"));

  // The server answers with its reason, for example after `remove`: the page shows only that reason.
  page.answer = { status: 500, body: `No code agent "${m.name}" is set up on this machine.\n` };
  await page.load();
  assert.equal(problem.textContent, `No code agent "${m.name}" is set up on this machine.`);

  page.answer = ok(pageData(m).text);
  await page.load();
  assert.equal(problem.hidden, true);
  assert.ok(!content.classList.contains("stale"));
  // The note stays at the top of the window when the person scrolls.
  assert.match(pageHtml("nonce"), /\.problem \{ position: sticky; top: 0;/);
});

test("the page's words: one step, a request whose asking time is not known, the plan limit, times with their time zone, a summary in the body's font, and a result that Doable did not keep", async (t) => {
  const m = machine(t);
  turnOn(t, m);
  const log = new Log().init("s-1").quiet("rejected");
  log.wait(task("CA-AAAAA1")).read("/repo/a.ts");
  log.update(
    { request_id: "CA-AAAAA1", result: { outcome: "done", summary: "**Answer:** the limit is 8.", logins: [{ username: "qa@acme.example", password: "Pw-1x", note: "manager" }] } },
    task("CA-AAAAA1", { status: "cancelled", cancel_requested: true }),
  );
  // A request that the logs know only from a refused call.
  log.refuse({ request_id: "CA-ZZZZZ9", progress: "Reading" }, "doable_error: CA-ZZZZZ9 waits for the answer to its question: read it with a long poll of the request.");
  writeFileSync(join(m.dir, "session.jsonl"), log.text());
  const page = await scriptPage(ok(pageData(m).text));
  const { content } = page.parts;

  const card = cardOf(page, "CA-AAAAA1");
  assert.ok(find(card, (node) => node.tagName === "SUMMARY" && node.textContent === "What the session did for it (1 step)"));
  assert.ok(find(cardOf(page, "CA-ZZZZZ9"), (node) => node.tagName === "P" && node.textContent === "Asked: not in the logs."));
  const resets = new Date(1795881600 * 1000);
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(resets).find((part) => part.type === "timeZoneName").value;
  const plan = factOf(content, "Plan limit");
  assert.match(plan, /^reached; it resets at /);
  assert.ok(plan.endsWith(zone), plan);

  const summary = find(card, (node) => node.textContent === "**Answer:** the limit is 8." && node.childNodes.length === 0);
  assert.equal(summary.tagName, "DIV");
  assert.equal(summary.className, "summary");
  assert.ok(find(card, (node) => node.tagName === "H4" && node.textContent === "Result sent after the cancel: Doable did not keep it"));
  assert.ok(find(card, (node) => node.tagName === "TD" && node.textContent === "qa@acme.example"));

  // A log that holds only other output: the page does not say that nothing was written.
  writeFileSync(join(m.dir, "session.jsonl"), "Invalid API key · Please run /login\n");
  page.answer = ok(pageData(m).text);
  await page.load();
  const text = content.textContent;
  assert.ok(text.includes("The session's log holds no event yet."), text);
  assert.ok(!text.includes("has not written anything"));
  assert.ok(text.includes("Invalid API key · Please run /login"));
});
