/**
 * `<ad>` (banner ads) and `<ad-custom>` (native template ads). The simulator
 * shows a mock ad card instead of a real ad: `ad` in `omr.config.json` says
 * whether ads fill, firing `load`, or fail, firing `error` and taking no height,
 * as WeChat does when there is no ad to show. Ads never raise `tap`.
 */
import type { AdConfig } from "@omr/runtime";
import { Builtin, emit } from "./base.ts";

let adConfig: AdConfig = {};

/** Sets how ads on this page load; the view calls it with the simulator's `ad` config. */
export function setAdConfig(config: AdConfig | undefined): void {
  adConfig = config ?? {};
}

/** The reasons of WeChat's ad error codes, as its error code table names them. */
const AD_ERRORS: Record<number, string> = {
  1000: "后端错误调用失败",
  1001: "参数错误",
  1002: "广告单元无效",
  1003: "内部错误",
  1004: "无适合的广告",
  1005: "广告组件审核中",
  1006: "广告组件被驳回",
  1007: "广告组件被封禁",
  1008: "广告单元已关闭",
};
const DEFAULT_ERROR = 1004;
/** How long a mock ad takes to load, in milliseconds. */
const LOAD_DELAY = 50;
/** `ad-intervals` below this many seconds does not refresh the ad. */
const MIN_INTERVAL = 30;

const STYLE = `
  :host { display: block; }
  .card { --bg: #fff; --fg: rgba(0, 0, 0, 0.9); --sub: rgba(0, 0, 0, 0.5); --line: rgba(0, 0, 0, 0.08); position: relative; display: flex; gap: 12px; padding: 12px; box-sizing: border-box; background: var(--bg); color: var(--fg); border: 1px solid var(--line); font-size: 14px; line-height: 1.4; overflow: hidden; }
  .card.black { --bg: #2c2c2c; --fg: rgba(255, 255, 255, 0.9); --sub: rgba(255, 255, 255, 0.5); --line: rgba(255, 255, 255, 0.1); }
  .media { position: relative; flex: none; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, hsl(var(--hue), 70%, 62%), hsl(calc(var(--hue) + 50), 70%, 48%)); color: rgba(255, 255, 255, 0.9); border-radius: 4px; overflow: hidden; }
  .banner .media { width: 112px; height: 63px; }
  .info { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 4px; padding-right: 20px; }
  .title { font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .desc { color: var(--sub); font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .badge { position: absolute; right: 8px; bottom: 8px; padding: 0 4px; border: 1px solid var(--sub); border-radius: 2px; color: var(--sub); font-size: 10px; line-height: 14px; }
  .close { position: absolute; top: 4px; right: 6px; width: 20px; height: 20px; color: var(--sub); font-size: 18px; line-height: 20px; text-align: center; cursor: pointer; }
  .video { flex-direction: column; }
  .video .media { width: 100%; aspect-ratio: 16 / 9; }
  .video .info { padding-right: 56px; }
  .play { width: 44px; height: 44px; border-radius: 50%; background: rgba(0, 0, 0, 0.35); display: flex; align-items: center; justify-content: center; }
  .play::after { content: ""; margin-left: 4px; border-style: solid; border-width: 9px 0 9px 15px; border-color: transparent transparent transparent #fff; }
  .grid { flex-direction: column; padding-bottom: 28px; }
  .grid .apps { display: flex; justify-content: space-between; gap: 8px; padding-right: 20px; }
  .grid .app { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 11px; color: var(--sub); }
  .grid .media { width: 44px; height: 44px; border-radius: 10px; }
  .custom .media { width: 56px; height: 56px; border-radius: 8px; }
  .custom .info { padding-right: 0; }
  .action { flex: none; align-self: center; padding: 4px 12px; border-radius: 4px; background: #07c160; color: #fff; font-size: 13px; }
  .custom .badge { position: static; align-self: flex-start; }
`;

/** Without an ad the element takes no height; important shadow styles win over the page's. */
const COLLAPSED =
  ":host { height: 0 !important; min-height: 0 !important; padding-top: 0 !important; padding-bottom: 0 !important; border-top-width: 0 !important; border-bottom-width: 0 !important; overflow: hidden !important; }";

const IMAGE_ICON =
  '<svg viewBox="0 0 24 24" width="28" height="28"><path d="M3 18l5-6 4 4 3-3 6 5z" fill="currentColor"/><circle cx="16" cy="8" r="2" fill="currentColor"/></svg>';

/** A `div` of the card; `html` is fixed markup, `text` may come from the page. */
function div(className: string, html = "", text?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  el.innerHTML = html;
  if (text !== undefined) el.textContent = text;
  return el;
}

