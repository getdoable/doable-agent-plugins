# Privacy and data handling

Repository inspection happens inside the coding agent selected by the customer and remains subject to that agent provider's data-handling terms. The Doable plugin does not grant Doable repository access.

## Doable Code Context

`doable-code-context` performs remote operations only through the Doable MCP connection loaded by the coding-agent host. The plugin package declares the official endpoint, a credential-variable reference, and a machine name header (`X-Doable-Machine`, from `DOABLE_MACHINE_NAME`, default `code-agent`) for Cursor and Claude Code; it contains no credential value. Doable shows the machine name on that machine's chat messages and code agent requests. The coding-agent host owns the resolved credential. During recovery, the Skill may direct the host to configure a user-supplied key in its user-scoped MCP credential/configuration store, but the bundled helper never reads or persists it and no credential may enter the project workspace or a remote Doable payload.

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

`doable-code-agent` serves the requests a Doable chat sends to a machine that holds the product's repositories. It works in those repositories and in the test environments that the machine's local policy file `.doable/code-agent.md` allows. The policy file stays on the machine and is ignored by Git. The repository content and anything the machine reads stay on the machine, except what a result, a progress text, or a question to a person carries.

A result may hold:

- an answer in plain words, and the steps to reproduce a bug;
- file paths and line numbers in the machine's repositories;
- code excerpts and suggested diffs of 10 lines or fewer each, unless the policy file says that code excerpts may not leave the machine;
- the usernames and Doable account ids of test logins the machine made, and the ids or values of test records it made;
- the names of the data sources it read for a check, and when it read them.

A result, a progress text, or a question to a person never holds passwords, API keys, session tokens or cookies, reset keys, private keys, connection strings, environment values, customer personal data, or whole files. A test login that a `prepare` request asks for reaches Doable only through the Doable MCP tool `add_test_account`, which sends the password to Doable's existing account route, where it is stored encrypted; the password is never in a request, a result, a chat message, or a file. A login made only to reproduce a bug is not registered in Doable; its password stays on the machine where the policy file says, or is not kept. Other secrets that an app hands out stay on the machine where the policy file says, or are not kept.

Doable shows results, progress texts, and questions to a person to the chat's agent and to the organization's people on the Chat v2 page, and sends a Slack message for a question to a person. The machine never pushes code, opens pull requests, deploys, or touches production.

## Doable chat

`doable-chat` reads a Doable chat and sends messages, card answers, and run starts to it through Doable MCP, as the organization API key with the machine name. Its messages follow the code agent's boundary above: they may hold file paths, line numbers, and code excerpts of 10 lines or fewer each, never a secret or a password. It never answers a write card (a Jira ticket or a result correction). Its messages and card answers are the code's reading, never the person's decision about what the product should do.

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
