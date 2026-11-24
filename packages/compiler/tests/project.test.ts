import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { loadProject } from "../src/index.ts";

async function fixture(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "omr-project-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(content));
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

  test("rejects an app.json without pages", async () => {
    const dir = await fixture({ "app.json": { pages: [] } });

    await expect(loadProject(dir)).rejects.toThrow("must list at least one page");
  });
});
