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

Managed launches, including resume, continue, fork, and `killExisting`
replacement, get `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` on both backends.
A generated suggestion in the composer looks like an unsent draft and blocks
prompts (`active_input_not_empty`) and graceful stop (`awaiting_input`). Add
`promptSuggestions: true` only when the user wants suggestions; the launched
Claude then gets `true`, and suggestion text can again cause those blocks. A
Claude settings `env` entry or a wrapper can override either value, and Claude
Code before 2.1.238 ignores the variable. The setting is not recorded or
compared, so an `already_running` session keeps the environment it was launched
with; to be sure, replace the session. If the composer shows text,
`killExisting` alone is refused; inspect the capture first, because
`forceKillExisting` also discards a real unsent draft.

Report the returned `claudeCliVersion`. Claude Code can update itself between
two starts, so a later start can report a newer version than an earlier one
(a live check saw 2.1.289 and then 2.1.294 ten minutes apart). Report it and
carry on unless a tool reports a problem.

For a `dontAsk` session that will receive a workflow keyword, allow the
Workflow tool at launch. This combination reproduces the live-tested posture,
which has no file, shell, network or connector tools:

```json
{
  "cwd": "C:\\work\\project",
  "managedSession": "claude-workflow-a",
  "remoteName": "Codex Remote",
  "permissionMode": "dontAsk",
  "tools": ["Workflow"],
  "allowedTools": ["Workflow"],
  "disallowedTools": ["Read", "Write", "Edit", "NotebookEdit", "Bash", "PowerShell", "Agent", "Task", "WebFetch", "WebSearch", "mcp__*"],
  "killExisting": false,
  "trustWorkspace": false
}
```

`tools` limits the session's built-in tools to the ones listed. To give the
session another built-in tool, add it to `tools` and remove it from
`disallowedTools`; for report-only work, start from the report-only deny list
(`Edit`, `Write`, `NotebookEdit`) instead. That wider list, `allowedTools`
alone, and tools used by workflow workers are not verified. Without the
allowance, Claude reports the Workflow call as denied and no workflow runs
(seen live). This MCP sets tool lists and permission mode only at launch, so a
running session without the allowance needs a replacement once it is idle,
for a workflow the user asked for. In `default` mode, Claude's documentation
says Claude asks before a workflow runs (not verified through this MCP), and
the MCP may not recognize that prompt as `approval_required`, so the wait can
time out instead (not verified). Capture the session and answer only with the
user's authorization.

## Fable 5.1 Plus Bypass Plus Ultracode

Use this launch recipe only when the user explicitly requests bypass and
Ultracode with Fable 5.1:

