# open-miniprogram-runtime

Lets coding agents run, debug, screenshot and annotate WeChat Mini Programs in sandboxes. See [docs/architecture.md](docs/architecture.md) for the goals, modules and agent interface, and [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow.

## Conventions

- pnpm workspace monorepo: libraries in `packages/*` (built with `vp pack`), applications in `apps/*` (built with `vp build`).
- Dependency versions live in the `catalog` in `pnpm-workspace.yaml`; packages reference them with `"catalog:"`.
- Tests live in each package's `tests/` directory and import from `vite-plus/test`; relative imports in source include the `.ts` extension.
- Lint and format rules are configured only in the root `vite.config.ts`; use `overrides` for package-specific settings.
- Run `vp run ready` (the same checks as CI) before committing. Pull requests are squash merged, and their titles must follow Conventional Commits.
- Everything in the repository is written in English: code, comments, documentation, error messages, templates and commit messages.
- WeChat's observable behavior and public documentation are the reference for compatibility. Never copy code or assets from the WeChat base library, DevTools or SDK.

## Troubleshooting

- In low-memory Linux sandboxes, `vp check` can panic when Oxlint starts (`oxc_allocator/src/pool/fixed_size.rs`), because the JS plugin reserves a large block of virtual memory. Run `sudo sysctl -w vm.overcommit_memory=1` and try again.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Running Scripts

Run TypeScript and JavaScript files with `vpx <file>`, for example `vpx ./scripts/seed.ts --dry-run`. It handles enums, decorators, JSX, and tsconfig `paths`, so do not add `tsx` or `ts-node` to run scripts. `vpx --watch <file>` reruns the file when a file it uses changes, in place of `tsx watch`. `vp node <file>` runs plain Node.js.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
