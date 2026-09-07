# Changelog

All notable changes to Doable Agent Plugins are documented here.

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
