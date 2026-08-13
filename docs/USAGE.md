# Usage

Use a project path for `cwd` that belongs to the same OS context as Codex,
this MCP, and Claude Code. On Windows, a persistent per-user broker owns managed
Claude terminals so a refreshed Codex task can reconnect. Linux and macOS use
detached tmux sessions.

## Recommended Workflow

1. Call `get_claude_capabilities`.
2. Use `list_claude_sessions` if resuming existing work.
3. Call `start_remote_control` with a unique `managedSession`.
4. Use `submit_prompt` for complete prompts.
5. Call `wait_for_claude_turn` for transcript-backed completion.
6. Use `capture_remote_control` when terminal state needs inspection.
7. Stop the managed session when finished.

Mutation operations are serialized per managed session. On Windows, the broker
also leases mutations across independent MCP clients so concurrent Codex agents
cannot interleave prompt text, keys, rename commands, or stop requests.

## Inspect Capabilities

`get_claude_capabilities` runs bounded `claude --version`, `claude --help`, and
related probes without starting an interactive session. Call it before using
permission or effort controls because Claude CLI help and accepted values can
change between releases.

The MCP treats `permissionMode: "default"` as a semantic request. At launch it
resolves that request to the installed CLI's advertised `default` or `manual`
alias. Explicit elevated modes must be advertised by the installed CLI; they
are never silently downgraded.

For current Claude builds that support it, `ultracode: true` resolves to
`--effort=ultracode`. The older generic settings request remains only as a
capability-reported compatibility fallback. Capability inspection reports the
chosen mechanism; launch and capture responses report requested, resolved, and
observed posture separately.

## List And Inspect Conversations

```json
{
  "cwd": "C:\\work\\project",
  "limit": 20,
  "query": "authentication review",
  "includeSnippets": false,
  "includeRemoteUrls": false,
  "scanLimit": 200,
  "archiveState": "active"
}
```

`archiveState` is `active`, `archived`, or `all`. The default listing is
metadata-only. Search may match a local title, transcript, URL, session ID, or
observed posture even when sensitive values are omitted from the response.
Set `includeSnippets` or `includeRemoteUrls` only when the returned content is
needed. Search and archive-filter scans are bounded by `scanLimit` and report
separately when results may be incomplete.

Inspect one conversation:

```json
{
  "sessionId": "00000000-0000-0000-0000-000000000000",
  "cwd": "C:\\work\\project",
  "maxMessages": 12
}
```

## Start, Resume, Continue, Or Fork

Start a new conversation:

```json
{
  "cwd": "C:\\work\\project",
  "managedSession": "claude-feature-review",
  "remoteName": "Codex Remote",
  "sessionTitle": "Feature review",
  "permissionMode": "default",
  "trustWorkspace": false
}
```

`remoteName` labels Remote Control. `sessionTitle` names a new Claude
conversation. They are intentionally independent. With `trustWorkspace: false`,
a new project remains at Claude's trust prompt until the operator inspects the
project configuration and explicitly chooses whether to trust it.

Resume selectors are mutually exclusive:

- `sessionId` resumes an exact UUID.
- `resumeSessionName` resolves an exact, unique local title to a UUID.
- `continueLatest: true` resolves the newest local log to an exact UUID before
  launching, avoiding a race-prone native `--continue`.

Set `forkSession: true` with a resume selector to create a new conversation
branch. Fresh starts receive a generated UUID by default so the MCP can bind
the resulting log deterministically. A fork has no caller-selected new UUID,
so its log is bound only when the new file's Remote Control URL corroborates
the managed terminal URL. Without that signal, binding stays `pending` instead
of guessing that a concurrent new log belongs to this process.

Use `killExisting: true` to replace an idle managed terminal. Every non-idle
state, including trust, approval, interruption, pasted input, and a non-empty
composer, is protected unless `forceKillExisting: true` is also explicitly
passed. Forced replacement never types `/exit` into a non-idle composer.

## Permission Modes

For report-only review work, prefer `permissionMode: "dontAsk"` when the
installed CLI advertises it, pass `disallowedTools: ["Edit", "Write",
"NotebookEdit"]`, and use a prompt that forbids edits and state-changing
commands. Verify repository and index state before and after the turn; shell
inspection means report-only is not an operating-system sandbox. This denies new permission requests while allowing a
direct final report. Use `plan` only as a compatibility fallback, and never
approve implementation from a report-only session.

For an explicitly authorized development host:

