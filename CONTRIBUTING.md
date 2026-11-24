# Contributing

Thanks for your interest in contributing to open-miniprogram-runtime! By participating, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug or compatibility issue**: use the [issue templates](https://github.com/nomofly/open-miniprogram-runtime/issues/new/choose) and include a minimal reproduction where possible.
- **Suggest a feature**: for larger changes, open an issue or a Discussion first and agree on the approach before writing code.
- **Contribute code or docs**: issues labeled [`good first issue`](https://github.com/nomofly/open-miniprogram-runtime/labels/good%20first%20issue) or [`help wanted`](https://github.com/nomofly/open-miniprogram-runtime/labels/help%20wanted) are good places to start. Comment on the issue before you start so work isn't duplicated.
- **Security vulnerabilities**: do not report them publicly; follow [SECURITY.md](./SECURITY.md).

## Development setup

This project uses [Vite+](https://viteplus.dev/) (`vp`) to manage Node.js, pnpm, and the Vite, Vitest, Rolldown, tsdown, Oxlint and Oxfmt toolchain.

```bash
curl -fsSL https://vite.plus | bash   # install vp; for Windows see https://viteplus.dev/guide/
git clone https://github.com/<your-name>/open-miniprogram-runtime.git
cd open-miniprogram-runtime
vp install                            # uses the versions pinned in .node-version and devEngines, and installs the pre-commit hook
```

Common commands:

| Command           | Description                                          |
| ----------------- | ---------------------------------------------------- |
| `vp check`        | Format check (Oxfmt), lint (Oxlint) and type check   |
| `vp check --fix`  | Fix formatting and auto-fixable lint issues          |
| `vp run -r test`  | Run the tests of every package (Vitest)              |
| `vp run -r build` | Build every package (tsdown / Vite)                  |
| `vp run ready`    | Run all of the above in order, the same checks as CI |

`vp test`, `vp build` and similar are built-in commands; run `package.json` scripts with `vp run <name>`. On commit, the pre-commit hook runs `vp check --fix` on staged files.

## Repository layout

This is a pnpm workspace monorepo. See the [architecture](./docs/architecture.md) for how the modules fit together.

- `packages/*`: libraries, built with `vp pack`. Tests live in each package's `tests/` directory and import the test API from `vite-plus/test`.
- `apps/*`: applications (such as the simulator UI), built with `vp build`.
- Shared dependency versions live in the `catalog` in `pnpm-workspace.yaml`; packages reference them with `"catalog:"`.
- Lint and format rules are configured once in the root `vite.config.ts`; use `overrides` for package-specific settings.

## Pull requests

1. Fork the repository and create a branch from `main`, such as `fix/scroll-view-bindscroll`.
2. Make your change and add tests. A bug fix should come with a test that fails without the fix.
3. Run `vp run ready` locally and make sure it passes.
4. Open a pull request, fill in the template, and link the issue (for example `Closes #123`).
5. Once CI passes and at least one maintainer approves, a maintainer **squash merges** it.

### PR titles

Pull requests are squash merged, so **the PR title becomes the commit message**. It must follow [Conventional Commits](https://www.conventionalcommits.org/), and CI checks it. Version numbers and the changelog are generated from it.

```
<type>(<scope>): <subject>
```

| Type           | Use for                                          | Version bump |
| -------------- | ------------------------------------------------ | ------------ |
| `feat`         | New features, newly supported APIs or components | minor        |
| `fix`          | Bug fixes and compatibility fixes                | patch        |
| `perf`         | Performance improvements                         | patch        |
| `refactor`     | Refactoring without behavior changes             | —            |
| `docs`         | Documentation                                    | —            |
| `test`         | Tests                                            | —            |
| `build` / `ci` | Build system and CI configuration                | —            |
| `chore`        | Other maintenance and dependency updates         | —            |
| `revert`       | Reverts                                          | —            |

The scope is optional; use the module name, such as `compiler`, `runtime`, `renderer`, `simulator` or `cli`.

Mark breaking changes with `!` after the type and describe the migration in the PR description, for example `feat(cli)!: rename --out to --output`.

## Compatibility changes

WeChat's behavior is the reference. When you implement or change an API or component:

- Link the official documentation in the PR, and state the environment you used to observe WeChat's behavior (DevTools or a real device, and the base library version).
- When the documentation and the observed behavior disagree, follow the observed behavior and explain it in a code comment.
- **Do not copy** proprietary code or assets from the WeChat SDK, base library or DevTools. Implement independently from public documentation and observable behavior.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please). Commits merged into `main` accumulate in a release PR; when a maintainer merges it, `CHANGELOG.md` is updated, a tag is created and a GitHub Release is published. Contributors never need to edit version numbers or the changelog.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](./LICENSE).
