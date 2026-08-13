# Rail Connector Operator Playbook

## Tool Set

- `status`
- `get_claude_capabilities`
- `list_claude_sessions`
- `get_claude_session`
- `start_remote_control`
- `capture_remote_control`
- `wait_for_claude_turn`
- `submit_prompt`
- `send_text`
- `send_key`
- `rename_claude_session`
- `archive_claude_session`
- `unarchive_claude_session`
- `stop_remote_control`

## Start Fresh

```json
{
  "cwd": "C:\\work\\project",
  "managedSession": "claude-feature-a",
  "remoteName": "Codex Remote",
  "sessionTitle": "Feature A",
  "permissionMode": "default",
  "effort": "medium",
  "killExisting": false,
  "trustWorkspace": false
}
```

`remoteName` labels Remote Control. `sessionTitle` names only a new Claude
conversation. The returned `resolvedSessionId` is the durable identity.

## Bypass Plus Ultracode

Use when the user explicitly requests both:

```json
{
  "cwd": "C:\\work\\project",
  "managedSession": "claude-feature-a-ultracode",
  "remoteName": "Codex Ultra",
  "sessionTitle": "Feature A implementation",
  "permissionMode": "bypassPermissions",
  "confirmBypassPermissions": true,
  "ultracode": true,
  "confirmUltracode": true,
  "killExisting": false,
  "trustWorkspace": false
}
```

First verify `get_claude_capabilities` reports:

- bypass policy `enabled: true`
- the installed permission mode
- `ultracode.launchMechanism`

If policy is disabled, configure it in the same OS context as Codex:

```powershell
.\install-windows.ps1 -BypassPolicy LocalHost
```

```bash
./install.sh --bypass-policy LocalHost
```

Confirm `codex mcp get rail-connector`, then open a fresh Codex task. Compare
`get_claude_capabilities` with `status.mcpProcess.pid` and `startedAt`; policy is
read when that MCP process starts. If a daemon-managed environment retains the
old transport, use `codex app-server daemon restart`. Do not restart WSL or
unrelated project services. Do not replace bypass with `default` and claim the
request was honored.

## Resume, Continue, And Fork

Exact UUID:

```json
{
  "sessionId": "00000000-0000-0000-0000-000000000000",
  "cwd": "C:\\work\\project",
  "managedSession": "claude-resume",
  "permissionMode": "default"
}
```

Exact unique title:

```json
{
  "resumeSessionName": "Feature A implementation",
  "cwd": "C:\\work\\project",
  "managedSession": "claude-resume",
  "permissionMode": "default"
}
```

Latest local conversation:

```json
{
  "continueLatest": true,
  "cwd": "C:\\work\\project",
  "managedSession": "claude-latest",
  "permissionMode": "default"
}
```

The MCP resolves latest to a UUID before launch. Add `forkSession: true` to any
resume selector to branch it. Do not combine selectors. Fork log binding
requires Remote Control URL corroboration; if binding is `pending`, do not
guess from a single concurrently created JSONL file.

## Find Conversations Privately

```json
{
  "cwd": "C:\\work\\project",
  "query": "Feature A",
  "includeSnippets": false,
  "includeRemoteUrls": false,
  "archiveState": "all",
  "scanLimit": 200
}
```

Search can use hidden title/transcript/URL fields without returning them.
Request snippets or URLs only when the content must be disclosed.

## Submit And Wait

```json
{
  "managedSession": "claude-feature-a",
  "text": "Implement the requested change, run focused tests, and return changed files, test results, and residual risks.",
  "pasteMode": "auto",
  "submitRetries": 1,
  "force": false
}
```

Then:

```json
{
  "managedSession": "claude-feature-a",
  "afterCursor": "<submit_prompt.waitAfterCursor>",
  "timeoutSeconds": 300
}
```

The returned value is always non-empty, including before the first assistant
reply. Treat it as opaque and pass it verbatim across MCP or Codex task
refreshes. Current portable cursors carry transcript baselines, submission
time, conversation UUID, and managed generation without prompt or answer text;
they reject stale cross-session use. `submitted` means acknowledgement was
observed. `completed` means a new terminal JSONL assistant record such as
`end_turn` was observed; `tool_use` is still in progress, and transcript
completion supersedes stale terminal prose.
For a large prompt, a pasted-text placeholder can become visible after the
first capture. `submit_prompt` polls a bounded visibility window before deciding
whether to send its Enter retry. If `paste_pending` still returns, inspect the
capture before sending a key.
Inspect `textLength` and `textTruncated` for unusually large answers. On
`needs_attention`, inspect the reason and capture before acting. A timeout can
be waited again. A `completed` result can include a separate `attention`
object for a weaker limit or paste warning; keep the completed transcript and
surface or resolve that warning independently.

Use `send_text` or `send_key` only for an inspected interactive state.
When either tool submits the composer, pass its non-empty `waitAfterCursor`
verbatim to `wait_for_claude_turn`. Check `submitted`; an Enter key used on a
menu intentionally does not create a remembered turn anchor.

## Reconnect After Windows Refresh

1. Call `status`.
2. Find the existing broker `managedSession`.
3. Call `capture_remote_control`.
4. Continue with `submit_prompt` or `wait_for_claude_turn`.

Do not call `start_remote_control` just because the Codex task is new. The
broker-owned Claude process may still be running.

Use `includeAgentDetails: true` only for intentional machine-wide diagnosis;
the default status is scoped to broker-managed sessions.

## Rename And Archive

Rename an attached idle conversation:

```json
{
  "managedSession": "claude-feature-a",
  "title": "Feature A complete"
}
```

Archive by UUID:

```json
{
  "sessionId": "00000000-0000-0000-0000-000000000000",
  "cwd": "C:\\work\\project"
}
```

Archive is local catalog state only. Use `unarchive_claude_session` with the
same arguments to restore it to active listings.

## Replace Or Stop

Replacement protects every non-idle state:

```json
{
  "cwd": "C:\\work\\project",
  "managedSession": "claude-feature-a",
  "sessionId": "<resolved-session-id>",
  "permissionMode": "default",
  "killExisting": true,
  "forceKillExisting": false
}
```

Stop:

```json
{
  "managedSession": "claude-feature-a",
  "graceful": true,
  "force": false
}
```

If stop is blocked, wait or inspect. `force: true` can discard in-flight work.
For an active token-derived session owned by an incompatible broker build,
`force: true` uses the restricted generation-bound compatibility cleanup path
and never reads terminal capture. Ordinary cross-version mutations stay
blocked.
