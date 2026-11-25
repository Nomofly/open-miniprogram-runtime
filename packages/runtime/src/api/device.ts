/**
 * Device, system and open-ability APIs: clipboard, phone, scanning, screen and
 * battery, system settings, app events, logs and reports, payments,
 * subscription messages, addresses, locations and other Mini Programs.
 */
import { resolveUser } from "../auth.ts";
import {
  ApiError,
  asyncApi,
  hasTapGesture,
  requireTapGesture,
  safeCall,
  type AnyFunction,
  type Options,
} from "./common.ts";
import type { ApiContext } from "./context.ts";

/** Checks a required parameter's type, failing with WeChat's `parameter error` message. */
export function requireParam(
  options: Options,
  name: string,
  type: "String" | "Number" | "Array" | "Object",
) {
  const actual = Object.prototype.toString.call(options[name]).slice(8, -1);
  if (actual !== type) {
    throw new Error(`parameter error: parameter.${name} should be ${type} instead of ${actual};`);
  }
}

/** How the shell's system UI is answered: shown (`ask`), or allowed or denied without it (`auth.consent`). */
export const consentOf = (ctx: ApiContext) => ctx.host.manifest.config.auth?.consent ?? "ask";

/** Shows an action sheet, or taps its first item or cancels as `auth.consent` says; fails with `cancel`. */
export async function actionSheet(ctx: ApiContext, itemList: string[], alertText = "") {
  const consent = consentOf(ctx);
  const result =
    consent === "ask"
      ? await ctx.host.ui("showActionSheet", { itemList, itemColor: "#000000", alertText })
      : consent === "allow"
        ? { tapIndex: 0 }
        : {};
  if (typeof result.tapIndex !== "number") throw new Error("cancel");
  return result.tapIndex;
}

/** Where the simulated user is: Tiananmen Square, as `wx.getLocation` reports by default. */
const DEFAULT_LOCATION = {
  latitude: 39.908823,
  longitude: 116.39747,
  name: "天安门",
  address: "北京市东城区东长安街",
};

const SCAN_DEFAULT = { result: "https://example.com/omr", scanType: "QR_CODE", charSet: "utf-8" };

/** Renames the `errno` of a failure to the `errCode` some open APIs document instead. */
const withErrCode =
  (api: (options: Options) => unknown) =>
  (options: Options = {}) => {
    const rename = (result: Record<string, unknown>) => {
      if (!("errno" in result)) return result;
      const { errno, ...rest } = result;
      return { ...rest, errCode: errno };
    };
    const { fail, complete } = options;
    if (!options.success && !fail && !complete) {
      return (api(options) as Promise<unknown>).catch((error: Record<string, unknown>) => {
        throw rename(error);
      });
    }
    return api({
      ...options,
      fail: fail && ((error: Record<string, unknown>) => fail(rename(error))),
      complete: complete && ((result: Record<string, unknown>) => complete(rename(result))),
    });
  };

/** Parses `signData`, which the payment APIs take as a JSON string. */
const parseSignData = (options: Options, errno: number) => {
  try {
    const data: unknown =
      typeof options.signData === "string" ? JSON.parse(options.signData) : options.signData;
    if (data && typeof data === "object") return data as Record<string, any>;
  } catch {
    // Fails below
  }
  throw new ApiError("parameter error: signData is not a valid JSON string", errno);
};

/** Listeners of an app event such as `wx.onMemoryWarning`. */
const eventApis = (on: string, off: string) => {
  const listeners = new Set<AnyFunction>();
  return {
    [on]: (listener: AnyFunction) => {
      if (typeof listener === "function") listeners.add(listener);
    },
    [off]: (listener?: AnyFunction) => {
      if (listener) listeners.delete(listener);
      else listeners.clear();
    },
  };
};

