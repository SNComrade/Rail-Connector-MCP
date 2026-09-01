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
paired `--effort=ultracode --version` plus invalid-effort control probes without
starting an interactive session. Call it before using permission or effort controls because
Claude CLI help and accepted values can change between releases. The UltraCode
result uses completed child exit status as its primary evidence: the requested
value must exit zero and the invalid control must exit nonzero. Error wording is
corroborative only; a timeout or signal termination is inconclusive. Successful
inspection is cached for at most 60 seconds per resolved executable identity,
file fingerprint, policy mode, and sanitized environment category. The result
also reports blockers visible in the current MCP process environment. It does
not authenticate account or server-side policy state.

`ultracode.advertisedAsEffort` and its clearer alias
`ultracode.helpListsUltracode` answer only whether `claude --help` lists the
literal `ultracode` effort value. `false` is not an unavailability result. Read
`supportedByInstalledVersion`, `capabilityStatus`, `supportSource`,
`launchMechanism`, `launchArgument`, and the calibrated probe together. For a
supported direct launch, `launchArgument` is `--effort=ultracode`; runtime
effort and workflow evidence remain separate observations.

The MCP treats `permissionMode: "default"` as a semantic request. At launch it
resolves that request to the installed CLI's advertised `default` or `manual`
alias. Explicit elevated modes must be advertised by the installed CLI; they
are never silently downgraded.

