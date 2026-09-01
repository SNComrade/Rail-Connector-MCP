# Linux / WSL Skill Setup

This repo includes Codex repo-scoped skills under:

```text
.agents/skills/
```

These skills are intended to work in Linux/WSL without requiring Windows-only
runtime components. For Linux/WSL, the active Rail Connector backend is `tmux`.

MCP registration does not install user-scope skills. Follow [Skill
Installation](SKILL_INSTALL.md) when the skills must be discovered from
unrelated repositories, then open a fresh Codex task.

## Active Skills

- `rail-operator`
- `rail-reviewer`
- `rail-debugger`

## Runtime Requirements

For using the MCP and skills from Linux/WSL:

```bash
node --version
npm --version
tmux -V
claude --version
```

The skills do not require Python at runtime. Python is only needed for Codex's
skill validator.

## Validation Requirements

Codex's skill validator is a Python script. On Ubuntu and many modern Linux
systems, system Python is externally managed, so do not force-install packages
into it. Use a small isolated virtualenv:

```bash
python3 -m venv ~/.local/share/rail-connector-mcp-venv
~/.local/share/rail-connector-mcp-venv/bin/python -m pip install PyYAML
```

Validate each skill separately:

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

Expected result for each skill:

```text
Skill is valid!
```

## Linux-Specific Operation Notes

- Register through `./install.sh`; use `--bypass-policy LocalHost` only when the
  operator explicitly authorizes local-host bypass. The installer verifies the
  result with `codex mcp get rail-connector`.
- MCP registration and environment are local to this Linux/WSL Codex instance.
  A native Windows registration does not propagate through SSH or a proxy.
- After a policy or tool-schema change, open a fresh Codex task and compare
  `get_claude_capabilities` with `status.mcpProcess.pid` and `startedAt`. Use a
  targeted `codex app-server daemon restart` only if the old transport remains;
  do not restart WSL or unrelated services for this change.
- Use Linux paths for `cwd`, such as `/home/<you>/project`.
- Use the task workspace as `cwd`, not automatically this MCP repo path.
- `submit_prompt` uses Unicode-safe chunking plus an atomic bracketed tmux
  buffer paste on Linux/WSL.
- Managed `tmux` sessions can survive Codex/MCP restarts.
- MCP-created tmux sessions retain launch metadata for requested-posture
  comparisons across MCP restarts. Capture, input, and stop operations require
  valid Rail ownership metadata; unmanaged same-name sessions are refused.
- It is normal for `status` to return an empty `managedSessions` array when no
  validated Rail tmux session exists.
- `status` reports only validated managed sessions; it does not expose arbitrary
  same-user tmux session names or commands.
- If using `RAIL_CONNECTOR_ALLOWED_ROOTS`, separate allowed roots with `:`.

Example allowed roots:

```bash
export RAIL_CONNECTOR_ALLOWED_ROOTS="/home/<you>/projects:/home/<you>/work"
```

## Avoid Windows-Only Assumptions

Do not require these on Linux skill workflows:

- PowerShell
- WindowsApps Codex aliases
- `C:\path\...` paths
- Visual Studio Build Tools
- Native Windows Claude profiles

Those belong only to the native Windows install path.
