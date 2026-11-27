/**
 * Canvas APIs. The Mini Program draws in the logic layer on an OffscreenCanvas,
 * and each changed picture goes to the `<canvas>` in the page as an ImageBitmap:
 *
 * - `<canvas type="2d">`: a selector query's `node` is a `Canvas` with the
 *   documented `getContext`, `createImage`, `requestAnimationFrame` and so on.
 * - The legacy `wx.createCanvasContext(canvasId)` records calls, and `draw`
 *   replays them on the canvas at the device pixel ratio.
 */
import { fsFileUrl, isFsPath } from "./context.ts";
import { asyncApi, type AnyFunction, type Options } from "./common.ts";
import type { ApiContext } from "./context.ts";
import { bytesToBase64 } from "./files.ts";
import { proxyStream } from "./network.ts";

/** What the view answers for the `node` field of a `<canvas>`. */
interface CanvasNodeInfo {
  canvasNodeId: number;
  width: number;
  height: number;
}

/** Turns what a Mini Program passes as an image into something an OffscreenCanvas draws. */
const unwrap = (value: unknown): unknown =>
  value instanceof MiniImage ? value.bitmap : value instanceof MiniCanvas ? value.offscreen : value;

/** Where an image source is fetched from, as the logic layer sees it. */
function imageUrl(src: string): string {
  if (isFsPath(src)) return fsFileUrl(src);
  if (/^([a-z][\w+.-]*:|\/\/)/i.test(src)) return src;
  return `/__omr/files/${src.replace(/^\/+/, "")}`;
}

/** How long a network image may take, as `wx.downloadFile` allows by default. */
const IMAGE_TIMEOUT = 60_000;

