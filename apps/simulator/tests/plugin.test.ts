import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { createServer, type ViteDevServer } from "vite-plus";
import { omrSimulator } from "../server/plugin.ts";

const upstream: string[] = [];
const target = createHttpServer((req, res) => {
  upstream.push(`${req.method} ${req.url}`);
  res.end("ok");
});
let vite: ViteDevServer;
let base: string;
let targetUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
  vite = await createServer({
    configFile: false,
    logLevel: "silent",
    root: path.join(import.meta.dirname, ".."),
    plugins: [
      omrSimulator({ project: path.join(import.meta.dirname, "../../../examples/auth-demo") }),
    ],
    server: { host: "127.0.0.1", port: 0, ws: false },
  });
  await vite.listen();
  base = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await vite.close();
  target.close();
});

const post = (pathname: string, headers: Record<string, string>, body: string) =>
  fetch(base + pathname, { method: "POST", headers, body });

test("only the simulator's own pages reach the request proxy and the file system", async () => {
  const request = JSON.stringify({ url: `${targetUrl}/a`, method: "POST", header: {} });
  // A no-cors fetch or form from another site, which needs no preflight
  const crossSite = await post(
    "/__omr/request",
    { "content-type": "text/plain", "sec-fetch-site": "cross-site", origin: "https://evil.test" },
    request,
  );
  expect(crossSite.status).toBe(403);
  // Another port of localhost is the same site, not the same origin
  const sameSite = await post(
    "/__omr/request",
    { "content-type": "application/json", "sec-fetch-site": "same-site" },
    request,
  );
  expect(sameSite.status).toBe(403);
  // An older browser without Sec-Fetch-Site still cannot send JSON across sites without a preflight
  const plainText = await post("/__omr/request", { "content-type": "text/plain" }, request);
  expect(plainText.status).toBe(403);
  const fsWrite = await post("/__omr/fs", { "content-type": "text/plain" }, "x");
  expect(fsWrite.status).toBe(403);
  const webView = await fetch(`${base}/__omr/web-view?url=${encodeURIComponent(targetUrl)}`, {
    headers: { "sec-fetch-site": "cross-site" },
  });
  expect(webView.status).toBe(403);
  expect(upstream).toEqual([]);

  const own = await post(
    "/__omr/request",
    { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    request,
  );
  expect(own.status).toBe(200);
  expect(await own.json()).toMatchObject({ statusCode: 200 });
  expect(upstream).toEqual(["POST /a"]);
});
