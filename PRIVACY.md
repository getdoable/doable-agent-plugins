# Privacy and data handling

Repository inspection happens inside the coding agent selected by the customer and remains subject to that agent provider's data-handling terms. The Doable plugin does not grant Doable repository access.

## Doable Code Context

`doable-code-context` performs remote operations only through the Doable MCP connection loaded by the coding-agent host. The plugin package declares the official endpoint, a credential-variable reference, and a machine name header (`X-Doable-Machine`, from `DOABLE_MACHINE_NAME`, default `unnamed-machine`) for Cursor and Claude Code; it contains no credential value. Doable shows the machine name on the code agent requests that machine serves. The coding-agent host owns the resolved credential. During recovery, the Skill may direct the host to configure a user-supplied key in its user-scoped MCP credential/configuration store, but the bundled helper never reads or persists it and no credential may enter the project workspace or a remote Doable payload.

Its local `.doable/workspace-candidate.json`, `.doable/workspace-private.json`, and `.doable/requests/` records may contain real repository identities, explicitly user-supplied artifact roots, local paths, Git provenance, exact evidence locators, and frozen Doable questions. They are written with private permissions and ignored by Git. Artifact roots are never serialized into the remote workspace profile.

The helper validates every workspace profile and answer payload before it is sent. An answer batch goes to Doable either directly from the helper, using the one-time submit token of that Round, or through Doable MCP; both send the same validated payload. Doable may receive only:

- opaque workspace, repository, evidence, round, and question identifiers;
- a sanitized workspace display name, product roles, surfaces, descriptions, feature scope, and externally observable findings;
- truth planes, source types, observable anchors, exact user-authorized clarifications, explicit finding-to-finding conflicts, explicit unknowns, and nonblocking same-scope observations;
- as observable anchors, user-visible routes and URL paths, and the names of browser storage keys (`localStorage`, `sessionStorage`, cookies, IndexedDB databases) that the feature reads or writes. A tester can see these in their own browser. Storage values, server-side field names, and code identifiers are never sent;
- keyed fingerprints that cannot be reversed into a branch, commit, local path, or source span.

Code evidence is always bound to an opaque repository reference and kept inside its mapped repository. A user-supplied PRD, screenshot, Figma export, or runtime capture outside Git is accepted only from an explicitly declared private artifact root; its remote evidence reference uses `repo_ref: null`, while its root, file name, path, and content remain local.

The first profile upload and material role/surface/description changes require user approval. A specific round copy prompt authorizes pulling that frozen round and submitting its validated answers; idempotent retries do not create additional submissions.

## Excluded data for Code Context rounds

No Code Context payload (workspace profile or Round answer) may contain source code or snippets, real repository or file identities, branches or commits, secrets or environment values, raw logs or attachments, private URLs, internal infrastructure topology, or real customer/business data. Code agent results follow their own boundary below.

## Doable code agent

`doable-code-agent` serves the requests that a Doable chat, or a person's own Claude Code, sends to a Claude Code session on a machine that holds the product's repositories. It works in those repositories and in test environments, it can read production when a request's goal needs a fact that the repositories and the test environments do not give, and it can read the team's work tools that the session already reaches (the issue tracker, docs, the wiki, shared chat channels), under the rules that the person gives in the message that starts the session. It reads production with the access that the machine already has, and never writes to it. The repository content and anything the session reads stay on the machine, except what a result, a progress text, or a question to the request's asker carries, and none of them carries code. A request from a person's Claude Code gives the machine that person's email (`asked_by_user`) when the person asked with their own sign-in or personal API key, so that the session's rules and its log can name who asked. A request asked with an organization API key names no person.

The Always on setup keeps the organization API key in a file on the machine that only its owner can read; a key that a person types in a command stays in the shell history. The Always on session runs with no permission check (the bypass permission mode): it can read each file and use each tool that the machine's user can, and Chrome with its sign-ins. Only the rules of its prompt and of the Skill limit what it reads and does there; what reaches Doable is only what this section names. Doable refuses a result, a record, a progress text, a question, or a capability summary that holds a Doable API key.

A result may hold:

- an answer in plain words, the steps to reproduce a bug, and a suggested fix in words;
- file paths, line numbers and single names (for example of a function, a field or a table) in the machine's repositories, and what the code does, in words;
- each new test login that the tests or the asker will sign in with, with its username, its password and a note, in the result's logins; and the ids or values of test records the machine made;
- the names of the data sources it read for a read of backend state, and when it read them;
- for a read of production, counts, states, ids and the product's own values, and never a real person's data;
- what a ticket, a doc or a chat thread of the team says about the product, in the session's own words or a quote of a few lines (never of code), with its key or title. It leaves out what the source says about people, and all that comes from a private message, mail or a page with restricted access.

A result's summary, a record, a login's note, a progress text, a question, and the capability summary never hold code, also when a request or an answer asks for it, whoever asks. Code is the text of a file of the repositories (source, tests, scripts, queries, schemas, configuration, migrations), and a diff or a patch of it. One line of it is code too, and so is a copy with changed names or as pseudo-code. A path, line numbers, a single name, an endpoint's method, path and fields, what the product shows or takes, the ids and values that tests need, and a command that a person can run are not code. Doable refuses a text that holds a code block or a diff. It does not recognize code in every other form: there, only the Skill's rules keep code on the machine. The asker's own texts, a request and an answer, can hold code.

