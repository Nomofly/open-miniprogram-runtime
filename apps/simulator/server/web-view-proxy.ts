/**
 * Serves the pages `<web-view>` shows. Each real origin gets its own proxy on
 * its own port, which forwards every path to that origin, so a page keeps its
 * paths, its history and its same-origin requests, and runs at an origin other
 * than the simulator's. Into each HTML document it injects what WeChat puts
 * there (`WeixinJSBridge`, the WeChat user agent); upstream it sends the WeChat
 * user agent. It drops the headers that would stop the page from being framed
 * or from running the injected script.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { WebViewBridgeConfig } from "../src/web-view-bridge.ts";

export interface WebViewProxies {
  /** The port of the proxy for `origin`, started on first use; `userAgent` is what the page and its server see. */
  open(origin: string, userAgent: string): Promise<number>;
  close(): void;
}

/** Request headers that belong to one connection, or that the proxy sets itself. */
const REQUEST_DROPPED = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
  "user-agent",
]);
/** Response headers that belong to one connection, describe the body before decoding, or stop the page from being framed or scripted. */
const RESPONSE_DROPPED = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "alt-svc",
  "set-cookie",
  "location",
]);

export function createWebViewProxies(bridge: () => Promise<string>): WebViewProxies {
  const proxies = new Map<string, Promise<{ server: Server; port: number }>>();
  let userAgent = "";

  const open = (origin: string) => {
    let proxy = proxies.get(origin);
    if (!proxy) {
      const server = createServer((req, res) => {
        forward(origin, req, res).catch((error: unknown) => {
          if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          res.end((error as Error).message);
        });
      });
      proxy = new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, () => resolve({ server, port: (server.address() as AddressInfo).port }));
      });
      proxies.set(origin, proxy);
      proxy.catch(() => proxies.delete(origin));
    }
    return proxy.then(({ port }) => port);
  };

  /** The address of the proxy for a URL, at the host the browser reached this proxy by. */
  const proxied = async (url: URL, req: IncomingMessage) => {
    const host = new URL(`http://${req.headers.host ?? "localhost"}`).hostname;
    const port = await open(url.origin);
    return `http://${host.includes(":") ? `[${host}]` : host}:${port}${url.pathname}${url.search}${url.hash}`;
  };

  const forward = async (origin: string, req: IncomingMessage, res: ServerResponse) => {
    const target = new URL(req.url ?? "/", origin);
    // The page's own document, as opposed to its images, scripts and requests
    const isDocument = ["document", "iframe", "frame"].includes(
      String(req.headers["sec-fetch-dest"]),
    );
    const self = `http://${req.headers.host ?? ""}`;
    const headers: Record<string, string> = { "user-agent": userAgent };
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || REQUEST_DROPPED.has(name)) continue;
      // A fresh document every time, so it always gets the current bridge
      if (isDocument && (name === "if-none-match" || name === "if-modified-since")) continue;
      let text = Array.isArray(value) ? value.join(", ") : value;
      // The server sees requests from its own origin, not the proxy's
      if ((name === "origin" || name === "referer") && text.startsWith(self)) {
        text = origin + text.slice(self.length);
      }
      headers[name] = text;
    }
    const method = req.method ?? "GET";
    const body =
      method === "GET" || method === "HEAD" ? undefined : new Uint8Array(await readBody(req));
    let response: Response;
    try {
      response = await fetch(target, { method, headers, body, redirect: "manual" });
    } catch (error) {
      if (!isDocument) throw error;
      const cause = (error as Error & { cause?: Error }).cause;
      const page = errorPage(target, cause?.message ?? (error as Error).message);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      const script = await bridgeScript({ origin, userAgent, error: errorOf(target) });
      res.end(page.replace("<!--bridge-->", () => script));
      return;
    }
    const out: Record<string, string | string[]> = {};
    response.headers.forEach((value, name) => {
      if (!RESPONSE_DROPPED.has(name)) out[name] = value;
    });
    // Cookies belong to the proxy's host now
    const cookies = response.headers.getSetCookie().map(rewriteCookie);
    if (cookies.length > 0) out["set-cookie"] = cookies;
    const location = response.headers.get("location");
    if (location !== null) {
      const next = new URL(location, target);
      // A redirect stays in a proxy: this one for the same origin, another one for another origin
      out.location =
        next.origin === origin
          ? `${next.pathname}${next.search}${next.hash}`
          : /^https?:$/.test(next.protocol)
            ? await proxied(next, req)
            : location;
    }
    let bytes: Buffer = Buffer.from(await response.arrayBuffer());
    if (isDocument && /^text\/html\b/i.test(response.headers.get("content-type") ?? "")) {
      out["cache-control"] = "no-store";
      bytes = injectHtml(bytes, await bridgeScript({ origin, userAgent }));
    }
    res.writeHead(response.status, out);
    res.end(method === "HEAD" ? undefined : bytes);
  };

  const bridgeScript = async (config: WebViewBridgeConfig) =>
    `<script>window.__omrWebView=${JSON.stringify(config)};\n${await bridge()}</script>`
      // The script may sit in a document of any charset, and must not end early
      .replace(/<\/(?!script>$)/gi, "<\\/")
      .replace(
        /[\u0080-\uffff]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );

  return {
    open(origin, agent) {
      userAgent = agent;
      return open(origin);
    },
    close() {
      for (const proxy of proxies.values()) void proxy.then(({ server }) => server.close());
      proxies.clear();
    },
  };
}

/** WeChat's `binderror` detail: the URL without its query, and the whole URL. */
const errorOf = (url: URL) => ({ url: `${url.origin}${url.pathname}`, fullUrl: url.href });

/** Puts the script at the top of the document's head, before any of its own scripts. */
export function injectHtml(bytes: Buffer, script: string): Buffer {
  // Latin-1 keeps byte offsets, whatever the document's charset
  const text = bytes.toString("latin1");
  let at = 0;
  for (const pattern of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype\b[^>]*>/i]) {
    const match = pattern.exec(text);
    if (match) {
      at = match.index + match[0].length;
      break;
    }
  }
  return Buffer.concat([bytes.subarray(0, at), Buffer.from(script, "latin1"), bytes.subarray(at)]);
}

/** Drops `Domain`, so a cookie the real site sets for its domain is kept for the proxy's host. */
export function rewriteCookie(cookie: string): string {
  return cookie
    .split(";")
    .filter((part) => !/^\s*domain\s*=/i.test(part))
    .join(";");
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);

/** What the web-view shows when the page cannot be reached. */
function errorPage(url: URL, reason: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>无法打开网页</title>
    <!--bridge-->
    <style>
      body { margin: 0; padding: 96px 32px 0; font: 15px/1.5 -apple-system, "PingFang SC", sans-serif; color: #111; text-align: center; background: #fff; }
      .icon { width: 56px; height: 56px; margin: 0 auto 24px; border-radius: 50%; background: #fa5151; color: #fff; font: 600 32px/56px sans-serif; }
      h1 { margin: 0 0 12px; font-size: 18px; font-weight: 500; }
      p { margin: 0; color: rgba(0, 0, 0, 0.5); font-size: 13px; word-break: break-all; }
    </style>
  </head>
  <body>
    <div class="icon">!</div>
    <h1>网页无法打开</h1>
    <p>${escapeHtml(url.href)}</p>
    <p>${escapeHtml(reason)}</p>
  </body>
</html>
`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
