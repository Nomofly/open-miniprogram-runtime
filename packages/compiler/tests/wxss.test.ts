import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { compileWxss } from "../src/index.ts";

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "omr-wxss-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return dir;
}

describe("compileWxss", () => {
  test("prefixes the classes of imported component styles once", async () => {
    const root = await fixture({
      "components/card/card.wxss": '@import "../common/base.wxss";\n.title { color: red; }',
      "components/common/base.wxss": '@import "./reset.wxss";\n.label { color: blue; }',
      "components/common/reset.wxss": ":host .icon { margin: 0; }",
    });

    const css = await compileWxss(root, "components/card/card.wxss", { prefix: "p" });

    expect(css).toContain('[omr-host="p"] .p--icon');
    expect(css).toContain(".p--label");
    expect(css).toContain(".p--title");
    expect(css).not.toContain("p--p--");
  });

  test("inlines a file at every import, so later imports win the cascade", async () => {
    const root = await fixture({
      "a.wxss": '@import "red.wxss";\n@import "blue.wxss";\n@import "red.wxss";',
      "red.wxss": ".x { color: red; }",
      "blue.wxss": ".x { color: blue; }",
    });

    const css = await compileWxss(root, "a.wxss");

    expect(css.match(/color: \w+/g)).toEqual(["color: red", "color: blue", "color: red"]);
  });

  test("ignores import cycles", async () => {
    const root = await fixture({
      "a.wxss": '@import "b.wxss";\n.a { color: red; }',
      "b.wxss": '@import "a.wxss";\n.b { color: blue; }',
    });

    const css = await compileWxss(root, "a.wxss");

    expect(css.match(/\.\w \{/g)).toEqual([".b {", ".a {"]);
  });
});
