---
name: rail-operator
description: "Operate and inspect local Claude Code Remote Control sessions through the Rail Connector MCP. Use when the user asks Codex to start, list, search, find, inspect, resume, continue, fork, prompt, wait for, capture, rename, archive, reconnect to, or stop Claude; requests Claude bypassPermissions or Ultracode; or needs multiple Codex agents to share persistent Claude sessions safely."
---

# Rail Connector Operator

Operate Claude through the exposed `mcp__rail_connector` tools. Use the actual
task project as `cwd`, even when this skill is loaded from the MCP repo.

## Rules

- Do not simulate an MCP result. If tools are missing after an install or
  update, explain that Codex needs a fresh task or restart.
- Keep Codex, this MCP, Claude, paths, credentials, and logs in the same OS
  context.
- Call `status` when lifecycle is unclear and `get_claude_capabilities` before
  permission, effort, or Ultracode launch decisions.
- Use `debug: true` only for an explicit, bounded diagnostic run. Inspect the
  returned `debugLog` provenance and size; the MCP never returns contents, and
  the retained file is sensitive local evidence.
- Give parallel jobs unique `managedSession` names. A Windows broker session
  persists across MCP/Codex task refresh and must be explicitly stopped.
- Treat managed terminal name, Remote Control `remoteName`, conversation title,
  and conversation UUID as different identities.
- Prefer `submit_prompt` plus `wait_for_claude_turn`. Use terminal capture for
  attention states and low-level diagnosis, not as the clean answer channel.
- Claude spinner phrases are variable. Trust the returned structured state,
  completion ordering, and transcript cursor rather than matching a particular
  phrase.
- Treat `workflowPending: true` as busy even when the composer appears idle.
  The MCP combines the exact dynamic-workflow wait control line with sanitized
  session-log task lifecycle evidence and blocks submit, low-level text/Enter,
  rename, replacement, and ordinary stop with reason `workflow_pending`.
- Read `terminalState` separately from the combined `state`. Workflow activity
  can make `state` busy while `terminalState` remains idle. When
  `workflowPending` is false, `workflowPendingEvidence` is intentionally empty;
  use `workflowObservationCoverage` and `workflowObservationSkippedBytes` to
  tell a full scan from a bounded head/tail recovery of a large session log.
  Treat `workflowObservationUncertain: true` as a fail-closed pending state:
  skipped-middle history cannot prove current workflow completion or current
  model, effort, or permission posture. A tail checkpoint must complete a full
  replay before the MCP reports restored certainty.
- Treat `C-m`, `C-j`, `KPEnter`, and other documented Enter equivalents as
  submissions. They use the same pending-workflow gate as `Enter` and `Return`.
- Do not infer workflow completion from a final assistant record alone. Keep
  waiting until `workflowPending` clears, handle a bounded timeout, or inspect
  and deliberately authorize a force action.
- Treat `tool_use` as in progress. Check `textTruncated`, `textSha256`, and
  `textCharacters` before assuming a large report was returned in full. Use
  `get_claude_result` with `resultId` for exact chunks until `hasMore` is false.
- Never type over a busy or non-empty composer unless the user deliberately
  authorizes an inspected `force` action.

## Permission And Effort Intent

Use `permissionMode: "dontAsk"` for report-only work when the installed CLI
advertises it, pass `disallowedTools: ["Edit", "Write", "NotebookEdit"]`,
leave workspace trust false unless explicitly authorized, include explicit
no-edit prompt constraints, and verify repository/index state before and after.
This denies new permission requests without turning the review into a
plan-approval workflow; it is not an operating-system sandbox.
`tools`, `allowedTools`, and `disallowedTools` constrain built-in Claude tools
only. Connected MCP and connector tools can remain available, and this MCP does
not yet provide a verified strict MCP-config roster. Inspect the effective
roster when possible and use an isolated worktree or read-only copy when hard
write isolation is required.
Use `plan` only as a compatibility fallback and never approve implementation
from a report-only session. Use semantic `default` for normal interactive work;
the MCP resolves it to the installed CLI's advertised `default` or `manual`
alias.

When the user explicitly asks for bypass:

1. Confirm `get_claude_capabilities` reports the bypass policy enabled.
2. Pass `permissionMode: "bypassPermissions"`.
3. Pass `confirmBypassPermissions: true`.
4. If policy is disabled, report the exact missing MCP configuration and
   new-process requirement. Use registration and MCP PID/start-time evidence;
   do not silently downgrade the request.

The accepted local-host policy acknowledges that bypass can modify the host
without prompts. An isolated policy value remains supported, but
`posture.audit.securityBoundary.isolationClaim: "operator_asserted"` is not OS
isolation proof. Allowed roots constrain MCP session management, not Claude's
filesystem access. Do not infer bypass authorization from workspace trust or
team size.

