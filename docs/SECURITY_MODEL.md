# Security Notes

This MCP controls an interactive local Claude Code process. Treat it as a
powerful development automation surface, especially when multiple Codex agents
can reach the same managed session.

## Permission Policy

`start_remote_control` supports the permission modes advertised by the installed
Claude CLI. The semantic `default` request resolves dynamically to the
installed CLI's `default` or `manual` alias. Explicit elevated requests are
validated on every launch and are never silently downgraded.

`bypassPermissions` removes Claude's normal tool approval prompts. It is useful
for an intentionally authorized development environment, but it can also let
Claude modify repositories, host files, credentials, services, and external
systems available to the process.

The MCP therefore requires two explicit acknowledgements:

1. The MCP process opts into a policy:

   ```text
   RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS=I_UNDERSTAND_BYPASS_CAN_MODIFY_MY_HOST_WITHOUT_PROMPTS
   ```

   Use the legacy
   `I_UNDERSTAND_THIS_REQUIRES_ISOLATION` value for a disposable isolated
   instance.

2. Each launch passes `confirmBypassPermissions: true`.

This is an operator-controlled capability gate, not an isolation-only ban. Keep
the environment value unset where bypass should be unavailable. Team size,
repository trust, and prompt wording are not substitutes for the explicit
acknowledgements.

Configure the process policy through the platform installer so registration is
repeatable and can be read back:

```bash
./install.sh --bypass-policy LocalHost
```

```powershell
.\install-windows.ps1 -BypassPolicy LocalHost
```

Use `Disabled` to register without the environment entry, then confirm the
result with `codex mcp get rail-connector`. The MCP reads this environment only
at process startup. `get_claude_capabilities` reports whether the configured
value is recognized, and `status.mcpProcess` reports the PID and startup time.
After changing policy, open a fresh Codex task so a new MCP process inherits the
registration. A daemon-managed environment may require a targeted
`codex app-server daemon restart`; WSL and unrelated project services do not
need to be restarted for this policy change.

If an already-running broker session was launched in `bypassPermissions`, later
prompt, key, and rename mutations remain available only while the current MCP
process has one of those policy acknowledgements. Capture and stop remain
available so a policy change cannot trap an elevated session.

`safeMode` cannot be combined with `bypassPermissions` or `dontAsk`.
`trustWorkspace` only accepts Claude's trust prompt when the MCP detects the
current prompt; it does not change permission policy.

For report-only reviews, prefer `permissionMode: "dontAsk"` when advertised,
pass `disallowedTools: ["Edit", "Write", "NotebookEdit"]`, verify repository
and index state before and after, and use an explicit prompt prohibiting edits,
installs, commits, pushes, configuration changes, and commands that create
artifacts. `dontAsk`
automatically denies new permission requests while allowing read-only
inspection. `plan` is a compatibility fallback, but its approval workflow is
not the report: never approve implementation from a report-only review. No
interactive mode is a zero-write OS sandbox; Claude and the MCP still maintain
local logs, terminal state, and caches.

`tools`, `allowedTools`, and `disallowedTools` constrain Claude's built-in tool
set. They do not remove or authenticate the effective roster of MCP and
connector tools. A session can therefore retain mutating connector tools even
when `Edit`, `Write`, and `NotebookEdit` are denied. This MCP does not currently
offer a verified strict MCP-config launch mode. Treat report-only as a reviewed
operating posture, verify the roster when possible, and use an isolated
worktree or read-only copy when hard write isolation is required.

## Scope Restrictions

Set `RAIL_CONNECTOR_ALLOWED_ROOTS` to restrict accepted working directories.
Use `;` between roots on Windows and `:` on Linux/macOS:

```powershell
$env:RAIL_CONNECTOR_ALLOWED_ROOTS = 'C:\Users\<you>\Projects;D:\Work'
```

Every entry must already exist in the same OS context as Codex and Claude. If
the variable is set but contains no valid directory, `cwd` resolution fails
closed. A refreshed MCP also revalidates the stored `cwd` of every persistent
Windows broker session before capture, input, metadata mutation, replacement,
or ordinary stop, so narrowing the root policy takes effect immediately.
`status` filters out broker sessions outside the current roots before returning
metadata or querying process details. A missing or retargeted persisted path is
eligible only for force cleanup when the broker retained a start-time canonical
path that is still inside a currently configured root. Cleanup returns only a
minimal managed name/state, never terminal capture. Older broker records
without canonical provenance fail closed under configured roots.

Allowed roots are an MCP working-directory and session-management boundary.
They are not a Claude filesystem sandbox. An `Isolated` bypass policy is also
only an operator assertion: the MCP does not verify a VM, container, Windows
Sandbox, restricted token, or filesystem boundary. Launch receipts report
`osIsolationVerified: false` and warn that bypass can modify every host resource
available to the Claude process.

Claude's `tools`, `allowedTools`, and `disallowedTools` flags are passed through
to Claude Code. Launch receipts preserve the requested argv rules but leave
effective enforcement and delegated-agent coverage unverified. These flags
complement, but do not replace, working-directory, permission, and prompt
controls. They cover built-in tools only and do not by themselves suppress MCP
or connector tools.

