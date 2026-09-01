# Repo Skills

The repo-scoped Codex skills live under:

```text
.agents/skills/
```

## Active Skills

- `rail-operator` operates start, resume, prompt, wait, capture,
  rename, archive, reconnect, and stop workflows.
- `rail-debugger` diagnoses registration, capability resolution,
  broker/tmux lifecycle, input transport, transcript binding, and posture.
- `rail-reviewer` runs independent report-only Claude reviews.

Each skill contains:

```text
SKILL.md
agents/openai.yaml
references/
```

Repo-scoped discovery works when the Codex task is inside this checkout. To use
the skills from unrelated projects, invoke Codex's native `$skill-installer`
with each GitHub skill directory, then open a fresh Codex task. Installing the
MCP does not silently copy user-level skills. In every mode, pass the actual
task project as `cwd`; Claude's local session logs are grouped by that path.

Installed user-scope copies do not update automatically. Follow [Skill
Installation](SKILL_INSTALL.md) to reinstall reviewed tagged skill directories,
then open a fresh Codex task. Skill installation remains separate from MCP
registration.

## Current Operating Model

The skills teach agents to:

- inspect installed Claude capabilities before launch
- resolve semantic permission posture dynamically
- use the dedicated Ultracode request and confirmation
- use explicitly authorized local-host bypass when requested
- prefer `submit_prompt` plus `wait_for_claude_turn`
- recover truncated answers with record-scoped `get_claude_result` identities,
  Unicode character offsets, and separate SHA-256 content verification
- reconnect to the persistent Windows broker after a Codex task refresh
- distinguish Remote Control name, managed terminal name, title, and UUID
- serialize shared-session mutations and avoid typing over busy work
- use local archive sidecars without changing Claude transcripts
- report requested, resolved, and observed posture accurately
- inspect launch audit receipts without treating allowed roots, tool argv, or
  an isolated policy assertion as verified runtime isolation
- distinguish UltraCode parser acceptance, xhigh correlation, workflow
  activity, conflicts, and unknown trigger attribution
- use explicit Fable 5 and Opus 5 bypass-plus-UltraCode launch recipes only
  when the user requests that posture
- distinguish built-in Claude tool filters from connected MCP and connector
  tools, whose availability must be assessed separately

## Validation

Run the native Codex validator against all three skills:

```powershell
$python = 'C:\path\to\python.exe'
$validator = "$env:USERPROFILE\.codex\skills\.system\skill-creator\scripts\quick_validate.py"
Get-ChildItem .\.agents\skills -Directory | ForEach-Object {
  & $python $validator $_.FullName
}
```

The validator requires PyYAML. Use the Codex bundled Python when it has that
dependency or an isolated virtual environment:

```powershell
py -3 -m venv "$env:USERPROFILE\.venvs\rail-skills"
& "$env:USERPROFILE\.venvs\rail-skills\Scripts\python.exe" -m pip install PyYAML
```

`npm test` also performs repository-level structural skill checks along with
the MCP suites.

See [Windows Skill Setup](SKILLS_WINDOWS.md) and
[Linux/WSL Skill Setup](SKILLS_LINUX.md) for OS-specific validation commands.
