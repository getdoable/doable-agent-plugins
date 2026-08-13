# Changelog

All notable changes to Doable Agent Plugins are documented here.

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