```json
{
  "cwd": "C:\\work\\project",
  "managedSession": "claude-feature-a-fable51-ultracode",
  "remoteName": "Codex Fable 5.1 Ultra",
  "sessionTitle": "Feature A Fable 5.1 implementation",
  "permissionMode": "bypassPermissions",
  "confirmBypassPermissions": true,
  "model": "claude-fable-5-1",
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

For an existing installation, first follow the [Windows upgrade order](../../../../docs/WINDOWS.md#upgrade),
including authorized session stops and old-broker shutdown through the old client.
Then close MCP clients using the checkout and use a separate PowerShell window.
`-ClientsClosed` acknowledges that preparation; it performs none of those steps.

```powershell
.\install-windows.ps1 -BypassPolicy LocalHost -ClientsClosed
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
For an explicitly requested workflow keyword on native Windows, use
`submit_prompt` with `pasteMode: "keyword"` and an unchanged leading
`ultracode:` prefix. Only that prefix is literal; the multiline body remains
bracketed. Do not infer this intent from quoted/tool/scheduled material, change
launch effort or permissions, or use full literal mode for multiline input.
The keyword transport itself never changes permissions. Under `dontAsk`, the
session must already have been launched with the Workflow tool allowed (see
Start Fresh); otherwise Claude denies the workflow. Adding the allowance means
a new launch for a workflow the user explicitly requested, and replacing a
running session needs it idle and the user's agreement.
Keyword mode requires an empty composer even with `force: true`. A draft or
unresolved paste placeholder returns `preflight_blocked` with reason
`active_input_not_empty` or `paste_pending`, `forceUsed: false`, and
`forceRefused: true` when force was requested; it sends no text or Enter, even
when pending workflow evidence would otherwise mask the composer state. Keyword
mode does not clear drafts or dismiss suggestions.
Verify full prompt acknowledgement, keyword recognition, actual workflow launch,
and identity-bound completion separately. On Claude 2.1.289, do not ask Claude
to call `TaskOutput`: that CLI has no such tool, and the call fails with "No
such tool available". The MCP releases only the tracked workflow, from Claude's
own task notification with a terminal status, a direct terminal record with the
matching run ID, an older CLI's matching completed `TaskOutput` retrieval, or a
fresh native-Windows conversation's workflow snapshot. Worker results,
end_turn, or a pending count alone cannot release it. If release fails, use the
authorized force recovery described below for the stale waiting row. See Submit
And Wait in docs/USAGE.md for the version-specific evidence.
If a keyword `submit_prompt` returns an error instead of a receipt, call
`status` before any retry. If the session shows `recoveryOnly: true`, part or
all of the prompt (the prefix, some or all of the body, possibly the closing
paste frame, never the final Enter) may have reached Claude, and a line break
may have submitted part of it; if the session was already recovery-only before
this call, nothing was sent. Do not retry in that session. Inspect it with
`capture_remote_control`. Then stop it with `stop_remote_control`, passing its
`generationId` and `startedAtMs` from `status` as `expectedGenerationId` and
`expectedStartedAtMs` with `force: true`, and start a new session. Otherwise,
read the error text and a capture before retrying.
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
In Claude 2.1.289, the `Waiting for N dynamic workflow(s) to finish` row stays
on screen after the workflow ends. A complete, certain session log that has
recorded the workflow launch overrides that stale row. Without such a log, the
row still holds pending work. One example is `head_tail` coverage: after an MCP
restart, or when a conversation is resumed, the MCP first reads a log that is
already over 2.25 MiB. In that case, confirm in Claude that the workflow
finished; then, with authorization and only when `terminalState` is otherwise
idle and the composer is empty, repeat the blocked `submit_prompt`,
`send_text`, `send_key`, `rename_claude_session`, or `stop_remote_control` call
with `force: true`. A replacement uses `forceKillExisting: true`;
`wait_for_claude_turn` takes no `force`.
For rename, force is deliberately narrower: it may cross a verified
`workflow_pending` gate, but it must not cross approval, trust, draft, paste,
exit, or another non-idle `terminalState`. If both workflow and terminal
attention are present, resolve the terminal attention state first.

## Reconnect After Windows Refresh

1. Call `status`.
2. Find the existing broker `managedSession` and note its `generationId` and
   `startedAtMs`.
3. Call `capture_remote_control` with that pair as `expectedGenerationId` and
   `expectedStartedAtMs`.
4. Continue with `submit_prompt` or `wait_for_claude_turn`, passing the same
   pair. A paired wait needs the `waitAfterCursor` returned for that
   generation; if the new task does not have it, wait by name. A paired
   `submit_prompt` also needs a resolved conversation UUID for the session.

If a paired call fails with a stale-generation error (code `ESTALE`; the text
says the generation changed, refuses a stale operation, or rejects the
`afterCursor`), either the name now belongs to another generation or none, or
the cursor or conversation does not match the pair. A paired `submit_prompt`
on a session with no resolved conversation UUID fails the same way, with the
text "A generation-bound submission requires a resolved Claude session
identity." Such a call reached no other generation, and one refused at its
start did nothing at all. Only if Claude exited during the call and another
start took the name can input sent earlier in that call have reached the old
session (from the code; not seen live). Call `status` again before anything
else; do not repeat the call by name. Callers see only the error text, not the
code. The pair works on native Windows only; tmux rejects it.

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

