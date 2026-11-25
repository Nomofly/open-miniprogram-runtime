/**
 * Serves a Mini Program project to the simulator: its manifest, the logic-layer
 * bundle, each page's view bundle, its files, a proxy for `wx.request`, and a
 * mock of the WeChat server APIs a backend calls to finish login.
 */
import { open, readFile, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileAppService,
  compilePage,
  loadProject,
  pageWindow,
  type MiniProgramProject,
} from "@omr/compiler";
import {
  mockWechatApi,
  REQUEST_PROXY_PATH,
  type Manifest,
  type SimulatorConfig,
} from "@omr/runtime";
import { build, type Plugin, type Rolldown, type ViteDevServer } from "vite-plus";

export interface SimulatorPluginOptions {
  /** The Mini Program project directory. */
  project: string;
}

/** Where the mock WeChat server API is served; a backend uses it in place of https://api.weixin.qq.com. */
export const WECHAT_API_PREFIX = "/__omr/wechat-api";
const FILES_PREFIX = "/__omr/files/";
const WECHAT_API_HOST = "api.weixin.qq.com";
const WEBVIEW_ENTRY = path.join(import.meta.dirname, "../src/webview.ts");

/**
 * The page of a WebView. It runs in a sandboxed iframe with an opaque origin,
 * which cannot load module scripts from the simulator without CORS, so it loads
 * the view layer as one classic script and gets everything else by message.
 */
const WEBVIEW_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script src="/__omr/webview.js"></script>
  </head>
  <body></body>
</html>
`;

/** Bundles the view layer into one classic script. */
async function bundleWebview(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    root: path.dirname(WEBVIEW_ENTRY),
    build: {
      write: false,
      minify: false,
      sourcemap: "inline",
      lib: { entry: WEBVIEW_ENTRY, formats: ["iife"], name: "omrWebview", fileName: "webview" },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  const chunk = outputs.flatMap((output) => output.output).find((item) => item.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("failed to bundle the view layer");
  return chunk.code;
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function omrSimulator(options: SimulatorPluginOptions): Plugin {
  // Codes are single use across the whole session, as on WeChat
  const usedCodes = new Set<string>();
  let projectPromise: Promise<MiniProgramProject> | undefined;
  const project = () => (projectPromise ??= loadProject(options.project));
  let webviewPromise: Promise<string> | undefined;
  const webview = () => {
    webviewPromise ??= bundleWebview();
    // A failed build is retried on the next request
    webviewPromise.catch(() => (webviewPromise = undefined));
    return webviewPromise;
  };

  const manifest = async (): Promise<Manifest> => {
    const loaded = await project();
    let config: SimulatorConfig = {};
    for (const dir of new Set([loaded.dir, loaded.root])) {
      const file = path.join(dir, "omr.config.json");
      try {
        config = JSON.parse(await readFile(file, "utf8")) as SimulatorConfig;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(`invalid ${file}: ${(error as Error).message}`, { cause: error });
        }
      }
    }
    const windows: Manifest["windows"] = {};
    for (const route of loaded.pages) windows[route] = await pageWindow(loaded, route);
    return {
      appid: loaded.appid,
      appName: loaded.name,
      appJson: loaded.appJson,
      pages: loaded.pages,
      entryPage: loaded.entryPage,
      windows,
      config,
    };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const { pathname } = url;
    if (pathname === "/__omr/webview.html") {
      send(res, 200, "text/html", WEBVIEW_HTML);
    } else if (pathname === "/__omr/webview.js") {
      send(res, 200, "text/javascript", await webview());
    } else if (pathname === "/__omr/manifest.json") {
      sendJson(res, 200, await manifest());
    } else if (pathname === "/__omr/app-service.js") {
      send(res, 200, "text/javascript", await compileAppService(await project()));
    } else if (pathname === "/__omr/page.json") {
      sendJson(res, 200, await compilePage(await project(), url.searchParams.get("route") ?? ""));
    } else if (pathname.startsWith(FILES_PREFIX)) {
      await serveFile(
        res,
        (await project()).root,
        decodeURIComponent(pathname.slice(FILES_PREFIX.length)),
      );
    } else if (pathname === REQUEST_PROXY_PATH && req.method === "POST") {
      sendJson(
        res,
        200,
        await proxyRequest(JSON.parse(await readBody(req)) as ProxyRequest, usedCodes),
      );
    } else if (pathname.startsWith(`${WECHAT_API_PREFIX}/`)) {
      const target = new URL(
        pathname.slice(WECHAT_API_PREFIX.length) + url.search,
        `https://${WECHAT_API_HOST}`,
      );
      const response = mockWechatApi(
        { method: req.method ?? "GET", url: target, body: await readBody(req) },
        usedCodes,
      );
      if (response) sendJson(res, response.status, response.json);
      else
        sendJson(res, 404, {
          errcode: -1,
          errmsg: `${target.pathname} is not mocked by the simulator`,
        });
    } else {
      return false;
    }
    return true;
  };

  return {
    name: "omr-simulator",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/__omr/")) {
          next();
          return;
        }
        handle(req, res, url).then(
          (handled) => {
            if (!handled) next();
          },
          (error: unknown) => sendJson(res, 500, { error: (error as Error).message }),
        );
      });
      // The view layer is not in the shell's module graph, so watch its sources and rebuild it
      const webviewSources = [
        path.dirname(WEBVIEW_ENTRY),
        ...["@omr/renderer", "@omr/runtime", "@omr/compiler"].map((name) =>
          path.dirname(fileURLToPath(import.meta.resolve(name))),
        ),
      ];
      server.watcher.add(webviewSources);
      server.watcher.on("change", (file) => {
        if (!webviewSources.some((dir) => file.startsWith(dir + path.sep))) return;
        webviewPromise = undefined;
        server.ws.send({ type: "full-reload" });
      });
      void project().then(
        (loaded) => {
          server.watcher.add(loaded.dir);
          server.watcher.on("all", (_event, file) => {
            if (!file.startsWith(loaded.dir + path.sep)) return;
            // app.json and project.config.json are read once; reload them too
            projectPromise = undefined;
            server.ws.send({ type: "full-reload" });
          });
          server.config.logger.info(
            `  Mini Program: ${loaded.root}\n  Mock WeChat API: ${WECHAT_API_PREFIX} (use it in place of https://${WECHAT_API_HOST})`,
          );
        },
        (error: unknown) => server.config.logger.error(`[omr] ${(error as Error).message}`),
      );
    },
  };
}

