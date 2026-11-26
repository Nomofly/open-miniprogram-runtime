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
import { webViewErrorPage } from "../src/web-view-error-page.ts";

export interface WebViewProxies {
  /**
   * The port of the proxy for `origin`, started on first use; `userAgent` is
   * what the page and its server see. The proxy listens only on `address`, the
   * local address the browser reached the simulator at.
   */
  open(origin: string, userAgent: string, address: string): Promise<number>;
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
  const proxies = new Map<string, Promise<{ servers: Server[]; port: number }>>();
  let userAgent = "";
  /**
   * The origins that set each cookie name. Browsers keep cookies by host, not
   * port, so every proxy gets every cookie; each origin's server gets back only
   * those it set, and those set by the page's scripts, as it would on its own.
   */
  const cookieOrigins = new Map<string, Set<string>>();

  const open = (origin: string, address: string) => {
    // An IPv4 client of a dual-stack server
    const host = address.replace(/^::ffff:(?=\d+\.)/, "");
    // `localhost` may resolve to either loopback address, so a loopback proxy listens on both
    const hosts = isLoopbackAddress(host) ? LOOPBACK : [host];
    const key = `${hosts.join(" ")} ${origin}`;
    let proxy = proxies.get(key);
    if (!proxy) {
      const handle = (req: IncomingMessage, res: ServerResponse) => {
        forward(origin, req, res).catch((error: unknown) => {
          if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          res.end((error as Error).message);
        });
      };
      proxy = listenAll(hosts, handle);
      proxies.set(key, proxy);
      proxy.catch(() => proxies.delete(key));
    }
    return proxy.then(({ port }) => port);
  };

  /** The address of the proxy for a URL, at the host the browser reached this proxy by. */
  const proxied = async (url: URL, req: IncomingMessage) => {
    // An IPv6 hostname keeps its brackets
    const host = new URL(`http://${req.headers.host ?? "localhost"}`).hostname;
    const port = await open(url.origin, req.socket.localAddress ?? "localhost");
    return `http://${host}:${port}${url.pathname}${url.search}${url.hash}`;
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
      if (name === "cookie") {
        text = text
          .split(/;\s*/)
          .filter((pair) => cookieOrigins.get(cookieName(pair))?.has(origin) ?? true)
          .join("; ");
        if (!text) continue;
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
      const script = await bridgeScript({ origin, userAgent, error: errorOf(target) });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(webViewErrorPage(target.href, cause?.message ?? (error as Error).message, script));
      return;
    }
    const out: Record<string, string | string[]> = {};
    response.headers.forEach((value, name) => {
      if (!RESPONSE_DROPPED.has(name)) out[name] = value;
    });
    // Cookies belong to the proxy's host now
    const secure = isLoopback(new URL(self).hostname);
    const cookies = response.headers.getSetCookie().map((cookie) => {
      const name = cookieName(cookie);
      cookieOrigins.set(name, (cookieOrigins.get(name) ?? new Set()).add(origin));
      return rewriteCookie(cookie, secure);
    });
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
    open(origin, agent, address) {
      userAgent = agent;
      return open(origin, address);
    },
    close() {
      for (const proxy of proxies.values()) {
        void proxy.then(({ servers }) => servers.forEach((server) => server.close()));
      }
      proxies.clear();
    },
  };
}

const LOOPBACK = ["127.0.0.1", "::1"];
const isLoopbackAddress = (address: string) =>
  address === "::1" || address === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(address);

/** Listens on a port of the system's choosing, which the hosts after the first share. */
const listen = (server: Server, port: number, host: string) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });

/**
 * One port on every host. A host the machine does not have, such as `::1`
 * without IPv6, is skipped; when another program has the port there, the
 * proxy tries another port.
 */
async function listenAll(
  hosts: string[],
  handle: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ servers: Server[]; port: number }> {
  for (let attempt = 0; ; attempt++) {
    const servers = [createServer(handle)];
    const port = await listen(servers[0]!, 0, hosts[0]!);
    try {
      for (const host of hosts.slice(1)) {
        const server = createServer(handle);
        try {
          await listen(server, port, host);
          servers.push(server);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EADDRNOTAVAIL") throw error;
        }
      }
      return { servers, port };
    } catch (error) {
      servers.forEach((server) => server.close());
      if (attempt >= 4) throw error;
    }
  }
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

/** The name of a cookie, from a `Set-Cookie` value or a pair of a `Cookie` header. */
const cookieName = (cookie: string) => cookie.split(/[=;]/, 1)[0]!.trim();

/** Hosts whose plain http pages browsers trust with `Secure` cookies. */
const isLoopback = (hostname: string) =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "[::1]" ||
  /^127\.\d+\.\d+\.\d+$/.test(hostname);

/**
 * Drops `Domain`, so a cookie the real site sets for its domain is kept for
 * the proxy's host. The proxy serves plain http, where browsers refuse
 * `Secure` cookies except on loopback hosts: elsewhere, unless `secure`, the
 * cookie loses `Secure`, and `SameSite=None`, which needs it, becomes `Lax`,
 * which the proxy's frames still get, being on the simulator's site. Cookies
 * named `__Secure-` or `__Host-` still need `Secure`.
 */
export function rewriteCookie(cookie: string, secure: boolean): string {
  return cookie
    .split(";")
    .filter((part) => !/^\s*domain\s*=/i.test(part) && (secure || !/^\s*secure\s*$/i.test(part)))
    .map((part) => (secure ? part : part.replace(/^(\s*samesite\s*=\s*)none\s*$/i, "$1Lax")))
    .join(";");
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
