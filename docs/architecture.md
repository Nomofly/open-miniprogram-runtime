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

| Module    | Location            | Responsibility                                                                                                                                                                                                              | Status                              |
| --------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| compiler  | `packages/compiler` | Load the project (`project.config.json`, `app.json`, subpackages); compile WXML to render functions and WXSS to CSS (including `rpx` conversion and style isolation); bundle logic-layer JS with Rolldown, with source maps | WXML, WXSS, page and logic bundles  |
| runtime   | `packages/runtime`  | Logic layer: `App` / `Page` / `Component` / `Behavior`, lifecycles, `setData`, event dispatch; `wx.*` APIs whose host capabilities (network, storage, system info and so on) can be replaced with mocks                     | Core, routing, login and auth mocks |
| renderer  | `packages/renderer` | View layer: build the DOM from render functions and data; implement built-in components as Web Components; send user events back to the logic layer                                                                         | Core components implemented         |
| simulator | `apps/simulator`    | Vite app that combines runtime and renderer: device presets, page stack and routing, navigation bar, tabBar; also serves human developers debugging in a browser                                                            | Dev server implemented              |
| cli       | `packages/cli`      | The entry point for agents: the `omr` CLI and an MCP server, driving headless Chromium                                                                                                                                      | Planned                             |

Separating the logic layer and the view layer (Worker plus page) is deliberate: it reproduces WeChat's two-thread model, so timing bugs such as reading the old DOM before the `setData` callback show up as they would on WeChat.

Each page's view layer runs in a sandboxed iframe with an opaque origin, so page code such as WXS cannot reach the simulator shell: the device chrome, other pages and system UI such as consent dialogs. The shell sends the page its compiled bundle and data by message, and the view layer is served as one classic script, since an opaque origin cannot load modules from the simulator without CORS. The shell and the logic layer talk over a private message port handed to the Worker before Mini Program code runs, so that code cannot post messages as the logic layer or the shell. It still shares the Worker's JavaScript realm, so it could tamper with built-ins the logic layer uses, for example to change the result of a consent dialog; running Mini Program code in a realm of its own would close that gap.

## Simulated login and authorization

WeChat DevTools signs `wx.login` and the user-data APIs with the developer's own WeChat account. The simulator stands in for that account with a configurable user, so login flows run without QR codes or network access to WeChat:

- `omr.config.json` next to `project.config.json` (or `app.json`) sets the user (`auth.user`: openid, unionid, nickname, avatar, phone number), the permissions already granted (`auth.authSetting`), whether the user has agreed to the privacy guide (`auth.privacy.agreed`, false by default as for a new user) and its name (`auth.privacy.contractName`), whether system dialogs are shown or answered automatically (`auth.consent`: `ask`, `allow` or `deny`), and initial storage (`storage`), which injects a logged-in session so a page can be opened without going through login.
- `wx.login` and the `getPhoneNumber` button return codes that encode the user. The simulator serves a mock of the WeChat server APIs (`jscode2session`, `getuserphonenumber`, `token`) at `/__omr/wechat-api`; a backend uses it in place of `https://api.weixin.qq.com` to exchange the codes. Codes expire after five minutes and are single use, as on WeChat.
- User data follows base library 3.5.0, the version the simulator reports:
  - `wx.getUserProfile`, `wx.getUserInfo` and the `getUserInfo` button return the anonymous user "微信用户" with a gray avatar and show no dialog. `wx.getUserProfile` and `wx.openSetting` still fail outside a tap handler with `can only be invoked by user TAP gesture.`; the tap state lasts through the handler's microtasks and the callbacks of `wx.login`, `wx.getSetting` and `wx.request`, and is lost after `setTimeout`.
  - The configured nickname and avatar reach the Mini Program only when the user picks them: the `chooseAvatar` button's sheet, and the bar WeChat shows above the keyboard of `<input type="nickname">`. `bindnicknamereview` fires after blur and always passes.
  - Privacy APIs (`getUserProfile`, `getUserInfo`, `getLocation`, `authorize` and the `getPhoneNumber`, `getRealtimePhoneNumber`, `chooseAvatar` and `getUserInfo` buttons) wait for the privacy guide to be agreed. The Mini Program's `wx.onNeedPrivacyAuthorization` listener is asked first; `resolve({ event: "agree", buttonId })` passes only after the `agreePrivacyAuthorization` button with that id was tapped. Without a listener, WeChat's own privacy popup asks; a refusal fails the call with `privacy permission is not authorized` and errno 104, and calls in the next ten seconds fail the same way without asking. Until the guide is agreed, `<input type="nickname">` is a plain text input. `wx.getPrivacySetting`, `wx.requirePrivacyAuthorize` and `wx.openPrivacyContract` are available, and combined open-types such as `getPhoneNumber|agreePrivacyAuthorization` record the agreement before the phone number dialog.
  - `wx.authorize` asks once per scope, remembers the answer for `wx.getSetting`, and returns success without asking for `scope.address`, `scope.invoiceTitle`, `scope.invoice` and the withdrawn `scope.userInfo`.
- While the Mini Program uses the location, the microphone or the camera, the capsule shows their icons in place of its dots, as WeChat does: for three seconds after `wx.getLocation`, between `wx.startLocationUpdate` and `wx.stopLocationUpdate`, while `RecorderManager` records, and while an authorized `<camera>` is on a page. `<camera>` shows a simulated preview and fires `initdone`, or `binderror` with `insertCamera:fail auth deny`; recordings stop with a `http://tmp/` path and no audio.
- System UI (the privacy popup and guide, authorization, phone number and avatar dialogs, the nickname bar) is drawn by the shell, outside the page's WebView. Its buttons have `data-omr-action` attributes, so automation can answer them.

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
- Launch Chromium with `--disable-features=IsolateSandboxedIframes`. Otherwise Chromium renders the sandboxed page iframes in their own process, which does not receive an emulated device scale factor, and page content is captured at 1x while the shell is at 2x.
- Time, randomness and network responses can be fixed or mocked through a config file.

## Compatibility principles

- WeChat's **observable behavior** is the reference. Implement independently from public documentation; never use proprietary code or assets from the WeChat base library or DevTools.
- Cover the rendering paths agents hit most first: WXML template syntax, WXSS, common built-in components, page lifecycles and routing, and `setData`.
- Native components (`map`, `video`, `live-player` and so on) and capabilities that depend on Tencent services (login, payment, cloud development) are provided as placeholder rendering and configurable mocks, without aiming for real behavior.

## Non-goals

- Replacing every feature of WeChat DevTools (upload, preview, real-device debugging, profiling and so on).
- Pixel-perfect parity with the WeChat app.
- Running Mini Programs in production.
