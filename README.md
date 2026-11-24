# open-miniprogram-runtime

[![CI](https://github.com/nomofly/open-miniprogram-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/nomofly/open-miniprogram-runtime/actions/workflows/ci.yml)
[![CodeQL](https://github.com/nomofly/open-miniprogram-runtime/actions/workflows/codeql.yml/badge.svg)](https://github.com/nomofly/open-miniprogram-runtime/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/nomofly/open-miniprogram-runtime/badge)](https://scorecard.dev/viewer/?uri=github.com/nomofly/open-miniprogram-runtime)
[![License](https://img.shields.io/github/license/nomofly/open-miniprogram-runtime)](./LICENSE)

Run, debug, screenshot and annotate WeChat Mini Programs headlessly, built for coding agents in sandboxes.

> [!WARNING]
> This project is in early development. APIs and behavior may change at any time.

## Why

WeChat DevTools only runs as a desktop GUI on Windows and macOS, and it requires signing in by scanning a QR code with WeChat. A coding agent working in a Linux cloud sandbox can edit a Mini Program but cannot see the page or read its errors.

open-miniprogram-runtime needs only Node.js and headless Chromium. It lets an agent:

- **Screenshot**: render any page and get a stable, reproducible screenshot.
- **Annotate**: number the interactive elements in a screenshot and map each one back to its WXML node, source location and data.
- **Debug**: read console output, errors (mapped back to source), `setData` updates and `wx.*` API calls, and tap, type, scroll and navigate between pages.
- **Integrate**: drive all of the above through the `omr` CLI or an MCP server, with structured JSON output.

See the [architecture](./docs/architecture.md) for the design.

## Development

The toolchain is [Vite+](https://viteplus.dev/) from [VoidZero](https://voidzero.dev/) (Vite, Vitest, Rolldown, tsdown, Oxlint, Oxfmt and Vite Task), driven through the `vp` CLI.

```bash
curl -fsSL https://vite.plus | bash   # install vp (see viteplus.dev for Windows)
vp install                            # install dependencies with the pinned Node.js and pnpm
vp run ready                          # format, lint, type check, test and build, same as CI
```

See the [contributing guide](./CONTRIBUTING.md) for details.

## Contributing

Contributions of all kinds are welcome. Please read:

- [Contributing guide](./CONTRIBUTING.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Governance](./GOVERNANCE.md)
- [Support](./SUPPORT.md)
- [Security policy](./SECURITY.md)

If something behaves differently from WeChat, please open a [compatibility issue](https://github.com/nomofly/open-miniprogram-runtime/issues/new?template=compat_issue.yml).

## Disclaimer

This is an independent open-source implementation. It is not affiliated with, endorsed by, or authorized by Tencent or the WeChat team. "WeChat" and related marks are trademarks of Tencent. This project does not contain, and does not accept, proprietary code or assets from the WeChat SDK, base library or DevTools.

## License

[Apache License 2.0](./LICENSE)
