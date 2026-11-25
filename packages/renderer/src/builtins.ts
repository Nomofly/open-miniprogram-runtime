/**
 * Built-in components as custom elements named `wx-<tag>`. Their look follows
 * what WeChat shows; the styles and drawings here are written for this project.
 *
 * Components raise WeChat events by dispatching an `omr-event` DOM event on
 * themselves, which the view turns into a logic-layer event. The view calls
 * `omrUpdate` with the evaluated attributes after every render, and
 * `omrActivate` when the user taps a control.
 */

export interface BuiltinElement extends HTMLElement {
  omrUpdate(props: Record<string, unknown>): void;
  /** Tapping a checkbox, radio, switch or picker. */
  omrActivate?(): void;
  /** The value a `<form>` submits for this control, by its `name`. */
  omrFormValue?(): unknown;
  omrReset?(): void;
  /** Fills `<input type="nickname">` with the nickname the user chose above the keyboard. */
  omrFill?(value: string): void;
  /** Tells a `<camera>` whether it may show its preview; `error` is its `binderror` message when not. */
  omrCameraState?(error?: string): void;
}

export interface OmrEventDetail {
  name: string;
  detail: Record<string, unknown>;
}

import { toText } from "./expression.ts";

function emit(el: Element, name: string, detail: Record<string, unknown> = {}): void {
  el.dispatchEvent(new CustomEvent<OmrEventDetail>("omr-event", { detail: { name, detail } }));
}

const isV2 = () => document.documentElement.classList.contains("omr-v2");
const BRAND_GREEN = () => (isV2() ? "#07c160" : "#09bb07");

abstract class Builtin extends HTMLElement implements BuiltinElement {
  props: Record<string, unknown> = {};
  omrUpdate(props: Record<string, unknown>): void {
    this.props = props;
    this.update();
  }
  protected update(): void {}
  protected str(name: string, fallback = ""): string {
    const value = this.props[name];
    return value === undefined || value === null ? fallback : toText(value);
  }
  protected num(name: string, fallback: number): number {
    const value = Number.parseFloat(toText(this.props[name]));
    return Number.isFinite(value) ? value : fallback;
  }
  /** As on WeChat, any non-empty string, including "false", is true. */
  protected flag(name: string): boolean {
    return Boolean(this.props[name]);
  }
  protected shadow(html: string): ShadowRoot {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = html;
    return root;
  }
}

