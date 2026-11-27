/**
 * WeChat Shop components: `<store-product>`, `<store-home>`, `<store-coupon>`
 * and `<store-gift>`. They need base libraries newer than the 3.5.0 the
 * simulator reports, and WeChat fills them with the shop's data, which the
 * simulator does not have: they draw a card with the ids they were given, and
 * a tap is the jump to the shop (`entersuccess`), or fails without the ids.
 */
import { toText } from "../expression.ts";
import { Builtin, emit } from "./base.ts";

const warned = new Set<string>();
/** Says once per tag that the component is newer than the reported base library. */
export function warnNewer(tag: string, version: string): void {
  if (warned.has(tag)) return;
  warned.add(tag);
  console.info(
    `[omr] <${tag}> needs base library ${version}; the simulator reports 3.5.0 but draws it, without the data WeChat would load`,
  );
}

const STORE_LOGO = `<span class="logo"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M3 5h10l-1 8H4z M6 5a2 2 0 0 1 4 0" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>微信小店</span>`;

const CARD_STYLE = `
  :host { display: block; font: 14px/1.4 -apple-system, "PingFang SC", sans-serif; color: rgba(0, 0, 0, 0.9); cursor: pointer; }
  .card { position: relative; box-sizing: border-box; padding: 12px; border-radius: 8px; background: #fff; overflow: hidden; }
  .muted { color: rgba(0, 0, 0, 0.5); font-size: 12px; }
  .logo { display: inline-flex; align-items: center; gap: 3px; color: #fa9d3b; font-size: 11px; }
  .button { flex: none; padding: 4px 14px; border-radius: 4px; background: #fa5151; color: #fff; font-size: 13px; }
  [hidden] { display: none !important; }
`;

/** What the shop cards share: the version note, and the tap that jumps to the shop or fails without its ids. */
abstract class StoreCard extends Builtin {
  protected abstract readonly version: string;
  /** The attributes WeChat requires; without one, a tap fails. */
  protected abstract readonly required: string[];
  constructor() {
    super();
    this.addEventListener("click", () => this.enter());
  }
  connectedCallback(): void {
    warnNewer(this.localName.slice(3), this.version);
  }
  protected missing(): string | undefined {
    return this.required.find((name) => !this.str(name));
  }
  protected enter(): void {
    const missing = this.missing();
    if (missing) emit(this, "entererror", { code: -1, message: `${missing} is required` });
    else emit(this, "entersuccess", { code: 0, message: "ok" });
  }
}

/**
 * A product of a WeChat Shop. With `custom-content` the page's own content
 * shows, with the shop logo where `logo-position` puts it.
 */
export class WxStoreProduct extends StoreCard {
  protected readonly version = "3.5.5";
  protected readonly required = ["appid", "product-id"];
  private readonly card: HTMLElement;
  private readonly custom: HTMLElement;
  private readonly idLine: HTMLElement;
  constructor() {
    super();
    const root = this.shadow(`<style>${CARD_STYLE}
      .product { display: flex; gap: 10px; }
      .image { flex: none; width: 84px; height: 84px; border-radius: 4px; background: linear-gradient(135deg, #f3e7d9, #e6d3bd); }
      .info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .title { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .row { margin-top: auto; display: flex; align-items: center; justify-content: space-between; }
      .price { color: #fa5151; font-weight: 600; }
      .custom { position: relative; }
      .custom .logo { position: absolute; padding: 2px 6px; border-radius: 4px; background: rgba(255, 255, 255, 0.9); }
      .top-left { left: 6px; top: 6px; } .top-right { right: 6px; top: 6px; }
      .bottom-left { left: 6px; bottom: 6px; } .bottom-right { right: 6px; bottom: 6px; }
    </style><div class="card product"><div class="image"></div><div class="info"><div class="title">微信小店商品</div><div class="muted id"></div><div class="row"><span class="price">¥ --</span><span class="button">购买</span></div>${STORE_LOGO}</div></div><div class="custom" hidden><slot></slot>${STORE_LOGO}</div>`);
    this.card = root.querySelector(".card")!;
    this.custom = root.querySelector(".custom")!;
    this.idLine = root.querySelector(".id")!;
  }
  protected override update(): void {
    const custom = this.flag("custom-content");
    this.card.hidden = custom;
    this.custom.hidden = !custom;
    const logo = this.custom.querySelector(".logo")!;
    logo.className = `logo ${this.str("logo-position", "bottom-left")}`;
    this.idLine.textContent = `商品 ID：${this.str("product-id") || "未设置"}`;
    applyStyle(this.card, this.props["custom-style"], "card");
  }
}

