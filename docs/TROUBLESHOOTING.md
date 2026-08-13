# Troubleshooting

## `npm ci` Fails In `node-pty`

`node-pty` runs an install script that selects a prebuilt binary or falls back
to `node-gyp`. Do not use `npm ci --ignore-scripts`; the MCP needs the native
terminal module.

First confirm a supported Node version:

```bash
node --version
npm --version
```

Use Node 22, 24, or 26 for the first public beta.

Windows fallback compilation requires Python and Microsoft Visual Studio Build
Tools with the Desktop development with C++ workload. Reopen PowerShell after
installation, then run `npm ci` again.

Ubuntu/Debian fallback compilation requires:

```bash
sudo apt-get update
sudo apt-get install -y python3 make g++
```

macOS fallback compilation requires Xcode Command Line Tools:

```bash
xcode-select --install
```

When reporting a failure, include the OS, CPU architecture, Node and npm
versions, and the first relevant `node-gyp` error. Remove usernames and local
paths.

## Codex Cannot See The Tools

Open a fresh Codex task after installation or registration changes. MCP server
schemas and process environment are loaded when the client starts the server.

Confirm the registration:

```bash
codex mcp get rail-connector
```

Then call `get_claude_capabilities` and `status`.

If Codex starts with a narrower `PATH` than the installation shell, rerun the
installer. It records absolute Node and Claude paths on every platform and an
absolute tmux path on Linux/macOS. Manual registrations can set
`RAIL_CONNECTOR_CLAUDE_PATH` and `RAIL_CONNECTOR_TMUX_PATH` to existing
absolute executable paths.

## Bypass Mode Is Disabled

Bypass mode requires both a process policy and a per-launch confirmation. Run
the installer again with the intended policy, open a fresh Codex task, and
verify `get_claude_capabilities` reports the policy as enabled.

Never work around the gate by editing source or inventing an acknowledgement
value.

## Windows Broker Upgrade Is Refused

The broker refuses an incompatible upgrade while active managed sessions would
be stranded. Inspect `status`, wait for active work to finish, stop the named
session, then refresh the MCP process.

## Linux/macOS Session Is Refused

The tmux backend controls only sessions with valid Rail Connector ownership
metadata and the original pane identity. Capture the target first. Do not delete
or replace an unknown same-name tmux session.

## Claude Appears Busy Forever

Spinner phrases vary. Use structured state and the transcript-backed
`wait_for_claude_turn` result rather than matching one phrase. Check for trust,
approval, rate-limit, interruption, and composer attention states before sending
more input.
