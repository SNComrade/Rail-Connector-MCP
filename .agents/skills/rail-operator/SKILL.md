---
name: rail-operator
description: "Operate and inspect local Claude Code Remote Control sessions through the Rail Connector MCP. Use when the user asks Codex to start, list, search, find, inspect, resume, continue, fork, prompt, wait for, capture, rename, archive, reconnect to, or stop Claude; requests Claude bypassPermissions or Ultracode; asks for the quick check after a Claude Code update or when something looks off; or needs multiple Codex agents to share persistent Claude sessions safely."
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
- On native Windows a managed name can come to belong to a new generation, for
  example after a replacement or a start by another agent. To make sure a call
  reaches the session you started or inspected, pass its generation pair as
  `expectedGenerationId` and `expectedStartedAtMs`, always together, to
  `capture_remote_control`, `wait_for_claude_turn`, `submit_prompt`,
  `rename_claude_session` and `stop_remote_control`. Take the pair from the
  start result's `sessionBinding` (`existingSession` on `already_running`) or
  from the `status` entry with that `name` (`generationId`, `startedAtMs`). A
  paired wait also needs the `waitAfterCursor` returned for that generation;
  without one, wait by name. A paired call can fail with a stale-generation
  error (code `ESTALE`, which callers do not see; the text says the
  generation changed, refuses a stale operation, or rejects the `afterCursor`).
  The name now belongs to another generation or none, or the cursor or
  conversation does not match. Such a call reached no other generation, and
  one refused at its start did nothing at all. Only if Claude exited during the
  call and another start took the name can input sent earlier in that call
  have reached the old session (from the code; not seen live). Call `status`;
  do not repeat the call by name. Other tools take no pair. On Linux and macOS
  leave it out: tmux rejects it.
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
  On Claude 2.1.289 the `Waiting for N dynamic workflows to finish` row stays
  on screen after the workflow ends. Once a complete, certain session log
  (`workflowObservationCoverage: "full"`) has seen the workflow launch, the log
  decides and the stale row is neither pending nor busy evidence. With
  `head_tail` coverage, or before the log has seen a launch, the row still
  holds `workflowPending`. Then confirm in Claude that the workflow finished;
  with authorization, and only when `terminalState` is otherwise idle and the
  composer is empty, repeat the blocked `submit_prompt`, `send_text`,
  `send_key`, `rename_claude_session`, or `stop_remote_control` call with
  `force: true` (a replacement uses `forceKillExisting: true`;
  `wait_for_claude_turn` takes no `force`).
- Read `terminalState` separately from the combined `state`. Workflow activity
  can make `state` busy while `terminalState` remains idle. When
  `workflowPending` is false, `workflowPendingEvidence` is intentionally empty;
  use `workflowObservationCoverage` and `workflowObservationSkippedBytes` to
  tell a full scan from a bounded head/tail recovery of a large session log.
  Treat `workflowObservationUncertain: true` as a fail-closed pending state:
  skipped-middle history cannot prove current workflow completion or current
  model, effort, or permission posture. A current explicit workflow counter or
  bound interruption in the observed tail can restore current-state certainty,
  but a counter alone cannot clear known pending workflows. The skipped middle
  is never replayed, and coverage stays `head_tail`.
- Treat `C-m`, `C-j`, `KPEnter`, and other documented Enter equivalents as
  submissions. They use the same pending-workflow gate as `Enter` and `Return`.
- Do not infer workflow completion from a final assistant record, worker
  results, an idle composer, or a pending count. The MCP releases a tracked
  workflow whose launch bound a task ID and a run ID only on current evidence
  for it: a direct terminal record with the matching run ID, a completed
  `TaskOutput` retrieval (older CLIs; Claude 2.1.289 has no `TaskOutput`
  tool) or Claude's own task notification for that task (a run ID may be
  absent but must match if present; notification statuses `completed`,
  `failed`, `killed`, or an older terminal word release, while `blocked` and
  unknown statuses stay pending), or the workflow snapshot of a fresh
  native-Windows managed conversation. A current bound interruption can also
  clear the tracked set. Keep waiting until `workflowPending` clears or handle
  a bounded timeout. If Claude shows the workflow finished but it stays
  pending, use the authorized force recovery described above.
