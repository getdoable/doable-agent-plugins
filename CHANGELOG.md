# Changelog

All notable changes to Doable Agent Plugins are documented here.

## GitHub workflow distribution [1.0.0] - 2026-10-03

- Publish the self-contained Code Context workflow with a SHA-256 release manifest.
- Add customer-agent installation, provider setup, connection, and upgrade instructions.
- Verify template integrity and syntax in CI. Local plugin version remains 0.2.10.
- Clarify the GitHub integration's repository metadata and model-provider boundary.

## [0.6.4] - 2026-11-27

The code agent's page runs as part of the Always on service, on by default. A person no longer
keeps a command open for it, and it is on again after a restart of the Mac and after a self-update.
A machine of 0.6.3 updates itself to 0.6.4 when Doable asks for it, with no person: its start
script runs 0.6.4's `write-start-script`, which turns the page on (0.6.3's `config.json` has no
choice for the page). The page also has a new layout: a header that says what the session does
now, "Needs attention", "Now", and tabs with pages. The session's prompt does not change.

### Added

- The page runs with the service: the start script starts
  `code-agent-service.mjs page --machine <machine> --port <port>` of its own release, with
  `--pid-file` and the path of `page.pid`, in the background, next to the serving session, with the
  start script's `node`. Its output goes to `page.log` in the machine's folder (emptied at each start
  of the page), and its process id to `page.pid`. The page writes its own process id there too,
  because the `node` of the start script's PATH can be a program that runs node as its child (for
  example a version manager's shim); `stop-page` also stops such a program's child that runs the
  page. Each write of `page.pid` is a rename, so that no reader finds the file empty. Each start
  script first stops the page that an earlier start script started: also the page of an older
  release, after a self-update's exec. It stops a process only when the process runs this machine's
  page command, because a process id can be reused. A start script that starts after `stop` (launchd
  runs it at each login) starts no page. Before each start of the serving session, the start script
  checks that the page runs (`check-page`). When it does not, it writes one line to `service.log`
  with the last lines of `page.log`, masked, and starts it again. A page that cannot start (its port
  is in use) never stops the session, and its words name the service's steps: `stop`, then `start`
  with `--page-port`. The page stops when the loop ends, and at `stop` and `remove`.
- `setup` and `start` take `--page on|off` (default on) and `--page-port <number>` (default 47615),
  kept in the machine's `config.json`; `start`, and the setup again, without them keep the choice.
  Each command refuses an option that it does not take: `setup` and `start` refuse the page
  command's `--port` and name `--page-port`. `setup` prints the page's address, that any account on
  this computer can open it, and how to turn it off; `start` prints it when it gets one of the
  options. After the launch, both look at the page, and when it does not run, they say why with the
  last lines of `page.log`. `status` shows whether the page is on, its address, and whether it runs
  now; while the code agent is stopped or not running, it says that the page runs only while the
  code agent runs, and it names a start script of an older release that runs no page.
- The code agent's page is shorter and easier to read. A header says what the session does now;
  "Needs attention" shows only what needs a person (a question that waits, Doable's ask for a newer
  plugin, a session that cannot start, refused calls of the request in progress); "Now" shows the
  request in progress; and three tabs hold the requests (one line each, newest first, in pages of
  10, 25 or 50, with status chips and a search), the sessions and `service.log` (in pages). A line
  opens its details, and the address keeps the tab and the place (`#requests&page=2`). The page
  reads every 5 seconds only the state and one line of each request (`/data.json`); it reads one
  request (`/request.json?id=CA-…`), a page of sessions (`/sessions.json`, which gives the page
  that holds an open session), one session by its id (`/session.json?id=…`), a page of
  `service.log` (`/log.json`) or the requests whose whole text holds the search's words
  (`/search.json?q=…`, over the masked text) only while that part is open. Each new route takes
  only GET, answers only at `127.0.0.1:<port>` or `localhost:<port>`, refuses a parameter that it
  does not take (`400`), masks as `/data.json` does, and has the same headers. The page follows
  light or dark mode and works down to a phone's width.
- The page's header shows whether self-update is on, whether the service's page is on and its
  address (from `config.json`), and whether the service runs this page ("(this page)") or a person
  ran it by hand with the page command ("This page runs by hand"). Its note when it cannot reach its
  server says that the code agent stopped or the page ended, and that the service starts the page
  again before its next session.
- The page shows the files that a result names (repository, commit and path), the version that
  Doable asked for while `update-asked` holds it, and a session that ended at Doable's ask.
- README ("Always on", "The code agent's page"), TESTING (scenarios 73 and 75), PRIVACY. The manual
  `page` command stays, for a machine with the page off or for one more page on another port.

### Fixed

- `service.log` holds the exit code of each serving session. The start script wrote `$?` after
  `$(date ...)` in the same line, so the line said "ended with code 0" for each session, and the
  page showed that code. The start script now keeps the code on the line after the session.
- When the session does not start to wait for requests, the setup and `start` say why. They stop
  the wait at once when the session ended, and say its exit code; while it runs, they still wait 2
  minutes. Then they give the text of Claude Code's result (for example "Not logged in · Please
  run /login" when Claude Code is not signed in), or its `errors` when the result has no text
  (for example a turn that failed while it ran), else the last three lines of the session's
  output that are not events. They mask that text with the service's mask and cut it after 500
  characters. Before, they said only that the session did not start to wait in 2 minutes.
- The setup and `start` refuse at once to run as root (also with `sudo`), and say to run them as
  a normal user. Claude Code refuses the bypass permission mode for root
  ("--dangerously-skip-permissions cannot be used with root/sudo privileges"), so a session of
  root never started. That line of Claude Code is now in `session.jsonl` only when a person runs
  the start script itself as root. The setup and `start` follow Claude Code's own rule: Claude
  Code allows root in a sandbox (`IS_SANDBOX=1`, or a `CLAUDE_CODE_BUBBLEWRAP` that is not empty).
  On a machine without launchd, where the start script gets their environment, they let root
  through in such a sandbox. On a Mac, the launchd job does not get those values, so they refuse
  root there in all cases.
