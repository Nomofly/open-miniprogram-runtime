import { readFile } from "node:fs/promises";
import path from "node:path";
import postcss, { type AtRule, type Root } from "postcss";
import selectorParser from "postcss-selector-parser";
import { BUILTIN_TAGS } from "./wxml.ts";

/** The attribute the view layer sets on a custom component's host element, so `:host` can match it. */
export const HOST_ATTRIBUTE = "omr-host";

export interface WxssOptions {
  /**
   * The class prefix of a custom component. Its classes `.a` become `.<prefix>--a`,
   * matching the classes the view layer gives the component's elements.
   */
  prefix?: string;
}

/**
 * Compiles a WXSS file and its `@import`s into CSS for the view layer: built-in
 * tag selectors become `wx-*`, `page` becomes `body`, and component styles are
 * scoped by class prefix. `rpx` units are kept; the view layer converts them for
 * the device width.
 */
export async function compileWxss(
  root: string,
  file: string,
  options: WxssOptions = {},
): Promise<string> {
  return compileFile(root, file, options, new Set());
}

async function compileFile(
  root: string,
  file: string,
  options: WxssOptions,
  seen: Set<string>,
): Promise<string> {
  if (seen.has(file)) return "";
  seen.add(file);
  let source: string;
  try {
    source = await readFile(path.join(root, file), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  const ast = postcss.parse(source, { from: file });

  const imports: AtRule[] = [];
  ast.walkAtRules("import", (rule) => {
    imports.push(rule);
  });
  for (const rule of imports) {
    const target = rule.params
      .trim()
      .replace(/^url\((.*)\)$/, "$1")
      .replace(/^["']|["']$/g, "");
    const resolved = target.startsWith("/")
      ? path.posix.normalize(target.slice(1))
      : path.posix.join(path.posix.dirname(file), target);
    const css = await compileFile(
      root,
      resolved.endsWith(".wxss") ? resolved : `${resolved}.wxss`,
      options,
      seen,
    );
    rule.replaceWith(postcss.parse(css));
  }

  transformSelectors(ast, options);
  return ast.toString();
}

function transformSelectors(ast: Root, options: WxssOptions): void {
  const transform = selectorParser((selectors) => {
    selectors.walk((node) => {
      if (node.type === "tag") {
        const tag = node.value;
        if (tag === "page") node.value = "body";
        else if (BUILTIN_TAGS.has(tag)) node.value = `wx-${tag}`;
      } else if (node.type === "class" && options.prefix) {
        node.value = `${options.prefix}--${node.value}`;
      } else if (node.type === "pseudo" && node.value === ":host" && options.prefix) {
        node.replaceWith(
          selectorParser.attribute({
            attribute: HOST_ATTRIBUTE,
            operator: "=",
            value: `"${options.prefix}"`,
            quoteMark: '"',
            raws: {},
          } as Parameters<typeof selectorParser.attribute>[0]),
        );
      }
    });
  });
  ast.walkRules((rule) => {
    // Keyframe selectors such as `from` and `50%` are not element selectors
    if (rule.parent?.type === "atrule" && /keyframes$/i.test((rule.parent as AtRule).name)) return;
    rule.selector = transform.processSync(rule.selector);
  });
}
