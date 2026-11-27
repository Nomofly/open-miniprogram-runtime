/**
 * Animations: `wx.createAnimation`, whose exported steps the view plays on an
 * element's `animation` attribute, and the keyframe animations of a page's or
 * component's `this.animate` and `this.clearAnimation`, which the view plays
 * with the Web Animations API.
 */
import { safeCall, type AnyFunction } from "./common.ts";
import type { ApiContext } from "./context.ts";

/** One call of an `Animation` method: a CSS property (`style`) or a transform function. */
export interface AnimationAnimate {
  type: string;
  args: unknown[];
}

/** One `step()`: what it animates and how. */
export interface AnimationAction {
  animates: AnimationAnimate[];
  option: {
    transition: { duration: number; timingFunction: string; delay: number };
    transformOrigin: string;
  };
}

/**
 * The key under which an export's identity crosses to the view, so setting the
 * same export again does not replay it while a new export with the same steps
 * does. It is not enumerable on the exported object, only in its JSON.
 */
export const ANIMATION_EXPORT_ID = "__omrExportId";

interface StepOptions {
  duration: number;
  timingFunction: string;
  delay: number;
  transformOrigin: string;
}

const DEFAULT_STEP: StepOptions = {
  duration: 400,
  timingFunction: "linear",
  delay: 0,
  transformOrigin: "50% 50% 0",
};

const stepOptions = (base: StepOptions, options: unknown): StepOptions => {
  const given = (options && typeof options === "object" ? options : {}) as Record<string, unknown>;
  const number = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const text = (value: unknown, fallback: string) =>
    typeof value === "string" && value ? value : fallback;
  return {
    duration: number(given.duration, base.duration),
    timingFunction: text(given.timingFunction, base.timingFunction),
    delay: number(given.delay, base.delay),
    transformOrigin: text(given.transformOrigin, base.transformOrigin),
  };
};

/** A length: a number is in px; a string, such as `50%` or `20rpx`, is kept. */
const length = (value: unknown) => (typeof value === "number" ? `${value}px` : String(value));

let nextExportId = 1;

/**
 * The animation object of `wx.createAnimation`. Methods describe a step;
 * `step()` ends it, and `export()` hands every step since the last export to
 * an `animation` attribute. A step lists only its own calls; the element keeps
 * what earlier steps set, so `rotate(45).step()` then `scale(2).step()` stays
 * rotated while it scales.
 */
export class Animation {
  #defaults: StepOptions;
  #actions: AnimationAction[] = [];
  #step: AnimationAnimate[] = [];

  constructor(options?: unknown) {
    this.#defaults = stepOptions(DEFAULT_STEP, options);
  }

  #add(type: string, args: unknown[]) {
    this.#step.push({ type, args });
    return this;
  }
  #style(name: string, value: unknown) {
    return this.#add("style", [name, value]);
  }

  opacity(value: number) {
    return this.#style("opacity", value);
  }
  backgroundColor(value: string) {
    return this.#style("background-color", value);
  }
  width(value: number | string) {
    return this.#style("width", length(value));
  }
  height(value: number | string) {
    return this.#style("height", length(value));
  }
  top(value: number | string) {
    return this.#style("top", length(value));
  }
  left(value: number | string) {
    return this.#style("left", length(value));
  }
  bottom(value: number | string) {
    return this.#style("bottom", length(value));
  }
  right(value: number | string) {
    return this.#style("right", length(value));
  }

  rotate(angle: number) {
    return this.#add("rotate", [angle]);
  }
  rotateX(angle: number) {
    return this.#add("rotateX", [angle]);
  }
  rotateY(angle: number) {
    return this.#add("rotateY", [angle]);
  }
  rotateZ(angle: number) {
    return this.#add("rotateZ", [angle]);
  }
  rotate3d(x: number, y: number, z: number, angle: number) {
    return this.#add("rotate3d", [x, y, z, angle]);
  }
  /** With only `sx`, both axes scale by it. */
  scale(sx: number, sy?: number) {
    return this.#add("scale", [sx, sy ?? sx]);
  }
  scaleX(scale: number) {
    return this.#add("scaleX", [scale]);
  }
  scaleY(scale: number) {
    return this.#add("scaleY", [scale]);
  }
  scaleZ(scale: number) {
    return this.#add("scaleZ", [scale]);
  }
  scale3d(sx: number, sy: number, sz: number) {
    return this.#add("scale3d", [sx, sy, sz]);
  }
  /** With only `tx`, it moves along the X axis. */
  translate(tx: number | string, ty?: number | string) {
    return this.#add("translate", [tx, ty ?? 0]);
  }
  translateX(translation: number | string) {
    return this.#add("translateX", [translation]);
  }
  translateY(translation: number | string) {
    return this.#add("translateY", [translation]);
  }
  translateZ(translation: number | string) {
    return this.#add("translateZ", [translation]);
  }
  translate3d(tx: number | string, ty: number | string, tz: number | string) {
    return this.#add("translate3d", [tx, ty, tz]);
  }
  skew(ax: number, ay?: number) {
    return this.#add("skew", [ax, ay ?? 0]);
  }
  skewX(angle: number) {
    return this.#add("skewX", [angle]);
  }
  skewY(angle: number) {
    return this.#add("skewY", [angle]);
  }
  matrix(...args: number[]) {
    return this.#add("matrix", args);
  }
  matrix3d(...args: number[]) {
    return this.#add("matrix3d", args);
  }

  step(options?: unknown) {
    const { duration, timingFunction, delay, transformOrigin } = stepOptions(
      this.#defaults,
      options,
    );
    this.#actions.push({
      animates: this.#step,
      option: { transition: { duration, timingFunction, delay }, transformOrigin },
    });
    this.#step = [];
    return this;
  }

  /** The steps since the last export, which this clears. */
  export(): { actions: AnimationAction[] } {
    const actions = this.#actions;
    this.#actions = [];
    // Calls not ended by step() are cleared too
    this.#step = [];
    const id = nextExportId++;
    const exported = { actions };
    Object.defineProperty(exported, "toJSON", {
      value: () => ({ actions, [ANIMATION_EXPORT_ID]: id }),
    });
    return exported;
  }
}

