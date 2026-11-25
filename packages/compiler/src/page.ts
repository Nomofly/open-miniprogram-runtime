import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { MiniProgramProject } from "./project.ts";
import { readJson } from "./project.ts";
import { compileWxml, type WxmlFile } from "./wxml.ts";
import { compileWxss } from "./wxss.ts";

/** A page or custom component as the view layer sees it. */
export interface ScopeDefinition {
  /** Root-relative path without extension, such as `components/card/card`. */
  path: string;
  /** Root-relative path of its `.wxml` file. */
  template: string;
  /** Tags declared in `usingComponents` (with the app's global ones), mapped to component paths. */
  usingComponents: Record<string, string>;
  /** Class prefix of a component's scoped styles; empty for a page. */
  prefix: string;
}

/** Everything one page's view layer (its WebView) needs to render. */
export interface WebviewBundle {
  route: string;
  page: ScopeDefinition;
  components: Record<string, ScopeDefinition>;
  /** Every `.wxml` file the page and its components use, by root-relative path. */
  files: Record<string, WxmlFile>;
  /** Source of every `.wxs` file referenced with `src`, by root-relative path. */
  wxs: Record<string, string>;
  /** app.wxss, component styles and page styles, in that order. */
  css: string;
  /** The page's window configuration: app.json `window` merged with the page's json. */
  window: Record<string, unknown>;
}

/** Window fields a page json may override. */
const WINDOW_KEYS = new Set([
  "navigationBarBackgroundColor",
  "navigationBarTextStyle",
  "navigationBarTitleText",
  "navigationStyle",
  "backgroundColor",
  "backgroundTextStyle",
  "backgroundColorTop",
  "backgroundColorBottom",
  "enablePullDownRefresh",
  "onReachBottomDistance",
  "pageOrientation",
  "disableScroll",
  "homeButton",
]);

/** The window configuration of a page: app.json `window` merged with the page's json. */
export async function pageWindow(
  project: MiniProgramProject,
  route: string,
): Promise<Record<string, unknown>> {
  const appWindow = (project.appJson.window as Record<string, unknown> | undefined) ?? {};
  const pageJson = (await readJson(path.join(project.root, `${route}.json`))) ?? {};
  const merged: Record<string, unknown> = { ...appWindow };
  for (const [key, value] of Object.entries(pageJson)) {
    if (WINDOW_KEYS.has(key)) merged[key] = value;
  }
  return merged;
}

/** Compiles a page and every custom component it uses into what its WebView renders. */
export async function compilePage(
  project: MiniProgramProject,
  route: string,
): Promise<WebviewBundle> {
  if (!project.pages.includes(route)) {
    throw new Error(`page "${route}" is not listed in app.json`);
  }
  const { root } = project;
  const globalComponents = await resolveUsingComponents(
    root,
    "app.json",
    (project.appJson.usingComponents as Record<string, string> | undefined) ?? {},
  );

  const files: Record<string, WxmlFile> = {};
  const wxs: Record<string, string> = {};
  const components: Record<string, ScopeDefinition> = {};

  const loadWxml = async (file: string): Promise<void> => {
    if (file in files) return;
    const source = await readOptional(path.join(root, file));
    const compiled = compileWxml(source ?? "", file);
    files[file] = compiled;
    for (const module of compiled.wxs) {
      if (module.src) await loadWxs(module.src);
    }
    for (const dep of [...compiled.imports, ...compiled.includes]) await loadWxml(dep);
  };
  const loadWxs = async (file: string): Promise<void> => {
    if (file in wxs) return;
    const source = (await readOptional(path.join(root, file))) ?? "";
    wxs[file] = source;
    for (const match of source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
      await loadWxs(path.posix.join(path.posix.dirname(file), match[1]!));
    }
  };
  const loadScope = async (scopePath: string, prefix: string): Promise<ScopeDefinition> => {
    const json = (await readJson(path.join(root, `${scopePath}.json`))) ?? {};
    const own = await resolveUsingComponents(
      root,
      `${scopePath}.json`,
      (json.usingComponents as Record<string, string> | undefined) ?? {},
    );
    const scope: ScopeDefinition = {
      path: scopePath,
      template: `${scopePath}.wxml`,
      usingComponents: { ...globalComponents, ...own },
      prefix,
    };
    await loadWxml(scope.template);
    return scope;
  };

  const page = await loadScope(route, "");
  const pending = [page];
  while (pending.length > 0) {
    const scope = pending.pop()!;
    for (const componentPath of Object.values(scope.usingComponents)) {
      if (componentPath in components) continue;
      // Reserve the entry first so a component that uses itself is not loaded again
      components[componentPath] = undefined!;
      const component = await loadScope(componentPath, componentPrefix(componentPath));
      components[componentPath] = component;
      pending.push(component);
    }
  }

  const cssParts = [await compileWxss(root, "app.wxss")];
  for (const component of Object.values(components)) {
    cssParts.push(await compileWxss(root, `${component.path}.wxss`, { prefix: component.prefix }));
  }
  cssParts.push(await compileWxss(root, `${route}.wxss`));

  return {
    route,
    page,
    components,
    files,
    wxs,
    css: cssParts.filter(Boolean).join("\n"),
    window: await pageWindow(project, route),
  };
}

