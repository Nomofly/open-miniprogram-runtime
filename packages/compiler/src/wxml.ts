import path from "node:path";

/** Built-in component tags. The compiler renames them to the custom elements `wx-<tag>` of the view layer. */
export const BUILTIN_TAGS = new Set([
  "view",
  "text",
  "image",
  "button",
  "input",
  "textarea",
  "scroll-view",
  "swiper",
  "swiper-item",
  "icon",
  "navigator",
  "checkbox",
  "checkbox-group",
  "radio",
  "radio-group",
  "switch",
  "slider",
  "progress",
  "form",
  "label",
  "picker",
  "picker-view",
  "picker-view-column",
  "rich-text",
  "web-view",
  "cover-view",
  "cover-image",
  "movable-area",
  "movable-view",
  "map",
  "video",
  "canvas",
  "camera",
  "live-player",
  "live-pusher",
  "ad",
  "official-account",
  "editor",
  "audio",
  "page-container",
  "root-portal",
  "match-media",
  "page-meta",
  "functional-page-navigator",
  "open-data",
  "voip-room",
  "channel-live",
  "channel-video",
  "ad-custom",
  "official-account-publish",
  "store-coupon",
  "store-gift",
  "store-home",
  "store-product",
  "keyboard-accessory",
  "share-element",
  "selection",
  "editor-portal",
]);

/** A WXML expression, the text between `{{` and `}}`. */
export interface Expr {
  e: string;
}

/**
 * An attribute or text value. A plain string has no interpolation. An array is
 * concatenated as a string, except that a single expression keeps its raw value,
 * so `value="{{ 1 }}"` is the number 1.
 */
export type Value = string | (string | Expr)[];

export interface EventBinding {
  /** Event name, such as `tap`. */
  name: string;
  /** Handler method name; it may be interpolated. */
  handler: Value;
  catch: boolean;
  capture: boolean;
}

export interface ElementNode {
  type: "element";
  uid: number;
  /** Built-in components are renamed to `wx-<tag>`; `block`, `slot` and custom component tags are kept. */
  tag: string;
  attrs: Record<string, Value>;
  events: EventBinding[];
  children: TemplateNode[];
}

export interface TextNode {
  type: "text";
  uid: number;
  value: Value;
}

export interface IfNode {
  type: "if";
  uid: number;
  /** The first branch whose test is truthy renders; a branch without a test is `wx:else`. */
  branches: { test?: Value; node: TemplateNode }[];
}

export interface ForNode {
  type: "for";
  uid: number;
  list: Value;
  item: string;
  index: string;
  /** `wx:key`: a property name of the item, or `*this` for the item itself. */
  key?: string;
  node: TemplateNode;
}

/** `<template is="...">`. */
export interface TemplateUseNode {
  type: "template";
  uid: number;
  is: Value;
  /** An object expression; `{{a, b: 1}}` is compiled as `{{ {a, b: 1} }}`. */
  data?: Value;
}

export interface IncludeNode {
  type: "include";
  uid: number;
  /** Mini Program root-relative path of the included `.wxml` file. */
  src: string;
}

export type TemplateNode =
  | ElementNode
  | TextNode
  | IfNode
  | ForNode
  | TemplateUseNode
  | IncludeNode;

export interface WxsModule {
  module: string;
  /** Root-relative path of the `.wxs` file, or undefined for inline code. */
  src?: string;
  code?: string;
}

export interface WxmlFile {
  /** Root-relative path, such as `pages/index/index.wxml`. */
  path: string;
  nodes: TemplateNode[];
  /** `<template name="...">` definitions. */
  templates: Record<string, TemplateNode[]>;
  /** Root-relative paths of `<import>`ed files; their templates are visible here. */
  imports: string[];
  /** Root-relative paths of `<include>`d files. */
  includes: string[];
  wxs: WxsModule[];
}

interface RawElement {
  tag: string;
  attrs: [string, string][];
  children: RawNode[];
}
type RawNode = RawElement | string;

/** Tags that never have children; tolerated without a closing tag. */
const VOID_TAGS = new Set(["import", "include", "input", "image", "icon"]);

