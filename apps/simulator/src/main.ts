/**
 * The simulator shell: draws the device (status bar, navigation bar, capsule,
 * tab bar), runs the logic layer in a Worker, opens one iframe per page as its
 * WebView, and relays messages between them.
 */
import type { WebviewBundle } from "@omr/compiler";
import type {
  LogicToShell,
  Manifest,
  PermissionKind,
  ShellToLogic,
  StackEntry,
  ViewToLogic,
} from "@omr/runtime";
import { DEFAULT_DEVICE, DEVICES, TAB_BAR_HEIGHT, menuButtonRect, systemInfo } from "./device.ts";
import { createUi } from "./ui.ts";
import type { WebviewInit } from "./webview.ts";
import "./style.css";

interface TabBarConfig {
  color?: string;
  selectedColor?: string;
  backgroundColor?: string;
  borderStyle?: string;
  list?: { pagePath: string; text?: string; iconPath?: string; selectedIconPath?: string }[];
}

interface PageView {
  entry: StackEntry;
  el: HTMLElement;
  iframe: HTMLIFrameElement;
  navbar: HTMLElement;
  title: HTMLElement;
  back: HTMLElement;
  /** The page's window configuration, with changes from `wx.setNavigationBar*`. */
  window: Record<string, unknown>;
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

const resolveAsset = (src: string) =>
  /^([a-z][\w+.-]*:|\/\/)/i.test(src) ? src : FILES + src.replace(/^\/+/, "");

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
const tabBar = manifest.appJson.tabBar as TabBarConfig | undefined;
const tabRoutes = (tabBar?.list ?? []).map((item) => item.pagePath.replace(/^\/+/, ""));

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
capsule.innerHTML = `<span class="omr-capsule-menu">${CAPSULE_DOTS}</span><span class="omr-capsule-divider"></span><span class="omr-capsule-close"></span>`;
const capsuleMenu = capsule.querySelector<HTMLElement>(".omr-capsule-menu")!;
/** What the capsule's menu button shows instead of its dots while a capability is in use. */
const IN_USE_ICONS: Record<PermissionKind, string> = {
  location: `<path d="M20 4L4 11l7 2 2 7z" fill="currentColor"/>`,
  record: `<rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
  camera: `<path fill-rule="evenodd" d="M4 7h3l2-2h6l2 2h3v12H4zM12 9.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z" fill="currentColor"/>`,
};
function showPermissionsInUse(kinds: PermissionKind[]): void {
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
root.append(pagesLayer, statusBar, capsule, tabBarEl, uiLayer);

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
  const custom = win.navigationStyle === "custom";
  const isTab = tabRoutes.includes(page.entry.route);
  page.navbar.hidden = custom;
  const str = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
  page.navbar.style.background = str(win.navigationBarBackgroundColor, "#000000");
  page.navbar.style.color = win.navigationBarTextStyle === "black" ? "#000000" : "#ffffff";
  page.title.textContent = str(win.navigationBarTitleText, "");
  const top = custom ? 0 : navHeight;
  const bottom = isTab ? TAB_BAR_HEIGHT + device.safeAreaBottom : 0;
  // An iframe does not stretch between top and bottom, so give it its height
  page.iframe.style.top = `${top}px`;
  page.iframe.style.height = `${device.screenHeight - top - bottom}px`;
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
  back.addEventListener("click", () => toLogic({ type: "navigateBack" }));
  const title = el("div", "omr-title");
  navbar.append(back, title);
  const iframe = document.createElement("iframe");
  iframe.className = "omr-webview";
  iframe.title = entry.route;
  // Without allow-same-origin the page gets an opaque origin: it cannot touch this document
  iframe.setAttribute("sandbox", "allow-scripts");
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
      };
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
    window: { ...manifest.windows[entry.route] },
  };
  applyWindow(page);
  pages.set(entry.webviewId, page);
  return page;
}

function renderTabBar(route: string): void {
  const items = tabBar?.list ?? [];
  const active = tabRoutes.indexOf(route);
  tabBarEl.hidden = active === -1;
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
    if (page) page.back.hidden = index === 0;
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
          page.window.navigationBarTitleText = args.title;
        else {
          page.window.navigationBarBackgroundColor = args.backgroundColor;
          page.window.navigationBarTextStyle = args.frontColor === "#ffffff" ? "white" : "black";
        }
        applyWindow(page);
        if (stack[stack.length - 1]?.webviewId === page.entry.webviewId) onRoute(lastRoute!);
      }
    } else {
      result = await ui(message.name, message.args);
    }
    toLogic({ type: "uiResult", callId: message.callId, result });
  } catch (error) {
    toLogic({ type: "uiResult", callId: message.callId, error: (error as Error).message });
  }
}

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
});
