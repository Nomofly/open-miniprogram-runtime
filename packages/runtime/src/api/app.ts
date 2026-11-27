/**
 * App-level APIs: app and route events, `wx.rewriteRoute`, API category,
 * batch storage, buffer URLs, fonts, the alert before leaving a page, the
 * keyboard and the window, and the base utilities around them.
 */
import { toJsonValue } from "../data.ts";
import type { ViewRequest } from "../protocol.ts";
import { ApiError, asyncApi, respond, safeCall, type AnyFunction, type Options } from "./common.ts";
import type { ApiContext } from "./context.ts";

/** Events with `wx.on<Name>` and `wx.off<Name>`. */
const EVENTS = [
  "Error",
  "UnhandledRejection",
  "PageNotFound",
  "AppShow",
  "AppHide",
  "ThemeChange",
  "LazyLoadError",
  "AudioInterruptionBegin",
  "AudioInterruptionEnd",
  "BeforeAppRoute",
  "AppRoute",
  "AppRouteDone",
  "BeforePageLoad",
  "AfterPageLoad",
  "BeforePageUnload",
  "AfterPageUnload",
  "ApiCategoryChange",
  "KeyboardHeightChange",
  "KeyDown",
  "KeyUp",
  "WindowResize",
  "WindowStateChange",
] as const;
export type AppEvent = (typeof EVENTS)[number];

/** What the logic layer drives in this module. */
export interface AppHooks {
  /** Calls the `wx.on<event>` listeners. */
  emit(event: AppEvent, res: unknown): void;
  /** Whether `wx.on<event>` has listeners. */
  listening(event: AppEvent): boolean;
  /**
   * Calls the `wx.onBeforeAppRoute` listeners; `wx.rewriteRoute` works only
   * while they run, through `rewrite`, which throws the fail reason.
   */
  beforeAppRoute(
    res: Record<string, unknown>,
    rewrite: (url: string, preserveQuery: boolean) => void,
  ): void;
  /** The message of `wx.enableAlertBeforeUnload` on a page, if it is on. */
  alertBeforeUnload(webviewId: number): string | undefined;
  /** A page's view is ready for requests: it gets the global fonts. */
  pageOpened(webviewId: number): void;
  /** A page's view answered a request. */
  viewReply(
    webviewId: number,
    requestId: number,
    result?: Record<string, unknown>,
    error?: string,
  ): void;
  releasePage(webviewId: number): void;
}

