---
name: rail-reviewer
description: "Run independent code, repository, implementation, performance, safety, or final-quality reviews through the Rail Connector MCP. Use when the user asks Codex to have Claude review work, inspect or find gaps, search prior Claude sessions for review continuity, provide a second opinion, or produce a report, including explicitly requested Ultracode or bypass capability validation."
---

# Rail Connector Reviewer

Use Claude as an independent reviewer, then verify its claims locally. Claude
output is evidence, not authority.

## Rules

- Use the target project's real same-OS `cwd`, not this skill repo unless this
  MCP itself is under review.
- If MCP tools are unavailable, report that a fresh Codex task or restart is
  needed. Never imply that Claude reviewed something when it did not.
- Ground branch, status, diff, relevant code, docs, and tests before prompting
  Claude.
- Default report-only reviews to `permissionMode: "dontAsk"` when the installed
  CLI advertises it, pass `disallowedTools: ["Edit", "Write",
  "NotebookEdit"]`, and include explicit no-edit constraints. `dontAsk` denies
  new permission requests while allowing read-only inspection. Use `plan` only
  as a compatibility fallback; never approve implementation from a report-only
  review. Report-only is verified by pre/post repository evidence; it is not an
  operating-system sandbox. Constrain shell use to inspection and use a
  read-only copy when hard isolation matters.
- `tools`, `allowedTools`, and `disallowedTools` constrain built-in Claude
  tools only. MCP and connector tools can remain available; the current MCP
  does not offer a verified strict MCP-config roster. Inspect the effective
  roster when possible and do not describe the built-in deny list as hard
  connector isolation.
- Leave `trustWorkspace` false unless the user explicitly authorizes trust
  after project configuration and hooks are inspected.
- Honor an explicit user request for Ultracode with `ultracode: true`,
  `confirmUltracode: true`, and no ordinary effort. Check capability provenance
  and calibrated probe exit status plus environment blockers before launch,
  treating probe timeout or termination as inconclusive, then report
  `posture.ultracodeAssessment` without promoting `xhigh` alone to confirmed
  Ultracode. Keep the persisted child `launchEnvironment` separate from
  `currentMcpEnvironment` when a review reconnects after an MCP refresh.
  `advertisedAsEffort: false` or `helpListsUltracode: false` means help text is
  silent, not that the launch is unavailable. Read
  `ultraEffortAttachment.active`, `lifecycle`, and `historyCoverage`: a latest
  enter is active, a later exit is inactive, and a skipped or partial range is
  unknown until a later complete transition restores current state. Historical
  coverage remains partial after recovery. These attachments authenticate
  client-side transitions, not workflow execution. Inspect `attentionStatus`;
  a blocking environment, conflicting effort, or terminal-rejection conflict
  takes precedence without erasing lifecycle evidence.
- Honor an explicit user request to test or use bypass only when capability
  inspection reports policy enabled and the call includes
  `confirmBypassPermissions: true`. Do not independently elevate and do not
  silently downgrade an explicit request.
- If a review uses native-Windows `submit_prompt` `pasteMode: "keyword"` (only
  on an explicit user request), keyword mode needs an empty composer even with
  `force: true`; a draft (or a suggestion that cannot be told apart from one)
  or a paste placeholder returns `preflight_blocked` (`active_input_not_empty`
  or `paste_pending`, `forceRefused: true` when force was requested) and
  nothing is sent. If `EPASTEMODE` leaves the generation recovery-only
  (`status` shows `recoveryOnly: true`), do not retry there: capture it, stop
  it with the `generationId` and `startedAtMs` from `status` as
  `expectedGenerationId` and `expectedStartedAtMs`, adding `force: true` only
  when that stop returns `stop_blocked` and the capture shows the cause (such
  as leftover keyword input or a partly submitted turn), then start a new
  review session.
