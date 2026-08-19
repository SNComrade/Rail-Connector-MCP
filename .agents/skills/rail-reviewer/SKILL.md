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
  CLI advertises it, plus explicit no-edit constraints. `dontAsk` denies new
  permission requests while allowing read-only inspection. Use `plan` only as
  a compatibility fallback; never approve implementation from a report-only
  review. Report-only is verified by pre/post repository evidence; it is not an
  operating-system sandbox. Deny `Edit`, `Write`, and `NotebookEdit`, constrain
  shell use to inspection, and use a read-only copy when hard isolation matters.
- Leave `trustWorkspace` false unless the user explicitly authorizes trust after
  project configuration and hooks are inspected.
- Honor an explicit user request for Ultracode with `ultracode: true`,
  `confirmUltracode: true`, and no ordinary effort. Check capability provenance
  and calibrated probe exit status plus environment blockers before launch,
  treating probe timeout or termination as inconclusive, then report
  `posture.ultracodeAssessment` without promoting `xhigh` alone to confirmed
  Ultracode. Keep the persisted child `launchEnvironment` separate from
  `currentMcpEnvironment` when a review reconnects after an MCP refresh.
- Honor an explicit user request to test or use bypass only when capability
  inspection reports policy enabled and the call includes
  `confirmBypassPermissions: true`. Do not independently elevate and do not
  silently downgrade an explicit request.
- Prefer `submit_prompt` and `wait_for_claude_turn`. Use capture for attention
  states, not as the primary final-report parser.
- Keep waiting while `workflowPending` is true even if an assistant completion
  record is already present. Do not submit follow-up text, rename, replace, or
  ordinarily stop a session blocked with reason `workflow_pending`.
- Treat `workflowObservationUncertain: true` as fail-closed pending evidence.
  A skipped session-log middle invalidates head-only current posture and cannot
  prove workflow completion until an explicit observed checkpoint restores
  certainty.
- Read `terminalState` independently from the combined `state`; active workflow
  evidence may make the latter busy without proving that Claude's terminal is
  busy. When workflow pending clears, historical evidence should not remain in
  `workflowPendingEvidence`.
- A `tool_use` record is not a final report. Check `textTruncated` before
  synthesizing an unusually large review.
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
   use a unique review managed name.
3. **Start.** Use explicit `cwd`, `managedSession`, `remoteName`,
   `permissionMode`, `trustWorkspace`, and requested effort/Ultracode posture.
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
   activity, conflicts, and unknowns separately. Do not promise that Claude's
   footer will literally display `Ultracode`.
8. **Clean up.** Recheck repository/index state and verify the composer is empty,
   then gracefully stop the review session created by this workflow unless
   follow-up continuity is requested. Preserve an
   `awaiting_input` draft unless the user explicitly authorizes submission or
   discard.

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
