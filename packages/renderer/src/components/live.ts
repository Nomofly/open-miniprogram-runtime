/**
 * `<live-player>` and `<live-pusher>`, native components WeChat fills with a
 * live stream. The simulator has no stream: it draws a moving picture and
 * fires the `statechange` codes and the `netstatus` info WeChat documents, and
 * their contexts drive them through `omrCall`. Going to the background suspends
 * both (codes 6000 and 5000) until the app comes back.
 */
import { Builtin, emit } from "./base.ts";

/** How often `netstatus` fires while a stream plays or pushes. */
const NET_STATUS_MS = 1000;
/** The pause between the codes of one sequence, such as connecting, then playing. */
const STEP_MS = 150;

/** Stream addresses `<live-player>` plays: RTMP, or FLV over HTTP. */
const PLAYABLE = /^(?:rtmp:\/\/.+|https?:\/\/[^?#]+\.flv(?:[?#].*)?)$/i;
/** Stream addresses `<live-pusher>` pushes to. */
const PUSHABLE = /^rtmp:\/\/.+/i;

const STYLE = `
  :host { display: block; position: relative; background: #000; overflow: hidden; }
  .screen { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; container-type: size; overflow: hidden; color: rgba(255, 255, 255, 0.75); font: 12px/1.4 sans-serif; }
  .picture { position: relative; flex: none; overflow: hidden; background: linear-gradient(120deg, #3a4a63, #6a5470, #2f5d62, #3a4a63) 0 0 / 300% 300%; animation: omr-live-drift 6s linear infinite; }
  .picture::before { content: ""; position: absolute; left: 50%; top: 22%; width: 22%; aspect-ratio: 1; transform: translateX(-50%); border-radius: 50%; background: rgba(255, 255, 255, 0.35); }
  .picture::after { content: ""; position: absolute; left: 50%; bottom: 0; width: 48%; height: 38%; transform: translateX(-50%); border-radius: 50% 50% 0 0; background: rgba(255, 255, 255, 0.25); }
  .frozen .picture { animation-play-state: paused; }
  .picture[hidden] { display: none; }
  .badge { position: absolute; left: 8px; top: 8px; padding: 1px 6px; border-radius: 3px; background: #fa5151; color: #fff; font-weight: 600; }
  .badge[hidden], .note[hidden] { display: none; }
  .note { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); padding: 4px 10px; border-radius: 4px; background: rgba(0, 0, 0, 0.55); color: #fff; white-space: nowrap; }
  .label { position: absolute; left: 8px; right: 8px; bottom: 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  @keyframes omr-live-drift { to { background-position: 300% 300%; } }
`;

/** What the two components share: the moving picture, timed state codes and the netstatus timer. */
abstract class LiveStream extends Builtin {
  protected readonly screen: HTMLElement;
  protected readonly picture: HTMLElement;
  protected readonly badge: HTMLElement;
  protected readonly note: HTMLElement;
  protected readonly label: HTMLElement;
  private steps: ReturnType<typeof setTimeout>[] = [];
  private net?: ReturnType<typeof setInterval>;
  constructor(extraStyle: string) {
    super();
    const root = this.shadow(
      `<style>${STYLE}${extraStyle}</style><div class="screen"><div class="picture" hidden></div><span class="badge" hidden>LIVE</span><span class="note" hidden></span><span class="label"></span></div><slot></slot>`,
    );
    this.screen = root.querySelector(".screen")!;
    this.picture = root.querySelector(".picture")!;
    this.badge = root.querySelector(".badge")!;
    this.note = root.querySelector(".note")!;
    this.label = root.querySelector(".label")!;
  }
  disconnectedCallback(): void {
    this.halt();
  }
  /** Fires `statechange` with each code in turn, then runs `then`. */
  protected codes(codes: number[], then?: () => void): void {
    codes.forEach((code, index) => {
      this.steps.push(setTimeout(() => emit(this, "statechange", { code }), index * STEP_MS));
    });
    if (then) this.steps.push(setTimeout(then, codes.length * STEP_MS));
  }
  /** Fires `netstatus` every second with the info the stream has then. */
  protected reportNet(info: () => Record<string, number>): void {
    clearInterval(this.net);
    this.net = setInterval(() => emit(this, "netstatus", { info: info() }), NET_STATUS_MS);
  }
  /** Stops the codes still to come and the netstatus timer. */
  protected halt(): void {
    for (const step of this.steps) clearTimeout(step);
    this.steps = [];
    clearInterval(this.net);
    this.net = undefined;
  }
  protected setNote(text: string): void {
    this.note.hidden = text === "";
    this.note.textContent = text;
  }
  /** The page was hidden or shown again; `background` when the app went to or came back from the background. */
  abstract omrPageVisibility(visible: boolean, background: boolean): void;
}

/** A number around `base` that moves a little each second, as live bitrates do. */
const around = (base: number, spread: number) =>
  Math.round(base + (Math.random() * 2 - 1) * spread);

/**
 * `<live-player>`, 300×225 by default. `src` must be an RTMP or FLV address;
 * playing it fires 2001, 2002, 2008, 2026, 2003 and 2004 and then `netstatus`,
 * any other address fires -2302. Leaving for another page pauses it unless
 * `auto-pause-if-navigate` is false.
 */
export class WxLivePlayer extends LiveStream {
  private state: "idle" | "playing" | "paused" = "idle";
  private suspended = false;
  /** A play asked for while the Mini Program was in the background, started when it returns. */
  private playOnShow = false;
  private muted?: boolean;
  private fullScreen = false;
  private readonly fullScreenStyle: HTMLStyleElement;
  private src?: string;
  constructor() {
    super(`
      .picture { aspect-ratio: 16 / 9; width: min(100cqw, 100cqh * 16 / 9); }
      .fill .picture { width: max(100cqw, 100cqh * 16 / 9); }
      .horizontal .picture { aspect-ratio: 9 / 16; width: min(100cqw, 100cqh * 9 / 16); }
      .horizontal.fill .picture { width: max(100cqw, 100cqh * 9 / 16); }
    `);
    this.fullScreenStyle = this.shadowRoot!.appendChild(document.createElement("style"));
  }
  protected override update(): void {
    this.screen.classList.toggle("fill", this.str("object-fit") === "fillCrop");
    this.screen.classList.toggle("horizontal", this.str("orientation") === "horizontal");
    const src = this.str("src");
    if (src !== this.src) {
      const first = this.src === undefined;
      this.src = src;
      // A new address starts over; autoplay plays it, as does a player that was playing
      // or had a play queued for the app's return
      const wasPlaying = this.state !== "idle" || this.playOnShow;
      this.stop();
      if (src && (this.flag("autoplay") || (!first && wasPlaying))) this.play();
    }
    this.render();
  }
  private play(): void {
    if (this.suspended) {
      if (this.state === "idle") this.playOnShow = true;
      return;
    }
    if (this.state === "playing") return;
    if (this.state === "paused") {
      this.resume();
      return;
    }
    const src = this.str("src");
    if (!src) return;
    if (!PLAYABLE.test(src)) {
      this.codes([-2302]);
      this.render("无法拉流：仅支持 rtmp 和 flv 地址");
      return;
    }
    this.state = "playing";
    this.render();
    this.codes([2001, 2002, 2008, 2026, 2003, 2004], () => this.startNet());
  }
  private stop(): void {
    this.halt();
    this.state = "idle";
    this.playOnShow = false;
    this.render();
  }
  private pause(): void {
    if (this.state !== "playing") return;
    this.halt();
    this.state = "paused";
    this.render();
  }
  private resume(): void {
    if (this.state !== "paused" || this.suspended) return;
    this.state = "playing";
    this.render();
    this.codes([2004], () => this.startNet());
  }
  private startNet(): void {
    const horizontal = this.str("orientation") === "horizontal";
    this.reportNet(() => ({
      videoBitrate: around(1200, 150),
      audioBitrate: around(48, 4),
      videoFPS: around(24, 1),
      videoGOP: 2,
      netSpeed: around(1300, 200),
      netJitter: around(4, 3),
      netQualityLevel: 1,
      videoWidth: horizontal ? 360 : 640,
      videoHeight: horizontal ? 640 : 360,
      videoCache: around(Math.round(this.num("min-cache", 1) * 1000), 100),
      audioCache: around(Math.round(this.num("min-cache", 1) * 1000), 100),
      vDecCacheSize: 0,
      vSumCacheSize: around(20, 4),
      avPlayInterval: around(20, 10),
      avRecvInterval: around(20, 10),
      audioCacheThreshold: 1,
    }));
  }
  private render(problem = ""): void {
    const playing = this.state !== "idle" || this.suspended;
    this.picture.hidden = !playing;
    this.badge.hidden = !playing;
    this.screen.classList.toggle("frozen", this.state === "paused" || this.suspended);
    this.setNote(
      problem ||
        (this.suspended
          ? "已挂起：小程序在后台"
          : this.state === "paused"
            ? "已暂停"
            : this.state === "idle"
              ? this.str("src")
                ? "未在播放"
                : "未设置拉流地址"
              : ""),
    );
    const muted = this.muted ?? this.flag("muted");
    this.label.textContent = `模拟直播画面 · ${this.str("mode", "live") === "RTC" ? "实时通话" : "直播"}${muted ? " · 静音" : ""}`;
  }
  omrPageVisibility(visible: boolean, background: boolean): void {
    if (background) {
      if (!visible && this.state === "playing") {
        this.halt();
        this.state = "paused";
        this.suspended = true;
        emit(this, "statechange", { code: 6000 });
        this.render();
      } else if (visible && this.suspended) {
        this.suspended = false;
        // A source that changed in the background starts over; the same one goes on
        if (this.playOnShow) {
          this.playOnShow = false;
          this.play();
        } else {
          this.resume();
        }
      }
      return;
    }
    const autoPause = this.props["auto-pause-if-navigate"];
    if (!visible && autoPause !== false && autoPause !== "false") this.pause();
  }
  omrCall(method: string, args: unknown[]): void {
    const options = (args[0] ?? {}) as Record<string, unknown>;
    switch (method) {
      case "play":
        this.play();
        break;
      case "stop":
        this.stop();
        break;
      case "pause":
        this.pause();
        break;
      case "resume":
        this.resume();
        break;
      case "mute":
        // LivePlayerContext.mute switches the sound off and on again
        this.muted = !(this.muted ?? this.flag("muted"));
        this.render();
        break;
      case "requestFullScreen":
        this.setFullScreen(true, options.direction);
        break;
      case "exitFullScreen":
        this.setFullScreen(false);
        break;
      // Picture in picture, background playback and casting have nothing to show here
    }
  }
  /** Covers the page's window as `<video>` does; directions 90 and -90 turn it sideways. */
  private setFullScreen(on: boolean, direction?: unknown): void {
    if (on === this.fullScreen) return;
    this.fullScreen = on;
    const turn = Number(direction);
    const box =
      "position: fixed !important; top: 0 !important; left: 0 !important; z-index: 10000 !important; margin: 0 !important;";
    this.fullScreenStyle.textContent = !on
      ? ""
      : turn === 90 || turn === -90
        ? `:host { ${box} width: 100vh !important; height: 100vw !important; transform-origin: top left !important; transform: ${
            turn === 90 ? "translateY(100vh) rotate(-90deg)" : "translateX(100vw) rotate(90deg)"
          } !important; }`
        : `:host { ${box} width: 100vw !important; height: 100vh !important; }`;
    document.dispatchEvent(
      new CustomEvent("omr-video-fullscreen", { detail: { video: this, fullScreen: on } }),
    );
    emit(this, "fullscreenchange", {
      fullScreen: on,
      direction: on && (turn === 90 || turn === -90) ? "horizontal" : "vertical",
    });
  }
}

let nextPusherId = 0;

/**
 * Whether the Mini Program is in the background. Kept for the whole view, as
 * only pushers on the page hear the app leave and return, and one mounted in
 * the background must not start its camera.
 */
let appInBackground = false;

/** The view tells pushers, mounted now or later, that the app left or returned. */
export function setAppBackground(hidden: boolean): void {
  appInBackground = hidden;
}

/**
 * `<live-pusher>`, as wide as its parent and with no height of its own. When
 * inserted it asks the logic layer for `scope.camera` and `scope.record`; a
 * refusal fires `error` with code 10001 or 10002. With both it previews the
 * simulated camera (1003). Pushing to an RTMP `url` fires 1001, 1002, 2027
 * (with the microphone on) and 1008, then `netstatus`; any other address fails
 * with 3002 and -1307.
 */
export class WxLivePusher extends LiveStream {
  readonly pusherId = ++nextPusherId;
  private mounted = false;
  /** Undefined while the logic layer has not answered; the refusal when it said no. */
  private auth?: { errCode?: number; errMsg?: string };
  private previewing = false;
  private state: "idle" | "pushing" | "paused" = "idle";
  private suspended = false;
  /**
   * A preview, and with `push` a push, asked for in the background, whether by
   * authorization with autopush or by the context; it starts when the app returns.
   */
  private deferred?: { push: boolean };
  /** Set by `switchCamera`, which overrides `device-position`. */
  private position?: string;
  private torch = false;
  private readonly waiting: HTMLImageElement;
  constructor() {
    super(`
      .picture { position: absolute; inset: 0; }
      .mirror .picture { transform: scaleX(-1); }
      .torch .picture { filter: brightness(1.5); }
      .waiting { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .waiting[hidden] { display: none; }
    `);
    this.waiting = this.screen.insertBefore(document.createElement("img"), this.badge);
    this.waiting.className = "waiting";
    this.waiting.hidden = true;
  }
  connectedCallback(): void {
    this.announce(true);
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.announce(false);
  }
  private announce(mounted: boolean): void {
    if (mounted === this.mounted) return;
    this.mounted = mounted;
    if (!mounted) {
      this.auth = undefined;
      this.previewing = false;
      this.suspended = false;
      this.deferred = undefined;
      this.state = "idle";
    }
    document.dispatchEvent(
      new CustomEvent("omr-live-pusher", { detail: { pusher: this, mounted } }),
    );
  }
  /** The logic layer's answer: the user allowed the camera and the microphone, or which one they refused. */
  omrLivePusherState(state: { errCode?: number; errMsg?: string }): void {
    if (!this.mounted) return;
    this.auth = state;
    if (state.errCode !== undefined) {
      emit(this, "error", { errMsg: state.errMsg, errCode: state.errCode });
      this.render();
      return;
    }
    this.startPreview();
    if (this.flag("autopush")) this.start();
  }
  private get front(): boolean {
    return (this.position ?? this.str("device-position", "front")) !== "back";
  }
  protected override update(): void {
    this.render();
  }
  private startPreview(): void {
    if (this.previewing || !this.allowed()) return;
    // WeChat stops the camera in the background, so nothing starts until the app returns
    if (appInBackground) {
      this.deferred ??= { push: false };
      return;
    }
    this.previewing = true;
    this.render();
    if (this.flagOn("enable-camera")) this.codes([1003]);
  }
  private allowed(): boolean {
    return this.auth !== undefined && this.auth.errCode === undefined;
  }
  private start(): void {
    if (!this.allowed()) throw new Error(this.auth?.errMsg ?? "camera is not ready");
    if (this.state !== "idle") return;
    // Asked in the background, even after the preview stopped there, the push waits for the return
    if (appInBackground) {
      this.deferred = { push: true };
      return;
    }
    if (this.suspended) return;
    this.startPreview();
    if (!PUSHABLE.test(this.str("url"))) {
      this.codes([3002, -1307]);
      return;
    }
    this.state = "pushing";
    this.render();
    this.codes([1001, 1002, ...(this.flagOn("enable-mic") ? [2027] : []), 1008], () =>
      this.startNet(),
    );
  }
  private stop(): void {
    this.halt();
    if (this.deferred) this.deferred.push = false;
    this.state = "idle";
    this.render();
  }
  private pause(): void {
    if (this.state !== "pushing") return;
    this.halt();
    this.state = "paused";
    this.render();
  }
  private resume(): void {
    if (this.state !== "paused" || this.suspended) return;
    this.state = "pushing";
    this.render();
    this.startNet();
  }
  private startNet(): void {
    const min = this.num("min-bitrate", 200);
    const max = Math.max(min, this.num("max-bitrate", 1000));
    this.reportNet(() => ({
      videoBitrate: around((min + max) / 2, (max - min) / 4),
      audioBitrate: around(48, 4),
      videoFPS: around(Math.min(30, Math.max(1, this.num("fps", 15))), 1),
      videoGOP: 3,
      netSpeed: around(max, max / 10),
      netJitter: around(4, 3),
      netQualityLevel: 1,
      videoWidth: this.num("video-width", 360),
      videoHeight: this.num("video-height", 640),
      videoCache: 0,
      audioCache: 0,
    }));
  }
  private render(): void {
    const camera = this.previewing && this.flagOn("enable-camera");
    this.picture.hidden = !camera || this.suspended;
    const mirror = this.str("local-mirror", "auto");
    this.screen.classList.toggle(
      "mirror",
      mirror === "enable" || (mirror !== "disable" && this.front),
    );
    this.screen.classList.toggle("torch", this.torch && !this.front);
    this.screen.classList.toggle("frozen", this.state === "paused");
    this.badge.hidden = this.state === "idle";
    this.badge.textContent = this.state === "paused" ? "已暂停" : "推流中";
    const waitingImage = this.str("waiting-image");
    this.waiting.hidden = !(this.suspended && waitingImage);
    if (waitingImage && this.waiting.getAttribute("src") !== waitingImage) {
      this.waiting.src = waitingImage;
    }
    this.setNote(
      this.auth?.errCode !== undefined
        ? this.auth.errCode === 10002
          ? "无法使用麦克风"
          : "无法使用摄像头"
        : this.suspended
          ? waitingImage
            ? ""
            : "推流已挂起：小程序在后台"
          : this.previewing && !this.flagOn("enable-camera")
            ? "摄像头已关闭"
            : "",
    );
    const muted = this.flag("muted") || !this.flagOn("enable-mic");
    this.label.textContent = `模拟推流画面 · ${this.front ? "前置" : "后置"} · ${this.str("mode", "RTC")}${muted ? " · 静音" : ""}`;
  }
  omrPageVisibility(visible: boolean, background: boolean): void {
    if (!background) return;
    appInBackground = !visible;
    // Returning clears the suspension even when the preview stopped in the background
    if (!visible && !this.suspended && this.previewing) {
      this.suspended = true;
      this.halt();
      if (this.state !== "idle") emit(this, "statechange", { code: 5000 });
      this.render();
    } else if (visible && this.suspended) {
      this.suspended = false;
      this.render();
      if (this.state === "pushing") this.codes([1002], () => this.startNet());
    }
    // What was asked for in the background starts once the suspension is over
    if (visible && this.deferred) {
      const { push } = this.deferred;
      this.deferred = undefined;
      if (this.allowed() && this.mounted) {
        this.startPreview();
        if (push) this.start();
      }
    }
  }
  omrCall(method: string, _args: unknown[]): void {
    switch (method) {
      case "start":
        this.start();
        break;
      case "stop":
        this.stop();
        break;
      case "pause":
        this.pause();
        break;
      case "resume":
        this.resume();
        break;
      case "startPreview":
        if (!this.allowed()) throw new Error(this.auth?.errMsg ?? "camera is not ready");
        this.startPreview();
        break;
      case "stopPreview":
        this.deferred = undefined;
        this.halt();
        this.previewing = false;
        this.state = "idle";
        this.render();
        break;
      case "switchCamera":
        this.position = this.front ? "back" : "front";
        this.render();
        break;
      case "toggleTorch":
        if (this.front) throw new Error("the front camera has no torch");
        this.torch = !this.torch;
        this.render();
        break;
      // Background music, filters, makeup and stickers change nothing the simulator shows
    }
  }
}

let nextVoipRoomId = 0;

/**
 * `<voip-room>`, a window of one member of the video room `wx.joinVoIPChat`
 * joined: the user's simulated camera for `mode="camera"`, another member's
 * simulated video for `mode="video"`. The logic layer answers what it shows;
 * outside a video room, or for an openid not in it, it stays black and fires
 * `error`.
 */
export class WxVoipRoom extends LiveStream {
  readonly roomId = ++nextVoipRoomId;
  private announced?: string;
  constructor() {
    super(`
      .picture { position: absolute; inset: 0; }
      .mirror .picture { transform: scaleX(-1); }
      .contain .picture { inset: 12% 0; }
      .video .picture { background-image: linear-gradient(140deg, #5a4a3a, #3d6a5a, #4a4f73, #5a4a3a); }
    `);
  }
  connectedCallback(): void {
    this.announce();
  }
  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.announced = undefined;
    document.dispatchEvent(
      new CustomEvent("omr-voip-room", { detail: { room: this, mounted: false } }),
    );
  }
  protected override update(): void {
    const camera = this.mode() === "camera";
    const position = this.str("device-position", "front");
    this.screen.classList.toggle("mirror", camera && position !== "back");
    this.screen.classList.toggle("contain", this.str("object-fit") === "contain");
    this.screen.classList.toggle("video", !camera);
    this.label.textContent = camera
      ? `模拟通话画面 · 我 · ${position === "back" ? "后置" : "前置"}`
      : `模拟通话画面 · ${this.str("openid")}`;
    this.announce();
  }
  private mode(): string {
    return this.str("mode", "camera") === "video" ? "video" : "camera";
  }
  /** Asks the logic layer what to show when inserted, and again when `openid` or `mode` changes. */
  private announce(): void {
    if (!this.isConnected) return;
    const openid = this.str("openid");
    const mode = this.mode();
    if (this.announced === `${mode} ${openid}`) return;
    this.announced = `${mode} ${openid}`;
    document.dispatchEvent(
      new CustomEvent("omr-voip-room", { detail: { room: this, mounted: true, openid, mode } }),
    );
  }
  omrVoipRoomState(state: {
    visible?: boolean;
    muted?: boolean;
    error?: string;
    fire?: boolean;
  }): void {
    if (state.error !== undefined) {
      this.picture.hidden = true;
      this.badge.hidden = true;
      this.setNote("无法显示通话画面");
      if (state.fire) emit(this, "error", { errMsg: state.error });
      return;
    }
    this.picture.hidden = !state.visible;
    this.badge.hidden = !state.muted;
    this.badge.textContent = "已静音";
    this.setNote(state.visible ? "" : "未订阅该成员画面");
  }
  omrPageVisibility(): void {}
}
