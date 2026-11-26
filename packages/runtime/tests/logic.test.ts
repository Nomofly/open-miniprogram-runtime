import { describe, expect, test } from "vite-plus/test";
import { decodeCode, mockWechatApi, startLogic } from "../src/index.ts";
import type {
  AncestorBindings,
  LogicToShell,
  SimulatorConfig,
  TreeNode,
  ViewToLogic,
} from "../src/index.ts";

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
  config: SimulatorConfig = {},
  windows: Record<string, Record<string, unknown>> = {},
  launch?: { path: string; query: Record<string, string> },
  scene?: number,
) {
  const sent: LogicToShell[] = [];
  const handle = startLogic((message) => sent.push(message));
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
      windows,
      config,
    },
    system: SYSTEM,
    menuButton: MENU_BUTTON,
    chrome: { navigationBar: 64, tabBar: 50 },
    appService,
    launch,
    scene,
  });
  const view = (webviewId: number, message: ViewToLogic) =>
    handle({ type: "view", webviewId, message });
  const log = () => (globalThis as unknown as { getApp(): { log: unknown[] } }).getApp().log;
  return { sent, handle, view, log };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const lastRoute = (sent: LogicToShell[]) =>
  sent.filter((message) => message.type === "route").at(-1) as Extract<
    LogicToShell,
    { type: "route" }
  >;
const toView = (sent: LogicToShell[], type: string) =>
  sent.flatMap((message) =>
    message.type === "toView" && message.message.type === type ? [message.message] : [],
  );

const APP = "App({ log: [] });";
const bind = (name: string, handler: string, catchIt = false) => ({
  name,
  handler,
  catch: catchIt,
  capture: false,
});
/** Attaches components to page 1 as the view does: `[nodeId, ownerId, path, id, props?]`. */
const attachAll = (
  view: (webviewId: number, message: ViewToLogic) => void,
  list: [number, number, string, string, Record<string, unknown>?][],
) => {
  for (const [nodeId, ownerId, path, id, props = {}] of list) {
    view(1, { type: "attach", nodeId, ownerId, path, props, listeners: {}, id, dataset: {} });
  }
};
const tree = (
  nodeId: number,
  parentId: number,
  tag: string,
  className = "",
  events: ReturnType<typeof bind>[] = [],
  ancestors: AncestorBindings[] = [],
): TreeNode => ({ nodeId, parentId, tag, className, events, ancestors });
const currentPage = () => (globalThis as any).getCurrentPages()[0];

const tapOn = (id: string) => {
  const target = { id, dataset: {} };
  return { type: "tap", timeStamp: 0, target, currentTarget: target, detail: {} };
};

