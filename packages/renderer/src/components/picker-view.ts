/** `<picker-view>` and `<picker-view-column>`: wheels embedded in the page. */
import { toText } from "../expression.ts";
import { Applied, Builtin, convertStyle, emit } from "./base.ts";
import { Wheel } from "./wheel.ts";

const DEFAULT_ITEM_HEIGHT = 34;

export class WxPickerViewColumn extends Builtin {
  readonly wheel: Wheel;
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: block; position: relative; flex: 1; height: 100%; overflow: hidden; touch-action: none; }
      .content { will-change: transform; }
      /* Each item is as tall as the picker view's indicator, as WeChat makes it */
      ::slotted(*) { height: var(--omr-item-height) !important; box-sizing: border-box; overflow: hidden; }
    </style><div class="content"><slot></slot></div>`);
    this.wheel = new Wheel(this, root.querySelector(".content")!, {
      pickStart: () => this.pickerView()?.picking("pickstart"),
      release: (index) => this.pickerView()?.columnMoved(this, index, true),
      settle: (index) => this.pickerView()?.columnMoved(this, index, false),
      pickEnd: () => this.pickerView()?.picking("pickend"),
    });
    new MutationObserver(() => this.pickerView()?.schedule()).observe(this, { childList: true });
  }
  private pickerView(): WxPickerView | undefined {
    return this.parentElement instanceof WxPickerView ? this.parentElement : undefined;
  }
  measure(itemHeight: number): void {
    this.wheel.layout(itemHeight, this.childElementCount, this.clientHeight);
  }
}

/**
 * The mask and the indicator are light DOM nodes of the picker view, after its
 * columns, so `mask-class` and `indicator-class` can use the page's styles.
 */
export class WxPickerView extends Builtin {
  private readonly mask = document.createElement("div");
  private readonly indicator = document.createElement("div");
  private readonly applied = new Applied();
  private values: number[] = [];
  private scheduled = false;
  private pendingApply = false;
  /** The value the columns show, as last reported. */
  private current: number[] = [];
  private readonly resize = new ResizeObserver(() => this.schedule());
  /** Gives the columns the item height, which they inherit. */
  private readonly sizing: HTMLStyleElement;
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: block; position: relative; overflow: hidden; }
      .columns { display: flex; height: 100%; }
    </style><style></style><div class="columns"><slot></slot></div><slot name="omr-overlay"></slot>`);
    this.sizing = root.querySelectorAll("style")[1]!;
    this.mask.slot = this.indicator.slot = "omr-overlay";
  }
  connectedCallback(): void {
    if (!this.mask.isConnected) this.append(this.mask, this.indicator);
    this.resize.observe(this);
  }
  disconnectedCallback(): void {
    this.resize.disconnect();
  }
  private columns(): WxPickerViewColumn[] {
    return [...this.children].filter(
      (child): child is WxPickerViewColumn => child instanceof WxPickerViewColumn,
    );
  }
  protected override update(): void {
    if (this.applied.changed("value", this.props.value)) {
      const value = this.props.value;
      this.values = Array.isArray(value) ? value.map((part) => Number(part) || 0) : [];
      this.schedule(true);
    } else {
      this.schedule();
    }
    this.mask.className = `omr-picker-view-mask ${this.str("mask-class")}`.trim();
    this.mask.setAttribute("style", convertStyle(this.str("mask-style")));
    this.indicator.className = `omr-picker-view-indicator ${this.str("indicator-class")}`.trim();
    this.indicator.setAttribute("style", convertStyle(this.str("indicator-style")));
  }
  /** Lays the columns out once the view has patched them; `apply` moves them to `value`. */
  schedule(apply = false): void {
    this.pendingApply ||= apply;
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.layout(this.pendingApply);
      this.pendingApply = false;
    });
  }
  private layout(apply: boolean): void {
    const columns = this.columns();
    // `indicator-style` and `indicator-class` set the height of every item
    const itemHeight = this.indicator.offsetHeight || DEFAULT_ITEM_HEIGHT;
    this.sizing.textContent = `:host { --omr-item-height: ${itemHeight}px; }`;
    const height = this.clientHeight;
    this.mask.style.setProperty("--omr-mask-size", `${Math.max(0, (height - itemHeight) / 2)}px`);
    columns.forEach((column, index) => {
      column.measure(itemHeight);
      if (apply) column.wheel.setIndex(this.values[index] ?? 0);
    });
    this.current = columns.map((column) => column.wheel.index);
  }
  picking(name: "pickstart" | "pickend"): void {
    emit(this, name);
  }
  columnMoved(column: WxPickerViewColumn, index: number, released: boolean): void {
    // Without immediate-change, change waits until the wheel stops
    if (released !== this.flag("immediate-change")) return;
    const columns = this.columns();
    // A released column reports where the others are heading, so the last change matches where all stop
    const value = columns.map((other) =>
      other === column ? index : released ? other.wheel.target : other.wheel.index,
    );
    if (toText(value) === toText(this.current)) return;
    this.current = value;
    emit(this, "change", { value });
  }
}
