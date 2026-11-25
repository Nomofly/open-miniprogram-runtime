/**
 * One page's view layer. The shell opens it in a sandboxed iframe with an
 * opaque origin, so page code (WXS, built-in components) cannot reach the shell's
 * DOM: the device chrome, other pages or system dialogs. Everything arrives and
 * leaves through `postMessage`; the page bundle comes from the shell, because a
 * sandboxed page cannot fetch from the simulator without CORS.
 */
import type { WebviewBundle } from "@omr/compiler";
import { startView } from "@omr/renderer";
import type { AdConfig, LogicToView } from "@omr/runtime";

/** The first message from the shell. */
export interface WebviewInit {
  omr: "init";
  webviewId: number;
  bundle: WebviewBundle;
  windowWidth: number;
  hairline: number;
  styleV2: boolean;
  /** Whether built-in components take their dark defaults: app.json `"darkmode": true` in the dark theme. */
  dark: boolean;
  /** `ad` of omr.config.json, for `<ad>` and `<ad-custom>`. */
  ad?: AdConfig;
}

type FromShell =
  | WebviewInit
  | { omr: "logic"; message: LogicToView }
  /** The theme changed; `prefers-color-scheme` follows the iframe's `color-scheme` by itself. */
  | { omr: "theme"; dark: boolean };

let handle: ((message: LogicToView) => void) | undefined;

addEventListener("message", (event: MessageEvent<FromShell>) => {
  if (event.source !== parent) return;
  const data = event.data;
  if (data?.omr === "init" || data?.omr === "theme") {
    document.documentElement.classList.toggle("omr-dark", data.dark);
  }
  if (data?.omr === "init" && !handle) {
    // The opaque origin cannot be named, so the shell's origin is this document's URL origin
    const shell = location.origin;
    handle = startView({
      bundle: data.bundle,
      windowWidth: data.windowWidth,
      hairline: data.hairline,
      assetBase: "/__omr/files/",
      styleV2: data.styleV2,
      ad: data.ad,
      post: (message) =>
        parent.postMessage({ omr: "view", webviewId: data.webviewId, message }, shell),
    });
  } else if (data?.omr === "logic") {
    handle?.(data.message);
  }
});
