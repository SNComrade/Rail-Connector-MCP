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

## Request Cancellation And Connection Closure

MCP cancellation is scoped to the exact request ID, including numeric `0`, an
empty string, and distinct numeric/string IDs. It cancels read-only polling and
prevents unsent mutations. A cancelled queued operation remains in the session's
ordering chain until its predecessor finishes, so a later operation cannot pass
an active predecessor. Duplicate active IDs close that connection through the
same cleanup barrier; unknown cancellation IDs do not create retained state.
Cancellation is bound synchronously to the currently admitted generation. It
cannot target a later request that reuses that ID, including reuse in the same
parser chunk or while the SDK retires an older handler.

Cancellation does not undo delivered input. A dispatched Windows lease acquisition
must settle before an exact original-generation release can complete. A lost grant
or release reply is reported as unknown; lease expiry is not proof of release.
An authoritative stale-generation rejection of the exact release is recorded as
`generation_changed`, without claiming release of the replacement. Available tool
results include redacted categories in `_meta["rail-connector/control-outcome"]`.
An acquisition whose reply was lost cannot fall through to an unleased operation
or authorize another acquisition. Only a provably undispatched unavailable
endpoint retains the existing fallback. Product mutations with uncertain replies
are not replayed, and cancellation prevents later separate Enter/retry calls.
The same lost-reply and exact-release rules apply after an authoritative broker
upgrade refusal permits a new acquisition attempt.
An authoritative acquisition refusal records that no lease was acquired; it
does not report an unknown grant or emit an unknown-lease cleanup event.
An unacknowledged launch can also leave a broker-owned lease whose new generation
is unknown. The outcome stays unknown; this client does not guess a release identity.
An already-dispatched native `sendText` RPC may finish its combined chunks and
Enter; this client cannot retract or interrupt those broker-side actions.

A new `submit_prompt` delivery attempt discards the previous remembered turn
anchor before sending, including when the new acknowledgement is lost. A
`preflight_blocked` result preserves that anchor because no delivery began.
Unbound idle waits can still report the latest settled turn; this does not make
that old turn the completion of an uncertain new submission.

Client EOF, output failure and parser/transport closure stop admission, cancel
safe waits, and await owned operations and their lease/finally cleanup before
closing the SDK transport. Shared capability probes belong to the MCP process;
cancelling one waiter detaches it while other waiters continue. Their bounded
owned subprocess work is included in EOF cleanup. No unrelated managed session
or persistent broker is stopped because a request or connection closes.
If one capability probe fails early, its bounded sibling probes still settle
before their shared result and EOF cleanup complete.

Response write callbacks, drain, errors and close settle once and remove their
listeners. The response-drain deadline is two seconds after the operation's
cleanup; connection closure also allows at most two seconds for remaining
responses after owned cleanup. This is not a two-second total shutdown promise:
already-dispatched work retains its existing bounded RPC/pacing and release
budgets. A drained response does not prove the client received it. Cancelled
mutations emit only redacted delivery/lease outcome categories on stderr, without
request IDs, prompts, transcript text or session URLs.

The focused synthetic contract checks are `node test/stdio-lifecycle.mjs` and
`node test/stop-generation.mjs --cancellation-contract-only`. Injected writable
checks and native Windows fake-pipe/owned-child checks are distinct from POSIX
qualification, ConPTY descendant extinction, and actual account/model behavior.

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

The product MCP resolves the executable selected by the ordinary launcher and
refreshes cached capabilities when that executable's stat identity changes.
The Issue 66 compatibility harness adds per-operation validation: it resolves
the ordinary `claude` launcher again and freezes the exact launcher and payload
identities. It does not pin a long-lived Claude version, run the updater, or
select a cached/versioned payload directly. A newly installed Claude release is
accepted only after the same capability, provenance, and minimum-contract
checks pass; an incompatible capability shape is handled as a compatibility
repair rather than by downgrading Claude.

