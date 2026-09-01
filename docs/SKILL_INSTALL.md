# Install The Codex Skills

The three bundled skills are repo-scoped by default. Codex discovers them
automatically when the active task is inside this checkout.

To make a skill available from unrelated project repositories, ask Codex's
native `$skill-installer` to install the immutable tagged GitHub directory:

```text
$skill-installer Install rail-operator from https://github.com/SNComrade/Rail-Connector-MCP/tree/v1.0.0-beta.3/.agents/skills/rail-operator
```

Repeat for:

```text
https://github.com/SNComrade/Rail-Connector-MCP/tree/v1.0.0-beta.3/.agents/skills/rail-debugger
https://github.com/SNComrade/Rail-Connector-MCP/tree/v1.0.0-beta.3/.agents/skills/rail-reviewer
```

Open a fresh Codex task after installation so skill discovery is reloaded. MCP
registration and skill installation are separate: the installers register the
MCP but do not silently copy user-level skills.

An installed user-scope copy does not update automatically when this repository
changes. Reinstall it deliberately after reviewing a new tagged release.

For development against unreleased `main`, substitute `/tree/main/` only when
you intentionally want mutable skill content. Validate all installed skill
directories with Codex's native skill validator as described in [Repo
Skills](SKILLS.md).
