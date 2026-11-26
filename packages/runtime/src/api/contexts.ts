/**
 * Contexts of native components: `wx.createVideoContext`,
 * `wx.createAudioContext`, `wx.createMapContext`, `wx.createCameraContext`,
 * `wx.createLivePlayerContext` and `wx.createLivePusherContext`, and the
 * contexts `NodesRef.context` gives, such as `EditorContext`.
 *
 * `VideoContext` and `MapContext` drive the `<video>` and the simulated
 * `<map>` in the page, which fire their own events, as do the contexts of
 * `<live-player>` and `<live-pusher>`; their snapshots are generated images.
 * `CameraContext` needs a `<camera>` on the page with `scope.camera` granted;
 * its photos and frames are generated, and its recordings hold no playable
 * frames, as `wx.chooseVideo` returns.
 */
import { asyncApi, safeCall, type AnyFunction, type Options } from "./common.ts";
import type { ContextNode, ScrollViewNode } from "../protocol.ts";
import type { ApiContext } from "./context.ts";
import { encodePhoto } from "./media.ts";

/** The `<camera>` reports `maxZoom: 1` in `initdone`, so every zoom becomes 1. */
const CAMERA_MAX_ZOOM = 1;
/** Generated photos are portrait, as `wx.chooseImage` takes them with the camera. */
const PHOTO_WIDTH = 600;
const PHOTO_HEIGHT = 800;
/** `startRecord` stops by itself after `timeout` seconds: 30 by default, at most 5 minutes. */
const RECORD_TIMEOUT_S = 30;
const RECORD_MAX_S = 300;
/** The size of generated camera frames for each `frame-size`; WeChat leaves the exact size to the system. */
const FRAME_SIZES: Record<string, [number, number]> = {
  small: [144, 192],
  medium: [240, 320],
  large: [480, 640],
};
const FRAME_MS = 100;

const VIDEO_METHODS = [
  "play",
  "pause",
  "stop",
  "seek",
  "playbackRate",
  "requestFullScreen",
  "exitFullScreen",
  "showStatusBar",
  "hideStatusBar",
  "sendDanmu",
  "requestPictureInPicture",
  "exitPictureInPicture",
  "requestBackgroundPlayback",
  "exitBackgroundPlayback",
  "startCasting",
  "switchCasting",
  "reconnectCasting",
  "exitCasting",
];

/** AudioContext drives the legacy `<audio>`. */
const AUDIO_METHODS = ["setSrc", "play", "pause", "seek"];

const LIVE_PLAYER_METHODS = [
  "play",
  "stop",
  "mute",
  "pause",
  "resume",
  "requestFullScreen",
  "exitFullScreen",
  "exitPictureInPicture",
  "requestBackgroundPlayback",
  "exitBackgroundPlayback",
  "startCasting",
  "switchCasting",
  "reconnectCasting",
  "exitCasting",
];

const LIVE_PUSHER_METHODS = [
  "start",
  "stop",
  "pause",
  "resume",
  "switchCamera",
  "toggleTorch",
  "playBGM",
  "stopBGM",
  "pauseBGM",
  "resumeBGM",
  "setBGMVolume",
  "setMICVolume",
  "startPreview",
  "stopPreview",
  "sendMessage",
  "exitPictureInPicture",
  "applyFilter",
  "clearFilters",
  "applySticker",
  "clearStickers",
  "applyLipStickMakeup",
  "applyEyeShadowMakeup",
  "applyBlusherStickMakeup",
  "applyFaceContourMakeup",
  "applyEyeBrowMakeup",
  "clearMakeups",
];

/** EditorContext methods up to base library 3.5.0, and `insertCustomBlock` (3.7.11); `<editor>` runs them. */
const EDITOR_METHODS = [
  "format",
  "removeFormat",
  "insertDivider",
  "insertImage",
  "insertText",
  "setContents",
  "getContents",
  "getSelectionText",
  "clear",
  "undo",
  "redo",
  "blur",
  "scrollIntoView",
  "insertCustomBlock",
];

/** MapContext methods up to base library 3.5.0; the simulated `<map>` runs them. */
const MAP_METHODS = [
  "getCenterLocation",
  "setLocMarkerIcon",
  "moveToLocation",
  "translateMarker",
  "moveAlong",
  "includePoints",
  "getRegion",
  "getRotate",
  "getSkew",
  "getScale",
  "setCenterOffset",
  "removeCustomLayer",
  "addCustomLayer",
  "addGroundOverlay",
  "addVisualLayer",
  "removeVisualLayer",
  "executeVisualLayerCommand",
  "addArc",
  "removeArc",
  "setBoundary",
  "updateGroundOverlay",
  "removeGroundOverlay",
  "toScreenLocation",
  "fromScreenLocation",
  "openMapApp",
  "addMarkers",
  "removeMarkers",
  "initMarkerCluster",
  "eraseLines",
];

