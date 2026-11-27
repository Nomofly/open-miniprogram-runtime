import { expect, test } from "vite-plus/test";
import { MemoryFs, startLogic } from "../src/index.ts";
import type { LogicToShell } from "../src/index.ts";

test("a full-screen <video> asks the shell to raise its page over the chrome, and to put it back", () => {
  const sent: LogicToShell[] = [];
  const handle = startLogic((message) => sent.push(message), { fs: new MemoryFs() });
  const route = "pages/index/index";
  handle({
    type: "boot",
    manifest: {
      appid: "wx0123456789abcdef",
      appName: "Demo",
      appJson: { pages: [route] },
      pages: [route],
      entryPage: route,
      windows: {},
      config: {},
    },
    system: {
      windowWidth: 375,
      windowHeight: 603,
      statusBarHeight: 20,
      screenWidth: 375,
      screenHeight: 667,
      pixelRatio: 2,
    },
    menuButton: { width: 87, height: 32, top: 24, right: 368, bottom: 56, left: 281 },
    chrome: { navigationBar: 64, tabBar: 50 },
    appService: [
      `__omrDefine("app.js", function (require, module, exports) { App({}); });`,
      `__omrDefine("${route}.js", function (require, module, exports) { Page({}); });`,
    ].join("\n"),
  });
  const { webviewId } = sent.findLast((message) => message.type === "route")!.stack[0]!;
  handle({ type: "view", webviewId, message: { type: "ready" } });
  handle({ type: "view", webviewId, message: { type: "videoFullScreen", fullScreen: true } });
  handle({ type: "view", webviewId, message: { type: "videoFullScreen", fullScreen: false } });
  expect(sent.filter((message) => message.type === "videoFullScreen")).toEqual([
    { type: "videoFullScreen", webviewId, fullScreen: true },
    { type: "videoFullScreen", webviewId, fullScreen: false },
  ]);
});
