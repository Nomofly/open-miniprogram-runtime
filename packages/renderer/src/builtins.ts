/**
 * Built-in components as custom elements named `wx-<tag>`. Their look follows
 * what WeChat shows; the styles and drawings here are written for this project.
 *
 * Components raise WeChat events by dispatching an `omr-event` DOM event on
 * themselves, which the view turns into a logic-layer event. The view calls
 * `omrUpdate` with the evaluated attributes after every render, and
 * `omrActivate` when the user taps a control. Larger components live in
 * `components/`.
 */
import { CANVAS_DEFINITIONS } from "./canvas.ts";
import { toText } from "./expression.ts";
import { WxAd, WxAdCustom } from "./components/ad.ts";
import { Applied, BRAND_GREEN, Builtin, emit, lengthOf } from "./components/base.ts";
import {
  WxMatchMedia,
  WxPageContainer,
  WxPageMeta,
  WxRootPortal,
} from "./components/containers.ts";
import { SKYLINE_ONLY_TAGS, SkylineOnly, WxGridView } from "./components/skyline.ts";
import { WxEditor } from "./components/editor.ts";
import { WxInput, WxTextarea } from "./components/input.ts";
import { WxLivePlayer, WxLivePusher, WxVoipRoom } from "./components/live.ts";
import { WxMap } from "./components/map.ts";
import { WxAudio, WxImage, WxVideo } from "./components/media.ts";
import {
  WxChannelLive,
  WxChannelVideo,
  WxOfficialAccount,
  WxOfficialAccountPublish,
  WxReward,
} from "./components/open-cards.ts";
import { WxMovableArea, WxMovableView } from "./components/movable.ts";
import { WxPicker } from "./components/picker.ts";
import { WxPickerView, WxPickerViewColumn } from "./components/picker-view.ts";
import { WxScrollView } from "./components/scroll-view.ts";
import {
  WxStoreCoupon,
  WxStoreGift,
  WxStoreHome,
  WxStoreProduct,
} from "./components/store-cards.ts";
import { WxSwiper, WxSwiperItem } from "./components/swiper.ts";
import { WxText } from "./components/text.ts";
import { applySpace } from "./components/format.ts";

export type { BuiltinElement, OmrEventDetail } from "./components/base.ts";

const ICONS: Record<string, { color: string; svg: string }> = {
  success: {
    color: "#09bb07",
    svg: '<circle cx="12" cy="12" r="12" fill="C"/><path d="M6.5 12.5l3.6 3.6 7.4-7.8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  success_no_circle: {
    color: "#09bb07",
    svg: '<path d="M3 12.5l6 6L21 6" fill="none" stroke="C" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  info: {
    color: "#10aeff",
    svg: '<circle cx="12" cy="12" r="12" fill="C"/><rect x="10.8" y="10" width="2.4" height="8" rx="1" fill="#fff"/><circle cx="12" cy="6.8" r="1.4" fill="#fff"/>',
  },
  warn: {
    color: "#f76260",
    svg: '<circle cx="12" cy="12" r="12" fill="C"/><rect x="10.8" y="5.5" width="2.4" height="9" rx="1" fill="#fff"/><circle cx="12" cy="17.6" r="1.4" fill="#fff"/>',
  },
  waiting: {
    color: "#10aeff",
    svg: '<circle cx="12" cy="12" r="12" fill="C"/><path d="M12 6v6.5l4 2.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  cancel: {
    color: "#f43530",
    svg: '<circle cx="12" cy="12" r="12" fill="C"/><path d="M8 8l8 8M16 8l-8 8" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  },
  clear: {
    color: "#b2b2b2",
    svg: '<circle cx="12" cy="12" r="10" fill="C"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>',
  },
  download: {
    color: "#09bb07",
    svg: '<circle cx="12" cy="12" r="12" fill="C"/><path d="M12 6v8.5M8.5 11.5L12 15l3.5-3.5M7.5 18h9" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  search: {
    color: "#b2b2b2",
    svg: '<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="C" stroke-width="2"/><path d="M15.5 15.5L21 21" stroke="C" stroke-width="2" stroke-linecap="round"/>',
  },
};

class WxIcon extends Builtin {
  private readonly root: ShadowRoot;
  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }
  protected override update(): void {
    const icon = ICONS[this.str("type")];
    // px by default; "40rpx" or "20px" since base library 2.4.0
    const size = lengthOf(this.props.size, 23);
    // The colour is set through the DOM, so a template value cannot add markup
    this.root.innerHTML = `<style>:host { display: inline-block; font-size: 0; line-height: 0; vertical-align: middle; } svg { display: block; }</style><svg viewBox="0 0 24 24" width="${size}" height="${size}">${icon?.svg.replaceAll('"C"', '"currentColor"') ?? ""}</svg>`;
    this.root.querySelector("svg")!.style.color = this.str("color") || icon?.color || "#000";
  }
}

