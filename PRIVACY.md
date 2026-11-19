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

`doable-code-agent` serves the requests a Doable chat sends to a Claude Code session on a machine that holds the product's repositories. It works in those repositories and in test environments, under the rules that the person gives in the message that starts the session. The repository content and anything the session reads stay on the machine, except what a result, a progress text, or a question to the chat's agent carries.

The prompt that a person copies from a request card for a one-off session holds an organization API key, so the key stays in that session's transcript on the machine. The command for a long-running session holds the key too, so it stays in the shell history. Doable refuses a result, a record, a progress text, a question, or a capability summary that holds a Doable API key.

A result may hold:

- an answer in plain words, and the steps to reproduce a bug;
- file paths and line numbers in the machine's repositories;
- code excerpts and suggested diffs of 10 lines or fewer each, unless the session's rules say that code excerpts may not leave the machine;
- the usernames and Doable account ids of test logins the machine made, and the ids or values of test records it made;
- the names of the data sources it read for a read of backend state, and when it read them.

At each start and resume, a long-running session also sends Doable a capability summary: a few plain lines, 600 characters or fewer, that say what the session does under its rules. A one-off session sends none. Doable shows it to the chat's agent, which sees it with the chat's password mask, to the organization's people on the chat's page, and to the organization's machines in `list_code_agent_machines`, with no mask. The summary holds no secret, no name or value of an environment variable, no command line, no host name and no connection string. Doable keeps it in memory only, and loses it at a restart until the machine sends it again.

A result, a progress text, or a question never holds passwords, API keys, session tokens or cookies, reset keys, private keys, connection strings, environment values, customer personal data, or whole files. A test login that a request asks the machine to make for the tests reaches Doable only through the Doable MCP tool `add_test_account`, which sends the password to Doable's existing account route, where it is stored encrypted; the password is never in a request, a result, a chat message, or a file. A login made only to reproduce a bug is not registered in Doable, and its password is not kept. Other secrets that an app hands out are not kept.

The chat's agent and the organization's people see the machine's results, progress texts, and questions on the Chat v2 page. The machine never asks a person: it asks the chat's agent, which answers from what the chat holds or asks a person in the chat. When the agent asks a person in a turn that the machine's question started, Doable can also send the agent's question on Slack, with a link to the chat, to the chat's person or else to the organization's default channel. Because a question and its answer stay in the chat, the machine never asks for a password, a key, a token, or any other credential: it declines and says which access a person must add on the machine. The machine never pushes code, opens pull requests, deploys, or touches production.

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
