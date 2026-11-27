/**
 * The content model of `<editor>`, independent of the DOM so it can be tested:
 * the content is a flat list of items, each one position long, as Quill
 * counts them. A text line is its characters and images followed by a line
 * end that carries the line's formats; a divider is a line of its own, and
 * so is a custom block, a divider with the `blockId` an `<editor-portal>`
 * fills. The last item is always a line end.
 *
 * The editor reads its DOM into items, edits the items and renders them back,
 * and exports them as WeChat does: `html` with `<p>` blocks, `text` and a
 * Quill-like `delta`.
 */
import { toText as stringOf } from "../expression.ts";

export type Value = string | number | boolean;
export type Formats = Record<string, Value>;

export type Item =
  | { kind: "char"; char: string; formats: Formats }
  | { kind: "image"; src: string; props: Record<string, string>; formats: Formats }
  | { kind: "line"; formats: Formats }
  | { kind: "divider"; blockId?: string };

export interface DeltaOp {
  insert: string | Record<string, unknown>;
  attributes?: Record<string, unknown>;
}

/** Formats of characters, as `EditorContext.format` names them. */
const INLINE_CSS = [
  "font",
  "fontSize",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontFamily",
  "letterSpacing",
  "textDecoration",
];
const INLINE = new Set([
  "bold",
  "italic",
  "underline",
  "strike",
  "ins",
  "script",
  "link",
  "color",
  "backgroundColor",
  ...INLINE_CSS,
]);
/** Formats of lines. */
const BLOCK_CSS = [
  "margin",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "padding",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "lineHeight",
  "textIndent",
  "wordWrap",
  "wordBreak",
  "whiteSpace",
];
const BLOCK = new Set(["header", "align", "direction", "indent", "list", ...BLOCK_CSS]);
/** Formats that are on or off. */
const TOGGLES = new Set(["bold", "italic", "underline", "strike", "ins"]);
/** Attributes of an inserted image that the html and the delta keep. */
const IMAGE_PROPS = ["alt", "width", "height", "class", "data-custom", "data-local"];
const MAX_INDENT = 8;

export const isFormatName = (name: string) => INLINE.has(name) || BLOCK.has(name);
/** Only the character formats of a set, with pending changes applied (null removes one). */
export const inlineFormats = (formats: Formats, pending: Record<string, Value | null> = {}) => {
  const out: Formats = {};
  for (const [name, value] of Object.entries({ ...formats, ...pending })) {
    if (INLINE.has(name) && value !== null) out[name] = value;
  }
  return out;
};
const kebab = (name: string) => name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
const camel = (name: string) => name.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());

