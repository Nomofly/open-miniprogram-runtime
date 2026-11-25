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

/**
 * `<video>`. `VideoContext` drives it through `omrCall`: full screen covers the
 * page's window (turned sideways for a horizontal video), and danmu cross the
 * video when `enable-danmu` is set.
 */
export class WxVideo extends Builtin {
  private readonly video: HTMLVideoElement;
  private readonly danmu: HTMLElement;
  /** The full screen box, through the shadow root so it wins over page styles. */
  private readonly fullScreenStyle: HTMLStyleElement;
  private fullScreen = false;
  private pictureInPicture = false;
  private danmuRow = 0;
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: inline-block; position: relative; width: 300px; height: 225px; background: #000; overflow: hidden; }
      video { display: block; width: 100%; height: 100%; }
      .danmu { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
      .danmu span { position: absolute; left: 100%; white-space: nowrap; font: 16px/${DANMU_ROW}px sans-serif; text-shadow: 0 0 2px rgba(0, 0, 0, 0.8); }
    </style><style></style><video playsinline></video><div class="danmu"></div><slot></slot>`);
    this.fullScreenStyle = root.querySelectorAll("style")[1]!;
    this.video = root.querySelector("video")!;
    this.danmu = root.querySelector(".danmu")!;
    for (const name of ["play", "pause", "ended", "waiting"]) {
      this.video.addEventListener(name, () => emit(this, name));
    }
    this.video.addEventListener("seeked", () =>
      emit(this, "seekcomplete", { position: this.video.currentTime }),
    );
    this.video.addEventListener("timeupdate", () =>
      emit(this, "timeupdate", {
        currentTime: this.video.currentTime,
        duration: this.video.duration || 0,
      }),
    );
    this.video.addEventListener("loadedmetadata", () =>
      emit(this, "loadedmetadata", {
        width: this.video.videoWidth,
        height: this.video.videoHeight,
        duration: this.video.duration || 0,
      }),
    );
    this.video.addEventListener("error", () => {
      // An empty src is no source, not an error
      if (!this.video.getAttribute("src")) return;
      emit(this, "error", { errMsg: "MEDIA_ERR_SRC_NOT_SUPPORTED" });
    });
  }
  protected override update(): void {
    const src = this.str("src");
    if (!src) {
      if (this.video.hasAttribute("src")) {
        this.video.removeAttribute("src");
        this.video.load();
      }
    } else if (this.video.getAttribute("src") !== src) {
      this.video.setAttribute("src", src);
    }
    const poster = this.str("poster");
    if (poster) this.video.poster = poster;
    else this.video.removeAttribute("poster");
    this.video.controls = this.flagOn("controls");
    this.video.muted = this.flag("muted");
    this.video.loop = this.flag("loop");
    this.video.autoplay = this.flag("autoplay");
    this.video.style.objectFit = this.str("object-fit", "contain");
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
  /** Covers the page's window; a horizontal video turns sideways, as the phone does. */
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
    emit(this, "fullscreenchange", {
      fullScreen: on,
      direction: on && direction !== 0 ? "horizontal" : "vertical",
    });
  }
  private sendDanmu(text: string, color: unknown): void {
    if (!this.flag("enable-danmu") || !text) return;
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
