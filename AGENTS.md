# Agent Instructions

This repository is public source. Never add credentials, session transcripts,
Remote Control URLs, real conversation identifiers, local usernames, machine
names, absolute personal paths, customer data, or private project references.

## Engineering Rules

- Preserve the same-OS contract: Codex, this MCP server, and Claude Code run in
  the same operating-system context.
- Keep `bypassPermissions` behind both the process-level policy acknowledgement
  and the per-launch confirmation.
- Treat requested, resolved, and observed launch posture as separate evidence.
- Prefer transcript-backed completion over terminal spinner wording.
- Add a focused regression test for parser, renderer, broker, session, or prompt
  transport changes.
- Keep real-account acceptance opt-in and out of hosted CI.
- Do not weaken workspace-root, broker-token, ownership, generation, or mutation
  lease checks.

## Required Checks

Run `npm test` before submitting a pull request. Run the platform-specific
installer and transport tests when changing installers, Windows broker code, or
the tmux backend. Run `npm run check:privacy` before any release candidate.

Security reports belong in GitHub private vulnerability reporting, not public
issues. See `SECURITY.md`.
