# Changelog

All notable public changes will be documented here. The project follows
Semantic Versioning after the first stable release.

## [Unreleased]

## [1.0.0-beta.2] - 2026-08-18

### Added

- Direct Fable 5 and Opus 5 launch recipes with explicit Ultracode and
  `bypassPermissions` acknowledgements
- Portable transcript wait cursors that survive MCP and Codex task refreshes
- Incremental session-log runtime observation for model, effort, permission,
  and dynamic-workflow lifecycle evidence
- Exact child argument and sanitized launch-environment provenance across the
  Windows broker and Linux/macOS tmux backends
- Public runtime-observation regression coverage for bounded incremental log
  reads and cache rollover

### Changed

- Ultracode reporting now separates requested, launch-resolved,
  runtime-observed, workflow-observed, terminal-heuristic, and web-UI evidence
  instead of treating `xhigh` or the web `Extra` label as full confirmation
- Prompt, text, Enter-equivalent key, rename, replacement, and stop operations
  hold while a bound dynamic workflow is pending; inspected force recovery is
  machine-auditable
- Operator, debugger, and reviewer skills now use explicit identity, posture,
  transcript-wait, cleanup, and evidence-reporting contracts
- Windows broker compatibility advanced for stricter launch provenance and key
  transport behavior

### Fixed

- Prompt submission retries no longer depend on Claude's rotating spinner words
- Stale or cross-generation waits fail closed instead of returning an older turn
- Junction and symlink project paths bind to Claude's canonical session-log
  directory
- Unsupported native-Windows key names return `EINVAL` instead of being typed
  into Claude's composer
- Forced `submit_prompt` calls report both `forceUsed` and `forcedPastReason`

### Security

- Broker launch descriptors, child environments, generation leases, and
  workflow metadata are revalidated and sanitized without returning raw
  environment values, workflow names, or task identifiers
- CodeQL actions updated to v4.37.7 at the immutable Dependabot-reviewed commit

## [1.0.0-beta.1] - 2026-08-13

### Added

- Public project governance, security, support, compatibility, and contribution
  policies
- Public CI, dependency review, CodeQL, dependency audit, and release checks
- First public beta candidate
- Native Windows broker and Linux/macOS tmux backends
- Claude session discovery, resume, continue, fork, rename, archive, and stop
- Prompt submission with transcript-backed completion waiting
- Permission-mode, model, effort, and Ultracode launch controls
- Operator, debugger, and reviewer Codex skills
- Deterministic sanitized export, public privacy checks, full-history secret
  scanning, and public metadata/package regression gates
- Absolute Claude-path registration, optional allowed roots, and tagged-source
  installation guidance

[Unreleased]: https://github.com/SNComrade/Rail-Connector-MCP/compare/v1.0.0-beta.2...HEAD
[1.0.0-beta.2]: https://github.com/SNComrade/Rail-Connector-MCP/releases/tag/v1.0.0-beta.2
[1.0.0-beta.1]: https://github.com/SNComrade/Rail-Connector-MCP/releases/tag/v1.0.0-beta.1