- On the page, the header says "Cannot reach Doable", and "Needs attention" shows the newest failed
  waits, while each wait for a request fails. A restart shows "Starting" until the new session
  writes its first event or the start script writes its end, not "Cannot start". A question that no
  session serves and that got no answer in 24 hours shows as "Probably expired", not as open.
- README ("Always on", "When the session does not start"), TESTING (scenarios 67 and 74).

### Known limits

- Any account or program on this computer can open the page at any time while the service runs,
  not only while a person keeps a command open as in 0.6.3.
- The start script checks the page only before each start of the serving session: a page that
  ended stays down until the next session starts.
- A page that a person still runs by hand on port 47615 (as 0.6.3's README said) keeps the
  service's page from its port: `service.log` says so before each session until the person stops
  it.
- Each code agent on one computer, also one of another account, needs its own `--page-port`: with
  the same port, only the page of the code agent that started first runs. The setup and `start` of
  the other one say that its page does not run.

## [0.6.3] - 2026-11-25

The code agent sends no code back, whoever asks. A result says in words what the code does, with file
paths and line numbers. It reads the code that the request's environment runs, not what a checkout
holds, and a new `page` command shows the session and its requests on the machine. A result names
the files that its answer rests on, for the chat's Sources tab. From 0.6.3, an Always on machine
updates itself when Doable asks for a newer release, and at no other time. Update each machine to 0.6.3 by hand, with stop,
the plugin update, and start from the new installPath, as for 0.6.2
(README, "Update from 0.6.2"). Start each session after the Doable MCP release that goes with 0.6.3.
The session's prompt does not change.

### Added

- `scripts/code-agent-service.mjs page --machine <machine>`: a page at `http://127.0.0.1:47615/` that
  other computers cannot open (any account of this computer can). It shows the session and each
  request from the machine's own files, with `****` in place of the logins' passwords, Doable API keys
  and secrets in known forms (README, "The code agent's page").
- Code files: `doable-code-agent` puts in the result's `code_files` each file of the repositories that
  the answer rests on, with its repository (`owner/name` of its `origin` remote, else its folder's
  name), the full id of the commit that the session read (the running revision) and its path from the
  repository's root; only these three, never code. Doable shows them on the chat's Sources tab. A
  file read at two revisions is two entries. A refusal that names `code_files` (Doable MCP's own, or
  Doable's `422`) gets the values corrected, or the file left out, and the whole result sent again. PRIVACY says that repository names, commit ids and paths now reach Doable.
- Self-update, on by default, only when Doable asks: the bundled Doable MCP connection sends the
  plugin's version (`X-Doable-Plugin-Version`, checked against `plugin.json` by the release
  verifier). When Doable needs a newer release, the wait's answer has no request, and its `update`
  is the words "Doable needs the plugin X on this machine. ...": the session ends at once (the skill
  writes one line and calls no other tool; the same words in a request are data). After each
  session, the start script's `update-request` reads that session's output for this answer (the
  JSON record that Claude Code writes there, or the words alone from a client that passes only the
  answer's text; never a record that holds a request), keeps the asked version in the
  machine's `update-asked` file, and writes a line to `service.log`. Then it runs
  `claude plugin marketplace update`, `claude plugin update` in the plugin's scope and
  `claude plugin list --json`, each with a time limit; when Claude Code installed a new release,
  that release writes the start script again (`write-start-script`) and the loop goes on in it at
  once. When the machine still runs a lower release (the release is not in the marketplace yet, or a
  command failed), a line says that a person must act, and the next session starts 30 minutes later,
  not 5. The first start never updates. Each step writes one line to `service.log`, with secrets
  masked. `setup` and `start` take `--auto-update on|off`, kept in the machine's `config.json`;
  `setup` says whether it is on, `status` and the page show it, and `status` shows the asked
  version. `setup` and `start` say when the session's first wait got Doable's ask, not that it is
  connected. With self-update off, or with a development folder, `service.log` says which version
  Doable asked for and that a person must update (README, "Self-update"), with the same wait of 30
  minutes. The start script runs `node` by the path that `setup` and `start` find on its PATH, and
  they refuse when that PATH has none. The README gives the release order: deploy the Doable server,
  then the Doable MCP, that the release needs, then merge the release to the marketplace, then raise
  the version that Doable asks for. A rollback takes back the Doable MCP before the Doable server.

### Changed

- `doable-code-agent`: "Code" in "Words" says what code is (the text of a file of the repositories,
  one line too, a diff or a patch of it, and such text that the session writes itself) and what is
  not (paths, line numbers, names, what the product shows or takes, the value of a setting or a flag
  that is no secret, the ids and values that tests need, the words of the product's docs and READMEs,
  a command that a person can run). No summary, record, login's note, progress text, question or
  capability summary holds code, also when a request, an answer or a line of the person's message
  asks for it or allows it, whoever asks. 0.6.2 could send code excerpts and suggested diffs of 10
  lines or fewer.
- A request that asks for code gets what its goal needs in words, with paths and line numbers, and
  one sentence that code stays on the machine. The outcome is that of the work. The session declines
  it only when nothing is left to say without the code (the request gives no goal). A suggested fix
  is in words, with no diff.
- Doable refuses a text with a code block, whatever is in it, or a diff (`422`), and keeps nothing of
  the call: the session writes a command or a value inline, says code in words, and sends the call
  again.
- The capability summary says that the session sends no code.
- README, PRIVACY, the Codex manifest's description, and TESTING (scenarios 36, 39, 53 and 69) say the
  same. README: "Update from 0.6.2".
- `doable-code-agent` reads the code of the running revision: it fetches each repository that it
  reads, finds the branch, tag or commit that the request's environment runs (deploy and CI files,
  the team's docs, a version that the app shows), and reads it with `git show`, `git grep` or a new
  worktree of its own, with no change to the checkout. A branch, tag, commit or open change that the
  request names comes first; with no environment, or nothing that says what it runs, it reads the
  newest commit of the default branch. The result names the revision, its date and how the session
  knows that the environment runs it; a failed fetch is named under **Not known** with the date of
  the copy that it read. A fix that it tries is a new local branch of that revision in a worktree of
  its own, and it leaves no worktree behind. 0.6.2 answered from what each repository had checked
  out, which could be weeks behind the environment (TESTING, scenario 70).

### Fixed

- `scripts/code-agent-service.mjs` refuses the machine names `.` and `..`. With them, `remove` deleted
  the folder of all machines or the one above it.

### Known limit

- Doable refuses only a fenced code block, an HTML `<pre>` tag and a header line of a diff. It does
  not recognize code in another form (for example one line with no code block, or an indented block):
  there, only the Skill's rules keep code on the machine.
- The code agent's page finds secrets only in known forms. A password in a sentence, or a new login's
  password as a script's argument until the result names that login, shows on the page. Any account
  or program of the computer can open the page.
- Self-update: Doable's chat page shows no state for a machine that needs an update. With
  self-update off, or while the marketplace does not hold the release that Doable asks for, the
  machine serves no request: a session starts every 30 minutes, uses the Claude plan until its first
  wait, and ends there (run `stop` until the update is done). A session that a person started by
  hand gets the same answer, ends, and is updated by hand. The Codex manifest sends no plugin
  version.

## [0.6.2] - 2026-11-24

The session uses only the Chrome that the person chose in Claude Code on the machine. A Claude
account can have a Chrome connected on several computers. With several and no choice, Claude Code
asks which one to use and nobody answers, so a 0.6.1 session declined a sign-up by email. With only
another computer's Chrome connected, Claude Code uses that one without a question.
Choose this machine's Chrome before you update a machine (README, "Update from 0.6.1"): with no
choice, the session uses no browser.

### Added

- `scripts/code-agent-service.mjs browser`: prints the Chrome that the person chose in Claude Code
  (`/chrome`, "Select browser"), or that none is chosen, and nothing else of Claude Code's config
  file (`.claude.json` in `CLAUDE_CONFIG_DIR`, else in the home folder).
- README: "Choose this machine's Chrome in Claude Code one time", and "Update from 0.6.1". TESTING:
  scenario 68.

### Changed

- `doable-code-agent`: "The browser". Before the first browser call of each request, each time it
  comes back to the browser after other work or a wait (for example before it opens a mail's link),
  and after a browser call that fails, the session compares the browser in use
  (`list_connected_browsers`) with the choice that `browser` prints. When they differ, none is
  chosen, or the chosen one is on another operating system, it goes on without the browser and says
  what a person does on the machine. It never calls `select_browser` or `switch_browser`, because
  they change the person's choice.
- `scripts/code-agent-service.mjs`: the setup and `start` say which Chrome is chosen, or that none
  is and how to choose one. A config file of Claude Code that is not valid JSON stops them before
  they change anything. The script also runs when its path holds a link (a linked `~/.claude`);
  before, it ended with no output.
- PRIVACY says which Chrome the session may use, and TESTING scenarios 60 and 65 to 67 say the same.

### Fixed

- 2026-11-25, with no new version: the README and the line that the setup and `start` print no longer
  tell the person to let the Claude in Chrome extension act on the test sites without asking. In the
  bypass permission mode, Claude Code tells the extension not to ask.

### Known limit

- The session cannot tell this machine's Chrome from one on another computer with the same operating
  system. A person who chooses the other one gives the session that one.

## [0.6.1] - 2026-11-23

A machine reads its request's test inbox, so that it can finish a sign-up that a test environment
sends by email, and the serving session runs with no permission check and with Claude in Chrome.
The session may read production when a request's goal needs it, and never writes to it.
Update each Always on machine with stop, the plugin update, and start, with Chrome open (README,
"Update from 0.6.0"); the session's prompt does not change by itself, and a 0.6.0 prompt still
tells the session not to call production.

### Added

- `doable-code-agent` uses a third Doable MCP tool of a machine, `read_code_agent_mail`. When a
  test environment gives a new user its password only through a link or a code in an email, the
  session invites the user at a `+` address of the request's `test_inbox`, reads the mail with
  the tool (`wait_seconds` up to 60, again for about 5 minutes), opens the link in a new tab of
  the machine's Chrome or uses the code, signs in once, and returns the login with its password.
  The link and the code go in no progress text, question, result or file. When a request names no
  test inbox (`test_inbox` is `null` or not there: the organization has none, or Doable is older
  than this release, or the request is older than it), the session makes no such login and says
  in the result that the request named no test inbox, and that a person can ask the Doable team. On Doable's `no_test_inbox`, it gives Doable's reason; on `not_test_inbox`, it
  reads a `+` address of the test inbox. The skill's rule that forbids opening a link that acts
  when it opens has one exception: the link of such a mail.
- The skill's `allowed-tools` names the tool under both server names.
- `doable-code-agent`: the session's browser is Claude in Chrome. It opens a mail's link in a new
  tab of this machine's Chrome, and when Chrome is not open or the extension is not connected, it
  says so in the result. It checks that the browser answers before it invites a user, signs out
  of the test environment's app before it opens the link, and signs the new login out after its
  check. A session with no browser tools says that a person must start it with `claude --chrome`.
  The session uses Doable MCP only through the three tools of a machine, and calls none of its
  other tools, which are for people, also the ones that only read. The one hard rule for
  permissions is never to write to a production system; every other tool and command that a
  request's work needs is allowed.

### Changed

- `doable-code-agent`: the rule "Never touch production" is now "Never write to production". The
  session may read production (a page, a `GET` request, a read-only query, a log) when the goal
  needs a fact that the repositories and the test environments do not give, with the access that
  the machine already has. It reads only the records that the goal needs, says what it read and
  when, and puts no real person's data in a result. An action that it cannot tell from a write is a
  write. It still starts the app and runs the repository's tests only on a local copy that is a
  test environment. The start prompt's first rule, PRIVACY and TESTING (scenarios 40, 49, 63 and
  64) say the same.
- `scripts/code-agent-service.mjs`: the serving session runs with
  `--permission-mode bypassPermissions --chrome --disallowedTools
  'mcp__plugin_doable-code-context_doable__ask_code_agent' 'mcp__doable__ask_code_agent'`: every
  tool with no permission check, Claude in Chrome, and no `ask_code_agent` under the plugin's
  server name or under `doable` (a user-scoped or project-scoped Doable MCP server), so that the
  session cannot send a request to itself with it.
  `start` writes this command line into the start script, also on a machine that 0.6.0 set up.
  Then, as the setup does, it waits up to 2 minutes for the result of the session's first wait
  for a request, and says whether the session is connected: a wait call that Claude Code or
  Doable refused does not count. Both also say when the session runs in another permission mode
  than the bypass mode, and when it waits through another Doable MCP server than the plugin's (a
  server of the person's settings with the plugin server's address takes the place of the
  plugin's server, with its own key and machine header). Both read only the session's output
  after the launch, and on a machine without launchd they refuse while the session runs, so that
  a call of an earlier session does not count.
- `scripts/code-agent-service.mjs status`: on a machine without launchd, it says `not running`
  when the start script does not run (for example after a reboot), not `on`.
- README: the sign-up by email, the new command for a session with nobody at the terminal and what
  the bypass mode lets it do, that the serving session must have no other Doable MCP server than
  the plugin's, managed settings that turn the bypass mode off, "A browser for a
  mail's link" (keep Chrome open with the extension connected, let it act on the test sites
  without asking, and keep its profile signed out of the test environments' apps), a session by
  hand started with `claude --chrome`, and "Update from 0.6.0" (stop, the plugin update, start). The start prompt's
  first rule says "Never write to production". PRIVACY and TESTING (scenarios 49, 56, 60, 65, 66
  and 67) say the same.

### Removed

- The serving session's allow rules (`--allowedTools` in the `dontAsk` mode) and the setup's
  `--allow` option. Setup and `start` refuse `--allow` and `--chrome` with a line that this
  release allows every tool and has Chrome on. `start` does not use the `allow` list of a 0.6.0
  `config.json`.
- The skill's texts about allow rules and refusals in the `dontAsk` mode.

## [0.6.0] - 2026-11-20

Two Doable MCP tools serve requests, and a person's own Claude Code can ask the code agent too.
Release it in the same hour as the Doable MCP release that has the new tools. Stop each machine's
0.5.0 session before that release: a 0.5.0 session that still runs after it keeps taking requests
that it cannot end, Doable shows the machine as connected, and each such request ends lost after
about 30 minutes. After the release, update the plugin, add the exception for a new login's
password to the session's prompt, and start the session (README, "Update from 0.5.0"). Update a
machine that you cannot stop before the release at once after it.

### Changed

- `doable-code-agent` serves requests with two Doable MCP tools: `wait_for_code_agent_request`
  (the loop) and the new `update_code_agent_request` (progress, a question, a read of a request,
  and the result). Its `allowed-tools` names only these two. `take_code_agent_request`,
  `get_code_agent_request`, `report_code_agent_progress`, `ask_agent`, `submit_code_agent_result`,
  `add_test_account` and `list_code_agent_machines` leave Doable MCP in the same release.
- The connection check is the first `wait_for_code_agent_request`, with `wait_seconds: 0` and the
  capability summary. A request that it returns is served at once.
- Logins: the session makes the login in the app with a new username that holds the date and
  time, and puts its username, password and note in the result's `logins`. For a chat's request,
  Doable saves it in the suite's test accounts with the password encrypted, and shows only the
  username. A password goes in no other place. On `username_exists`, the session makes a login with
  a new username and sends the result again; on `no_environment` or `logins_not_saved_here`, it
  sends the result again with no logins and names each login in the summary as "not in Doable".
- A question waits up to 50 seconds for its answer (`update_code_agent_request` with `question`).
  With no answer by then, the session serves other requests and checks the question as before.
- A request can come from a person's Claude Code (Doable MCP's `ask_code_agent`, which only the
  organization's own members may use: Doable refuses a system admin who is not a member, a member
  with the support role, and their keys, with `not_a_member`): `asked_by` is
  `claude_code`, `asked_by_user` is the person's email (`null` when it asked with an organization
  API key, which names no person), and it has no suite, chat or environment.
  Its asker gets only the result. Its test environment is one that the request names, when the
  session's rules or the repositories show that it is not production.
