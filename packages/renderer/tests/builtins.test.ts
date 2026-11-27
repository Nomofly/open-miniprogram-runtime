// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { defineBuiltins, type BuiltinElement } from "../src/builtins.ts";
import { animate } from "../src/components/base.ts";
import { Wheel } from "../src/components/wheel.ts";

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
  vi.restoreAllMocks();
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

  test("only the last frame gets 1, even when the easing rounds to 1 a frame early", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const seen: number[] = [];
    // easeOutCubic is exactly 1 in floating point a few microseconds before the end
    vi.spyOn(performance, "now").mockReturnValue(1000);
    animate(250, (t) => seen.push(t));
    frames.shift()!(1250 - 0.0005);
    frames.shift()!(1250);
    expect(seen.filter((t) => t >= 1)).toHaveLength(1);
    expect(seen.at(-1)).toBe(1);
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

  test("active animates at duration ms per percent and fires activeend; forwards goes on from where it was", () => {
    // Frames run when the test says, at the time it says
    let now = 0;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => frames.push(fn));
    vi.stubGlobal("cancelAnimationFrame", () => (frames.length = 0));
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const tick = (to: number) => {
      now = to;
      for (const fn of frames.splice(0)) fn(now);
    };
    const fired: Record<string, unknown>[] = [];
    const props = { percent: 50, active: true, duration: 10, "show-info": true };
    const progress = mount("wx-progress", props);
    progress.addEventListener("omr-event", (event) =>
      fired.push((event as CustomEvent<{ name: string; detail: Record<string, unknown> }>).detail),
    );
    const inner = progress.shadowRoot!.querySelector<HTMLElement>(".inner")!;
    const info = progress.shadowRoot!.querySelector<HTMLElement>(".info")!;
    expect(inner.style.width).toBe("0%");
    // 50% at 10 ms each takes 500 ms
    tick(250);
    expect(inner.style.width).toBe("25%");
    expect(info.textContent).toBe("25%");
    tick(500);
    expect(inner.style.width).toBe("50%");
    expect(fired).toEqual([{ name: "activeend", detail: { curPercent: 50 } }]);

    // backwards (the default) starts again from 0
    progress.omrUpdate({ ...props, percent: 80 });
    expect(inner.style.width).toBe("0%");
    tick(500 + 400);
    expect(inner.style.width).toBe("40%");
    tick(500 + 800);
    expect(inner.style.width).toBe("80%");

    // forwards goes from 80 down to 60 in 200 ms
    progress.omrUpdate({ ...props, percent: 60, "active-mode": "forwards" });
    expect(inner.style.width).toBe("80%");
    tick(1300 + 100);
    expect(inner.style.width).toBe("70%");
    tick(1300 + 200);
    expect(fired.at(-1)).toEqual({ name: "activeend", detail: { curPercent: 60 } });

    // A change of color alone does not replay it
    progress.omrUpdate({ ...props, percent: 60, "active-mode": "forwards", activeColor: "red" });
    expect(inner.style.width).toBe("60%");
    expect(frames).toHaveLength(0);
  });

  test("without active the bar jumps to percent and fires nothing", () => {
    const progress = mount("wx-progress", { percent: 30 });
    expect(progress.shadowRoot!.querySelector<HTMLElement>(".inner")!.style.width).toBe("30%");
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

describe("wheel", () => {
  /** Frames run only when the test asks, each far enough ahead to finish its animation. */
  function frames() {
    let queue: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => queue.push(fn));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      queue[id - 1] = () => {};
    });
    return () => {
      while (queue.length) {
        const run = queue;
        queue = [];
        for (const fn of run) fn(performance.now() + 1000);
      }
    };
  }
  function wheel() {
    const surface = document.createElement("div");
    const content = document.createElement("div");
    surface.append(content);
    document.body.append(surface);
    const settled: number[] = [];
    const starts: number[] = [];
    const w = new Wheel(surface, content, {
      pickStart: () => starts.push(1),
      settle: (index) => settled.push(index),
    });
    w.layout(34, 10, 34);
    const step = (deltaY: number) =>
      surface.dispatchEvent(new WheelEvent("wheel", { deltaY, cancelable: true }));
    return { w, surface, content, settled, starts, step };
  }

  test("a drag that starts while the wheel glides goes on from the row it shows", () => {
    const run = frames();
    const { w, surface, content, settled, starts, step } = wheel();
    w.setIndex(4);
    step(30);
    surface.dispatchEvent(new PointerEvent("pointerdown", { clientY: 100, bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 90 }));
    expect(content.style.transform).toBe("translateY(-146px)");
    window.dispatchEvent(new PointerEvent("pointerup", { clientY: 90 }));
    run();
    expect(settled).toEqual([4]);
    expect(starts).toHaveLength(1);
  });

  test("an index set while the wheel glides applies once it stops", () => {
    const run = frames();
    const { w, content, settled, step } = wheel();
    step(30);
    w.setIndex(3);
    run();
    expect(settled).toEqual([1]);
    expect(w.index).toBe(3);
    expect(content.style.transform).toBe("translateY(-102px)");
  });

  test("a glide toward a row that is removed stops at the last row left", () => {
    const run = frames();
    const { w, settled, step } = wheel();
    w.setIndex(4);
    step(30);
    w.layout(34, 2, 34);
    run();
    expect(settled.at(-1)).toBe(1);
    expect(w.index).toBe(1);
  });

  test("a glide whose rows are all removed stops without settling at a row", () => {
    const run = frames();
    const { w, settled, step } = wheel();
    w.setIndex(5);
    step(30);
    w.layout(34, 0, 34);
    run();
    expect(settled).toEqual([]);
    expect(w.index).toBe(0);
  });

  test("with immediate-change, the last change of a picker-view is where its columns stop", async () => {
    const run = frames();
    const view = document.createElement("wx-picker-view") as unknown as BuiltinElement;
    view.omrUpdate({ "immediate-change": true });
    const columns = [0, 1].map(() => {
      const column = document.createElement("wx-picker-view-column") as unknown as BuiltinElement;
      column.omrUpdate({});
      column.append(
        ...["a", "b", "c"].map((text) =>
          Object.assign(document.createElement("div"), { textContent: text }),
        ),
      );
      view.append(column);
      return column;
    });
    document.body.append(view);
    await settle();
    const changes: unknown[] = [];
    view.addEventListener("omr-event", (event) => {
      const { name, detail } = (event as CustomEvent<{ name: string; detail: { value: unknown } }>)
        .detail;
      if (name === "change") changes.push(detail.value);
    });
    for (const column of columns)
      column.dispatchEvent(new WheelEvent("wheel", { deltaY: 30, cancelable: true }));
    run();
    expect(changes.at(-1)).toEqual([1, 1]);
  });
});

