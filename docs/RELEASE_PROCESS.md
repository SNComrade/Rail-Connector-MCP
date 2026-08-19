# Release Process

Only a maintainer may authorize a release. A passing workflow, generated label,
version bump, or AI message is evidence, not authorization.

## Candidate Evidence

Before each public release candidate, verify the reviewed tree has:

- A release branch from current protected public `main` with only reviewed
  candidate changes
- No private repository remote, private history, or private-only files
- A passing privacy scan against the repository and runtime npm package
- A full-history Gitleaks scan after the candidate commit exists
- Passing `npm test` plus platform-specific installer and backend tests
- Package contents matching the reviewed manifest
- Git mode `100755` for `install.sh`, `src/index.js`, and `tools/leak-scan.mjs`
- Node 22, 24, and 26 coverage across the supported OS matrix
- A working private vulnerability-reporting plan

## Public Beta Verification

After the repository exists, `Public Beta Verified` requires the exact public
commit to pass CI, CodeQL, dependency review/audit, package checks, and an
installation from the public clone URL. A separate non-public reconciliation
record must confirm applicable public findings were incorporated into the
development source before release eligibility is claimed. Accepted public work
and its attribution must be present in that reconciliation.

For CodeQL, require both a successful analysis workflow and no open high or
critical security alerts on the exact commit. The workflow can succeed while
reporting findings. Configure the repository ruleset's CodeQL merge protection
to block errors and high-or-higher security alerts, then inspect the security
dashboard before tagging.

## Version And Tag

1. Update `CHANGELOG.md` and remove `Unreleased` from the target release date.
2. Confirm `package.json` and the intended tag match exactly.
3. Run `npm ci`, `npm test`, platform checks, and `npm pack --dry-run` from a
   clean checkout.
4. Confirm `git ls-files --stage -- install.sh src/index.js tools/leak-scan.mjs`
   reports `100755` for all three paths. On the first commit, use
   `git add --chmod=+x` for those paths.
5. Confirm the release commit and package contain no sensitive material.
6. Confirm CodeQL has no open high or critical security alerts for the exact
   commit; do not treat a green analysis workflow as a clean result by itself.
7. Create an immutable annotated `v<version>` tag only after explicit human
   authorization.
8. Let the tag workflow build and retain the runtime-only package artifact.
9. Create the GitHub Release from the exact tag after reviewing the artifact.

The first sequence is `1.0.0-beta.N`, then `1.0.0-rc.N`, then `1.0.0`. Never
move or reuse a published tag.

## npm Publication

The beta candidate is marked `private` in `package.json` to prevent accidental
npm publication. npm publishing is a separate future decision. If enabled,
remove that guard in a reviewed release change and use npm trusted publishing
with provenance instead of a long-lived registry token.

The current npm tarball is a runtime inspection artifact, not the supported
source-tree installer. It intentionally excludes `install.sh`,
`install-windows.ps1`, tests, and `package-lock.json`; install users from the
immutable Git tag until npm publication is separately designed and approved.