class WxImage extends Builtin {
  private readonly img: HTMLImageElement;
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: inline-block; overflow: hidden; position: relative; width: 320px; height: 240px; }
      :host([mode="widthFix"]) { height: auto !important; }
      :host([mode="heightFix"]) { width: auto !important; }
      img { display: block; width: 100%; height: 100%; object-fit: fill; -webkit-user-drag: none; }
      img:not([src]) { visibility: hidden; }
    </style><img alt="" draggable="false">`);
    this.img = root.querySelector("img")!;
    this.img.addEventListener("load", () =>
      emit(this, "load", { width: this.img.naturalWidth, height: this.img.naturalHeight }),
    );
    this.img.addEventListener("error", () =>
      emit(this, "error", { errMsg: `GET ${this.img.getAttribute("src")} 404 (Not Found)` }),
    );
  }
  protected override update(): void {
    const src = this.str("src");
    if (!src) this.img.removeAttribute("src");
    else if (this.img.getAttribute("src") !== src) this.img.setAttribute("src", src);
    const mode = this.str("mode", "scaleToFill");
    const style = this.img.style;
    style.width = mode === "heightFix" ? "auto" : "100%";
    style.height = mode === "widthFix" ? "auto" : "100%";
    const position = IMAGE_POSITIONS[mode];
    style.objectFit = position
      ? "none"
      : mode === "aspectFit"
        ? "contain"
        : mode === "aspectFill"
          ? "cover"
          : mode === "scaleToFill"
            ? "fill"
            : "";
    style.objectPosition = position ?? "";
  }
}

/** Image modes that show the image unscaled, and the part they show. */
const IMAGE_POSITIONS: Record<string, string> = {
  top: "center top",
  bottom: "center bottom",
  center: "center",
  left: "left center",
  right: "right center",
  "top left": "left top",
  "top right": "right top",
  "bottom left": "left bottom",
  "bottom right": "right bottom",
};

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
    const size = this.num("size", 23);
    const color = this.str("color") || icon?.color || "#000";
    this.root.innerHTML = `<style>:host { display: inline-block; font-size: 0; line-height: 0; vertical-align: middle; } svg { display: block; }</style><svg viewBox="0 0 24 24" width="${size}" height="${size}">${icon?.svg.replaceAll('"C"', `"${color}"`) ?? ""}</svg>`;
  }
}

/** A text field; its parts are light DOM so `placeholder-class` can use the page's styles. */
class WxInput extends Builtin {
  protected field?: HTMLInputElement | HTMLTextAreaElement;
  private placeholder?: HTMLElement;
  private appliedValue: unknown = Symbol("unset");
  protected createField(): HTMLInputElement | HTMLTextAreaElement {
    return document.createElement("input");
  }
  connectedCallback(): void {
    if (this.field) return;
    this.placeholder = document.createElement("div");
    this.field = this.createField();
    this.append(this.placeholder, this.field);
    const field = this.field;
    field.addEventListener("input", () => {
      this.syncPlaceholder();
      emit(this, "input", { value: field.value, cursor: field.selectionStart ?? 0, keyCode: 0 });
    });
    field.addEventListener("focus", () => {
      emit(this, "focus", { value: field.value, height: 0 });
      if (this.isNickname()) this.announceNicknameFocus(true);
    });
    field.addEventListener("blur", () => {
      emit(this, "blur", { value: field.value });
      if (!this.isNickname()) return;
      this.announceNicknameFocus(false);
      // WeChat reviews the nickname asynchronously after blur; the simulator passes every nickname
      if (field.value !== "") {
        setTimeout(() => emit(this, "nicknamereview", { pass: true, timeout: false }), 200);
      }
    });
    field.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter" && field instanceof HTMLInputElement) {
        emit(this, "confirm", { value: field.value });
      }
    });
    this.update();
  }
  protected override update(): void {
    const { field, placeholder } = this;
    if (!field || !placeholder) return;
    // Only a changed value property replaces what the user typed
    const value = this.props.value;
    if (value !== this.appliedValue) {
      this.appliedValue = value;
      field.value = toText(value);
    }
    if (field instanceof HTMLInputElement) {
      const type = this.str("type", "text");
      field.type = this.flag("password") || type === "safe-password" ? "password" : "text";
      field.inputMode =
        type === "number"
          ? "numeric"
          : type === "digit"
            ? "decimal"
            : type === "idcard"
              ? "text"
              : "";
    }
    const maxlength = this.num("maxlength", 140);
    if (maxlength < 0) field.removeAttribute("maxlength");
    else field.maxLength = maxlength;
    field.disabled = this.flag("disabled");
    placeholder.textContent = this.str("placeholder");
    placeholder.className = `omr-placeholder ${this.str("placeholder-class")}`.trim();
    placeholder.setAttribute("style", this.str("placeholder-style"));
    this.syncPlaceholder();
    if (this.flag("focus") || this.flag("auto-focus")) queueMicrotask(() => field.focus());
  }
  private isNickname(): boolean {
    return this.field instanceof HTMLInputElement && this.str("type") === "nickname";
  }
  private announceNicknameFocus(focused: boolean): void {
    document.dispatchEvent(new CustomEvent("omr-nickname", { detail: { focused, input: this } }));
  }
  omrFill(value: string): void {
    if (!this.field) return;
    this.field.value = value;
    this.syncPlaceholder();
    emit(this, "input", { value, cursor: value.length, keyCode: 0 });
  }
  private syncPlaceholder(): void {
    if (this.placeholder && this.field) this.placeholder.hidden = this.field.value !== "";
  }
  omrFormValue(): unknown {
    return this.field?.value ?? "";
  }
  omrReset(): void {
    if (this.field) this.field.value = "";
    this.syncPlaceholder();
  }
}

class WxTextarea extends WxInput {
  protected override createField(): HTMLTextAreaElement {
    const field = document.createElement("textarea");
    field.addEventListener("input", () => this.fitHeight());
    return field;
  }
  protected override update(): void {
    super.update();
    this.fitHeight();
  }
  private fitHeight(): void {
    const field = this.field;
    if (!field) return;
    if (!this.flag("auto-height")) {
      field.style.height = "";
      return;
    }
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
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

class WxSlider extends Builtin {
  private readonly range: HTMLInputElement;
  private readonly label: HTMLElement;
  private appliedValue: unknown = Symbol("unset");
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: block; margin: 10px 18px; }
      .row { display: flex; align-items: center; min-height: 28px; }
      input { flex: 1; margin: 0; }
      .value { margin-left: 14px; min-width: 2em; color: #888; font-size: 14px; }
    </style><div class="row"><input type="range"><span class="value"></span></div>`);
    this.range = root.querySelector("input")!;
    this.label = root.querySelector(".value")!;
    this.range.addEventListener("input", () => {
      this.label.textContent = this.range.value;
      emit(this, "changing", { value: Number(this.range.value) });
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
    this.range.style.accentColor =
      this.str("activeColor") || this.str("selected-color") || BRAND_GREEN();
    this.label.hidden = !this.flag("show-value");
    this.label.textContent = this.range.value;
  }
  omrFormValue(): unknown {
    return Number(this.range.value);
  }
}