export function createDeviceApis(ctx: ApiContext): Record<string, unknown> {
  const { host } = ctx;
  const { manifest } = host;
  const config = manifest.config;
  const consent = consentOf(ctx);
  const user = resolveUser(config.auth?.user);

  /** Shows a dialog, or answers it without UI as `auth.consent` says; `allow` and `deny` give these results. */
  const ask = async (
    name: string,
    args: Record<string, unknown>,
    answers: { allow: Record<string, unknown>; deny: Record<string, unknown> },
  ) => (consent === "ask" ? host.ui(name, args) : answers[consent]);
  /** Shows UI without waiting for it, as WeChat does for viewers it opens over the page. */
  const show = (name: string, args: Record<string, unknown>) => {
    host.ui(name, args).catch(() => {});
  };
  const requireScope = async (referrer: string, scope: string) => {
    await ctx.requirePrivacy(referrer);
    if (!(await ctx.requestScope(scope))) throw new Error("auth deny");
  };
  const requireDeclared = (api: string) => {
    const declared = (manifest.appJson.requiredPrivateInfos as string[] | undefined) ?? [];
    if (!declared.includes(api)) {
      throw new Error(
        "the api need to be declared in the requiredPrivateInfos field in app.json/ext.json",
      );
    }
  };
  const location = () => ({ ...DEFAULT_LOCATION, ...config.location });

  let clipboard = "";
  let brightness = 0.5;

  /** `wx.requestPayment` and the other payment APIs: the payment sheet, or the configured answer. */
  const pay = async (amount: unknown, cancelErrno?: number) => {
    const configured = config.payment?.result;
    const result = configured
      ? { pay: configured === "success" }
      : await ask(
          "payment",
          { appName: manifest.appName, amount: typeof amount === "number" ? amount : undefined },
          { allow: { pay: true }, deny: {} },
        );
    if (result.pay !== true) throw new ApiError("cancel", cancelErrno);
    return {};
  };

  // The simulator always runs the latest code, so no update is ever ready or failed
  const updateManager = {
    applyUpdate() {
      console.warn("[omr] UpdateManager.applyUpdate: the simulator has no new version");
    },
    onCheckForUpdate(listener: AnyFunction) {
      setTimeout(() => safeCall(listener, { hasUpdate: false }), 0);
    },
    onUpdateReady() {},
    onUpdateFailed() {},
  };

  const log =
    (prefix: string, level: "debug" | "info" | "log" | "warn" | "error") =>
    (...args: unknown[]) =>
      console[level](`[omr] ${prefix}`, ...args);
  const tagLogManager = (tag: string) => ({
    info: log(`realtime log [${tag}]:`, "info"),
    warn: log(`realtime log [${tag}]:`, "warn"),
    error: log(`realtime log [${tag}]:`, "error"),
    setFilterMsg() {},
    addFilterMsg() {},
  });
  const realtimeLogManager = {
    info: log("realtime log:", "info"),
    warn: log("realtime log:", "warn"),
    error: log("realtime log:", "error"),
    setFilterMsg() {},
    addFilterMsg() {},
    in() {
      return realtimeLogManager;
    },
    tag: (tag: string) => tagLogManager(String(tag)),
    getCurrentState: () => ({ size: 0, maxSize: 5 * 1024, logCount: 0, maxLogCount: 200 }),
  };
  const logManager = {
    debug: log("log:", "debug"),
    info: log("log:", "info"),
    log: log("log:", "log"),
    warn: log("log:", "warn"),
  };

  const performanceApi = {
    now: () => Date.now(),
    createObserver: () => ({ observe() {}, disconnect() {} }),
    getEntries: () => [],
    getEntriesByName: () => [],
    getEntriesByType: () => [],
    setBufferSize() {},
  };

  const idleCallbacks = new Map<number, ReturnType<typeof setTimeout>>();
  let idleCallbackId = 0;

  // A permission is "denied" when the simulated user has denied the scope behind it
  const appAuthorized = (scope: string) =>
    config.auth?.authSetting?.[scope] === false ? "denied" : "authorized";

  return {
    // Clipboard
    setClipboardData: asyncApi("setClipboardData", async (options) => {
      requireParam(options, "data", "String");
      await ctx.requirePrivacy("setClipboardData");
      clipboard = options.data;
      show("showToast", { title: "内容已复制", icon: "success", duration: 1500, mask: false });
      return {};
    }),
    getClipboardData: asyncApi("getClipboardData", async () => {
      await ctx.requirePrivacy("getClipboardData");
      return { data: clipboard };
    }),

    // Phone, contacts and calendar
    makePhoneCall: asyncApi("makePhoneCall", async (options) => {
      requireParam(options, "phoneNumber", "String");
      await actionSheet(ctx, ["呼叫"], options.phoneNumber);
      return {};
    }),
    addPhoneContact: asyncApi("addPhoneContact", async (options) => {
      requireParam(options, "firstName", "String");
      await requireScope("addPhoneContact", "scope.addPhoneContact");
      await actionSheet(ctx, ["创建新联系人", "添加到现有联系人"]);
      return {};
    }),
    addPhoneCalendar: asyncApi("addPhoneCalendar", async (options) => {
      requireParam(options, "title", "String");
      requireParam(options, "startTime", "Number");
      await requireScope("addPhoneCalendar", "scope.addPhoneCalendar");
      return {};
    }),
    addPhoneRepeatCalendar: asyncApi("addPhoneRepeatCalendar", async (options) => {
      requireParam(options, "title", "String");
      requireParam(options, "startTime", "Number");
      await requireScope("addPhoneRepeatCalendar", "scope.addPhoneCalendar");
      return {};
    }),

    // Scanning
    scanCode: asyncApi("scanCode", async (options) => {
      const scanned = { ...SCAN_DEFAULT, ...config.scanCode };
      const result = await ask(
        "scanCode",
        { result: scanned.result, onlyFromCamera: Boolean(options.onlyFromCamera) },
        { allow: { scanned: true }, deny: {} },
      );
      if (result.scanned !== true) throw new Error("cancel");
      const bytes = new TextEncoder().encode(scanned.result);
      return {
        ...scanned,
        rawData: btoa(String.fromCharCode(...bytes)),
      };
    }),

    // Screen, battery and vibration
    setScreenBrightness: asyncApi("setScreenBrightness", async (options) => {
      requireParam(options, "value", "Number");
      brightness = Math.min(1, Math.max(0, options.value));
      return {};
    }),
    getScreenBrightness: asyncApi("getScreenBrightness", async () => ({ value: brightness })),
    setKeepScreenOn: asyncApi("setKeepScreenOn", async () => ({})),
    getBatteryInfo: asyncApi("getBatteryInfo", async () => batteryInfo()),
    getBatteryInfoSync: () => batteryInfo(),
    vibrateShort: asyncApi("vibrateShort", async () => ({})),
    vibrateLong: asyncApi("vibrateLong", async () => ({})),

    // App events
    ...eventApis("onUserCaptureScreen", "offUserCaptureScreen"),
    ...eventApis("onMemoryWarning", "offMemoryWarning"),

    // System settings and device information
    getSystemSetting: () => ({
      bluetoothEnabled: true,
      locationEnabled: true,
      wifiEnabled: true,
      deviceOrientation: "portrait",
    }),
    getAppAuthorizeSetting: () => ({
      albumAuthorized: appAuthorized("scope.writePhotosAlbum"),
      bluetoothAuthorized: appAuthorized("scope.bluetooth"),
      cameraAuthorized: appAuthorized("scope.camera"),
      locationAuthorized: appAuthorized("scope.userLocation"),
      locationReducedAccuracy: false,
      microphoneAuthorized: appAuthorized("scope.record"),
      notificationAuthorized: "authorized",
      notificationAlertAuthorized: "authorized",
      notificationBadgeAuthorized: "authorized",
      notificationSoundAuthorized: "authorized",
      phoneCalendarAuthorized: appAuthorized("scope.addPhoneCalendar"),
    }),
    openAppAuthorizeSetting: asyncApi("openAppAuthorizeSetting", async () => ({})),
    openSystemBluetoothSetting: asyncApi("openSystemBluetoothSetting", async () => ({})),
    getDeviceBenchmarkInfo: asyncApi("getDeviceBenchmarkInfo", async () => ({
      benchmarkLevel:
        typeof host.system.benchmarkLevel === "number" ? host.system.benchmarkLevel : -1,
      modelLevel: 1,
    })),
    getRandomValues: asyncApi("getRandomValues", async (options) => {
      requireParam(options, "length", "Number");
      const values = new Uint8Array(Math.max(0, Math.floor(options.length)));
      // crypto.getRandomValues fills at most 65536 bytes per call
      for (let i = 0; i < values.length; i += 65536) {
        crypto.getRandomValues(values.subarray(i, i + 65536));
      }
      return { randomValues: values.buffer };
    }),
    getExtConfig: asyncApi("getExtConfig", async () => ({ extConfig: { ...config.extConfig } })),
    getExtConfigSync: () => ({ ...config.extConfig }),
    setEnableDebug: asyncApi("setEnableDebug", async () => ({})),

    // Updates, logs, reports and performance
    getUpdateManager: () => updateManager,
    getRealtimeLogManager: () => realtimeLogManager,
    getLogManager: () => logManager,
    reportEvent() {},
    reportAnalytics() {},
    reportMonitor() {},
    reportPerformance() {},
    getPerformance: () => performanceApi,
    // The logic layer is idle once the current task ends, well before any timeout
    requestIdleCallback: (callback: AnyFunction) => {
      const id = ++idleCallbackId;
      idleCallbacks.set(
        id,
        setTimeout(() => {
          idleCallbacks.delete(id);
          const start = Date.now();
          safeCall(callback, {
            didTimeout: false,
            timeRemaining: () => Math.max(0, 50 - (Date.now() - start)),
          });
        }, 0),
      );
      return id;
    },
    cancelIdleCallback: (id: number) => {
      clearTimeout(idleCallbacks.get(id));
      idleCallbacks.delete(id);
    },

    // Payments
    requestPayment: asyncApi("requestPayment", async (options) => {
      for (const name of ["timeStamp", "nonceStr", "package", "paySign"]) {
        requireParam(options, name, "String");
      }
      return pay(config.payment?.amount);
    }),
    requestCommonPayment: asyncApi("requestCommonPayment", async (options) => {
      const signData = parseSignData(options, 1022);
      return pay(signData.amount?.order_amount);
    }),
    requestVirtualPayment: withErrCode(
      asyncApi("requestVirtualPayment", async (options) => {
        const signData = parseSignData(options, -15016);
        const { goodsPrice, buyQuantity } = signData;
        return pay(
          typeof goodsPrice === "number" ? goodsPrice * (Number(buyQuantity) || 1) : undefined,
          -2,
        );
      }),
    ),

    // Subscription messages
    requestSubscribeMessage: (options: Options = {}) => {
      // The tap state is read when the call is made
      const tapped = hasTapGesture();
      return withErrCode(
        asyncApi("requestSubscribeMessage", async () => {
          const { tmplIds } = options;
          if (!Array.isArray(tmplIds) || tmplIds.some((id) => typeof id !== "string" || !id)) {
            throw new ApiError("Invalid template id", 10004);
          }
          if (tmplIds.length === 0) throw new ApiError("TmplIds can't be empty", 10001);
          if (tmplIds.length > 5) {
            throw new ApiError("Templates count out of max bounds", 20003);
          }
          if (!tapped) requireTapGesture();
          const ids = [...new Set(tmplIds as string[])];
          const answers: Record<string, string> = {};
          const asked = ids.filter((id) => {
            const configured = config.subscribeMessage?.[id];
            if (configured) answers[id] = configured;
            return !configured;
          });
          if (asked.length > 0) {
            const result = await ask(
              "subscribeMessage",
              { appName: manifest.appName, tmplIds: asked },
              { allow: { accepted: asked }, deny: { accepted: [] } },
            );
            const accepted = Array.isArray(result.accepted) ? result.accepted : [];
            // Cancel rejects every template, as WeChat reports it
            for (const id of asked) answers[id] = accepted.includes(id) ? "accept" : "reject";
          }
          return answers;
        }),
      )(options);
    },

    // Addresses and invoices
    chooseAddress: asyncApi("chooseAddress", async () => {
      requireDeclared("chooseAddress");
      await ctx.requirePrivacy("chooseAddress");
      if (consent === "deny") throw new Error("cancel");
      return {
        userName: "张三",
        postalCode: "100010",
        provinceName: "北京市",
        cityName: "北京市",
        countyName: "东城区",
        streetName: "东华门街道",
        detailInfo: "东长安街1号",
        detailInfoNew: "东长安街1号",
        nationalCode: "110101",
        telNumber: user.phoneNumber,
        ...config.address,
      };
    }),
    chooseInvoiceTitle: asyncApi("chooseInvoiceTitle", async () => {
      await ctx.requirePrivacy("chooseInvoiceTitle");
      if (consent === "deny") throw new Error("cancel");
      return {
        type: "0",
        title: "示例科技有限公司",
        taxNumber: "91110101MA00000000",
        companyAddress: "北京市东城区东长安街1号",
        telephone: "010-12345678",
        bankName: "中国工商银行北京东城支行",
        bankAccount: "0200000000000000000",
        ...config.invoiceTitle,
      };
    }),

    // Locations
    chooseLocation: asyncApi("chooseLocation", async (options) => {
      requireDeclared("chooseLocation");
      await requireScope("chooseLocation", "scope.userLocation");
      const chosen = location();
      const result = await ask(
        "chooseLocation",
        {
          name: chosen.name,
          address: chosen.address,
          latitude: options.latitude ?? chosen.latitude,
          longitude: options.longitude ?? chosen.longitude,
        },
        { allow: { confirm: true }, deny: {} },
      );
      if (result.confirm !== true) throw new Error("cancel");
      const { latitude, longitude, name, address } = chosen;
      return { name, address, latitude, longitude };
    }),
    openLocation: asyncApi("openLocation", async (options) => {
      requireParam(options, "latitude", "Number");
      requireParam(options, "longitude", "Number");
      show("openLocation", {
        latitude: options.latitude,
        longitude: options.longitude,
        name: typeof options.name === "string" ? options.name : "",
        address: typeof options.address === "string" ? options.address : "",
      });
      return {};
    }),
    getFuzzyLocation: asyncApi("getFuzzyLocation", async () => {
      requireDeclared("getFuzzyLocation");
      await requireScope("getFuzzyLocation", "scope.userFuzzyLocation");
      // Fuzzy locations are accurate to about a kilometre
      const { latitude, longitude } = location();
      const fuzzy = (value: number) => Math.round(value * 100) / 100;
      return { latitude: fuzzy(latitude), longitude: fuzzy(longitude) };
    }),

    // Other Mini Programs, customer service and sharing
    navigateToMiniProgram: (options: Options = {}) => {
      const tapped = hasTapGesture();
      return asyncApi("navigateToMiniProgram", async () => {
        if (!tapped) requireTapGesture();
        const target = String(options.appId ?? options.shortLink ?? "");
        const result = await ask(
          "showModal",
          {
            title: "",
            content: `即将打开“${target}”小程序`,
            showCancel: true,
            cancelText: "取消",
            cancelColor: "#000000",
            confirmText: "允许",
            confirmColor: "#576B95",
            editable: false,
            placeholderText: "",
          },
          { allow: { confirm: true }, deny: {} },
        );
        if (result.confirm !== true) throw new Error("cancel");
        return {};
      })(options);
    },
    navigateBackMiniProgram: asyncApi("navigateBackMiniProgram", async () => ({})),
    exitMiniProgram: asyncApi("exitMiniProgram", async () => ({})),
    openCustomerServiceChat: asyncApi("openCustomerServiceChat", async () => ({})),
    showShareMenu: asyncApi("showShareMenu", async () => ({})),
    hideShareMenu: asyncApi("hideShareMenu", async () => ({})),
    updateShareMenu: asyncApi("updateShareMenu", async () => ({})),
    showShareImageMenu: asyncApi("showShareImageMenu", async (options) => {
      requireParam(options, "path", "String");
      return {};
    }),
  };
}

const batteryInfo = () => ({ level: 100, isCharging: false, isLowPowerModeEnabled: false });
