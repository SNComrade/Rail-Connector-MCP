# Governance

Rail Connector MCP uses a maintainer-led model. The repository owner is the
initial maintainer and final decision maker for scope, security posture,
compatibility, releases, and contributor access.

## Decisions

Routine changes are discussed and reviewed in pull requests. Material changes
to MCP schemas, security gates, supported platforms, release policy, or project
scope should include a written rationale in the pull request or linked issue.

The maintainer may decline changes that broaden host access, weaken explicit
permission acknowledgements, create unsupported cross-OS control, expose
sensitive local data, or add maintenance cost without demonstrated user value.

## Beta Development Flow

During the public beta, the maintainer may develop and validate changes in a
separate non-public working tree before exporting a sanitized candidate here.
This public repository is the distribution and contribution surface: accepted
public pull requests are reconciled into the development source before the next
export, and a later export must not silently overwrite accepted public work.

Conflicts are resolved in a public pull request or issue when disclosure is
safe. Contributor attribution is preserved in the public commit and in any
backport, using the original commit identity or a co-authored trailer. This
two-tree arrangement will be reevaluated after beta; the public repository may
become the sole software authority when the privacy split no longer justifies
its maintenance cost.

## Releases

Only the maintainer may authorize a release. A green workflow, version bump,
label, or generated message does not itself authorize publication. See
`docs/RELEASE_PROCESS.md`.

## Maintainer Changes

Additional maintainers may be added after sustained, security-conscious
contributions. Their scope and repository permissions will be documented here.