When the user explicitly asks for Ultracode:

1. Confirm `ultracode.argumentProbe`, `capabilityStatus`, `supportSource`, and
   `environment`. Probe acceptance requires a zero exit for UltraCode and a
   nonzero invalid control; timeout or termination is inconclusive. A blocking
   process override must be corrected before launch.
   `advertisedAsEffort: false` and `helpListsUltracode: false` mean only that
   CLI help omitted the literal value; they are not unavailability results.
   Read `supportedByInstalledVersion`, `launchMechanism`, and `launchArgument`
   with the probe evidence.
2. Pass `ultracode: true` and `confirmUltracode: true`.
3. Omit ordinary `effort` and `safeMode`.
4. Inspect `posture.ultracodeAssessment` after start and after the turn. Current
   supported Claude builds use direct `--effort=ultracode`. Compare the
   persisted `launchEnvironment` with `currentMcpEnvironment`; after a refresh,
   the latter is diagnostics for the new MCP process, not retroactive launch
   evidence for the existing Claude child.
   Read `ultraEffortAttachment.active`, `lifecycle`, `lastTransition`, and
   `historyCoverage`. A current enter produces
   `attachment_lifecycle_active`; a later exit produces
   `exited_after_entry`. An unknown lifecycle after a skipped or partial range
   must not be promoted to active unless a later complete transition restores
   current state; historical coverage remains partial. Inspect
   `attentionStatus` before trusting an active lifecycle because a blocking
   environment, conflicting effort, or terminal rejection can coexist with the
   attachment. Enter/exit records authenticate client-side mode transitions,
   not server-side workflow execution.

Do not claim an unobserved posture is confirmed. Use each field's evidence
source; session-log evidence is stronger than terminal heuristics. `xhigh` is
consistent with Ultracode but does not prove workflow orchestration. Claude's
Remote Control web UI can label the underlying `xhigh` level as `Extra` while
Ultracode is active. A session-bound web `Extra` is compatible UI presentation,
not confirmation, conflict, or workflow evidence; context-free terminal text
must remain unmapped. Any bound effort other than `xhigh` or `ultracode`, such
as `high` or `max`, is a conflict to investigate. On an idle, empty composer,
`/effort ultracode` returning the explicit UltraCode setting is current-setting
evidence, but the command can change posture and does not prove launch
provenance. A trivial turn cannot validate dynamic workflows. Bind visual
comparisons to the same managed name, conversation UUID, generation, and time.

## Workflow

1. **Orient.** Call `status` and `get_claude_capabilities`. If a named session
   exists, capture it before mutation.
2. **Choose identity.** Start fresh, resume exact `sessionId`, resolve exact
   `resumeSessionName`, use `continueLatest`, or fork a resolved conversation.
   Metadata-only session listing is the privacy default; hidden title and
   transcript fields can still be searched.
3. **Start.** Pass explicit `cwd`, `managedSession`, `remoteName`,
   `permissionMode`, and `trustWorkspace`. Use `sessionTitle` only for a new
   conversation. Start with `killExisting: false`.
4. **Submit.** Use `submit_prompt` with `force: false`. Read `status`, `reason`,
   signals, `waitAfterCursor`, transcript, posture, and `posture.audit`.
5. **Wait.** Call `wait_for_claude_turn` with the returned non-empty
   `waitAfterCursor` verbatim. Handle `needs_attention` before sending more
   work. A `completed` result may also carry an additive `attention` warning;
   report or resolve it without discarding the completed answer.
   `workflow_pending` keeps the wait active even if a terminal assistant record
   has already appeared.
6. **Manage.** Rename only while idle. Archive/unarchive by UUID; those tools
   only change the MCP-local catalog, never Claude's transcript. If an
   interrupted workflow leaves stale pending evidence, inspect first; text,
   Enter-equivalent key, rename, submit, replacement, and stop tools expose
   explicit force recovery. Report `forceUsed`, `replacementForceUsed`, or
   `workflowInterrupted` rather than hiding the override. For forced prompt
   submission, also report `forcedPastReason`. Rename `force` bypasses only a
   verified `workflow_pending` gate; approval, trust, draft, paste, exit, and
   other non-idle `terminalState` gates remain blocking. Native Windows rejects
   unsupported key names with `EINVAL`; never retry by sending the key name as
   text.
7. **Finish.** Gracefully stop only an idle managed session created by this
   workflow with an empty composer, unless the user explicitly asks to stop or
   retain another known session. If stop reports
   `awaiting_input`, preserve the draft: submit it only with authorization,
   explicitly discard and recapture only with authorization, or leave the
   session running. Never force-stop an unsent draft as routine cleanup. Report
   the managed name and running state. Disclose a Remote Control URL only when
   requested or necessary.

Read [operator-playbook.md](references/operator-playbook.md) for exact call
recipes and recovery paths.