/** The home page of a WeChat Shop. */
export class WxStoreHome extends StoreCard {
  protected readonly version = "3.5.5";
  protected readonly required = ["appid"];
  private readonly idLine: HTMLElement;
  constructor() {
    super();
    const root = this.shadow(`<style>${CARD_STYLE}
      .home { display: flex; align-items: center; gap: 12px; }
      .avatar { flex: none; width: 44px; height: 44px; border-radius: 50%; background: #fa9d3b; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 18px; }
      .text { flex: 1; min-width: 0; }
      .enter { flex: none; color: rgba(0, 0, 0, 0.5); }
    </style><div class="card home"><div class="avatar">店</div><div class="text"><div>微信小店</div><div class="muted id"></div></div><span class="enter">进店 ›</span></div>`);
    this.idLine = root.querySelector(".id")!;
  }
  protected override update(): void {
    this.idLine.textContent = `小店 appid：${this.str("appid") || "未设置"}`;
  }
}

/**
 * A coupon of a WeChat Shop. `custom-style` styles its parts by the names
 * WeChat documents, with the properties WeChat allows for each.
 */
export class WxStoreCoupon extends StoreCard {
  protected readonly version = "3.8.3";
  protected readonly required = ["appid", "coupon-id"];
  private readonly card: HTMLElement;
  constructor() {
    super();
    const root = this.shadow(`<style>${CARD_STYLE}
      .card { background: #fff7f5; padding: 0; }
      .main { display: flex; align-items: center; gap: 10px; padding: 12px; }
      .left { flex: none; min-width: 76px; }
      .discount-fee { color: #fa5151; font-size: 22px; font-weight: 600; }
      .coupon-type { color: #fa5151; font-size: 12px; }
      .right { flex: 1; min-width: 0; }
      .condition-text, .valid-time { color: rgba(0, 0, 0, 0.6); font-size: 12px; }
      .coupon-button { border-radius: 14px; }
      .footer { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-top: 1px dashed transparent; }
      .coupon-footer-line { height: 1px; background: rgba(0, 0, 0, 0.08); }
    </style><div class="card"><div class="main"><div class="left"><div class="discount-fee">¥ --</div><div class="coupon-type">店铺券</div></div><div class="right"><div class="condition-text">优惠券</div><div class="valid-time"></div></div><span class="button coupon-button">领取</span></div><div class="coupon-footer-line"></div><div class="footer">${STORE_LOGO}<span class="muted coupon-shop-nickname">微信小店</span></div></div>`);
    this.card = root.querySelector(".card")!;
  }
  protected override update(): void {
    const id = this.str("coupon-id");
    this.card.querySelector(".valid-time")!.textContent = `券 ID：${id || "未设置"}`;
    const style = this.props["custom-style"];
    applyStyle(this.card, style, "card");
    for (const part of [
      "discount-fee",
      "coupon-type",
      "condition-text",
      "valid-time",
      "coupon-button",
      "coupon-footer-line",
      "coupon-shop-nickname",
    ]) {
      const el = this.card.querySelector<HTMLElement>(`.${part}`);
      if (el) applyStyle(el, style, part);
    }
  }
}

/**
 * A WeChat gift to open (`present-order-id` for `open-id`): a gift card unless
 * `show-gift-card` is false; a tap opens it (`success`), or fails with -1001
 * without its ids.
 */
export class WxStoreGift extends StoreCard {
  protected readonly version = "3.8.10";
  protected readonly required = ["present-order-id", "open-id"];
  private readonly card: HTMLElement;
  constructor() {
    super();
    const root = this.shadow(`<style>${CARD_STYLE}
      .card { display: flex; align-items: center; gap: 12px; min-width: 312px; max-width: 350px; background: linear-gradient(135deg, #fff1e6, #ffe0cc); }
      .gift { flex: none; width: 48px; height: 48px; border-radius: 8px; background: #fa5151; position: relative; }
      .gift::before { content: ""; position: absolute; left: 21px; top: 0; bottom: 0; width: 6px; background: #ffd48d; }
      .gift::after { content: ""; position: absolute; top: 21px; left: 0; right: 0; height: 6px; background: #ffd48d; }
      .text { flex: 1; }
    </style><div class="card"><div class="gift"></div><div class="text"><div>你收到一份微信礼物</div><div class="muted">点击打开礼物</div></div><span class="button">打开</span></div><slot></slot>`);
    this.card = root.querySelector(".card")!;
  }
  protected override update(): void {
    this.card.hidden = !this.flagOn("show-gift-card");
  }
  protected override enter(): void {
    const missing = this.missing();
    if (missing) emit(this, "error", { code: -1001, message: "打开礼物失败[参数错误]" });
    else emit(this, "success", { code: 0, message: "ok" });
  }
}

/** Applies the properties `custom-style` gives a part, such as `{ card: { "background-color": "#fafafa" } }`. */
function applyStyle(el: HTMLElement, style: unknown, part: string): void {
  const rules = (style as Record<string, unknown> | undefined)?.[part];
  if (!rules || typeof rules !== "object") return;
  for (const [name, value] of Object.entries(rules)) el.style.setProperty(name, toText(value));
}
