# Security Policy

Rail Connector MCP can launch and control a local Claude Code process. In
`bypassPermissions`, that process may modify any host resource available to its
account without interactive approval. Review `docs/SECURITY_MODEL.md` before
enabling elevated modes.

## Supported Versions

Security fixes are provided for the latest published prerelease or stable
release. Older prereleases are unsupported unless a release note says otherwise.

## Report A Vulnerability

Do not open a public issue. Use GitHub's **Security** tab and select **Report a
vulnerability**:

https://github.com/SNComrade/Rail-Connector-MCP/security/advisories/new

Private vulnerability reporting must be enabled before the repository is
announced. If that form is unavailable, do not disclose details publicly; wait
for the maintainer to publish a working private channel.

Include the affected version and OS, impact, prerequisites, minimal reproduction,
and suggested mitigation. Redact credentials, tokens, local paths, transcripts,
session identifiers, titles, and Remote Control URLs.

## Response Targets

The maintainer aims to acknowledge a report within 3 business days, provide an
initial assessment within 7 business days, and coordinate remediation and
disclosure based on severity. These are best-effort targets, not an SLA.

## Scope

In scope:

- Workspace-root bypass or path validation failures
- Broker authentication, ownership, generation, or mutation-lease bypasses
- Command or argument injection
- Sensitive data returned without an explicit opt-in
- Permission-mode or Ultracode posture represented as observed when it was not
- Export or package behavior that publishes denied private material

Out of scope:

- Behavior of unsupported external CLI versions
- Social engineering, denial of service without security impact, or reports
  requiring access to another user's local account
- A user intentionally enabling bypass mode and then asking Claude to perform
  the resulting host modification

Good-faith research that avoids privacy harm, persistence, data destruction,
and access beyond the minimum needed to demonstrate the issue is welcome.