async function loadBitmap(src: string): Promise<ImageBitmap> {
  // Network images go through the simulator's request proxy: WeChat loads them without CORS
  if (/^https?:\/\//i.test(src) && !isFsPath(src)) {
    const { head, bytes } = await proxyStream(
      { url: src, method: "GET", header: {} },
      AbortSignal.timeout(IMAGE_TIMEOUT),
      () => {},
      () => {},
    );
    if (head.statusCode < 200 || head.statusCode >= 300) {
      throw new Error(`GET ${src} ${head.statusCode}`);
    }
    return createImageBitmap(new Blob([bytes]));
  }
  const response = await fetch(imageUrl(src));
  if (!response.ok) throw new Error(`GET ${src} ${response.status}`);
  return createImageBitmap(await response.blob());
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  // 5552 bytes is the most that can be summed before the sums must be reduced
  for (let start = 0; start < bytes.length; start += 5552) {
    const end = Math.min(bytes.length, start + 5552);
    for (let i = start; i < end; i++) {
      a += bytes[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Largest length of a stored deflate block. */
const STORED_BLOCK = 0xffff;

/**
 * Encodes RGBA pixels, not premultiplied, as a PNG. The image data is in
 * stored (uncompressed) deflate blocks: encoding stays synchronous and simple,
 * as `Canvas.toDataURL` needs, at the cost of size.
 */
export function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
): Uint8Array<ArrayBuffer> {
  // Each row starts with filter type 0, none
  const stride = width * 4 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  }
  const blocks = Math.max(1, Math.ceil(raw.length / STORED_BLOCK));
  const zlib = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  const z = new DataView(zlib.buffer);
  // CMF 0x78 (deflate, 32K window) and FLG 0x01 make a valid zlib header
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  let at = 2;
  for (let i = 0; i < blocks; i++) {
    const start = i * STORED_BLOCK;
    const length = Math.min(STORED_BLOCK, raw.length - start);
    zlib[at] = i === blocks - 1 ? 1 : 0;
    z.setUint16(at + 1, length, true);
    z.setUint16(at + 3, ~length & 0xffff, true);
    zlib.set(raw.subarray(start, start + length), at + 5);
    at += 5 + length;
  }
  z.setUint32(at, adler32(raw));

  const header = new Uint8Array(13);
  const h = new DataView(header.buffer);
  h.setUint32(0, width);
  h.setUint32(4, height);
  // 8 bits per channel, color type 6 (RGBA), deflate, adaptive filtering, no interlace
  header.set([8, 6, 0, 0, 0], 8);
  const chunks: [string, Uint8Array][] = [
    ["IHDR", header],
    ["IDAT", zlib],
    ["IEND", new Uint8Array(0)],
  ];
  const png = new Uint8Array(8 + chunks.reduce((total, [, data]) => total + 12 + data.length, 0));
  const view = new DataView(png.buffer);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  for (const [type, data] of chunks) {
    view.setUint32(offset, data.length);
    const typed = new Uint8Array(4 + data.length);
    typed.set(new TextEncoder().encode(type));
    typed.set(data, 4);
    png.set(typed, offset + 4);
    view.setUint32(offset + 8 + data.length, crc32(typed));
    offset += 12 + data.length;
  }
  return png;
}

/** Whether `Canvas.toDataURL` said it encodes PNG for another type. */
let notedPngOnly = false;

/** `Canvas.createImage()`: loads when `src` is set, then calls `onload` or `onerror`. */
class MiniImage {
  bitmap?: ImageBitmap;
  onload: AnyFunction | null = null;
  onerror: AnyFunction | null = null;
  complete = false;
  private source = "";
  get src() {
    return this.source;
  }
  set src(value: string) {
    this.source = String(value);
    this.complete = false;
    const src = this.source;
    loadBitmap(src).then(
      (bitmap) => {
        if (src !== this.source) return;
        this.bitmap = bitmap;
        this.complete = true;
        this.onload?.({ type: "load" });
      },
      (error: Error) => {
        if (src !== this.source) return;
        this.onerror?.({ type: "error", message: error.message });
      },
    );
  }
  get width() {
    return this.bitmap?.width ?? 0;
  }
  get height() {
    return this.bitmap?.height ?? 0;
  }
}

/** The `Canvas` of `<canvas type="2d">` and `wx.createOffscreenCanvas`. */
class MiniCanvas {
  readonly offscreen: OffscreenCanvas;
  private context?: unknown;
  private contextType?: "2d" | "webgl";
  private frameQueued = false;
  private readonly show?: (bitmap: ImageBitmap) => void;
  constructor(width: number, height: number, show?: (bitmap: ImageBitmap) => void) {
    this.offscreen = new OffscreenCanvas(width, height);
    this.show = show;
  }
  get width() {
    return this.offscreen.width;
  }
  set width(value: number) {
    this.offscreen.width = value;
    this.changed();
  }
  get height() {
    return this.offscreen.height;
  }
  set height(value: number) {
    this.offscreen.height = value;
    this.changed();
  }
  getContext(type: string) {
    if (type !== "2d" && type !== "webgl") return null;
    const real = this.offscreen.getContext(type);
    if (!real) return null;
    this.contextType = type;
    this.context ??=
      type === "2d" ? wrapContext(real as OffscreenCanvasRenderingContext2D, this) : real;
    return this.context;
  }
  createImage() {
    return new MiniImage();
  }
  createImageData(...args: [number, number] | [ImageData]) {
    return args.length === 1
      ? new ImageData(args[0].width, args[0].height)
      : new ImageData(...args);
  }
  createPath2D(path?: Path2D | string) {
    return new Path2D(path);
  }
  requestAnimationFrame(callback: AnyFunction) {
    return setTimeout(() => {
      try {
        callback(performance.now());
      } catch (error) {
        console.error("[omr] error in Canvas.requestAnimationFrame callback:", error);
      }
      // WebGL draws without going through the 2D wrapper
      this.changed();
    }, 16) as unknown as number;
  }
  cancelAnimationFrame(id: number) {
    clearTimeout(id);
  }
  /**
   * An OffscreenCanvas only encodes asynchronously, so the pixels are read and
   * encoded here. Only PNG is written: like a browser, another type gives PNG.
   */
  toDataURL(type = "image/png") {
    const { width, height } = this.offscreen;
    if (width === 0 || height === 0) return "data:,";
    if (String(type).toLowerCase() !== "image/png" && !notedPngOnly) {
      notedPngOnly = true;
      console.info(`[omr] Canvas.toDataURL encodes PNG only in the simulator, not ${type}`);
    }
    return `data:image/png;base64,${bytesToBase64(encodePng(width, height, this.pixels()))}`;
  }
  /** The picture as RGBA rows from the top, not premultiplied. */
  private pixels(): Uint8Array | Uint8ClampedArray {
    const { width, height } = this.offscreen;
    if (this.contextType === "2d") {
      return this.offscreen.getContext("2d")!.getImageData(0, 0, width, height).data;
    }
    const pixels = new Uint8Array(width * height * 4);
    if (this.contextType !== "webgl") return pixels;
    const gl = this.offscreen.getContext("webgl")!;
    const read = new Uint8Array(pixels.length);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, read);
    // WebGL rows start at the bottom
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      pixels.set(read.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    }
    if (gl.getContextAttributes()?.premultipliedAlpha !== false) {
      for (let i = 0; i < pixels.length; i += 4) {
        const alpha = pixels[i + 3]!;
        if (alpha === 0 || alpha === 255) continue;
        for (let c = i; c < i + 3; c++)
          pixels[c] = Math.min(255, Math.round((pixels[c]! * 255) / alpha));
      }
    }
    return pixels;
  }
  /** Sends the picture to the page once the current task has finished drawing. */
  changed() {
    if (!this.show || this.frameQueued) return;
    this.frameQueued = true;
    setTimeout(() => {
      this.frameQueued = false;
      if (this.offscreen.width === 0 || this.offscreen.height === 0) return;
      void createImageBitmap(this.offscreen).then(this.show!);
    }, 0);
  }
}

/** The 2D context a Mini Program gets: every call marks the canvas changed, and images unwrap. */
function wrapContext(real: OffscreenCanvasRenderingContext2D, canvas: MiniCanvas) {
  return new Proxy(real, {
    get(target, key) {
      if (key === "canvas") return canvas;
      const value = Reflect.get(target, key, target) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        canvas.changed();
        return (value as AnyFunction).apply(target, args.map(unwrap));
      };
    },
    set(target, key, value) {
      canvas.changed();
      return Reflect.set(target, key, unwrap(value), target);
    },
  });
}

