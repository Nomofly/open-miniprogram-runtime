/**
 * The simulator shell: draws the device (status bar, navigation bar, capsule,
 * tab bar), runs the logic layer in a Worker, opens one iframe per page as its
 * WebView, and relays messages between them.
 */
import type { WebviewBundle } from "@omr/compiler";
import { fsFileUrl, isFsPath, themeTabBar, themeWindow } from "@omr/runtime";
import type {
  LogicToShell,
  Manifest,
  PermissionKind,
  ShellToLogic,
  StackEntry,
  Theme,
  ViewToLogic,
} from "@omr/runtime";
import { DEFAULT_DEVICE, DEVICES, TAB_BAR_HEIGHT, menuButtonRect, systemInfo } from "./device.ts";
import { createUi } from "./ui.ts";
import type { WebviewInit } from "./webview.ts";
import type { BridgeToShell, ShellToBridge } from "./web-view-bridge.ts";
import "./style.css";

interface TabBarConfig {
  color?: string;
  selectedColor?: string;
  backgroundColor?: string;
  borderStyle?: string;
  /** Each tab page draws the `custom-tab-bar` component instead. */
  custom?: boolean;
  list?: { pagePath: string; text?: string; iconPath?: string; selectedIconPath?: string }[];
}

interface PageView {
  entry: StackEntry;
  el: HTMLElement;
  iframe: HTMLIFrameElement;
  navbar: HTMLElement;
  title: HTMLElement;
  back: HTMLElement;
  home: HTMLElement;
  loading: HTMLElement;
  /** Whether `wx.hideHomeButton` hid the home button. */
  homeHidden: boolean;
  /** The page's window configuration in the current theme, with `changes` over it. */
  window: Record<string, unknown>;
  /** What `wx.setNavigationBar*` changed, which a theme change keeps. */
  changes: Record<string, unknown>;
  /** The web page of the page's `<web-view>`, shown over its WebView. */
  web?: { frame: HTMLIFrameElement; canGoBack: boolean; title: string };
}

const FILES = "/__omr/files/";
const params = new URLSearchParams(location.search);
const deviceName = params.get("device") ?? DEFAULT_DEVICE;
const device = DEVICES[deviceName] ?? DEVICES[DEFAULT_DEVICE]!;
const system = systemInfo(device);
const menuButton = menuButtonRect(device);
const navHeight = device.statusBarHeight + device.navigationBarHeight;

const root = document.getElementById("omr-device")!;
root.style.width = `${device.screenWidth}px`;
root.style.height = `${device.screenHeight}px`;
root.dataset.device = deviceName;
// Full-screen system pages start below the status bar
root.style.setProperty("--omr-status-bar", `${device.statusBarHeight}px`);

