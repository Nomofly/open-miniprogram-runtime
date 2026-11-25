import { crc32, inflateSync } from "node:zlib";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { encodePng } from "../src/api/canvas.ts";
import { MemoryFs, startLogic } from "../src/index.ts";

const SYSTEM = {
  windowWidth: 375,
  windowHeight: 603,
  statusBarHeight: 20,
  screenWidth: 375,
  screenHeight: 667,
  pixelRatio: 2,
};
const MENU_BUTTON = { width: 87, height: 32, top: 24, right: 368, bottom: 56, left: 281 };

/** Boots a logic layer whose only page runs `onLoad` and opens it. */
function boot(onLoad: string) {
  const handle = startLogic(() => {}, { fs: new MemoryFs() });
  const files = {
    "app.js": "App({ log: [] });",
    "pages/index/index.js": `const log = (entry) => getApp().log.push(entry);
      Page({ async onLoad() {\n${onLoad}\n} });`,
  };
  const pages = ["pages/index/index"];
  handle({
    type: "boot",
    manifest: {
      appid: "wx0123456789abcdef",
      appName: "Demo",
      appJson: { pages },
      pages,
      entryPage: pages[0]!,
      windows: {},
      config: {},
    },
    system: SYSTEM,
    menuButton: MENU_BUTTON,
    chrome: { navigationBar: 64, tabBar: 50 },
    appService: Object.entries(files)
      .map(
        ([file, source]) =>
          `__omrDefine(${JSON.stringify(file)}, function (require, module, exports) {\n${source}\n});`,
      )
      .join("\n"),
  });
  handle({ type: "view", webviewId: 1, message: { type: "ready" } });
  return () => (globalThis as unknown as { getApp(): { log: unknown[] } }).getApp().log;
}

async function until(log: () => unknown[], count: number) {
  for (let i = 0; i < 200 && log().length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return log();
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The chunks of a PNG, checking each CRC. */
function chunksOf(png: Uint8Array) {
  expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: { type: string; data: Uint8Array }[] = [];
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at);
    const typed = png.subarray(at + 4, at + 8 + length);
    expect(view.getUint32(at + 8 + length)).toBe(crc32(typed));
    chunks.push({ type: String.fromCharCode(...typed.subarray(0, 4)), data: typed.subarray(4) });
    at += 12 + length;
  }
  return chunks;
}

/** Decodes a PNG of the encoder's form (RGBA, 8 bits, no filters) to its size and pixels. */
function decodePng(png: Uint8Array) {
  const chunks = chunksOf(png);
  expect(chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  const header = new DataView(chunks[0]!.data.buffer, chunks[0]!.data.byteOffset, 13);
  const width = header.getUint32(0);
  const height = header.getUint32(4);
  expect([...chunks[0]!.data.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
  // inflateSync checks the zlib header and Adler-32 too
  const raw = inflateSync(chunks[1]!.data);
  const stride = width * 4 + 1;
  expect(raw.length).toBe(stride * height);
  const pixels: number[] = [];
  for (let y = 0; y < height; y++) {
    expect(raw[y * stride]).toBe(0);
    pixels.push(...raw.subarray(y * stride + 1, (y + 1) * stride));
  }
  return { width, height, pixels };
}

/** An OffscreenCanvas whose 2D context answers `getImageData` with `pixels`. */
function stubOffscreenCanvas(pixels: (width: number, height: number) => Uint8ClampedArray) {
  class FakeOffscreenCanvas {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
    getContext(type: string) {
      if (type !== "2d") return null;
      return {
        getImageData: (_x: number, _y: number, width: number, height: number) => ({
          width,
          height,
          data: pixels(width, height),
        }),
      };
    }
  }
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PNG encoder", () => {
  test("round-trips pixels with valid CRCs and Adler-32", () => {
    const pixels = Uint8Array.from({ length: 3 * 2 * 4 }, (_, i) => (i * 37) % 256);
    const decoded = decodePng(encodePng(3, 2, pixels));
    expect(decoded).toEqual({ width: 3, height: 2, pixels: [...pixels] });
  });

  test("splits image data larger than one stored block", () => {
    // 200 x 100 RGBA rows are 80,100 bytes, more than a stored block holds
    const pixels = Uint8Array.from({ length: 200 * 100 * 4 }, (_, i) => (i * 7 + (i >> 9)) % 256);
    const decoded = decodePng(encodePng(200, 100, pixels));
    expect(decoded.pixels).toEqual([...pixels]);
  });
});

describe("Canvas", () => {
  test("toDataURL returns a PNG of the canvas synchronously", async () => {
    stubOffscreenCanvas((width, height) =>
      Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => [255, 0, 0, 128][i % 4]!),
    );
    const log = boot(`
      const canvas = wx.createOffscreenCanvas({ type: "2d", width: 2, height: 2 });
      canvas.getContext("2d");
      log(canvas.toDataURL());
    `);
    const [url] = (await until(log, 1)) as string[];
    expect(url).toMatch(/^data:image\/png;base64,/);
    const png = Uint8Array.from(atob(url!.split(",")[1]!), (char) => char.charCodeAt(0));
    expect(decodePng(png)).toEqual({
      width: 2,
      height: 2,
      pixels: Array.from({ length: 4 }, () => [255, 0, 0, 128]).flat(),
    });
  });

  test("createImage loads network images through the request proxy and reports failures", async () => {
    stubOffscreenCanvas((width, height) => new Uint8ClampedArray(width * height * 4));
    const PNG = Uint8Array.from([...PNG_SIGNATURE, 0, 0, 0, 0]);
    const requested: { path: string; request: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
      const request = JSON.parse(init.body as string) as Record<string, unknown>;
      requested.push({ path, request });
      const target = String(request.url);
      const statusCode = target.endsWith("missing.png") ? 404 : 200;
      const head = { statusCode, header: { "content-type": "image/png" } };
      const body = target.endsWith("page.html") ? new TextEncoder().encode("<html>") : PNG;
      return new Response(body, {
        headers: { "x-omr-proxy": encodeURIComponent(JSON.stringify(head)) },
      });
    });
    // Decodes only bytes that start like a PNG, as a browser does with images
    vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes[1] !== 0x50) throw new Error("The source image could not be decoded.");
      return { width: 1, height: 1 };
    });
    const log = boot(`
      const canvas = wx.createOffscreenCanvas({ type: "2d", width: 2, height: 2 });
      for (const name of ["a.png", "missing.png", "page.html"]) {
        const image = canvas.createImage();
        image.onload = () => log(name + " load " + image.width);
        image.onerror = () => log(name + " error");
        image.src = "https://example.com/" + name;
      }
    `);
    expect(((await until(log, 3)) as string[]).sort()).toEqual([
      "a.png load 1",
      "missing.png error",
      "page.html error",
    ]);
    expect(requested.map(({ path }) => path)).toEqual(Array(3).fill("/__omr/request"));
    expect(requested[0]!.request).toEqual({
      url: "https://example.com/a.png",
      method: "GET",
      header: {},
      stream: true,
    });
  });
});