export function createAnimationApis({ host }: ApiContext) {
  let nextAnimationId = 0;
  /** Callbacks waiting for the view, by animation id. */
  const pending = new Map<number, { webviewId: number; done: () => void }>();

  const scopeOf = (instance: object, name: string) => {
    const scope = host.scopeOf(instance);
    if (!scope) console.warn(`[omr] this.${name} called on a page or component that is gone`);
    return scope;
  };
  const register = (webviewId: number, instance: object, callback: unknown) => {
    const animationId = ++nextAnimationId;
    pending.set(animationId, {
      webviewId,
      done: () => {
        if (typeof callback === "function") {
          safeCall(callback.bind(instance) as AnyFunction, undefined);
        }
      },
    });
    return animationId;
  };

  /** `this.animate(selector, keyframes, duration, callback)` of a page or component. */
  const animate = (instance: object, ...args: unknown[]): void => {
    const [selector, keyframes, duration, callback] = args;
    if (callback && typeof callback === "object") {
      console.warn(
        "[omr] this.animate with a ScrollTimeline is not supported in the simulator; the animation is not played",
      );
      return;
    }
    if (typeof selector !== "string" || !Array.isArray(keyframes)) {
      console.error("[omr] this.animate expects a selector and an array of keyframes");
      return;
    }
    const scope = scopeOf(instance, "animate");
    if (!scope) return;
    host.sendView(scope.webviewId, {
      type: "animate",
      animationId: register(scope.webviewId, instance, callback),
      scopeNodeId: scope.nodeId,
      selector,
      keyframes: JSON.parse(JSON.stringify(keyframes)) as Record<string, unknown>[],
      duration: Number(duration) || 0,
    });
  };

  /** `this.clearAnimation(selector, options?, callback?)`: options name the fields to clear; none clears all. */
  const clearAnimation = (instance: object, ...args: unknown[]): void => {
    const selector = args[0];
    let [, options, callback] = args;
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    if (typeof selector !== "string") {
      console.error("[omr] this.clearAnimation expects a selector");
      return;
    }
    const scope = scopeOf(instance, "clearAnimation");
    if (!scope) return;
    const properties =
      options && typeof options === "object"
        ? Object.entries(options).flatMap(([name, value]) => (value ? [name] : []))
        : undefined;
    host.sendView(scope.webviewId, {
      type: "clearAnimation",
      animationId: register(scope.webviewId, instance, callback),
      scopeNodeId: scope.nodeId,
      selector,
      properties,
    });
  };

  /** The view finished an animation or a clear; only the WebView that was asked may answer. */
  const animationDone = (webviewId: number, animationId: number) => {
    const entry = pending.get(animationId);
    if (entry?.webviewId !== webviewId) return;
    pending.delete(animationId);
    entry.done();
  };
  /** A page is gone; its animations never finish. */
  const releasePage = (webviewId: number) => {
    for (const [id, entry] of pending) if (entry.webviewId === webviewId) pending.delete(id);
  };

  return {
    apis: { createAnimation: (options?: unknown) => new Animation(options) },
    animate,
    clearAnimation,
    animationDone,
    releasePage,
  };
}
