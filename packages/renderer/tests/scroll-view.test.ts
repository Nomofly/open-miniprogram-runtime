// @vitest-environment happy-dom
import { compileWxml, type WebviewBundle } from "@omr/compiler";
import type { ViewToLogic } from "@omr/runtime";
import { describe, expect, test } from "vite-plus/test";
import type { BuiltinElement } from "../src/builtins.ts";
import { startView } from "../src/view.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("NodesRef.node gives an enhanced <scroll-view>, without an id, whose context methods reach it", async () => {
  const wxml = `<scroll-view class="list" scroll-y enhanced paging-enabled refresher-enabled bindrefresherrefresh="onRefresh" style="height:100px">
  <view wx:for="{{[1,2,3]}}" wx:key="*this" id="item{{item}}">{{item}}</view>
</scroll-view>
<scroll-view class="plain" scroll-y></scroll-view>`;
  const bundle = {
    route: "pages/a/a",
    page: { path: "pages/a/a", template: "pages/a/a.wxml", usingComponents: {}, prefix: "" },
    components: {},
    files: { "pages/a/a.wxml": compileWxml(wxml, "pages/a/a.wxml") },
    wxs: {},
    css: "",
    window: {},
  } as unknown as WebviewBundle;
  const posted: ViewToLogic[] = [];
  const handle = startView({
    bundle,
    windowWidth: 375,
    assetBase: "/files/",
    styleV2: false,
    post: (message) => posted.push(message),
  });
  handle({ type: "init", data: {}, seq: 1 });
  await settle();
  handle({
    type: "query",
    queryId: 1,
    requests: [".list", ".plain"].map((selector) => ({
      selector,
      all: false,
      scopeNodeId: 0,
      fields: { node: true },
    })),
  });
  await settle();
  const answer = posted.find((message) => message.type === "queryResult");
  if (answer?.type !== "queryResult") throw new Error("no answer");
  const [enhanced, plain] = answer.results as { node: Record<string, any> | null }[];
  // WeChat gives a ScrollViewContext only with `enhanced`
  expect(plain!.node).toBeNull();
  const target = enhanced!.node!.scrollView;
  expect(target).toMatchObject({ tag: "scroll-view", id: "", scopeNodeId: 0 });
  expect(target.settings).toMatchObject({ scrollEnabled: true, pagingEnabled: true });

  let callId = 0;
  const call = async (method: string, args: unknown[]) => {
    const id = ++callId;
    const { settings: _, ...builtin } = target;
    handle({ type: "callBuiltin", callId: id, target: builtin, method, args });
    await settle();
    return posted.find((message) => message.type === "builtinResult" && message.callId === id);
  };
  const list = document.querySelector<HTMLElement>("wx-scroll-view.list")!;
  expect(await call("set", [{ scrollEnabled: false }])).toMatchObject({ result: {} });
  expect(list.style.overflow).toBe("hidden");
  await call("set", [{ scrollEnabled: true }]);
  expect(list.style.overflow).toBe("");

  await call("triggerRefresh", [{}]);
  const refreshes = posted.filter(
    (message) => message.type === "event" && message.handler === "onRefresh",
  );
  expect(refreshes).toHaveLength(1);

  expect(await call("scrollIntoView", ["#item9", {}])).toMatchObject({
    error: "#item9 not found in the scroll-view",
  });
  expect(await call("scrollIntoView", ["#item3", {}])).toMatchObject({ result: {} });
});

describe("scroll-view defaults", () => {
  const mount = (props: Record<string, unknown>) => {
    const el = document.createElement("wx-scroll-view") as BuiltinElement;
    el.omrUpdate(props);
    document.body.append(el);
    return el;
  };
  const names = (el: Element) => {
    const fired: string[] = [];
    el.addEventListener("omr-event", (event) =>
      fired.push((event as CustomEvent<{ name: string }>).detail.name),
    );
    return fired;
  };
  const pointer = (el: Element, type: string, x: number, y: number) =>
    el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true }));

  test("an enhanced scroll view fires dragstart once the finger moves, and nothing for a tap", () => {
    const el = mount({ "scroll-y": true, enhanced: true });
    const fired = names(el);
    pointer(el, "pointerdown", 10, 100);
    pointer(el, "pointermove", 11, 102);
    pointer(el, "pointerup", 11, 102);
    expect(fired).toEqual([]);
    pointer(el, "pointerdown", 10, 100);
    pointer(el, "pointermove", 10, 90);
    pointer(el, "pointermove", 10, 80);
    pointer(el, "pointerup", 10, 80);
    expect(fired).toEqual(["dragstart", "dragging", "dragend"]);
  });

  test("show-scrollbar is on by default with enhanced, and only then", () => {
    expect(mount({ "scroll-y": true }).style.scrollbarWidth).toBe("");
    expect(mount({ "scroll-y": true, enhanced: true }).style.scrollbarWidth).toBe("thin");
    const off = mount({ "scroll-y": true, enhanced: true, "show-scrollbar": false });
    expect(off.style.scrollbarWidth).toBe("none");
  });

  test("back to top scrolls a scroll view with enable-back-to-top, or one that fills the window unless set to false", () => {
    const scrolled = (props: Record<string, unknown>, height: number) => {
      const el = mount({ "scroll-y": true, ...props });
      el.getBoundingClientRect = () => new DOMRect(0, 0, 300, height);
      Object.defineProperty(el, "scrollTop", { value: 200, configurable: true });
      const calls: unknown[] = [];
      el.scrollTo = ((options: ScrollToOptions) => calls.push(options)) as typeof el.scrollTo;
      (el as BuiltinElement & { omrBackToTop(): void }).omrBackToTop();
      return calls;
    };
    const tall = window.innerHeight;
    expect(scrolled({ "enable-back-to-top": true }, 100)).toEqual([{ top: 0, behavior: "smooth" }]);
    expect(scrolled({}, tall)).toHaveLength(1);
    expect(scrolled({}, 100)).toHaveLength(0);
    expect(scrolled({ "enable-back-to-top": false }, tall)).toHaveLength(0);
  });
});

