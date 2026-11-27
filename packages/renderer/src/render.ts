/** Turns a scope's template and data into virtual nodes. Pure: no DOM access. */
import type {
  ElementNode,
  ScopeDefinition,
  TemplateNode,
  Value,
  WebviewBundle,
  WxmlFile,
} from "@omr/compiler";
import { evaluateValue, toText } from "./expression.ts";

export interface VText {
  kind: "text";
  /** Identity among siblings, from the template position and `wx:key`. */
  key: string;
  text: string;
  node?: Text;
}

export interface VEvent {
  name: string;
  handler: string;
  catch: boolean;
  capture: boolean;
}

export interface VElement {
  kind: "element";
  key: string;
  tag: string;
  /** DOM attributes and built-in component properties; `class` is scoped and `style` has px instead of rpx. */
  attrs: Record<string, unknown>;
  events: VEvent[];
  children: VNode[];
  /** The page (0) or component whose template produced this element. */
  ownerId: number;
  /** Set on a custom component's host: its path and the raw values of every attribute. */
  component?: { path: string; props: Record<string, unknown> };
  /** Set on a `<slot>` of a component template: the slot name, empty for the default slot. */
  slot?: string;
  /** The attributes whose bindings read data a `setData` wrote since the last render, even with the same value. */
  written?: string[];
  el?: HTMLElement;
}

export type VNode = VText | VElement;

export interface RenderScope {
  /** 0 for the page. */
  nodeId: number;
  def: ScopeDefinition;
  data: Record<string, unknown>;
  /** Maps the `class` value written in this scope's template to the classes the element gets. */
  transformClass(value: string): string;
  /** For a component with `componentGenerics`: the component path each generic tag renders. */
  generics?: Record<string, string>;
  /** The top-level data keys a `setData` wrote since the last render. */
  written?: ReadonlySet<string>;
}

export interface RenderEnv {
  bundle: WebviewBundle;
  /** The WXS modules visible in a file, by module name. */
  wxsModules(file: WxmlFile): Record<string, unknown>;
  /** Converts rpx in inline styles. */
  convertStyle(style: string): string;
  /** Resolves a resource path, such as an image `src`, written in the given `.wxml` file. */
  resolveAsset(src: string, file: string): string;
}

interface Context {
  scope: RenderScope;
  file: WxmlFile;
  /** The scope's data, or the `data` of a `<template is>`. */
  data: Record<string, unknown>;
  /** `wx:for` item and index variables. */
  vars?: Map<string, unknown>;
  /** The names, data keys or variables, whose values a `setData` wrote since the last render. */
  written: ReadonlySet<string>;
  /** How many templates and includes this node is rendered inside. */
  depth: number;
}

/** Deeper than this, a template or include is taken to render itself without end. */
const MAX_DEPTH = 64;

/** Renders a page or component scope. */
export function renderScope(scope: RenderScope, env: RenderEnv): VNode[] {
  const file = env.bundle.files[scope.def.template];
  if (!file) return [];
  const out: VNode[] = [];
  const written = scope.written ?? new Set();
  renderNodes(file.nodes, { scope, file, data: scope.data, depth: 0, written }, "", out, env);
  return out;
}

function lookupIn(ctx: Context, env: RenderEnv) {
  return (name: string): unknown => {
    if (ctx.vars?.has(name)) return ctx.vars.get(name);
    if (Object.hasOwn(ctx.data, name)) return ctx.data[name];
    return env.wxsModules(ctx.file)[name];
  };
}

/** Evaluates a value and tells whether it read a name a `setData` wrote since the last render. */
function evaluateWritten(value: Value, ctx: Context, env: RenderEnv): [unknown, boolean] {
  const lookup = lookupIn(ctx, env);
  if (ctx.written.size === 0) return [evaluateValue(value, lookup), false];
  let read = false;
  const result = evaluateValue(value, (name) => {
    if (ctx.written.has(name)) read = true;
    return lookup(name);
  });
  return [result, read];
}