- A keyword workflow review under `dontAsk` needs the Workflow tool allowed at
  launch. The allowance verified live is `tools: ["Workflow"]` plus
  `allowedTools: ["Workflow"]`, in a run whose workers used no tools. Note that
  `tools: ["Workflow"]` leaves Workflow as the session's only built-in tool, so
  a review that must read code has to list read tools such as `Read`, `Grep`
  and `Glob` in `tools` too (and keep them out of `disallowedTools`); that
  wider list, `allowedTools` alone, and what workers can do under it are not
  verified. Without the allowance Claude reports the Workflow call as denied
  and no workflow runs (seen live). This MCP sets tool lists only at launch, so
  a running review session without the allowance needs a replacement once it
  is idle. In `default` mode, Claude's documentation says Claude asks before
  the workflow runs (not verified through this MCP), and the MCP may not
  recognize that prompt as `approval_required` (not verified); capture before
  acting.
- Prefer `submit_prompt` and `wait_for_claude_turn`. Use capture for attention
  states, not as the primary final-report parser.
- Keep waiting while `workflowPending` is true even if an assistant completion
  record is already present. Identity-bound evidence releases only its own
  tracked launch: a direct terminal record with the matching run, a completed
  `TaskOutput` retrieval (older CLIs; 2.1.289 has no such tool), Claude's own
  task notification with a terminal status (`completed`, `failed`, `killed`, or
  an older word; `blocked` or any other status stays pending), or the
  per-conversation workflow snapshot (fresh managed native-Windows
  conversations only). A current bound interruption clears the tracked set.
  Worker results, an end turn, an idle composer, or a pending counter alone
  never release it. Do not submit follow-up text, rename, replace, or
  ordinarily stop a session blocked with reason `workflow_pending`. On CLI
  2.1.289 the `Waiting for N dynamic workflows to finish` row stays on screen
  after the workflow ends; a fully and certainly observed log that has seen
  the launch decides instead, but with `workflowObservationCoverage:
  "head_tail"`, or before the log has seen a launch, the row still holds
  pending work. If it stays pending after Claude shows the workflow finished,
  confirm that in Claude, check that `terminalState` is otherwise idle and the
  composer is empty, then, with authorization, repeat the blocked
  `submit_prompt`, `rename_claude_session`, or `stop_remote_control` call with
  `force: true` (a replacement uses `forceKillExisting: true`;
  `wait_for_claude_turn` takes no `force`) and report the returned
  `forceUsed`, `workflowInterrupted`, or `forcedPastReason` as a forced
  recovery.
- Treat `workflowObservationUncertain: true` as fail-closed pending evidence.
  A skipped session-log middle invalidates head-only current posture. A later
  explicit workflow counter or bound interruption can restore current-state
  certainty, but a counter alone never clears known pending workflows, and a
  `head_tail` observation cannot earn workflow-snapshot completion.
- Read `terminalState` independently from the combined `state`; active workflow
  evidence may make the latter busy without proving that Claude's terminal is
  busy. When workflow pending clears, historical evidence should not remain in
  `workflowPendingEvidence`.
- A `tool_use` record is not a final report. Check `textTruncated`,
  `textSha256`, and `textCharacters` before synthesizing an unusually large
  review. Use `get_claude_result` with the returned `resultId` until `hasMore`
  is false; treat `resultId` as an opaque record identity and verify the
  separate `textSha256` content digest instead of treating the preview as
  complete.
- Remote Control web may label the underlying xhigh setting `Extra` while
  UltraCode is active. A session-bound web `Extra` is compatible presentation,
  not confirmation or conflict. On an idle, empty composer,
  `/effort ultracode` is current-setting evidence but may change posture and
  does not prove launch provenance. Use a substantive turn, not a trivial
  prompt, when workflow activity is part of the review evidence.
- Verify Claude's file paths, line references, commands, factual claims, and
  severity against local evidence before synthesis.
- Default to one Claude reviewer with no delegated workflow. When parallel
  review is explicitly authorized, copy any user-supplied bounds into the
  prompt. Without supplied bounds, allow at most 3 workflow agents, one pass,
  no recursive delegation, 5 findings, 10 minutes, and 200k aggregate tokens;
  stop and synthesize when any bound is reached.

## Workflow

1. **Ground locally.** Record exact review scope, Git state, implementation
   diff, and available test evidence.
2. **Inspect capability.** Call `status` and `get_claude_capabilities`. Reconnect
   to a relevant broker session only when continuity is intentional; otherwise
   use a unique review managed name. A reconnected (`already_running`) session
   keeps the environment it was launched with, so an older launch can still show
   prompt suggestions, which block prompts (`active_input_not_empty`) and
   graceful stop (`awaiting_input`). To be sure suggestions are off, replace it;
   `killExisting` is refused while composer text shows, and `forceKillExisting`
   also discards a real draft.
