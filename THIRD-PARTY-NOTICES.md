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
