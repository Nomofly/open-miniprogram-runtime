/** `<text>`: inline text that keeps line breaks, with `decode` and `space`. */
import { Builtin } from "./base.ts";
import { applySpace, decodeText } from "./format.ts";

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
