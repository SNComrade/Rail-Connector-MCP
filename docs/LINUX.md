# Linux / WSL Install

Use this path for native Linux or WSL when **Codex and Claude Code are also
installed in that same Linux environment**.

```text
Linux/WSL Codex -> Linux node -> this MCP -> Linux/WSL Claude Code -> tmux
```

The Linux backend uses `tmux`. The managed Claude session is detached from the
MCP server process and can survive a Codex/MCP restart.

> **WSL note:** use this path only if your Codex **and** Claude Code both run
> inside WSL. If your Codex/Claude are native Windows, follow
> [Windows Install](WINDOWS.md) instead - do not register a native Windows Codex
> against a WSL install, or it will read WSL-side paths and Claude logs instead of
> your native Windows environment.

## 1. Install System Packages

Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y git curl tmux nodejs npm
```

If your distro ships an old Node.js, install Node.js 22+ from NodeSource,
`nvm`, or your preferred package manager.

`node-pty` normally uses a compatible prebuilt binary. If `npm ci` reports a
native-module build failure, install `python3`, `make`, and `g++`, then retry.

Verify:

```bash
node --version
npm --version
tmux -V
```

Node.js must be major version 22, 24, or 26. Use tmux 3.2 or newer; per-session launch
environment isolation relies on `new-session -e`, and metadata safety targets
the original pane ID when updating its containing session.

If `npm ci` reports a native-module build error, confirm the active `node` and
`npm` are from the same Linux/WSL environment:

```bash
command -v node
command -v npm
node -p "process.platform"
```

Expected platform output is:

```text
linux
```

## 2. Install And Authenticate Claude Code

Install Claude Code using Anthropic's current official instructions, then run:

```bash
claude
```

Complete the login flow in this same Linux/WSL environment before installing
this MCP. Do not authenticate native Windows Claude and expect a WSL MCP to see
that login; those are separate OS profiles and separate Claude log folders.

## 3. Clone And Install

```bash
git clone --branch v1.0.0-beta.3 --depth 1 https://github.com/SNComrade/Rail-Connector-MCP.git
cd Rail-Connector-MCP
./install.sh
```

The smoke test should show all fourteen MCP tools, including
`wait_for_claude_turn`, rename, and local archive controls, plus a
status block with:

```json
{
  "backend": "tmux"
}
```

For targeted troubleshooting, the test suite can be run in smaller pieces:

```bash
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
npm run test:tmux
```

`test:tmux` creates isolated test sessions and validates ownership refusal plus
atomic multi-line prompt transport. GitHub Actions runs the same integration on
clean Ubuntu runners across the supported Node matrix.

## 4. Register With Codex

`install.sh` registers the MCP with bypass disabled and immediately reads the
registration back. To intentionally enable local-host bypass, rerun it with:

```bash
./install.sh --bypass-policy LocalHost --allowed-root "$HOME/projects"
```

Use `--bypass-policy Disabled` to remove the opt-in or `Isolated` for the legacy
disposable-environment acknowledgement. The equivalent manual commands are:

```bash
# Bypass disabled
codex mcp add rail-connector \
  --env RAIL_CONNECTOR_CLAUDE_PATH="$(command -v claude)" \
  --env RAIL_CONNECTOR_TMUX_PATH="$(command -v tmux)" \
  -- "$(command -v node)" "$PWD/src/index.js"

# Explicitly authorized local development host
codex mcp add rail-connector \
  --env RAIL_CONNECTOR_CLAUDE_PATH="$(command -v claude)" \
  --env RAIL_CONNECTOR_TMUX_PATH="$(command -v tmux)" \
  --env RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS=I_UNDERSTAND_BYPASS_CAN_MODIFY_MY_HOST_WITHOUT_PROMPTS \
  -- "$(command -v node)" "$PWD/src/index.js"

codex mcp get rail-connector
```

Automated policy registration requires `--env`. If an older Codex CLI does not
advertise that option in `codex mcp add --help`, update Codex or use that
client's MCP/server configuration surface to set the same environment entry
without replacing unrelated configuration.

Run registration from the same Linux/WSL Codex environment that should use the
tool. A native Windows registration, including its environment, does not
propagate into a Codex process inside WSL through SSH, a proxy, or a gateway.
The installer records the absolute paths returned by `command -v node`,
`command -v claude`, and `command -v tmux`. If an
`nvm` upgrade removes that versioned path, rerun the installer to refresh the
registration.

The policy is read once when the MCP process starts. Open a fresh Codex task
after registration so a newly spawned process inherits it. If a managed Codex
app-server still holds the old MCP transport, reload only that daemon:

```bash
codex app-server daemon restart
```

For environments whose access runbook requires Codex remote control, re-enable
that app-server feature afterward with
`codex app-server daemon enable-remote-control`.

Applying an MCP environment change does not require restarting WSL or any
unrelated service.

The tool namespace should appear as:

```text
mcp__rail_connector
```

## 5. Path Examples

Use Linux paths for `cwd`:

```json
{
  "cwd": "/home/you/project"
}
```

For WSL, use WSL paths, not Windows paths:

```json
{
  "cwd": "/home/you/projects/my-project"
}
```

Avoid registering a native Windows Codex instance to this WSL install. If Codex
is native Windows, use [Windows Install](WINDOWS.md).

## 6. Optional Allowed Roots

Set `RAIL_CONNECTOR_ALLOWED_ROOTS` when you want the MCP to reject accidental
`cwd` values outside trusted Linux/WSL folders. Use `:` between roots on
Linux/macOS:

```bash
export RAIL_CONNECTOR_ALLOWED_ROOTS="/home/you/projects:/home/you/work"
```

If Codex starts MCP servers from a config file or desktop environment, set the
environment variable there before the MCP process starts.

## 7. Skill Validation On Ubuntu

Skill validation is separate from MCP runtime. Ubuntu may block global Python
package installs through externally managed Python, so use an isolated virtualenv:

```bash
python3 -m venv ~/.local/share/rail-connector-mcp-venv
~/.local/share/rail-connector-mcp-venv/bin/python -m pip install PyYAML
```

Then validate the bundled skills:

```bash
for skill in \
  .agents/skills/rail-reviewer \
  .agents/skills/rail-operator \
  .agents/skills/rail-debugger
