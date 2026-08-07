# Doable Agent Plugins

Official, public agent plugins for [Doable](https://getdoable.ai).

The first plugin, **Doable TRD Context**, helps a coding agent inspect one clearly identified feature in a private mono-repo or multi-repo and create one privacy-safe, evidence-grounded `doable-context.md` file. The user then uploads that single file to Doable to create a TRD.

This beta is deliberately context-only: it does not include MCP, authenticate to Doable, create a TRD, generate test cases, or run tests.

## Requirements

- Codex, Claude Code, or Cursor with Agent Skills/plugin support;
- Node.js 20 or newer for deterministic validation and rendering;
- Git available locally for repository-bound provenance checks.

## Install in Codex

```bash
codex plugin marketplace add getdoable/doable-agent-plugins --ref main
codex plugin add doable-trd-context@getdoable
```

Start a new task after installation. Example:

```text
Test the authentication feature. Prepare the context I need to create a Doable TRD.
```

## Install in Claude Code

```bash
claude plugin marketplace add getdoable/doable-agent-plugins
claude plugin install doable-trd-context@doable --scope user
```

Start a new session or run `/reload-plugins`. The explicit command is `/doable-trd-context:doable-trd-intake`; natural-language requests work too.

## Install in Cursor

In a new Cursor Agent chat, try:

```text
/add-plugin doable-trd-context@https://github.com/getdoable/doable-agent-plugins
```

For local beta development, clone this repository and symlink it into Cursor, then fully restart Cursor:

```bash
git clone https://github.com/getdoable/doable-agent-plugins.git
mkdir -p ~/.cursor/plugins/local
ln -s "$(pwd)/doable-agent-plugins/plugins/doable-trd-context" ~/.cursor/plugins/local/doable-trd-context
```

After Cursor Marketplace approval, install `doable-trd-context` from the marketplace or with `/add-plugin doable-trd-context`.

## Use

Name one feature or feature domain. `Authentication` is sufficiently specific even if it includes sign-up, sign-in, and sign-out. A request such as “test the new feature” works only when the current conversation, selected PR/diff, ticket, or supplied design artifact identifies the feature. Product-wide requests are intentionally stopped before broad scanning.

Useful examples:

```text
Test Authentication and prepare Doable context.
Test the feature in this selected PR and prepare Doable context.
Prepare Doable context for Checkout using these screenshots as desired behavior.
```

The output is `.doable/features/<feature-slug>/doable-context.md`. Upload only that file. The neighboring `doable-intake.json` is local-only.

The plugin package is `doable-trd-context`; the workflow Skill inside it is `doable-trd-intake`. Keeping those names distinct preserves compatibility with the existing Skill while making the installed package's purpose clear.

## Privacy boundary

The plugin code makes no network requests and never connects to Doable. It excludes source code, repository metadata, secrets, raw logs, private URLs, and real customer data from the uploadable file. See [PRIVACY.md](PRIVACY.md) for the full boundary.

## Verify the package

```bash
npm test
claude plugin validate .
claude plugin validate ./plugins/doable-trd-context
```

The release check verifies all three host manifests, the Skill structure, internal references, absence of symlinks and MCP configuration, and common secret/path leaks.

Use [TESTING.md](TESTING.md) for the fresh-session beta acceptance matrix.

## License

[MIT](LICENSE)
