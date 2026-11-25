/** The `wx` object of the logic layer. */
import { ANONYMOUS_NICKNAME, DEFAULT_AVATAR, encodeCode, resolveUser } from "./auth.ts";
import type { CodePayload } from "./auth.ts";
import { toJsonValue } from "./data.ts";
import type {
  LogicToView,
  Manifest,
  MenuButtonRect,
  PermissionKind,
  SelectorQueryRequest,
  SystemInfo,
} from "./protocol.ts";

type AnyFunction = (...args: any[]) => any;
type Options = Record<string, any> & {
  success?: AnyFunction;
  fail?: AnyFunction;
  complete?: AnyFunction;
};

/** The simulator endpoint that performs `wx.request` for the logic layer, avoiding CORS. */
export const REQUEST_PROXY_PATH = "/__omr/request";

export interface WxHost {
  manifest: Manifest;
  system: SystemInfo;
  menuButton: MenuButtonRect;
  /** Mutable; call `saveStorage` after changing it. */
  storage: Record<string, unknown>;
  saveStorage(): void;
  launchOptions: Record<string, unknown>;
  /** Shows native UI in the shell, such as a toast or a consent dialog, and resolves with its result. */
  ui(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  navigate(openType: string, options: { url?: string; delta?: number }): void;
  topWebviewId(): number | undefined;
  scopeOf(instance: object): { webviewId: number; nodeId: number } | undefined;
  query(webviewId: number, requests: SelectorQueryRequest[]): Promise<unknown[]>;
  sendView(webviewId: number, message: LogicToView): void;
  /** How far the current page's window starts below the screen top and ends above its bottom. */
  windowInsets(): { top: number; bottom: number };
  /** Shows in the capsule which capabilities are in use. */
  setPermissionsInUse(kinds: PermissionKind[]): void;
}

/** Descriptions WeChat shows in `wx.authorize` dialogs, by scope. */
export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "scope.userLocation": "获取你的位置信息",
  "scope.userFuzzyLocation": "获取你的模糊地理位置",
  "scope.userLocationBackground": "在后台获取你的位置信息",
  "scope.record": "使用你的麦克风",
  "scope.camera": "使用你的摄像头",
  "scope.bluetooth": "使用你的蓝牙",
  "scope.writePhotosAlbum": "保存图片或视频到你的相册",
  "scope.addPhoneContact": "添加到你的手机通讯录",
  "scope.addPhoneCalendar": "添加到你的手机日历",
  "scope.werun": "获取你的微信运动步数",
  "scope.address": "获取你的通讯地址",
  "scope.invoiceTitle": "获取你的发票抬头",
  "scope.invoice": "获取你的发票",
  "scope.userInfo": "获取你的昵称、头像",
};

/** An API failure; `errno` is set where WeChat sets one. */
class ApiError extends Error {
  readonly errno?: number;
  constructor(message: string, errno?: number) {
    super(message);
    this.errno = errno;
  }
}

/**
 * Whether code runs in response to a user tap. WeChat keeps this state for the
 * tap handler and its microtasks, loses it after `setTimeout`, and passes it on
 * to the callbacks of a few APIs such as `wx.login`.
 */
let tapGesture = false;
let tapGestureReset: ReturnType<typeof setTimeout> | undefined;

/** Runs a tap or button open-type handler with the tap state. */
export function runWithTapGesture(run: () => void) {
  tapGesture = true;
  // The state ends with the current macrotask; entering it again from a microtask does not extend it
  tapGestureReset ??= setTimeout(() => {
    tapGesture = false;
    tapGestureReset = undefined;
  }, 0);
  run();
}

/** Calls API callbacks, with the tap state when the call was made with it. */
function respond(callbacks: (AnyFunction | undefined)[], result: unknown, tapped: boolean) {
  const call = () => callbacks.forEach((callback) => safeCall(callback, result));
  if (tapped) runWithTapGesture(call);
  else call();
}

const requireTapGesture = () => {
  if (!tapGesture) throw new Error("can only be invoked by user TAP gesture.");
};

interface AsyncApiOptions {
  /** False for APIs that return no Promise when called without callbacks. */
  promise?: boolean;
  /** Whether callbacks keep the tap state of the call. */
  passesTapGesture?: boolean;
}

