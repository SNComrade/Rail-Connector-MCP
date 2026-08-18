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
- Linux and macOS now require tmux 3.2 or newer so per-session child
  environments can use the isolated `new-session -e` transport
- Cold runtime-observation reads now use a bounded head/tail window before
  continuing incrementally and report when middle bytes were skipped

### Fixed

- Prompt submission retries no longer depend on Claude's rotating spinner words
- Stale or cross-generation waits fail closed instead of returning an older turn
- Junction and symlink project paths bind to Claude's canonical session-log
  directory
- Claude `--effort` rejection diagnostics are parsed linearly instead of with
  unbounded regular expressions over CLI output
- Unsupported native-Windows key names return `EINVAL` instead of being typed
  into Claude's composer
- Forced `submit_prompt` calls report both `forceUsed` and `forcedPastReason`
- Non-parser CLI failures no longer masquerade as calibrated UltraCode argument
  rejection
- Invalid Windows launch metadata is rejected before a PTY can be spawned, and
  equivalent blocker sets are canonicalized independent of caller ordering
- Reconnecting to an existing session no longer applies current MCP
  environment blockers that could not have affected the persisted child
- Workflow-only forced rename no longer bypasses a simultaneous approval,
  trust, draft, busy, or other terminal attention state
- Completed workflow state no longer retains pending-only evidence fields, and
  symlinked fixture paths use the same canonical project directory as runtime
  observation
- Terminal local-workflow status records now retire their matching tracked
  tasks instead of leaving `workflowPending` stuck after completion
- Linux and macOS status output now removes legacy persisted
  `observedPosture` metadata before reporting current managed-session evidence

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
