# Rail Connector Operator Playbook

## Tool Set

- `status`
- `get_claude_capabilities`
- `list_claude_sessions`
- `get_claude_session`
- `get_claude_result`
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

## Fable 5 Plus Bypass Plus Ultracode

Use this launch recipe only when the user explicitly requests bypass and
Ultracode with Fable 5:

```json
{
  "cwd": "C:\\work\\project",
  "managedSession": "claude-feature-a-fable5-ultracode",
  "remoteName": "Codex Fable 5 Ultra",
  "sessionTitle": "Feature A Fable 5 implementation",
  "permissionMode": "bypassPermissions",
  "confirmBypassPermissions": true,
  "model": "claude-fable-5",
  "ultracode": true,
  "confirmUltracode": true,
  "killExisting": false,
  "trustWorkspace": false
}
```

## Opus 5 Plus Bypass Plus Ultracode

Use this launch recipe only when the user explicitly requests bypass and
Ultracode with Opus 5:

```json
{
  "cwd": "C:\\work\\project",
  "managedSession": "claude-feature-a-opus5-ultracode",
  "remoteName": "Codex Opus 5 Ultra",
  "sessionTitle": "Feature A Opus 5 implementation",
  "permissionMode": "bypassPermissions",
  "confirmBypassPermissions": true,
  "model": "claude-opus-5",
  "ultracode": true,
  "confirmUltracode": true,
  "killExisting": false,
  "trustWorkspace": false
}
```

For either recipe, first verify `get_claude_capabilities` reports:

- bypass policy `enabled: true`
- the installed permission mode
- `ultracode.launchMechanism: "effort_flag"`
- `ultracode.launchArgument: "--effort=ultracode"`
- `ultracode.argumentProbe.accepted: true`, or documented support provenance
- `ultracode.environment.status: "compatible"`

The calibrated parser probe treats child exit status as authoritative. A zero
exit for `--effort=ultracode` plus a nonzero invalid control is accepted even if
Claude changes its error wording; timeout or signal termination is
inconclusive. Claude Code v2.1.203 is the documented floor for direct
`--effort=ultracode` startup.
`advertisedAsEffort: false` and `helpListsUltracode: false` report that help
omitted the literal value; they do not override supported version or calibrated
probe evidence.

After launch, inspect `posture.ultracodeAssessment`. `requested_unconfirmed`
means the request was accepted but runtime evidence has not arrived.
`attachment_lifecycle_active` means the latest complete bound attachment is an
UltraCode enter; `exited_after_entry` means a later exit made that client-side
mode inactive. Read `active`, `lastTransition`, and `historyCoverage`; a partial
or skipped range keeps history coverage partial. Current state remains unknown
until a later complete transition is observed; that transition can restore the
current state without pretending the skipped history became complete. These
transitions do not prove server-side workflow work.
Check `attentionStatus` next. `environment_blocked`,
`conflicting_effort_evidence`, and `terminal_rejection_conflict` take
precedence in the primary status while preserving the lifecycle evidence that
created the contradiction.
`xhigh_correlated_unconfirmed` is consistent with UltraCode but is not proof of
workflow orchestration. `workflow_activity_observed` reports sanitized Claude
workflow activity while leaving its trigger attribution `unknown`. A bound
effort other than `xhigh` or `ultracode`, such as `high` or `max`, produces
`conflicting_effort_evidence`. Remote Control web can show `Extra` for the
underlying xhigh setting while UltraCode is active. A session-bound web
`Extra` is compatible presentation, not confirmation, conflict, or workflow
evidence; context-free terminal text remains unmapped. On an idle, empty
composer, `/effort ultracode` can provide explicit current-setting evidence,
but it may change posture and cannot prove launch provenance. Use a substantive
turn when testing workflow activity.

Also inspect `launchEnvironment`, `currentMcpEnvironment`, and
`environmentComparison`. The launch field is the sanitized child snapshot.
After a Codex refresh, a different current MCP environment does not rewrite the
already-running session's launch provenance. Treat `launch_not_recorded` as an
older-session unknown rather than substituting the current process value.

`trustWorkspace: false` keeps trust as a separate, visible decision. If the
current capture returns `workspace_trust_required`, inspect it and respond only
with the user's authorization.

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

## Bounded Debug Capture

For an explicitly requested launch investigation, add:

```json
{
  "debug": true,
  "debugFilter": "api,!statsig"
}
```

The filter is optional. Verify capabilities advertise `--debug-file` and, when
filtering, `--debug`. Read the returned `debugLog.status`, `identityMatch`,
`launchBindingMatch`, and `sizeBytes`; contents are deliberately not returned.
The generated log and
receipt remain under the MCP state directory as sensitive local evidence until
the operator removes them. On Windows, `ready_acl_unverified` and
`windowsAclVerified: false` mean file identity and launch binding passed while
Node mode bits remain insufficient ACL proof. Debug capture can correlate local argv and
client events, but it cannot authenticate Anthropic's server-side effort.

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
completion supersedes stale terminal prose. It does not supersede
`workflowPending: true`; a pending dynamic workflow keeps the result in
`wait` until its lifecycle clears or the bounded timeout expires.
For a large prompt, a pasted-text placeholder can become visible after the
first capture. `submit_prompt` polls a bounded visibility window before deciding
whether to send its Enter retry. If `paste_pending` still returns, inspect the
capture before sending a key.
Inspect `textLength`, `textCharacters`, `textUtf8Bytes`, `textSha256`, and
`textTruncated` for unusually large answers. When truncated, call
`get_claude_result` with the same `cwd`, conversation UUID, and returned
opaque, record-scoped `resultId`; advance `offsetCharacters` through the
Unicode-safe chunks until `hasMore` is false, then confirm the separate
`textSha256` content digest. On
`needs_attention`, inspect the reason and capture before acting. A timeout can
be waited again. A `completed` result can include a separate `attention`
object for a weaker limit or paste warning; keep the completed transcript and
surface or resolve that warning independently.

Use `send_text` or `send_key` only for an inspected interactive state.
When either tool submits the composer, pass its non-empty `waitAfterCursor`
verbatim to `wait_for_claude_turn`. Check `submitted`; an Enter key used on a
menu intentionally does not create a remembered turn anchor. Text and
Enter/Return are blocked with reason `workflow_pending` while a dynamic
workflow remains active. `C-m`, `C-j`, `KPEnter`, and `NumpadEnter` are also
Enter-equivalent and use the same gate. Escape and cancellation keys remain
available. Native Windows returns `EINVAL` for an unsupported key name rather
than injecting its literal name into the composer. If an interruption leaves
stale pending evidence, inspect the
session before using the explicit `force: true` recovery on text, key, or
rename; report the returned `forceUsed` field. A forced `submit_prompt` also
returns `forcedPastReason`; preserve that reason in the operator report.
For rename, force is deliberately narrower: it may cross a verified
`workflow_pending` gate, but it must not cross approval, trust, draft, paste,
exit, or another non-idle `terminalState`. If both workflow and terminal
attention are present, resolve the terminal attention state first.

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

If stop is blocked, wait or inspect. If the reason is `awaiting_input`, preserve
the unsent draft: submit only with authorization, explicitly discard and
recapture only with authorization, or leave the session running. Never use
routine force cleanup to discard it. If the reason is `workflow_pending`, wait
for `workflowPending` to clear. `force: true` can discard in-flight work; report
`workflowInterrupted` or `replacementForceUsed` when returned.
For an active token-derived session owned by an incompatible broker build,
`force: true` uses the restricted generation-bound compatibility cleanup path
and never reads terminal capture. Ordinary cross-version mutations stay
blocked.