class WxProgress extends Builtin {
  private readonly root: ShadowRoot;
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
    const radius = `${this.num("border-radius", 0)}px`;
    bar.style.height = `${this.num("stroke-width", 6)}px`;
    bar.style.background = this.str("backgroundColor", "#ebebeb");
    bar.style.borderRadius = radius;
    inner.style.width = `${percent}%`;
    inner.style.background = this.str("activeColor") || this.str("color") || BRAND_GREEN();
    inner.style.borderRadius = radius;
    info.hidden = !this.flag("show-info");
    info.textContent = `${percent}%`;
    info.style.fontSize = `${this.num("font-size", 16)}px`;
  }
}

class WxScrollView extends Builtin {
  private applied: Record<string, unknown> = {};
  private last = { top: 0, left: 0 };
  private edges = { upper: true, lower: false };
  constructor() {
    super();
    this.addEventListener("scroll", () => this.onScroll(), { passive: true });
  }
  protected override update(): void {
    // Children are patched after attributes, so scroll once the render finishes
    queueMicrotask(() => {
      const behavior: ScrollBehavior = this.flag("scroll-with-animation") ? "smooth" : "auto";
      for (const [prop, axis] of [
        ["scroll-top", "top"],
        ["scroll-left", "left"],
      ] as const) {
        const value = this.props[prop];
        if (value !== undefined && value !== this.applied[prop]) {
          this.scrollTo({ [axis]: Number.parseFloat(toText(value)) || 0, behavior });
        }
        this.applied[prop] = value;
      }
      const intoView = this.str("scroll-into-view");
      if (intoView && intoView !== this.applied.intoView) {
        const target = this.querySelector(`#${CSS.escape(intoView)}`);
        if (target) {
          const offset = target.getBoundingClientRect();
          const box = this.getBoundingClientRect();
          this.scrollTo({
            top: this.scrollTop + offset.top - box.top,
            left: this.scrollLeft + offset.left - box.left,
            behavior,
          });
        }
      }
      this.applied.intoView = intoView;
    });
  }
  private onScroll(): void {
    const { scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth } = this;
    emit(this, "scroll", {
      scrollLeft,
      scrollTop,
      scrollHeight,
      scrollWidth,
      deltaX: this.last.left - scrollLeft,
      deltaY: this.last.top - scrollTop,
    });
    this.last = { top: scrollTop, left: scrollLeft };
    const vertical = this.flag("scroll-y");
    const upper = (vertical ? scrollTop : scrollLeft) <= this.num("upper-threshold", 50);
    const lower = vertical
      ? scrollTop + clientHeight >= scrollHeight - this.num("lower-threshold", 50)
      : scrollLeft + clientWidth >= scrollWidth - this.num("lower-threshold", 50);
    if (upper && !this.edges.upper) {
      emit(this, "scrolltoupper", { direction: vertical ? "top" : "left" });
    }
    if (lower && !this.edges.lower) {
      emit(this, "scrolltolower", { direction: vertical ? "bottom" : "right" });
    }
    this.edges = { upper, lower };
  }
}

