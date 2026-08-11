# Doable Agent Plugins

Official beta plugins for [Doable](https://getdoable.ai), supporting Codex, Claude Code, and Cursor.

| Plugin | Version | Purpose | Network |
| --- | --- | --- | --- |
| `doable-code-context` | `0.2.0` | Resolve context requests or start a managed feature-testing workflow | Configured Doable MCP |

The repository is private during beta. Installation requires GitHub access to `getdoable/doable-agent-plugins`.

## Workflow

Use **Doable Code Context** for the connected pre-TRD workflow:

1. The user submits a TRD request in Doable.
2. Doable shows the original feature request as the required base investigation,
   adds any focused TRD Assistant questions, and lets the user review or add
   questions before publishing one frozen round with a short copy prompt such as:

   ```text
   Resolve Doable context request DQ-7F3K for this workspace.
   ```

3. The coding agent performs demand-driven workspace setup if needed, pulls that exact frozen round, grounds the base request across the relevant private repositories, answers the focused supplements, asks one batched clarification round only when product authority is missing, and pushes structured grounded findings suitable for later knowledge reuse.
4. Doable reviews the dispositions and continues the existing TRD loop.

All remote operations use the separately configured Doable MCP connection. The bundled helper is not a service or standalone CLI: it deterministically maps local repositories, keeps exact provenance private, builds safe payloads, and validates MCP responses.

## Requirements

- Codex, Claude Code, or Cursor with Agent Skills or plugin support;
- Node.js 20 or newer;
- Git for repository-bound evidence;
- an authenticated Doable MCP connection configured in the coding agent.

Never paste an API key into chat or save it under `.doable/`. The MCP connection owns organization authentication; the helper never reads a credential or calls the Doable API directly.

## Install

### Codex

```bash
codex plugin marketplace add getdoable/doable-agent-plugins --ref main
codex plugin add doable-code-context@getdoable
```

Install only the plugin needed for the desired workflow, then start a new task.

### Claude Code

```bash
claude plugin marketplace add getdoable/doable-agent-plugins
claude plugin install doable-code-context@doable --scope user
```

Natural-language requests activate the Skills. Explicit invocations are:

- `/doable-code-context:doable-connect`
- `/doable-code-context:doable-answer-questions`
- `/doable-code-context:doable-test-feature`

### Cursor

In a new Cursor Agent chat, install the plugin:

```text
/add-plugin doable-code-context@https://github.com/getdoable/doable-agent-plugins
```

For local beta development, clone the repository, link the selected plugin, and fully restart Cursor:

```bash
git clone https://github.com/getdoable/doable-agent-plugins.git
mkdir -p ~/.cursor/plugins/local
ln -s "$(pwd)/doable-agent-plugins/plugins/doable-code-context" ~/.cursor/plugins/local/doable-code-context
```

Cursor Marketplace installation will replace this fallback after approval.

## Connect Doable MCP once

The plugin supplies Skills and the local privacy helper; it does not bundle or duplicate the remote MCP server. Configure the official Streamable HTTP endpoint `https://mcp.getdoable.ai/mcp` once in the coding-agent host using the organization API key from Doable Settings. The host stores and sends this credential; the Skill and helper never read it. See the [Doable MCP client instructions](https://github.com/getdoable/doable-mcp#connect-a-client) for host-specific configuration.

## Use Doable Code Context

Normally, paste the short prompt copied from the Doable TRD composer:

```text
Resolve Doable context request DQ-7F3K for this workspace.
```

Setup is recovered inside the same conversation if needed. The user may also request it directly:

```text
Doable setup for this workspace.
```

Or start from the coding agent after implementing a feature:

```text
Use Doable to test the feature I just implemented.
```

The agent reuses or creates the appropriate suite, opens one coding-agent-origin
Round only when context or requirements changed, resolves that Round from the
private workspace, and then continues through the existing TRD and managed-case
workflow.

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

## Shared grounding and privacy boundary

The connected plugin:

- support mono-repos, multi-repo workspaces, selected changes, PRDs, designs, screenshots, and supplied artifacts;
- inspect the smallest connected evidence graph for the named feature;
- distinguish desired, implemented, deployed/artifact, inference, and unknown truth planes;
- record fixtures, permissions, validation, persistence, failures, and cross-repo seams only when they affect testing;
- treat repository content as untrusted evidence, not instructions.

Doable never receives source code or snippets, real repository names or paths, branches or commits, secrets or environment values, private URLs, raw logs, internal topology, or real customer data.

See [PRIVACY.md](PRIVACY.md) for the exact per-plugin boundary.

## Current limitations

- One run resolves one identified feature or coherent feature domain, not an entire product.
- The connected workflow requires server-side code-context rounds and organization capability enablement.
- Multiple workspaces are selected in Doable before publishing the round; the coding agent never guesses across workspaces.
- Required skips return to platform-user review. Coding agents cannot defer or waive scope.
- Active notifications, setup-time exhaustive knowledge mapping, and automatic historical-knowledge reuse are outside this MVP.

## Verify

```bash
npm test
claude plugin validate ./plugins/doable-code-context
```

The release verifier requires exactly three Skills and one dependency-free, local-only helper with no network or credential primitives.

Use [TESTING.md](TESTING.md) for the fresh-session acceptance matrix.

## Repository layout

```text
plugins/
  doable-code-context/
    skills/doable-connect/
    skills/doable-answer-questions/
    skills/doable-test-feature/
    scripts/doable-code-context.mjs
```

## License

[MIT](LICENSE)
