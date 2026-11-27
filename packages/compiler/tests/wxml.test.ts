import { describe, expect, test } from "vite-plus/test";
import { compileWxml, parseValue, parseWxml } from "../src/index.ts";

describe("parseWxml", () => {
  test("skips declarations and processing instructions", () => {
    const nodes = parseWxml('<?xml version="1.0"?>\n<!DOCTYPE html>\n<view>a</view><!x>');

    expect(nodes).toEqual(["\n", "\n", { tag: "view", attrs: [], children: ["a"] }]);
  });

  test("skips comments, including an unterminated one", () => {
    expect(parseWxml("<view><!-- <text>no</text> -->a</view>")).toEqual([
      { tag: "view", attrs: [], children: ["a"] },
    ]);
    expect(parseWxml("<view>a</view><!-- open")).toEqual([
      { tag: "view", attrs: [], children: ["a"] },
    ]);
  });

  test("ends on unterminated declarations, tags and attribute values", () => {
    expect(parseWxml("a<!DOCTYPE")).toEqual(["a"]);
    expect(parseWxml("a<?xml")).toEqual(["a"]);
    expect(() => parseWxml("<view")).toThrow("unterminated <view>");
    expect(() => parseWxml('<view class="a')).toThrow("unterminated <view>");
    expect(() => parseWxml("<view></view")).toThrow("unterminated closing tag");
  });

  test("does not end an interpolation at a `}}` inside a string", () => {
    const nodes = parseWxml(`<view hidden="{{ a === '}}' }}">{{ b + "}}" }}</view>`);

    expect(nodes).toEqual([
      { tag: "view", attrs: [["hidden", "{{ a === '}}' }}"]], children: ['{{ b + "}}" }}'] },
    ]);
  });
});

describe("parseValue", () => {
  test("keeps `}}` inside a string literal in the expression", () => {
    expect(parseValue(`x{{ a === '}}' }}y`)).toEqual(["x", { e: "a === '}}'" }, "y"]);
  });
});

describe("compileWxml", () => {
  test("accepts a template named after an Object.prototype property", () => {
    const file = compileWxml(
      '<template name="__proto__"><view/></template><template name="constructor"><text/></template>',
      "a.wxml",
    );

    expect(Object.keys(file.templates)).toEqual(["__proto__", "constructor"]);
    expect(file.templates["__proto__"]).toHaveLength(1);
  });

  test("ignores whitespace around a lone interpolation in an attribute", () => {
    const file = compileWxml(
      '<template is="t" data=" {{ {a: 1} }} "/><view data-n=" {{ 1 }} " class=" a {{ b }} "/>',
      "a.wxml",
    );

    expect(file.nodes[0]).toMatchObject({ type: "template", data: [{ e: "{a: 1}" }] });
    expect(file.nodes[1]).toMatchObject({
      attrs: { "data-n": [{ e: "1" }], class: [" a ", { e: "b" }, " "] },
    });
  });
});
