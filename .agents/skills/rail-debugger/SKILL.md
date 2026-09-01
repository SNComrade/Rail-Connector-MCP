---
name: rail-debugger
description: "Diagnose, inspect, and fix Rail Connector MCP installation, capability, Windows broker, tmux, session listing or search, identity, prompt transport, transcript wait, capture, permission-mode, bypassPermissions, Ultracode, rename, archive, resume, fork, and cleanup failures. Use when tools are missing, Claude will not start or reconnect, requested posture is not observed, or multiple Codex agents conflict."
---

# Rail Connector Debugger

Move from symptom to evidence before changing configuration, processes, or repo
files. Read [debugging-playbook.md](references/debugging-playbook.md) for exact
checks.

## Diagnostic Layers

1. Codex tool exposure
2. MCP registration and process environment
3. installed Claude executable and capabilities
4. Windows broker or tmux ownership/lifecycle
5. Claude authentication, trust, and terminal state
6. session-log identity and transcript completion
7. caller workflow and concurrency

Do not reinstall before identifying the failed layer.

## Core Rules

- Treat diagnose, inspect, list, and report-only requests as non-mutating. Stop
  before installation, process termination, configuration, or file edits unless
  the user asked for a fix.
- Enforce the same-OS contract. Native Windows Codex controls native Windows
  Claude; WSL is separate.
- On Windows, the broker owns Claude Code ConPTY sessions across MCP task
  refreshes. Distinguish Claude Desktop processes, MCP stdio clients, broker,
  and Claude Code children.
- If tools are missing after code/config changes, verify registration and use a
  fresh Codex task before diagnosing runtime behavior.
- Prefer the platform installer or `codex mcp add` plus `codex mcp get` over
  direct configuration edits. If a fallback edit is unavoidable, back up
  `config.toml` first and parse it afterward.
- Call `status` and `get_claude_capabilities`; do not infer permission or
  Ultracode support from stale docs.
- Request `status.includeAgentDetails` only when machine-wide Claude process
  inventory is necessary; managed-session status is the privacy-safe default.
- Compare `posture.requested`, `posture.resolved`, `posture.observed`,
  `posture.ultracodeAssessment`, and evidence sources. Missing observation is
  unknown, not proof of failure.
- Separate `terminalState` from the combined `state`; workflow activity can
  make the latter busy without inventing terminal-busy evidence. On Unix,
  inspect `tmuxCompatibility` and require tmux 3.2 or newer for a new or
  replacement launch.
- For bypass failures, verify both policy `enabled: true` and
  `confirmBypassPermissions: true`. Local-host and isolated policies are both
  supported. Compare the policy fields and `status.mcpProcess` identity after
  registration changes. Inspect `posture.audit.securityBoundary`: isolated is
  an operator assertion, `osIsolationVerified` remains false, and allowed roots
  are not a Claude filesystem sandbox. Never silently downgrade an explicit
  bypass request.
- For Ultracode failures, verify the dedicated booleans, omitted ordinary
  effort, calibrated probe exit status, MCP-process environment blockers,
  chosen launch mechanism, runtime effort, and sanitized workflow activity.
  `advertisedAsEffort: false` and `helpListsUltracode: false` mean only that
  CLI help did not list the literal value; check `supportedByInstalledVersion`,
  `launchArgument`, and the probe before calling the capability unavailable.
  Timeout or terminated probes are inconclusive. Compare the persisted child
  `launchEnvironment` with `currentMcpEnvironment` after refresh; do not use the
  new process to rewrite an existing session's launch evidence. `xhigh`
  alone is correlated evidence, not confirmed Ultracode. Treat bound `high` or
  `max` as conflicting effort evidence; leave unknown labels unmapped.
  Inspect the bound attachment lifecycle: current enter is active, a later exit
  is inactive, and skipped or partial history stays labeled even when a later
  complete transition restores current state. Inspect `attentionStatus` for a
  blocking environment, effort conflict, or terminal-rejection conflict. These
  records prove a client-side transition, not server-side orchestration.
- For an explicit deep diagnostic, launch with `debug: true` and an optional
  `debugFilter`. Verify `debugLog.status`, identity, launch binding, and growth
  without returning its sensitive contents. On Windows,
  `ready_acl_unverified` is the expected success-with-ACL-caveat state. Debug
  capture can prove local argv and event timing;
  it cannot prove Anthropic's effective server-side effort.
- For report-only posture, remember that built-in tool flags do not remove MCP
  or connector tools. The current MCP does not provide a verified strict
  MCP-config roster; inspect the effective roster and use filesystem isolation
  when connector-level writes must be impossible.
- Before comparing Claude Desktop or CLI visuals, bind the view to the same
  managed name, conversation UUID, generation, and time window. An unbound
  screenshot cannot prove or disprove the MCP session's posture.
- Prefer the transcript returned by `wait_for_claude_turn` over animated
  terminal capture. When `textTruncated` is true, use `get_claude_result` with
  the returned opaque, record-scoped `resultId` and verify the separate
  `textSha256` content digest after the last chunk.
- Distinguish `needs_attention` from a completed result with additive
  `attention`; the latter still contains a valid completed transcript plus a
  weaker warning to surface or resolve.
- Treat renderer, parser, and composer mistakes as testable defects. Add a
  focused regression fixture before broad heuristic changes.
- Treat spinner wording as variable Claude UI. Diagnose from animation
  glyphs, timing/interrupt markers, completion ordering, composer state, and
  transcript evidence rather than a fixed phrase list or a bare prose phrase.
- Treat non-idle stop/replacement refusal and mutation leases as protective
  lifecycle behavior, not random failure.
- A current MCP launch blocker must stop a new or replacement child, but it
  must not prevent read-only reconnection to an already-running managed child.

## Workflow

1. Classify the symptom by layer.
2. Record exact repo status, config, versions, capabilities, backend status,
   managed name, UUID, and capture state.
3. Reproduce with the smallest non-destructive operation.
4. Compare expected behavior with tool status/reason and broker or tmux
   metadata.
5. Apply the narrowest fix.
6. Run focused tests, then `npm test`.
7. Report symptom, evidence, root cause, fix, verification, and whether Codex
   needs a fresh MCP process or targeted app-server reload.
