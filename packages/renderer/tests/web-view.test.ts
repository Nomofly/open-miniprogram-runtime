// @vitest-environment happy-dom
import { compileWxml, type WebviewBundle } from "@omr/compiler";
import type { LogicToView, ViewToLogic } from "@omr/runtime";
import { expect, test } from "vite-plus/test";
import { startView } from "../src/view.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the view reports the page's first <web-view>: src and handlers, when they change, and its removal", async () => {
  const wxml = `<view>before</view>
<web-view wx:if="{{show}}" id="web" data-kind="h5" src="{{src}}" bindload="onLoad" binderror="onError" bindmessage="onMessage" bindtap="onTap"></web-view>
<web-view src="https://second.example.com/"></web-view>`;
  const bundle: WebviewBundle = {
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
  const reports = () => posted.filter((message) => message.type === "webView");
  let seq = 0;
  const send = async (message: Omit<Extract<LogicToView, { type: "setData" }>, "seq" | "type">) => {
    handle({ type: "setData", ...message, seq: ++seq });
    await settle();
  };
  handle({ type: "init", data: { show: true, src: "https://h5.example.com/a" }, seq: ++seq });
  await settle();
  const handler = (name: string) => ({ ownerId: 0, handler: name });
  expect(reports()).toEqual([
    {
      type: "webView",
      src: "https://h5.example.com/a",
      target: expect.objectContaining({ id: "web", dataset: { kind: "h5" } }),
      // Only the web-view's own events; a tap never reaches it
      handlers: {
        load: handler("onLoad"),
        error: handler("onError"),
        message: handler("onMessage"),
      },
    },
  ]);

  // Data that does not touch it sends nothing again
  await send({ nodeId: 0, patch: { other: 1 } });
  expect(reports()).toHaveLength(1);

  await send({ nodeId: 0, patch: { src: "https://h5.example.com/b" } });
  expect(reports().at(-1)).toMatchObject({ src: "https://h5.example.com/b" });

  // Without the first one, the page's next web-view is the one shown
  await send({ nodeId: 0, patch: { show: false } });
  expect(reports().at(-1)).toEqual({
    type: "webView",
    src: "https://second.example.com/",
    target: expect.objectContaining({ id: "" }),
    handlers: {},
  });
  expect(reports()).toHaveLength(3);
});
