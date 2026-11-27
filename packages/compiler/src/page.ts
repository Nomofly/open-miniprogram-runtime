import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { MiniProgramProject } from "./project.ts";
import { readJson } from "./project.ts";
import { compileWxml, type TemplateNode, type WxmlFile } from "./wxml.ts";
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
  /** `componentGenerics`: each generic tag's default component path, or `""` without a default. */
  generics?: Record<string, string>;
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
  /** On a tab page of an app with `tabBar.custom`: the `custom-tab-bar` component it shows at the bottom. */
  customTabBar?: string;
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
  const alias = (project.appJson.resolveAlias as Record<string, string> | undefined) ?? {};
  const globalComponents = await resolveUsingComponents(
    root,
    "app.json",
    (project.appJson.usingComponents as Record<string, string> | undefined) ?? {},
    alias,
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
      else await loadWxsRequires(module.code ?? "", file);
    }
    for (const dep of [...compiled.imports, ...compiled.includes]) await loadWxml(dep);
  };
  const loadWxs = async (file: string): Promise<void> => {
    if (file in wxs) return;
    const source = (await readOptional(path.join(root, file))) ?? "";
    wxs[file] = source;
    await loadWxsRequires(source, file);
  };
  /** Loads the `.wxs` files that WXS code written in `file` requires. */
  const loadWxsRequires = async (code: string, file: string): Promise<void> => {
    for (const match of code.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = match[1]!;
      await loadWxs(
        spec.startsWith("/")
          ? path.posix.normalize(spec.slice(1))
          : path.posix.join(path.posix.dirname(file), spec),
      );
    }
  };
  const loadScope = async (scopePath: string, prefix: string): Promise<ScopeDefinition> => {
    const json = (await readJson(path.join(root, `${scopePath}.json`))) ?? {};
    const own = await resolveUsingComponents(
      root,
      `${scopePath}.json`,
      (json.usingComponents as Record<string, string> | undefined) ?? {},
      alias,
    );
    const usingComponents = { ...globalComponents, ...own };
    // A placeholder stands in for a component that is not there, such as one in a missing subpackage
    for (const [tag, placeholder] of Object.entries(
      (json.componentPlaceholder as Record<string, string> | undefined) ?? {},
    )) {
      const stand = usingComponents[placeholder];
      if (!Object.hasOwn(usingComponents, tag) && stand) usingComponents[tag] = stand;
    }
    const scope: ScopeDefinition = {
      path: scopePath,
      template: `${scopePath}.wxml`,
      usingComponents,
      prefix,
    };
    const genericSpecs = json.componentGenerics as Record<string, unknown> | undefined;
    if (genericSpecs && typeof genericSpecs === "object") {
      const defaults: Record<string, string> = {};
      for (const [name, spec] of Object.entries(genericSpecs)) {
        const fallback = (spec as { default?: unknown } | null)?.default;
        if (typeof fallback === "string") defaults[name] = fallback;
      }
      const resolved = await resolveUsingComponents(root, `${scopePath}.json`, defaults, alias);
      scope.generics = Object.fromEntries(
        Object.keys(genericSpecs).map((name) => [name, resolved[name] ?? ""]),
      );
    }
    await loadWxml(scope.template);
    return scope;
  };

  const page = await loadScope(route, "");
  const tabBar = project.appJson.tabBar as
    | { custom?: boolean; list?: { pagePath?: string }[] }
    | undefined;
  const customTabBar =
    tabBar?.custom === true &&
    (tabBar.list ?? []).some(
      (item) => path.posix.normalize(String(item.pagePath ?? "").replace(/^\/+/, "")) === route,
    )
      ? await findComponent(root, ["custom-tab-bar"])
      : undefined;
  const pending = [page];
  const prefixes = new Set<string>();
  while (pending.length > 0) {
    const scope = pending.pop()!;
    for (const componentPath of [
      ...Object.values(scope.usingComponents),
      ...Object.values(scope.generics ?? {}),
      ...(scope === page && customTabBar ? [customTabBar] : []),
    ]) {
      if (!componentPath || componentPath in components) continue;
      // Reserve the entry first so a component that uses itself is not loaded again
      components[componentPath] = undefined!;
      // Distinct paths may hash alike, but each component of the page needs its own prefix
      let prefix = componentPrefix(componentPath);
      for (let n = 2; prefixes.has(prefix); n++) prefix = `${componentPrefix(componentPath)}_${n}`;
      prefixes.add(prefix);
      const component = await loadScope(componentPath, prefix);
      components[componentPath] = component;
      pending.push(component);
    }
  }
  // Rendering starts at the page and component templates, so cycles are cut where they close from there
  breakIncludeCycles(
    files,
    [page, ...Object.values(components)].map((scope) => scope.template),
  );

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
    ...(customTabBar ? { customTabBar } : {}),
  };
}