describe("logic layer", () => {
  test("runs page lifecycles in order and calls setData callbacks only after the view renders", () => {
    const { sent, view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `
          const log = (entry) => getApp().log.push(entry);
          Page({
            data: { count: 0 },
            onLoad(query) {
              log("onLoad " + query.id);
              this.setData({ count: 1, "user.name": "Ann" }, () => log("callback " + this.data.count));
            },
            onShow() { log("onShow"); },
            onReady() { log("onReady"); },
          });`,
      },
      { pages: ["pages/index/index"] },
    );
    expect(lastRoute(sent).stack).toEqual([{ webviewId: 1, route: "pages/index/index" }]);

    view(1, { type: "ready" });
    const [init] = toView(sent, "init");
    expect(init).toMatchObject({ data: { count: 1, user: { name: "Ann" } } });
    expect(log()).toEqual(["onLoad undefined", "onShow"]);

    view(1, { type: "rendered", seq: (init as { seq: number }).seq });
    expect(log()).toEqual(["onLoad undefined", "onShow", "callback 1", "onReady"]);
  });

  test("wx.login issues a code the mock jscode2session exchanges for the configured user once", async () => {
    const { view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({ onLoad() { wx.login().then((res) => getApp().log.push(res)); } });`,
      },
      { pages: ["pages/index/index"] },
      { auth: { user: { openid: "o-alice", unionid: "u-alice" } } },
    );
    view(1, { type: "ready" });
    await settle();
    const [result] = log() as { code: string; errMsg: string }[];
    expect(result!.errMsg).toBe("login:ok");

    const used = new Set<string>();
    const exchange = (appid: string, code = result!.code) =>
      mockWechatApi(
        {
          method: "GET",
          url: new URL(
            `https://api.weixin.qq.com/sns/jscode2session?appid=${appid}&secret=x&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`,
          ),
        },
        used,
      )!.json;
    expect(exchange("wxother")).toMatchObject({ errcode: 40013 });
    expect(exchange("wx0123456789abcdef")).toEqual({
      openid: "o-alice",
      unionid: "u-alice",
      session_key: "omr-session-key-developer",
    });
    expect(exchange("wx0123456789abcdef")).toMatchObject({ errcode: 40163 });
    // Base64 ignores whitespace: the same code spelled differently is still used
    expect(exchange("wx0123456789abcdef", `${result!.code} `)).toMatchObject({ errcode: 40163 });
  });

  test("checkSession fails for an expired session until wx.login runs", async () => {
    const { view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({ async onLoad() {
          const push = (r) => getApp().log.push(r.errMsg);
          await wx.checkSession().then(push, push);
          await wx.login();
          await wx.checkSession().then(push, push);
        } });`,
      },
      { pages: ["pages/index/index"] },
      { auth: { sessionExpired: true } },
    );
    view(1, { type: "ready" });
    await settle();
    await settle();
    expect(log()).toEqual(["checkSession:fail session time out, need relogin", "checkSession:ok"]);
  });

  test("what a bindinput handler returns is sent back to replace the input's value", () => {
    const { sent, view } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({
          upper(e) { return e.detail.value.toUpperCase(); },
          count(e) { return e.detail.value.length; },
          keep() {},
        });`,
      },
      { pages: ["pages/index/index"] },
    );
    view(1, { type: "ready" });
    const target = { id: "", dataset: {} };
    const input = (handler: string, replyId: number) =>
      view(1, {
        type: "event",
        ownerId: 0,
        handler,
        replyId,
        event: {
          type: "input",
          timeStamp: 0,
          target,
          currentTarget: target,
          detail: { value: "abc" },
        },
      });
    input("upper", 1);
    input("count", 2);
    input("keep", 3);
    expect(toView(sent, "eventResult")).toEqual([
      { type: "eventResult", replyId: 1, value: "ABC" },
      { type: "eventResult", replyId: 2, value: "3" },
      // Returning nothing keeps what the user typed, but the view still hears back
      { type: "eventResult", replyId: 3, value: undefined },
    ]);
  });

  test("the chooseAvatar button gives the avatar as a temporary file that wx.uploadFile can read", async () => {
    const { view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({ onAvatar(e) { getApp().log.push(e.detail.avatarUrl); } });`,
      },
      { pages: ["pages/index/index"] },
      { auth: { consent: "allow", privacy: { agreed: true } } },
    );
    view(1, { type: "ready" });
    const target = { id: "", dataset: {} };
    view(1, {
      type: "event",
      ownerId: 0,
      handler: "onAvatar",
      openType: "chooseAvatar",
      event: { type: "chooseavatar", timeStamp: 0, target, currentTarget: target, detail: {} },
    });
    await settle();
    const [avatarUrl] = log() as string[];
    expect(avatarUrl).toMatch(/^http:\/\/tmp\/.+\.svg$/);
    const wx = (globalThis as unknown as { wx: Record<string, any> }).wx;
    const content = wx.getFileSystemManager().readFileSync(avatarUrl, "utf8") as string;
    expect(content).toContain("<svg");
  });

  test("a return closes an open page-container instead of the page, and a hidden page is told so its videos pause", async () => {
    const { sent, handle, view } = boot(
      { "app.js": APP, "pages/a/a.js": "Page({});", "pages/b/b.js": "Page({});" },
      { pages: ["pages/a/a", "pages/b/b"] },
    );
    view(1, { type: "ready" });
    const wx = (globalThis as unknown as { wx: Record<string, any> }).wx;
    wx.navigateTo({ url: "/pages/b/b" });
    await settle();
    view(2, { type: "ready" });
    const visibility = (webviewId: number) =>
      sent.flatMap((message) =>
        message.type === "toView" &&
        message.webviewId === webviewId &&
        message.message.type === "pageVisibility"
          ? [message.message.visible]
          : [],
      );
    expect(visibility(1)).toEqual([true, false]);

    view(2, { type: "pageContainer", open: true });
    handle({ type: "navigateBack" });
    await settle();
    await expect(wx.navigateBack()).resolves.toMatchObject({ errMsg: "navigateBack:ok" });
    expect(toView(sent, "closePageContainer")).toHaveLength(2);
    expect(lastRoute(sent).stack.map((entry) => entry.route)).toEqual(["pages/a/a", "pages/b/b"]);

    view(2, { type: "pageContainer", open: false });
    handle({ type: "navigateBack" });
    await settle();
    expect(lastRoute(sent).stack.map((entry) => entry.route)).toEqual(["pages/a/a"]);
    expect(visibility(1)).toEqual([true, false, true]);
  });

  test("a phone number button asks for consent and gives a code for the configured number", async () => {
    const { sent, handle, view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({ onPhone(e) { getApp().log.push(e.detail); } });`,
      },
      { pages: ["pages/index/index"] },
      { auth: { user: { phoneNumber: "13912345678" }, privacy: { agreed: true } } },
    );
    view(1, { type: "ready" });
    const target = { id: "", dataset: {} };
    view(1, {
      type: "event",
      ownerId: 0,
      handler: "onPhone",
      openType: "getPhoneNumber",
      event: { type: "getphonenumber", timeStamp: 0, target, currentTarget: target, detail: {} },
    });
    await settle();
    const ui = sent.find((message) => message.type === "ui") as Extract<
      LogicToShell,
      { type: "ui" }
    >;
    expect(ui).toMatchObject({ name: "phoneNumber", args: { phoneNumber: "139****5678" } });
    expect(log()).toEqual([]);

    handle({ type: "uiResult", callId: ui.callId, result: { allow: true } });
    await settle();
    const [detail] = log() as { code: string; errMsg: string }[];
    expect(detail!.errMsg).toBe("getPhoneNumber:ok");
    const response = mockWechatApi(
      {
        method: "POST",
        url: new URL("https://api.weixin.qq.com/wxa/business/getuserphonenumber"),
        body: JSON.stringify({ code: detail!.code }),
      },
      new Set(),
    );
    expect(response!.json).toMatchObject({
      errcode: 0,
      phone_info: { phoneNumber: "13912345678", purePhoneNumber: "13912345678", countryCode: "86" },
    });
    expect(decodeCode(detail!.code)?.kind).toBe("phone");
  });

  test("denied consent fails authorize, and getSetting remembers the denial", async () => {
    const { view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({ async onLoad() {
          const push = (r) => getApp().log.push(r.errMsg);
          await wx.authorize({ scope: "scope.userLocation" }).then(push, push);
          await wx.authorize({ scope: "scope.userLocation" }).then(push, push);
          await wx.authorize({ scope: "scope.address" }).then(push, push);
          const { authSetting } = await wx.getSetting();
          getApp().log.push(authSetting);
        } });`,
      },
      { pages: ["pages/index/index"] },
      {
        auth: { consent: "deny", privacy: { agreed: true }, authSetting: { "scope.camera": true } },
      },
    );
    view(1, { type: "ready" });
    for (let i = 0; i < 6; i++) await settle();
    expect(log()).toEqual([
      "authorize:fail auth deny",
      "authorize:fail auth deny",
      "authorize:ok",
      { "scope.camera": true, "scope.userLocation": false },
    ]);
  });

  test("getUserProfile needs a tap, keeps it through microtasks and wx.login, and returns the anonymous user", async () => {
    const { sent, view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `
          const push = (r) => getApp().log.push(r.errMsg === "getUserProfile:ok" ? r.userInfo.nickName : r.errMsg);
          const profile = () => wx.getUserProfile({ desc: "展示头像" }).then(push, push);
          Page({
            onLoad() { profile(); },
            async onTap() {
              await Promise.resolve();
              profile();
              setTimeout(profile, 0);
              wx.login({ success: profile });
            },
          });`,
      },
      { pages: ["pages/index/index"] },
      { auth: { user: { nickName: "Alice" }, privacy: { agreed: true } } },
    );
    view(1, { type: "ready" });
    await settle();
    expect(log()).toEqual(["getUserProfile:fail can only be invoked by user TAP gesture."]);

    const target = { id: "", dataset: {} };
    view(1, {
      type: "event",
      ownerId: 0,
      handler: "onTap",
      event: { type: "tap", timeStamp: 0, target, currentTarget: target, detail: {} },
    });
    for (let i = 0; i < 4; i++) await settle();
    expect(
      log()
        .slice(1)
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual([
      "getUserProfile:fail can only be invoked by user TAP gesture.",
      "微信用户",
      "微信用户",
    ]);
    expect(sent.some((message) => message.type === "ui")).toBe(false);
  });

  test("a privacy listener holds the call until the tapped agree button resolves it", async () => {
    const { view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `
          const push = (r) => getApp().log.push(r.errMsg);
          Page({
            onLoad() {
              wx.onNeedPrivacyAuthorization((resolve, info) => {
                getApp().log.push("need " + info.referrer);
                this.resolve = resolve;
              });
              wx.requirePrivacyAuthorize({ success: push, fail: push });
            },
            early() { this.resolve({ event: "agree", buttonId: "agree" }); },
            retry() { wx.requirePrivacyAuthorize({ success: push, fail: push }); },
            onAgree() {
              this.resolve({ event: "agree", buttonId: "agree" });
              wx.getPrivacySetting({ success: (r) => getApp().log.push(r.needAuthorization) });
            },
          });`,
      },
      { pages: ["pages/index/index"] },
    );
    view(1, { type: "ready" });
    await settle();
    const call = (handler: string) =>
      view(1, { type: "event", ownerId: 0, handler, event: tapOn("") });
    call("early");
    await settle();
    call("retry");
    await settle();
    view(1, {
      type: "event",
      ownerId: 0,
      handler: "onAgree",
      openType: "agreePrivacyAuthorization",
      event: { ...tapOn("agree"), type: "agreeprivacyauthorization" },
    });
    for (let i = 0; i < 3; i++) await settle();
    expect(log()).toEqual([
      "need requirePrivacyAuthorize",
      "requirePrivacyAuthorize:fail privacy permission is not authorized",
      "need requirePrivacyAuthorize",
      "requirePrivacyAuthorize:ok",
      false,
    ]);
  });

  test("without a listener the official privacy popup asks, and a refusal is not asked again for ten seconds", async () => {
    const { sent, handle, view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({ async onLoad() {
          const push = (r) => getApp().log.push(r);
          await wx.getLocation().then(push, push);
          await wx.getLocation().then(push, push);
        } });`,
      },
      { pages: ["pages/index/index"], requiredPrivateInfos: ["getLocation"] },
    );
    view(1, { type: "ready" });
    await settle();
    const uis = () =>
      sent.filter(
        (message): message is Extract<LogicToShell, { type: "ui" }> => message.type === "ui",
      );
    expect(uis()).toMatchObject([
      { name: "privacy", args: { contractName: "《Demo小程序隐私保护指引》" } },
    ]);

    handle({ type: "uiResult", callId: uis()[0]!.callId, result: { allow: false } });
    for (let i = 0; i < 4; i++) await settle();
    const refused = { errMsg: "getLocation:fail privacy permission is not authorized", errno: 104 };
    expect(log()).toEqual([refused, refused]);
    expect(uis()).toHaveLength(1);
  });

  test("the capsule shows each capability while it is in use", async () => {
    const { sent, view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `
          const recorder = wx.getRecorderManager();
          recorder.onStop((r) => getApp().log.push("stop " + r.tempFilePath.endsWith(".mp3")));
          Page({
            async onLoad() {
              await wx.startLocationUpdate();
              recorder.start({ format: "mp3" });
            },
            stopRecording() { recorder.stop(); },
            stopLocation() { wx.stopLocationUpdate(); },
          });`,
      },
      { pages: ["pages/index/index"], requiredPrivateInfos: ["startLocationUpdate"] },
      {
        auth: {
          consent: "allow",
          privacy: { agreed: true },
          authSetting: { "scope.camera": false },
        },
      },
    );
    const inUse = () =>
      sent.flatMap((message) => (message.type === "permissionsInUse" ? [message.kinds] : []));
    const call = (handler: string) =>
      view(1, { type: "event", ownerId: 0, handler, event: tapOn("") });
    view(1, { type: "ready" });
    for (let i = 0; i < 6; i++) await settle();
    call("stopRecording");
    await settle();

    // A <camera> the user has denied gets binderror and never shows in the capsule
    view(1, { type: "camera", cameraId: 7, mounted: true });
    for (let i = 0; i < 3; i++) await settle();
    expect(toView(sent, "cameraState")).toEqual([
      { type: "cameraState", cameraId: 7, error: "insertCamera:fail auth deny" },
    ]);

    call("stopLocation");
    await settle();
    expect(log()).toEqual(["stop true"]);
    expect(inUse()).toEqual([["location"], ["record", "location"], ["location"], []]);
  });

  test("setData keys named __proto__ stay in the data and never reach Object.prototype", () => {
    const { sent, view } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({
          data: { items: [1, 2] },
          onLoad() { this.setData({ "__proto__.polluted": 1, "a.__proto__": 2, "items.length": 0 }); },
        });`,
      },
      { pages: ["pages/index/index"] },
    );
    view(1, { type: "ready" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.stringify(toView(sent, "init")[0])).toContain(
      '"items":[],"__proto__":{"polluted":1},"a":{"__proto__":2}',
    );
  });

  test("a privacy listener that throws falls back to the official popup", async () => {
    const { sent, view } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({ onLoad() {
          wx.onNeedPrivacyAuthorization(() => { throw new Error("broken"); });
          wx.requirePrivacyAuthorize({});
        } });`,
      },
      { pages: ["pages/index/index"] },
    );
    view(1, { type: "ready" });
    for (let i = 0; i < 3; i++) await settle();
    expect(sent.filter((message) => message.type === "ui")).toMatchObject([{ name: "privacy" }]);
  });

  test("windowHeight is the current page's window: without the tab bar, or the full screen with a custom navigation bar", async () => {
    const { view, log } = boot(
      {
        "app.js": APP,
        "pages/tab/tab.js": `Page({ onLoad() {
          getApp().log.push(wx.getSystemInfoSync().windowHeight);
          wx.navigateTo({ url: "/pages/custom/custom" });
        } });`,
        "pages/custom/custom.js": `Page({ onLoad() {
          const { windowHeight, screenTop } = wx.getWindowInfo();
          getApp().log.push(windowHeight, screenTop);
        } });`,
      },
      {
        pages: ["pages/tab/tab", "pages/custom/custom"],
        tabBar: { list: [{ pagePath: "pages/tab/tab" }] },
      },
      {},
      { "pages/custom/custom": { navigationStyle: "custom" } },
    );
    view(1, { type: "ready" });
    await settle();
    view(2, { type: "ready" });
    await settle();
    // screenHeight 667, navigation bar 64, tab bar 50
    expect(log()).toEqual([553, 667, 0]);
  });

  test("a selector query takes its reply only from its own WebView, and finds nothing once that WebView closes", async () => {
    const { sent, view, log } = boot(
      {
        "app.js": APP,
        "pages/a/a.js": `Page({ onLoad() { wx.navigateTo({ url: "/pages/b/b" }); } });`,
        "pages/b/b.js": `Page({ onLoad() {
          wx.createSelectorQuery().select("#x").boundingClientRect().exec((r) => getApp().log.push(r));
        } });`,
      },
      { pages: ["pages/a/a", "pages/b/b"] },
    );
    view(1, { type: "ready" });
    await settle();
    view(2, { type: "ready" });
    await settle();
    const [query] = toView(sent, "query") as { queryId: number }[];
    view(1, { type: "queryResult", queryId: query!.queryId, results: [{ forged: true }] });
    await settle();
    expect(log()).toEqual([]);

    (globalThis as unknown as { wx: { navigateBack(): void } }).wx.navigateBack();
    for (let i = 0; i < 3; i++) await settle();
    expect(log()).toEqual([[null]]);
  });

  test("navigateTo hides the opener, navigateBack unloads the top page, and tab pages refuse navigateTo", async () => {
    const page = (name: string) => `
      const log = (entry) => getApp().log.push("${name} " + entry);
      Page({
        onLoad(q) { log("load " + JSON.stringify(q)); },
        onShow() { log("show"); },
        onHide() { log("hide"); },
        onUnload() { log("unload"); },
      });`;
    const { sent, view, log } = boot(
      {
        "app.js": APP,
        "pages/home/home.js": page("home"),
        "pages/detail/detail.js": `${page("detail")}
          getApp().go = (url) => wx.navigateTo({ url }).then((r) => r.errMsg, (e) => e.errMsg);`,
      },
      {
        pages: ["pages/home/home", "pages/detail/detail"],
        tabBar: { list: [{ pagePath: "pages/home/home", text: "Home" }] },
      },
    );
    view(1, { type: "ready" });
    // The navigator component sends its open-type, resolved against its page
    view(1, { type: "navigate", openType: "navigate", url: "../detail/detail?id=7" });
    const go = () => (globalThis as any).getApp().go as (url: string) => Promise<string>;
    expect(lastRoute(sent).stack.map((entry) => entry.route)).toEqual([
      "pages/home/home",
      "pages/detail/detail",
    ]);
    view(2, { type: "ready" });
    expect(await go()("/pages/home/home")).toBe("navigateTo:fail can not navigateTo a tabbar page");

    (globalThis as any).wx.navigateBack();
    await settle();
    expect(lastRoute(sent).alive).toEqual([{ webviewId: 1, route: "pages/home/home" }]);
    expect(log()).toEqual([
      "home load {}",
      "home show",
      "home hide",
      'detail load {"id":"7"}',
      "detail show",
      "detail unload",
      "home show",
    ]);
  });

  test("components receive properties, run observers and trigger events on their owner", () => {
    const { sent, view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({ onChange(e) { getApp().log.push(["change", e.detail, e.target.id]); } });`,
        "components/counter/counter.js": `Component({
          properties: { start: { type: Number, value: 0 }, label: String },
          data: { doubled: 0 },
          observers: { start(value) { this.setData({ doubled: value * 2 }); } },
          lifetimes: { attached() { getApp().log.push(["attached", this.data.start, this.data.label]); } },
          methods: { bump() { this.triggerEvent("change", { value: this.data.start + 1 }); } },
        });`,
      },
      { pages: ["pages/index/index"] },
    );
    view(1, { type: "ready" });
    view(1, {
      type: "attach",
      nodeId: 1,
      ownerId: 0,
      path: "components/counter/counter",
      props: { start: "3", label: "Clicks", class: "x" },
      listeners: { change: { handler: "onChange", catch: false } },
      id: "counter",
      dataset: {},
    });
    const [init] = toView(sent, "componentInit");
    expect(init).toMatchObject({
      nodeId: 1,
      data: { start: 3, label: "Clicks", doubled: 6 },
      options: { styleIsolation: "isolated" },
    });

    view(1, {
      type: "props",
      nodeId: 1,
      props: { start: 5 },
      listeners: {},
      id: "counter",
      dataset: {},
    });
    expect(toView(sent, "setData").at(-1)).toMatchObject({ nodeId: 1, patch: { doubled: 10 } });

    // The host's id changed in the owner's template: selectComponent finds it by the new id only
    view(1, {
      type: "props",
      nodeId: 1,
      props: { start: 5 },
      listeners: { change: { handler: "onChange", catch: false } },
      id: "renamed",
      dataset: { kind: "main" },
    });
    const page = (globalThis as any).getCurrentPages()[0];
    expect(page.selectComponent("#counter")).toBeNull();
    page.selectComponent("#renamed").bump();
    expect(log()).toEqual([
      ["attached", 3, "Clicks"],
      ["change", { value: 6 }, "renamed"],
    ]);
  });

  test("navigateTo connects the opener and the new page with an event channel", async () => {
    const { view, log } = boot(
      {
        "app.js": APP,
        "pages/list/list.js": `Page({
          async onLoad() {
            const { eventChannel } = await wx.navigateTo({
              url: "/pages/detail/detail",
              events: { saved: (value) => getApp().log.push("opener got " + value) },
            });
            // Emitted before the new page has loaded: it waits for the listener
            eventChannel.emit("item", { id: 7 });
          },
        });`,
        "pages/detail/detail.js": `Page({
          onLoad() {
            const channel = this.getOpenerEventChannel();
            channel.on("item", (item) => {
              getApp().log.push("detail got " + item.id);
              channel.emit("saved", item.id * 2);
            });
          },
        });`,
      },
      { pages: ["pages/list/list", "pages/detail/detail"] },
    );
    view(1, { type: "ready" });
    await settle();
    expect(log()).toEqual([]);
    view(2, { type: "ready" });
    expect(log()).toEqual(["detail got 7", "opener got 14"]);
  });

  test("a button event answered after its page was closed does not reach the page", async () => {
    const { sent, handle, view, log } = boot(
      {
        "app.js": APP,
        "pages/a/a.js": `Page({ onPhone(e) { getApp().log.push("a " + e.detail.errMsg); } });`,
        "pages/b/b.js": `Page({});`,
      },
      { pages: ["pages/a/a", "pages/b/b"] },
      { auth: { privacy: { agreed: true } } },
    );
    view(1, { type: "ready" });
    const target = { id: "", dataset: {} };
    view(1, {
      type: "event",
      ownerId: 0,
      handler: "onPhone",
      openType: "getPhoneNumber",
      event: { type: "getphonenumber", timeStamp: 0, target, currentTarget: target, detail: {} },
    });
    await settle();
    const ui = sent.find((message) => message.type === "ui") as Extract<
      LogicToShell,
      { type: "ui" }
    >;
    (globalThis as any).wx.redirectTo({ url: "/pages/b/b" });
    await settle();
    handle({ type: "uiResult", callId: ui.callId, result: { allow: true } });
    for (let i = 0; i < 3; i++) await settle();
    expect(log()).toEqual([]);
  });

  test("pull-down refresh: the API starts the view's animation and the view's refresh reaches the page", async () => {
    const { sent, view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({
          onLoad() { wx.startPullDownRefresh(); },
          onPullDownRefresh() { getApp().log.push("refresh"); wx.stopPullDownRefresh(); },
        });`,
      },
      { pages: ["pages/index/index"] },
    );
    view(1, { type: "ready" });
    await settle();
    // The page hears of the refresh only once the view starts it
    expect(log()).toEqual([]);
    view(1, { type: "pullDownRefresh" });
    await settle();
    expect(log()).toEqual(["refresh"]);
    expect(toView(sent, "pullDownRefresh")).toEqual([
      { type: "pullDownRefresh", refreshing: true },
      { type: "pullDownRefresh", refreshing: false },
    ]);
  });

  test("a page's <navigation-bar> sets the title, colors and loading of its own navigation bar", () => {
    const { sent, view } = boot(
      { "app.js": APP, "pages/index/index.js": `Page({});` },
      { pages: ["pages/index/index"] },
    );
    view(1, { type: "ready" });
    view(1, {
      type: "navigationBar",
      attributes: {
        title: "详情",
        loading: true,
        "front-color": "#ffffff",
        "background-color": "#07c160",
        "color-animation-duration": "300",
        "color-animation-timing-func": "easeIn",
      },
    });
    const uis = sent.flatMap((message) =>
      message.type === "ui" ? [{ name: message.name, args: message.args }] : [],
    );
    expect(uis).toEqual([
      { name: "setNavigationBarTitle", args: { webviewId: 1, title: "详情" } },
      {
        name: "setNavigationBarColor",
        args: {
          webviewId: 1,
          frontColor: "#ffffff",
          backgroundColor: "#07c160",
          animation: { duration: 300, timingFunc: "easeIn" },
        },
      },
      { name: "showNavigationBarLoading", args: { webviewId: 1 } },
    ]);
  });

  test("a scanCode camera sees the configured code, and the background stops and restarts it", async () => {
    const { sent, handle, view } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({ frames() {
          const listener = wx.createCameraContext().onCameraFrame((frame) => {
            getApp().log.push([frame.width, frame.height]);
            listener.stop();
          });
          listener.start();
        } });`,
      },
      { pages: ["pages/index/index"] },
      {
        auth: { privacy: { agreed: true }, authSetting: { "scope.camera": true } },
        scanCode: { result: "hello", scanType: "QR_CODE" },
      },
    );
    view(1, { type: "ready" });
    view(1, { type: "camera", cameraId: 1, mounted: true, mode: "scanCode", frameSize: "small" });
    for (let i = 0; i < 4; i++) await settle();
    expect(toView(sent, "cameraState")).toEqual([
      {
        type: "cameraState",
        cameraId: 1,
        scan: { type: "QR_CODE", result: "hello", charSet: "utf-8", rawData: btoa("hello") },
      },
    ]);
    currentPage().frames();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((globalThis as any).getApp().log).toEqual([[144, 192]]);

    handle({ type: "appHide" });
    handle({ type: "appShow" });
    expect(toView(sent, "cameraState").slice(1)).toEqual([
      { type: "cameraState", cameraId: 1, stopped: true },
      { type: "cameraState", cameraId: 1, stopped: false },
    ]);
  });

  test("a live-pusher needs the camera and the microphone, and the background reaches live components", async () => {
    const { sent, handle, view } = boot(
      { "app.js": APP, "pages/index/index.js": `Page({});` },
      { pages: ["pages/index/index"] },
      {
        auth: {
          privacy: { agreed: true },
          authSetting: { "scope.camera": true, "scope.record": false },
        },
      },
    );
    view(1, { type: "ready" });
    view(1, { type: "livePusher", pusherId: 1, mounted: true });
    for (let i = 0; i < 4; i++) await settle();
    // Allowed the camera but refused the microphone: error 10002, and nothing in use
    expect(toView(sent, "livePusherState")).toEqual([
      {
        type: "livePusherState",
        pusherId: 1,
        errCode: 10002,
        errMsg: "insertLivePusher:fail record auth deny",
      },
    ]);
    expect(sent.some((message) => message.type === "permissionsInUse")).toBe(false);

    handle({ type: "appHide" });
    handle({ type: "appShow" });
    expect(toView(sent, "pageVisibility").slice(-2)).toEqual([
      { type: "pageVisibility", visible: false, background: true },
      { type: "pageVisibility", visible: true, background: true },
    ]);
  });

  test("a live-pusher the user allows holds the camera and the microphone until it is removed", async () => {
    const { sent, view } = boot(
      { "app.js": APP, "pages/index/index.js": `Page({});` },
      { pages: ["pages/index/index"] },
      {
        auth: {
          privacy: { agreed: true },
          authSetting: { "scope.camera": true, "scope.record": true },
        },
      },
    );
    view(1, { type: "ready" });
    view(1, { type: "livePusher", pusherId: 2, mounted: true });
    for (let i = 0; i < 4; i++) await settle();
    view(1, { type: "livePusher", pusherId: 2, mounted: false });
    await settle();
    expect(toView(sent, "livePusherState")).toEqual([{ type: "livePusherState", pusherId: 2 }]);
    const inUse = sent.flatMap((message) =>
      message.type === "permissionsInUse" ? [message.kinds] : [],
    );
    expect(inUse).toEqual([["camera"], ["camera", "record"], ["record"], []]);
  });

  test("a camera moved while it waits for consent shows in the capsule once", async () => {
    const { sent, handle, view } = boot(
      { "app.js": APP, "pages/index/index.js": `Page({});` },
      { pages: ["pages/index/index"] },
      { auth: { privacy: { agreed: true } } },
    );
    view(1, { type: "ready" });
    // Moving an element in the DOM removes and inserts it again
    view(1, { type: "camera", cameraId: 3, mounted: true });
    await settle();
    view(1, { type: "camera", cameraId: 3, mounted: false });
    view(1, { type: "camera", cameraId: 3, mounted: true });
    await settle();
    const ui = sent.find((message) => message.type === "ui") as Extract<
      LogicToShell,
      { type: "ui" }
    >;
    handle({ type: "uiResult", callId: ui.callId, result: { allow: true } });
    for (let i = 0; i < 4; i++) await settle();
    view(1, { type: "camera", cameraId: 3, mounted: false });
    await settle();
    const inUse = sent.flatMap((message) =>
      message.type === "permissionsInUse" ? [message.kinds] : [],
    );
    expect(inUse).toEqual([["camera"], []]);
    expect(toView(sent, "cameraState")).toEqual([{ type: "cameraState", cameraId: 3 }]);
  });

  test("triggerEvent reaches the host, bubbles within its owner's template, and crosses components when composed", () => {
    // The example from WeChat's component event guide: my-component sits in another-component's slot
    const { view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({
          pageEventListener1(e) { getApp().log.push("page1 " + e.currentTarget.id + " " + e.target.id); },
          pageEventListener2(e) { getApp().log.push("page2 " + e.currentTarget.id); },
        });`,
        "components/another/another.js": `Component({ methods: { anotherEventListener() { getApp().log.push("another"); } } });`,
        "components/mine/mine.js": `Component({ methods: { fire(options) { this.triggerEvent("customevent", {}, options); } } });`,
      },
      { pages: ["pages/index/index"] },
    );
    view(1, { type: "ready" });
    attachAll(view, [
      [1, 0, "components/another/another", "another"],
      [2, 0, "components/mine/mine", "mine"],
    ]);
    const place = (catchInAnother: boolean) =>
      view(1, {
        type: "tree",
        nodes: [
          tree(1, 0, "another-component", "", [bind("customevent", "pageEventListener1")]),
          tree(
            2,
            1,
            "my-component",
            "",
            [bind("customevent", "pageEventListener2")],
            [
              {
                ownerId: 1,
                id: "",
                dataset: {},
                events: [bind("customevent", "anotherEventListener", catchInAnother)],
              },
              {
                ownerId: 0,
                id: "another",
                dataset: {},
                events: [bind("customevent", "pageEventListener1")],
              },
            ],
          ),
        ],
      });
    place(false);
    const mine = currentPage().selectComponent("#mine");
    const fire = (options: object) => {
      log().length = 0;
      mine.fire(options);
      return [...log()];
    };
    expect(fire({})).toEqual(["page2 mine"]);
    expect(fire({ bubbles: true })).toEqual(["page2 mine", "page1 another mine"]);
    expect(fire({ bubbles: true, composed: true })).toEqual([
      "page2 mine",
      "another",
      "page1 another mine",
    ]);
    // A catch binding inside another-component stops the event there
    place(true);
    expect(fire({ bubbles: true, composed: true })).toEqual(["page2 mine", "another"]);
  });

  test("selectComponent matches tags, ids, classes and combinators within the caller's template", () => {
    const empty = "Component({});";
    const { view } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": "Page({});",
        "components/list/list.js": empty,
        "components/item/item.js": empty,
        "components/wrap/wrap.js": empty,
        "components/outer/outer.js": empty,
      },
      { pages: ["pages/index/index"] },
    );
    view(1, { type: "ready" });
    // <list class="list"><item class="item a" id="i1"/><item class="item" id="i2"/><wrap><item id="i5"/></wrap></list>
    // <item class="item" id="i3"/><outer id="o"/>, where outer's template has <item class="item inner" id="i4"/>
    attachAll(view, [
      [1, 0, "components/list/list", "l"],
      [2, 0, "components/item/item", "i1"],
      [3, 0, "components/item/item", "i2"],
      [7, 0, "components/wrap/wrap", "w"],
      [8, 0, "components/item/item", "i5"],
      [4, 0, "components/item/item", "i3"],
      [5, 0, "components/outer/outer", "o"],
      [6, 5, "components/item/item", "i4"],
    ]);
    view(1, {
      type: "tree",
      nodes: [
        tree(1, 0, "list", "list"),
        tree(2, 1, "item", "item a"),
        tree(3, 1, "item", "item"),
        tree(7, 1, "wrap"),
        tree(8, 7, "item"),
        tree(4, 0, "item", "item"),
        tree(5, 0, "outer"),
        tree(6, 5, "item", "item inner"),
      ],
    });
    const page = currentPage();
    const ids = (selector: string, from = page) =>
      from.selectAllComponents(selector).map((comp: { id: string }) => comp.id);
    expect(ids(".item")).toEqual(["i1", "i2", "i3"]);
    expect(ids("item")).toEqual(["i1", "i2", "i5", "i3"]);
    expect(ids("item.a")).toEqual(["i1"]);
    expect(ids(".list item")).toEqual(["i1", "i2", "i5"]);
    expect(ids(".list > item")).toEqual(["i1", "i2"]);
    expect(ids("#i3, .a")).toEqual(["i1", "i3"]);
    expect(ids("#o .item")).toEqual([]);
    expect(ids("#o >>> .item")).toEqual(["i4"]);
    expect(ids(".inner", page.selectComponent("#o"))).toEqual(["i4"]);
    expect(page.selectComponent(".missing")).toBeNull();
    expect(page.selectComponent("#i4")).toBeNull();
    expect(page.selectComponent("#o").selectComponent("#i4").selectOwnerComponent().id).toBe("o");
  });

  test("relations link parents and children, and built-in behaviors and definition filters apply", () => {
    const { sent, view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": "Page({});",
        "components/list/list.js": `Component({
          behaviors: ["wx://component-export"],
          relations: { "../item/item": {
            type: "child",
            linked(target) { getApp().log.push("list linked " + target.id); },
            unlinked(target) { getApp().log.push("list unlinked " + target.id); },
          } },
          export() { return { kind: "list" }; },
        });`,
        "components/item/item.js": `
          const marker = Behavior({
            definitionFilter(fields) { fields.data = Object.assign({}, fields.data, { filtered: true }); },
          });
          Component({
            behaviors: [marker, "wx://form-field"],
            relations: { "../list/list": { type: "parent", linked(target) { getApp().log.push("item linked " + target.is); } } },
            methods: { marked() { return this.hasBehavior(marker); } },
          });`,
      },
      { pages: ["pages/index/index"] },
    );
    view(1, { type: "ready" });
    attachAll(view, [
      [1, 0, "components/list/list", "l"],
      [2, 0, "components/item/item", "i1", { name: "size", value: "L" }],
      [3, 0, "components/item/item", "i2"],
    ]);
    view(1, {
      type: "tree",
      nodes: [tree(1, 0, "list"), tree(2, 1, "item"), tree(3, 1, "item")],
    });
    expect([...(log() as string[])].sort((a, b) => a.localeCompare(b))).toEqual([
      "item linked components/list/list",
      "item linked components/list/list",
      "list linked i1",
      "list linked i2",
    ]);
    const page = currentPage();
    // wx://component-export: selectComponent returns what export returns
    expect(page.selectComponent("#l")).toEqual({ kind: "list" });
    const item = page.selectComponent("#i1");
    const list = item.getRelationNodes("../list/list")[0];
    expect(list.getRelationNodes("../item/item").map((comp: { id: string }) => comp.id)).toEqual([
      "i1",
      "i2",
    ]);
    // wx://form-field adds the name and value properties, and a form submits them
    expect(item.data).toMatchObject({ name: "size", value: "L", filtered: true });
    expect(item.marked()).toBe(true);
    expect(item.hasBehavior("wx://form-field")).toBe(true);
    expect(list.hasBehavior("wx://form-field")).toBe(false);
    const inits = toView(sent, "componentInit") as { nodeId: number; options: object }[];
    expect(inits.find((init) => init.nodeId === 2)!.options).toMatchObject({ formField: true });

    log().length = 0;
    view(1, { type: "detach", nodeIds: [3] });
    expect(log()).toEqual(["list unlinked i2"]);
    expect(list.getRelationNodes("../item/item")).toHaveLength(1);
  });

  test("pure data fields stay in the logic layer, and routers resolve against the component's path", async () => {
    const { sent, view } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": "Page({});",
        "pages/detail/detail.js": "Page({});",
        "components/card/card.js": `Component({
          options: { pureDataPattern: /^_/ },
          data: { _raw: 1, shown: 2 },
          methods: { update() { this.setData({ _raw: 3, shown: 4 }); } },
        });`,
      },
      { pages: ["pages/index/index", "pages/detail/detail"] },
    );
    view(1, { type: "ready" });
    attachAll(view, [[1, 0, "components/card/card", "card"]]);
    const card = currentPage().selectComponent("#card");
    card.update();
    expect(toView(sent, "componentInit")[0]).toMatchObject({ data: { shown: 2 } });
    expect((toView(sent, "componentInit")[0] as { data: object }).data).not.toHaveProperty("_raw");
    expect(toView(sent, "setData").at(-1)).toMatchObject({ nodeId: 1, patch: { shown: 4 } });
    expect((toView(sent, "setData").at(-1) as { patch: object }).patch).not.toHaveProperty("_raw");
    expect(card.data._raw).toBe(3);

    card.router.navigateTo({ url: "../../pages/detail/detail?id=7" });
    await settle();
    expect(lastRoute(sent).stack.map((entry) => entry.route)).toEqual([
      "pages/index/index",
      "pages/detail/detail",
    ]);
  });

  test("a launch page that does not exist calls onPageNotFound, which may redirect", async () => {
    const pages = ["pages/index/index", "pages/other/other"];
    const files = {
      "app.js": `App({ log: [], onPageNotFound(res) { this.log.push(res); wx.redirectTo({ url: "/pages/other/other" }); } });`,
      "pages/index/index.js": "Page({});",
      "pages/other/other.js": "Page({});",
    };
    const launch = { path: "pages/missing/missing", query: { a: "1" } };
    const redirected = boot(files, { pages }, {}, {}, launch);
    await settle();
    expect(redirected.log()).toEqual([
      { path: "pages/missing/missing", query: { a: "1" }, isEntryPage: true },
    ]);
    expect(lastRoute(redirected.sent).stack.map((entry) => entry.route)).toEqual([
      "pages/other/other",
    ]);

    // Without a redirect, the entry page opens
    const plain = boot({ ...files, "app.js": APP }, { pages }, {}, {}, launch);
    await settle();
    expect(lastRoute(plain.sent).stack.map((entry) => entry.route)).toEqual(["pages/index/index"]);
  });

  test("a tab page's custom tab bar exists in onShow and is the component the view attaches", () => {
    const { sent, view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({ onShow() { this.getTabBar().setData({ selected: 1 }); } });`,
        "custom-tab-bar/index.js": `Component({
          data: { selected: 0 },
          lifetimes: { attached() { getApp().log.push("attached"); } },
        });`,
      },
      {
        pages: ["pages/index/index"],
        tabBar: { custom: true, list: [{ pagePath: "pages/index/index" }] },
      },
    );
    view(1, { type: "ready" });
    attachAll(view, [[4, 0, "custom-tab-bar/index", ""]]);
    expect(toView(sent, "componentInit")).toMatchObject([{ nodeId: 4, data: { selected: 1 } }]);
    expect(log()).toEqual(["attached"]);
    const page = currentPage();
    page.getTabBar().setData({ selected: 0 });
    expect(toView(sent, "setData").at(-1)).toMatchObject({ nodeId: 4, patch: { selected: 0 } });
  });

  /** Sends a button open-type event of page 1, as the view does after a tap. */
  const openTypeEvent = (
    view: (webviewId: number, message: ViewToLogic) => void,
    openType: string,
    type: string,
    handler: string,
    openTypeProps?: Record<string, unknown>,
  ) => {
    const target = { id: "", dataset: {} };
    view(1, {
      type: "event",
      ownerId: 0,
      handler,
      openType,
      openTypeProps,
      event: { type, timeStamp: 0, target, currentTarget: target, detail: {} },
    });
  };
  const uiCalls = (sent: LogicToShell[], name: string) =>
    sent.filter(
      (message): message is Extract<LogicToShell, { type: "ui" }> =>
        message.type === "ui" && message.name === name,
    );

  test("the openSetting button shows the scopes asked for, and a switch turned on there reaches getSetting", async () => {
    const { sent, handle, view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({ onSetting(e) { getApp().log.push(e.detail); } });`,
      },
      { pages: ["pages/index/index"] },
      { auth: { authSetting: { "scope.userLocation": false, "scope.camera": true } } },
    );
    view(1, { type: "ready" });
    openTypeEvent(view, "openSetting", "opensetting", "onSetting");
    await settle();
    const [ui] = uiCalls(sent, "openSetting");
    expect(ui!.args).toMatchObject({
      appName: "Demo",
      scopes: [
        { scope: "scope.userLocation", description: "获取你的位置信息", allowed: false },
        { scope: "scope.camera", description: "使用你的摄像头", allowed: true },
      ],
    });
    // The event fires only when the user goes back
    expect(log()).toEqual([]);

    handle({
      type: "uiResult",
      callId: ui!.callId,
      result: { authSetting: { "scope.userLocation": true, "scope.camera": true } },
    });
    await settle();
    const authSetting = { "scope.userLocation": true, "scope.camera": true };
    expect(log()).toEqual([{ authSetting, errMsg: "openSetting:ok" }]);
    const wx = (globalThis as unknown as { wx: Record<string, any> }).wx;
    await expect(wx.getSetting()).resolves.toMatchObject({ authSetting });
  });

  test("the contact button fires bindcontact once the chat closes, with the tapped card's path and query", async () => {
    const { sent, handle, view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({ onContact(e) { getApp().log.push(e.detail); } });`,
      },
      { pages: ["pages/index/index"] },
    );
    view(1, { type: "ready" });
    openTypeEvent(view, "contact", "contact", "onContact", {
      "show-message-card": true,
      "send-message-title": "Order 7",
      "send-message-img": "/images/order.png",
      "send-message-path": "pages/order/order?id=7&from=chat",
    });
    await settle();
    const [withCard] = uiCalls(sent, "contact");
    expect(withCard!.args).toEqual({
      appName: "Demo",
      card: {
        title: "Order 7",
        img: "/images/order.png",
        path: "pages/order/order?id=7&from=chat",
      },
    });
    expect(log()).toEqual([]);
    handle({ type: "uiResult", callId: withCard!.callId, result: { tapped: true } });
    await settle();

    // Closed without tapping a card: path and query are empty
    openTypeEvent(view, "contact", "contact", "onContact", {});
    await settle();
    const [, plain] = uiCalls(sent, "contact");
    expect(plain!.args).toEqual({ appName: "Demo" });
    handle({ type: "uiResult", callId: plain!.callId, result: {} });
    await settle();
    expect(log()).toEqual([
      { path: "pages/order/order", query: { id: "7", from: "chat" }, errMsg: "enterContact:ok" },
      { path: "", query: {}, errMsg: "enterContact:ok" },
    ]);
  });

  test("the launchApp button fails with invalid scene, and the feedback button fires nothing", async () => {
    const { sent, view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({ onError(e) { getApp().log.push(e.type, e.detail); } });`,
      },
      { pages: ["pages/index/index"] },
    );
    view(1, { type: "ready" });
    // The view sends launchApp as the button's error event
    openTypeEvent(view, "launchApp", "error", "onError");
    openTypeEvent(view, "feedback", "", "onError");
    await settle();
    expect(log()).toEqual(["error", { errMsg: "invalid scene" }]);
    expect(uiCalls(sent, "feedback")).toHaveLength(1);
  });

  test("the getPhoneNumber detail has encrypted data and an iv next to the code, for older backends", async () => {
    const { view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({ onPhone(e) { getApp().log.push(e.detail); } });`,
      },
      { pages: ["pages/index/index"] },
      { auth: { consent: "allow", privacy: { agreed: true } } },
    );
    view(1, { type: "ready" });
    openTypeEvent(view, "getPhoneNumber", "getphonenumber", "onPhone");
    await settle();
    const [detail] = log() as Record<string, string>[];
    expect(detail).toMatchObject({ errMsg: "getPhoneNumber:ok" });
    expect(decodeCode(detail!.code!)).toMatchObject({ kind: "phone" });
    expect(detail!.encryptedData).toMatch(/^[A-Za-z0-9+/]{100,}={0,2}$/);
    expect(atob(detail!.iv!)).toHaveLength(16);
    expect(detail!.cloudID).toMatch(/^\w+$/);
  });

  test("a long press on an image with show-menu-by-longpress opens WeChat's image menu", async () => {
    const { sent, view, handle } = boot(
      { "app.js": APP, "pages/index/index.js": "Page({});" },
      { pages: ["pages/index/index"] },
    );
    view(1, { type: "ready" });
    view(1, { type: "imageMenu" });
    await settle();
    const uis = () =>
      sent.filter((message) => message.type === "ui") as Extract<LogicToShell, { type: "ui" }>[];
    expect(uis()[0]).toMatchObject({
      name: "showActionSheet",
      args: { itemList: ["发送给朋友", "收藏", "保存图片", "搜一搜"] },
    });

    handle({ type: "uiResult", callId: uis()[0]!.callId, result: { tapIndex: 2 } });
    await settle();
    expect(uis()[1]).toMatchObject({ name: "showToast", args: { title: "已保存到系统相册" } });
  });

  test("a navigator to another Mini Program reports to its success and complete, and exit leaves", async () => {
    const { sent, view, log } = boot(
      {
        "app.js": APP,
        "pages/index/index.js": `Page({ on(e) { getApp().log.push([e.type, e.detail.errMsg]); } });`,
      },
      { pages: ["pages/index/index"] },
      { auth: { consent: "allow" } },
    );
    view(1, { type: "ready" });
    const target = { id: "nav", dataset: {} };
    const handlers = {
      success: { ownerId: 0, handler: "on" },
      fail: { ownerId: 0, handler: "on" },
      complete: { ownerId: 0, handler: "on" },
    };
    view(1, {
      type: "navigateMiniProgram",
      openType: "navigate",
      props: { "app-id": "wx1111111111111111", path: "pages/a/a" },
      target,
      handlers,
    });
    for (let i = 0; i < 4; i++) await settle();
    expect(log()).toEqual([
      ["success", "navigateToMiniProgram:ok"],
      ["complete", "navigateToMiniProgram:ok"],
    ]);

    view(1, { type: "navigateMiniProgram", openType: "exit", props: {}, target, handlers });
    for (let i = 0; i < 4; i++) await settle();
    expect(sent.filter((message) => message.type === "exit")).toHaveLength(1);
  });

  test("official-account shows only after a launch from a scanned code", async () => {
    const files = { "app.js": APP, "pages/index/index.js": "Page({});" };
    const state = (config: SimulatorConfig, scene?: number) => {
      const { sent, view } = boot(
        files,
        { pages: ["pages/index/index"] },
        config,
        {},
        undefined,
        scene,
      );
      view(1, { type: "ready" });
      view(1, { type: "officialAccount", accountId: 1 });
      return toView(sent, "officialAccountState")[0];
    };
    expect(state({})).toMatchObject({ status: 5, errMsg: "场景值错误" });
    expect(state({ officialAccount: { name: "Demo News" } }, 1047)).toEqual({
      type: "officialAccountState",
      accountId: 1,
      status: 0,
      errMsg: "ok",
      name: "Demo News",
    });
    expect(state({ officialAccount: { status: 4 } }, 1011)).toMatchObject({ status: 4 });
  });
});