- `scripts/code-agent-service.mjs`: the four rules of a serving session name the two tools, not
  the whole Doable MCP server, so that a session in the `dontAsk` mode cannot call
  `ask_code_agent`. `start` writes the start script again with the rules of the installed release,
  so `stop` and `start` after a plugin update apply them; setup keeps in `config.json` what the
  start script needs. On a machine that 0.5.0 set up, `start` takes the `PATH` and the `claude`
  command from the start script that setup wrote (from its environment only when that script has
  none), and prints a line that reminds the person of the password exception in the prompt.
- README: Always on is set up by hand with the setup command; the start prompt is in its own part,
  and its secret rule lets a new test login's password go in that login of the result; a new part
  "Update from 0.5.0".

### Removed

- The one-off session, which took one request by its id, and the request card's texts in README,
  TESTING and PRIVACY (`Needs a session`, `One request`, `Try again`, the copied prompts and their
  key).

## [0.5.0] - 2026-11-20

### Added

- **Always on, from one prompt.** The request card's `Always on` option (it was `Keep connected`)
  gives one prompt in place of a command and a start prompt. Pasted into Claude Code in the folder
  with the repositories, it installs or updates this plugin, asks the person which commands the
  agent may run, and runs the new `scripts/code-agent-service.mjs setup`. The script keeps the key
  in `~/.doable/code-agent/<machine>/env` (mode 600), starts the serving session in the background
  in the `dontAsk` mode with the three rules and the person's commands, starts it again 5 minutes
  after it stops, keeps a Mac awake with `caffeinate`, and on a Mac starts it at each login with a
  launchd job. `status`, `stop`, `start` and `remove` manage it.