Composer text blocks `killExisting` alone, and that includes a prompt
suggestion Claude generated, because the MCP cannot tell it from a real draft.
Inspect the capture first: `forceKillExisting` also discards a real unsent
draft. Replacing a session is also the only way to be sure it has the requested
prompt-suggestion setting.

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
recapture only with authorization, or leave the session running. When prompt
suggestions are on, untyped suggestion text reports the same reason, and the
MCP cannot reliably tell it from a real draft, so treat it as one. Never use
routine force cleanup to discard it. If the reason is `workflow_pending`, wait
for `workflowPending` to clear. If it stays pending after Claude shows the
workflow has finished, confirm that in Claude, then repeat the stop with
`force: true`. `force: true` can discard in-flight work; report
`workflowInterrupted` or `replacementForceUsed` when returned.
For an active token-derived session owned by an incompatible broker build,
`force: true` uses the restricted generation-bound compatibility cleanup path
and never reads terminal capture. Ordinary cross-version mutations stay
blocked.

On native Windows a forced stop (or a `forceKillExisting` replacement) can end
in `stop_timeout`: Claude did not confirm exit within about 5.5 seconds. For a
stop this is a normal result, not an error. The session is now recovery-only
(`recoveryOnly: true` in `status`): prompts, text, keys and rename are
refused, with or without the pair, and so are a stop or replacement by name,
while `status`, `capture_remote_control` and `wait_for_claude_turn` still
work. Only in that case, retry the stop once:
the same `managedSession`, `expectedGenerationId` and `expectedStartedAtMs`
exactly as the `stop_timeout` reply returned them, and `force: true`. A failed
replacement returns only an error, so take the pair from the session's `status`
entry instead. Never stop a recovery-only session by name, and do not leave out
`force`: a paired stop without it does not repeat the termination. With an
idle-looking capture the forced stop still tries `/exit` first.

A forced stop discards what the session still holds: an unsent draft, an
in-flight turn, a pending approval and any running workflow, reported as
`forceUsed` and `workflowInterrupted`. Output Claude had not yet written to
its session log may be lost (not verified); the stop itself does not delete the
conversation log. `stopped` shows only that the direct Claude process exited.
A retry can also return `not_running` if Claude exited meanwhile. If it returns
`stop_timeout` again, do not loop: report it, because the process must end
outside the MCP, and the broker cannot be upgraded while it tracks the
session. If the session's workspace folder was removed or retargeted, the
paired stop fails closed as well. A retry that ends in `stopped` has been shown
only with a test process, not with a real Claude session.

## Quick Check

Exact calls for the operator skill's Quick Check. Every call uses
`"managedSession": "quick-check"`. Create the folder yourself first, as a new
empty folder under the temp directory; no MCP tool creates or removes folders,
and a missing folder fails the start.

1. **Orient.** Call `status`, then `get_claude_capabilities`. Report `command`
   (the Claude program path, symlinks resolved) and `version`. Start refuses
   unless `advertised.permissionModes` lists `dontAsk` and
   `advertised.effortLevels` lists `xhigh`. A managed session already exists
   when `managedSessions` is not empty (entries with `exited: true` count) or,
   on Windows, when `cleanupEligibleSessions` is not empty or
   `inaccessibleManagedSessionCount` is above 0. A non-null `broker.probeError`
   means `status` could not tell. In either case, stop the check there and
   report: do not capture, prompt or stop any listed session, and report steps
   2 to 10 as NOT RUN. If the only entry is `quick-check` with `exited: true`,
   an earlier check left it; say in the report that a graceful
   `stop_remote_control` on `quick-check` without force removes it, unless
   `status` shows `recoveryOnly: true`.
