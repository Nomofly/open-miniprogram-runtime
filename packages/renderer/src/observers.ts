/**
 * The view side of `IntersectionObserver` and `MediaQueryObserver`. Like
 * WeChat's default (non-native) observers, intersections are computed from
 * layout boxes: the target's box against the intersection of its reference
 * areas, which may be any nodes rather than only ancestors. They are measured
 * again after each render, on scrolls of the page or any scroll-view, and
 * when the window or the page changes size.
 */
import type {
  IntersectionMargins,
  IntersectionRect,
  IntersectionRequest,
  LogicToView,
  MediaQueryDescriptor,
  ViewToLogic,
} from "@omr/runtime";

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Whether a ratio reaches a threshold: any intersection reaches 0; other thresholds need at least their value. */
const reaches = (ratio: number, threshold: number) =>
  threshold <= 0 ? ratio > threshold : ratio >= threshold;

/**
 * Whether going from one intersection ratio to another crosses a threshold, so
 * the callback fires. Crossing several thresholds at once fires once. The first
 * measurement compares against `initialRatio`.
 */
export function crossesThreshold(previous: number, current: number, thresholds: number[]): boolean {
  return thresholds.some(
    (threshold) => reaches(previous, threshold) !== reaches(current, threshold),
  );
}

/** A box with each edge moved outward by its margin. */
export const expandBox = (box: Box, margins: IntersectionMargins): Box => ({
  left: box.left - margins.left,
  top: box.top - margins.top,
  right: box.right + margins.right,
  bottom: box.bottom + margins.bottom,
});

const EMPTY_RECT: IntersectionRect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
const rectOf = (box: Box): IntersectionRect => ({
  left: box.left,
  top: box.top,
  right: box.right,
  bottom: box.bottom,
  width: box.right - box.left,
  height: box.bottom - box.top,
});

/**
 * Measures a target box against reference areas, whose intersection is the
 * reference area. The ratio is the share of the target's area inside it, so a
 * target without area has a ratio of 0.
 */
export function measureIntersection(target: Box, references: Box[]) {
  const relative = references.reduce((area, box) => ({
    left: Math.max(area.left, box.left),
    top: Math.max(area.top, box.top),
    right: Math.min(area.right, box.right),
    bottom: Math.min(area.bottom, box.bottom),
  }));
  const overlap = {
    left: Math.max(target.left, relative.left),
    top: Math.max(target.top, relative.top),
    right: Math.min(target.right, relative.right),
    bottom: Math.min(target.bottom, relative.bottom),
  };
  const intersects = overlap.right > overlap.left && overlap.bottom > overlap.top;
  const targetArea = (target.right - target.left) * (target.bottom - target.top);
  const area = intersects ? (overlap.right - overlap.left) * (overlap.bottom - overlap.top) : 0;
  return {
    intersectionRatio: targetArea > 0 ? Math.min(1, area / targetArea) : 0,
    intersectionRect: intersects ? rectOf(overlap) : { ...EMPTY_RECT },
    boundingClientRect: rectOf(target),
    relativeRect: {
      left: relative.left,
      top: relative.top,
      right: relative.right,
      bottom: relative.bottom,
    },
  };
}

/** The CSS media query of a `MediaQueryObserver` descriptor; an empty descriptor matches always. */
export function mediaQueryOf(descriptor: MediaQueryDescriptor): string {
  const features: [keyof MediaQueryDescriptor, string][] = [
    ["minWidth", "min-width"],
    ["maxWidth", "max-width"],
    ["width", "width"],
    ["minHeight", "min-height"],
    ["maxHeight", "max-height"],
    ["height", "height"],
  ];
  const parts = features
    .filter(([name]) => typeof descriptor[name] === "number")
    .map(([name, feature]) => `(${feature}: ${descriptor[name]}px)`);
  if (descriptor.orientation) parts.push(`(orientation: ${descriptor.orientation})`);
  return parts.length > 0 ? parts.join(" and ") : "all";
}

export interface ObserverHost {
  /**
   * The rendered elements a selector matches in the template of a page (0) or
   * component: undefined while the scope has not rendered, null once it is gone.
   */
  select(scopeNodeId: number, selector: string): Element[] | null | undefined;
  describe(el: Element): { id: string; dataset: Record<string, unknown> };
  post(message: ViewToLogic): void;
}

