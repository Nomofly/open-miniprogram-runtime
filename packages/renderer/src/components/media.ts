/** `<image>`, `<cover-image>`, `<video>` and the legacy `<audio>`. */
import { Applied, Builtin, emit } from "./base.ts";

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

const OBJECT_FIT: Record<string, string> = {
  scaleToFill: "fill",
  aspectFit: "contain",
  aspectFill: "cover",
  widthFix: "fill",
  heightFix: "fill",
};

/** `lazy-load` starts loading within three screens of the viewport, as WeChat does. */
const lazyObserver = () =>
  (lazy ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        lazy!.unobserve(entry.target);
        (entry.target as WxImage).reveal();
      }
    },
    { rootMargin: "300% 0px" },
  ));
let lazy: IntersectionObserver | undefined;

export class WxImage extends Builtin {
  private readonly img: HTMLImageElement;
  /** The size `widthFix` and `heightFix` give the host, through the shadow root so it wins over page styles. */
  private readonly sizing: HTMLStyleElement;
  private natural?: { width: number; height: number };
  private visible = false;
  private readonly resize = new ResizeObserver(() => this.fix());
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: inline-block; overflow: hidden; position: relative; width: 320px; height: 240px; }
      img { display: block; width: 100%; height: 100%; object-fit: fill; -webkit-user-drag: none; }
      img:not([src]), img.broken { visibility: hidden; }
      img.fade { transition: opacity 0.3s; }
      img.fade:not(.loaded) { opacity: 0; }
    </style><style></style><img alt="" draggable="false">`);
    this.sizing = root.querySelectorAll("style")[1]!;
    this.img = root.querySelector("img")!;
    this.img.addEventListener("load", () => {
      const { naturalWidth: width, naturalHeight: height } = this.img;
      this.natural = { width, height };
      this.img.classList.add("loaded");
      this.img.classList.remove("broken");
      this.fix();
      emit(this, "load", { width, height });
    });
    this.img.addEventListener("error", () => {
      if (!this.img.getAttribute("src")) return;
      this.natural = undefined;
      // WeChat shows nothing for an image that fails to load
      this.img.classList.add("broken");
      emit(this, "error", { errMsg: `GET ${this.img.getAttribute("src")} 404 (Not Found)` });
    });
  }
  connectedCallback(): void {
    this.resize.observe(this);
    if (this.flag("lazy-load") && !this.visible) lazyObserver().observe(this);
  }
  disconnectedCallback(): void {
    this.resize.disconnect();
    lazy?.unobserve(this);
  }
  reveal(): void {
    this.visible = true;
    this.update();
  }
  protected override update(): void {
    const src = this.str("src");
    if (this.flag("lazy-load") && !this.visible) {
      if (this.isConnected) lazyObserver().observe(this);
    } else if (!src) {
      this.img.removeAttribute("src");
      this.natural = undefined;
    } else if (this.img.getAttribute("src") !== src) {
      this.img.classList.remove("loaded", "broken");
      this.natural = undefined;
      this.img.setAttribute("src", src);
    }
    this.img.classList.toggle("fade", this.flag("fade-in"));
    const mode = this.str("mode", "scaleToFill");
    const position = IMAGE_POSITIONS[mode];
    this.img.style.objectFit = position ? "none" : (OBJECT_FIT[mode] ?? "fill");
    this.img.style.objectPosition = position ?? "";
    this.fix();
  }
  /** `widthFix` keeps the width and sets the height from the image's ratio; `heightFix` the other way round. */
  private fix(): void {
    const mode = this.str("mode");
    const natural = this.natural;
    let css = "";
    if (natural && natural.width > 0 && natural.height > 0) {
      if (mode === "widthFix") {
        css = `:host { height: ${(this.clientWidth * natural.height) / natural.width}px !important; }`;
      } else if (mode === "heightFix") {
        css = `:host { width: ${(this.clientHeight * natural.width) / natural.height}px !important; }`;
      }
    }
    if (this.sizing.textContent !== css) this.sizing.textContent = css;
  }
}

/** The height of a danmu row, in px. */
const DANMU_ROW = 24;
/** How long a danmu takes to cross the video, in milliseconds. */
const DANMU_MS = 6000;
/** How long the controls stay while playing after the last touch, in milliseconds. */
const CONTROLS_MS = 3000;

/** The names of the MediaError codes, which `binderror` gives as its reason. */
const MEDIA_ERRORS: Record<number, string> = {
  1: "MEDIA_ERR_ABORTED",
  2: "MEDIA_ERR_NETWORK",
  3: "MEDIA_ERR_DECODE",
  4: "MEDIA_ERR_SRC_NOT_SUPPORTED",
};

/** A boolean attribute as WeChat reads it: absent is the default, any other value is truthy or not. */
const option = (props: Record<string, unknown>, name: string, fallback: boolean) =>
  props[name] === undefined ? fallback : Boolean(props[name]);

/** Which of `<video>`'s own controls show. */
export interface VideoControls {
  /** The control bar at the bottom, with the times. */
  bar: boolean;
  /** The play/pause button in the bar. */
  play: boolean;
  /** The play/pause button in the middle while the bar shows, for `play-btn-position="center"`. */
  centerToggle: boolean;
  /** The large play button in the middle while paused. */
  centerPlay: boolean;
  progress: boolean;
  mute: boolean;
  fullScreen: boolean;
  danmu: boolean;
  poster: boolean;
}

/** The controls a `<video>` shows for its attributes, while paused or not, at a width in px. */
export function videoControls(
  props: Record<string, unknown>,
  state: { paused: boolean; width: number },
): VideoControls {
  const controls = option(props, "controls", true);
  const playButton = controls && option(props, "show-play-btn", true);
  const center = props["play-btn-position"] === "center";
  const centerPlay = state.paused && option(props, "show-center-play-btn", true);
  return {
    bar: controls,
    play: playButton && !center,
    centerToggle: playButton && center && !centerPlay,
    centerPlay,
    // Unset, the progress bar shows only on a video wider than 240px
    progress: controls && option(props, "show-progress", state.width > 240),
    mute: controls && option(props, "show-mute-btn", false),
    fullScreen: controls && option(props, "show-fullscreen-btn", true),
    danmu: controls && option(props, "danmu-btn", false),
    // WeChat ignores the poster of a video without controls
    poster: controls && Boolean(props.poster),
  };
}

export interface Danmu {
  text: string;
  color: string;
  time: number;
}

/**
 * The `danmu-list` items whose `time` playback passed going from `previous`
 * to `current` seconds: from `previous` included to `current` excluded, and
 * none when time went back or stood still.
 */
export function dueDanmu(list: unknown, previous: number, current: number): Danmu[] {
  if (!Array.isArray(list) || !(current > previous)) return [];
  return list.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const { text, color, time } = item as Record<string, unknown>;
    const at = Number(time);
    if (typeof text !== "string" && typeof text !== "number") return [];
    if (text === "" || !Number.isFinite(at) || at < previous || at >= current) return [];
    return [
      {
        text: String(text),
        color: typeof color === "string" && color ? color : "#ffffff",
        time: at,
      },
    ];
  });
}

/**
 * `bindprogress`'s `buffered`: how far the loaded part reaches, as a whole
 * percentage of the duration. WeChat reports one loaded part: the one holding
 * the current time, else the first.
 */
export function bufferedPercent(
  ranges: { length: number; start(index: number): number; end(index: number): number },
  currentTime: number,
  duration: number,
): number {
  if (!(duration > 0) || !Number.isFinite(duration) || ranges.length === 0) return 0;
  let index = 0;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= currentTime && currentTime <= ranges.end(i)) {
      index = i;
      break;
    }
  }
  return Math.max(0, Math.min(100, Math.round((ranges.end(index) / duration) * 100)));
}

const svg = (body: string, size = 22) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const VIDEO_ICONS = {
  play: svg('<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>'),
  pause: svg('<path d="M8 5v14M16 5v14" stroke-width="3"/>'),
  sound: svg(
    '<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" stroke="none"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/>',
  ),
  muted: svg(
    '<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" stroke="none"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  ),
  enter: svg('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
  exit: svg('<path d="M9 4v5H4M15 4v5h5M15 20v-5h5M9 20v-5H4"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>', 24),
  center:
    '<svg viewBox="0 0 56 56" width="56" height="56"><circle cx="28" cy="28" r="27" fill="rgba(0,0,0,0.35)" stroke="rgba(255,255,255,0.85)" stroke-width="1.5"/><path d="M22.5 17.5v21l17-10.5z" fill="#fff"/></svg>',
};

/**
 * `<video>`. It draws WeChat's controls itself: the play button in the
 * middle while paused, and a bar with play, time, progress, mute, danmu and
 * full screen that hides a few seconds into playback and comes back on a
 * tap. `VideoContext` drives it through `omrCall`. Full screen covers the
 * page's window, turned sideways for a horizontal video, and asks the shell,
 * through an `omr-video-fullscreen` event the view forwards, to grow that
 * window over the navigation bar, capsule and tab bar. Danmu, sent or from
 * `danmu-list`, cross the video while danmu are on.
 */
export class WxVideo extends Builtin {
  private readonly video: HTMLVideoElement;
  private readonly danmu: HTMLElement;
  /** The full screen box, through the shadow root so it wins over page styles. */
  private readonly fullScreenStyle: HTMLStyleElement;
  private readonly parts: Record<
    | "poster"
    | "bar"
    | "play"
    | "current"
    | "progress"
    | "buffered"
    | "played"
    | "thumb"
    | "duration"
    | "mute"
    | "danmuButton"
    | "fullScreen"
    | "centerPlay"
    | "centerToggle"
    | "top"
    | "title",
    HTMLElement
  >;
  private readonly applied = new Applied();
  private readonly resize = new ResizeObserver(() => this.refresh());
  private fullScreen = false;
  private pictureInPicture = false;
  private danmuRow = 0;
  /** Whether danmu show: `enable-danmu` at first, then the danmu button. */
  private danmuOn?: boolean;
  /** Where `danmu-list` was last checked, in seconds. */
  private danmuClock = 0;
  private controlsShown = true;
  /** Whether the source played yet: the poster shows until it does. */
  private started = false;
  private hideTimer?: ReturnType<typeof setTimeout>;
  /** `initial-time` waits for the source's metadata; its seek is not the user's. */
  private initialSeek: "pending" | "seeking" | "" = "";
  private lastBuffered = -1;
  /** Where a drag on the progress bar would seek to, while dragging. */
  private scrub?: number;
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: inline-block; position: relative; width: 300px; height: 225px; background: #000; overflow: hidden; color: #fff; font: 12px/1 -apple-system, "PingFang SC", sans-serif; -webkit-tap-highlight-color: transparent; }
      video { display: block; width: 100%; height: 100%; }
      [hidden] { display: none !important; }
      button { all: unset; display: flex; flex: none; align-items: center; justify-content: center; cursor: pointer; }
      .poster { position: absolute; inset: 0; background: #000 center / contain no-repeat; pointer-events: none; }
      .danmu { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
      .danmu span { position: absolute; left: 100%; white-space: nowrap; font: 16px/${DANMU_ROW}px sans-serif; text-shadow: 0 0 2px rgba(0, 0, 0, 0.8); }
      .center { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); }
      .toggle { width: 48px; height: 48px; border-radius: 50%; background: rgba(0, 0, 0, 0.35); }
      .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 44px; box-sizing: border-box; padding: 0 10px; display: flex; align-items: center; gap: 8px; background: linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.55)); }
      .bar button { width: 28px; height: 28px; }
      .time { flex: none; font-variant-numeric: tabular-nums; }
      .progress { flex: 1; align-self: stretch; display: flex; align-items: center; touch-action: none; cursor: pointer; }
      .progress.off { visibility: hidden; pointer-events: none; }
      .track { position: relative; flex: 1; height: 2px; background: rgba(255, 255, 255, 0.3); }
      .buffered, .played { position: absolute; left: 0; top: 0; bottom: 0; width: 0; }
      .buffered { background: rgba(255, 255, 255, 0.55); }
      .played { background: #fff; }
      .thumb { position: absolute; top: 50%; left: 0; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; background: #fff; }
      .bar .danmu-button { width: auto; height: 18px; padding: 0 5px; border: 1px solid rgba(255, 255, 255, 0.85); border-radius: 3px; font-size: 11px; }
      .bar .danmu-button.on { border-color: #07c160; color: #07c160; }
      .top { position: absolute; left: 0; right: 0; top: 0; height: 44px; box-sizing: border-box; padding: 0 12px 0 6px; display: flex; align-items: center; gap: 4px; background: linear-gradient(rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0)); font-size: 16px; }
      .top button { width: 32px; height: 32px; }
      .title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    </style><style></style><video playsinline></video><div class="poster" hidden></div><div class="danmu"></div><button class="center toggle" type="button" hidden></button><button class="center center-play" type="button" aria-label="play" hidden>${VIDEO_ICONS.center}</button><div class="top" hidden><button class="back" type="button" aria-label="exit full screen">${VIDEO_ICONS.back}</button><span class="title"></span></div><div class="bar"><button class="play" type="button" aria-label="play"></button><span class="time current">00:00</span><div class="progress"><div class="track"><div class="buffered"></div><div class="played"></div><div class="thumb"></div></div></div><span class="time duration">00:00</span><button class="mute" type="button" aria-label="mute"></button><button class="danmu-button" type="button">弹幕</button><button class="fullscreen" type="button" aria-label="full screen"></button></div><slot></slot>`);
    this.fullScreenStyle = root.querySelectorAll("style")[1]!;
    this.video = root.querySelector("video")!;
    this.danmu = root.querySelector(".danmu")!;
    const part = (selector: string) => root.querySelector<HTMLElement>(selector)!;
    this.parts = {
      poster: part(".poster"),
      bar: part(".bar"),
      play: part(".play"),
      current: part(".current"),
      progress: part(".progress"),
      buffered: part(".buffered"),
      played: part(".played"),
      thumb: part(".thumb"),
      duration: part(".duration"),
      mute: part(".mute"),
      danmuButton: part(".danmu-button"),
      fullScreen: part(".fullscreen"),
      centerPlay: part(".center-play"),
      centerToggle: part(".toggle"),
      top: part(".top"),
      title: part(".title"),
    };
    this.listenToVideo();
    this.listenToControls();
  }
  connectedCallback(): void {
    this.resize.observe(this);
  }
  disconnectedCallback(): void {
    this.resize.disconnect();
    clearTimeout(this.hideTimer);
    // A full-screen video that leaves the page gives the screen back
    if (this.fullScreen) {
      this.fullScreen = false;
      this.fullScreenStyle.textContent = "";
      this.notifyFullScreen(false);
    }
  }
  private listenToVideo(): void {
    const video = this.video;
    video.addEventListener("play", () => {
      this.started = true;
      this.showControls(true);
      emit(this, "play");
    });
    for (const name of ["pause", "ended"]) {
      video.addEventListener(name, () => {
        this.showControls(true);
        emit(this, name);
      });
    }
    video.addEventListener("waiting", () => emit(this, "waiting"));
    video.addEventListener("volumechange", () => this.refresh());
    video.addEventListener("seeking", () => (this.danmuClock = video.currentTime));
    video.addEventListener("seeked", () => {
      if (this.initialSeek === "seeking") this.initialSeek = "";
      else emit(this, "seekcomplete", { position: video.currentTime });
    });
    video.addEventListener("timeupdate", () => {
      this.refreshTime();
      this.reportBuffered();
      const now = video.currentTime;
      const due = dueDanmu(this.props["danmu-list"], this.danmuClock, now);
      this.danmuClock = now;
      for (const item of due) this.sendDanmu(item.text, item.color);
      emit(this, "timeupdate", { currentTime: now, duration: video.duration || 0 });
    });
    video.addEventListener("progress", () => this.reportBuffered());
    video.addEventListener("loadedmetadata", () => {
      const initial = this.num("initial-time", 0);
      if (this.initialSeek === "pending" && initial > 0) {
        this.initialSeek = "seeking";
        video.currentTime = initial;
      } else this.initialSeek = "";
      this.refreshTime();
      emit(this, "loadedmetadata", {
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration || 0,
      });
    });
    video.addEventListener("error", () => {
      // An empty src is no source, not an error
      if (!video.getAttribute("src")) return;
      emit(this, "error", {
        errMsg: MEDIA_ERRORS[video.error?.code ?? 4] ?? MEDIA_ERRORS[4]!,
      });
    });
  }
  private listenToControls(): void {
    const { parts, video } = this;
    const togglePlay = () => {
      if (video.paused) this.play();
      else video.pause();
      this.showControls(true);
    };
    parts.play.addEventListener("click", togglePlay);
    parts.centerToggle.addEventListener("click", togglePlay);
    parts.centerPlay.addEventListener("click", togglePlay);
    parts.mute.addEventListener("click", () => {
      video.muted = !video.muted;
      this.showControls(true);
    });
    parts.danmuButton.addEventListener("click", () => {
      this.danmuOn = !this.danmuOn;
      if (!this.danmuOn) this.danmu.replaceChildren();
      this.showControls(true);
    });
    parts.fullScreen.addEventListener("click", () => {
      this.setFullScreen(!this.fullScreen);
      this.showControls(true);
    });
    parts.top.querySelector(".back")!.addEventListener("click", () => this.setFullScreen(false));
    // A tap on the picture shows or hides the controls
    video.addEventListener("click", () => {
      if (this.flagOn("controls")) this.showControls(!this.controlsShown);
    });
    // Dragging along the progress bar seeks where it is let go
    const fraction = (event: PointerEvent) => {
      const box = parts.progress.querySelector(".track")!.getBoundingClientRect();
      return box.width > 0 ? Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) : 0;
    };
    parts.progress.addEventListener("pointerdown", (event) => {
      if (!(video.duration > 0)) return;
      try {
        parts.progress.setPointerCapture(event.pointerId);
      } catch {
        // The pointer is already gone
      }
      this.scrub = fraction(event) * video.duration;
      this.refreshTime();
      this.showControls(true);
    });
    parts.progress.addEventListener("pointermove", (event) => {
      if (this.scrub === undefined) return;
      this.scrub = fraction(event) * video.duration;
      this.refreshTime();
    });
    const release = () => {
      if (this.scrub === undefined) return;
      video.currentTime = this.scrub;
      this.scrub = undefined;
      this.showControls(true);
    };
    parts.progress.addEventListener("pointerup", release);
    parts.progress.addEventListener("pointercancel", release);
  }
  protected override update(): void {
    const { applied, video } = this;
    this.danmuOn ??= this.flag("enable-danmu");
    const src = this.str("src");
    if (applied.changed("src", src)) {
      this.initialSeek = "pending";
      this.started = false;
      this.danmuClock = 0;
      this.lastBuffered = -1;
      if (src) video.setAttribute("src", src);
      else if (video.hasAttribute("src")) {
        video.removeAttribute("src");
        video.load();
      }
      // The browser's own autoplay gives up silently when sound is not allowed
      if (src && this.flag("autoplay")) this.play();
    }
    // Only a change from the logic layer overrides what the user chose on the controls
    const muted = this.flag("muted");
    if (applied.changed("muted", muted)) video.muted = muted;
    const loop = this.flag("loop");
    if (applied.changed("loop", loop)) video.loop = loop;
    // The browser's own poster goes at the first seek, such as initial-time's; WeChat's stays until playback
    const poster = this.str("poster");
    if (applied.changed("poster", poster)) {
      this.parts.poster.style.backgroundImage = poster ? `url(${JSON.stringify(poster)})` : "";
    }
    video.style.objectFit = this.str("object-fit", "contain");
    this.refresh();
  }
  /** Shows the controls for the current attributes and state. */
  private refresh(): void {
    const { parts, video } = this;
    const plan = videoControls(this.props, { paused: video.paused, width: this.clientWidth });
    const shown = this.controlsShown;
    const icon = (el: HTMLElement, name: keyof typeof VIDEO_ICONS) => {
      if (el.dataset.icon === name) return;
      el.dataset.icon = name;
      el.innerHTML = VIDEO_ICONS[name];
    };
    parts.poster.hidden = !plan.poster || this.started;
    parts.bar.hidden = !plan.bar || !shown;
    parts.play.hidden = !plan.play;
    icon(parts.play, video.paused ? "play" : "pause");
    parts.centerToggle.hidden = !plan.centerToggle || !shown;
    icon(parts.centerToggle, video.paused ? "play" : "pause");
    parts.centerPlay.hidden = !plan.centerPlay;
    parts.progress.classList.toggle("off", !plan.progress);
    parts.mute.hidden = !plan.mute;
    icon(parts.mute, video.muted ? "muted" : "sound");
    parts.danmuButton.hidden = !plan.danmu;
    parts.danmuButton.classList.toggle("on", Boolean(this.danmuOn));
    parts.fullScreen.hidden = !plan.fullScreen;
    icon(parts.fullScreen, this.fullScreen ? "exit" : "enter");
    // The title shows at the top in full screen, with the way back
    parts.top.hidden = !this.fullScreen || !shown;
    parts.title.textContent = this.str("title");
    this.refreshTime();
  }
  private refreshTime(): void {
    const { parts, video } = this;
    const duration = video.duration > 0 && Number.isFinite(video.duration) ? video.duration : 0;
    const time = this.scrub ?? video.currentTime;
    parts.current.textContent = formatTime(time);
    // `duration` names the length to show, before the metadata says or instead of it
    parts.duration.textContent = formatTime(this.num("duration", 0) || duration);
    const played = duration ? `${Math.min(100, (time / duration) * 100)}%` : "0%";
    parts.played.style.width = played;
    parts.thumb.style.left = played;
  }
  /** Shows or hides the controls; while playing they hide again a few seconds after the last touch. */
  private showControls(show: boolean): void {
    clearTimeout(this.hideTimer);
    if (show && !this.video.paused) {
      this.hideTimer = setTimeout(() => this.showControls(false), CONTROLS_MS);
    }
    if (show !== this.controlsShown) {
      this.controlsShown = show;
      if (this.flagOn("controls")) emit(this, "controlstoggle", { show });
    }
    this.refresh();
  }
  private reportBuffered(): void {
    const { video } = this;
    const buffered = bufferedPercent(video.buffered, video.currentTime, video.duration);
    this.parts.buffered.style.width = `${buffered}%`;
    if (buffered === this.lastBuffered) return;
    this.lastBuffered = buffered;
    emit(this, "progress", { buffered });
  }
  omrCall(method: string, args: unknown[]): void {
    const options = (args[0] ?? {}) as Record<string, unknown>;
    switch (method) {
      case "play":
        this.play();
        break;
      case "pause":
        this.video.pause();
        break;
      case "stop":
        this.video.pause();
        this.video.currentTime = 0;
        break;
      case "seek": {
        const position = Number(args[0]);
        if (Number.isFinite(position)) this.video.currentTime = Math.max(0, position);
        break;
      }
      case "playbackRate": {
        const rate = Number(args[0]);
        if (rate > 0) this.video.playbackRate = rate;
        break;
      }
      case "requestFullScreen":
        this.setFullScreen(true, options.direction);
        break;
      case "exitFullScreen":
        this.setFullScreen(false);
        break;
      case "sendDanmu":
        this.sendDanmu(typeof options.text === "string" ? options.text : "", options.color);
        break;
      case "requestPictureInPicture":
      case "exitPictureInPicture": {
        const entering = method === "requestPictureInPicture";
        if (entering === this.pictureInPicture) break;
        this.pictureInPicture = entering;
        emit(this, entering ? "enterpictureinpicture" : "leavepictureinpicture");
        break;
      }
      // The status bar, background playback and casting have nothing to show in the simulator
    }
  }
  private play(): void {
    void this.video.play().catch((error: unknown) => {
      // Without a user gesture the browser only plays muted video; the simulator has no sound to lose
      if ((error as Error)?.name !== "NotAllowedError") return;
      this.video.muted = true;
      void this.video.play().catch(() => {});
    });
  }
  /** Covers the page's window, which the shell grows to the whole screen; a horizontal video turns sideways, as the phone does. */
  private setFullScreen(on: boolean, requested?: unknown): void {
    if (on === this.fullScreen) return;
    const asked = requested ?? this.props.direction;
    let direction = asked === undefined || asked === null || asked === "" ? NaN : Number(asked);
    if (![0, 90, -90].includes(direction)) {
      // Unset: from the video's aspect ratio
      direction = this.video.videoWidth > this.video.videoHeight ? -90 : 0;
    }
    this.fullScreen = on;
    const box =
      "position: fixed !important; top: 0 !important; left: 0 !important; z-index: 10000 !important; margin: 0 !important; border-radius: 0 !important;";
    this.fullScreenStyle.textContent = !on
      ? ""
      : direction === 0
        ? `:host { ${box} width: 100vw !important; height: 100vh !important; }`
        : `:host { ${box} width: 100vh !important; height: 100vw !important; transform-origin: top left !important; transform: ${
            direction === 90
              ? "translateY(100vh) rotate(-90deg)"
              : "translateX(100vw) rotate(90deg)"
          } !important; }`;
    this.notifyFullScreen(on);
    this.refresh();
    emit(this, "fullscreenchange", {
      fullScreen: on,
      direction: on && direction !== 0 ? "horizontal" : "vertical",
    });
  }
  /** Asks the shell, through the view and the logic layer, to raise the page over its chrome or put it back. */
  private notifyFullScreen(on: boolean): void {
    document.dispatchEvent(
      new CustomEvent("omr-video-fullscreen", { detail: { video: this, fullScreen: on } }),
    );
  }
  private sendDanmu(text: string, color: unknown): void {
    if (!this.danmuOn || !text) return;
    const item = document.createElement("span");
    item.textContent = text;
    item.style.color = typeof color === "string" && color ? color : "#fff";
    const rows = Math.max(1, Math.floor((this.danmu.clientHeight - 8) / DANMU_ROW));
    item.style.top = `${4 + (this.danmuRow++ % rows) * DANMU_ROW}px`;
    this.danmu.append(item);
    const distance = this.danmu.clientWidth + item.offsetWidth;
    item
      .animate([{ transform: "translateX(0)" }, { transform: `translateX(${-distance}px)` }], {
        duration: DANMU_MS,
        easing: "linear",
      })
      .finished.then(
        () => item.remove(),
        () => item.remove(),
      );
  }
}

