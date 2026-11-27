/**
 * Cards for open abilities WeChat draws itself: `<official-account>`,
 * `<channel-video>`, `<channel-live>`, `<official-account-publish>` and
 * `<reward>`. The simulator has no account or channel data, so they show what
 * the attributes name.
 */
import { Builtin, emit } from "./base.ts";
import { warnNewer } from "./store-cards.ts";

const AVATAR =
  '<svg viewBox="0 0 40 40" width="100%" height="100%"><rect width="40" height="40" fill="#e1e1e1"/><circle cx="20" cy="15" r="7" fill="#fff"/><path d="M6 40c1-9 7-13 14-13s13 4 14 13z" fill="#fff"/></svg>';

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

let posts = 0;

/**
 * `<official-account-publish>`, WeChat's sticker posts about the app (base
 * library 3.9.3). The simulator has no posts to load: the list is empty
 * (`empty`) and shows `placeholder`; posting adds the user's post and fires
 * `publishsuccess` with a simulated `postUrl`.
 */
export class WxOfficialAccountPublish extends Builtin {
  private readonly box: HTMLElement;
  private readonly topic: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly list: HTMLElement;
  private readonly more: HTMLElement;
  private count = 0;
  private reported = false;
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: block; font: 14px/1.4 -apple-system, "PingFang SC", sans-serif; }
      .box { padding: 12px; border-radius: 8px; }
      .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .topic { color: #576b95; font-weight: 600; }
      .publish { padding: 3px 12px; border-radius: 14px; background: #07c160; color: #fff; font-size: 13px; cursor: pointer; }
      .empty { padding: 18px 0; text-align: center; color: rgba(0, 0, 0, 0.4); font-size: 13px; }
      .list { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
      .post { height: 90px; border-radius: 6px; background: linear-gradient(135deg, #d8efe2, #c3e4f0); display: flex; align-items: flex-end; padding: 6px; box-sizing: border-box; font-size: 12px; color: rgba(0, 0, 0, 0.6); }
      .more { margin-top: 8px; text-align: center; color: #576b95; font-size: 13px; }
      [hidden] { display: none !important; }
    </style><div class="box"><div class="head"><span class="topic"></span><span class="publish">发表</span></div><div class="empty"></div><div class="list"></div><div class="more" hidden>查看更多</div></div>`);
    this.box = root.querySelector(".box")!;
    this.topic = root.querySelector(".topic")!;
    this.empty = root.querySelector(".empty")!;
    this.list = root.querySelector(".list")!;
    this.more = root.querySelector(".more")!;
    root.querySelector(".publish")!.addEventListener("click", () => this.publish());
  }
  connectedCallback(): void {
    warnNewer("official-account-publish", "3.9.3");
    if (this.reported) return;
    this.reported = true;
    setTimeout(() => emit(this, "empty", {}), 0);
  }
  protected override update(): void {
    this.box.style.background = this.str("background-color", "#f7f7f7") || "#f7f7f7";
    this.topic.textContent = `#${this.str("topic").slice(0, 20) || "小程序话题"}`;
    this.empty.textContent = this.str("placeholder", "来写下第一条吧") || "来写下第一条吧";
    this.render();
  }
  private publish(): void {
    this.count++;
    this.render();
    emit(this, "publishsuccess", { postUrl: `https://example.com/omr-simulated-post/${++posts}` });
  }
  private render(): void {
    const limit = Math.max(1, Math.floor(this.num("limit", 4)));
    this.empty.hidden = this.count > 0;
    this.list.replaceChildren(
      ...Array.from({ length: Math.min(this.count, limit) }, (_, i) =>
        Object.assign(document.createElement("div"), {
          className: "post",
          textContent: `我的贴图 ${this.count - i}`,
        }),
      ),
    );
    this.more.hidden = this.count <= limit;
  }
}

const REWARD_THEMES: Record<string, [string, string]> = {
  transparent: ["transparent", "rgba(0, 0, 0, 0.9)"],
  plain: ["transparent", "rgba(0, 0, 0, 0.9)"],
  white: ["#ffffff", "rgba(0, 0, 0, 0.9)"],
  light: ["#ffffff", "rgba(0, 0, 0, 0.9)"],
  black: ["#2c2c2c", "rgba(255, 255, 255, 0.9)"],
  dark: ["#2c2c2c", "rgba(255, 255, 255, 0.9)"],
};

/**
 * `<reward>`, "喜欢开发者" (base library 3.17.5): a button that likes the
 * author, then the count and the avatars of those who did. The simulator has
 * no likes until the user's. `width` is a share of the available width from
 * 85 to 100; below 85, or with another `<reward>` on the page, none shows.
 */
export class WxReward extends Builtin {
  private readonly card: HTMLElement;
  private readonly button: HTMLElement;
  private readonly likes: HTMLElement;
  private liked = false;
  constructor() {
    super();
    const root = this.shadow(`<style>
      :host { display: block; font: 14px/1.4 -apple-system, "PingFang SC", sans-serif; }
      .card { margin: 0 auto; padding: 16px; border-radius: 8px; box-sizing: border-box; text-align: center; }
      .button { display: inline-flex; align-items: center; gap: 6px; padding: 8px 22px; border-radius: 20px; background: #fa5151; color: #fff; cursor: pointer; }
      .button.liked { background: rgba(250, 81, 81, 0.12); color: #fa5151; }
      .likes { margin-top: 12px; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 13px; opacity: 0.7; cursor: pointer; }
      .avatar { width: 24px; height: 24px; border-radius: 4px; overflow: hidden; }
      [hidden] { display: none !important; }
    </style><div class="card"><span class="button">♥ 喜欢作者</span><div class="likes" hidden><span class="avatar">${AVATAR}</span><span>1 人喜欢</span></div></div>`);
    this.card = root.querySelector(".card")!;
    this.button = root.querySelector(".button")!;
    this.likes = root.querySelector(".likes")!;
    this.button.addEventListener("click", () => {
      this.liked = !this.liked;
      this.render();
    });
  }
  connectedCallback(): void {
    warnNewer("reward", "3.17.5");
    // One per page: with more, none shows
    queueMicrotask(() => {
      const all = document.querySelectorAll("wx-reward");
      for (const el of all) (el as WxReward).render(all.length > 1);
    });
  }
  protected override update(): void {
    this.render();
  }
  private render(duplicated = document.querySelectorAll("wx-reward").length > 1): void {
    const [background, color] = REWARD_THEMES[this.str("theme")] ?? REWARD_THEMES.transparent!;
    this.card.style.background = background;
    this.card.style.color = color;
    const width = this.props.width === undefined ? 96 : Math.min(100, this.num("width", 96));
    this.card.style.width = `${width}%`;
    this.hidden = duplicated || width < 85;
    this.button.classList.toggle("liked", this.liked);
    this.button.textContent = this.liked ? "♥ 已喜欢" : "♥ 喜欢作者";
    this.likes.hidden = !this.liked;
  }
}
