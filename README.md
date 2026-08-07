# Doable Agent Plugins

Official beta plugins for [Doable](https://getdoable.ai). The current release is **Doable TRD Context 0.1.5**.

Doable TRD Context lets a customer's coding agent inspect one clearly identified feature in a private codebase and prepare the product and testing context needed to create a Doable TRD. Doable never receives repository access. The user uploads one generated file: `doable-context.md`.

The repository is private during the beta. Installation requires GitHub access to `getdoable/doable-agent-plugins`.

## Current product boundary

The plugin:

- works with Codex, Claude Code, and Cursor;
- understands mono-repos, multi-repo workspaces, selected PRs or diffs, tickets, PRDs, screenshots, and other supplied design artifacts;
- grounds feature scope, actors, flows, states, rules, observable outcomes, fixture requirements, environment constraints, exclusions, and bounded unknowns;
- keeps repository identities, source locations, revisions, dirty state, and evidence provenance local;
- creates one privacy-safe context file for manual upload to Doable.

This context-only beta does **not** configure MCP, authenticate to Doable, create or update a TRD, generate test cases, or run tests.

## Requirements

- Codex, Claude Code, or Cursor with Agent Skills or plugin support;
- Node.js 20 or newer for deterministic validation and rendering;
- Git for repository-bound evidence and refresh checks.

## Install

### Codex

```bash
codex plugin marketplace add getdoable/doable-agent-plugins --ref main
codex plugin add doable-trd-context@getdoable
```

Start a new task after installation.

### Claude Code

```bash
claude plugin marketplace add getdoable/doable-agent-plugins
claude plugin install doable-trd-context@doable --scope user
```

Start a new session after installation or update. Natural-language requests activate the Skill; the explicit invocation is `/doable-trd-context:doable-trd-intake`.

### Cursor

In a new Cursor Agent chat, try:

```text
/add-plugin doable-trd-context@https://github.com/getdoable/doable-agent-plugins
```

For local beta development, clone the repository, link the plugin directory, and fully restart Cursor:

```bash
git clone https://github.com/getdoable/doable-agent-plugins.git
mkdir -p ~/.cursor/plugins/local
ln -s "$(pwd)/doable-agent-plugins/plugins/doable-trd-context" ~/.cursor/plugins/local/doable-trd-context
```

Cursor Marketplace installation will replace this fallback after the plugin is approved there.

## Use

Ask naturally for one named feature or feature domain:

```text
Test Authentication and prepare Doable context.
Test the feature in this selected PR and prepare Doable context.
Prepare Doable context for Checkout using this PRD and these screenshots.
```

A domain such as `Authentication` is specific enough even when it includes sign-up, sign-in, and sign-out. “Test the newly developed feature” also works when the conversation, selected change, ticket, or supplied artifact already identifies the feature.

The plugin intentionally stops before broad repository scanning when the feature cannot be identified. Product-wide requests such as “test the whole website” require the user to choose the first feature.

No prescribed long prompt, Doable API key, organization selection, suite selection, or MCP configuration is required.

## How context collection works

1. Identify the feature and reuse an existing local feature record when the same capability was collected before.
2. Build a compact feature map before opening implementation details.
3. Inspect the smallest connected evidence graph that establishes user-visible behavior, state transitions, validation, permissions, persistence, relevant tests, contracts, and cross-repo seams.
4. Separate desired behavior, implemented behavior, deployed observations, reference material, and inference rather than silently merging them.
5. Record the account roles, fixture states, preparation and cleanup requirements, and environment conditions needed for later testing.
6. Validate provenance and privacy, then render one uploadable context file.

Investigation depth follows the feature's actual complexity. There are no fixed time, repository-count, file-count, flow-count, or output-size limits. Before widening, the agent names the missing readiness dimension that more evidence must close; it stops repeated retrieval when it no longer adds product behavior.

When the user supplies a deployment, the plugin performs at most one brief entrypoint readiness check. Reachability is recorded only as an environment fact and is never presented as verified feature behavior. The plugin does not mutate feature data or deeply test the deployment.

## Multi-repo behavior

Each independent Git repository is mapped separately, but the customer makes one request and receives one final context file. The agent follows only the product seams needed for the named feature and reconciles frontend, backend, contract, worker, or integration evidence into one behavioral model.

An existing ownership map may accelerate orientation, but feature-relevant ownership and seams are still verified against current evidence. Repository names, paths, commits, and local topology never enter the upload.

## Output and refresh

The plugin writes:

```text
.doable/features/<feature-slug>/
  doable-context.md
  doable-intake.json
```

- `doable-context.md` is the only file to upload. It contains typed **User Authority** and **Grounded Context** sections.
- `doable-intake.json` is local canonical state for provenance, validation, refresh, and recovery. Never upload it.

Running the plugin again for the same feature updates the existing feature record and increments its context revision while preserving unaffected grounded content. If local history is missing, the plugin rebuilds from current evidence without pretending the lost lineage was recovered.

After validation, the coding agent prints only the upload path, the next Doable step, the scope, and the collected flow names. Review is optional; no `approve` reply is required before the context is ready.

## Privacy boundary

All repository inspection stays inside the customer's coding agent. The upload excludes:

- source code and snippets;
- repository names, paths, revisions, dirty state, and evidence metadata;
- secrets, credentials, environment values, and private URLs;
- raw logs, attachments, and internal infrastructure topology;
- real customer or business data.

The upload may describe private product roles, behavior, fixture needs, and observable state in sanitized product language. See [PRIVACY.md](PRIVACY.md) for the complete policy.

## Current limitations

- One run covers one identified feature or coherent feature domain, not an entire product.
- The user still creates a suite and uploads `doable-context.md` manually in Doable.
- External accounts, seeded lifecycle states, callback receivers, and other fixtures are described but not provisioned.
- Runtime reachability does not prove that repository behavior is deployed.
- Installation remains private-beta and host marketplace availability differs.

## Verify the release package

```bash
npm test
claude plugin validate .
claude plugin validate ./plugins/doable-trd-context
```

The release verifier checks host manifests, marketplace entries, exact Skill/schema/renderer version alignment, internal references, package structure, the absence of MCP configuration and symlinks, and common secret or path leaks.

Use [TESTING.md](TESTING.md) for the fresh-session acceptance matrix.

## Repository layout

```text
plugins/doable-trd-context/
  .claude-plugin/
  .codex-plugin/
  .cursor-plugin/
  skills/doable-trd-intake/
```

`doable-trd-context` is the installable plugin. `doable-trd-intake` is the portable workflow Skill shared by all supported hosts.

## License

[MIT](LICENSE)