```json
{
  "cwd": "C:\\work\\project",
  "managedSession": "claude-build",
  "permissionMode": "bypassPermissions",
  "confirmBypassPermissions": true,
  "trustWorkspace": false
}
```

The MCP process must separately opt in with one of these exact policy values:

```text
RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS=I_UNDERSTAND_BYPASS_CAN_MODIFY_MY_HOST_WITHOUT_PROMPTS
RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS=I_UNDERSTAND_THIS_REQUIRES_ISOLATION
```

The first value explicitly authorizes a local development host. The second is
for a disposable isolated environment. The per-call confirmation is still
required in either case. Bypass mode removes Claude's normal permission prompts
and can modify the host, repository, credentials, services, and external state
available to Claude. The MCP exposes this capability when the operator opts in;
it does not infer authorization from team size or folder trust.

Install the MCP with local-host opt-in in the same OS context as Codex.
Linux/macOS:

```bash
./install.sh --bypass-policy LocalHost
```

Windows:

```powershell
.\install-windows.ps1 -BypassPolicy LocalHost
```

Use `Disabled` to remove the opt-in or `Isolated` for the legacy isolation
acknowledgement. Both installers read back the registration. The policy is
inherited at MCP process startup, so open a fresh Codex task after changing it.
If a daemon-managed Codex environment keeps the old MCP transport, use a
targeted `codex app-server daemon restart`, not a restart of WSL or unrelated
project services.

## Ultracode And Effort

Request ordinary effort with `effort: "low"`, `"medium"`, `"high"`,
`"xhigh"`, or `"max"` when the installed CLI advertises it.

Request Ultracode separately:

```json
{
  "cwd": "C:\\work\\project",
  "managedSession": "claude-ultracode",
  "permissionMode": "bypassPermissions",
  "confirmBypassPermissions": true,
  "ultracode": true,
  "confirmUltracode": true,
  "trustWorkspace": false
}
```

Do not combine `ultracode` with `effort` or `safeMode`. Ultracode implies xhigh
effort plus dynamic workflow orchestration. `confirmUltracode` acknowledges the
additional compute and behavior; it is not a safety restriction.

Start and capture responses contain a `posture` object:

- `requested` records the caller's semantic request.
- `resolved` records the exact CLI values and launch mechanism.
- `observed` records session-log or terminal evidence.
- `evidence` identifies the source for each observed field.

Treat missing observation as unknown, not as a failed request. Session-log
evidence is stronger than terminal heuristics, but neither is a privileged
Anthropic state API. Current Claude logs record direct Ultracode turns as
`effort: "xhigh"`; when that is correlated with the resolved
`--effort=ultracode` launch, the field is labeled
`claude_session_log_correlated_with_resolved_launch`.

## Submit And Wait

Use `submit_prompt` for complete, multiline prompts:

```json
{
  "managedSession": "claude-feature-review",
  "text": "Review the current implementation. Return Findings, Fixes, and Residual risk.",
  "pasteMode": "auto",
  "submitRetries": 1,
  "force": false
}
```

The tool uses Unicode-safe chunks, bracketed paste only when the terminal
reports that mode enabled, a short Windows paste-settle delay, JSONL prompt
acknowledgement, and bounded Enter retries. After the first Enter it also polls
a short visibility window so a delayed pasted-text placeholder can appear
before it decides whether a retry is needed. It refuses to type over busy,
approval, trust, limit, or non-empty composer states unless `force: true` is
explicitly supplied. The result reports whether bracketed paste was requested
and actually used.

Claude changes spinner wording and phrase length frequently. Busy detection
therefore does not enumerate phrases such as `Stewing` or `Consulting the
rubber ducky`; it uses animation glyphs, timing/interrupt markers, and later
completion markers. Timers and completion markers support hour, minute, and
second durations. A bare prose-like phrase with no glyph, timer, or interrupt
marker is intentionally not treated as proof of busy state. Transcript bullets
and ordinary prose with ellipses have negative regression fixtures so they do
not lock an idle composer. Fixed approval, trust, limit, interruption, and
paste markers are scoped to the active TUI phase after the latest spinner or
completion boundary, so an assistant report quoting a complete terminal screen
does not become a live control prompt.

Use `waitAfterCursor` returned by `submit_prompt` when waiting:

```json
{
  "managedSession": "claude-feature-review",
  "afterCursor": "<submit_prompt.waitAfterCursor>",
  "timeoutSeconds": 300
}
```

