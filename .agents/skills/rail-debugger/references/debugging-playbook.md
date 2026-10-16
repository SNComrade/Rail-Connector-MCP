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
- A `claudeCliVersion` that differs from an earlier start is not a failure by
  itself: Claude Code can update itself between two starts (a native install
  uses a downloaded update at the next start). Report it and carry on unless a
  tool reports a problem.
- If a keyword workflow will run under `dontAsk`, the session needs a Workflow
  allowance at launch; without one Claude denies the Workflow call and no
  workflow runs (seen live). The verified allowance is `tools: ["Workflow"]`
  plus `allowedTools: ["Workflow"]`; a wider `tools` list or `allowedTools`
  alone is not verified.
- On Unix, inspect `status.tmuxCompatibility`; tmux 3.2 or newer is required
  because managed launch uses `new-session -e`. An older tmux may still expose
  an already-running session for read-only reconnection, but cannot create or
  replace one.
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
- Inspect `ultracode.capabilityStatus`, `supportSource`, `argumentProbe`, and
  `environment`. A non-`xhigh` `CLAUDE_CODE_EFFORT_LEVEL` or
  `CLAUDE_CODE_DISABLE_WORKFLOWS=1` in the MCP process is blocking; correct the
  registration or process environment and start a fresh MCP process.
- Interpret `advertisedAsEffort: false` and `helpListsUltracode: false` as
  "not listed by help," not "unavailable." Check
  `supportedByInstalledVersion`, `launchMechanism`, and `launchArgument` before
  deciding whether the MCP can make the direct request.
- Check `argumentProbe.exitCode` and `controlExitCode`. Acceptance requires a
  completed zero/nonzero pair. Treat timeout or termination as inconclusive;
  changed stderr wording alone is not rejection. The documented direct launch
  floor is Claude Code v2.1.203.
- Use `ultracode: true` and `confirmUltracode: true`.
- Omit ordinary `effort` and `safeMode`.
- Confirm the selected launch mechanism. Current Claude builds may support
  direct `--effort=ultracode`; older builds may expose only the compatibility
  settings request.
- Inspect `posture.ultracodeAssessment` after launch and after a substantive
  turn. Separate parser acceptance, runtime effort, workflow activity, and
  trigger attribution. `xhigh_correlated_unconfirmed` is not confirmed
  UltraCode; `workflow_activity_observed` still leaves the workflow trigger
  unknown.
- Inspect `ultraEffortAttachment.active`, `lifecycle`, `lastTransition`, and
  `historyCoverage`. A latest enter produces `attachment_lifecycle_active`; a
  later exit produces `exited_after_entry`. Treat a skipped or partial range as
  unknown until a later complete transition restores the current state; keep
  history coverage partial after that recovery. Attachment transitions
  authenticate client-side mode changes, not server-side workflow execution.
- Inspect `attentionStatus` independently. A blocking launch environment,
  conflicting bound effort, or terminal rejection takes precedence in the
  primary status without erasing the recorded lifecycle.
- Compare `launchEnvironment` with `currentMcpEnvironment`. A `different`
  result after refresh can be legitimate; diagnose the original child from its
  persisted sanitized launch snapshot. `launch_not_recorded` means older
  metadata, not permission to infer launch state from the current MCP process.
- Any bound effort other than `xhigh` or `ultracode`, such as `high` or `max`,
  is conflicting evidence. Remote Control web may show `Extra` for underlying
  xhigh while UltraCode is active. Treat a session-bound web `Extra` as
  compatible presentation only; it confirms and disproves nothing, and
  context-free terminal text remains unmapped. Verify that the view belongs to
  the same managed name, conversation UUID, generation, and time window.
- On an idle, empty composer, `/effort ultracode` returning the explicit
  UltraCode setting is current-setting evidence. It may change posture, so it
  cannot prove launch provenance. A trivial prompt cannot validate workflows.
- Claude's UI may display the underlying `xhigh` effort while UltraCode is
  requested. Do not require the footer to display the literal word
  `UltraCode`.

For a bounded local transport investigation, start a separate diagnostic
session with `debug: true` and optionally `debugFilter: "api,!statsig"`. Confirm
capabilities advertise `--debug-file`, then inspect `debugLog.status`,
`identityMatch`, `launchBindingMatch`, and `sizeBytes`. The MCP returns no
contents. The retained log is sensitive. Windows reports
`ready_acl_unverified` because mode bits are not ACL proof, and debug timing
cannot authenticate Anthropic's server-side effort state.

## Windows Session Missing Or Stale

Windows sessions live in the per-user broker, not one MCP stdio process.

