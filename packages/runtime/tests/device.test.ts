import { describe, expect, test } from "vite-plus/test";
import { MemoryFs, startLogic } from "../src/index.ts";
import type { LogicToShell, SimulatorConfig, ViewToLogic } from "../src/index.ts";

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
      config,
    },
    system: SYSTEM,
    menuButton: MENU_BUTTON,
    chrome: { navigationBar: 64, tabBar: 50 },
    appService,
  });
  const view = (webviewId: number, message: ViewToLogic) =>
    handle({ type: "view", webviewId, message });
  const log = () => (globalThis as unknown as { getApp(): { log: unknown[] } }).getApp().log;
  const uis = () =>
    sent.filter(
      (message): message is Extract<LogicToShell, { type: "ui" }> => message.type === "ui",
    );
  const answered = new Set<number>();
  /** Answers the latest UI of that name still waiting for its result. */
  const answer = (name: string, result: Record<string, unknown>) => {
    const ui = uis().findLast((message) => message.name === name && !answered.has(message.callId));
    if (!ui) throw new Error(`no "${name}" UI is waiting`);
    answered.add(ui.callId);
    handle({ type: "uiResult", callId: ui.callId, result });
  };
  const tap = (handler: string) => {
    const target = { id: "", dataset: {} };
    view(1, {
      type: "event",
      ownerId: 0,
      handler,
      event: { type: "tap", timeStamp: 0, target, currentTarget: target, detail: {} },
    });
  };
  view(1, { type: "ready" });
  return { sent, handle, view, log, uis, answer, tap };
}

const settle = async (times = 4) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const APP = "App({ log: [] });";
const PAGE = "pages/index/index";
const AGREED = { auth: { privacy: { agreed: true } } } satisfies SimulatorConfig;
/** A page whose handlers run the given code, with `push` logging a result. */
const page = (handlers: Record<string, string>) => ({
  "app.js": APP,
  [`${PAGE}.js`]: `
    const push = (r) => getApp().log.push(r);
    Page({ ${Object.entries(handlers)
      .map(([name, body]) => `async ${name}() { ${body} }`)
      .join(",\n")} });`,
});