class WxSwitch extends Builtin {
  private checked = false;
  private appliedChecked: unknown = Symbol("unset");
  private readonly root: ShadowRoot;
  constructor() {
    super();
    this.root = this.shadow(`<style>
      :host { display: inline-block; vertical-align: middle; }
      :host([disabled]) { opacity: 0.7; }
      .switch { position: relative; display: block; width: 52px; height: 32px; border: 1px solid #dfdfdf; border-radius: 16px; background: #dfdfdf; box-sizing: border-box; transition: background-color 0.1s, border-color 0.1s; }
      .switch::before { content: ""; position: absolute; top: 0; left: 0; width: 50px; height: 30px; border-radius: 15px; background: #fdfdfd; transition: transform 0.3s; }
      .switch::after { content: ""; position: absolute; top: 0; left: 0; width: 30px; height: 30px; border-radius: 15px; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4); transition: transform 0.3s; }
      .switch.on::before { transform: scale(0); }
      .switch.on::after { transform: translateX(20px); }
      .checkbox { display: inline-block; position: relative; width: 24px; height: 24px; border: 1px solid #d1d1d1; border-radius: 3px; background: #fff; box-sizing: border-box; vertical-align: middle; }
      .checkbox.on::after { content: ""; position: absolute; left: 7px; top: 2px; width: 6px; height: 12px; border: solid currentColor; border-width: 0 2px 2px 0; transform: rotate(45deg); }
    </style><span></span>`);
  }
  protected override update(): void {
    if (this.props.checked !== this.appliedChecked) {
      this.appliedChecked = this.props.checked;
      this.checked = this.flag("checked");
    }
    this.render();
  }
  private render(): void {
    const box = this.root.querySelector("span")!;
    const color = this.str("color") || BRAND_GREEN();
    const isCheckbox = this.str("type") === "checkbox";
    box.className = `${isCheckbox ? "checkbox" : "switch"}${this.checked ? " on" : ""}`;
    box.style.color = color;
    box.style.backgroundColor = !isCheckbox && this.checked ? color : "";
    box.style.borderColor = !isCheckbox && this.checked ? color : "";
  }
  omrActivate(): void {
    if (this.flag("disabled")) return;
    this.checked = !this.checked;
    this.render();
    emit(this, "change", { value: this.checked });
  }
  omrFormValue(): unknown {
    return this.checked;
  }
  omrReset(): void {
    this.checked = false;
    this.render();
  }
}

/** A checkbox or radio; `round` draws a radio. */
class WxCheckbox extends Builtin {
  checked = false;
  private appliedChecked: unknown = Symbol("unset");
  private readonly box: HTMLElement;
  protected readonly round: boolean = false;
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: inline-block; vertical-align: middle; }
      :host([disabled]) { opacity: 0.7; }
      .box { display: inline-block; position: relative; width: 24px; height: 24px; margin-right: 5px; border: 1px solid #d1d1d1; border-radius: 3px; background: #fff; box-sizing: border-box; vertical-align: middle; }
      .box.round { border-radius: 50%; }
      .box.on::after { content: ""; position: absolute; left: 7px; top: 2px; width: 6px; height: 12px; border: solid currentColor; border-width: 0 2px 2px 0; transform: rotate(45deg); }
      .box.round.on { background: currentColor; border-color: currentColor; }
      .box.round.on::after { border-color: #fff; left: 7.5px; top: 3px; width: 5px; height: 10px; }
    </style><span class="box"></span><slot></slot>`);
    this.box = root.querySelector(".box")!;
  }
  protected override update(): void {
    if (this.props.checked !== this.appliedChecked) {
      this.appliedChecked = this.props.checked;
      this.checked = this.flag("checked");
    }
    this.render();
  }
  render(): void {
    this.box.className = `box${this.round ? " round" : ""}${this.checked ? " on" : ""}`;
    this.box.style.color = this.str("color") || BRAND_GREEN();
  }
  omrActivate(): void {
    if (this.flag("disabled")) return;
    this.checked = !this.checked;
    this.render();
    (this.closest("wx-checkbox-group") as WxCheckboxGroup | null)?.changed();
  }
}

class WxRadio extends WxCheckbox {
  protected override readonly round = true;
  override omrActivate(): void {
    if (this.flag("disabled") || this.checked) return;
    const group = this.closest("wx-radio-group") as WxRadioGroup | null;
    for (const radio of group?.radios() ?? []) {
      radio.checked = false;
      radio.render();
    }
    this.checked = true;
    this.render();
    group?.changed();
  }
}

class WxCheckboxGroup extends Builtin {
  changed(): void {
    emit(this, "change", { value: this.omrFormValue() });
  }
  omrFormValue(): unknown {
    return [...this.querySelectorAll<WxCheckbox>("wx-checkbox")]
      .filter((box) => box.checked)
      .map((box) => toText(box.props.value));
  }
  omrReset(): void {
    for (const box of this.querySelectorAll<WxCheckbox>("wx-checkbox")) {
      box.checked = false;
      box.render();
    }
  }
}

class WxRadioGroup extends Builtin {
  radios(): WxRadio[] {
    return [...this.querySelectorAll<WxRadio>("wx-radio")];
  }
  changed(): void {
    emit(this, "change", { value: this.omrFormValue() });
  }
  omrFormValue(): unknown {
    const checked = this.radios().find((radio) => radio.checked);
    return checked ? toText(checked.props.value) : "";
  }
  omrReset(): void {
    for (const radio of this.radios()) {
      radio.checked = false;
      radio.render();
    }
  }
}

/**
 * The first color set among the names of a property: the compiler keeps
 * attribute names as written, so `active-color` and `activeColor` both arrive.
 */
const colorOf = (props: Record<string, unknown>, ...names: string[]) =>
  names.map((name) => toText(props[name] ?? "").trim()).find(Boolean) ?? "";

class WxSlider extends Builtin {
  private readonly range: HTMLInputElement;
  private readonly label: HTMLElement;
  private appliedValue: unknown = Symbol("unset");
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: block; margin: 10px 18px; }
      .row { display: flex; align-items: center; min-height: 28px; }
      input { flex: 1; margin: 0; height: max(28px, var(--block)); background: transparent; -webkit-appearance: none; appearance: none; }
      input:disabled { opacity: 0.6; }
      input::-webkit-slider-runnable-track { height: 2px; border-radius: 1px; background: linear-gradient(to right, var(--active) var(--fill), var(--track) var(--fill)); }
      input::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: var(--block); height: var(--block); margin-top: calc(1px - var(--block) / 2); border: none; border-radius: 50%; background: var(--thumb); box-shadow: 0 0 4px rgba(0, 0, 0, 0.2); }
      input::-moz-range-track { height: 2px; border-radius: 1px; background: var(--track); }
      input::-moz-range-progress { height: 2px; border-radius: 1px; background: var(--active); }
      input::-moz-range-thumb { width: var(--block); height: var(--block); border: none; border-radius: 50%; background: var(--thumb); box-shadow: 0 0 4px rgba(0, 0, 0, 0.2); }
      .value { margin-left: 14px; min-width: 2em; color: #888; font-size: 14px; }
    </style><div class="row"><input type="range"><span class="value"></span></div>`);
    this.range = root.querySelector("input")!;
    this.label = root.querySelector(".value")!;
    // `changing` is for drags: a tap on the track moves the value with `change` alone
    let press: { x: number; moved: boolean } | undefined;
    this.range.addEventListener("pointerdown", (event) => {
      press = { x: event.clientX, moved: false };
    });
    this.range.addEventListener("pointermove", (event) => {
      if (press && Math.abs(event.clientX - press.x) > 2) press.moved = true;
    });
    for (const type of ["pointerup", "pointercancel"]) {
      this.range.addEventListener(type, () => (press = undefined));
    }
    this.range.addEventListener("input", () => {
      this.label.textContent = this.range.value;
      this.fill();
      if (press?.moved) emit(this, "changing", { value: Number(this.range.value) });
    });
    this.range.addEventListener("change", () =>
      emit(this, "change", { value: Number(this.range.value) }),
    );
  }
  protected override update(): void {
    this.range.min = String(this.num("min", 0));
    this.range.max = String(this.num("max", 100));
    this.range.step = String(this.num("step", 1));
    if (this.props.value !== this.appliedValue) {
      this.appliedValue = this.props.value;
      this.range.value = String(this.num("value", 0));
    }
    this.range.disabled = this.flag("disabled");
    const style = this.range.style;
    style.setProperty(
      "--active",
      colorOf(this.props, "active-color", "activeColor", "selected-color") || BRAND_GREEN(),
    );
    style.setProperty(
      "--track",
      colorOf(this.props, "background-color", "backgroundColor", "color") || "#e9e9e9",
    );
    style.setProperty("--thumb", colorOf(this.props, "block-color") || "#ffffff");
    style.setProperty("--block", `${Math.min(28, Math.max(12, this.num("block-size", 28)))}px`);
    this.fill();
    this.label.hidden = !this.flag("show-value");
    this.label.textContent = this.range.value;
  }
  /** Where the selected part of the track ends: under the centre of the thumb. */
  private fill(): void {
    const min = Number(this.range.min);
    const span = Number(this.range.max) - min;
    const ratio = span > 0 ? (Number(this.range.value) - min) / span : 0;
    this.range.style.setProperty(
      "--fill",
      `calc(var(--block) / 2 + (100% - var(--block)) * ${ratio})`,
    );
  }
  omrFormValue(): unknown {
    return Number(this.range.value);
  }
  /** A form's reset moves the slider to its lowest value, as it clears an input. */
  omrReset(): void {
    this.range.value = this.range.min;
    this.label.textContent = this.range.value;
    this.fill();
  }
}

