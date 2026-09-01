# macOS Install

Use this path only when Codex, Rail Connector, and Claude Code all run in the
same macOS user environment. The backend is `tmux`.

## Prerequisites

Install Git, a supported Node line, and tmux with Homebrew or equivalent tools:

```bash
brew install git node@24 tmux
```

Ensure the selected Node installation is on `PATH`, then verify:

```bash
node --version
npm --version
tmux -V
claude --version
command -v node
command -v claude
```

Supported Node majors are 22, 24, and 26. Rail Connector requires tmux 3.2 or
newer and checks it before launching or replacing a managed session. Install
and authenticate Claude Code using Anthropic's current instructions before
registering this MCP.

`node-pty` normally selects a compatible prebuilt binary. If `npm ci` reports a
native-module build failure, install Apple's Command Line Tools with
`xcode-select --install`, ensure Python 3 is available, and retry.

## Install A Tagged Release

```bash
git clone --branch v1.0.0-beta.3 --depth 1 https://github.com/SNComrade/Rail-Connector-MCP.git
cd Rail-Connector-MCP
./install.sh
```

For an explicitly authorized development host, restrict the registration to
known project roots where practical:

```bash
./install.sh --bypass-policy LocalHost --allowed-root "$HOME/Projects"
```

The installer records absolute Node, Claude, and tmux paths, runs syntax and
smoke checks, registers `rail-connector`, and reads the registration back. Add
`--run-tests` for the complete suite.

Open a fresh Codex task after registration. Confirm the tools appear under
`mcp__rail_connector`, then call `get_claude_capabilities` and `status`.

## Validate

```bash
npm test
npm run test:installer:unix
npm run test:tmux
```

Hosted CI validates macOS on Node 22, 24, and 26. A release is not described as
macOS verified until those checks pass on its exact public commit.

## Uninstall

Finish or stop managed sessions, then run:

```bash
codex mcp remove rail-connector
```

Open a fresh Codex task and confirm the registration is gone. Deleting the
checkout or `~/.rail-connector-mcp` state is optional and never deletes Claude
Code transcripts.

See [Usage](USAGE.md), [Security Model](SECURITY_MODEL.md), and
[Troubleshooting](TROUBLESHOOTING.md).