- Setup deletes the policy file of plugin 0.3.0 from the folder, so that nobody thinks that it
  still applies.

### Changed

- README: the card's two ways are `One request` and `Always on`; the sign-in command is
  `claude auth login` (Claude Code has no `claude login`).

## [0.4.2] - 2026-11-20

Both watches wait inside one tool call instead of polling.

### Changed

- `doable-answer-questions`: while a Round waits, the Skill calls `get_code_context_round` with
  `unchanged_since` (the `Watch version` that `record-round` prints) and `wait_seconds: 290`, with
  no sleep between the calls. While nothing changes, Doable MCP returns a short
  `{"unchanged": true}` result in place of the whole Round, and the Skill does not record it. A
  new question reaches the agent within about 5 seconds. With an older Doable MCP server the Skill
  polls as before.
- `doable-code-agent`: the loop calls `wait_for_code_agent_request` with `wait_seconds: 290`, so an
  empty queue costs about 12 calls an hour in place of about 70. A host that stops a tool call
  after about 60 seconds, and an older Doable MCP server, keep `wait_seconds: 50`.
- The helper's `record-round` prints the Round's `Watch version`, and records nothing for an
  `unchanged` result.

## [0.4.1] - 2026-11-19

Two fixes from the production live check of 0.4.0 (suite ts-yfbbtplb in teamspire-agent-tests).