## Broker And Concurrency

On Windows, a per-user broker owns ConPTY sessions across MCP process and Codex
task refreshes. Broker state is stored under:

```text
%USERPROFILE%\.rail-connector-mcp\state\v1
```

The broker uses a random local token and a named-pipe identity derived from that
token. The raw token is never placed in the pipe name or protocol logs. Do not
copy the token or state directory to another account. Managed sessions persist
until stopped, exit naturally, or the broker is terminated, so inspect `status`
and stop sessions that are no longer needed.

The client refuses to derive or contact a pipe from a short or corrupt token.
Startup replaces an invalid token using exclusive creation; status treats it as
no valid broker. This prevents an empty token from selecting the historical
predictable pipe identity.

The current broker never sends the token to the older predictable pipe name.
An older historical-pipe broker may remain alive until it is stopped through
the MCP build that created it. Token-derived brokers expose a restricted
compatibility cleanup channel so a refreshed client can force-stop an active
older-build session without reading capture, launching a command, or bypassing
generation and workspace checks. All ordinary cross-version mutations remain
blocked. Authenticated `start` and `replace` requests must match the resolved
Claude executable, including an exact `cmd.exe` descriptor for a configured
`.cmd` or `.bat` wrapper. An invalid replacement is rejected before the
existing session is stopped.

Input, key, rename, replacement, and stop operations are serialized per managed
session. The Windows broker adds a cross-process lease so separate Codex agents
cannot interleave terminal mutations. Startup keeps the same lease through
trust handling, session-log binding, and generation-checked metadata updates.
The MCP renews that lease during long workflows. The broker rejects mutation
requests when the lease is absent, expired, or belongs to another MCP client.
This prevents accidental mixed prompts; it does not decide which agent's
request is semantically correct.

The mutation lease covers one MCP operation, not the full duration of a Claude
dynamic workflow. Before submitting text or Enter, renaming, replacing, or
stopping, the MCP therefore recomputes sanitized workflow activity from the
bound session log and combines it with Claude's exact terminal wait control
line. A positive result blocks the operation with `workflow_pending` unless the
operation exposes and receives an explicit force choice. A
workflow task ID is retained only inside the process-local reducer so a later
matching terminal retrieval can clear the pending count; IDs and workflow names
are never returned. Unidentified launches remain counted when an identified
peer completes, and a bound interruption or explicit zero count clears the
tracked set. Enter-equivalent aliases such as `C-m` and `C-j` use the same gate.
A session-log read error fails the mutation instead of silently treating the
session as idle. An absent or not-yet-bound log is reported as not observed and
leaves the terminal signal as the available lifecycle evidence. Explicit force
recovery is machine-readable in stop, replacement, text, key, and rename
results.

Linux/macOS uses validated tmux ownership metadata and refuses to control an
unmanaged same-name session or one whose pane identity changed. Metadata
updates compare the launch generation and target the original pane rather than
a possibly replaced same-name session.

## Effort And Posture Evidence

Ultracode requires both `ultracode: true` and `confirmUltracode: true` and
cannot be combined with ordinary `effort` or `safeMode`. Current supported
Claude builds launch it with `--effort=ultracode`; a legacy generic-settings
path is used only when capability inspection selects that fallback.

Responses separate:

- the semantic posture requested by the caller
- the exact posture resolved for the installed CLI
- posture observed from Claude's JSONL session log or terminal
- the evidence source for each observation

The `resolved` object is validated launch argv, not proof that a model alias
resolved without fallback. The additive `audit` receipt records that semantic
boundary, requested tool argv, unverified isolation, and unavailable
per-subagent telemetry. Current Claude session logs do not provide a trustworthy
per-subagent model, permission, fallback, tool, token, or dollar-cost receipt,
so those fields remain unknown instead of being inferred.

