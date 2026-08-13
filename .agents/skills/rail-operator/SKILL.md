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
- Give parallel jobs unique `managedSession` names. A Windows broker session
  persists across MCP/Codex task refresh and must be explicitly stopped.
- Treat managed terminal name, Remote Control `remoteName`, conversation title,
  and conversation UUID as different identities.
- Prefer `submit_prompt` plus `wait_for_claude_turn`. Use terminal capture for
  attention states and low-level diagnosis, not as the clean answer channel.
- Claude spinner phrases are variable. Trust the returned structured state,
  completion ordering, and transcript cursor rather than matching a particular
  phrase.
- Treat `tool_use` as in progress. Check `textTruncated` before assuming a large
  report was returned in full.
- Never type over a busy or non-empty composer unless the user deliberately
  authorizes an inspected `force` action.

## Permission And Effort Intent

Use `permissionMode: "dontAsk"` for report-only work when the installed CLI
advertises it, pass `disallowedTools: ["Edit", "Write", "NotebookEdit"]`,
leave workspace trust false unless explicitly authorized, and verify repository
and index state before and after the turn. This denies new
permission requests without turning the review into a plan-approval workflow.
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
without prompts. An isolated policy value remains supported. Do not infer
bypass authorization from workspace trust or team size.

When the user explicitly asks for Ultracode:

1. Pass `ultracode: true`.
2. Pass `confirmUltracode: true`.
3. Omit ordinary `effort` and `safeMode`.
4. Inspect requested, resolved, and observed posture. Current supported Claude
   builds use direct `--effort=ultracode`.

Do not claim an unobserved posture is confirmed. Use each field's evidence
source; session-log evidence is stronger than terminal heuristics.

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
   signals, `waitAfterCursor`, transcript, and posture.
5. **Wait.** Call `wait_for_claude_turn` with the returned non-empty
   `waitAfterCursor` verbatim. Handle `needs_attention` before sending more
   work. A `completed` result may also carry an additive `attention` warning;
   report or resolve it without discarding the completed answer.
6. **Manage.** Rename only while idle. Archive/unarchive by UUID; those tools
   only change the MCP-local catalog, never Claude's transcript.
7. **Finish.** Gracefully stop only an idle session created by this workflow,
   unless the user explicitly asks to stop or retain another known session. Report the managed name and running state. Disclose a
   Remote Control URL only when requested or necessary.

Read [operator-playbook.md](references/operator-playbook.md) for exact call
recipes and recovery paths.
