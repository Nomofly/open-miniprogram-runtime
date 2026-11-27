import { describe, expect, test } from "vite-plus/test";
import { startLogic } from "../src/index.ts";
import type { IntersectionResult, LogicToShell, LogicToView, ViewToLogic } from "../src/index.ts";

/** Boots a logic layer with the given JS files, as the compiler bundles them. */
function boot(files: Record<string, string>, pages: string[]) {
  const sent: LogicToShell[] = [];
  const handle = startLogic((message) => sent.push(message));
  handle({
    type: "boot",
    manifest: {
      appid: "wx0123456789abcdef",
      appName: "Demo",
      appJson: { pages },
      pages,
      entryPage: pages[0]!,
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
    appService: Object.entries(files)
      .map(
        ([file, source]) =>
          `__omrDefine(${JSON.stringify(file)}, function (require, module, exports) {\n${source}\n});`,
      )
      .join("\n"),
  });
  const view = (webviewId: number, message: ViewToLogic) =>
    handle({ type: "view", webviewId, message });
  const toView = <T extends LogicToView["type"]>(type: T) =>
    sent.flatMap((message) =>
      message.type === "toView" && message.message.type === type
        ? [
            {
              webviewId: message.webviewId,
              ...(message.message as Extract<LogicToView, { type: T }>),
            },
          ]
        : [],
    );
  const log = () => (globalThis as unknown as { getApp(): { log: unknown[] } }).getApp().log;
  return { view, toView, log };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const wx = () => (globalThis as any).wx;

const resultWith = (intersectionRatio: number): IntersectionResult => {
  const rect = { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 };
  return {
    id: "item",
    dataset: { index: 3 },
    time: 1,
    intersectionRatio,
    intersectionRect: rect,
    boundingClientRect: rect,
    relativeRect: { left: 0, top: 0, right: 375, bottom: 603 },
  };
};

describe("observers", () => {
  test("an intersection observer asks the view of its component's page, scoped to the component, and stops on disconnect", () => {
    const { view, toView, log } = boot(
      {
        "app.js": "App({ log: [] });",
        "pages/index/index.js": "Page({});",
        "components/card/card.js": `Component({
          lifetimes: {
            attached() {
              this.observer = this.createIntersectionObserver({ thresholds: [0, 0.5], initialRatio: 1, observeAll: true })
                .relativeTo(".box", { top: 10 })
                .relativeToViewport({ bottom: 100 });
              this.observer.observe(".item", (res) => getApp().log.push(res));
              getApp().card = this;
            },
          },
        });`,
      },
      ["pages/index/index"],
    );
    view(1, { type: "ready" });
    view(1, {
      type: "attach",
      nodeId: 4,
      ownerId: 0,
      path: "components/card/card",
      props: {},
      listeners: {},
      id: "",
      dataset: {},
    });
    const [observe] = toView("observeIntersection");
    expect(observe).toEqual({
      webviewId: 1,
      type: "observeIntersection",
      request: {
        observerId: expect.any(Number),
        scopeNodeId: 4,
        selector: ".item",
        all: true,
        relatives: [
          { selector: ".box", margins: { left: 0, right: 0, top: 10, bottom: 0 } },
          { selector: null, margins: { left: 0, right: 0, top: 0, bottom: 100 } },
        ],
        thresholds: [0, 0.5],
        initialRatio: 1,
      },
    });
    const { observerId } = observe!.request;

    view(1, { type: "intersection", observerId, result: resultWith(0.4) });
    expect(log()).toEqual([resultWith(0.4)]);
    // Another page cannot answer for this one, nor can an unknown observer
    view(2, { type: "intersection", observerId, result: resultWith(0.9) });
    view(1, { type: "intersection", observerId: observerId + 100, result: resultWith(0.9) });
    expect(log()).toHaveLength(1);

    (globalThis as any).getApp().card.observer.disconnect();
    expect(toView("unobserve")).toEqual([{ webviewId: 1, type: "unobserve", observerId }]);
    view(1, { type: "intersection", observerId, result: resultWith(0) });
    expect(log()).toHaveLength(1);
  });

  test("wx.createIntersectionObserver without a component observes the current page with the documented defaults", () => {
    const { view, toView } = boot(
      { "app.js": "App({ log: [] });", "pages/index/index.js": "Page({});" },
      ["pages/index/index"],
    );
    view(1, { type: "ready" });
    wx()
      .createIntersectionObserver()
      .observe("#a", () => {});
    expect(toView("observeIntersection")[0]).toMatchObject({
      webviewId: 1,
      request: {
        scopeNodeId: 0,
        selector: "#a",
        all: false,
        relatives: [],
        thresholds: [0],
        initialRatio: 0,
      },
    });
  });

  test("a media query observer reports each match state the view sends, until disconnect", () => {
    const { view, toView, log } = boot(
      {
        "app.js": "App({ log: [] });",
        "pages/index/index.js": `Page({
          onLoad() {
            this.mq = this.createMediaQueryObserver();
            this.mq.observe({ minWidth: 300, maxWidth: "500", orientation: "sideways", foo: 1 }, (res) => getApp().log.push(res));
          },
        });`,
      },
      ["pages/index/index"],
    );
    view(1, { type: "ready" });
    const [observe] = toView("observeMediaQuery");
    // Unknown fields and values are dropped; numeric strings are lengths
    expect(observe).toMatchObject({ webviewId: 1, descriptor: { minWidth: 300, maxWidth: 500 } });
    expect(Object.keys(observe!.descriptor)).toEqual(["minWidth", "maxWidth"]);

    view(1, { type: "mediaQuery", observerId: observe!.observerId, matches: true });
    view(1, { type: "mediaQuery", observerId: observe!.observerId, matches: false });
    expect(log()).toEqual([{ matches: true }, { matches: false }]);

    (globalThis as any).getCurrentPages()[0].mq.disconnect();
    view(1, { type: "mediaQuery", observerId: observe!.observerId, matches: true });
    expect(log()).toHaveLength(2);
  });

  test("a page's observers stop when it unloads", async () => {
    const { view, toView, log } = boot(
      {
        "app.js": "App({ log: [] });",
        "pages/a/a.js": `Page({ onLoad() { wx.navigateTo({ url: "/pages/b/b" }); } });`,
        "pages/b/b.js": `Page({
          onLoad() {
            this.createIntersectionObserver().relativeToViewport().observe(".x", (res) => getApp().log.push(res.intersectionRatio));
          },
        });`,
      },
      ["pages/a/a", "pages/b/b"],
    );
    view(1, { type: "ready" });
    await settle();
    view(2, { type: "ready" });
    const [observe] = toView("observeIntersection");
    expect(observe!.webviewId).toBe(2);
    const { observerId } = observe!.request;
    view(2, { type: "intersection", observerId, result: resultWith(1) });
    expect(log()).toEqual([1]);

    wx().navigateBack();
    for (let i = 0; i < 3; i++) await settle();
    view(2, { type: "intersection", observerId, result: resultWith(0) });
    expect(log()).toEqual([1]);
    // The closed page's view is not asked to stop
    expect(toView("unobserve")).toEqual([]);
  });
});
