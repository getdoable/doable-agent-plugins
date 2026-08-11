---
name: doable-connect
description: Connect the current private mono-repo or multi-repo workspace to the Doable organization bound to a Doable API key. Use when the user says “Doable setup,” asks to connect a workspace, or a Doable context request cannot be pulled because `.doable/workspace-private.json` is missing or stale. Build only a routing-level workspace map, keep real repository identities and source provenance local, and upload a sanitized profile after approval.
---

# Connect Doable Workspace

Set up the local-to-remote privacy boundary needed by Doable code-context requests. Setup is demand-driven; do not scan a workspace merely because this Skill is installed.

The bundled helper is an implementation detail, not a user-facing CLI:

```bash
node <plugin-directory>/scripts/doable-code-context.mjs <command> ...
```

## Workflow

1. Verify that `DOABLE_API_KEY` is available in the coding agent's local environment. If missing, direct the user to create a key in Doable Settings and configure it in the agent environment. Never ask the user to paste the key into chat and never write it to a workspace file. Use `DOABLE_API_BASE_URL` only to override the default API origin for local or staging development.
2. Look for `.doable/workspace-private.json` at the workspace root.
   - If it is valid and bound to the current organization, reuse it.
   - If paths moved but repositories are the same, refresh the local paths while preserving `workspaceId` and `repoRef` values.
   - If it is absent or cannot be recovered, rebuild the routing map and reuse an unambiguous remote `repoRef` whose sanitized role, surfaces, user-facing flag, and description still match. Never pretend lost exact provenance was recovered.
3. Reuse existing `.doable/features/*/doable-intake.json` records or a customer-supplied ownership map as local orientation hints when present; verify current repository roots and routing roles rather than regenerating their feature context. Then identify every independent Git repository under the user-selected workspace boundary. Do not treat a common parent directory as a synthetic repository. For each repository, establish only:
   - its local identity and path;
   - its product role and user-facing surfaces;
   - whether it contributes user-visible behavior;
   - a short, safely shareable product-level description.
   Describe stable, broad product responsibilities that remain useful across later feature requests.
   Do not turn the feature that triggered setup into the repository's entire role or surface list
   unless the repository is genuinely dedicated to that feature. Existing feature intakes are
   orientation hints, not an exhaustive workspace map.
   When the user has explicitly supplied PRDs, screenshots, Figma exports, or runtime captures outside Git, record only the narrow directory containing those supplied files as a private `artifactRoot`. Do not infer broad roots such as a home, Downloads, Documents, or workspace-parent directory, and do not scan adjacent files.
4. Do not inventory every feature, symbol, endpoint, package, database, or deployment component. Setup exists to route later questions to likely owners. A feature missing from the map is not evidence that it is missing from the product; later requests still search the current workspace from the base feature query.
5. Write `.doable/workspace-candidate.json` using the contract in [references/workspace-contract.md](references/workspace-contract.md), then run `prepare-workspace`. It is private, ignored, and must never be uploaded. When setup was entered from a round copy prompt, pass its code with `--round-code`; this lets Doable recover the already-selected workspace even if local state was deleted. The helper authenticates, assigns stable opaque repository references, records local Git provenance, writes `.doable/workspace-private.json` with private permissions, and validates the remote profile.
6. Show the user only the organization, product roles, surfaces, and safe descriptions that would be shared. Ask once before the first profile upload or any material role/surface/description change. A revision-only refresh needs no new approval.
7. After approval, run `sync-workspace --approved`. If the helper says approval is not required, omit `--approved`. Repeated calls are idempotent.
8. If setup was entered from a Doable request, return immediately to `doable-answer-questions` and pull that exact request. Do not make the user repeat the copy prompt.

## Privacy boundary

Keep these only in `.doable/workspace-private.json` and local request ledgers:

- real repository names and paths;
- explicitly supplied artifact roots and artifact file identities;
- branches, commits, dirty state, diffs, symbols, and line locators;
- secrets, environment values, private URLs, raw logs, source snippets, and customer data.

The remote profile may contain only opaque `repoRef` values, product roles, surfaces, user-facing flags, sanitized descriptions, and opaque fingerprints. Do not upload a repo map produced by another tool without passing it through the bundled helper.

## Completion

Report that the workspace is connected, name the shared product surfaces, and continue the pending Doable request when one exists. Do not claim that a TRD or test case was created.
