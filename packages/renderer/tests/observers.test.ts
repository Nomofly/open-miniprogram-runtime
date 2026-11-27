// @vitest-environment happy-dom
import type { ViewToLogic } from "@omr/runtime";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  createObservers,
  crossesThreshold,
  expandBox,
  measureIntersection,
  mediaQueryOf,
} from "../src/observers.ts";

const box = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

describe("intersection observers", () => {
  test("the first measurement fires only when it is on the other side of a threshold than initialRatio", () => {
    // Default initialRatio 0 and threshold 0: a visible node fires, a hidden one does not
    expect(crossesThreshold(0, 0.3, [0])).toBe(true);
    expect(crossesThreshold(0, 0, [0])).toBe(false);
    // initialRatio 1: a fully visible node does not fire, a partly visible one does
    expect(crossesThreshold(1, 1, [0, 1])).toBe(false);
    expect(crossesThreshold(1, 0.6, [0, 1])).toBe(true);
    // A ratio different from initialRatio but on the same side of every threshold does not fire
    expect(crossesThreshold(0.2, 0.4, [0, 0.5])).toBe(false);
    expect(crossesThreshold(0.8, 0.6, [0.5])).toBe(false);
  });

  test("reaching a threshold exactly crosses it, while 0 needs some intersection", () => {
    expect(crossesThreshold(0.4, 0.5, [0.5])).toBe(true);
    expect(crossesThreshold(0.5, 0.49, [0.5])).toBe(true);
    expect(crossesThreshold(0.99, 1, [1])).toBe(true);
    expect(crossesThreshold(0.01, 0, [0])).toBe(true);
  });

  test("crossing several thresholds in one step fires once, and going back across them fires again", () => {
    const thresholds = [0, 0.25, 0.5, 0.75, 1];
    expect(crossesThreshold(0, 1, thresholds)).toBe(true);
    expect(crossesThreshold(1, 0, thresholds)).toBe(true);
    // Moving within one band fires nothing
    expect(crossesThreshold(0.3, 0.45, thresholds)).toBe(false);
  });

  test("the ratio is the target's share inside the intersection of the reference areas", () => {
    const viewport = box(0, 0, 375, 600);
    const target = box(0, 550, 100, 650);
    const half = measureIntersection(target, [viewport]);
    expect(half.intersectionRatio).toBe(0.5);
    expect(half.intersectionRect).toEqual({
      left: 0,
      top: 550,
      right: 100,
      bottom: 600,
      width: 100,
      height: 50,
    });
    expect(half.boundingClientRect).toMatchObject({ width: 100, height: 100 });
    expect(half.relativeRect).toEqual({ left: 0, top: 0, right: 375, bottom: 600 });

    // A second reference area narrows it: only the overlap of both counts
    const both = measureIntersection(target, [viewport, box(50, 0, 375, 575)]);
    expect(both.intersectionRatio).toBe(0.125);
    expect(both.relativeRect).toEqual({ left: 50, top: 0, right: 375, bottom: 575 });

    // Disjoint and edge-adjacent boxes do not intersect
    const below = measureIntersection(box(0, 600, 100, 700), [viewport]);
    expect(below.intersectionRatio).toBe(0);
    expect(below.intersectionRect).toEqual({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    });
    // A target without area has a ratio of 0 rather than NaN
    expect(measureIntersection(box(0, 10, 100, 10), [viewport]).intersectionRatio).toBe(0);
  });

  test("margins move the reference area's edges outward, or inward when negative", () => {
    const viewport = box(0, 0, 375, 600);
    // relativeToViewport({ bottom: 100 }): a node just below the window counts
    const below = box(0, 620, 100, 680);
    expect(measureIntersection(below, [viewport]).intersectionRatio).toBe(0);
    const expanded = expandBox(viewport, { left: 0, right: 0, top: 0, bottom: 100 });
    expect(expanded).toEqual({ left: 0, top: 0, right: 375, bottom: 700 });
    expect(measureIntersection(below, [expanded]).intersectionRatio).toBe(1);
    // Negative margins shrink every side
    const shrunk = expandBox(viewport, { left: -10, right: -20, top: -30, bottom: -40 });
    expect(shrunk).toEqual({ left: 10, top: 30, right: 355, bottom: 560 });
    expect(measureIntersection(box(0, 0, 20, 40), [shrunk]).intersectionRatio).toBe(0.125);
  });

  test("a media query descriptor becomes a CSS media query", () => {
    expect(mediaQueryOf({ minWidth: 300, maxWidth: 500 })).toBe(
      "(min-width: 300px) and (max-width: 500px)",
    );
    expect(mediaQueryOf({ height: 600, orientation: "landscape" })).toBe(
      "(height: 600px) and (orientation: landscape)",
    );
    expect(mediaQueryOf({})).toBe("all");
  });
});

describe("intersection observer sizes", () => {
  test("a target that grows inside a fixed reference crosses a threshold without a render or scroll", () => {
    const resizeObservers: { callback: () => void; watched: Set<Element> }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        watched = new Set<Element>();
        callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
          resizeObservers.push(this);
        }
        observe(el: Element) {
          this.watched.add(el);
        }
        unobserve(el: Element) {
          this.watched.delete(el);
        }
      },
    );
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => fn(0));
    try {
      const target = document.createElement("div");
      const reference = document.createElement("div");
      document.body.append(target, reference);
      let bottom = 30;
      target.getBoundingClientRect = () =>
        DOMRect.fromRect({ x: 0, y: 0, width: 100, height: bottom });
      reference.getBoundingClientRect = () =>
        DOMRect.fromRect({ x: 0, y: 0, width: 100, height: 30 });
      const posted: ViewToLogic[] = [];
      const observers = createObservers({
        select: (_, selector) => [selector === ".ref" ? reference : target],
        describe: () => ({ id: "", dataset: {} }),
        post: (message) => posted.push(message),
      });
      const margins = { left: 0, right: 0, top: 0, bottom: 0 };
      observers.receive({
        type: "observeIntersection",
        request: {
          observerId: 1,
          scopeNodeId: 0,
          selector: ".target",
          all: false,
          relatives: [{ selector: ".ref", margins }],
          thresholds: [0.75],
          initialRatio: 0,
        },
      });
      observers.afterRender();
      const sizes = resizeObservers[0]!;
      expect(sizes.watched.has(target)).toBe(true);
      expect(sizes.watched.has(reference)).toBe(true);
      // Grown to 60 px, half of it is inside the 30 px reference
      bottom = 60;
      sizes.callback();
      const ratios = posted.flatMap((message) =>
        message.type === "intersection" ? [message.result.intersectionRatio] : [],
      );
      expect(ratios).toEqual([1, 0.5]);
      observers.receive({ type: "unobserve", observerId: 1 });
      expect(sizes.watched.has(target)).toBe(false);
      expect(sizes.watched.has(reference)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      document.body.replaceChildren();
    }
  });
});