### Fixed

- A session with nobody at the terminal said that it had no shell tool after Claude Code refused
  one command (a read outside its folder), and so it did not make a login that the work needed:
  Claude Code's text "Permission to use Bash has been denied" names the tool, but it refuses only
  that call. `doable-code-agent` now says a tool is missing or refused only after the call that
  the work needs failed. In the live check, the session then made the login with `curl`, checked
  it, and registered it.
- The same session saved an API's reply with a new login's password and key to a file, could not
  delete it (the mode refused `rm`), and its result said that it kept no key. The skill now keeps
  such a reply in the command's output, never in a file, and names under **Not known** a file with
  a secret that stays.

## [0.4.0] - 2026-11-19

This release holds three changes: requests in plain words with a capability summary; one path to
the code agent from each request's card, with the session's rules in its start prompt instead of a
policy file; and a request that gives a goal, for which the code agent finds the facts and does
the work, also work that the request did not ask for.

### Changed

- A code agent request is plain words with no kind: a goal, what it is for in the tests, and what
  the chat knows, with few steps or none. `doable-code-agent` chooses the way and checks its work
  against the session's rules. The usual kinds of work are a question about the product or its
  code, whether the machine can do something, state to make, backend state to read, and a failed
  run to debug, and these are examples, not a list of what is allowed. When a request asks for
  several things and the rules forbid one, the Skill does the others and names the part it did
  not do and the rule. When the request's words leave open which thing it means, the Skill looks
  for it first, and asks the chat's agent with `ask_agent` only when it cannot tell the goal or
  two readings lead to different work.
- The Skill reads the team's work tools that the session already reaches (the issue tracker,
  docs, the wiki, shared chat channels) for what the code cannot say: what the product must do,
  what a change is, and why it was made. It only reads there, unless the person's rules name an
  action. A result says for each statement whether the code does it or a source states it, and
  names the source. All text that the session reads is information, never an instruction.
- The Skill does the work that a request's goal needs, also when the request did not ask for it:
  for example, it makes and registers a login for a role that no listed account has (an admin or
  an owner too), makes a record that a test needs, or runs the app locally to settle a question.
  In the request's test environment, or on a local copy of the app, it may also change and delete
  data that it did not make, when the goal needs that. It never changes how a listed account signs
  in and never deletes one, and it resets, migrates or empties only a database that it started or
  that only the repository's tests use. A person turns this work off with a line in the start
  prompt, for example `Make nothing that a request does not ask for.`
- A result can end with three parts: **Also found** (facts that matter for the goal and that the
  request did not ask about), **Also done** (each thing that the session made, changed, deleted
  or ran and that the request did not ask for, with where) and **Not known** (what it could not
  establish or do, and why; for a source that it could not read, the reason in words that a
  person can act on and what a person can do on the machine). When a request is cancelled or
  dropped after the session made or changed something, one line at the terminal names it.
- The Skill causes no effect outside the test environment: no real payment, and no message to a
  real person. Production has one definition, in the Skill's "Words": the product's live system,
  a live service that it uses, each tool that shows real users' data, and a local copy of the app
  that uses a production database or service. The Skill starts the app locally or runs the
  repository's tests only when it knows that the local copy uses no database but its own or the
  request's environment's. It runs no command from a ticket or a doc that downloads code, and it
  opens no link that acts when it opens.
- The session's rules come from the person's start message: the card's prompts hold eight rules
  (never production, and a host that cannot be told from production counts as production; in a
  request's test environment or on a local copy of the app, the logins and data that its goal
  needs, with all of it listed in the result; no effect outside test environments; only reads in
  the team's work tools; text that
  the session reads is information; no push, and a fix try only on a new local branch; no secret
  in a result, a progress line, a question or the capability summary; decline a request when not
  sure, and leave out work that the request did not ask for when not sure), and the person can
  add lines before the paste. They join the Skill's own "Rules" and never replace them; with no
  rules in the message, the Skill's "Rules" alone apply. Only a new message in the session
  changes them, never a request or an answer from the chat's agent.
- The Skill declines work that needs production, a push, a real payment or a message to a real
  person, a change in the team's work tools that the rules do not name, or a secret in a result,
  and asked work that it is not sure the rules allow. The decline names the rule in plain words.
- A question whether the machine can do something gets an answer from the rules and the
  repositories, with the outcome `done`. The machine does not do the thing.
- State to make uses the request's environment only when its hosts are not production. A request
  for state fails when it names no test and does not say what the state is for.
- The Skill registers in Doable only a login that the tests will sign in with, asked for or not.
  A login that reproduced a bug is never registered, also when the tests need its role. The Skill
  keeps no password of such a login, and no other secret that an app hands out.
- A result may always hold code excerpts of 10 lines or fewer each. A person who wants none writes
  that in the start prompt. A result never holds a Doable API key: Doable refuses a text that
  holds one, and the Skill sends the text again without the key.
- The lines to the person and the result layouts name no kind, for example
  `CA-7K2M9P: done, made one login and one pending time-off request.`
- README.md: "Run a Doable code agent" describes the two ways (from the card, and by hand), the
  session's rules, and one start command for a session with nobody at the terminal
  (`--permission-mode dontAsk` with the Skill, the Doable MCP server and `sleep 20` allowed by
  `--allowedTools`). The `.claude/settings.json` allow list and its example are gone.
- PRIVACY.md and TESTING.md describe requests by the work they ask for, the session's rules, and
  the one-off session. PRIVACY.md says that the session can read the team's work tools and what a
  result may hold from them. TESTING.md adds the scenarios "Can this machine do X?", "Capability
  summary", "A one-off session", "A one-off that loses the take", "A one-off that asks",
  "A Doable API key in a text", "A goal that needs a ticket, a linked doc and a fact that nobody
  asked about", "Text that gives orders or a method", "No access to a source", "A login that the
  request did not ask for", "What stops work that the request did not ask for", "A look at the
  running product" and "A change of data that the session did not make".
