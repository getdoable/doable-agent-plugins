# Changelog

All notable changes to Doable Agent Plugins are documented here.

## [0.2.9] - 2026-09-26

### Added

- Report investigation stages and the current question to the TRD editor, with
  updates during long active work at the next tool boundary (about 60 seconds).
- Fall back to phase-only reporting on older MCP/backend deployments; never
  report artificial activity during idle connection polling.
- Cross-repository contract: `getdoable/trd`
  `docs/change-sets/code-context-live-progress.yaml`.

## [0.2.8] - 2026-09-25

### Fixed

- Accept a server-bound pre-create successor when a TRD needs more context to
  finish creation. Keep checking the original connection code and local workspace.
- Requires the matching TRD connection resolver fix; older servers retain their
  existing behavior. Cross-repository contract: `getdoable/trd`
  `docs/change-sets/pre-create-code-context-toggle.yaml`.

## [0.2.7] - 2026-09-17

### Fixed

- Advance the plugin version so existing installations can receive the changes
  merged after 0.2.6: persistent follow-up watching, journey declarations, and
  result observation. A reused version can leave an installed plugin cached.
- Follow the server's next-action decision when a pre-create Round hands over
  to TRD follow-ups, and omit journey declarations when the Round did not
  request them, preserving compatibility with older backends.
- Align the local helper's client version with the plugin release.

### Documentation

- Explain how to inspect the installed Doable version, update the Claude Code
  plugin, load it into a session, and enable marketplace auto-updates.

## [0.2.6] - 2026-09-07

### Fixed

- Wait for Cursor's asynchronous MCP refresh after replacing credentials, then
  retry the original preflight before treating a `401` as a rejected new key.

## [0.2.5] - 2026-09-07

### Changed

- Bundle the official remote Doable MCP connection for Codex, Claude Code, and Cursor.
- Ask for `DOABLE_API_KEY` as a required Cursor installation variable so a
  first-time user authenticates while installing the plugin.
- Define the cold-start acceptance path from a TRD Editor copy prompt through
  plugin approval, authentication, exact-Round preflight, and automatic resume.

## [0.2.4] - 2026-09-07

### Changed

- Preflight copied context requests against their exact Round and organization
  before reading local state or scanning source.
- Recover missing, stale, invalid, or wrong-organization MCP connections in the
  original conversation. Claude Code users reconnect `doable` once in `/mcp`;
  they no longer restart the host or paste the request again.
- Apply the same live-connection preflight to coding-agent-origin feature tests
  before workspace setup or suite lookup.

## [0.2.3] - 2026-08-21

### Changed

- Keep one post-create context connection open across sequential TRD follow-up
  Rounds. The original copied DQ code resolves to the newest published Round
  until the user stops the coding-agent task.
- Fetch the current TRD for each newly resolved follow-up Round while keeping
  code, tests, and runtime evidence descriptive rather than treating it as
  authoritative product intent.

### Fixed

- Preserve an existing workspace client reference when a new Round has not yet
  been bound, avoiding duplicate workspace profiles and unnecessary approval.

## [0.2.2] - 2026-08-20

### Changed

- Watch one published Round until the editor continues TRD generation. `record-round`
  prints `Next action: answer|wait|stop`, keeps same-round answers as established
  context, and does not treat `ready_to_create` as finished.
- `record-submission` keeps one receipt per payload digest so a later batch on the
  same revision can be recorded. Retrying the exact same payload stays idempotent.
- Before scanning, the answering Skill verifies any named branch, PR, worktree, or
  change set locally, refreshes a stale checkout, and stops if that target is
  missing or ambiguous. A Round does not transfer Git state.

## [0.2.1] - 2026-08-13

### Fixed

- Resume coding-agent feature testing from an existing Round state instead of
  assuming every retry requires another code scan.

## [0.2.0] - 2026-08-12

### Added

- Doable Code Context for Codex, Claude Code, and Cursor.
- MCP-backed pre-TRD context rounds with grounded, privacy-safe findings.
- Coding-agent-first feature testing through the existing Doable suite, TRD, and managed-case workflow.
- Demand-driven mono-repo and multi-repo workspace mapping with local-only provenance.

### Changed

- Replaced the legacy context-file workflow with MCP-backed context rounds and managed feature testing.
- Added direct public setup instructions for Codex, Claude Code, and Cursor.

### Security and privacy

- Remote operations are isolated to the separately configured Doable MCP connection.
- The bundled helper has no network or credential primitives.
- Real repository identities, source locations, commits, local paths, and private artifacts remain local.
