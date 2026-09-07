# Doable MCP connection recovery

Use this workflow only after a live `get_code_context_connection` preflight fails. An MCP config entry, an environment-variable name, or an API-key-shaped value is diagnostic information; none proves that the active MCP connection has a valid credential.

## Identify the expected organization

- For a copied Doable Round prompt, use its exact `DQ-...` code and organization display name or slug. Every preflight and retry must include that original code as `round_code`.
- For a coding-agent-originated request or explicit standalone setup, there is no externally selected Round. Validate the organization returned by the authenticated connection before creating or selecting remote resources.
- Never use a credential from one organization to infer access to another organization.

## Recover in the same conversation

1. Stop before scanning repositories, pulling a Round, searching suites, or using `.doable` state for anything beyond the optional `workspace.clientRef` needed by the preflight.
2. Inspect the coding-agent host's MCP connection status without printing configured headers or environment values. Treat a missing/disabled `doable` server, an empty environment expansion, and `401` as different diagnostics with the same next goal: establish one valid user-scoped `doable` connection for the expected organization.
3. If the user already supplied the expected organization's API key in the current request, continue without asking for it again. Otherwise ask once for it and point them to that organization's Doable Settings. Prefer the host's masked credential input when it is available. Do not ask the user to run configuration commands themselves. Keep the request action-focused: “Doable is not connected to {organization}. Send its API key from Doable Settings; I will configure it and continue {round code or feature request}.” Do not narrate the diagnosis unless the user asks.
4. Configure or replace only the host's **user-scoped** `doable` MCP connection. Never write a credential into the repository, `.doable`, a project-scoped MCP file, shell history, a command-line argument, or assistant output. Do not print or repeat the key. The coding-agent host owns its credential storage.
5. Refresh the connection in the current conversation when the host exposes that operation. In Cursor, the user-scoped MCP configuration reloads asynchronously: wait for the host to refresh, then retry the exact preflight. Treat an immediate `401` as a potentially stale live transport, not proof that the newly stored key is invalid; allow one more refresh-and-retry cycle before asking for another key. In Claude Code, the agent cannot invoke the interactive slash-command UI, so ask for exactly one action: “Open `/mcp` and reconnect `doable`; I will continue this request here.” Do not ask the user to restart Claude Code, open another session, rerun the skill, or paste the original request again.
6. Retry `get_code_context_connection` with the same preflight arguments. Continue the original request automatically only after it succeeds and, for a copied prompt, the returned organization matches the prompt. Do not compare, print, or re-request a credential merely because the pre-refresh transport still returns `401`.

If the refreshed connection still returns `401`, say that the supplied credential was rejected and ask for a current key from the expected organization's Settings. If authentication succeeds but the organization differs, state the expected and connected organization names and recover the expected organization's connection. If the exact Round then returns `404`, state that the Round is not available in the authenticated organization; do not call it an expired key.
