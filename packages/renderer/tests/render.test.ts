import { compileWxml, type WebviewBundle } from "@omr/compiler";
import { resolvePath } from "@omr/runtime";
import { describe, expect, test } from "vite-plus/test";
import { convertRpx, renderScope, type VElement, type VNode } from "../src/render.ts";

/** Renders a page template with data, as the view layer does before patching the DOM. */
function render(
  wxml: string,
  data: Record<string, unknown>,
  extraFiles: Record<string, string> = {},
) {
  // Through JSON, as the shell sends the bundle to the page
  const files = JSON.parse(
    JSON.stringify(
      Object.fromEntries(
        Object.entries({ "pages/a/a.wxml": wxml, ...extraFiles }).map(([path, source]) => [
          path,
          compileWxml(source, path),
        ]),
      ),
    ),
  ) as Record<string, ReturnType<typeof compileWxml>>;
  const page = {
    path: "pages/a/a",
    template: "pages/a/a.wxml",
    usingComponents: { card: "components/card/card" },
    prefix: "",
  };
  const bundle = { route: "pages/a/a", page, components: {}, files, wxs: {}, css: "", window: {} };
  return renderScope(
    { nodeId: 0, def: page, data, transformClass: (value) => value },
    {
      bundle: bundle as WebviewBundle,
      wxsModules: () => ({}),
      convertStyle: (css) => convertRpx(css, 375),
      resolveAsset: (src, file) => `/files/${resolvePath(file, src)}`,
    },
  );
}

/** Text of the rendered tree, with elements as `<tag>`. */
const show = (nodes: VNode[]): string =>
  nodes
    .map((node) => (node.kind === "text" ? node.text : `<${node.tag}>${show(node.children)}`))
    .join("");

describe("renderScope", () => {
  test("wx:if chains, wx:for with item names and keys, and blocks", () => {
    const nodes = render(
      `<view wx:if="{{n > 1}}">many</view><view wx:elif="{{n === 1}}">one</view><view wx:else>none</view>
       <block wx:for="{{list}}" wx:for-item="u" wx:for-index="i" wx:key="id"><text>{{i}}:{{u.name}} </text></block>`,
      {
        n: 1,
        list: [
          { id: "b", name: "Bo" },
          { id: "a", name: "Al" },
        ],
      },
    );
    expect(show(nodes)).toBe("<wx-view>one<wx-text>0:Bo <wx-text>1:Al ");
    const [, first, second] = nodes;
    // Keys follow wx:key, so reordering the list moves nodes instead of rewriting them
    expect(first!.key).toContain(":b/");
    expect(second!.key).toContain(":a/");
  });

  test("a lone mustache keeps its value type, while mixed text becomes a string", () => {
    const [el] = render(`<view data-n="{{count}}" title="n={{count}}" hidden="{{!show}}" />`, {
      count: 2,
      show: true,
    }) as VElement[];
    expect(el!.attrs).toEqual({ "data-n": 2, title: "n=2", hidden: false });
  });

  test("missing names and errors in expressions render as empty, not as exceptions", () => {
    expect(show(render(`<text>[{{user.name}}][{{missing}}]</text>`, {}))).toBe("<wx-text>[][]");
  });

  test("templates from imported files receive their data object", () => {
    const nodes = render(
      `<import src="../../tpl/item.wxml" /><template is="item" data="{{title, n: 3}}" />`,
      { title: "Hi" },
      { "tpl/item.wxml": `<template name="item"><view>{{title}} x{{n}}</view></template>` },
    );
    expect(show(nodes)).toBe("<wx-view>Hi x3");
  });

  test("a template that renders itself stops, and Object.prototype names are not templates", () => {
    const nodes = render(
      `<template name="t"><view>a</view><template is="t" /></template><template is="t" /><template is="constructor" />`,
      {},
    );
    // Templates rendered at depths 0 to 63 each add one view; the 65th is cut
    expect(show(nodes)).toBe("<wx-view>a".repeat(64));
  });

  test("custom component hosts keep every attribute as a property and only DOM attributes on the element", () => {
    const [el] = render(
      `<card id="c" class="x" title="{{t}}" data-k="1" bind:change="onChange" />`,
      {
        t: "T",
      },
    ) as VElement[];
    expect(el!.component).toEqual({
      path: "components/card/card",
      props: { id: "c", class: "x", title: "T", "data-k": "1" },
    });
    expect(el!.attrs).toEqual({ id: "c", class: "x", "data-k": "1" });
    expect(el!.events).toEqual([
      { name: "change", handler: "onChange", catch: false, capture: false },
    ]);
  });

  test("inline rpx becomes px for the window width and asset paths resolve against the file", () => {
    const [el] = render(
      `<image style="width: 750rpx; margin: 1rpx -3rpx" src="../../img/a.png" />`,
      {},
    ) as VElement[];
    expect(el!.attrs).toEqual({ style: "width: 375px; margin: 1px -1px", src: "/files/img/a.png" });
  });
});