2. **Start.**

   ```json
   {
     "cwd": "<the new empty temp folder>",
     "managedSession": "quick-check",
     "remoteName": "Codex Quick Check",
     "model": "claude-fable-5-1",
     "effort": "xhigh",
     "permissionMode": "dontAsk",
     "tools": ["Workflow"],
     "allowedTools": ["Workflow"],
     "disallowedTools": ["Read", "Write", "Edit", "NotebookEdit", "Bash", "PowerShell", "Agent", "Task", "WebFetch", "WebSearch", "mcp__*"],
     "killExisting": false,
     "trustWorkspace": true
   }
   ```

   Leave out `ultracode`, `confirmUltracode`, `confirmBypassPermissions` and
   `promptSuggestions`. PASS: `status: "started"` and
   `needsWorkspaceTrust: false`. `needs_workspace_trust` means the trust prompt
   was not answered; treat it as an unexpected dialog. `already_running` means
   a `quick-check` session this check did not start appeared after step 1:
   that is a FAIL. Do not capture, prompt, rename or stop that session; report
   what start returned, without `capture` or `remoteUrl`, and report steps 3 to
   10 as NOT RUN. `exited_during_startup` is a FAIL: Claude ended during start.
   Report `exitCode` and the returned `note`, but not `capture`, do not start
   again, report steps 3 to 7 as NOT RUN, and go on to step 8.
   `trustWorkspace: true` answers Claude's trust prompt only if it shows during
   start; Claude most
   likely remembers that trust for the folder's path afterwards (not
   verified). Report `claudeCliVersion` and the model and permission mode
   under `posture.requested`, `posture.resolved` and `posture.observed`, each
   observed value with its source in `posture.observed.evidence`:
   `claude_session_log` is session-log evidence, `terminal_heuristic` was read
   from the screen and counts as INFERENCE, and an empty source means not
   observed. The observed model appears only after Claude's first answer, so
   report the observed values and their sources again after step 4. Do not
   quote `remoteUrl` or `capture`.
3. **Empty prompt box.** Call `capture_remote_control`. PASS:
   `signals.terminalState` is `idle`, `signals.activeInputHasText` and
   `signals.pastePlaceholder` are false, and no suggested text shows.
4. **READY.** Call `submit_prompt` with this text, `"pasteMode": "auto"` and
   `"force": false`:

   ```text
   Reply with the single word READY.
   ```

   PASS: `status: "submitted"`, `transcriptAcknowledged: true` and
   `forceUsed: false`. Then call `wait_for_claude_turn` with the returned
   `waitAfterCursor` and `"timeoutSeconds": 45`, and repeat it with the same
   cursor while it returns `status: "timeout"`, up to 180 seconds in total.
   Keep each wait short: the MCP client can end a longer tool call on its own
   time limit and return an error while Claude is still working (Codex has a
   per-tool timeout; its value on this PC is not verified). PASS:
   `status: "completed"` and `transcript.lastAssistant.text` is exactly
   `READY`. Still `timeout` after 180 seconds is a FAIL with a busy session:
   stop the check there and report.
5. **Rename.** Call `rename_claude_session` with
   `"title": "Quick check renamed"`. PASS: `status: "renamed"`, `observedTitle`
   equals the title, `titleSource: "custom-title"`, and the returned
   `signals.terminalState` is `idle`. The MCP types `/rename <title>` without
   bracketed paste, presses Enter 100 ms later and decides the result only
   from the title in Claude's session log. `rename_unverified` is a FAIL:
   report `observedTitle` and the returned signals. If they show text left in
   the prompt box or a `terminalState` other than `idle`, the session is not
   idle: stop the check and report, and send no key to clear it. If they show
   `idle` and no text, still look at the returned capture without quoting it,
   because the signals do not recognize every list or dialog. If `/rename`
   text is still in the prompt box, or a suggestion list, menu or dialog is
   open, treat it as an unexpected dialog: stop the check and report, send no
   key, and do not call `stop_remote_control` (its graceful stop types `/exit`
   and Enter into whatever is open); report steps 6 to 10 as NOT RUN.
   Otherwise go on to step 6. `rename_blocked` is a refused call.