/** Parses WXML source into a tree of elements and text, tolerating `<` and quotes inside `{{ }}`. */
export function parseWxml(source: string, file = "<wxml>"): RawNode[] {
  const root: RawElement = { tag: "#root", attrs: [], children: [] };
  const stack: RawElement[] = [root];
  let i = 0;

  const fail = (message: string): never => {
    const line = source.slice(0, i).split("\n").length;
    throw new Error(`${file}:${line}: ${message}`);
  };
  /** Returns the index just after the `}}` that closes the `{{` at `start`. */
  const skipMustache = (start: number): number => {
    const end = mustacheEnd(source, start + 2);
    return end === -1 ? source.length : end + 2;
  };

  while (i < source.length) {
    const parent = stack[stack.length - 1]!;
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    // Declarations such as `<!DOCTYPE html>` and processing instructions such as `<?xml ?>` are ignored
    if (source.startsWith("<!", i) || source.startsWith("<?", i)) {
      const end = source.indexOf(">", i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("</", i)) {
      const end = source.indexOf(">", i);
      if (end === -1) fail("unterminated closing tag");
      const tag = source.slice(i + 2, end).trim();
      i = end + 1;
      const index = stack.findLastIndex((el) => el.tag === tag);
      if (index > 0) stack.length = index;
      continue;
    }
    if (source[i] === "<" && /[A-Za-z]/.test(source[i + 1] ?? "")) {
      i++;
      const tagMatch = /^[A-Za-z][\w\-.:]*/.exec(source.slice(i));
      const tag = tagMatch![0];
      i += tag.length;
      const el: RawElement = { tag, attrs: [], children: [] };
      let selfClosing = false;
      for (;;) {
        while (/\s/.test(source[i] ?? "")) i++;
        if (i >= source.length) fail(`unterminated <${tag}>`);
        if (source.startsWith("/>", i)) {
          selfClosing = true;
          i += 2;
          break;
        }
        if (source[i] === ">") {
          i++;
          break;
        }
        const nameMatch = /^[^\s=/>]+/.exec(source.slice(i));
        if (!nameMatch) fail(`invalid attribute in <${tag}>`);
        const name = nameMatch![0];
        i += name.length;
        while (/\s/.test(source[i] ?? "")) i++;
        let value = "";
        if (source[i] === "=") {
          i++;
          while (/\s/.test(source[i] ?? "")) i++;
          const quote = source[i];
          if (quote === '"' || quote === "'") {
            const start = ++i;
            while (i < source.length && source[i] !== quote) {
              i = source.startsWith("{{", i) ? skipMustache(i) : i + 1;
            }
            value = source.slice(start, i);
            i++;
          } else {
            const start = i;
            while (i < source.length && !/[\s>]/.test(source[i]!)) i++;
            value = source.slice(start, i);
          }
        } else {
          // A boolean attribute such as `<button disabled>`
          value = "true";
        }
        el.attrs.push([name, value]);
      }
      parent.children.push(el);
      if (tag === "wxs" && !selfClosing) {
        const end = source.indexOf("</wxs>", i);
        if (end === -1) fail("unterminated <wxs>");
        el.children.push(source.slice(i, end));
        i = end + "</wxs>".length;
      } else if (!selfClosing && !VOID_TAGS.has(tag)) {
        stack.push(el);
      }
      continue;
    }
    const start = i;
    while (i < source.length) {
      if (source.startsWith("{{", i)) i = skipMustache(i);
      else if (i > start && source[i] === "<" && /[A-Za-z!?/]/.test(source[i + 1] ?? "")) break;
      else i++;
    }
    parent.children.push(source.slice(start, i));
  }
  return root.children;
}

/** Splits `a {{b}} c` into its static and interpolated parts. */
export function parseValue(raw: string): Value {
  if (!raw.includes("{{")) return raw;
  const parts: (string | Expr)[] = [];
  let i = 0;
  while (i < raw.length) {
    const start = raw.indexOf("{{", i);
    if (start === -1) {
      parts.push(raw.slice(i));
      break;
    }
    const end = mustacheEnd(raw, start + 2);
    if (end === -1) {
      parts.push(raw.slice(i));
      break;
    }
    if (start > i) parts.push(raw.slice(i, start));
    parts.push({ e: raw.slice(start + 2, end).trim() || "undefined" });
    i = end + 2;
  }
  return parts;
}

/**
 * Returns the index of the `}}` that ends an expression starting at `start`, or -1.
 * A `}}` inside a string literal does not end it, unless the literal is unterminated.
 */
function mustacheEnd(source: string, start: number): number {
  let quote: string | undefined;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "}" && source[i + 1] === "}") {
      return i;
    }
  }
  return quote ? source.indexOf("}}", start) : -1;
}

/** Parses an attribute value. Whitespace around a lone interpolation is ignored, so `" {{ 1 }} "` is the number 1. */
function parseAttribute(raw: string): Value {
  const value = parseValue(raw);
  if (typeof value === "string") return value;
  const exprs = value.filter((part) => typeof part !== "string");
  const padding = value.every((part) => typeof part !== "string" || part.trim() === "");
  return exprs.length === 1 && padding ? exprs : value;
}

const EVENT_ATTR = /^(capture-bind|capture-catch|mut-bind|bind|catch):?(.+)$/;