function renderNodes(
  nodes: TemplateNode[],
  ctx: Context,
  prefix: string,
  out: VNode[],
  env: RenderEnv,
): void {
  const lookup = lookupIn(ctx, env);
  for (const node of nodes) {
    const key = `${prefix}${node.uid}`;
    switch (node.type) {
      case "text":
        out.push({ kind: "text", key, text: toText(evaluateValue(node.value, lookup)) });
        break;
      case "if": {
        const index = node.branches.findIndex(
          (branch) => !branch.test || evaluateValue(branch.test, lookup),
        );
        if (index !== -1)
          renderNodes([node.branches[index]!.node], ctx, `${key}.${index}/`, out, env);
        break;
      }
      case "for": {
        const [list, listWritten] = evaluateWritten(node.list, ctx, env);
        // The item and index of a written list are written; otherwise they hide data of their names
        const written = new Set(ctx.written);
        for (const name of [node.item, node.index]) {
          if (listWritten) written.add(name);
          else written.delete(name);
        }
        for (const [index, item] of listEntries(list)) {
          const itemKey =
            node.key === undefined
              ? index
              : node.key === "*this"
                ? item
                : (item as Record<string, unknown> | null)?.[node.key];
          const vars = new Map(ctx.vars);
          vars.set(node.item, item);
          vars.set(node.index, index);
          renderNodes(
            [node.node],
            { ...ctx, vars, written },
            `${key}:${toText(itemKey)}/`,
            out,
            env,
          );
        }
        break;
      }
      case "include": {
        const file = env.bundle.files[node.src];
        if (!file || tooDeep(ctx, node.src)) break;
        renderNodes(file.nodes, { ...ctx, file, depth: ctx.depth + 1 }, `${key}/`, out, env);
        break;
      }
      case "template": {
        const name = toText(evaluateValue(node.is, lookup));
        const found = findTemplate(name, ctx.file, env.bundle);
        if (!found) {
          if (name) console.warn(`[omr] template "${name}" is not defined in ${ctx.file.path}`);
          break;
        }
        if (tooDeep(ctx, `template "${name}"`)) break;
        const [value, dataWritten] =
          node.data === undefined ? [{}, false] : evaluateWritten(node.data, ctx, env);
        const data = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
        renderNodes(
          found.nodes,
          {
            scope: ctx.scope,
            file: found.file,
            data,
            depth: ctx.depth + 1,
            // The template's data is written when what it was made from was
            written: new Set(dataWritten ? Object.keys(data) : []),
          },
          `${key}=${name}/`,
          out,
          env,
        );
        break;
      }
      case "element":
        renderElement(node, ctx, key, out, env);
        break;
    }
  }
}

function tooDeep(ctx: Context, what: string): boolean {
  if (ctx.depth < MAX_DEPTH) return false;
  console.warn(`[omr] ${what} in ${ctx.file.path} is nested ${MAX_DEPTH} deep; it renders itself`);
  return true;
}

/** Templates visible in a file: its own and those of the files it imports, but not their imports. */
function findTemplate(name: string, file: WxmlFile, bundle: WebviewBundle) {
  // The bundle comes through JSON, so `templates` inherits from Object.prototype again
  if (Object.hasOwn(file.templates, name)) return { nodes: file.templates[name]!, file };
  for (const imported of file.imports) {
    const target = bundle.files[imported];
    if (target && Object.hasOwn(target.templates, name)) {
      return { nodes: target.templates[name]!, file: target };
    }
  }
  return undefined;
}

/** What `wx:for` iterates: arrays, objects by key, strings by character and numbers as ranges. */
function listEntries(list: unknown): [string | number, unknown][] {
  if (Array.isArray(list)) return list.map((item, index) => [index, item]);
  if (typeof list === "number") {
    return Array.from({ length: Math.max(0, Math.floor(list)) }, (_, index) => [index, index]);
  }
  if (typeof list === "string") return list.split("").map((char, index) => [index, char]);
  if (list && typeof list === "object") return Object.entries(list);
  return [];
}

