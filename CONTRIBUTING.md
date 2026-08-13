# Contributing

Thank you for helping improve Rail Connector MCP.

## Before You Start

- Search existing issues and pull requests.
- Use a focused issue for substantial behavior or schema changes.
- Report vulnerabilities privately through `SECURITY.md`.
- Never include credentials, local session data, Remote Control URLs, personal
  paths, customer material, or real conversation identifiers.

## Development

Use Node.js 22, 24, or 26 and install dependencies with scripts enabled:

```bash
npm ci
npm test
```

Run platform-specific checks for the code you change:

```bash
npm run test:installer:unix
npm run test:tmux
```

```powershell
npm run test:installer:windows
npm run test:wrapper:windows
npm run test:broker
```

The real-account Windows acceptance test is opt-in, consumes an authenticated
Claude account, and must not run in hosted CI.

## Pull Requests

Keep changes narrow, add regression coverage, update documentation when public
behavior changes, and complete the pull request checklist. Disclose material
AI-assisted authorship in the pull request description and confirm that you
reviewed and can explain the submitted code.

Dependency changes must pass dependency review. MIT, ISC, BSD-2-Clause, and
BSD-3-Clause dependencies are accepted by the automated policy; any other
license requires an explicit maintainer review. Update
`THIRD-PARTY-NOTICES.md` when dependency names or license families change.

During beta, accepted public changes are reconciled into a separate development
source before the next exported release. The maintainer preserves contributor
attribution and must not overwrite accepted public work with a later export;
see `GOVERNANCE.md`.

Contributions are accepted under the repository's MIT license. By submitting a
contribution, you represent that you have the right to license it on those
terms.
