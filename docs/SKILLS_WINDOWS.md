# Windows Skill Setup

Repo-scoped skills live under `.agents/skills/` and operate the same
`mcp__rail_connector` tools as other platforms.

## Runtime

Use native Windows Node.js and Claude from the same account as Codex Desktop:

```powershell
node --version
npm --version
claude --version
```

Windows uses the persistent per-user broker. A refreshed Codex task should call
`status` and reconnect to an existing `managedSession`; it should not assume the
Claude process ended.

## Skill Validation

```powershell
$venv = "$env:USERPROFILE\.venvs\rail-skills"
$validator = "$env:USERPROFILE\.codex\skills\.system\skill-creator\scripts\quick_validate.py"
py -3 -m venv $venv
& "$venv\Scripts\python.exe" -m pip install PyYAML
Get-ChildItem .\.agents\skills -Directory | ForEach-Object {
  & "$venv\Scripts\python.exe" $validator $_.FullName
}
```

## Windows Operator Notes

- Use native paths such as `C:\Users\<you>\project`.
- Separate `RAIL_CONNECTOR_ALLOWED_ROOTS` with `;`.
- Prefer `submit_prompt`; Windows uses bracketed paste and acknowledgement
  checks.
- Use `wait_for_claude_turn` for clean assistant output.
- Call `get_claude_capabilities` before permission or Ultracode launches.
- Local-host bypass requires the configured policy plus
  `confirmBypassPermissions: true`.
- Configure policy with `install-windows.ps1`, verify it with
  `codex mcp get rail-connector`, and open a fresh task. Compare
  `status.mcpProcess.pid` and `startedAt` when checking that a new MCP process
  inherited the registration.
- Ultracode requires `ultracode: true` plus `confirmUltracode: true`.
- Use unique managed names for parallel agents. Broker leases serialize
  mutations to a shared name and renew during long workflows.
- Spinner wording is not stable. Skills should consume structured state and
  transcript completion rather than matching a named spinner phrase.
- The current MCP contacts only the token-derived broker pipe and rejects PTY
  launches that do not match the resolved Claude executable.
- Run `npm run test:broker`, `npm run test:installer:windows`, and
  `npm run test:wrapper:windows` after Windows lifecycle changes.
- Run the opt-in `npm run test:live:windows` only when a real Claude acceptance
  run and its account usage are intended.
