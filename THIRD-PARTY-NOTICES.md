# Third-Party Notices

Rail Connector MCP depends on third-party packages installed through npm. The
four direct dependencies declare the MIT license:

- `@modelcontextprotocol/sdk`
- `@xterm/headless`
- `node-pty`
- `zod`

The locked transitive dependency tree also contains packages declaring MIT,
BSD-2-Clause, BSD-3-Clause, and ISC licenses. `node_modules` is not committed or
bundled in this repository; npm retrieves dependencies under their respective
licenses during installation.

The package names, versions, integrity values, and dependency graph are recorded
in `package-lock.json`. Review the license files distributed with installed
packages when preparing a redistributed binary bundle.

The tracked `patches/node-pty-1.2.0-beta.15-readiness.json` compatibility fix
modifies the installed node-pty JavaScript/types to expose a bounded Windows
worker-readiness budget. It preserves upstream copyright/license notices and
the readiness-before-connect and error-cleanup safeguards. Exact supported
input/output hashes are recorded in that file and checked during installation
and before Windows launches. No native binary is modified or bundled.
