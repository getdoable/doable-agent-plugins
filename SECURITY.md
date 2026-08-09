# Security

Report suspected security or privacy issues privately to support@getdoable.ai. Do not include credentials, source code, customer data, or private environment details.

`doable-code-context` contains no MCP server, credential store, standalone CLI package, runtime dependency, or telemetry. Its helper reads `DOABLE_API_KEY` only at request time, restricts transport to the centralized Doable REST endpoint table, validates local/private versus remote/sanitized schemas, writes private state atomically with mode `0600`, and uses content-derived idempotency keys for profile and answer retries.

Never commit `.doable/workspace-candidate.json`, `.doable/workspace-private.json`, or `.doable/requests/`. Rotate a Doable API key if it is pasted into a conversation, terminal transcript, issue, or log.