That rolling behavior depends on ordinary `claude` launcher resolution.
`RAIL_CONNECTOR_CLAUDE_PATH` is an explicit operator-selected executable or
wrapper override whose update behavior belongs to that selected command. Leave
it unset when the MCP should follow the ordinary currently installed launcher.
The Issue 66 harness resolver fails closed when an inherited override selects a
different command from the ordinary launcher. Its dedicated MCP children also
remove every case variant of that key from their launch environment. These
are harness checks; the product MCP continues to honor an explicit executable
override. An override is not credited as rolling-latest validation evidence.

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

Prompt suggestions start off. Claude can show a generated next prompt as
dimmed text in an empty composer, even right after a fresh start. The MCP
cannot tell that text from a real unsent draft, so it would refuse prompts
(`active_input_not_empty`) and graceful stop (`awaiting_input`). Every managed
Claude session the MCP launches, including resume, continue, fork and a
`killExisting` replacement, therefore gets
`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` in its environment on both
backends. This replaces any value the MCP process itself inherited, for example
from a Claude Code session that started it. Short Claude checks the MCP runs
itself, such as version and help probes and session listing, keep the MCP
process environment unchanged. Pass
`promptSuggestions: true` to keep suggestions on for that launch; the launched
Claude then gets `true`, which also overrides Claude's own
`promptSuggestionEnabled` setting and keeps suggestions on until the account
reaches its usage limit instead of pausing near it. This is the only way the
MCP offers.

Limits of this setting:

- Claude Code honors the variable from version 2.1.238. An older Claude
  ignores it and can still show suggestions; the MCP does not check the
  version.
- It sets the launched process environment only. An `env` entry for
  `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` in Claude user, project, local or
  managed settings usually takes precedence, in either direction, and so can a
  configured Claude wrapper.
- It is not recorded in launch evidence, posture or audit receipts, and an
  `already_running` result does not compare it: a session keeps the environment
  it was launched with, and "matches the requested launch arguments" covers
  arguments and posture only. Sessions launched before this setting existed, or
  by an MCP process not yet restarted on this version, can still show
  suggestions.
- To be sure of the setting for an existing session, replace it. If the
  session already shows composer text, `killExisting` alone is refused; inspect
  the capture first, because `forceKillExisting` also discards a real unsent
  draft.

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

`dontAsk` also denies the Workflow tool unless it is allowed. A workflow
keyword (`pasteMode: "keyword"`) sent to a `dontAsk` session without that
allowance starts no workflow: Claude reports the Workflow call as denied, and
the MCP shows no workflow launch (seen live). The allowance verified live is
`tools: ["Workflow"]` plus `allowedTools: ["Workflow"]` at launch, with a
`disallowedTools` list that denied file, shell, network and connector tools;
the keyword workflow ran and the MCP released it without force (see
`docs/WINDOWS_VALIDATION.md`, 2026-10-08). `tools` limits the session's
built-in tools to the ones it names, so a session that also needs other
built-in tools must list them in `tools` and leave them out of
`disallowedTools`. Not verified: such a wider list, `allowedTools` alone
without `tools`, and tools that workflow workers themselves use.

This MCP sets the permission mode and tool lists only when it launches
Claude, and it offers no supported way to add an allowance to a running
session: `start_remote_control` without `killExisting` reports the existing
session as `already_running` and changes nothing. Once the session is idle,
replace it with the allowance and `killExisting: true`, or stop it and resume
its `resolvedSessionId` with the allowance. A resumed conversation's workflow
is released by Claude's task notification, not the fresh-conversation
snapshot. Claude's own `/permissions` command or a settings allow rule could
add an allowance inside a running session, but that changes Claude's
configuration outside this MCP (not verified through this MCP).

In `default` (or `manual`) mode, Claude's documentation says Claude asks
before running a workflow (not verified through this MCP). The MCP reports an
approval prompt as `approval_required` (and `wait_for_claude_turn` returns
`needs_attention`) only when the screen shows an approval question together
with a `Yes, and don't ask again` or `No, and tell Claude what to do
differently` choice. A workflow's own prompt may use other choices, so the MCP
may not recognize it, and the wait can end in `timeout` instead (not
verified). Capture the session either way, answer the prompt only with the
user's authorization, then wait again with the original `waitAfterCursor`.

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