class WxSwiper extends Builtin {
  private current = 0;
  private appliedCurrent: unknown = Symbol("unset");
  private timer?: ReturnType<typeof setInterval>;
  private readonly track: HTMLElement;
  private readonly dots: HTMLElement;
  private drag?: { start: number; delta: number; pointerId: number };
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: block; position: relative; height: 150px; overflow: hidden; }
      .track { display: flex; width: 100%; height: 100%; }
      .dots { position: absolute; left: 0; right: 0; bottom: 10px; display: flex; justify-content: center; gap: 8px; pointer-events: none; }
      .dots.vertical { left: auto; right: 10px; top: 0; bottom: 0; flex-direction: column; align-items: center; }
      .dot { width: 8px; height: 8px; border-radius: 50%; }
    </style><div class="track"><slot></slot></div><div class="dots"></div>`);
    this.track = root.querySelector(".track")!;
    this.dots = root.querySelector(".dots")!;
    root.querySelector("slot")!.addEventListener("slotchange", () => this.layout(false));
    this.addEventListener("pointerdown", (event) => {
      this.drag = { start: this.axisOf(event), delta: 0, pointerId: event.pointerId };
    });
    this.addEventListener("pointermove", (event) => {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      this.drag.delta = this.axisOf(event) - this.drag.start;
      this.layout(false);
    });
    const end = () => {
      if (!this.drag) return;
      const { delta } = this.drag;
      this.drag = undefined;
      const size = this.flag("vertical") ? this.clientHeight : this.clientWidth;
      if (Math.abs(delta) > size * 0.2) this.go(this.current + (delta < 0 ? 1 : -1), "touch");
      else this.layout(true);
    };
    this.addEventListener("pointerup", end);
    this.addEventListener("pointercancel", end);
  }
  private axisOf(event: PointerEvent): number {
    return this.flag("vertical") ? event.clientY : event.clientX;
  }
  private items(): Element[] {
    return [...this.children].filter((child) => child.tagName === "WX-SWIPER-ITEM");
  }
  protected override update(): void {
    if (this.props.current !== this.appliedCurrent) {
      this.appliedCurrent = this.props.current;
      this.current = this.num("current", 0);
    }
    clearInterval(this.timer);
    if (this.flag("autoplay")) {
      this.timer = setInterval(
        () => this.go(this.current + 1, "autoplay"),
        this.num("interval", 5000),
      );
    }
    queueMicrotask(() => this.layout(false));
  }
  disconnectedCallback(): void {
    clearInterval(this.timer);
  }
  private go(index: number, source: string): void {
    const count = this.items().length;
    if (count === 0) return;
    const perView = Math.max(1, this.num("display-multiple-items", 1));
    const last = Math.max(0, count - perView);
    let next = index;
    if (next > last) next = this.flag("circular") || source === "autoplay" ? 0 : last;
    if (next < 0) next = this.flag("circular") ? last : 0;
    const changed = next !== this.current;
    this.current = next;
    this.layout(true);
    if (!changed) return;
    const itemId = this.items()[next]?.getAttribute("item-id") ?? "";
    emit(this, "change", { current: next, currentItemId: itemId, source });
    setTimeout(
      () => emit(this, "animationfinish", { current: next, currentItemId: itemId, source }),
      this.num("duration", 500),
    );
  }
  private layout(animate: boolean): void {
    const vertical = this.flag("vertical");
    const perView = Math.max(1, this.num("display-multiple-items", 1));
    const count = this.items().length;
    this.track.style.flexDirection = vertical ? "column" : "row";
    this.track.style.setProperty("--omr-swiper-item-size", `${100 / perView}%`);
    const drag = this.drag?.delta ?? 0;
    const offset = `calc(${(-this.current * 100) / perView}% + ${drag}px)`;
    this.track.style.transition =
      animate && !this.drag ? `transform ${this.num("duration", 500)}ms ease` : "none";
    this.track.style.transform = vertical ? `translateY(${offset})` : `translateX(${offset})`;
    this.dots.className = `dots${vertical ? " vertical" : ""}`;
    this.dots.hidden = !this.flag("indicator-dots");
    const color = this.str("indicator-color", "rgba(0, 0, 0, 0.3)");
    const active = this.str("indicator-active-color", "#000000");
    this.dots.innerHTML = Array.from(
      { length: count },
      (_, index) =>
        `<span class="dot" style="background:${index === this.current ? active : color}"></span>`,
    ).join("");
  }
}

class WxPicker extends Builtin {
  omrActivate(): void {
    if (this.flag("disabled")) return;
    const mode = this.str("mode", "selector");
    if (mode === "selector" || mode === "multiSelector") this.openColumns(mode === "multiSelector");
    else if (mode === "date" || mode === "time") this.openNative(mode);
    else {
      console.warn(`[omr] picker mode "${mode}" is not supported in the simulator`);
      emit(this, "cancel");
    }
  }
  omrFormValue(): unknown {
    return this.props.value;
  }
  private label(item: unknown): string {
    const key = this.str("range-key");
    const value =
      key && item && typeof item === "object" ? (item as Record<string, unknown>)[key] : item;
    return toText(value);
  }
  private openColumns(multi: boolean): void {
    const range = Array.isArray(this.props.range) ? (this.props.range as unknown[]) : [];
    const columns = (multi ? range : [range]).map((column) =>
      Array.isArray(column) ? column : [],
    );
    const value = this.props.value;
    const selected = columns.map((_, index) =>
      Math.max(0, Number(multi ? (Array.isArray(value) ? value[index] : 0) : value) || 0),
    );
    const body = document.createElement("div");
    body.className = "omr-picker-columns";
    columns.forEach((column, columnIndex) => {
      const list = document.createElement("div");
      list.className = "omr-picker-column";
      column.forEach((item, index) => {
        const option = document.createElement("div");
        option.className = "omr-picker-option";
        option.textContent = this.label(item);
        option.addEventListener("click", () => {
          selected[columnIndex] = index;
          mark();
          if (multi) emit(this, "columnchange", { column: columnIndex, value: index });
        });
        list.append(option);
      });
      body.append(list);
    });
    const mark = () =>
      [...body.children].forEach((list, columnIndex) =>
        [...list.children].forEach((option, index) =>
          option.classList.toggle("selected", index === selected[columnIndex]),
        ),
      );
    mark();
    this.openSheet(body, () => (multi ? [...selected] : selected[0]));
    for (const option of body.querySelectorAll<HTMLElement>(".selected")) {
      option.parentElement!.scrollTop = option.offsetTop - 102;
    }
  }
  private openNative(mode: "date" | "time"): void {
    const input = document.createElement("input");
    input.type = mode;
    input.className = "omr-picker-native";
    input.value = this.str("value");
    if (this.props.start) input.min = this.str("start");
    if (this.props.end) input.max = this.str("end");
    this.openSheet(input, () => input.value);
  }
  private openSheet(content: HTMLElement, value: () => unknown): void {
    const mask = document.createElement("div");
    mask.className = "omr-picker-mask";
    const sheet = document.createElement("div");
    sheet.className = "omr-picker";
    const header = document.createElement("div");
    header.className = "omr-picker-header";
    // Button labels as WeChat shows them
    const cancel = Object.assign(document.createElement("span"), { textContent: "取消" });
    const confirm = Object.assign(document.createElement("span"), { textContent: "确定" });
    confirm.className = "omr-picker-confirm";
    header.append(cancel, confirm);
    sheet.append(header, content);
    const close = () => {
      mask.remove();
      sheet.remove();
    };
    cancel.addEventListener("click", () => {
      close();
      emit(this, "cancel");
    });
    mask.addEventListener("click", () => {
      close();
      emit(this, "cancel");
    });
    confirm.addEventListener("click", () => {
      close();
      emit(this, "change", { value: value() });
    });
    document.body.append(mask, sheet);
  }
}

const ALLOWED_RICH_TEXT_TAGS = new Set(
  "a abbr address article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del div dl dt em fieldset font footer h1 h2 h3 h4 h5 h6 header hr i img ins label legend li mark nav ol p pre q rt ruby s section small span strong sub sup table tbody td tfoot th thead tr tt u ul".split(
    " ",
  ),
);

/** rich-text renders in light DOM so its `class` attributes use the page's styles. */
class WxRichText extends Builtin {
  private applied?: string;
  protected override update(): void {
    const nodes = this.props.nodes;
    const serialized = JSON.stringify(nodes ?? "");
    if (serialized === this.applied) return;
    this.applied = serialized;
    if (typeof nodes === "string") {
      const doc = new DOMParser().parseFromString(nodes, "text/html");
      this.replaceChildren(...sanitize([...doc.body.childNodes]));
    } else if (Array.isArray(nodes)) {
      this.replaceChildren(...nodes.flatMap((node) => buildRichNode(node)));
    } else {
      this.replaceChildren();
    }
  }
}

function sanitize(nodes: Node[]): Node[] {
  return nodes.flatMap((node): Node[] => {
    if (node.nodeType === Node.TEXT_NODE) return [document.importNode(node)];
    if (!(node instanceof Element)) return [];
    const tag = node.tagName.toLowerCase();
    if (!ALLOWED_RICH_TEXT_TAGS.has(tag)) return [];
    const el = document.createElement(tag);
    for (const attr of node.attributes) {
      if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) continue;
      el.setAttribute(attr.name, attr.value);
    }
    el.append(...sanitize([...node.childNodes]));
    return [el];
  });
}

function buildRichNode(node: unknown): Node[] {
  if (!node || typeof node !== "object") return [];
  const { type, text, name, attrs, children } = node as Record<string, unknown>;
  if (type === "text") return [document.createTextNode(toText(text))];
  const tag = toText(name).toLowerCase();
  if (!ALLOWED_RICH_TEXT_TAGS.has(tag)) return [];
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries((attrs as Record<string, unknown>) ?? {})) {
    if (/^on/i.test(key) || /^\s*javascript:/i.test(toText(value))) continue;
    try {
      el.setAttribute(key, toText(value));
    } catch {
      // Skip attribute names the DOM rejects
    }
  }
  if (Array.isArray(children)) el.append(...children.flatMap((child) => buildRichNode(child)));
  return [el];
}

class WxVideo extends Builtin {
  private readonly video: HTMLVideoElement;
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: inline-block; position: relative; width: 300px; height: 225px; background: #000; overflow: hidden; }
      video { display: block; width: 100%; height: 100%; }
    </style><video playsinline></video><slot></slot>`);
    this.video = root.querySelector("video")!;
    for (const name of ["play", "pause", "ended", "error"]) {
      this.video.addEventListener(name, () => emit(this, name));
    }
  }
  protected override update(): void {
    const src = this.str("src");
    if (this.video.getAttribute("src") !== src) this.video.src = src;
    this.video.poster = this.str("poster");
    this.video.controls = this.props.controls === undefined || this.flag("controls");
    this.video.muted = this.flag("muted");
    this.video.loop = this.flag("loop");
    this.video.autoplay = this.flag("autoplay");
    this.video.style.objectFit = this.str("object-fit", "contain");
  }
}