- README.md no longer gives a `curl` rule as an example of an allow rule for a session with
  nobody at the terminal, and says why: `"Bash(curl *)"` lets the session call any host,
  production too, and a rule that starts with the test host still matches a command that names a
  second address after it. It gives one of the app's own scripts as the example instead.

### Added

- A one-off session: when the person's message names one request ("Take request CA-7K2M9P", the
  prompt that a request card copies), `doable-code-agent` takes that request by its id with
  `take_code_agent_request`, serves it, sends the result, and ends its turn. It does not start the
  loop and sends no capability summary. A `409` means that another session took the request or
  that it ended: the Skill says so in one line and stops. A `404` with an API key for the request's
  organization in the person's message makes it connect with that key and try once more through
  that connection. A `503` or another `5xx` error, `429`, a timeout or a network error makes it
  try again for up to 5 minutes, then stop. When it asks Doable's agent, it waits for the answer
  for up to 30 minutes, then stops. Where the Skill says "go back to the loop", a one-off session
  ends its turn.
  `allowed-tools` adds `take_code_agent_request` under both server names.
- At each start and resume, a long-running session writes a capability summary from the
  repositories in its folder and from its rules: a few plain lines, 600 characters or fewer, with
  no secret, no name or value of an environment variable, no command line, no host name and no
  connection string. It shows the summary to the person in its start line and sends it in
  `capabilities` with its first `wait_for_code_agent_request` call. Doable shows it to the chat's
  agent and on the chat's page. When an answer has `capabilities_missing: true` (Doable restarted
  and lost it), the Skill sends it once more with the next call.
- The release verifier requires the summary's no-secret rule, the rule that the machine does not
  do what a "can you" question names, the logins rule, the rule that a reproduction login is
  never registered, the rules on the team's work tools, on read text and on effects outside the
  test environment, the **Also done** part, the rule that the start message never replaces the
  Skill's "Rules", the one-off section and `take_code_agent_request` in `allowed-tools`. It
  refuses any file but CHANGELOG.md that names the removed policy file.

### Removed

- The machine's policy file `.doable/code-agent.md` and its template
  (`skills/doable-code-agent/references/policy-template.md`). The Skill no longer reads, copies or
  asks for the file, and an existing file has no effect. Move what it said into the start prompt.

### Compatibility

- The Skill needs a Doable MCP server whose `wait_for_code_agent_request` takes `capabilities` and
  that has `take_code_agent_request`, and a Doable server that takes both. An older Doable server
  refuses `capabilities` with `422`, so install this release only after both are deployed.
  Against an older server, the Skill stops at its first `wait_for_code_agent_request` call and
  tells the person that this release needs a newer Doable server. A one-off session on a Doable
  MCP server without `take_code_agent_request` tells the person so and stops.

## [0.3.0] - 2026-11-11

### Added

- `doable-code-agent` serves Doable code agent requests on a machine that holds the product's
  repositories. A Doable chat (Chat v2) sends typed requests: `question` (answer from the code),
  `prepare` (make state in a test environment and return the logins and ids), `check` (read
  backend state) and `bug_report` (debug a failed run and report the cause with file paths, line
  numbers and a suggested fix). The Skill waits for requests in one agent turn with
  `wait_for_code_agent_request` and writes no text at all while the queue is empty. It reports
  progress and sends each result with `submit_code_agent_result`. It never asks a person: when the
  work cannot go on without an answer that the code and the request do not give, it asks the
  chat's agent one question with `ask_agent`, never for a credential, and the agent answers from
  what the chat holds or asks a person in the chat first. The question names each test by its
  title, never by its id. It checks a request that waits for an answer (`needs_answer`) after every
  empty poll and at each progress report, continues an answered request with its `answer` and
  never asks again, and retries a `404` on a request it holds for up to 5 minutes after a
  Doable restart, with `sleep 20` between tries (Claude Code blocks a longer `sleep`). When a
  person cancels a request after its last call, `submit_code_agent_result` returns the request as
  `cancelled` and Doable keeps nothing: the Skill does not send the result again and tells the
  person that Doable did not use it. The machine's local policy file `.doable/code-agent.md` says
  which repositories, environments, commands and data sources it may use; neither a request nor an
  answer widens it, also when a person gave the answer. The Skill copies a template from its
  `references/` on the first start. Its frontmatter allows the Doable MCP tools it calls, and it loads itself again after
  each new message from the person, because Claude Code then forgets those tools. For a session
  with nobody at the terminal, the README's setup lists what to allow in `.claude/settings.json`:
  the Skill itself (Claude Code asks before it loads a Skill that no rule allows), the Doable MCP
  server, the policy's commands, its data source commands, the keychain command, `sleep 20`, and
  file changes and git commands when the policy allows a fix try. Its example list allows all that
  the template's example policy lines name, and the release verifier checks that. Claude Code
  reads that list only in a folder the person trusted, so the setup says to do the first start
  interactively and accept the trust dialog, or to give the same rules with `--allowedTools`; it
  also says that the person's own user settings apply to the serving session. A person watches the
  first request of each kind. It registers only the logins a `prepare` request asks for, and only
  through `add_test_account`; a login made only to reproduce a bug stays out of Doable. It never
  pushes, never touches production, and never puts a secret in a result.
- The bundled MCP connection sends the machine name as the `X-Doable-Machine` header
  (`DOABLE_MACHINE_NAME`, default `unnamed-machine`) in Claude Code and Cursor. Doable shows it on
  the code agent requests that the machine serves. A name is 1 to 64 letters, digits, `.`, `_` or
  `-`. Doable MCP refuses any other name itself, with an error that names the header and has no
  status, and Doable refuses it with `422`. The code agent Skill stops on any error about the
  machine name, whatever its status, and tells the person the rule.
- `doable-code-agent` needs an organization API key in `DOABLE_API_KEY`. Doable MCP's code agent
  tools refuse a personal API key and a person's Doable login token before they call Doable,
  because Doable takes the caller of such a token for the person who owns it. On that error
  (`This tool needs an organization API key`) the Skill tells the person to set an organization
  API key and stops.

