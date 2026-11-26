import { describe, expect, test } from "vite-plus/test";
import { MemoryFs, startLogic } from "../src/index.ts";
import type { LogicToShell, SimulatorConfig, ViewToLogic } from "../src/index.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const TARGET = { id: "web", dataset: {}, offsetLeft: 0, offsetTop: 0 };

/** Boots an app whose first page has a `<web-view>` and logs its events in `getApp().log`. */
function boot(platform: "ios" | "android" = "ios", config: SimulatorConfig = {}) {
  const sent: LogicToShell[] = [];
  const handle = startLogic((message) => sent.push(message), { fs: new MemoryFs() });
  const pages = ["pages/web/web", "pages/next/next", "pages/tab/tab"];
  const page = `Page({
    onLoad() {},
    onWeb(e) { getApp().log.push([e.type, e.detail]); },
    onShareAppMessage(options) { getApp().log.push(["share", options.webViewUrl]); return {}; },
  });`;
  handle({
    type: "boot",
    manifest: {
      appid: "wx0123456789abcdef",
      appName: "Demo",
      appJson: { pages, tabBar: { list: [{ pagePath: "pages/tab/tab", text: "Tab" }] } },
      pages,
      entryPage: pages[0]!,
      windows: {},
      config: { auth: { consent: "allow" }, ...config },
    },
    system: {
      windowWidth: 375,
      windowHeight: 603,
      statusBarHeight: 20,
      screenWidth: 375,
      screenHeight: 667,
      pixelRatio: 2,
      platform,
    },
    menuButton: { width: 87, height: 32, top: 24, right: 368, bottom: 56, left: 281 },
    chrome: { navigationBar: 64, tabBar: 50 },
    appService: [
      `__omrDefine("app.js", function (require, module, exports) { App({ log: [] }); });`,
      ...pages.map(
        (route) => `__omrDefine("${route}.js", function (require, module, exports) { ${page} });`,
      ),
    ].join("\n"),
  });
  const routes = () => sent.filter((message) => message.type === "route");
  const top = () => routes().at(-1)!.stack.at(-1)!;
  const { webviewId } = top();
  const view = (message: ViewToLogic, id = webviewId) =>
    handle({ type: "view", webviewId: id, message });
  view({ type: "ready" });
  const log = () => (globalThis as unknown as { getApp(): { log: unknown[] } }).getApp().log;
  const handlers = {
    load: { ownerId: 0, handler: "onWeb" },
    error: { ownerId: 0, handler: "onWeb" },
    message: { ownerId: 0, handler: "onWeb" },
  };
  /** Calls `WeixinJSBridge.invoke` from the web page and resolves its answer. */
  let callId = 0;
  const invoke = async (name: string, args: Record<string, unknown> = {}) => {
    const id = ++callId;
    handle({ type: "webViewInvoke", webviewId, callId: id, name, args });
    for (let i = 0; i < 20; i++) {
      await settle();
      const answer = sent.find(
        (message) => message.type === "webViewResult" && message.callId === id,
      );
      if (answer?.type === "webViewResult") return answer.result;
    }
    throw new Error(`${name} was not answered`);
  };
  return { sent, handle, view, log, webviewId, handlers, invoke, top };
}

