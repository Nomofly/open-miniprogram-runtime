// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { defineBuiltins, type BuiltinElement } from "../src/builtins.ts";
import { animate } from "../src/components/base.ts";

defineBuiltins();

/** Creates a built-in as the view does: attributes first, then the children, then into the page. */
function mount(
  tag: string,
  props: Record<string, unknown>,
  children: { tag: string; props: Record<string, unknown> }[] = [],
  extra: Record<string, unknown> = {},
): BuiltinElement {
  const el = Object.assign(document.createElement(tag), extra) as unknown as BuiltinElement;
  el.omrUpdate(props);
  for (const child of children) {
    const node = document.createElement(child.tag) as BuiltinElement;
    for (const [name, value] of Object.entries(child.props)) node.setAttribute(name, String(value));
    node.omrUpdate(child.props);
    el.append(node);
  }
  document.body.append(el);
  return el;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("swiper", () => {
  const items = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      tag: "wx-swiper-item",
      props: { "item-id": `item${index}` },
    }));
  const events = (el: Element) => {
    const names: string[] = [];
    el.addEventListener("omr-event", (event) =>
      names.push((event as CustomEvent<{ name: string }>).detail.name),
    );
    return names;
  };
  const currentOf = (el: Element) => (el as unknown as { current: number }).current;

  test("current set before the items are added is where the first render rests, without change", async () => {
    const swiper = mount("wx-swiper", { current: 2 }, items(4));
    const fired = events(swiper);
    await settle();
    expect(currentOf(swiper)).toBe(2);
    // The same value again stays there
    swiper.omrUpdate({ current: 2 });
    await settle();
    expect(currentOf(swiper)).toBe(2);
    expect(fired).not.toContain("change");
  });

  test("current-item-id set before the items are added is where the first render rests", async () => {
    const swiper = mount("wx-swiper", { "current-item-id": "item3" }, items(4));
    const fired = events(swiper);
    await settle();
    expect(currentOf(swiper)).toBe(3);
    expect(fired).not.toContain("change");
  });
});

describe("animate", () => {
  test("progress stays within 0 and 1 when a frame's timestamp precedes the start", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const seen: number[] = [];
    animate(
      100,
      (t) => seen.push(t),
      (t) => t,
    );
    const start = performance.now();
    frames.shift()!(start - 16);
    frames.shift()!(start + 50);
    frames.shift()!(start + 200);
    expect(seen[0]).toBe(0);
    expect(seen[1]).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(1);
    expect(seen.every((t) => t >= 0 && t <= 1)).toBe(true);
  });
});

describe("progress", () => {
  test("kebab-case colors are used, ahead of camelCase, and lengths accept rpx", () => {
    const progress = mount("wx-progress", {
      percent: 40,
      "active-color": "red",
      activeColor: "blue",
      "background-color": "yellow",
      "stroke-width": "750rpx",
    });
    const root = progress.shadowRoot!;
    const bar = root.querySelector<HTMLElement>(".bar")!;
    expect(root.querySelector<HTMLElement>(".inner")!.style.background).toBe("red");
    expect(bar.style.background).toBe("yellow");
    expect(bar.style.height).toBe(`${window.innerWidth}px`);
  });

  test("camelCase colors still work", () => {
    const progress = mount("wx-progress", { percent: 40, activeColor: "blue" });
    expect(progress.shadowRoot!.querySelector<HTMLElement>(".inner")!.style.background).toBe(
      "blue",
    );
  });
});

describe("rich-text", () => {
  const scope = { omrTransformClass: (value: string) => `card--${value}` };

  test("classes in array nodes and string nodes take the owner's style scope", () => {
    const array = mount(
      "wx-rich-text",
      { nodes: [{ name: "div", attrs: { class: "title" }, children: [] }] },
      [],
      scope,
    );
    expect(array.querySelector("div")!.className).toBe("card--title");
    const html = mount("wx-rich-text", { nodes: '<p class="body">x</p>' }, [], scope);
    expect(html.querySelector("p")!.className).toBe("card--body");
  });

  test("text nodes decode entities without parsing markup", () => {
    const el = mount("wx-rich-text", {
      nodes: [{ type: "text", text: "a&nbsp;&lt;b&gt;&amp;<img src=x onerror=alert(1)>" }],
    });
    expect(el.textContent).toBe("a\u00a0<b>&<img src=x onerror=alert(1)>");
    expect(el.querySelector("img")).toBeNull();
  });

  test("links do not navigate and space keeps runs of spaces", () => {
    const el = mount("wx-rich-text", {
      nodes: '<a href="https://example.com">a  b</a>',
      space: "nbsp",
    });
    const link = el.querySelector("a")!;
    expect(link.hasAttribute("href")).toBe(false);
    expect(link.textContent).toBe("a\u00a0\u00a0b");
  });
});