/** Attributes whose value is a resource path. */
const ASSET_ATTRIBUTES = new Set(["src", "poster"]);
/** Attributes whose value is a list of classes written in the template's scope. */
const CLASS_ATTRIBUTES = new Set(["class", "hover-class", "placeholder-class"]);
/** Host attributes that the view uses; the other host attributes are only component properties. */
const HOST_DOM_ATTRIBUTES = new Set(["id", "class", "style", "hidden", "slot"]);
/**
 * Components WeChat documents for the Skyline renderer. The compiler keeps
 * their tags, since a project may name its own components so; when none is,
 * they render as the simulator's built-ins of the same name.
 */
const SKYLINE_TAGS = new Set([
  "list-view",
  "grid-view",
  "sticky-header",
  "sticky-section",
  "draggable-sheet",
  "nested-scroll-header",
  "nested-scroll-body",
  "list-builder",
  "grid-builder",
  "open-container",
  "snapshot",
  "span",
  "large-image",
  "open-data-item",
  "open-data-list",
  "tap-gesture-handler",
  "double-tap-gesture-handler",
  "pan-gesture-handler",
  "scale-gesture-handler",
  "long-press-gesture-handler",
  "force-press-gesture-handler",
  "horizontal-drag-gesture-handler",
  "vertical-drag-gesture-handler",
]);

function renderElement(
  node: ElementNode,
  ctx: Context,
  key: string,
  out: VNode[],
  env: RenderEnv,
): void {
  const { scope } = ctx;
  const lookup = lookupIn(ctx, env);
  if (node.tag === "block") {
    renderNodes(node.children, ctx, `${key}/`, out, env);
    return;
  }
  if (node.tag === "slot") {
    // A page has no slots
    if (scope.nodeId === 0) return;
    out.push({
      kind: "element",
      key,
      tag: "omr-slot",
      attrs: {},
      events: [],
      children: [],
      ownerId: scope.nodeId,
      slot: toText(evaluateValue(node.attrs.name ?? "", lookup)),
    });
    return;
  }

  const raw: Record<string, unknown> = {};
  const written: string[] = [];
  for (const [name, value] of Object.entries(node.attrs)) {
    const [result, read] = evaluateWritten(value, ctx, env);
    raw[name] = result;
    if (read) written.push(name);
  }
  const componentPath = scope.def.usingComponents[node.tag] ?? scope.generics?.[node.tag];
  const attrs: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (componentPath && !HOST_DOM_ATTRIBUTES.has(name) && !name.startsWith("data-")) continue;
    if (CLASS_ATTRIBUTES.has(name)) {
      attrs[name] =
        name !== "class" && value === "none" ? value : scope.transformClass(toText(value));
    } else if (name === "style" || name === "placeholder-style") {
      attrs[name] = env.convertStyle(toText(value));
    } else if (ASSET_ATTRIBUTES.has(name) && typeof value === "string" && value !== "") {
      attrs[name] = env.resolveAsset(value, ctx.file.path);
    } else {
      attrs[name] = value;
    }
  }
  const children: VNode[] = [];
  renderNodes(node.children, ctx, "", children, env);
  out.push({
    kind: "element",
    key,
    tag: !componentPath && SKYLINE_TAGS.has(node.tag) ? `wx-${node.tag}` : node.tag,
    attrs,
    events: node.events.map((event) => ({
      name: event.name,
      handler: toText(evaluateValue(event.handler, lookup)),
      catch: event.catch,
      capture: event.capture,
    })),
    children,
    ownerId: scope.nodeId,
    component: componentPath ? { path: componentPath, props: raw } : undefined,
    ...(written.length > 0 && { written }),
  });
}

/**
 * Converts rpx to px for a window width, as WeChat does: 750rpx is the window
 * width, rounded down, and a non-zero value never rounds to 0 (it becomes 1px,
 * or 0.5px on iOS devices with a pixel ratio above 1).
 */
export function convertRpx(css: string, windowWidth: number, hairline = 1): string {
  return css.replace(/(?<![\d.])(-?(?:\d+(?:\.\d*)?|\.\d+))rpx\b/g, (_, number: string) => {
    const value = Number(number);
    const px = Math.floor((Math.abs(value) * windowWidth) / 750 + 0.0001);
    const result = px === 0 && value !== 0 ? hairline : px;
    return `${value < 0 ? -result : result}px`;
  });
}
