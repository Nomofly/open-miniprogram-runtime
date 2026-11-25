/** `<swiper>` and `<swiper-item>`. */
import { Applied, Builtin, animate, emit, lengthOf, trackDrag } from "./base.ts";

const EASINGS: Record<string, (t: number) => number> = {
  default: (t) => 1 - (1 - t) ** 2.4,
  linear: (t) => t,
  easeInCubic: (t) => t ** 3,
  easeOutCubic: (t) => 1 - (1 - t) ** 3,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
};

/** An item places itself through its own style sheet, so the `style` the view writes does not move it. */
export class WxSwiperItem extends Builtin {
  private readonly placement: HTMLStyleElement;
  constructor() {
    super();
    const root = this.shadow(
      `<style>:host { display: block; position: absolute; top: 0; left: 0; width: 100%; height: 100%; box-sizing: border-box; overflow: hidden; }</style><style></style><slot></slot>`,
    );
    this.placement = root.querySelectorAll("style")[1]!;
  }
  place(css: string): void {
    if (this.placement.textContent !== css) this.placement.textContent = css;
  }
}

export class WxSwiper extends Builtin {
  /** The index the swiper rests at. */
  private current = 0;
  /** Where the swiper is, in items from the first; fractional while it moves. */
  private position = 0;
  private readonly applied = new Applied();
  /** A `current` or `current-item-id` whose item is not rendered yet. */
  private pending?: { index: number } | { itemId: string };
  private timer?: ReturnType<typeof setInterval>;
  private stopAnimation = () => {};
  private dragging = false;
  private readonly dots: HTMLElement;
  private readonly resize = new ResizeObserver(() => this.layout());
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: block; position: relative; height: 150px; overflow: hidden; }
      .track { position: absolute; inset: 0; overflow: hidden; }
      .dots { position: absolute; left: 0; right: 0; bottom: 10px; display: flex; justify-content: center; gap: 6px; pointer-events: none; }
      .dots.vertical { left: auto; right: 10px; top: 0; bottom: 0; flex-direction: column; align-items: center; justify-content: center; }
      .dot { width: 8px; height: 8px; border-radius: 50%; transition: background-color 0.3s; }
    </style><div class="track"><slot></slot></div><div class="dots"></div>`);
    this.dots = root.querySelector(".dots")!;
    root.querySelector("slot")!.addEventListener("slotchange", () => {
      if (!this.resolvePending()) {
        this.current = this.clampIndex(this.current);
        this.position = this.current;
      }
      this.layout();
    });
    let from = 0;
    trackDrag(this, {
      start: () => this.items().length > 1,
      accept: (dx, dy) =>
        this.isVertical() ? Math.abs(dy) >= Math.abs(dx) : Math.abs(dx) >= Math.abs(dy),
      move: (dx, dy) => {
        if (!this.dragging) {
          this.dragging = true;
          this.stopAnimation();
          from = this.position;
        }
        const delta = (this.isVertical() ? dy : dx) / this.itemSize();
        let next = from - delta;
        if (!this.flag("circular")) {
          // Past the first or last item the swiper resists
          const last = this.lastIndex();
          if (next < 0) next /= 3;
          else if (next > last) next = last + (next - last) / 3;
        }
        this.position = next;
        this.layout();
        this.transition();
      },
      end: (_, __, velocity) => {
        this.dragging = false;
        const speed = this.isVertical() ? velocity.y : velocity.x;
        const moved = this.position - this.current;
        let target = this.current;
        if (Math.abs(moved) > 0.5) target = Math.round(this.position);
        else if (Math.abs(speed) > 0.3 || Math.abs(moved) > 0.2) {
          target = this.current + (moved > 0 ? 1 : -1);
        }
        this.go(target, "touch");
        this.restartTimer();
      },
    });
  }
  connectedCallback(): void {
    this.resize.observe(this);
    // A swiper moved back into the page, as a wx:if branch is, plays again
    if (!this.timer && this.flag("autoplay")) this.restartTimer();
  }
  disconnectedCallback(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.resize.disconnect();
  }
  private isVertical(): boolean {
    return this.flag("vertical");
  }
  private items(): WxSwiperItem[] {
    return [...this.children].filter(
      (child): child is WxSwiperItem => child instanceof WxSwiperItem,
    );
  }
  private perView(): number {
    return Math.max(1, Math.floor(this.num("display-multiple-items", 1)));
  }
  private lastIndex(): number {
    const count = this.items().length;
    return this.flag("circular") ? count - 1 : Math.max(0, count - this.perView());
  }
  private clampIndex(index: number): number {
    return Math.max(0, Math.min(this.lastIndex(), Math.round(index) || 0));
  }
  private margins(): [number, number] {
    return [lengthOf(this.props["previous-margin"]), lengthOf(this.props["next-margin"])];
  }
  private size(): number {
    return this.isVertical() ? this.clientHeight : this.clientWidth;
  }
  private itemSize(): number {
    const [previous, next] = this.margins();
    return Math.max(1, (this.size() - previous - next) / this.perView());
  }

  /** Which item `current` or `current-item-id` names; undefined until that item is rendered. */
  private indexOf(request: { index: number } | { itemId: string }): number | undefined {
    const items = this.items();
    if (items.length === 0) return undefined;
    if ("index" in request) return request.index;
    const index = items.findIndex((item) => item.getAttribute("item-id") === request.itemId);
    return index === -1 ? undefined : index;
  }

  /**
   * Rests at the item a `current` or `current-item-id` named before it was
   * rendered, as on the first render, where the view applies attributes before
   * it adds the items. It moves there directly, without `change`.
   */
  private resolvePending(): boolean {
    const target = this.pending && this.indexOf(this.pending);
    if (target === undefined) return false;
    this.pending = undefined;
    this.current = this.position = this.clampIndex(target);
    return true;
  }

  protected override update(): void {
    const itemId = this.str("current-item-id");
    const currentChanged = this.applied.changed("current", this.props.current);
    const itemIdChanged = this.applied.changed("current-item-id", itemId);
    let request: { index: number } | { itemId: string } | undefined;
    if (itemIdChanged && itemId) request = { itemId };
    else if (currentChanged) request = { index: this.num("current", 0) };
    if (request) {
      const target = this.indexOf(request);
      // An item not rendered yet, as the view adds the items after this, is waited for
      this.pending = target === undefined ? request : undefined;
      if (target !== undefined) {
        if (!this.isConnected || this.size() === 0) {
          this.current = this.position = this.clampIndex(target);
        } else {
          queueMicrotask(() => this.go(target, ""));
        }
        // Autoplay counts its interval again from the item the logic layer chose
        this.restartTimer();
      }
    }
    const timing = [
      this.applied.changed("autoplay", this.flag("autoplay")),
      this.applied.changed("interval", this.props.interval),
      this.applied.changed("circular", this.flag("circular")),
    ];
    if (timing.includes(true)) this.restartTimer();
    // Children are patched after attributes, so lay out once the render finishes
    queueMicrotask(() => {
      this.resolvePending();
      this.layout();
    });
  }

  private restartTimer(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    if (!this.flag("autoplay")) return;
    this.timer = setInterval(
      () => {
        if (this.dragging) return;
        // Without circular, autoplay goes back to the first item after the last
        const next =
          this.current + 1 > this.lastIndex() && !this.flag("circular") ? 0 : this.current + 1;
        this.go(next, "autoplay");
      },
      this.num("interval", 5000),
    );
  }

  private go(index: number, source: string): void {
    const count = this.items().length;
    if (count === 0) return;
    const circular = this.flag("circular");
    // With circular, moving past the last item continues to the first, in the same direction
    const destination = circular ? index : this.clampIndex(index);
    const next = circular ? ((Math.round(destination) % count) + count) % count : destination;
    const changed = next !== this.current;
    this.current = next;
    const itemId = this.items()[next]?.getAttribute("item-id") ?? "";
    if (changed) emit(this, "change", { current: next, currentItemId: itemId, source });
    this.stopAnimation();
    const from = this.position;
    // With circular, head for the copy of the item nearest to where the swiper is, so an
    // interrupted move keeps its direction
    const to = circular
      ? destination + count * Math.round((from - destination) / count)
      : destination;
    const easing = EASINGS[this.str("easing-function", "default")] ?? EASINGS.default!;
    this.stopAnimation = animate(
      from === to ? 0 : this.num("duration", 500),
      (t) => {
        this.position = from + (to - from) * t;
        if (t >= 1) this.position = next;
        this.layout();
        if (t < 1) this.transition();
        else if (changed || from !== to) {
          emit(this, "animationfinish", { current: next, currentItemId: itemId, source });
        }
      },
      easing,
    );
  }

  /** Reports how far the items moved from the current one, as `bindtransition` does. */
  private transition(): void {
    const distance = (this.position - this.current) * this.itemSize();
    emit(this, "transition", this.isVertical() ? { dx: 0, dy: distance } : { dx: distance, dy: 0 });
  }

  /** Where the first item starts for a resting index, with `snap-to-edge` pinning the ends. */
  private startAt(index: number): number {
    const [previous] = this.margins();
    const size = this.itemSize();
    const start = previous - index * size;
    if (!this.flag("snap-to-edge") || this.flag("circular") || this.items().length < 2)
      return start;
    if (index <= 0) return 0;
    const last = this.lastIndex();
    if (index >= last) return this.size() - this.items().length * size;
    return start;
  }

  private layout(): void {
    const items = this.items();
    const count = items.length;
    const vertical = this.isVertical();
    const size = this.itemSize();
    const circular = this.flag("circular") && count > 1;
    const [previous] = this.margins();
    let start = 0;
    if (!circular) {
      const low = Math.floor(this.position);
      const fraction = this.position - low;
      start = this.startAt(low) + (this.startAt(low + 1) - this.startAt(low)) * fraction;
    }
    items.forEach((item, index) => {
      let offset: number;
      if (circular) {
        // Each item sits on the side of the current one it is closest to, so the ends join
        const relative = ((((index - this.position + 1) % count) + count) % count) - 1;
        offset = previous + relative * size;
      } else {
        offset = start + index * size;
      }
      item.place(
        `:host { ${vertical ? "height" : "width"}: ${size}px; transform: ${vertical ? `translateY(${offset}px)` : `translateX(${offset}px)`} !important; }`,
      );
    });
    this.style.touchAction = vertical ? "pan-x" : "pan-y";
    this.dots.className = `dots${vertical ? " vertical" : ""}`;
    this.dots.hidden = !this.flag("indicator-dots");
    if (this.dots.hidden) return;
    const color = this.str("indicator-color", "rgba(0, 0, 0, 0.3)");
    const active = this.str("indicator-active-color", "#000000");
    const shown = ((Math.round(this.position) % count) + count) % count;
    if (this.dots.childElementCount !== count) {
      this.dots.replaceChildren(
        ...items.map(() => Object.assign(document.createElement("span"), { className: "dot" })),
      );
    }
    [...this.dots.children].forEach((dot, index) => {
      (dot as HTMLElement).style.background = index === shown ? active : color;
    });
  }
}
