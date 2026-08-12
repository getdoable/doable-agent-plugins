# Workspace setup contract

Create `.doable/workspace-candidate.json` and pass it to `prepare-workspace`. It contains private paths, is mode `0600`, is ignored by the nested `.doable/.gitignore`, and must never be uploaded:

```json
{
  "workspaceLabel": "local-only label",
  "safeDisplayName": "Commerce administration",
  "artifactRoots": [
    "/absolute/local/directory/containing-user-supplied-artifacts"
  ],
  "repositories": [
    {
      "path": "/absolute/local/repository/root",
      "name": "local-only repository name",
      "productRole": "commerce-admin",
      "surfaces": ["catalog-management", "order-management", "customer-operations"],
      "userFacing": true,
      "safeDescription": "Staff-facing administration for commerce operations and configuration."
    }
  ]
}
```

Rules:

- `path` must resolve to an independent Git repository root.
- `artifactRoots` is optional and local-only. Include only a narrow absolute directory that the user explicitly supplied for this request, such as a folder containing a PRD, screenshot, Figma export, or runtime capture. Never infer a broad home, Downloads, Documents, filesystem-root, or workspace-parent directory. Its path and contents are never serialized remotely.
- A workspace may contain repositories, supplied artifact roots, or both. Code evidence still requires a mapped repository even when an artifact-only workspace is valid for a published question round.
- `name` and `workspaceLabel` are local-only. They are never serialized remotely.
- `safeDisplayName` is shown in Doable when an organization has multiple workspaces. Use a product-facing label that does not reveal a repository, customer, environment, or internal project name.
- Omit `repoRef` for new setup. On an unambiguous path move, copy the existing opaque `repoRef` from private state so identity survives; never invent a replacement for an existing repository.
- `productRole` and every `surface` are short sanitized product identifiers, not package names, service hosts, or repository names.
- `safeDescription` explains a product responsibility without code, file, class, endpoint, infrastructure, customer, or deployment details.
- Prefer stable product domains and repository responsibilities over feature names from the request
  that happened to trigger setup. A prior feature intake may help orient the scan but must not become
  an exhaustive feature inventory. Missing map entries never establish product absence.
- Include orchestration or infrastructure repositories only when they own a product surface needed to route later questions.
- Preserve an existing repository's opaque `repoRef` when its path moves. The helper matches the repository's local identity and lets the agent repair ambiguous moves explicitly.

Commands:

```bash
# Save the result of MCP get_code_context_connection to this private file first.
node <plugin-directory>/scripts/doable-code-context.mjs prepare-workspace \
  --candidate .doable/workspace-candidate.json \
  --handshake .doable/mcp-connection-response.json \
  --state .doable/workspace-private.json \
  --round-code DQ-7F3K

node <plugin-directory>/scripts/doable-code-context.mjs build-workspace-profile \
  --state .doable/workspace-private.json \
  --output .doable/workspace-profile.json \
  --approved

# Call MCP sync_code_context_workspace with the exact generated workspace_ref
# and profile, save its result, then record it locally.
node <plugin-directory>/scripts/doable-code-context.mjs record-workspace-sync \
  --state .doable/workspace-private.json \
  --payload .doable/workspace-profile.json \
  --response .doable/mcp-workspace-sync-response.json
```

Omit `--round-code` for an explicit standalone “Doable setup” request. Include it when recovering setup from a Doable copy prompt so the organization-authenticated handshake binds this local map to the workspace already selected for that round.
For a first-time workspace whose published round is not yet bound, the helper carries this code only into the first profile sync; Doable atomically binds that same-organization round to the newly created workspace.

`prepare-workspace` reports whether material approval is required. Remove `--approved` for a revision-only refresh. The helper never reads a Doable credential or calls a remote endpoint; organization authentication comes from the configured Doable MCP connection.

The helper sends `material_change_approved: true` only after its local `--approved` gate succeeds. A revision-only refresh sends `false` and relies on the previously approved material profile.

The private state file is mode `0600` and contains the organization binding, real repository map, explicitly supplied artifact roots, local Git provenance, opaque identities, and the sanitized profile. It must remain ignored by Git.
