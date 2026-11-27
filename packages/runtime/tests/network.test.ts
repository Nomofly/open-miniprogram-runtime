import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { MemoryFs, startLogic } from "../src/index.ts";
import type { LogicToShell } from "../src/index.ts";

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
function boot(onLoad: string, appJson: Record<string, unknown> = {}, fs = new MemoryFs()) {
  const sent: LogicToShell[] = [];
  const handle = startLogic((message) => sent.push(message), { fs });
  const files = {
    "app.js": "App({ log: [] });",
    "pages/index/index.js": `const log = (entry) => getApp().log.push(entry);
      Page({ async onLoad() {\n${onLoad}\n} });`,
  };
  const json = { pages: ["pages/index/index"], ...appJson };
  handle({
    type: "boot",
    manifest: {
      appid: "wx0123456789abcdef",
      appName: "Demo",
      appJson: json,
      pages: json.pages,
      entryPage: json.pages[0]!,
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

/** Waits until the page has logged `count` entries. */
async function until(log: () => unknown[], count: number) {
  for (let i = 0; i < 200 && log().length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return log();
}

/** Stubs fetch with a handler of the JSON requests the logic layer sends to the simulator's proxy. */
function stubProxy(handler: (request: any, signal?: AbortSignal) => Response | Promise<Response>) {
  const requests: any[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    expect(url).toBe("/__omr/request");
    const request = JSON.parse(init.body as string);
    requests.push(request);
    return handler(request, init.signal ?? undefined);
  });
  return requests;
}

const json = (value: unknown) => Response.json(value);
const base64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("network", () => {
  test("wx.request fails with timeout after options.timeout or app.json networkTimeout.request", async () => {
    const signals: AbortSignal[] = [];
    stubProxy(
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signals.push(signal!);
          // As fetch does, including for a signal aborted before the call
          if (signal!.aborted) reject(new Error("aborted"));
          signal!.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const started = Date.now();
    const log = boot(
      `
      wx.request({ url: "https://example.com/a", timeout: 20, fail: (res) => log(res.errMsg) });
      wx.request({ url: "https://example.com/b", fail: (res) => log(res.errMsg) });
      const task = wx.request({ url: "https://example.com/c", timeout: 5000, fail: (res) => log(res.errMsg) });
      task.abort();
    `,
      { networkTimeout: { request: 60 } },
    );
    expect(await until(log, 3)).toEqual([
      "request:fail abort",
      "request:fail timeout",
      "request:fail timeout",
    ]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  test("wx.request sends and receives binary data with responseType arraybuffer", async () => {
    const requests = stubProxy(() =>
      json({
        statusCode: 201,
        header: { "content-type": "application/octet-stream" },
        cookies: ["session=abc; Path=/"],
        body: base64([1, 2, 255]),
        bodyEncoding: "base64",
      }),
    );
    const log = boot(`
      wx.request({
        url: "https://example.com/bin",
        method: "POST",
        data: new Uint8Array([9, 8]).buffer,
        responseType: "arraybuffer",
        success: (res) => log([res.data instanceof ArrayBuffer, Array.from(new Uint8Array(res.data)), res.statusCode, res.cookies, res.errMsg]),
      });
    `);
    expect(await until(log, 1)).toEqual([
      [true, [1, 2, 255], 201, ["session=abc; Path=/"], "request:ok"],
    ]);
    expect(requests[0]).toMatchObject({
      url: "https://example.com/bin",
      method: "POST",
      body: base64([9, 8]),
      bodyEncoding: "base64",
      responseType: "arraybuffer",
    });
  });

  test("wx.request with enableChunked passes each chunk to onChunkReceived", async () => {
    stubProxy(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"a":'));
              controller.enqueue(new TextEncoder().encode("1}"));
              controller.close();
            },
          }),
          {
            headers: {
              "x-omr-proxy": encodeURIComponent(JSON.stringify({ statusCode: 200, header: {} })),
            },
          },
        ),
    );
    const log = boot(`
      const task = wx.request({ url: "https://example.com/s", enableChunked: true, success: (res) => log(res.data) });
      task.onHeadersReceived((res) => log(res.statusCode));
      task.onChunkReceived((res) => log(new TextDecoder().decode(res.data)));
    `);
    expect(await until(log, 4)).toEqual([200, '{"a":', "1}", { a: 1 }]);
  });

  test("wx.downloadFile writes a temporary file whose bytes match the response", async () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a];
    const requests = stubProxy(
      () =>
        new Response(new Uint8Array(png), {
          headers: {
            "x-omr-proxy": encodeURIComponent(
              JSON.stringify({
                statusCode: 200,
                header: { "content-type": "image/png", "content-length": String(png.length) },
              }),
            ),
          },
        }),
    );
    const log = boot(`
      const fs = wx.getFileSystemManager();
      const task = wx.downloadFile({
        url: "https://example.com/logo",
        success: (res) => {
          log([/^http:\\/\\/tmp\\/.+\\.png$/.test(res.tempFilePath), res.statusCode]);
          log(Array.from(new Uint8Array(fs.readFileSync(res.tempFilePath))));
          wx.downloadFile({
            url: "https://example.com/logo",
            filePath: wx.env.USER_DATA_PATH + "/logo.png",
            success: (saved) => log([saved.filePath, saved.tempFilePath, fs.statSync(saved.filePath).size]),
          });
        },
      });
      task.onProgressUpdate((res) => log(res.progress));
    `);
    expect(await until(log, 4)).toEqual([
      100,
      [true, 200],
      png,
      ["wxfile://usr/logo.png", undefined, png.length],
    ]);
    expect(requests[0]).toMatchObject({
      url: "https://example.com/logo",
      method: "GET",
      stream: true,
    });
  });

  test("a download aborted by its last progress listener fails with abort and writes nothing", async () => {
    // Without content-length, the last progress event comes after the body is read
    stubProxy(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: {
            "x-omr-proxy": encodeURIComponent(JSON.stringify({ statusCode: 200, header: {} })),
          },
        }),
    );
    const fs = new MemoryFs();
    const log = boot(
      `
      const task = wx.downloadFile({
        url: "https://example.com/a.bin",
        filePath: wx.env.USER_DATA_PATH + "/a.bin",
        success: () => log("success"),
        fail: (res) => log(res.errMsg),
      });
      task.onProgressUpdate((res) => { if (res.progress === 100) task.abort(); });
    `,
      {},
      fs,
    );
    expect(await until(log, 1)).toEqual(["downloadFile:fail abort"]);
    expect(() => fs.call("stat", { path: "wxfile://usr/a.bin" })).toThrow();
  });

  test("wx.uploadFile posts the file and formData as multipart/form-data", async () => {
    const requests = stubProxy(() => json({ statusCode: 200, header: {}, body: '{"ok":true}' }));
    const fs = new MemoryFs();
    fs.call("writeFile", { path: "wxfile://usr/photo.png" }, new Uint8Array([1, 2, 3, 13, 10]));
    const log = boot(
      `
      wx.uploadFile({
        url: "https://example.com/upload",
        filePath: wx.env.USER_DATA_PATH + "/photo.png",
        name: "file",
        header: { "x-token": "t" },
        formData: { user: "test" },
        success: (res) => log([res.data, res.statusCode, res.errMsg]),
      });
    `,
      {},
      fs,
    );
    expect(await until(log, 1)).toEqual([['{"ok":true}', 200, "uploadFile:ok"]]);
    const request = requests[0];
    expect(request).toMatchObject({ method: "POST", url: "https://example.com/upload" });
    expect(request.header["x-token"]).toBe("t");
    // Parse the body as a server would
    const form = await new Response(
      Uint8Array.from(atob(request.body), (c) => c.charCodeAt(0)),
      {
        headers: { "content-type": request.header["content-type"] },
      },
    ).formData();
    expect(form.get("user")).toBe("test");
    const file = form.get("file") as File;
    expect(file.name).toBe("photo.png");
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([1, 2, 3, 13, 10]);
  });

  test("wx.connectSocket returns a SocketTask and feeds the legacy global listeners", async () => {
    const sockets: FakeSocket[] = [];
    class FakeSocket extends EventTarget {
      readyState = 0;
      binaryType = "blob";
      sent: unknown[] = [];
      url: string;
      constructor(url: string) {
        super();
        this.url = url;
        sockets.push(this);
        setTimeout(() => {
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
          this.dispatchEvent(new MessageEvent("message", { data: "hi" }));
        }, 0);
      }
      send(data: unknown) {
        this.sent.push(data);
      }
      close(code: number, reason?: string) {
        this.readyState = 3;
        this.dispatchEvent(Object.assign(new Event("close"), { code, reason: reason ?? "" }));
      }
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    const log = boot(`
      wx.onSocketMessage((res) => log("global " + res.data));
      const task = wx.connectSocket({ url: "ws://localhost:1234/ws", success: (res) => log(res.errMsg) });
      task.onOpen(() => log("open"));
      task.onMessage((res) => {
        log(res.data);
        task.send({ data: "pong", success: (r) => log(r.errMsg) });
        task.close({ code: 1000, reason: "bye" });
      });
      task.onClose((res) => log([res.code, res.reason]));
    `);
    expect(await until(log, 6)).toEqual([
      "connectSocket:ok",
      "open",
      "hi",
      "global hi",
      [1000, "bye"],
      "sendSocketMessage:ok",
    ]);
    expect(sockets[0]!.url).toBe("ws://localhost:1234/ws");
    expect(sockets[0]!.sent).toEqual(["pong"]);
  });

  test("wx.closeSocket closes the socket that was latest when it was called, even if another connects right after", async () => {
    const sockets: { url: string; closed: boolean }[] = [];
    vi.stubGlobal(
      "WebSocket",
      class extends EventTarget {
        readyState = 0;
        binaryType = "blob";
        record: { url: string; closed: boolean };
        constructor(url: string) {
          super();
          this.record = { url, closed: false };
          sockets.push(this.record);
          setTimeout(() => {
            this.readyState = 1;
            this.dispatchEvent(new Event("open"));
          }, 0);
        }
        send() {}
        close(code: number) {
          this.record.closed = true;
          this.readyState = 3;
          this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "" }));
        }
      },
    );
    const log = boot(`
      wx.connectSocket({ url: "ws://localhost/a" });
      wx.onSocketOpen(() => {
        // B opens too; only the first open acts
        if (getApp().log.length) return;
        log("open");
        wx.closeSocket({ complete: (res) => log(res.errMsg) });
        wx.connectSocket({ url: "ws://localhost/b" });
      });
    `);
    expect(await until(log, 2)).toEqual(["open", "closeSocket:ok"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sockets).toEqual([
      { url: "ws://localhost/a", closed: true },
      { url: "ws://localhost/b", closed: false },
    ]);
  });
});
