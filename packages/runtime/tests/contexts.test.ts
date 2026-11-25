import { describe, expect, test } from "vite-plus/test";
import { MemoryFs, startLogic } from "../src/index.ts";
import type { LogicToShell, LogicToView, SimulatorConfig, ViewToLogic } from "../src/index.ts";

const SYSTEM = {
  windowWidth: 375,
  windowHeight: 603,
  statusBarHeight: 20,
  screenWidth: 375,
  screenHeight: 667,
  pixelRatio: 2,
};
const MENU_BUTTON = { width: 87, height: 32, top: 24, right: 368, bottom: 56, left: 281 };
const PAGE = "pages/index/index";
const DETAIL = "pages/detail/detail";

/** Boots a logic layer whose pages run the given handlers, with `push` logging a result. */
function boot(pages: Record<string, Record<string, string>>, config: SimulatorConfig = {}) {
  const sent: LogicToShell[] = [];
  const handle = startLogic((message) => sent.push(message), { fs: new MemoryFs() });
  const files: Record<string, string> = { "app.js": "App({ log: [] });" };
  for (const [route, handlers] of Object.entries(pages)) {
    files[`${route}.js`] = `
      const push = (r) => getApp().log.push(r);
      Page({ ${Object.entries(handlers)
        .map(([name, body]) => `${name}() { ${body} }`)
        .join(",\n")} });`;
  }
  const routes = Object.keys(pages);
  handle({
    type: "boot",
    manifest: {
      appid: "wx0123456789abcdef",
      appName: "Demo",
      appJson: { pages: routes },
      pages: routes,
      entryPage: routes[0]!,
      windows: {},
      config,
    },
    system: SYSTEM,
    menuButton: MENU_BUTTON,
    chrome: { navigationBar: 64, tabBar: 50 },
    appService: Object.entries(files)
      .map(
        ([file, source]) =>
          `__omrDefine(${JSON.stringify(file)}, function (require, module, exports) {\n${source}\n});`,
      )
      .join("\n"),
  });
  const view = (webviewId: number, message: ViewToLogic) =>
    handle({ type: "view", webviewId, message });
  const log = () => (globalThis as unknown as { getApp(): { log: unknown[] } }).getApp().log;
  const tap = (handler: string, webviewId = 1) => {
    const target = { id: "", dataset: {} };
    view(webviewId, {
      type: "event",
      ownerId: 0,
      handler,
      event: { type: "tap", timeStamp: 0, target, currentTarget: target, detail: {} },
    });
  };
  const toView = <T extends LogicToView["type"]>(type: T) =>
    sent.flatMap((message) =>
      message.type === "toView" && message.message.type === type
        ? [message.message as Extract<LogicToView, { type: T }>]
        : [],
    );
  /** The view gets ready and renders the page's first data, so `onReady` runs. */
  const open = (webviewId: number) => {
    view(webviewId, { type: "ready" });
    const init = sent.findLast(
      (message) =>
        message.type === "toView" &&
        message.webviewId === webviewId &&
        message.message.type === "init",
    ) as Extract<LogicToShell, { type: "toView" }> | undefined;
    if (init) view(webviewId, { type: "rendered", seq: (init.message as { seq: number }).seq });
  };
  open(1);
  return { sent, view, log, tap, toView, open };
}

const settle = async (times = 4) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("VideoContext", () => {
  test("a method reaches the page's <video> by id and calls back when the view answers", async () => {
    const { view, log, tap, toView } = boot({
      [PAGE]: {
        onReady: `this.video = wx.createVideoContext("player");`,
        play: `push(this.video.play({ success: push, fail: push }));`,
        seek: `this.video.seek(12.5); this.video.sendDanmu({ text: "hi", color: "#f00" });`,
      },
    });
    await settle();
    tap("play");
    await settle();
    const [call] = toView("callBuiltin");
    expect(call).toMatchObject({
      target: { tag: "video", id: "player", scopeNodeId: 0 },
      method: "play",
      args: [{}],
    });
    // Context methods take no Promise style
    expect(log()).toEqual([undefined]);
    view(1, { type: "builtinResult", callId: call!.callId, result: {} });
    await settle();
    expect(log()).toEqual([undefined, { errMsg: "play:ok" }]);

    tap("seek");
    await settle();
    expect(toView("callBuiltin").slice(1)).toMatchObject([
      { method: "seek", args: [12.5] },
      { method: "sendDanmu", args: [{ text: "hi", color: "#f00" }] },
    ]);
  });

  test("a method fails with the view's reason, and when its page unloads before the answer", async () => {
    const { view, log, tap, toView, open } = boot({
      [PAGE]: {
        pause: `wx.createVideoContext("missing").pause({ fail: push });`,
        open: `wx.navigateTo({ url: "/${DETAIL}" });`,
      },
      [DETAIL]: {
        stop: `wx.createVideoContext("player").stop({ fail: push });`,
        back: `wx.navigateBack();`,
      },
    });
    await settle();
    tap("pause");
    await settle();
    const [pause] = toView("callBuiltin");
    view(1, { type: "builtinResult", callId: pause!.callId, error: "no <video> found" });
    await settle();
    expect(log()).toEqual([{ errMsg: "pause:fail no <video> found" }]);

    tap("open");
    await settle();
    open(2);
    await settle();
    tap("stop", 2);
    await settle();
    expect(toView("callBuiltin").at(-1)).toMatchObject({ method: "stop" });
    tap("back", 2);
    await settle();
    expect(log()).toEqual([
      { errMsg: "pause:fail no <video> found" },
      { errMsg: "stop:fail page is unloaded" },
    ]);
  });
});

