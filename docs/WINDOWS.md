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

```powershell
git clone --branch v1.0.0-beta.3 --depth 1 https://github.com/SNComrade/Rail-Connector-MCP.git
cd Rail-Connector-MCP
.\install-windows.ps1
```

The default `BypassPolicy` is `Disabled`. For an explicitly authorized
single-user development host where bypass mode should be available:

```powershell
.\install-windows.ps1 -BypassPolicy LocalHost -AllowedRoot "$HOME\Projects"
```

For a disposable isolated instance:

```powershell
.\install-windows.ps1 -BypassPolicy Isolated
```

The installer runs `npm ci`, syntax checking, and the smoke test by default;
`-RunTests` adds `npm test`. It resolves absolute Node and Claude executables,
probes Codex CLI candidates with `--version`, and registers `rail-connector`
through the first executable candidate. It checks `codex` on `PATH`, then the
Codex Desktop bundled CLI at `%USERPROFILE%\.codex\.sandbox-bin\codex.exe`.
After registration it runs `codex mcp get rail-connector` so the command,
arguments, and process environment can be checked immediately.
Override discovery with an exact path when needed:

```powershell
.\install-windows.ps1 -BypassPolicy LocalHost -AllowedRoot "$HOME\Projects" `
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

Let any active Claude turn finish and record its `resolvedSessionId`, then:

```powershell
git fetch --tags origin
git checkout --detach "v<new-version>"
npm ci
npm test
.\install-windows.ps1 -BypassPolicy LocalHost -AllowedRoot "$HOME\Projects"
```

Open a fresh Codex task so a new MCP process and tool schema use the updated
code. A broker session from the previous version may still exist. If the broker
reports an upgrade block, finish any important work, then call
`stop_remote_control` with
`force: true` for the named session. Token-derived brokers from versions that
support compatibility cleanup can be drained without reopening the previous
Codex task. A broker predating that protocol still requires its original MCP
process.

Builds that used the historical predictable pipe are intentionally not probed
by the current MCP. Stop those sessions with the old MCP task, or terminate that
old broker only after confirming no work is active. The current token-derived
broker can otherwise run independently.