describe("live", () => {
  type Live = BuiltinElement & {
    omrPageVisibility(visible: boolean, background: boolean): void;
    omrLivePusherState(state: { errCode?: number }): void;
  };
  const codes = (el: Element) => {
    const fired: number[] = [];
    el.addEventListener("omr-event", (event) => {
      const { name, detail } = (event as CustomEvent<{ name: string; detail: { code: number } }>)
        .detail;
      if (name === "statechange") fired.push(detail.code);
    });
    return fired;
  };

  test("a player whose src changed in the background plays the new stream when the app returns", () => {
    vi.useFakeTimers();
    try {
      const player = mount("wx-live-player", { src: "rtmp://a/live", autoplay: true }) as Live;
      vi.advanceTimersByTime(2000);
      player.omrPageVisibility(false, true);
      player.omrUpdate({ src: "rtmp://b/live", autoplay: true });
      const fired = codes(player);
      vi.advanceTimersByTime(2000);
      expect(fired).toEqual([]);
      player.omrPageVisibility(true, true);
      vi.advanceTimersByTime(2000);
      expect(fired).toEqual([2001, 2002, 2008, 2026, 2003, 2004]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a play queued in the background survives two source changes and plays the last one on return", () => {
    vi.useFakeTimers();
    try {
      const player = mount("wx-live-player", { src: "rtmp://a/live" }) as Live;
      void player.omrCall!("play", []);
      vi.advanceTimersByTime(2000);
      player.omrPageVisibility(false, true);
      player.omrUpdate({ src: "rtmp://b/live" });
      player.omrUpdate({ src: "rtmp://c/live" });
      const fired = codes(player);
      player.omrPageVisibility(true, true);
      vi.advanceTimersByTime(2000);
      expect(fired).toEqual([2001, 2002, 2008, 2026, 2003, 2004]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a pusher authorized while the app is in the background starts its preview and push only on return", () => {
    vi.useFakeTimers();
    try {
      const pusher = mount("wx-live-pusher", { url: "rtmp://a/push", autopush: true }) as Live;
      const fired = codes(pusher);
      pusher.omrPageVisibility(false, true);
      pusher.omrLivePusherState({});
      vi.advanceTimersByTime(2000);
      expect(fired).toEqual([]);
      pusher.omrPageVisibility(true, true);
      vi.advanceTimersByTime(2000);
      expect(fired).toContain(1001);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a pusher's context cannot start its preview or push in the background; they start on return unless stopped", () => {
    vi.useFakeTimers();
    try {
      const pusher = mount("wx-live-pusher", { url: "rtmp://a/push" }) as Live;
      const fired = codes(pusher);
      pusher.omrPageVisibility(false, true);
      pusher.omrLivePusherState({});
      void pusher.omrCall!("startPreview", []);
      void pusher.omrCall!("start", []);
      vi.advanceTimersByTime(2000);
      expect(fired).toEqual([]);
      pusher.omrPageVisibility(true, true);
      vi.advanceTimersByTime(2000);
      expect(fired).toContain(1001);

      const other = mount("wx-live-pusher", { url: "rtmp://b/push" }) as Live;
      const otherFired = codes(other);
      other.omrPageVisibility(false, true);
      other.omrLivePusherState({});
      void other.omrCall!("start", []);
      void other.omrCall!("stop", []);
      other.omrPageVisibility(true, true);
      vi.advanceTimersByTime(2000);
      expect(otherFired).not.toContain(1001);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a push asked for in the background after the suspended preview stopped starts on return", () => {
    vi.useFakeTimers();
    try {
      const pusher = mount("wx-live-pusher", { url: "rtmp://a/push" }) as Live;
      pusher.omrLivePusherState({});
      pusher.omrPageVisibility(false, true);
      void pusher.omrCall!("stopPreview", []);
      const fired = codes(pusher);
      void pusher.omrCall!("start", []);
      vi.advanceTimersByTime(2000);
      expect(fired).toEqual([]);
      pusher.omrPageVisibility(true, true);
      vi.advanceTimersByTime(2000);
      expect(fired).toContain(1001);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a pusher whose preview stopped in the background can start once the app returns", () => {
    vi.useFakeTimers();
    try {
      const pusher = mount("wx-live-pusher", { url: "rtmp://a/push" }) as Live;
      pusher.omrLivePusherState({});
      pusher.omrPageVisibility(false, true);
      void pusher.omrCall!("stopPreview", []);
      pusher.omrPageVisibility(true, true);
      const fired = codes(pusher);
      void pusher.omrCall!("start", []);
      vi.advanceTimersByTime(2000);
      expect(fired).toContain(1001);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("form controls", () => {
  test("a picker without value submits its mode's default, and a reset returns to it", () => {
    const selector = mount("wx-picker", { range: ["a", "b"] });
    expect(selector.omrFormValue!()).toBe(0);
    const multi = mount("wx-picker", { mode: "multiSelector", range: [["a"], ["b", "c"]] });
    expect(multi.omrFormValue!()).toEqual([0, 0]);
    const date = mount("wx-picker", { mode: "date", value: "2026-11-25" });
    expect(date.omrFormValue!()).toBe("2026-11-25");
    date.omrReset!();
    expect(date.omrFormValue!()).toBe("");
  });

  test("a reset moves a slider to its lowest value", () => {
    const slider = mount("wx-slider", { min: 10, max: 50, value: 30 });
    expect(slider.omrFormValue!()).toBe(30);
    slider.omrReset!();
    expect(slider.omrFormValue!()).toBe(10);
  });

  test("an input's value replaced by its handler keeps maxlength and fires no input event", () => {
    const input = mount("wx-input", { maxlength: 4 });
    const fired: string[] = [];
    input.addEventListener("omr-event", (event) =>
      fired.push((event as CustomEvent<{ name: string }>).detail.name),
    );
    input.omrReplaceValue!("abcdef");
    expect(input.omrFormValue!()).toBe("abcd");
    expect(fired).toEqual([]);
  });
});

describe("selection", () => {
  test("reports offsets in each text unit, leaves them empty for a boundary outside, and reports the clear once", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const text = (id: string, value: string) => {
      const el = document.createElement("wx-text");
      el.id = id;
      el.setAttribute("user-select", "true");
      el.textContent = value;
      return el;
    };
    const before = document.createElement("p");
    before.textContent = "outside";
    document.body.append(before);
    const sel = mount("wx-selection", {});
    sel.append(text("a", "hello "), text("b", "world"));
    const details: Record<string, unknown>[] = [];
    sel.addEventListener("omr-event", (event) => {
      details.push((event as CustomEvent<{ detail: Record<string, unknown> }>).detail.detail);
    });
    const next = async () => {
      document.dispatchEvent(new Event("selectionchange"));
      await settle();
      return details.at(-1);
    };

    void sel.omrCall!("selectRange", [4, 8]);
    expect(await next()).toMatchObject({
      isCollapsed: false,
      selectedString: "o wo",
      firstNodeId: "a",
      firstOffset: 4,
      lastNodeId: "b",
      lastOffset: 2,
    });

    document
      .getSelection()!
      .setBaseAndExtent(before.firstChild!, 3, sel.querySelector("#b")!.firstChild!, 3);
    const outside = await next();
    expect(outside).toMatchObject({
      selectedString: "hello wor",
      firstNodeId: "",
      lastNodeId: "b",
    });
    expect(outside!.firstOffset).toBeUndefined();

    void sel.omrCall!("removeSelection", []);
    expect(await next()).toMatchObject({ isCollapsed: true, selectedString: "" });
    const count = details.length;
    await next();
    expect(details.length).toBe(count);
  });
});

describe("editor", () => {
  test("deleteText joins lines and moves a later selection back; setSelection and getSelection share the range", async () => {
    const editor = mount("wx-editor", {});
    await settle();
    const call = (method: string, options: Record<string, unknown> = {}) =>
      editor.omrCall!(method, [options]) as Record<string, unknown>;
    call("setContents", { html: "<p>abcdef</p><p>gh</p>" });
    call("setSelection", { index: 8, length: 1 });
    expect(call("getSelection").range as object).toEqual({ index: 8, length: 1 });

    call("deleteText", { index: 2, length: 5 });
    expect(call("getContents").text).toBe("abgh\n");
    // "h" was at 8 and stays selected at 3
    expect(call("getSelection").range).toEqual({ index: 3, length: 1 });

    // Out of range lengths stop before the last line end
    call("deleteText", { index: 1, length: 99 });
    expect(call("getContents").text).toBe("a\n");
    expect(() => call("deleteText", {})).toThrow("parameter.index should be Number");
  });

  test("a context edit ends the typing group, so the next keystroke is its own undo step", async () => {
    const editor = mount("wx-editor", {});
    await settle();
    const call = (method: string, options: Record<string, unknown> = {}) =>
      editor.omrCall!(method, [options]) as Record<string, unknown>;
    const area = editor.querySelector<HTMLElement>(".ql-editor")!;
    const type = (char: string) => {
      area.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: char }));
      area.querySelector("p")!.append(char);
    };
    call("setContents", { html: "<p>a</p>" });
    call("setSelection", { index: 1, length: 0 });
    type("x");
    call("insertText", { text: "b" });
    type("y");
    // insertText puts "b" at the kept selection, after "a"; one undo takes back only "y"
    call("undo");
    expect(call("getContents").text).toBe("abx\n");
  });

  test("an editor stops hearing selection changes once it leaves the page, and hears them again when it returns", async () => {
    const editor = mount("wx-editor", {});
    await settle();
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    editor.remove();
    expect(removed.mock.calls.filter(([name]) => name === "selectionchange")).toHaveLength(1);
    document.body.append(editor);
    expect(added.mock.calls.filter(([name]) => name === "selectionchange")).toHaveLength(1);
    expect(removed.mock.calls[0]![1]).toBe(
      added.mock.calls.find(([name]) => name === "selectionchange")![1],
    );
  });

  test("getHistoryState follows the undo and redo stacks", async () => {
    const editor = mount("wx-editor", {});
    await settle();
    const call = (method: string, options: Record<string, unknown> = {}) =>
      editor.omrCall!(method, [options]) as Record<string, unknown>;
    const state = () => call("getHistoryState");
    expect(state()).toEqual({ canUndo: false, canRedo: false });
    call("setContents", { html: "<p>a</p>" });
    call("insertText", { text: "b" });
    expect(state()).toEqual({ canUndo: true, canRedo: false });
    call("undo");
    expect(state()).toEqual({ canUndo: true, canRedo: true });
    call("undo");
    expect(state()).toEqual({ canUndo: false, canRedo: true });
    call("redo");
    expect(state()).toEqual({ canUndo: true, canRedo: true });
    // A new edit drops what could be redone
    call("insertText", { text: "c" });
    expect(state()).toEqual({ canUndo: true, canRedo: false });
  });
});
