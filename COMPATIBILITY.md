# Compatibility

## Release Status

`1.0.0-beta.5` is prerelease software. Tool names, input schemas, response
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

The beta pins `node-pty 1.2.0-beta.15` exactly. Native Windows selects its bundled
ConPTY DLL backend and fails launch if the required binaries are unavailable;
it does not fall back to the legacy console-list/PID-termination backend.
The dependency and DLL option remain prerelease/experimental. Broker build
`1.0.0-beta.5+broker.8` requires a compatible broker rather than reusing an older
backend. See [Windows guidance](docs/WINDOWS.md) for startup recovery and limits.
Upstream natural-exit native resource leakage remains under investigation;
this change is not a claim that all host memory or connection retention is fixed.
The tracked install lifecycle applies version/hash-guarded JavaScript fixes for
the upstream beta.15 readiness watchdog and output-worker cleanup after socket
close. This cleanup change does not prove native HPCON release or explain retained
MCP client connections. Windows uses an explicit 15-second child
startup contract and refuses unpatched or unexpected dependency bytes. Install
with normal `npm ci`; disabling install scripts is unsupported. Native binaries
and the upstream readiness-before-connect/error-cleanup safeguards are preserved.

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
