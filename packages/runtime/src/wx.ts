/** The `wx` object of the logic layer. */
import { ANONYMOUS_NICKNAME, DEFAULT_AVATAR, encodeCode, resolveUser } from "./auth.ts";
import type { CodePayload } from "./auth.ts";
import { toJsonValue } from "./data.ts";
import {
  ApiError,
  asyncApi,
  hasTapGesture,
  requireTapGesture,
  safeCall,
  type AnyFunction,
  type Options,
} from "./api/common.ts";
import type { ApiContext, WxHost } from "./api/context.ts";
import { createCanvasApis } from "./api/canvas.ts";
import { createDeviceApis, scannedCode } from "./api/device.ts";
import { createFileApis, createTempFiles } from "./api/files.ts";
import { createInterfaceApis } from "./api/interface.ts";
import { createMediaApis } from "./api/media.ts";
import { createContextApis } from "./api/contexts.ts";
import { createVoipApis } from "./api/voip.ts";
import { createAnimationApis } from "./api/animation.ts";
import { createNetworkApis } from "./api/network.ts";
import { createAppApis } from "./api/app.ts";
import { createObserverApis } from "./api/observers.ts";
import { createWebViewApis } from "./api/web-view.ts";
import type {
  ContextNode,
  PermissionKind,
  ScrollViewNode,
  SelectorQueryRequest,
  SystemInfo,
} from "./protocol.ts";

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

/** Scopes `wx.authorize` no longer asks for: the APIs are called directly, or the data is withdrawn. */
const SCOPES_WITHOUT_AUTHORIZATION = new Set([
  "scope.address",
  "scope.invoiceTitle",
  "scope.invoice",
  "scope.userInfo",
]);