`wait_for_claude_turn` combines terminal state with the local Claude JSONL log
and returns clean final assistant text. Within one MCP process it also tracks
the most recent `submit_prompt` baseline when `afterCursor` is omitted, but the
explicit returned value is always a non-empty opaque cursor, including before
the first assistant reply. Pass it verbatim; it is portable across Codex task
or MCP refreshes. Current cursors carry the assistant and user baselines,
submission time, resolved conversation UUID, and managed-generation ID, but no
prompt or response text. That lets a refreshed process reject stale cursors and
require a completion from the submitted turn. Legacy raw assistant cursors
remain accepted with their older, weaker guarantees. Approval, trust,
interruption, and exit states take priority over completion and return
`needs_attention`. A completed transcript can be returned with an additive
`attention` value for a weaker stale limit or paste banner. The tool returns
`timeout` when the bounded wait expires. A `tool_use` stop reason is not a
completed turn.
Final assistant text is returned up to 128 KiB with `textLength` and
`textTruncated`, so callers can detect the uncommon larger response.

Use `send_text` and `send_key` only for low-level interaction. Newlines sent
through `send_text` can submit early; prefer `submit_prompt` for real prompts.
`send_text` with `submit: true` and `send_key` with `Enter` or `Return` also
return a non-empty `waitAfterCursor`. Their `submitted` field is true only when
the session log or composer transition provides evidence that a Claude turn
started, so pressing Enter on a menu does not create a false in-process anchor.

## Rename And Archive

Rename the conversation attached to a running, idle terminal:

```json
{
  "managedSession": "claude-feature-review",
  "title": "Feature review complete"
}
```

`rename_claude_session` sends Claude's `/rename` command and verifies the exact
title in the local session log. Repeating the same title returns
`already_named` without typing another command.

Archive a conversation from default MCP listings:

```json
{
  "sessionId": "00000000-0000-0000-0000-000000000000",
  "cwd": "C:\\work\\project"
}
```

`archive_claude_session` and `unarchive_claude_session` only update an MCP-local
sidecar catalog. They never move, edit, truncate, or delete Claude's JSONL
transcript.

## Capture And Stop

`capture_remote_control` returns:

- official headless xterm terminal rendering on Windows
- structured state signals
- a clean transcript snapshot and cursor
- requested, resolved, and observed posture

Stop defaults to a graceful exit and refuses a non-idle session:

```json
{
  "managedSession": "claude-feature-review",
  "graceful": true,
  "force": false
}
```

Use `force: true` only after inspecting the capture and deciding that in-flight
work may be interrupted.

## Windows Broker

The broker is per Windows user and authenticated with a local token. Its pipe
name is derived from that private token rather than a predictable user/path
value. Its state is under:

```text
%USERPROFILE%\.rail-connector-mcp\state\v1
```

The broker owns ConPTY sessions independently of one MCP stdio process. A new
Codex task can call `status`, capture an existing `managedSession`, continue
prompting it, or stop it. Sessions therefore require explicit lifecycle
management rather than disappearing when Codex refreshes.

Only a valid token-derived pipe is contacted. A short or corrupt token is
rejected before any connection and replaced under exclusive-create semantics;
it can never select the old predictable pipe. The old predictable pipe is never
sent the current token. Broker mutations require a renewable exclusive lease,
and PTY launch descriptors must resolve to the configured Claude executable.

`status` returns managed sessions by default. Pass
`includeAgentDetails: true` only when machine-wide `claude agents --json --all`
details are needed; those details can include Claude work outside the current
project.

## Operational Guardrails

Set `RAIL_CONNECTOR_ALLOWED_ROOTS` to a platform path list when desired (`;` on
Windows, `:` on Linux/macOS). This limits accepted `cwd` values and is
revalidated before reconnecting to broker-owned sessions after an MCP refresh.
`status` omits broker sessions outside the current roots. If a broker-owned
project directory disappears or its junction is retargeted, normal capture and
mutation fail closed. `status.cleanupEligibleSessions` returns only the managed
name and cleanup state when the stored start-time canonical path remains inside
a currently configured root. `stop_remote_control` with `force: true` can then
terminate the generation without reading capture or trusting the changed path.
Missing canonical provenance fails closed when allowed roots are configured.

When Claude is launched with `CLAUDE_CONFIG_DIR`, the MCP reads session logs
from the same configured directory. This supports isolated test/profile
layouts without falling back to the account's default `.claude` directory.

Treat Claude transcripts, terminal captures, titles, and Remote Control URLs as
sensitive local operator data. Do not commit them. For commands that may not
exit on their own, follow [Claude Task Guide](TASK_GUIDE.md).