describe("CameraContext", () => {
  const CAMERA_PAGE = {
    photo: `wx.createCameraContext().takePhoto({
      quality: "high",
      success: (res) => push({ ...res, size: wx.getFileSystemManager().statSync(res.tempImagePath).size }),
      fail: push,
    });`,
  };

  test("takePhoto fails without a <camera> on the page", async () => {
    const { log, tap } = boot({ [PAGE]: CAMERA_PAGE });
    await settle();
    tap("photo");
    await settle();
    expect(log()).toEqual([{ errMsg: "operateCamera:fail camera not found" }]);
  });

  test("takePhoto fails with the camera's auth deny when scope.camera is refused", async () => {
    const { log, tap, view } = boot(
      { [PAGE]: CAMERA_PAGE },
      { auth: { privacy: { agreed: true }, authSetting: { "scope.camera": false } } },
    );
    await settle();
    view(1, { type: "camera", cameraId: 1, mounted: true });
    await settle();
    tap("photo");
    await settle();
    expect(log()).toEqual([{ errMsg: "operateCamera:fail auth deny" }]);
  });

  test("takePhoto with an authorized <camera> returns a temporary PNG the file system knows", async () => {
    const { log, tap, view } = boot(
      { [PAGE]: CAMERA_PAGE },
      { auth: { privacy: { agreed: true }, authSetting: { "scope.camera": true } } },
    );
    await settle();
    view(1, { type: "camera", cameraId: 1, mounted: true });
    await settle();
    tap("photo");
    await settle(20);
    const [photo] = log() as { errMsg: string; tempImagePath: string; size: number }[];
    expect(photo!.errMsg).toBe("operateCamera:ok");
    expect(photo!.tempImagePath).toMatch(/^http:\/\/tmp\/.+\.png$/);
    expect(photo!.size).toBeGreaterThan(1000);
  });
});

describe("MapContext", () => {
  test("getCenterLocation and getScale read the <map>'s attributes; moveToLocation moves the center", async () => {
    const { view, log, tap, toView } = boot({
      [PAGE]: {
        onReady: `this.map = wx.createMapContext("m");`,
        center: `this.map.getCenterLocation({ success: push });`,
        scale: `this.map.getScale({ success: push });`,
        move: `this.map.moveToLocation({ latitude: 22.5, longitude: 114.05, success: push });`,
        layer: `this.map.addCustomLayer({ layerId: "x", success: push });`,
      },
    });
    await settle();
    const answer = (found: Record<string, unknown>) => {
      const query = toView("query").at(-1)!;
      expect(query.requests[0]).toMatchObject({ selector: 'wx-map[id="m"]', scopeNodeId: 0 });
      view(1, { type: "queryResult", queryId: query.queryId, results: [found] });
    };
    const map = { width: 300, height: 150, latitude: 31.2304, longitude: "121.4737" };
    tap("center");
    await settle();
    answer(map);
    await settle();
    tap("scale");
    await settle();
    answer(map);
    await settle();
    tap("move");
    await settle();
    answer(map);
    await settle();
    tap("center");
    await settle();
    answer(map);
    await settle();
    tap("layer");
    await settle();
    expect(log()).toEqual([
      { errMsg: "getCenterLocation:ok", latitude: 31.2304, longitude: 121.4737 },
      { errMsg: "getScale:ok", scale: 16 },
      { errMsg: "moveToLocation:ok" },
      { errMsg: "getCenterLocation:ok", latitude: 22.5, longitude: 114.05 },
      { errMsg: "addCustomLayer:ok" },
    ]);
  });

  test("a <map> without latitude and longitude is centered on the configured location", async () => {
    const { view, log, tap, toView } = boot(
      { [PAGE]: { center: `wx.createMapContext("m").getCenterLocation({ success: push });` } },
      { location: { latitude: 30.5, longitude: 104.06 } },
    );
    await settle();
    tap("center");
    await settle();
    const query = toView("query").at(-1)!;
    view(1, {
      type: "queryResult",
      queryId: query.queryId,
      results: [{ width: 300, height: 150 }],
    });
    await settle();
    expect(log()).toEqual([{ errMsg: "getCenterLocation:ok", latitude: 30.5, longitude: 104.06 }]);
  });
});