For current Claude builds that support it, `ultracode: true` resolves to
`--effort=ultracode`. The older generic settings request remains only as a
capability-reported compatibility fallback. Capability inspection reports the
chosen mechanism; launch and capture responses report requested, resolved, and
observed posture separately. Anthropic's current settings reference documents
the direct launch form for Claude Code v2.1.203 and later:
[Claude Code settings](https://code.claude.com/docs/en/settings#available-settings).

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

Conversation summaries expose `observedClaudeVersion` when the session log
records it. They also expose the nested `ultraEffortAttachment` lifecycle from
bound `ultra_effort_enter` and `ultra_effort_exit` records. `active` is `true`
after the latest enter, `false` after the latest exit, and `null` when a skipped
or partial range prevents a current conclusion. Transition times, lower-bound
counts, explicit event omission, history coverage, and the compatibility fields
`ultraEffortAttachmentObserved` and `ultraEffortAttachmentObservedAt` are
reported separately. Compact list results omit the event array; detailed
session inspection and managed-session posture can include up to the latest 64
`transitionEvents`. An enter authenticates the client-side mode transition; it
does not independently prove that dynamic workflow orchestration ran on a
substantive turn.

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
passed. A pending dynamic workflow is protected with the distinct
`workflow_pending` reason even when the composer otherwise appears idle.
Forced replacement never types `/exit` into a non-idle composer.

## Permission Modes

For report-only review work, prefer `permissionMode: "dontAsk"` when the
installed CLI advertises it, pass `disallowedTools: ["Edit", "Write",
"NotebookEdit"]`, and use a prompt that forbids edits and state-changing
commands. Verify repository and index state before and after the turn; shell
inspection means report-only is not an operating-system sandbox. This denies
new permission requests while allowing a direct final report. Use `plan` only
as a compatibility fallback, and never approve implementation from a
report-only session.

These tool-list flags constrain Claude's built-in tools. They do not prove that
connected MCP or connector tools were removed from the session; those tools can
remain available under their own names. This MCP does not currently offer or
verify a strict MCP-config launch mode, so the recipe above is an operating
posture rather than hard tool isolation. Use an isolated review worktree or
read-only copy when that distinction matters, inspect the effective roster in
Claude, and keep the before/after repository checks.

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

The first value explicitly authorizes a local development host. The second
records an operator assertion that the surrounding environment is isolated;
the MCP does not verify a VM, container, Windows Sandbox, restricted token, or
filesystem boundary. The per-call confirmation is still required in either
case. Bypass mode removes Claude's normal permission prompts
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
- `resolved` records validated CLI launch arguments and mechanism. It does not
  prove model-alias resolution, fallback behavior, or delegated-agent posture.
- `observed` records session-log or terminal evidence.
- `observed.claudeVersion` records the CLI version from a bound session-log
  record when available. Start responses also report the version inspected for
  that launch as `claudeCliVersion`.
- `evidence` identifies the source for each observed field.
- `ultracodeAssessment` separates launch acceptance, runtime effort, sanitized
  workflow activity, environment blockers, conflicts, and unknowns.
- `ultracodeAssessment.ultraEffortAttachment` reports the bound enter/exit
  lifecycle. `attachment_lifecycle_active` means the latest complete transition
  is enter; `exited_after_entry` means a later exit made the client-side mode
  inactive. A skipped range or partial trailing record produces an unknown
  current state while retaining explicitly labeled historical evidence.
- `ultracodeAssessment.attentionStatus` reports a blocking launch environment,
  conflicting bound effort, or terminal-rejection conflict separately from the
  attachment lifecycle. Attention takes precedence in `status`; lifecycle
  evidence remains available for diagnosis.
- `ultracodeAssessment.launchEnvironment` is the sanitized snapshot captured
  from the environment actually supplied to the Claude child.
- `ultracodeAssessment.currentMcpEnvironment` describes the inspecting MCP
  process. `environmentComparison` is `match`, `different`, or
  `launch_not_recorded` for an older session.
- `audit.securityBoundary` states that allowed roots constrain MCP session
  management, reports bypass isolation as operator-asserted when applicable,
  and leaves OS/filesystem isolation unverified.
- `audit.toolPolicy` records requested tool arguments and whether persisted
  launch argv exists; effective main-session enforcement and delegated-agent
  coverage remain explicitly unverified or unknown.
- `audit.subagentTelemetry` is `unavailable` because current upstream evidence
  does not expose per-subagent model, fallback, permission, tool, token, or cost
  receipts.

Treat missing observation as unknown, not as a failed request. Session-log
evidence is stronger than terminal heuristics, but neither is a privileged
Anthropic state API. Claude can record `effort: "xhigh"` for an UltraCode
request because UltraCode uses xhigh underneath. The MCP reports that as
`xhigh_correlated_unconfirmed`; it does not promote xhigh alone to confirmed
UltraCode. Sanitized successful local-workflow launch records or a pending
count greater than zero produce `workflow_activity_observed`, while
`workflowTriggerAttribution` remains `unknown` because the log does not prove
what triggered the workflow. Failed, cancelled, rejected, and unknown workflow
statuses do not become successful launch evidence.

After a Codex or MCP refresh, use `launchEnvironment` for launch provenance and
the current field only as present-process diagnostics. A current blocker does
not retroactively prove that an already-running child launched with that
blocker. Raw environment values are never persisted or returned.

Remote Control web may label the underlying xhigh setting `Extra` while
UltraCode is active. A session-bound web `Extra` is compatible UI presentation,
not confirmation, conflict, or workflow evidence; context-free terminal text
remains unmapped. Any effort other than `xhigh` or `ultracode`, such as `high`
or `max`, bound to the same managed session is conflicting evidence. On an
idle, empty composer, `/effort ultracode` returning the explicit UltraCode
setting is current-setting evidence, but the command can change posture and
does not prove launch provenance. Use a substantive turn when validating
workflow activity. Bind visual comparisons to the same managed name,
conversation UUID, generation, and time window.

## Opt-In Debug Capture

For a narrowly scoped launch investigation, request Claude's own debug log:

```json
{
  "cwd": "C:\\work\\project",
  "managedSession": "claude-debug-investigation",
  "permissionMode": "default",
  "debug": true,
  "debugFilter": "api,!statsig",
  "trustWorkspace": false
}
```

`debugFilter` is optional and requires `debug: true`. Capability inspection
must advertise `--debug-file`; a filter additionally requires `--debug`.
The MCP creates a unique file under its state directory, passes it with
`--debug-file`, and returns `debugLog` provenance, file-identity status,
launch-argv binding, filter, and byte size. It never returns log contents. The
generated path is ignored when
comparing otherwise identical launch posture because each launch receives a
new file.

Debug logs can contain prompts, paths, tool activity, and other sensitive
local data. They persist for explicit operator inspection and are not committed
or automatically deleted. `ready` means identity and launch binding were
validated on Unix-like systems. Windows reports `ready_acl_unverified` because
Node file mode bits are not proof of a restrictive ACL; protect the MCP state
directory at the account boundary. Use debug capture only for a bounded
diagnostic run and remove the retained log and receipt after evidence handling
is complete.

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

Default review prompts should not delegate. When parallel review is explicitly
authorized but no budget is supplied, bound Claude to at most 3 workflow
agents, one pass, no recursive delegation, 5 findings, 10 minutes, and 200k
aggregate tokens. Stop and synthesize when any bound is reached.

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

Claude's exact `Waiting for N dynamic workflow(s) to finish` control line is
also a busy marker. The MCP combines that terminal heuristic with sanitized
session-log task lifecycle evidence and returns `workflowPending`,
`workflowPendingCount`, `workflowPendingEvidence`, and
`workflowPendingObservedAt`. Workflow names, task IDs, prompts, and results are
not exposed through these fields. A later matching task result, explicit zero
counter, bound interruption record, or newer terminal completion marker
releases its corresponding session-log or terminal evidence. An unidentified
launch remains fail-closed until one of those explicit release events arrives.
`workflowPendingEvidence` and `workflowPendingObservedAt` are empty whenever no
workflow is currently pending. `terminalState` preserves a simultaneous
approval, trust, draft, or other terminal state so workflow-only force controls
cannot bypass it.

The first session-log observation is bounded. Small logs are read fully; large
logs use a 256 KiB head plus a 2 MiB tail and then continue incrementally from
that checkpoint. `workflowObservationCoverage` reports `full`, `head_tail`, or
`none`, and `workflowObservationSkippedBytes` reports any skipped middle bytes.
When the middle was skipped, head-only model, effort, and permission posture is
discarded rather than presented as current. Any workflow launch or pending
state from the head remains historical evidence, but current workflow state is
reported as `unknown_due_to_gap` with `workflowObservationUncertain: true`, a
null `workflowPendingCount`, and `claude_session_log_incomplete` evidence until
the tail supplies an explicit global counter or bound interruption as a
candidate release. Before reporting certainty, the MCP replays the complete log
once and validates releases against the newest observed workflow timestamp; a
newer launch hidden in the skipped middle therefore keeps the session pending.
Successful replay changes coverage to `full` and clears the skipped-byte count.
This uncertainty fails
closed as `workflowPending: true`, so ordinary submit, text, Enter, rename,
replacement, and stop operations remain blocked. Inspect before using an
explicit force recovery. `lastKnownPendingCount` preserves the most recent
historical count without presenting it as current. The `status` tool reports
`workflowObservationStatus: "incomplete"` and `workflowPending: true` for this
state. If the terminal independently shows Claude's exact workflow wait control
line, its current count and `terminal_heuristic` evidence take precedence while
`workflowObservationUncertain` remains true. A trailing partial JSONL record is
assembled in chunks and treated with the same fail-closed uncertainty until the
record is complete or the log is replaced. A single trailing record is bounded
to 8 MiB and all cached plus in-flight fragments to 32 MiB. Overflow is
discarded through its next newline. Historical UltraCode coverage remains
explicitly partial, while a later complete UltraCode transition or authoritative
workflow counter can restore the corresponding current state instead of leaving
the cache permanently poisoned. Bounded session listings likewise discard
head-only permission, model, and effort rather than presenting stale posture as
current, while retaining a labeled historical UltraCode summary.
Fully read cached history is digest-verified within the same bounded read
window before appended records are accepted; the digest is extended during the
incremental read instead of re-reading the file, and unchanged observations do
not rehash it. Unchanged file metadata is never trusted by itself: stored
boundary guards are still compared before cached state is reused. Oversized
logs remain head/tail-bounded; a later authoritative record may restore current
state without triggering an unbounded full replay or relabeling skipped history
as complete. A valid final JSON object is accepted without requiring a trailing
newline, while a genuinely partial record remains uncertain.
Timestamp-regressing release records and untracked completions cannot release
newer workflow evidence.

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
completed turn. A terminal assistant record also does not complete the wait
while `workflowPending` remains true; the wait resumes only after the workflow
lifecycle reaches zero or a bounded timeout is returned.
Final assistant text is returned up to 128 KiB with an opaque, record-scoped
`resultId`, plus `textLength`, `textCharacters`, `textUtf8Bytes`, `textSha256`,
and `textTruncated`. `resultId` distinguishes separate assistant records that
contain identical text; `textSha256` is the content-integrity hash. The reader
expands from 2 MiB through a bounded 32 MiB window when the requested JSONL
record crosses the initial boundary, even when smaller records follow it. A
required record beyond that bound returns an explicit attention reason instead
of silently timing out. Use `get_claude_result` with the same project, UUID, and
`resultId` to retrieve Unicode-safe chunks until `hasMore` is false, then verify
`textSha256`. Legacy SHA-256 content result IDs remain accepted; when identical
text occurs in multiple records, their record-specific usage is intentionally
reported as ambiguous rather than guessed. The returned `usage` is only the
main assistant record's session-log evidence; delegated-agent coverage and
dollar or credit cost remain unknown.

The first record-scoped chunk read retains the verified result in a five-minute,
process-local, memory-bounded cache. Sequential pages reuse the prior Unicode
position instead of rereading, reparsing, or rehashing the complete result.
Every cache hit first confirms the session log is still the same regular file
with unchanged identity, size, and timestamps. An append, rewrite, replacement,
expiry, eviction, or MCP refresh causes a fresh bounded read. `resultCache` and
`transcriptRead.cacheHit` report which path supplied each chunk. Legacy
content-only IDs deliberately use a full bounded scan so duplicate-text usage
cannot be presented as record-specific evidence.

Use `send_text` and `send_key` only for low-level interaction. Newlines sent
through `send_text` can submit early; prefer `submit_prompt` for real prompts.
`send_text` with `submit: true` and `send_key` with `Enter` or `Return` also
return a non-empty `waitAfterCursor`. Their `submitted` field is true only when
the session log or composer transition provides evidence that a Claude turn
started, so pressing Enter on a menu does not create a false in-process anchor.
Low-level text and Enter submission return `send_blocked` with reason
`workflow_pending` instead of typing into an active dynamic workflow. This
includes Enter aliases such as `C-m`, `C-j`, and `KPEnter`. Escape and
cancellation keys remain available for deliberate operator control. The
native Windows backend accepts only its documented key names and returns
`EINVAL` for an unsupported name instead of typing that name into Claude's
composer. If an interruption leaves stale pending evidence, inspect the
capture first;
`send_text`, Enter-equivalent `send_key`, and rename each accept an explicit
`force: true` recovery and report `forceUsed` when it bypasses this one gate.
`submit_prompt` also reports `forcedPastReason` when its inspected force
override crosses a busy or non-idle preflight gate.

## Rename And Archive

Rename the conversation attached to a running, idle terminal:

```json
{
  "managedSession": "claude-feature-review",
  "title": "Feature review complete"
}
```

Rename is also blocked with `workflow_pending`. Use its `force: true` recovery
only after confirming that pending evidence is stale; it does not bypass other
non-idle attention or composer states.

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
work may be interrupted. If stop reports `awaiting_input`, preserve the unsent
draft: submit it only with authorization, explicitly discard and recapture only
with authorization, or leave the session running. Never force-stop a draft as
routine cleanup. A pending dynamic workflow returns `stop_blocked` with reason
`workflow_pending`; wait for it to finish or use `force: true` only after
accepting that the in-flight workflow will be interrupted. A forced stop returns
`forceUsed` and `workflowInterrupted`; forced replacement reports the matching
`replacementForceUsed` and `workflowInterrupted` fields on the new launch.

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