/** `rgb(255, 0, 0)` as `#ff0000`; WeChat reports colors in hex. Other values are kept. */
export function toHex(color: string): string {
  const match = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(color.trim());
  if (!match) return color.trim();
  return `#${match
    .slice(1, 4)
    .map((part) => Math.min(255, Number(part)).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** An empty document: one empty line. */
export const emptyItems = (): Item[] => [{ kind: "line", formats: {} }];

const sameFormats = (a: Formats, b: Formats) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

/** The formats every one of the sets has with the same value. */
const common = (sets: Formats[]): Formats => {
  const [first, ...rest] = sets;
  if (!first) return {};
  return Object.fromEntries(
    Object.entries(first).filter(([key, value]) => rest.every((set) => set[key] === value)),
  );
};

/** The line end of the line a position is in. */
const lineEndOf = (items: Item[], index: number) => {
  for (let i = Math.max(0, index); i < items.length; i++) if (items[i]!.kind === "line") return i;
  return items.length - 1;
};

/** The line ends of the lines a range touches. */
const lineEndsIn = (items: Item[], index: number, length: number) => {
  const last = lineEndOf(items, length > 0 ? index + length - 1 : index);
  const ends: number[] = [];
  for (let i = index; i <= last; i++) if (items[i]?.kind === "line") ends.push(i);
  return ends;
};

/** Keeps a range inside the document, before its last line end. */
export function clampRange(items: Item[], index: number, length: number) {
  const max = items.length - 1;
  const start = Math.min(Math.max(0, Math.floor(index) || 0), max);
  return { index: start, length: Math.min(Math.max(0, Math.floor(length) || 0), max - start) };
}

/**
 * The formats of a range, as `bindstatuschange` reports them: the character
 * formats all of its characters share (at a cursor, those of the character
 * before it) and the line formats all of its lines share.
 */
export function formatsAt(items: Item[], index: number, length: number): Formats {
  const range = clampRange(items, index, length);
  let inline: Formats = {};
  if (range.length === 0) {
    const before = items[range.index - 1];
    const at = items[range.index];
    const leaf =
      before && (before.kind === "char" || before.kind === "image")
        ? before
        : at && (at.kind === "char" || at.kind === "image")
          ? at
          : undefined;
    inline = leaf ? { ...leaf.formats } : {};
  } else {
    const leaves = items
      .slice(range.index, range.index + range.length)
      .flatMap((item) => (item.kind === "char" || item.kind === "image" ? [item.formats] : []));
    inline = common(leaves);
  }
  const lines = lineEndsIn(items, range.index, range.length).map(
    (i) => (items[i] as { formats: Formats }).formats,
  );
  return { ...inline, ...common(lines) };
}

/** A format value as the model keeps it; undefined for a value that removes the format. */
export function normalizeFormat(name: string, value: unknown): Value | undefined {
  if (TOGGLES.has(name)) return true;
  if (value === undefined || value === null || value === "" || value === false) return undefined;
  if (name === "header") {
    const level = Number(/\d/.exec(stringOf(value))?.[0]);
    return level >= 1 && level <= 6 ? level : undefined;
  }
  if (name === "color" || name === "backgroundColor") return toHex(stringOf(value));
  return stringOf(value);
}

/**
 * `EditorContext.format(name, value)` on a range. Formatting a range that
 * already has the format with that value removes it. A collapsed range
 * changes only its lines; character formats then wait in `pending` for the
 * next typed text.
 */
export function applyFormat(
  items: Item[],
  index: number,
  length: number,
  name: string,
  value: unknown,
  pending: Record<string, Value | null> = {},
): { items: Item[]; pending: Record<string, Value | null> } {
  const range = clampRange(items, index, length);
  const current = { ...formatsAt(items, range.index, range.length), ...pending };
  const next = items.map((item) =>
    item.kind === "divider" ? item : { ...item, formats: { ...item.formats } },
  ) as Item[];
  if (BLOCK.has(name)) {
    const ends = lineEndsIn(next, range.index, range.length);
    for (const i of ends) {
      const formats = (next[i] as { formats: Formats }).formats;
      if (name === "indent") {
        const step = String(value).trim() === "-1" ? -1 : 1;
        const level = Math.min(MAX_INDENT, Math.max(0, Number(formats.indent ?? 0) + step));
        if (level === 0) delete formats.indent;
        else formats.indent = level;
        continue;
      }
      const wanted = normalizeFormat(name, value);
      if (wanted === undefined || current[name] === wanted) delete formats[name];
      else {
        formats[name] = wanted;
        // A line is a header or a list item, not both
        if (name === "header") delete formats.list;
        if (name === "list") delete formats.header;
      }
    }
    return { items: next, pending };
  }
  if (!INLINE.has(name)) return { items, pending };
  const wanted = normalizeFormat(name, value);
  const result = wanted === undefined || current[name] === wanted ? undefined : wanted;
  if (range.length === 0) return { items, pending: { ...pending, [name]: result ?? null } };
  for (const item of next.slice(range.index, range.index + range.length)) {
    if (item.kind !== "char" && item.kind !== "image") continue;
    if (result === undefined) delete item.formats[name];
    else item.formats[name] = result;
  }
  return { items: next, pending };
}

/** `EditorContext.removeFormat`: the range's characters and lines lose every format. */
export function removeFormats(items: Item[], index: number, length: number): Item[] {
  const range = clampRange(items, index, length);
  const ends = new Set(lineEndsIn(items, range.index, range.length));
  return items.map((item, i) => {
    if (item.kind === "line") return ends.has(i) ? { kind: "line", formats: {} } : item;
    if (item.kind === "divider" || i < range.index || i >= range.index + range.length) return item;
    return { ...item, formats: {} };
  });
}

/**
 * Replaces a range with new items. A line end in what is inserted splits the
 * line, and both parts keep the line's formats.
 */
export function replaceRange(
  items: Item[],
  index: number,
  length: number,
  inserted: Item[],
): Item[] {
  const range = clampRange(items, index, length);
  const next = [...items];
  next.splice(range.index, range.length);
  const lineFormats = (next[lineEndOf(next, range.index)] as { formats: Formats }).formats;
  next.splice(
    range.index,
    0,
    ...inserted.map((item) =>
      item.kind === "line" ? { kind: "line" as const, formats: { ...lineFormats } } : item,
    ),
  );
  return next;
}

/** Items for plain text with character formats; `\n` ends a line. */
export const textItems = (text: string, formats: Formats = {}): Item[] =>
  text
    .replace(/\r\n?/g, "\n")
    .split("")
    .map((char) =>
      char === "\n"
        ? { kind: "line", formats: {} }
        : { kind: "char", char, formats: { ...formats } },
    );

// Export

const escapeText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (text: string) => escapeText(text).replace(/"/g, "&quot;");

type Leaf = Extract<Item, { kind: "char" | "image" }>;
type Block =
  | { kind: "line"; leaves: Leaf[]; formats: Formats }
  | Extract<Item, { kind: "divider" }>;

/** The items as lines. */
function blocksOf(items: Item[]): Block[] {
  const blocks: Block[] = [];
  let leaves: Leaf[] = [];
  for (const item of items) {
    if (item.kind === "char" || item.kind === "image") leaves.push(item);
    else if (item.kind === "line") {
      blocks.push({ kind: "line", leaves, formats: item.formats });
      leaves = [];
    } else {
      if (leaves.length > 0) blocks.push({ kind: "line", leaves, formats: {} });
      leaves = [];
      blocks.push(item);
    }
  }
  if (leaves.length > 0) blocks.push({ kind: "line", leaves, formats: {} });
  return blocks;
}

/** Adjacent characters with the same formats, as text runs. */
function runsOf(leaves: Leaf[]): (Leaf | { kind: "text"; text: string; formats: Formats })[] {
  const runs: (Leaf | { kind: "text"; text: string; formats: Formats })[] = [];
  for (const leaf of leaves) {
    const last = runs.at(-1);
    if (leaf.kind === "char") {
      if (last?.kind === "text" && sameFormats(last.formats, leaf.formats)) last.text += leaf.char;
      else runs.push({ kind: "text", text: leaf.char, formats: leaf.formats });
    } else runs.push(leaf);
  }
  return runs;
}

/** Wraps HTML in the tags and inline styles of character formats. */
function wrapInline(html: string, formats: Formats): string {
  let out = html;
  if (formats.script === "sub") out = `<sub>${out}</sub>`;
  if (formats.script === "super") out = `<sup>${out}</sup>`;
  if (formats.ins) out = `<ins>${out}</ins>`;
  if (formats.strike) out = `<s>${out}</s>`;
  if (formats.underline) out = `<u>${out}</u>`;
  if (formats.italic) out = `<em>${out}</em>`;
  if (formats.bold) out = `<strong>${out}</strong>`;
  const styles = ["color", "backgroundColor", ...INLINE_CSS]
    .filter((name) => formats[name] !== undefined)
    .map((name) => `${kebab(name)}: ${String(formats[name])};`);
  if (styles.length > 0) out = `<span style="${escapeAttribute(styles.join(" "))}">${out}</span>`;
  if (formats.link !== undefined) {
    out = `<a href="${escapeAttribute(String(formats.link))}" target="_blank">${out}</a>`;
  }
  return out;
}

/** The attributes of a line's element: alignment and block styles inline, indentation as Quill's class. */
function blockAttributes(formats: Formats): string {
  const styles: string[] = [];
  if (formats.align !== undefined) styles.push(`text-align: ${String(formats.align)};`);
  if (formats.direction !== undefined) styles.push(`direction: ${String(formats.direction)};`);
  for (const name of BLOCK_CSS) {
    if (formats[name] !== undefined) styles.push(`${kebab(name)}: ${String(formats[name])};`);
  }
  let out = "";
  if (formats.indent !== undefined) out += ` class="ql-indent-${Number(formats.indent)}"`;
  if (styles.length > 0) out += ` style="${escapeAttribute(styles.join(" "))}"`;
  return out;
}

export interface HtmlOptions {
  /** The URL an image source is shown from in the page; the exported html keeps the source. */
  imageUrl?: (src: string) => string;
}

/** The items as WeChat's editor exports them: `<p>` per line, headers, lists, `<hr>` and `<img>`. */
export function toHtml(items: Item[], { imageUrl }: HtmlOptions = {}): string {
  let html = "";
  let list: { tag: string; type: string } | undefined;
  const closeList = () => {
    if (list) html += `</${list.tag}>`;
    list = undefined;
  };
  for (const block of blocksOf(items)) {
    if (block.kind === "divider") {
      closeList();
      html +=
        block.blockId === undefined
          ? "<hr>"
          : `<div data-block-id="${escapeAttribute(block.blockId)}" contenteditable="false"></div>`;
      continue;
    }
    const inner =
      block.leaves.length === 0
        ? "<br>"
        : runsOf(block.leaves)
            .map((run) => {
              if (run.kind === "text") return wrapInline(escapeText(run.text), run.formats);
              if (run.kind === "char") return wrapInline(escapeText(run.char), run.formats);
              const attributes = IMAGE_PROPS.filter((name) => run.props[name] !== undefined)
                .map((name) => ` ${name}="${escapeAttribute(run.props[name]!)}"`)
                .join("");
              const shown = imageUrl ? imageUrl(run.src) : run.src;
              // What the page shows keeps the source, and fits images in the editor
              const source = imageUrl
                ? ` data-omr-src="${escapeAttribute(run.src)}" style="max-width: 100%;"`
                : "";
              return wrapInline(
                `<img src="${escapeAttribute(shown)}"${source}${attributes}>`,
                run.formats,
              );
            })
            .join("");
    const type = block.formats.list === undefined ? undefined : String(block.formats.list);
    if (type === undefined) closeList();
    else if (list?.type !== type) {
      closeList();
      list = { tag: type === "ordered" ? "ol" : "ul", type };
      html += type === "check" ? `<ul data-checked="false">` : `<${list.tag}>`;
    }
    const tag =
      type !== undefined ? "li" : block.formats.header ? `h${Number(block.formats.header)}` : "p";
    html += `<${tag}${blockAttributes(block.formats)}>${inner}</${tag}>`;
  }
  closeList();
  return html;
}

/** The plain text: each line ends with `\n`; images and dividers have none. */
export const toText = (items: Item[]) =>
  items
    .map((item) => (item.kind === "char" ? item.char : item.kind === "line" ? "\n" : ""))
    .join("");

const withAttributes = (op: DeltaOp, attributes: Record<string, unknown>) =>
  Object.keys(attributes).length > 0 ? { ...op, attributes } : op;

/**
 * A Quill-like delta: text with its formats, `\n` with the line's formats,
 * image and divider embeds, and custom blocks as `{ customBlock: { blockId } }`,
 * since WeChat documents only that the delta keeps the block id.
 */
export function toDelta(items: Item[]): { ops: DeltaOp[] } {
  const ops: DeltaOp[] = [];
  const push = (op: DeltaOp) => {
    const last = ops.at(-1);
    if (
      last &&
      typeof last.insert === "string" &&
      typeof op.insert === "string" &&
      sameFormats((last.attributes ?? {}) as Formats, (op.attributes ?? {}) as Formats)
    ) {
      last.insert += op.insert;
    } else ops.push(op);
  };
  for (const item of items) {
    if (item.kind === "char") push(withAttributes({ insert: item.char }, item.formats));
    else if (item.kind === "line") push(withAttributes({ insert: "\n" }, item.formats));
    else if (item.kind === "image") {
      push(withAttributes({ insert: { image: item.src } }, { ...item.props, ...item.formats }));
    } else if (item.blockId !== undefined)
      push({ insert: { customBlock: { blockId: item.blockId } } });
    else push({ insert: { divider: true } });
  }
  return { ops };
}

const pick = (attributes: Record<string, unknown>, names: Set<string>): Formats =>
  Object.fromEntries(
    Object.entries(attributes).flatMap(([name, value]) => {
      if (!names.has(name)) return [];
      const normalized = normalizeFormat(name, value);
      return normalized === undefined
        ? []
        : [[name, name === "indent" ? Number(value) : normalized]];
    }),
  );

/** The items of a delta, as `setContents({ delta })` takes it: `{ ops }` or the ops themselves. */
export function fromDelta(delta: unknown): Item[] {
  const ops = Array.isArray(delta)
    ? delta
    : Array.isArray((delta as { ops?: unknown } | null)?.ops)
      ? (delta as { ops: unknown[] }).ops
      : [];
  const items: Item[] = [];
  for (const op of ops as DeltaOp[]) {
    const attributes = (op?.attributes ?? {}) as Record<string, unknown>;
    if (typeof op?.insert === "string") {
      for (const char of op.insert.replace(/\r\n?/g, "\n").split("")) {
        items.push(
          char === "\n"
            ? { kind: "line", formats: pick(attributes, BLOCK) }
            : { kind: "char", char, formats: pick(attributes, INLINE) },
        );
      }
    } else if (op?.insert && typeof op.insert === "object") {
      if (typeof op.insert.image === "string") {
        const props = Object.fromEntries(
          IMAGE_PROPS.flatMap((name) =>
            attributes[name] === undefined ? [] : [[name, stringOf(attributes[name])]],
          ),
        );
        items.push({
          kind: "image",
          src: op.insert.image,
          props,
          formats: pick(attributes, INLINE),
        });
      } else if (op.insert.divider) items.push({ kind: "divider" });
      else if (typeof op.insert.customBlock === "object" && op.insert.customBlock !== null) {
        const { blockId } = op.insert.customBlock as { blockId?: unknown };
        items.push({ kind: "divider", blockId: stringOf(blockId) });
      }
    }
  }
  if (items.at(-1)?.kind !== "line") items.push({ kind: "line", formats: {} });
  return items;
}

// Reading HTML

/** The part of a DOM node the reader uses, so it reads a page's DOM and plain objects alike. */
export interface MiniNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<MiniNode>;
  getAttribute?(name: string): string | null;
}

/** A position in the DOM, as a Selection gives it. */
export interface DomPoint {
  node: unknown;
  offset: number;
}

const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "BLOCKQUOTE",
  "PRE",
  "SECTION",
  "ARTICLE",
  "HEADER",
  "FOOTER",
]);
const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "HEAD", "TITLE", "META"]);

/** `a: b; c: d` as `{ a: "b", c: "d" }`. */
export function parseStyle(style: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const declaration of (style ?? "").split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const name = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (name && value) out[name] = value;
  }
  return out;
}

const attribute = (node: MiniNode, name: string) => node.getAttribute?.(name) ?? null;

/** The character formats an inline element adds. */
function inlineFormatsOf(node: MiniNode): Formats {
  const formats: Formats = {};
  switch (node.nodeName) {
    case "B":
    case "STRONG":
      formats.bold = true;
      break;
    case "I":
    case "EM":
      formats.italic = true;
      break;
    case "U":
      formats.underline = true;
      break;
    case "S":
    case "STRIKE":
    case "DEL":
      formats.strike = true;
      break;
    case "INS":
      formats.ins = true;
      break;
    case "SUB":
      formats.script = "sub";
      break;
    case "SUP":
      formats.script = "super";
      break;
    case "A": {
      const href = attribute(node, "href");
      if (href) formats.link = href;
      break;
    }
  }
  const style = parseStyle(attribute(node, "style"));
  for (const [property, value] of Object.entries(style)) {
    const name = camel(property);
    if (name === "fontWeight" && (value === "bold" || Number(value) >= 600)) formats.bold = true;
    else if (name === "fontStyle" && value === "italic") formats.italic = true;
    else if (name === "textDecoration" && /underline|line-through/.test(value)) {
      if (value.includes("underline")) formats.underline = true;
      if (value.includes("line-through")) formats.strike = true;
    } else if (name === "color" || name === "backgroundColor") formats[name] = toHex(value);
    else if (INLINE_CSS.includes(name)) formats[name] = value;
  }
  return formats;
}

/** The line formats a block element sets. */
function blockFormatsOf(node: MiniNode, list?: string): Formats {
  const formats: Formats = {};
  const header = /^H([1-6])$/.exec(node.nodeName);
  if (header) formats.header = Number(header[1]);
  if (node.nodeName === "LI" && list) formats.list = list;
  for (const name of (attribute(node, "class") ?? "").split(/\s+/)) {
    const indent = /^ql-indent-(\d)$/.exec(name);
    if (indent) formats.indent = Number(indent[1]);
    const align = /^ql-align-(\w+)$/.exec(name);
    if (align) formats.align = align[1]!;
    if (name === "ql-direction-rtl") formats.direction = "rtl";
  }
  for (const [property, value] of Object.entries(parseStyle(attribute(node, "style")))) {
    const name = camel(property);
    if (name === "textAlign") formats.align = value;
    else if (name === "direction") formats.direction = value;
    else if (BLOCK_CSS.includes(name)) formats[name] = value;
  }
  return formats;
}

/**
 * Reads HTML into items, as the editor keeps its content: block elements are
 * lines, `<div>` included; a `<br>` ends a line unless it holds an empty
 * line open; tags the editor does not know keep their text. With points, also
 * returns the position of each, such as the ends of the selection.
 */
export function readHtml(
  root: MiniNode,
  points: DomPoint[] = [],
  imageSource: (node: MiniNode) => string = (node) =>
    attribute(node, "data-omr-src") ?? attribute(node, "src") ?? "",
): { items: Item[]; positions: (number | undefined)[] } {
  const items: Item[] = [];
  const positions: (number | undefined)[] = points.map(() => undefined);
  /** The characters and images of the line being read, before its end. */
  let open = false;
  /** Whether the last line ended at a `<br>`, which also holds an empty line open. */
  let brokeAtBr = false;
  const mark = (node: unknown, offset: number) => {
    points.forEach((point, i) => {
      if (positions[i] === undefined && point.node === node && point.offset === offset) {
        positions[i] = items.length;
      }
    });
  };
  const endLine = (formats: Formats) => {
    items.push({ kind: "line", formats: { ...formats } });
    open = false;
  };

  const walk = (node: MiniNode, inline: Formats, block: Formats, list?: string) => {
    const children = Array.from(node.childNodes);
    const container = node === root || node.nodeName === "OL" || node.nodeName === "UL";
    children.forEach((child, i) => {
      mark(node, i);
      if (child.nodeType === 3) {
        const text = child.nodeValue ?? "";
        // Indentation between blocks in HTML is not content
        if (container && text.trim() === "" && !open) {
          mark(child, 0);
          return;
        }
        // Positions count UTF-16 code units, as the DOM and Quill do
        text.split("").forEach((char, offset) => {
          mark(child, offset);
          if (char === "\u200b" || char === "\ufeff") return;
          if (char === "\n" || char === "\r") {
            endLine(block);
            brokeAtBr = false;
            return;
          }
          items.push({
            kind: "char",
            char: char === "\u00a0" ? " " : char,
            formats: { ...inline },
          });
          open = true;
          brokeAtBr = false;
        });
        mark(child, text.length);
        return;
      }
      if (child.nodeType !== 1 || SKIPPED_TAGS.has(child.nodeName)) return;
      const tag = child.nodeName;
      if (tag === "BR") {
        endLine(block);
        brokeAtBr = true;
        return;
      }
      const blockId = attribute(child, "data-block-id");
      if (tag === "HR" || blockId !== null) {
        if (open) endLine(block);
        items.push(blockId === null ? { kind: "divider" } : { kind: "divider", blockId });
        brokeAtBr = false;
        return;
      }
      if (tag === "IMG") {
        const props: Record<string, string> = {};
        for (const name of IMAGE_PROPS) {
          const value = attribute(child, name);
          if (value !== null) props[name] = value;
        }
        items.push({ kind: "image", src: imageSource(child), props, formats: { ...inline } });
        open = true;
        brokeAtBr = false;
        return;
      }
      if (tag === "OL" || tag === "UL") {
        if (open) endLine(block);
        const type =
          tag === "OL" ? "ordered" : attribute(child, "data-checked") !== null ? "check" : "bullet";
        walk(child, inline, block, type);
        return;
      }
      if (BLOCK_TAGS.has(tag)) {
        if (open) endLine(block);
        const formats = blockFormatsOf(child, list);
        const before = items.length;
        brokeAtBr = false;
        walk(child, {}, formats, list);
        // A block ends its line, unless it held only blocks or its last <br> did
        const hadBlocks = items.slice(before).some((item) => item.kind === "line") && !open;
        if (open || (!hadBlocks && !brokeAtBr)) endLine(formats);
        brokeAtBr = false;
        return;
      }
      walk(child, { ...inline, ...inlineFormatsOf(child) }, block, list);
    });
    mark(node, children.length);
  };

  walk(root, {}, {});
  if (open || items.length === 0 || items.at(-1)!.kind !== "line") endLine({});
  const last = items.length - 1;
  return {
    items,
    positions: positions.map((position) =>
      position === undefined ? undefined : Math.min(position, last),
    ),
  };
}

/**
 * Where a position is in the DOM `toHtml` rendered: in a text node when it
 * can be, else before a child of a line's element.
 */
export function locate(root: MiniNode, index: number): DomPoint {
  let remaining = index;
  let last: DomPoint = { node: root, offset: root.childNodes.length };
  const inLine = (line: MiniNode): DomPoint | undefined => {
    let result: DomPoint | undefined;
    let length = 0;
    const leaves: { node: MiniNode; parent: MiniNode; at: number; length: number }[] = [];
    const collect = (node: MiniNode) => {
      Array.from(node.childNodes).forEach((child, at) => {
        if (child.nodeType === 3) {
          leaves.push({ node: child, parent: node, at, length: (child.nodeValue ?? "").length });
        } else if (child.nodeName === "IMG")
          leaves.push({ node: child, parent: node, at, length: 1 });
        else if (child.nodeType === 1) collect(child);
      });
    };
    collect(line);
    for (const leaf of leaves) length += leaf.length;
    const offset = Math.max(0, remaining);
    if (offset <= length) {
      let left = offset;
      for (const leaf of leaves) {
        if (leaf.node.nodeType === 3 && left <= leaf.length) {
          result = { node: leaf.node, offset: left };
          break;
        }
        if (leaf.node.nodeType !== 3 && left === 0) {
          result = { node: leaf.parent, offset: leaf.at };
          break;
        }
        left -= leaf.length;
      }
      result ??= leaves.length
        ? { node: leaves.at(-1)!.parent, offset: leaves.at(-1)!.at + 1 }
        : { node: line, offset: 0 };
    }
    remaining -= length + 1;
    last = leaves.length
      ? { node: leaves.at(-1)!.parent, offset: leaves.at(-1)!.at + 1 }
      : { node: line, offset: 0 };
    return result;
  };
  for (const [at, block] of Array.from(root.childNodes).entries()) {
    if (block.nodeName === "HR" || attribute(block, "data-block-id") !== null) {
      // The position of a divider or custom block is the boundary before it
      if (remaining === 0) return { node: root, offset: at };
      remaining -= 1;
      continue;
    }
    const lines =
      block.nodeName === "OL" || block.nodeName === "UL"
        ? Array.from(block.childNodes).filter((child) => child.nodeName === "LI")
        : [block];
    for (const line of lines) {
      const found = inLine(line);
      if (found) return found;
    }
  }
  return last;
}
