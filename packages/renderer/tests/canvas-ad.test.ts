// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { defineBuiltins, type BuiltinElement, type OmrEventDetail } from "../src/builtins.ts";
import { setAdConfig } from "../src/components/ad.ts";

defineBuiltins();

function mount(tag: string, props: Record<string, unknown>) {
  const el = document.createElement(tag) as BuiltinElement;
  const events: OmrEventDetail[] = [];
  el.addEventListener("omr-event", (event) =>
    events.push((event as CustomEvent<OmrEventDetail>).detail),
  );
  el.omrUpdate(props);
  document.body.append(el);
  return { el, events };
}

const collapsed = (el: Element) =>
  el.shadowRoot!.querySelector("style")!.textContent!.includes("height: 0 !important");

afterEach(() => {
  document.body.replaceChildren();
  setAdConfig(undefined);
  vi.useRealTimers();
});

describe("ad", () => {
  test("fills with a mock ad, fires load and never lets a click become a tap", async () => {
    vi.useFakeTimers();
    const { el, events } = mount("wx-ad", { "unit-id": "adunit-1" });
    expect(collapsed(el)).toBe(true);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toEqual([{ name: "load", detail: {} }]);
    expect(collapsed(el)).toBe(false);
    const card = el.shadowRoot!.querySelector<HTMLElement>(".card")!;
    expect(card.classList.contains("banner")).toBe(true);
    expect(card.textContent).toContain("广告");
    expect(card.textContent).toContain("unit-id: adunit-1");

    // The view raises tap from clicks that reach the document
    const reached = vi.fn();
    document.addEventListener("click", reached);
    card.querySelector<HTMLElement>(".media")!.click();
    el.click();
    document.removeEventListener("click", reached);
    expect(reached).not.toHaveBeenCalled();
  });

  test("the close button fires close and takes the ad's height away", async () => {
    vi.useFakeTimers();
    const { el, events } = mount("wx-ad", { "unit-id": "adunit-1", "ad-theme": "black" });
    await vi.advanceTimersByTimeAsync(100);
    expect(el.shadowRoot!.querySelector(".card.black")).not.toBeNull();
    el.shadowRoot!.querySelector<HTMLElement>(".close")!.click();
    expect(events.map((event) => event.name)).toEqual(["load", "close"]);
    expect(collapsed(el)).toBe(true);
    expect(el.shadowRoot!.querySelector(".card")).toBeNull();
  });

  test("ad-type and ad-intervals of 30 seconds or more", async () => {
    vi.useFakeTimers();
    const video = mount("wx-ad", { "unit-id": "a", "ad-type": "video", "ad-intervals": 30 });
    const grid = mount("wx-ad", { "unit-id": "b", "ad-type": "grid", "ad-intervals": 10 });
    await vi.advanceTimersByTimeAsync(100);
    expect(video.el.shadowRoot!.querySelector(".card.video .play")).not.toBeNull();
    expect(grid.el.shadowRoot!.querySelectorAll(".card.grid .app")).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(video.events.map((event) => event.name)).toEqual(["load", "load", "load"]);
    expect(grid.events.map((event) => event.name)).toEqual(["load"]);
  });

  test("error takes no height and fires error 1004 by default", async () => {
    vi.useFakeTimers();
    setAdConfig({ result: "error" });
    const ad = mount("wx-ad", { "unit-id": "adunit-1" });
    const custom = mount("wx-ad-custom", { "unit-id": "adunit-2" });
    await vi.advanceTimersByTimeAsync(100);
    for (const { el, events } of [ad, custom]) {
      expect(events).toEqual([
        { name: "error", detail: { errCode: 1004, errMsg: "无适合的广告" } },
      ]);
      expect(collapsed(el)).toBe(true);
      expect(el.shadowRoot!.querySelector(".card")).toBeNull();
    }
    setAdConfig({ result: "error", errCode: 1002 });
    const other = mount("wx-ad", { "unit-id": "adunit-3" });
    await vi.advanceTimersByTimeAsync(100);
    expect(other.events).toEqual([
      { name: "error", detail: { errCode: 1002, errMsg: "广告单元无效" } },
    ]);
  });

  test("ad-custom fills with a native template card", async () => {
    vi.useFakeTimers();
    const { el, events } = mount("wx-ad-custom", { "unit-id": "adunit-2" });
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toEqual([{ name: "load", detail: {} }]);
    expect(el.shadowRoot!.querySelector(".card.custom .action")).not.toBeNull();
  });
});

describe("canvas", () => {
  test("disable-scroll keeps a move on the canvas from scrolling the page", () => {
    const canvas = document.createElement("wx-canvas") as BuiltinElement;
    canvas.omrUpdate({ "disable-scroll": true });
    document.body.append(canvas);
    const move = new Event("touchmove", { bubbles: true, cancelable: true });
    canvas.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
    expect(canvas.shadowRoot!.querySelector("canvas")!.classList.contains("no-scroll")).toBe(true);

    canvas.omrUpdate({});
    const free = new Event("touchmove", { bubbles: true, cancelable: true });
    canvas.dispatchEvent(free);
    expect(free.defaultPrevented).toBe(false);
  });

  test("a repeated canvas-id hides the later canvas and fires error", async () => {
    const events: OmrEventDetail[] = [];
    const canvases = [0, 1].map(() => {
      const canvas = document.createElement("wx-canvas") as BuiltinElement;
      canvas.addEventListener("omr-event", (event) =>
        events.push((event as CustomEvent<OmrEventDetail>).detail),
      );
      canvas.omrUpdate({ "canvas-id": "poster" });
      document.body.append(canvas);
      return canvas;
    });
    await Promise.resolve();
    expect(events).toEqual([
      {
        name: "error",
        detail: { errMsg: 'canvas-id "poster" is already used by another canvas on this page' },
      },
    ]);
    const shown = canvases.map(
      (canvas) => canvas.shadowRoot!.querySelector("canvas")!.style.display !== "none",
    );
    expect(shown).toEqual([true, false]);
  });
});
