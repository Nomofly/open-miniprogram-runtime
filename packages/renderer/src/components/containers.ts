/**
 * Containers that change where or whether their children show: `<page-container>`
 * with its `<share-element>`s, `<root-portal>`, `<match-media>`, and the page configuration nodes
 * `<page-meta>` and `<navigation-bar>`.
 */
import { Applied, Builtin, convertStyle, emit, lengthOf, trackDrag } from "./base.ts";
import { mediaQueryOf } from "./format.ts";

type Phase = "hidden" | "entering" | "shown" | "leaving";

/** A popup layer the page shows over itself; returning from the page closes it first on WeChat. */
export class WxPageContainer extends Builtin {
  private readonly overlay: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly frame: HTMLStyleElement;
  private readonly applied = new Applied();
  private phase: Phase = "hidden";
  private timer?: ReturnType<typeof setTimeout>;
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: none; position: fixed; inset: 0; z-index: 100; pointer-events: none; }
      .overlay { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.7); opacity: 0; pointer-events: auto; transition: opacity var(--omr-duration) ease; }
      .overlay[hidden] { display: none; }
      .panel { position: absolute; box-sizing: border-box; background: #fff; overflow: hidden; pointer-events: auto; transition: transform var(--omr-duration) ease, opacity var(--omr-duration) ease; }
      .bottom { left: 0; right: 0; bottom: 0; max-height: 100%; transform: translateY(100%); }
      .top { left: 0; right: 0; top: 0; max-height: 100%; transform: translateY(-100%); }
      .right { top: 0; right: 0; bottom: 0; width: 100%; transform: translateX(100%); }
      .center { left: 50%; top: 50%; max-width: 100%; max-height: 100%; transform: translate(-50%, -50%) scale(0.7); opacity: 0; }
      .bottom.round { border-radius: 20px 20px 0 0; }
      .top.round { border-radius: 0 0 20px 20px; }
      .right.round { border-radius: 20px 0 0 20px; }
      .center.round { border-radius: 20px; }
      .open .overlay { opacity: 1; }
      .open .panel.bottom, .open .panel.top, .open .panel.right { transform: none; }
      .open .panel.center { transform: translate(-50%, -50%); opacity: 1; }
    </style><style></style><div class="layer"><div class="overlay"></div><div class="panel"><slot></slot></div></div>`);
    this.frame = root.querySelectorAll("style")[1]!;
    this.overlay = root.querySelector(".overlay")!;
    this.panel = root.querySelector(".panel")!;
    this.overlay.addEventListener("click", () => {
      emit(this, "clickoverlay");
      // Tapping the overlay is a return, which closes the container
      this.leave();
    });
    let pulled = 0;
    trackDrag(this.panel, {
      start: () => this.flag("close-on-slide-down") && this.phase === "shown",
      move: (_, dy) => {
        pulled = Math.max(0, dy);
        this.panel.style.transition = "none";
        this.panel.style.transform = pulled > 0 ? `translateY(${pulled}px)` : "";
      },
      end: () => {
        this.panel.style.transition = "";
        this.panel.style.transform = "";
        if (pulled > Math.min(100, this.panel.offsetHeight / 3)) this.leave();
        pulled = 0;
      },
    });
  }
  protected override update(): void {
    const position = this.str("position", "bottom");
    this.panel.className = `panel ${["top", "bottom", "right", "center"].includes(position) ? position : "bottom"}${this.flag("round") ? " round" : ""}`;
    this.panel.setAttribute("style", convertStyle(this.str("custom-style")));
    this.overlay.hidden = !this.flagOn("overlay");
    this.overlay.setAttribute("style", convertStyle(this.str("overlay-style")));
    this.frame.textContent = `:host { z-index: ${this.num("z-index", 100)} !important; --omr-duration: ${this.duration()}ms; }${this.phase === "hidden" ? "" : " :host { display: block !important; }"}`;
    if (!this.applied.changed("show", this.flag("show"))) return;
    if (this.flag("show")) this.enter();
    else this.leave();
  }
  private duration(): number {
    return Math.max(0, this.num("duration", 300));
  }
  /** A return on the page closes the container, as tapping the overlay does. */
  omrClose(): void {
    this.leave();
  }
  /** Tells the view whether the container is open, so a return closes it instead of the page. */
  private report(open: boolean): void {
    this.dispatchEvent(
      new CustomEvent("omr-page-container", { bubbles: true, composed: true, detail: { open } }),
    );
  }
  private enter(): void {
    if (this.phase === "entering" || this.phase === "shown") return;
    clearTimeout(this.timer);
    this.report(true);
    emit(this, "beforeenter");
    this.phase = "entering";
    this.update();
    const layer = this.panel.parentElement!;
    const pairs = this.sharedPairs();
    if (pairs.length) {
      // Where the shared elements land: laid out open without the transition, then closed again
      this.panel.style.transition = "none";
      layer.classList.add("open");
      const targets = pairs.map(([, inside]) => inside.getBoundingClientRect());
      layer.classList.remove("open");
      void layer.offsetWidth;
      this.panel.style.transition = "";
      pairs.forEach(([outside, inside], index) =>
        inside.fly(outside.getBoundingClientRect(), targets[index]!, outside),
      );
    }
    // Lay out closed, then open, so the transition runs
    void layer.offsetWidth;
    layer.classList.add("open");
    emit(this, "enter");
    this.timer = setTimeout(() => {
      this.phase = "shown";
      emit(this, "afterenter");
    }, this.duration());
  }
  /**
   * The `<share-element>`s in the page and in this container with the same
   * key, where either has `transform`.
   */
  private sharedPairs(): [WxShareElement, WxShareElement][] {
    const inside = [...this.querySelectorAll<WxShareElement>("wx-share-element")];
    const outside = [...document.querySelectorAll<WxShareElement>("wx-share-element")].filter(
      (el) => !el.parentElement?.closest("wx-page-container"),
    );
    return inside.flatMap((target): [WxShareElement, WxShareElement][] => {
      const source = outside.find((el) => el.shareKey && el.shareKey === target.shareKey);
      return source && (source.animates || target.animates) ? [[source, target]] : [];
    });
  }
  private leave(): void {
    if (this.phase === "hidden" || this.phase === "leaving") return;
    clearTimeout(this.timer);
    emit(this, "beforeleave");
    this.phase = "leaving";
    this.report(false);
    for (const [outside, inside] of this.sharedPairs()) {
      outside.fly(inside.getBoundingClientRect(), outside.getBoundingClientRect(), inside);
    }
    this.panel.parentElement!.classList.remove("open");
    emit(this, "leave");
    this.timer = setTimeout(() => {
      this.phase = "hidden";
      this.update();
      emit(this, "afterleave");
    }, this.duration());
  }
}

/**
 * `<share-element>`: a page element and one in a `<page-container>` with the
 * same `key` (or the older `name`) are one element that flies between them as
 * the container opens and closes. The element it lands on flies: its content
 * goes to the top layer, above the overlay and unclipped by the panel, and
 * moves from the other's place to its own while both keep their room.
 */
export class WxShareElement extends Builtin {
  private readonly flight: HTMLElement;
  private readonly hold: HTMLStyleElement;
  private animation?: Animation;
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: block; }
      .flight { display: contents; }
      .flight:popover-open { display: block; position: fixed; inset: auto; margin: 0; padding: 0; border: 0; overflow: visible; background: none; color: inherit; font: inherit; box-sizing: border-box; transform-origin: 0 0; }
    </style><style></style><div class="flight" popover="manual"><slot></slot></div>`);
    this.hold = root.querySelectorAll("style")[1]!;
    this.flight = root.querySelector(".flight")!;
  }
  get shareKey(): string {
    return this.str("key") || this.str("name");
  }
  get animates(): boolean {
    return this.flag("transform");
  }
  /** Flies the content from a place to this element's place, `to`, hiding `other` meanwhile. */
  fly(from: DOMRect, to: DOMRect, other: WxShareElement): void {
    this.animation?.finish();
    const width = this.offsetWidth;
    const height = this.offsetHeight;
    this.hold.textContent = `:host { width: ${width}px !important; height: ${height}px !important; }`;
    other.hide(true);
    Object.assign(this.flight.style, {
      left: `${to.left}px`,
      top: `${to.top}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    this.flight.showPopover();
    const scale = (a: number, b: number) => (b > 0 ? a / b : 1);
    const keyframes = [
      {
        transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${scale(from.width, to.width)}, ${scale(from.height, to.height)})`,
      },
      { transform: `scale(${scale(to.width, width)}, ${scale(to.height, height)})` },
    ];
    const timing = { duration: Math.max(0, this.num("duration", 300)) };
    let animation: Animation;
    try {
      animation = this.flight.animate(keyframes, {
        ...timing,
        easing: this.str("easing-function", "ease-out"),
      });
    } catch {
      // An easing the browser does not know
      animation = this.flight.animate(keyframes, { ...timing, easing: "ease-out" });
    }
    this.animation = animation;
    animation.onfinish = animation.oncancel = () => {
      if (this.animation !== animation) return;
      this.animation = undefined;
      this.flight.hidePopover();
      this.flight.removeAttribute("style");
      this.hold.textContent = "";
      other.hide(false);
    };
  }
  private hide(hidden: boolean): void {
    if (!this.animation) this.hold.textContent = hidden ? ":host { visibility: hidden; }" : "";
  }
}