class WxProgress extends Builtin {
  private readonly root: ShadowRoot;
  private readonly applied = new Applied();
  /** The percent the bar shows now, which an animation moves towards `percent`. */
  private shown = 0;
  private frame = 0;
  constructor() {
    super();
    this.root = this.shadow(`<style>
      :host { display: flex; align-items: center; }
      .bar { flex: 1; overflow: hidden; }
      .inner { height: 100%; }
      .info { margin-left: 15px; font-size: 16px; }
    </style><div class="bar"><div class="inner"></div></div><span class="info"></span>`);
  }
  protected override update(): void {
    const percent = Math.min(100, Math.max(0, this.num("percent", 0)));
    const bar = this.root.querySelector<HTMLElement>(".bar")!;
    const inner = this.root.querySelector<HTMLElement>(".inner")!;
    const info = this.root.querySelector<HTMLElement>(".info")!;
    const radius = `${lengthOf(this.props["border-radius"], 0)}px`;
    bar.style.height = `${lengthOf(this.props["stroke-width"], 6)}px`;
    bar.style.background = colorOf(this.props, "background-color", "backgroundColor") || "#ebebeb";
    bar.style.borderRadius = radius;
    inner.style.background =
      colorOf(this.props, "active-color", "activeColor", "color") || BRAND_GREEN();
    inner.style.borderRadius = radius;
    info.hidden = !this.flag("show-info");
    info.style.fontSize = `${lengthOf(this.props["font-size"], 16)}px`;
    // A new percent, or turning `active` on, plays the animation; other changes keep the bar where it is
    const percentChanged = this.applied.changed("percent", percent);
    const activeChanged = this.applied.changed("active", this.flag("active"));
    if (!percentChanged && !activeChanged) return;
    cancelAnimationFrame(this.frame);
    if (!this.flag("active")) {
      this.show(percent);
      return;
    }
    // backwards starts from 0 each time; forwards goes on from where the bar is
    const from = this.str("active-mode", "backwards") === "forwards" ? this.shown : 0;
    const perPercent = Math.max(0, this.num("duration", 30));
    const total = Math.abs(percent - from) * perPercent;
    const start = performance.now();
    const step = (now: number) => {
      const progress = total > 0 ? Math.min(1, (now - start) / total) : 1;
      this.show(from + (percent - from) * progress);
      if (progress < 1) {
        this.frame = requestAnimationFrame(step);
      } else {
        emit(this, "activeend", { curPercent: percent });
      }
    };
    this.show(from);
    this.frame = requestAnimationFrame(step);
  }
  private show(percent: number): void {
    this.shown = percent;
    this.root.querySelector<HTMLElement>(".inner")!.style.width = `${percent}%`;
    this.root.querySelector<HTMLElement>(".info")!.textContent = `${Math.round(percent)}%`;
  }
  disconnectedCallback(): void {
    cancelAnimationFrame(this.frame);
  }
}

