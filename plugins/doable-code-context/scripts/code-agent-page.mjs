// The page of an Always on code agent (`code-agent-service.mjs page --machine NAME [--port N]`): a web page on this
// computer that shows the serving session and each request that it served. It reads only the files of the machine's
// folder (session.1.jsonl, then session.jsonl, service.log, the stop file through serviceState, and config.json through
// selfUpdateState) and calls nothing on the network.
//
// The session's output holds the password of each login that it made (the result is a tool call), and can hold keys
// and tokens in its commands. So a login's password never leaves the parser (it keeps only the username and the note),
// and every text that the page shows goes through a mask (makeMasker): each password of a login in a result of the
// logs, each Doable API key, each Bearer or Basic credential, the password of a URL, and secrets in known forms (the
// value after a secret's name, --password VALUE, curl's -u user:VALUE, pw=) become ****. A secret in another form (a
// password as a script's positional argument, or in a sentence) still shows, and a new login's password shows until
// the result that names it is in the log: the README and the page say so.
//
// Safety: the server listens on 127.0.0.1 only. It answers only a Host of 127.0.0.1:<port> or localhost:<port>, so that a
// web site cannot read the page through DNS rebinding, and only GET of / and /data.json. Each answer allows no source
// but the page's own inline script and style (a nonce of that answer), and the script writes each value as text, never
// as HTML: request texts come from other people. Other computers cannot open the page, but any account or program of
// this computer can (a program that is not a browser sends any Host): the README and the page say so.
//
// It stays fast with two logs of 20 MB: it parses session.1.jsonl again only when that file changed, and of a growing
// session.jsonl it reads only the part that was added. When session.jsonl shrank or is another file (the start script
// moved it to session.1.jsonl), it starts over from the state after session.1.jsonl.

import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { ANY_DOABLE_KEY, selfUpdateState, serviceDir, serviceState } from "./code-agent-service.mjs";

export const DEFAULT_PORT = 47615;
const OLDER_LOG = "session.1.jsonl";
const CURRENT_LOG = "session.jsonl";
const SERVICE_LOG = "service.log";
const SERVICE_LOG_LINES = 12;
const MASK = "****";
// How many steps the page keeps for each request and for each session's start, and how many lines for each request:
// it keeps the newest and says how many earlier ones it left out.
const STEP_LIMIT = 500;
const EVENT_LIMIT = 500;
const FAILED_CALL_LIMIT = 20;
const OTHER_OUTPUT_LIMIT = 20;
// A text is kept to KEEP_CHARS when the parser reads it, then masked, then cut to what the page shows. The mask comes
// before the cut, so that a cut cannot leave the first part of a password that the mask would have found whole.
const KEEP_CHARS = 4000;
const COMMAND_CHARS = 300;
const TARGET_CHARS = 300;
const MESSAGE_CHARS = 500;
const REASON_CHARS = 1000;
const REQUEST_ID = /^CA-[0-9A-Z]{6}$/;
// The three Doable MCP tools of a machine, under any server name (mcp__doable__..., mcp__plugin_doable-code-context_doable__...).
const DOABLE_TOOL = /^mcp__.+__(wait_for_code_agent_request|update_code_agent_request|read_code_agent_mail)$/;
// A line that the start script writes to service.log before and after each session.
const SERVICE_LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) the serving session (?:(starts)|ended with code (\d+))$/;
const EXIT_WORDS = { 0: "no error", 130: "it was interrupted", 137: "it was killed", 143: "it was stopped" };

// ---------------------------------------------------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------------------------------------------------

