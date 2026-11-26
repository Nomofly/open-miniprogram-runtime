/**
 * Media APIs: choosing, previewing, inspecting, compressing and saving images
 * and videos, and audio playback. The simulator has no camera, album or
 * speaker: chosen images are generated PNGs or the project files listed in
 * omr.config.json `media.images`, and audio plays silently on timers.
 */
import { resolvePath } from "../paths.ts";
import { asyncApi, safeCall, type AnyFunction, type Options } from "./common.ts";
import { isFsPath, type ApiContext } from "./context.ts";
import { actionSheet, consentOf, requireParam } from "./device.ts";

/** The size of generated photos: portrait, as a phone takes them. */
const PHOTO_WIDTH = 600;
const PHOTO_HEIGHT = 800;
/** The duration of chosen videos picked from the album, in seconds. */
const ALBUM_VIDEO_SECONDS = 10;
/** How often audio reports its progress, in milliseconds. */
const AUDIO_TICK_MS = 250;
const DEFAULT_AUDIO_SECONDS = 10;

export function createMediaApis(ctx: ApiContext): Record<string, unknown> {
  const { host } = ctx;
  const config = host.manifest.config;
  const consent = consentOf(ctx);

  /** A path the Mini Program passed, as the file system and the shell take it. */
  const resolveSrc = (src: string) => {
    if (isFsPath(src) || /^[a-z][\w+.-]*:/i.test(src)) return src;
    if (src.startsWith("/")) return resolvePath("", src);
    const pages = (
      globalThis as { getCurrentPages?: () => { route?: string }[] }
    ).getCurrentPages?.();
    return resolvePath(pages?.at(-1)?.route ?? "", src);
  };
  /** The bytes of an image or another file, and a path the Mini Program can use for it. */
  const load = async (src: string) => {
    const path = resolveSrc(src);
    if (!isFsPath(path) && /^(https?|data):/i.test(path)) {
      const response = await fetch(path).catch(() => undefined);
      if (!response?.ok) throw new Error("download image fail");
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { bytes, path: ctx.files.writeTemp(bytes, extensionOf(path) || "png") };
    }
    const bytes = ctx.files.read(path);
    if (!bytes) throw new Error("file not found");
    return { bytes, path };
  };

  /** Generated photos so far; each new one gets its own colors. */
  let generated = 0;
  const generatePhoto = async () => {
    const bytes = await encodePhoto(PHOTO_WIDTH, PHOTO_HEIGHT, generated++);
    return {
      path: ctx.files.writeTemp(bytes, "png"),
      size: bytes.length,
      width: PHOTO_WIDTH,
      height: PHOTO_HEIGHT,
    };
  };
  /** Images picked from the album: the configured project files, or one generated photo. */
  const albumImages = async (count: number) => {
    const configured = config.media?.images ?? [];
    if (configured.length === 0) return [await generatePhoto()];
    return configured.slice(0, count).map((file) => {
      const bytes = ctx.files.read(file);
      if (!bytes) throw new Error(`media.images in omr.config.json: ${file} is not found`);
      const { width, height } = decodeImageInfo(bytes) ?? { width: 0, height: 0 };
      return {
        path: ctx.files.writeTemp(bytes, extensionOf(file) || "png"),
        size: bytes.length,
        width,
        height,
      };
    });
  };
  const chooseImages = async (source: "album" | "camera", count: number) =>
    source === "camera" ? [await generatePhoto()] : albumImages(count);
  /** A video with a generated cover; the file holds no playable frames. */
  const chooseVideoFile = async (seconds: number) => {
    const thumb = await generatePhoto();
    const bytes = new TextEncoder().encode("omr simulated video\n");
    return {
      tempFilePath: ctx.files.writeTemp(bytes, "mp4"),
      size: bytes.length,
      duration: seconds,
      width: thumb.width,
      height: thumb.height,
      thumbTempFilePath: thumb.path,
    };
  };

  /** Where a choose API takes its files from: the camera, the album, or the sheet that asks. */
  const chooseSource = async (sourceType: unknown, cameraLabel: string) => {
    const types =
      Array.isArray(sourceType) && sourceType.length > 0 ? sourceType : ["album", "camera"];
    const album = types.includes("album");
    const camera = types.includes("camera");
    if (album && camera) {
      return (await actionSheet(ctx, [cameraLabel, "从手机相册选择"])) === 0 ? "camera" : "album";
    }
    // With one source WeChat opens it directly; leaving it cancels
    if (consent === "deny") throw new Error("cancel");
    return camera ? "camera" : "album";
  };
  const cameraSeconds = (maxDuration: unknown, fallback: number) =>
    Math.min(60, Math.max(3, Number(maxDuration ?? fallback) || fallback));

  const saveToAlbum = (name: string) =>
    asyncApi(name, async (options) => {
      requireParam(options, "filePath", "String");
      await ctx.requirePrivacy(name);
      if (!(await ctx.requestScope("scope.writePhotosAlbum"))) throw new Error("auth deny");
      if (ctx.files.size(resolveSrc(options.filePath)) === undefined) {
        throw new Error("file not found");
      }
      return {};
    });

  const audioSeconds = config.media?.audioDuration ?? DEFAULT_AUDIO_SECONDS;
  const audioSourceExists = (src: string) => {
    const path = resolveSrc(src);
    return /^(https?|data):/i.test(path) && !isFsPath(path)
      ? true
      : ctx.files.size(path) !== undefined;
  };

  let backgroundAudio: BackgroundAudio | undefined;

  ctx.pickImages = async (sourceType, count) => {
    const source = await chooseSource(sourceType, "拍照");
    return (await chooseImages(source, count)).map((image) => image.path);
  };

  return {
    chooseImage: asyncApi("chooseImage", async (options) => {
      await ctx.requirePrivacy("chooseImage");
      const source = await chooseSource(options.sourceType, "拍照");
      const images = await chooseImages(source, Math.min(9, Number(options.count ?? 9) || 9));
      return {
        tempFilePaths: images.map((image) => image.path),
        tempFiles: images.map(({ path, size }) => ({ path, size })),
      };
    }),
    chooseMedia: asyncApi("chooseMedia", async (options) => {
      await ctx.requirePrivacy("chooseMedia");
      const mediaType: unknown[] = Array.isArray(options.mediaType)
        ? options.mediaType
        : ["image", "video"];
      const source = await chooseSource(options.sourceType, "拍摄");
      if (!mediaType.includes("image") && !mediaType.includes("mix")) {
        const video = await chooseVideoFile(
          source === "camera" ? cameraSeconds(options.maxDuration, 10) : ALBUM_VIDEO_SECONDS,
        );
        return { tempFiles: [{ ...video, fileType: "video" }], type: "video" };
      }
      const images = await chooseImages(source, Math.min(20, Number(options.count ?? 9) || 9));
      return {
        tempFiles: images.map(({ path, size }) => ({
          tempFilePath: path,
          size,
          fileType: "image",
        })),
        type: "image",
      };
    }),
    chooseVideo: asyncApi("chooseVideo", async (options) => {
      await ctx.requirePrivacy("chooseVideo");
      const source = await chooseSource(options.sourceType, "拍摄");
      const { thumbTempFilePath: _, ...video } = await chooseVideoFile(
        source === "camera" ? cameraSeconds(options.maxDuration, 60) : ALBUM_VIDEO_SECONDS,
      );
      return video;
    }),
    chooseMessageFile: asyncApi("chooseMessageFile", async (options) => {
      requireParam(options, "count", "Number");
      await ctx.requirePrivacy("chooseMessageFile");
      if (consent === "deny") throw new Error("cancel");
      const type = String(options.type ?? "all");
      const time = Math.floor(Date.now() / 1000);
      if (type === "video") {
        const video = await chooseVideoFile(ALBUM_VIDEO_SECONDS);
        const name = video.tempFilePath.split("/").pop()!;
        return {
          tempFiles: [{ path: video.tempFilePath, size: video.size, name, type: "video", time }],
        };
      }
      if (type === "file") {
        const extension = Array.isArray(options.extension)
          ? String(options.extension[0] ?? "txt").replace(/^\./, "")
          : "txt";
        const bytes = new TextEncoder().encode("omr simulated file\n");
        const path = ctx.files.writeTemp(bytes, extension);
        return {
          tempFiles: [{ path, size: bytes.length, name: `文件.${extension}`, type: "file", time }],
        };
      }
      const images = await albumImages(Math.min(100, options.count));
      return {
        tempFiles: images.map(({ path, size }) => ({
          path,
          size,
          name: path.split("/").pop()!,
          type: "image",
          time,
        })),
      };
    }),

    previewImage: asyncApi("previewImage", async (options) => {
      requireParam(options, "urls", "Array");
      const urls = (options.urls as unknown[]).map((url) => resolveSrc(String(url)));
      const current = typeof options.current === "string" ? resolveSrc(options.current) : "";
      void host
        .ui("previewImage", {
          sources: urls.map((url) => ({ url, type: "image" })),
          current: Math.max(0, urls.indexOf(current)),
        })
        .catch(() => {});
      return {};
    }),
    previewMedia: asyncApi("previewMedia", async (options) => {
      requireParam(options, "sources", "Array");
      const sources = (options.sources as Record<string, unknown>[]).map((source) => ({
        url: typeof source?.url === "string" ? resolveSrc(source.url) : "",
        type: source?.type === "video" ? "video" : "image",
        poster: typeof source?.poster === "string" ? resolveSrc(source.poster) : "",
      }));
      void host
        .ui("previewImage", { sources, current: Math.max(0, Number(options.current ?? 0) || 0) })
        .catch(() => {});
      return {};
    }),
    getImageInfo: asyncApi("getImageInfo", async (options) => {
      requireParam(options, "src", "String");
      const { bytes, path } = await load(options.src);
      const info = decodeImageInfo(bytes) ?? (await decodeWithBitmap(bytes));
      if (!info) throw new Error("decode image fail");
      return { orientation: "up", ...info, path };
    }),
    compressImage: asyncApi("compressImage", async (options) => {
      requireParam(options, "src", "String");
      const { bytes, path } = await load(options.src);
      const compressed = await compressJpeg(bytes, options);
      return {
        tempFilePath: compressed
          ? ctx.files.writeTemp(compressed, "jpg")
          : ctx.files.writeTemp(bytes, extensionOf(path) || "png"),
      };
    }),
    saveImageToPhotosAlbum: saveToAlbum("saveImageToPhotosAlbum"),
    saveVideoToPhotosAlbum: saveToAlbum("saveVideoToPhotosAlbum"),

    createInnerAudioContext: () => new InnerAudio(audioSeconds, audioSourceExists).api(),
    getBackgroundAudioManager: () => {
      backgroundAudio ??= new BackgroundAudio(audioSeconds, audioSourceExists);
      return backgroundAudio.api();
    },
    setInnerAudioOption: asyncApi("setInnerAudioOption", async () => ({})),
    getAvailableAudioSources: asyncApi("getAvailableAudioSources", async () => ({
      audioSources:
        host.system.platform === "android"
          ? [
              "auto",
              "buildInMic",
              "headsetMic",
              "mic",
              "camcorder",
              "voice_communication",
              "voice_recognition",
            ]
          : ["auto", "buildInMic", "headsetMic"],
    })),
  };
}

