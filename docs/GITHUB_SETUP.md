# GitHub Repository Setup

These controls cannot be fully represented by committed files. Apply them after
the public repository is created and before it is announced.

## Repository

- Confirm visibility is public and the default branch is `main`.
- Add a concise description, topics, and the project URL if one exists.
- Enable Issues. Keep Discussions, Wiki, and Projects disabled until each has a
  documented moderation or maintenance purpose.
- Confirm no private repository is configured as a remote, submodule, or Action
  dependency.

## Rulesets

- Protect `main` from deletion and force pushes.
- Require pull requests and conversation resolution. For the solo-maintainer
  beta, use zero required approvals or an explicit maintainer bypass so a
  one-person project cannot deadlock itself.
- Require the CI, CodeQL, dependency review, and secret-scan checks that
  actually exist after their first runs. Dependency audit and release checks
  remain additional push/tag gates when they do not produce pull-request checks.
- Add a CodeQL code-scanning rule that blocks errors and security alerts rated
  high or higher. A successful CodeQL workflow means analysis completed; it
  does not mean the analysis found no alerts.
- Require linear history unless a different merge policy is documented.
- Protect `v*` tags from update and deletion.

## Actions

- Set default workflow permissions to read repository contents.
- Disable permission for Actions to create or approve pull requests.
- Require approval for workflows from all outside collaborators, because fork
  changes can execute arbitrary code, including dependency install scripts.
- Allow only the actions required by committed workflows.
- Keep every third-party action pinned to a full commit SHA.

## Self-hosted Runner Qualification

All committed workflow jobs select self-hosted runners. Before registering
runners or activating these routes, qualify the following controls on each
operating system; committed YAML does not establish that they exist.

- Use `rail-ci-pr` for pull-request jobs and `rail-ci-maintenance` for main,
  scheduled, manual and tag jobs. Preserve the Linux, Windows and macOS labels
  and all nine OS/Node test cells. These labels are scheduling selectors, not
  authorization or evidence of isolation. Fork-controlled YAML can request any
  runner exposed to this repository, including the maintenance pool.
- Run every job in BOTH pools in a newly created, single-job guest from a
  reviewed clean baseline. Use ephemeral runner registration. Removing a runner
  registration or cleaning the checkout alone does not clean the guest.
- Keep the guest lifecycle controller outside the guest. After success,
  failure, cancellation, timeout or guest/controller interruption, destroy the
  guest and its writable disks, or perform a verified clean-baseline restore
  before reuse. Block further admission when cleanup cannot be established.
- Do not share writable workspaces, home directories, local dependency/tool
  caches, disks, containers or Docker sockets between jobs or with the host.
  Never copy job output into the clean baseline. Review remote cache and artifact
  scope separately; never promote untrusted PR state into maintenance jobs.
- Keep personal, private-repository and management credentials outside guests.
  Disable host folders, clipboard integration, SSH-agent forwarding and host
  command integration. Job tokens must have only the workflow's declared
  permissions and must not survive the job.
- Enforce network isolation outside the guest, covering the host, private LAN,
  VPNs, other guests, cloud metadata and IPv6. NAT alone is insufficient. Allow
  only the public endpoints required for the job, and verify denied paths from
  an untrusted guest without exposing credentials or private data.
- Record the exact commit and job ID, OS/toolchain and baseline identity,
  creation time, clean pre-job state, and teardown/reset result in an external
  operation record. Exercise failure and cancellation cleanup as well as
  success. A workflow success does not replace this lifecycle evidence.
- Measure capacity before admitting jobs. `max-parallel: 2` limits the test
  matrix only; the controller must also bound aggregate resource use across
  workflows and both pools. A runner waiting for capacity must not fall back
  to a persistent trusted host or a GitHub-hosted runner.

Keep routing changes unqualified and runner activation held until these
controls are demonstrated for Linux, Windows and macOS. See GitHub's
[self-hosted runner security guidance](https://docs.github.com/en/actions/concepts/security/compromised-runners).

## Code Security

- Enable the dependency graph, Dependabot alerts, and Dependabot security
  updates.
- Enable secret scanning and push protection.
- Enable private vulnerability reporting and test the link in `SECURITY.md`.
- Enable CodeQL default setup only if the committed advanced workflow is not
  used; do not run both configurations.

## Community

- Confirm the Security, Contributing, Code of Conduct, Support, and Governance
  links appear correctly.
- Confirm issue forms and the pull request template render.
- Confirm `CODEOWNERS` resolves to the intended maintainer account.
- Confirm the initial commit uses the intended public identity and a GitHub
  `users.noreply.github.com` address rather than a personal email.

## Before Announcement

- Run all public workflows on the exact candidate commit.
- Confirm the exact commit has no open CodeQL security alerts rated high or
  critical. Review lower-severity alerts explicitly instead of relying only on
  the workflow conclusion.
- Perform a clean installation from the public clone URL.
- Verify the three executable paths retain mode `100755` in a clean Linux clone.
- Review the repository tree, npm package dry run, Git history, authorship, tags,
  releases, and Actions logs for sensitive material.
- Record the exact public commit and verification status.
