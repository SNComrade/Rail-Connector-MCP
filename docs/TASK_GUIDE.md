# Claude Task Guide

This guide covers effective Codex-to-Claude work through this interactive MCP.

## Start With Explicit Intent

Before launch, determine:

- the real task `cwd`
- whether this is review-only or implementation work
- whether to start, resume by UUID/title, continue latest, or fork
- requested permission, model, effort, and Ultracode posture
- a unique `managedSession` when other agents may be active

Call `get_claude_capabilities` before relying on version-sensitive controls.
The MCP resolves semantic requests against the installed Claude CLI and reports
requested, resolved, and observed posture separately.

## Review Workflow

Use `permissionMode: "dontAsk"` when the installed Claude CLI advertises it,
pass `disallowedTools: ["Edit", "Write", "NotebookEdit"]`, leave workspace
trust false unless explicitly authorized, and include a report-only prompt.
Record repository and index state before and after the review; prompt wording is
not an operating-system sandbox while shell inspection remains available.

This denies new permission requests while letting Claude return a direct report instead of ending at plan approval.
Use `plan` only as a compatibility fallback, and never approve implementation
from a report-only review.

```text
Report only. Do not edit files, commit, push, install packages, change
configuration, or write artifacts unless I provide an exact report path. Use
read-only inspection commands. Return Findings, Recommended changes, and
Residual risk with file and line evidence. Deliver the complete report directly
in this response. Do not enter or exit a plan workflow, write a plan file, or
ask for approval to continue.
```

Submit one focused question with `submit_prompt`, then pass its non-empty
`waitAfterCursor` verbatim to `wait_for_claude_turn`. Prefer the clean
transcript result over scraping the animated terminal. Use
`capture_remote_control` for trust, approval, limit,
interruption, or terminal-state diagnosis. Treat `tool_use` as in progress,
and check `textTruncated` before treating an unusually large answer as complete.
A completed turn can also carry an additive `attention` warning; preserve the
answer and handle that weaker warning separately.

The cursor is opaque but portable across a Codex task refresh. It binds the
prior user/assistant records, submission time, conversation UUID, and managed
generation without embedding prompt or response text. Never reconstruct or
reuse it with a different managed session.

## Implementation Workflow

For a development task where the operator has explicitly requested bypass:

```json
{
  "permissionMode": "bypassPermissions",
  "confirmBypassPermissions": true,
  "ultracode": true,
  "confirmUltracode": true,
  "trustWorkspace": false
}
```

The MCP process must already have the local-host or isolated bypass policy
acknowledgement. Bypass removes Claude approval prompts; inspect the working
tree and test results after Claude finishes.

Ultracode is requested through the dedicated boolean, not the ordinary
`effort` field or a prompt keyword. Current supported Claude builds use
`--effort=ultracode`. Do not combine it with `effort` or `safeMode`.

## Session Continuity

Prefer exact identity:

- resume with `sessionId` when known
- use `resumeSessionName` only for an exact unique title
- use `continueLatest` when newest-by-log-time is truly intended
- set `forkSession: true` to branch a resumed conversation

`continueLatest` resolves a UUID before launch. It does not pass Claude's
race-prone native `--continue`.
Fork binding additionally requires the new log's Remote Control URL to match
the managed terminal. A `pending` binding is safer than selecting a concurrent
new JSONL file by timing alone.

Use `sessionTitle` only when creating a new conversation. Use
`rename_claude_session` on an attached, idle conversation later. `remoteName`
labels Remote Control and is not a conversation title.

On Windows, the persistent broker keeps managed sessions alive across refreshed
Codex tasks. After refresh, call `status` and reconnect using the same
`managedSession`. On Linux/macOS, detached tmux provides persistence.

Archive and unarchive only change the MCP-local listing catalog; Claude's JSONL
transcript remains untouched.

## Multiple Codex Agents

Give independent tasks distinct `managedSession` names. Multiple agents may
read status or capture concurrently. Terminal mutations are serialized, but
serialization cannot decide whether two different prompts are logically
compatible.

For a shared managed session:

1. Inspect `status` and capture.
2. Wait until Claude is idle.
3. Submit one complete prompt.
4. Wait for that turn's new transcript cursor.
5. Rename, replace, or stop only while idle unless interruption is intentional.

## Avoid Hanging Interactive Commands

Avoid prompts that leave Claude inside a REPL or console:

```text
python
node
psql
sqlite3
```

Prefer bounded commands that exit:

```text
python -c "print('bounded task')"
node -e "console.log('bounded task')"
psql --no-psqlrc -c "SELECT 1"
python script_that_exits.py
```

If an interactive console is unavoidable, tell Claude exactly how and when to
exit it.

## Long Tasks

Give concrete completion criteria:

```text
When the requested implementation and validation are complete, return changed
files, tests run, failures, and residual risks. Stop exploring after that.
```

Use `wait_for_claude_turn` with a suitable timeout. A timeout does not mean the
turn failed; capture state and wait again. If it returns `needs_attention`,
handle the reported trust, approval, limit, interruption, paste, or exit state
before sending more text. If it returns `completed` with `attention`, retain the
completed transcript and surface or resolve the attached limit or paste warning.

## Changing Launch Posture

Permission, model, ordinary effort, and Ultracode are process launch controls.
To change them:

1. Wait for the current turn to finish.
2. Record the exact `resolvedSessionId`.
3. Stop the idle managed terminal gracefully.
4. Start it again with that `sessionId` and the new posture.
5. Verify resolved and observed posture.

`killExisting: true` automates replacement only for an idle session.
`forceKillExisting: true` may interrupt in-flight work and must be deliberate.

## Recovery

1. Call `status`.
2. Capture the managed session.
3. Use `Escape`, `C-c`, or an exit command only when the visible state justifies it.
4. If the terminal exited, resume the exact `resolvedSessionId`.
5. Force-stop only after accepting that unpersisted work may be lost.

For databases or other stateful systems, require backups and non-interactive
scripts before write operations. Bypass permission mode removes Claude prompts;
it does not remove the need for application-level validation.
