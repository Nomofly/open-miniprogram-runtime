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
  /** The height of one item: the first item's, as WeChat measures it. */
  itemHeight(): number {
    return (this.firstElementChild as HTMLElement | null)?.offsetHeight || DEFAULT_ITEM_HEIGHT;
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
  constructor() {
    super();
    this.shadow(`<style>
      :host { display: block; position: relative; overflow: hidden; }
      .columns { display: flex; height: 100%; }
    </style><div class="columns"><slot></slot></div><slot name="omr-overlay"></slot>`);
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
    const itemHeight = columns[0]?.itemHeight() ?? DEFAULT_ITEM_HEIGHT;
    this.indicator.style.setProperty("--omr-item-height", `${itemHeight}px`);
    const height = this.clientHeight;
    const indicatorHeight = this.indicator.offsetHeight || itemHeight;
    this.mask.style.setProperty(
      "--omr-mask-size",
      `${Math.max(0, (height - indicatorHeight) / 2)}px`,
    );
    columns.forEach((column, index) => {
      column.measure(column.itemHeight());
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
    const value = columns.map((other) => (other === column ? index : other.wheel.index));
    if (toText(value) === toText(this.current)) return;
    this.current = value;
    emit(this, "change", { value });
  }
}
