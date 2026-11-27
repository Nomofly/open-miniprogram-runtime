/**
 * Animations in the view: the steps `wx.createAnimation` exports to an
 * element's `animation` attribute, played as CSS transitions, and the keyframe
 * animations of `this.animate`, played with the Web Animations API.
 */
import { toText } from "./expression.ts";

/** WeChat's keyframe fields, and `Animation` methods, that are CSS transform functions. */
const TRANSFORM_FIELDS = new Set([
  "matrix",
  "matrix3d",
  "rotate",
  "rotate3d",
  "rotateX",
  "rotateY",
  "rotateZ",
  "scale",
  "scale3d",
  "scaleX",
  "scaleY",
  "scaleZ",
  "skew",
  "skewX",
  "skewY",
  "translate",
  "translate3d",
  "translateX",
  "translateY",
  "translateZ",
]);
/** Fields whose numbers are px. */
const LENGTH_FIELDS = new Set(["width", "height", "left", "top", "right", "bottom"]);
/** Keyframe fields that are not styles. */
const TIMING_FIELDS = new Set(["offset", "ease"]);

/** The key the logic layer gives an export's JSON; matches `ANIMATION_EXPORT_ID` in @omr/runtime. */
const EXPORT_ID = "__omrExportId";

/** Converts rpx in a CSS value. */
export type ConvertStyle = (css: string) => string;

const lengthOf = (value: unknown, convert: ConvertStyle) =>
  typeof value === "number" ? `${value}px` : convert(String(value));

/**
 * A CSS transform function from a WeChat transform and its arguments: angles
 * are degrees, translations px, and strings are kept with rpx converted.
 */
export function transformFunction(name: string, args: unknown[], convert: ConvertStyle): string {
  const values = args.map((arg, index) => {
    const angle = /^(rotate[XYZ]?|skew[XY]?)$/.test(name) || (name === "rotate3d" && index === 3);
    if (angle) return typeof arg === "number" ? `${arg}deg` : String(arg);
    if (name.startsWith("translate")) return lengthOf(arg, convert);
    return String(arg);
  });
  return `${name}(${values.join(", ")})`;
}

/** A Web Animations keyframe from one of WeChat's `this.animate` keyframes. */
export function keyframeOf(frame: Record<string, unknown>, convert: ConvertStyle): Keyframe {
  const keyframe: Keyframe = {};
  const transforms: string[] = [];
  for (const [field, value] of Object.entries(frame)) {
    if (value === undefined || value === null) continue;
    if (field === "offset") keyframe.offset = Number(value);
    else if (field === "ease") keyframe.easing = toText(value);
    else if (TRANSFORM_FIELDS.has(field)) {
      transforms.push(transformFunction(field, Array.isArray(value) ? value : [value], convert));
    } else if (LENGTH_FIELDS.has(field)) keyframe[field] = lengthOf(value, convert);
    // Other CSS properties, such as `borderRadius` or `transform`, pass through
    else keyframe[field] = typeof value === "string" ? convert(value) : toText(value);
  }
  if (transforms.length > 0) keyframe.transform = transforms.join(" ");
  return keyframe;
}

/** Keyframes without the fields `clearAnimation` names; `transform` names every transform field. */
export function withoutFields(
  frames: Record<string, unknown>[],
  fields: string[],
): Record<string, unknown>[] {
  const removed = new Set(fields);
  if (removed.has("transform")) for (const field of TRANSFORM_FIELDS) removed.add(field);
  return frames.map((frame) =>
    Object.fromEntries(Object.entries(frame).filter(([field]) => !removed.has(field))),
  );
}

interface ExportedAnimate {
  type: string;
  args: unknown[];
}
interface ExportedAction {
  animates: ExportedAnimate[];
  option: {
    transition: { duration: number; timingFunction: string; delay: number };
    transformOrigin: string;
  };
}

/** What one step of an export sets: transform functions by name, and styles by property. */
export function stepStyles(
  animates: ExportedAnimate[],
  convert: ConvertStyle,
): { transforms: [string, string][]; styles: [string, string][] } {
  const transforms: [string, string][] = [];
  const styles: [string, string][] = [];
  for (const { type, args } of animates) {
    if (type === "style") {
      const [property, value] = args;
      styles.push([String(property), typeof value === "string" ? convert(value) : String(value)]);
    } else if (TRANSFORM_FIELDS.has(type)) {
      transforms.push([type, transformFunction(type, args, convert)]);
    }
  }
  return { transforms, styles };
}

/** How long the steps before each step take, which is when it starts, in ms. */
export function stepStarts(actions: ExportedAction[]): number[] {
  let at = 0;
  return actions.map((action) => {
    const start = at;
    const { duration, delay } = action.option.transition;
    at += Math.max(0, Number(duration) || 0) + Math.max(0, Number(delay) || 0);
    return start;
  });
}