/**
 * Resolves `usingComponents` paths, declared in `jsonFile`, to root-relative
 * component paths: absolute paths are relative to the root, relative paths to
 * the json file, and bare paths are looked up in `miniprogram_npm`.
 */
async function resolveUsingComponents(
  root: string,
  jsonFile: string,
  using: Record<string, string>,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  const dir = path.posix.dirname(jsonFile);
  for (const [tag, spec] of Object.entries(using)) {
    if (spec.startsWith("plugin://")) continue;
    let candidates: string[];
    if (spec.startsWith("/")) {
      candidates = [path.posix.normalize(spec.slice(1))];
    } else if (spec.startsWith(".")) {
      candidates = [path.posix.join(dir, spec)];
    } else {
      candidates = [];
      for (let current = dir; ; current = path.posix.dirname(current)) {
        candidates.push(path.posix.join(current === "." ? "" : current, "miniprogram_npm", spec));
        if (current === "." || current === "/" || current === "") break;
      }
      // A bare path may also be root-relative, which WeChat accepts for compatibility
      candidates.push(path.posix.normalize(spec));
    }
    const found = await findComponent(root, candidates);
    if (found) resolved[tag] = found;
  }
  return resolved;
}

async function findComponent(root: string, candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    for (const option of [candidate, path.posix.join(candidate, "index")]) {
      if ((await readOptional(path.join(root, `${option}.json`))) !== undefined) return option;
    }
  }
  return undefined;
}

/** A stable CSS class prefix for a component path. */
export function componentPrefix(componentPath: string): string {
  let hash = 5381;
  for (const char of componentPath) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0;
  return `c${hash.toString(36)}`;
}

/**
 * Bundles every `.js` file of the Mini Program into one script for the logic
 * layer. Each file becomes a CommonJS module registered with
 * `__omrDefine(path, factory)`; the logic layer requires them on demand.
 */
export async function compileAppService(project: MiniProgramProject): Promise<string> {
  const files = await listFiles(project.root, ".js");
  const parts: string[] = [];
  for (const file of files) {
    const source = await readFile(path.join(project.root, file), "utf8");
    parts.push(
      `__omrDefine(${JSON.stringify(file)}, function (require, module, exports, window, document, self, location, navigator, localStorage, XMLHttpRequest, WebSocket, fetch, importScripts) {\n${source}\n});`,
    );
  }
  return `${parts.join("\n")}\n//# sourceURL=omr://app-service.js\n`;
}

/** Root-relative paths of files with `extension`, skipping `node_modules` and dot directories. */
async function listFiles(root: string, extension: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    )
    .filter(
      (file) => !file.split("/").some((part) => part === "node_modules" || part.startsWith(".")),
    )
    .sort();
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
