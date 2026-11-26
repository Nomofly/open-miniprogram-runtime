/**
 * What WeChat puts into a `<web-view>` page, injected by the simulator's
 * web-view proxy at the top of each HTML document: `WeixinJSBridge`, which the
 * JSSDK (jweixin) calls, `window.__wxjs_environment` and a user agent with
 * `MicroMessenger` and `miniProgram`. Bridge calls go to the shell by
 * `postMessage`; the shell answers them through the logic layer.
 *
 * The page runs at the proxy's origin, which mirrors the real one path for
 * path, so links and history work as on the real site.
 */

/** Set by the proxy in a script before this one. */
export interface WebViewBridgeConfig {
  /** The real origin the proxy stands in for, such as `https://h5.example.com`. */
  origin: string;
  userAgent: string;
  /** Set on the proxy's error page: the document could not be loaded. */
  error?: { url: string; fullUrl: string };
}

/** What the bridge sends the shell. */
export type BridgeToShell = { omr: "jsbridge" } & (
  | { type: "invoke"; callId: number; name: string; args: Record<string, unknown> }
  /** A document loaded (`load`), or the page changed its URL without loading (`location`). */
  | { type: "load" | "location"; url: string; title: string; canGoBack: boolean }
  /** The page's title changed. */
  | { type: "title"; title: string }
  | { type: "error"; url: string; fullUrl: string }
);

/** What the shell sends the bridge. */
export type ShellToBridge =
  | { omr: "jsbridge-result"; callId: number; result: Record<string, unknown> }
  /** An event the page listens to with `WeixinJSBridge.on`, such as `onPageStateChange`. */
  | { omr: "jsbridge-event"; name: string; data: Record<string, unknown> }
  /** The navigation bar's back button, while the web page can go back. */
  | { omr: "jsbridge-back" };

type Callback = (result: Record<string, unknown>) => void;

const scope = window as unknown as {
  __omrWebView?: WebViewBridgeConfig;
  __wxjs_environment?: string;
  WeixinJSBridge?: unknown;
  navigation?: { canGoBack: boolean };
};
const config = scope.__omrWebView;
delete scope.__omrWebView;

if (config && window.parent !== window) {
  const send = (message: Record<string, unknown>) => {
    const data = { omr: "jsbridge", ...message };
    try {
      window.parent.postMessage(data, "*");
    } catch {
      // Arguments that cannot be cloned, such as functions, are dropped as JSON drops them
      window.parent.postMessage(JSON.parse(JSON.stringify(data)), "*");
    }
  };
  /** The real URL of the page: the proxy's path at the real origin. */
  const realUrl = () => config.origin + location.pathname + location.search + location.hash;
  const state = (type: "load" | "location") =>
    send({ type, url: realUrl(), title: document.title, canGoBack: canGoBack() });
  // The Navigation API sees only this frame's own entries, unlike `history.length`
  const canGoBack = () => scope.navigation?.canGoBack ?? false;

  if (config.error) {
    const { url, fullUrl } = config.error;
    addEventListener("load", () => send({ type: "error", url, fullUrl }));
  } else {
    Object.defineProperty(Navigator.prototype, "userAgent", {
      get: () => config.userAgent,
      configurable: true,
    });
    Object.defineProperty(Navigator.prototype, "appVersion", {
      get: () => config.userAgent.replace(/^Mozilla\//, ""),
      configurable: true,
    });
    scope.__wxjs_environment = "miniprogram";

    let nextCallId = 0;
    const pending = new Map<number, Callback>();
    const listeners = new Map<string, Callback[]>();
    const invoke = (name: string, args?: Record<string, unknown>, callback?: Callback) => {
      const callId = ++nextCallId;
      if (typeof callback === "function") pending.set(callId, callback);
      send({ type: "invoke", callId, name: String(name), args: args ?? {} });
    };
    scope.WeixinJSBridge = Object.freeze({
      invoke,
      call: (name: string, args?: Record<string, unknown>, callback?: Callback) =>
        invoke(name, args, callback),
      on: (name: string, callback: Callback) => {
        if (typeof callback !== "function") return;
        listeners.set(name, [...(listeners.get(name) ?? []), callback]);
      },
    });

    addEventListener("message", (event: MessageEvent<ShellToBridge>) => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (data?.omr === "jsbridge-result") {
        const callback = pending.get(data.callId);
        pending.delete(data.callId);
        callback?.(data.result);
      } else if (data?.omr === "jsbridge-event") {
        for (const callback of listeners.get(data.name) ?? []) callback(data.data);
      } else if (data?.omr === "jsbridge-back") {
        history.back();
      }
    });

    // WeChat announces the bridge once the document is parsed; it is usable before that
    const ready = () => document.dispatchEvent(new Event("WeixinJSBridgeReady"));
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", ready, { once: true });
    } else {
      ready();
    }
    addEventListener("load", () => {
      state("load");
      // The navigation bar shows the page's title, including later changes
      let title = document.title;
      new MutationObserver(() => {
        if (document.title === title) return;
        title = document.title;
        send({ type: "title", title });
      }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    });

    // A single-page app changes its URL without loading
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
        original.apply(this, args);
        state("location");
      };
    }
    addEventListener("popstate", () => state("location"));
    addEventListener("hashchange", () => state("location"));

    // Links to the real origin stay in the proxy, so the page keeps its bridge
    document.addEventListener(
      "click",
      (event) => {
        const link = (event.target as Element | null)?.closest?.("a[href]");
        if (!(link instanceof HTMLAnchorElement) || event.defaultPrevented) return;
        if (link.target && link.target !== "_self") return;
        const url = new URL(link.href);
        if (url.origin !== config.origin) return;
        event.preventDefault();
        location.assign(location.origin + url.pathname + url.search + url.hash);
      },
      true,
    );

    // On Android a chosen image's localId is an image URL WeChat serves; ask the bridge for its data
    document.addEventListener(
      "error",
      (event) => {
        const img = event.target;
        if (!(img instanceof HTMLImageElement) || !img.src.startsWith("weixin://resourceid/")) {
          return;
        }
        invoke("getLocalImgData", { localId: img.src }, (result) => {
          if (typeof result.localData === "string") {
            img.src = `data:image/png;base64,${result.localData}`;
          }
        });
      },
      true,
    );
  }
}