const DOABLE_KEY = new RegExp(ANY_DOABLE_KEY.source, "g");
const URL_PASSWORD = /(\/\/[^\s/:@]+:)[^\s/@]+@/g;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const BASIC = /\b(Authorization:\s*Basic\s+)[A-Za-z0-9+/=]+/gi;
// A value after a name: in escaped double quotes (JSON in a shell string, \"...\"), in double or single quotes, or a word.
const VALUE = String.raw`(\\"[^"\\\n]*\\"|"[^"\n]*"|'[^'\n]*'|[^\s"'&,;)}\]>]+)`;
// A name that holds password, passwd, secret, token or api key, then ':' or '=' (password=, "client_secret": "...",
// \"password\":\"...\", --api-key=, token:). The look-behind starts a name only where a word starts, so that a long word
// with no such name costs one pass.
const NAMED_SECRET = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]*?(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_.-]*)(\\?["']?[ \t]*[:=][ \t]*)${VALUE}`,
  "gi",
);
// An environment variable whose name holds KEY, SECRET, TOKEN or PASSWORD (DOABLE_API_KEY=..., DB_PASSWORD=...).
const ENV_SECRET = /(?<![A-Za-z0-9_])([A-Z0-9_]*?(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*)=("[^"\n]*"|'[^'\n]*'|\S+)/g;
// An option whose next word is a password: --password VALUE, --passwd VALUE, --pass VALUE, --pwd VALUE.
const PASSWORD_OPTION = new RegExp(String.raw`(?<![A-Za-z0-9_.-])(--(?:password|passwd|pass|pwd)[ \t]+)${VALUE}`, "gi");
// The password of a user of curl or wget: -u user:VALUE, --user user:VALUE, --user=user:VALUE. The user starts with a
// letter, a digit or one of _.@- , so that `date -u +%H:%M` is not a user.
const USER_PASSWORD = /(?<![A-Za-z0-9_.-])((?:-u[ \t]*|--user[ \t=]+)["']?[A-Za-z0-9_.@-]+:)([^\s"']+)/g;
// A short name of a password with '=' (a URL's query, a command's option): pw=, pwd=, pass=. Only a whole name: no
// `compass=`. `-p VALUE` and `-pVALUE` are not masked: they also mean a port, a folder's parents or a thread option.
const SHORT_PASSWORD = new RegExp(String.raw`(?<![A-Za-z0-9_.-])(-{0,2}(?:pw|pwd|pass)=)${VALUE}`, "gi");
// The name of a result's record whose value is a secret. Not any name with "key": a Jira issue key is no secret.
const SECRET_NAME = /password|passwd|secret|token|api[ _-]?key/i;
// Values that are no secret: words that say that there is none, or what one must be.
const PLAIN_VALUES = new Set(["none", "null", "nil", "required", "optional", "true", "false", "empty", "unset", "undefined", "yes", "no"]);
// After a value: a space and a word, as in a sentence.
const NEXT_WORD = /[ \t]+[A-Za-z]/y;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isEscapedQuoted(value) {
  return value.length >= 4 && value.startsWith('\\"') && value.endsWith('\\"');
}

// A value without its quotes.
function bareValue(value) {
  if (isEscapedQuoted(value)) return value.slice(2, -2);
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.length >= 2 && value.at(-1) === quote ? value.slice(1, -1) : value;
}

// A value in quotes keeps its quotes.
function maskedValue(value) {
  if (isEscapedQuoted(value)) return `\\"${MASK}\\"`;
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.length >= 2 && value.at(-1) === quote ? `${quote}${MASK}${quote}` : MASK;
}

// Whether a value after a secret's name can be a secret: not only digits (SESSION_TOKEN_TTL=3600), not a word that says
// that there is none or what one must be (token: none, password: required), and, after ':', not the first word of a
// sentence (password: at least 8 characters). `text` and `end` say what comes after the value.
function looksSecret(value, { colon = false, text = "", end = 0 } = {}) {
  const bare = bareValue(value);
  if (bare === "" || bare === MASK || /^\d+$/.test(bare)) return false;
  if (PLAIN_VALUES.has(bare.toLowerCase().replace(/\.$/, ""))) return false;
  if (!colon || !/^[A-Za-z]+$/.test(bare)) return true;
  NEXT_WORD.lastIndex = end;
  return !NEXT_WORD.test(text);
}

// The value of a result's record as the page shows it: **** when its name names a secret.
function recordValue(name, value) {
  return name !== null && value !== null && SECRET_NAME.test(name) && looksSecret(value) ? MASK : value;
}

// The mask of every text that the page shows: each of `passwords` (the passwords of the logins in the results of the
// logs) wherever it is, then each Doable API key, the password of a URL, a Bearer or Basic credential, and secrets in
// known forms (after a secret's name, --password VALUE, -u user:VALUE, pw=). The names stay; the values become ****.
export function makeMasker(passwords) {
  const literal = [...passwords].filter((password) => password.length > 0).sort((a, b) => b.length - a.length);
  const known = literal.length > 0 ? new RegExp(literal.map(escapeRegExp).join("|"), "g") : null;
  return (text) => {
    let masked = known === null ? text : text.replace(known, MASK);
    masked = masked
      .replace(DOABLE_KEY, `sk-doable-${MASK}`)
      .replace(URL_PASSWORD, `$1${MASK}@`)
      .replace(BEARER, `$1${MASK}`)
      .replace(BASIC, `$1${MASK}`)
      .replace(NAMED_SECRET, (whole, name, separator, value, at, all) =>
        looksSecret(value, { colon: separator.includes(":"), text: all, end: at + whole.length }) ? `${name}${separator}${maskedValue(value)}` : whole,
      )
      .replace(ENV_SECRET, (whole, name, value) => (looksSecret(value) ? `${name}=${maskedValue(value)}` : whole))
      .replace(PASSWORD_OPTION, (whole, option, value) => (!value.startsWith("-") && looksSecret(value) ? `${option}${maskedValue(value)}` : whole))
      .replace(USER_PASSWORD, (whole, user, value) => (looksSecret(value) ? `${user}${MASK}` : whole))
      .replace(SHORT_PASSWORD, (whole, name, value) => (looksSecret(value) ? `${name}${maskedValue(value)}` : whole));
    return masked;
  };
}

export function maskSecrets(text, passwords = []) {
  return makeMasker(passwords)(text);
}

// `value` with each of its strings masked.
function maskAll(value, mask) {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return value.map((item) => maskAll(item, mask));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, maskAll(item, mask)]));
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------------
// The parser: the events of `claude -p --output-format stream-json --verbose`, one JSON object a line
// ---------------------------------------------------------------------------------------------------------------------

const textOf = (value) => (typeof value === "string" ? value : null);
// A text that is longer than KEEP_CHARS keeps a mark of its cut.
const keep = (value) => (typeof value !== "string" ? null : value.length > KEEP_CHARS ? `${value.slice(0, KEEP_CHARS)}…` : value);

function newState() {
  // Plain data (structuredClone copies it): the sessions in order, the requests by id in the order that the logs first
  // name them, the passwords of the logins (for the mask only), the calls that wait for their result, the request to
  // which the session's steps go now (null: no request, the session's own steps), the request that ended just before
  // the session went to another one (its closing line stays with it), and the last lines of the output that are no
  // event (the session's stderr: an error of Claude Code or of the shell).
  return { sessions: [], requests: new Map(), passwords: new Set(), calls: new Map(), current: null, lastEnded: null, otherOutput: [] };
}

function isDoableServer(name) {
  return typeof name === "string" && (name === "doable" || name.endsWith(":doable"));
}

// A session from its `system` `init` line, or with `init` null for output whose start is not in the logs.
function newSession(init) {
  const servers = Array.isArray(init?.mcp_servers) ? init.mcp_servers : [];
  return {
    id: textOf(init?.session_id),
    startKnown: init !== null,
    model: textOf(init?.model),
    permissionMode: textOf(init?.permissionMode),
    claudeCodeVersion: textOf(init?.claude_code_version),
    doableServers: servers
      .filter((server) => isDoableServer(server?.name))
      .map((server) => ({ name: server.name, status: textOf(server.status) })),
    firstAt: null,
    lastAt: null,
    result: null,
    planLimit: null,
    requestIds: [],
    failedCalls: [],
    steps: [],
    stepsLeftOut: 0,
  };
}

function newRequest(state, id) {
  return {
    id,
    text: null,
    askedBy: null,
    askedByUser: null,
    askedAt: null,
    organization: null,
    suite: null,
    environment: null,
    chatUrl: null,
    takenAt: null,
    status: null,
    cancelRequested: false,
    asked: false,
    answer: null,
    result: null,
    events: [],
    eventsLeftOut: 0,
    steps: [],
    stepsLeftOut: 0,
    sessionIndex: state.sessions.length - 1,
  };
}

function requestOf(state, id) {
  if (!state.requests.has(id)) state.requests.set(id, newRequest(state, id));
  return state.requests.get(id);
}

function isRequestId(id) {
  return typeof id === "string" && REQUEST_ID.test(id);
}

function isTask(task) {
  return task !== null && typeof task === "object" && isRequestId(task.id);
}

// Whether a request is still the session's work: no end, no cancel.
function isOpen(request) {
  return request !== undefined && !request.cancelRequested && (request.status === "working" || request.status === "needs_answer");
}

function pushLimited(list, item, limit, owner, leftOutField) {
  list.push(item);
  if (list.length > limit) {
    list.shift();
    if (owner) owner[leftOutField] += 1;
  }
}

function addStep(state, session, step) {
  let id = state.current;
  // The closing line of the request that ended ("CA-X: done, ...") stays with that request.
  if (step.kind === "text" && state.lastEnded !== null && step.text.startsWith(state.lastEnded)) id = state.lastEnded;
  const owner = id === null ? session : state.requests.get(id);
  pushLimited(owner.steps, step, STEP_LIMIT, owner, "stepsLeftOut");
}

function addEvent(request, event) {
  if (event.kind === "question") request.asked = true;
  pushLimited(request.events, event, EVENT_LIMIT, request, "eventsLeftOut");
}

// When the request that the session served is no longer open while the session holds exactly one other open request
// that has its answer, the steps that follow are that request's: the session serves the answered request now (the
// Skill: "serve that request now with its answer"), with no wait between.
function followAnsweredRequest(state, session) {
  const current = state.current === null ? undefined : state.requests.get(state.current);
  if (current === undefined || isOpen(current)) return;
  const answered = session.requestIds.filter((id) => id !== current.id && isOpen(state.requests.get(id)) && state.requests.get(id).answer !== null);
  if (answered.length !== 1) return;
  state.lastEnded = current.id;
  state.current = answered[0];
}

// The text of a tool's result: a string, or the text parts of a list.
function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    // A tool's text that is not JSON (an error, a message) holds no request.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

// What the page shows of one tool call: the file, the pattern, the description and the command, or the URL.
function stepTarget(name, input) {
  const tool = DOABLE_TOOL.exec(name)?.[1];
  if (tool === "read_code_agent_mail") return { target: keep(input.to) };
  switch (name) {
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
      return { target: keep(input.file_path) };
    case "NotebookEdit":
      return { target: keep(input.notebook_path) };
    case "Grep":
    case "Glob":
      return { target: keep(input.pattern), detail: typeof input.path === "string" ? keep(`in ${input.path}`) : null };
    case "Bash":
      return { target: keep(input.description), detail: keep(input.command) };
    case "WebSearch":
    case "ToolSearch":
      return { target: keep(input.query) };
    case "Skill":
      return { target: keep(input.skill) };
    case "Task":
    case "Agent":
      return { target: keep(input.description) };
    default:
      // A web fetch, and a browser navigation (Claude in Chrome's navigate) give a URL.
      return { target: keep(input.url) };
  }
}

// A result as the page keeps it. Each login loses its password here: the password goes only to the mask.
function keptResult(state, result) {
  if (result === null || typeof result !== "object") return null;
  const logins = Array.isArray(result.logins) ? result.logins : [];
  for (const login of logins) {
    if (typeof login?.password === "string" && login.password.length > 0) state.passwords.add(login.password);
  }
  const records = Array.isArray(result.records) ? result.records : [];
  return {
    outcome: textOf(result.outcome),
    summary: textOf(result.summary),
    records: records.map((record) => ({ name: textOf(record?.name), value: textOf(record?.value) })),
    logins: logins.map((login) => ({ username: textOf(login?.username), note: textOf(login?.note) })),
  };
}

function toolUse(state, session, part, at) {
  const name = textOf(part.name) ?? "";
  const input = part.input !== null && typeof part.input === "object" ? part.input : {};
  const tool = DOABLE_TOOL.exec(name)?.[1];
  // A wait and an update are not steps: the request's lines show them.
  if (tool === "wait_for_code_agent_request") {
    // The session waits for its next request: what it does until then is no request's (for example a wait of 20 seconds
    // after a server error of Doable). The closing line of the last request comes before the wait.
    state.calls.set(part.id, { kind: "wait", at });
    state.current = null;
    state.lastEnded = null;
    return;
  }
  if (tool === "update_code_agent_request") {
    const what = input.result != null ? "result" : input.question != null ? "question" : input.progress != null ? "progress" : "check";
    state.calls.set(part.id, {
      kind: "update",
      at,
      requestId: textOf(input.request_id),
      what,
      text: what === "progress" || what === "question" ? keep(input[what]) : null,
      result: what === "result" ? keptResult(state, input.result) : null,
    });
    return;
  }
  const step = { kind: "tool", at, tool: name, target: null, detail: null, ...stepTarget(name, input), failed: false };
  addStep(state, session, step);
  state.calls.set(part.id, { kind: tool === "read_code_agent_mail" ? "mail" : "step", at, requestId: textOf(input.request_id), step });
}

// How a request stands after Doable refused a call about it with one of its 409 texts (orchestration's
// agent_v2/code_agent.py, `_held` and `working`): taken by another machine, cancelled, ended, or back in the queue. Then
// it is no longer the session's. The MCP library can put words before the text. A refusal while the request's question
// waits for its answer, or of a field that Doable does not take (422), changes nothing: the request stays the session's.
function refusedState(request, text) {
  const ended = new RegExp(`${request.id} has ended \\(([a-z_]+)\\)`).exec(text);
  if (text.includes(`${request.id} was cancelled`)) request.cancelRequested = true;
  else if (ended) request.status = ended[1];
  else if (text.includes(`${request.id} is claimed by another machine`)) request.status = "taken_by_another_machine";
  else if (text.includes(`${request.id} is not claimed`)) request.status = "queued";
}

// A call about a request that Doable did not take (an error): a line of that request, else of the session.
function refusedCall(state, session, requestId, entry) {
  if (isRequestId(requestId)) {
    const request = requestOf(state, requestId);
    request.sessionIndex = state.sessions.length - 1;
    addEvent(request, { kind: "refused", ...entry });
    refusedState(request, entry.text ?? "");
    followAnsweredRequest(state, session);
  } else pushLimited(session.failedCalls, entry, FAILED_CALL_LIMIT);
}

// What Doable said about a request (a CodeAgentTask).
function applyTask(state, session, request, task, at) {
  request.text = textOf(task.request) ?? request.text;
  request.askedBy = textOf(task.asked_by) ?? request.askedBy;
  request.askedByUser = textOf(task.asked_by_user);
  request.askedAt = textOf(task.asked_at) ?? request.askedAt;
  request.organization = textOf(task.organization?.slug);
  request.suite = textOf(task.suite?.name);
  request.environment = textOf(task.environment?.name);
  request.chatUrl = textOf(task.chat?.url);
  // A question that is in no log of this computer (another machine or an earlier log asked it) shows before its answer.
  // Doable masks the question, so its text can differ from the session's call: any question line counts.
  const question = textOf(task.question);
  if (question !== null && !request.asked) addEvent(request, { kind: "question", at, text: keep(question) });
  // The answer is kept whole, as the request's text is: Doable takes up to 20000 characters.
  const answer = textOf(task.answer);
  if (answer !== null && answer !== request.answer) addEvent(request, { kind: "answer", at, text: answer });
  request.answer = answer;
  request.status = textOf(task.status) ?? request.status;
  request.cancelRequested ||= task.cancel_requested === true;
  request.sessionIndex = state.sessions.length - 1;
  if (!session.requestIds.includes(request.id)) session.requestIds.push(request.id);
}

function toolResult(state, session, part, at) {
  const call = state.calls.get(part.tool_use_id);
  if (call === undefined) return;
  state.calls.delete(part.tool_use_id);
  const failed = part.is_error === true;
  const words = resultText(part.content);
  if (call.kind === "step" || call.kind === "mail") {
    call.step.failed = failed;
    if (failed && call.kind === "mail") refusedCall(state, session, call.requestId, { at: call.at, what: "read of the test inbox", text: keep(words) });
    return;
  }
  if (call.kind === "wait") {
    if (failed) {
      pushLimited(session.failedCalls, { at: call.at, what: "wait for a request", text: keep(words) }, FAILED_CALL_LIMIT);
      return;
    }
    const task = parseJson(words)?.request;
    if (!isTask(task)) return;
    const request = requestOf(state, task.id);
    addEvent(request, { kind: request.takenAt === null ? "taken" : "taken again", at });
    request.takenAt ??= at;
    applyTask(state, session, request, task, at);
    state.current = request.id;
    return;
  }
  // An update: progress, a question, the result, or a check (a read).
  if (failed) {
    refusedCall(state, session, call.requestId, { at: call.at, what: call.what, text: keep(words) });
    return;
  }
  const task = parseJson(words);
  const id = isTask(task) ? task.id : call.requestId;
  if (!isRequestId(id)) return;
  const request = requestOf(state, id);
  const answerBefore = request.answer;
  const servesNone = () => state.current === null || !isOpen(state.requests.get(state.current));
  // The session works on the request of its progress, question or result. A check of another request (one that waits
  // for an answer) does not move the steps to it, and nor does progress on another request while this one is open.
  if (call.what !== "check" && servesNone()) state.current = id;
  if (call.what === "progress" || call.what === "question") addEvent(request, { kind: call.what, at: call.at, text: call.text });
  if (call.what === "result" && call.result !== null) {
    // A result that comes after a cancel gets the request as it stands (cancelled), and Doable keeps nothing of it.
    const kept = !isTask(task) || textOf(task.status) === call.result.outcome;
    request.result = { ...call.result, at: call.at, kept };
    addEvent(request, { kind: kept ? "result" : "result not kept", at: call.at, text: call.result.outcome });
  }
  if (isTask(task)) applyTask(state, session, request, task, at);
  // A check that brings the answer while the session serves no open request: the session serves the answered one now.
  if (call.what === "check" && request.answer !== null && request.answer !== answerBefore && isOpen(request) && servesNone()) state.current = id;
  followAnsweredRequest(state, session);
}

function feedEvent(state, event) {
  if (event.type === "system" && event.subtype === "init") {
    state.sessions.push(newSession(event));
    state.current = null;
    state.lastEnded = null;
    state.calls.clear();
    return;
  }
  if (state.sessions.length === 0) state.sessions.push(newSession(null));
  const session = state.sessions.at(-1);
  const at = textOf(event.timestamp);
  if (at !== null) {
    session.firstAt ??= at;
    session.lastAt = at;
  }
  if (event.type === "result") {
    session.result = { kind: textOf(event.subtype), isError: event.is_error === true, text: keep(textOf(event.result)) };
    return;
  }
  if (event.type === "rate_limit_event") {
    const info = event.rate_limit_info;
    session.planLimit =
      typeof info?.status === "string"
        ? { status: info.status, resetsAt: typeof info.resetsAt === "number" ? new Date(info.resetsAt * 1000).toISOString() : null }
        : null;
    return;
  }
  if (event.type === "system" && event.subtype === "permission_denied") {
    addStep(state, session, { kind: "denied", at, tool: textOf(event.tool_name), text: keep(textOf(event.message)) });
    return;
  }
  const content = event.message?.content;
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    if (event.type === "assistant" && part.type === "tool_use") toolUse(state, session, part, at);
    else if (event.type === "assistant" && part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      addStep(state, session, { kind: "text", at, text: keep(part.text.trim()) });
    } else if (event.type === "user" && part.type === "tool_result") toolResult(state, session, part, at);
  }
}

const isEvent = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// How each event line of the output starts.
const EVENT_START = '{"type":';

// A line of the output that is no event (the session's stderr, for example an error of Claude Code when the session
// cannot start), with the time of the last event before it.
function addOtherOutput(state, text) {
  pushLimited(state.otherOutput, { after: state.sessions.at(-1)?.lastAt ?? null, text: keep(text) }, OTHER_OUTPUT_LIMIT);
}

function feedLine(state, line) {
  const parsed = parseJson(line);
  if (isEvent(parsed)) {
    feedEvent(state, parsed);
    return;
  }
  if (parsed !== null) return;
  // A write that was cut (a crash, a full disk), or stderr text with no newline, joins the next event to its line. That
  // event is the first part from a later {"type": that parses: a part that starts inside the cut text cannot parse,
  // because the cut text's own end is missing.
  for (let at = line.indexOf(EVENT_START, 1); at > 0; at = line.indexOf(EVENT_START, at + 1)) {
    const event = parseJson(line.slice(at));
    if (isEvent(event)) {
      const before = line.slice(0, at).trim();
      // A cut event (it starts with {") is no output of its own.
      if (before && !before.startsWith('{"')) addOtherOutput(state, before);
      feedEvent(state, event);
      return;
    }
  }
  if (!line.trimStart().startsWith('{"')) addOtherOutput(state, line.trim());
}

function feedText(state, text) {
  for (const line of text.split("\n")) {
    if (line.trim()) feedLine(state, line);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------------------------------------------------

function statOrNull(path) {
  try {
    return statSync(path);
  } catch (error) {
    // The start script moves session.jsonl away when it grew large, and creates it again when a session writes.
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function readBytes(fd, from, to) {
  const bytes = Buffer.alloc(to - from);
  let done = 0;
  while (done < bytes.length) {
    const read = readSync(fd, bytes, done, bytes.length - done, from + done);
    if (read === 0) break;
    done += read;
  }
  return bytes.subarray(0, done);
}

// The session's two logs, parsed into one state. `stats` counts the bytes read and the parses of each file, for tests.
export class SessionLogs {
  constructor(dir) {
    this.dir = dir;
    this.olderKey = null;
    this.checkpoint = newState();
    this.state = null;
    this.currentFile = null;
    this.offset = 0;
    this.generation = 0;
    this.found = false;
    this.stats = { bytesRead: 0, olderParses: 0, currentStarts: 0 };
  }

  // session.1.jsonl does not grow: parse it again only when it is another file, or its size or its time changed. Then
  // session.jsonl is read again from its start, on the new state.
  refreshOlder() {
    const path = join(this.dir, OLDER_LOG);
    const stat = statOrNull(path);
    const key = stat === null ? "none" : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (key === this.olderKey) return false;
    this.olderKey = key;
    this.checkpoint = newState();
    if (stat !== null) {
      const bytes = readFileSync(path);
      this.stats.bytesRead += bytes.length;
      this.stats.olderParses += 1;
      feedText(this.checkpoint, bytes.toString("utf8"));
    }
    this.state = null;
    return true;
  }

  startCurrent(file) {
    this.state = structuredClone(this.checkpoint);
    this.currentFile = file;
    this.offset = 0;
    this.stats.currentStarts += 1;
  }

  // The state after both logs as they are now.
  refresh() {
    let changed = this.refreshOlder();
    const path = join(this.dir, CURRENT_LOG);
    let fd;
    try {
      fd = openSync(path, "r");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // No session.jsonl: no session wrote yet, or the start script has just moved it to session.1.jsonl.
      if (this.state === null || this.currentFile !== null) {
        this.startCurrent(null);
        changed = true;
      }
      return this.finish(changed);
    }
    try {
      const stat = fstatSync(fd);
      const file = `${stat.dev}:${stat.ino}`;
      if (this.state === null || file !== this.currentFile || stat.size < this.offset) {
        this.startCurrent(file);
        changed = true;
      }
      if (stat.size > this.offset) {
        const bytes = readBytes(fd, this.offset, stat.size);
        this.stats.bytesRead += bytes.length;
        // Only whole lines: the last line can be half written. Its rest is read the next time.
        const end = bytes.lastIndexOf(0x0a);
        if (end >= 0) {
          feedText(this.state, bytes.subarray(0, end + 1).toString("utf8"));
          this.offset += end + 1;
          changed = true;
        }
      }
    } finally {
      closeSync(fd);
    }
    return this.finish(changed);
  }

  finish(changed) {
    if (changed) this.generation += 1;
    this.found = this.olderKey !== "none" || this.currentFile !== null;
    return this.state;
  }
}

// service.log, read again when it changed: its lines, and the start and end of each session.
class ServiceLog {
  constructor(path) {
    this.path = path;
    this.value = { key: null, lines: [], entries: [] };
  }

  read() {
    const stat = statOrNull(this.path);
    const key = stat === null ? "none" : `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (key === this.value.key) return this.value;
    const lines = stat === null ? [] : readFileSync(this.path, "utf8").split("\n").filter((line) => line.trim());
    const entries = [];
    for (const line of lines) {
      const match = SERVICE_LINE.exec(line.trim());
      if (match) entries.push({ at: Date.parse(match[1]), kind: match[2] ? "start" : "end", code: match[3] === undefined ? null : Number(match[3]) });
    }
    this.value = { key, lines, entries };
    return this.value;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The page's data
// ---------------------------------------------------------------------------------------------------------------------

function cut(text, limit) {
  if (typeof text !== "string") return text;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function later(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

// The start line and the end line of service.log for each session: the last start at or before its first event, and
// the first end after that start. service.log's times are whole seconds, the events' times are not.
function pairWithServiceLog(sessions, entries) {
  let from = 0;
  return sessions.map((session) => {
    const first = session.firstAt === null ? Number.NaN : Date.parse(session.firstAt);
    if (Number.isNaN(first)) return { startedAt: null, end: null };
    let start = -1;
    for (let i = from; i < entries.length && entries[i].at <= first; i += 1) {
      if (entries[i].kind === "start") start = i;
    }
    if (start < 0) return { startedAt: null, end: null };
    from = start + 1;
    let end = null;
    for (let i = start + 1; i < entries.length && entries[i].kind !== "start"; i += 1) {
      if (entries[i].kind === "end") {
        end = entries[i];
        break;
      }
    }
    return { startedAt: iso(entries[start].at), end };
  });
}

function endingWords(session, end) {
  const words = [];
  if (session.result !== null) {
    const { kind, isError } = session.result;
    // `success` with is_error (for example at a plan limit), or an error kind such as error_during_execution.
    if (isError || kind !== "success") words.push(`It stopped with an error${kind !== null && kind !== "success" ? ` (${kind})` : ""}.`);
    else words.push("It ended its turn.");
    if (session.result.text) words.push(`Its last message: ${session.result.text}`);
  }
  if (end !== null) {
    words.push(`The start script saw it end with code ${end.code}${EXIT_WORDS[end.code] ? ` (${EXIT_WORDS[end.code]})` : ""}.`);
  }
  if (words.length === 0) words.push("Its log has no end: it was stopped, or Claude Code or the computer stopped it.");
  return words.join(" ");
}

// How a session ended, in a few words: the line of an earlier session.
function shortEnding(session, end) {
  if (session.result !== null) {
    if (session.planLimit?.status === "rejected") return "stopped at the plan limit";
    return session.result.isError || session.result.kind !== "success" ? "stopped with an error" : "ended its turn";
  }
  if (end !== null) return `ended with code ${end.code}`;
  return "no end in its log";
}

function stepView(step, mask) {
  if (step.kind !== "tool") return { kind: step.kind, at: step.at, tool: step.tool ?? null, text: cut(mask(step.text ?? ""), MESSAGE_CHARS) };
  return {
    kind: "tool",
    at: step.at,
    tool: step.tool,
    target: step.target === null ? null : cut(mask(step.target), TARGET_CHARS),
    detail: step.detail === null ? null : cut(mask(step.detail), COMMAND_CHARS),
    failed: step.failed,
  };
}

function sessionView(session, pair, ended, fileTime, mask) {
  return {
    id: session.id,
    startKnown: session.startKnown,
    startedAt: pair.startedAt ?? session.firstAt,
    lastActivity: later(session.lastAt, fileTime),
    running: !ended,
    endedAt: ended ? (pair.end === null ? session.lastAt : iso(pair.end.at)) : null,
    ending: ended ? cut(mask(endingWords(session, pair.end)), REASON_CHARS) : null,
    endedHow: ended ? shortEnding(session, pair.end) : null,
    model: session.model,
    permissionMode: session.permissionMode,
    claudeCodeVersion: session.claudeCodeVersion,
    doableServers: session.doableServers,
    planLimit: session.planLimit !== null && session.planLimit.status !== "allowed" ? session.planLimit : null,
    requests: session.requestIds.length,
    failedCalls: session.failedCalls.map((call) => ({ at: call.at, what: call.what, text: cut(mask(call.text ?? ""), REASON_CHARS) })),
    steps: session.steps.map((step) => stepView(step, mask)),
    stepsLeftOut: session.stepsLeftOut,
  };
}

// The status that the page shows. A request that a session held when it ended is no longer served (requestNote).
function statusWords(request, sessionEnded) {
  if (request.cancelRequested || request.status === "cancelled") return "cancelled";
  if (request.status === "done" || request.status === "failed" || request.status === "declined") return request.status;
  if (request.status === "working") return sessionEnded ? "left when its session ended" : "working";
  if (request.status === "needs_answer") return sessionEnded ? "waiting for an answer; no session serves it" : "waiting for an answer";
  if (request.status === "queued") return "given back to the queue";
  return request.status === null ? "unknown" : request.status.replaceAll("_", " ");
}

// What Doable does with a request that no session serves, by its rules (orchestration's agent_v2/code_agent.py): a
// lease of 10 minutes from the last call of the session; with no lease while its question waits, up to 24 hours for
// the answer; then 30 minutes for this machine after the answer.
function requestNote(status, answered) {
  if (status === "waiting for an answer; no session serves it") {
    return "No session serves it now. It waits up to 24 hours for the asker's answer. When the answer comes, Doable keeps it for this machine for 30 minutes, then gives it back to the queue, and the next session can take it.";
  }
  if (status !== "left when its session ended") return null;
  if (answered) {
    return "No session serves it now. Doable keeps it for this machine until 30 minutes after the answer, or 10 minutes after the last word from the session when that is later. Then it gives it back to the queue, and the next session can take it.";
  }
  return "No session serves it now. Doable gives it back to the queue 10 minutes after the last word from the session, and the next session can take it.";
}

function requestView(request, sessionEnded, mask) {
  const result = request.result;
  const status = statusWords(request, sessionEnded);
  return {
    id: request.id,
    status,
    note: requestNote(status, request.answer !== null),
    askedBy: request.askedBy,
    askedByUser: request.askedByUser,
    askedAt: request.askedAt,
    organization: request.organization,
    suite: request.suite,
    environment: request.environment,
    chatUrl: request.chatUrl,
    takenAt: request.takenAt,
    text: request.text === null ? null : mask(request.text),
    events: request.events.map((event) => ({
      kind: event.kind,
      at: event.at,
      what: event.what ?? null,
      // The asker's answer shows whole, as the request's text does.
      text:
        typeof event.text !== "string"
          ? null
          : event.kind === "answer"
            ? mask(event.text)
            : cut(mask(event.text), event.kind === "refused" ? REASON_CHARS : KEEP_CHARS),
    })),
    eventsLeftOut: request.eventsLeftOut,
    result:
      result === null
        ? null
        : {
            at: result.at,
            outcome: result.outcome,
            kept: result.kept,
            summary: result.summary === null ? null : mask(result.summary),
            records: result.records.map((record) => ({ name: record.name, value: recordValue(record.name, record.value) })),
            logins: result.logins.map((login) => ({ username: login.username, note: login.note })),
          },
    steps: request.steps.map((step) => stepView(step, mask)),
    stepsLeftOut: request.stepsLeftOut,
  };
}

// What /data.json gives: the service (with its self-update: "on", "off" or "development folder"), the current session,
// the earlier sessions (newest first), and the requests (newest first), with every string masked.
export function pageView(state, { machine, serviceState: service, selfUpdate, serviceLog, currentLogTime, logFound }) {
  const mask = makeMasker(state.passwords);
  const sessions = state.sessions;
  const last = sessions.length - 1;
  const pairs = pairWithServiceLog(sessions, serviceLog.entries);
  // A session ended when a later one started, when it wrote its result, when the start script wrote its end, or when
  // the service does not run.
  const ended = sessions.map((session, i) => i < last || session.result !== null || pairs[i].end !== null || service !== "on");
  const views = sessions.map((session, i) => sessionView(session, pairs[i], ended[i], i === last ? currentLogTime : null, mask));
  const view = {
    machine,
    service: {
      state: service,
      selfUpdate,
      lastActivity: currentLogTime,
      logLines: serviceLog.lines.slice(-SERVICE_LOG_LINES).map((line) => cut(mask(line), REASON_CHARS)),
      otherOutput: state.otherOutput.map((line) => ({ after: line.after, text: cut(mask(line.text), REASON_CHARS) })),
    },
    logFound,
    current: views.at(-1) ?? null,
    earlier: views.slice(0, -1).reverse(),
    requests: [...state.requests.values()].reverse().map((request) => requestView(request, ended[request.sessionIndex] ?? true, mask)),
  };
  // Every string once more, also the ones that the views above do not mask (names, usernames, records, log lines).
  return maskAll(view, mask);
}

// The data of one machine's page, built again only when a log, the service log or the service's state changed.
export class PageData {
  constructor({ machine, env }) {
    this.machine = machine;
    this.env = env;
    this.dir = serviceDir(env, machine);
    this.logs = new SessionLogs(this.dir);
    this.serviceLog = new ServiceLog(join(this.dir, SERVICE_LOG));
    this.cached = { key: null, text: null };
  }

  json() {
    const service = serviceState(this.machine, this.env);
    const selfUpdate = selfUpdateState(this.machine, this.env);
    const state = this.logs.refresh();
    const serviceLog = this.serviceLog.read();
    const current = statOrNull(join(this.dir, CURRENT_LOG));
    const currentLogTime = current === null ? null : current.mtime.toISOString();
    const key = [this.logs.generation, service, selfUpdate, serviceLog.key, currentLogTime].join("|");
    if (key !== this.cached.key) {
      const view = pageView(state, { machine: this.machine, serviceState: service, selfUpdate, serviceLog, currentLogTime, logFound: this.logs.found });
      this.cached = { key, text: JSON.stringify(view) };
    }
    return this.cached.text;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------------------------------

function safetyHeaders(nonce) {
  return {
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

function send(response, status, type, body, headers) {
  response.writeHead(status, { ...headers, "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

function answer(request, response, port, data) {
  const nonce = randomBytes(16).toString("base64");
  const headers = safetyHeaders(nonce);
  const host = (request.headers.host ?? "").toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    send(response, 403, "text/plain; charset=utf-8", `This page answers only at http://127.0.0.1:${port}/ on this computer.\n`, headers);
    return;
  }
  if (request.method !== "GET") {
    send(response, 405, "text/plain; charset=utf-8", "This page takes only GET.\n", { ...headers, Allow: "GET" });
    return;
  }
  if (request.url === "/") {
    send(response, 200, "text/html; charset=utf-8", pageHtml(nonce), headers);
    return;
  }
  if (request.url === "/data.json") {
    let body;
    try {
      body = data.json();
    } catch (error) {
      // The page shows the reason (for example a machine that was removed) and reads again 5 seconds later.
      console.error(error);
      send(response, 500, "text/plain; charset=utf-8", `${maskSecrets(error.message)}\n`, headers);
      return;
    }
    send(response, 200, "application/json; charset=utf-8", body, headers);
    return;
  }
  send(response, 404, "text/plain; charset=utf-8", "Not found. This page has only / and /data.json.\n", headers);
}

// The page's server for `machine`, listening on 127.0.0.1 at `port` (0: a free port).
export function startPageServer({ machine, env, port }) {
  const data = new PageData({ machine, env });
  const server = createServer((request, response) => answer(request, response, server.address().port, data));
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is in use on this computer. Start the page on another port with --port <number>.`));
      } else reject(error);
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// Who can open the page, and what it hides: the page() command prints these, and the page shows them (README, "The code
// agent's page").
const PAGE_ACCESS = "Other computers cannot open it, but any account or program on this computer can, not only you.";
const PAGE_MASK =
  "It shows **** in place of each password of a login in a result, each Doable API key, and secrets in known forms " +
  "(NAME=value, password: value, --password value, -u user:password, a URL's password, Bearer and Basic headers). " +
  "A secret in another form can still show: for example a password in a sentence, or a new login's password as a " +
  "script's argument until the result names that login.";

// The `page` command: it serves the page until Ctrl-C.
export async function page(options, env, print = console.log) {
  const { machine } = options;
  // The checks and the messages of the other commands: a valid name, of a machine that is set up.
  serviceState(machine, env);
  const server = await startPageServer({ machine, env, port: options.port ?? DEFAULT_PORT });
  print(`The page of the code agent "${machine}": http://127.0.0.1:${server.address().port}/`);
  print(PAGE_ACCESS);
  print(PAGE_MASK);
  print("Stop the page with Ctrl-C. The code agent goes on.");
  process.once("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The page: one inline style and one inline script (each with the answer's nonce). The script reads /data.json every 5
// seconds and writes each value with textContent, never as HTML.
// ---------------------------------------------------------------------------------------------------------------------

const STYLE = String.raw`
:root { --bg: #f6f6f3; --card: #ffffff; --text: #1f2328; --muted: #5d636b; --line: #d9dad5;
  --ok: #1a7f37; --ok-bg: #e6f4ea; --info: #0b5cad; --info-bg: #e7f0fb; --warn: #8a5300; --warn-bg: #fdf1dc;
  --bad: #b42318; --bad-bg: #fdecea; --muted-bg: #eeeeea; }
* { box-sizing: border-box; }
/* The script keeps the card that the person reads in its place after each new read; the browser must not move it too. */
html, body { overflow-anchor: none; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 19px; margin: 32px 0 12px; }
h3 { font-size: 16px; margin: 0; }
h4 { font-size: 15px; margin: 16px 0 8px; }
p { margin: 8px 0; }
a { color: var(--info); }
.muted { color: var(--muted); }
.note { color: var(--muted); font-size: 13px; }
.problem { position: sticky; top: 0; z-index: 1; background: var(--bad-bg); color: var(--bad); border: 1px solid #f3c1bc; border-radius: 8px; padding: 10px 12px; }
#content.stale { opacity: 0.55; }
.empty { background: var(--card); border: 1px dashed var(--line); border-radius: 10px; padding: 16px; color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin: 0 0 14px; }
.head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.badge { display: inline-block; border-radius: 999px; padding: 1px 10px; font-size: 13px; font-weight: 600; white-space: nowrap; }
.badge.ok { color: var(--ok); background: var(--ok-bg); }
.badge.info { color: var(--info); background: var(--info-bg); }
.badge.warn { color: var(--warn); background: var(--warn-bg); }
.badge.bad { color: var(--bad); background: var(--bad-bg); }
.badge.muted { color: var(--muted); background: var(--muted-bg); }
.badge.big { font-size: 15px; padding: 3px 14px; }
dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 12px 0; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre.text { background: #fafaf8; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.summary { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0; background: #fafaf8; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
pre.log { background: #fafaf8; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; max-height: 260px; overflow: auto; }
ol.lines, ol.steps { list-style: none; padding: 0; margin: 8px 0; }
ol.lines li, ol.steps li { padding: 6px 0; border-top: 1px solid #ecece8; overflow-wrap: anywhere; }
ol.lines li:first-child, ol.steps li:first-child { border-top: 0; }
.time { color: var(--muted); font-size: 13px; margin-right: 10px; white-space: nowrap; }
.what { font-weight: 600; margin-right: 8px; }
.words { overflow-wrap: anywhere; }
ol.lines pre { margin: 4px 0 0; }
.detail { display: block; margin-top: 2px; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #3d444d; white-space: pre-wrap; overflow-wrap: anywhere; }
li.said .words { font-style: italic; }
li.denied .what { color: var(--bad); }
.result { border-top: 1px solid var(--line); margin-top: 12px; }
table { border-collapse: collapse; width: 100%; margin: 6px 0; font-size: 14px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #ecece8; vertical-align: top; overflow-wrap: anywhere; }
th { color: var(--muted); font-weight: 600; }
details.fold { margin-top: 12px; }
details.fold summary { cursor: pointer; color: var(--info); }
`;

const SCRIPT = String.raw`
"use strict";
const openKeys = new Set();
let lastText = null;
// The cards of the last render, in their order on the page, each with a key (data-key).
let anchors = [];
const problem = document.getElementById("problem");
const updated = document.getElementById("updated");
const content = document.getElementById("content");
const STATE = {
  on: { label: "On", tone: "ok", words: "It runs and waits for Doable's requests." },
  stopped: { label: "Stopped", tone: "muted", words: "Someone ran stop. It serves no request until someone runs start." },
  "not running": { label: "Not running", tone: "bad", words: "It is set up, but it does not run. Run start to turn it on." },
};
const SELF_UPDATE = {
  on: "Self-update is on: before each start of a session, the start script updates the plugin with Claude Code. The service's log below shows each update and each failure.",
  off: "Self-update is off: when Doable needs a newer plugin, each session ends at its first wait for a request, until a person updates the plugin on this computer.",
  "development folder": "Self-update is off: the session loads the plugin from a development folder. When Doable needs a newer plugin, each session ends at its first wait for a request, until a person updates that folder.",
};
const STATUS_TONE = { working: "info", "waiting for an answer": "warn", done: "ok", failed: "bad", declined: "warn",
  cancelled: "muted", "left when its session ended": "bad", "waiting for an answer; no session serves it": "warn",
  "taken by another machine": "muted", "given back to the queue": "muted", "timed out": "bad", lost: "bad", expired: "muted" };
const EVENT_LABEL = { taken: "The session took it", "taken again": "The session took it again", progress: "Progress",
  question: "Question to the asker", answer: "Answer from the asker", result: "Result sent",
  "result not kept": "Result sent: Doable did not keep it" };
const WHAT = { progress: "progress", question: "question", result: "result", check: "check for an answer",
  "read of the test inbox": "read of the test inbox", "wait for a request": "wait for a request" };
const PLAN_WORDS = { rejected: "reached", allowed_warning: "near the limit" };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function add(parent, ...children) {
  for (const child of children) if (child) parent.append(child);
  return parent;
}
function count(number, one, many) {
  return number + " " + (number === 1 ? one : many);
}
// A time with its time zone, so that it can be compared with the service log's UTC times.
function when(iso) {
  if (!iso) return "unknown";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" });
}
function anchor(node, key) {
  node.dataset.key = key;
  anchors.push(node);
  return node;
}
function link(url, text) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  const anchor = el("a", null, text);
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  return anchor;
}
function badge(text, tone, big) {
  return el("span", "badge " + (tone || "muted") + (big ? " big" : ""), text);
}
function facts(rows) {
  const list = el("dl", "facts");
  for (const [name, value] of rows) {
    if (value === null || value === undefined || value === "") continue;
    add(list, el("dt", null, name), typeof value === "string" ? el("dd", null, value) : add(el("dd"), value));
  }
  return list;
}
function folded(key, title, body) {
  const box = el("details", "fold");
  add(box, el("summary", null, title), body);
  box.open = openKeys.has(key);
  box.addEventListener("toggle", () => {
    if (box.open) openKeys.add(key);
    else openKeys.delete(key);
  });
  return box;
}
function toolLabel(name) {
  const match = /^mcp__(.+?)__(.+)$/.exec(name || "");
  return match ? match[2] + " (" + match[1] + ")" : name || "a tool";
}
function stepList(steps, leftOut) {
  const box = el("div");
  if (leftOut) add(box, el("p", "note", count(leftOut, "earlier step is", "earlier steps are") + " not shown."));
  const list = add(box, el("ol", "steps")).lastChild;
  for (const step of steps) {
    const item = el("li", step.kind === "text" ? "said" : step.kind === "denied" ? "denied" : null);
    add(item, el("span", "time", step.at ? when(step.at) : ""));
    if (step.kind === "text") add(item, el("span", "what", "Wrote"), el("span", "words", step.text));
    else if (step.kind === "denied") add(item, el("span", "what", "Claude Code refused " + (step.tool || "a tool")), el("span", "words", step.text));
    else {
      add(item, el("span", "what", toolLabel(step.tool)), step.target ? el("span", "words", step.target) : null);
      if (step.failed) add(item, el("span", null, " "), badge("failed", "bad"));
      if (step.detail) add(item, el("code", "detail", step.detail));
    }
    add(list, item);
  }
  return box;
}
function doableWords(servers) {
  if (!servers || servers.length === 0) return "No Doable MCP server in this session";
  return servers.map((server) => (server.status === "connected" ? "connected" : "not connected (" + (server.status || "no status") + ")") + " — " + server.name).join("; ");
}
function modeWords(mode) {
  if (!mode) return null;
  return mode === "bypassPermissions" ? mode + " (no permission check)" : mode + " (not the bypass mode: with nobody at the terminal it cannot do the work)";
}
function planWords(limit) {
  if (!limit) return null;
  return (PLAN_WORDS[limit.status] || limit.status.replaceAll("_", " ")) + (limit.resetsAt ? "; it resets at " + when(limit.resetsAt) : "");
}
function sessionFacts(session) {
  return facts([
    ["Started", session.startKnown ? when(session.startedAt) : when(session.startedAt) + " (its start is not in the logs)"],
    ["Last activity", when(session.lastActivity)],
    ["Doable MCP at its start", doableWords(session.doableServers)],
    ["Model", session.model],
    ["Permission mode", modeWords(session.permissionMode)],
    ["Claude Code", session.claudeCodeVersion],
    ["Plan limit", planWords(session.planLimit)],
    ["Ended", session.running ? null : when(session.endedAt)],
    ["How it ended", session.running ? null : session.ending],
  ]);
}
function failedCalls(session) {
  if (!session.failedCalls.length) return null;
  const box = el("div");
  add(box, el("h4", null, "Calls to Doable that failed"));
  const list = add(box, el("ol", "lines")).lastChild;
  for (const call of session.failedCalls) {
    add(list, add(el("li"), el("span", "time", when(call.at)), el("span", "what", "The " + (WHAT[call.what] || call.what)), el("span", "words", call.text)));
  }
  return box;
}
// The steps that a session made outside a request: before its first request, and between requests.
function ownSteps(session) {
  if (!session.steps.length) return null;
  return folded("own:" + (session.id || session.startedAt), "What it did outside a request (" + count(session.steps.length, "step", "steps") + ")", stepList(session.steps, session.stepsLeftOut));
}
function otherOutput(lines) {
  if (!lines.length) return null;
  const box = el("div");
  add(box, el("h4", null, "Output of the session that is not an event (last lines)"));
  add(box, el("p", "note", "Claude Code and the shell write their errors here, for example when the session cannot start."));
  const list = add(box, el("ol", "lines")).lastChild;
  for (const line of lines) add(list, add(el("li"), el("span", "time", line.after ? "after " + when(line.after) : "before the first event"), el("span", "words", line.text)));
  return box;
}
function renderSession(data) {
  const box = el("section");
  add(box, el("h2", null, "The serving session"));
  const state = STATE[data.service.state] || { label: data.service.state, tone: "muted", words: "" };
  const card = anchor(add(box, el("div", "card")).lastChild, "session");
  add(card, add(el("div", "head"), badge(state.label, state.tone, true), el("span", null, state.words)));
  if (SELF_UPDATE[data.service.selfUpdate]) add(card, el("p", "note", SELF_UPDATE[data.service.selfUpdate]));
  if (!data.logFound) {
    add(card, el("p", "empty", "No log yet: the serving session has not written anything on this computer. When it runs, its steps show here."));
  } else if (!data.current) {
    add(card, el("p", "empty", "The session's log holds no event yet. Its output below that is not an event can say why, for example an error of Claude Code."));
  } else {
    const current = data.current;
    add(card, el("h4", null, current.running ? "The session that runs now" : "The last session"));
    add(card, sessionFacts(current));
    if (!current.running && data.service.state === "on") add(card, el("p", "note", "The start script starts a new session 5 minutes after one ends."));
    add(card, failedCalls(current), ownSteps(current));
  }
  add(card, el("h4", null, "The service's log (last lines)"));
  add(card, data.service.logLines.length ? el("pre", "log", data.service.logLines.join("\n")) : el("p", "muted", "No line yet."));
  add(card, otherOutput(data.service.otherOutput));
  return box;
}
// The earlier sessions, folded, one line each: after hours of restarts (for example at a plan limit) they are many.
function renderEarlier(data) {
  const box = el("section");
  add(box, el("h2", null, "Earlier sessions"));
  if (!data.earlier.length) {
    add(box, el("p", "muted", "None in the logs on this computer."));
    return box;
  }
  const list = el("div");
  for (const session of data.earlier) {
    const line = when(session.startedAt) + " to " + when(session.endedAt) + ": " + count(session.requests, "request", "requests") + ", " + session.endedHow;
    add(list, folded("session:" + (session.id || session.startedAt), line, add(el("div", "card"), sessionFacts(session), failedCalls(session), ownSteps(session))));
  }
  add(box, anchor(folded("earlier", count(data.earlier.length, "earlier session", "earlier sessions") + ", newest first", list), "earlier"));
  return box;
}
function askerWords(request) {
  const box = el("p");
  if (request.askedBy === "chat") {
    let words = "Asked from a Doable chat";
    if (request.suite) words += " of the suite \u201c" + request.suite + "\u201d";
    if (request.environment) words += ", environment \u201c" + request.environment + "\u201d";
    add(box, el("span", null, words + ". "), link(request.chatUrl, "Open the chat"));
  } else if (request.askedBy === "claude_code") {
    add(box, el("span", null, request.askedByUser ? "Asked by " + request.askedByUser + " from their Claude Code." : "Asked from a person's Claude Code with an organization API key, which names no person."));
  } else add(box, el("span", "muted", "The asker is not in the logs."));
  return box;
}
function eventItem(event) {
  const item = el("li");
  add(item, el("span", "time", when(event.at)));
  const label = event.kind === "refused" ? "Doable did not take the " + (WHAT[event.what] || event.what) : EVENT_LABEL[event.kind] || event.kind;
  add(item, el("span", "what", label));
  if (event.text) add(item, event.kind === "question" || event.kind === "answer" ? el("pre", "text", event.text) : el("span", "words", event.text));
  return item;
}
function table(headings, rows) {
  const box = el("table");
  add(box, add(el("thead"), add(el("tr"), ...headings.map((heading) => el("th", null, heading)))));
  const body = add(box, el("tbody")).lastChild;
  for (const row of rows) add(body, add(el("tr"), ...row.map((cell) => el("td", null, cell === null ? "" : cell))));
  return box;
}
function resultBox(request) {
  const result = request.result;
  const box = el("div", "result");
  const heading = result.kept ? "Result" : request.status === "cancelled" ? "Result sent after the cancel: Doable did not keep it" : "Result that Doable did not keep";
  add(box, el("h4", null, heading), facts([["Outcome", result.outcome], ["Sent", when(result.at)]]));
  if (!result.kept) add(box, el("p", "note", "Doable gave back the request as it stood and saved nothing of this result: the asker did not get it."));
  // The summary is Markdown: it shows in the body's font, with its lines.
  if (result.summary) add(box, el("div", "summary", result.summary));
  if (result.records.length) add(box, el("h4", null, "Records"), table(["Name", "Value"], result.records.map((record) => [record.name, record.value])));
  if (result.logins.length) {
    add(box, el("h4", null, "Logins"), table(["Username", "Note"], result.logins.map((login) => [login.username, login.note])));
    add(box, el("p", "note", result.kept
      ? "The page keeps no password of a login."
      : "Doable did not save these logins, but the session made them in the test environment: remove them there if nobody needs them. The page keeps no password of a login."));
  }
  return box;
}
function renderRequests(data) {
  const box = el("section");
  add(box, el("h2", null, "Requests"));
  if (!data.requests.length) {
    add(box, el("p", "empty", "No request yet: the session has not taken a request from Doable."));
    return box;
  }
  const counts = {};
  for (const request of data.requests) counts[request.status] = (counts[request.status] || 0) + 1;
  add(box, el("p", "muted", data.requests.length + (data.requests.length === 1 ? " request, newest first: " : " requests, newest first: ") + Object.entries(counts).map(([status, count]) => count + " " + status).join(", ") + "."));
  for (const request of data.requests) {
    const card = anchor(add(box, el("article", "card")).lastChild, "request:" + request.id);
    add(card, add(el("div", "head"), el("h3", null, request.id), badge(request.status, STATUS_TONE[request.status])));
    add(card, askerWords(request));
    add(card, el("p", "muted", (request.askedAt ? "Asked " + when(request.askedAt) : "Asked: not in the logs") + "." + (request.takenAt ? " Taken " + when(request.takenAt) + "." : "")));
    if (request.note) add(card, el("p", "note", request.note));
    if (request.text) add(card, el("pre", "text", request.text));
    if (request.events.length) {
      if (request.eventsLeftOut) add(card, el("p", "note", count(request.eventsLeftOut, "earlier line is", "earlier lines are") + " not shown."));
      const list = add(card, el("ol", "lines")).lastChild;
      for (const event of request.events) add(list, eventItem(event));
    }
    if (request.result) add(card, resultBox(request));
    if (request.steps.length) add(card, folded("request:" + request.id, "What the session did for it (" + count(request.steps.length, "step", "steps") + ")", stepList(request.steps, request.stepsLeftOut)));
  }
  return box;
}
// The first card that shows in the window, and where its top is.
function firstVisible() {
  for (const node of anchors) {
    const box = node.getBoundingClientRect();
    if (box.bottom > 0) return { key: node.dataset.key, top: box.top };
  }
  return null;
}
// Whether the person selects text of the page: a new render would lose the selection.
function selecting() {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed && content.contains(selection.anchorNode);
}
function render(data) {
  const before = firstVisible();
  anchors = [];
  document.title = "Doable code agent \u201c" + data.machine + "\u201d";
  document.getElementById("title").textContent = "Doable code agent \u201c" + data.machine + "\u201d";
  content.replaceChildren(renderSession(data), renderRequests(data), renderEarlier(data));
  // The card that the person reads stays where it was in the window: a new request above it moves the window with it.
  const same = before === null ? undefined : anchors.find((node) => node.dataset.key === before.key);
  if (same) {
    const moved = same.getBoundingClientRect().top - before.top;
    if (moved !== 0) window.scrollBy(0, moved);
  }
}
function showProblem(words) {
  problem.textContent = words;
  problem.hidden = false;
  content.classList.add("stale");
}
async function load() {
  let response;
  let text;
  try {
    response = await fetch("/data.json", { cache: "no-store" });
    text = await response.text();
  } catch {
    // No answer: the page command stopped, or the computer slept.
    showProblem("The page cannot reach its server. Start the page command again on this computer. The data below is from the last read.");
    return;
  }
  if (!response.ok) {
    // The server's reason, for example a machine that was removed.
    showProblem(text.trim() || "The page's server answered with the status " + response.status + ".");
    return;
  }
  problem.hidden = true;
  content.classList.remove("stale");
  if (text !== lastText && selecting()) {
    updated.textContent = "New data waits while you select text on the page.";
    return;
  }
  updated.textContent = "Updated " + new Date().toLocaleTimeString() + ". The page reads the logs again every 5 seconds.";
  if (text === lastText) return;
  lastText = text;
  render(JSON.parse(text));
}
load();
setInterval(load, 5000);
`;

export function pageHtml(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Doable code agent</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
<h1 id="title">Doable code agent</h1>
<p class="note" id="updated">Reading the logs…</p>
<p class="note">This page reads only the code agent's files on this computer. ${PAGE_ACCESS} ${PAGE_MASK}</p>
<p class="problem" id="problem" hidden></p>
<div id="content"></div>
</main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
}
