import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vite-plus/test";
import { cookiePrefix, createWebViewProxies } from "../server/web-view-proxy.ts";

const servers: Server[] = [];
const proxies = createWebViewProxies(async () => "");

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  proxies.close();
});

/** A real site, which sets the cookie `sid` and remembers the headers it was sent. */
async function site(cookie: string) {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { "content-type": "text/plain", "set-cookie": cookie });
    res.end("ok");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

test("each origin's server gets back only its own cookies, even ones named like another origin's, and its proxy listens on loopback alone", async () => {
  const a = await site("sid=secret; Domain=example.com; Path=/; Secure; HttpOnly; SameSite=None");
  // Another site setting the same name on another path must not get the first one's value
  const b = await site("sid=marker; Path=/unused");
  const portA = await proxies.open(a.origin, "WeChat", "127.0.0.1");
  const portB = await proxies.open(b.origin, "WeChat", "127.0.0.1");
  const [prefixA, prefixB] = [cookiePrefix(a.origin), cookiePrefix(b.origin)];
  expect(prefixA).not.toBe(prefixB);

  // Named for the origin, kept for the proxy's host; Secure stays, as loopback http keeps it
  const first = await fetch(`http://127.0.0.1:${portA}/`);
  expect(first.headers.getSetCookie()).toEqual([
    `${prefixA}sid=secret; Path=/; Secure; HttpOnly; SameSite=None`,
  ]);
  expect((await fetch(`http://127.0.0.1:${portB}/`)).headers.getSetCookie()).toEqual([
    `${prefixB}sid=marker; Path=/unused`,
  ]);

  // The browser sends every cookie of the host to both proxies
  const cookie = `${prefixA}sid=secret; ${prefixB}sid=marker; other=1`;
  await fetch(`http://127.0.0.1:${portA}/`, { headers: { cookie } });
  await fetch(`http://127.0.0.1:${portB}/collect`, { headers: { cookie } });
  expect(a.seen.at(-1)!.cookie).toBe("sid=secret");
  expect(b.seen.at(-1)!.cookie).toBe("sid=marker");

  // Reachable at either loopback address, whichever one localhost resolves to
  expect(await (await fetch(`http://[::1]:${portA}/`)).text()).toBe("ok");
  expect(await (await fetch(`http://localhost:${portA}/`)).text()).toBe("ok");

  // Not reachable from other interfaces
  const { networkInterfaces } = await import("node:os");
  const other = Object.values(networkInterfaces())
    .flat()
    .find((net) => net && net.family === "IPv4" && !net.internal)?.address;
  if (other) await expect(fetch(`http://${other}:${portA}/`)).rejects.toThrow();
});