For an existing installation, first follow the [Windows upgrade order](WINDOWS.md#upgrade),
including authorized session stops and old-broker shutdown through the old client.
Then close MCP clients using the checkout and use a separate PowerShell window.
`-ClientsClosed` acknowledges that preparation; it performs none of those steps.

```powershell
.\install-windows.ps1 -BypassPolicy LocalHost -ClientsClosed
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
  that launch as `claudeCliVersion`. Claude Code can update itself between two
  starts (a native install downloads updates in the background and uses them
  at the next start), so a later start can report a newer version than an
  earlier one; a live check saw 2.1.289 and then 2.1.294 ten minutes apart.
  Report the version and carry on unless a tool reports a problem. In an
  `already_running` result, `claudeCliVersion` is the version installed now,
  which can differ from the version the running session started with.
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

The tool uses Unicode-safe chunks, confirmed bracketed paste, a short
Windows paste-settle delay, JSONL prompt
acknowledgement, and bounded Enter retries. After the first Enter it also polls
a short visibility window so a delayed pasted-text placeholder can appear
before it decides whether a retry is needed. It refuses to type over busy,
approval, trust, limit, or non-empty composer states unless `force: true` is
explicitly supplied. The result reports whether bracketed paste was requested
and actually used. Missing or contradictory backend delivery evidence is an
error, not assumed framing; the first backend call may already have written
input, so inspect the composer before retrying that error.

`auto` requests framing. If mode support is unavailable or cannot be observed,
it permits literal fallback only when the prompt contains no TAB, CR or LF,
and reports `bracketedPasteUsed: false` with a delivery warning. Multiline/TAB
input is refused before input writes instead of being sent as keystrokes.
Explicit `bracketed` mode requires confirmed framing for every prompt, including
single-line text. All framed intent rejects ESC and other C0/C1 terminal controls
before capture/preflight/input, including with `force: true`; TAB, LF, CR,
ordinary Unicode and line endings are retained without normalization.
Explicit `literal` and the low-level raw `send_text` API keep their intentional
raw terminal semantics and are not covered by this framed-input protection.

Windows flushes pending renderer output before checking mode support and
rechecks after paced waits, before closing the frame and before Enter. If a recheck
observes lost mode support after partial delivery, it sends no further input and leaves
the generation recovery-only; no repair frame or automatic replay is attempted.
The check observes screen output already received, not a guarantee that the TUI
cannot change immediately afterward.

On tmux, one targeted server command chooses confirmed framed paste or the
allowed literal/refusal branch, with explicit delivery evidence. After the
ordinary settle delay, framed Enter is separately gated on the same pane's
current mode; a refusal then means the body was already pasted and requires
composer inspection. Older supported tmux versions that cannot report the
bracketed-paste mode refuse restricted input honestly; this does not silently
raise the general tmux minimum or treat conditional `paste-buffer -p` as proof.

An exact framed/literal nonce line records `paste-buffer -d` consumption before
late cancellation, even when a later hook adds output or fails. Delivery success
still requires a successful command and the clean whole delivery receipt.
Successful raw `paste-buffer -d` also records consumption. Known consumption
never triggers buffer cleanup or a replay.

Uncertain load/paste outcomes and mode refusals use one shielded internal cleanup
command list: `set-buffer -b OWNED x` replaces/creates only the generated owned
name with inert text, then a server-side exact-top conditional deletes only that
owned name. This avoids older tmux's missing-name delete fallback. An after-set
hook may change the top; the guard then refuses deletion and cleanup remains
`ECLEANUP`/UNCONFIRMED, although a completed exact set replaced the prompt text.
A positive cleanup nonce acknowledges the guarded delete action. An after-delete
hook can recreate the owned name before that nonce; final absence under arbitrary
hooks is not established. Lost/wrong cleanup receipts or failed commands also
report UNCONFIRMED, without
claiming buffer absence or guessing input delivery. Aggregate failures retain
the original error message/cause and carry `ECLEANUP`. The cleanup option is
internal, suppresses delivery-dispatch accounting, and does not replace shielding.
No shell, separate query/delete, unrelated buffer deletion, global lock, version
floor change or automatic replay is introduced.

Keyword mode requires an empty composer even with `force: true`. A draft or
unresolved paste placeholder returns `preflight_blocked` with reason
`active_input_not_empty` or `paste_pending`, `forceUsed: false`, and
`forceRefused: true` when force was requested. It sends no text or Enter, even
when pending workflow evidence would otherwise mask the composer state.
Generated suggestions remain protected when indistinguishable from real
drafts; keyword mode does not clear or dismiss them. Managed launches start
with suggestions off (see Start), so this applies when suggestions are on: a
`promptSuggestions: true` launch, a Claude settings override or wrapper, a
Claude older than 2.1.238, or a session launched before that default. Ordinary
modes retain their existing explicit-force behavior.

For a user-authorized workflow keyword request on native Windows, select
`pasteMode: "keyword"` and begin the unchanged prompt with lowercase `ultracode:`:

```json
{
  "managedSession": "claude-feature-review",
  "text": "ultracode: Review this synthetic example.\nReturn one bounded report.",
  "pasteMode": "keyword",
  "submitRetries": 0
}
```

This mode sends only the existing ten-character prefix as literal terminal
input, then brackets the remaining text and sends one Enter inside the same
managed mutation. It preserves multiline content and Unicode, requires active
bracketed-paste support, and rejects malformed prefixes or terminal control
characters before sending input. It is currently Windows-only; normal modes
are cross-platform under the framing requirements above. The receipt reports
`literalPrefixCharacters: 10`; check `transcriptAcknowledged` and the returned
wait cursor normally. CLI 2.1.289 logs bracketed-paste input inside an
id-matched `<pasted_content id="...">` pair, after a blank line (and after the typed
prefix in keyword mode); acknowledgement unwraps only such exact pairs and still
requires the content to equal the submitted text byte for byte. Keyword mode always disables extra Enter attempts, even
when a caller supplies a larger ordinary-mode retry limit. If bracketed-paste
support is missing before anything is sent, the tool returns an error and no
input was sent. If it changes after the prefix or part of the body was sent,
the broker sends nothing more (no remaining body, closing frame or Enter) and
marks that generation recovery-only. The broker checks the mode in its own copy
of Claude's screen output 100 ms after the prefix, at least 100 ms after each
body chunk, and again before Enter; it can act only on a change Claude has
already written to the screen by then. This is a timing window, not an
acknowledgement: a change that arrives just after a check lets one more write
through before the next check stops the send, for example one body chunk that
Claude then reads as ordinary typing, where a line break can submit part of the
prompt. A change after the last check before Enter, or one Claude never writes
to the screen, is not caught. A recovery-only session refuses every
further prompt, key, rename and name-only stop or replacement; `status` shows
`recoveryOnly: true`. Do not retry the prompt in that session. Inspect it with
`capture_remote_control`, then stop it with `stop_remote_control` using its
`expectedGenerationId` and `expectedStartedAtMs`, and start a new session.

Select this mode only for deliberate workflow intent. Do not select it because
quoted text, source code, tool output, or scheduled content mentions the word.
The default remains `auto`; no prompt scanning enables keyword mode. Transport
does not claim human origin or change effort, permissions, or workspace trust.
Because it changes no permissions, the workflow still needs Claude's
permission for the Workflow tool: under `dontAsk` the session must have been
launched with it allowed (see Permission Modes).
The keyword requests a workflow; explicit session UltraCode is a separate
launch control. Do not use full `literal` mode for multiline prompts: raw
newlines can submit before the final intended Enter.

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
not exposed through these fields. Direct terminal task results with matching
task and run IDs, completed `TaskOutput` retrievals for a tracked task,
Claude's own task notifications for a tracked task (see below), or
qualifying aggregate snapshots release only their matching tracked workflow. A current bound interruption can clear the tracked
set. An aggregate counter, including zero, cannot clear known pending workflows
by itself; an unidentified launch remains pending until a bound interruption.
A newer terminal completion marker releases terminal heuristic evidence only.
In CLI 2.1.289 that waiting line is a permanent turn-summary row drawn from the
same session-log record (`pendingWorkflowCount`) the MCP reads, and a short
later turn prints no newer completion row, so the row stays on screen after
the workflow completes. When the session log is fully and certainly observed
and has tracked workflow launches, the log decides: the stale row then is not
counted as pending work or as busy evidence (`likelyBusy`) in any composer state. Without a
complete log, or before the log has seen any launch, the row still holds
pending work. In particular, when an MCP process first reads a session log that
is already larger than 2.25 MiB (after an MCP restart, or when resuming a long
conversation), it reads only the log's head and tail; the stale row then keeps
holding pending work for that session. Confirm in Claude that the workflow has
finished, then repeat the call with `force: true`.
`workflowPendingEvidence` and `workflowPendingObservedAt` are empty whenever no
workflow is currently pending. `terminalState` preserves a simultaneous
approval, trust, draft, or other terminal state so workflow-only force controls
cannot bypass it.

Some CLI 2.1.274 workflow logs contain a launch and positive count, then worker
results and a final assistant answer without any aggregate terminal record.
Those observations cannot safely release pending state. A matching completed
`TaskOutput` retrieval is supported; the historical 2.1.275 compatibility
control exercised that path successfully. The real retrieval records on file (CLI
2.1.275) carry the task ID but no run ID, while every `async_launched`
record carries both and each task ID maps to a single run. A retrieval without a
run ID therefore releases the tracked launch with that task ID, provided the
launch bound a run ID and the retrieval is not older than the latest workflow
observation; a retrieval that does carry a different run ID stays a conflict.
CLI 2.1.289 no longer offers a `TaskOutput` tool (a call fails with "No such
tool available"). It reports a finished background task with a
`<task-notification>` that Claude itself records, either as a user record or,
in a resumed session, as a `queued_command` attachment, each marked by the
record-level origin `{kind: "task-notification"}`, which typed prompt text
cannot set. The MCP reads only the notification's leading header (task ID,
then status); a terminal status for a tracked launch that bound a run ID
releases that workflow, in fresh and resumed sessions and on every backend.
Terminal statuses are `completed`, `failed` and `killed` (Claude's word for a
stopped task), plus the older `succeeded`, `error`, `cancelled`, `canceled` and
`interrupted`. Any other status, such as `blocked`, keeps the workflow pending;
if Claude shows that it has ended, repeat the call with `force: true`.
Worker output later in the notification, a notification for another task, a
non-terminal status, and identical text in an ordinary user message do not
release anything. Live evidence (native Windows, CLI 2.1.289): every
`local_workflow` launch in the Issue 66 runs was followed by a notification
with status `completed` for that task, as a user record in fresh sessions and
as a `queued_command` attachment in resumed ones. Linux, macOS and tmux, and
the `failed` and `killed` statuses, are covered by offline tests only.
The MCP does not read arbitrary worker sidecars or clear pending solely from
worker completion, terminal prose, an idle composer, or an assistant end turn.

A completed 2.1.275 review also reproduced a dimmed prompt suggestion being
classified as a nonempty draft, blocking graceful stop. Internal cursor-style
diagnostics can record that appearance, but styling alone is not a trusted
distinction from a real draft. Automatic draft clearing is not implemented.
Managed launches now prevent suggestions by default instead (see Start); when
suggestions are on anyway, the classification limitation remains: untyped
suggestion text still blocks prompts (`active_input_not_empty`) and graceful
stop (`awaiting_input`). Inspected force cleanup
of an authorized task-owned session must be reported as a failure of graceful
shutdown, never a passing lifecycle result.

The MCP also checks the CLI's per-conversation aggregate workflow snapshot when
the session log is complete and a current managed launch identifies both the
task and run. A bounded, unchanged regular file must report completed status
with matching identities and ordered timestamps within that managed generation.
The snapshot must start no earlier than the managed session and within a
window around the matching JSONL `async_launched` record: at most 30 seconds
before it or 5 seconds after it. Claude registers the run before it writes that
record, so the snapshot normally starts a few milliseconds earlier (3-55 ms
across 115 local snapshots from CLI 2.1.247-2.1.288). Completion must not
precede the snapshot start or the launch record. An aggregate pending count
written after the completion holds the release back only when that count is
higher than the other tracked and unidentified workflows known at that moment;
a zero count, or a count those other workflows explain, does not.
Only that workflow is released; peers, unidentified work, newer pending evidence,
partial history, malformed files and conflicting evidence remain fail-closed.
An aggregate pending count alone cannot clear an identified workflow. Direct
terminal results require the matching run ID; every terminal result requires a
tracked launch with a bound run ID and a valid, ordered launch timestamp.

Snapshot evidence is checked again on each observation, so a cached release does
not hide a later missing or conflicting snapshot. The posture report's
`ultracodeAssessment.workflowActivity` identifies this source with
`completionEvidence: "claude_workflow_snapshot"` and `completedSnapshotCount`,
without exposing task identities or results. A `TaskOutput` call is not required
for this aggregate-snapshot path.

Aggregate snapshot completion currently requires a native-Windows broker binding
between one fresh managed generation and a new Claude conversation. The MCP
requests a new conversation ID, verifies that its session log was absent before
launch and contains an explicit matching session record, then binds the stable
log-file identity to that broker generation. A resumed, forked, reused, missing,
or ambiguous conversation log cannot earn this snapshot completion evidence.
The snapshot itself has no generation ID, so a snapshot created before the
bound generation or a replaced or identity-changed log file also leaves the
workflow pending. Linux, macOS, and tmux remain fail-closed for this evidence
source until an equivalent generation binding is implemented.

The earlier configuration diagnostic run isolated its task-owned broker and
state directory but deliberately shared active Claude configuration and
authentication. Because unrelated Claude processes were present, that run
established correlation only, not single-process attribution.

This snapshot format was corroborated in task-owned CLI 2.1.275 evidence and its
writer inspected in 2.1.276. It is a version-specific compatibility source, not
a promised CLI API. A passing live test using the older matching `TaskOutput`
shape still validates only that observed path; it cannot establish recovery of
the historical 2.1.274 missing-event case. Missing aggregate evidence continues
to block ordinary lifecycle operations. The start-before-launch ordering comes
from local snapshot history; release through it in a live managed session is
recorded in `docs/WINDOWS_VALIDATION.md` only after such a run.

No reliable interactive suggestion-origin marker was established. The
print/stream-json suggestion event belongs to a different interface and is not
used to classify Remote Control composer text. Suggestion classification remains
incomplete; the MCP prevents suggestions by default instead (see Start).

The first session-log observation is bounded. Small logs are read fully; large
logs use a 256 KiB head plus a 2 MiB tail and then continue incrementally from
that checkpoint. `workflowObservationCoverage` reports `full`, `head_tail`, or
`none`, and `workflowObservationSkippedBytes` reports any skipped middle bytes.
When the middle was skipped, head-only model, effort, and permission posture is
discarded rather than presented as current. Any workflow launch or pending
state from the head remains historical evidence, but current workflow state is
reported as `unknown_due_to_gap` with `workflowObservationUncertain: true`, a
null `workflowPendingCount`, and `claude_session_log_incomplete` evidence unless
a separate complete workflow reconstruction succeeds. This reconstruction reads
every byte through one captured file extent, in physical record order, using
the same launch/task/run, counter, terminal-notification and interruption rules.
A counter cannot clear known pending workflows by itself. No range is skipped
because its first timestamp is old, and idle or an ordinary `end_turn` is never
workflow completion evidence.

Reconstruction is limited to 16 MiB, 100,000 nonempty records, 8 MiB per record,
4,096 active task identities and a one-second cooperative deadline. The deadline
is checked around reads and parses; an individual OS read or synchronous parse
is not forcibly cancelled. Exhaustion, short/failed reads, invalid UTF-8,
malformed/partial records or ambiguous session/timestamp evidence leave workflow
certainty incomplete, even if a later tail counter or interruption looks idle.
Workflow timestamps must be strings interpreted by the same date parser as the
launch filter. Each fully parsed record may be excluded by that filter's exact
timestamp cutoff; this never excludes a surrounding range or relies on ordering.
Decoded incomplete records share the existing process-wide 32 MiB fragment
allowance and release their reservations on completion, refusal or failure.
Only workflow fields are retained for reconstruction. Their logical string
payload is limited during replay to 128 Ki UTF-16 code units per cached
projection, conservatively counting aliases, collection keys/values, timestamps
and counter identity arrays. Overflow refuses recovery without truncating or
dropping pending identities. Across the existing 128 cache entries this caps
that logical string payload at 32 MiB; collection overhead, temporary parsed
objects and process RSS are not covered by this bound.
The file handle and current path must retain the captured identity, size, mtime
and ctime through validation. Append/rewrite/rotation during the scan refuses
the candidate. An unchanged observation can reuse completed evidence or a
deterministic refusal only after ordinary cache guards and the unchanged
metadata tuple validate. This avoids replaying an unchanged malformed or
unsupported range on every wait poll. Byte/record/identity/retained-string limits,
malformed/partial JSON and invalid encoding remain conservatively unknown until
the source changes; a later counter alone cannot complete a failed range.
Transient deadline, read, file-change, `future_timestamp` and shared-fragment-budget
failures are not retained as refusals. A future timestamp is rechecked even when
the file is unchanged, because advancing the clock may make it current.
Each later append requires a new bounded replay from
byte zero. This assumes
cooperative local filesystem metadata, not an adversarial immutable snapshot.

`workflowActivity.reconstruction` reports `status` (`complete` or `incomplete`),
a closed refusal `reason`, `bytesRead`, `recordsRead` and cache reuse when
applicable. On a cache hit these counts describe the original proof attempt,
not new reconstruction I/O. Coverage remains `head_tail` and the skipped-byte count remains:
this proof restores only workflow certainty, never head-only posture or full
UltraCode history. A complete workflow proof can support the existing verified
snapshot-completion and stale-terminal-wait reconciliation rules without
claiming complete posture/history coverage. Existing snapshot identity,
generation, timestamp and counter checks still apply.
While current-state uncertainty remains, it fails
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
logs retain head/tail posture coverage; workflow reconstruction remains bounded
and cannot relabel skipped posture/history as complete. A valid final JSON object
is accepted without requiring a trailing
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

On native Windows every managed session has a generation pair:
`generationId` and `startedAtMs`. `start_remote_control` returns it as
`sessionBinding`, and `status` lists it for each managed session. Callers can
pass it as `expectedGenerationId` and `expectedStartedAtMs` to
`capture_remote_control`, `wait_for_claude_turn`, `submit_prompt`,
`rename_claude_session` and `stop_remote_control`. The pair is checked before
any capture, input or stop. If the managed name now belongs to a different
generation or no longer exists, the call fails with `ESTALE` and sends, types
and stops nothing in any other generation; a pair refused at the start of the
call does nothing at all. Only if Claude exits during a call and another start
takes the name can input sent earlier in that call have reached the old
generation. Callers see only the error text, which says the generation
changed, refuses a stale operation, or rejects the `afterCursor`. A paired
`wait_for_claude_turn` also needs the `waitAfterCursor` returned for that
generation; without it, or with any other cursor, it fails with `ESTALE`. tmux
rejects the
pair. Supplying only one of the two fields is rejected. `stop_remote_control`
also accepts `expectedResolvedSessionId` and `expectedCanonicalCwd` to bind the
stop to the exact conversation and workspace as well.

Calls without the pair keep name-based behavior, with one exception. A session
becomes recovery-only after `stop_timeout` (Claude did not confirm exit after a
forced ConPTY stop) or after an interrupted keyword send. It then refuses every
prompt, text, key and rename, even with the pair, and every name-only stop and
`killExisting` replacement; `status`, `capture_remote_control` and
`wait_for_claude_turn` still work. `status` shows `recoveryOnly: true` for such
a session, and the `stop_timeout` reply, a normal result rather than an error,
includes the `expectedGenerationId` and `expectedStartedAtMs` to retry with.
After `stop_timeout`, retry with that pair and `force: true`. A paired forced
stop repeats the ConPTY termination; a paired stop without `force` does not.
The broker does not add a separate `taskkill` by PID. A forced stop discards
any unsent draft, in-flight turn, pending approval and running workflow. If
the retry returns `stop_timeout` again, the process must end outside the MCP.
If the session's workspace folder has been removed or retargeted, the paired
stop also fails closed and the session must be ended outside the MCP.

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