/** Compiles one WXML file. `file` is its Mini Program root-relative path. */
export function compileWxml(source: string, file: string): WxmlFile {
  const result: WxmlFile = {
    path: file,
    nodes: [],
    // No prototype, so a template may be named `__proto__` or `constructor`
    templates: Object.create(null) as Record<string, TemplateNode[]>,
    imports: [],
    includes: [],
    wxs: [],
  };
  let uid = 0;
  const resolve = (src: string, ext: string) => {
    const joined = src.startsWith("/")
      ? path.posix.normalize(src.slice(1))
      : path.posix.join(path.posix.dirname(file), src);
    return joined.endsWith(ext) ? joined : joined + ext;
  };

  const compileChildren = (raw: RawNode[], parentTag: string | undefined): TemplateNode[] => {
    const out: TemplateNode[] = [];
    // The open wx:if chain that a following wx:elif or wx:else extends
    let chain: IfNode | undefined;
    for (const child of raw) {
      if (typeof child === "string") {
        // Whitespace between tags is layout, except inside <text>, which shows it
        if (parentTag !== "text" && child.trim() === "") continue;
        out.push({ type: "text", uid: uid++, value: parseValue(child) });
        chain = undefined;
        continue;
      }
      const attrs = new Map(child.attrs);
      if (child.tag === "import") {
        const src = attrs.get("src");
        if (src) result.imports.push(resolve(src, ".wxml"));
        continue;
      }
      if (child.tag === "wxs") {
        const module = attrs.get("module");
        const src = attrs.get("src");
        if (module) {
          result.wxs.push(
            src
              ? { module, src: resolve(src, ".wxs") }
              : { module, code: typeof child.children[0] === "string" ? child.children[0] : "" },
          );
        }
        continue;
      }
      if (child.tag === "template" && attrs.has("name")) {
        result.templates[attrs.get("name")!] = compileChildren(child.children, undefined);
        continue;
      }

      let node = compileElement(child, attrs);
      if (!node) continue;

      const forValue = attrs.get("wx:for") ?? attrs.get("wx:for-items");
      if (forValue !== undefined) {
        node = {
          type: "for",
          uid: uid++,
          list: parseAttribute(forValue),
          item: attrs.get("wx:for-item") ?? "item",
          index: attrs.get("wx:for-index") ?? "index",
          key: attrs.get("wx:key"),
          node: attrs.has("wx:if") ? wrapIf(attrs.get("wx:if")!, node) : node,
        };
        out.push(node);
        chain = undefined;
        continue;
      }

      if (attrs.has("wx:if")) {
        chain = wrapIf(attrs.get("wx:if")!, node);
        out.push(chain);
      } else if (attrs.has("wx:elif") && chain) {
        chain.branches.push({ test: parseAttribute(attrs.get("wx:elif")!), node });
      } else if (attrs.has("wx:else") && chain) {
        chain.branches.push({ node });
        chain = undefined;
      } else {
        out.push(node);
        chain = undefined;
      }
    }
    return out;
  };

  const wrapIf = (test: string, node: TemplateNode): IfNode => ({
    type: "if",
    uid: uid++,
    branches: [{ test: parseAttribute(test), node }],
  });

  const compileElement = (
    raw: RawElement,
    attrs: Map<string, string>,
  ): TemplateNode | undefined => {
    if (raw.tag === "include") {
      const src = attrs.get("src");
      if (!src) return undefined;
      const resolved = resolve(src, ".wxml");
      result.includes.push(resolved);
      return { type: "include", uid: uid++, src: resolved };
    }
    if (raw.tag === "template") {
      const data = attrs.get("data");
      return {
        type: "template",
        uid: uid++,
        is: parseAttribute(attrs.get("is") ?? ""),
        data: data === undefined ? undefined : parseAttribute(objectShorthand(data)),
      };
    }
    const element: ElementNode = {
      type: "element",
      uid: uid++,
      tag: BUILTIN_TAGS.has(raw.tag) ? `wx-${raw.tag}` : raw.tag,
      attrs: {},
      events: [],
      children: compileChildren(raw.children, raw.tag),
    };
    for (const [name, value] of raw.attrs) {
      if (name.startsWith("wx:")) continue;
      const event = EVENT_ATTR.exec(name);
      if (event) {
        const kind = event[1]!;
        element.events.push({
          name: event[2]!,
          handler: parseAttribute(value),
          catch: kind.endsWith("catch"),
          capture: kind.startsWith("capture"),
        });
      } else {
        element.attrs[name] = parseAttribute(value);
      }
    }
    return element;
  };

  result.nodes = compileChildren(parseWxml(source, file), undefined);
  return result;
}

/** `{{a, b: 1}}` in a template's `data` is an object literal without its braces. */
function objectShorthand(raw: string): string {
  const match = /^\s*\{\{([\s\S]*)\}\}\s*$/.exec(raw);
  if (!match) return raw;
  const body = match[1]!.trim();
  return body.startsWith("{") && body.endsWith("}") ? raw : `{{ {${body}} }}`;
}