abstract class MockAd extends Builtin {
  private readonly root: ShadowRoot;
  private state: "loading" | "filled" | "closed" | "error" = "loading";
  private loadTimer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private interval = 0;
  /** How many times the ad has refreshed, so each refresh shows another ad. */
  private refreshes = 0;
  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    // Ads raise no tap: the view raises it from clicks that reach the document
    this.addEventListener("click", (event) => event.stopPropagation());
    this.render();
  }
  connectedCallback(): void {
    if (this.state === "loading" && !this.loadTimer) {
      this.loadTimer = setTimeout(() => this.load(), LOAD_DELAY);
    }
    this.schedule();
  }
  disconnectedCallback(): void {
    clearTimeout(this.loadTimer);
    this.loadTimer = undefined;
    this.schedule();
  }
  protected override update(): void {
    this.schedule();
    this.render();
  }
  private load(): void {
    this.loadTimer = undefined;
    const errCode = !this.str("unit-id")
      ? 1001
      : adConfig.result === "error"
        ? (adConfig.errCode ?? DEFAULT_ERROR)
        : undefined;
    this.state = errCode === undefined ? "filled" : "error";
    this.render();
    if (errCode === undefined) emit(this, "load");
    else emit(this, "error", { errCode, errMsg: AD_ERRORS[errCode] ?? AD_ERRORS[1003]! });
  }
  /** `ad-intervals` of at least 30 seconds loads another ad on that interval. */
  private schedule(): void {
    const seconds = this.num("ad-intervals", 0);
    const interval = this.isConnected && seconds >= MIN_INTERVAL ? seconds * 1000 : 0;
    if (interval === this.interval) return;
    clearInterval(this.refreshTimer);
    this.interval = interval;
    this.refreshTimer = interval ? setInterval(() => this.refresh(), interval) : undefined;
  }
  private refresh(): void {
    if (this.state !== "filled") return;
    this.refreshes++;
    this.render();
    emit(this, "load");
  }
  protected close(): void {
    this.state = "closed";
    this.render();
    emit(this, "close");
  }
  private render(): void {
    const filled = this.state === "filled";
    this.root.innerHTML = `<style>${STYLE}${filled ? "" : COLLAPSED}</style>`;
    if (!filled) return;
    const card = document.createElement("div");
    card.className = `card${this.str("ad-theme") === "black" ? " black" : ""}`;
    const hue = (200 + this.refreshes * 67) % 360;
    card.style.setProperty("--hue", String(hue));
    this.fill(card, hue);
    this.root.append(card);
  }
  /** Draws the mock ad into the card. */
  protected abstract fill(card: HTMLElement, hue: number): void;
  /** The title and description of the mock ad; the description names the ad unit. */
  protected info(title: string): HTMLElement {
    const info = div("info");
    info.append(div("title", "", title), div("desc", "", `unit-id: ${this.str("unit-id")}`));
    return info;
  }
  protected badge(): HTMLElement {
    return div("badge", "", "广告");
  }
}

/** `<ad>`: a banner, video or grid ad, by `ad-type`, with a close button. */
export class WxAd extends MockAd {
  protected override fill(card: HTMLElement, hue: number): void {
    const type = this.str("ad-type", "banner");
    const close = div("close", "", "×");
    close.setAttribute("role", "button");
    close.setAttribute("aria-label", "close");
    close.addEventListener("click", () => this.close());
    if (type === "grid") {
      card.classList.add("grid");
      const apps = div("apps");
      for (let i = 1; i <= 5; i++) {
        const app = div("app");
        const icon = div("media", IMAGE_ICON);
        icon.style.setProperty("--hue", String((hue + i * 40) % 360));
        app.append(icon, `应用 ${i}`);
        apps.append(app);
      }
      card.append(apps);
    } else if (type === "video") {
      card.classList.add("video");
      card.append(div("media", '<span class="play"></span>'), this.info("模拟视频广告"));
    } else {
      card.classList.add("banner");
      card.append(div("media", IMAGE_ICON), this.info("模拟广告"));
    }
    card.append(this.badge(), close);
  }
}

/** `<ad-custom>`: a native template ad, drawn as a generic app promotion card. */
export class WxAdCustom extends MockAd {
  protected override fill(card: HTMLElement): void {
    card.classList.add("custom");
    const info = this.info("模拟原生模板广告");
    info.append(this.badge());
    card.append(div("media", IMAGE_ICON), info, div("action", "", "查看详情"));
  }
}
