/** `<scroll-view>`, with scroll events, positioning properties and the custom pull-to-refresh. */
import { Applied, Builtin, animate, emit, lengthOf, trackDrag } from "./base.ts";

type RefresherState = "idle" | "pulling" | "refreshing" | "closing";

/** How far a finger moves before a touch is a drag, in px. */
const DRAG_SLOP = 5;
/** Without `enable-back-to-top`, a scroll view at least this share of the window's height goes back to the top, as WeChat does since 2.27.3. */
const BACK_TO_TOP_SHARE = 0.9;

export class WxScrollView extends Builtin {
  private readonly applied = new Applied();
  private last = { top: 0, left: 0 };
  private edges = { upper: true, lower: false };
  private readonly refresher: HTMLElement;
  private readonly dots: HTMLElement;
  private state: RefresherState = "idle";
  private pull = 0;
  private stopAnimation = () => {};
  /** When the user triggered a refresh. */
  private refreshedAt = 0;
  /** A finger down on an enhanced scroll view; `started` once it has moved, which is when WeChat's drag begins. */
  private enhancedDrag?: { x: number; y: number; t: number; started: boolean };
  /**
   * What a ScrollViewContext set, over the attributes of the same name; a
   * later change of the attribute wins again.
   */
  private overrides: Record<string, boolean> = {};
  /** Set by the view before a context call. */
  omrSelect?: (selector: string) => Element[];