const resolveAsset = (src: string) =>
  isFsPath(src)
    ? fsFileUrl(src)
    : /^([a-z][\w+.-]*:|\/\/)/i.test(src)
      ? src
      : FILES + src.replace(/^\/+/, "");

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${url}: ${response.status}`);
  }
  return response;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let manifest: Manifest;
let appService: string;
try {
  [manifest, appService] = await Promise.all([
    fetchOk("/__omr/manifest.json").then((r) => r.json() as Promise<Manifest>),
    fetchOk("/__omr/app-service.js").then((r) => r.text()),
  ]);
} catch (error) {
  root.append(el("div", "omr-fatal", (error as Error).message));
  throw error;
}

const styleV2 = manifest.appJson.style === "v2";
const darkmode = manifest.appJson.darkmode === true;
/** The system theme: `?theme=dark`, else light, so screenshots do not depend on the host. */
let theme: Theme = params.get("theme") === "dark" ? "dark" : "light";
/** A page's window configuration with the theme's variables resolved. */
const themedWindow = (route: string) =>
  themeWindow(manifest.windows[route] ?? {}, manifest.themeVariables, theme);
const tabBarConfig = manifest.appJson.tabBar as TabBarConfig | undefined;
/** What wx.setTabBarStyle and wx.setTabBarItem changed, which a theme change keeps. */
const tabBarChanges: Record<string, string> = {};
const tabItemChanges = new Map<number, Record<string, string>>();
const themedTabBar = (): TabBarConfig | undefined => {
  if (!tabBarConfig) return undefined;
  const result = { ...themeTabBar(tabBarConfig, manifest.themeVariables, theme), ...tabBarChanges };
  result.list = result.list?.map((item, index) => ({ ...item, ...tabItemChanges.get(index) }));
  return result;
};
let tabBar = themedTabBar();
const tabRoutes = (tabBar?.list ?? []).map((item) => item.pagePath.replace(/^\/+/, ""));
/** Badge text, or "" for a red dot, by tab index. */
const tabBadges = new Map<number, string>();
let tabBarHidden = false;
/** The page the home button opens: the app's first page. */
const homeRoute = manifest.pages[0] ?? manifest.entryPage;

const pagesLayer = el("div", "omr-pages");
const statusBar = el("div", "omr-statusbar");
statusBar.style.height = `${device.statusBarHeight}px`;
statusBar.innerHTML = `<span class="omr-time">9:41</span><span class="omr-status-icons"><svg viewBox="0 0 18 12" width="18" height="12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg><svg viewBox="0 0 26 12" width="26" height="12"><rect x="0.5" y="0.5" width="22" height="11" rx="3" fill="none" stroke="currentColor" opacity="0.4"/><rect x="2" y="2" width="19" height="8" rx="2"/><rect x="23.5" y="4" width="1.5" height="4" rx="0.75" opacity="0.4"/></svg></span>`;
const capsule = el("div", "omr-capsule");
Object.assign(capsule.style, {
  top: `${menuButton.top}px`,
  left: `${menuButton.left}px`,
  width: `${menuButton.width}px`,
  height: `${menuButton.height}px`,
});
const CAPSULE_DOTS = "<i></i><i></i><i></i>";
capsule.innerHTML = `<span class="omr-capsule-menu">${CAPSULE_DOTS}</span><span class="omr-capsule-divider"></span><span class="omr-capsule-close" data-omr-action="appHide"></span>`;
const capsuleMenu = capsule.querySelector<HTMLElement>(".omr-capsule-menu")!;
capsuleMenu.addEventListener("click", () => toLogic({ type: "menu" }));
// The close button leaves the Mini Program, which keeps running in the background
capsule.querySelector(".omr-capsule-close")!.addEventListener("click", () => appHide());
/** What the capsule's menu button shows instead of its dots while a capability is in use. */
const IN_USE_ICONS: Record<PermissionKind, string> = {
  location: `<path d="M20 4L4 11l7 2 2 7z" fill="currentColor"/>`,
  record: `<rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
  camera: `<path fill-rule="evenodd" d="M4 7h3l2-2h6l2 2h3v12H4zM12 9.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z" fill="currentColor"/>`,
};
function showPermissionsInUse(reported: PermissionKind[]): void {
  const kinds = reported.filter((kind) => Object.hasOwn(IN_USE_ICONS, kind));
  capsuleMenu.dataset.inUse = kinds.join(" ");
  capsuleMenu.innerHTML = kinds.length
    ? kinds
        .map(
          (kind) =>
            `<svg class="omr-in-use" data-kind="${kind}" viewBox="0 0 24 24" width="16" height="16">${IN_USE_ICONS[kind]}</svg>`,
        )
        .join("")
    : CAPSULE_DOTS;
}
const tabBarEl = el("div", "omr-tabbar");
tabBarEl.style.height = `${TAB_BAR_HEIGHT + device.safeAreaBottom}px`;
tabBarEl.style.paddingBottom = `${device.safeAreaBottom}px`;
const uiLayer = el("div", "omr-ui-layer");
// What the user sees after leaving: WeChat's recent Mini Programs, where tapping this one comes back
const backgroundScreen = el("div", "omr-background");
backgroundScreen.hidden = true;
backgroundScreen.style.paddingTop = `${device.statusBarHeight}px`;
const recent = el("button", "omr-recent");
recent.setAttribute("type", "button");
recent.dataset.omrAction = "appShow";
recent.append(
  el("span", "omr-recent-icon", manifest.appName.slice(0, 1)),
  el("span", "omr-recent-name", manifest.appName),
);
// Scene 1089: the recent list above WeChat's chats
recent.addEventListener("click", () => appShow(1089));
backgroundScreen.append(
  el("div", "omr-background-title", "微信"),
  el("div", "omr-background-label", "最近使用的小程序"),
  recent,
);
root.append(pagesLayer, backgroundScreen, statusBar, capsule, tabBarEl, uiLayer);

/** Scroll views with `enable-back-to-top` on the page in front go back to the top. */
function backToTop(): void {
  const top = stack[stack.length - 1];
  if (!backgroundScreen.hidden || !top) return;
  pages
    .get(top.webviewId)
    ?.iframe.contentWindow?.postMessage({ omr: "logic", message: { type: "backToTop" } }, "*");
}
// iOS goes back to the top when the status bar is tapped; Android when the title is double-tapped
if (device.platform === "ios") {
  statusBar.classList.add("omr-statusbar-tappable");
  statusBar.dataset.omrAction = "backToTop";
  statusBar.addEventListener("click", backToTop);
}

const ui = createUi(uiLayer, resolveAsset, manifest.appName);
const pages = new Map<number, PageView>();
let stack: StackEntry[] = [];

const worker = new Worker(new URL("./logic-worker.ts", import.meta.url), { type: "module" });
// The logic layer talks to the shell only over this private port, handed over before any
// Mini Program code runs; that code can post on the Worker itself, which the shell ignores
const logic = new MessageChannel();
worker.postMessage(null, [logic.port2]);
const toLogic = (message: ShellToLogic) => logic.port1.postMessage(message);

function applyWindow(page: PageView): void {
  const win = page.window;
  // navigationStyle: custom does not apply to <web-view>, as on WeChat
  const custom = win.navigationStyle === "custom" && !page.web;
  const isTab = tabRoutes.includes(page.entry.route);
  page.navbar.hidden = custom;
  const str = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
  page.navbar.style.background = str(win.navigationBarBackgroundColor, "#000000");
  page.navbar.style.color = win.navigationBarTextStyle === "black" ? "#000000" : "#ffffff";
  // A web-view page shows the web page's title
  page.title.textContent = page.web?.title || str(win.navigationBarTitleText, "");
  const top = custom ? 0 : navHeight;
  // A custom tab bar is drawn by the page itself, over the bottom of its window
  const bottom =
    isTab && !tabBarHidden && !tabBar?.custom ? TAB_BAR_HEIGHT + device.safeAreaBottom : 0;
  // An iframe does not stretch between top and bottom, so give it its height
  for (const frame of [page.iframe, page.web?.frame]) {
    if (!frame) continue;
    frame.style.top = `${top}px`;
    frame.style.height = `${device.screenHeight - top - bottom}px`;
  }
}

/** What WeChat's web-view reports as `navigator.userAgent`, with the Mini Program's appid. */
const wechatVersion = String(system.version);
const webViewUserAgent =
  device.platform === "ios"
    ? `Mozilla/5.0 (iPhone; CPU iPhone OS ${device.system.replace(/^iOS /, "").replace(/\./g, "_")} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/${wechatVersion}(0x18003237) NetType/WIFI Language/zh_CN miniProgram/${manifest.appid}`
    : `Mozilla/5.0 (Linux; ${device.system}; ${device.model} Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.120 Mobile Safari/537.36 XWEB/1220099 MMWEBSDK/20240301 MMWEBID/1 MicroMessenger/${wechatVersion}.2620(0x28003237) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 miniProgram/${manifest.appid}`;

const toBridge = (page: PageView, message: ShellToBridge) =>
  page.web?.frame.contentWindow?.postMessage(message, "*");

/** Opens a `<web-view>`'s `src` over the page, through the simulator's proxy for its origin; closes it without `src`. */
async function openWebView(page: PageView, src: string | undefined): Promise<void> {
  page.web?.frame.remove();
  page.web = undefined;
  if (src) {
    const frame = document.createElement("iframe");
    frame.className = "omr-webview omr-web-page";
    frame.title = src;
    // Its own origin already keeps it from the shell; the sandbox also keeps it from navigating the shell away
    frame.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads",
    );
    page.web = { frame, canGoBack: false, title: "" };
    page.el.append(frame);
    try {
      const query = new URLSearchParams({ url: src, ua: webViewUserAgent });
      const { port, path } = (await (await fetchOk(`/__omr/web-view?${query}`)).json()) as {
        port: number;
        path: string;
      };
      if (page.web?.frame === frame) frame.src = `http://${location.hostname}:${port}${path}`;
    } catch {
      // Not an http(s) URL: WeChat cannot open it either
      if (page.web?.frame === frame) {
        const url = src.replace(/[?#].*$/, "");
        toLogic({
          type: "webViewEvent",
          webviewId: page.entry.webviewId,
          name: "error",
          detail: { url, fullUrl: src },
        });
      }
    }
  }
  applyWindow(page);
  if (lastRoute) onRoute(lastRoute);
}

function createPage(entry: StackEntry): PageView {
  const container = el("div", "omr-page");
  container.dataset.webviewId = String(entry.webviewId);
  container.dataset.route = entry.route;
  const navbar = el("div", "omr-navbar");
  navbar.style.height = `${navHeight}px`;
  navbar.style.paddingTop = `${device.statusBarHeight}px`;
  const back = el("button", "omr-back");
  back.setAttribute("type", "button");
  back.setAttribute("aria-label", "back");
  back.innerHTML = `<svg viewBox="0 0 12 24" width="12" height="24"><path d="M10 3L2 12l8 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  back.addEventListener("click", () => {
    // The back button goes back in the web-view's own history first, as on WeChat
    const page = pages.get(entry.webviewId);
    if (page?.web?.canGoBack) toBridge(page, { omr: "jsbridge-back" });
    else toLogic({ type: "navigateBack" });
  });
  const home = el("button", "omr-home");
  home.setAttribute("type", "button");
  home.setAttribute("aria-label", "home");
  home.hidden = true;
  home.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 11l8-7 8 7M6.5 9v10h11V9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  home.addEventListener("click", () => toLogic({ type: "reLaunch", url: `/${homeRoute}` }));
  const title = el("div", "omr-title");
  if (device.platform === "android") title.addEventListener("dblclick", backToTop);
  const loading = el("span", "omr-nav-loading");
  loading.hidden = true;
  const heading = el("div", "omr-heading");
  heading.append(loading, title);
  navbar.append(back, home, heading);
  const iframe = document.createElement("iframe");
  iframe.className = "omr-webview";
  iframe.title = entry.route;
  // Without allow-same-origin the page gets an opaque origin: it cannot touch this document
  iframe.setAttribute("sandbox", "allow-scripts");
  // The page's prefers-color-scheme media queries follow the iframe's color-scheme
  iframe.style.colorScheme = theme;
  iframe.src = "/__omr/webview.html";
  const loaded = new Promise((resolve) => iframe.addEventListener("load", resolve, { once: true }));
  void Promise.all([fetchOk(`/__omr/page.json?route=${encodeURIComponent(entry.route)}`), loaded])
    .then(([response]) => response.json() as Promise<WebviewBundle>)
    .then((bundle) => {
      const init: WebviewInit = {
        omr: "init",
        webviewId: entry.webviewId,
        bundle,
        windowWidth: device.screenWidth,
        hairline: device.platform === "ios" && device.pixelRatio > 1 ? 0.5 : 1,
        styleV2,
        dark: darkmode && theme === "dark",
        ad: manifest.config.ad,
        location: manifest.config.location,
      };
      // The view paints the window background behind pull-down refresh in this theme
      bundle.window = themeWindow(bundle.window, manifest.themeVariables, theme);
      // An opaque origin cannot be named as the target, so "*"; the target is this iframe only
      iframe.contentWindow?.postMessage(init, "*");
    })
    .catch((error: unknown) => container.append(el("div", "omr-fatal", (error as Error).message)));
  container.append(navbar, iframe);
  pagesLayer.append(container);
  const page: PageView = {
    entry,
    el: container,
    iframe,
    navbar,
    title,
    back,
    home,
    loading,
    homeHidden: false,
    window: themedWindow(entry.route),
    changes: {},
  };
  applyWindow(page);
  pages.set(entry.webviewId, page);
  return page;
}

function renderTabBar(route: string): void {
  const items = tabBar?.list ?? [];
  const active = tabRoutes.indexOf(route);
  tabBarEl.hidden = active === -1 || tabBarHidden || tabBar?.custom === true;
  if (active === -1) return;
  tabBarEl.style.background = tabBar?.backgroundColor ?? "#ffffff";
  tabBarEl.style.borderTopColor =
    tabBar?.borderStyle === "white" ? "rgba(255, 255, 255, 0.33)" : "rgba(0, 0, 0, 0.33)";
  tabBarEl.replaceChildren(
    ...items.map((item, index) => {
      const selected = index === active;
      const button = el("button", `omr-tab${selected ? " omr-tab-selected" : ""}`);
      button.setAttribute("type", "button");
      button.dataset.pagePath = item.pagePath;
      button.style.color = selected
        ? (tabBar?.selectedColor ?? "#18181b")
        : (tabBar?.color ?? "#7a7e83");
      const icon = selected ? (item.selectedIconPath ?? item.iconPath) : item.iconPath;
      if (icon) {
        const img = document.createElement("img");
        img.className = "omr-tab-icon";
        img.src = resolveAsset(icon);
        img.alt = "";
        button.append(img);
      }
      button.append(el("span", "omr-tab-text", item.text ?? ""));
      const badge = tabBadges.get(index);
      if (badge !== undefined) {
        button.append(el("span", badge ? "omr-tab-badge" : "omr-tab-dot", badge || undefined));
      }
      button.addEventListener("click", () => toLogic({ type: "switchTab", url: item.pagePath }));
      return button;
    }),
  );
}

function onRoute(message: Extract<LogicToShell, { type: "route" }>): void {
  const alive = new Set(message.alive.map((entry) => entry.webviewId));
  for (const [id, page] of pages) {
    if (!alive.has(id)) {
      page.el.remove();
      pages.delete(id);
    }
  }
  for (const entry of message.alive) if (!pages.has(entry.webviewId)) createPage(entry);
  stack = message.stack;
  const top = stack[stack.length - 1];
  if (!top) return;
  stack.forEach((entry, index) => {
    const page = pages.get(entry.webviewId);
    if (!page) return;
    page.back.hidden = index === 0 && !page.web?.canGoBack;
    // A first page other than the home page or a tab offers the way home, as WeChat does
    page.home.hidden =
      index !== 0 ||
      page.homeHidden ||
      entry.route === homeRoute ||
      tabRoutes.includes(entry.route);
  });
  for (const [id, page] of pages) page.el.classList.toggle("omr-page-active", id === top.webviewId);
  const topPage = pages.get(top.webviewId)!;
  const dark = topPage.window.navigationBarTextStyle !== "black";
  root.classList.toggle("omr-chrome-dark", dark);
  renderTabBar(top.route);
  document.documentElement.dataset.omrRoute = top.route;
}

async function onUi(message: Extract<LogicToShell, { type: "ui" }>): Promise<void> {
  try {
    let result: Record<string, unknown> = {};
    if (message.name === "setNavigationBarTitle" || message.name === "setNavigationBarColor") {
      const page = pages.get(Number(message.args.webviewId));
      if (page) {
        const { args } = message;
        if (message.name === "setNavigationBarTitle")
          page.changes.navigationBarTitleText = args.title;
        else {
          page.changes.navigationBarBackgroundColor = args.backgroundColor;
          page.changes.navigationBarTextStyle = args.frontColor === "#ffffff" ? "white" : "black";
        }
        page.window = { ...themedWindow(page.entry.route), ...page.changes };
        applyWindow(page);
        if (stack[stack.length - 1]?.webviewId === page.entry.webviewId) onRoute(lastRoute!);
      }
    } else if (message.name in CHROME_APIS) {
      CHROME_APIS[message.name]!(message.args, pages.get(Number(message.args.webviewId)));
      if (lastRoute) onRoute(lastRoute);
    } else {
      result = await ui(message.name, message.args);
    }
    toLogic({ type: "uiResult", callId: message.callId, result });
  } catch (error) {
    toLogic({ type: "uiResult", callId: message.callId, error: (error as Error).message });
  }
}

/** The index of a tab bar item an API names; throws WeChat's failure when there is none. */
function tabIndex(args: Record<string, unknown>, page: PageView | undefined): number {
  if (!page || !tabRoutes.includes(page.entry.route)) throw new Error("not TabBar page");
  const index = Number(args.index);
  if (!Number.isInteger(index) || index < 0 || index >= tabRoutes.length) {
    throw new Error("tabbar item not found");
  }
  return index;
}

/** APIs that change the chrome around the page: the tab bar and the navigation bar. */
const CHROME_APIS: Record<string, (args: Record<string, unknown>, page?: PageView) => void> = {
  setTabBarBadge: (args, page) => {
    // WeChat shows "..." for text longer than four characters
    const text = typeof args.text === "string" ? args.text : "";
    tabBadges.set(tabIndex(args, page), text.length > 4 ? "..." : text);
  },
  removeTabBarBadge: (args, page) => void tabBadges.delete(tabIndex(args, page)),
  showTabBarRedDot: (args, page) => void tabBadges.set(tabIndex(args, page), ""),
  hideTabBarRedDot: (args, page) => {
    const index = tabIndex(args, page);
    if (tabBadges.get(index) === "") tabBadges.delete(index);
  },
  setTabBarStyle: (args, page) => {
    if (!page || !tabRoutes.includes(page.entry.route)) throw new Error("not TabBar page");
    for (const key of ["color", "selectedColor", "backgroundColor", "borderStyle"] as const) {
      if (typeof args[key] === "string") tabBarChanges[key] = args[key];
    }
    tabBar = themedTabBar();
  },
  setTabBarItem: (args, page) => {
    const index = tabIndex(args, page);
    const changes = tabItemChanges.get(index) ?? {};
    for (const key of ["text", "iconPath", "selectedIconPath"] as const) {
      if (typeof args[key] === "string") changes[key] = args[key];
    }
    tabItemChanges.set(index, changes);
    tabBar = themedTabBar();
  },
  showTabBar: (_args, page) => {
    if (!page || !tabRoutes.includes(page.entry.route)) throw new Error("not TabBar page");
    tabBarHidden = false;
    for (const view of pages.values()) applyWindow(view);
  },
  hideTabBar: (_args, page) => {
    if (!page || !tabRoutes.includes(page.entry.route)) throw new Error("not TabBar page");
    tabBarHidden = true;
    for (const view of pages.values()) applyWindow(view);
  },
  showNavigationBarLoading: (_args, page) => page && (page.loading.hidden = false),
  hideNavigationBarLoading: (_args, page) => page && (page.loading.hidden = true),
  hideHomeButton: (_args, page) => page && (page.homeHidden = true),
};

const storageKey = `omr-storage:${manifest.appid}`;
let lastRoute: Extract<LogicToShell, { type: "route" }> | undefined;

logic.port1.addEventListener("message", (event: MessageEvent<LogicToShell>) => {
  const message = event.data;
  switch (message.type) {
    case "route":
      lastRoute = message;
      onRoute(message);
      break;
    case "toView":
      pages
        .get(message.webviewId)
        ?.iframe.contentWindow?.postMessage({ omr: "logic", message: message.message }, "*");
      break;
    case "ui":
      void onUi(message);
      break;
    case "permissionsInUse":
      showPermissionsInUse(message.kinds);
      break;
    case "videoFullScreen":
      // style.css grows the page's WebView to the whole screen and hides the chrome while it is shown
      pages
        .get(message.webviewId)
        ?.el.classList.toggle("omr-page-video-fullscreen", message.fullScreen);
      break;
    case "webView": {
      const page = pages.get(message.webviewId);
      if (page) void openWebView(page, message.src);
      break;
    }
    case "webViewResult": {
      const page = pages.get(message.webviewId);
      if (page)
        toBridge(page, { omr: "jsbridge-result", callId: message.callId, result: message.result });
      break;
    }
    case "exit":
      appHide();
      break;
    case "storage":
      // Kept for reloads in this tab; a new session starts from omr.config.json
      sessionStorage.setItem(storageKey, JSON.stringify(message.storage));
      break;
  }
});
logic.port1.start();
worker.addEventListener("error", (event) => console.error("[omr] logic layer:", event.message));

addEventListener(
  "message",
  (event: MessageEvent<{ omr?: string; webviewId: number; message: ViewToLogic }>) => {
    // A sandboxed page's origin is "null", so the sender is identified by its window
    if (event.data?.omr !== "view") return;
    const page = pages.get(event.data.webviewId);
    if (!page || event.source !== page.iframe.contentWindow) return;
    toLogic({ type: "view", webviewId: event.data.webviewId, message: event.data.message });
  },
);

// What the page in a <web-view> sends: JSSDK bridge calls and its loads
addEventListener("message", (event: MessageEvent<BridgeToShell>) => {
  if (event.data?.omr !== "jsbridge") return;
  const page = [...pages.values()].find(
    (view) => view.web && event.source === view.web.frame.contentWindow,
  );
  if (!page?.web) return;
  const webviewId = page.entry.webviewId;
  const data = event.data;
  switch (data.type) {
    case "invoke":
      toLogic({
        type: "webViewInvoke",
        webviewId,
        callId: data.callId,
        name: data.name,
        args: data.args,
      });
      break;
    case "load":
    case "location":
      page.web.canGoBack = data.canGoBack;
      page.web.title = data.title;
      toLogic({ type: "webViewEvent", webviewId, name: data.type, detail: { src: data.url } });
      applyWindow(page);
      if (lastRoute) onRoute(lastRoute);
      break;
    case "title":
      page.web.title = data.title;
      applyWindow(page);
      break;
    case "error":
      toLogic({
        type: "webViewEvent",
        webviewId,
        name: "error",
        detail: { url: data.url, fullUrl: data.fullUrl },
      });
      break;
  }
});

/** Tells web-view pages whether the Mini Program is in the foreground, as `WeixinJSBridge.on("onPageStateChange")` hears. */
function webViewPageState(active: boolean): void {
  for (const page of pages.values()) {
    toBridge(page, { omr: "jsbridge-event", name: "onPageStateChange", data: { active } });
  }
}

/** Leaves the Mini Program, as the capsule's close button does. */
function appHide(): void {
  if (!backgroundScreen.hidden) return;
  backgroundScreen.hidden = false;
  root.classList.add("omr-in-background");
  document.documentElement.dataset.omrAppState = "background";
  backgroundButton.textContent = "回前台";
  toLogic({ type: "appHide" });
  webViewPageState(false);
}
/** Comes back to the Mini Program from `scene`. */
function appShow(scene = 1001): void {
  if (backgroundScreen.hidden) return;
  backgroundScreen.hidden = true;
  root.classList.remove("omr-in-background");
  document.documentElement.dataset.omrAppState = "foreground";
  backgroundButton.textContent = "切后台";
  toLogic({ type: "appShow", scene });
  webViewPageState(true);
}

/** Paints the device in the system theme: WeChat's own UI, the window and tab bar variables, and each page. */
function applyTheme(): void {
  root.classList.toggle("omr-theme-dark", theme === "dark");
  document.documentElement.dataset.omrTheme = theme;
  themeButton.textContent = theme === "dark" ? "浅色模式" : "深色模式";
  tabBar = themedTabBar();
  for (const page of pages.values()) {
    page.window = { ...themedWindow(page.entry.route), ...page.changes };
    applyWindow(page);
    page.iframe.style.colorScheme = theme;
    page.iframe.contentWindow?.postMessage(
      { omr: "theme", dark: darkmode && theme === "dark" },
      "*",
    );
    if (manifest.themeVariables) {
      const win = page.window;
      const text = (value: unknown) => (typeof value === "string" ? value : undefined);
      const background = {
        type: "background",
        color: text(win.backgroundColor),
        top: text(win.backgroundColorTop),
        bottom: text(win.backgroundColorBottom),
        textStyle: text(win.backgroundTextStyle),
      };
      page.iframe.contentWindow?.postMessage({ omr: "logic", message: background }, "*");
    }
  }
  if (lastRoute) onRoute(lastRoute);
}
function setTheme(next: Theme): void {
  if (next === theme) return;
  theme = next;
  applyTheme();
  toLogic({ type: "theme", theme });
}

// Controls outside the device, as WeChat DevTools has above its simulator
const toolbar = el("div", "omr-toolbar");
const themeButton = el("button", "omr-toolbar-button");
themeButton.setAttribute("type", "button");
themeButton.dataset.omrAction = "toggleTheme";
themeButton.addEventListener("click", () => setTheme(theme === "dark" ? "light" : "dark"));
const backgroundButton = el("button", "omr-toolbar-button", "切后台");
backgroundButton.setAttribute("type", "button");
backgroundButton.dataset.omrAction = "toggleBackground";
backgroundButton.addEventListener("click", () => (backgroundScreen.hidden ? appHide() : appShow()));
toolbar.append(themeButton, backgroundButton);
root.before(toolbar);
// For automation: window.omr.appHide(), appShow(scene), setTheme("dark")
Object.assign(window, { omr: { appHide, appShow, setTheme } });
document.documentElement.dataset.omrAppState = "foreground";
applyTheme();

const launchParam = params.get("page");
const [launchPath = "", launchSearch = ""] = (launchParam ?? "").replace(/^\/+/, "").split("?", 2);
const saved = sessionStorage.getItem(storageKey);
toLogic({
  type: "boot",
  manifest,
  system,
  menuButton,
  chrome: { navigationBar: navHeight, tabBar: TAB_BAR_HEIGHT + device.safeAreaBottom },
  appService,
  storage: saved ? (JSON.parse(saved) as Record<string, unknown>) : undefined,
  launch: launchPath
    ? { path: launchPath, query: Object.fromEntries(new URLSearchParams(launchSearch)) }
    : undefined,
  scene: Number(params.get("scene")) || undefined,
  theme,
});
