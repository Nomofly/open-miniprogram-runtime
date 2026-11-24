# Governance

This document describes the roles, decision-making and maintenance process of open-miniprogram-runtime. The project starts with lightweight governance that will evolve as the community grows; changes to it follow the process below.

## Roles

### Contributor

Anyone who has opened an issue or pull request, contributed documentation, reviewed changes, or taken part in discussions.

### Committer

A contributor with a track record of high-quality contributions may be invited to become a committer. Committers have triage permission on issues and pull requests and can give formal reviews.

### Maintainer

Maintainers are responsible for the project's direction and code quality, have write access to the repository, and:

- Review and merge pull requests and triage issues
- Cut releases (by merging the release PR that release-please opens)
- Handle security reports and Code of Conduct reports
- Maintain this document and the other governance documents

The current maintainers are listed in [.github/CODEOWNERS](./.github/CODEOWNERS).

## Becoming a committer or maintainer

A current maintainer nominates the candidate in a public issue. The nomination takes effect once the maintainers reach consensus with no objections. We consider the quality and consistency of contributions, reviews of others' work, understanding of the project's goals, and conduct in the community.

Maintainers inactive for more than 6 months may move to emeritus status and can ask to be reinstated at any time.

## Decision-making

- **Day-to-day changes** go through pull requests and are merged after at least one maintainer approves and CI passes.
- **Significant changes** (architecture changes, new public APIs, breaking changes, major new dependencies, governance changes) start with an issue or Discussion that explains the motivation and the proposal, which stays open for comments for at least 7 days.
- Decisions use **lazy consensus**: if no maintainer raises a reasoned objection during that period, the proposal is accepted.
- When consensus cannot be reached, the maintainers decide by simple majority vote.

## Branches and releases

- `main` is the only long-lived branch and must always be releasable. All changes land through pull requests; direct pushes are not allowed.
- Pull requests are squash merged, and PR titles follow Conventional Commits.
- Versions follow [Semantic Versioning](https://semver.org/). Before 1.0, minor releases may contain breaking changes, which are called out in the changelog.

## Code of Conduct

All participants must follow the [Code of Conduct](./CODE_OF_CONDUCT.md), which the maintainers enforce.
