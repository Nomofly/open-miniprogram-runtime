/** What every built-in component shares: the element interface the view uses, events and property helpers. */
import { toText } from "../expression.ts";
import { convertRpx } from "../render.ts";

export interface BuiltinElement extends HTMLElement {
  omrUpdate(props: Record<string, unknown>): void;
  /** Tapping a checkbox, radio, switch or picker. */
  omrActivate?(): void;
  /** The value a `<form>` submits for this control, by its `name`. */
  omrFormValue?(): unknown;
  omrReset?(): void;
  /** Replaces an input's value with what its `bindinput` handler returned; fires no event. */
  omrReplaceValue?(value: string): void;
  /** Fills `<input type="nickname">` with the nickname the user chose above the keyboard. */
  omrFill?(value: string): void;
  /** Tells a `<camera>` whether it may show its preview; `error` is its `binderror` message when not. */
  omrCameraState?(error?: string): void;
  /** A method of the component's context, such as `play` of `VideoContext`; throws the fail reason. */
  omrCall?(
    method: string,
    args: unknown[],
  ): Record<string, unknown> | void | Promise<Record<string, unknown> | void>;
}

export interface OmrEventDetail {
  name: string;
  detail: Record<string, unknown>;
}

/** Raises a WeChat event on a built-in component; the view sends it to the logic layer. It does not bubble. */
export function emit(el: Element, name: string, detail: Record<string, unknown> = {}): void {
  el.dispatchEvent(new CustomEvent<OmrEventDetail>("omr-event", { detail: { name, detail } }));
}

export const isV2 = () => document.documentElement.classList.contains("omr-v2");
export const BRAND_GREEN = () => (isV2() ? "#07c160" : "#09bb07");

/** Converts rpx in a style the view does not convert itself, such as `indicator-style`. */
export const convertStyle = (css: string) => convertRpx(css, window.innerWidth, 1);

/** A length property in px, or in rpx when it says so, such as `x="100rpx"`. */
export function lengthOf(value: unknown, fallback = 0): number {
  const text = toText(value).trim();
  const number = Number.parseFloat(text);
  if (!Number.isFinite(number)) return fallback;
  return text.endsWith("rpx") ? (number * window.innerWidth) / 750 : number;
}

export abstract class Builtin extends HTMLElement implements BuiltinElement {
  props: Record<string, unknown> = {};
  omrUpdate(props: Record<string, unknown>): void {
    this.props = props;
    this.update();
  }
  protected update(): void {}
  protected str(name: string, fallback = ""): string {
    const value = this.props[name];
    return value === undefined || value === null ? fallback : toText(value);
  }
  protected num(name: string, fallback: number): number {
    const value = Number.parseFloat(toText(this.props[name]));
    return Number.isFinite(value) ? value : fallback;
  }
  /** As on WeChat, any non-empty string, including "false", is true. */
  protected flag(name: string): boolean {
    return Boolean(this.props[name]);
  }
  /** A boolean property whose default is true, such as `overlay`: only an explicit false value turns it off. */
  protected flagOn(name: string): boolean {
    return !(name in this.props) || this.props[name] === undefined || this.flag(name);
  }
  protected shadow(html: string, init: Partial<ShadowRootInit> = {}): ShadowRoot {
    const root = this.attachShadow({ mode: "open", ...init });
    root.innerHTML = html;
    return root;
  }
}

/** Remembers the last value of a property, so a component reacts only when the logic layer changes it. */
export class Applied {
  private values = new Map<string, unknown>();
  /** Whether the value differs from the last one seen; arrays and objects compare by content. */
  changed(name: string, value: unknown): boolean {
    const key = typeof value === "object" && value !== null ? JSON.stringify(value) : value;
    if (this.values.has(name) && Object.is(this.values.get(name), key)) return false;
    this.values.set(name, key);
    return true;
  }
}

/** The element that drags each pointer, so nested draggable elements do not move together. */
const dragOwners = new Map<number, HTMLElement>();