1. Call `status`.
2. Inspect broker availability, PID, state directory, and managed sessions.
3. Reuse the exact `managedSession` after a Codex refresh. Take its
   `generationId` and `startedAtMs` from `status` and pass them as
   `expectedGenerationId` and `expectedStartedAtMs`, always together, to
   `capture_remote_control`, `submit_prompt`, `rename_claude_session`,
   `stop_remote_control` and `wait_for_claude_turn`. Pass them to the wait
   only together with that generation's `waitAfterCursor`; otherwise wait by
   name. A stale-generation error (code `ESTALE`, which callers do not see; the
   text says the generation changed, refuses a stale operation, or rejects the
   `afterCursor`) means the name now belongs to another generation or none, or
   the cursor or conversation does not match (see Wait Returns Wrong Or Old
   Output). That call reached no other generation; only if Claude exited
   during the call and another start took the name can input sent earlier in
   it have reached the old session (from the code; not seen live).
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
- `active_input_not_empty` (or `awaiting_input` on a graceful stop) on a
  composer nobody typed in can be a dimmed prompt suggestion. Managed launches
  set `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` on both backends unless
  `start_remote_control` received `promptSuggestions: true`. Suggestions can
  still appear through that opt-in, a Claude settings `env` entry or wrapper,
  Claude before 2.1.238, or a session launched before this default or by an
  MCP process not yet restarted on it. The setting is not recorded or compared
  for an existing session; replace the session to be sure. `killExisting` is
  refused while composer text shows, and `forceKillExisting` also discards a
  real draft, so inspect the capture first.
- JSONL acknowledgement should distinguish an accepted prompt from text still
  sitting in the composer.
- A large paste placeholder can appear after the first capture. Submission
  polls a bounded visibility window before deciding whether to retry Enter.
- Windows bracketed paste has a settle delay before Enter and is used only
  when the xterm application mode reports it enabled. Compare
  `bracketedPasteRequested` with `bracketedPasteUsed`.
- Keyword `submit_prompt` can fail with `EPASTEMODE`. If the message says no
  input was sent, bracketed paste was not active before the prefix and nothing
  reached the composer. If the mode changed after the prefix was sent, the
  broker sent nothing more (no further body, closing frame, or Enter) and the
  generation is recovery-only (`status` shows `recoveryOnly: true`). Do not
  retry the prompt there: capture it to see what reached Claude, stop it with
  `force: true` plus the `generationId` and `startedAtMs` from `status` passed
  as `expectedGenerationId` and `expectedStartedAtMs`, then start a new
  session. The mode checks are a timing window, not acknowledgement: one more
  chunk can arrive as ordinary typing, and a line break in it can submit part
  of the prompt.
- `preflight_blocked` should not be retried blindly.
- A forced `submit_prompt` reports `forceUsed` and `forcedPastReason`; preserve
  both when diagnosing why a prompt crossed its preflight gate.
- Native-Windows `pasteMode: "keyword"` requires an empty composer even with
  `force: true`. A draft or paste placeholder returns `preflight_blocked` with
  `active_input_not_empty` or `paste_pending`, `forceUsed: false`, and
  `forceRefused: true` when force was requested. No text or Enter was sent; the
  check holds even when pending workflow evidence would otherwise mask the
  composer state. Keyword mode does not clear a draft or a generated suggestion
  that looks like one; inspect the composer instead of retrying with force.