/** The order of the capsule's in-use icons. */
/** Scenes that let `<official-account>` show, and scenes coming back to the app that keep it. */
const OFFICIAL_ACCOUNT_LAUNCH_SCENES = new Set([1011, 1017, 1025, 1047, 1124]);
const OFFICIAL_ACCOUNT_RETURN_SCENES = new Set([1001, 1038, 1041, 1089, 1090, 1104, 1131, 1187]);
/** The `binderror` reasons of `<official-account>` by `status`, as WeChat documents them. */
const OFFICIAL_ACCOUNT_ERRORS: Record<number, string> = {
  [-2]: "网络错误",
  [-1]: "数据解析错误",
  1: "小程序关注公众号功能被封禁",
  2: "关联公众号被封禁",
  3: "关联关系解除或未选中关联公众号",
  4: "未开启关注公众号功能",
  5: "场景值错误",
  6: "重复创建",
};
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
  const files = createTempFiles(host.fs);
  /**
   * WeChat gives the avatar the user picked as a temporary file, which
   * `wx.uploadFile` can send; a data URL or a package file becomes one.
   * Other URLs, such as https, stay as they are.
   */
  const avatarFile = (url: string): string => {
    const data = /^data:image\/([\w+.-]+)(;base64)?,(.*)$/s.exec(url);
    let bytes: Uint8Array | undefined;
    let extension = "png";
    if (data) {
      extension = data[1] === "svg+xml" ? "svg" : data[1]!;
      bytes = data[2]
        ? Uint8Array.from(atob(data[3]!), (char) => char.charCodeAt(0))
        : new TextEncoder().encode(decodeURIComponent(data[3]!));
    } else if (!/^[a-z][\w+.-]*:/i.test(url)) {
      bytes = files.read(url.replace(/^\/+/, ""));
      extension = /\.(\w+)$/.exec(url)?.[1] ?? "png";
    }
    return bytes ? files.writeTemp(bytes, extension) : url;
  };
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
  const scopeRequests = new Map<string, Promise<boolean>>();
  const requestScope = (scope: string): Promise<boolean> => {
    if (authSetting[scope] !== undefined) return Promise.resolve(authSetting[scope]);
    // Calls while the dialog is open wait for its answer instead of opening another
    let pending = scopeRequests.get(scope);
    if (!pending) {
      pending = askConsent("authorize", {
        scope,
        description: SCOPE_DESCRIPTIONS[scope] ?? scope,
      })
        .then((allowed) => {
          authSetting[scope] = allowed;
          return allowed;
        })
        .finally(() => scopeRequests.delete(scope));
      scopeRequests.set(scope, pending);
    }
    return pending;
  };

  const maskPhone = (phone: string) =>
    phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone;

  /** Base64 of `length` bytes derived from `seed`: stands in for ciphertext that is never decrypted. */
  const opaqueBase64 = (seed: string, length: number) => {
    let hash = 2166136261;
    let binary = "";
    for (let i = 0; i < length; i++) {
      hash = Math.imul(hash ^ seed.charCodeAt(i % seed.length) ^ i, 16777619);
      binary += String.fromCharCode(hash >>> 24);
    }
    return btoa(binary);
  };

  /**
   * The settings page of `wx.openSetting` and the `openSetting` button: one switch per
   * scope the Mini Program has asked for. Resolves with the settings once the user goes back.
   */
  const openSettingPage = async () => {
    if (consent === "ask") {
      const result = await host.ui("openSetting", {
        appName: manifest.appName,
        scopes: Object.entries(authSetting).map(([scope, allowed]) => ({
          scope,
          description: SCOPE_DESCRIPTIONS[scope] ?? scope,
          allowed,
        })),
      });
      const changed = (result.authSetting ?? {}) as Record<string, unknown>;
      for (const [scope, allowed] of Object.entries(changed)) {
        if (scope in authSetting && typeof allowed === "boolean") authSetting[scope] = allowed;
      }
    }
    return { authSetting: { ...authSetting } };
  };

  /** Splits a Mini Program path such as `pages/a/a?id=7` into `path` and `query`, as `bindcontact` gives them. */
  const splitPath = (url: string) => {
    const mark = url.indexOf("?");
    const query: Record<string, string> = {};
    if (mark < 0) return { path: url, query };
    for (const [name, value] of new URLSearchParams(url.slice(mark + 1))) query[name] = value;
    return { path: url.slice(0, mark), query };
  };

  /**
   * The detail of a button `open-type` event, or undefined when the event does
   * not fire. A combined open-type such as `getPhoneNumber|agreePrivacyAuthorization`
   * arrives as one call per part, the agreement first. `props` are the button
   * attributes the open-type reads, such as `send-message-path` for `contact`.
   */
  const openTypeDetail = async (
    openType: string,
    buttonId: string,
    props: Record<string, unknown> = {},
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
        const code = issueCode("phone", {
          phoneNumber: user.phoneNumber,
          countryCode: user.countryCode,
        });
        if (openType === "getRealtimePhoneNumber") return { code, errMsg: `${openType}:ok` };
        // Code written before the code exchange checks the encrypted fields; they do not decrypt
        return {
          code,
          encryptedData: opaqueBase64(code, 192),
          iv: opaqueBase64(`iv:${code}`, 16),
          cloudID: `01_${opaqueBase64(`cloud:${code}`, 48).replace(/[+/=]/g, "")}`,
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
        return allowed ? { avatarUrl: avatarFile(user.avatarUrl) } : undefined;
      }
      case "getUserInfo":
        try {
          await requirePrivacy("button.getUserInfo");
        } catch (error) {
          return failDetail(openType, error);
        }
        return { ...userInfoResult(), errMsg: "getUserInfo:ok" };
      case "openSetting":
        return { ...(await openSettingPage()), errMsg: "openSetting:ok" };
      case "contact": {
        // bindcontact fires when the user comes back, with the card they tapped in the chat
        const attribute = (name: string) => {
          const value = props[name];
          return typeof value === "string" || typeof value === "number" ? String(value) : "";
        };
        const card = Boolean(props["show-message-card"]);
        const result =
          consent === "ask"
            ? await host.ui("contact", {
                appName: manifest.appName,
                ...(card
                  ? {
                      card: {
                        title: attribute("send-message-title"),
                        img: attribute("send-message-img"),
                        path: attribute("send-message-path"),
                      },
                    }
                  : {}),
              })
            : {};
        const tapped = card && result.tapped === true;
        return {
          ...splitPath(tapped ? attribute("send-message-path") : ""),
          errMsg: "enterContact:ok",
        };
      }
      case "launchApp":
        // Only a Mini Program opened from an app (scene 1069) can go back to it; the view binds this to binderror
        return { errMsg: "invalid scene" };
      case "feedback":
        // WeChat tells the Mini Program nothing about the feedback page
        if (consent === "ask") void host.ui("feedback", { appName: manifest.appName });
        return undefined;
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
    // A silent file of about the size a recording of this length has
    const fileSize = Math.round(elapsed * 4);
    emitRecorder("onStop", {
      tempFilePath: files.writeTemp(new Uint8Array(fileSize), format),
      duration: elapsed,
      fileSize,
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

  /** Each `<camera>` that is on a page, with the release of its preview once it shows one. */
  type CameraEntry = {
    webviewId: number;
    cameraId: number;
    frameSize?: string;
    release?: () => void;
    error?: string;
  };
  const cameras = new Map<string, CameraEntry>();
  /** Whether the app is in the background, which stops every camera. */
  let camerasStopped = false;
  /** A `<camera>` was inserted or removed; it needs the privacy agreement and `scope.camera`. */
  const cameraMounted = async (
    webviewId: number,
    cameraId: number,
    mounted: boolean,
    options: { mode?: string; frameSize?: string } = {},
  ) => {
    const key = `${webviewId}:${cameraId}`;
    cameras.get(key)?.release?.();
    cameras.delete(key);
    if (!mounted) return;
    // A camera moved in the DOM is removed and inserted again; only the latest insertion counts
    const entry: CameraEntry = {
      webviewId,
      cameraId,
      frameSize: options.frameSize,
    };
    cameras.set(key, entry);
    let error: string | undefined;
    try {
      await requirePrivacy("camera");
      if (!(await requestScope("scope.camera"))) throw new Error("auth deny");
    } catch (reason) {
      error = `insertCamera:fail ${(reason as Error).message}`;
    }
    if (cameras.get(key) !== entry) return;
    entry.error = error;
    if (!error) entry.release = holdPermission("camera");
    host.sendView(webviewId, {
      type: "cameraState",
      cameraId,
      error,
      ...(!error && options.mode === "scanCode" ? { scan: cameraScan() } : {}),
      ...(!error && camerasStopped ? { stopped: true } : {}),
    });
  };
  /** The `scancode` detail of a camera in `scanCode` mode, which sees the code `wx.scanCode` reads. */
  const cameraScan = () => {
    const { scanType, result, charSet, rawData } = scannedCode(ctx);
    return { type: scanType, result, charSet, rawData };
  };
  /** Going to the background stops each camera that shows its preview (`bindstop`); coming back starts it again. */
  const stopCameras = (stopped: boolean) => {
    if (camerasStopped === stopped) return;
    camerasStopped = stopped;
    for (const { webviewId, cameraId, release } of cameras.values()) {
      if (release) host.sendView(webviewId, { type: "cameraState", cameraId, stopped });
    }
  };
  /** Each `<live-pusher>` on a page, with the release of the camera and microphone it holds. */
  const pushers = new Map<string, { release?: () => void }>();
  /**
   * A `<live-pusher>` was inserted or removed. It needs the privacy agreement,
   * `scope.camera` and `scope.record`; a refusal is its `error` 10001 or 10002.
   */
  const livePusherMounted = async (webviewId: number, pusherId: number, mounted: boolean) => {
    const key = `${webviewId}:${pusherId}`;
    pushers.get(key)?.release?.();
    pushers.delete(key);
    if (!mounted) return;
    const entry: { release?: () => void } = {};
    pushers.set(key, entry);
    let errCode: number | undefined;
    let errMsg: string | undefined;
    try {
      await requirePrivacy("live-pusher");
      if (!(await requestScope("scope.camera"))) errCode = 10001;
      else if (!(await requestScope("scope.record"))) errCode = 10002;
    } catch (reason) {
      errCode = 10001;
      errMsg = `insertLivePusher:fail ${(reason as Error).message}`;
    }
    if (pushers.get(key) !== entry) return;
    if (errCode === undefined) {
      const camera = holdPermission("camera");
      const record = holdPermission("record");
      entry.release = () => {
        camera();
        record();
      };
    }
    host.sendView(webviewId, {
      type: "livePusherState",
      pusherId,
      ...(errCode !== undefined && {
        errCode,
        errMsg:
          errMsg ?? `insertLivePusher:fail ${errCode === 10001 ? "camera" : "record"} auth deny`,
      }),
    });
  };
  /**
   * Whether `<official-account>` may show: only after a launch from a scanned
   * code (or the trial version's entry), and while the app came back from a
   * scene that keeps that state, as WeChat documents since base library 2.18.1.
   */
  const officialAccountState = () => {
    const config = host.manifest.config.officialAccount ?? {};
    const launchScene = Number(host.launchOptions.scene);
    const enterScene = Number(host.enterOptions().scene);
    const status =
      !OFFICIAL_ACCOUNT_LAUNCH_SCENES.has(launchScene) ||
      !(
        OFFICIAL_ACCOUNT_LAUNCH_SCENES.has(enterScene) ||
        OFFICIAL_ACCOUNT_RETURN_SCENES.has(enterScene)
      )
        ? 5
        : (config.status ?? 0);
    return {
      status,
      errMsg: OFFICIAL_ACCOUNT_ERRORS[status] ?? "ok",
      name: config.name ?? `${host.manifest.appName}公众号`,
    };
  };
  /** A page is gone with everything it was using. */
  const releasePage = (webviewId: number) => {
    appApis.hooks.releasePage(webviewId);
    for (const [key, { release }] of cameras) {
      if (!key.startsWith(`${webviewId}:`)) continue;
      release?.();
      cameras.delete(key);
    }
    for (const [key, { release }] of pushers) {
      if (!key.startsWith(`${webviewId}:`)) continue;
      release?.();
      pushers.delete(key);
    }
    voipApis.releasePage(webviewId);
    observerApis.releasePage(webviewId);
    animationApis.releasePage(webviewId);
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

  const darkmode = host.manifest.appJson.darkmode === true;
  /** System info with the window of the current page: a tab bar or a custom navigation bar changes its height. */
  const systemInfo = (): SystemInfo => {
    const { top, bottom } = host.windowInsets();
    const screenHeight = Number(host.system.screenHeight);
    return {
      ...host.system,
      windowHeight: screenHeight - top - bottom,
      screenTop: top,
      // Only a Mini Program that supports DarkMode learns the theme
      theme: darkmode ? host.theme() : undefined,
    };
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
    node(callback?: AnyFunction) {
      return this.fields({ node: true }, callback);
    }
    /** `{ context }`: the node's EditorContext, VideoContext, MapContext and so on; undefined for other nodes. */
    context(callback?: AnyFunction) {
      return this.fields({ context: true }, callback);
    }
  }

  class SelectorQuery {
    private scope: { webviewId?: number; nodeId: number } = { nodeId: 0 };
    private readonly requests: SelectorQueryRequest[] = [];
    private readonly callbacks: (AnyFunction | undefined)[] = [];
    private component?: object;
    in(component: object) {
      const scope = host.scopeOf(component);
      if (scope) {
        this.scope = scope;
        this.component = component;
      }
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
      void host.query(webviewId, this.requests).then((raw) => {
        // A canvas node is a Canvas object of the logic layer
        // and a context is built from what the view says the node is
        const withNode = (result: unknown) => {
          const node = (result as { node?: Record<string, unknown> } | null)?.node;
          const resolved = !node
            ? result
            : {
                ...result!,
                node:
                  "scrollView" in node
                    ? contextApis.scrollViewContext(webviewId, node as unknown as ScrollViewNode)
                    : canvasApis.nodeOf(webviewId, node as never),
              };
          if (!resolved || typeof resolved !== "object" || !("context" in resolved))
            return resolved;
          const context = contextApis.contextOf(
            webviewId,
            resolved.context as ContextNode | null,
            this.component,
          );
          return { ...resolved, context };
        };
        const results = raw.map((result) =>
          Array.isArray(result) ? result.map(withNode) : withNode(result),
        );
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
      const tapped = hasTapGesture();
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
      const tapped = hasTapGesture();
      return asyncApi("openSetting", async () => {
        if (!tapped) requireTapGesture();
        return openSettingPage();
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
      theme: darkmode ? host.theme() : undefined,
      enableDebug: false,
    }),
    getMenuButtonBoundingClientRect: () => ({ ...host.menuButton }),
    getLaunchOptionsSync: () => toJsonValue(host.launchOptions),
    getEnterOptionsSync: () => toJsonValue(host.enterOptions()),
    getNetworkType: asyncApi("getNetworkType", async () => ({
      networkType: "wifi",
      signalStrength: 4,
      hasSystemProxy: false,
    })),
    nextTick: (fn: AnyFunction) => setTimeout(fn, 0),

    // Routing
    navigateTo: asyncApi("navigateTo", async (options) => {
      return {
        eventChannel: host.navigate("navigateTo", { url: options.url, events: options.events }),
      };
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
        animation: options.animation,
      }),
    ),
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

  const ctx: ApiContext = {
    host,
    wx,
    files,
    requirePrivacy,
    requestScope,
    holdPermission,
    cameraState: (webviewId) => {
      for (const [key, { release, error, frameSize }] of cameras) {
        if (key.startsWith(`${webviewId}:`)) {
          return { ready: release !== undefined && !camerasStopped, error, frameSize };
        }
      }
      return undefined;
    },
  };
  const canvasApis = createCanvasApis(ctx);
  const animationApis = createAnimationApis(ctx);
  const appApis = createAppApis(ctx);
  const observerApis = createObserverApis(ctx);
  const contextApis = createContextApis(ctx);
  const voipApis = createVoipApis(ctx, user.openid);
  const deviceApis = createDeviceApis(ctx);
  Object.assign(
    wx,
    appApis.apis,
    createFileApis(ctx),
    createNetworkApis(ctx),
    createInterfaceApis(ctx),
    canvasApis.apis,
    deviceApis.apis,
    createMediaApis(ctx),
    contextApis.apis,
    voipApis.apis,
    animationApis.apis,
    observerApis.apis,
  );
  const webViewApis = createWebViewApis(ctx);

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

  return {
    wx: proxy,
    app: appApis.hooks,
    openTypeDetail,
    nicknameFocus,
    cameraMounted,
    stopCameras,
    livePusherMounted,
    voipRoomMounted: voipApis.voipRoomMounted,
    interruptVoip: voipApis.interrupt,
    copyToClipboard: deviceApis.copy,
    officialAccountState,
    observerMessage: (...args: Parameters<typeof observerApis.receive>) =>
      observerApis.receive(...args),
    releasePage,
    /** `this.animate()` and `this.clearAnimation()` of a page or component. */
    animate: animationApis.animate,
    clearAnimation: animationApis.clearAnimation,
    animationDone: animationApis.animationDone,
    /** Answers the JSSDK of a `<web-view>` page, other than `invokeMiniProgramAPI`. */
    webViewInvoke: webViewApis.invoke,
  };
}