describe("<web-view>", () => {
  test("the shell opens its src once; load and error reach the page's handlers", () => {
    const { sent, handle, view, log, webviewId, handlers } = boot();
    const src = "https://h5.example.com/a?x=1";
    view({ type: "webView", src, target: TARGET, handlers });
    // A render that changes nothing else does not reopen it
    view({ type: "webView", src, target: TARGET, handlers });
    expect(sent.filter((message) => message.type === "webView")).toEqual([
      { type: "webView", webviewId, src },
    ]);
    handle({ type: "webViewEvent", webviewId, name: "load", detail: { src } });
    handle({
      type: "webViewEvent",
      webviewId,
      name: "error",
      detail: { url: "https://h5.example.com/b", fullUrl: "https://h5.example.com/b?y=2" },
    });
    expect(log()).toEqual([
      ["load", { src }],
      ["error", { url: "https://h5.example.com/b", fullUrl: "https://h5.example.com/b?y=2" }],
    ]);
    // Removing it closes the web page
    view({ type: "webView" });
    expect(sent.at(-1)).toEqual({ type: "webView", webviewId });
  });

  test("bindmessage gets what the page posted when it is shared, then when it unloads", async () => {
    const { sent, handle, view, log, webviewId, handlers, invoke, top } = boot();
    view({ type: "webView", src: "https://h5.example.com/", target: TARGET, handlers });
    expect(await invoke("invokeMiniProgramAPI", { name: "postMessage", arg: { a: 1 } })).toEqual({
      err_msg: "invokeMiniProgramAPI:ok",
    });
    await invoke("invokeMiniProgramAPI", { name: "postMessage", arg: "two" });
    // Opening a page over it and coming back delivers nothing: the web-view's page stays
    await invoke("invokeMiniProgramAPI", {
      name: "navigateTo",
      arg: { url: "/pages/next/next?from=web" },
    });
    expect(top()).toMatchObject({ route: "pages/next/next" });
    view({ type: "ready" }, top().webviewId);
    handle({ type: "navigateBack" });
    expect(top().webviewId).toBe(webviewId);
    expect(log()).toEqual([]);

    // A single-page app moved on; sharing reports where it is now
    handle({
      type: "webViewEvent",
      webviewId,
      name: "location",
      detail: { src: "https://h5.example.com/list#2" },
    });
    handle({ type: "menu" });
    await settle();
    const sheet = sent.findLast((message) => message.type === "ui")!;
    expect(sheet).toMatchObject({ name: "showActionSheet" });
    if (sheet.type !== "ui") throw new Error("no sheet");
    expect(sheet.args.itemList).toContain("复制链接");
    handle({ type: "uiResult", callId: sheet.callId, result: { tapIndex: 0 } });
    await settle();
    expect(log()).toEqual([
      ["message", { data: [{ a: 1 }, "two"] }],
      ["share", "https://h5.example.com/list#2"],
    ]);

    // Leaving the page hands over what came since, once
    await invoke("invokeMiniProgramAPI", { name: "postMessage", arg: { b: 2 } });
    await invoke("invokeMiniProgramAPI", { name: "reLaunch", arg: { url: "/pages/next/next" } });
    expect(log().slice(2)).toEqual([["message", { data: [{ b: 2 }] }]]);
  });

  test("routes from the web page fail as the Mini Program's would", async () => {
    const { view, handlers, invoke } = boot();
    expect((await invoke("invokeMiniProgramAPI", { name: "postMessage", arg: {} })).err_msg).toBe(
      "invokeMiniProgramAPI:fail the web-view is closed",
    );
    view({ type: "webView", src: "https://h5.example.com/", target: TARGET, handlers });
    expect(
      await invoke("invokeMiniProgramAPI", { name: "navigateTo", arg: { url: "/pages/tab/tab" } }),
    ).toEqual({ err_msg: "invokeMiniProgramAPI:fail can not navigateTo a tabbar page" });
    expect(
      await invoke("invokeMiniProgramAPI", { name: "navigateBack", arg: { delta: 1 } }),
    ).toEqual({ err_msg: "invokeMiniProgramAPI:fail cannot navigate back at first page." });
  });
});

describe("JSSDK in <web-view>", () => {
  test("chooseImage gives local ids whose data getLocalImgData reads, as iOS formats them", async () => {
    const { view, handlers, invoke } = boot("ios");
    view({ type: "webView", src: "https://h5.example.com/", target: TARGET, handlers });
    const chosen = await invoke("chooseImage", { count: 1, sourceType: ["album"] });
    expect(chosen.err_msg).toBe("chooseImage:ok");
    const localIds = chosen.localIds as string[];
    expect(localIds).toHaveLength(1);
    expect(localIds[0]).toMatch(/^wxlocalresource:\/\//);
    const data = await invoke("getLocalImgData", { localId: localIds[0] });
    expect(data.err_msg).toBe("getLocalImgData:ok");
    // A PNG's signature, base64 encoded
    expect(data.localData).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
    expect((await invoke("getLocalImgData", { localId: "wxlocalresource://nope" })).err_msg).toBe(
      "getLocalImgData:fail invalid localId",
    );
  });

  test("Android gets JSON strings and bare base64, as the JSSDK parses them there", async () => {
    const { view, handlers, invoke } = boot("android");
    view({ type: "webView", src: "https://h5.example.com/", target: TARGET, handlers });
    const chosen = await invoke("chooseImage", { count: 1, sourceType: ["album"] });
    const localIds = JSON.parse(chosen.localIds as string) as string[];
    expect(localIds[0]).toMatch(/^weixin:\/\/resourceid\//);
    const data = await invoke("getLocalImgData", { localId: localIds[0] });
    expect(data.localData).toMatch(/^iVBORw0KGgo/);
    const checked = await invoke("checkJsApi", { jsApiList: ["chooseImage", "chooseWXPay"] });
    expect(JSON.parse(checked.checkResult as string)).toEqual({
      chooseImage: true,
      chooseWXPay: false,
    });
  });

  test("location, network, scanning, and APIs a web-view may not use", async () => {
    const { view, handlers, invoke } = boot("ios", {
      location: { latitude: 31.2304, longitude: 121.4737 },
      scanCode: { result: "hello" },
    });
    view({ type: "webView", src: "https://h5.example.com/", target: TARGET, handlers });
    expect(await invoke("geoLocation", { type: "gcj02" })).toMatchObject({
      err_msg: "geoLocation:ok",
      latitude: 31.2304,
      longitude: 121.4737,
    });
    // The JSSDK reads the type out of err_msg
    expect(await invoke("getNetworkType")).toEqual({ err_msg: "network_type:wifi" });
    // iOS wraps the result; without needResult the page gets nothing
    const scanned = await invoke("scanQRCode", { needResult: 1 });
    expect(JSON.parse(scanned.resultStr as string)).toEqual({
      scan_code: { scan_result: "hello" },
    });
    expect(await invoke("scanQRCode", { needResult: 0 })).toEqual({ err_msg: "scanQRCode:ok" });
    expect((await invoke("getBrandWCPayRequest")).err_msg).toBe(
      "getBrandWCPayRequest:fail not supported in <web-view>",
    );
  });
});