/** What the steps played so far left on an element, which survives its `style` being rewritten. */
interface Played {
  key: unknown;
  transforms: Map<string, string>;
  styles: Map<string, string>;
  transition: string;
  origin: string;
  timers: ReturnType<typeof setTimeout>[];
}

interface Tracked {
  animation: Animation;
  frames: Record<string, unknown>[];
}

export function createAnimations(convert: ConvertStyle) {
  const played = new WeakMap<HTMLElement, Played>();
  const tracked = new WeakMap<Element, Tracked[]>();

  const paint = (el: HTMLElement, state: Played) => {
    el.style.transition = state.transition;
    if (state.origin) el.style.transformOrigin = state.origin;
    for (const [property, value] of state.styles) el.style.setProperty(property, value);
    if (state.transforms.size > 0) el.style.transform = [...state.transforms.values()].join(" ");
  };

  const runStep = (el: HTMLElement, state: Played, action: ExportedAction) => {
    const { duration, timingFunction, delay } = action.option.transition;
    const { transforms, styles } = stepStyles(action.animates ?? [], convert);
    const timing = `${duration}ms ${timingFunction} ${delay}ms`;
    const properties = styles.map(([property]) => property);
    if (transforms.length > 0) properties.push("transform");
    for (const [name, value] of transforms) state.transforms.set(name, value);
    for (const [property, value] of styles) state.styles.set(property, value);
    state.transition = properties.map((property) => `${property} ${timing}`).join(", ");
    state.origin = convert(action.option.transformOrigin ?? "50% 50% 0");
    // The transition starts from what is on screen, even for an element inserted just now
    void getComputedStyle(el).transform;
    paint(el, state);
  };

  /**
   * The element's `animation` attribute: a new export plays its steps one
   * after another; the same export again does nothing. `restyled` says the
   * element's `style` attribute was just rewritten, which drops what the
   * steps set, so it is put back.
   */
  const attribute = (el: HTMLElement, value: unknown, restyled: boolean) => {
    let state = played.get(el);
    const actions = (value as { actions?: unknown } | null | undefined)?.actions;
    if (Array.isArray(actions) && actions.length > 0) {
      const key = (value as Record<string, unknown>)[EXPORT_ID] ?? JSON.stringify(value);
      if (key !== state?.key) {
        if (!state) {
          state = {
            key,
            transforms: new Map(),
            styles: new Map(),
            transition: "",
            origin: "",
            timers: [],
          };
          played.set(el, state);
        }
        state.key = key;
        // A new export replaces the steps still waiting from the last one
        for (const timer of state.timers) clearTimeout(timer);
        const current = state;
        const starts = stepStarts(actions as ExportedAction[]);
        // After the render that set it, so a new element is on screen before it moves
        current.timers = (actions as ExportedAction[]).map((action, index) =>
          setTimeout(() => runStep(el, current, action), starts[index]),
        );
        if (restyled) paint(el, state);
        return;
      }
    }
    if (state && restyled) paint(el, state);
  };

  /** `this.animate`: plays the keyframes on each element, holding the end; `done` runs once all finish. */
  const animate = (
    elements: Element[],
    frames: Record<string, unknown>[],
    duration: number,
    done: () => void,
  ) => {
    const keyframes = frames.map((frame) => keyframeOf(frame, convert));
    let remaining = elements.length;
    if (remaining === 0) done();
    for (const el of elements) {
      let animation: Animation;
      try {
        animation = el.animate(keyframes, { duration, fill: "forwards" });
      } catch (error) {
        console.error("[omr] this.animate:", error);
        if (--remaining === 0) done();
        continue;
      }
      const list = tracked.get(el) ?? [];
      list.push({ animation, frames });
      tracked.set(el, list);
      // A cleared animation is cancelled and never finishes
      animation.finished.then(
        () => {
          if (--remaining === 0) done();
        },
        () => {},
      );
    }
  };

  /** `this.clearAnimation`: removes the named fields of earlier animations, or the animations. */
  const clear = (elements: Element[], fields?: string[]) => {
    for (const el of elements) {
      const list = tracked.get(el) ?? [];
      const kept: Tracked[] = [];
      for (const entry of list) {
        const frames = fields ? withoutFields(entry.frames, fields) : [];
        const styled = frames.some((frame) =>
          Object.keys(frame).some((field) => !TIMING_FIELDS.has(field)),
        );
        if (!styled) {
          entry.animation.cancel();
          continue;
        }
        entry.frames = frames;
        (entry.animation.effect as KeyframeEffect | null)?.setKeyframes(
          frames.map((frame) => keyframeOf(frame, convert)),
        );
        kept.push(entry);
      }
      tracked.set(el, kept);
    }
  };

  return { attribute, animate, clear };
}