const PLAY_ICON =
  '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="11" fill="rgba(0,0,0,0.3)" stroke="#fff" stroke-width="1.2"/><path d="M10 8l6 4-6 4z" fill="#fff"/></svg>';
const PAUSE_ICON =
  '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="11" fill="rgba(0,0,0,0.3)" stroke="#fff" stroke-width="1.2"/><path d="M9.5 8v8M14.5 8v8" stroke="#fff" stroke-width="1.8"/></svg>';

const formatTime = (seconds: number) => {
  const total = Math.floor(Number.isFinite(seconds) ? seconds : 0);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

/** The legacy `<audio>`: with `controls`, a card with the poster, name, author and time. */
export class WxAudio extends Builtin {
  private readonly audio: HTMLAudioElement;
  private readonly card: HTMLElement;
  private readonly poster: HTMLElement;
  private readonly button: HTMLElement;
  private readonly name: HTMLElement;
  private readonly author: HTMLElement;
  private readonly time: HTMLElement;
  private readonly applied = new Applied();
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: inline-block; }
      .card { display: flex; width: 290px; height: 65px; box-sizing: content-box; border: 1px solid #e0e0e0; border-radius: 3px; background: #fcfcfc; overflow: hidden; font-family: inherit; }
      .card[hidden] { display: none; }
      .poster { position: relative; flex: none; width: 65px; height: 65px; background: #e6e6e6 center / cover no-repeat; display: flex; align-items: center; justify-content: center; cursor: pointer; }
      .info { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; padding: 0 12px; }
      .row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      .name { font-size: 14px; color: #353535; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .time { flex: none; font-size: 13px; color: #888; }
      .author { margin-top: 9px; font-size: 12px; color: #888; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    </style><div class="card" hidden><div class="poster"><span class="button"></span></div><div class="info"><div class="row"><span class="name"></span><span class="time">00:00</span></div><div class="author"></div></div></div><audio></audio>`);
    this.audio = root.querySelector("audio")!;
    this.card = root.querySelector(".card")!;
    this.poster = root.querySelector(".poster")!;
    this.button = root.querySelector(".button")!;
    this.name = root.querySelector(".name")!;
    this.author = root.querySelector(".author")!;
    this.time = root.querySelector(".time")!;
    this.button.innerHTML = PLAY_ICON;
    this.poster.addEventListener("click", () => {
      if (!this.audio.getAttribute("src")) return;
      if (this.audio.paused) void this.audio.play().catch(() => {});
      else this.audio.pause();
    });
    this.audio.addEventListener("play", () => {
      this.button.innerHTML = PAUSE_ICON;
      emit(this, "play");
    });
    this.audio.addEventListener("pause", () => {
      this.button.innerHTML = PLAY_ICON;
      emit(this, "pause");
    });
    this.audio.addEventListener("ended", () => emit(this, "ended"));
    this.audio.addEventListener("timeupdate", () => {
      this.time.textContent = formatTime(this.audio.currentTime);
      emit(this, "timeupdate", {
        currentTime: this.audio.currentTime,
        duration: this.audio.duration || 0,
      });
    });
    this.audio.addEventListener("error", () => {
      if (!this.audio.getAttribute("src")) return;
      // MediaError codes, as the audio component reports them
      emit(this, "error", { errMsg: this.audio.error?.code ?? 4 });
    });
  }
  protected override update(): void {
    const src = this.str("src");
    if (this.applied.changed("src", src)) {
      if (src) this.audio.setAttribute("src", src);
      else this.audio.removeAttribute("src");
    }
    this.audio.loop = this.flag("loop");
    this.card.hidden = !this.flag("controls");
    const poster = this.str("poster");
    this.poster.style.backgroundImage = poster ? `url(${JSON.stringify(poster)})` : "";
    // Labels as WeChat shows them
    this.name.textContent = this.str("name", "未知音频") || "未知音频";
    this.author.textContent = this.str("author", "未知作者") || "未知作者";
  }
}
