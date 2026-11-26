// @vitest-environment happy-dom
import { compileWxml, type WebviewBundle } from "@omr/compiler";
import type { ViewToLogic } from "@omr/runtime";
import { expect, test } from "vite-plus/test";
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