export function createAppApis(ctx: ApiContext): { apis: Record<string, unknown>; hooks: AppHooks } {
  const { host } = ctx;
  const listeners = new Map<AppEvent, Set<AnyFunction>>(EVENTS.map((name) => [name, new Set()]));
  const emit = (event: AppEvent, res: unknown) => {
    for (const listener of Array.from(listeners.get(event)!)) safeCall(listener, res);
  };

  const currentWebview = () => {
    const webviewId = host.topWebviewId();
    if (webviewId === undefined) throw new Error("no page is open");
    return webviewId;
  };

  // Requests the view answers, such as loading a font
  let nextRequestId = 0;
  const pending = new Map<
    number,
    { webviewId: number; resolve: AnyFunction; reject: AnyFunction }
  >();
  const ask = (webviewId: number, request: ViewRequest) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const requestId = ++nextRequestId;
      pending.set(requestId, { webviewId, resolve, reject });
      host.sendView(webviewId, { type: "viewRequest", requestId, request });
    });

  /** Pages whose view is ready, and the global fonts every page gets. */
  const openPages = new Set<number>();
  const globalFonts: Extract<ViewRequest, { kind: "loadFontFace" }>[] = [];
  const alerts = new Map<number, string>();

  let rewriter: ((url: string, preserveQuery: boolean) => void) | undefined;

  const hooks: AppHooks = {
    emit,
    listening: (event) => listeners.get(event)!.size > 0,
    beforeAppRoute(res, rewrite) {
      rewriter = rewrite;
      try {
        emit("BeforeAppRoute", res);
      } finally {
        rewriter = undefined;
      }
    },
    alertBeforeUnload: (webviewId) => alerts.get(webviewId),
    pageOpened(webviewId) {
      openPages.add(webviewId);
      for (const font of globalFonts) void ask(webviewId, font).catch(() => {});
    },
    viewReply(webviewId, requestId, result, error) {
      const request = pending.get(requestId);
      if (request?.webviewId !== webviewId) return;
      pending.delete(requestId);
      if (error === undefined) request.resolve(result ?? {});
      else request.reject(new Error(error));
    },
    releasePage(webviewId) {
      openPages.delete(webviewId);
      alerts.delete(webviewId);
      for (const [id, request] of pending) {
        if (request.webviewId !== webviewId) continue;
        pending.delete(id);
        request.reject(new Error("page is closed"));
      }
    },
  };

  const listenerApis: Record<string, AnyFunction> = {};
  for (const event of EVENTS) {
    const set = listeners.get(event)!;
    listenerApis[`on${event}`] = (listener: AnyFunction) => {
      if (typeof listener === "function") set.add(listener);
    };
    listenerApis[`off${event}`] = (listener?: AnyFunction) => {
      if (typeof listener === "function") set.delete(listener);
      else set.clear();
    };
  }

  const storageList = (list: unknown, name: string): unknown[] => {
    if (!Array.isArray(list)) throw new Error(`parameter.${name} should be Array`);
    return list;
  };
  const batchSet = (kvList: unknown) => {
    const entries = storageList(kvList, "kvList") as { key?: unknown; value?: unknown }[];
    for (const entry of entries) {
      if (typeof entry?.key !== "string" || entry.key === "") {
        throw new Error("parameter.kvList[].key should be String");
      }
    }
    for (const { key, value } of entries) host.storage[key as string] = toJsonValue(value);
    host.saveStorage();
  };
  const batchGet = (keyList: unknown) =>
    storageList(keyList, "keyList").map((key) =>
      typeof key === "string" && key in host.storage ? toJsonValue(host.storage[key]) : "",
    );

  const extensionOf = (buffer: Uint8Array) =>
    buffer[0] === 0x89 && buffer[1] === 0x50
      ? "png"
      : buffer[0] === 0xff && buffer[1] === 0xd8
        ? "jpg"
        : buffer[0] === 0x47 && buffer[1] === 0x49
          ? "gif"
          : "bin";

  const userAgent = () => {
    const { system, platform, version, language } = host.system as Record<string, string>;
    const os =
      platform === "android"
        ? `Linux; ${system}; Simulator Build/OMR; wv`
        : `iPhone; CPU iPhone OS ${String(system)
            .replace(/^iOS\s*/, "")
            .replace(/\./g, "_")} like Mac OS X`;
    return `Mozilla/5.0 (${os}) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/${version} NetType/WIFI Language/${language ?? "zh_CN"} miniProgram/${host.manifest.appid}`;
  };

  const skylineInfo = () => ({ isSupported: false, reason: "client not supported" });

  const apis: Record<string, unknown> = {
    ...listenerApis,

    // Base utilities
    base64ToArrayBuffer: (base64: string) => {
      const binary = atob(String(base64).replace(/[^A-Za-z0-9+/=]/g, ""));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    },
    arrayBufferToBase64: (buffer: ArrayBuffer | ArrayBufferView) => {
      const bytes = ArrayBuffer.isView(buffer)
        ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        : new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    },
    getSystemInfoAsync: asyncApi(
      "getSystemInfoAsync",
      async () => ctx.wx.getSystemInfoSync() as Record<string, unknown>,
      { promise: false },
    ),
    // The Promise resolves with the user agent itself; callbacks get `{ userAgent }`
    getRendererUserAgent: (options: Options = {}) => {
      const promise = Promise.resolve().then(userAgent);
      void promise.then((value) =>
        respond(
          [options.success, options.complete],
          { userAgent: value, errMsg: "getRendererUserAgent:ok" },
          false,
        ),
      );
      return promise;
    },
    getSkylineInfo: asyncApi("getSkylineInfo", async () => skylineInfo(), { promise: false }),
    getSkylineInfoSync: skylineInfo,
    getApiCategory: () =>
      typeof host.launchOptions.apiCategory === "string"
        ? host.launchOptions.apiCategory
        : "default",

    // Routes
    rewriteRoute: (options: Options = {}) => {
      let result: { errMsg: string };
      try {
        if (!rewriter) throw new Error("can only be called in a wx.onBeforeAppRoute listener");
        if (typeof options.url !== "string") throw new Error("parameter.url should be String");
        rewriter(options.url, options.preserveQuery === true);
        result = { errMsg: "rewriteRoute:ok" };
      } catch (error) {
        result = { errMsg: `rewriteRoute:fail ${(error as Error).message}` };
      }
      const ok = result.errMsg === "rewriteRoute:ok";
      void Promise.resolve().then(() =>
        respond([ok ? options.success : options.fail, options.complete], result, false),
      );
    },

    // Storage
    batchSetStorageSync: batchSet,
    batchGetStorageSync: batchGet,
    batchSetStorage: asyncApi("batchSetStorage", async (options) => {
      batchSet(options.kvList);
      return {};
    }),
    batchGetStorage: asyncApi("batchGetStorage", async (options) => ({
      dataList: batchGet(options.keyList),
    })),
    // A temporary file, so <image>, audio and the file APIs read it like any other
    createBufferURL: (buffer: ArrayBuffer | ArrayBufferView) => {
      if (!(buffer instanceof ArrayBuffer) && !ArrayBuffer.isView(buffer)) {
        throw new TypeError("createBufferURL expects an ArrayBuffer or TypedArray");
      }
      const bytes = ArrayBuffer.isView(buffer)
        ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        : new Uint8Array(buffer);
      return ctx.files.writeTemp(bytes.slice(), extensionOf(bytes));
    },
    revokeBufferURL: (url: string) => {
      try {
        host.fs.call("unlink", { path: String(url) });
      } catch {
        // Already gone
      }
    },

    // Fonts
    loadFontFace: asyncApi("loadFontFace", async (options) => {
      if (typeof options.family !== "string" || !options.family) {
        throw new Error("parameter.family should be String");
      }
      if (typeof options.source !== "string" || !options.source) {
        throw new Error("parameter.source should be String");
      }
      const request: ViewRequest = {
        kind: "loadFontFace",
        family: options.family,
        source: options.source,
        desc: (options.desc as Record<string, string> | undefined) ?? {},
      };
      const webviewId = currentWebview();
      if (options.global === true) {
        globalFonts.push(request);
        for (const other of openPages) {
          if (other !== webviewId) void ask(other, request).catch(() => {});
        }
      }
      try {
        await ask(webviewId, request);
      } catch (error) {
        throw new Error(`a network error occurred. ${(error as Error).message}`.trim());
      }
      return { status: "loaded" };
    }),
    // WeChat's own fonts are not available; text falls back to the system font
    loadBuiltInFontFace: asyncApi("loadBuiltInFontFace", async () => ({})),

    // Interaction
    // The alert belongs to the page that asked for it, which need not be the page on top
    enableAlertBeforeUnload: (options?: Options) => {
      const webviewId = host.callerWebviewId();
      return asyncApi(
        "enableAlertBeforeUnload",
        async (options) => {
          if (typeof options.message !== "string")
            throw new Error("parameter.message should be String");
          if (webviewId === undefined) throw new Error("no page is open");
          alerts.set(webviewId, options.message);
          return {};
        },
        { promise: false },
      )(options);
    },
    disableAlertBeforeUnload: (options?: Options) => {
      const webviewId = host.callerWebviewId();
      return asyncApi(
        "disableAlertBeforeUnload",
        async () => {
          if (webviewId !== undefined) alerts.delete(webviewId);
          return {};
        },
        { promise: false },
      )(options);
    },

    // Keyboard: the simulated device has no on-screen keyboard
    hideKeyboard: asyncApi("hideKeyboard", async () => {
      await ask(currentWebview(), { kind: "hideKeyboard" });
      return {};
    }),
    getSelectedTextRange: asyncApi("getSelectedTextRange", async () => {
      const range = await ask(currentWebview(), { kind: "selectedTextRange" });
      if (range.start === undefined) throw new ApiError("no focused input");
      return range;
    }),

    // Window: a phone's window does not change size on request
    setWindowSize: asyncApi("setWindowSize", async () => {
      throw new Error("not supported on this platform");
    }),
    checkIsPictureInPictureActive: () => false,

    // Performance and subpackages: everything is in the code package already
    preloadWebview: asyncApi("preloadWebview", async () => ({})),
    preloadSkylineView: asyncApi("preloadSkylineView", async () => ({})),
    preloadAssets: asyncApi("preloadAssets", async (options) => {
      if (!Array.isArray(options.data)) throw new Error("parameter.data should be Array");
      return {};
    }),
    preDownloadSubpackage: (options: Options = {}) => {
      const progress = new Set<AnyFunction>();
      const started = asyncApi("preDownloadSubpackage", async () => {
        if (options.packageType !== "workers") throw new Error("packageType should be workers");
        for (const listener of progress) {
          safeCall(listener, { progress: 100, totalBytesWritten: 0, totalBytesExpectedToWrite: 0 });
        }
        return {};
      })({ success: options.success, fail: options.fail, complete: options.complete });
      // Without callbacks the result is only reported through the task
      (started as Promise<unknown> | undefined)?.catch(() => {});
      return {
        onProgressUpdate: (listener: AnyFunction) => {
          if (typeof listener === "function") progress.add(listener);
        },
        offProgressUpdate: (listener?: AnyFunction) => {
          if (listener) progress.delete(listener);
          else progress.clear();
        },
      };
    },
  };
  return { apis, hooks };
}