describe("live contexts", () => {
  test("every documented method succeeds and snapshot returns a generated image", async () => {
    const { log, tap } = boot({
      [PAGE]: {
        run: `
          const player = wx.createLivePlayerContext("live");
          const pusher = wx.createLivePusherContext();
          player.play({ success: push });
          pusher.applyFilter({ success: push });
          player.snapshot({ success: (res) => push({ ...res, size: wx.getFileSystemManager().statSync(res.tempImagePath).size }) });`,
      },
    });
    await settle();
    tap("run");
    await settle(20);
    const [play, filter, snapshot] = log() as Record<string, unknown>[];
    expect(play).toEqual({ errMsg: "play:ok" });
    expect(filter).toEqual({ errMsg: "applyFilter:ok" });
    expect(snapshot).toMatchObject({ errMsg: "snapshot:ok", width: 640, height: 360 });
    expect(snapshot!.tempImagePath).toMatch(/^http:\/\/tmp\/.+\.png$/);
    expect(snapshot!.size).toBeGreaterThan(0);
  });
});

describe("NodesRef.context", () => {
  test("an <editor> gives an EditorContext whose methods reach it and resolve with its answer", async () => {
    const { view, log, tap, toView } = boot({
      [PAGE]: {
        query: `wx.createSelectorQuery().select("#editor").context((res) => {
          this.editor = res.context;
          push(Object.keys(res));
        }).exec();`,
        format: `this.editor.format("header", "H2");
          this.editor.insertImage({ src: "http://tmp/a.png", width: "50%", success: push });`,
        get: `push(this.editor.getContents({ success: push }));`,
        undo: `this.editor.undo({ fail: push });`,
      },
    });
    await settle();
    tap("query");
    await settle();
    const query = toView("query").at(-1)!;
    expect(query.requests).toEqual([
      { selector: "#editor", all: false, scopeNodeId: 0, fields: { context: true } },
    ]);
    view(1, {
      type: "queryResult",
      queryId: query.queryId,
      results: [{ context: { tag: "editor", id: "editor", scopeNodeId: 0 } }],
    });
    await settle();
    expect(log()).toEqual([["context"]]);

    tap("format");
    await settle();
    const [format, image] = toView("callBuiltin");
    expect(format).toMatchObject({
      target: { tag: "editor", id: "editor", scopeNodeId: 0 },
      method: "format",
      args: ["header", "H2"],
    });
    expect(image).toMatchObject({
      method: "insertImage",
      args: [{ src: "http://tmp/a.png", width: "50%" }],
    });
    view(1, { type: "builtinResult", callId: format!.callId, result: {} });
    view(1, { type: "builtinResult", callId: image!.callId, result: {} });
    await settle();
    expect(log().at(-1)).toEqual({ errMsg: "insertImage:ok" });

    tap("get");
    await settle();
    const get = toView("callBuiltin").at(-1)!;
    expect(get.method).toBe("getContents");
    const contents = { html: "<p>hi</p>", text: "hi\n", delta: { ops: [{ insert: "hi\n" }] } };
    view(1, { type: "builtinResult", callId: get.callId, result: contents });
    await settle();
    // EditorContext methods take no Promise style
    expect(log().slice(-2)).toEqual([undefined, { errMsg: "getContents:ok", ...contents }]);

    tap("undo");
    await settle();
    const undo = toView("callBuiltin").at(-1)!;
    view(1, { type: "builtinResult", callId: undo.callId, error: "no <editor> found" });
    await settle();
    expect(log().at(-1)).toEqual({ errMsg: "undo:fail no <editor> found" });
  });

  test("a <video> gives a VideoContext in its owner's template; other nodes give none", async () => {
    const { view, log, tap, toView } = boot({
      [PAGE]: {
        query: `wx.createSelectorQuery()
          .select("#player").context((res) => { this.video = res.context; })
          .select(".plain").context(push)
          .select("#none").context(push)
          .exec();`,
        play: `this.video.play({ success: push });`,
      },
    });
    await settle();
    tap("query");
    await settle();
    const query = toView("query").at(-1)!;
    view(1, {
      type: "queryResult",
      queryId: query.queryId,
      results: [
        { context: { tag: "video", id: "player", scopeNodeId: 3 } },
        { context: null },
        null,
      ],
    });
    await settle();
    expect(log()).toEqual([{ context: undefined }, null]);
    tap("play");
    await settle();
    const play = toView("callBuiltin").at(-1)!;
    expect(play).toMatchObject({
      target: { tag: "video", id: "player", scopeNodeId: 3 },
      method: "play",
    });
    view(1, { type: "builtinResult", callId: play.callId, result: {} });
    await settle();
    expect(log().at(-1)).toEqual({ errMsg: "play:ok" });
  });
});
