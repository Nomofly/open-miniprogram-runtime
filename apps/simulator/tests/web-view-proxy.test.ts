import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vite-plus/test";
import { createWebViewProxies, rewriteCookie } from "../server/web-view-proxy.ts";

const servers: Server[] = [];
const proxies = createWebViewProxies(async () => "");

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  proxies.close();
});

/** A real site, which sets a cookie named after itself and remembers the headers it was sent. */
async function site(name: string) {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, {
      "content-type": "text/plain",
      "set-cookie": `${name}=1; Domain=example.com; Path=/; Secure; SameSite=None`,
    });
    res.end("ok");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

test("each origin's server gets back only the cookies it set, and its proxy listens on the simulator's address alone", async () => {
  const a = await site("a");
  const b = await site("b");
  const portA = await proxies.open(a.origin, "WeChat", "127.0.0.1");
  const portB = await proxies.open(b.origin, "WeChat", "127.0.0.1");

  const first = await fetch(`http://127.0.0.1:${portA}/`);
  // On a loopback host browsers keep Secure cookies over http, so only Domain goes
  expect(first.headers.getSetCookie()).toEqual(["a=1; Path=/; Secure; SameSite=None"]);
  await fetch(`http://127.0.0.1:${portB}/`);

  // The browser sends every cookie of the host to both proxies
  const cookie = "a=1; b=1; script=1";
  await fetch(`http://127.0.0.1:${portA}/`, { headers: { cookie } });
  await fetch(`http://127.0.0.1:${portB}/`, { headers: { cookie } });
  expect(a.seen.at(-1)!.cookie).toBe("a=1; script=1");
  expect(b.seen.at(-1)!.cookie).toBe("b=1; script=1");

  // Not reachable from other interfaces
  const { networkInterfaces } = await import("node:os");
  const other = Object.values(networkInterfaces())
    .flat()
    .find((net) => net && net.family === "IPv4" && !net.internal)?.address;
  if (other) await expect(fetch(`http://${other}:${portA}/`)).rejects.toThrow();
});

test("away from loopback, cookies drop Secure and SameSite=None becomes Lax", () => {
  expect(
    rewriteCookie("sid=1; Domain=.example.com; Path=/; Secure; HttpOnly; SameSite=None", false),
  ).toBe("sid=1; Path=/; HttpOnly; SameSite=Lax");
  expect(rewriteCookie("sid=1; SameSite=Strict; secure", false)).toBe("sid=1; SameSite=Strict");
  expect(rewriteCookie("sid=1; Secure; SameSite=None", true)).toBe("sid=1; Secure; SameSite=None");
});