/** Legacy setters of CanvasContext and the context property each sets. */
const LEGACY_SETTERS: Record<string, string> = {
  setFillStyle: "fillStyle",
  setStrokeStyle: "strokeStyle",
  setLineWidth: "lineWidth",
  setLineCap: "lineCap",
  setLineJoin: "lineJoin",
  setMiterLimit: "miterLimit",
  setGlobalAlpha: "globalAlpha",
  setTextAlign: "textAlign",
  setTextBaseline: "textBaseline",
};

type Command = { set: string; value: unknown } | { call: string; args: unknown[] };

/** A gradient of the legacy context, made real when `draw` replays it. */
class LegacyGradient {
  readonly stops: [number, string][] = [];
  readonly kind: "linear" | "circular";
  readonly args: number[];
  constructor(kind: "linear" | "circular", args: number[]) {
    this.kind = kind;
    this.args = args;
  }
  addColorStop(offset: number, color: string) {
    this.stops.push([offset, color]);
  }
  create(ctx: OffscreenCanvasRenderingContext2D) {
    const [a = 0, b = 0, c = 0, d = 0] = this.args;
    const gradient =
      this.kind === "linear"
        ? ctx.createLinearGradient(a, b, c, d)
        : ctx.createRadialGradient(a, b, 0, a, b, c);
    for (const [offset, color] of this.stops) gradient.addColorStop(offset, color);
    return gradient;
  }
}

