import { compileWxml, type WebviewBundle } from "@omr/compiler";
import { resolvePath } from "@omr/runtime";
import { describe, expect, test, vi } from "vite-plus/test";
import { convertRpx, renderScope, type VElement, type VNode } from "../src/render.ts";

/** Renders a page template with data, as the view layer does before patching the DOM. */
function render(
  wxml: string,
  data: Record<string, unknown>,
  extraFiles: Record<string, string> = {},
  written?: Set<string>,
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
    usingComponents: { card: "components/card/card", "sticky-header": "components/sticky/sticky" },
    prefix: "",
  };
  const bundle = { route: "pages/a/a", page, components: {}, files, wxs: {}, css: "", window: {} };
  return renderScope(
    { nodeId: 0, def: page, data, transformClass: (value) => value, written },
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
  test("Skyline tags render as built-ins unless the page names a component so", () => {
    const nodes = render(
      `<grid-view><span>a</span></grid-view><sticky-header>b</sticky-header>`,
      {},
    );
    expect(show(nodes)).toBe("<wx-grid-view><wx-span>a<sticky-header>b");
  });

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

  test("an element names the attributes whose bindings read written data, through wx:for and template data", () => {
    const wxml = `<view a="{{on}}" b="{{other}}" />
<view wx:for="{{list}}" c="{{item}}" d="{{other}}" />
<template name="t"><view e="{{x}}" /></template>
<template is="t" data="{{x: on}}" />
<template is="t" data="{{x: other}}" />`;
    const data = { on: false, other: 1, list: [1] };
    const nodes = render(wxml, data, {}, new Set(["on", "list"])) as VElement[];
    expect(nodes.map((node) => node.written ?? [])).toEqual([["a"], ["c"], ["e"], []]);
    // Without a setData, nothing is written
    expect((render(wxml, data) as VElement[]).every((node) => !node.written)).toBe(true);
  });

  test("template data written field by field: a field is written only when its own expression read written data", () => {
    const wxml = `<template name="t"><view a="{{triggered}}" b="{{n}}" c="{{m}}" /></template>
<template is="t" data="{{triggered: triggered, n: n, 'm': 1}}" />
<template is="t" data="{{triggered, ...rest, n: 2}}" />
<template is="t" data="{{['triggered']: triggered}}" />`;
    const data = { triggered: false, n: 0, rest: { n: 1, m: 3 }, list: [1] };
    const written = (names: string[]) =>
      (render(wxml, data, {}, new Set(names)) as VElement[]).map((node) => node.written ?? []);
    // A literal with computed keys is written as a whole, when it reads written data
    expect(written(["n"])).toEqual([["b"], [], []]);
    expect(written(["triggered"])).toEqual([["a"], ["a"], ["a"]]);
    // A spread writes the fields it brings, unless a later field replaces them
    expect(written(["rest"])).toEqual([[], ["c"], []]);
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

  test("a template that calls itself twice stops within one render's budget, with one warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const nodes = render(
        `<template name="t"><view /><template is="t" /><template is="t" /></template><template is="t" />`,
        {},
      );
      expect(nodes.length).toBeGreaterThan(0);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
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
