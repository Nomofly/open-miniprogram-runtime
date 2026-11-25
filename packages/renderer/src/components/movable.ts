/** `<movable-area>` and `<movable-view>`: a view the user drags, and the area that bounds it. */
import { Applied, Builtin, animate, emit, lengthOf, trackDrag } from "./base.ts";

export class WxMovableArea extends Builtin {
  private readonly resize = new ResizeObserver(() => this.views().forEach((view) => view.fit()));
  connectedCallback(): void {
    this.resize.observe(this);
  }
  disconnectedCallback(): void {
    this.resize.disconnect();
  }
  views(): WxMovableView[] {
    return [...this.children].filter(
      (child): child is WxMovableView => child instanceof WxMovableView,
    );
  }
}

export class WxMovableView extends Builtin {
  private x = 0;
  private y = 0;
  private scale = 1;
  /** Whether the view has its first position, which it takes without moving there. */
  private placed = false;
  private readonly applied = new Applied();
  private stop = () => {};
  private readonly resize = new ResizeObserver(() => this.fit());
  /** The view places itself through its own style sheet, so the `style` the view layer writes does not move it. */
  private readonly placement: HTMLStyleElement;
  constructor() {
    super();
    const root = this.shadow(
      `<style>:host { display: block; position: absolute; top: 0; left: 0; width: 10px; height: 10px; transform-origin: center; touch-action: none; }</style><style></style><slot></slot>`,
    );
    this.placement = root.querySelectorAll("style")[1]!;
    let base = { x: 0, y: 0 };
    let axis: "h" | "v" | undefined;
    trackDrag(this, {
      start: () => !this.flag("disabled") && this.direction() !== "none",
      // A view that moves along one axis leaves drags along the other to its ancestors
      accept: (dx, dy) => {
        const direction = this.direction();
        if (direction === "horizontal") return Math.abs(dx) >= Math.abs(dy);
        if (direction === "vertical") return Math.abs(dy) >= Math.abs(dx);
        return true;
      },
      move: (dx, dy) => {
        if (!axis) {
          this.stop();
          base = { x: this.x, y: this.y };
          axis = Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
          emit(this, axis === "h" ? "htouchmove" : "vtouchmove");
        }
        const direction = this.direction();
        let x = direction === "vertical" ? base.x : base.x + dx;
        let y = direction === "horizontal" ? base.y : base.y + dy;
        const bounds = this.bounds();
        const outside = x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY;
        if (this.flag("out-of-bounds")) {
          // Past the edge the view follows the finger at half the speed
          x = resist(x, bounds.minX, bounds.maxX);
          y = resist(y, bounds.minY, bounds.maxY);
        } else {
          x = clamp(x, bounds.minX, bounds.maxX);
          y = clamp(y, bounds.minY, bounds.maxY);
        }
        this.moveTo(x, y, outside && this.flag("out-of-bounds") ? "touch-out-of-bounds" : "touch");
      },
      end: (_, __, velocity) => {
        axis = undefined;
        const bounds = this.bounds();
        const direction = this.direction();
        const vx = direction === "vertical" ? 0 : velocity.x;
        const vy = direction === "horizontal" ? 0 : velocity.y;
        if (this.flag("inertia") && Math.hypot(vx, vy) > 0.05) {
          // The view slides on, slowing down by `friction`, and stops at the edge
          const friction = Math.max(0.1, this.num("friction", 2));
          const glide = 300 / friction;
          const x = clamp(this.x + vx * glide, bounds.minX, bounds.maxX);
          const y = clamp(this.y + vy * glide, bounds.minY, bounds.maxY);
          this.glideTo(x, y, "friction", Math.min(1200, 400 + glide));
        } else {
          this.settle();
        }
      },
    });
    this.addEventListener(
      "wheel",
      (event) => {
        if (!this.flag("scale") || this.flag("disabled")) return;
        event.preventDefault();
        this.zoom(this.scale * Math.exp(-event.deltaY / 300), true);
      },
      { passive: false },
    );
  }
  connectedCallback(): void {
    this.resize.observe(this);
    queueMicrotask(() => this.fit());
  }
  disconnectedCallback(): void {
    this.resize.disconnect();
    this.stop();
  }
  private direction(): string {
    return this.str("direction", "none");
  }