type ObserverMessage = Extract<
  LogicToView,
  { type: "observeIntersection" | "observeMediaQuery" | "unobserve" }
>;

interface Observation {
  request: IntersectionRequest;
  /** Each target with its last ratio, which starts at `initialRatio`. */
  targets: { el: Element; ratio: number }[];
  /** The element of each `relativeTo` node, null for the viewport, undefined when not found. */
  relatives: (Element | null | undefined)[];
}

export function createObservers(host: ObserverHost) {
  /** Requests waiting for their scope to render. */
  const pending = new Map<number, IntersectionRequest>();
  const observations = new Map<number, Observation>();
  const mediaQueries = new Map<number, { list: MediaQueryList; listener: () => void }>();

  /** Selects the nodes of a request; false while its scope has not rendered yet. */
  const start = (request: IntersectionRequest): boolean => {
    const targets = host.select(request.scopeNodeId, request.selector);
    if (targets === undefined) return false;
    if (targets === null) return true;
    const chosen = request.all ? targets : targets.slice(0, 1);
    if (chosen.length === 0) {
      console.warn(`[omr] IntersectionObserver: no node matches "${request.selector}"`);
      return true;
    }
    const relatives = request.relatives.map(({ selector }) => {
      if (selector === null) return null;
      const el = host.select(request.scopeNodeId, selector)?.[0];
      if (!el) console.warn(`[omr] IntersectionObserver: no node matches "${selector}"`);
      return el;
    });
    observations.set(request.observerId, {
      request,
      targets: chosen.map((el) => ({ el, ratio: request.initialRatio })),
      relatives,
    });
    return true;
  };

  const viewport = (): Box => ({
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  });
  const NOWHERE: Box = { left: 0, top: 0, right: 0, bottom: 0 };

  const check = () => {
    for (const [observerId, { request, targets, relatives }] of observations) {
      const references =
        relatives.length === 0
          ? [viewport()]
          : relatives.map((el, index) =>
              el === undefined
                ? NOWHERE
                : expandBox(
                    el === null ? viewport() : el.getBoundingClientRect(),
                    request.relatives[index]!.margins,
                  ),
            );
      for (const target of targets) {
        // A node removed from the page is no longer observed
        if (!target.el.isConnected) continue;
        const measured = measureIntersection(target.el.getBoundingClientRect(), references);
        const previous = target.ratio;
        target.ratio = measured.intersectionRatio;
        if (!crossesThreshold(previous, measured.intersectionRatio, request.thresholds)) continue;
        host.post({
          type: "intersection",
          observerId,
          result: { ...host.describe(target.el), time: Date.now(), ...measured },
        });
      }
    }
  };

  let queued = false;
  const queueCheck = () => {
    if (queued || observations.size === 0) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      check();
    });
  };
  // Scroll events do not bubble, but a capturing listener hears those of every scroll-view
  document.addEventListener("scroll", queueCheck, { capture: true, passive: true });
  window.addEventListener("resize", queueCheck);
  // Layout that changes without a render, such as an image that loaded
  new ResizeObserver(queueCheck).observe(document.documentElement);

  return {
    receive(message: ObserverMessage) {
      switch (message.type) {
        case "observeIntersection":
          pending.set(message.request.observerId, message.request);
          break;
        case "observeMediaQuery": {
          const list = window.matchMedia(mediaQueryOf(message.descriptor));
          let matches = list.matches;
          const listener = () => {
            if (list.matches === matches) return;
            matches = list.matches;
            host.post({ type: "mediaQuery", observerId: message.observerId, matches });
          };
          list.addEventListener("change", listener);
          mediaQueries.set(message.observerId, { list, listener });
          host.post({ type: "mediaQuery", observerId: message.observerId, matches });
          break;
        }
        case "unobserve": {
          pending.delete(message.observerId);
          observations.delete(message.observerId);
          const media = mediaQueries.get(message.observerId);
          media?.list.removeEventListener("change", media.listener);
          mediaQueries.delete(message.observerId);
          break;
        }
      }
    },
    /** Starts the requests whose scope has rendered and measures every observation. */
    afterRender() {
      for (const [observerId, request] of pending) {
        if (start(request)) pending.delete(observerId);
      }
      if (observations.size > 0) check();
    },
  };
}
