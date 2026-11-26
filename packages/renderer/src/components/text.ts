/** `<text>`: inline text that keeps line breaks, with `decode` and `space`; `<selection>`, which reports what is selected in it. */
import { Builtin, emit } from "./base.ts";
import { applySpace, decodeText } from "./format.ts";
import { warnNewer } from "./store-cards.ts";

/**
 * The view writes the template's text into the text nodes; this element
 * rewrites its own text nodes when `decode` or `space` asks for it, and
 * remembers what it wrote, so text the view writes later is transformed again.
 */
export class WxText extends Builtin {
  private readonly shown = new WeakMap<Text, { raw: string; shown: string }>();
  private readonly observer = new MutationObserver(() => this.transform());
  connectedCallback(): void {
    this.observer.observe(this, { childList: true, characterData: true, subtree: true });
    this.transform();
  }
  disconnectedCallback(): void {
    this.observer.disconnect();
  }
  protected override update(): void {
    this.transform();
  }
  private transform(): void {
    const decode = this.flag("decode");
    const space = this.str("space");
    for (const node of this.childNodes) {
      if (!(node instanceof Text)) continue;
      const known = this.shown.get(node);
      const raw = known && known.shown === node.data ? known.raw : node.data;
      const text = applySpace(decode ? decodeText(raw) : raw, space);
      if (text !== node.data) node.data = text;
      this.shown.set(node, { raw, shown: text });
    }
    this.observer.takeRecords();
  }
}

/** The `<text>` and `<rich-text>` whose text can be selected, which `<selection>` counts. */
const UNITS = "wx-text[user-select], wx-text[selectable], wx-rich-text[user-select]";

/**
 * `<selection>`: reports the selection in the selectable `<text>` and
 * `<rich-text>` inside it as `selectionchange`, and lets SelectionContext set
 * or clear it. Node ids and offsets name the unit a boundary is in and the
 * characters before it there; a boundary outside the component has neither.
 * `disable-context-menu` hides the browser's menu, as it hides WeChat's
 * copy buttons.
 */
export class WxSelection extends Builtin {
  private reported = "";
  private readonly onChange = () => this.report();
  constructor() {
    super();
    this.addEventListener("contextmenu", (event) => {
      if (this.flag("disable-context-menu")) event.preventDefault();
    });
  }
  connectedCallback(): void {
    warnNewer("selection", "3.6.4");
    document.addEventListener("selectionchange", this.onChange);
  }
  disconnectedCallback(): void {
    document.removeEventListener("selectionchange", this.onChange);
  }
  private units(): Element[] {
    return [...this.querySelectorAll(UNITS)];
  }
  /** The characters of a unit before a boundary in it. */
  private offsetIn(unit: Element, node: Node, offset: number): number {
    const range = document.createRange();
    range.setStart(unit, 0);
    range.setEnd(node, offset);
    return range.toString().length;
  }
  /** The id and offset of a boundary in a unit of this component; empty outside them. */
  private boundary(node: Node, offset: number): { id: string; offset?: number } {
    const el = node instanceof Element ? node : node.parentElement;
    const unit = el?.closest(UNITS);
    if (!unit || !this.contains(unit)) return { id: "" };
    return { id: unit.id, offset: this.offsetIn(unit, node, offset) };
  }
  private report(): void {
    const selection = document.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
    const inside = Boolean(range?.intersectsNode(this));
    // A selection elsewhere is reported once, as the end of this one
    if (!inside && (!this.reported || this.reported === "collapsed")) return;
    let detail: Record<string, unknown>;
    if (!range || !inside || range.collapsed) {
      detail = { isCollapsed: true, selectedString: "", firstNodeId: "", lastNodeId: "" };
    } else {
      // The part inside the component
      const own = document.createRange();
      own.selectNodeContents(this);
      if (range.compareBoundaryPoints(Range.START_TO_START, own) > 0) {
        own.setStart(range.startContainer, range.startOffset);
      }
      if (range.compareBoundaryPoints(Range.END_TO_END, own) < 0) {
        own.setEnd(range.endContainer, range.endOffset);
      }
      const first = this.boundary(range.startContainer, range.startOffset);
      const last = this.boundary(range.endContainer, range.endOffset);
      const rect = own.getClientRects()[0] ?? own.getBoundingClientRect();
      detail = {
        isCollapsed: false,
        selectedString: own.toString(),
        firstNodeId: first.id,
        firstOffset: first.offset,
        lastNodeId: last.id,
        lastOffset: last.offset,
        firstRangeRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      };
    }
    const key = detail.isCollapsed ? "collapsed" : JSON.stringify(detail);
    if (key === this.reported) return;
    this.reported = key;
    emit(this, "selectionchange", detail);
  }
  /** The text node and offset at a character of the units' text, joined in order. */
  private position(units: Element[], index: number): [Node, number] {
    let left = Math.max(0, index);
    let last: [Node, number] = [this, 0];
    for (const unit of units) {
      const walker = document.createTreeWalker(unit, NodeFilter.SHOW_TEXT);
      for (
        let node = walker.nextNode() as Text | null;
        node;
        node = walker.nextNode() as Text | null
      ) {
        if (left <= node.length) return [node, left];
        left -= node.length;
        last = [node, node.length];
      }
    }
    return last;
  }
  omrCall(method: string, args: unknown[]): void {
    const selection = document.getSelection();
    if (!selection) return;
    switch (method) {
      case "selectRange": {
        const units = this.units();
        const [start, end] = [Number(args[0]) || 0, Number(args[1]) || 0];
        selection.setBaseAndExtent(...this.position(units, start), ...this.position(units, end));
        return;
      }
      case "setBaseAndExtent": {
        const find = (id: unknown) => {
          const unit = this.units().find((el) => el.id === String(id));
          if (!unit) throw new Error(`no selectable <text> or <rich-text> with id "${String(id)}"`);
          return unit;
        };
        const anchor = this.position([find(args[0])], Number(args[1]) || 0);
        const focus = this.position([find(args[2])], Number(args[3]) || 0);
        selection.setBaseAndExtent(...anchor, ...focus);
        return;
      }
      case "removeSelection":
        if (selection.rangeCount && selection.getRangeAt(0).intersectsNode(this)) {
          selection.removeAllRanges();
        }
        return;
      default:
        throw new Error(`unknown method ${method}`);
    }
  }
}
