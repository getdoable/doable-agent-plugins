// The page of an Always on code agent (`code-agent-service.mjs page --machine NAME [--port N]`): a web page on this
// computer that shows what the serving session does now, what needs a person, and each request that it served. It reads
// only the files of the machine's folder (session.1.jsonl, then session.jsonl, service.log, update-asked, the stop file
// through serviceState, and config.json through selfUpdateState) and calls nothing on the network.
//
// The page reads /data.json every 5 seconds: the session's state, the request in progress and one short line of each
// request. It reads the rest only for the part that the person opens: one request (/request.json?id=CA-...), a page of
// the sessions (/sessions.json?page=N&size=N&open=ID), one session (/session.json?id=ID), a page of service.log
// (/log.json?page=N), or the requests whose whole text holds the words of the search (/search.json?q=WORDS). So a
// machine that served hundreds of requests, each with hundreds of steps, does not send them all every 5 seconds.
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
// web site cannot read the page through DNS rebinding, and only GET of its routes (ROUTES). Each answer allows no source
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
// The version that Doable asked this machine for last, while the machine runs a lower release (code-agent-service.mjs).
const UPDATE_ASKED = "update-asked";
const VERSION = /^\d+\.\d+\.\d+$/;
// The first sentence of Doable's ask for a newer plugin, in the answer of a wait for a request (code-agent-service.mjs).
const ASK_SENTENCE = /^Doable needs the plugin (\d+\.\d+\.\d+) on this machine\./;
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
// What /data.json gives of each request: the start of its text, and of a question that waits for its answer.
const ROW_TEXT_CHARS = 300;
const QUESTION_CHARS = 1000;
// The newest steps of the request in progress that /data.json gives.
const NOW_STEPS = 3;
// The files that a result names (each with its repository, commit and path): Doable takes 50 or fewer.
const CODE_FILE_LIMIT = 100;
// How many lines of service.log one page of /log.json holds, and the sizes of a page of sessions.
const LOG_PAGE_LINES = 200;
const PAGE_SIZES = [10, 25, 50];
const REQUEST_ID = /^CA-[0-9A-Z]{6}$/;
// How the page names a session: its Claude Code session id, which stays the same when the start script moves the log
// (a number from the oldest session would change then).
const SESSION_REF = /^[A-Za-z0-9._-]{1,100}$/;
// The longest search that /search.json takes.
const SEARCH_CHARS = 200;
// Doable waits up to 24 hours for the answer to a request's question while no session serves the request, then expires
// the request (orchestration's agent_v2/code_agent.py). No log of this computer records that, so the page says
// "probably".
const QUESTION_WAIT_MS = 24 * 60 * 60 * 1000;
const EXPIRED = "probably expired: no answer in 24 hours";
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
    // Its calls of the wait for a request, whether one of them returned with no error, the waits that failed since the
    // last one that returned (the session gets no request while they fail), and the version that Doable asked for in a
    // wait's answer (then the session ends).
    waits: 0,
    waited: false,
    failedWaits: 0,
    updateAsked: null,
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