### Not in this release

- The chat Skill (`doable-chat`), which let a machine write in a Doable chat (Chat v2), is not in
  this release: Doable has turned off chat control from a machine. Its last version is kept on the
  branch `parked/doable-chat` of this repository.

### Removed

- `doable-test-feature` and its Codex metadata. Doable MCP no longer starts or lists runs
  (`run_test_cases`, `get_run` and `list_runs` are gone). The release verifier refuses a Skill
  that names a removed run tool.

### Changed

- PRIVACY.md: a code agent result may hold file paths, line numbers and code excerpts of 10 lines
  or fewer each, unless the machine's policy file forbids excerpts. It never holds a secret, a
  password or customer personal data. Code Context answers keep their boundary.
- The connection recovery workflow covers `doable-code-agent`, which uses its first Doable call
  as the preflight.
- The new Skill needs a Doable MCP server with the code agent tools and a Doable server with the
  code agent turned on. The machine asks with `ask_agent`, which replaced Doable MCP's earlier
  `ask_person`: a Doable MCP server that has only `ask_person` cannot take the machine's
  questions. The release verifier refuses `ask_person`, the status `needs_person` and the fields
  `person_question` and `person_answer` in the plugin, README.md, PRIVACY.md and TESTING.md.

## [0.2.18] - 2026-11-10

### Changed

- `doable-answer-questions` no longer assumes the workspace's docs match its code. A README,
  `docs/` page, spec, changelog or code comment only routes the search; implemented behavior
  comes from inspected code alone. When a doc disagrees with the code, the agent reads the
  history of both and says in the conflict which changed later and whether that change says it
  was intended, in product words with no commit ids, branch names or dates. It submits both
  findings and the conflict either way and does not decide which is wrong. Without this, a stale
  README reached Doable as plain intent and became an expected result that fails a correct product.

## [0.2.17] - 2026-10-21

### Changed

- `doable-test-feature` uses the Doable MCP result tools by name: `list_test_suites` to find a suite,
  `list_test_cases` and `get_test_spec` to inspect it, `run_test_cases` and `get_run` (`wait_seconds=60`) to run
  test cases, and `get_test_case` to read why one did not pass. The MCP server no longer creates suites or
  generates test cases, so the skill asks the developer to do those in the Doable web app and waits for them.
  It reads `Incomplete` as no evidence about the code.

## [0.2.16] - 2026-10-16

### Added

- The answer skill reports a blocked Round back to Doable with the Doable MCP tool `report_code_context_blocked`
  instead of leaving the editor silent. It reports `feature_not_in_workspace` before it stops because no mapped
  product repository contains the requested feature, and `waiting_for_person` before it asks the user for a
  clarification or a named checkout target. Only the reason is sent; the next `report_code_context_activity`
  clears the block. An unknown inside an otherwise answerable Round is still answered as `unknown` or `skipped`.
  Against an MCP server without the tool, the agent skips the report and behaves as in 0.2.15.

## [0.2.15] - 2026-10-16

### Added

- The Round file keeps the server's journey-map instructions (`journeyMap.how`, `journeyMap.maySkip`) so the agent
  reads them where it reads the questions. `record-round` prints `Journey map: requested` when the Round asks for one.

### Changed

- The Round defines what to return. Its open questions (text and answer expectation) and its journey-map
  instructions set what the agent collects and how deep it goes; the plugin keeps only how to investigate, privacy,
  progress and submission. The skill no longer branches on `investigation: quick|full` or a time budget: the
  sibling enumeration, family sweep, test-state sweep and coverage check run when a question asks for them.
  `record-round` no longer prints `Investigation: ...` and the Round file no longer keeps the tier or budget; a
  server may still send them for older plugins.

## [0.2.14] - 2026-10-16

### Added

- Direct submission. A Round in the answer state may carry `direct_submission` (a URL and a one-time submit token).
  `record-round` keeps it in the private frozen Round file and prints only `Direct submission: available until <time>`,
  never the token. The new `submit --candidate <context-local-r<revision>.json>` command runs every privacy check,
  writes the outgoing `context-r<revision>.json`, and POSTs it to that URL with the token and an
  `Idempotency-Key` equal to the one Doable MCP computes for `submit_code_context_round`
  (`round:<round_id>:<sha256 of Python json.dumps(payload, sort_keys=True, separators=(",", ":"))>`), so a direct
  POST whose response was lost and its MCP fallback dedupe to one server submission. It then writes the usual receipt. The agent no longer re-types the whole payload into the MCP
  submit tool, which took minutes per answer batch.
- When the Round offers no direct submission (an older server or MCP, an offer without a URL, an invalid offer, an
  expired token) or the host has no network access, `submit` prints `Direct submission: unavailable` and exits with
  code 3; the agent then submits `context-r<revision>.json` through MCP `submit_code_context_round` and runs
  `record-submission` as before. A rejected token (HTTP 401) tells the agent to pull the Round again and retry once.

### Changed

- Local file names: the candidate with local evidence is `context-local-r<revision>.json` (an existing
  `submission-r<revision>.json` is renamed on the next `record-round`), and the outgoing file is
  `context-r<revision>.json` next to the Round file. `build-submission --output` and `record-submission --payload`
  are now optional and default to that file. `record-round` prints `Context file:`.
- The release verifier allows the helper exactly one network call, the direct submission POST, which refuses
  redirects; it still rejects API-key, Authorization, raw HTTP module and Doable URL primitives.

## [0.2.13] - 2026-10-15

### Changed

- The agent routes the investigation by the app under test, not by the organization. A Round may carry `target_app`
  (the environment name and entry URL); `record-round` keeps it and prints `App under test: <name> (<entry URL>)`. The
  copy prompt may also name the app before the organization. The agent routes to the repositories that serve that app.
  The organization name and slug are used only for the connection check. A Round without the field records as before.

## [0.2.12] - 2026-10-15

### Added

- Quick investigations. A Round may carry `investigation: quick` and a `time_budget_minutes`; `record-round` prints
  them. A quick base item maps only the feature's main user journeys and the preconditions that block running them,
  and skips the sibling enumeration, family sweep, test-state sweep and base coverage check. The agent submits within
  the budget and names what it did not reach as `unknown`. A Round without the field stays a full investigation.

