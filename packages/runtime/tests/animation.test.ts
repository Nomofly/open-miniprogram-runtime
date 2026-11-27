import { describe, expect, test, vi } from "vite-plus/test";
import { ANIMATION_EXPORT_ID, Animation } from "../src/api/animation.ts";
import { startLogic } from "../src/index.ts";
import type { LogicToShell, LogicToView } from "../src/index.ts";

const option = (duration: number, timingFunction = "linear", delay = 0, origin = "50% 50% 0") => ({
  transition: { duration, timingFunction, delay },
  transformOrigin: origin,
});

describe("wx.createAnimation", () => {
  test("export gives one action per step with its own animates and transition option", () => {
    // The Animation page's example: rotate and scale, then translate for 1000ms
    const animation = new Animation({ duration: 1000, timingFunction: "ease" });
    animation.rotate(45).scale(2, 2).step();
    animation.translate(100, 100).step({ duration: 1000 });
    animation.opacity(0.5).width(100).height("20rpx").backgroundColor("#f00").step({
      duration: 200,
      delay: 50,
      timingFunction: "ease-in",
      transformOrigin: "0 0",
    });
    expect(animation.export()).toEqual({
      actions: [
        {
          animates: [
            { type: "rotate", args: [45] },
            { type: "scale", args: [2, 2] },
          ],
          option: option(1000, "ease"),
        },
        { animates: [{ type: "translate", args: [100, 100] }], option: option(1000, "ease") },
        {
          animates: [
            { type: "style", args: ["opacity", 0.5] },
            { type: "style", args: ["width", "100px"] },
            { type: "style", args: ["height", "20rpx"] },
            { type: "style", args: ["background-color", "#f00"] },
          ],
          option: option(200, "ease-in", 50, "0 0"),
        },
      ],
    });
  });

  test("steps take the documented defaults: 400ms, linear, no delay, origin 50% 50% 0", () => {
    const animation = new Animation();
    animation.scale(2).translate(30).skew(10).step();
    expect(animation.export().actions).toEqual([
      {
        animates: [
          { type: "scale", args: [2, 2] },
          { type: "translate", args: [30, 0] },
          { type: "skew", args: [10, 0] },
        ],
        option: option(400),
      },
    ]);
  });

  test("export clears the queue, and each export has an identity of its own in JSON", () => {
    const animation = new Animation();
    animation.rotate(90).step();
    const first = animation.export();
    expect(first.actions).toHaveLength(1);
    expect(animation.export().actions).toEqual([]);
    // Calls not yet ended by step() are not exported, and the export drops them
    animation.rotate(90);
    expect(animation.export().actions).toEqual([]);

    // The same export serializes the same way; a new export with equal steps does not
    const again = JSON.parse(JSON.stringify(first));
    expect(again).toEqual(JSON.parse(JSON.stringify(first)));
    expect(Object.keys(first)).toEqual(["actions"]);
    animation.rotate(90).step();
    const second = JSON.parse(JSON.stringify(animation.export()));
    expect(second.actions).toEqual(again.actions);
    expect(second[ANIMATION_EXPORT_ID]).not.toBe(again[ANIMATION_EXPORT_ID]);
  });
});

describe("this.animate and this.clearAnimation", () => {
  function boot(pageSource: string) {
    const sent: LogicToShell[] = [];
    const handle = startLogic((message) => sent.push(message));
    const files = { "app.js": "App({ log: [] });", "pages/a/a.js": pageSource };
    handle({
      type: "boot",
      manifest: {
        appid: "wx0123456789abcdef",
        appName: "Demo",
        appJson: { pages: ["pages/a/a"] },
        pages: ["pages/a/a"],
        entryPage: "pages/a/a",
        windows: {},
        config: {},
      },
      system: { windowWidth: 375, windowHeight: 603, statusBarHeight: 20 },
      menuButton: { width: 87, height: 32, top: 24, right: 368, bottom: 56, left: 281 },
      chrome: { navigationBar: 64, tabBar: 50 },
      appService: Object.entries(files)
        .map(
          ([file, source]) =>
            `__omrDefine(${JSON.stringify(file)}, function (require, module, exports) {\n${source}\n});`,
        )
        .join("\n"),
    });
    const toView = <T extends LogicToView["type"]>(type: T) =>
      sent.flatMap((message) =>
        message.type === "toView" && message.message.type === type ? [message.message] : [],
      ) as Extract<LogicToView, { type: T }>[];
    const log = () => (globalThis as any).getApp().log as unknown[];
    return { handle, toView, log };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("sends the keyframes to the page's view and calls back on the page when the view is done", async () => {
    const { handle, toView, log } = boot(`
      Page({
        onLoad() {
          this.animate("#box", [{ opacity: 1, rotate: 0 }, { opacity: 0, rotate: 90 }], 500, function () {
            getApp().log.push("animated " + (this === getCurrentPages()[0]));
            this.clearAnimation("#box", { opacity: true }, () => getApp().log.push("cleared opacity"));
            this.clearAnimation("#box", () => getApp().log.push("cleared all"));
          });
        },
      });`);
    handle({ type: "view", webviewId: 1, message: { type: "ready" } });
    await settle();
    const [animate] = toView("animate");
    expect(animate).toEqual({
      type: "animate",
      animationId: animate!.animationId,
      scopeNodeId: 0,
      selector: "#box",
      keyframes: [
        { opacity: 1, rotate: 0 },
        { opacity: 0, rotate: 90 },
      ],
      duration: 500,
    });
    // Another WebView cannot finish it
    handle({
      type: "view",
      webviewId: 2,
      message: { type: "animationDone", animationId: animate!.animationId },
    });
    expect(log()).toEqual([]);
    handle({
      type: "view",
      webviewId: 1,
      message: { type: "animationDone", animationId: animate!.animationId },
    });
    expect(log()).toEqual(["animated true"]);

    const clears = toView("clearAnimation");
    expect(clears.map(({ selector, properties }) => ({ selector, properties }))).toEqual([
      { selector: "#box", properties: ["opacity"] },
      { selector: "#box", properties: undefined },
    ]);
    for (const clear of clears) {
      handle({
        type: "view",
        webviewId: 1,
        message: { type: "animationDone", animationId: clear.animationId },
      });
    }
    expect(log()).toEqual(["animated true", "cleared opacity", "cleared all"]);
  });

  test("a ScrollTimeline animation only warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handle, toView } = boot(`
      Page({
        onLoad() {
          this.animate(".avatar", [{ opacity: 0 }, { opacity: 1 }], 1000, {
            scrollSource: "#scroller", timeRange: 1000, startScrollOffset: 0, endScrollOffset: 85,
          });
        },
      });`);
    handle({ type: "view", webviewId: 1, message: { type: "ready" } });
    await settle();
    expect(toView("animate")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ScrollTimeline"));
    warn.mockRestore();
  });
});