/** Calls an async API implementation with WeChat's callback and Promise conventions. */
function asyncApi(
  name: string,
  impl: (options: Options) => Promise<Record<string, unknown>>,
  { promise: returnsPromise = true, passesTapGesture = false }: AsyncApiOptions = {},
) {
  return (options: Options = {}) => {
    const tapped = tapGesture;
    const promise = Promise.resolve()
      .then(() => impl(options))
      .then(
        (result) => ({ errMsg: `${name}:ok`, ...result }),
        (error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          const errno = error instanceof ApiError ? error.errno : undefined;
          throw {
            errMsg: `${name}:fail ${reason}`.trimEnd(),
            ...(errno === undefined ? {} : { errno }),
          };
        },
      );
    if (!options.success && !options.fail && !options.complete) {
      if (returnsPromise) return promise;
      promise.catch(() => {});
      return undefined;
    }
    const keepTap = passesTapGesture && tapped;
    promise.then(
      (result) => respond([options.success, options.complete], result, keepTap),
      (error) => respond([options.fail, options.complete], error, keepTap),
    );
    return undefined;
  };
}

function safeCall(fn: AnyFunction | undefined, arg: unknown) {
  if (typeof fn !== "function") return;
  try {
    fn(arg);
  } catch (error) {
    console.error("[omr] error in API callback:", error);
  }
}

/** Scopes `wx.authorize` no longer asks for: the APIs are called directly, or the data is withdrawn. */
const SCOPES_WITHOUT_AUTHORIZATION = new Set([
  "scope.address",
  "scope.invoiceTitle",
  "scope.invoice",
  "scope.userInfo",
]);

/** The order of the capsule's in-use icons. */
const PERMISSION_KINDS: PermissionKind[] = ["camera", "record", "location"];
/** How long the capsule shows the location icon after a one-off `wx.getLocation`. */
const LOCATION_IN_USE_MS = 3000;
/** How often `wx.onLocationChange` listeners hear from `wx.startLocationUpdate`. */
const LOCATION_UPDATE_MS = 1000;

const PRIVACY_NOT_AUTHORIZED = "privacy permission is not authorized";
/** The errno of a call the user refused in the privacy popup. */
const PRIVACY_ERRNO = 104;
/** After the user refuses the official privacy popup, calls fail without it for this long. */
const PRIVACY_REFUSAL_QUIET_MS = 10_000;