Do not report an unobserved field as confirmed. Session-log evidence is stronger
than terminal heuristics, but neither is an authenticated Anthropic control
plane. When Claude records `xhigh` for a successfully resolved direct
`--effort=ultracode` launch, the MCP reports the correlation as unconfirmed.
It reports only sanitized successful local-workflow launch evidence or a
positive pending count and does not attribute a workflow trigger when the log
cannot prove one. Failed, cancelled, rejected, and unknown workflow statuses
do not become successful launch evidence.
Current session-log evidence is recomputed for each posture report so stale
persisted correlation cannot hide a newer conflict. The MCP incrementally
reduces append-only records observed for each bound launch. A first cold read
of an oversized log uses bounded head/tail recovery; skipped-middle workflow
state and trailing partial records fail closed, and head-only permission,
model, and effort are not reported as current. Fully read logs retain a
whole-history digest within the same bounded read window and verify it before
accepting appended bytes. The digest is extended while appended bytes are
parsed, and an unchanged observation does not hash the complete history again.
Stored prefix and offset-anchor guards are still compared before unchanged
metadata can reuse cached state; change-time drift resets same-length entries.
Oversized logs retain prefix and offset-anchor guards without rehashing the
skipped middle on each observation. An explicit workflow checkpoint in the
observed tail is only a candidate release: the MCP performs one complete replay
before restoring certainty, so newer hidden-middle evidence cannot be erased by
an older tail record. This bounded design treats Claude's session log as
append-only; it does not claim to authenticate against another local process
deliberately rewriting an oversized skipped middle while preserving both
boundary guards. Trailing JSON records are buffered in chunks with an 8 MiB
per-record and 32 MiB process-wide bound shared by cached and concurrently
loading fragments. An overflow is discarded to the next record boundary while
retaining explicit partial-history evidence. A later complete UltraCode
transition or authoritative workflow counter may restore that current field;
it does not rewrite the unobserved historical range as complete.
The runtime-observation cache is bounded and is not broker or tmux posture
persistence. Exact result paging uses a separate process-local cache for
record-scoped IDs. It retains at most four entries and no more than 40 Mi
UTF-16 code units in aggregate. It refreshes a five-minute expiry only after the
same regular session-log file has unchanged identity, size, and timestamps.
Any log change, file replacement, eviction, or MCP restart forces a fresh
bounded read.
The cache contains result text already available through the MCP and is never
persisted to the broker, tmux metadata, or disk. Terminal-only posture
heuristics are returned for the current capture but are not persisted as
durable observation. Legacy broker or tmux `observedPosture` metadata remains
read-compatible for migration but is excluded from public lifecycle responses.
Environment diagnostics return sanitized categories and blocker names, never
the raw effort override value. New managed launches persist those sanitized
categories as `launchEnvironment`; posture reports show that snapshot
separately from `currentMcpEnvironment` after an MCP refresh. Linux/macOS tmux
launches explicitly set `CLAUDE_CONFIG_DIR`, the two UltraCode-relevant Claude
environment variables, and `FORCE_COLOR` for the child instead of trusting a
possibly older tmux-server copy. No raw value is added to public posture or
managed metadata.

For current native Windows launches, the Claude child inherits the MCP process
environment plus explicit launch overrides. For current Linux/macOS launches,
the child receives the tmux session environment plus explicit Claude launch
overrides, and an existing tmux server can retain its own environment. The
audit receipt reports that model only when sanitized child-launch environment
evidence was persisted. Legacy launch metadata without that evidence reports
the child environment as unknown rather than applying current behavior
retroactively. Treat both MCP registration and terminal-server environments as
part of the Claude trust boundary and keep unrelated secrets out of them;
changing to a strict allowlist requires a separately reviewed compatibility
design.

Capability inspection calibrates the requested UltraCode parser probe against
an invalid control by process exit status. Timeout and signal termination are
inconclusive, and stderr text is corroboration rather than authority. Results
are cached for no more than 60 seconds per resolved executable/file identity
and sanitized process posture, preventing repeated probe storms without
surviving an MCP process restart.

When a JSONL record contains both
`sessionId` and legacy `session_id`, the top-level `sessionId` is authoritative;
the legacy field is used only when the top-level field is absent. Sidechain
records are excluded from the main transcript and runtime-posture observation.

All caller-provided CLI values reject option-like or control-character input
and are emitted as `--option=value`. Claude is resolved to one executable path
before inspection and launch. Set `RAIL_CONNECTOR_CLAUDE_PATH` only to an
absolute, operator-selected Claude executable or wrapper. A persistent broker
started with one configured path will reject a later client that requests a
different path. The MCP compares a launch-policy fingerprint and restarts an
idle broker when that policy changes; active sessions must be stopped first.

## Sensitive Local Data

Never commit:

- `.claude` or `.codex` state
- Claude JSONL transcripts
- Remote Control URLs
- broker tokens or logs
- opt-in Claude debug logs under the MCP state directory
- API keys, OAuth tokens, or `.env` files
- private customer or business data

`list_claude_sessions` omits snippets, titles, per-session paths, and Remote
Control URLs by default. Search can still use those local fields without
disclosing them. `get_claude_session` intentionally returns recent transcript
content and any recorded URL, so use it only for a selected conversation.
`status` omits machine-wide Claude agent details unless
`includeAgentDetails: true` is explicitly requested.

The MCP captures Remote Control URLs produced by Claude Code; it does not
implement Anthropic's private Remote Control protocol. Treat every URL as a
sensitive live-session link.

`start_remote_control` can opt into Claude's `--debug-file` support. The MCP
creates a unique regular file and sidecar receipt under its state directory.
The receipt binds file identity to the managed-session name, debug filter, and
exact launch argv hash. The MCP reports provenance and size and never returns
contents. Debug logs
may contain prompts, paths, tool activity, and environment-adjacent data. They
persist for operator-controlled evidence handling and have no automatic
retention deletion. Unix owner-only creation modes are requested. Windows uses
`ready_acl_unverified`, not `ready`, because Node mode bits do not prove a
restrictive ACL; account-level state-directory permissions remain part of the
trust boundary.

Archive operations only maintain MCP-local sidecars. They never modify, move,
truncate, or delete Claude's transcript.
