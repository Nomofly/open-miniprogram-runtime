/**
 * Contexts of native components: `wx.createVideoContext`, `wx.createMapContext`,
 * `wx.createCameraContext`, `wx.createLivePlayerContext` and
 * `wx.createLivePusherContext`, and the contexts `NodesRef.context` gives,
 * such as `EditorContext`.
 *
 * `VideoContext` drives the `<video>` in the page, which fires its own events.
 * `<map>`, `<live-player>` and `<live-pusher>` are placeholders: their contexts
 * succeed with values derived from the map's attributes, or with generated
 * images. `CameraContext` needs a `<camera>` on the page with `scope.camera`
 * granted; its photos and frames are generated, and its recordings hold no
 * playable frames, as `wx.chooseVideo` returns.
 */
import { asyncApi, safeCall, type AnyFunction, type Options } from "./common.ts";
import type { ContextNode } from "../protocol.ts";
import type { ApiContext } from "./context.ts";
import { encodePhoto } from "./media.ts";

/** What `<map>` shows without `scale`, and the range `min-scale` and `max-scale` default to. */
const MAP_SCALE = 16;
const MAP_MIN_SCALE = 3;
const MAP_MAX_SCALE = 20;
/** The size of a map tile at scale 0, in px: a scale step doubles the map. */
const MAP_TILE = 256;
/** The `<camera>` reports `maxZoom: 1` in `initdone`, so every zoom becomes 1. */
const CAMERA_MAX_ZOOM = 1;
/** Generated photos are portrait, as `wx.chooseImage` takes them with the camera. */
const PHOTO_WIDTH = 600;
const PHOTO_HEIGHT = 800;
/** `startRecord` stops by itself after `timeout` seconds: 30 by default, at most 5 minutes. */
const RECORD_TIMEOUT_S = 30;
const RECORD_MAX_S = 300;
/** Generated camera frames, whatever `frame-size` asks for. */
const FRAME_WIDTH = 240;
const FRAME_HEIGHT = 320;
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

/** EditorContext methods up to base library 3.5.0; `<editor>` runs them. */
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
];

/** The `<map>` attributes the map context reads. */
const MAP_PROPERTIES = [
  "latitude",
  "longitude",
  "scale",
  "minScale",
  "maxScale",
  "rotate",
  "skew",
  "setting",
];

interface LatLng {
  latitude: number;
  longitude: number;
}

