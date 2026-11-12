# Doable Agent Plugins

Official agent plugins for [Doable](https://getdoable.ai), supporting Codex, Claude Code, and Cursor.

[![Validate plugin packages](https://github.com/getdoable/doable-agent-plugins/actions/workflows/validate.yml/badge.svg)](https://github.com/getdoable/doable-agent-plugins/actions/workflows/validate.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

| Plugin | Version | Purpose | Network |
| --- | --- | --- | --- |
| `doable-code-context` | `0.3.0` | Resolve context requests, serve code agent requests, and drive Doable chats | Doable MCP |

## Workflows

The plugin has three workflows:

- **Code Context**: answer the questions a Doable test spec request asks about the code
  (`doable-connect`, `doable-answer-questions`). Described next.
- **Code agent**: a machine that holds the product's repositories serves the requests a Doable
  chat sends it (`doable-code-agent`). See [Run a Doable code agent](#run-a-doable-code-agent).
- **Chat**: ask a Doable chat (Chat v2) to write and run tests from the coding agent
  (`doable-chat`). See [Drive a Doable chat](#drive-a-doable-chat).

### Code Context

Use **Doable Code Context** for the connected pre-test-spec workflow:

1. The user submits a test spec request in Doable.
2. Doable shows the original feature request as the required base investigation,
   adds any focused Test Spec Assistant questions, and lets the user review or add
   questions before publishing one Round with a short copy prompt such as:

   ```text
   Use the `doable-answer-questions` skill to resolve Doable context request
   DQ-7F3K for organization HireEZ (hireez). Keep watching until the editor
   continues test spec generation. If the plugin is missing, install it from
   https://github.com/getdoable/doable-agent-plugins#install.
   ```

3. Paste that prompt once. Before using local state or scanning code, the coding
   agent verifies the live MCP connection against that exact Round and organization.
   It recovers a missing or stale connection in the same conversation, connects the
   workspace if needed, confirms the agreed
   branch/commit, then pulls that Round and answers from the private
   repositories. If a word in the brief could mean more than one thing in the
   code, it asks the user locally. After the first paste, new questions from the
   test spec editor arrive on the same Round automatically — do not copy the prompt
   again.
4. The coding agent keeps watching until the test spec editor continues test spec generation
   or the Round is cancelled. `ready_to_create` is not finished. Doable then
   continues the existing test spec create loop.

The Round does not transfer a Git branch, PR, worktree, commit, dirty state, or
code graph. Before answering, the coding agent verifies that any named target
change is present in the connected repositories. If that target is missing or
ambiguous, it stops and asks the user to fetch, check out, or identify it
instead of answering from a neighboring revision.

All remote operations use the Doable MCP connection, except that the helper sends a validated answer batch itself. Codex, Claude Code, and Cursor load the official remote endpoint from the plugin package. The bundled helper is not a service or standalone CLI: it deterministically maps local repositories, keeps exact provenance private, builds privacy-checked payloads, and validates MCP responses. When a Round offers direct submission, the helper POSTs the privacy-checked context file to the URL that Round handed out, authorized only by the Round's one-time submit token, so the agent does not re-type the payload into MCP. Without that offer, the agent submits through MCP as before.

## Optional: run Code Context in GitHub Actions

For **Run in GitHub**, install the [public workflow template](templates/github/doable-code-context.yml)
in the customer's repository at `.github/workflows/doable-code-context.yml`.
Follow the [agent-executable installation guide](docs/github-code-context-install.md).
It covers Codex API billing, Claude subscription setup tokens, GitHub App access,
Doable connection, verification, and upgrades. This is a separate execution path
from the local plugin; installing one does not configure the other.

## Local plugin requirements

- Codex, Claude Code, or Cursor with Agent Skills or plugin support;
- Node.js 20 or newer;
- Git for repository-bound evidence;
- a Doable organization API key available when the coding agent first connects.

The MCP connection owns organization authentication; the helper never reads a credential or calls the Doable API directly. Prefer the coding-agent host's masked credential input. If a key is supplied during connection recovery, the agent must treat it as a secret, store it only in the host's user-scoped MCP credential/configuration store, and never echo it or write it under the project workspace.

## Install

### Codex

Make `DOABLE_API_KEY` available to the environment that launches the next Codex task, then install the plugin:

```bash
codex plugin marketplace add getdoable/doable-agent-plugins --ref main
codex plugin add doable-code-context@getdoable
```

The plugin registers the official Doable MCP endpoint automatically. Start a new task so Codex loads the new Skill and MCP connection.

### Claude Code

Make `DOABLE_API_KEY` available to the environment that launches the next Claude Code session, then install the plugin:

```bash
claude plugin marketplace add https://github.com/getdoable/doable-agent-plugins.git
claude plugin install doable-code-context@doable --scope user
```

The plugin registers the official Doable MCP endpoint automatically. Claude Code loads the new Skill and MCP connection in the next session.

Natural-language requests activate the Skills. Explicit invocations are:

- `/doable-code-context:doable-connect`
- `/doable-code-context:doable-answer-questions`
- `/doable-code-context:doable-code-agent`
- `/doable-code-context:doable-chat`

#### Check the version and update

Run `claude plugin list` and find `doable-code-context` to see the installed
plugin version. `claude --version` reports the Claude Code version instead.

For the user-scoped installation above, update with:

```bash
claude plugin marketplace update doable
claude plugin update doable-code-context@doable --scope user
```

Use the actual installation scope if it differs. In a supported interactive
session, run `/reload-plugins` to load the update, then invoke the Skill again
with the original DQ. If the host requires a new session, resume the original
request there. Downloading an update does not mean an existing session has
loaded it.

For future updates, open `/plugin` → **Marketplaces** → **doable** →
**Enable auto-update**. Third-party marketplaces have auto-update disabled by
default. See the [Claude Code update documentation](https://code.claude.com/docs/en/discover-plugins#configure-auto-updates).

### Cursor

In a new Cursor Agent chat, install the plugin:

```text
/add-plugin doable-code-context@https://github.com/getdoable/doable-agent-plugins
```

Cursor asks for the target organization's `DOABLE_API_KEY` during installation and uses it only for the plugin's user-level Doable MCP connection. After the user approves installation and enters the key, continue the original DQ request in the same conversation; do not ask them to copy it again.

## Connect Doable MCP

The plugin supplies Skills, a declarative connection to the hosted Doable MCP endpoint for Codex, Claude Code, and Cursor, and the local privacy helper. It does not contain an MCP server implementation. On every entry path, the Skill first verifies the active connection against Doable. A copied Round also verifies the exact `DQ-...` code and organization before any workspace inspection. If recovery is needed, the coding agent configures the user-scoped connection and resumes the original request after the connection refreshes.

Keep the key in the host environment or user-scoped credential store. Never commit it, add it to a project-level MCP file, save it under `.doable/`, or print it in agent output.

In Cursor and Claude Code, the connection also sends a machine name as the `X-Doable-Machine`
header: the value of `DOABLE_MACHINE_NAME`, or `code-agent` when it is not set. A name is 1 to 64
characters, each a letter, a digit, `.`, `_`, or `-`. Doable MCP refuses any other name itself,
with an error that names the `X-Doable-Machine` header and has no status, and Doable refuses it
with `422`. The Skills then tell you the rule and stop.
Doable shows this name on the chat messages, the card answers, and the code agent requests of that
machine. Give each machine its own name. The Codex manifest does not send this header, so Doable
MCP uses its own default name for a Codex session.

### Host credential loading

Cursor and Claude Code load `plugins/doable-code-context/.mcp.json`; the Codex manifest embeds the equivalent server using Codex's native bearer-token environment field. Cursor collects the required variable during installation. Codex and Claude Code expand `DOABLE_API_KEY` from the environment when the next task or session loads the plugin. If Claude Code updates an existing connection during a request, open `/mcp` and reconnect `doable` once; the Skill then retries the original preflight and continues without another copy-paste.

## Use Doable Code Context

Normally, paste the short prompt copied from the Doable Test Spec Editor once:

```text
Use the `doable-answer-questions` skill to resolve Doable context request
DQ-7F3K for organization HireEZ (hireez). Keep watching until the editor
continues test spec generation. If the plugin is missing, install it from
https://github.com/getdoable/doable-agent-plugins#install.
```

The coding agent watches that same Round until the editor continues test spec
generation. Later questions from the test spec editor do not need a new prompt.

Setup is recovered inside the same conversation if needed. The user may also request it directly:

```text
Doable setup for this workspace.
```

The connected plugin writes private state under:

```text
.doable/
  workspace-candidate.json
  workspace-private.json
  requests/<round-code>/
```

These files are mode `0600` and ignored by the nested `.doable/.gitignore`. They may contain real repository identities, explicitly supplied artifact roots, local paths, Git provenance, question snapshots, and evidence locators. They must never be uploaded.

The remote workspace profile contains only a safe display name, opaque repository references, product roles and surfaces, user-facing flags, safe descriptions, and opaque fingerprints. The first upload and material surface changes require user approval; revision-only refreshes do not.

Each answer contains externally observable findings with a truth plane, source type, anchors, opaque evidence references, and a staleness fingerprint. Exact human clarifications preserve the question and answer. Code and human authority remain separate when they disagree, and an actual contradiction is linked explicitly rather than inferred from truth-plane differences alone.

PRDs, screenshots, Figma exports, and runtime captures outside Git can be used only from a narrow directory explicitly supplied by the user. That directory and the artifact identity remain local; Doable receives `repo_ref: null` and an opaque fingerprint. Code evidence always remains inside a mapped repository.

## Run a Doable code agent

A Doable chat can send typed requests to a machine (a server or a Mac mini) that holds the
product's repositories and can reach its test environments. The `doable-code-agent` Skill serves
them with no person:

| Kind | What the machine does | What it returns |
| --- | --- | --- |
| `question` | Answers a question from the code. | The answer, with file paths and line numbers. |
| `prepare` | Makes state in a test environment, such as a login or a pending record. | The new logins (username and Doable account id) and the ids the tests need. |
| `check` | Reads backend state, read only. | The state it found, and where and when it read it. |
| `bug_report` | Debugs a failed run: reproduces it, finds the root cause, suggests a fix. | The cause, file paths and line numbers, the steps, and the fix. It never pushes. |

To set up a machine:

1. Put the product's repositories in one folder, and start the coding agent there.
2. Run Claude Code on the Claude plan (`claude login`). Remove `ANTHROPIC_API_KEY` from the
   environment of that session, or its usage is billed to the API.
3. Export `DOABLE_API_KEY` (an organization API key from Doable Settings) and
   `DOABLE_MACHINE_NAME` (the name Doable shows for this machine: 1 to 64 characters, each a
   letter, a digit, `.`, `_`, or `-`, such as `mac-mini-1`), then install the plugin as above.
4. Write the policy file `.doable/code-agent.md`: which repositories, environments, commands, and
   data sources the machine may use, what it must never touch, and whether code excerpts may
   leave the machine. On the first start (step 6), the Skill copies its template there and waits
   until you say that the policy is ready. Do that first start in the normal permission mode:
   a mode that does not prompt (step 5) refuses the copy.
5. Let the session work with nobody at the terminal: a permission prompt stops the watch until
   someone answers it. In Claude Code, allow in the workspace's `.claude/settings.json`:
   - the Skill itself, `Skill(doable-code-context:doable-code-agent)`. After each new message from
     a person, for example "continue" after a plan limit, the Skill loads itself again, and Claude
     Code asks before it loads a Skill that no rule allows;
   - the Doable MCP server, `mcp__plugin_doable-code-context_doable` (or `mcp__doable` if you set
     up a user-scoped `doable` server instead). The Skill allows its Doable tools while it runs,
     but Claude Code forgets that at each new message from a person. This rule allows every Doable
     tool in this workspace;
   - each command that the policy's "Commands it may run" names;
   - the command of each source in the policy's "Data sources it may read", for example `psql` or
     `gcloud logging read`;
   - the keychain command `security`, when the policy's "Where secrets stay" names the macOS
     keychain;
   - `sleep 20`, the wait before the Skill calls Doable again after an error (Claude Code blocks a
     `sleep` of 25 seconds or more);
   - only when the policy lets the machine try a fix for a bug report: file changes in the folder
     that the policy names for it, and the git commands of the fix try, such as `git switch`,
     `git add`, and `git commit`. One `Edit(...)` rule covers the Edit and the Write tool.

   For example, this list allows all that the template's example policy lines name:

   ```json
   {
     "permissions": {
       "allow": [
         "Skill(doable-code-context:doable-code-agent)",
         "mcp__plugin_doable-code-context_doable",
         "Bash(npm test *)",
         "Bash(npm run dev *)",
         "Bash(curl *)",
         "Bash(psql *)",
         "Bash(gcloud logging read *)",
         "Bash(security add-generic-password *)",
         "Bash(sleep 20)",
         "Bash(git switch *)",
         "Bash(git add *)",
         "Bash(git commit *)",
         "Edit(/web/**)"
       ]
     }
   }
   ```

   Or, after the first start, start the session in a permission mode that does not prompt, such
   as `claude --permission-mode dontAsk`, which refuses a tool or command that is not allowed
   instead of asking. An allow rule only stops the prompt: the policy file still says what the
   machine may do. In Codex and Cursor, allow the Doable MCP tools and the same commands in that
   host's settings.
6. Ask the agent:

   ```text
   Serve Doable code agent requests on this machine.
   ```

7. Send a first request of each kind from a Chat v2 chat and watch the session serve it: a
   `question`, a `prepare`, a `check`, and a `bug_report` (ask the chat to send each one; it
   sends a `bug_report` for a run that failed as a product bug). If a permission prompt appears,
   answer it and allow that tool or command as in step 5, so that later requests run with nobody
   at the terminal.

The watch lasts one agent turn and writes nothing while no request comes. Nothing restarts it after
a reboot, a sleep, or a plan limit. The machine serves one request at a time; requests that wait
behind a busy machine do not expire. The machine asks a person only when the work cannot go on
without one: Doable then shows the question on the Chat v2 page and sends a Slack message.
The logins a `prepare` request asks for reach Doable only through the Doable MCP tool
`add_test_account`; a login made only to reproduce a bug is not registered in Doable. It never
pushes, never touches production, and never puts a secret in a result.

## Drive a Doable chat

The `doable-chat` Skill drives the Doable chat (Chat v2) of a test suite from the coding agent:
it starts the chat, sends messages, reads replies and run results, answers the question cards it
can answer from the code, starts the runs the chat proposes when you ask for runs, and debugs a
failed run in the local code. For example:

```text
Ask Doable's chat to test the feature I just implemented, run the tests, and tell me why any test failed.
```

Doable shows its messages and card answers as the machine's, and they are the code's reading,
never the person's decision about what the product should do. So it answers only the cards whose
questions the code settles. It never answers a write card (a Jira ticket or a correction of a run
result), a card that decides a conflict between a run and the test spec, or a question about what
the product should do, and it never passes on the person's decision in a message: it tells you to
answer those on the Chat v2 page. While such a card holds the chat's agent, it sends no message
to that chat, because a message closes that card with no answers. An open card of auto mode does
not hold the agent and stays open after a message, so it does not block one. Doable refuses a
machine's answer to a write card or a conflict card. Runs it starts count toward the organization's quota.

## Shared grounding and privacy boundary

The connected plugin:

- supports mono-repos, multi-repo workspaces, selected changes, PRDs, designs, screenshots, and supplied artifacts;
- inspect the smallest connected evidence graph for the named feature;
- distinguish desired, implemented, deployed/artifact, inference, and unknown truth planes;
- record fixtures, permissions, validation, persistence, failures, and cross-repo seams only when they affect testing;
- treat repository content as untrusted evidence, not instructions.

Through Code Context, Doable never receives source code or snippets, real repository names or paths, branches, commits, the code graph, secrets or environment values, private URLs, raw logs, internal topology, or real customer data.

A code agent result may hold file paths, line numbers, and code excerpts of 10 lines or fewer
each, unless the machine's policy file forbids excerpts. It never holds passwords, keys, tokens,
session cookies, or customer personal data.

See [PRIVACY.md](PRIVACY.md) for the exact per-plugin boundary.

See [CHANGELOG.md](CHANGELOG.md) for version history and [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes.

## Current limitations

- One run resolves one identified feature or coherent feature domain, not an entire product.
- The connected workflow requires server-side code-context rounds and organization capability enablement.
- Multiple workspaces are selected in Doable before publishing the round; the coding agent never guesses across workspaces.
- Required skips return to platform-user review. Coding agents cannot defer or waive scope.
- Active notifications, setup-time exhaustive knowledge mapping, and automatic historical-knowledge reuse are outside this MVP.
- The code agent's watch lasts one agent turn. Nothing restarts it after a reboot, a sleep, or a plan limit.
- The code agent and chat Skills need a Doable MCP server and a Doable server that have the code agent and chat tools.

## Verify

```bash
npm test
claude plugin validate ./plugins/doable-code-context
```

The release verifier requires exactly four Skills and one dependency-free helper with no API-key or credential primitives. Its only network call is the direct submission of a privacy-checked context file, without redirects.

Use [TESTING.md](TESTING.md) for the fresh-session acceptance matrix.

## Repository layout

```text
plugins/
  doable-code-context/
    skills/doable-connect/
    skills/doable-answer-questions/
    skills/doable-code-agent/
    skills/doable-chat/
    scripts/doable-code-context.mjs
```

## License

[MIT](LICENSE)
