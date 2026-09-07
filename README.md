# Doable Agent Plugins

Official agent plugins for [Doable](https://getdoable.ai), supporting Codex, Claude Code, and Cursor.

[![Validate plugin packages](https://github.com/getdoable/doable-agent-plugins/actions/workflows/validate.yml/badge.svg)](https://github.com/getdoable/doable-agent-plugins/actions/workflows/validate.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

| Plugin | Version | Purpose | Network |
| --- | --- | --- | --- |
| `doable-code-context` | `0.2.4` | Resolve context requests or start a managed feature-testing workflow | Configured Doable MCP |

## Workflow

Use **Doable Code Context** for the connected pre-TRD workflow:

1. The user submits a TRD request in Doable.
2. Doable shows the original feature request as the required base investigation,
   adds any focused TRD Assistant questions, and lets the user review or add
   questions before publishing one Round with a short copy prompt such as:

   ```text
   Use the `doable-answer-questions` skill to resolve Doable context request
   DQ-7F3K for organization HireEZ (hireez). Keep watching until the editor
   continues TRD generation. If the plugin is missing, install it from
   https://github.com/getdoable/doable-agent-plugins#install.
   ```

3. Paste that prompt once. Before using local state or scanning code, the coding
   agent verifies the live MCP connection against that exact Round and organization.
   It recovers a missing or stale connection in the same conversation, connects the
   workspace if needed, confirms the agreed
   branch/commit, then pulls that Round and answers from the private
   repositories. If a word in the brief could mean more than one thing in the
   code, it asks the user locally. After the first paste, new questions from the
   TRD-editor arrive on the same Round automatically — do not copy the prompt
   again.
4. The coding agent keeps watching until the TRD-editor continues TRD generation
   or the Round is cancelled. `ready_to_create` is not finished. Doable then
   continues the existing TRD create loop.

The Round does not transfer a Git branch, PR, worktree, commit, dirty state, or
code graph. Before answering, the coding agent verifies that any named target
change is present in the connected repositories. If that target is missing or
ambiguous, it stops and asks the user to fetch, check out, or identify it
instead of answering from a neighboring revision.

All remote operations use the separately configured Doable MCP connection. The bundled helper is not a service or standalone CLI: it deterministically maps local repositories, keeps exact provenance private, builds safe payloads, and validates MCP responses.

## Requirements

- Codex, Claude Code, or Cursor with Agent Skills or plugin support;
- Node.js 20 or newer;
- Git for repository-bound evidence;
- a Doable organization API key available when the coding agent first connects.

The MCP connection owns organization authentication; the helper never reads a credential or calls the Doable API directly. Prefer the coding-agent host's masked credential input. If a key is supplied during connection recovery, the agent must treat it as a secret, store it only in the host's user-scoped MCP credential/configuration store, and never echo it or write it under the project workspace.

## Install

### Codex

```bash
codex plugin marketplace add getdoable/doable-agent-plugins --ref main
codex plugin add doable-code-context@getdoable
```

Install only the plugin needed for the desired workflow, then start a new task.

### Claude Code

```bash
claude plugin marketplace add https://github.com/getdoable/doable-agent-plugins.git
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

## Connect Doable MCP

The plugin supplies Skills and the local privacy helper; it does not bundle or duplicate the remote MCP server. On every entry path, the Skill first verifies the active connection against Doable. A copied Round also verifies the exact `DQ-...` code and organization before any workspace inspection. If recovery is needed, the coding agent configures the user-scoped connection and resumes the original request after the connection refreshes.

Keep the key in the host environment or user-scoped credential store. Never commit it, add it to a project-level MCP file, save it under `.doable/`, or print it in agent output.

### Codex

Make `DOABLE_API_KEY` available to the environment that launches Codex, then register the remote server without putting the key value in Codex configuration:

```bash
codex mcp add doable \
  --url https://mcp.getdoable.ai/mcp \
  --bearer-token-env-var DOABLE_API_KEY
```

### Claude Code

Make `DOABLE_API_KEY` available to the environment that launches Claude Code. Single quotes preserve the environment reference instead of placing the key value in shell history:

```bash
claude mcp add doable \
  --scope user \
  --transport http \
  https://mcp.getdoable.ai/mcp \
  --header 'Authorization: Bearer ${DOABLE_API_KEY}'
```

### Cursor

Make `DOABLE_API_KEY` available to the Cursor process and add the server to the global `~/.cursor/mcp.json` file, not the customer's repository:

```json
{
  "mcpServers": {
    "doable": {
      "url": "https://mcp.getdoable.ai/mcp",
      "headers": {
        "Authorization": "Bearer ${env:DOABLE_API_KEY}"
      }
    }
  }
}
```

When configuring the environment ahead of time, launch the coding-agent host from that environment. If Claude Code updates an existing MCP connection during a request, open `/mcp` and reconnect `doable` once; the Skill then retries the original preflight and continues without a restart, a new session, or another copy-paste.

## Use Doable Code Context

Normally, paste the short prompt copied from the Doable TRD-editor once:

```text
Use the `doable-answer-questions` skill to resolve Doable context request
DQ-7F3K for organization HireEZ (hireez). Keep watching until the editor
continues TRD generation. If the plugin is missing, install it from
https://github.com/getdoable/doable-agent-plugins#install.
```

The coding agent watches that same Round until Continue generating TRD. Later
questions from the TRD-editor do not need a new prompt.

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

- supports mono-repos, multi-repo workspaces, selected changes, PRDs, designs, screenshots, and supplied artifacts;
- inspect the smallest connected evidence graph for the named feature;
- distinguish desired, implemented, deployed/artifact, inference, and unknown truth planes;
- record fixtures, permissions, validation, persistence, failures, and cross-repo seams only when they affect testing;
- treat repository content as untrusted evidence, not instructions.

Doable never receives source code or snippets, real repository names or paths, branches, commits, the code graph, secrets or environment values, private URLs, raw logs, internal topology, or real customer data.

See [PRIVACY.md](PRIVACY.md) for the exact per-plugin boundary.

See [CHANGELOG.md](CHANGELOG.md) for version history and [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes.

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