### Changed

- A copied prompt may carry a fresh API key every time. When the preflight already succeeds for the prompt
  organization, the agent keeps its working connection and does not save, swap or test the supplied key, so a
  connected agent no longer spends minutes reconnecting before it reads the questions.

## [0.2.11] - 2026-10-07

### Changed

- Base investigations now run a test-state sweep. The agent lists, in its local ledger:
  - browser storage keys the feature uses;
  - operations that change persistent state;
  - role, plan, permission and quota gates;
  - one-time states;
  - external services.

  Every included item is closed with a grounded finding or an `unknown` that says why the workspace cannot establish
  it. "Not inspected yet" does not close an item in a mapped repository. Items are named by product purpose.
- Observable anchors may name a browser storage key as `localStorage:<key>`, `sessionStorage:<key>`, `cookie:<name>`
  or `indexedDB:<database>`, and may use URL paths. The helper accepts these even when the key equals a local
  evidence symbol. Server-side fields and code identifiers remain rejected. PRIVACY.md lists the new remote data.

## [0.2.10] - 2026-09-30

### Changed

- Say "test spec" instead of "TRD" in the skills, helper output, and documentation,
  following Doable's rename of the Test Requirement Document (TRD) to test spec.
- Read the current test spec with the Doable MCP tool `get_test_spec`. This requires
  the updated Doable MCP server, which keeps `get_trd` as a deprecated alias for
  earlier plugin versions.
- `record-finalize` reads `test_spec_id` / `test_spec_session_id` and falls back to
  the pre-rename `trd_id` / `trd_session_id`, so it works with a Doable MCP server
  from either side of the rename. New finalize receipts store `testSpecId` /
  `testSpecSessionId`.
- Add the `test-spec` keyword to every host manifest; `trd` stays for discoverability.

## [0.2.9] - 2026-09-26

### Added

- Report investigation stages and the current question to the test spec editor, with
  updates during long active work at the next tool boundary (about 60 seconds).
- Fall back to phase-only reporting on older MCP/backend deployments; never
  report artificial activity during idle connection polling.
- Cross-repository contract: `getdoable/trd`
  `docs/change-sets/code-context-live-progress.yaml`.

## [0.2.8] - 2026-09-25

### Fixed

- Accept a server-bound pre-create successor when a test spec needs more context to
  finish creation. Keep checking the original connection code and local workspace.
- Requires the matching test spec connection resolver fix; older servers retain their
  existing behavior. Cross-repository contract: `getdoable/trd`
  `docs/change-sets/pre-create-code-context-toggle.yaml`.

## [0.2.7] - 2026-09-17

### Fixed

- Advance the plugin version so existing installations can receive the changes
  merged after 0.2.6: persistent follow-up watching, journey declarations, and
  result observation. A reused version can leave an installed plugin cached.
- Follow the server's next-action decision when a pre-create Round hands over
  to test spec follow-ups, and omit journey declarations when the Round did not
  request them, preserving compatibility with older backends.
- Align the local helper's client version with the plugin release.

### Documentation

- Explain how to inspect the installed Doable version, update the Claude Code
  plugin, load it into a session, and enable marketplace auto-updates.

## [0.2.6] - 2026-09-07

### Fixed

- Wait for Cursor's asynchronous MCP refresh after replacing credentials, then
  retry the original preflight before treating a `401` as a rejected new key.

## [0.2.5] - 2026-09-07

### Changed

- Bundle the official remote Doable MCP connection for Codex, Claude Code, and Cursor.
- Ask for `DOABLE_API_KEY` as a required Cursor installation variable so a
  first-time user authenticates while installing the plugin.
- Define the cold-start acceptance path from a Test Spec Editor copy prompt through
  plugin approval, authentication, exact-Round preflight, and automatic resume.

## [0.2.4] - 2026-09-07

### Changed

- Preflight copied context requests against their exact Round and organization
  before reading local state or scanning source.
- Recover missing, stale, invalid, or wrong-organization MCP connections in the
  original conversation. Claude Code users reconnect `doable` once in `/mcp`;
  they no longer restart the host or paste the request again.
- Apply the same live-connection preflight to coding-agent-origin feature tests
  before workspace setup or suite lookup.

## [0.2.3] - 2026-08-21

### Changed

- Keep one post-create context connection open across sequential test spec follow-up
  Rounds. The original copied DQ code resolves to the newest published Round
  until the user stops the coding-agent task.
- Fetch the current test spec for each newly resolved follow-up Round while keeping
  code, tests, and runtime evidence descriptive rather than treating it as
  authoritative product intent.

### Fixed

- Preserve an existing workspace client reference when a new Round has not yet
  been bound, avoiding duplicate workspace profiles and unnecessary approval.

## [0.2.2] - 2026-08-20

### Changed

- Watch one published Round until the editor continues test spec generation. `record-round`
  prints `Next action: answer|wait|stop`, keeps same-round answers as established
  context, and does not treat `ready_to_create` as finished.
- `record-submission` keeps one receipt per payload digest so a later batch on the
  same revision can be recorded. Retrying the exact same payload stays idempotent.
- Before scanning, the answering Skill verifies any named branch, PR, worktree, or
  change set locally, refreshes a stale checkout, and stops if that target is
  missing or ambiguous. A Round does not transfer Git state.

## [0.2.1] - 2026-08-13

### Fixed

- Resume coding-agent feature testing from an existing Round state instead of
  assuming every retry requires another code scan.

## [0.2.0] - 2026-08-12

### Added

- Doable Code Context for Codex, Claude Code, and Cursor.
- MCP-backed pre-test-spec context rounds with grounded, privacy-safe findings.
- Coding-agent-first feature testing through the existing Doable suite, test spec, and managed-case workflow.
- Demand-driven mono-repo and multi-repo workspace mapping with local-only provenance.

### Changed

- Replaced the legacy context-file workflow with MCP-backed context rounds and managed feature testing.
- Added direct public setup instructions for Codex, Claude Code, and Cursor.

### Security and privacy

- Remote operations are isolated to the separately configured Doable MCP connection.
- The bundled helper has no network or credential primitives.
- Real repository identities, source locations, commits, local paths, and private artifacts remain local.