- Treat `tool_use` as in progress. Check `textTruncated`, `textSha256`, and
  `textCharacters` before assuming a large report was returned in full. Use
  `get_claude_result` with `resultId` for exact chunks until `hasMore` is false.
- Never type over a busy or non-empty composer unless the user deliberately
  authorizes an inspected `force` action. Native-Windows keyword mode never
  crosses a draft or paste placeholder: `pasteMode: "keyword"` needs an empty
  composer even with `force: true`, and otherwise returns `preflight_blocked`
  (`active_input_not_empty` or `paste_pending`, plus `forceRefused: true` when
  force was requested) without sending anything.

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

`dontAsk` also denies the Workflow tool unless it is allowed. If a `dontAsk`
session will receive a workflow keyword, launch it with `tools: ["Workflow"]`
and `allowedTools: ["Workflow"]` (verified live). `tools` then leaves
Workflow as the only built-in tool, so list any other built-in tool the
session needs and keep it out of `disallowedTools` (not verified). Without the
allowance, Claude reports the Workflow call as denied and no workflow runs
(seen live). This MCP sets permissions and tool lists only at launch, so a
running session without the allowance needs a replacement: `killExisting:
true` once it is idle, for a workflow the user asked for. In `default` mode,
Claude's documentation says Claude asks before a workflow runs (not verified
through this MCP), and the MCP may not recognize that prompt as
`approval_required`, so a wait can time out instead (not verified). Capture,
and answer only with the user's authorization.

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
   conversation. Start with `killExisting: false`. Every managed launch,
   including resume, continue, fork, and a `killExisting` replacement, gets
   `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` on both backends, because
   generated suggestion text looks like an unsent draft and blocks prompts
   (`active_input_not_empty`) and graceful stop (`awaiting_input`). Pass
   `promptSuggestions: true` only when the user wants suggestions. A Claude
   settings `env` entry or a wrapper can override the setting, Claude before
   2.1.238 ignores it, and it is not recorded or compared for an
   `already_running` session. To be sure, replace the session. If composer
   text shows, a plain `killExisting` is refused. Inspect the capture first,
   because `forceKillExisting` also discards a real draft. Report the returned
   `claudeCliVersion`. Claude Code can update itself between two starts, so it
   can differ from an earlier start; report it and carry on unless a tool
   reports a problem.
4. **Submit.** Use `submit_prompt` with `force: false`. Read `status`, `reason`,
   signals, `waitAfterCursor`, transcript, posture, and `posture.audit`.
   Use `pasteMode: "keyword"` only for an explicit native-Windows workflow
   keyword request, with an unchanged leading lowercase `ultracode:` and an
   empty composer; `force` cannot send past a draft or paste placeholder in
   this mode. Under `dontAsk` the session must have been launched with the
   Workflow tool allowed (see Permission And Effort Intent). If it fails with `EPASTEMODE` and `status` shows
   `recoveryOnly: true` for that session, do not retry there: inspect it with
   `capture_remote_control`, stop it with `stop_remote_control` using its
   `expectedGenerationId`, `expectedStartedAtMs`, and `force: true`, and start
   a new session.
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
   session running. Never force-stop an unsent draft as routine cleanup. With
   suggestions on, untyped suggestion text also makes stop report
   `awaiting_input` (and submit report `active_input_not_empty`); the MCP
   cannot tell it from a draft, so treat it as one. Report
   the managed name and running state. Disclose a Remote Control URL only when
   requested or necessary.
   On native Windows a forced stop can return `status: "stop_timeout"`, a
   normal result rather than an error: Claude did not confirm exit, and the
   session is now recovery-only (`recoveryOnly: true` in `status`). Only in
   that case, retry `stop_remote_control` once with the same
   `managedSession`, the reply's `expectedGenerationId` and
   `expectedStartedAtMs` exactly as given, and `force: true`; never stop it by
   name, and a retry without `force` does not repeat the termination. A forced
   stop discards what the session still holds: an unsent draft, an in-flight
   turn, a pending approval and any running workflow (`forceUsed`,
   `workflowInterrupted`). If the retry returns `stop_timeout` again, do not
   loop; report it, because the process must then end outside the MCP. See
   Replace Or Stop in the playbook.