  protected override update(): void {
    const xChanged = this.applied.changed("x", this.props.x);
    const yChanged = this.applied.changed("y", this.props.y);
    if (this.applied.changed("scale-value", this.props["scale-value"])) {
      this.zoom(this.num("scale-value", 1), false);
    }
    if (!xChanged && !yChanged) return;
    const x = xChanged ? lengthOf(this.props.x, this.x) : this.x;
    const y = yChanged ? lengthOf(this.props.y, this.y) : this.y;
    const first = !this.placed;
    this.placed = true;
    // Changing x or y animates, unless `animation` is false; the first position is taken directly
    queueMicrotask(() => {
      const bounds = this.bounds();
      const target = {
        x: clamp(x, bounds.minX, bounds.maxX),
        y: clamp(y, bounds.minY, bounds.maxY),
      };
      if (first) {
        this.stop();
        this.x = target.x;
        this.y = target.y;
        this.place();
      } else if (this.flagOn("animation") && this.isConnected) {
        this.glideTo(target.x, target.y, "", 300);
      } else {
        this.moveTo(target.x, target.y, "");
      }
    });
  }

  /** How far the view can move: within the area, or with the area inside it when the view is larger. */
  private bounds(): { minX: number; maxX: number; minY: number; maxY: number } {
    const area = this.parentElement;
    const width = this.offsetWidth * this.scale;
    const height = this.offsetHeight * this.scale;
    const areaWidth = area?.clientWidth ?? width;
    const areaHeight = area?.clientHeight ?? height;
    // The view scales around its centre, so its box moves by half the growth
    const growX = (width - this.offsetWidth) / 2;
    const growY = (height - this.offsetHeight) / 2;
    const rangeX = areaWidth - width;
    const rangeY = areaHeight - height;
    return {
      minX: Math.min(0, rangeX) + growX,
      maxX: Math.max(0, rangeX) + growX,
      minY: Math.min(0, rangeY) + growY,
      maxY: Math.max(0, rangeY) + growY,
    };
  }

  /** Keeps the view inside the area after a size change. */
  fit(): void {
    const bounds = this.bounds();
    const x = clamp(this.x, bounds.minX, bounds.maxX);
    const y = clamp(this.y, bounds.minY, bounds.maxY);
    if (x !== this.x || y !== this.y) this.moveTo(x, y, "");
    else this.place();
  }

  private settle(): void {
    const bounds = this.bounds();
    const x = clamp(this.x, bounds.minX, bounds.maxX);
    const y = clamp(this.y, bounds.minY, bounds.maxY);
    if (x !== this.x || y !== this.y)
      this.glideTo(x, y, "out-of-bounds", 2000 / Math.max(1, this.num("damping", 20)) + 150);
  }

  private glideTo(x: number, y: number, source: string, duration: number): void {
    this.stop();
    const from = { x: this.x, y: this.y };
    if (from.x === x && from.y === y) return;
    this.stop = animate(duration, (t) =>
      this.moveTo(from.x + (x - from.x) * t, from.y + (y - from.y) * t, source),
    );
  }

  private moveTo(x: number, y: number, source: string): void {
    if (x === this.x && y === this.y) return;
    this.x = x;
    this.y = y;
    this.place();
    emit(this, "change", { x: round(x), y: round(y), source });
  }

  private zoom(scale: number, user: boolean): void {
    const next = clamp(
      scale,
      Math.max(0.1, this.num("scale-min", 0.1)),
      Math.min(10, this.num("scale-max", 10)),
    );
    if (next === this.scale) return;
    this.scale = next;
    this.place();
    if (user || this.flag("scale"))
      emit(this, "scale", { x: round(this.x), y: round(this.y), scale: next });
    this.fit();
  }

  private place(): void {
    this.placement.textContent = `:host { transform: translate(${this.x}px, ${this.y}px) scale(${this.scale}) !important; }`;
  }
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const resist = (value: number, min: number, max: number) =>
  value < min ? min + (value - min) / 2 : value > max ? max + (value - max) / 2 : value;
const round = (value: number) => Math.round(value * 10) / 10;
