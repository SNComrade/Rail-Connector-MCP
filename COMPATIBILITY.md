# Compatibility

## Release Status

`1.0.0-beta.2` is prerelease software. Tool names, input schemas, response
fields, installation behavior, and platform support may change before `1.0.0`.

## Node.js

Supported Node lines are 22, 24, and 26 for the public beta series. The project
supports Node releases that are in Current, Active LTS, or Maintenance LTS when
they pass the repository matrix. An EOL Node line is removed in the next minor
or major release, with advance notice in the changelog when practical.

## Operating Systems

- Native Windows uses the persistent per-user ConPTY broker.
- Linux and macOS use tmux 3.2 or newer. This minimum is enforced before a new
  or replacement session launch because isolated child environments rely on
  `new-session -e`.
- WSL is supported only when Codex, this MCP server, and Claude Code all run in
  the same WSL distribution.

Each platform also requires a compatible `node-pty` prebuild or native compiler
toolchain.

## Claude Code

Claude Code is an external CLI that changes independently. The MCP probes the
installed CLI for advertised flags and reports unsupported launch requests.
Terminal rendering and spinner text are not stable APIs; transcript completion
and structured state are preferred whenever available.

No fixed future Claude Code version is promised. Report the exact CLI version,
OS, Node version, and sanitized MCP `status` output with compatibility issues.

## Semantic Versioning

The public API includes MCP tool names, tool input schemas, response fields,
permission semantics, and persisted broker/session metadata formats.

- Removing or renaming a tool or response field is a major change.
- Tightening an accepted input in a breaking way is a major change.
- Adding a tool or optional response field is a minor change.
- Compatible fixes and documentation corrections are patch changes.

Prereleases progress through `beta.N`, then `rc.N`, then stable. Published tags
are immutable. Breaking changes may occur between beta or release-candidate
tags when they are documented in `CHANGELOG.md` with migration guidance.
Strict stable compatibility begins at `1.0.0`.