Read [operator-playbook.md](references/operator-playbook.md) for exact call
recipes and recovery paths.

## Quick Check

A smoke check the user can ask for in one line, after a Claude Code update or
when something looks off. It shows that the MCP and Claude Code on this PC
still start, answer, rename, run a small keyword workflow and stop cleanly. It
does not validate workflows: that needs a substantive prompt. Take the exact
calls, prompts and pass conditions from Quick Check in
[operator-playbook.md](references/operator-playbook.md).

- **Setup:** one session named `quick-check` in a new empty folder you create
  under the temp directory. The request to run the quick check authorizes
  workspace trust for that folder only (`trustWorkspace: true`). Use the
  project's model target (`claude-fable-5-1` today), effort `xhigh`,
  `permissionMode: "dontAsk"`, no bypass, no explicit UltraCode,
  `promptSuggestions` left unset, and the tool lists of the playbook's
  live-tested `dontAsk` workflow example. Call every tool by the managed name.
- **Steps:**
  1. `status` and `get_claude_capabilities`: report the Claude program path
     and version. If a managed session already exists, stop the check there
     and report it; do not capture, prompt or stop that session.
  2. Start, then report `claudeCliVersion` and the requested, resolved and
     observed model and permission mode. If start returns `already_running`,
     that session is not this check's: stop the check and leave it alone.
  3. `capture_remote_control`: the prompt box must be empty.
  4. An ordinary prompt asking for the single word READY, then wait.
  5. One `rename_claude_session` call.
  6. The two-worker keyword workflow prompt with `pasteMode: "keyword"`.
  7. Wait at most 8 minutes in total for `workflowPending` to clear by itself.
  8. Graceful stop.
  9. `status`: no managed session is left.
  10. Remove the temp folder only if it is empty.
- **Limits:** one session, the one this check started (never capture,
  prompt, rename or stop another), two prompts, no force, no bypass. Stop the
  check only if a call is refused or returns an error, an unexpected dialog
  shows, or the session is busy when it should be idle (a non-idle
  `terminalState` or text left in the prompt box). Then leave things as they
  are and report. After a FAIL that leaves this check's session idle with
  nothing pending (`signals.terminalState` `idle`,
  `signals.workflowPending: false`) and no unexpected dialog, list, menu or
  leftover prompt text in the capture, still stop it gracefully. Also stop it
  gracefully when Claude has already exited (`exited_during_startup`, or
  `terminalState` `exited`) and `status` does not show `recoveryOnly: true`:
  that stop sends nothing to Claude and only removes the leftover entry, which
  would otherwise stop the next quick check at step 1 (from the code; not seen
  live). After an unexpected dialog, send nothing at all, not even the graceful
  stop, which types `/exit` and Enter into whatever is open. A
  version that differs from an earlier check is reported, not a reason to
  stop. Steps 6 and 7 need native Windows. On Linux and macOS do not call
  them: report them as NOT RUN and go on to step 8; skipping them is not an
  error stop.
- **Report:** one line for each of the 10 steps with PASS, FAIL or NOT RUN and
  what was seen; for NOT RUN, give the reason (not native Windows, an earlier
  stop, or a workflow still pending). Mark each statement FACT, INFERENCE or
  UNKNOWN. Leave out transcripts, tokens, Remote Control links and capture
  text.
- **Seen live:** the first full pass was on 2026-10-08 (owner-reported). A
  fresh Codex task, given the one-line request, ran all 10 steps in one session
  on native Windows through the registered MCP, on Claude Code 2.1.294. That
  run is recorded, with its date, in the repository's Windows validation notes
  (`docs/WINDOWS_VALIDATION.md`); check there for later Windows runs on other
  Claude Code versions. As of the first pass, no Quick Check step had been run
  on Linux or macOS. The rename exercises a typed `/` command on the current
  CLI. Claude Code's changelog says that since 2.1.290 the selected row of its
  `/` and `@` suggestion lists starts with a `❯` pointer, which the MCP also
  reads as a prompt-line marker (from the code). In the first pass the plain
  title left no list open in the returned capture, so that pass did not test
  the pointer; as of that pass, neither the pointer's effect on the MCP nor
  rename titles with `@` had been tested.
