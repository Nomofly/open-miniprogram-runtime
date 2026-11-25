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

describe("media APIs", () => {
  test("chooseImage asks for the source and returns a generated PNG whose size and dimensions the file system agrees on", async () => {
    const { log, uis, answer } = boot(
      page({
        onLoad: `
          const chosen = await wx.chooseImage({ count: 1 });
          push(chosen);
          push(await wx.getImageInfo({ src: chosen.tempFilePaths[0] }));
          push(wx.getFileSystemManager().statSync(chosen.tempFilePaths[0]).size);`,
      }),
      { pages: [PAGE] },
      AGREED,
    );
    await settle();
    expect(uis()).toMatchObject([
      { name: "showActionSheet", args: { itemList: ["拍照", "从手机相册选择"] } },
    ]);
    answer("showActionSheet", { tapIndex: 1 });
    await settle(20);
    const [chosen, info, size] = log() as [
      { tempFilePaths: string[]; tempFiles: { path: string; size: number }[]; errMsg: string },
      Record<string, unknown>,
      number,
    ];
    expect(chosen.errMsg).toBe("chooseImage:ok");
    expect(chosen.tempFilePaths).toHaveLength(1);
    expect(chosen.tempFilePaths[0]).toMatch(/^http:\/\/tmp\/.+\.png$/);
    expect(chosen.tempFiles).toEqual([{ path: chosen.tempFilePaths[0], size }]);
    expect(size).toBeGreaterThan(0);
    expect(info).toMatchObject({
      errMsg: "getImageInfo:ok",
      width: 600,
      height: 800,
      type: "png",
      path: chosen.tempFilePaths[0],
    });
  });

  test("cancelling the source sheet fails chooseMedia with cancel", async () => {
    const { log, answer } = boot(
      page({ onLoad: `await wx.chooseMedia({ mediaType: ["image"] }).catch(push);` }),
      { pages: [PAGE] },
      AGREED,
    );
    await settle();
    answer("showActionSheet", {});
    await settle();
    expect(log()).toEqual([{ errMsg: "chooseMedia:fail cancel" }]);
  });

  test("saveImageToPhotosAlbum needs the privacy guide, then scope.writePhotosAlbum", async () => {
    const run = `
      await wx.saveImageToPhotosAlbum({ filePath: "http://tmp/missing.png" }).then(push, push);
      push((await wx.getSetting()).authSetting);`;
    const refused = boot(page({ onLoad: run }), { pages: [PAGE] });
    await settle();
    refused.answer("privacy", { allow: false });
    await settle(6);
    expect(refused.log()).toEqual([
      { errMsg: "saveImageToPhotosAlbum:fail privacy permission is not authorized", errno: 104 },
      {},
    ]);

    const denied = boot(page({ onLoad: run }), { pages: [PAGE] }, AGREED);
    await settle();
    expect(denied.uis()).toMatchObject([
      { name: "authorize", args: { scope: "scope.writePhotosAlbum" } },
    ]);
    denied.answer("authorize", { allow: false });
    await settle(6);
    expect(denied.log()).toEqual([
      { errMsg: "saveImageToPhotosAlbum:fail auth deny" },
      { "scope.writePhotosAlbum": false },
    ]);
  });

  test("InnerAudioContext fires canplay, play, timeUpdate and ended in order, and pause stops the clock", async () => {
    const { log } = boot(
      {
        "app.js": APP,
        [`${PAGE}.js`]: `
          const push = (r) => getApp().log.push(r);
          const audio = wx.createInnerAudioContext();
          for (const event of ["Canplay", "Play", "Pause", "Stop", "TimeUpdate", "Ended", "Error"]) {
            audio["on" + event](() => push(event + " " + audio.currentTime + "/" + audio.duration + " " + audio.paused));
          }
          Page({ onLoad() { audio.src = "https://example.com/a.mp3"; audio.play(); } });`,
      },
      { pages: [PAGE] },
      { media: { audioDuration: 0.5 } },
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(log()).toEqual([
      "Canplay 0/0.5 true",
      "Play 0/0.5 false",
      "TimeUpdate 0.25/0.5 false",
      "TimeUpdate 0.5/0.5 false",
      "Ended 0.5/0.5 true",
    ]);
  });

  test("an InnerAudioContext with a missing local file reports an error instead of playing", async () => {
    const { log } = boot(
      {
        "app.js": APP,
        [`${PAGE}.js`]: `
          const audio = wx.createInnerAudioContext({ useWebAudioImplement: false });
          audio.onPlay(() => getApp().log.push("play"));
          audio.onError((e) => getApp().log.push(e));
          Page({ onLoad() { audio.autoplay = true; audio.src = "http://tmp/missing.mp3"; } });`,
      },
      { pages: [PAGE] },
    );
    await settle();
    expect(log()).toEqual([{ errMsg: "file not found", errCode: 10003 }]);
  });
});