/**
 * Replaces each `<include>` that leads back to a file it is rendered from, such
 * as a file that includes itself, with an empty block, so that rendering ends.
 * Imports need no check: templates are looked up only in directly imported files.
 */
function breakIncludeCycles(files: Record<string, WxmlFile>, roots: string[]): void {
  const done = new Set<string>();
  const active = new Set<string>();
  const visit = (file: string): void => {
    if (done.has(file) || !files[file]) return;
    active.add(file);
    const check = (node: TemplateNode): TemplateNode => {
      switch (node.type) {
        case "include":
          if (active.has(node.src)) {
            return {
              type: "element",
              uid: node.uid,
              tag: "block",
              attrs: {},
              events: [],
              children: [],
            };
          }
          visit(node.src);
          return node;
        case "element":
          node.children = node.children.map(check);
          return node;
        case "if":
          for (const branch of node.branches) branch.node = check(branch.node);
          return node;
        case "for":
          node.node = check(node.node);
          return node;
        default:
          return node;
      }
    };
    // Template definitions are not checked: they render only through `<template is>`
    files[file].nodes = files[file].nodes.map(check);
    active.delete(file);
    done.add(file);
  };
  for (const file of [...roots, ...Object.keys(files)]) visit(file);
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
  alias: Record<string, string> = {},
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  const dir = path.posix.dirname(jsonFile);
  for (const [tag, written] of Object.entries(using)) {
    if (typeof written !== "string") continue;
    const spec = applyAlias(written, alias);
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

/**
 * Applies app.json `resolveAlias`, such as `{ "~/*": "/src/*" }`: the first
 * key whose prefix starts the path replaces that prefix.
 */
export function applyAlias(spec: string, alias: Record<string, string>): string {
  for (const [from, to] of Object.entries(alias)) {
    if (typeof to !== "string" || !from.endsWith("/*") || !to.endsWith("/*")) continue;
    const prefix = from.slice(0, -1);
    if (spec.startsWith(prefix)) return to.slice(0, -1) + spec.slice(prefix.length);
  }
  return spec;
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
 * The module body runs in a function of its own, so it may declare a name the
 * factory injects, such as `const fetch`, and its `"use strict"` still applies.
 * Each source line keeps its position after the factory's first line.
 */
export async function compileAppService(project: MiniProgramProject): Promise<string> {
  const files = await listFiles(project.root, ".js");
  const parts: string[] = [];
  for (const file of files) {
    const source = await readFile(path.join(project.root, file), "utf8");
    parts.push(
      `__omrDefine(${JSON.stringify(file)}, function (require, module, exports, window, document, self, location, navigator, localStorage, XMLHttpRequest, WebSocket, fetch, importScripts) { return (function () {\n${source}\n}).apply(this, arguments); });`,
    );
  }
  return `${parts.join("\n")}\n//# sourceURL=omr://app-service.js\n`;
}

/**
 * Root-relative paths of files with `extension`, skipping `node_modules`, dot
 * files and directories, directories that cannot be read, and symbolic links,
 * which may loop or lead out of the project.
 */
async function listFiles(root: string, extension: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(root, dir), { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM" || code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const file = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.endsWith(extension)) files.push(file);
    }
  };
  await walk("");
  return files.sort();
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