- `workflow_pending` means the bound session log still shows an active dynamic
  workflow or cannot prove completion, or Claude's exact `Waiting for N dynamic
  workflow(s) to finish` line still holds pending work. In CLI 2.1.289 that
  line is a permanent turn-summary row. A full, certain log with a tracked
  launch overrides it; a missing, `head_tail`, uncertain, or launch-free log
  lets the row keep holding pending work. Do not submit or press Enter over a
  pending workflow; test aliases such as `C-m`, `C-j`, and `KPEnter` when
  diagnosing a bypass. If release fails, confirm in Claude that the workflow
  finished; then, with authorization and only when `terminalState` is
  otherwise idle and the composer is empty, repeat the blocked mutation (not
  `wait_for_claude_turn`, which takes no `force`) with `force: true`.
- Native Windows returns `EINVAL` for an unsupported key name. Do not retry by
  sending that name as composer text.
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
- A matching assistant completion cannot supersede `workflowPending: true`.
  Release needs terminal evidence for a tracked launch that bound both a task
  ID and a run ID, no older than the latest workflow observation: a direct
  terminal record with the matching run ID, a completed `TaskOutput` retrieval
  on older CLIs, Claude's own task-notification record, or the per-conversation
  workflow snapshot in a fresh native-Windows conversation. A current bound
  interruption clears the tracked set. Claude 2.1.289 has no `TaskOutput` tool
  (a call fails with "No such tool available"); a notification status of
  `completed`, `failed`, `killed`, or an older terminal word releases, while
  `blocked` or any other status keeps it pending. Counters (zero included),
  worker output, an idle composer, and `end_turn` never clear identified work.
  Inspect `workflowPendingEvidence`, `workflowPendingCount`, and
  `workflowPendingObservedAt`; when pending is false, the evidence and observed
  time should be empty rather than retaining a historical task. Also inspect
  `terminalState`, `workflowObservationCoverage`, and
  `workflowObservationSkippedBytes`. `head_tail` means the first cold read
  bounded a large log. If `workflowObservationUncertain` is true, the skipped
  middle prevents proof of current workflow completion: head-only posture is
  discarded, the log-derived current pending count is null, and ordinary
  mutations fail closed. The same incomplete state can follow a trailing JSONL
  fragment that exceeds the bounded record buffer; a later counter does not
  erase that skipped record. If the terminal independently exposes the exact
  workflow wait control line, its count and evidence take precedence while
  `workflowObservationUncertain` remains true.
  An explicit global workflow count or bound interruption in the observed tail
  can restore current-state certainty, but the MCP does not replay the skipped
  middle: coverage stays `head_tail` and the skipped-byte count remains. That
  observation cannot earn snapshot completion or override Claude 2.1.289's
  waiting row, and a counter still cannot clear known pending workflows.
  A matching workflow task result alone may leave
  uncertainty because an unseen middle record could have launched another
  task. If the workflow stays pending, confirm in Claude that it has finished,
  then repeat the blocked mutation (not `wait_for_claude_turn`, which takes no
  `force`) with `force: true` and verify its `forceUsed` or
  `workflowInterrupted` result.
- Check `textLength` and `textTruncated` before diagnosing a large report as
  incomplete.
- `needs_attention` is expected for approval, trust, limit, interruption,
  paste, or exit states. The MCP recognizes an approval prompt only when the
  screen shows an approval question with a `Yes, and don't ask again` or
  `No, and tell Claude what to do differently` choice. A workflow approval
  prompt in `default` mode may use other choices and end the wait in `timeout`
  instead (not verified); capture before waiting again.
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
- Rename `force` may bypass only `workflow_pending`; it must remain blocked by
  approval, trust, draft, paste, exit, or any other non-idle `terminalState`.
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
If the reason is `awaiting_input`, preserve the unsent draft: submit or discard
it only with explicit authorization, or leave the session running. When prompt
suggestions are on, untyped suggestion text reports the same reason and cannot
be told apart from a draft, so treat it as one. If a bound session reports
`workflow_pending`, wait for the MCP to release it from evidence bound to the
tracked task. If Claude shows that the workflow finished but the MCP still holds
it, for example Claude 2.1.289's permanent `Waiting for N dynamic workflows to
finish` row while `workflowObservationCoverage` is `head_tail`, repeat the stop
with `force: true` after accepting interruption.
`force: true` accepts interruption. A timeout or still-running backend must not
be reported as stopped. Windows force-stop closes the owned ConPTY session and
does not add a separate `taskkill` by PID. On a native-Windows `stop_timeout`,
or after a keyword send that the broker stopped part-way because
bracketed-paste support changed (`EPASTEMODE` after the prefix or part of the
body was sent; an `EPASTEMODE` raised before any input was sent does not do
this), the session stays tracked as recovery-only (`status` shows
`recoveryOnly: true`). Prompts, keys, rename, `killExisting` replacement and
name-only stop are refused.
Inspect it with `capture_remote_control`, then retry `stop_remote_control` with
`expectedGenerationId` and `expectedStartedAtMs` taken from the `stop_timeout`
reply or from the session's `generationId` and `startedAtMs` in `status`.
On native Windows, `stop_timeout` comes only from a forced stop. After it,
retry once with the pair and `force: true`: a paired stop without `force` does
not repeat the termination. If it returns `stop_timeout` again, do not loop;
report it, because the process must end outside the MCP and the broker cannot
be upgraded while it tracks the session. After a partial keyword send, add
`force: true` after inspection when the capture is not idle, or when a paired
stop without it returns `graceful_stop_timeout`. On tmux, `stop_timeout` only
means tmux still lists the session after `kill-session`, and a stop without
`force` can return it too; it carries no pair, leaves no recovery-only state,
and tmux refuses the pair (`EUNSUPPORTED`). Report it instead of following the
Windows retry (from the code; not seen live). A forced stop discards any
unsent draft, in-flight turn, pending approval and running workflow. Do not
retry the prompt in that session; start a new one.

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