interface ProxyRequest {
  url: string;
  method: string;
  header: Record<string, string>;
  body?: string;
}

/** Performs `wx.request` for the logic layer, which cannot make cross-origin requests from the browser. */
async function proxyRequest(request: ProxyRequest, usedCodes: Set<string>) {
  try {
    const target = new URL(request.url);
    // A Mini Program cannot call WeChat server APIs itself, but a demo may; answer with the mock
    if (target.host === WECHAT_API_HOST) {
      const mocked = mockWechatApi(
        { method: request.method, url: target, body: request.body },
        usedCodes,
      );
      if (mocked) {
        return {
          statusCode: mocked.status,
          header: { "content-type": "application/json" },
          body: JSON.stringify(mocked.json),
        };
      }
    }
    const headers = Object.fromEntries(
      Object.entries(request.header).filter(
        ([name]) => !["host", "content-length", "referer"].includes(name.toLowerCase()),
      ),
    );
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    });
    return {
      statusCode: response.status,
      header: Object.fromEntries(response.headers),
      body: await response.text(),
    };
  } catch (error) {
    const cause = (error as Error & { cause?: Error }).cause;
    return { error: cause?.message ?? (error as Error).message };
  }
}

async function serveFile(res: ServerResponse, root: string, relative: string): Promise<void> {
  const file = path.resolve(root, relative);
  const inside = file.startsWith(root + path.sep);
  if (!inside || relative.split("/").some((part) => part.startsWith("."))) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  try {
    // A symlink must not lead out of the project
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
    if (!realFile.startsWith(realRoot + path.sep)) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    // Check and read the same open file, so it cannot be swapped in between
    const handle = await open(realFile, "r");
    let body: Buffer;
    try {
      if (!(await handle.stat()).isFile()) throw new Error("not a file");
      body = await handle.readFile();
    } finally {
      await handle.close();
    }
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    // Opened as a document, such as an SVG with script, a project file runs in a sandbox, not as the simulator
    res.writeHead(200, {
      "content-type": type,
      "cache-control": "no-cache",
      "content-security-policy": "sandbox",
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: `${relative} not found` });
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-cache" });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, "application/json", JSON.stringify(value));
}
