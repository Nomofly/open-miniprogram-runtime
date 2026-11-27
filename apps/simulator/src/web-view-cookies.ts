/**
 * Keeps the cookies of each `<web-view>` origin apart. Browsers keep cookies by
 * host, not port, so every origin's proxy at the simulator's host shares one
 * cookie jar. Each origin's cookies are named with its own prefix, both those
 * its server sets (by the proxy) and those its scripts set (by the bridge's
 * `document.cookie`), and each origin sees only its own, without the prefix.
 */

/** The cookies of a `Cookie` header, or of `document.cookie`, that carry the prefix, without it. */
export function ownCookies(header: string, prefix: string): string {
  return header
    .split(/;\s*/)
    .filter((pair) => pair.startsWith(prefix))
    .map((pair) => pair.slice(prefix.length))
    .join("; ");
}

/**
 * A `Set-Cookie` value, or a `document.cookie` assignment, named with the
 * prefix. `Domain` goes, so the cookie is kept for the simulator's host.
 */
export function prefixCookie(cookie: string, prefix: string): string {
  return (
    prefix +
    cookie
      .trimStart()
      .split(";")
      .filter((part) => !/^\s*domain\s*=/i.test(part))
      .join(";")
  );
}