/**
 * Lets an element follow a pointer drag. Moves are followed on the window, so
 * a fast first move that leaves the element still counts; the pointer is
 * captured once it moved, so a release outside the page ends the drag, while a
 * tap still reaches the child under it. The innermost element that accepts
 * the movement drags; `accept` can decline it, such as a horizontal swiper
 * declining a vertical drag. The click that ends a drag is swallowed, as
 * WeChat does not tap after a drag.
 */
export function trackDrag(
  el: HTMLElement,
  handlers: {
    start?(event: PointerEvent): boolean | void;
    accept?(dx: number, dy: number): boolean;
    move(dx: number, dy: number, event: PointerEvent): void;
    end(dx: number, dy: number, velocity: { x: number; y: number }, event: PointerEvent): void;
  },
  threshold = 4,
): void {
  let drag:
    | {
        id: number;
        x: number;
        y: number;
        moving: boolean;
        samples: { t: number; x: number; y: number }[];
      }
    | undefined;
  let swallowClick = false;
  const view = () => el.ownerDocument.defaultView ?? window;
  const listen = (on: boolean) => {
    const target = view();
    for (const [name, listener] of [
      ["pointermove", onMove],
      ["pointerup", finish],
      ["pointercancel", finish],
    ] as const) {
      if (on) target.addEventListener(name, listener, true);
      else target.removeEventListener(name, listener, true);
    }
  };
  const stop = () => {
    if (drag && dragOwners.get(drag.id) === el) dragOwners.delete(drag.id);
    drag = undefined;
    listen(false);
  };
  const onMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moving) {
      if (Math.hypot(dx, dy) < threshold) return;
      const owner = dragOwners.get(drag.id);
      if ((owner && owner !== el) || handlers.accept?.(dx, dy) === false) {
        stop();
        return;
      }
      dragOwners.set(drag.id, el);
      drag.moving = true;
      try {
        el.setPointerCapture(event.pointerId);
      } catch {
        // The pointer is already gone
      }
    }
    drag.samples.push({ t: event.timeStamp, x: event.clientX, y: event.clientY });
    if (drag.samples.length > 5) drag.samples.shift();
    handlers.move(dx, dy, event);
  };
  const finish = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    const { moving, samples } = drag;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    stop();
    if (!moving) return;
    swallowClick = true;
    setTimeout(() => (swallowClick = false), 0);
    const first = samples[0];
    const last = samples.at(-1);
    const time = first && last ? last.t - first.t : 0;
    const velocity =
      first && last && time > 0 && event.timeStamp - last.t < 100
        ? { x: (last.x - first.x) / time, y: (last.y - first.y) / time }
        : { x: 0, y: 0 };
    handlers.end(dx, dy, velocity, event);
  };
  el.addEventListener("pointerdown", (event) => {
    if (event.button > 0) return;
    // A new press while a drag is open means its release was never seen
    if (drag) {
      const stale = drag;
      stop();
      if (stale.moving) handlers.end(0, 0, { x: 0, y: 0 }, event);
    }
    // Forget an owner removed from the page in the middle of a drag
    if (dragOwners.get(event.pointerId)?.isConnected === false) dragOwners.delete(event.pointerId);
    if (handlers.start?.(event) === false) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moving: false, samples: [] };
    listen(true);
  });
  el.addEventListener("lostpointercapture", finish);
  el.addEventListener(
    "click",
    (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.stopImmediatePropagation();
    },
    true,
  );
}

/** Runs `step` with the eased progress on each animation frame for `duration` milliseconds. */
export function animate(
  duration: number,
  step: (progress: number) => void,
  easing: (t: number) => number = easeOutCubic,
): () => void {
  let frame = 0;
  if (duration <= 0) {
    step(1);
    return () => {};
  }
  const start = performance.now();
  const tick = (now: number) => {
    // A frame's timestamp can precede `start`, as it is when the frame began
    const t = Math.max(0, Math.min(1, (now - start) / duration));
    step(easing(t));
    if (t < 1) frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}

export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