test("a plain selector matches only the caller's template; >>> reaches into components", async () => {
  const bundle = {
    route: "pages/a/a",
    page: {
      path: "pages/a/a",
      template: "pages/a/a.wxml",
      usingComponents: { child: "components/child/child" },
      prefix: "",
    },
    components: {
      "components/child/child": {
        path: "components/child/child",
        template: "components/child/child.wxml",
        usingComponents: {},
        prefix: "child",
      },
    },
    files: {
      "pages/a/a.wxml": compileWxml(
        `<child class="kid" /><view id="status">page</view>`,
        "pages/a/a.wxml",
      ),
      "components/child/child.wxml": compileWxml(
        `<view id="status">child</view>`,
        "components/child/child.wxml",
      ),
    },
    wxs: {},
    css: "",
    window: {},
  } as unknown as WebviewBundle;
  const posted: ViewToLogic[] = [];
  const handle = startView({
    bundle,
    windowWidth: 375,
    assetBase: "/files/",
    styleV2: false,
    post: (message) => posted.push(message),
  });
  handle({ type: "init", data: {}, seq: 1 });
  await settle();
  const attach = posted.find((message) => message.type === "attach");
  if (attach?.type !== "attach") throw new Error("no attach");
  handle({
    type: "componentInit",
    nodeId: attach.nodeId,
    data: {},
    options: { externalClasses: [], styleIsolation: "isolated" },
    seq: 1,
  });
  await settle();
  expect(document.querySelectorAll("#status")).toHaveLength(2);
  handle({
    type: "query",
    queryId: 1,
    requests: ["#status", ".kid >>> #status"].map((selector) => ({
      selector,
      all: true,
      scopeNodeId: 0,
      fields: { dataset: true, properties: ["id"] },
    })),
  });
  await settle();
  const answer = posted.find((message) => message.type === "queryResult");
  if (answer?.type !== "queryResult") throw new Error("no answer");
  const [plain, crossing] = answer.results as unknown[][];
  expect(plain).toHaveLength(1);
  expect(crossing).toHaveLength(1);
});

test("refresher-triggered written false closes the refresher at once; a render that does not write it leaves it open", async () => {
  const wxml = `<scroll-view scroll-y refresher-enabled refresher-triggered="{{triggered}}" bindrefresherrestore="onRestore">{{n}}</scroll-view>`;
  const bundle = {
    route: "pages/a/a",
    page: { path: "pages/a/a", template: "pages/a/a.wxml", usingComponents: {}, prefix: "" },
    components: {},
    files: { "pages/a/a.wxml": compileWxml(wxml, "pages/a/a.wxml") },
    wxs: {},
    css: "",
    window: {},
  } as unknown as WebviewBundle;
  const posted: ViewToLogic[] = [];
  const handle = startView({
    bundle,
    windowWidth: 375,
    assetBase: "/files/",
    styleV2: false,
    post: (message) => posted.push(message),
  });
  handle({ type: "init", data: { triggered: false, n: 0 }, seq: 1 });
  await settle();
  const restores = () =>
    posted.filter((message) => message.type === "event" && message.handler === "onRestore").length;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const list = document.querySelector("wx-scroll-view") as BuiltinElement;
  let seq = 1;
  const setData = (patch: Record<string, unknown>) =>
    handle({ type: "setData", nodeId: 0, patch, seq: ++seq });

  void list.omrCall!("triggerRefresh", [{}]);
  await wait(350);
  setData({ n: 1 });
  await wait(400);
  expect(restores()).toBe(0);
  setData({ triggered: false });
  await wait(400);
  expect(restores()).toBe(1);

  void list.omrCall!("triggerRefresh", [{}]);
  await wait(20);
  setData({ triggered: false });
  await wait(400);
  expect(restores()).toBe(2);
});