const extensionOf = (path: string) =>
  /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(path)?.[1]?.toLowerCase() ?? "";

// Audio

const AUDIO_EVENTS = [
  "Canplay",
  "Play",
  "Pause",
  "Stop",
  "Ended",
  "TimeUpdate",
  "Error",
  "Waiting",
  "Seeking",
  "Seeked",
];

/**
 * Audio that plays without sound: it loads on a timer once `src` is set, moves
 * `currentTime` on while playing and fires WeChat's events in the order a
 * device does: `canplay`, `play`, `timeUpdate`… and `ended`.
 */
class InnerAudio {
  src = "";
  startTime = 0;
  autoplay = false;
  loop = false;
  volume = 1;
  playbackRate = 1;
  obeyMuteSwitch = true;
  referrerPolicy = "origin";
  protected paused = true;
  protected position = 0;
  protected loaded = false;
  protected readonly listeners = new Map<string, Set<AnyFunction>>();
  private loading?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;
  /** Whether `play()` waits for the source to load. */
  private playWhenLoaded = false;
  private readonly seconds: number;
  private readonly exists: (src: string) => boolean;

  constructor(seconds: number, exists: (src: string) => boolean) {
    this.seconds = seconds;
    this.exists = exists;
  }

  protected emit(event: string, result?: Record<string, unknown>) {
    for (const listener of this.listeners.get(event) ?? []) safeCall(listener, result);
  }

