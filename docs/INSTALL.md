# Install Guide

Install the MCP in the same OS context as Codex and Claude Code.

- [Windows Install](WINDOWS.md)
- [Linux/WSL Install](LINUX.md)
- [macOS Install](MACOS.md)

The commands below use mutable `main`. To install a published release, use
the instructions shipped in its immutable tag; older installers do not define
all current switches.

## Requirements

- Node.js 22, 24, or 26
- npm
- Claude Code installed and authenticated
- Codex Desktop or Codex CLI
- tmux 3.2 or newer on Linux/macOS
- Git

## Native Install

Linux/macOS:

```bash
git clone https://github.com/SNComrade/Rail-Connector-MCP.git
cd Rail-Connector-MCP
./install.sh
```

Windows:

For an existing installation, first follow the [Windows upgrade order](WINDOWS.md#upgrade),
including authorized session stops and old-broker shutdown through the old client.
Then close MCP clients using the checkout and use a separate PowerShell window.
`-ClientsClosed` acknowledges that preparation; it performs none of those steps.

```powershell
git clone https://github.com/SNComrade/Rail-Connector-MCP.git
cd Rail-Connector-MCP
.\install-windows.ps1 -ClientsClosed
```

To expose explicitly authorized local-host bypass mode on Linux/macOS:

```bash
./install.sh --bypass-policy LocalHost --allowed-root "$HOME/projects"
```

On Windows:

```powershell
.\install-windows.ps1 -BypassPolicy LocalHost -AllowedRoot "$HOME\Projects" -ClientsClosed
```

Use `-CodexPath <absolute-path>` when Codex CLI discovery needs an explicit
override. The installer probes candidates with `--version` and knows the Codex
Desktop bundled path under `%USERPROFILE%\.codex\.sandbox-bin`.

`Disabled` is the default on both installers and removes the bypass environment
entry from the new registration. `Isolated` selects the legacy disposable-
environment acknowledgement. Each installer runs the repository checks,
registers through `codex mcp add`, and reads the result back with
`codex mcp get rail-connector`.

Automated policy registration requires a Codex CLI whose `mcp add --help`
advertises `--env`. Update an older CLI or use the client's MCP/server
configuration surface when that option is unavailable.

The registration environment is inherited only when Codex starts the MCP
process. Open a fresh Codex task after registration or a policy/schema change.
If a daemon-managed Codex environment still owns the old MCP transport, use its
targeted app-server reload rather than restarting WSL or unrelated project
services.

## Verify In Codex

The expected MCP tools are:

- `list_claude_sessions`
- `get_claude_session`
- `get_claude_result`
- `start_remote_control`
- `capture_remote_control`
- `wait_for_claude_turn`
- `send_text`
- `submit_prompt`
- `send_key`
- `rename_claude_session`
- `archive_claude_session`
- `unarchive_claude_session`
- `stop_remote_control`
- `get_claude_capabilities`
- `status`

Call `get_claude_capabilities` and `status` first. On Windows, `status` should
report the persistent broker backend even before a managed session exists.
Machine-wide Claude agent details require `includeAgentDetails: true`.

## Upgrade

For a release install, first complete the platform-specific prerequisites below.
On Windows, old-client stops, closed clients and unchanged-target CheckOnly must
precede tag checkout or any other source/dependency replacement. Then fetch and
check out the immutable tag shown in its release notes. A deliberate `main`
development checkout may instead use `git pull --ff-only origin main`.

Linux/macOS:

```bash
git fetch --tags origin
git checkout --detach "v<new-version>"
./install.sh --bypass-policy LocalHost --allowed-root "$HOME/projects"
```

Windows: follow the complete [Windows upgrade order](WINDOWS.md#upgrade)
**before `git pull`, `npm ci`, or any native dependency replacement**. Through
the old client, stop only authorized sessions, verify their exits, shut down the
old broker through its authenticated no-start route, then close affected clients.
For the first transition, use the reviewed new checkout's installer with
`-CheckOnly -ClientsClosed -TargetRoot <old-checkout>` while the old target is
unchanged. A missing old shutdown route or uncertain ownership blocks replacement.

After that check, keep clients closed, update the target and run its new
installer with `-ClientsClosed`; it repeats the guard before dependency
replacement and registration. Choose the same bypass policy or explicitly select
`Disabled`. Custom-state registration needs the separate documented route.
CheckOnly performs no replacement, but its Restart Manager query creates transient
Windows session state. It is not an atomic lock or permission to stop unrelated
work. Reopen a fresh Codex task only after the guarded upgrade and verification.

For Linux/macOS, use the existing policy or explicitly choose `Disabled`, then
open a fresh Codex task to load the new schema and process environment.

## CI Coverage

GitHub Actions runs the portable suite on Windows, Ubuntu, and macOS with
Node.js 22, 24, and 26. Separate workflows run the production dependency
audit, dependency review, CodeQL, full-history secret scan, and release package
checks. Platform jobs also cover the Windows installer/wrapper and broker, the
Unix installer, Linux/macOS tmux ownership, prompt transport, and skills.
The account-consuming real Claude acceptance test remains an explicit local test.

## Uninstall

Finish or stop every managed Claude turn before removing the registration. Then
run `codex mcp remove rail-connector`, open a fresh Codex task, and confirm
`codex mcp get rail-connector` no longer resolves. The source checkout and
`~/.rail-connector-mcp` or `%USERPROFILE%\.rail-connector-mcp` state can be
removed separately after reviewing any local archive metadata. Uninstalling
Rail Connector never deletes Claude Code transcripts under the Claude profile.

## OS Boundary

Native Windows Codex and Claude require a native Windows MCP install. Codex and
Claude running together inside WSL require a WSL install. Do not cross these
boundaries merely to reuse one configuration: credentials, logs, process
control, and filesystem paths are OS-local.