do
  ~/.local/share/rail-connector-mcp-venv/bin/python \
    ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py "$skill"
done
```

## 8. Quick Test Prompt

```text
Use the rail-connector MCP. Show status, list my latest Claude sessions for my
current project, and tell me whether a Claude remote-control tmux session is
already running.
```

## 9. Linux Operator Pattern

For normal Linux/WSL operation:

```json
{
  "cwd": "/home/you/project",
  "managedSession": "rail-connector-managed",
  "remoteName": "Rail-Connector",
  "permissionMode": "default",
  "killExisting": false,
  "trustWorkspace": false,
  "resumeChoice": "none"
}
```

Then send work with `submit_prompt`:

```json
{
  "managedSession": "rail-connector-managed",
  "text": "Review the current repo state. Return: Findings, Recommended changes, Residual risk.",
  "pasteMode": "auto",
  "submitRetries": 1,
  "lines": 200
}
```

On Linux, `pasteMode: "auto"` uses an atomic bracketed tmux buffer paste bound
to the exact managed pane.

## Troubleshooting

### `npm ci` fails compiling native modules

Install build tools, then retry:

```bash
sudo apt install -y python3 python3-venv make g++
npm ci
```

### `tmux: command not found`

Install tmux:

```bash
sudo apt install -y tmux
```

### No Claude sessions found

Make sure the `cwd` you pass matches the project directory used by Claude Code.
Claude stores logs under:

```text
~/.claude/projects/
```

For example, `/home/you/project` maps to a Claude project log directory similar
to:

```text
~/.claude/projects/-home-you-project
```

### Claude exits during startup

Run `claude` directly in the same Linux/WSL shell and complete authentication.
Then retry `start_remote_control`.

### Existing tmux session is already running

The MCP captures or replaces a tmux session only when it has valid Rail launch
metadata and its recorded `cwd`, exact pane ID/PID, and requested posture pass
validation. Switching the visible active pane does not redirect MCP input. A
same-name session created manually or by another program is refused rather than
adopted.

Metadata updates also compare the recorded `startedAtMs` generation and target
the original pane ID. A delayed update cannot be written onto a same-name
replacement session.

New launches also store only sanitized UltraCode-relevant child environment
categories. The tmux session receives explicit `CLAUDE_CONFIG_DIR`, effort,
workflow-disable, and color values from the launching MCP, so an older tmux
server environment cannot silently replace those launch inputs. Raw values are
not returned in posture metadata.

For a managed Rail session, capture it:

```json
{
  "managedSession": "rail-connector-managed",
  "lines": 160
}
```

To replace a managed Rail session, first capture it, wait until it is idle, and
record its exact `resolvedSessionId`. Then call `start_remote_control` with:

```json
{
  "killExisting": true
}
```

Replacement proceeds only after stop is confirmed. If stop returns
`stop_timeout`, inspect and retry; do not assume the old pane was replaced.

`submit_prompt` sends multi-line text through `tmux load-buffer` and an atomic
bracketed buffer paste. It does not place literal prompt text in a shell command
or take control of an unmanaged pane. After the first Enter, submission polls a
short bounded visibility window for delayed pasted-text placeholders before
deciding whether one retry Enter is needed.

### `cwd is outside RAIL_CONNECTOR_ALLOWED_ROOTS`

Choose a `cwd` under one of the allowed Linux paths, or update
`RAIL_CONNECTOR_ALLOWED_ROOTS` and restart the MCP process.

### Codex cannot see `mcp__rail_connector`

Confirm registration from the same Linux/WSL environment:

```bash
codex mcp get rail-connector
```

Then open a fresh Codex task so the MCP tools are reloaded. In a daemon-managed
environment where that does not replace the MCP process, use the targeted
`codex app-server daemon restart` command described above.

### Bypass still reports disabled after registration

Confirm the exact registration in the same Linux/WSL account:

```bash
codex mcp get rail-connector
```

Then call `get_claude_capabilities` and `status`. The capability response reports
whether the policy value was configured and recognized; `status.mcpProcess`
reports the MCP PID and startup time. The policy is process-startup state, so an
old PID cannot observe a registration change. Open a fresh Codex task, then use
the targeted app-server reload only if the old MCP transport remains. Do not
restart unrelated WSL or project services to solve this condition.
