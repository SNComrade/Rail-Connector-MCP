# Changelog

All notable public changes will be documented here. The project follows
Semantic Versioning after the first stable release.

## [Unreleased]

## [1.0.0-beta.3] - 2026-08-31

### Added

- Record-scoped result identities, separate SHA-256 content verification,
  Unicode-safe chunk retrieval, exact text-size metadata, and main-record
  session-log usage evidence
- A short-lived, memory-bounded, session-log-validated result cache for
  efficient sequential paging of large record-scoped answers
- Launch audit receipts for bypass/isolation boundaries, requested tool argv,
  resolved-posture semantics, and unavailable delegated-agent telemetry
- Cross-platform launch-provenance coverage in the public portable test suite
- Bounded UltraCode attachment lifecycle evidence that records entry, exit,
  current state, partial-history uncertainty, and attention status
- Opt-in Claude debug capture with an MCP-owned path plus file, argument, and
  session binding evidence; debug contents are never returned by the MCP
- A guarded native-Windows acceptance test for initial UltraCode entry,
  transition to high effort, re-entry, debug-log growth, clean stop, and exact
  restoration of compatible Claude effort defaults

### Changed

- Operator, debugger, and reviewer skills recover truncated answers through
  `get_claude_result` and treat report-only prompts, allowed roots, and isolated
  policy values as controls with explicit evidence limits
- Operator and debugger guidance now uses lifecycle and debug provenance when
  distinguishing requested UltraCode from observed attachment behavior

### Fixed

- Final assistant JSONL records larger than the former 2 MiB tail window no
  longer disappear and cause a misleading wait timeout
- Large results remain retrievable when a smaller user or metadata record was
  appended after them, and oversized partial records are reported explicitly
- The bounded reader reserves the JSONL delimiter byte, so a payload exactly at
  the documented record limit remains recoverable
- Identical assistant text in separate records no longer borrows the wrong
  main-record usage evidence
- Legacy tmux metadata without a recorded child-launch environment now reports
  that boundary as unknown instead of applying current launch behavior
- Legacy session reconstruction no longer borrows the current MCP bypass policy
  and presents it as historical launch provenance
- Runtime-observation overflow recovery reports exact skipped-byte counts,
  stays bounded, and avoids replaying an entire large log
- Untimestamped duplicate UltraCode entry records retain the latest known entry
  time, while precommit cleanup removes a debug sidecar only when it is
  definitively bound to the failed launch
- Windows trust-menu navigation follows the selected row, delayed environment
  expansion is disabled for `cmd.exe` wrappers, and debug readiness remains
  consistent across platform backends

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
- Bounded large-log recovery now preserves unresolved head workflow evidence,
  fails closed across skipped lifecycle records, and does not report head-only
  model, effort, or permission posture as current
- Runtime-observation caches now reject truncate/regrow rewrites and fail
  closed while an appended JSONL record is incomplete
- Fully read cached history is whole-digest verified within the bounded read
  window before accepting appends; unchanged observations avoid full rehashing
  and oversized uncertain logs retain boundary guards until release replay
- Valid final JSON records no longer require a trailing newline, while genuine
  partial records still fail closed
- Timestamp-regressing release records cannot clear newer workflow activity,
  untracked historical completions do not advance the release watermark, and
  repeated global counters conservatively reconcile mixed task populations
- A tail checkpoint cannot clear a skipped-middle gap until one complete replay
  confirms that no newer hidden workflow evidence remains pending
- Trailing JSON records are assembled without quadratic copying and bounded per
  record and across cached or concurrent loads; overflow remains fail-closed
  across later counters
- Cached state now compares stored boundary guards even when size and timestamps
  appear unchanged, with change-time drift resetting same-length entries

Migration: consumers should treat the additive `unknown_due_to_gap` workflow
state and `incomplete` observation status as pending/unknown, use
`workflowObservationUncertain` instead of exhaustive string matching, and not
interpret `lastKnownPendingCount` as a current count.

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

[Unreleased]: https://github.com/SNComrade/Rail-Connector-MCP/compare/v1.0.0-beta.3...HEAD
[1.0.0-beta.3]: https://github.com/SNComrade/Rail-Connector-MCP/releases/tag/v1.0.0-beta.3
[1.0.0-beta.2]: https://github.com/SNComrade/Rail-Connector-MCP/releases/tag/v1.0.0-beta.2
[1.0.0-beta.1]: https://github.com/SNComrade/Rail-Connector-MCP/releases/tag/v1.0.0-beta.1
