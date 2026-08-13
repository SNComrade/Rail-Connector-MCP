# Rail Connector Debugging Playbook

## Tools Missing

- Confirm the current Codex task exposes `mcp__rail_connector`.
- Inspect the global `mcp_servers.rail-connector` configuration.
- Verify command is an absolute native Node path and args point to this repo's
  `src/index.js`.
- Run `codex mcp get rail-connector` when a working CLI is available.
- After tool-schema or environment changes, open a fresh Codex task so a new
  MCP process inherits them.

Use the platform installer for local-host bypass:

```powershell
.\install-windows.ps1 -BypassPolicy LocalHost
```

```bash
./install.sh --bypass-policy LocalHost
```

Or register manually from the same OS context as Codex:

```bash
codex mcp add rail-connector \
  --env RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS=I_UNDERSTAND_BYPASS_CAN_MODIFY_MY_HOST_WITHOUT_PROMPTS \
  -- /absolute/path/to/node /absolute/path/to/Rail-Connector-MCP/src/index.js
codex mcp get rail-connector
```

If a daemon-managed Codex environment retains the old MCP transport after a
fresh task, use `codex app-server daemon restart`. Do not restart WSL or
unrelated project services for an MCP registration change. Direct TOML editing
is a fallback; back up the file before edits and validate it afterward.

## Start Fails

- Call `status` and `get_claude_capabilities`.
- Verify `claude` is authenticated in the same OS account.
- Check `cwd` exists and is within `RAIL_CONNECTOR_ALLOWED_ROOTS`.
- Inspect `exited_during_startup` capture and exit code.
- Handle `needs_workspace_trust` only after confirming the folder.
- Verify explicit elevated permission modes appear in advertised capabilities.
- Semantic `default` should resolve to the installed `default` or `manual`
  alias.

## Bypass Fails

Check capability output and `status.mcpProcess` for bypass policy status:

- `enabled: false`: inspect `configured` and `recognized`, correct registration,
  and start a new MCP process.
- `readAtProcessStart: true`: a running PID cannot observe later registration
  changes.
- compare `status.mcpProcess.pid` and `startedAt` before and after the reload.
- local-host value:
  `I_UNDERSTAND_BYPASS_CAN_MODIFY_MY_HOST_WITHOUT_PROMPTS`
- isolated value: `I_UNDERSTAND_THIS_REQUIRES_ISOLATION`
- request must include `permissionMode: "bypassPermissions"` and
  `confirmBypassPermissions: true`

Do not report success if the MCP launched a different mode. Compare requested,
resolved, and observed permission fields.

## Ultracode Fails

- Call `get_claude_capabilities`.
- Use `ultracode: true` and `confirmUltracode: true`.
- Omit ordinary `effort` and `safeMode`.
- Confirm the selected launch mechanism. Current Claude builds may support
  direct `--effort=ultracode`; older builds may expose only the compatibility
  settings request.
- Inspect session-log evidence and terminal signals. A requested-only result is
  not observed activation.

## Windows Session Missing Or Stale

Windows sessions live in the per-user broker, not one MCP stdio process.

1. Call `status`.
2. Inspect broker availability, PID, state directory, and managed sessions.
3. Reuse the exact `managedSession` after a Codex refresh.
4. Inspect the broker log under
   `%USERPROFILE%\.rail-connector-mcp\state\v1`.
5. Verify the token/state directory belongs to the current user.
6. Inspect `broker.compatible` and `broker.launchPolicyCompatible`. The current
   MCP never probes a historical predictable pipe with the current token.
7. If `broker.running` is `null`, report `broker.probeError`; do not describe a
   timeout as an absent broker.
8. If a token-derived older broker owns an active session, finish important
   work and call `stop_remote_control` with `force: true`. Compatibility
   cleanup is authenticated, generation-bound, workspace-scoped, and reads no
   capture. A broker predating that cleanup protocol still needs its original
   MCP process.
9. A missing or retargeted project path can appear under
   `cleanupEligibleSessions`. Non-force stop reports the reason; force cleanup
   uses stored canonical provenance and reads no terminal content.

Do not start a replacement merely because the current Codex task is new. If a
session is busy, replacement should be blocked unless
`forceKillExisting: true` is deliberate.

## Concurrent Agents Conflict