3. **Start.** Use explicit `cwd`, `managedSession`, `remoteName`,
   `permissionMode`, `trustWorkspace`, and requested effort/Ultracode posture.
   Leave `promptSuggestions` unset so the launched Claude gets suggestions off.
   Suggestions can still appear if a Claude settings `env` entry overrides the
   value or the CLI is older than 2.1.238. Report the returned
   `claudeCliVersion`; Claude Code can update itself between two starts, so it
   can differ from an earlier start. Report it and carry on unless a tool
   reports a problem. On native Windows, keep the generation pair from
   `sessionBinding` (from `existingSession` on `already_running`, or from the
   session's `status` entry when reconnecting) and pass its `generationId` and
   `startedAtMs` as `expectedGenerationId` and `expectedStartedAtMs`, always
   together, to `capture_remote_control`, `submit_prompt`,
   `wait_for_claude_turn` (with that generation's `waitAfterCursor`),
   `rename_claude_session` and `stop_remote_control`, so the review never acts
   on a replacement session. A stale-generation error (code `ESTALE`, which
   callers do not see; the text says the generation changed, refuses a stale
   operation, or rejects the `afterCursor`) means that call reached no other
   generation (only if Claude exited mid-call and the name was restarted can
   the review prompt have reached the old session); call `status` and do not
   repeat the call by name. Leave the pair out on Linux and macOS.
4. **Prompt.** Read [review-prompt.md](references/review-prompt.md). State
   report-only constraints, exact files/diff/objective, evidence requirements,
   and output structure.
5. **Wait.** Pass the non-empty `submit_prompt.waitAfterCursor` verbatim to
   `wait_for_claude_turn`.
   Handle trust, approval, limit, interruption, paste, or exit states before
   sending more text. A `completed` result can also include an additive
   `attention` warning; preserve it in the review synthesis.
6. **Verify.** Reproduce or inspect every actionable finding. Separate verified
   findings from useful but unverified observations.
7. **Synthesize.** Lead with verified issues ordered by severity, then testing
   gaps and residual risk. State launch acceptance, runtime effort, workflow
   activity, conflicts, and unknowns separately. If `workflowPending` did not
   clear and a call was repeated with `force: true` after confirming in Claude
   that the workflow finished, say so and report the returned `forceUsed`,
   `forcedPastReason`, or `workflowInterrupted` fields; a forced call is not
   MCP-observed completion. Do not promise that Claude's footer will literally
   display `Ultracode`.
8. **Clean up.** Recheck repository/index state, verify the composer is empty,
   then gracefully stop only the review session created by this workflow
   unless follow-up continuity is requested. Preserve an
   `awaiting_input` draft unless the user explicitly authorizes submission or
   discard. When suggestions are on anyway (a `promptSuggestions: true` launch,
   a Claude settings `env` override or wrapper, Claude before 2.1.238, or a
   session launched before that default), suggestion text cannot be told from
   a real draft and still blocks prompts (`active_input_not_empty`) and
   graceful stop (`awaiting_input`). If a forced stop returns
   `status: "stop_timeout"` (native Windows; Claude did not confirm exit), the
   session is recovery-only. Only in that case, retry `stop_remote_control`
   once with the reply's `expectedGenerationId` and `expectedStartedAtMs`
   exactly as given and `force: true`, never by name; without `force` the
   retry does not repeat the termination. A forced stop discards any draft,
   in-flight turn, pending approval and running workflow. If the retry times
   out again, stop retrying and report it.

For a report-only prompt, include:

```text
Report only. Do not edit files, commit, push, install packages, change
configuration, or write artifacts unless I provide an exact report path. Use
read-only inspection commands. Return findings ordered by severity with
file/line evidence, recommended changes, tests, and residual risk. Deliver the
complete report directly in this response. Do not enter or exit a plan
workflow, write a plan file, or ask for approval to proceed.
Do not delegate or launch a dynamic workflow unless this prompt explicitly
authorizes it. Obey the stated agent, pass, finding, time, and token bounds and
stop to synthesize when any bound is reached.
```