/**
 * Takes its children out of the page, as if fixed at the top left of the page's
 * root. It is shown in the top layer, so no transformed or clipping ancestor,
 * such as a swiper-item or a scroll-view, moves or cuts it, while it stays in
 * the tree for events, styles and updates.
 */
export class WxRootPortal extends Builtin {
  private readonly placement: HTMLStyleElement;
  constructor() {
    super();
    const root = this.shadow(`<style></style><slot></slot>`);
    this.placement = root.querySelector("style")!;
  }
  connectedCallback(): void {
    this.place();
  }
  protected override update(): void {
    // Undo the top layer's own popover styles
    this.placement.textContent = this.flagOn("enable")
      ? ":host { display: block; position: fixed !important; inset: 0 auto auto 0; width: 100%; height: 0; margin: 0; padding: 0; border: 0; overflow: visible; color: inherit; background: none; }"
      : ":host { display: contents; }";
    this.place();
  }
  /** Leaving the document hides the popover, so it is shown again whenever it is connected. */
  private place(): void {
    if (!this.flagOn("enable")) {
      this.popover = null;
      return;
    }
    this.popover = "manual";
    if (this.isConnected && !this.matches(":popover-open")) this.showPopover();
  }
}

/** Shows its children only while the page matches its media query; updated when the page resizes. */
export class WxMatchMedia extends Builtin {
  private readonly visibility: HTMLStyleElement;
  private query?: MediaQueryList;
  private readonly onChange = () => this.sync();
  constructor() {
    super();
    const root = this.shadow(
      `<style>:host { display: block; }</style><style></style><slot></slot>`,
    );
    this.visibility = root.querySelectorAll("style")[1]!;
  }
  disconnectedCallback(): void {
    this.query?.removeEventListener("change", this.onChange);
  }
  connectedCallback(): void {
    this.query?.addEventListener("change", this.onChange);
  }
  protected override update(): void {
    const media = mediaQueryOf(this.props);
    if (this.query?.media !== window.matchMedia(media).media) {
      this.query?.removeEventListener("change", this.onChange);
      this.query = window.matchMedia(media);
      this.query.addEventListener("change", this.onChange);
    }
    this.sync();
  }
  private sync(): void {
    const css = this.query?.matches === false ? ":host { display: none !important; }" : "";
    if (this.visibility.textContent !== css) this.visibility.textContent = css;
  }
}

