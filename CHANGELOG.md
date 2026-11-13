# Changelog

All notable changes to Doable Agent Plugins are documented here.

## GitHub workflow distribution [1.0.0] - 2026-10-03

- Publish the self-contained Code Context workflow with a SHA-256 release manifest.
- Add customer-agent installation, provider setup, connection, and upgrade instructions.
- Verify template integrity and syntax in CI. Local plugin version remains 0.2.10.
- Clarify the GitHub integration's repository metadata and model-provider boundary.

## [0.3.0] - 2026-11-11

### Added

- `doable-code-agent` serves Doable code agent requests on a machine that holds the product's
  repositories. A Doable chat (Chat v2) sends typed requests: `question` (answer from the code),
  `prepare` (make state in a test environment and return the logins and ids), `check` (read
  backend state) and `bug_report` (debug a failed run and report the cause with file paths, line
  numbers and a suggested fix). The Skill waits for requests in one agent turn with
  `wait_for_code_agent_request` and writes no text at all while the queue is empty. It reports
  progress, sends each result with `submit_code_agent_result`, and asks a person with
  `ask_person` only when the work cannot go on without one, never for a credential. It checks a
  request that waits for a person after every empty poll and at each progress report, continues
  an answered request with its `person_answer` and never asks again, and retries a `404` on a
  request it holds for up to 5 minutes after a Doable restart, with `sleep 20` between tries
  (Claude Code blocks a longer `sleep`). The machine's local policy file `.doable/code-agent.md`
  says which repositories, environments, commands and data sources it may use; neither a request
  nor a person's answer widens it. The Skill copies a template from its `references/` on the
  first start. Its frontmatter allows the Doable MCP tools it calls, and it loads itself again
  after each new message from the person, because Claude Code then forgets those tools. For a
  session with nobody at the terminal, the README's setup lists what to allow in
  `.claude/settings.json`: the Skill itself (Claude Code asks before it loads a Skill that no rule
  allows), the Doable MCP server, the policy's commands, its data source commands, the keychain
  command, `sleep 20`, and file changes and git commands when the policy allows a fix try. Its
  example list allows all that the template's example policy lines name, and the release verifier
  checks that. A person watches the first request of each kind. It registers only the logins a
  `prepare` request asks for, and only through `add_test_account`; a login made only to reproduce
  a bug stays out of Doable. It never pushes, never touches production, and never puts a secret in
  a result.
- `doable-chat` drives a Doable chat through Doable MCP: `start_chat`, `send_chat_message`,
  `read_chat`, `answer_chat_questions`, `run_chat_proposal`, `get_chat_run` and `stop_chat`. It
  starts runs only when someone asked for them, and debugs a failed run in the local code. Doable
  shows its messages and card answers as the machine's: they are the code's reading, never the
  person's decision. It answers only a card that the code settles. It never answers a write card
  (a Jira ticket or a result correction), a card that decides a conflict (Doable refuses a
  machine's answer to both) or a question about what the product should do, and it never passes
  on the person's decision in a message: it tells the person to answer on the Chat v2 page. While
  such a card holds the chat's agent (kind `question` in `read_chat`'s `waiting_cards`), it sends
  no message to that chat, because a message closes that card with no answers. An open card of
  auto mode (kind `open`) does not hold the agent and stays open after a message, so it does not
  block one. A stop closes every waiting card of both kinds with no answers, so it does not call
  `stop_chat` while such a card of either kind waits. When `start_chat` sends nothing because the suite's chat waits for a card's answers,
  it reads that chat, answers the card only when the code settles it or else tells the person to
  answer it on the Chat v2 page and waits, then sends with `send_chat_message`. When a test looks
  wrong, it asks the chat to put the question to its person.
- The bundled MCP connection sends the machine name as the `X-Doable-Machine` header
  (`DOABLE_MACHINE_NAME`, default `code-agent`) in Claude Code and Cursor. Doable admits an
  organization API key on the chat routes only with this header. A name is 1 to 64 letters,
  digits, `.`, `_` or `-`. Doable MCP refuses any other name itself, with an error that names the
  header and has no status, and Doable refuses it with `422`. The Skills stop on any error about
  the machine name, whatever its status, and tell the person the rule.

### Removed

- `doable-test-feature` and its Codex metadata. Doable MCP no longer starts or lists runs
  (`run_test_cases`, `get_run` and `list_runs` are gone); ask Doable's chat to test a feature with
  `doable-chat` instead. The release verifier refuses a Skill that names a removed run tool.

### Changed

- PRIVACY.md: a code agent result may hold file paths, line numbers and code excerpts of 10 lines
  or fewer each, unless the machine's policy file forbids excerpts. It never holds a secret, a
  password or customer personal data. Code Context answers keep their boundary.
- The connection recovery workflow covers `doable-code-agent` and `doable-chat`, which use their
  first Doable call as the preflight.
- The new Skills need a Doable MCP server with the code agent and chat tools and a Doable server
  with the code agent turned on.

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