  /** `src` changed: the audio stops and loads the new source. */
  protected setSrc(src: string) {
    this.src = src;
    this.halt();
    clearTimeout(this.loading);
    this.loaded = false;
    this.position = this.startTime;
    if (!src) return;
    this.loading = setTimeout(() => {
      if (!this.exists(src)) {
        this.playWhenLoaded = false;
        this.emit("Error", { errMsg: "file not found", errCode: 10003 });
        return;
      }
      this.loaded = true;
      this.emit("Canplay");
      if (this.autoplay || this.playWhenLoaded) this.start();
    }, 0);
  }

  get duration() {
    return this.loaded ? this.seconds : 0;
  }
  get currentTime() {
    return Math.round(this.position * 1e6) / 1e6;
  }
  set currentTime(value: number) {
    this.seek(value);
  }
  get buffered() {
    return this.duration;
  }

  play() {
    if (!this.paused) return;
    if (!this.src) {
      setTimeout(() => this.emit("Error", { errMsg: "src is empty", errCode: 10003 }), 0);
      return;
    }
    if (this.loaded) setTimeout(() => this.start(), 0);
    else this.playWhenLoaded = true;
  }
  pause() {
    if (this.paused) return;
    this.halt();
    this.emit("Pause");
  }
  stop() {
    const wasStopped = this.paused && this.position === 0;
    this.halt();
    this.playWhenLoaded = false;
    this.position = 0;
    if (!wasStopped) this.emit("Stop");
  }
  seek(position: number) {
    this.emit("Seeking");
    this.position = Math.min(this.duration, Math.max(0, Number(position) || 0));
    setTimeout(() => this.emit("Seeked"), 0);
  }
  destroy() {
    this.halt();
    clearTimeout(this.loading);
    this.listeners.clear();
  }

