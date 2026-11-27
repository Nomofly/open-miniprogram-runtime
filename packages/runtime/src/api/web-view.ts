/**
 * The JSSDK in `<web-view>`: what `WeixinJSBridge.invoke` answers to the page a
 * web-view shows. The JSSDK (jweixin from res.wx.qq.com, or the weixin-js-sdk
 * package) calls the bridge by WeChat's internal names, such as `geoLocation`
 * for `wx.getLocation` and `imagePreview` for `wx.previewImage`, and reads the
 * answer's `err_msg`, which it turns into the `errMsg` the page sees. Some
 * answers differ between iOS and Android, as the JSSDK expects.
 * `invokeMiniProgramAPI` (`wx.miniProgram`) is answered by the logic layer.
 */
import type { ApiContext } from "./context.ts";
import { DEFAULT_LOCATION } from "./device.ts";

/** How long the capsule shows the location icon after `getLocation`, as for `wx.getLocation`. */
const LOCATION_IN_USE_MS = 3000;

/**
 * The JSSDK APIs WeChat lets a web-view page use, by bridge name, beside
 * `invokeMiniProgramAPI`; `checkJsApi` reports these.
 */
const SUPPORTED = new Set([
  "preVerifyJSAPI",
  "checkJsApi",
  "chooseImage",
  "imagePreview",
  "uploadImage",
  "downloadImage",
  "getLocalImgData",
  "startRecord",
  "stopRecord",
  "onVoiceRecordEnd",
  "playVoice",
  "pauseVoice",
  "stopVoice",
  "onVoicePlayEnd",
  "uploadVoice",
  "downloadVoice",
  "translateVoice",
  "getNetworkType",
  "openLocation",
  "geoLocation",
  "startMonitoringBeacons",
  "stopMonitoringBeacons",
  "onBeaconsInRange",
  "scanQRCode",
  "chooseCard",
  "batchAddCard",
  "batchViewCard",
  "invokeMiniProgramAPI",
]);

const MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function createWebViewApis(ctx: ApiContext) {
  const android = ctx.host.system.platform === "android";
  // Taken now, so a Mini Program that replaces wx.* does not change what the web page gets
  type Api = (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  const { scanCode, previewImage, openLocation } = ctx.wx as {
    scanCode: Api;
    previewImage: Api;
    openLocation: Api;
  };
  /**
   * Local resource ids of the images a page chose or downloaded, with their
   * temporary files and the origin of the document that got them: only that
   * origin's documents can use them.
   */
  const localFiles = new Map<string, { path: string; origin: string }>();
  /** Media ids of uploaded images, with their temporary files and the origin that uploaded them. */
  const uploads = new Map<string, { path: string; origin: string }>();
  let nextId = 0;
  const localIdOf = (path: string, origin: string) => {
    const id = `${android ? "weixin://resourceid/" : "wxlocalresource://"}omr${(++nextId).toString(16).padStart(8, "0")}`;
    localFiles.set(id, { path, origin });
    return id;
  };
  const fileOf = (localId: unknown, origin: string) => {
    const file = localFiles.get(String(localId));
    if (!file || file.origin !== origin) throw new Error("invalid localId");
    return file.path;
  };

  const apis: Record<
    string,
    (args: Record<string, unknown>, origin: string) => Promise<Record<string, unknown>>
  > = {
    // The signature is not checked: the simulator has no jsapi_ticket
    preVerifyJSAPI: async () => ({}),
    checkJsApi: async (args) => {
      const list = Array.isArray(args.jsApiList) ? (args.jsApiList as unknown[]) : [];
      const result = Object.fromEntries(
        list.map((name) => [String(name), SUPPORTED.has(String(name))]),
      );
      return { checkResult: android ? JSON.stringify(result) : result };
    },
    chooseImage: async (args, origin) => {
      const count = Math.min(9, Math.max(1, Number(args.count ?? 9) || 9));
      const paths = await ctx.pickImages!(args.sourceType, count);
      const localIds = paths.map((path) => localIdOf(path, origin));
      return { localIds: android ? JSON.stringify(localIds) : localIds };
    },
    imagePreview: async (args) => {
      const urls = Array.isArray(args.urls) ? args.urls.map(String) : [];
      await previewImage({ urls, current: typeof args.current === "string" ? args.current : "" });
      return {};
    },
    uploadImage: async (args, origin) => {
      const serverId = `omr_media_${(++nextId).toString(16).padStart(8, "0")}`;
      uploads.set(serverId, { path: fileOf(args.localId, origin), origin });
      return { serverId };
    },
    downloadImage: async (args, origin) => {
      const upload = uploads.get(String(args.serverId));
      if (!upload || upload.origin !== origin) throw new Error("invalid serverId");
      return { localId: localIdOf(upload.path, origin) };
    },
    getLocalImgData: async (args, origin) => {
      const path = fileOf(args.localId, origin);
      const bytes = ctx.files.read(path);
      if (!bytes) throw new Error("file not found");
      const extension = /\.(\w+)$/.exec(path)?.[1]?.toLowerCase() ?? "png";
      const base64 = toBase64(bytes);
      // iOS gives a data URL; Android gives the base64 alone
      return {
        localData: android
          ? base64
          : `data:${MIME_TYPES[extension] ?? "image/png"};base64,${base64}`,
      };
    },
    // The JSSDK reads the network type from the answer itself
    getNetworkType: async () => ({ err_msg: "network_type:wifi" }),
    openLocation: async (args) => {
      await openLocation({
        latitude: Number(args.latitude),
        longitude: Number(args.longitude),
        name: typeof args.name === "string" ? args.name : "",
        address: typeof args.address === "string" ? args.address : "",
      });
      return {};
    },
    geoLocation: async () => {
      setTimeout(ctx.holdPermission("location"), LOCATION_IN_USE_MS);
      const { latitude, longitude } = {
        ...DEFAULT_LOCATION,
        ...ctx.host.manifest.config.location,
      };
      return { latitude, longitude, speed: -1, accuracy: 65 };
    },
    scanQRCode: async (args) => {
      const { result } = await scanCode({});
      // Without needResult, WeChat handles the result itself and the page gets nothing
      if (Number(args.needResult) !== 1) return {};
      return {
        resultStr: android
          ? String(result)
          : JSON.stringify({ scan_code: { scan_result: String(result) } }),
      };
    },
  };

  /**
   * Answers one bridge call from a document of `origin`, in the bridge's
   * format: `err_msg` is `<name>:ok`, `:cancel` or `:fail <reason>`.
   */
  const invoke = async (
    name: string,
    args: Record<string, unknown>,
    origin: string,
  ): Promise<Record<string, unknown>> => {
    const api = apis[name];
    if (!api) {
      const reason = SUPPORTED.has(name)
        ? "not implemented in the simulator"
        : "not supported in <web-view>";
      return { err_msg: `${name}:fail ${reason}` };
    }
    try {
      return { err_msg: `${name}:ok`, ...(await api(args, origin)) };
    } catch (error) {
      const raw = error as { errMsg?: unknown; message?: unknown };
      const reason = String(raw?.errMsg ?? raw?.message ?? error).replace(/^\w+:fail ?/, "");
      return { err_msg: reason === "cancel" ? `${name}:cancel` : `${name}:fail ${reason}` };
    }
  };
  return { invoke };
}
