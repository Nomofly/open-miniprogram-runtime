import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  compileAppService,
  compilePage,
  loadProject,
  type TemplateNode,
  type WebviewBundle,
} from "../src/index.ts";

async function fixture(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "omr-project-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

describe("loadProject", () => {
  test("follows miniprogramRoot and lists subpackage pages after main pages", async () => {
    const dir = await fixture({
      "project.config.json": { miniprogramRoot: "miniprogram/" },
      "miniprogram/app.json": {
        pages: ["pages/index/index", "pages/logs/logs"],
        entryPagePath: "pages/logs/logs",
        subPackages: [{ root: "packageA/", pages: ["pages/cat/cat"] }],
      },
    });

    const project = await loadProject(dir);

    expect(project.root).toBe(path.join(dir, "miniprogram"));
    expect(project.pages).toEqual([
      "pages/index/index",
      "pages/logs/logs",
      "packageA/pages/cat/cat",
    ]);
    expect(project.entryPage).toBe("pages/logs/logs");
  });

  test("accepts lowercase subpackages and defaults entry to the first page", async () => {
    const dir = await fixture({
      "app.json": {
        pages: ["pages/home/home", "pages/me/me"],
        subpackages: [{ root: "shop", pages: ["list/list"] }],
      },
    });

    const project = await loadProject(dir);

    expect(project.root).toBe(dir);
    expect(project.pages).toEqual(["pages/home/home", "pages/me/me", "shop/list/list"]);
    expect(project.entryPage).toBe("pages/home/home");
  });

  test("reports where app.json was expected", async () => {
    const dir = await fixture({ "project.config.json": { miniprogramRoot: "src" } });

    await expect(loadProject(dir)).rejects.toThrow(path.join(dir, "src", "app.json"));
  });

  test("keeps a project name that is not URL-encoded", async () => {
    const encoded = await fixture({
      "project.config.json": { projectname: "my%20demo" },
      "app.json": { pages: ["index"] },
    });
    const raw = await fixture({
      "project.config.json": { projectname: "100%demo" },
      "app.json": { pages: ["index"] },
    });

    expect((await loadProject(encoded)).name).toBe("my demo");
    expect((await loadProject(raw)).name).toBe("100%demo");
  });

  test("rejects an app.json without pages", async () => {
    const dir = await fixture({ "app.json": { pages: [] } });

    await expect(loadProject(dir)).rejects.toThrow("must list at least one page");
  });
});

/** Expands includes the way the view layer renders them, failing if that does not end. */
function expandIncludes(bundle: WebviewBundle, nodes: TemplateNode[], depth = 0): string[] {
  if (depth > 20) throw new Error("include does not end");
  return nodes.flatMap((node): string[] => {
    if (node.type === "include") {
      return expandIncludes(bundle, bundle.files[node.src]?.nodes ?? [], depth + 1);
    }
    if (node.type === "text") return typeof node.value === "string" ? [node.value] : [];
    if (node.type === "element") return expandIncludes(bundle, node.children, depth);
    return [];
  });
}

describe("compilePage", () => {
  test("cuts include cycles and keeps import cycles", async () => {
    const dir = await fixture({
      "app.json": { pages: ["index"] },
      "index.wxml": '<include src="a.wxml"/><include src="self.wxml"/><import src="x.wxml"/>',
      "a.wxml": '<view>a<include src="b.wxml"/></view>',
      "b.wxml": '<view>b<include src="/a.wxml"/></view>',
      "self.wxml": 'self<include src="self"/>',
      "x.wxml": '<import src="y.wxml"/><template name="x">x</template>',
      "y.wxml": '<import src="x.wxml"/><template name="y">y</template>',
    });

    const bundle = await compilePage(await loadProject(dir), "index");

    expect(expandIncludes(bundle, bundle.files["index.wxml"]!.nodes)).toEqual(["a", "b", "self"]);
    expect(bundle.files["x.wxml"]!.imports).toEqual(["y.wxml"]);
    expect(bundle.files["y.wxml"]!.imports).toEqual(["x.wxml"]);
  });

  test("gives components whose paths hash alike their own prefix", async () => {
    // These two paths have the same hash
    const dir = await fixture({
      "app.json": { pages: ["index"] },
      "index.json": {
        usingComponents: { a: "/components/c1r/index", b: "/components/c30/index" },
      },
      "index.wxml": "<a/><b/>",
      "components/c1r/index.json": { component: true },
      "components/c30/index.json": { component: true },
    });

    const bundle = await compilePage(await loadProject(dir), "index");
    const prefixes = Object.values(bundle.components).map((component) => component.prefix);

    expect(new Set(prefixes).size).toBe(2);
  });

  test("resolves generics, placeholders, aliases and the custom tab bar of a page", async () => {
    const dir = await fixture({
      "app.json": {
        pages: ["pages/home/home", "pages/plain/plain"],
        resolveAlias: { "~/*": "/src/*" },
        tabBar: { custom: true, list: [{ pagePath: "/pages/home/home", text: "Home" }] },
      },
      "pages/home/home.json": {
        usingComponents: {
          list: "~/list/list",
          row: "../../src/row/row",
          loading: "/src/spin/spin",
        },
        componentPlaceholder: { lazy: "loading" },
      },
      "pages/home/home.wxml": '<list generic:item="row"/><lazy/>',
      "pages/plain/plain.wxml": "",
      "src/list/list.json": {
        component: true,
        componentGenerics: { item: { default: "../cell/cell" }, extra: true },
      },
      "src/cell/cell.json": { component: true },
      "src/row/row.json": { component: true },
      "src/spin/spin.json": { component: true },
      "custom-tab-bar/index.json": { component: true },
    });
    const project = await loadProject(dir);

    const home = await compilePage(project, "pages/home/home");
    expect(home.page.usingComponents).toMatchObject({
      list: "src/list/list",
      lazy: "src/spin/spin",
    });
    expect(home.components["src/list/list"]!.generics).toEqual({
      item: "src/cell/cell",
      extra: "",
    });
    expect(Object.keys(home.components).sort()).toEqual([
      "custom-tab-bar/index",
      "src/cell/cell",
      "src/list/list",
      "src/row/row",
      "src/spin/spin",
    ]);
    expect(home.customTabBar).toBe("custom-tab-bar/index");

    const plain = await compilePage(project, "pages/plain/plain");
    expect(plain.customTabBar).toBeUndefined();
  });

  test("loads WXS modules required with whitespace before the parenthesis", async () => {
    const dir = await fixture({
      "app.json": { pages: ["index"] },
      "index.wxml":
        '<wxs module="m" src="m.wxs"/><wxs module="n">var u = require ("/util/u.wxs");</wxs>',
      "m.wxs": 'var t = require ( "./t.wxs" );',
      "t.wxs": "module.exports = 1;",
      "util/u.wxs": "module.exports = 2;",
    });

    const bundle = await compilePage(await loadProject(dir), "index");

    expect(Object.keys(bundle.wxs).sort()).toEqual(["m.wxs", "t.wxs", "util/u.wxs"]);
  });
});

describe("compileAppService", () => {
  /** Runs the bundle and returns the exports of `file`, with `require` returning the module path it was asked for. */
  function run(bundle: string, file: string): unknown {
    const factories = new Map<string, (...args: unknown[]) => void>();
    // oxlint-disable-next-line typescript/no-implied-eval -- the test runs the compiled bundle
    new Function("__omrDefine", bundle)((name: string, factory: (...args: unknown[]) => void) =>
      factories.set(name, factory),
    );
    const module = { exports: {} as unknown };
    factories.get(file)!.call(module.exports, (spec: string) => spec, module, module.exports);
    return module.exports;
  }

  test("lets a module declare the names the factory injects", async () => {
    const dir = await fixture({
      "app.json": { pages: ["index"] },
      "index.js": `"use strict";
const require = (spec) => "own " + spec;
let fetch = 1;
const window = 2;
var exports = 3;
module.exports = { required: require("x"), fetch, window, exports, self: this === undefined };
`,
      "util.js": 'module.exports = { util: require("./x"), self: this === exports };',
    });

    const bundle = await compileAppService(await loadProject(dir));

    expect(run(bundle, "index.js")).toEqual({
      required: "own x",
      fetch: 1,
      window: 2,
      exports: 3,
      self: false,
    });
    expect(run(bundle, "util.js")).toEqual({ util: "./x", self: true });
  });

  test("keeps the source lines of each module after the factory's first line", async () => {
    const dir = await fixture({ "app.json": { pages: ["index"] }, "index.js": "a\nb" });

    const bundle = await compileAppService(await loadProject(dir));

    expect(bundle.split("\n").slice(1, 3)).toEqual(["a", "b"]);
  });

  test("skips symbolic links and unreadable directories", async () => {
    // Windows ignores directory permissions, so it cannot lock a directory
    const lockable = process.platform !== "win32";
    const dir = await fixture({
      "app.json": { pages: ["index"] },
      "index.js": "",
      "outside/secret.js": "",
      ...(lockable && { "locked/hidden.js": "" }),
    });
    await mkdir(path.join(dir, "pages"));
    await symlink(dir, path.join(dir, "pages", "loop"));
    await symlink(path.join(dir, "outside"), path.join(dir, "pages", "out"));
    await symlink(path.join(dir, "index.js"), path.join(dir, "pages", "link.js"));
    if (lockable) await chmod(path.join(dir, "locked"), 0);

    try {
      const bundle = await compileAppService(await loadProject(dir));
      const files = [...bundle.matchAll(/__omrDefine\("([^"]+)"/g)].map((match) => match[1]);

      expect(files).toEqual(["index.js", "outside/secret.js"]);
    } finally {
      if (lockable) await chmod(path.join(dir, "locked"), 0o755);
    }
  });
});
