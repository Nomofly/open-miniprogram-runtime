// @vitest-environment happy-dom
import { compileWxml, type WebviewBundle } from "@omr/compiler";
import type { ViewToLogic } from "@omr/runtime";
import { expect, test } from "vite-plus/test";
import { startView } from "../src/view.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a focused input raises the simulated keyboard, moves the page for adjust-position and keeps it up between fields", async () => {
  const wxml = `<input class="low" cursor-spacing="20" bindfocus="onFocus" bindkeyboardheightchange="onHeight">
  <keyboard-accessory class="bar"><cover-view>done</cover-view></keyboard-accessory>
</input>
<input class="fixed" adjust-position="{{false}}" />
<textarea class="hold" hold-keyboard />`;
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
    keyboardHeight: 300,
    assetBase: "/files/",
    styleV2: false,
    post: (message) => posted.push(message),
  });
  handle({ type: "init", data: {}, seq: 1 });
  await settle();
  const keyboard = () => posted.filter((message) => message.type === "keyboard");
  const details = (handler: string) =>
    posted.flatMap((message) =>
      message.type === "event" && message.handler === handler ? [message.event.detail] : [],
    );
  const at = (selector: string, top: number, bottom: number) => {
    const el = document.querySelector(selector)!;
    el.getBoundingClientRect = () => ({ top, bottom }) as DOMRect;
    return el.querySelector<HTMLElement>("input, textarea")!;
  };
  const height = window.innerHeight;
  // Ends 50px above the bottom: with 20px of cursor-spacing it needs 300 + 20 - 50 = 270px
  const low = at("wx-input.low", height - 90, height - 50);
  const fixed = at("wx-input.fixed", height - 90, height - 50);

  low.focus();
  await settle();
  expect(keyboard()).toEqual([{ type: "keyboard", height: 300, offset: 270 }]);
  expect(details("onFocus")).toEqual([{ value: "", height: 300 }]);
  expect(details("onHeight")).toEqual([{ height: 300, duration: 0.25 }]);
  // The accessory sits on the keyboard, which is 270px higher in the moved page
  const bar = document.querySelector<HTMLElement>("wx-keyboard-accessory")!;
  expect(bar.classList.contains("omr-keyboard-accessory-shown")).toBe(true);
  expect(bar.style.bottom).toBe("30px");

  // Moving to a field with adjust-position false keeps the keyboard up, with the page back in place
  fixed.focus();
  await settle();
  expect(bar.classList.contains("omr-keyboard-accessory-shown")).toBe(false);
  expect(keyboard().slice(1)).toEqual([{ type: "keyboard", height: 300, offset: 0 }]);

  fixed.blur();
  await settle();
  expect(keyboard().slice(2)).toEqual([{ type: "keyboard", height: 0, offset: 0 }]);
  expect(details("onHeight")).toEqual([{ height: 300, duration: 0.25 }]);
});
