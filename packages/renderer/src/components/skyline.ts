/**
 * Components WeChat documents for the Skyline renderer. The simulator renders
 * pages as WebView does, so `<grid-view>` follows its WebView implementation
 * (base library 2.30.4): a grid, or a masonry of columns. The others only work
 * in Skyline; they render their children as plain containers, as a page that
 * also runs in WebView expects, and say so once in the console.
 */
import { Applied, Builtin, lengthOf } from "./base.ts";

/**
 * The masonry layout: each child, in order, goes to the column that ends
 * highest, the leftmost of equal ones. `heights` are the children's heights
 * at the column width; returns each child's column.
 */
export function masonryColumns(heights: number[], count: number, gap: number): number[] {
  const ends = Array.from({ length: Math.max(1, count) }, () => 0);
  return heights.map((height) => {
    let column = 0;
    for (let i = 1; i < ends.length; i++) if (ends[i]! < ends[column]!) column = i;
    // A column's first child starts at the top; later ones after a gap
    ends[column]! += (ends[column]! > 0 ? gap : 0) + height;
    return column;
  });
}

/**
 * The number of columns: `cross-axis-count`, or with `max-cross-axis-extent`
 * as many as keep each column at most that wide.
 */
export function gridColumnCount(width: number, count: number, maxExtent: number, gap: number) {
  if (maxExtent > 0 && width > 0) return Math.max(1, Math.ceil((width + gap) / (maxExtent + gap)));
  return Math.max(1, Math.floor(count) || 2);
}

/** `<grid-view>`: `type="aligned"` lines children up in rows; `type="masonry"` stacks them in columns. */
export class WxGridView extends Builtin {
  private readonly root = this.shadow(
    `<style>
      :host { display: block; }
      .grid { display: grid; box-sizing: border-box; }
      .masonry { display: flex; align-items: flex-start; box-sizing: border-box; }
      .column { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
    </style><div part="container"></div>`,
    { slotAssignment: "manual" },
  );
  private readonly container = this.root.querySelector("div")!;
  private readonly applied = new Applied();
  private queued = false;
  /** Children change size as their images load, which moves the masonry's columns. */
  private readonly resize = new ResizeObserver(() => this.queueLayout());
  private readonly mutations = new MutationObserver(() => this.queueLayout());

  connectedCallback(): void {
    this.mutations.observe(this, { childList: true });
    this.resize.observe(this);
    this.queueLayout();
  }

  disconnectedCallback(): void {
    this.mutations.disconnect();
    this.resize.disconnect();
  }

  protected override update(): void {
    const keys = [
      "type",
      "cross-axis-count",
      "max-cross-axis-extent",
      "main-axis-gap",
      "cross-axis-gap",
      "padding",
    ];
    // Every key is compared, so each remembers its latest value
    const changed = keys.filter((key) => this.applied.changed(key, this.props[key]));
    if (changed.length > 0) this.queueLayout();
  }

  private queueLayout(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.isConnected) this.layout();
    });
  }

  private layout(): void {
    const masonry = this.str("type", "aligned") === "masonry";
    const mainGap = lengthOf(this.props["main-axis-gap"]);
    const crossGap = lengthOf(this.props["cross-axis-gap"]);
    const padding = Array.isArray(this.props.padding) ? this.props.padding : [];
    const [top = 0, right = 0, bottom = 0, left = 0] = [0, 1, 2, 3].map((i) =>
      lengthOf(padding[i]),
    );
    this.container.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
    const width = this.clientWidth - left - right;
    const count = gridColumnCount(
      width,
      this.num("cross-axis-count", 2),
      this.num("max-cross-axis-extent", 0),
      crossGap,
    );
    const children = [...this.children] as HTMLElement[];
    for (const child of children) this.resize.observe(child);
    if (!masonry) {
      this.container.className = "grid";
      this.container.style.gridTemplateColumns = `repeat(${count}, minmax(0, 1fr))`;
      this.container.style.gap = `${mainGap}px ${crossGap}px`;
      const slot = this.slotsFor(1)[0]!;
      slot.assign(...children);
      return;
    }
    this.container.className = "masonry";
    this.container.style.gap = `${crossGap}px`;
    this.container.style.gridTemplateColumns = "";
    const slots = this.slotsFor(count);
    for (const column of this.container.children) {
      (column as HTMLElement).style.gap = `${mainGap}px`;
    }
    // Every column is as wide, so the children's heights in the first are their heights anywhere
    slots[0]!.assign(...children);
    for (const slot of slots.slice(1)) slot.assign();
    const heights = children.map((child) => child.getBoundingClientRect().height);
    const columns = masonryColumns(heights, count, mainGap);
    slots.forEach((slot, index) =>
      slot.assign(...children.filter((_, child) => columns[child] === index)),
    );
  }

  /** The container's slots: one in a grid, or one per column, each in a column of its own. */
  private slotsFor(count: number): HTMLSlotElement[] {
    const masonry = this.container.classList.contains("masonry");
    const wanted = masonry ? count : 1;
    const current = [...this.container.children];
    const shaped = current.every((el) =>
      masonry ? el.classList.contains("column") : el.localName === "slot",
    );
    if (current.length !== wanted || !shaped) {
      this.container.replaceChildren(
        ...Array.from({ length: wanted }, () => {
          const slot = document.createElement("slot");
          if (!masonry) return slot;
          const column = document.createElement("div");
          column.className = "column";
          column.append(slot);
          return column;
        }),
      );
    }
    return [...this.container.querySelectorAll("slot")];
  }
}

const warned = new Set<string>();
/** A Skyline-only component: its children render as they would in a container. */
export class SkylineOnly extends Builtin {
  connectedCallback(): void {
    const tag = this.localName.slice(3);
    if (warned.has(tag)) return;
    warned.add(tag);
    console.info(
      `[omr] <${tag}> works only in the Skyline renderer; the simulator renders pages as WebView does, so its children show as in a plain container`,
    );
  }
}

/** Components that work only in Skyline. */
export const SKYLINE_ONLY_TAGS = [
  "list-view",
  "sticky-header",
  "sticky-section",
  "draggable-sheet",
  "nested-scroll-header",
  "nested-scroll-body",
  "list-builder",
  "grid-builder",
  "open-container",
  "snapshot",
  "span",
  "large-image",
  "open-data-item",
  "open-data-list",
  "tap-gesture-handler",
  "double-tap-gesture-handler",
  "pan-gesture-handler",
  "scale-gesture-handler",
  "long-press-gesture-handler",
  "force-press-gesture-handler",
  "horizontal-drag-gesture-handler",
  "vertical-drag-gesture-handler",
];
