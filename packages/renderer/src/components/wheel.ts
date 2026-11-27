/** The scrolling wheel of `<picker-view-column>` and of the picker sheet: drag, wheel and tap, snapping to an item. */
import { animate, trackDrag } from "./base.ts";

export interface WheelEvents {
  /** The user starts moving the wheel. */
  pickStart?(): void;
  /** The finger is lifted, with the item the wheel will stop at. */
  release?(index: number): void;
  /** The wheel stopped at an item after the user moved it. */
  settle(index: number): void;
  /** The wheel stopped. */
  pickEnd?(): void;
}

export class Wheel {
  index = 0;
  private itemHeight = 34;
  private count = 0;
  private padding = 0;
  private offset = 0;
  private picking = false;
  private stop = () => {};
  /** A finger is moving the wheel; `picking` also covers the glide that follows. */
  private dragging = false;
  private wheelDelta = 0;
  /** The index the wheel is moving to, or is at when it stands still. */
  target = 0;
  /** An index set while the user moved the wheel, applied once it stops. */
  private requested?: number;

  private readonly content: HTMLElement;
  private readonly events: WheelEvents;

  constructor(surface: HTMLElement, content: HTMLElement, events: WheelEvents) {
    this.content = content;
    this.events = events;
    let base = 0;
    trackDrag(surface, {
      start: () => this.count > 0,
      accept: (dx, dy) => Math.abs(dy) >= Math.abs(dx),
      move: (_, dy) => {
        if (!this.dragging) {
          // A drag that starts while the wheel still glides takes over from where it shows
          this.stop();
          base = this.offset;
          this.dragging = true;
          if (!this.picking) this.begin();
        }
        this.place(this.rubber(base + dy));
      },
      end: (_, __, velocity) => {
        this.dragging = false;
        // Keep gliding for a moment, as a flick does
        const projected = this.offset + velocity.y * 160;
        this.finish(this.indexAt(projected));
      },
    });
    surface.addEventListener(
      "wheel",
      (event) => {
        if (this.count === 0) return;
        event.preventDefault();
        this.wheelDelta += event.deltaY;
        if (Math.abs(this.wheelDelta) < 20) return;
        const step = Math.sign(this.wheelDelta);
        this.wheelDelta = 0;
        if (!this.picking) this.begin();
        this.finish(this.clamp(this.target + step));
      },
      { passive: false },
    );
    surface.addEventListener("click", (event) => {
      if (this.count === 0) return;
      const top = content.getBoundingClientRect().top;
      const index = Math.floor((event.clientY - top - this.padding) / this.itemHeight);
      if (index === this.index || index < 0 || index >= this.count) return;
      this.begin();
      this.finish(index);
    });
  }

  /** Measures again: the height of one item, how many there are and the height of the wheel. */
  layout(itemHeight: number, count: number, height: number): void {
    itemHeight = itemHeight > 0 ? itemHeight : 34;
    const padding = Math.max(0, (height - itemHeight) / 2);
    const changed =
      itemHeight !== this.itemHeight || count !== this.count || padding !== this.padding;
    this.itemHeight = itemHeight;
    this.count = count;
    this.padding = padding;
    this.content.style.paddingTop = `${this.padding}px`;
    this.content.style.paddingBottom = `${this.padding}px`;
    if (!this.picking) this.setIndex(this.index);
    else if (changed && !this.dragging && count === 0) {
      // With no rows left the glide ends at none of them: no row to settle at
      this.stop();
      this.picking = false;
      this.requested = undefined;
      this.setIndex(0);
      this.events.pickEnd?.();
    }
    // A glide toward a row that moved or no longer exists heads for the row it can stop at now
    else if (changed && !this.dragging) this.finish(this.clamp(this.target));
  }

  /** Moves to an item without events, as setting `value` does; while the user moves the wheel, once it stops. */
  setIndex(index: number, animated = false): void {
    if (this.picking) {
      this.requested = index;
      return;
    }
    this.requested = undefined;
    this.stop();
    this.index = this.target = this.clamp(index);
    const to = this.offsetOf(this.index);
    if (!animated) {
      this.place(to);
      return;
    }
    const from = this.offset;
    this.stop = animate(200, (t) => this.place(from + (to - from) * t));
  }

  private begin(): void {
    this.picking = true;
    this.events.pickStart?.();
  }

  private finish(index: number): void {
    this.stop();
    this.target = index;
    this.events.release?.(index);
    const from = this.offset;
    const to = this.offsetOf(index);
    const duration = Math.min(400, 150 + Math.abs(to - from));
    this.stop = animate(duration, (t) => {
      this.place(from + (to - from) * t);
      if (t < 1) return;
      this.picking = false;
      this.index = index;
      this.events.settle(index);
      this.events.pickEnd?.();
      if (this.requested !== undefined && !this.picking) this.setIndex(this.requested);
    });
  }

  private clamp(index: number): number {
    return Math.max(0, Math.min(this.count - 1, Math.round(index) || 0));
  }
  private offsetOf(index: number): number {
    return -index * this.itemHeight;
  }
  private indexAt(offset: number): number {
    return this.clamp(-offset / this.itemHeight);
  }
  /** Past the first or last item the wheel follows the finger at a third of the speed. */
  private rubber(offset: number): number {
    const min = this.offsetOf(this.count - 1);
    if (offset > 0) return offset / 3;
    if (offset < min) return min + (offset - min) / 3;
    return offset;
  }
  private place(offset: number): void {
    this.offset = offset;
    this.content.style.transform = `translateY(${offset}px)`;
  }
}