/** Whether a URL runs script; browsers drop tabs, newlines and leading control characters before reading the scheme. */
const isScriptUrl = (value: string) =>
  // oxlint-disable-next-line no-control-regex -- control characters are what this removes
  /^javascript:/i.test(value.replace(/[\u0000-\u0020\u007f]/g, ""));

const ALLOWED_RICH_TEXT_TAGS = new Set(
  "a abbr address article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del div dl dt em fieldset font footer h1 h2 h3 h4 h5 h6 header hr i img ins label legend li mark nav ol p pre q rt ruby s section small span strong sub sup table tbody td tfoot th thead tr tt u ul".split(
    " ",
  ),
);

/** How rich-text writes its nodes: class names in the owner's style scope, and spaces as `space` asks. */
interface RichTextOptions {
  transformClass: (value: string) => string;
  space: string;
}

/**
 * rich-text renders in light DOM so its `class` attributes use the styles of
 * the page, or in a custom component only the component's own, as on WeChat.
 */
class WxRichText extends Builtin {
  /** Set by the view before the first update: scopes a class name as the owner's template does. */
  omrTransformClass?: (value: string) => string;
  private applied?: string;
  protected override update(): void {
    const nodes = this.props.nodes;
    const options: RichTextOptions = {
      transformClass: this.omrTransformClass ?? ((value) => value),
      space: this.str("space"),
    };
    const serialized = JSON.stringify([nodes ?? "", options.space]);
    if (serialized === this.applied) return;
    this.applied = serialized;
    if (typeof nodes === "string") {
      const doc = new DOMParser().parseFromString(nodes, "text/html");
      this.replaceChildren(...sanitize([...doc.body.childNodes], options));
    } else if (Array.isArray(nodes)) {
      this.replaceChildren(...nodes.flatMap((node) => buildRichNode(node, options)));
    } else {
      this.replaceChildren();
    }
  }
}

/**
 * Copies a rich-text attribute, without event handlers, script URLs, or the
 * `href` of a link, which would take the page away as WeChat never does.
 */
function setRichAttribute(el: Element, name: string, value: string, options: RichTextOptions) {
  if (/^on/i.test(name) || isScriptUrl(value)) return;
  if (el.localName === "a" && name.toLowerCase() === "href") return;
  try {
    el.setAttribute(name, name.toLowerCase() === "class" ? options.transformClass(value) : value);
  } catch {
    // Skip attribute names the DOM rejects
  }
}

/** Decodes the HTML entities of a text node; only entities, as the text is not parsed as markup. */
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  const doc = new DOMParser().parseFromString(text.replaceAll("<", "&lt;"), "text/html");
  return doc.body.textContent ?? "";
}

function sanitize(nodes: Node[], options: RichTextOptions): Node[] {
  return nodes.flatMap((node): Node[] => {
    if (node.nodeType === Node.TEXT_NODE) {
      return [document.createTextNode(applySpace(node.textContent ?? "", options.space))];
    }
    if (!(node instanceof Element)) return [];
    const tag = node.tagName.toLowerCase();
    if (!ALLOWED_RICH_TEXT_TAGS.has(tag)) return [];
    const el = document.createElement(tag);
    for (const attr of node.attributes) setRichAttribute(el, attr.name, attr.value, options);
    el.append(...sanitize([...node.childNodes], options));
    return [el];
  });
}

function buildRichNode(node: unknown, options: RichTextOptions): Node[] {
  if (!node || typeof node !== "object") return [];
  const { type, text, name, attrs, children } = node as Record<string, unknown>;
  if (type === "text") {
    return [document.createTextNode(applySpace(decodeEntities(toText(text)), options.space))];
  }
  const tag = toText(name).toLowerCase();
  if (!ALLOWED_RICH_TEXT_TAGS.has(tag)) return [];
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries((attrs as Record<string, unknown>) ?? {})) {
    setRichAttribute(el, key, toText(value), options);
  }
  if (Array.isArray(children)) {
    el.append(...children.flatMap((child) => buildRichNode(child, options)));
  }
  return [el];
}

let nextCameraId = 0;

const FLASH_LABELS: Record<string, string> = {
  auto: "自动",
  on: "打开",
  off: "关闭",
  torch: "常亮",
};

/**
 * The camera, a native component: it stays black until the logic layer has the
 * user's `scope.camera`, then shows a simulated preview and fires `initdone`.
 * In `scanCode` mode, tapping the preview is the camera seeing the code
 * `wx.scanCode` reads, which fires `scancode`. Going to the background stops it
 * (`stop`) and coming back shows the preview again.
 */
