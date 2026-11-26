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
  test("methods reach the page's <map> by id and resolve with its answer, without a Promise", async () => {
    const { view, log, tap, toView } = boot({
      [PAGE]: {
        onReady: `this.map = wx.createMapContext("m");`,
        center: `push(this.map.getCenterLocation({ success: push }));`,
        move: `this.map.moveToLocation({ latitude: 22.5, longitude: 114.05, success: push, fail: push });`,
        points: `this.map.includePoints({ points: [{ latitude: 1, longitude: 2 }], padding: [10, 10, 10, 10] });
          this.map.addCustomLayer({ layerId: "x", success: push });`,
      },
    });
    await settle();
    tap("center");
    await settle();
    const [center] = toView("callBuiltin");
    expect(center).toMatchObject({
      target: { tag: "map", id: "m", scopeNodeId: 0 },
      method: "getCenterLocation",
      args: [{}],
    });
    expect(log()).toEqual([undefined]);
    view(1, {
      type: "builtinResult",
      callId: center!.callId,
      result: { latitude: 31.2304, longitude: 121.4737 },
    });
    await settle();
    expect(log().at(-1)).toEqual({
      errMsg: "getCenterLocation:ok",
      latitude: 31.2304,
      longitude: 121.4737,
    });

    tap("move");
    await settle();
    const move = toView("callBuiltin").at(-1)!;
    expect(move).toMatchObject({
      method: "moveToLocation",
      args: [{ latitude: 22.5, longitude: 114.05 }],
    });
    view(1, {
      type: "builtinResult",
      callId: move.callId,
      error: "parameter error: latitude and longitude should be Number",
    });
    await settle();
    expect(log().at(-1)).toEqual({
      errMsg: "moveToLocation:fail parameter error: latitude and longitude should be Number",
    });

    tap("points");
    await settle();
    const [include, layer] = toView("callBuiltin").slice(-2);
    expect(include).toMatchObject({
      target: { tag: "map", id: "m" },
      method: "includePoints",
      args: [{ points: [{ latitude: 1, longitude: 2 }], padding: [10, 10, 10, 10] }],
    });
    expect(layer).toMatchObject({ method: "addCustomLayer", args: [{ layerId: "x" }] });
    view(1, { type: "builtinResult", callId: layer!.callId, result: {} });
    await settle();
    expect(log().at(-1)).toEqual({ errMsg: "addCustomLayer:ok" });
  });

  test("translateMarker calls animationEnd once the map answers that the marker arrived", async () => {
    const { view, log, tap, toView } = boot({
      [PAGE]: {
        go: `wx.createMapContext("m").translateMarker({
          markerId: 1,
          destination: { latitude: 31, longitude: 121 },
          autoRotate: false,
          rotate: 0,
          duration: 500,
          animationEnd: () => push("animationEnd"),
          success: push,
        });`,
      },
    });
    await settle();
    tap("go");
    await settle();
    const call = toView("callBuiltin").at(-1)!;
    expect(call).toMatchObject({
      target: { tag: "map", id: "m" },
      method: "translateMarker",
      args: [
        {
          markerId: 1,
          destination: { latitude: 31, longitude: 121 },
          autoRotate: false,
          rotate: 0,
          duration: 500,
        },
      ],
    });
    // The callbacks stay in the logic layer
    expect(Object.keys(call.args[0] as object)).not.toContain("animationEnd");
    await settle();
    expect(log()).toEqual([]);
    view(1, { type: "builtinResult", callId: call.callId, result: {} });
    await settle();
    expect(log()).toEqual(["animationEnd", { errMsg: "translateMarker:ok" }]);
  });

  test("a <map> found by NodesRef.context gives a MapContext in its owner's template", async () => {
    const { view, log, tap, toView } = boot({
      [PAGE]: {
        query: `wx.createSelectorQuery().select("#m").context((res) => { this.map = res.context; }).exec();`,
        scale: `this.map.getScale({ success: push }); this.map.on("markerClusterCreate", () => {});`,
      },
    });
    await settle();
    tap("query");
    await settle();
    const query = toView("query").at(-1)!;
    view(1, {
      type: "queryResult",
      queryId: query.queryId,
      results: [{ context: { tag: "map", id: "m", scopeNodeId: 4 } }],
    });
    await settle();
    tap("scale");
    await settle();
    const call = toView("callBuiltin").at(-1)!;
    expect(call).toMatchObject({
      target: { tag: "map", id: "m", scopeNodeId: 4 },
      method: "getScale",
    });
    view(1, { type: "builtinResult", callId: call.callId, result: { scale: 16 } });
    await settle();
    expect(log()).toEqual([{ errMsg: "getScale:ok", scale: 16 }]);
  });
});