  private start() {
    if (!this.paused || !this.loaded) return;
    this.playWhenLoaded = false;
    // Playing again after the end starts over
    if (this.position >= this.seconds) this.position = 0;
    this.paused = false;
    this.emit("Play");
    this.ticker = setInterval(() => this.tick(), AUDIO_TICK_MS);
  }
  private tick() {
    this.position += (AUDIO_TICK_MS / 1000) * this.playbackRate;
    if (this.position < this.seconds) {
      this.emit("TimeUpdate");
      return;
    }
    if (this.loop) {
      this.position = 0;
      this.emit("TimeUpdate");
      return;
    }
    this.position = this.seconds;
    this.emit("TimeUpdate");
    this.halt();
    this.emit("Ended");
  }
  private halt() {
    clearInterval(this.ticker);
    this.ticker = undefined;
    this.paused = true;
  }

  /** The object the Mini Program gets: properties and methods, with `on*` and `off*` for each event. */
  api(): Record<string, unknown> {
    const target: Record<string, unknown> = {
      play: () => this.play(),
      pause: () => this.pause(),
      stop: () => this.stop(),
      seek: (position: number) => this.seek(position),
      destroy: () => this.destroy(),
    };
    for (const name of this.eventNames()) {
      target[`on${name}`] = (listener: AnyFunction) => {
        if (typeof listener !== "function") return;
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name)!.add(listener);
      };
      target[`off${name}`] = (listener?: AnyFunction) => {
        if (listener) this.listeners.get(name)?.delete(listener);
        else this.listeners.delete(name);
      };
    }
    Object.defineProperties(target, {
      duration: { enumerable: true, get: () => this.duration },
      buffered: { enumerable: true, get: () => this.buffered },
      paused: { enumerable: true, get: () => this.paused },
      currentTime: {
        enumerable: true,
        get: () => this.currentTime,
        set: (value: number) => {
          this.seek(value);
        },
      },
      src: {
        enumerable: true,
        get: () => this.src,
        set: (value: unknown) => {
          this.setSrc(typeof value === "string" ? value : "");
        },
      },
    });
    const fields = this as unknown as Record<string, unknown>;
    for (const name of this.plainProperties()) {
      Object.defineProperty(target, name, {
        enumerable: true,
        get: () => fields[name],
        set: (value: unknown) => {
          fields[name] = value;
        },
      });
    }
    return target;
  }
  protected eventNames() {
    return AUDIO_EVENTS;
  }
  protected plainProperties() {
    return [
      "startTime",
      "autoplay",
      "loop",
      "volume",
      "playbackRate",
      "obeyMuteSwitch",
      "referrerPolicy",
    ];
  }
}