/** The page-level settings `<page-meta>` and `<navigation-bar>` carry, sent to the shell. */
export interface PageConfigDetail {
  pageMeta?: Record<string, unknown>;
  navigationBar?: Record<string, unknown>;
}

/** What the shell applies: the navigation bar and the window around the page. */
const NAVIGATION_BAR_PROPS = [
  "title",
  "loading",
  "front-color",
  "background-color",
  "color-animation-duration",
  "color-animation-timing-func",
];
const PAGE_META_SHELL_PROPS = [
  "background-text-style",
  "background-color",
  "background-color-top",
  "background-color-bottom",
  "page-orientation",
];

function announce(detail: PageConfigDetail): void {
  document.dispatchEvent(new CustomEvent<PageConfigDetail>("omr-page-config", { detail }));
}

function pick(props: Record<string, unknown>, names: string[]): Record<string, unknown> {
  return Object.fromEntries(
    names.filter((name) => props[name] !== undefined).map((name) => [name, props[name]]),
  );
}

/**
 * Applies the settings that belong to the page itself (`page-style`,
 * `root-font-size`, `page-font-size`, `root-background-color`, `scroll-top`)
 * and the `scroll` and `resize` events; tells the shell the window settings
 * and those of the `<navigation-bar>` inside it through an `omr-page-config`
 * document event.
 *
 * `navigation-bar` stays an ordinary element rather than a built-in, because
 * projects commonly declare a custom component of that name, which WeChat
 * prefers to the built-in; its attributes are read from the DOM.
 */
