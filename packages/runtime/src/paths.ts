/** Root-relative POSIX path helpers; the logic layer runs in a Worker without `node:path`. */

export function normalizePath(file: string): string {
  const out: string[] = [];
  for (const part of file.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

export function dirname(file: string): string {
  const index = file.lastIndexOf("/");
  return index === -1 ? "" : file.slice(0, index);
}

/** Resolves `target` against the file `from`; a leading `/` means the Mini Program root. */
export function resolvePath(from: string, target: string): string {
  return target.startsWith("/")
    ? normalizePath(target)
    : normalizePath(`${dirname(from)}/${target}`);
}

/**
 * Splits a page URL such as `../detail/detail?id=1` into its route and query,
 * resolving it against the current route. Query values are passed through
 * undecoded, as WeChat does.
 */
export function parsePageUrl(
  url: string,
  fromRoute: string,
): { route: string; query: Record<string, string> } {
  const [pathPart = "", search = ""] = url.split("?", 2);
  const query: Record<string, string> = {};
  for (const pair of search.split("&")) {
    if (!pair) continue;
    const index = pair.indexOf("=");
    if (index === -1) query[pair] = "";
    else query[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return { route: resolvePath(fromRoute, pathPart), query };
}