/** `wx.getBackgroundAudioManager()`: one player for the app, which plays as soon as `src` is set. */
class BackgroundAudio extends InnerAudio {
  title = "";
  epname = "";
  singer = "";
  coverImgUrl = "";
  webUrl = "";
  protocol = "http";
  override autoplay = true;
  private cached?: Record<string, unknown>;

  protected override eventNames() {
    return [...AUDIO_EVENTS, "Prev", "Next"];
  }
  protected override plainProperties() {
    return [
      "startTime",
      "playbackRate",
      "referrerPolicy",
      "title",
      "epname",
      "singer",
      "coverImgUrl",
      "webUrl",
      "protocol",
    ];
  }
  override api() {
    this.cached ??= super.api();
    return this.cached;
  }
}

// Images

/** Width, height, format and orientation from an image's header, for PNG, JPEG and GIF. */
function decodeImageInfo(
  bytes: Uint8Array,
): { width: number; height: number; type: string; orientation?: string } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return { width: view.getUint32(16), height: view.getUint32(20), type: "png" };
    }
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
      return { width: view.getUint16(6, true), height: view.getUint16(8, true), type: "gif" };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return decodeJpegInfo(bytes, view);
  } catch {
    // A truncated header
  }
  return undefined;
}

const EXIF_ORIENTATIONS = [
  "up",
  "up-mirrored",
  "down",
  "down-mirrored",
  "left-mirrored",
  "right",
  "right-mirrored",
  "left",
];

function decodeJpegInfo(bytes: Uint8Array, view: DataView) {
  let orientation = "up";
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    const length = view.getUint16(offset + 2);
    // Start of frame markers, except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        width: view.getUint16(offset + 7),
        height: view.getUint16(offset + 5),
        type: "jpeg",
        orientation,
      };
    }
    // APP1 with "Exif\0\0", then a TIFF header
    if (marker === 0xe1 && view.getUint32(offset + 4) === 0x45786966) {
      const tiff = offset + 10;
      const little = view.getUint16(tiff) === 0x4949;
      const ifd = tiff + view.getUint32(tiff + 4, little);
      const entries = view.getUint16(ifd, little);
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12;
        if (view.getUint16(entry, little) === 0x0112) {
          orientation = EXIF_ORIENTATIONS[view.getUint16(entry + 8, little) - 1] ?? "up";
        }
      }
    }
    offset += 2 + length;
  }
  return undefined;
}

/** Decodes other formats, such as WebP, where the platform can (the simulator's Worker). */
async function decodeWithBitmap(bytes: Uint8Array) {
  if (typeof createImageBitmap !== "function") return undefined;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]));
    const info = { width: bitmap.width, height: bitmap.height, type: "unknown" };
    bitmap.close();
    return info;
  } catch {
    return undefined;
  }
}

