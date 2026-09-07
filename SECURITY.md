# Security

Report suspected security or privacy issues privately to support@getdoable.ai. Do not include credentials, source code, customer data, or private environment details.

## Supported versions

Security fixes are provided for the current release line. Upgrade to the latest published release before reporting a reproducible issue.

## Reporting

Include the plugin version, coding-agent host, and sanitized reproduction steps. Do not open a public issue for a suspected vulnerability. We will acknowledge a report and coordinate disclosure after validating its impact.

## Security boundary

`doable-code-context` contains no bundled MCP server, credential store, standalone CLI package, runtime dependency, or telemetry. Its helper has no network or credential primitives: it validates local/private versus remote/sanitized schemas, writes private state atomically with mode `0600`, and checks content-derived payload digests around calls made through the separately configured Doable MCP connection. Connection recovery may place a user-supplied key only in the coding-agent host's user-scoped MCP credential/configuration store; it must never echo the key or put it in a workspace file, project-scoped MCP file, shell history, or command-line argument.

Never commit `.doable/workspace-candidate.json`, `.doable/workspace-private.json`, or `.doable/requests/`. Rotate a Doable API key if it is pasted into a conversation, terminal transcript, issue, or log.