describe("live contexts", () => {
  test("methods reach the <live-player> by id and the page's <live-pusher>, and snapshot returns a generated image", async () => {
    const { log, tap, view, toView } = boot({
      [PAGE]: {
        run: `
          const player = wx.createLivePlayerContext("live");
          const pusher = wx.createLivePusherContext();
          player.play({ success: push });
          pusher.start({ fail: push });
          player.snapshot({ success: (res) => push({ ...res, size: wx.getFileSystemManager().statSync(res.tempImagePath).size }) });`,
      },
    });
    await settle();
    tap("run");
    await settle();
    const [play, start] = toView("callBuiltin");
    expect(play).toMatchObject({ target: { tag: "live-player", id: "live" }, method: "play" });
    expect(start).toMatchObject({ target: { tag: "live-pusher" }, method: "start" });
    expect(start!.target.id).toBeUndefined();
    view(1, { type: "builtinResult", callId: play!.callId, result: {} });
    view(1, { type: "builtinResult", callId: start!.callId, error: "camera is not ready" });
    await settle(20);
    const results = log() as Record<string, unknown>[];
    const byName = (name: string) =>
      results.find((result) => String(result.errMsg).startsWith(`${name}:`));
    expect(byName("play")).toEqual({ errMsg: "play:ok" });
    expect(byName("start")).toEqual({ errMsg: "start:fail camera is not ready" });
    const snapshot = byName("snapshot")!;
    expect(snapshot).toMatchObject({ errMsg: "snapshot:ok", width: 640, height: 360 });
    expect(snapshot.tempImagePath).toMatch(/^http:\/\/tmp\/.+\.png$/);
    expect(snapshot.size).toBeGreaterThan(0);
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

describe("ScrollViewContext", () => {
  test("NodesRef.node of an enhanced <scroll-view> calls that very node back; setting a property applies it", async () => {
    const { view, log, tap, toView } = boot({
      [PAGE]: {
        query: `wx.createSelectorQuery().select("#list").node((res) => {
          this.list = res.node;
          push({ paging: res.node.pagingEnabled, scrollEnabled: res.node.scrollEnabled });
        }).exec();`,
        use: `this.list.scrollEnabled = false;
          push(this.list.scrollEnabled);
          push(this.list.scrollTo({ top: 120, animated: true }));
          this.list.scrollIntoView("#item3");
          this.list.triggerRefresh();`,
      },
    });
    await settle();
    tap("query");
    await settle();
    const query = toView("query").at(-1)!;
    expect(query.requests[0]!.fields).toEqual({ node: true });
    const scrollView = { tag: "scroll-view", id: "list", scopeNodeId: 0, nodeKey: 7 };
    const settings = {
      scrollEnabled: true,
      bounces: true,
      showScrollbar: true,
      pagingEnabled: true,
      fastDeceleration: false,
      decelerationDisabled: false,
    };
    view(1, {
      type: "queryResult",
      queryId: query.queryId,
      results: [{ node: { scrollView: { ...scrollView, settings } } }],
    });
    await settle();
    expect(log()).toEqual([{ paging: true, scrollEnabled: true }]);

    tap("use");
    await settle();
    // Methods return nothing; each reaches the node the query found, by its key
    expect(log().slice(1)).toEqual([false, undefined]);
    expect(
      toView("callBuiltin").map(({ target, method, args }) => ({ target, method, args })),
    ).toEqual([
      { target: scrollView, method: "set", args: [{ scrollEnabled: false }] },
      { target: scrollView, method: "scrollTo", args: [{ top: 120, animated: true }] },
      { target: scrollView, method: "scrollIntoView", args: ["#item3", {}] },
      { target: scrollView, method: "triggerRefresh", args: [{}] },
    ]);
  });
});