let nextCameraId = 0;

/**
 * The camera, a native component: it stays black until the logic layer has the
 * user's `scope.camera`, then shows a simulated preview and fires `initdone`.
 */
class WxCamera extends Builtin {
  readonly cameraId = ++nextCameraId;
  private readonly preview: HTMLElement;
  private mounted = false;
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: block; position: relative; width: 100%; height: 300px; background: #000; overflow: hidden; }
      .preview { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: radial-gradient(circle at 35% 40%, #5b6470, #262a30 70%); color: rgba(255, 255, 255, 0.6); font: 13px/1.4 sans-serif; }
      .preview[hidden] { display: none; }
    </style><div class="preview" hidden>模拟摄像头画面</div><slot></slot>`);
    this.preview = root.querySelector(".preview")!;
  }
  connectedCallback(): void {
    this.announce(true);
  }
  disconnectedCallback(): void {
    this.announce(false);
  }
  private announce(mounted: boolean): void {
    if (mounted === this.mounted) return;
    this.mounted = mounted;
    if (!mounted) this.preview.hidden = true;
    document.dispatchEvent(new CustomEvent("omr-camera", { detail: { camera: this, mounted } }));
  }
  omrCameraState(error?: string): void {
    if (!this.mounted) return;
    this.preview.hidden = error !== undefined;
    if (error === undefined) emit(this, "initdone", { maxZoom: 1 });
    else emit(this, "error", { errMsg: error });
  }
}

/** Native components the simulator does not render; they keep their size and say what they are. */
class Placeholder extends Builtin {
  constructor() {
    super();
    const name = this.localName.slice(3);
    this.shadow(`<style>
      :host { display: inline-block; position: relative; }
      .box { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 8px; box-sizing: border-box; background: #f2f2f2; border: 1px dashed #c8c8c8; color: #999; font: 12px/1.4 sans-serif; text-align: center; }
    </style><div class="box">&lt;${name}&gt; is not rendered by the simulator</div><slot></slot>`);
  }
}

const DEFINITIONS: [string, CustomElementConstructor][] = [
  ["wx-image", WxImage],
  ["wx-cover-image", class extends WxImage {}],
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
  ["wx-picker", WxPicker],
  ["wx-rich-text", WxRichText],
  ["wx-video", WxVideo],
  ["wx-camera", WxCamera],
  ...[
    "map",
    "canvas",
    "live-player",
    "live-pusher",
    "web-view",
    "ad",
    "official-account",
    "editor",
    "audio",
  ].map((tag): [string, CustomElementConstructor] => [`wx-${tag}`, class extends Placeholder {}]),
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
wx-view, wx-cover-view, wx-form, wx-navigator, wx-picker, wx-movable-area, wx-movable-view, wx-picker-view, wx-rich-text, wx-swiper-item { display: block; }
wx-movable-area { position: relative; }
wx-text { white-space: pre-line; }
wx-text[space] { white-space: pre-wrap; }
wx-text[user-select], wx-text[selectable] { user-select: text; }
wx-swiper-item { flex: 0 0 var(--omr-swiper-item-size, 100%); width: 100%; height: 100%; box-sizing: border-box; overflow: hidden; }
wx-scroll-view { display: block; position: relative; overflow: hidden; -webkit-overflow-scrolling: touch; }
wx-scroll-view[scroll-x] { overflow-x: auto; }
wx-scroll-view[scroll-y] { overflow-y: auto; }
wx-map, wx-canvas, wx-live-player, wx-live-pusher { width: 300px; height: 150px; }
wx-ad, wx-official-account { display: block; height: 100px; }
wx-editor { display: block; height: 200px; }
wx-audio { width: 300px; height: 70px; }
wx-web-view { position: fixed !important; inset: 0; width: 100%; height: 100%; z-index: 100; }
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

.omr-picker-mask { position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.6); }
.omr-picker { position: fixed; left: 0; right: 0; bottom: 0; z-index: 1001; padding-bottom: env(safe-area-inset-bottom); background: #fff; font-size: 17px; }
.omr-picker-header { display: flex; justify-content: space-between; padding: 0 16px; line-height: 50px; border-bottom: 1px solid #e5e5e5; color: #888; }
.omr-picker-confirm { color: #07c160; font-weight: 600; }
.omr-picker-columns { display: flex; }
.omr-picker-column { flex: 1; height: 238px; overflow-y: auto; text-align: center; }
.omr-picker-option { line-height: 34px; color: #999; }
.omr-picker-option.selected { color: #000; font-weight: 600; background: #f2f2f2; }
.omr-picker-native { display: block; margin: 24px auto; font-size: 20px; }
`;