describe("device and open APIs", () => {
  test("getClipboardData returns what setClipboardData copied, and copying shows WeChat's toast", async () => {
    const { log, uis, tap } = boot(
      page({
        onLoad: `push((await wx.getClipboardData()).data);`,
        copy: `
          push((await wx.setClipboardData({ data: "订单 42" })).errMsg);
          push(await wx.getClipboardData());
          await wx.setClipboardData({ data: 42 }).catch((e) => push(e.errMsg));`,
      }),
      { pages: [PAGE] },
      AGREED,
    );
    await settle();
    tap("copy");
    await settle(8);
    expect(log()).toEqual([
      "",
      "setClipboardData:ok",
      { data: "订单 42", errMsg: "getClipboardData:ok" },
      "setClipboardData:fail parameter error: parameter.data should be String instead of Number;",
    ]);
    expect(uis()).toMatchObject([{ name: "showToast", args: { title: "内容已复制" } }]);
  });

  test("requestSubscribeMessage needs a tap and maps every template id to the user's choice", async () => {
    const { log, uis, answer, tap } = boot(
      page({
        onLoad: `await wx.requestSubscribeMessage({ tmplIds: ["t-1"] }).catch(push);`,
        subscribe: `wx.requestSubscribeMessage({ tmplIds: ["t-1", "t-2"], success: push, fail: push });`,
        empty: `wx.requestSubscribeMessage({ tmplIds: [], fail: push });`,
      }),
      { pages: [PAGE] },
    );
    await settle();
    expect(log()).toEqual([
      { errMsg: "requestSubscribeMessage:fail can only be invoked by user TAP gesture." },
    ]);

    tap("empty");
    await settle();
    expect(log()[1]).toEqual({
      errMsg: "requestSubscribeMessage:fail TmplIds can't be empty",
      errCode: 10001,
    });

    tap("subscribe");
    await settle();
    expect(uis()).toMatchObject([{ name: "subscribeMessage", args: { tmplIds: ["t-1", "t-2"] } }]);
    answer("subscribeMessage", { accepted: ["t-2"] });
    await settle();
    expect(log()[2]).toEqual({
      errMsg: "requestSubscribeMessage:ok",
      "t-1": "reject",
      "t-2": "accept",
    });
  });

  test("closing the payment sheet fails requestPayment with cancel; virtual payment reports errCode -2", async () => {
    const payment = `{ timeStamp: "1", nonceStr: "n", package: "prepay_id=1", signType: "RSA", paySign: "s" }`;
    const { log, uis, answer, tap } = boot(
      page({
        pay: `await wx.requestPayment(${payment}).catch(push);`,
        virtual: `wx.requestVirtualPayment({
          signData: JSON.stringify({ offerId: "1", buyQuantity: 2, currencyType: "CNY", goodsPrice: 300, outTradeNo: "o" }),
          paySig: "p", signature: "s", mode: "short_series_goods", fail: push,
        });`,
      }),
      { pages: [PAGE] },
    );
    await settle();
    tap("pay");
    await settle();
    answer("payment", { pay: false });
    await settle();
    expect(log()).toEqual([{ errMsg: "requestPayment:fail cancel" }]);

    tap("virtual");
    await settle();
    expect(uis().at(-1)).toMatchObject({ name: "payment", args: { amount: 600 } });
    answer("payment", { pay: false });
    await settle();
    expect(log()[1]).toEqual({ errMsg: "requestVirtualPayment:fail cancel", errCode: -2 });
  });

  test("payment.result in omr.config.json pays without showing the sheet", async () => {
    const { log, uis } = boot(
      page({
        onLoad: `push(await wx.requestPayment({ timeStamp: "1", nonceStr: "n", package: "p", paySign: "s" }));`,
      }),
      { pages: [PAGE] },
      { payment: { result: "success" } },
    );
    await settle();
    expect(log()).toEqual([{ errMsg: "requestPayment:ok" }]);
    expect(uis()).toEqual([]);
  });

  test("chooseAddress must be declared in requiredPrivateInfos and fails with errno 104 when the privacy guide is refused", async () => {
    const run = `await wx.chooseAddress().then(push, push);`;
    const undeclared = boot(page({ onLoad: run }), { pages: [PAGE] }, AGREED);
    await settle();
    expect(undeclared.log()).toEqual([
      {
        errMsg:
          "chooseAddress:fail the api need to be declared in the requiredPrivateInfos field in app.json/ext.json",
      },
    ]);

    const refused = boot(page({ onLoad: run }), {
      pages: [PAGE],
      requiredPrivateInfos: ["chooseAddress"],
    });
    await settle();
    expect(refused.uis()).toMatchObject([{ name: "privacy" }]);
    refused.answer("privacy", { allow: false });
    await settle();
    expect(refused.log()).toEqual([
      { errMsg: "chooseAddress:fail privacy permission is not authorized", errno: 104 },
    ]);

    const agreed = boot(
      page({ onLoad: run }),
      { pages: [PAGE], requiredPrivateInfos: ["chooseAddress"] },
      { auth: { privacy: { agreed: true } }, address: { userName: "李四" } },
    );
    await settle();
    expect(agreed.log()).toEqual([
      expect.objectContaining({
        errMsg: "chooseAddress:ok",
        userName: "李四",
        provinceName: "北京市",
        telNumber: "13800138000",
      }),
    ]);
  });

  test("navigateToMiniProgram needs a tap and fails with cancel when the user declines", async () => {
    const { log, uis, answer, tap } = boot(
      page({
        onLoad: `await wx.navigateToMiniProgram({ appId: "wxother" }).catch(push);`,
        open: `await wx.navigateToMiniProgram({ appId: "wxother" }).catch(push);`,
      }),
      { pages: [PAGE] },
    );
    await settle();
    tap("open");
    await settle();
    expect(uis()).toMatchObject([
      { name: "showModal", args: { content: "即将打开“wxother”小程序" } },
    ]);
    answer("showModal", { confirm: false, cancel: true });
    await settle();
    expect(log()).toEqual([
      { errMsg: "navigateToMiniProgram:fail can only be invoked by user TAP gesture." },
      { errMsg: "navigateToMiniProgram:fail cancel" },
    ]);
  });

  test("getAppAuthorizeSetting reports a scope the user denied as denied", async () => {
    const { log } = boot(
      page({ onLoad: `push(wx.getAppAuthorizeSetting());` }),
      { pages: [PAGE] },
      { auth: { authSetting: { "scope.userLocation": false, "scope.camera": true } } },
    );
    await settle();
    expect(log()[0]).toMatchObject({
      locationAuthorized: "denied",
      cameraAuthorized: "authorized",
      locationReducedAccuracy: false,
    });
  });

  test("getFuzzyLocation needs scope.userFuzzyLocation, which consent deny refuses", async () => {
    const { log } = boot(
      page({
        onLoad: `await wx.getFuzzyLocation().then(push, push); push((await wx.getSetting()).authSetting);`,
      }),
      { pages: [PAGE], requiredPrivateInfos: ["getFuzzyLocation"] },
      { auth: { consent: "deny", privacy: { agreed: true } } },
    );
    await settle(8);
    expect(log()).toEqual([
      { errMsg: "getFuzzyLocation:fail auth deny" },
      { "scope.userFuzzyLocation": false },
    ]);
  });
});
