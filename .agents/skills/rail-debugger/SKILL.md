---
name: rail-debugger
description: "Diagnose, inspect, and fix Rail Connector MCP installation, capability, Windows broker, tmux, session listing or search, identity, prompt transport, keyword-mode, transcript wait, pending-workflow, capture, permission-mode, bypassPermissions, Ultracode, rename, archive, resume, fork, and cleanup failures. Use when tools are missing, Claude will not start or reconnect, a workflow stays pending, composer text blocks a prompt or stop, requested posture is not observed, or multiple Codex agents conflict."
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
- Release a pending workflow only from current evidence for a tracked launch
  that bound a task ID and a run ID: a direct terminal record with the matching
  run ID, a completed `TaskOutput` retrieval (older CLIs; Claude 2.1.289 has no
  `TaskOutput` tool) or Claude's own task-notification record with a terminal
  status for that task (a run ID may be absent but must match if present), or
  the fresh native-Windows conversation snapshot. A current bound
  interruption clears the tracked set. `blocked` or any other non-terminal
  notification status keeps it pending; counters (including zero), worker
  output, and `end_turn` never clear identified work. A full, certain log that
  has seen a workflow launch overrides 2.1.289's permanent `Waiting for N
  dynamic workflows` row; a `head_tail` or uncertain log does not. If release
  fails, confirm in Claude that the workflow finished; then, with
  authorization and only when `terminalState` is otherwise idle and the
  composer is empty, repeat the blocked `submit_prompt`, `send_text`,
  `send_key`, `rename_claude_session`, or `stop_remote_control` call with
  `force: true` (a replacement uses `forceKillExisting: true`;
  `wait_for_claude_turn` takes no `force`).
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
- Managed launches, including resume, fork and replacement, set
  `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` on both backends unless
  `start_remote_control` received `promptSuggestions: true` (the child then
  gets `true`). When suggestions are on anyway (that opt-in, a Claude settings
  `env` entry or wrapper, Claude before 2.1.238, or a session launched before
  this default or by an MCP process not yet restarted), suggestion text blocks
  prompts (`active_input_not_empty`) and graceful stop (`awaiting_input`) like
  a real draft. The setting is not recorded or compared for existing sessions;
  replace to be sure, inspecting the capture first because `killExisting` is
  refused on composer text and `forceKillExisting` discards a real draft.
- Treat renderer, parser, and composer mistakes as testable defects. Add a
  focused regression fixture before broad heuristic changes.
- Treat spinner wording as variable Claude UI. Diagnose from animation
  glyphs, timing/interrupt markers, completion ordering, composer state, and
  transcript evidence rather than a fixed phrase list or a bare prose phrase.
- Treat non-idle stop/replacement refusal, mutation leases, keyword-mode
  refusal, and recovery-only sessions as protective lifecycle behavior, not
  random failure. Native-Windows keyword mode refuses a draft or paste
  placeholder even with `force: true` (`preflight_blocked` with
  `active_input_not_empty` or `paste_pending`, `forceRefused: true`; nothing
  sent). `EPASTEMODE` after the prefix or part of the body was sent, or a
  native-Windows `stop_timeout`, makes that generation recovery-only
  (`status` shows `recoveryOnly: true`): prompts, keys, renames, and
  name-only stop or replacement are refused. Inspect it with
  `capture_remote_control`, then stop it with its `expectedGenerationId` and
  `expectedStartedAtMs`, never by name.
  On native Windows, `stop_timeout` comes only from a forced stop; after it,
  always add `force: true`, because a paired stop without it does not repeat
  the termination. If it times out again, report it instead of looping. After
  `EPASTEMODE`, add `force: true` only if that paired stop returns
  `stop_blocked` or `graceful_stop_timeout`. Then start a new session. A tmux
  `stop_timeout` carries no pair and leaves no recovery-only state, and tmux
  refuses the pair; report it.
- A keyword prompt accepted under `dontAsk` whose answer reports the Workflow
  tool call as denied, with no workflow launch observed
  (`posture.ultracodeAssessment.workflowActivity.launchObserved: false`), is
  launch posture, not a transport failure: the session was started without
  the Workflow tool allowed. The allowance verified live is
  `tools: ["Workflow"]` plus `allowedTools: ["Workflow"]` at launch. This MCP
  sets tool lists only at launch, so when the user asked for a fix, replace
  the session once it is idle. In `default` mode, Claude's documentation says
  Claude asks before the workflow runs (not verified through this MCP), and
  the MCP may not recognize that prompt as `approval_required` (not verified).
- A current MCP launch blocker must stop a new or replacement child, but it
  must not prevent read-only reconnection to an already-running managed child.

## Workflow

1. Classify the symptom by layer.
2. Record exact repo status, config, versions, capabilities, backend status,
   managed name, UUID, and capture state. Claude Code can update itself
   between two starts, so its version can differ from an earlier record;
   report the change and carry on unless a tool reports a problem.
3. Reproduce with the smallest non-destructive operation.
4. Compare expected behavior with tool status/reason and broker or tmux
   metadata.
5. Apply the narrowest fix.
6. Run focused tests, then `npm test`.
7. Report symptom, evidence, root cause, fix, verification, and whether Codex
   needs a fresh MCP process or targeted app-server reload.
