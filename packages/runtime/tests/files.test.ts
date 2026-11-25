import { describe, expect, test } from "vite-plus/test";
import { MemoryFs, remoteFs, serveFsRequest, startLogic } from "../src/index.ts";
import type { FsHost, LogicToShell, PackageFiles } from "../src/index.ts";

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
function boot(onLoad: string, fs?: FsHost) {
  const sent: LogicToShell[] = [];
  const handle = startLogic((message) => sent.push(message), { fs });
  const files = {
    "app.js": "App({ log: [] });",
    "pages/index/index.js": `const log = (entry) => getApp().log.push(entry);
      Page({ async onLoad() {\n${onLoad}\n} });`,
  };
  const appJson = { pages: ["pages/index/index"] };
  handle({
    type: "boot",
    manifest: {
      appid: "wx0123456789abcdef",
      appName: "Demo",
      appJson,
      pages: appJson.pages,
      entryPage: appJson.pages[0]!,
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Waits until the page has logged `count` entries. */
async function until(log: () => unknown[], count: number) {
  for (let i = 0; i < 200 && log().length < count; i++) await settle();
  return log();
}

describe("file system", () => {
  test("writeFileSync and readFileSync round trip in each encoding", async () => {
    const log = boot(`
      const fs = wx.getFileSystemManager();
      const p = wx.env.USER_DATA_PATH + "/a.txt";
      fs.writeFileSync(p, "héllo", "utf8");
      log(fs.readFileSync(p, "hex"));
      log(fs.readFileSync(p, "utf-8"));
      fs.writeFileSync(p, "aGVsbG8=", "base64");
      log(fs.readFileSync(p, "utf8"));
      fs.writeFileSync(p, "ff00", "hex");
      log(Array.from(new Uint8Array(fs.readFileSync(p))));
      fs.writeFileSync(p, "hi", "ucs2");
      log(fs.readFileSync(p, "hex"));
      log(fs.readFileSync(p, "utf16le"));
      fs.writeFileSync(p, new Uint8Array([1, 2, 3]).buffer);
      log(fs.readFileSync(p, "base64"));
      fs.writeFileSync(p, "\\u00e9", "latin1");
      fs.appendFileSync(p, "A", "binary");
      log(fs.readFileSync(p, "hex"));
      log(fs.readFileSync(p, "ascii", 1, 1));
      log(fs.statSync(p).size);
      fs.readFile({ filePath: p, encoding: "base64", success: (res) => log(res) });
    `);
    await settle();
    expect(log()).toEqual([
      "68c3a96c6c6f",
      "héllo",
      "hello",
      [255, 0],
      "68006900",
      "hi",
      "AQID",
      "e941",
      "A",
      2,
      { data: "6UE=", errMsg: "readFile:ok" },
    ]);
  });

  test("a missing file fails with errno 1300002 and the path", async () => {
    const log = boot(`
      const fs = wx.getFileSystemManager();
      const p = wx.env.USER_DATA_PATH + "/missing.txt";
      try { fs.readFileSync(p, "utf8"); } catch (e) { log([e instanceof Error, e.message, e.errno]); }
      fs.readFile({ filePath: p, fail: (res) => log(res) });
      fs.access({ path: p, fail: (res) => log(res.errMsg) });
      try { fs.writeFileSync("/images/a.png", "x"); } catch (e) { log(e.message); }
    `);
    await settle();
    expect(log()).toEqual([
      [true, "readFileSync:fail no such file or directory wxfile://usr/missing.txt", 1300002],
      // Sync calls throw at once; async callbacks follow
      "writeFileSync:fail permission denied",
      {
        errMsg: "readFile:fail no such file or directory wxfile://usr/missing.txt",
        errno: 1300002,
      },
      "access:fail no such file or directory wxfile://usr/missing.txt",
    ]);
  });

  test("mkdir, readdir, stat and rmdir work recursively", async () => {
    const log = boot(`
      const fs = wx.getFileSystemManager();
      const root = wx.env.USER_DATA_PATH;
      try { fs.mkdirSync(root + "/x/y"); } catch (e) { log(e.message); }
      fs.mkdirSync(root + "/a/b/c", true);
      fs.writeFileSync(root + "/a/b/f.txt", "1234");
      log(fs.readdirSync(root + "/a/b").sort());
      log(fs.statSync(root + "/a/b").isDirectory());
      log(fs.statSync(root + "/a/b/f.txt").isFile());
      log(fs.statSync(root + "/a", true).map((entry) => [entry.path, entry.stats.isDirectory(), entry.stats.size]).sort());
      try { fs.rmdirSync(root + "/a"); } catch (e) { log([e.message, e.errno]); }
      fs.rmdirSync(root + "/a", true);
      try { fs.accessSync(root + "/a/b/f.txt"); } catch (e) { log(e.errno); }
      log(fs.readdirSync(root));
    `);
    await settle();
    expect(log()).toEqual([
      "mkdirSync:fail no such file or directory wxfile://usr/x/y",
      ["c", "f.txt"],
      true,
      true,
      [
        ["/", true, 0],
        ["/b", true, 0],
        ["/b/c", true, 0],
        ["/b/f.txt", false, 4],
      ],
      ["rmdirSync:fail directory not empty", 1300066],
      1300002,
      [],
    ]);
  });

  test("saveFile moves a temporary file into saved files", async () => {
    const fs = new MemoryFs();
    const temp = fs.call("writeTemp", { extension: "txt" }, new TextEncoder().encode("hello"))
      .value as string;
    expect(temp).toMatch(/^http:\/\/tmp\/.+\.txt$/);
    const log = boot(
      `
      const fs = wx.getFileSystemManager();
      const { savedFilePath } = await wx.saveFile({ tempFilePath: ${JSON.stringify(temp)} });
      log(savedFilePath.startsWith("wxfile://store_"));
      log(fs.readFileSync(savedFilePath, "utf8"));
      try { fs.accessSync(${JSON.stringify(temp)}); } catch (e) { log(e.errno); }
      const { fileList } = await wx.getSavedFileList();
      log(fileList.map((file) => [file.filePath === savedFilePath, file.size]));
      log((await wx.getSavedFileInfo({ filePath: savedFilePath })).size);
      log((await wx.getFileInfo({ filePath: savedFilePath })).digest);
      log((await wx.getFileInfo({ filePath: savedFilePath, digestAlgorithm: "sha1" })).digest);
      await wx.removeSavedFile({ filePath: savedFilePath });
      log((await wx.getSavedFileList()).fileList.length);
      wx.saveFile({ tempFilePath: ${JSON.stringify(temp)}, fail: (res) => log(res.errMsg) });
    `,
      fs,
    );
    expect(await until(log, 9)).toEqual([
      true,
      "hello",
      1300002,
      [[true, 5]],
      5,
      "5d41402abc4b2a76b9719d911017c592",
      "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d",
      0,
      "saveFile:fail tempFilePath file not exist",
    ]);
  });

  test("fd operations read and write at the file pointer", async () => {
    const log = boot(`
      const fs = wx.getFileSystemManager();
      const p = wx.env.USER_DATA_PATH + "/fd.txt";
      const fd = fs.openSync({ filePath: p, flag: "w+" });
      log(fs.writeSync({ fd, data: "hello world" }).bytesWritten);
      const buffer = new ArrayBuffer(5);
      log(fs.readSync({ fd, arrayBuffer: buffer, length: 5, position: 6 }).bytesRead);
      log(new TextDecoder().decode(buffer));
      fs.ftruncateSync({ fd, length: 5 });
      log(fs.fstatSync({ fd }).size);
      fs.closeSync({ fd });
      try { fs.fstatSync({ fd }); } catch (e) { log(e.message); }
      try { fs.openSync({ filePath: p, flag: "wx" }); } catch (e) { log(e.message); }
      log(fs.readFileSync(p, "utf8"));
    `);
    await settle();
    expect(log()).toEqual([
      11,
      5,
      "world",
      5,
      "fstatSync:fail bad file descriptor",
      "openSync:fail file already exists wxfile://usr/fd.txt",
      "hello",
    ]);
  });

  test("remoteFs carries calls, binary data and errors over the server's wire format", async () => {
    const server = new MemoryFs();
    const log = boot(
      `
      const fs = wx.getFileSystemManager();
      const p = wx.env.USER_DATA_PATH + "/bin";
      fs.writeFileSync(p, new Uint8Array([0, 255, 10]).buffer);
      log(Array.from(new Uint8Array(fs.readFileSync(p))));
      try { fs.unlinkSync(p + "x"); } catch (e) { log([e.message, e.errno]); }
    `,
      remoteFs((body) => serveFsRequest(server, body)),
    );
    await settle();
    expect(log()).toEqual([
      [0, 255, 10],
      ["unlinkSync:fail no such file or directory wxfile://usr/binx", 1300002],
    ]);
    expect(Array.from(server.call("readFile", { path: "wxfile://usr/bin" }).data!)).toEqual([
      0, 255, 10,
    ]);
  });

  test("code package files are read only through the fallback", async () => {
    const files: Record<string, string> = { "data/a.json": '{"a":1}' };
    const packageFiles: PackageFiles = {
      stat: (path) =>
        path === "data"
          ? { directory: true, size: 0, mtimeMs: 0 }
          : files[path] === undefined
            ? undefined
            : { directory: false, size: files[path]!.length, mtimeMs: 0 },
      read: (path) =>
        files[path] === undefined ? undefined : new TextEncoder().encode(files[path]),
      list: (path) => (path === "data" ? ["a.json"] : undefined),
    };
    const log = boot(
      `
      const fs = wx.getFileSystemManager();
      log(fs.readFileSync("/data/a.json", "utf8"));
      log(fs.readFileSync("data/a.json", "utf8"));
      log(fs.readdirSync("/data"));
      try { fs.unlinkSync("/data/a.json"); } catch (e) { log(e.message); }
    `,
      new MemoryFs({ packageFiles }),
    );
    await settle();
    expect(log()).toEqual(['{"a":1}', '{"a":1}', ["a.json"], "unlinkSync:fail permission denied"]);
  });
});