export function createWx(host: WxHost) {
  const { manifest } = host;
  const authConfig = manifest.config.auth ?? {};
  const user = resolveUser(authConfig.user);
  const authSetting: Record<string, boolean> = { ...authConfig.authSetting };
  let sessionValid = !authConfig.sessionExpired;
  const consent = authConfig.consent ?? "ask";
  const privacyContractName =
    authConfig.privacy?.contractName ?? `《${manifest.appName}小程序隐私保护指引》`;
  let privacyAgreed = authConfig.privacy?.agreed === true;
  let privacyRefusedAt = -Infinity;
  let privacyListener: AnyFunction | undefined;
  /** Ids of `agreePrivacyAuthorization` buttons the user has tapped. */
  const agreeButtons = new Set<string>();

  const askConsent = async (dialog: string, args: Record<string, unknown>) => {
    if (consent !== "ask") return consent === "allow";
    const result = await host.ui(dialog, { appName: manifest.appName, ...args });
    return result.allow === true;
  };

  /**
   * Holds a privacy API call until the user has agreed to the privacy guide: the
   * Mini Program's `wx.onNeedPrivacyAuthorization` listener asks, or WeChat's
   * own popup when there is none.
   */
  const requirePrivacy = async (referrer: string) => {
    if (privacyAgreed) return;
    // Undefined when the listener throws: WeChat shows its own popup when the developer does not respond
    const listener = privacyListener;
    const answer = listener
      ? await new Promise<Record<string, unknown> | undefined>((resolve) => {
          const resolvePrivacy = (result?: Record<string, unknown>) => {
            if (result?.event !== "exposureAuthorization") resolve(result ?? {});
          };
          try {
            listener(resolvePrivacy, { referrer });
          } catch (error) {
            console.error("[omr] error in onNeedPrivacyAuthorization listener:", error);
            resolve(undefined);
          }
        })
      : undefined;
    if (answer) {
      if (answer.event === "agree") {
        const { buttonId } = answer;
        if (typeof buttonId === "string" && agreeButtons.has(buttonId)) {
          privacyAgreed = true;
          return;
        }
        console.error(
          `[omr] onNeedPrivacyAuthorization resolved "agree" with buttonId ${JSON.stringify(buttonId)}, ` +
            'but no <button open-type="agreePrivacyAuthorization"> with that id has been tapped',
        );
      }
      throw new ApiError(PRIVACY_NOT_AUTHORIZED, PRIVACY_ERRNO);
    }
    if (Date.now() - privacyRefusedAt < PRIVACY_REFUSAL_QUIET_MS) {
      throw new ApiError(PRIVACY_NOT_AUTHORIZED, PRIVACY_ERRNO);
    }
    if (await askConsent("privacy", { contractName: privacyContractName })) {
      privacyAgreed = true;
      return;
    }
    privacyRefusedAt = Date.now();
    throw new ApiError(PRIVACY_NOT_AUTHORIZED, PRIVACY_ERRNO);
  };

  /** The `detail` of a failed button open-type event. */
  const failDetail = (openType: string, error: unknown) => ({
    errMsg: `${openType}:fail ${(error as Error).message}`,
    ...(error instanceof ApiError && error.errno !== undefined ? { errno: error.errno } : {}),
  });

  const issueCode = (kind: CodePayload["kind"], extra: Partial<CodePayload> = {}) =>
    encodeCode({
      kind,
      appid: manifest.appid,
      openid: user.openid,
      unionid: user.unionid,
      sessionKey: user.sessionKey,
      issuedAt: Date.now(),
      nonce: Math.random().toString(36).slice(2, 10),
      ...extra,
    });

  // WeChat returns this anonymous profile from wx.getUserInfo, wx.getUserProfile and the getUserInfo button
  const anonymousInfo = {
    nickName: ANONYMOUS_NICKNAME,
    avatarUrl: DEFAULT_AVATAR,
    gender: 0,
    country: "",
    province: "",
    city: "",
    language: "",
    is_demote: true,
  };
  const userInfoResult = () => ({
    userInfo: { ...anonymousInfo },
    rawData: JSON.stringify(anonymousInfo),
    signature: "omr-simulated-signature",
    encryptedData: "",
    iv: "",
  });

  /** Asks for a scope the way `wx.authorize` does; resolves whether it is granted. */
  const requestScope = async (scope: string) => {
    if (authSetting[scope] !== undefined) return authSetting[scope];
    const allowed = await askConsent("authorize", {
      scope,
      description: SCOPE_DESCRIPTIONS[scope] ?? scope,
    });
    authSetting[scope] = allowed;
    return allowed;
  };

  const maskPhone = (phone: string) =>
    phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone;

  /**
   * The detail of a button `open-type` event, or undefined when the event does
   * not fire. A combined open-type such as `getPhoneNumber|agreePrivacyAuthorization`
   * arrives as one call per part, the agreement first.
   */
  const openTypeDetail = async (
    openType: string,
    buttonId: string,
  ): Promise<Record<string, unknown> | undefined> => {
    switch (openType) {
      case "agreePrivacyAuthorization":
        privacyAgreed = true;
        agreeButtons.add(buttonId);
        return {};
      case "getPhoneNumber":
      case "getRealtimePhoneNumber": {
        try {
          await requirePrivacy(`button.${openType}`);
        } catch (error) {
          return failDetail(openType, error);
        }
        const allowed = await askConsent("phoneNumber", {
          phoneNumber: maskPhone(user.phoneNumber),
        });
        if (!allowed) return { errMsg: `${openType}:fail user deny` };
        return {
          code: issueCode("phone", {
            phoneNumber: user.phoneNumber,
            countryCode: user.countryCode,
          }),
          errMsg: `${openType}:ok`,
        };
      }
      case "chooseAvatar": {
        try {
          await requirePrivacy("button.chooseAvatar");
        } catch {
          return undefined;
        }
        const allowed = await askConsent("chooseAvatar", { avatarUrl: user.avatarUrl });
        return allowed ? { avatarUrl: user.avatarUrl } : undefined;
      }
      case "getUserInfo":
        try {
          await requirePrivacy("button.getUserInfo");
        } catch (error) {
          return failDetail(openType, error);
        }
        return { ...userInfoResult(), errMsg: "getUserInfo:ok" };
      case "openSetting":
        return { authSetting: { ...authSetting }, errMsg: "openSetting:ok" };
      default:
        return {};
    }
  };

  /**
   * `<input type="nickname">` gained or lost focus. While it has focus WeChat
   * shows the user's nickname above the keyboard, but only once the privacy
   * guide is agreed; before that the input is a plain text input.
   */
  const nicknameFocus = async (focused: boolean, webviewId: number) => {
    if (!focused) {
      await host.ui("hideNicknameKeyboard", {});
      return;
    }
    if (!privacyAgreed) return;
    const result = await host.ui("nicknameKeyboard", { nickName: user.nickName });
    if (typeof result.nickName === "string") {
      host.sendView(webviewId, { type: "fillNickname", value: result.nickName });
    }
  };

  // Capabilities in use: each user holds one until it releases it
  const holders = new Map<PermissionKind, number>();
  let shownInUse = "";
  const publishInUse = () => {
    const kinds = PERMISSION_KINDS.filter((kind) => (holders.get(kind) ?? 0) > 0);
    if (kinds.join() === shownInUse) return;
    shownInUse = kinds.join();
    host.setPermissionsInUse(kinds);
  };
  const holdPermission = (kind: PermissionKind) => {
    holders.set(kind, (holders.get(kind) ?? 0) + 1);
    publishInUse();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holders.set(kind, holders.get(kind)! - 1);
      publishInUse();
    };
  };

  const requireDeclared = (api: string) => {
    const declared = (manifest.appJson.requiredPrivateInfos as string[] | undefined) ?? [];
    if (!declared.includes(api)) {
      throw new Error(
        "the api need to be declared in the requiredPrivateInfos field in app.json/ext.json",
      );
    }
  };
  /** Privacy agreement, then `scope.userLocation`, as every location API needs. */
  const requireLocation = async (api: string) => {
    requireDeclared(api);
    await requirePrivacy(api);
    if (!(await requestScope("scope.userLocation"))) throw new Error("auth deny");
  };
  const currentLocation = () => ({
    ...(manifest.config.location ?? { latitude: 39.908823, longitude: 116.39747 }),
    speed: -1,
    accuracy: 65,
    altitude: 0,
    verticalAccuracy: 65,
    horizontalAccuracy: 65,
  });

  // wx.startLocationUpdate
  const locationListeners = new Set<AnyFunction>();
  let locationUpdates: { timer: ReturnType<typeof setInterval>; release: () => void } | undefined;
  const stopLocationUpdates = () => {
    if (!locationUpdates) return;
    clearInterval(locationUpdates.timer);
    locationUpdates.release();
    locationUpdates = undefined;
  };

  // wx.getRecorderManager
  const recorderListeners: Record<string, AnyFunction | undefined> = {};
  const emitRecorder = (name: string, result: Record<string, unknown> = {}) =>
    safeCall(recorderListeners[name], result);
  let recording:
    | {
        format: string;
        /** Recorded milliseconds before the current run. */
        elapsed: number;
        /** When the current run started, or undefined while paused. */
        runningSince?: number;
        remaining: number;
        timer?: ReturnType<typeof setTimeout>;
        release?: () => void;
      }
    | undefined;
  let recorderStarting = false;
  const runRecorder = () => {
    if (!recording) return;
    recording.runningSince = Date.now();
    recording.release = holdPermission("record");
    recording.timer = setTimeout(stopRecorder, recording.remaining);
  };
  const haltRecorder = () => {
    if (!recording || recording.runningSince === undefined) return;
    const ran = Date.now() - recording.runningSince;
    recording.elapsed += ran;
    recording.remaining -= ran;
    recording.runningSince = undefined;
    clearTimeout(recording.timer);
    recording.release?.();
  };
  function stopRecorder() {
    if (!recording) return;
    haltRecorder();
    const { format, elapsed } = recording;
    recording = undefined;
    emitRecorder("onStop", {
      tempFilePath: `http://tmp/omr_${Math.random().toString(36).slice(2, 10)}.${format}`,
      duration: elapsed,
      fileSize: Math.round(elapsed * 4),
    });
  }
  const recorderManager = {
    start(options: Options = {}) {
      if (recording || recorderStarting) return;
      recorderStarting = true;
      void (async () => {
        try {
          await requirePrivacy("RecorderManager.start");
          if (!(await requestScope("scope.record"))) throw new Error("auth deny");
        } catch (error) {
          emitRecorder("onError", failDetail("operateRecorder", error));
          return;
        } finally {
          recorderStarting = false;
        }
        recording = {
          format: String(options.format ?? "aac"),
          elapsed: 0,
          remaining: Math.min(Number(options.duration ?? 60000), 600000),
        };
        runRecorder();
        emitRecorder("onStart");
      })();
    },
    pause() {
      if (recording?.runningSince === undefined) return;
      haltRecorder();
      emitRecorder("onPause");
    },
    resume() {
      if (!recording || recording.runningSince !== undefined) return;
      runRecorder();
      emitRecorder("onResume");
    },
    stop: stopRecorder,
    ...Object.fromEntries(
      ["onStart", "onPause", "onResume", "onStop", "onError", "onFrameRecorded"].map((name) => [
        name,
        (listener: AnyFunction) => {
          recorderListeners[name] = listener;
        },
      ]),
    ),
    onInterruptionBegin() {},
    onInterruptionEnd() {},
  };

  /** Releases of the `<camera>` components that show a preview, or undefined while they wait for authorization. */
  const cameras = new Map<string, (() => void) | undefined>();
  /** A `<camera>` was inserted or removed; it needs the privacy agreement and `scope.camera`. */
  const cameraMounted = async (webviewId: number, cameraId: number, mounted: boolean) => {
    const key = `${webviewId}:${cameraId}`;
    if (!mounted) {
      cameras.get(key)?.();
      cameras.delete(key);
      return;
    }
    cameras.set(key, undefined);
    let error: string | undefined;
    try {
      await requirePrivacy("camera");
      if (!(await requestScope("scope.camera"))) throw new Error("auth deny");
    } catch (reason) {
      error = `insertCamera:fail ${(reason as Error).message}`;
    }
    // Removed while it waited
    if (!cameras.has(key)) return;
    if (!error) cameras.set(key, holdPermission("camera"));
    host.sendView(webviewId, { type: "cameraState", cameraId, error });
  };
  /** A page is gone with everything it was using. */
  const releasePage = (webviewId: number) => {
    for (const [key, release] of cameras) {
      if (!key.startsWith(`${webviewId}:`)) continue;
      release?.();
      cameras.delete(key);
    }
  };

  const setStorage = (key: string, data: unknown) => {
    if (typeof key !== "string" || key === "") throw new Error("parameter.key should be String");
    host.storage[key] = toJsonValue(data);
    host.saveStorage();
  };

  const currentWebview = () => {
    const webviewId = host.topWebviewId();
    if (webviewId === undefined) throw new Error("no page is open");
    return webviewId;
  };

  /** System info with the window of the current page: a tab bar or a custom navigation bar changes its height. */
  const systemInfo = (): SystemInfo => {
    const { top, bottom } = host.windowInsets();
    const screenHeight = Number(host.system.screenHeight);
    return { ...host.system, windowHeight: screenHeight - top - bottom, screenTop: top };
  };
  const windowInfo = () => {
    const s = systemInfo();
    return {
      pixelRatio: s.pixelRatio,
      screenWidth: s.screenWidth,
      screenHeight: s.screenHeight,
      windowWidth: s.windowWidth,
      windowHeight: s.windowHeight,
      statusBarHeight: s.statusBarHeight,
      safeArea: s.safeArea,
      screenTop: s.screenTop,
    };
  };

  class NodesRef {
    private readonly query: SelectorQuery;
    private readonly request: Omit<SelectorQueryRequest, "fields">;
    constructor(query: SelectorQuery, request: Omit<SelectorQueryRequest, "fields">) {
      this.query = query;
      this.request = request;
    }
    fields(fields: SelectorQueryRequest["fields"], callback?: AnyFunction) {
      return this.query.add({ ...this.request, fields }, callback);
    }
    boundingClientRect(callback?: AnyFunction) {
      return this.fields({ id: true, dataset: true, rect: true, size: true }, callback);
    }
    scrollOffset(callback?: AnyFunction) {
      return this.fields({ id: true, dataset: true, scrollOffset: true }, callback);
    }
  }

  class SelectorQuery {
    private scope: { webviewId?: number; nodeId: number } = { nodeId: 0 };
    private readonly requests: SelectorQueryRequest[] = [];
    private readonly callbacks: (AnyFunction | undefined)[] = [];
    in(component: object) {
      const scope = host.scopeOf(component);
      if (scope) this.scope = scope;
      return this;
    }
    select(selector: string) {
      return new NodesRef(this, { selector, all: false, scopeNodeId: this.scope.nodeId });
    }
    selectAll(selector: string) {
      return new NodesRef(this, { selector, all: true, scopeNodeId: this.scope.nodeId });
    }
    selectViewport() {
      return new NodesRef(this, { selector: null, all: false, scopeNodeId: this.scope.nodeId });
    }
    add(request: SelectorQueryRequest, callback?: AnyFunction) {
      this.requests.push(request);
      this.callbacks.push(callback);
      return this;
    }
    exec(callback?: AnyFunction) {
      const webviewId = this.scope.webviewId ?? host.topWebviewId();
      if (webviewId === undefined) return;
      void host.query(webviewId, this.requests).then((results) => {
        results.forEach((result, index) => safeCall(this.callbacks[index], result));
        safeCall(callback, results);
      });
    }
  }

  const wx: Record<string, any> = {
    env: { USER_DATA_PATH: "wxfile://usr" },
    canIUse: (schema: string) => String(schema).split(".")[0]! in wx,

    // Login and user information
    login: asyncApi(
      "login",
      async () => {
        sessionValid = true;
        return { code: issueCode("login") };
      },
      { passesTapGesture: true },
    ),
    checkSession: asyncApi("checkSession", async () => {
      if (!sessionValid) throw new Error("session time out, need relogin");
      return {};
    }),
    getUserInfo: asyncApi("getUserInfo", async () => {
      await requirePrivacy("getUserInfo");
      return userInfoResult();
    }),
    getUserProfile: (options: Options = {}) => {
      // The tap state is read when the call is made
      const tapped = tapGesture;
      return asyncApi("getUserProfile", async () => {
        if (typeof options.desc !== "string" || options.desc.length === 0) {
          throw new Error("desc length does not meet the requirements");
        }
        if (!tapped) requireTapGesture();
        await requirePrivacy("getUserProfile");
        // Since base library 2.27.1 there is no dialog and the profile is anonymous
        return userInfoResult();
      })(options);
    },
    getSetting: asyncApi("getSetting", async () => ({ authSetting: { ...authSetting } }), {
      passesTapGesture: true,
    }),
    openSetting: (options: Options = {}) => {
      const tapped = tapGesture;
      return asyncApi("openSetting", async () => {
        if (!tapped) requireTapGesture();
        return { authSetting: { ...authSetting } };
      })(options);
    },
    authorize: asyncApi("authorize", async (options) => {
      const scope = String(options.scope ?? "");
      if (SCOPES_WITHOUT_AUTHORIZATION.has(scope)) return {};
      if (!(scope in SCOPE_DESCRIPTIONS)) throw new Error("invalid scope");
      await requirePrivacy("authorize");
      if (!(await requestScope(scope))) throw new Error("auth deny");
      return {};
    }),
    getPrivacySetting: asyncApi(
      "getPrivacySetting",
      async () => ({ needAuthorization: !privacyAgreed, privacyContractName }),
      { promise: false },
    ),
    requirePrivacyAuthorize: asyncApi(
      "requirePrivacyAuthorize",
      async () => {
        await requirePrivacy("requirePrivacyAuthorize");
        return {};
      },
      { promise: false },
    ),
    onNeedPrivacyAuthorization: (listener: AnyFunction) => {
      // Registering again replaces the earlier listener
      privacyListener = typeof listener === "function" ? listener : undefined;
    },
    openPrivacyContract: asyncApi("openPrivacyContract", async () => {
      void host.ui("privacyContract", { contractName: privacyContractName });
      return {};
    }),
    getAccountInfoSync: () => ({
      miniProgram: { appId: manifest.appid, envVersion: "develop", version: "" },
      plugin: {},
    }),
    getLocation: asyncApi("getLocation", async () => {
      await requireLocation("getLocation");
      setTimeout(holdPermission("location"), LOCATION_IN_USE_MS);
      return currentLocation();
    }),
    startLocationUpdate: asyncApi("startLocationUpdate", async () => {
      await requireLocation("startLocationUpdate");
      if (!locationUpdates) {
        const notify = () => {
          const location = currentLocation();
          for (const listener of locationListeners) safeCall(listener, location);
        };
        locationUpdates = {
          timer: setInterval(notify, LOCATION_UPDATE_MS),
          release: holdPermission("location"),
        };
        setTimeout(notify, 0);
      }
      return {};
    }),
    stopLocationUpdate: asyncApi("stopLocationUpdate", async () => {
      stopLocationUpdates();
      return {};
    }),
    onLocationChange: (listener: AnyFunction) => {
      if (typeof listener === "function") locationListeners.add(listener);
    },
    offLocationChange: (listener?: AnyFunction) => {
      if (listener) locationListeners.delete(listener);
      else locationListeners.clear();
    },
    getRecorderManager: () => recorderManager,

    // Storage
    setStorageSync: setStorage,
    getStorageSync: (key: string) => (key in host.storage ? toJsonValue(host.storage[key]) : ""),
    removeStorageSync: (key: string) => {
      delete host.storage[key];
      host.saveStorage();
    },
    clearStorageSync: () => {
      for (const key of Object.keys(host.storage)) delete host.storage[key];
      host.saveStorage();
    },
    getStorageInfoSync: () => ({
      keys: Object.keys(host.storage),
      currentSize: Math.ceil(JSON.stringify(host.storage).length / 1024),
      limitSize: 10240,
    }),
    setStorage: asyncApi("setStorage", async (options) => {
      setStorage(options.key, options.data);
      return {};
    }),
    getStorage: asyncApi("getStorage", async (options) => {
      if (!(options.key in host.storage)) throw new Error("data not found");
      return { data: toJsonValue(host.storage[options.key]) };
    }),
    removeStorage: asyncApi("removeStorage", async (options) => {
      wx.removeStorageSync(options.key);
      return {};
    }),
    clearStorage: asyncApi("clearStorage", async () => {
      wx.clearStorageSync();
      return {};
    }),
    getStorageInfo: asyncApi("getStorageInfo", async () => wx.getStorageInfoSync()),

    // System
    getSystemInfoSync: systemInfo,
    getSystemInfo: asyncApi("getSystemInfo", async () => systemInfo()),
    getWindowInfo: windowInfo,
    getDeviceInfo: () => ({
      brand: host.system.brand,
      model: host.system.model,
      system: host.system.system,
      platform: host.system.platform,
      pixelRatio: host.system.pixelRatio,
    }),
    getAppBaseInfo: () => ({
      SDKVersion: host.system.SDKVersion,
      version: host.system.version,
      language: host.system.language,
      theme: "light",
      enableDebug: false,
    }),
    getMenuButtonBoundingClientRect: () => ({ ...host.menuButton }),
    getLaunchOptionsSync: () => toJsonValue(host.launchOptions),
    getEnterOptionsSync: () => toJsonValue(host.launchOptions),
    getNetworkType: asyncApi("getNetworkType", async () => ({
      networkType: "wifi",
      signalStrength: 4,
      hasSystemProxy: false,
    })),
    nextTick: (fn: AnyFunction) => setTimeout(fn, 0),
    vibrateShort: asyncApi("vibrateShort", async () => ({})),
    vibrateLong: asyncApi("vibrateLong", async () => ({})),

    // Network
    request: (options: Options) => {
      const controller = new AbortController();
      // Callbacks keep the tap state of the call
      const tapped = tapGesture;
      void performRequest(options, controller.signal).then(
        (result) => respond([options.success, options.complete], result, tapped),
        (error: unknown) =>
          respond(
            [options.fail, options.complete],
            { errMsg: `request:fail ${(error as Error).message ?? error}`, errno: 600001 },
            tapped,
          ),
      );
      return {
        abort: () => controller.abort(),
        onHeadersReceived() {},
        offHeadersReceived() {},
        onChunkReceived() {},
        offChunkReceived() {},
      };
    },

    // Routing
    navigateTo: asyncApi("navigateTo", async (options) => {
      host.navigate("navigateTo", { url: options.url });
      return { eventChannel: wxEventChannel() };
    }),
    redirectTo: asyncApi("redirectTo", async (options) => {
      host.navigate("redirectTo", { url: options.url });
      return {};
    }),
    navigateBack: asyncApi("navigateBack", async (options) => {
      host.navigate("navigateBack", { delta: options.delta ?? 1 });
      return {};
    }),
    switchTab: asyncApi("switchTab", async (options) => {
      host.navigate("switchTab", { url: String(options.url ?? "").split("?")[0] });
      return {};
    }),
    reLaunch: asyncApi("reLaunch", async (options) => {
      host.navigate("reLaunch", { url: options.url });
      return {};
    }),

    // Interface
    showToast: asyncApi("showToast", async (options) =>
      host.ui("showToast", {
        title: String(options.title ?? ""),
        icon: options.icon ?? "success",
        duration: options.duration ?? 1500,
        mask: Boolean(options.mask),
      }),
    ),
    hideToast: asyncApi("hideToast", async () => host.ui("hideToast", {})),
    showLoading: asyncApi("showLoading", async (options) =>
      host.ui("showLoading", { title: String(options.title ?? ""), mask: Boolean(options.mask) }),
    ),
    hideLoading: asyncApi("hideLoading", async () => host.ui("hideLoading", {})),
    showModal: asyncApi("showModal", async (options) =>
      host.ui("showModal", {
        title: options.title ?? "",
        content: options.content ?? "",
        showCancel: options.showCancel ?? true,
        cancelText: options.cancelText ?? "取消",
        cancelColor: options.cancelColor ?? "#000000",
        confirmText: options.confirmText ?? "确定",
        confirmColor: options.confirmColor ?? "#576B95",
        editable: Boolean(options.editable),
        placeholderText: options.placeholderText ?? "",
      }),
    ),
    showActionSheet: asyncApi("showActionSheet", async (options) => {
      const result = await host.ui("showActionSheet", {
        itemList: options.itemList ?? [],
        itemColor: options.itemColor ?? "#000000",
        alertText: options.alertText ?? "",
      });
      if (typeof result.tapIndex !== "number") throw new Error("cancel");
      return result;
    }),
    setNavigationBarTitle: asyncApi("setNavigationBarTitle", async (options) =>
      host.ui("setNavigationBarTitle", {
        webviewId: currentWebview(),
        title: String(options.title ?? ""),
      }),
    ),
    setNavigationBarColor: asyncApi("setNavigationBarColor", async (options) =>
      host.ui("setNavigationBarColor", {
        webviewId: currentWebview(),
        frontColor: options.frontColor,
        backgroundColor: options.backgroundColor,
      }),
    ),
    showNavigationBarLoading: asyncApi("showNavigationBarLoading", async () => ({})),
    hideNavigationBarLoading: asyncApi("hideNavigationBarLoading", async () => ({})),
    hideHomeButton: asyncApi("hideHomeButton", async () => ({})),
    stopPullDownRefresh: asyncApi("stopPullDownRefresh", async () => ({})),
    pageScrollTo: asyncApi("pageScrollTo", async (options) => {
      host.sendView(currentWebview(), {
        type: "pageScrollTo",
        scrollTop: Number(options.scrollTop ?? 0),
        duration: Number(options.duration ?? 300),
      });
      return {};
    }),
    createSelectorQuery: () => new SelectorQuery(),
  };

  async function performRequest(options: Options, signal: AbortSignal) {
    const url = String(options.url ?? "");
    if (!/^https?:\/\//.test(url)) throw new Error("invalid url");
    const method = String(options.method ?? "GET").toUpperCase();
    const header: Record<string, string> = { ...options.header };
    const contentTypeKey = Object.keys(header).find((key) => key.toLowerCase() === "content-type");
    if (!contentTypeKey) header["content-type"] = "application/json";
    const contentType = header[contentTypeKey ?? "content-type"]!;
    let target = url;
    let body: string | undefined;
    const data = options.data;
    if (method === "GET" || method === "HEAD") {
      const query =
        typeof data === "string"
          ? data
          : data && typeof data === "object"
            ? Object.entries(data as Record<string, unknown>)
                .map(
                  ([key, value]) =>
                    `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
                )
                .join("&")
            : "";
      if (query) target += (target.includes("?") ? "&" : "?") + query;
    } else if (data !== undefined) {
      body =
        typeof data === "string"
          ? data
          : contentType.includes("x-www-form-urlencoded")
            ? new URLSearchParams(data as Record<string, string>).toString()
            : JSON.stringify(data);
    }
    const response = await fetch(REQUEST_PROXY_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: target, method, header, body }),
      signal,
    });
    const result = (await response.json()) as {
      statusCode?: number;
      header?: Record<string, string>;
      body?: string;
      error?: string;
    };
    if (result.error) throw new Error(result.error);
    let responseData: unknown = result.body ?? "";
    if ((options.dataType ?? "json") === "json" && typeof responseData === "string") {
      try {
        responseData = JSON.parse(responseData);
      } catch {
        // WeChat returns the text as is when it is not JSON
      }
    }
    return {
      data: responseData,
      statusCode: result.statusCode,
      header: result.header ?? {},
      cookies: [],
      errMsg: "request:ok",
    };
  }

  function wxEventChannel() {
    return { on() {}, once() {}, off() {}, emit() {} };
  }

  const proxy = new Proxy(wx, {
    get(target, name) {
      if (typeof name !== "string" || name in target || name === "then") {
        return target[name as string];
      }
      return (options: Options = {}) => {
        console.warn(`[omr] wx.${name} is not implemented in the simulator`);
        const result = { errMsg: `${name}:fail not implemented in the simulator` };
        safeCall(options?.fail, result);
        safeCall(options?.complete, result);
        return undefined;
      };
    },
  });

  return { wx: proxy, openTypeDetail, nicknameFocus, cameraMounted, releasePage };
}