6. **Keyword workflow.** Call `submit_prompt` with this text,
   `"pasteMode": "keyword"` and `"force": false`:

   ```text
   ultracode: Run exactly one dynamic workflow with two workers. Each worker replies with the single word OK and uses no files, shell, network or connector. When the workflow has finished, answer with the single line WORKFLOW_DONE.
   ```

   PASS: `status: "submitted"`, `pasteMode: "keyword"`,
   `literalPrefixCharacters: 10`, `bracketedPasteUsed: true`,
   `transcriptAcknowledged: true` and `forceUsed: false`. This needs native
   Windows. On Linux and macOS do not make this call: keyword mode refuses it
   there with "Keyword prefix delivery currently requires native Windows."
   before sending anything (from the code; not seen live). Report steps 6 and
   7 as NOT RUN and go on to step 8. Do not send the prompt in another paste
   mode either, which would be a different check. On Windows, if the call
   returns an error, call `status`. A `recoveryOnly: true` session is a FAIL:
   report it, leave it running, and report steps 7 to 10 as NOT RUN. Submit
   And Wait explains how much of the prompt may have reached Claude; its
   forced stop and new session are outside the quick check's limits, so leave
   that decision to the user. Any other error is a FAIL too; do not send the
   prompt again. Call `capture_remote_control`, because a `status` entry has no
   `terminalState`. If `signals.terminalState` is `idle` and
   `signals.activeInputHasText`, `signals.pastePlaceholder` and
   `signals.workflowPending` are all false, report step 7 as NOT RUN and go on
   to step 8. Otherwise leave the session running and report steps 7 to 10 as
   NOT RUN.
7. **Wait.** Call `wait_for_claude_turn` with the keyword `waitAfterCursor` and
   `"timeoutSeconds": 45`. While it returns `status: "timeout"`, call it again
   with the same cursor, which stays valid after a `timeout`, until 8 minutes
   have passed in total. Short waits are meant to keep each call inside the
   client's own per-tool time limit, whose value on this PC is not verified
   (see step 4).
   PASS: `status: "completed"` and the final answer `WORKFLOW_DONE`, with:
   - `signals.workflowPending: false`;
   - `signals.workflowObservationCoverage: "full"`;
   - `signals.workflowObservationUncertain: false`;
   - `posture.ultracodeAssessment.workflowActivity.launchObserved: true`;
   - `posture.ultracodeAssessment.ultraEffortAttachment.workflowKeywordRequestCount: 1`.

   Report `workflowActivity.completionEvidence`. `claude_workflow_snapshot`
   means the fresh-session snapshot released the workflow; empty means other
   evidence did, such as Claude's task notification. A stale
   `Waiting for 1 dynamic workflow` row on screen is not a FAIL. Report
   `ultracodeAssessment.status`, which is not a PASS condition. It read
   `not_requested` in the first full pass (2026-10-08; see
   `docs/WINDOWS_VALIDATION.md`), because UltraCode is not requested here.
   `attachment_lifecycle_active`, if Claude ever logs an UltraCode transition
   for the keyword, is not a FAIL either. If Claude says the
   Workflow tool was denied or is not available, that is a FAIL: report its
   words, do not retry, and go on to step 8. If the workflow is still pending
   after 8 minutes, force nothing: leave the session running, report what
   `status` shows, and report steps 8 to 10 as NOT RUN.
8. **Stop.** Call `stop_remote_control` with `"graceful": true` and
   `"force": false`. PASS: `status: "stopped"`, `forceUsed: false` and
   `workflowInterrupted: false`. If Claude had already exited, the stop
   returns `status: "not_running"` with `exitCode` and removes the entry;
   report that as PASS. On `stop_blocked`, `graceful_stop_timeout` or a
   recovery-only refusal, report and leave the session as it is.
9. **Final status.** PASS: `managedSessions` is empty and, on Windows,
   `cleanupEligibleSessions` is empty and `inaccessibleManagedSessionCount` is
   0. A broker that keeps running with no sessions is normal.
10. **Folder.** Only after step 9 passes, remove the folder if it is empty,
    without recursive or forced removal, and report its path either way.
    Claude's conversation log and workflow records live under its own config
    folder and stay there.
