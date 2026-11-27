import { describe, expect, test } from "vite-plus/test";
import { MemoryFs, startLogic, themeTabBar, themeWindow } from "../src/index.ts";
import type { LogicToShell, LogicToView, ViewToLogic } from "../src/index.ts";

const SYSTEM = {
  windowWidth: 375,
  windowHeight: 603,
  statusBarHeight: 20,
  screenWidth: 375,
  screenHeight: 667,
  pixelRatio: 2,
};
const MENU_BUTTON = { width: 87, height: 32, top: 24, right: 368, bottom: 56, left: 281 };

/** Boots a logic layer with the given JS files, as the compiler bundles them. */
function boot(
  files: Record<string, string>,
  appJson: Record<string, unknown> & { pages: string[] },
  launch?: { path: string; query: Record<string, string> },
  theme?: "light" | "dark",
) {
  const sent: LogicToShell[] = [];
  const handle = startLogic((message) => sent.push(message), { fs: new MemoryFs() });
  const appService = Object.entries(files)
    .map(
      ([file, source]) =>
        `__omrDefine(${JSON.stringify(file)}, function (require, module, exports) {\n${source}\n});`,
    )
    .join("\n");
  handle({
    type: "boot",
    manifest: {
      appid: "wx0123456789abcdef",
      appName: "Demo",
      appJson,
      pages: appJson.pages,
      entryPage: appJson.pages[0]!,
      windows: {},
      config: {},
    },
    system: SYSTEM,
    menuButton: MENU_BUTTON,
    chrome: { navigationBar: 64, tabBar: 50 },
    appService,
    launch,
    theme,
  });
  const view = (webviewId: number, message: ViewToLogic) =>
    handle({ type: "view", webviewId, message });
  const log = () => (globalThis as unknown as { getApp(): { log: unknown[] } }).getApp().log;
  const toView = (webviewId?: number) =>
    sent.flatMap((message) =>
      message.type === "toView" && (webviewId === undefined || message.webviewId === webviewId)
        ? [message.message]
        : [],
    );
  /** Opens a page's view and renders it, so its onReady runs. */
  const render = (webviewId: number) => {
    view(webviewId, { type: "ready" });
    const init = toView(webviewId).find((message) => message.type === "init") as { seq: number };
    view(webviewId, { type: "rendered", seq: init.seq });
  };
  const stack = () =>
    (
      sent.filter((message) => message.type === "route").at(-1) as Extract<
        LogicToShell,
        { type: "route" }
      >
    ).stack.map((entry) => entry.route);
  return { sent, handle, view, log, toView, render, stack };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const wx = () => (globalThis as unknown as { wx: Record<string, any> }).wx;

/** A page that logs its lifecycles as `<name> <hook>`. */
const page = (name: string) =>
  `Page({ ${["onLoad", "onUnload", "onReady"]
    .map((hook) => `${hook}() { getApp().log.push("${name} ${hook}"); }`)
    .join(", ")} });`;

/** An app.js that logs each route listener with its routeEventId. */
const ROUTE_LOGGER = `App({ log: [], onLaunch() {
  for (const name of ["BeforeAppRoute", "AppRoute", "AppRouteDone", "BeforePageLoad", "AfterPageLoad", "BeforePageUnload", "AfterPageUnload"]) {
    wx["on" + name]((res) => this.log.push([name, res.path, res.routeEventId, res.openType]));
  }
} });`;

describe("route listeners", () => {
  test("redirectTo calls them in the order WeChat's route listener guide lists", () => {
    const { log, render } = boot(
      { "app.js": ROUTE_LOGGER, "pages/a/a.js": page("a"), "pages/b/b.js": page("b") },
      { pages: ["pages/a/a", "pages/b/b"] },
    );
    render(1);
    log().length = 0;
    wx().redirectTo({ url: "/pages/b/b?x=1" });
    return settle().then(() => {
      render(2);
      const entries = log() as unknown[][];
      const id = (entries[0] as string[])[2];
      expect(entries.map((entry) => (Array.isArray(entry) ? entry.slice(0, 2) : entry))).toEqual([
        ["BeforeAppRoute", "/pages/b/b"],
        ["BeforePageUnload", "/pages/a/a"],
        "a onUnload",
        ["AfterPageUnload", "/pages/a/a"],
        ["BeforePageLoad", "/pages/b/b"],
        "b onLoad",
        ["AfterPageLoad", "/pages/b/b"],
        ["AppRoute", "/pages/b/b"],
        "b onReady",
        ["AppRouteDone", "/pages/b/b"],
      ]);
      // Every listener of one route gets the same id
      for (const entry of entries.filter(Array.isArray)) expect(entry[2]).toBe(id);
    });
  });

  test("rewriteRoute retargets a route only from onBeforeAppRoute and only to a page of the same kind", async () => {
    const { log, render, stack } = boot(
      {
        "app.js": `App({ log: [], onLaunch() {
          wx.onBeforeAppRoute((res) => {
            if (res.path === "/pages/old/old") {
              wx.rewriteRoute({ url: "/pages/new/new?from=rewrite", complete: (r) => this.log.push(r.errMsg) });
            }
            if (res.path === "/pages/b/b") {
              wx.rewriteRoute({ url: "/pages/tab/tab", complete: (r) => this.log.push(r.errMsg) });
            }
          });
        } });`,
        "pages/a/a.js": "Page({});",
        "pages/b/b.js": "Page({});",
        "pages/new/new.js": "Page({ onLoad(q) { getApp().log.push(q); } });",
        "pages/tab/tab.js": "Page({});",
      },
      {
        pages: ["pages/a/a", "pages/b/b", "pages/new/new", "pages/tab/tab"],
        tabBar: { list: [{ pagePath: "pages/tab/tab" }, { pagePath: "pages/a/a" }] },
      },
    );
    render(1);
    // The old page is gone from app.json; the route still goes where the rewrite says
    wx()
      .navigateTo({ url: "/pages/old/old?id=7" })
      .catch(() => log().push("navigateTo failed"));
    await settle();
    expect(stack()).toEqual(["pages/a/a", "pages/new/new"]);
    render(2);
    // navigateTo cannot go to a tab page, so that rewrite fails and the route goes on as it was
    wx().navigateTo({ url: "/pages/b/b" });
    await settle();
    expect(stack()).toEqual(["pages/a/a", "pages/new/new", "pages/b/b"]);
    const ok = { errMsg: "rewriteRoute:ok" };
    expect(log()).toEqual([
      ok.errMsg,
      { from: "rewrite" },
      "rewriteRoute:fail can not navigateTo a tabbar page",
    ]);

    const outside = await new Promise((resolve) =>
      wx().rewriteRoute({ url: "/pages/a/a", fail: resolve }),
    );
    expect(outside).toEqual({
      errMsg: "rewriteRoute:fail can only be called in a wx.onBeforeAppRoute listener",
    });
  });

  test("a switchTab rewritten to another cached tab reports that tab's webviewId", async () => {
    const { log, render } = boot(
      {
        "app.js": `App({ log: [], onLaunch() {
          wx.onBeforeAppRoute((res) => {
            if (res.openType === "switchTab" && getApp().rewrite) wx.rewriteRoute({ url: "/pages/b/b" });
          });
          wx.onAppRoute((res) => this.log.push(["route", res.path, res.webviewId]));
          wx.onAppRouteDone((res) => this.log.push(["done", res.path, res.webviewId]));
        } });`,
        "pages/a/a.js": "Page({});",
        "pages/b/b.js": "Page({});",
      },
      {
        pages: ["pages/a/a", "pages/b/b"],
        tabBar: { list: [{ pagePath: "pages/a/a" }, { pagePath: "pages/b/b" }] },
      },
    );
    render(1);
    wx().switchTab({ url: "/pages/b/b" });
    await settle();
    render(2);
    wx().switchTab({ url: "/pages/a/a" });
    await settle();
    (globalThis as unknown as { getApp(): { rewrite: boolean } }).getApp().rewrite = true;
    log().length = 0;
    // a/a is page 1 and b/b is page 2; the rewrite sends the route to b/b
    wx().switchTab({ url: "/pages/a/a" });
    await settle();
    expect(log()).toEqual([
      ["route", "/pages/b/b", 2],
      ["done", "/pages/b/b", 2],
    ]);
  });

  test("a launch page that does not exist can be rewritten before onPageNotFound", () => {
    const { log, stack } = boot(
      {
        "app.js": `App({ log: [], onLaunch() {
          wx.onBeforeAppRoute((res) => {
            this.log.push([res.openType, res.notFound]);
            if (res.notFound) wx.rewriteRoute({ url: "/pages/b/b?lost=" + encodeURIComponent(res.path) });
          });
          wx.onPageNotFound(() => this.log.push("not found"));
        }, onPageNotFound() { this.log.push("App not found"); } });`,
        "pages/a/a.js": "Page({});",
        "pages/b/b.js": "Page({});",
      },
      { pages: ["pages/a/a", "pages/b/b"] },
      { path: "pages/gone/gone", query: {} },
    );
    expect(stack()).toEqual(["pages/b/b"]);
    expect(log()).toEqual([["appLaunch", true]]);
  });

  test("without a rewrite, a missing launch page reaches wx.onPageNotFound as well as App", () => {
    const { log } = boot(
      {
        "app.js": `App({ log: [], onLaunch() { wx.onPageNotFound((res) => this.log.push(["wx", res.path, res.isEntryPage])); },
          onPageNotFound(res) { this.log.push(["App", res.path]); } });`,
        "pages/a/a.js": "Page({});",
      },
      { pages: ["pages/a/a"] },
      { path: "pages/gone/gone", query: {} },
    );
    expect(log()).toEqual([
      ["App", "pages/gone/gone"],
      ["wx", "pages/gone/gone", true],
    ]);
  });
});

describe("app APIs", () => {
  test("the back button asks before leaving a page with enableAlertBeforeUnload; wx.navigateBack does not", async () => {
    const { sent, handle, render, stack } = boot(
      {
        "app.js": "App({ log: [] });",
        "pages/a/a.js": "Page({});",
        "pages/b/b.js": `Page({ onLoad() { wx.enableAlertBeforeUnload({ message: "还没保存，确定离开？" }); } });`,
      },
      { pages: ["pages/a/a", "pages/b/b"] },
    );
    render(1);
    wx().navigateTo({ url: "/pages/b/b" });
    await settle();
    render(2);
    await settle();
    const modals = () =>
      sent.filter(
        (message): message is Extract<LogicToShell, { type: "ui" }> =>
          message.type === "ui" && message.name === "showModal",
      );
    handle({ type: "navigateBack" });
    expect(modals().at(-1)!.args).toMatchObject({ content: "还没保存，确定离开？" });
    handle({ type: "uiResult", callId: modals().at(-1)!.callId, result: { confirm: false } });
    await settle();
    expect(stack()).toEqual(["pages/a/a", "pages/b/b"]);

    handle({ type: "navigateBack" });
    handle({ type: "uiResult", callId: modals().at(-1)!.callId, result: { confirm: true } });
    await settle();
    expect(stack()).toEqual(["pages/a/a"]);

    // The API itself is not held up
    wx().navigateTo({ url: "/pages/b/b" });
    await settle();
    render(3);
    const count = modals().length;
    await wx().navigateBack();
    expect(stack()).toEqual(["pages/a/a"]);
    expect(modals()).toHaveLength(count);
  });

  test("base64 conversions keep every byte, and batch storage reads what it wrote", async () => {
    boot({ "app.js": "App({ log: [] });", "pages/a/a.js": "Page({});" }, { pages: ["pages/a/a"] });
    const bytes = new Uint8Array([0, 0x7f, 0x80, 0xff, 0xe4, 0xb8, 0xad]);
    const base64 = wx().arrayBufferToBase64(bytes.buffer);
    expect(base64).toBe("AH+A/+S4rQ==");
    expect([...new Uint8Array(wx().base64ToArrayBuffer(base64))]).toEqual([...bytes]);

    wx().batchSetStorageSync([
      { key: "a", value: { n: 1 } },
      { key: "b", value: [2] },
    ]);
    expect(wx().batchGetStorageSync(["b", "missing", "a"])).toEqual([[2], "", { n: 1 }]);
    expect(wx().getStorageSync("a")).toEqual({ n: 1 });
    await expect(wx().batchGetStorage({ keyList: ["a"] })).resolves.toMatchObject({
      dataList: [{ n: 1 }],
      errMsg: "batchGetStorage:ok",
    });
    await expect(wx().batchSetStorage({ kvList: [{ value: 1 }] })).rejects.toMatchObject({
      errMsg: "batchSetStorage:fail parameter.kvList[].key should be String",
    });
  });

  test("loadFontFace succeeds when the view has loaded the font, and a global font reaches pages opened later", async () => {
    const { view, toView, render } = boot(
      { "app.js": "App({ log: [] });", "pages/a/a.js": "Page({});", "pages/b/b.js": "Page({});" },
      { pages: ["pages/a/a", "pages/b/b"] },
    );
    render(1);
    const requests = (webviewId: number) =>
      toView(webviewId).filter(
        (message): message is Extract<LogicToView, { type: "viewRequest" }> =>
          message.type === "viewRequest",
      );
    const loading = wx().loadFontFace({
      global: true,
      family: "Demo",
      source: 'url("https://x/demo.ttf")',
    });
    await settle();
    const [request] = requests(1);
    expect(request!.request).toEqual({
      kind: "loadFontFace",
      family: "Demo",
      source: 'url("https://x/demo.ttf")',
      desc: {},
    });
    view(1, { type: "viewReply", requestId: request!.requestId });
    await expect(loading).resolves.toMatchObject({ status: "loaded", errMsg: "loadFontFace:ok" });

    wx().navigateTo({ url: "/pages/b/b" });
    await settle();
    render(2);
    expect(requests(2).map((message) => message.request)).toMatchObject([{ family: "Demo" }]);

    const failing = wx().loadFontFace({ family: "Bad", source: "https://x/bad.ttf" });
    await settle();
    view(2, { type: "viewReply", requestId: requests(2).at(-1)!.requestId, error: "404" });
    await expect(failing).rejects.toMatchObject({
      errMsg: "loadFontFace:fail a network error occurred. 404",
    });
  });

  test("wx.onError hears errors thrown in page code with their message", () => {
    const { render, log } = boot(
      {
        "app.js": `App({ log: [], onLaunch() { wx.onError((res) => this.log.push(typeof res.message)); } });`,
        "pages/a/a.js": `Page({ onLoad() { throw new Error("boom"); } });`,
      },
      { pages: ["pages/a/a"] },
    );
    render(1);
    expect(log()).toEqual(["string"]);
  });
});

describe("background and foreground", () => {
  test("leaving hides the page, then the app; coming back shows the app with the top page's enter options, then the page", async () => {
    const { handle, render, log } = boot(
      {
        "app.js": `App({ log: [],
          onLaunch() {
            wx.onAppHide((res) => this.log.push(["wx.onAppHide", res]));
            wx.onAppShow((res) => this.log.push(["wx.onAppShow", res.path, res.query, res.scene]));
          },
          onShow(res) { this.log && this.log.push(["App onShow", res.path, res.query, res.scene]); },
          onHide() { this.log.push(["App onHide"]); },
        });`,
        "pages/a/a.js": `Page({ onShow() { getApp().log.push("a onShow"); }, onHide() { getApp().log.push("a onHide"); } });`,
        "pages/b/b.js": `Page({ onShow() { getApp().log.push("b onShow"); }, onHide() { getApp().log.push("b onHide"); } });`,
      },
      { pages: ["pages/a/a", "pages/b/b"] },
    );
    render(1);
    wx().navigateTo({ url: "/pages/b/b?x=1" });
    await settle();
    render(2);
    log().length = 0;

    handle({ type: "appHide" });
    // Leaving twice, such as two taps on the close button, is one departure
    handle({ type: "appHide" });
    expect(log()).toEqual(["b onHide", ["App onHide"], ["wx.onAppHide", {}]]);

    log().length = 0;
    handle({ type: "appShow", scene: 1089 });
    handle({ type: "appShow", scene: 1001 });
    expect(log()).toEqual([
      ["App onShow", "pages/b/b", { x: "1" }, 1089],
      ["wx.onAppShow", "pages/b/b", { x: "1" }, 1089],
      "b onShow",
    ]);
    // The enter options follow the return; the launch options stay as the app started
    expect(wx().getEnterOptionsSync()).toMatchObject({ path: "pages/b/b", scene: 1089 });
    expect(wx().getLaunchOptionsSync()).toMatchObject({ path: "pages/a/a", scene: 1001 });
  });
});

describe("DarkMode", () => {
  const THEME_LOGGER = `App({ log: [],
    onLaunch() { wx.onThemeChange((res) => this.log.push(["wx.onThemeChange", res])); },
    onThemeChange(res) { this.log.push(["App onThemeChange", res]); },
  });`;

  test("with darkmode, the system info reports the theme and a change reaches App and wx.onThemeChange", () => {
    const { handle, log } = boot(
      { "app.js": THEME_LOGGER, "pages/a/a.js": "Page({});" },
      { pages: ["pages/a/a"], darkmode: true },
      undefined,
      "dark",
    );
    expect(wx().getSystemInfoSync().theme).toBe("dark");
    expect(wx().getAppBaseInfo().theme).toBe("dark");
    handle({ type: "theme", theme: "light" });
    // The theme it already has is no change
    handle({ type: "theme", theme: "light" });
    expect(log()).toEqual([
      ["App onThemeChange", { theme: "light" }],
      ["wx.onThemeChange", { theme: "light" }],
    ]);
    expect(wx().getSystemInfoSync().theme).toBe("light");
  });

  test("without darkmode, the theme is undefined and its changes are not heard", () => {
    const { handle, log } = boot(
      { "app.js": THEME_LOGGER, "pages/a/a.js": "Page({});" },
      { pages: ["pages/a/a"] },
      undefined,
      "dark",
    );
    expect(wx().getSystemInfoSync().theme).toBeUndefined();
    expect(wx().getAppBaseInfo().theme).toBeUndefined();
    handle({ type: "theme", theme: "light" });
    expect(log()).toEqual([]);
  });

  test("theme.json variables replace only the settings that accept them, in the theme asked for", () => {
    const variables = {
      light: { nav: "#f6f6f6", text: "black", icon: "image/home_light.png", title: "Light" },
      dark: { nav: "#191919", text: "white", icon: "image/home_dark.png", title: "Dark" },
    };
    const window = {
      navigationBarBackgroundColor: "@nav",
      navigationBarTextStyle: "@text",
      navigationBarTitleText: "@title",
      backgroundColor: "@missing",
    };
    expect(themeWindow(window, variables, "dark")).toEqual({
      navigationBarBackgroundColor: "#191919",
      navigationBarTextStyle: "white",
      // A title is not themed, and a variable theme.json lacks stays as written
      navigationBarTitleText: "@title",
      backgroundColor: "@missing",
    });
    const tabBar = { color: "@text", list: [{ pagePath: "a", text: "@title", iconPath: "@icon" }] };
    expect(themeTabBar(tabBar, variables, "light")).toEqual({
      color: "black",
      list: [{ pagePath: "a", text: "@title", iconPath: "image/home_light.png" }],
    });
    // The input is left as it was, so the other theme can be resolved from it later
    expect(tabBar.list[0]!.iconPath).toBe("@icon");
  });
});
