import { describe, expect, test } from "vite-plus/test";
import {
  applyFormat,
  formatsAt,
  fromDelta,
  locate,
  readHtml,
  removeFormats,
  replaceRange,
  textItems,
  toDelta,
  toHtml,
  toText,
  type MiniNode,
} from "../src/components/editor-model.ts";

/** A DOM-like node, as the editor reads its area. */
const el = (
  name: string,
  children: MiniNode[] = [],
  attributes: Record<string, string> = {},
): MiniNode => ({
  nodeType: 1,
  nodeName: name.toUpperCase(),
  nodeValue: null,
  childNodes: children,
  getAttribute: (key) => attributes[key] ?? null,
});
const txt = (value: string): MiniNode => ({
  nodeType: 3,
  nodeName: "#text",
  nodeValue: value,
  childNodes: [],
});

describe("editor content", () => {
  test("reads the DOM into a delta with character and line formats", () => {
    const root = el("div", [
      el("h1", [txt("Title")]),
      el("p", [txt("a "), el("strong", [txt("bold")]), txt(" "), el("em", [txt("it")])], {
        style: "text-align: center;",
      }),
      el("ol", [el("li", [txt("one")]), el("li", [txt("two")])]),
      el("div", [el("a", [txt("link")], { href: "https://example.com" })]),
      el("hr"),
      el("p", [el("img", [], { src: "http://tmp/a.png", width: "50%" })]),
    ]);
    const { items } = readHtml(root);
    expect(toDelta(items).ops).toEqual([
      { insert: "Title" },
      { insert: "\n", attributes: { header: 1 } },
      { insert: "a " },
      { insert: "bold", attributes: { bold: true } },
      { insert: " " },
      { insert: "it", attributes: { italic: true } },
      { insert: "\n", attributes: { align: "center" } },
      { insert: "one" },
      { insert: "\n", attributes: { list: "ordered" } },
      { insert: "two" },
      { insert: "\n", attributes: { list: "ordered" } },
      { insert: "link", attributes: { link: "https://example.com" } },
      { insert: "\n" },
      { insert: { divider: true } },
      { insert: { image: "http://tmp/a.png" }, attributes: { width: "50%" } },
      { insert: "\n" },
    ]);
    expect(toText(items)).toBe("Title\na bold it\none\ntwo\nlink\n\n");
  });

  test("exports html with <p> blocks, as WeChat does", () => {
    const items = fromDelta({
      ops: [
        { insert: "Hi " },
        { insert: "there", attributes: { bold: true, color: "rgb(255, 0, 0)" } },
        { insert: "\n", attributes: { header: 2 } },
        { insert: "x\ny" },
        { insert: "\n", attributes: { list: "bullet" } },
        { insert: { image: "http://tmp/a.png" }, attributes: { "data-local": "http://tmp/a.png" } },
        { insert: "\n" },
      ],
    });
    expect(toHtml(items)).toBe(
      '<h2>Hi <span style="color: #ff0000;"><strong>there</strong></span></h2>' +
        "<p>x</p><ul><li>y</li></ul>" +
        '<p><img src="http://tmp/a.png" data-local="http://tmp/a.png"></p>',
    );
    expect(toHtml(fromDelta({ ops: [] }))).toBe("<p><br></p>");
    // The page shows the image from the simulator's file endpoint and keeps its source
    expect(toHtml(items, { imageUrl: (src) => `/fs?path=${src}` })).toContain(
      '<img src="/fs?path=http://tmp/a.png" data-omr-src="http://tmp/a.png"',
    );
  });

  test("html the editor rendered reads back to the same content", () => {
    const items = fromDelta({
      ops: [
        { insert: "a" },
        { insert: "b", attributes: { italic: true, underline: true } },
        { insert: "\n", attributes: { align: "right", indent: 1 } },
        { insert: "\n" },
      ],
    });
    const html = toHtml(items);
    expect(html).toBe(
      '<p class="ql-indent-1" style="text-align: right;">a<em><u>b</u></em></p><p><br></p>',
    );
    const root = el("div", [
      el("p", [txt("a"), el("em", [el("u", [txt("b")])])], {
        class: "ql-indent-1",
        style: "text-align: right;",
      }),
      el("p", [el("br")]),
    ]);
    expect(readHtml(root).items).toEqual(items);
  });

  test("a custom block is a line of its own that keeps its id through html and delta", () => {
    const delta = {
      ops: [
        { insert: "a\n" },
        { insert: { customBlock: { blockId: "x1" } } },
        { insert: { divider: true } },
        { insert: "b\n" },
      ],
    };
    const items = fromDelta(delta);
    expect(toDelta(items)).toEqual(delta);
    expect(toText(items)).toBe("a\nb\n");
    expect(toHtml(items)).toBe(
      '<p>a</p><div data-block-id="x1" contenteditable="false"></div><hr><p>b</p>',
    );
    const block = el("div", [], { "data-block-id": "x1", contenteditable: "false" });
    const b = txt("b");
    const root = el("div", [el("p", [txt("a")]), block, el("hr"), el("p", [b])]);
    const { items: read, positions } = readHtml(root, [{ node: b, offset: 1 }]);
    expect(read).toEqual(items);
    // a, its line end, the block and the divider come before b
    expect(positions).toEqual([5]);
  });

  test("a position before a divider is the boundary before it, not a point past every divider", () => {
    const paragraph = el("p", [el("br")]);
    const root = el("div", [el("hr"), el("hr"), paragraph]);
    expect(locate(root, 0)).toEqual({ node: root, offset: 0 });
    expect(locate(root, 1)).toEqual({ node: root, offset: 1 });
    expect(locate(root, 2)).toEqual({ node: paragraph, offset: 0 });
  });

  test("reports where selection points are", () => {
    const first = txt("ab");
    const second = txt("cd");
    const root = el("div", [el("p", [first]), el("p", [second])]);
    const { positions } = readHtml(root, [
      { node: first, offset: 1 },
      { node: second, offset: 2 },
    ]);
    expect(positions).toEqual([1, 5]);
  });

  test("format toggles character formats on a range and line formats on its lines", () => {
    let items = textItems("hello\nworld\n");
    items = applyFormat(items, 1, 3, "bold", "").items;
    expect(formatsAt(items, 1, 3)).toEqual({ bold: true });
    expect(formatsAt(items, 0, 2)).toEqual({});
    // Formatting a range that has the format removes it
    items = applyFormat(items, 1, 3, "bold", "").items;
    expect(formatsAt(items, 1, 3)).toEqual({});

    items = applyFormat(items, 2, 6, "header", "H3").items;
    expect(formatsAt(items, 0, 0)).toEqual({ header: 3 });
    expect(formatsAt(items, 7, 0)).toEqual({ header: 3 });
    items = applyFormat(items, 7, 0, "list", "ordered").items;
    expect(formatsAt(items, 7, 0)).toEqual({ list: "ordered" });
    expect(formatsAt(items, 0, 0)).toEqual({ header: 3 });
    items = applyFormat(items, 0, 0, "color", "rgb(0, 128, 255)").items;
    // At a cursor, character formats wait for the next text
    const pending = applyFormat(items, 3, 0, "italic", "");
    expect(pending.items).toBe(items);
    expect(pending.pending).toEqual({ italic: true });

    items = applyFormat(items, 0, 5, "color", "rgb(0, 128, 255)").items;
    expect(formatsAt(items, 0, 5)).toEqual({ header: 3, color: "#0080ff" });
    items = removeFormats(items, 0, 3);
    expect(formatsAt(items, 0, 3)).toEqual({});
    expect(formatsAt(items, 3, 2)).toEqual({ color: "#0080ff" });
  });

  test("inserted text replaces the range and a line end keeps the line's formats", () => {
    let items = fromDelta({
      ops: [{ insert: "abc" }, { insert: "\n", attributes: { align: "center" } }],
    });
    items = replaceRange(items, 1, 1, textItems("X\nY", { bold: true }));
    expect(toDelta(items).ops).toEqual([
      { insert: "a" },
      { insert: "X", attributes: { bold: true } },
      { insert: "\n", attributes: { align: "center" } },
      { insert: "Y", attributes: { bold: true } },
      { insert: "c" },
      { insert: "\n", attributes: { align: "center" } },
    ]);
  });
});
