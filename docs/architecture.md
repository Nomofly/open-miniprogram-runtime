# Architecture

> Status: draft. It will be updated as the implementation progresses; significant changes are discussed through the process in [GOVERNANCE.md](../GOVERNANCE.md).

## The problem

Coding agents increasingly work in cloud sandboxes: Linux, no display, and no way to scan a QR code to sign in. Today the only way to debug a WeChat Mini Program is WeChat DevTools, which runs only as a desktop GUI on Windows and macOS and requires signing in with WeChat. As a result, an agent that changes a Mini Program **cannot see the page, cannot read the errors, and cannot show that its change works**.

This project lets an agent do the following in any Linux sandbox, with only Node.js and headless Chromium:

1. **Run**: load a Mini Program project and render any page.
2. **Screenshot**: get a stable, reproducible screenshot of the page.
3. **Annotate**: number the interactive elements on a screenshot and map each number to its WXML node, source location and data, so the agent can refer to and act on them.
4. **Debug**: read console output, errors (mapped back to the original source), `setData` updates and `wx.*` API calls, and tap, type, scroll and navigate between pages.

Every capability returns **structured output** (JSON plus image files) rather than a UI meant for human eyes.

## Overview

```
Mini Program project ──► compiler ──► runtime (logic layer, Worker) ◄──► renderer (view layer, page)
                                               ▲                                 ▲
                                               └──── simulator (Vite app: device, page stack, navigation bar, tabBar)
                                                                    ▲
                                              cli / MCP (drives headless Chromium: screenshot, annotate, debug, interact)
                                                                    ▲
                                                               coding agent
```

| Module    | Location            | Responsibility                                                                                                                                                                                                              | Status                      |
| --------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| compiler  | `packages/compiler` | Load the project (`project.config.json`, `app.json`, subpackages); compile WXML to render functions and WXSS to CSS (including `rpx` conversion and style isolation); bundle logic-layer JS with Rolldown, with source maps | Project loading implemented |
| runtime   | `packages/runtime`  | Logic layer: `App` / `Page` / `Component` / `Behavior`, lifecycles, `setData`, event dispatch; `wx.*` APIs whose host capabilities (network, storage, system info and so on) can be replaced with mocks                     | Planned                     |
| renderer  | `packages/renderer` | View layer: build the DOM from render functions and data; implement built-in components as Web Components; send user events back to the logic layer                                                                         | Planned                     |
| simulator | `apps/simulator`    | Vite app that combines runtime and renderer: device presets, page stack and routing, navigation bar, tabBar; also serves human developers debugging in a browser                                                            | Planned                     |
| cli       | `packages/cli`      | The entry point for agents: the `omr` CLI and an MCP server, driving headless Chromium                                                                                                                                      | Planned                     |

Separating the logic layer and the view layer (Worker plus page) is deliberate: it reproduces WeChat's two-thread model, so timing bugs such as reading the old DOM before the `setData` callback show up as they would on WeChat.

## Agent interface (draft)

CLI commands map one to one to MCP tools and print JSON by default:

| Command                                                                                  | Purpose                                                                                                                |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `omr dev <project>`                                                                      | Start the simulator server for humans debugging in a browser                                                           |
| `omr screenshot <project> --page <path> [--query k=v] [--device iphone-15] [-o out.png]` | Open the page, wait for rendering to settle and take a screenshot                                                      |
| `omr annotate <project> --page <path>`                                                   | Screenshot with numbered interactive elements, returning a list of `{ id, selector, wxmlPath, source, rect, dataset }` |
| `omr inspect <project> --page <path>`                                                    | Return the WXML node tree, page `data` and page stack                                                                  |
| `omr logs`                                                                               | Return console output, errors (mapped to original source), and `setData` and `wx.*` call records                       |
| `omr tap / input / scroll / navigate`                                                    | Interact by annotation number or selector, returning the screenshot and new logs after the interaction                 |

Calls within one session reuse a single browser instance to avoid cold starts.

## Reproducibility

Agents compare screenshots to judge their changes, so rendering must be stable:

- Fixed device parameters (screen width, pixel ratio, safe area, status bar height), defaulting to a common phone model.
- Bundled open-source CJK fonts, independent of the sandbox's system fonts.
- Before a screenshot, wait for the `setData` queue to drain and images to load, with an option to disable animations.
- Time, randomness and network responses can be fixed or mocked through a config file.

## Compatibility principles

- WeChat's **observable behavior** is the reference. Implement independently from public documentation; never use proprietary code or assets from the WeChat base library or DevTools.
- Cover the rendering paths agents hit most first: WXML template syntax, WXSS, common built-in components, page lifecycles and routing, and `setData`.
- Native components (`map`, `video`, `live-player` and so on) and capabilities that depend on Tencent services (login, payment, cloud development) are provided as placeholder rendering and configurable mocks, without aiming for real behavior.

## Non-goals

- Replacing every feature of WeChat DevTools (upload, preview, real-device debugging, profiling and so on).
- Pixel-perfect parity with the WeChat app.
- Running Mini Programs in production.