  constructor() {
    super();
    const root = this.shadow(`<style>
      .refresher { display: none; position: relative; overflow: hidden; height: 0; flex: none; width: 100%; }
      :host([refresher-enabled]) .refresher { display: block; }
      .default { position: absolute; left: 0; right: 0; bottom: 0; height: var(--omr-refresher-height, 45px); display: flex; align-items: center; justify-content: center; gap: 8px; }
      .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: var(--omr-pull-opacity, 0); }
      .refreshing .dot { opacity: 1; animation: omr-refresher-dot 1.2s ease-in-out infinite; }
      .refreshing .dot:nth-child(2) { animation-delay: 0.2s; }
      .refreshing .dot:nth-child(3) { animation-delay: 0.4s; }
      @keyframes omr-refresher-dot { 0%, 100% { opacity: 0.2; } 40% { opacity: 1; } }
      .custom { position: absolute; left: 0; right: 0; bottom: 0; }
    </style><div class="refresher" part="refresher"><div class="default"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div><div class="custom"><slot name="refresher"></slot></div></div><slot></slot>`);
    this.refresher = root.querySelector(".refresher")!;
    this.dots = root.querySelector(".default")!;
    this.addEventListener("scroll", () => this.onScroll(), { passive: true });
    this.addEventListener("scrollend", () => this.snapToPage());
    trackDrag(this, {
      start: () =>
        this.flag("refresher-enabled") &&
        this.flag("scroll-y") &&
        this.scrollTop <= 0 &&
        (this.state === "idle" || this.state === "closing"),
      accept: (dx, dy) => dy > 0 && dy >= Math.abs(dx),
      move: (_, dy) => {
        if (dy <= 0 && this.state !== "pulling") return;
        if (this.state !== "pulling") {
          this.stopAnimation();
          this.state = "pulling";
        }
        // The refresher follows the finger at half the speed
        this.setPull(Math.max(0, dy / 2));
        emit(this, "refresherpulling", { dy: this.pull });
      },
      end: () => {
        if (this.state !== "pulling") return;
        if (this.pull >= this.threshold()) {
          this.state = "refreshing";
          this.refreshedAt = performance.now();
          this.glide(this.threshold());
          emit(this, "refresherrefresh");
        } else {
          this.close("refresherabort");
        }
      },
    });
    // With `enhanced`, the drag events report the scroll position. A tap is not a drag:
    // dragstart waits until the finger has moved
    this.addEventListener("pointerdown", (event) => {
      if (!this.flag("enhanced")) return;
      this.enhancedDrag = {
        x: event.clientX,
        y: event.clientY,
        t: event.timeStamp,
        started: false,
      };
    });
    this.addEventListener("pointermove", (event) => {
      const drag = this.enhancedDrag;
      if (!drag) return;
      if (!drag.started) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_SLOP) return;
        drag.started = true;
        emit(this, "dragstart", this.position());
        return;
      }
      emit(this, "dragging", this.position());
    });
    const dragEnd = (event: PointerEvent) => {
      const drag = this.enhancedDrag;
      this.enhancedDrag = undefined;
      if (!drag?.started) return;
      const time = Math.max(1, event.timeStamp - drag.t);
      emit(this, "dragend", {
        ...this.position(),
        velocity: { x: (drag.x - event.clientX) / time, y: (drag.y - event.clientY) / time },
      });
    };
    this.addEventListener("pointerup", dragEnd);
    this.addEventListener("pointercancel", dragEnd);
  }

  /**
   * Tapping the status bar on iOS, or double-tapping the title on Android:
   * a vertical scroll view with `enable-back-to-top` scrolls to the top, as
   * one does without it unless it is set to false, when it fills most of the window.
   */
  omrBackToTop(): void {
    if (!this.flag("scroll-y") || this.scrollTop <= 0) return;
    const set = this.props["enable-back-to-top"];
    const on =
      set !== undefined
        ? this.flag("enable-back-to-top")
        : this.getBoundingClientRect().height >= window.innerHeight * BACK_TO_TOP_SHARE;
    if (on) this.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** A ScrollViewContext setting: what the context set, else the attribute. */
  private setting(name: string, attribute: string, fallback: boolean): boolean {
    if (name in this.overrides) return this.overrides[name]!;
    const value = this.props[attribute];
    return value === undefined ? fallback : this.flag(attribute);
  }

  /** The settings `NodesRef.node` reports; WeChat gives a context only with `enhanced`. */
  omrSettings(): Record<string, boolean> | undefined {
    if (!this.flag("enhanced")) return undefined;
    return {
      scrollEnabled: this.setting("scrollEnabled", "", true),
      bounces: this.setting("bounces", "bounces", true),
      showScrollbar: this.setting("showScrollbar", "show-scrollbar", true),
      pagingEnabled: this.setting("pagingEnabled", "paging-enabled", false),
      fastDeceleration: this.setting("fastDeceleration", "fast-deceleration", false),
      decelerationDisabled: false,
    };
  }

  /** ScrollViewContext methods, and `set` for its properties. */
  omrCall(method: string, args: unknown[]): void {
    const options = (args[0] ?? {}) as Record<string, unknown>;
    switch (method) {
      case "set":
        this.overrides = { ...this.overrides, ...(options as Record<string, boolean>) };
        this.applySettings();
        return;
      case "scrollTo": {
        const to: ScrollToOptions = { behavior: options.animated ? "smooth" : "auto" };
        if (typeof options.top === "number") to.top = options.top;
        if (typeof options.left === "number") to.left = options.left;
        this.scrollTo(to);
        return;
      }
      case "scrollIntoView": {
        const selector = typeof args[0] === "string" ? args[0] : "";
        const target = (this.omrSelect?.(selector) ?? []).find((el) => this.contains(el));
        if (!target) throw new Error(`${selector} not found in the scroll-view`);
        this.scrollToElement(target, 0, "auto");
        return;
      }
      case "triggerRefresh":
        if (!this.flag("refresher-enabled") || this.state === "refreshing") return;
        this.state = "refreshing";
        this.refreshedAt = performance.now();
        this.glide(this.threshold(), undefined, Number(options.duration ?? 300) || 300);
        emit(this, "refresherrefresh");
        return;
      case "closeRefresh":
        if (this.state === "refreshing") this.close("refresherrestore");
        return;
      // The two-level refresher is Skyline only
      case "triggerTwoLevel":
      case "closeTwoLevel":
        return;
      default:
        throw new Error(`${method} is not supported`);
    }
  }

  private applySettings(): void {
    // Only what a context changed goes inline; the rest stays with the page's styles
    const locked = this.overrides.scrollEnabled === false;
    this.style.setProperty("overflow", locked ? "hidden" : "", locked ? "important" : "");
    this.style.setProperty(
      "overscroll-behavior",
      this.flag("enhanced") && !this.setting("bounces", "bounces", true) ? "none" : "",
    );
    // `show-scrollbar` (true by default) works with `enhanced`; other scroll views show none, as before
    this.style.setProperty(
      "scrollbar-width",
      !this.flag("enhanced")
        ? ""
        : this.setting("showScrollbar", "show-scrollbar", true)
          ? "thin"
          : "none",
    );
  }

  private position() {
    return { scrollTop: this.scrollTop, scrollLeft: this.scrollLeft };
  }
  private threshold(): number {
    return Math.max(1, this.num("refresher-threshold", 45));
  }

  protected override update(): void {
    this.style.setProperty("overflow-anchor", this.flag("scroll-anchoring") ? "auto" : "none");
    // An attribute the logic layer changes wins over what a context set before
    for (const [name, attribute] of [
      ["bounces", "bounces"],
      ["showScrollbar", "show-scrollbar"],
      ["pagingEnabled", "paging-enabled"],
      ["fastDeceleration", "fast-deceleration"],
    ] as const) {
      if (this.applied.changed(attribute, this.props[attribute])) delete this.overrides[name];
    }
    this.applySettings();
    this.refresher.style.background = this.str("refresher-background");
    const style = this.str("refresher-default-style", "black");
    this.dots.hidden = style === "none";
    this.dots.style.color = style === "white" ? "#fff" : "#000";
    this.refresher.style.setProperty("--omr-refresher-height", `${this.threshold()}px`);
    this.updateRefresher();
    // Children are patched after attributes, so scroll once the render finishes
    queueMicrotask(() => this.applyScroll());
  }

  private updateRefresher(): void {
    const triggered = this.flag("refresher-triggered");
    const changed = this.applied.changed("refresher-triggered", triggered);
    if (!this.flag("refresher-enabled")) {
      if (this.state !== "idle") this.reset();
      return;
    }
    if (triggered && changed && this.state !== "refreshing") {
      this.state = "refreshing";
      this.glide(this.threshold());
      return;
    }
    if (this.state !== "refreshing" || triggered) return;
    // WeChat sets the property itself when the user pulls, so setting it to false closes the
    // refresher even when the page's data was already false. Renders right after the pull, such
    // as a loading flag the refresh handler sets, do not close it.
    if (changed || performance.now() - this.refreshedAt > 300) this.close("refresherrestore");
  }

  private reset(): void {
    this.stopAnimation();
    this.state = "idle";
    this.setPull(0);
  }

  private close(event: "refresherabort" | "refresherrestore"): void {
    this.state = "closing";
    this.glide(0, () => {
      this.state = "idle";
      emit(this, event);
    });
  }

  private glide(to: number, done?: () => void, duration = 250): void {
    this.stopAnimation();
    const from = this.pull;
    this.stopAnimation = animate(from === to ? 0 : duration, (t) => {
      this.setPull(from + (to - from) * t);
      if (t >= 1) done?.();
    });
  }

  private setPull(pull: number): void {
    this.pull = pull;
    this.refresher.style.height = `${pull}px`;
    this.refresher.style.setProperty(
      "--omr-pull-opacity",
      String(Math.min(1, pull / this.threshold())),
    );
    this.dots.classList.toggle("refreshing", this.state === "refreshing");
  }

  private applyScroll(): void {
    const behavior: ScrollBehavior = this.flag("scroll-with-animation") ? "smooth" : "auto";
    // scroll-into-view comes before scroll-top
    const intoView = this.str("scroll-into-view");
    if (this.applied.changed("scroll-into-view", intoView) && intoView) {
      const target = this.querySelector(`#${CSS.escape(intoView)}`);
      if (target) {
        this.scrollToElement(target, lengthOf(this.props["scroll-into-view-offset"]), behavior);
        return;
      }
    }
    for (const [prop, axis] of [
      ["scroll-top", "top"],
      ["scroll-left", "left"],
    ] as const) {
      const value = this.props[prop];
      if (this.applied.changed(prop, value) && value !== undefined && value !== "") {
        this.scrollTo({ [axis]: lengthOf(value), behavior });
      }
    }
  }

  private scrollToElement(target: Element, extra: number, behavior: ScrollBehavior): void {
    const offset = target.getBoundingClientRect();
    const box = this.getBoundingClientRect();
    this.scrollTo({
      top: this.flag("scroll-y") ? this.scrollTop + offset.top - box.top + extra : undefined,
      left: this.flag("scroll-x") ? this.scrollLeft + offset.left - box.left + extra : undefined,
      behavior,
    });
  }

  /** `paging-enabled` stops at whole pages of the scroll view's size. */
  private snapToPage(): void {
    if (!this.flag("enhanced") || !this.setting("pagingEnabled", "paging-enabled", false)) return;
    const vertical = this.flag("scroll-y");
    const page = vertical ? this.clientHeight : this.clientWidth;
    if (page <= 0) return;
    const at = vertical ? this.scrollTop : this.scrollLeft;
    const target = Math.round(at / page) * page;
    if (Math.abs(target - at) > 1) {
      this.scrollTo({ [vertical ? "top" : "left"]: target, behavior: "smooth" });
    }
  }

  private onScroll(): void {
    const { scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth } = this;
    emit(this, "scroll", {
      scrollLeft,
      scrollTop,
      scrollHeight,
      scrollWidth,
      deltaX: this.last.left - scrollLeft,
      deltaY: this.last.top - scrollTop,
    });
    this.last = { top: scrollTop, left: scrollLeft };
    const vertical = this.flag("scroll-y");
    const upperThreshold = lengthOf(this.props["upper-threshold"], 50);
    const lowerThreshold = lengthOf(this.props["lower-threshold"], 50);
    const upper = (vertical ? scrollTop : scrollLeft) <= upperThreshold;
    const lower = vertical
      ? scrollTop + clientHeight >= scrollHeight - lowerThreshold
      : scrollLeft + clientWidth >= scrollWidth - lowerThreshold;
    if (upper && !this.edges.upper) {
      emit(this, "scrolltoupper", { direction: vertical ? "top" : "left" });
    }
    if (lower && !this.edges.lower) {
      emit(this, "scrolltolower", { direction: vertical ? "bottom" : "right" });
    }
    this.edges = { upper, lower };
  }
}
