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
- Require linear history unless a different merge policy is documented.
- Protect `v*` tags from update and deletion.

## Actions

- Set default workflow permissions to read repository contents.
- Disable permission for Actions to create or approve pull requests.
- Require approval for workflows from all outside collaborators, because fork
  changes can affect dependency install scripts on hosted runners.
- Allow only the actions required by committed workflows.
- Keep every third-party action pinned to a full commit SHA.

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
- Perform a clean installation from the public clone URL.
- Verify the three executable paths retain mode `100755` in a clean Linux clone.
- Review the repository tree, npm package dry run, Git history, authorship, tags,
  releases, and Actions logs for sensitive material.
- Record the exact public commit and verification status.