/** Re-encodes an image as JPEG where the platform can, scaled to `compressedWidth`/`compressedHeight`. */
async function compressJpeg(bytes: Uint8Array, options: Options) {
  if (typeof OffscreenCanvas !== "function" || typeof createImageBitmap !== "function") {
    return undefined;
  }
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]));
    const ratio = bitmap.width / bitmap.height;
    const width = Number(options.compressedWidth) || 0;
    const height = Number(options.compressedHeight) || 0;
    const outWidth = Math.round(width || (height ? height * ratio : bitmap.width));
    const outHeight = Math.round(height || (width ? width / ratio : bitmap.height));
    const canvas = new OffscreenCanvas(outWidth, outHeight);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, outWidth, outHeight);
    bitmap.close();
    const quality = Math.min(100, Math.max(0, Number(options.quality ?? 80))) / 100;
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return undefined;
  }
}

// Generated photos: a PNG encoded here, so it is the same in every environment

/** 5×7 pixel glyphs for the text on generated photos. */
const GLYPHS: Record<string, string> = {
  o: "...........###.#...##...##...#.###.",
  m: "..........##.#.#.#.##.#.##...##...#",
  r: "..........#.##.##..##....#....#....",
  x: "..........#...#.#.#...#...#.#.#...#",
  "0": ".###.#...##..###.#.###..##...#.###.",
  "1": "..#...##....#....#....#....#...###.",
  "2": ".###.#...#....#...#...#...#...#####",
  "3": "#####...#...#.....#.....##...#.###.",
  "4": "...#...##..#.#.#..#.#####...#....#.",
  "5": "######....####.....#....##...#.###.",
  "6": "..##..#...#....####.#...##...#.###.",
  "7": "#####....#...#...#...#....#....#...",
  "8": ".###.#...##...#.###.#...##...#.###.",
  "9": ".###.#...##...#.####....#...#..##..",
};

/** A generated photo as PNG bytes; `index` picks its colors. */
export async function encodePhoto(width: number, height: number, index: number) {
  const stride = width * 3 + 1;
  const pixels = new Uint8Array(stride * height);
  // A diagonal gradient whose hue changes with each photo
  const hue = (200 + index * 47) % 360;
  const top = hslToRgb(hue, 0.6, 0.65);
  const bottom = hslToRgb((hue + 40) % 360, 0.65, 0.4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (y / height) * 0.8 + (x / width) * 0.2;
      const offset = y * stride + 1 + x * 3;
      for (let c = 0; c < 3; c++) {
        pixels[offset + c] = Math.round(top[c]! + (bottom[c]! - top[c]!) * t);
      }
    }
  }
  const drawText = (text: string, scale: number, centerY: number) => {
    const advance = 6 * scale;
    let left = Math.round((width - (text.length * advance - scale)) / 2);
    const topY = Math.round(centerY - (7 * scale) / 2);
    for (const char of text) {
      const glyph = GLYPHS[char] ?? "";
      for (let i = 0; i < glyph.length; i++) {
        if (glyph[i] !== "#") continue;
        const gx = left + (i % 5) * scale;
        const gy = topY + Math.floor(i / 5) * scale;
        for (let y = gy; y < gy + scale; y++) {
          pixels.fill(255, y * stride + 1 + gx * 3, y * stride + 1 + (gx + scale) * 3);
        }
      }
      left += advance;
    }
  };
  drawText("omr", Math.floor(width / 25), height * 0.45);
  drawText(`${width}x${height}`, Math.floor(width / 100), height * 0.62);

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const compressed = new Uint8Array(
    await new Response(
      new Blob([pixels]).stream().pipeThrough(new CompressionStream("deflate")),
    ).arrayBuffer(),
  );
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function hslToRgb(hue: number, saturation: number, lightness: number) {
  const k = (n: number) => (n + hue / 30) % 12;
  const a = saturation * Math.min(lightness, 1 - lightness);
  return [0, 8, 4].map((n) =>
    Math.round(255 * (lightness - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))),
  );
}

function pngChunk(type: string, data: Uint8Array) {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

let crcTable: Uint32Array | undefined;
function crc32(data: Uint8Array) {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
