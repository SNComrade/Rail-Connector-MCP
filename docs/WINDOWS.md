# Windows Install

## Native Windows Contract

Use native Windows when Codex Desktop and Claude Code run on Windows:

```text
Codex Desktop -> native Windows Node.js -> this MCP -> native Windows Claude
```

Do not install the MCP in WSL to control native Windows Claude. WSL has separate
paths, credentials, processes, and `~/.claude/projects` logs. Use WSL only when
Codex, this MCP, and Claude all run inside that same WSL environment.

## Prerequisites

The native broker uses the bundled ConPTY backend from exactly pinned
`node-pty 1.2.0-beta.15`. This includes upstream's native handle-registry race
fix and avoids the legacy asynchronous console-list helper and numeric-PID
termination path. Missing bundled binaries fail launch; there is no fallback
to that legacy backend. The dependency and its DLL option remain prerelease
and experimental, so the native test matrix is required before promotion.

The checkout carries a version/hash-verified JavaScript compatibility fix for
upstream [slow worker startup](https://github.com/microsoft/node-pty/issues/955).
`npm ci` applies it through the tracked install lifecycle. It exposes an explicit
15-second child-start readiness budget within the existing 30-second broker
request window, while preserving the upstream rule that native connection waits
for worker readiness. Worker failures, cancellation and late events retain their
cleanup safeguards. The upstream default remains unchanged for callers that do
not configure the option. A Windows launch refuses missing or altered fix bytes;
`--ignore-scripts` is not a supported installation. No native binary is patched.

The client requires the matching broker build rather than reusing an older
terminal backend. This does not change an installed broker automatically.
An incomplete asynchronous start remains tracked as recovery-only until its
original generation exits or is stopped with its exact generation/start pair.

Upstream [natural-exit resource leakage](https://github.com/microsoft/node-pty/issues/965)
remains a separate limitation. An exited child or absent console helper does
not prove all native handles or descendants were released, nor that host MCP
connection retention or RAM pressure is resolved.

Install and verify in PowerShell:

```powershell
node --version
npm --version
claude --version
Get-Command node, npm, claude
```

Requirements:

- Node.js 22, 24, or 26
- npm
- native Windows Claude Code, authenticated for this Windows account
- Codex Desktop or Codex CLI
- Git

Authenticate Claude interactively once:

```powershell
claude
```

## Install

These commands use the guarded source installer. For an existing installation,
first complete the [upgrade order](#upgrade), including authorized session stops
and old-broker shutdown through the old client. Then close affected MCP clients
and use a separate PowerShell window. `-ClientsClosed` acknowledges that
preparation; it performs none of those steps.

```powershell
git clone https://github.com/SNComrade/Rail-Connector-MCP.git
cd Rail-Connector-MCP
.\install-windows.ps1 -ClientsClosed
```

The default `BypassPolicy` is `Disabled`. For an explicitly authorized
single-user development host where bypass mode should be available:

```powershell
.\install-windows.ps1 -BypassPolicy LocalHost -AllowedRoot "$HOME\Projects" -ClientsClosed
```

For a disposable isolated instance:

```powershell
.\install-windows.ps1 -BypassPolicy Isolated -ClientsClosed
```

Keep affected MCP/client applications closed; the acknowledgement never
overrides a failed guard. A fresh install
requires both absent dependencies and absent/empty broker state. Existing
dependencies with missing/invalid token state are refused, not repaired.

The installer qualifies the target, selected state, broker endpoint and exact
existing native dependency files before `npm ci`, then rechecks before
registration. It runs `npm ci`, syntax checking and the smoke test by default;
`-RunTests` adds `npm test`. It resolves absolute Node and Claude executables,
probes Codex CLI candidates with `--version`, and registers `rail-connector`
through the first executable candidate. It checks `codex` on `PATH`, then the
Codex Desktop bundled CLI at `%USERPROFILE%\.codex\.sandbox-bin\codex.exe`.
After registration it runs `codex mcp get rail-connector` so the command,
arguments, and process environment can be checked immediately.
Override discovery with an exact path when needed:

```powershell
.\install-windows.ps1 -BypassPolicy LocalHost -AllowedRoot "$HOME\Projects" -ClientsClosed `
  -CodexPath "$HOME\.codex\.sandbox-bin\codex.exe"
```

If no candidate is executable or registration fails, the installer prints the
exact Codex Desktop command, arguments, and environment value instead of
claiming success. A WindowsApps alias that resolves but returns `Access is
denied` is rejected by the probe rather than treated as usable.

Open a fresh Codex Desktop task after installation so a newly spawned MCP
process inherits the registration. The tools appear under
`mcp__rail_connector`. `status.mcpProcess` reports the active MCP PID and startup
time when process identity matters.

## Manual Codex Configuration

The equivalent global configuration is:

```toml
[mcp_servers.rail-connector]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\path\to\Rail-Connector-MCP\src\index.js']

[mcp_servers.rail-connector.env]
RAIL_CONNECTOR_CLAUDE_PATH = 'C:\path\to\claude.exe'
RAIL_CONNECTOR_ALLOWED_ROOTS = 'C:\Users\<you>\Projects;D:\Work'
RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS = "I_UNDERSTAND_BYPASS_CAN_MODIFY_MY_HOST_WITHOUT_PROMPTS"
```

Remove only the bypass environment entry when bypass should be unavailable;
keep the absolute Claude path and any intended allowed roots. Leaving a stale
bypass value in an existing registration keeps the policy enabled. The local-host policy only exposes the capability; each bypass launch still requires
`confirmBypassPermissions: true`.

## Persistent Windows Broker

Windows uses `node-pty` inside a detached, authenticated per-user broker. The
broker owns the Claude ConPTY process independently of one MCP stdio process, so
managed sessions survive a Codex task refresh or MCP client restart.
The named-pipe identity is derived from the private broker token. A changed
broker build upgrades an idle broker automatically and refuses an upgrade while
an older token-derived broker still owns active sessions. A refreshed client
can call `stop_remote_control` with `force: true` to use the authenticated,
generation-bound compatibility cleanup path. That path cannot capture terminal
content or launch commands. Ordinary cross-version mutations remain blocked.
For a running session, a stop request must ask for either graceful or forced
shutdown; `graceful: false` with `force: false` is blocked. Forced shutdown
requests termination through the broker's owned ConPTY session. The broker no
longer adds a separate `taskkill` by PID if node-pty cannot confirm exit;
node-pty's default Windows force-stop path may itself enumerate console PIDs.
On `stop_timeout`, the session remains tracked as recovery-only (`status`
shows `recoveryOnly: true`) and requires its original generation ID and start
timestamp, returned in the `stop_timeout` reply, before another cleanup lease
or stop.
An accepted client-socket error is contained to that connection. A Terminal
error marks only the affected generation recovery-only and exposes its sanitized
`terminalErrorCode` in broker metadata. Both output and input channel errors are
contained. After a channel fault, only an integer exit code is accepted as exit
evidence: node-pty can report an undefined code when a socket closes while its
child still runs. Such a generation remains tracked, and an exact-bound stop can
honestly return `stop_timeout` if node-pty never emits a later numeric exit.
Inspect the generation and use the exact-bound stop path above. Other managed
sessions stay available. The contained Terminal and accepted-client error
diagnostics record only a sanitized code, not the native error message or
request contents; this is not a promise about every existing broker diagnostic.
These safeguards do not
establish the cause of a historical broker exit or quantify host memory use.
The current build does not contact the historical predictable pipe, because
doing so would expose the token to a pipe-name squatter. A historical broker can
coexist until it is stopped through its original MCP process.
A short or corrupt token is rejected before pipe derivation and replaced with a
new random token under exclusive creation, so an empty token cannot select the
historical pipe identity.

State and logs live under:

```text
%USERPROFILE%\.rail-connector-mcp\state\v1
```

Use `status` after a refresh to discover managed sessions, then address the same
`managedSession` name with capture, prompt, wait, rename, or stop tools. Stop
sessions explicitly when finished.

The broker also serializes mutations across MCP clients. Multiple Codex agents
can inspect one session concurrently, but prompt, key, rename, replace, and stop
operations receive one exclusive renewable lease at a time. Mutations fail
closed if that lease expires or ownership changes.

The broker validates every `start` and `replace` descriptor against the
resolved Claude executable. A configured `.cmd` or `.bat` path is accepted only
through the exact `cmd.exe` wrapper form generated by this MCP. Because
`cmd.exe` can rewrite `%`, embedded double quotes, trailing backslashes, and
oversized argument vectors before the Claude process receives them, the MCP
rejects those launch-argument shapes on batch shims instead of silently
changing them. This applies to launch options such as titles and tool rules,
not prompt text sent through the PTY. Configure `RAIL_CONNECTOR_CLAUDE_PATH` to a
native Claude executable when those argument values are required.
The variable selects an operator-controlled executable or wrapper whose own
update behavior is outside the MCP's normal launcher contract. Leave it unset
to follow ordinary `claude.exe` launcher resolution. The Issue 66
rolling-runtime harness removes every case variant of the key from its isolated
child environment before qualification or live acceptance.

`status` omits machine-wide Claude agent inventory by default. Pass
`includeAgentDetails: true` only for deliberate host-wide diagnosis.
`broker.compatible` and `broker.launchPolicyCompatible` must both be true
before ordinary mutation. `force: true` stop is the only restricted
compatibility mutation. A timed-out probe is reported as `broker.running: null`
with `broker.probeError` rather than being misreported as no broker.

## Optional Allowed Roots

Pass one or more `-AllowedRoot <path>` values to the installer, or set the
environment value in Codex MCP configuration:

```powershell
$env:RAIL_CONNECTOR_ALLOWED_ROOTS = 'C:\Users\<you>\Projects;D:\Work'
```

Every entry must exist. If the variable is present but none are valid, the MCP
rejects all `cwd` values. Persistent broker sessions are checked against the
current MCP process's roots on every reconnect and operation; narrowing this
value blocks discovery, capture, and mutation outside the new scope. If a
project path disappears or a junction is retargeted while its broker session is
alive, normal operations fail closed. Force cleanup remains available only
when the broker retained its start-time canonical path and that path remains
inside a currently configured root. Missing paths from older broker records
without canonical provenance fail closed when allowed roots are configured.
`status.cleanupEligibleSessions` exposes only the managed name and cleanup
state for these no-capture recovery cases.

## Validate

From the repo:

```powershell
npm test
npm run test:installer:windows
npm run test:wrapper:windows
npm run test:package
```

The real Claude acceptance test is intentionally opt-in because it starts a
live Claude session and uses account capacity:

```powershell
$env:RAIL_CONNECTOR_LIVE_ACCEPTANCE = '1'
npm run test:live:windows
Remove-Item Env:RAIL_CONNECTOR_LIVE_ACCEPTANCE
```

It uses a temporary workspace and unique broker state, then verifies real
bypass plus Ultracode execution, clean transcript output, rename, cross-client
reconnection, stop, search, archive/unarchive, exact resume/continue, and fork.
The test removes the exact temporary Claude project-log directory it creates.
It does not rewrite shared account history files while other Claude processes
may be active.

See [Troubleshooting](TROUBLESHOOTING.md) for recovery guidance and
[Compatibility](../COMPATIBILITY.md) for the supported-platform policy.

## Upgrade

Stop before replacement, while the old client still works:

1. Let active work finish. Inspect the affected sessions through the old MCP and
   retain their exact generation/session identity. A session count alone is not
   cleanup proof.
2. Stop only the sessions whose owner has authorized stopping. A foreign lease,
   recovery-only uncertainty or unconfirmed exit blocks this upgrade; do not
   force-stop unrelated work to satisfy the installer.
3. Use the unchanged old checkout's exported client API below; broker shutdown is
   not a registered MCP tool. Keep the old client available, but quiesce all
   clients/agents that could start sessions or submit mutations. Run as the same
   Windows user, with the old registration's actual `RAIL_CONNECTOR_STATE_DIR` and
   `RAIL_CONNECTOR_CLAUDE_PATH` values when configured; do not guess or change those
   values to bypass a mismatch. Set the target and immediately verified broker
   PID from the preceding old-client inspection. Zero intentionally refuses.

   ```powershell
   $oldRoot = 'D:\existing-installed-checkout'
   $expectedBrokerPid = 0 # Replace with the verified old broker PID.
   Push-Location -LiteralPath $oldRoot -ErrorAction Stop
   try {
   @'
   import assert from "node:assert/strict";
   import {
     WINDOWS_BROKER_PROTOCOL,
     WINDOWS_BROKER_VERSION,
     windowsBrokerLaunchPolicyFingerprint,
     windowsBrokerRequest,
   } from "./src/windows-broker-client.js";

   try {
     assert.equal(process.platform, "win32");
     const expectedPid = Number(process.argv[2]);
     assert(Number.isSafeInteger(expectedPid) && expectedPid > 0);
     const options = { startIfMissing: false, timeoutMs: 5000 };
     const before = await windowsBrokerRequest("status", {}, options);
     assert.equal(before.protocol, WINDOWS_BROKER_PROTOCOL);
     assert.equal(before.version, WINDOWS_BROKER_VERSION);
     assert.equal(before.launchPolicyFingerprint,
       windowsBrokerLaunchPolicyFingerprint());
     assert.equal(before.pid, expectedPid);
     assert(Array.isArray(before.managedSessions));
     assert.equal(before.managedSessions.length, 0);
     const result = await windowsBrokerRequest("shutdown", {}, options);
     assert.equal(result?.status, "shutting_down");
     assert.equal(result.pid, expectedPid);
     console.log("Shutdown acknowledged. Close clients, then run CheckOnly.");
   } catch (error) {
     const code = /^[A-Z][A-Z0-9_]{0,39}$/.test(error?.code ?? "")
       ? error.code : "EUNKNOWN";
     console.error(`Shutdown refused or uncertain (${code}); do not update.`);
     process.exitCode = 1;
   }
   '@ | node --input-type=module - $expectedBrokerPid
     if ($LASTEXITCODE -ne 0) {
       throw 'Broker shutdown refused or uncertain; stop the upgrade.'
     }
   } finally {
     Pop-Location
   }
   ```

   This no-start call reads the existing token internally; do not copy or print
   it. Status does not expose lease ownership, so require an empty session array,
   not merely entries marked exited. Any known unresolved lease, missing/invalid
   token, incompatible build/policy, nonempty or malformed status, changed PID,
   timeout, lost reply or unexpected acknowledgment blocks the upgrade. Reconcile
   through the old owner; do not automatically replay shutdown or force cleanup.
   The server drains admitted operations and refuses live sessions, but the PID
   precheck and acknowledgment are not an atomic identity lock: other callers
   must remain quiescent. `shutting_down` acknowledges the request, not process
   exit. Do not treat `probeWindowsBroker() === null` alone as absence proof; it
   can also hide some authentication failures. Close clients next and require the
   final new-installer `CheckOnly` gate before replacement. The installer never
   kills, drains, starts or repairs a broker.
4. Close affected Codex/MCP/client applications and keep them closed throughout
   checkout/dependency replacement. Do not discard the old client before the
   preceding stops are verified.
5. Run `CheckOnly` before `git pull` or any dependency command. For the first
   transition, the old installer lacks this flag: use the reviewed new checkout's
   script against the still-unchanged old target:

```powershell
& 'D:\reviewed-new-checkout\install-windows.ps1' -CheckOnly -ClientsClosed `
  -TargetRoot 'D:\existing-installed-checkout'
```

`TargetRoot` is accepted only with `CheckOnly`. Select `-StateDirectory` when the
old MCP uses a known custom state path; otherwise verify that the default
`%USERPROFILE%\.rail-connector-mcp\state\v1` is its actual state. A guessed state
path is not ownership evidence. Custom-state automatic registration is refused
because this installer does not preserve that environment in the registration.
CheckOnly/offline qualification leaves the existing registration untouched.

After a successful check, keep clients closed and update the actual target:

```powershell
git fetch --tags origin
git checkout --detach "v<new-version>"
.\install-windows.ps1 -BypassPolicy LocalHost -AllowedRoot "$HOME\Projects" -ClientsClosed
```

The installer repeats qualification before `npm ci` and before registration;
the earlier observation is not a reusable permission token. Any present endpoint
(including an idle or incompatible broker), connection reset/abort/timeout,
ambiguous state, linked dependency path, changed inventory or native resource
owner refuses replacement. It queries exact ordinary `.node`, `.dll` and `.exe`
files in the target's local `node-pty`; missing/hoisted/unsupported native
layouts are not adopted. No token or request is sent by its connect-only probe.

Native owner observation uses only Restart Manager start/register/list/end.
These calls create transient Windows session/registry state: **CheckOnly means
no dependency/configuration replacement, not zero Windows writes**. API errors,
owner-list growth, reboot reasons and session cleanup failure refuse. A zero
result is a dated observation for those registered files, not proof of loaded
native hashes, all historical brokers, or an atomic lock against clients
reopening. Historical predictable-pipe brokers still require their old owner.

For an offline known-state compatibility migration, after the same stop order
and source update, run CheckOnly immediately before the existing postinstall:

```powershell
.\install-windows.ps1 -CheckOnly -ClientsClosed
npm run postinstall
```

Keep clients closed between these commands. A bare package command bypasses the
installer guard. For the reviewed combined compatibility fix, pristine,
readiness-only and already-combined states retain the existing 4/1/0 writes;
the guard neither changes those postimages nor accepts unknown patch bytes.
It adds no dependency-only installer mode. Do not delete state to make a refusal
look like a fresh install.

After reviewed dependency verification, reopen a fresh Codex task and read back
the new broker build and managed session identity. Source/mock checks do not
constitute an installed-primary rollout or native lock qualification. The public
installer preserves this guard contract, including custom-state refusal; source
parity alone is not native/platform qualification.