class WxCamera extends Builtin {
  readonly cameraId = ++nextCameraId;
  private readonly preview: HTMLElement;
  private readonly label: HTMLElement;
  private readonly scanFrame: HTMLElement;
  private mounted = false;
  /** The `scancode` detail while the camera shows its preview in `scanCode` mode. */
  private scan?: Record<string, unknown>;
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: block; position: relative; width: 100%; height: 300px; background: #000; overflow: hidden; }
      .preview { position: absolute; inset: 0; color: rgba(255, 255, 255, 0.7); font: 12px/1.4 sans-serif; }
      .preview[hidden] { display: none; }
      .scene { position: absolute; inset: 0; background: radial-gradient(circle at 30% 35%, #6b7480, #262a30 70%); }
      .scene::after { content: ""; position: absolute; left: 62%; top: 55%; width: 22%; height: 30%; border-radius: 8px; background: rgba(255, 255, 255, 0.12); }
      .front .scene { transform: scaleX(-1); }
      .torch .scene { filter: brightness(1.5); }
      .label { position: absolute; left: 8px; bottom: 6px; }
      .scan { position: absolute; left: 50%; top: 50%; width: 55%; aspect-ratio: 1; max-height: 70%; transform: translate(-50%, -50%); border: 1px solid rgba(7, 193, 96, 0.8); box-sizing: border-box; display: flex; align-items: flex-end; justify-content: center; padding-bottom: 6px; color: #fff; }
      .scan[hidden] { display: none; }
    </style><div class="preview" hidden><div class="scene"></div><div class="scan" hidden>点击画面模拟扫到码</div><div class="label"></div></div><slot></slot>`);
    this.preview = root.querySelector(".preview")!;
    this.label = root.querySelector(".label")!;
    this.scanFrame = root.querySelector(".scan")!;
    this.preview.addEventListener("click", () => {
      if (this.scan && !this.preview.hidden) emit(this, "scancode", this.scan);
    });
  }
  connectedCallback(): void {
    this.announce(true);
  }
  disconnectedCallback(): void {
    this.announce(false);
  }
  protected override update(): void {
    const front = this.str("device-position") === "front";
    const flash = this.str("flash", "auto");
    this.preview.classList.toggle("front", front);
    this.preview.classList.toggle("torch", flash === "torch");
    this.label.textContent = `模拟摄像头画面 · ${front ? "前置" : "后置"} · 闪光灯${FLASH_LABELS[flash] ?? FLASH_LABELS.auto}`;
  }
  private announce(mounted: boolean): void {
    if (mounted === this.mounted) return;
    this.mounted = mounted;
    if (!mounted) this.preview.hidden = true;
    // `mode` and `frame-size` only count when the camera is inserted
    const mode = this.str("mode", "normal");
    const frameSize = this.str("frame-size", "medium");
    document.dispatchEvent(
      new CustomEvent("omr-camera", { detail: { camera: this, mounted, mode, frameSize } }),
    );
  }
  omrCameraState(state: {
    error?: string;
    scan?: Record<string, unknown>;
    stopped?: boolean;
  }): void {
    if (!this.mounted) return;
    if (state.error !== undefined) {
      this.preview.hidden = true;
      emit(this, "error", { errMsg: state.error });
      return;
    }
    if (state.scan) this.scan = state.scan;
    this.scanFrame.hidden = !this.scan;
    this.preview.hidden = state.stopped === true;
    if (state.stopped === true) emit(this, "stop", {});
    else if (state.stopped === undefined) emit(this, "initdone", { maxZoom: 1 });
  }
}

const AVATAR =
  '<svg viewBox="0 0 40 40" width="100%" height="100%" preserveAspectRatio="xMidYMid slice"><rect width="40" height="40" fill="#e1e1e1"/><circle cx="20" cy="15" r="7" fill="#fff"/><path d="M6 40c1-9 7-13 14-13s13 4 14 13z" fill="#fff"/></svg>';

/**
 * `<open-data>`: since base library 2.27 WeChat no longer shows user data
 * here; the nickname is "微信用户" and the avatar is gray, as on WeChat. Other
 * user data, and the group name the simulator has no group for, are empty:
 * they show `default-text` and fire `error`.
 */
class WxOpenData extends Builtin {
  private readonly root = this.attachShadow({ mode: "open" });
  private readonly applied = new Applied();
  protected override update(): void {
    const type = this.str("type");
    if (type === "userAvatarUrl") {
      this.root.innerHTML = `<style>:host { display: inline-block; overflow: hidden; } svg { display: block; }</style>${AVATAR}`;
      return;
    }
    this.root.innerHTML = "<style>:host { display: inline; }</style>";
    if (type === "userNickName") {
      this.root.append("微信用户");
      return;
    }
    this.root.append(this.str("default-text"));
    const changed = this.applied.changed("type", type);
    if (changed && (type === "groupName" || type.startsWith("user"))) {
      // After the element is in the page, so the view hears it
      setTimeout(() => emit(this, "error", { errMsg: `open-data: ${type} is empty` }), 0);
    }
  }
}

/** `<cover-view>` is a view; `scroll-top` scrolls it once it scrolls. */
class WxCoverView extends Builtin {
  private applied?: unknown;
  protected override update(): void {
    const value = this.props["scroll-top"];
    if (value === this.applied) return;
    this.applied = value;
    if (value !== undefined) queueMicrotask(() => (this.scrollTop = lengthOf(value, 0)));
  }
}

let warnedFunctionalPage = false;
/**
 * `<functional-page-navigator>` opens a functional page only inside a plugin,
 * which the simulator does not run; in an app's own pages it shows its children
 * and a tap does nothing, as on WeChat.
 */
class WxFunctionalPageNavigator extends Builtin {
  connectedCallback(): void {
    if (warnedFunctionalPage) return;
    warnedFunctionalPage = true;
    console.info(
      "[omr] <functional-page-navigator> works only in plugins; outside one, tapping it does nothing, as on WeChat",
    );
  }
}

/** `<web-view>` draws nothing in the page: the shell shows the web page over it. */
class WxWebView extends Builtin {}

const DEFINITIONS: [string, CustomElementConstructor][] = [
  ["wx-text", WxText],
  ["wx-image", WxImage],
  ["wx-cover-image", class extends WxImage {}],
  ["wx-cover-view", WxCoverView],
  ["wx-official-account", WxOfficialAccount],
  ["wx-channel-video", WxChannelVideo],
  ["wx-channel-live", WxChannelLive],
  ["wx-icon", WxIcon],
  ["wx-input", WxInput],
  ["wx-textarea", WxTextarea],
  ["wx-switch", WxSwitch],
  ["wx-checkbox", WxCheckbox],
  ["wx-radio", WxRadio],
  ["wx-checkbox-group", WxCheckboxGroup],
  ["wx-radio-group", WxRadioGroup],
  ["wx-slider", WxSlider],
  ["wx-progress", WxProgress],
  ["wx-scroll-view", WxScrollView],
  ["wx-swiper", WxSwiper],
  ["wx-swiper-item", WxSwiperItem],
  ["wx-movable-area", WxMovableArea],
  ["wx-movable-view", WxMovableView],
  ["wx-picker", WxPicker],
  ["wx-picker-view", WxPickerView],
  ["wx-picker-view-column", WxPickerViewColumn],
  ["wx-rich-text", WxRichText],
  ["wx-editor", WxEditor],
  ["wx-web-view", WxWebView],
  ["wx-grid-view", WxGridView],
  ...SKYLINE_ONLY_TAGS.map((tag): [string, CustomElementConstructor] => [
    `wx-${tag}`,
    class extends SkylineOnly {},
  ]),
  ["wx-video", WxVideo],
  ["wx-audio", WxAudio],
  ["wx-camera", WxCamera],
  ["wx-live-player", WxLivePlayer],
  ["wx-live-pusher", WxLivePusher],
  ["wx-voip-room", WxVoipRoom],
  ["wx-functional-page-navigator", WxFunctionalPageNavigator],
  ["wx-store-product", WxStoreProduct],
  ["wx-store-home", WxStoreHome],
  ["wx-store-coupon", WxStoreCoupon],
  ["wx-store-gift", WxStoreGift],
  ["wx-official-account-publish", WxOfficialAccountPublish],
  ["wx-reward", WxReward],
  ["wx-page-container", WxPageContainer],
  ["wx-root-portal", WxRootPortal],
  ["wx-match-media", WxMatchMedia],
  ["wx-page-meta", WxPageMeta],
  ["wx-open-data", WxOpenData],
  ["wx-ad", WxAd],
  ["wx-ad-custom", WxAdCustom],
  ["wx-map", WxMap],
  ...CANVAS_DEFINITIONS,
];

export function defineBuiltins(): void {
  for (const [tag, constructor] of DEFINITIONS) {
    if (!customElements.get(tag)) customElements.define(tag, constructor);
  }
}

/**
 * Default styles of the page and built-in components. They come before the
 * Mini Program's styles; internal parts use `:where()` so any page selector
 * overrides them. `html.omr-v2` marks apps with `"style": "v2"` in app.json.
 */
export const BASE_CSS = `
html { height: 100%; -webkit-text-size-adjust: 100%; scrollbar-width: none; }
/* The page fills the window, so a page background covers it as on WeChat */
body { min-height: 100%; }
::-webkit-scrollbar { display: none; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", sans-serif; font-size: 16px; -webkit-tap-highlight-color: transparent; user-select: none; cursor: default; }
[hidden] { display: none !important; }
omr-slot { display: contents; }
wx-view, wx-cover-view, wx-form, wx-navigator, wx-picker, wx-movable-area, wx-picker-view, wx-rich-text, wx-swiper-item, wx-share-element, wx-selection, wx-functional-page-navigator { display: block; }
/* Skyline-only components render their children as plain containers; gesture handlers and span draw nothing of their own */
wx-list-view, wx-sticky-header, wx-sticky-section, wx-draggable-sheet, wx-nested-scroll-header, wx-nested-scroll-body, wx-list-builder, wx-grid-builder, wx-open-container, wx-snapshot, wx-large-image, wx-open-data-item, wx-open-data-list { display: block; }
wx-sticky-header { position: sticky; top: 0; z-index: 1; }
:is(wx-tap-gesture-handler, wx-double-tap-gesture-handler, wx-pan-gesture-handler, wx-scale-gesture-handler, wx-long-press-gesture-handler, wx-force-press-gesture-handler, wx-horizontal-drag-gesture-handler, wx-vertical-drag-gesture-handler) { display: contents; }
wx-page-meta, wx-editor-portal { display: none; }
/* Shown only on the simulated keyboard of its focused field; the page's styles may lay it out, up to 200px tall */
wx-keyboard-accessory:not(.omr-keyboard-accessory-shown) { display: none !important; }
:where(wx-keyboard-accessory) { display: block; }
wx-keyboard-accessory.omr-keyboard-accessory-shown { position: fixed !important; left: 0 !important; right: 0 !important; max-height: 200px; overflow: hidden; z-index: 10001; }
wx-cover-view { line-height: 1.2; white-space: nowrap; overflow: hidden; }
wx-movable-area { position: relative; width: 10px; height: 10px; }
/* A pinch anywhere in a scale-area scales its views instead of the page */
wx-movable-area[scale-area] { touch-action: none; }
wx-text { white-space: pre-line; }
wx-text[space] { white-space: pre-wrap; }
wx-text[user-select], wx-text[selectable] { user-select: text; cursor: text; }
wx-text[user-select] { display: inline-block; }
wx-rich-text[user-select] { display: block; user-select: text; cursor: text; }
wx-scroll-view { display: block; position: relative; overflow: hidden; -webkit-overflow-scrolling: touch; }
wx-scroll-view[scroll-x] { overflow-x: auto; }
wx-scroll-view[scroll-y] { overflow-y: auto; }
wx-map, wx-canvas { width: 300px; height: 150px; }
wx-live-player, wx-voip-room, wx-channel-video { width: 300px; height: 225px; }
wx-live-pusher { width: 100%; }
wx-ad, wx-ad-custom, wx-official-account-publish, wx-store-product, wx-store-home, wx-store-coupon, wx-store-gift { display: block; }
wx-web-view { position: fixed !important; inset: 0; width: 100%; height: 100%; z-index: 100; }
wx-editor { display: block; position: relative; width: 100%; height: 200px; min-height: 200px; box-sizing: border-box; overflow: hidden; cursor: text; user-select: text; }
:where(wx-editor) > :where(.ql-editor) { position: relative; height: 100%; box-sizing: border-box; padding: 12px 15px; overflow-y: auto; outline: none; white-space: pre-wrap; word-wrap: break-word; line-height: 1.5; tab-size: 4; }
:where(wx-editor) > :where(.ql-editor.ql-blank)::before { content: attr(data-placeholder); position: absolute; left: 15px; right: 15px; color: rgba(0, 0, 0, 0.4); pointer-events: none; }
wx-editor > .omr-editor-image-tools { position: absolute; box-sizing: border-box; border: 1px dashed #576b95; pointer-events: none; z-index: 1; font: 12px/1.6 sans-serif; }
.omr-editor-image-tools > .omr-size { position: absolute; right: 2px; bottom: 2px; padding: 0 4px; border-radius: 2px; background: rgba(0, 0, 0, 0.6); color: #fff; }
.omr-editor-image-tools > .omr-resize { position: absolute; right: -6px; bottom: -6px; width: 12px; height: 12px; box-sizing: border-box; border: 2px solid #576b95; background: #fff; cursor: nwse-resize; pointer-events: auto; touch-action: none; }
.omr-editor-image-tools > .omr-toolbar { position: absolute; left: 0; top: 0; display: flex; gap: 1px; border-radius: 4px; overflow: hidden; background: rgba(0, 0, 0, 0.75); pointer-events: auto; }
.omr-editor-image-tools > .omr-toolbar > span { padding: 2px 8px; color: #fff; cursor: pointer; }
.navigator-hover { background-color: rgba(0, 0, 0, 0.1); opacity: 0.7; }

wx-input { display: block; position: relative; height: 1.4rem; min-height: 1.4rem; line-height: 1.4rem; overflow: hidden; white-space: nowrap; text-overflow: clip; cursor: auto; user-select: text; }
wx-textarea { display: block; position: relative; width: 300px; height: 150px; cursor: auto; user-select: text; }
wx-textarea[auto-height] { height: auto; min-height: 1.4rem; }
:where(wx-input, wx-textarea) > :where(input, textarea) { all: unset; display: block; position: relative; width: 100%; height: 100%; font: inherit; color: inherit; text-align: inherit; letter-spacing: inherit; box-sizing: border-box; white-space: pre-wrap; word-break: break-all; }
:where(wx-input, wx-textarea) > :where(.omr-placeholder) { position: absolute; inset: 0; color: #808080; pointer-events: none; overflow: hidden; text-align: inherit; }

wx-button { position: relative; display: block; box-sizing: border-box; margin-left: auto; margin-right: auto; padding-left: 14px; padding-right: 14px; width: 100%; font-size: 18px; line-height: 2.55555556; text-align: center; text-decoration: none; color: #000; background-color: #f8f8f8; border-radius: 5px; overflow: hidden; cursor: pointer; }
wx-button::after { content: " "; position: absolute; top: 0; left: 0; width: 200%; height: 200%; border: 1px solid rgba(0, 0, 0, 0.2); border-radius: 10px; transform: scale(0.5); transform-origin: 0 0; box-sizing: border-box; pointer-events: none; }
wx-button + wx-button { margin-top: 15px; }
wx-button[type="primary"] { color: #fff; background-color: #1aad19; }
wx-button[type="warn"] { color: #fff; background-color: #e64340; }
wx-button[size="mini"] { display: inline-block; width: auto; padding: 0 1.34em; font-size: 13px; line-height: 2.3; }
wx-button[size="mini"] + wx-button[size="mini"] { margin-top: 0; }
wx-button[plain] { color: #353535; background-color: transparent; }
wx-button[plain]::after { border-color: #353535; }
wx-button[plain][type="primary"] { color: #1aad19; }
wx-button[plain][type="primary"]::after { border-color: #1aad19; }
wx-button[plain][type="warn"] { color: #e64340; }
wx-button[plain][type="warn"]::after { border-color: #e64340; }
wx-button[disabled] { color: rgba(0, 0, 0, 0.3); background-color: #f7f7f7; cursor: default; }
wx-button[disabled][type="primary"] { color: rgba(255, 255, 255, 0.6); background-color: #9ed99d; }
wx-button[disabled][type="warn"] { color: rgba(255, 255, 255, 0.6); background-color: #ec8b89; }
.button-hover { background-color: #dedede; }
.button-hover[type="primary"] { background-color: #179b16; }
.button-hover[type="warn"] { background-color: #ce3c39; }
:where(.omr-v2) wx-button { width: 184px; padding: 8px 24px; font-size: 17px; font-weight: 700; line-height: 1.41176471; color: #06ae56; background-color: #f2f2f2; border-radius: 4px; }
:where(.omr-v2) wx-button::after { border: none; }
:where(.omr-v2) wx-button + wx-button { margin-top: 16px; }
:where(.omr-v2) wx-button[type="primary"] { color: #fff; background-color: #07c160; }
:where(.omr-v2) wx-button[type="warn"] { color: #fa5151; background-color: #f2f2f2; }
:where(.omr-v2) wx-button[size="mini"] { width: auto; padding: 0 12px; font-size: 16px; line-height: 2; border-radius: 4px; }
:where(.omr-v2) wx-button[disabled] { color: rgba(0, 0, 0, 0.18); background-color: rgba(0, 0, 0, 0.05); }
:where(.omr-v2) .button-hover { background-color: #dedede; }
:where(.omr-v2) .button-hover[type="primary"] { background-color: #06ad56; }
wx-button[loading]::before { content: ""; display: inline-block; width: 1em; height: 1em; margin-right: 0.5em; vertical-align: -0.15em; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; box-sizing: border-box; animation: omr-spin 1s linear infinite; }
@keyframes omr-spin { to { transform: rotate(360deg); } }

.omr-picker-mask, .omr-picker { width: auto; height: auto; margin: 0; border: 0; overflow: visible; color: inherit; }
.omr-picker-mask { position: fixed; inset: 0; z-index: 1000; padding: 0; background: rgba(0, 0, 0, 0.6); opacity: 0; transition: opacity 0.3s; }
.omr-picker { position: fixed; inset: auto 0 0 0; z-index: 1001; padding: 0 0 env(safe-area-inset-bottom); background: #fff; border-radius: 12px 12px 0 0; font-size: 17px; transform: translateY(100%); transition: transform 0.3s ease; user-select: none; }
.omr-picker-mask.omr-open { opacity: 1; }
.omr-picker.omr-open { transform: none; }
.omr-picker-header { display: flex; align-items: center; height: 56px; padding: 0 24px; }
.omr-picker-cancel, .omr-picker-confirm { flex: 1; cursor: pointer; }
.omr-picker-cancel { color: rgba(0, 0, 0, 0.9); }
.omr-picker-title { flex: 2; text-align: center; font-weight: 600; color: rgba(0, 0, 0, 0.9); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.omr-picker-confirm { text-align: right; color: #07c160; font-weight: 600; }
.omr-picker-body { position: relative; display: flex; padding: 0 16px; overflow: hidden; }
.omr-picker-highlight { position: absolute; left: 16px; right: 16px; top: 50%; height: 48px; transform: translateY(-50%); border-radius: 8px; background: rgba(0, 0, 0, 0.05); pointer-events: none; }
.omr-picker-fade { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(to bottom, rgba(255, 255, 255, 0.95), rgba(255, 255, 255, 0.6) 40%, transparent 40%, transparent 60%, rgba(255, 255, 255, 0.6) 60%, rgba(255, 255, 255, 0.95)); }
.omr-picker-column { position: relative; flex: 1; min-width: 0; height: 100%; overflow: hidden; touch-action: none; cursor: grab; }
.omr-picker-content { will-change: transform; }
.omr-picker-option { height: 48px; line-height: 48px; padding: 0 4px; text-align: center; color: rgba(0, 0, 0, 0.9); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

.omr-picker-view-mask { position: absolute; inset: 0; z-index: 3; pointer-events: none; background-image: linear-gradient(to bottom, rgba(255, 255, 255, 0.95), rgba(255, 255, 255, 0.6)), linear-gradient(to top, rgba(255, 255, 255, 0.95), rgba(255, 255, 255, 0.6)); background-position: top, bottom; background-size: 100% var(--omr-mask-size, 102px); background-repeat: no-repeat; }
.omr-picker-view-indicator { position: absolute; left: 0; right: 0; top: 50%; z-index: 3; height: 34px; transform: translateY(-50%); pointer-events: none; box-sizing: border-box; border-top: 1px solid rgba(0, 0, 0, 0.1); border-bottom: 1px solid rgba(0, 0, 0, 0.1); }

/* DarkMode: with "darkmode": true, built-in components take dark defaults in the dark theme (WeUI's dark palette) */
:where(.omr-dark) wx-button { color: rgba(255, 255, 255, 0.8); background-color: rgba(255, 255, 255, 0.08); }
:where(.omr-dark) wx-button::after { border-color: rgba(255, 255, 255, 0.2); }
:where(.omr-dark) wx-button[plain] { color: rgba(255, 255, 255, 0.8); background-color: transparent; }
:where(.omr-dark) wx-button[plain]::after { border-color: rgba(255, 255, 255, 0.8); }
:where(.omr-dark) wx-button[disabled] { color: rgba(255, 255, 255, 0.2); background-color: rgba(255, 255, 255, 0.08); }
:where(.omr-dark) wx-button[type="warn"]:not([plain]) { color: #fa5151; background-color: rgba(255, 255, 255, 0.08); }
:where(.omr-dark) .button-hover { background-color: rgba(255, 255, 255, 0.126); }
:where(.omr-dark) .navigator-hover { background-color: rgba(255, 255, 255, 0.1); }
:where(.omr-dark) :where(wx-input, wx-textarea) > :where(.omr-placeholder) { color: rgba(255, 255, 255, 0.3); }
:where(.omr-dark) .omr-picker { background: #191919; }
:where(.omr-dark) .omr-picker-cancel, :where(.omr-dark) .omr-picker-title, :where(.omr-dark) .omr-picker-option { color: rgba(255, 255, 255, 0.8); }
:where(.omr-dark) .omr-picker-highlight { background: rgba(255, 255, 255, 0.1); }
:where(.omr-dark) .omr-picker-fade { background: linear-gradient(to bottom, rgba(25, 25, 25, 0.95), rgba(25, 25, 25, 0.6) 40%, transparent 40%, transparent 60%, rgba(25, 25, 25, 0.6) 60%, rgba(25, 25, 25, 0.95)); }
:where(.omr-dark) .omr-picker-view-mask { background-image: linear-gradient(to bottom, rgba(25, 25, 25, 0.95), rgba(25, 25, 25, 0.6)), linear-gradient(to top, rgba(25, 25, 25, 0.95), rgba(25, 25, 25, 0.6)); }
:where(.omr-dark) .omr-picker-view-indicator { border-color: rgba(255, 255, 255, 0.1); }
`;