/** Context methods take no Promise style: without callbacks they return nothing. */
const callbackApi = (name: string, impl: (options: Options) => Promise<Record<string, unknown>>) =>
  asyncApi(name, impl, { promise: false });

const isOptions = (value: unknown): value is Options =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An argument without its callbacks, as it can travel to the view. */
const plain = (value: unknown) =>
  isOptions(value)
    ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== "function"))
    : value;

const finite = (value: unknown, fallback: number) => {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

/** The page and template a context works in. */
type Scope = () => { webviewId: number; scopeNodeId: number };

export function createContextApis(ctx: ApiContext) {
  const { host } = ctx;
  /**
   * The page and template a context works in: the component's when it is
   * given, else the page that is open when the context is created, or at the
   * call when none is.
   */
  const scopeFor = (component?: object): Scope => {
    const scope = component ? host.scopeOf(component) : undefined;
    const createdOn = scope?.webviewId ?? host.topWebviewId();
    return () => {
      const webviewId = createdOn ?? host.topWebviewId();
      if (webviewId === undefined) throw new Error("no page is open");
      return { webviewId, scopeNodeId: scope?.nodeId ?? 0 };
    };
  };

  let generated = 0;
  const generateImage = async (width: number, height: number) => {
    const bytes = await encodePhoto(width, height, generated++);
    return ctx.files.writeTemp(bytes, "png");
  };

  /** A context whose methods call the built-in component in the view, such as `VideoContext`. */
  const builtinContext = (
    name: string,
    tag: string,
    methods: string[],
    /** Without one, the first such component in the page, as `wx.createLivePusherContext` finds it. */
    id: string | undefined,
    scope: Scope,
    /** Runs after the component answered, with the call's options, such as translateMarker's animationEnd. */
    after?: (method: string, options: Options) => void,
  ) => {
    const call = (method: string, args: unknown[]) =>
      callbackApi(method, async () => {
        const { webviewId, scopeNodeId } = scope();
        try {
          const result = await host.callBuiltin(
            webviewId,
            { tag, id, scopeNodeId },
            method,
            args.map(plain),
          );
          after?.(method, args.find(isOptions) ?? {});
          return result;
        } catch (error) {
          console.warn(`[omr] ${name}.${method}: ${(error as Error).message}`);
          throw error;
        }
      })(args.find(isOptions) ?? {});
    return Object.fromEntries(
      methods.map((method) => [method, (...args: unknown[]) => call(method, args)]),
    );
  };

  // wx.createVideoContext: each method calls the <video> in the view, which fires its events
  const videoContext = (id: string, scope: Scope) =>
    builtinContext("VideoContext", "video", VIDEO_METHODS, String(id), scope);
  const createVideoContext = (id: string, component?: object) =>
    videoContext(id, scopeFor(component));

  // wx.createAudioContext: each method calls the <audio> in the view; none takes callbacks
  const createAudioContext = (id: string, component?: object) => {
    const methods = builtinContext(
      "AudioContext",
      "audio",
      AUDIO_METHODS,
      String(id),
      scopeFor(component),
    );
    return Object.fromEntries(
      AUDIO_METHODS.map((method) => [
        method,
        (...args: unknown[]) => void methods[method]!(...args),
      ]),
    );
  };

  // wx.createMapContext: each method calls the <map> in the view, which moves and fires its events
  const mapContext = (mapId: string, scope: Scope) => ({
    ...builtinContext("MapContext", "map", MAP_METHODS, String(mapId), scope, (method, options) => {
      // The map answers translateMarker once the marker arrived
      if (method === "translateMarker") {
        safeCall(options.animationEnd as AnyFunction | undefined, undefined);
      }
    }),
    // Map events come from clusters and visual layers, which the simulated map has none of
    on: () => {},
  });

  // wx.createCameraContext: the <camera> of the page that is open
  const recordings = new Map<
    number,
    { timer: ReturnType<typeof setTimeout>; finish: () => Promise<Record<string, unknown>> }
  >();
  const createCameraContext = () => {
    const createdOn = host.topWebviewId();
    const webviewOf = () => createdOn ?? host.topWebviewId();
    /** Throws the failure of a call without a camera that shows its preview. */
    const requireCamera = () => {
      const webviewId = webviewOf();
      const state = webviewId === undefined ? undefined : ctx.cameraState(webviewId);
      if (!state) throw new Error("camera not found");
      if (state.error) throw new Error(state.error.replace(/^insertCamera:fail\s*/, ""));
      if (!state.ready) throw new Error("camera is not ready");
      return webviewId!;
    };
    const cameraApi = (impl: (options: Options) => Promise<Record<string, unknown>>) =>
      callbackApi("operateCamera", impl);
    const recordResult = async () => ({
      tempThumbPath: await generateImage(PHOTO_WIDTH, PHOTO_HEIGHT),
      tempVideoPath: ctx.files.writeTemp(new TextEncoder().encode("omr simulated video\n"), "mp4"),
    });
    return {
      takePhoto: cameraApi(async () => {
        requireCamera();
        return { tempImagePath: await generateImage(PHOTO_WIDTH, PHOTO_HEIGHT) };
      }),
      setZoom: cameraApi(async (options) => {
        requireCamera();
        const zoom = Number(options.zoom);
        if (!Number.isFinite(zoom)) throw new Error("parameter error: zoom should be Number");
        return { zoom: Math.min(CAMERA_MAX_ZOOM, Math.max(1, Math.round(zoom * 10) / 10)) };
      }),
      startRecord: cameraApi(async (options) => {
        const webviewId = requireCamera();
        if (recordings.has(webviewId)) throw new Error("is recording");
        const seconds = Math.min(
          RECORD_MAX_S,
          Math.max(1, finite(options.timeout, RECORD_TIMEOUT_S)),
        );
        const timeoutCallback = options.timeoutCallback as AnyFunction | undefined;
        const finish = () => {
          clearTimeout(recording.timer);
          recordings.delete(webviewId);
          return recordResult();
        };
        const recording = {
          finish,
          timer: setTimeout(() => {
            void finish().then((result) => safeCall(timeoutCallback, result));
          }, seconds * 1000),
        };
        recordings.set(webviewId, recording);
        return {};
      }),
      stopRecord: cameraApi(async () => {
        const webviewId = webviewOf();
        const recording = webviewId === undefined ? undefined : recordings.get(webviewId);
        if (!recording) throw new Error("is not recording");
        return recording.finish();
      }),
      /** Delivers generated frames ten times a second while the camera shows its preview. */
      onCameraFrame: (callback: AnyFunction) => {
        let timer: ReturnType<typeof setInterval> | undefined;
        let count = 0;
        const stop = () => {
          clearInterval(timer);
          timer = undefined;
        };
        const deliver = () => {
          const webviewId = webviewOf();
          const state = webviewId === undefined ? undefined : ctx.cameraState(webviewId);
          if (!state || state.error) {
            stop();
            return;
          }
          // A camera stopped in the background sends no frames until the app comes back
          if (!state.ready) return;
          const [width, height] = FRAME_SIZES[state.frameSize ?? ""] ?? FRAME_SIZES.medium!;
          const data = new Uint8Array(width * height * 4);
          const shift = (count++ * 4) % 256;
          for (let i = 0; i < data.length; i += 4) {
            const pixel = i / 4;
            data[i] = ((pixel % width) + shift) % 256;
            data[i + 1] = (Math.floor(pixel / width) + shift) % 256;
            data[i + 2] = 128;
            data[i + 3] = 255;
          }
          safeCall(callback, { width, height, data: data.buffer });
        };
        return {
          start: cameraApi(async () => {
            requireCamera();
            timer ??= setInterval(deliver, FRAME_MS);
            return {};
          }),
          stop: cameraApi(async () => {
            stop();
            return {};
          }),
        };
      },
    };
  };

  const snapshot = (width: number, height: number) =>
    callbackApi("snapshot", async () => ({
      tempImagePath: await generateImage(width, height),
      width,
      height,
    }));

  // wx.createLivePlayerContext: each method calls the <live-player> in the view, which fires its statechange codes
  const livePlayerContext = (id: string, scope: Scope) => ({
    ...builtinContext("LivePlayerContext", "live-player", LIVE_PLAYER_METHODS, id, scope),
    // A frame of the stream: landscape, as streams usually are
    snapshot: snapshot(640, 360),
  });
  const createLivePlayerContext = (id: string, component?: object) =>
    livePlayerContext(String(id), scopeFor(component));
  // wx.createLivePusherContext: the page's <live-pusher>, which pushes and fires its codes
  const livePusherContext = (id: string | undefined, scope: Scope) => ({
    ...builtinContext("LivePusherContext", "live-pusher", LIVE_PUSHER_METHODS, id, scope),
    snapshot: snapshot(360, 640),
    setZoom: callbackApi("setZoom", async (options) => ({
      zoom: Math.min(CAMERA_MAX_ZOOM, Math.max(1, finite(options.zoom, 1))),
    })),
    getMaxZoom: callbackApi("getMaxZoom", async () => ({ maxZoom: CAMERA_MAX_ZOOM })),
    // Custom rendering never delivers frames
    onCustomRendererEvent: () => {},
    offCustomRendererEvent: () => {},
    createOffscreenCanvas: (options?: Options) => ctx.wx.createOffscreenCanvas?.(options),
  });

  /**
   * The SelectionContext of a `<selection>`: it sets or clears the selection in
   * that very component. Its methods return nothing and take no callbacks.
   */
  const selectionContext = (webviewId: number, target: ContextNode) => {
    const call = (method: string, args: unknown[]) => {
      host.callBuiltin(webviewId, target, method, args.map(plain)).catch((error: unknown) => {
        console.warn(`[omr] SelectionContext.${method}: ${(error as Error).message}`);
      });
    };
    return {
      selectRange: (start: number, end: number) => call("selectRange", [start, end]),
      setBaseAndExtent: (
        anchorNodeId: string,
        anchorOffset: number,
        focusNodeId: string,
        focusOffset: number,
      ) => call("setBaseAndExtent", [anchorNodeId, anchorOffset, focusNodeId, focusOffset]),
      removeSelection: () => call("removeSelection", []),
    };
  };

  /**
   * `NodesRef.context`: the context of a node the view described, in the page
   * it is on. A legacy `<canvas>` is found by its `canvas-id` in the query's
   * component; nodes without a context have none.
   */
  const contextOf = (webviewId: number, node: ContextNode | null, component?: object) => {
    if (!node) return undefined;
    const scope: Scope = () => ({ webviewId, scopeNodeId: node.scopeNodeId });
    const id = node.id ?? "";
    switch (node.tag) {
      case "editor":
        return builtinContext("EditorContext", "editor", EDITOR_METHODS, id, scope);
      case "video":
        return videoContext(id, scope);
      case "map":
        return mapContext(id, scope);
      case "live-player":
        return livePlayerContext(id, scope);
      case "live-pusher":
        return livePusherContext(node.id, scope);
      case "selection":
        return selectionContext(webviewId, node);
      case "canvas":
        return node.canvasId === undefined || node.canvasType
          ? undefined
          : ctx.wx.createCanvasContext?.(node.canvasId, component);
      default:
        return undefined;
    }
  };

  /**
   * `NodesRef.node` of an enhanced `<scroll-view>`: a ScrollViewContext. Its
   * properties apply to the scroll view when set; its methods return nothing
   * and take no callbacks, as WeChat documents them.
   */
  const scrollViewContext = (webviewId: number, { scrollView }: ScrollViewNode) => {
    const { settings, ...target } = scrollView;
    const call = (method: string, args: unknown[]) => {
      host.callBuiltin(webviewId, target, method, args.map(plain)).catch((error: unknown) => {
        console.warn(`[omr] ScrollViewContext.${method}: ${(error as Error).message}`);
      });
    };
    const values = { ...settings };
    const context: Record<string, unknown> = {
      scrollTo: (options: Options = {}) => call("scrollTo", [options]),
      scrollIntoView: (selector: string, options?: Options) =>
        call("scrollIntoView", [String(selector), options ?? {}]),
      triggerRefresh: (options: Options = {}) => call("triggerRefresh", [options]),
      closeRefresh: () => call("closeRefresh", []),
      triggerTwoLevel: (options: Options = {}) => call("triggerTwoLevel", [options]),
      closeTwoLevel: (options: Options = {}) => call("closeTwoLevel", [options]),
    };
    for (const name of Object.keys(values)) {
      Object.defineProperty(context, name, {
        enumerable: true,
        get: () => values[name],
        set: (value: unknown) => {
          values[name] = Boolean(value);
          call("set", [{ [name]: values[name] }]);
        },
      });
    }
    return context;
  };

  return {
    scrollViewContext,
    apis: {
      createVideoContext,
      createAudioContext,
      createMapContext: (mapId: string, component?: object) =>
        mapContext(mapId, scopeFor(component)),
      createCameraContext,
      createLivePlayerContext,
      createLivePusherContext: () => livePusherContext(undefined, scopeFor()),
    } as Record<string, unknown>,
    contextOf,
  };
}