// The version that a wait's answer asks for (the service's updateVersion reads it the same way): the ask's words alone,
// or a JSON record with no request whose `update` starts with them. A record that holds a request is never the ask.
function askedVersion(words, answer) {
  const alone = ASK_SENTENCE.exec(words.trim());
  if (alone !== null) return alone[1];
  if (!isEvent(answer) || answer.request != null || typeof answer.update !== "string") return null;
  return ASK_SENTENCE.exec(answer.update)?.[1] ?? null;
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
  const codeFiles = Array.isArray(result.code_files) ? result.code_files : [];
  return {
    outcome: textOf(result.outcome),
    summary: textOf(result.summary),
    records: records.map((record) => ({ name: textOf(record?.name), value: textOf(record?.value) })),
    logins: logins.map((login) => ({ username: textOf(login?.username), note: textOf(login?.note) })),
    // The files that the answer rests on: a repository, a commit and a path each, never code.
    codeFiles: codeFiles.slice(0, CODE_FILE_LIMIT).map((file) => ({ repository: keep(file?.repository), commit: keep(file?.commit), path: keep(file?.path) })),
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
    session.waits += 1;
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
      session.failedWaits += 1;
      pushLimited(session.failedCalls, { at: call.at, what: "wait for a request", text: keep(words) }, FAILED_CALL_LIMIT);
      return;
    }
    session.waited = true;
    session.failedWaits = 0;
    const answer = parseJson(words);
    const task = answer?.request;
    if (!isTask(task)) {
      session.updateAsked = askedVersion(words, answer) ?? session.updateAsked;
      return;
    }
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

// The version that Doable asked for (update-asked) and when, or null when the file is not there. It holds a version, as
// the service writes it: anything else fails, as the service's `status` does.
function askedUpdate(dir) {
  const path = join(dir, UPDATE_ASKED);
  const stat = statOrNull(path);
  if (stat === null) return null;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // A start script that a release at or above the asked one wrote removes the file: then nothing was asked.
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const version = text.trim();
  if (!VERSION.test(version)) throw new Error(`${path} does not hold a version (MAJOR.MINOR.PATCH): ${JSON.stringify(version.slice(0, 40))}.`);
  return { version, at: stat.mtime.toISOString() };
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
  if (session.updateAsked !== null) words.push(`Doable asked for the plugin ${session.updateAsked}, and the session ended at that ask.`);
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

// How a session ended, in a few words: the line of a session in the list.
function shortEnding(session, end) {
  if (session.updateAsked !== null) return `ended at Doable's ask for the plugin ${session.updateAsked}`;
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

// A session as the page shows it. `n` is its number in the logs, from 1 for the oldest, only to show: it changes when
// the start script moves the log. `ref` names the session in /session.json and in the page's address (sessionRefs). The
// steps that it made outside a request come only with `withSteps` (/session.json).
function sessionView(session, pair, ended, fileTime, mask, n, ref, withSteps) {
  const view = {
    n,
    ref,
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
    waited: session.waited,
    failedWaits: session.failedWaits,
    updateAsked: session.updateAsked,
    requests: session.requestIds.length,
    failedCalls: session.failedCalls.map((call) => ({ at: call.at, what: call.what, text: cut(mask(call.text ?? ""), REASON_CHARS) })),
    stepCount: session.steps.length + session.stepsLeftOut,
  };
  if (withSteps) {
    view.steps = session.steps.map((step) => stepView(step, mask));
    view.stepsLeftOut = session.stepsLeftOut;
  }
  return view;
}

// The status that the page shows at the time `now` (ms). A request that a session held when it ended is no longer served
// (requestNote). Its question that got no answer in the logs for 24 hours is probably expired (QUESTION_WAIT_MS).
function statusWords(request, sessionEnded, now) {
  if (request.cancelRequested || request.status === "cancelled") return "cancelled";
  if (request.status === "done" || request.status === "failed" || request.status === "declined") return request.status;
  if (request.status === "working") return sessionEnded ? "left when its session ended" : "working";
  if (request.status === "needs_answer") {
    if (!sessionEnded) return "waiting for an answer";
    return questionTime(request) + QUESTION_WAIT_MS <= now ? EXPIRED : "waiting for an answer; no session serves it";
  }
  if (request.status === "queued") return "given back to the queue";
  return request.status === null ? "unknown" : request.status.replaceAll("_", " ");
}

// Whether a status says that the request is not done yet: a session works on it, or its question waits for the answer.
function isOpenStatus(status) {
  return status === "working" || status.startsWith("waiting for an answer");
}

// What Doable does with a request that no session serves, by its rules (orchestration's agent_v2/code_agent.py): a
// lease of 10 minutes from the last call of the session; with no lease while its question waits, up to 24 hours for
// the answer; then 30 minutes for this machine after the answer.
function requestNote(status, answered) {
  if (status === "waiting for an answer; no session serves it") {
    return "No session serves it now. It waits up to 24 hours for the asker's answer. When the answer comes, Doable keeps it for this machine for 30 minutes, then gives it back to the queue, and the next session can take it.";
  }
  if (status === EXPIRED) {
    return "No session served it after its question, and the logs on this computer show no answer in 24 hours. By Doable's rules, the request has expired, or the answer came and another machine took it. The asker sees in Doable how it stands.";
  }
  if (status !== "left when its session ended") return null;
  if (answered) {
    return "No session serves it now. Doable keeps it for this machine until 30 minutes after the answer, or 10 minutes after the last word from the session when that is later. Then it gives it back to the queue, and the next session can take it.";
  }
  return "No session serves it now. Doable gives it back to the queue 10 minutes after the last word from the session, and the next session can take it.";
}

// The time of the last thing that the logs hold of a request.
function lastTime(request) {
  let last = null;
  for (const item of [...request.events, ...request.steps, request.result]) {
    if (typeof item?.at === "string") last = later(last, item.at);
  }
  return last;
}

// When the session that serves the request took it last (it can take a request again after a session ended).
function servedAt(request) {
  const taken = request.events.filter((event) => event.kind === "taken" || event.kind === "taken again").at(-1);
  return taken?.at ?? request.takenAt;
}

// The request's last question (its line) when no answer came after it.
function waitingQuestion(request) {
  for (let i = request.events.length - 1; i >= 0; i -= 1) {
    if (request.events[i].kind === "answer") return null;
    if (request.events[i].kind === "question") return request.events[i];
  }
  return null;
}

// When the request's question that waits was asked (ms), or its last line when the logs hold no such question.
function questionTime(request) {
  return Date.parse(waitingQuestion(request)?.at ?? lastTime(request) ?? "");
}

// When the request ended: its result, the end of Doable's wait for the answer (EXPIRED), or its last line. An open
// request has no end.
function finishedAt(request, status) {
  if (request.result !== null) return request.result.at;
  if (isOpenStatus(status)) return null;
  if (status === EXPIRED) return iso(questionTime(request) + QUESTION_WAIT_MS);
  return lastTime(request);
}

// One line of the list of requests (/data.json): the start of the text only. `status` is its statusWords.
function requestRow(request, status, mask) {
  const question = status.startsWith("waiting for an answer") ? waitingQuestion(request) : null;
  return {
    id: request.id,
    status,
    askedBy: request.askedBy,
    askedByUser: request.askedByUser,
    organization: request.organization,
    suite: request.suite,
    environment: request.environment,
    askedAt: request.askedAt,
    takenAt: request.takenAt,
    servedAt: servedAt(request),
    finishedAt: finishedAt(request, status),
    // The mask comes before the cut (KEEP_CHARS).
    text: request.text === null ? null : cut(mask(request.text), ROW_TEXT_CHARS),
    question: typeof question?.text === "string" ? cut(mask(question.text), QUESTION_CHARS) : null,
    questionAt: question?.at ?? null,
    outcome: request.result?.outcome ?? null,
    refused: request.events.filter((event) => event.kind === "refused").length,
    stepCount: request.steps.length + request.stepsLeftOut,
  };
}

// A request with its whole text, its lines, its result and the steps in `steps` (all of them for /request.json, the
// newest few for the request in progress).
function requestView(request, status, mask, steps) {
  const result = request.result;
  const row = requestRow(request, status, mask);
  return {
    ...row,
    note: requestNote(row.status, request.answer !== null),
    chatUrl: request.chatUrl,
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
            codeFiles: result.codeFiles,
          },
    steps: steps.map((step) => stepView(step, mask)),
    stepsLeftOut: request.stepsLeftOut,
  };
}

// What the session does now, for the page's header: "working" (on `requestId`), "waiting for an answer", "serving" (it
// waits for Doable's requests), "cannot reach Doable" (its waits for a request fail), "starting", "cannot start" (with
// the lines of its output that say why), "plan limit", "between sessions", "no log", or the service's "stopped" or
// "not running".
function servingState({ service, logFound, state, ended, entries, otherOutput, now }) {
  const none = (name, lines = []) => ({ state: name, requestId: null, lines });
  if (service !== "on") return none(service);
  if (!logFound) return none("no log");
  const last = state.sessions.length - 1;
  const newest = state.sessions[last];
  // The output after the newest session's last event (all of it when no session wrote an event).
  const after = () => otherOutput.filter((line) => newest === undefined || line.after === newest.lastAt).map((line) => line.text);
  if (newest === undefined) {
    const lines = after();
    return none(lines.length > 0 ? "cannot start" : "starting", lines);
  }
  // The start script's last start line came after the newest session's last event: it started a session that wrote no
  // event yet. That session cannot start only when the start script also wrote its end. Until then it can still be
  // connecting, and the output before the start line can be the earlier session's own.
  const lastAt = newest.lastAt === null ? null : Date.parse(newest.lastAt);
  const start = entries.findLastIndex((entry) => entry.kind === "start");
  if (lastAt !== null && start >= 0 && entries[start].at > lastAt) {
    return entries.slice(start + 1).some((entry) => entry.kind === "end") ? none("cannot start", after()) : none("starting");
  }
  if (!ended[last]) {
    const held = [...state.requests.values()].filter((request) => request.sessionIndex === last);
    const working = held.filter((request) => statusWords(request, false, now) === "working");
    const serving = working.find((request) => request.id === state.current) ?? working.at(-1);
    if (serving !== undefined) return { state: "working", requestId: serving.id, lines: [] };
    const asking = held.filter((request) => statusWords(request, false, now) === "waiting for an answer").at(-1);
    if (asking !== undefined) return { state: "waiting for an answer", requestId: asking.id, lines: [] };
    if (newest.failedWaits > 0) return none("cannot reach Doable");
    return none(newest.waits > 0 ? "serving" : "starting");
  }
  if (newest.planLimit?.status === "rejected") return none("plan limit");
  if (!newest.waited) return none("cannot start", after());
  return none("between sessions");
}

// A request, a session or a page that the page cannot give: its status (400 or 404) and the words that say why.
class Refusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The name of each session in /session.json and in the page's address: its Claude Code session id, or "position-N" (N
// from 1 for the oldest) for a session whose id is missing, has another form, or is also another session's id.
function sessionRefs(sessions) {
  const counts = new Map();
  for (const session of sessions) counts.set(session.id, (counts.get(session.id) ?? 0) + 1);
  return sessions.map((session, i) =>
    typeof session.id === "string" && SESSION_REF.test(session.id) && counts.get(session.id) === 1 ? session.id : `position-${i + 1}`,
  );
}

// The data of the page for one state of the files at the time `now` (ms), with every string masked. Each part is built
// when a route asks. `changesAt` is the time when a status changes with the time alone (QUESTION_WAIT_MS).
function pageModel(state, { machine, serviceState: service, selfUpdate, askedUpdate: asked = null, serviceLog, currentLogTime, logFound, now = Date.now() }) {
  const mask = makeMasker(state.passwords);
  const sessions = state.sessions;
  const last = sessions.length - 1;
  const pairs = pairWithServiceLog(sessions, serviceLog.entries);
  const refs = sessionRefs(sessions);
  // A session ended when a later one started, when it wrote its result, when the start script wrote its end, or when
  // the service does not run.
  const ended = sessions.map((session, i) => i < last || session.result !== null || pairs[i].end !== null || service !== "on");
  const sessionAt = (i, withSteps) => sessionView(sessions[i], pairs[i], ended[i], i === last ? currentLogTime : null, mask, i + 1, refs[i], withSteps);
  const endedOf = (request) => ended[request.sessionIndex] ?? true;
  const statusOf = (request) => statusWords(request, endedOf(request), now);
  const newestFirst = () => [...state.requests.values()].reverse();
  const otherOutput = () => state.otherOutput.map((line) => ({ after: line.after, text: cut(mask(line.text), REASON_CHARS) }));
  let changesAt = Infinity;
  for (const request of state.requests.values()) {
    const expires = questionTime(request) + QUESTION_WAIT_MS;
    if (statusOf(request) === "waiting for an answer; no session serves it" && Number.isFinite(expires)) changesAt = Math.min(changesAt, expires);
  }
  // The text of each request, masked, for /search.json: made at the first search of this state.
  let searchable = null;
  return {
    changesAt,
    // /data.json: the service, the newest session, the request in progress, one line of each request (newest first).
    summary() {
      const requests = newestFirst();
      const output = otherOutput();
      const serving = servingState({ service, logFound, state, ended, entries: serviceLog.entries, otherOutput: output, now });
      return maskAll(
        {
          machine,
          service: { state: service, selfUpdate, askedUpdate: asked, lastActivity: currentLogTime },
          logFound,
          serving,
          session: last >= 0 ? sessionAt(last, false) : null,
          sessionCount: sessions.length,
          now: requests
            .filter((request) => statusOf(request) === "working")
            .map((request) => requestView(request, "working", mask, request.steps.slice(-NOW_STEPS))),
          requests: requests.map((request) => requestRow(request, statusOf(request), mask)),
          otherOutput: output,
          logLineCount: serviceLog.lines.length,
        },
        mask,
      );
    },
    // /request.json: one request with all that the logs keep of it.
    request(id) {
      const request = state.requests.get(id);
      if (request === undefined) throw new Refusal(404, `No request ${id} is in the logs on this computer.`);
      return maskAll(requestView(request, statusOf(request), mask, request.steps), mask);
    },
    // The page of the sessions that /sessions.json gives: the page that holds the session `open` (newer sessions move
    // it to a later page), else `page`, and the last page for a page after it.
    sessionsPage(page, size, open = null) {
      const at = open === null ? -1 : refs.indexOf(open);
      if (at >= 0) return Math.floor((last - at) / size) + 1;
      return Math.min(page, Math.max(1, Math.ceil(sessions.length / size)));
    },
    // /sessions.json: a page of the sessions, newest first, one line each.
    sessions(page, size, open = null) {
      const at = this.sessionsPage(page, size, open);
      const rows = [];
      for (let i = last - (at - 1) * size; i >= 0 && i > last - at * size; i -= 1) {
        const view = sessionAt(i, false);
        rows.push({
          n: view.n,
          ref: view.ref,
          id: view.id,
          startKnown: view.startKnown,
          startedAt: view.startedAt,
          endedAt: view.endedAt,
          running: view.running,
          endedHow: view.endedHow,
          requests: view.requests,
        });
      }
      return maskAll({ page: at, size, pages: Math.max(1, Math.ceil(sessions.length / size)), total: sessions.length, sessions: rows }, mask);
    },
    // /session.json: one session with its facts, its failed calls and its steps outside a request.
    session(ref) {
      const at = refs.indexOf(ref);
      if (at < 0) throw new Refusal(404, `No session ${ref} is in the logs on this computer.`);
      return maskAll(sessionAt(at, true), mask);
    },
    // The page of service.log that /log.json gives: `page`, or the last page for a page after it.
    logPage(page) {
      return Math.min(page, Math.max(1, Math.ceil(serviceLog.lines.length / LOG_PAGE_LINES)));
    },
    // /log.json: a page of service.log, page 1 with the newest lines; the lines of a page are oldest first.
    log(page) {
      const total = serviceLog.lines.length;
      const at = this.logPage(page);
      const to = Math.max(0, total - (at - 1) * LOG_PAGE_LINES);
      const from = Math.max(0, to - LOG_PAGE_LINES);
      const lines = serviceLog.lines.slice(from, to).map((line) => cut(mask(line), REASON_CHARS));
      return maskAll({ page: at, pages: Math.max(1, Math.ceil(total / LOG_PAGE_LINES)), total, from: total === 0 ? 0 : from + 1, to, lines }, mask);
    },
    // /search.json: the ids of the requests (newest first) whose whole text holds `words`, in any case. It searches the
    // masked text, so that a search cannot find a secret that the page hides.
    search(words) {
      searchable ??= newestFirst().map((request) => [request.id, mask(request.text ?? "").toLowerCase()]);
      const lower = words.toLowerCase();
      return { ids: searchable.filter(([, text]) => text.includes(lower)).map(([id]) => id) };
    },
  };
}

// What /data.json gives for a state of the logs (the summary of pageModel).
export function pageView(state, options) {
  return pageModel(state, options).summary();
}

// The data of one machine's page. Its model is built again when a log, service.log, update-asked or the service's state
// changed, or when the time reached its `changesAt`; each answer's text is made once for each model. `now` gives the
// time (ms).
export class PageData {
  constructor({ machine, env, now = Date.now }) {
    this.machine = machine;
    this.env = env;
    this.now = now;
    this.dir = serviceDir(env, machine);
    this.logs = new SessionLogs(this.dir);
    this.serviceLog = new ServiceLog(join(this.dir, SERVICE_LOG));
    this.cached = { key: null, model: null, texts: new Map() };
  }

  refresh() {
    const service = serviceState(this.machine, this.env);
    const selfUpdate = selfUpdateState(this.machine, this.env);
    const asked = askedUpdate(this.dir);
    const state = this.logs.refresh();
    const serviceLog = this.serviceLog.read();
    const current = statOrNull(join(this.dir, CURRENT_LOG));
    const currentLogTime = current === null ? null : current.mtime.toISOString();
    const key = [this.logs.generation, service, selfUpdate, asked?.version, asked?.at, serviceLog.key, currentLogTime].join("|");
    const now = this.now();
    if (key !== this.cached.key || now >= this.cached.model.changesAt) {
      const model = pageModel(state, { machine: this.machine, serviceState: service, selfUpdate, askedUpdate: asked, serviceLog, currentLogTime, logFound: this.logs.found, now });
      this.cached = { key, model, texts: new Map() };
    }
    return this.cached;
  }

  // The text of an answer, kept under `name` for this model. A name holds no page number past the last page: else each
  // such number would keep one more copy of the last page.
  text(name, build, cached = this.refresh()) {
    if (!cached.texts.has(name)) cached.texts.set(name, JSON.stringify(build(cached.model)));
    return cached.texts.get(name);
  }

  json() {
    return this.text("data", (model) => model.summary());
  }

  requestJson(id) {
    return this.text(`request ${id}`, (model) => model.request(id));
  }

  sessionsJson(page, size, open = null) {
    const cached = this.refresh();
    const at = cached.model.sessionsPage(page, size, open);
    return this.text(`sessions ${at} ${size}`, (model) => model.sessions(at, size), cached);
  }

  sessionJson(ref) {
    return this.text(`session ${ref}`, (model) => model.session(ref));
  }

  logJson(page) {
    const cached = this.refresh();
    const at = cached.model.logPage(page);
    return this.text(`log ${at}`, (model) => model.log(at), cached);
  }

  // Not kept: each search's words would keep one more answer.
  searchJson(words) {
    return JSON.stringify(this.refresh().model.search(words));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------------------------------

// Each route and the parameters that it takes.
const ROUTES = new Map([
  ["/", []],
  ["/data.json", []],
  ["/request.json", ["id"]],
  ["/sessions.json", ["page", "size", "open"]],
  ["/session.json", ["id"]],
  ["/log.json", ["page"]],
  ["/search.json", ["q"]],
]);
const NOT_FOUND = "Not found. This page has only /, /data.json, /request.json, /sessions.json, /session.json, /log.json and /search.json.";
const SESSION_ID_WORDS = "the id of a session: 1 to 100 letters, digits, '.', '_' or '-'";
const TAKES = {
  "/": "/ takes no parameter.",
  "/data.json": "/data.json takes no parameter.",
  "/request.json": "/request.json takes id, the id of a request: CA- and 6 capital letters or digits.",
  "/sessions.json": `/sessions.json takes page, a whole number from 1, size: 10, 25 or 50, and open, ${SESSION_ID_WORDS}.`,
  "/session.json": `/session.json takes id, ${SESSION_ID_WORDS}.`,
  "/log.json": "/log.json takes page, a whole number from 1.",
  "/search.json": `/search.json takes q, the words to search for: 1 to ${SEARCH_CHARS} characters.`,
};
const WHOLE_NUMBER = /^[1-9]\d{0,8}$/;

// The route and the parameters of a request's URL, or null for a path that is no route. Parameters that the route does
// not take, a parameter given twice, and a value that cannot be decoded are refused.
function routeOf(url) {
  const at = url.indexOf("?");
  const path = at < 0 ? url : url.slice(0, at);
  if (!ROUTES.has(path)) return null;
  const params = new Map();
  for (const part of at < 0 ? [] : url.slice(at + 1).split("&")) {
    if (part === "") continue;
    const equals = part.indexOf("=");
    const name = equals < 0 ? part : part.slice(0, equals);
    if (!ROUTES.get(path).includes(name) || params.has(name)) throw new Refusal(400, TAKES[path]);
    let value;
    try {
      value = decodeURIComponent(equals < 0 ? "" : part.slice(equals + 1));
    } catch (error) {
      // A malformed escape (%E0%A4%A) is a value that the route does not take.
      if (error instanceof URIError) throw new Refusal(400, TAKES[path]);
      throw error;
    }
    params.set(name, value);
  }
  return { path, params };
}

// A whole number from 1, or `fallback` when the parameter is not given.
function numberParam(route, name, fallback) {
  if (!route.params.has(name)) return fallback;
  const value = route.params.get(name);
  if (!WHOLE_NUMBER.test(value)) throw new Refusal(400, TAKES[route.path]);
  return Number(value);
}

// A parameter that must match `form`, or `fallback` when it is not given and `fallback` is not undefined.
function formParam(route, name, form, fallback) {
  if (!route.params.has(name) && fallback !== undefined) return fallback;
  const value = route.params.get(name) ?? "";
  if (!form.test(value)) throw new Refusal(400, TAKES[route.path]);
  return value;
}

// The JSON text of a data route.
function dataText(route, data) {
  if (route.path === "/data.json") return data.json();
  if (route.path === "/request.json") return data.requestJson(formParam(route, "id", REQUEST_ID));
  if (route.path === "/sessions.json") {
    const size = numberParam(route, "size", PAGE_SIZES[0]);
    if (!PAGE_SIZES.includes(size)) throw new Refusal(400, TAKES[route.path]);
    return data.sessionsJson(numberParam(route, "page", 1), size, formParam(route, "open", SESSION_REF, null));
  }
  if (route.path === "/session.json") return data.sessionJson(formParam(route, "id", SESSION_REF));
  if (route.path === "/search.json") {
    const words = (route.params.get("q") ?? "").trim();
    if (words === "" || words.length > SEARCH_CHARS) throw new Refusal(400, TAKES[route.path]);
    return data.searchJson(words);
  }
  return data.logJson(numberParam(route, "page", 1));
}

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
  const plain = (status, words) => send(response, status, "text/plain; charset=utf-8", `${words}\n`, headers);
  const host = (request.headers.host ?? "").toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    plain(403, `This page answers only at http://127.0.0.1:${port}/ on this computer.`);
    return;
  }
  if (request.method !== "GET") {
    send(response, 405, "text/plain; charset=utf-8", "This page takes only GET.\n", { ...headers, Allow: "GET" });
    return;
  }
  let body;
  try {
    const route = routeOf(request.url ?? "");
    if (route === null) {
      plain(404, NOT_FOUND);
      return;
    }
    if (route.path === "/") {
      if (route.params.size > 0) throw new Refusal(400, TAKES["/"]);
      send(response, 200, "text/html; charset=utf-8", pageHtml(nonce), headers);
      return;
    }
    body = dataText(route, data);
  } catch (error) {
    if (error instanceof Refusal) {
      plain(error.status, error.message);
      return;
    }
    // The page shows the reason (for example a machine that was removed) and reads again 5 seconds later.
    console.error(error);
    plain(500, maskSecrets(error.message));
    return;
  }
  send(response, 200, "application/json; charset=utf-8", body, headers);
}

// The page's server for `machine`, listening on 127.0.0.1 at `port` (0: a free port). `now` gives the time (ms).
export function startPageServer({ machine, env, port, now = Date.now }) {
  const data = new PageData({ machine, env, now });
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
// seconds, and the route of the part that the person opened, and writes each value with textContent, never as HTML.
// ---------------------------------------------------------------------------------------------------------------------

const STYLE = String.raw`
:root { color-scheme: light dark;
  --bg: #f5f6f8; --surface: #ffffff; --sunken: #f7f8fa; --text: #1b1f24; --muted: #59626e; --line: #e1e4e8; --line-strong: #c8cdd4;
  --accent: #2357c4; --accent-bg: #e8effc; --on-accent: #ffffff;
  --ok: #17733a; --ok-bg: #e3f3e8; --info: #1d58b5; --info-bg: #e6eefb; --warn: #8a5300; --warn-bg: #fcf0d8;
  --bad: #b42318; --bad-bg: #fdeceb; --gray: #555e69; --gray-bg: #eceff2;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0e1116; --surface: #161b22; --sunken: #12161c; --text: #e6e9ed; --muted: #9da7b3; --line: #29303a; --line-strong: #3b4450;
    --accent: #80a8ff; --accent-bg: #1a2949; --on-accent: #0e1116;
    --ok: #63d18f; --ok-bg: #12301f; --info: #8db4ff; --info-bg: #172a4a; --warn: #f3bb57; --warn-bg: #34270f;
    --bad: #ff8f85; --bad-bg: #3b1815; --gray: #b3bbc5; --gray-bg: #232a33; }
}
* { box-sizing: border-box; }
/* The script keeps the row that the person reads in its place after each new read; the browser must not move it too. */
html, body { overflow-anchor: none; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
button, input, select { font: inherit; color: inherit; }
button { cursor: pointer; }
button:disabled { cursor: default; opacity: 0.45; }
a { color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* The list and the tab strip cut what is outside them: the ring of a row and of a tab is inside. */
.row-head:focus-visible, .tab:focus-visible { outline-offset: -2px; }
.wrap { max-width: 1100px; margin: 0 auto; padding: 0 16px; }
p { margin: 6px 0; }
.muted { color: var(--muted); }
/* A request's id does not break at its hyphen. */
.nowrap { white-space: nowrap; }
.note { color: var(--muted); font-size: 13px; }

/* Header */
.top { background: var(--surface); border-bottom: 1px solid var(--line); }
.top .wrap { padding-top: 16px; padding-bottom: 14px; }
.bar { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 16px; }
.brand { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; min-width: 0; }
.kind { color: var(--muted); font-size: 13px; }
h1 { margin: 0; font-size: 21px; line-height: 1.3; overflow-wrap: anywhere; }
.updated { color: var(--muted); font-size: 12.5px; }
.status { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin-top: 10px; }
.state-words { color: var(--muted); }
ul.facts-line { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-wrap: wrap; row-gap: 4px; color: var(--muted); font-size: 13px; }
ul.facts-line li { white-space: nowrap; }
ul.facts-line li + li::before { content: "\00b7"; margin: 0 8px; color: var(--line-strong); }
ul.facts-line li.flag span { color: var(--warn); background: var(--warn-bg); font-weight: 600; border-radius: 5px; padding: 1px 7px; }
@media (max-width: 520px) { ul.facts-line { column-gap: 14px; } ul.facts-line li + li::before { content: none; } }

/* Pills */
.pill { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; border-radius: 999px; padding: 0 9px 0 8px;
  font-size: 12.5px; font-weight: 600; line-height: 22px; white-space: nowrap; color: var(--gray); background: var(--gray-bg); }
.pill::before { content: ""; flex: none; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.pill > span { overflow: hidden; text-overflow: ellipsis; }
.pill.ok { color: var(--ok); background: var(--ok-bg); }
.pill.info { color: var(--info); background: var(--info-bg); }
.pill.warn { color: var(--warn); background: var(--warn-bg); }
.pill.bad { color: var(--bad); background: var(--bad-bg); }
.pill.big { font-size: 14px; line-height: 28px; padding: 0 13px 0 11px; }
.pill.live::before { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .pill.live::before { animation: none; } }

main { padding: 4px 0 8px; }
#content.stale { opacity: 0.55; }
.problem { position: sticky; top: 0; z-index: 2; margin: 12px 0 0; background: var(--bad-bg); color: var(--bad); border: 1px solid currentColor; border-radius: 8px; padding: 10px 12px; }
h2.section-title { margin: 22px 0 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
h3 { margin: 0; font-size: 14.5px; }
h4 { margin: 16px 0 6px; font-size: 13px; font-weight: 700; color: var(--muted); }
.mono { font-family: var(--mono); font-size: 13px; }

/* Needs attention */
.attention { display: grid; gap: 10px; }
.alert { background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--warn); border-radius: 10px; padding: 12px 14px; }
.alert.bad { border-left-color: var(--bad); }
.alert-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; }
.alert ul { margin: 6px 0 0; padding-left: 18px; }

/* Cards and texts */
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
.now-card { border-left: 4px solid var(--info); }
.now-card + .now-card { margin-top: 10px; }
.card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.card-head .grow { flex: 1 1 auto; }
.idle { margin: 0; background: var(--surface); border: 1px dashed var(--line-strong); border-radius: 12px; padding: 14px 16px; color: var(--muted); }
.empty { background: var(--surface); border: 1px dashed var(--line-strong); border-radius: 12px; padding: 16px; color: var(--muted); }
.text, .summary, .bubble { white-space: pre-wrap; overflow-wrap: anywhere; }
.text { margin: 10px 0 4px; }
.summary { margin: 6px 0; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.bubble { display: block; margin-top: 4px; background: var(--warn-bg); border-radius: 8px; padding: 8px 10px; }
li.event-answer .bubble { background: var(--ok-bg); }
.clamped { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
.lines-3 { -webkit-line-clamp: 3; }
.lines-6 { -webkit-line-clamp: 6; }
.lines-10 { -webkit-line-clamp: 10; }
.more { margin: 2px 0 0; padding: 0; border: 0; background: none; color: var(--accent); font-size: 13px; font-weight: 600; }
.button { border: 1px solid var(--line-strong); background: var(--surface); border-radius: 8px; padding: 3px 11px; font-size: 13px; font-weight: 600; white-space: nowrap; }
.button:hover { border-color: var(--accent); color: var(--accent); }

/* Tabs and the tool bar */
.tabs { display: flex; gap: 2px; margin: 26px 0 14px; border-bottom: 1px solid var(--line); overflow-x: auto; }
.tab { display: inline-flex; align-items: center; gap: 7px; margin-bottom: -1px; padding: 8px 12px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--muted); font-weight: 600; white-space: nowrap; }
.tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
.tab .count { border-radius: 999px; padding: 0 7px; background: var(--gray-bg); color: var(--gray); font-size: 12px; line-height: 19px; }
/* On a phone the three tabs share the width, each with its count under its name, so that no tab is cut. */
@media (max-width: 520px) {
  .tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; overflow: visible; }
  .tab { flex-direction: column; gap: 2px; padding: 6px 4px 7px; white-space: normal; text-align: center; }
}
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 10px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 1px solid var(--line-strong); background: var(--surface); border-radius: 999px; padding: 2px 10px; font-size: 13px; }
.chip .count { color: var(--muted); margin-left: 4px; }
.chip[aria-pressed="true"] { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); }
.search { flex: 1 1 220px; min-width: 0; border: 1px solid var(--line-strong); border-radius: 8px; padding: 5px 10px; background: var(--surface); }
.size { display: inline-flex; align-items: center; color: var(--muted); font-size: 13px; }
.size > span { margin-right: 8px; }
.size button { min-width: 36px; height: 30px; padding: 0 8px; border: 1px solid var(--line-strong); background: var(--surface); font-size: 13px; }
.size button + button { margin-left: -1px; }
.size button:first-of-type { border-radius: 8px 0 0 8px; }
.size button:last-of-type { border-radius: 0 8px 8px 0; }
.size button[aria-pressed="true"] { position: relative; background: var(--accent-bg); border-color: var(--accent); color: var(--accent); font-weight: 700; }
.size button:focus-visible { position: relative; z-index: 1; }

/* Lists of requests and sessions */
.rows { list-style: none; margin: 0; padding: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.rows > li + li { border-top: 1px solid var(--line); }
.row-head { display: grid; align-items: center; gap: 12px; width: 100%; margin: 0; padding: 10px 14px; border: 0; background: none; text-align: left; scroll-margin-top: 16px; }
.request-head { grid-template-columns: 178px 82px minmax(0, 0.85fr) minmax(0, 2.4fr) 74px 66px; }
.session-head { grid-template-columns: 132px 84px minmax(0, 1.9fr) minmax(0, 1.5fr) 96px; }
.row-head:hover { background: var(--sunken); }
.row.open > .row-head { background: var(--accent-bg); }
.row-head > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-id { font-family: var(--mono); font-size: 13px; }
.c-asker, .c-when, .c-took, .c-how { color: var(--muted); font-size: 13px; }
.c-when, .c-took, .c-count { text-align: right; font-variant-numeric: tabular-nums; }
.row-body { padding: 6px 16px 18px; border-top: 1px solid var(--line); background: var(--sunken); }
@media (max-width: 720px) {
  .request-head { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "status id when" "text text text" "asker asker took"; gap: 4px 10px; }
  .request-head .c-status { grid-area: status; } .request-head .c-id { grid-area: id; } .request-head .c-when { grid-area: when; }
  .request-head .c-text { grid-area: text; white-space: normal; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .request-head .c-asker { grid-area: asker; } .request-head .c-took { grid-area: took; }
  .session-head { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "status id count" "time time time" "how how how"; gap: 4px 10px; }
  .session-head .c-status { grid-area: status; } .session-head .c-id { grid-area: id; } .session-head .c-count { grid-area: count; }
  .session-head .c-time { grid-area: time; } .session-head .c-how { grid-area: how; }
  .row-body { padding: 6px 12px 16px; }
}

/* Pages */
.pager { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 12px 0 0; }
.pager button { min-width: 32px; height: 30px; padding: 0 9px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); font-size: 13px; }
.pager button[aria-current="page"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 700; }
.pager .gap { color: var(--muted); padding: 0 2px; }
.pager .range { margin-left: auto; color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }

/* The details of a request or a session */
dl.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 16px; margin: 10px 0; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 520px) { dl.facts { grid-template-columns: minmax(0, 1fr); gap: 0; } dl.facts dd { margin-bottom: 6px; } }
.callout { background: var(--warn-bg); border-radius: 8px; padding: 8px 12px; }
ol.timeline, ol.steps { list-style: none; padding: 0; margin: 6px 0; }
ol.timeline > li, ol.steps > li { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 2px 12px; padding: 6px 0; border-top: 1px solid var(--line); }
ol.timeline > li:first-child, ol.steps > li:first-child { border-top: 0; }
.time { color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.what { font-weight: 600; margin-right: 8px; }
.words { overflow-wrap: anywhere; }
li.event-refused .what, li.denied .what { color: var(--bad); }
li.said .words { font-style: italic; }
.detail { display: block; margin-top: 2px; font: 12px/1.45 var(--mono); color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 520px) { ol.timeline > li, ol.steps > li { grid-template-columns: minmax(0, 1fr); } }
.result { margin-top: 14px; padding-top: 2px; border-top: 1px solid var(--line); }
/* A fixed first column: a long value without spaces wraps in its own column and leaves the name its words. */
table { table-layout: fixed; border-collapse: collapse; width: 100%; margin: 6px 0; font-size: 13.5px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
th:first-child, td:first-child { width: 36%; overflow-wrap: break-word; }
th { color: var(--muted); font-weight: 600; }
ul.files { margin: 4px 0; padding-left: 18px; }
ul.files li { overflow-wrap: anywhere; }
details.fold { margin-top: 14px; }
details.fold > summary { cursor: pointer; color: var(--accent); font-weight: 600; }
pre.log { height: 420px; overflow: auto; margin: 0; padding: 12px 14px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
  font: 12.5px/1.6 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 520px) { pre.log { height: 340px; } }
ol.lines { list-style: none; padding: 0; margin: 6px 0; }
ol.lines > li { padding: 5px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
ol.lines > li:first-child { border-top: 0; }

footer.foot { margin: 28px 0 32px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12.5px; }
`;

const SCRIPT = String.raw`
"use strict";
const REQUEST_ID = /^CA-[0-9A-Z]{6}$/;
const SESSION_REF = ${SESSION_REF};
const PAGE_SIZES = [10, 25, 50];
const STEP_PAGE = 50;
const NOW_LINES = 4;
const EXPIRED = ${JSON.stringify(EXPIRED)};
// Where this tab keeps the search's words through a reload (the address does not hold them).
const SEARCH_KEY = "doable-code-agent-search";
const TABS = [["requests", "Requests"], ["sessions", "Sessions"], ["log", "Service log"]];
// The serving session's state: the pill, its color, and what it means.
const SERVING = {
  working: ["Working", "info", "It works on a request now."],
  "waiting for an answer": ["Waiting for an answer", "warn", "Its request waits for the asker's answer."],
  serving: ["Serving", "ok", "It runs and waits for Doable's requests."],
  "cannot reach Doable": ["Cannot reach Doable", "bad", "Its waits for a request fail, so it gets no request. It tries again."],
  starting: ["Starting", "info", "The session started and has not waited for a request yet."],
  "no log": ["No log yet", "muted", "The serving session has not written anything on this computer. When it runs, its steps show here."],
  "cannot start": ["Cannot start", "bad", "The session ended before it waited for a request, or wrote only errors."],
  "plan limit": ["Plan limit reached", "warn", "The session stopped at the plan limit. The start script starts a new session 5 minutes after one ends."],
  "between sessions": ["Between sessions", "muted", "The start script starts a new session 5 minutes after one ends, or 30 minutes after one that Doable asked for a plugin that this computer does not run."],
  stopped: ["Stopped", "muted", "Someone ran stop. It serves no request until someone runs start."],
  "not running": ["Not running", "bad", "It is set up, but it does not run. Run start to turn it on."],
};
const SELF_UPDATE = {
  on: "Self-update is on: when Doable asks for a newer plugin, the session ends, and the start script updates the plugin with Claude Code and starts the new release. It updates at no other time. The service's log below shows each ask, each update and each failure.",
  off: "Self-update is off: when Doable asks for a newer plugin, each session ends at its first wait for a request, and the next one starts 30 minutes later, until a person updates the plugin on this computer.",
  "development folder": "Self-update is off: the session loads the plugin from a development folder. When Doable asks for a newer plugin, each session ends at its first wait for a request, and the next one starts 30 minutes later, until a person updates that folder.",
};
const SELF_UPDATE_SHORT = { on: "Self-update on", off: "Self-update off", "development folder": "Self-update off (development folder)" };
// What a person does about Doable's ask for a newer plugin, by the choice of self-update.
const ASKED_WORDS = {
  on: "This computer still runs an older release. After each session that gets the ask, the start script updates the plugin. If the update fails, a person must act (README, “Self-update”): the Service log tab shows each step and each failure.",
  off: "Self-update is off: a person must update the plugin, then run stop and start (README, “Self-update”). Until then, each session ends at its first wait for a request, and the next session starts in 30 minutes.",
  "development folder": "The session loads the plugin from a development folder: a person must update that folder, then run stop and start (README, “Self-update”). Until then, each session ends at its first wait for a request, and the next session starts in 30 minutes.",
};
// Each status of a request: its pill, its color, and its group of the filter.
const STATUS = {
  working: ["Working", "info", "open"],
  "waiting for an answer": ["Waiting for an answer", "warn", "open"],
  "waiting for an answer; no session serves it": ["Waiting, no session", "warn", "open"],
  done: ["Done", "ok", "done"],
  failed: ["Failed", "bad", "failed"],
  "timed out": ["Timed out", "bad", "failed"],
  lost: ["Lost", "bad", "failed"],
  declined: ["Declined", "muted", "declined"],
  cancelled: ["Cancelled", "muted", "other"],
  "left when its session ended": ["Left unfinished", "muted", "other"],
  "given back to the queue": ["Back in the queue", "muted", "other"],
  "taken by another machine": ["Another machine", "muted", "other"],
  expired: ["Expired", "muted", "other"],
  [EXPIRED]: ["Probably expired", "muted", "other"],
};
const FILTERS = [
  ["all", "All", "Every request"],
  ["open", "Open", "Working, or waiting for an answer"],
  ["done", "Done", "Done"],
  ["failed", "Failed", "Failed, timed out or lost"],
  ["declined", "Declined", "Declined"],
  ["other", "Other", "Cancelled, left unfinished when its session ended, given back to the queue, taken by another machine, expired, or probably expired (no answer in 24 hours)"],
];
const EVENT_LABEL = { taken: "The session took it", "taken again": "The session took it again", progress: "Progress",
  question: "Question to the asker", answer: "Answer from the asker", result: "Result sent",
  "result not kept": "Result sent: Doable did not keep it" };
const WHAT = { progress: "progress", question: "question", result: "result", check: "check for an answer",
  "read of the test inbox": "read of the test inbox", "wait for a request": "wait for a request" };
const PLAN_WORDS = { rejected: "reached", allowed_warning: "near the limit" };

const problem = document.getElementById("problem");
const updated = document.getElementById("updated");
const content = document.getElementById("content");
const statusBox = document.getElementById("status");
const title = document.getElementById("title");

// Where the person is: the tab, and the place in each tab. The address keeps it (#requests&page=2), but not the search's
// words (setSearch). The session is the id of the open session (SESSION_REF).
const place = { tab: "requests", page: 1, size: 10, filter: "all", q: "", open: null, sessionsPage: 1, session: null, logPage: 1 };
// The answers of the last reads. The search holds the words of the last search on the server and the ids that it found;
// sessionsAsked says which page of the sessions the answer in sessions was asked for.
const got = { data: null, requests: new Map(), sessions: null, sessionsAsked: null, sessionDetails: new Map(), log: null, search: null };
// The texts, lists and folds that the person opened, and the page of each list of steps.
const opened = new Set();
const stepPages = new Map();
let lastText = null;
let readAt = null;
let holding = false;
let reads = 0;
// The rows and cards of the last render (each with a key), the times that change each second, the elements that can
// have the focus (each with a key), and the box of service.log.
let anchors = [];
let live = [];
let focusables = new Map();
let logBox = null;
let listBox = null;
// Whether the page has rendered once: the first render shows the line that the address opened (after a reload).
let rendered = false;
// The day of the last render: a time of today shows no date, so the page renders again after midnight.
let renderedDay = null;
// The search box stays the same element, so that typing in it goes on while the page renders again.
const search = el("input", "search");
search.type = "search";
search.placeholder = "Search";
search.setAttribute("aria-label", "Search the requests by id, asker or text");
search.addEventListener("input", () => {
  setSearch(search.value);
  place.page = 1;
  place.open = null;
  writePlace();
  renderList();
  // The server searches the whole text of each request; the list here has only its start.
  if (place.q.trim()) load();
});

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
function attr(node, name, value) {
  node.setAttribute(name, String(value));
  return node;
}
function focusable(node, key) {
  node.dataset.focus = key;
  focusables.set(key, node);
  return node;
}
function button(className, text, onClick, key) {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return key ? focusable(node, key) : node;
}
function anchor(node, key) {
  node.dataset.key = key;
  anchors.push(node);
  return node;
}
function count(number, one, many) {
  return number + " " + (number === 1 ? one : many);
}
function number(value) {
  return Number(value).toLocaleString();
}

// Times: the exact time with its time zone (in titles and facts), how long ago, and a time of day.
function when(iso) {
  if (!iso) return "unknown";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "long" });
}
function span(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + " s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " min";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " h" + (m % 60 ? " " + (m % 60) + " min" : "");
  const d = Math.floor(h / 24);
  return d + " d" + (h % 24 ? " " + (h % 24) + " h" : "");
}
function ago(iso) {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "unknown";
  const ms = Date.now() - at;
  if (ms < 0) return "in " + span(-ms);
  if (ms >= 7 * 86400000) return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return span(ms).replace(/ \d+ (min|h)$/, "") + " ago";
}
function lasting(iso) {
  return "for " + span(Date.now() - Date.parse(iso));
}
// A time of today, or a day and a time, with the time zone: the Service log tab's times are UTC.
function clock(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" })
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}
// A time that the page writes again each second.
function liveTime(iso, format, className) {
  const node = el("span", className || null, format(iso));
  node.title = when(iso);
  live.push([node, iso, format]);
  return node;
}
function timeOf(iso) {
  const node = el("span", "time", clock(iso));
  node.title = when(iso);
  return node;
}

function pill(label, tone, titleText, big) {
  const node = el("span", "pill " + (tone || "muted") + (big ? " big" : ""));
  add(node, el("span", null, label));
  if (titleText) node.title = titleText;
  return node;
}
function statusOf(status) {
  return STATUS[status] || [status.charAt(0).toUpperCase() + status.slice(1), "muted", "other"];
}
function statusPill(status) {
  const [label, tone] = statusOf(status);
  return pill(label, tone, status);
}
function link(url, text, key) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  const node = focusable(el("a", null, text), key);
  node.href = url;
  node.target = "_blank";
  node.rel = "noopener noreferrer";
  return node;
}
// A text in which each request id is one piece: it does not break at the id's hyphen.
function withIds(tag, className, text) {
  const node = el(tag, className);
  let at = 0;
  for (const match of text.matchAll(/CA-[0-9A-Z]{6}/g)) {
    if (match.index > at) add(node, el("span", null, text.slice(at, match.index)));
    add(node, el("span", "nowrap", match[0]));
    at = match.index + match[0].length;
  }
  if (at < text.length) add(node, el("span", null, text.slice(at)));
  return node;
}
function firstLine(text) {
  if (!text) return "(its text is not in the logs)";
  return text.split("\n").map((line) => line.trim()).find(Boolean) || "";
}
function askerShort(row) {
  if (row.askedBy === "chat") return row.suite ? "Chat: " + row.suite : "A Doable chat";
  if (row.askedBy === "claude_code") return row.askedByUser || "Claude Code, organization key";
  return "Asker not in the logs";
}
function askerWords(request) {
  const box = el("span");
  if (request.askedBy === "chat") {
    let words = "Asked from a Doable chat";
    if (request.suite) words += " of the suite “" + request.suite + "”";
    if (request.environment) words += ", environment “" + request.environment + "”";
    add(box, el("span", null, words + ". "), link(request.chatUrl, "Open the chat", "chat:" + request.id));
  } else if (request.askedBy === "claude_code") {
    add(box, el("span", null, request.askedByUser ? "Asked by " + request.askedByUser + " from their Claude Code." : "Asked from a person's Claude Code with an organization API key, which names no person."));
  } else add(box, el("span", "muted", "The asker is not in the logs."));
  return box;
}

// A long text shows its first lines, with "Show more".
function clamped(key, text, className, lines) {
  const long = text.length > lines * 110 || text.split("\n").length > lines;
  if (!long) return el("div", className, text);
  const open = opened.has(key);
  // The box keeps its padding; the text in it is cut at a whole line.
  const body = add(el("div", className), el("div", open ? null : "clamped lines-" + lines, text));
  const toggle = button("more", open ? "Show less" : "Show more", () => flip(key), "more:" + key);
  attr(toggle, "aria-expanded", open);
  return add(el("div"), body, toggle);
}
function flip(key) {
  if (opened.has(key)) opened.delete(key);
  else opened.add(key);
  render();
}
function folded(key, summary, body) {
  const box = el("details", "fold");
  add(box, focusable(el("summary", null, summary), "fold:" + key), body);
  box.open = opened.has(key);
  box.addEventListener("toggle", () => {
    if (box.open) opened.add(key);
    else opened.delete(key);
  });
  return box;
}
function facts(rows) {
  const list = el("dl", "facts");
  for (const [name, value] of rows) {
    if (value === null || value === undefined || value === "") continue;
    add(list, el("dt", null, name), typeof value === "string" ? el("dd", null, value) : add(el("dd"), value));
  }
  return list;
}
function table(headings, rows) {
  const box = el("table");
  add(box, add(el("thead"), add(el("tr"), ...headings.map((heading) => el("th", null, heading)))));
  const body = add(box, el("tbody")).lastChild;
  for (const row of rows) add(body, add(el("tr"), ...row.map((cell) => el("td", null, cell === null ? "" : cell))));
  return box;
}

// Pages: Previous, the page numbers (the first, the last, and the ones next to this one), Next, and "11–20 of 134".
function pageNumbers(page, pages) {
  const list = [];
  let before = 0;
  for (let n = 1; n <= pages; n += 1) {
    if (n !== 1 && n !== pages && Math.abs(n - page) > 1) continue;
    if (n - before > 1) list.push(null);
    list.push(n);
    before = n;
  }
  return list;
}
function pager(total, page, size, goTo, label, key) {
  const pages = Math.max(1, Math.ceil(total / size));
  const nav = attr(el("nav", "pager"), "aria-label", label);
  if (pages > 1) {
    const previous = button(null, "Previous", () => goTo(page - 1), key + ":previous");
    previous.disabled = page <= 1;
    add(nav, previous);
    for (const n of pageNumbers(page, pages)) {
      if (n === null) {
        add(nav, el("span", "gap", "…"));
        continue;
      }
      const item = attr(button(null, String(n), () => goTo(n), key + ":" + n), "aria-label", "Page " + n);
      if (n === page) attr(item, "aria-current", "page");
      add(nav, item);
    }
    const next = button(null, "Next", () => goTo(page + 1), key + ":next");
    next.disabled = page >= pages;
    add(nav, next);
  }
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  add(nav, el("span", "range", number(from) + "–" + number(Math.min(total, page * size)) + " of " + number(total)));
  return nav;
}

// ---------------------------------------------------------------------------------------------------------------------
// The address: #requests&page=2&size=25&filter=done&open=CA-AB12CD, #sessions&page=1&open=<a session's id>, #log&page=2
// ---------------------------------------------------------------------------------------------------------------------

// The search's words stay out of the address: the browser's history would keep each word that the person types. This
// tab's session storage keeps them through a reload.
function setSearch(q) {
  place.q = q;
  if (search.value !== q) search.value = q;
  try {
    if (q) window.sessionStorage.setItem(SEARCH_KEY, q);
    else window.sessionStorage.removeItem(SEARCH_KEY);
  } catch {
    // A browser that refuses the storage (a private window, blocked site data): the search lasts until a reload.
  }
}
function storedSearch() {
  try {
    return window.sessionStorage.getItem(SEARCH_KEY) || "";
  } catch {
    // The same refusal: a reload starts with no search.
    return "";
  }
}
function decoded(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    // A person can type any address: a value that cannot be decoded counts as not given.
    return "";
  }
}
function wholeNumber(value, fallback) {
  return /^[1-9]\d{0,8}$/.test(value || "") ? Number(value) : fallback;
}
function readPlace() {
  const parts = window.location.hash.replace(/^#/, "").split("&").filter(Boolean);
  const tab = parts.length && !parts[0].includes("=") ? parts.shift() : "requests";
  const values = {};
  for (const part of parts) {
    const at = part.indexOf("=");
    if (at > 0) values[part.slice(0, at)] = decoded(part.slice(at + 1));
  }
  place.tab = TABS.some(([key]) => key === tab) ? tab : "requests";
  // The size of a page changes only with an address that holds one.
  if (PAGE_SIZES.includes(Number(values.size))) place.size = Number(values.size);
  setSearch(storedSearch());
  if (place.tab === "requests") {
    place.page = wholeNumber(values.page, 1);
    place.filter = FILTERS.some(([key]) => key === values.filter) ? values.filter : "all";
    place.open = REQUEST_ID.test(values.open || "") ? values.open : null;
  } else if (place.tab === "sessions") {
    place.sessionsPage = wholeNumber(values.page, 1);
    place.session = SESSION_REF.test(values.open || "") ? values.open : null;
  } else place.logPage = wholeNumber(values.page, 1);
}
function writePlace() {
  const parts = [place.tab];
  const put = (name, value, plain) => {
    if (value !== plain && value !== null && value !== "") parts.push(name + "=" + encodeURIComponent(value));
  };
  if (place.tab === "requests") {
    put("page", place.page, 1);
    put("size", place.size, 10);
    put("filter", place.filter, "all");
    put("open", place.open, null);
  } else if (place.tab === "sessions") {
    put("page", place.sessionsPage, 1);
    put("size", place.size, 10);
    put("open", place.session, null);
  } else {
    put("page", place.logPage, 1);
    put("size", place.size, 10);
  }
  window.history.replaceState(null, "", "#" + parts.join("&"));
}
// A change of place: the page renders at once from what it has, then reads the part that the person opened.
function go(change, focusKey) {
  Object.assign(place, change);
  writePlace();
  render(focusKey);
  load();
}
// Opens a request's line in the Requests tab, from the "Needs attention" part or "Now". The list shows the page that
// holds the open line (fillList).
function openRequest(id) {
  const row = got.data.requests.find((item) => item.id === id);
  if (row && !matches(row)) {
    place.filter = "all";
    setSearch("");
  }
  go({ tab: "requests", open: id }, "row:" + id);
}

// ---------------------------------------------------------------------------------------------------------------------
// The header: the machine, the session's state and a few facts
// ---------------------------------------------------------------------------------------------------------------------
function planWords(limit) {
  if (!limit) return null;
  return (PLAN_WORDS[limit.status] || limit.status.replaceAll("_", " ")) + (limit.resetsAt ? "; it resets at " + when(limit.resetsAt) : "");
}
function renderHeader(data) {
  document.title = "Doable code agent “" + data.machine + "”";
  title.textContent = data.machine;
  const serving = data.serving;
  const [label, tone, words] = SERVING[serving.state] || [serving.state, "muted", ""];
  const state = serving.state === "working" ? "Working on " + serving.requestId : serving.state === "waiting for an answer" ? "Waiting for an answer on " + serving.requestId : label;
  const statePill = pill(state, tone, null, true);
  if (serving.state === "working") statePill.className += " live";
  const head = add(el("div", "status"), statePill, el("span", "state-words", words));
  const line = el("ul", "facts-line");
  const fact = (text, at, titleText) => {
    const item = add(el("li"), el("span", null, text));
    if (at) add(item, liveTime(at, ago));
    if (titleText) item.title = titleText;
    add(line, item);
    return item;
  };
  const session = data.session;
  if (session) {
    if (session.running && session.startedAt) fact("Session started ", session.startedAt);
    else if (session.endedAt) fact("Last session ended ", session.endedAt);
  }
  if (data.service.lastActivity) fact("Last activity ", data.service.lastActivity);
  fact(SELF_UPDATE_SHORT[data.service.selfUpdate] || "Self-update: " + data.service.selfUpdate, null, SELF_UPDATE[data.service.selfUpdate]);
  if (data.service.askedUpdate) {
    const asked = data.service.askedUpdate;
    add(line, add(attr(el("li", "flag"), "title", "Doable asked for the plugin " + asked.version + " at " + when(asked.at) + "."), el("span", null, "Doable asks for " + asked.version)));
  }
  if (session && session.planLimit) {
    const limit = session.planLimit;
    const item = fact(limit.status === "rejected" ? "Plan limit reached" : limit.status === "allowed_warning" ? "Near the plan limit" : "Plan limit: " + limit.status.replaceAll("_", " "), null, "Plan limit " + planWords(limit));
    if (limit.resetsAt) add(item, el("span", null, ", it resets "), liveTime(limit.resetsAt, ago));
  }
  statusBox.replaceChildren(head, line);
}

// ---------------------------------------------------------------------------------------------------------------------
// What needs a person
// ---------------------------------------------------------------------------------------------------------------------
function needItem(key, tone, heading, action) {
  const box = anchor(el("div", "alert" + (tone === "bad" ? " bad" : "")), key);
  attr(box, "role", "group");
  add(box, add(el("div", "alert-head"), withIds("h3", null, heading), action));
  return box;
}
// The lines of failed calls: the time, what the call was, and Doable's words.
function failedList(calls) {
  const list = el("ul");
  for (const call of calls) add(list, add(el("li"), timeOf(call.at), el("span", null, " The " + (WHAT[call.what] || call.what) + ": "), el("span", "words", call.text)));
  return list;
}
function openButton(id) {
  return button("button", "Open " + id, () => openRequest(id), "open:" + id);
}
function doableWords(servers) {
  if (!servers || servers.length === 0) return "No Doable MCP server in this session";
  return servers.map((server) => (server.status === "connected" ? "connected" : "not connected (" + (server.status || "no status") + ")") + " — " + server.name).join("; ");
}
function modeWords(mode) {
  if (!mode) return null;
  return mode === "bypassPermissions" ? mode + " (no permission check)" : mode + " (not the bypass mode: with nobody at the terminal it cannot do the work)";
}
function renderAttention(data) {
  const items = [];
  const serving = data.serving;
  const session = data.session;
  if (serving.state === "cannot start") {
    const box = needItem("attention:start", "bad", "The session cannot start");
    if (session && !session.running && !session.waited && session.ending) add(box, el("p", null, session.ending));
    if (serving.lines.length) add(box, el("p", "note", "The last lines of its output that are not events:"), el("div", "detail", serving.lines.join("\n")));
    else add(box, el("p", "note", "Its output has no line that says why. The Service log tab shows what the start script saw."));
    items.push(box);
  }
  if (session && session.running && session.failedWaits > 0) {
    // The waits that failed since the last one that worked are the newest waits in the session's failed calls.
    const waits = session.failedCalls.filter((call) => call.what === "wait for a request").slice(-Math.min(3, session.failedWaits));
    const box = needItem("attention:waits", "bad", "The session cannot reach Doable");
    add(box, el("p", null, count(session.failedWaits, "wait for a request has", "waits for a request have") + " failed since the last one that worked. The session tries again, and it gets no request until a wait works."));
    if (waits.length) add(box, failedList(waits));
    if (session.failedWaits > waits.length) add(box, el("p", "note", "The Sessions tab shows up to 20 failed calls of the session."));
    items.push(box);
  }
  for (const row of data.requests) {
    if (!row.status.startsWith("waiting for an answer")) continue;
    const box = needItem("attention:" + row.id, "warn", row.id + " waits for an answer", openButton(row.id));
    const taken = row.servedAt || row.takenAt;
    const words = askerShort(row) + (row.status === "waiting for an answer" ? "" : ". No session serves it now");
    add(box, add(el("p", "note"), el("span", null, words + (taken ? ". Taken " : ".")), taken ? liveTime(taken, ago) : null, taken ? el("span", null, ".") : null));
    if (row.question) add(box, clamped("question:" + row.id, row.question, "bubble", 3));
    items.push(box);
  }
  if (data.service.askedUpdate) {
    const asked = data.service.askedUpdate;
    const box = needItem("attention:update", "warn", "Doable asked for the plugin " + asked.version);
    add(box, el("p", null, ASKED_WORDS[data.service.selfUpdate] || ""), el("p", "note", "Asked " + when(asked.at) + "."));
    items.push(box);
  }
  for (const request of data.now) {
    const refused = request.events.filter((event) => event.kind === "refused");
    if (!refused.length) continue;
    const box = needItem("attention:refused:" + request.id, "bad", "Doable did not take " + count(refused.length, "call", "calls") + " of " + request.id, openButton(request.id));
    add(box, failedList(refused.slice(-3)));
    if (refused.length > 3) add(box, el("p", "note", count(refused.length - 3, "earlier one is", "earlier ones are") + " in its details."));
    items.push(box);
  }
  if (session && session.running) {
    if (session.permissionMode && session.permissionMode !== "bypassPermissions") {
      items.push(add(needItem("attention:mode", "bad", "The session does not run in the bypass mode"), el("p", null, modeWords(session.permissionMode))));
    }
    if (!session.doableServers.some((server) => server.status === "connected")) {
      items.push(add(needItem("attention:doable", "bad", "Doable MCP was not connected at the session's start"), el("p", null, doableWords(session.doableServers))));
    }
  }
  if (!items.length) return null;
  const box = attr(el("section", "attention-part"), "aria-label", "Needs attention");
  return add(box, el("h2", "section-title", "Needs attention"), add(el("div", "attention"), ...items));
}

// ---------------------------------------------------------------------------------------------------------------------
// Now: the request in progress
// ---------------------------------------------------------------------------------------------------------------------
function toolLabel(name) {
  const match = /^mcp__(.+?)__(.+)$/.exec(name || "");
  return match ? match[2] + " (" + match[1] + ")" : name || "a tool";
}
function stepItem(step) {
  const item = el("li", step.kind === "text" ? "said" : step.kind === "denied" ? "denied" : null);
  add(item, step.at ? timeOf(step.at) : el("span", "time", ""));
  const body = add(item, el("div")).lastChild;
  if (step.kind === "text") add(body, el("span", "what", "Wrote"), el("span", "words", step.text));
  else if (step.kind === "denied") add(body, el("span", "what", "Claude Code refused " + (step.tool || "a tool")), el("span", "words", step.text));
  else {
    add(body, el("span", "what", toolLabel(step.tool)), step.target ? el("span", "words", step.target) : null);
    if (step.failed) add(body, el("span", null, " "), pill("failed", "bad"));
    if (step.detail) add(body, el("code", "detail", step.detail));
  }
  return item;
}
function eventItem(event) {
  // A class of its own for each kind of line ("result" is also the class of the result's box).
  const item = el("li", "event-" + event.kind.replace(/ /g, "-"));
  add(item, timeOf(event.at));
  const body = add(item, el("div")).lastChild;
  const label = event.kind === "refused" ? "Doable did not take the " + (WHAT[event.what] || event.what) : EVENT_LABEL[event.kind] || event.kind;
  add(body, el("span", "what", label));
  if (event.text) add(body, event.kind === "question" || event.kind === "answer" ? el("span", "bubble", event.text) : el("span", "words", event.text));
  return item;
}
// The request's last question and the answer that came after it, if any.
function questionAndAnswer(events) {
  const at = events.findLastIndex((event) => event.kind === "question");
  if (at < 0) return [];
  const answer = events.slice(at + 1).find((event) => event.kind === "answer");
  return answer ? [events[at], answer] : [events[at]];
}
function nowCard(request) {
  const card = anchor(el("article", "card now-card"), "now:" + request.id);
  add(card, add(el("div", "card-head"), statusPill(request.status), el("strong", "mono nowrap", request.id), el("span", "muted", askerShort(request)),
    request.servedAt ? liveTime(request.servedAt, lasting, "muted") : null, el("span", "grow"),
    button("button", "Details", () => openRequest(request.id), "details:" + request.id)));
  if (request.text) add(card, clamped("now-text:" + request.id, request.text, "text", 3));
  // The question and its answer stay in view; the newest lines of the rest come under them.
  const asked = questionAndAnswer(request.events);
  if (asked.length) add(card, el("h4", null, asked.length > 1 ? "Question and answer" : "Question"), add(el("ol", "timeline"), ...asked.map(eventItem)));
  const others = request.events.filter((event) => !asked.includes(event));
  const key = "now-lines:" + request.id;
  const all = opened.has(key);
  const events = all ? others : others.slice(-NOW_LINES);
  if (events.length) {
    add(card, el("h4", null, "Latest lines"));
    add(card, add(el("ol", "timeline"), ...events.map(eventItem)));
    if (others.length > NOW_LINES) add(card, attr(button("more", all ? "Show the newest " + NOW_LINES : "Show all " + others.length + " lines", () => flip(key), "more:" + key), "aria-expanded", all));
  }
  if (request.steps.length) {
    add(card, el("h4", null, "Latest steps (" + count(request.stepCount, "step", "steps") + " in all)"));
    add(card, add(el("ol", "steps"), ...request.steps.map(stepItem)));
  }
  return card;
}
function renderNow(data) {
  const box = el("section");
  add(box, el("h2", "section-title", "Now"));
  if (data.now.length) return add(box, ...data.now.map(nowCard));
  const idle = add(box, el("p", "idle")).lastChild;
  if (data.serving.state === "waiting for an answer") add(idle, withIds("span", null, "No request in progress: " + data.serving.requestId + " waits for its answer."));
  else if (data.serving.state === "serving") {
    add(idle, el("span", null, "No request in progress: the session waits for Doable's next request."));
    // The request that ended last. The list is in the order in which the logs first name each request, and the session
    // can end a request that it took earlier after a later one (its answer came later).
    const ended = data.requests.filter((row) => row.finishedAt && row.status !== EXPIRED);
    const last = ended.reduce((a, b) => (Date.parse(b.finishedAt) > Date.parse(a.finishedAt) ? b : a), ended[0]);
    if (last) add(idle, el("span", null, " The last one, "), el("span", "nowrap", last.id), el("span", null, ", ended "), liveTime(last.finishedAt, ago), el("span", null, "."));
  } else if (data.serving.state === "cannot reach Doable") {
    add(idle, el("span", null, "No request in progress: the session's waits for a request fail (“Needs attention” shows why)."));
  } else add(idle, el("span", null, "No request in progress."));
  return box;
}

// ---------------------------------------------------------------------------------------------------------------------
// The tabs
// ---------------------------------------------------------------------------------------------------------------------
function renderTabs(data) {
  const nav = attr(attr(el("div", "tabs"), "role", "tablist"), "aria-label", "Parts of the page");
  const counts = { requests: data.requests.length, sessions: data.sessionCount, log: data.logLineCount };
  for (const [key, label] of TABS) {
    const tab = button("tab", null, () => go({ tab: key }, "tab:" + key), "tab:" + key);
    attr(attr(attr(tab, "role", "tab"), "aria-selected", key === place.tab), "aria-controls", "panel");
    add(tab, el("span", null, label), el("span", "count", number(counts[key])));
    add(nav, tab);
  }
  return nav;
}
function renderPanel(data) {
  const panel = attr(el("section", "panel"), "role", "tabpanel");
  panel.id = "panel";
  if (place.tab === "sessions") return add(panel, renderSessions(data));
  if (place.tab === "log") return add(panel, renderLog(data));
  return add(panel, renderRequests(data));
}

// The Requests tab: the filter, the search, the size of a page, the rows of this page and the pages.
// Whether a row has the chosen status and the search's words: in its id or its asker, or in its text. The list holds
// only the start of each text: the server's answer (/search.json) says which whole texts hold the words.
function matches(row) {
  if (place.filter !== "all" && statusOf(row.status)[2] !== place.filter) return false;
  const words = place.q.trim().toLowerCase();
  if (!words) return true;
  if ([row.id, askerShort(row), row.text].some((value) => value && value.toLowerCase().includes(words))) return true;
  return got.search !== null && got.search.words === words && got.search.ids.has(row.id);
}
// The rows to list. The open row stays when it no longer matches (its status changed): the person reads it.
function matching(rows) {
  return rows.filter((row) => row.id === place.open || matches(row));
}
function renderRequests(data) {
  const box = el("div");
  if (!data.requests.length) return add(box, el("p", "empty", "No request yet: the session has not taken a request from Doable."));
  const bar = add(box, el("div", "toolbar")).lastChild;
  const chips = attr(attr(el("div", "chips"), "role", "group"), "aria-label", "Show the requests with a status");
  for (const [key, label, titleText] of FILTERS) {
    const n = key === "all" ? data.requests.length : data.requests.filter((row) => statusOf(row.status)[2] === key).length;
    if (!n && key !== "all" && place.filter !== key) continue;
    const chip = button("chip", null, () => go({ filter: key, page: 1, open: null }, "chip:" + key), "chip:" + key);
    attr(chip, "aria-pressed", place.filter === key);
    chip.title = titleText;
    add(chips, add(chip, el("span", null, label), el("span", "count", number(n))));
  }
  add(bar, chips, focusable(search, "search"), sizeChoice());
  listBox = add(box, el("div")).lastChild;
  fillList(data);
  return box;
}
// The size of a page: three buttons, not a list that opens. A render every 5 seconds would close an open list.
function sizeChoice() {
  const box = attr(attr(el("div", "size"), "role", "group"), "aria-label", "Rows on a page");
  add(box, el("span", null, "Rows"));
  for (const size of PAGE_SIZES) {
    const choice = attr(button(null, String(size), () => go({ size, page: 1, sessionsPage: 1 }, "size:" + size), "size:" + size), "aria-pressed", size === place.size);
    add(box, choice);
  }
  return box;
}
function renderList() {
  if (!listBox || !got.data) return;
  anchors = anchors.filter((node) => !listBox.contains(node));
  fillList(got.data);
}
function fillList(data) {
  const rows = matching(data.requests);
  if (!rows.length) {
    listBox.replaceChildren(el("p", "empty", "No request matches the filter and the search."), button("button", "Show all requests", () => {
      setSearch("");
      go({ filter: "all", page: 1 }, "search");
    }, "show-all"));
    return;
  }
  const pages = Math.max(1, Math.ceil(rows.length / place.size));
  // The page that holds the open row: a new request moves each row down by one, and the open row can move to the next
  // page. The address follows.
  const at = place.open ? rows.findIndex((row) => row.id === place.open) : -1;
  const page = at >= 0 ? Math.floor(at / place.size) + 1 : Math.min(place.page, pages);
  if (page !== place.page) {
    place.page = page;
    writePlace();
  }
  const list = el("ol", "rows");
  for (const row of rows.slice((page - 1) * place.size, page * place.size)) add(list, requestLine(row));
  listBox.replaceChildren(list, pager(rows.length, page, place.size, (to) => go({ page: to, open: null }, "requests-pages:" + to), "Pages of requests", "requests-pages"));
}
function cell(className, child) {
  const node = el("span", className);
  if (typeof child === "string") node.textContent = child;
  else add(node, child);
  return node;
}
function requestLine(row) {
  const open = place.open === row.id;
  const item = anchor(el("li", "row" + (open ? " open" : "")), "request:" + row.id);
  const head = button("row-head request-head", null, () => go({ open: open ? null : row.id }, "row:" + row.id), "row:" + row.id);
  attr(attr(head, "aria-expanded", open), "aria-controls", "detail-" + row.id);
  const text = cell("c-text", firstLine(row.text));
  text.title = row.text || "";
  const asker = cell("c-asker", askerShort(row));
  asker.title = askerShort(row);
  const came = row.askedAt || row.takenAt;
  let took = "";
  if (row.finishedAt && row.takenAt && row.status !== EXPIRED) took = span(Date.parse(row.finishedAt) - Date.parse(row.takenAt));
  // The time counts on only while a session holds the request.
  const held = !row.finishedAt && row.servedAt && (row.status === "working" || row.status === "waiting for an answer");
  add(head, cell("c-status", statusPill(row.status)), cell("c-id", row.id), asker, text,
    cell("c-when", came ? liveTime(came, ago) : "—"),
    cell("c-took", took || (held ? liveTime(row.servedAt, (iso) => span(Date.now() - Date.parse(iso))) : "")));
  head.lastChild.title = took ? "From the time the session took it to its end" : held ? "Since the session took it" : "";
  add(item, head);
  if (open) {
    const body = el("div", "row-body");
    body.id = "detail-" + row.id;
    if (!matches(row)) add(body, el("p", "note", "It no longer matches the chosen status or the search. It stays in the list while it is open."));
    add(item, add(body, requestDetail(row.id)));
  }
  return item;
}
function resultBox(request) {
  const result = request.result;
  const box = el("div", "result");
  const heading = result.kept ? "Result" : request.status === "cancelled" ? "Result sent after the cancel: Doable did not keep it" : "Result that Doable did not keep";
  add(box, el("h4", null, heading), facts([["Outcome", result.outcome], ["Sent", when(result.at)]]));
  if (!result.kept) add(box, el("p", "note", "Doable gave back the request as it stood and saved nothing of this result: the asker did not get it."));
  // The summary is Markdown: it shows in the body's font, with its lines.
  if (result.summary) add(box, clamped("summary:" + request.id, result.summary, "summary", 10));
  if (result.records.length) add(box, el("h4", null, "Records"), table(["Name", "Value"], result.records.map((record) => [record.name, record.value])));
  if (result.logins.length) {
    add(box, el("h4", null, "Logins"), table(["Username", "Note"], result.logins.map((login) => [login.username, login.note])));
    add(box, el("p", "note", result.kept
      ? "The page keeps no password of a login."
      : "Doable did not save these logins, but the session made them in the test environment: remove them there if nobody needs them. The page keeps no password of a login."));
  }
  if (result.codeFiles.length) {
    add(box, el("h4", null, "Files that the answer rests on"));
    const list = add(box, el("ul", "files")).lastChild;
    for (const file of result.codeFiles) {
      const commit = el("span", "mono", file.commit ? file.commit.slice(0, 12) : "");
      commit.title = file.commit || "";
      add(list, add(el("li"), el("span", "mono", (file.repository || "") + " "), el("span", null, file.path || ""), el("span", "muted", " at "), commit));
    }
  }
  return box;
}
function pagedSteps(key, steps, leftOut) {
  const box = el("div");
  if (leftOut) add(box, el("p", "note", count(leftOut, "earlier step is", "earlier steps are") + " not shown."));
  const pages = Math.max(1, Math.ceil(steps.length / STEP_PAGE));
  // The newest page first.
  const page = Math.min(stepPages.get(key) || pages, pages);
  add(box, add(el("ol", "steps"), ...steps.slice((page - 1) * STEP_PAGE, page * STEP_PAGE).map(stepItem)));
  if (pages > 1) add(box, pager(steps.length, page, STEP_PAGE, (to) => {
    stepPages.set(key, to);
    render(key + ":" + to);
  }, "Pages of steps", key));
  return box;
}
function requestDetail(id) {
  const request = got.requests.get(id);
  if (!request) return el("p", "muted", "Reading the request…");
  if (request.missing) return el("p", "muted", request.missing);
  const box = el("div");
  // How long it took, or how long it works or waits now. A time counts on only while a session holds the request.
  let time = [null, null];
  if (request.status === EXPIRED) time = ["Doable's wait for the answer ended", when(request.finishedAt)];
  else if (request.finishedAt && request.takenAt) time = ["Took", span(Date.parse(request.finishedAt) - Date.parse(request.takenAt))];
  else if (request.status === "working" && request.servedAt) time = ["Working", liveTime(request.servedAt, lasting)];
  else if (request.status === "waiting for an answer" && (request.questionAt || request.servedAt)) time = ["Waiting for the answer", liveTime(request.questionAt || request.servedAt, lasting)];
  else if (request.questionAt) time = ["Question asked", when(request.questionAt)];
  add(box, facts([
    // The pill, and the status's own words when the pill says less (left when its session ended).
    ["Status", add(el("span"), statusPill(request.status), statusOf(request.status)[0].toLowerCase() === request.status ? null : el("span", null, " " + request.status))],
    ["Asker", askerWords(request)],
    ["Organization", request.organization],
    ["Asked", request.askedAt ? when(request.askedAt) : "not in the logs"],
    ["Taken", request.takenAt ? when(request.takenAt) : null],
    time,
  ]));
  if (request.note) add(box, el("p", "callout", request.note));
  if (request.text) add(box, el("h4", null, "Request"), clamped("text:" + id, request.text, "text", 6));
  if (request.result) add(box, resultBox(request));
  if (request.events.length) {
    add(box, el("h4", null, "Progress"));
    if (request.eventsLeftOut) add(box, el("p", "note", count(request.eventsLeftOut, "earlier line is", "earlier lines are") + " not shown."));
    add(box, add(el("ol", "timeline"), ...request.events.map(eventItem)));
  }
  if (request.steps.length || request.stepsLeftOut) {
    const key = "steps:" + id;
    add(box, folded(key, "What the session did for it (" + count(request.steps.length, "step", "steps") + ")", pagedSteps(key, request.steps, request.stepsLeftOut)));
  }
  return box;
}

// The Sessions tab: a page of the sessions, newest first; a line opens the session's facts and steps.
function sessionTone(session) {
  if (session.running) return ["Running", "ok"];
  const how = session.endedHow || "";
  if (how.startsWith("stopped at the plan limit")) return ["Plan limit", "warn"];
  if (how.startsWith("stopped with an error")) return ["Error", "bad"];
  if (how.startsWith("ended at Doable's ask")) return ["Update asked", "warn"];
  return ["Ended", "muted"];
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
    ["Requests", String(session.requests)],
    ["Ended", session.running ? null : when(session.endedAt)],
    ["How it ended", session.running ? null : session.ending],
  ]);
}
function failedCalls(session) {
  if (!session.failedCalls.length) return null;
  const box = el("div");
  add(box, el("h4", null, "Calls to Doable that failed"));
  const list = add(box, el("ol", "timeline")).lastChild;
  for (const call of session.failedCalls) {
    add(list, add(el("li", "event-refused"), timeOf(call.at), add(el("div"), el("span", "what", "The " + (WHAT[call.what] || call.what)), el("span", "words", call.text))));
  }
  return box;
}
function sessionDetail(ref) {
  const session = got.sessionDetails.get(ref);
  if (!session) return el("p", "muted", "Reading the session…");
  if (session.missing) return el("p", "muted", session.missing);
  const box = add(el("div"), sessionFacts(session));
  if (session.running && got.data.service.state === "on") add(box, el("p", "note", "It runs now."));
  add(box, failedCalls(session));
  if (session.steps.length) {
    const key = "own:" + ref;
    add(box, folded(key, "What it did outside a request (" + count(session.steps.length, "step", "steps") + ")", pagedSteps(key, session.steps, session.stepsLeftOut)));
  }
  return box;
}
// A session's line. Its id (ref) names it in the address and in the reads; its number in the logs only shows.
function sessionLine(session) {
  const open = place.session === session.ref;
  const item = anchor(el("li", "row" + (open ? " open" : "")), "session:" + session.ref);
  const head = button("row-head session-head", null, () => go({ session: open ? null : session.ref }, "session:" + session.ref), "session:" + session.ref);
  attr(attr(head, "aria-expanded", open), "aria-controls", "session-" + session.ref);
  const [label, tone] = sessionTone(session);
  const time = cell("c-time", (session.startKnown ? clock(session.startedAt) : "before " + clock(session.startedAt)) + " → " + (session.running ? "now" : clock(session.endedAt)) +
    (session.startedAt && (session.endedAt || session.running) ? " (" + span((session.running ? Date.now() : Date.parse(session.endedAt)) - Date.parse(session.startedAt)) + ")" : ""));
  time.title = when(session.startedAt) + " to " + (session.running ? "now" : when(session.endedAt));
  add(head, cell("c-status", pill(label, tone, session.endedHow || "It runs now.")), cell("c-id", "Session " + session.n), time,
    cell("c-how", session.running ? "runs now" : session.endedHow), cell("c-count", count(session.requests, "request", "requests")));
  add(item, head);
  if (open) {
    const body = el("div", "row-body");
    body.id = "session-" + session.ref;
    add(item, add(body, sessionDetail(session.ref)));
  }
  return item;
}
// What the page asks /sessions.json for: the page, its size and the open session.
function sessionsAsk() {
  return "/sessions.json?page=" + place.sessionsPage + "&size=" + place.size + (place.session ? "&open=" + encodeURIComponent(place.session) : "");
}
function renderSessions(data) {
  const box = el("div");
  if (!data.sessionCount) return add(box, el("p", "empty", "No session in the logs on this computer yet."));
  const page = got.sessions;
  if (!page) return add(box, el("p", "muted", "Reading the sessions…"));
  if (page.missing) return add(box, el("p", "muted", page.missing));
  // The page that the server gave for this ask: the one that holds the open session (newer sessions move it to a later
  // page), or the last page for a page after it. The address follows.
  if (got.sessionsAsked === sessionsAsk() && page.page !== place.sessionsPage) {
    place.sessionsPage = page.page;
    writePlace();
  }
  add(box, el("p", "note", "Newest first. After hours of restarts (for example at a plan limit) they are many."));
  add(box, add(el("ol", "rows"), ...page.sessions.map(sessionLine)));
  add(box, pager(page.total, page.page, page.size, (to) => go({ sessionsPage: to, session: null }, "sessions-pages:" + to), "Pages of sessions", "sessions-pages"));
  return box;
}

// The Service log tab: the start script's lines, newest at the bottom, and the session's output that is no event.
function otherOutput(lines) {
  if (!lines.length) return null;
  const box = el("div");
  add(box, el("h4", null, "Output of the session that is not an event (last lines)"));
  add(box, el("p", "note", "Claude Code and the shell write their errors here, for example when the session cannot start."));
  const list = add(box, el("ol", "lines")).lastChild;
  for (const line of lines) add(list, add(el("li"), el("span", "time", line.after ? "after " + when(line.after) + " " : "before the first event "), el("span", "words", line.text)));
  return box;
}
function renderLog(data) {
  const box = el("div");
  if (SELF_UPDATE[data.service.selfUpdate]) add(box, el("p", "note", SELF_UPDATE[data.service.selfUpdate]));
  add(box, el("h4", null, "The service's log (its times are UTC)"));
  const page = got.log;
  if (!page) add(box, el("p", "muted", "Reading the log…"));
  else if (page.missing) add(box, el("p", "muted", page.missing));
  else if (!page.total) add(box, el("p", "muted", "No line yet."));
  else {
    logBox = focusable(attr(attr(el("pre", "log", page.lines.join("\n")), "tabindex", 0), "aria-label", "The service's log"), "log:box");
    add(box, logBox);
    const nav = attr(el("nav", "pager"), "aria-label", "Pages of the log");
    const older = button(null, "Older lines", () => go({ logPage: page.page + 1 }, "log:older"), "log:older");
    older.disabled = page.page >= page.pages;
    const newer = button(null, "Newer lines", () => go({ logPage: page.page - 1 }, "log:newer"), "log:newer");
    newer.disabled = page.page <= 1;
    add(nav, older, newer, el("span", "range", "Lines " + number(page.from) + "–" + number(page.to) + " of " + number(page.total)));
    add(box, nav);
  }
  add(box, otherOutput(data.otherOutput));
  return box;
}

// ---------------------------------------------------------------------------------------------------------------------
// Render, read and keep the person's place
// ---------------------------------------------------------------------------------------------------------------------

// The first row or card that shows in the window, and where its top is.
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
function render(focusKey) {
  const data = got.data;
  if (!data) return;
  const before = firstVisible();
  const active = document.activeElement;
  const focusWas = focusKey || (active && active.dataset ? active.dataset.focus : null);
  const caret = active === search ? [search.selectionStart, search.selectionEnd] : null;
  const oldLog = logBox;
  const logAtEnd = !oldLog || oldLog.scrollTop + oldLog.clientHeight >= oldLog.scrollHeight - 4;
  anchors = [];
  live = [];
  focusables = new Map();
  logBox = null;
  listBox = null;
  renderedDay = new Date().toDateString();
  renderHeader(data);
  content.replaceChildren(...[renderAttention(data), renderNow(data), renderTabs(data), renderPanel(data)].filter(Boolean));
  // The log shows its newest lines, unless the person scrolled up in it.
  if (logBox) logBox.scrollTop = logAtEnd ? logBox.scrollHeight : oldLog.scrollTop;
  // The row or card that the person reads stays where it was in the window: a new request above it moves the window.
  const same = before === null ? undefined : anchors.find((node) => node.dataset.key === before.key);
  if (same && !focusKey) {
    const moved = same.getBoundingClientRect().top - before.top;
    if (moved !== 0) window.scrollBy(0, moved);
  }
  const target = focusWas ? focusables.get(focusWas) : undefined;
  if (target && target !== document.activeElement) {
    target.focus({ preventScroll: !focusKey });
    if (caret && target === search) search.setSelectionRange(caret[0], caret[1]);
  }
  if (focusKey && target) target.scrollIntoView({ block: "nearest" });
  if (!rendered) {
    rendered = true;
    const opener = place.tab === "requests" && place.open ? focusables.get("row:" + place.open) : place.tab === "sessions" && place.session ? focusables.get("session:" + place.session) : undefined;
    if (opener) opener.scrollIntoView({ block: "start" });
  }
}
function showProblem(words) {
  problem.textContent = words;
  problem.hidden = false;
  content.classList.add("stale");
}
function showUpdated() {
  if (holding || readAt === null) return;
  const ms = Date.now() - readAt;
  updated.textContent = ms < 2000 ? "Updated now" : "Updated " + span(ms) + " ago";
  updated.title = "The page reads the logs again every 5 seconds.";
}
// Each second: the time since the last read, and each time on the page that counts. After midnight, the whole page
// again: a time of today shows no date, and yesterday's times need theirs.
function tick() {
  showUpdated();
  if (renderedDay !== null && renderedDay !== new Date().toDateString() && !selecting()) {
    render();
    return;
  }
  for (const [node, iso, format] of live) node.textContent = format(iso);
}
// The reads of the parts that the person opened, besides /data.json, each with where its answer goes.
function wanted() {
  const list = [];
  const keep = (map, key) => (answer) => map.set(key, answer);
  if (place.tab === "requests" && place.open) list.push(["/request.json?id=" + encodeURIComponent(place.open), keep(got.requests, place.open)]);
  const words = place.q.trim();
  if (place.tab === "requests" && words) {
    list.push(["/search.json?q=" + encodeURIComponent(words), (answer) => (got.search = { words: words.toLowerCase(), ids: new Set(answer.ids || []) })]);
  }
  if (place.tab === "sessions") {
    const ask = sessionsAsk();
    list.push([ask, (answer) => {
      got.sessions = answer;
      got.sessionsAsked = ask;
    }]);
    if (place.session) list.push(["/session.json?id=" + encodeURIComponent(place.session), keep(got.sessionDetails, place.session)]);
  }
  if (place.tab === "log") list.push(["/log.json?page=" + place.logPage, (answer) => (got.log = answer)]);
  return list;
}
async function read(path) {
  const response = await fetch(path, { cache: "no-store" });
  return { path, ok: response.ok, status: response.status, text: await response.text() };
}
async function load() {
  const ticket = (reads += 1);
  const parts = wanted();
  const answers = [];
  try {
    answers.push(await read("/data.json"));
    if (answers[0].ok) for (const [path] of parts) answers.push(await read(path));
  } catch {
    // No answer: the page command stopped, or the computer slept.
    if (ticket === reads) showProblem("The page cannot reach its server. Start the page command again on this computer. The data below is from the last read.");
    return;
  }
  // A newer read started while this one waited (the person opened another part): its answers count.
  if (ticket !== reads) return;
  const main = answers[0];
  if (!main.ok) {
    // The server's reason, for example a machine that was removed.
    showProblem(main.text.trim() || "The page's server answered with the status " + main.status + ".");
    return;
  }
  problem.hidden = true;
  content.classList.remove("stale");
  const text = answers.map((answer) => answer.path + " " + answer.status + " " + answer.text).join("\n");
  if (text !== lastText && selecting()) {
    holding = true;
    updated.textContent = "New data waits while you select text on the page.";
    return;
  }
  holding = false;
  readAt = Date.now();
  showUpdated();
  if (text === lastText) return;
  lastText = text;
  got.data = JSON.parse(main.text);
  parts.forEach(([, put], i) => {
    const answer = answers[i + 1];
    put(answer.ok ? JSON.parse(answer.text) : { missing: answer.text.trim() || "The page's server answered with the status " + answer.status + "." });
  });
  render();
}
window.addEventListener("hashchange", () => {
  readPlace();
  render();
  load();
});
readPlace();
load();
setInterval(load, 5000);
setInterval(tick, 1000);
`;

export function pageHtml(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>Doable code agent</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<header class="top">
<div class="wrap">
<div class="bar"><div class="brand"><h1 id="title">Doable code agent</h1><span class="kind">Doable code agent on this computer</span></div><span class="updated" id="updated">Reading the logs…</span></div>
<div id="status"></div>
</div>
</header>
<div class="wrap">
<p class="problem" id="problem" role="alert" hidden></p>
<main id="content"></main>
<footer class="foot"><p>This page reads only the code agent's files on this computer. ${PAGE_ACCESS} ${PAGE_MASK}</p></footer>
</div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
}
