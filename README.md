# Rail Connector MCP

Local MCP bridge for operating Claude Code Remote Control from Codex.

> **Same-OS contract:** Codex, this MCP server, and Claude Code must run in the
> same operating-system context. Native Windows controls native Windows. A WSL
> installation controls Claude only when Codex and Claude both run inside that
> same WSL environment.

Rail Connector MCP combines Claude Code's local session logs and Remote Control
CLI with a persistent Windows terminal broker or tmux on Linux and macOS. It
lets Codex list, inspect, start, resume, continue, fork, prompt, wait for,
capture, rename, archive, and stop local Claude Code conversations.

This project does not implement Anthropic's private cloud protocol. A local,
authenticated Claude Code process remains required.

Rail Connector MCP is an independent open-source project. It is not affiliated
with, sponsored by, or endorsed by Anthropic or OpenAI. Product names are used
only to describe interoperability. See [NOTICE](NOTICE).

## Status

The current version is `1.0.0-beta.1`, the first public beta candidate. Treat
the MCP tool schemas and response fields as prerelease interfaces until a stable
release is published. See [Compatibility](COMPATIBILITY.md).

The package is intentionally marked `private` and is not published to the npm
registry. Git tags and GitHub Releases are the public release authority.

## Capabilities

- Local Claude conversation listing, search, inspection, resume, continue, and
  fork support
- Model, effort, Ultracode, permission, safe-mode, tool, and workspace-trust
  launch controls
- Persistent per-user ConPTY broker on Windows and validated tmux ownership on
  Linux/macOS
- Chunked prompt submission and transcript-backed completion waiting
- Session rename plus MCP-local archive metadata
- Requested, resolved, and observed launch-posture evidence
- Repo-scoped Codex operator, debugger, and reviewer skills

## Requirements

- Windows, Linux, or macOS
- Node.js 22, 24, or 26
- npm and Git
- Claude Code CLI installed and authenticated
- Codex Desktop or Codex CLI with local MCP server support
- tmux 2.4 or newer on Linux/macOS
- Build prerequisites for `node-pty` when a matching prebuilt binary is not
  available; see [Troubleshooting](docs/TROUBLESHOOTING.md)

Package installation scripts must be enabled because `node-pty` uses its install
step to select a prebuild or compile. `npm ci --ignore-scripts` is unsupported.

## Data And Trust Boundary

Rail Connector runs locally under the current user. It reads local Claude Code
session logs and controls a local terminal process; MCP responses can include
conversation text or Remote Control URLs when a caller requests those fields.
The project has no telemetry service and does not upload session data. Claude
Code itself still communicates with Anthropic under the user's Claude account.

Treat the Codex MCP client, the selected project directory, Claude hooks, and
any enabled bypass policy as part of one local trust boundary. Use allowed
roots when a registration should be limited to specific project trees.

## Install

Install from the same OS environment that runs Codex and Claude Code.

For a published release, clone the immutable tag:

Linux:

```bash
git clone --branch v1.0.0-beta.1 --depth 1 https://github.com/SNComrade/Rail-Connector-MCP.git
cd Rail-Connector-MCP
./install.sh
```

macOS uses the same installer after the prerequisites in
[macOS Install](docs/MACOS.md) are present.

Native Windows PowerShell:

```powershell
git clone --branch v1.0.0-beta.1 --depth 1 https://github.com/SNComrade/Rail-Connector-MCP.git
cd Rail-Connector-MCP
.\install-windows.ps1
```

To evaluate unreleased work, clone `main` without `--branch`; do not describe a
mutable `main` checkout as a released version. The source-tree installers are
not included in the runtime-only npm tarball produced for release inspection.

The default installer runs syntax and smoke verification before registration.
Pass `--run-tests` on Linux/macOS or `-RunTests` on Windows to run the complete
suite during installation. CI always runs the complete suite.

The registered MCP server name is `rail-connector`; Codex tools appear under
`mcp__rail_connector` after a fresh Codex task loads the registration.
Bundled skills are repo-scoped. Use Codex's native `$skill-installer` for the
three directories under `.agents/skills/` when they should be available from
unrelated project repositories; skill installation is an explicit, separate
choice from MCP registration.

## Permission Policy

Bypass mode is disabled by default. On an intentionally authorized development
host, install with the explicit local-host policy:

```bash
./install.sh --bypass-policy LocalHost --allowed-root "$HOME/projects"
```

```powershell
.\install-windows.ps1 -BypassPolicy LocalHost -AllowedRoot "$HOME\Projects"
```

Each bypass launch must still include `confirmBypassPermissions: true`. Bypass
mode removes Claude's approval prompts and can modify any host resource
available to the Claude process. Read [Security Model](docs/SECURITY_MODEL.md)
before enabling it.

LocalHost is an advanced single-user development policy, not a claim that the
host is isolated. `Disabled` remains the default. Restricting allowed roots is
strongly recommended when LocalHost is enabled.

## Verify

```bash
npm ci
npm test
```

Start with the MCP `get_claude_capabilities` and `status` tools. On Windows,
`status` should report the persistent native broker backend. Use the actual task
project as `cwd`, not this repository unless this repository is the review
target.

## Documentation

- [Install Guide](docs/INSTALL.md)
- [Windows Install](docs/WINDOWS.md)
- [Linux/WSL Install](docs/LINUX.md)
- [macOS Install](docs/MACOS.md)
- [Usage](docs/USAGE.md)
- [Security Model](docs/SECURITY_MODEL.md)
- [Task Guide](docs/TASK_GUIDE.md)
- [Repo Skills](docs/SKILLS.md)
- [Install Skills](docs/SKILL_INSTALL.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

Project policies and maintainer references:

- [Security Policy](SECURITY.md)
- [Support](SUPPORT.md)
- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Governance](GOVERNANCE.md)
- [Compatibility](COMPATIBILITY.md)
- [Changelog](CHANGELOG.md)
- [Release Process](docs/RELEASE_PROCESS.md)
- [GitHub Setup](docs/GITHUB_SETUP.md)
- [Agent Instructions](./AGENTS.md)

## License

MIT. See [LICENSE](LICENSE) and [Third-Party Notices](THIRD-PARTY-NOTICES.md).