/** What `MapContext` changed since the map's attributes last changed. */
interface MapState {
  attributes: string;
  center?: LatLng;
  scale?: number;
}

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

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** Web Mercator pixel coordinates of a point at a scale. */
function project({ latitude, longitude }: LatLng, scale: number) {
  const size = MAP_TILE * 2 ** scale;
  const sin = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, latitude)) * Math.PI) / 180);
  return {
    x: ((longitude + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

function unproject(x: number, y: number, scale: number): LatLng {
  const size = MAP_TILE * 2 ** scale;
  const n = Math.PI - (2 * Math.PI * y) / size;
  return {
    latitude: round((180 / Math.PI) * Math.atan(Math.sinh(n))),
    longitude: round((x / size) * 360 - 180),
  };
}

/** The page and template a context works in. */
type Scope = () => { webviewId: number; scopeNodeId: number };

export function createContextApis(ctx: ApiContext) {
  const { host } = ctx;
  const defaultLocation = (): LatLng => {
    const { latitude, longitude } = host.manifest.config.location ?? {
      latitude: 39.908823,
      longitude: 116.39747,
    };
    return { latitude, longitude };
  };

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
    id: string,
    scope: Scope,
  ) => {
    const call = (method: string, args: unknown[]) =>
      callbackApi(method, async () => {
        const { webviewId, scopeNodeId } = scope();
        try {
          return await host.callBuiltin(
            webviewId,
            { tag, id, scopeNodeId },
            method,
            args.map(plain),
          );
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

  // wx.createMapContext: <map> is a placeholder, so the map is what its attributes say
  const mapStates = new Map<string, MapState>();
  const mapContext = (mapId: string, scope: Scope) => {
    const id = String(mapId);
    /** The map's center, scale, rotation and size now. */
    const read = async () => {
      const { webviewId, scopeNodeId } = scope();
      const [found] = (await host.query(webviewId, [
        {
          selector: `wx-map[id=${JSON.stringify(id)}]`,
          all: false,
          scopeNodeId,
          fields: { size: true, properties: MAP_PROPERTIES },
        },
      ])) as (Record<string, unknown> | null)[];
      if (!found) throw new Error(`no <map id="${id}"> found`);
      const setting = isOptions(found.setting) ? found.setting : {};
      const attribute = (name: string) => setting[name] ?? found[name];
      const minScale = finite(attribute("minScale"), MAP_MIN_SCALE);
      const maxScale = finite(attribute("maxScale"), MAP_MAX_SCALE);
      const fallback = defaultLocation();
      const attributes = {
        latitude: finite(attribute("latitude"), fallback.latitude),
        longitude: finite(attribute("longitude"), fallback.longitude),
        scale: Math.min(maxScale, Math.max(minScale, finite(attribute("scale"), MAP_SCALE))),
        rotate: finite(attribute("rotate"), 0),
        skew: finite(attribute("skew"), 0),
      };
      // Changing the attributes moves the map again, over what the context did
      const key = `${webviewId}:${scopeNodeId}:${id}`;
      const serialized = JSON.stringify(attributes);
      let state = mapStates.get(key);
      if (state?.attributes !== serialized) {
        state = { attributes: serialized };
        mapStates.set(key, state);
      }
      return {
        state,
        center: state.center ?? { latitude: attributes.latitude, longitude: attributes.longitude },
        scale: state.scale ?? attributes.scale,
        minScale,
        maxScale,
        rotate: attributes.rotate,
        skew: attributes.skew,
        width: Number(found.width) || 0,
        height: Number(found.height) || 0,
      };
    };
    const latLngOf = (options: Options, name = "") => {
      const latitude = Number(options.latitude);
      const longitude = Number(options.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new Error(`parameter error: ${name}latitude and ${name}longitude should be Number`);
      }
      return { latitude, longitude };
    };
    const methods: Record<string, (options: Options) => Promise<Record<string, unknown>>> = {
      getCenterLocation: async () => ({ ...(await read()).center }),
      getScale: async () => ({ scale: (await read()).scale }),
      getRotate: async () => ({ rotate: (await read()).rotate }),
      getSkew: async () => ({ skew: (await read()).skew }),
      getRegion: async () => {
        const { center, scale, width, height } = await read();
        const { x, y } = project(center, scale);
        return {
          southwest: unproject(x - width / 2, y + height / 2, scale),
          northeast: unproject(x + width / 2, y - height / 2, scale),
        };
      },
      moveToLocation: async (options) => {
        const { state } = await read();
        // Without a point, the map moves to the user's location
        state.center =
          options.latitude === undefined && options.longitude === undefined
            ? defaultLocation()
            : latLngOf(options);
        return {};
      },
      includePoints: async (options) => {
        const points = Array.isArray(options.points) ? options.points.map((p) => latLngOf(p)) : [];
        if (points.length === 0) throw new Error("parameter error: points should not be empty");
        const { state, width, height, minScale, maxScale } = await read();
        const [top = 0, right = 0, bottom = 0, left = 0] = Array.isArray(options.padding)
          ? options.padding.map(Number)
          : [];
        const projected = points.map((point) => project(point, 0));
        const xs = projected.map((p) => p.x);
        const ys = projected.map((p) => p.y);
        const [minX, maxX, minY, maxY] = [
          Math.min(...xs),
          Math.max(...xs),
          Math.min(...ys),
          Math.max(...ys),
        ];
        state.center = unproject((minX + maxX) / 2, (minY + maxY) / 2, 0);
        // The largest scale that shows every point inside the padding
        const fit = Math.min(
          (width - left - right) / (maxX - minX),
          (height - top - bottom) / (maxY - minY),
        );
        const scale = Number.isFinite(fit) && fit > 0 ? Math.floor(Math.log2(fit)) : maxScale;
        state.scale = Math.min(maxScale, Math.max(minScale, scale));
        return {};
      },
      toScreenLocation: async (options) => {
        const point = latLngOf(options);
        const { center, scale, width, height } = await read();
        const from = project(center, scale);
        const to = project(point, scale);
        return { x: to.x - from.x + width / 2, y: to.y - from.y + height / 2 };
      },
      fromScreenLocation: async (options) => {
        const x = Number(options.x);
        const y = Number(options.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error("parameter error: x and y should be Number");
        }
        const { center, scale, width, height } = await read();
        const { x: cx, y: cy } = project(center, scale);
        return { ...unproject(cx + x - width / 2, cy + y - height / 2, scale) };
      },
      translateMarker: async (options) => {
        latLngOf(options.destination ?? {}, "destination.");
        // The marker is not drawn; the animation ends after its duration
        const animationEnd = options.animationEnd as AnyFunction | undefined;
        setTimeout(() => safeCall(animationEnd, undefined), finite(options.duration, 1000));
        return {};
      },
      moveAlong: async (options) => {
        if (!Array.isArray(options.path) || options.path.length === 0) {
          throw new Error("parameter error: path should not be empty");
        }
        // Succeeds when the marker would reach the end of the path
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, finite(options.duration, 0))),
        );
        return {};
      },
    };
    const context: Record<string, unknown> = {
      // Map events come from clusters and visual layers, which the placeholder has none of
      on: () => {},
    };
    return new Proxy(context, {
      get(target, name) {
        if (typeof name !== "string" || name in target || name === "then") {
          return target[name as string];
        }
        // Methods without a result, such as addMarkers or addCustomLayer, succeed
        const impl = methods[name] ?? (async () => ({}));
        return (options: Options = {}) => callbackApi(name, impl)(options);
      },
    });
  };

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
          if (webviewId === undefined || !ctx.cameraState(webviewId)?.ready) {
            stop();
            return;
          }
          const data = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 4);
          const shift = (count++ * 4) % 256;
          for (let i = 0; i < data.length; i += 4) {
            const pixel = i / 4;
            data[i] = ((pixel % FRAME_WIDTH) + shift) % 256;
            data[i + 1] = (Math.floor(pixel / FRAME_WIDTH) + shift) % 256;
            data[i + 2] = 128;
            data[i + 3] = 255;
          }
          safeCall(callback, { width: FRAME_WIDTH, height: FRAME_HEIGHT, data: data.buffer });
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

  /** Context methods that succeed without doing anything visible. */
  const succeeding = (methods: string[]) =>
    Object.fromEntries(methods.map((method) => [method, callbackApi(method, async () => ({}))]));
  const snapshot = (width: number, height: number) =>
    callbackApi("snapshot", async () => ({
      tempImagePath: await generateImage(width, height),
      width,
      height,
    }));

  const createLivePlayerContext = (_id?: string, _component?: object) => ({
    ...succeeding(LIVE_PLAYER_METHODS),
    // A frame of the stream: landscape, as streams usually are
    snapshot: snapshot(640, 360),
  });
  const createLivePusherContext = () => ({
    ...succeeding(LIVE_PUSHER_METHODS),
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
        return createLivePlayerContext(id);
      case "live-pusher":
        return createLivePusherContext();
      case "canvas":
        return node.canvasId === undefined || node.canvasType
          ? undefined
          : ctx.wx.createCanvasContext?.(node.canvasId, component);
      default:
        return undefined;
    }
  };

  return {
    apis: {
      createVideoContext,
      createMapContext: (mapId: string, component?: object) =>
        mapContext(mapId, scopeFor(component)),
      createCameraContext,
      createLivePlayerContext,
      createLivePusherContext,
    } as Record<string, unknown>,
    contextOf,
  };
}
