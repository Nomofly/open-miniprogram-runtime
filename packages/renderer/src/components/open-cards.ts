/**
 * Cards for open abilities WeChat draws itself: `<official-account>`,
 * `<channel-video>` and `<channel-live>`. The simulator has no account or
 * channel data, so they show what the attributes name.
 */
import { Builtin, emit } from "./base.ts";

let nextAccountId = 0;

/**
 * The follow card of the app's Official Account, 84px tall. The logic layer
 * answers whether it may show for the launch scene; only one per page loads.
 */
export class WxOfficialAccount extends Builtin {
  readonly accountId = ++nextAccountId;
  private readonly card: HTMLElement;
  private readonly name: HTMLElement;
  private readonly follow: HTMLElement;
  /** Whether it asked to show; the first one on the page does, and keeps its state when moved. */
  private claimed = false;
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: block; min-width: 300px; height: 84px; }
      :host([hidden]), .card[hidden] { display: none; }
      .card { display: flex; align-items: center; gap: 12px; height: 100%; padding: 0 16px; box-sizing: border-box; background: #fff; border-radius: 8px; font: 14px/1.4 sans-serif; }
      .avatar { width: 44px; height: 44px; border-radius: 50%; background: #07c160; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 20px; flex: none; }
      .text { flex: 1; min-width: 0; }
      .name { color: rgba(0, 0, 0, 0.9); font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .desc { color: rgba(0, 0, 0, 0.5); font-size: 12px; }
      .follow { flex: none; padding: 4px 14px; border-radius: 4px; background: #07c160; color: #fff; font-size: 13px; cursor: pointer; }
      .follow.done { background: #f2f2f2; color: rgba(0, 0, 0, 0.5); }
    </style><div class="card" hidden><div class="avatar"></div><div class="text"><div class="name"></div><div class="desc">关注公众号，获取更多服务</div></div><span class="follow">关注</span></div>`);
    this.card = root.querySelector(".card")!;
    this.name = root.querySelector(".name")!;
    this.follow = root.querySelector(".follow")!;
    this.follow.addEventListener("click", () => {
      this.follow.classList.add("done");
      this.follow.textContent = "已关注";
    });
  }
  connectedCallback(): void {
    if (this.claimed) return;
    // Once the render that inserted it is done, the first on the page claims it; the others fail as created twice
    queueMicrotask(() => {
      if (!this.isConnected || this.claimed) return;
      const all = [...document.querySelectorAll<WxOfficialAccount>("wx-official-account")];
      if (all.some((el) => el.claimed) || all[0] !== this) {
        this.omrAccountState({ status: 6, errMsg: "重复创建", name: "" });
        return;
      }
      this.claimed = true;
      document.dispatchEvent(
        new CustomEvent("omr-official-account", { detail: { account: this } }),
      );
    });
  }
  omrAccountState(state: { status: number; errMsg: string; name: string }): void {
    const shown = state.status === 0;
    this.card.hidden = !shown;
    this.hidden = !shown;
    if (!shown) {
      emit(this, "error", { status: state.status, errMsg: state.errMsg });
      return;
    }
    this.name.textContent = state.name;
    this.card.querySelector(".avatar")!.textContent = state.name.slice(0, 1);
    emit(this, "load", { status: 0, errMsg: state.errMsg });
  }
}

const CARD_STYLE = `
  :host { display: block; position: relative; overflow: hidden; background: #111; color: #fff; font: 13px/1.4 sans-serif; }
  .cover { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; background: linear-gradient(160deg, #3a3f47, #15171a); }
  .badge { position: absolute; left: 10px; top: 10px; padding: 2px 8px; border-radius: 4px; background: rgba(0, 0, 0, 0.45); font-size: 12px; }
  .live { background: #fa5151; }
  .id { position: absolute; left: 10px; bottom: 8px; right: 10px; color: rgba(255, 255, 255, 0.6); font-size: 11px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .play { width: 0; height: 0; border-left: 18px solid rgba(255, 255, 255, 0.9); border-top: 11px solid transparent; border-bottom: 11px solid transparent; margin-left: 6px; }
  .play.playing { width: 14px; height: 20px; border: none; margin: 0; border-left: 5px solid rgba(255, 255, 255, 0.9); border-right: 5px solid rgba(255, 255, 255, 0.9); box-sizing: border-box; }
`;

/**
 * A video of the app's WeChat Channels account, as the default `<video>` box;
 * tapping it plays and pauses. Without `feed-id` or `feed-token` it fires
 * `binderror`.
 */
export class WxChannelVideo extends Builtin {
  private readonly feed: HTMLElement;
  private readonly play: HTMLElement;
  private reported = false;
  constructor() {
    super();
    const root = this.shadow(`<style>${CARD_STYLE}
      :host { width: 300px; height: 225px; cursor: pointer; }
    </style><div class="cover"><span class="play"></span></div><span class="badge">视频号</span><span class="id"></span>`);
    this.feed = root.querySelector(".id")!;
    this.play = root.querySelector(".play")!;
    this.addEventListener("click", () => this.play.classList.toggle("playing"));
  }
  connectedCallback(): void {
    this.check();
  }
  protected override update(): void {
    const feed = this.feedOf();
    this.feed.textContent = feed ? `${this.str("finder-user-name")} ${feed}`.trim() : "";
    if (this.flag("autoplay")) this.play.classList.add("playing");
    if (this.isConnected) this.check();
  }
  private feedOf(): string {
    return this.str("feed-id") || this.str("feed-token");
  }
  /** Reports a missing video once it is on the page, where its `binderror` hears it. */
  private check(): void {
    if (this.feedOf() || this.reported) return;
    this.reported = true;
    emit(this, "error", { errMsg: "channel-video: feed-id or feed-token is required" });
  }
}

/** The cover and status of a live stream of the app's WeChat Channels account. */
export class WxChannelLive extends Builtin {
  private readonly feed: HTMLElement;
  constructor() {
    super();
    const root = this.shadow(`<style>${CARD_STYLE}
      :host { width: 100%; height: 180px; }
    </style><div class="cover"><span>视频号直播</span></div><span class="badge live">直播中</span><span class="id"></span>`);
    this.feed = root.querySelector(".id")!;
  }
  protected override update(): void {
    this.feed.textContent = `${this.str("finder-user-name")} ${this.str("feed-id")}`.trim();
  }
}