export function createCanvasApis({ host, files }: ApiContext) {
  const dpr = Number(host.system.pixelRatio) || 1;
  /** Canvas nodes by WebView and node id, so a query returns the same node each time. */
  const nodes = new Map<string, MiniCanvas>();
  /** What the legacy contexts drew, by WebView and node id, kept for `reserve` and exports. */
  const legacy = new Map<string, OffscreenCanvas>();
  /** Pages that were unloaded: a draw still loading its images does not bring their canvas back. */
  const released = new Set<number>();
  /** The last legacy draw of each `canvas-id`; the next one waits for it, so batches land in order. */
  const drawing = new Map<string, Promise<void>>();

  const nodeOf = (webviewId: number, info: CanvasNodeInfo): MiniCanvas => {
    const key = `${webviewId}:${info.canvasNodeId}`;
    let node = nodes.get(key);
    if (!node) {
      node = new MiniCanvas(300, 150, (bitmap) =>
        host.sendView(webviewId, { type: "canvasFrame", canvasNodeId: info.canvasNodeId, bitmap }),
      );
      nodes.set(key, node);
    }
    return node;
  };

  /** Finds a legacy `<canvas canvas-id>` in the page or a component. */
  const findLegacy = async (canvasId: string, component?: object) => {
    const scope = (component && host.scopeOf(component)) || {
      webviewId: host.topWebviewId(),
      nodeId: 0,
    };
    if (scope.webviewId === undefined) throw new Error("no page is open");
    const [found] = (await host.query(scope.webviewId, [
      {
        selector: `[canvas-id=${JSON.stringify(String(canvasId))}]`,
        all: false,
        scopeNodeId: scope.nodeId,
        fields: { node: true },
      },
    ])) as ({ node: CanvasNodeInfo | null } | null)[];
    if (!found?.node) throw new Error(`canvas with canvas-id "${canvasId}" is not found`);
    return { webviewId: scope.webviewId, info: found.node };
  };

  const createCanvasContext = (canvasId: string, component?: object) => {
    let commands: Command[] = [];
    // A context only measures text; it never draws
    const measurer = new OffscreenCanvas(1, 1).getContext("2d")!;
    const record = (call: string, args: unknown[]) => void commands.push({ call, args });
    const setter = (set: string) => (value: unknown) => void commands.push({ set, value });

    const context: Record<string, unknown> = {
      canvasId,
      setFontSize: (size: number) => {
        commands.push({ set: "font", value: `${size}px sans-serif` });
        measurer.font = `${size}px sans-serif`;
      },
      setShadow: (offsetX: number, offsetY: number, blur: number, color: string) => {
        commands.push(
          { set: "shadowOffsetX", value: offsetX },
          { set: "shadowOffsetY", value: offsetY },
          { set: "shadowBlur", value: blur },
          { set: "shadowColor", value: color },
        );
      },
      setLineDash: (pattern: number[], offset = 0) => {
        record("setLineDash", [pattern]);
        commands.push({ set: "lineDashOffset", value: offset });
      },
      createLinearGradient: (x0: number, y0: number, x1: number, y1: number) =>
        new LegacyGradient("linear", [x0, y0, x1, y1]),
      createCircularGradient: (x: number, y: number, r: number) =>
        new LegacyGradient("circular", [x, y, r]),
      createPattern: (image: string, repetition: string) => ({ pattern: image, repetition }),
      measureText: (text: string) => measurer.measureText(String(text)),
      draw: (reserve?: boolean | AnyFunction, callback?: AnyFunction) => {
        if (typeof reserve === "function") [reserve, callback] = [false, reserve];
        const drawn = commands;
        commands = [];
        // After the canvas's earlier draws, even of other contexts, whether they worked or not
        const run = (drawing.get(canvasId) ?? Promise.resolve()).then(() =>
          draw(drawn, Boolean(reserve)).then(
            () => callback?.(),
            (error: Error) => console.error(`[omr] CanvasContext.draw: ${error.message}`),
          ),
        );
        drawing.set(canvasId, run);
        void run.then(() => {
          if (drawing.get(canvasId) === run) drawing.delete(canvasId);
        });
      },
    };
    for (const [name, property] of Object.entries(LEGACY_SETTERS)) {
      context[name] = setter(property);
    }
    const replay = async (ctx: OffscreenCanvasRenderingContext2D, drawn: Command[]) => {
      // Image paths load first, so the replay itself is synchronous
      const images = new Map<string, ImageBitmap>();
      for (const command of drawn) {
        const source =
          "call" in command && command.call === "drawImage"
            ? command.args[0]
            : "set" in command && typeof command.value === "object"
              ? (command.value as { pattern?: unknown })?.pattern
              : undefined;
        if (typeof source === "string" && !images.has(source)) {
          images.set(source, await loadBitmap(source));
        }
      }
      const value = (raw: unknown): unknown => {
        if (raw instanceof LegacyGradient) return raw.create(ctx);
        const pattern = raw as { pattern?: string; repetition?: string } | null;
        if (pattern && typeof pattern === "object" && typeof pattern.pattern === "string") {
          return ctx.createPattern(images.get(pattern.pattern)!, pattern.repetition ?? "repeat");
        }
        return raw;
      };
      for (const command of drawn) {
        if ("set" in command) {
          (ctx as unknown as Record<string, unknown>)[command.set] = value(command.value);
        } else {
          const args = command.args.map((arg, index) =>
            index === 0 && command.call === "drawImage" && typeof arg === "string"
              ? images.get(arg)
              : unwrap(value(arg)),
          );
          (ctx[command.call as keyof OffscreenCanvasRenderingContext2D] as AnyFunction).apply(
            ctx,
            args,
          );
        }
      }
    };
    const draw = async (drawn: Command[], reserve: boolean) => {
      const { webviewId, info } = await findLegacy(canvasId, component);
      const key = `${webviewId}:${info.canvasNodeId}`;
      const width = Math.max(1, Math.round(info.width * dpr));
      const height = Math.max(1, Math.round(info.height * dpr));
      let canvas = legacy.get(key);
      if (!canvas || canvas.width !== width || canvas.height !== height) {
        canvas = new OffscreenCanvas(width, height);
        legacy.set(key, canvas);
      }
      const ctx = canvas.getContext("2d")!;
      ctx.save();
      if (!reserve) ctx.clearRect(0, 0, width, height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      await replay(ctx, drawn);
      ctx.restore();
      if (released.has(webviewId)) {
        legacy.delete(key);
        return;
      }
      const bitmap = await createImageBitmap(canvas);
      host.sendView(webviewId, { type: "canvasFrame", canvasNodeId: info.canvasNodeId, bitmap });
    };
    // Every other method of CanvasRenderingContext2D is recorded as is
    return new Proxy(context, {
      get(target, key) {
        if (typeof key !== "string" || key in target) return target[key as string];
        return (...args: unknown[]) => record(key, args);
      },
      set(target, key, value) {
        if (typeof key === "string") commands.push({ set: key, value });
        return true;
      },
    });
  };

  /** The canvas an export or pixel API names, and how many of its pixels make one logical pixel. */
  const sourceOf = async (options: Options, component?: object) => {
    if (options.canvas instanceof MiniCanvas) return { canvas: options.canvas.offscreen, scale: 1 };
    if (options.canvasId === undefined) throw new Error("canvas or canvasId is required");
    const { webviewId, info } = await findLegacy(String(options.canvasId), component);
    const canvas = legacy.get(`${webviewId}:${info.canvasNodeId}`);
    if (!canvas) throw new Error("canvas is empty");
    return { canvas, scale: dpr };
  };

  /** A page is gone: its canvases are released. */
  const releasePage = (webviewId: number) => {
    released.add(webviewId);
    for (const map of [nodes, legacy]) {
      for (const key of map.keys()) if (key.startsWith(`${webviewId}:`)) map.delete(key);
    }
  };

  return {
    nodeOf,
    releasePage,
    apis: {
      createCanvasContext,
      createOffscreenCanvas: (options: Options = {}) =>
        new MiniCanvas(Number(options.width ?? 300), Number(options.height ?? 150)),
      canvasToTempFilePath: (options: Options = {}, component?: object) =>
        asyncApi("canvasToTempFilePath", async () => {
          const { canvas, scale } = await sourceOf(options, component);
          const x = Number(options.x ?? 0) * scale;
          const y = Number(options.y ?? 0) * scale;
          const width =
            Number(options.width ?? canvas.width / scale - Number(options.x ?? 0)) * scale;
          const height =
            Number(options.height ?? canvas.height / scale - Number(options.y ?? 0)) * scale;
          const out = new OffscreenCanvas(
            Math.max(1, Math.round(Number(options.destWidth ?? width))),
            Math.max(1, Math.round(Number(options.destHeight ?? height))),
          );
          out.getContext("2d")!.drawImage(canvas, x, y, width, height, 0, 0, out.width, out.height);
          const jpg = options.fileType === "jpg";
          const blob = await out.convertToBlob({
            type: jpg ? "image/jpeg" : "image/png",
            quality: Number(options.quality ?? 1),
          });
          const path = files.writeTemp(
            new Uint8Array(await blob.arrayBuffer()),
            jpg ? "jpg" : "png",
          );
          return { tempFilePath: path };
        })(options),
      canvasGetImageData: (options: Options = {}, component?: object) =>
        asyncApi("canvasGetImageData", async () => {
          const { canvas, scale } = await sourceOf(options, component);
          const image = canvas
            .getContext("2d")!
            .getImageData(
              Number(options.x ?? 0) * scale,
              Number(options.y ?? 0) * scale,
              Number(options.width) * scale,
              Number(options.height) * scale,
            );
          return { width: image.width, height: image.height, data: image.data };
        })(options),
    },
  };
}