At each start and resume, a session also sends Doable a capability summary: a few plain lines, 600 characters or fewer, that say what the session does under its rules. Doable shows it to the chat's agent, which sees it with the chat's password mask, to the organization's people on the chat's page, and to a person's Claude Code that reads the connected sessions with `ask_code_agent`, with no mask. The summary holds no secret, no code, no name or value of an environment variable, no command line, no host name and no connection string. Doable keeps it in memory only, and loses it at a restart until the machine sends it again.

A summary, a record, a progress text, or a question never holds passwords, API keys, session tokens or cookies, reset keys, private keys, connection strings, environment values, customer personal data, code, or a whole file of another kind (for example a log). The only password that a result holds is that of each new test login that the machine made for the tests or the asker, asked for or not, in that login. For a chat's request, Doable saves the login in the suite's test accounts, with the password encrypted, and keeps the password in no stored text: not in the request's record, the chat message, the card or a trace. For a request from a person's Claude Code, Doable saves no login: it keeps the result in memory only and gives it, with the passwords, to that person's Claude Code. The machine writes the password in no file of its own. The serving session's transcripts hold it, because the result that carries it is a tool call: the Always on service's session log (`~/.doable/code-agent/<machine>/session.jsonl`, and `session.1.jsonl` after the log grows) and Claude Code's own transcript of the session. Only the machine's user can read them. A login that reproduced a bug is not in the result's logins, and its password is not kept. Other secrets that an app hands out are not kept.

When a test environment gives a new user its password only through a link or a code in an email, the machine reads that mail from the organization's test inbox in Doable with the Doable MCP tool `read_code_agent_mail`. Doable gives it only the mail of its organization's own test inbox, only the mail to the address that the machine names (the test inbox or a `+` address of it), and only the mail that came after the request was asked, to the machine that holds the request. Doable MCP takes only an organization API key for this tool, as for the other tools of a machine. The machine uses the link or the code only on the machine, for that sign-up. It opens the link in a new tab of the machine's own Chrome, with Claude in Chrome, which the Always on session always has. A Chrome of another computer can be connected to the same Claude account. The session's rules let it use only the Chrome that the person chose in Claude Code on the machine, so the person must choose the machine's own Chrome: the session cannot tell it from a Chrome of another computer with the same operating system. For the comparison of the Chrome in use with the choice, the plugin's service script reads Claude Code's config file on the machine and prints only the choice (a device id and a name). Chrome acts with the sign-ins that it holds. The session's rules let it act in Chrome on the test environments, and read production and the team's work tools (the issue tracker, docs, the wiki, shared chat channels) in which Chrome is signed in as a person, as that person. They let it change nothing in production, and nothing in the work tools unless the person's rules name that action. What it reads there reaches a result only as the list above says: from production, never a real person's data; from the work tools, nothing about people, and nothing from a private message, mail or a page with restricted access. It puts the link, the code and the mail's text in no result, progress text, question or file of its own. The serving session's transcripts hold the mail that it read, as they hold a new login's password.

For a chat's request, the chat's agent and the organization's people see the machine's results, progress texts, and questions on the Chat v2 page. A request from a person's Claude Code has no chat: only its asker (the person who asked, or for an organization API key, that key) can read it, its question and its result, and Doable drops it at a restart and one hour after it ends. The machine never asks a person: it asks the request's asker. The chat's agent answers from what the chat holds or asks a person in the chat; a person's Claude Code can ask its person. When the chat's agent asks a person in a turn that the machine's question started, Doable can also send the agent's question on Slack, with a link to the chat, to the chat's person or else to the organization's default channel. Because a question and its answer reach other people, the machine never asks for a password, a key, a token, or any other credential: it declines asked work that needs the access, or else names the source or the work under Not known, and says which access a person must add on the machine. The machine never pushes code, opens pull requests, deploys, or writes to production, and it changes nothing in the team's work tools unless the person's rules name that action.

## Optional GitHub runner

The separately installed GitHub workflow is not the local MCP plugin. The customer
authorizes the getdoable GitHub App for selected repositories and explicitly saves
a repository connection in Doable. Doable stores repository/installation identities
and run metadata needed to authorize and dispatch that connection. These metadata
are exceptions to the local plugin's opaque-repository policy above, not permission
to submit source code, secret values, raw model output, or private source locators.

The selected provider processes relevant repository source: OpenAI for Codex or
Anthropic for Claude. The workflow sends sanitized findings or bounded diagnostics
to Doable. Provider credentials stay in GitHub Actions secrets and are subject to
GitHub access controls. The GitHub App private key stays on Doable's backend.
Claude's restricted tools are not an operating-system sandbox. Customers must use
trusted, reviewed workflows and repositories. See the
[installation and security guide](docs/github-code-context-install.md).

See the [Doable Privacy Policy](https://qa.getdoable.ai/privacy-policy) for platform data handling. Questions may be sent to support@getdoable.ai.