export class WxPageMeta extends Builtin {
  private readonly applied = new Applied();
  private sent?: string;
  private sentBar?: string;
  private readonly observer = new MutationObserver(() => this.announceNavigationBar());
  private scrollDone?: ReturnType<typeof setTimeout>;
  private readonly onScroll = () => emit(this, "scroll", { scrollTop: window.scrollY });
  private readonly onResize = () =>
    emit(this, "resize", {
      size: { windowWidth: window.innerWidth, windowHeight: window.innerHeight },
    });
  connectedCallback(): void {
    window.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onResize);
    this.observer.observe(this, { childList: true, attributes: true, subtree: true });
    this.announceNavigationBar();
  }
  disconnectedCallback(): void {
    window.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("resize", this.onResize);
    this.observer.disconnect();
  }
  private announceNavigationBar(): void {
    const bar = [...this.children].find((child) => child.localName === "navigation-bar");
    if (!bar) return;
    const navigationBar: Record<string, unknown> = {};
    for (const name of NAVIGATION_BAR_PROPS) {
      const value = bar.getAttribute(name);
      if (name === "loading") navigationBar.loading = value !== null;
      else if (value !== null) navigationBar[name] = value;
    }
    const key = JSON.stringify(navigationBar);
    if (key === this.sentBar) return;
    this.sentBar = key;
    announce({ navigationBar });
  }
  protected override update(): void {
    const html = document.documentElement;
    const body = document.body;
    if (this.applied.changed("page-style", this.props["page-style"])) {
      body.setAttribute("style", convertStyle(this.str("page-style")));
    }
    const fontSize = (value: string) =>
      value === "" || value === "system"
        ? ""
        : /^\d+(\.\d+)?$/.test(value)
          ? `${value}px`
          : convertStyle(value);
    html.style.fontSize = fontSize(this.str("root-font-size"));
    if (!this.str("page-style").includes("font-size")) {
      body.style.fontSize = fontSize(this.str("page-font-size"));
    }
    html.style.backgroundColor = this.str("root-background-color");
    const scrollTop = this.props["scroll-top"];
    if (
      this.applied.changed("scroll-top", scrollTop) &&
      scrollTop !== undefined &&
      scrollTop !== ""
    ) {
      const duration = this.num("scroll-duration", 300);
      window.scrollTo({ top: lengthOf(scrollTop), behavior: duration > 0 ? "smooth" : "auto" });
      clearTimeout(this.scrollDone);
      this.scrollDone = setTimeout(() => emit(this, "scrolldone"), duration);
    }
    const pageMeta = pick(this.props, PAGE_META_SHELL_PROPS);
    const key = JSON.stringify(pageMeta);
    if (key !== this.sent) {
      this.sent = key;
      announce({ pageMeta });
    }
  }
}