- Give unrelated jobs unique managed names.
- A broker mutation lease should serialize prompt, key, rename, replace, and
  stop operations across MCP clients.
- Capture/status may run concurrently.
- If lease timeout occurs, identify the agent holding the operation and retry
  after it completes. Do not bypass serialization by writing directly to the
  terminal.
- A missing, expired, or wrong lease must fail closed. Long MCP workflows renew
  ownership automatically; repeated lease loss indicates a stale client or
  broker-version mismatch.

## Prompt Does Not Submit

- Use `submit_prompt`, not multiline `send_text`.
- Inspect preflight `status`, `reason`, signals, and active composer.
- JSONL acknowledgement should distinguish an accepted prompt from text still
  sitting in the composer.
- A large paste placeholder can appear after the first capture. Submission
  polls a bounded visibility window before deciding whether to retry Enter.
- Windows bracketed paste has a settle delay before Enter and is used only
  when the xterm application mode reports it enabled. Compare
  `bracketedPasteRequested` with `bracketedPasteUsed`.
- `preflight_blocked` should not be retried blindly.
- Use `force: true` only after inspecting the conflicting state.
- Add new TUI prompt/composer shapes to submission fixtures.

## Wait Returns Wrong Or Old Output

- Pass the non-empty `submit_prompt.waitAfterCursor` verbatim, especially
  across an MCP or Codex task refresh.
- Current portable cursors bind the transcript baseline, submission time,
  conversation UUID, and broker generation. An `ESTALE` cursor error means the
  managed generation or conversation changed; submit again instead of editing
  the cursor.
- Confirm the new user prompt appears after the previous assistant record.
- Inspect the bound `resolvedSessionId` and local JSONL path.
- An anchored `wait_for_claude_turn` requires a different assistant cursor with
  a terminal stop reason such as `end_turn`; `tool_use` is still in progress.
  A matching JSONL completion can supersede stale terminal status text.
- Check `textLength` and `textTruncated` before diagnosing a large report as
  incomplete.
- `needs_attention` is expected for approval, trust, limit, interruption,
  paste, or exit states.
- `completed` can still include an additive `attention` object for a weaker
  limit or paste warning. Do not discard the completed transcript while
  diagnosing that warning.
- A timeout can mean Claude is still working; capture and wait again.

## Capture Looks Noisy

Windows capture is rendered by official headless xterm. Regressions belong in
`test/render-capture.mjs` with raw escape-sequence fixtures. Avoid reintroducing
an ad hoc cursor parser.

Check whether noise is:

- true TUI content
- stale scrollback
- xterm sizing/scrollback behavior
- an input/status parser false positive

Use transcript snapshots for final output. `axScreenReader` is an optional
comparison, not the default repair.

## Session Identity Problems

- `remoteName` is not a title.
- `sessionTitle` applies only to a new conversation.
- Rename uses `/rename` and verifies the local log.
- Title precedence is custom title, agent name, then AI title.
- `isMeta: true` user reminders must not become titles or prompts.
- `resumeSessionName` must resolve an exact unique title.
- `continueLatest` resolves a UUID before launch.
- Fork should produce a different UUID and bind by new log/Remote URL evidence.
- Reject symlinked JSONL logs.

## Archive Problems

Archive state is an MCP-local sidecar. It should:

- hide archived sessions from default `active` listings
- appear with `archiveState: "archived"` or `"all"`
- never alter Claude JSONL content
- be removable with `unarchive_claude_session`

## Stop Problems

Default stop requires `signals.state: "idle"` and asks Claude to exit
gracefully. `stop_blocked` is expected while busy or needing attention.
`force: true` accepts interruption. A timeout or still-running backend must not
be reported as stopped. Windows force-stop first closes ConPTY and then uses
`taskkill /T /F`; `stop_timeout` remains tracked and can be retried.

## Verification

```powershell
npm run check
npm run test:args
npm run test:capabilities
npm run test:submit
npm run test:submit-loop
npm run test:sessions
npm run test:lifecycle
npm run test:render
npm run test:broker
npm run smoke
npm run test:installer:windows
npm run test:installer:unix
npm run test:wrapper:windows
npm test
```

For an intentional real Claude Windows acceptance:

```powershell
$env:RAIL_CONNECTOR_LIVE_ACCEPTANCE = '1'
npm run test:live:windows
```

Run the native Codex `quick_validate.py` against each skill after skill edits.
