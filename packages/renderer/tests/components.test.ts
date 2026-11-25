import { describe, expect, test } from "vite-plus/test";
import {
  dateColumns,
  formatDate,
  formatTime,
  timeColumns,
} from "../src/components/date-columns.ts";
import {
  applySpace,
  decodeText,
  filterInputValue,
  mediaQueryOf,
} from "../src/components/format.ts";
import {
  regionColumns,
  regionDepth,
  regionPathOf,
  regionResult,
} from "../src/components/region.ts";

describe("text", () => {
  test("decode understands the entities WeChat lists, once", () => {
    expect(decodeText("&lt;b&gt; &amp; &apos;q&apos;")).toBe("<b> & 'q'");
    expect(decodeText("a&nbsp;b&ensp;c&emsp;d")).toBe("a\u00a0b\u2002c\u2003d");
    expect(decodeText("&amp;lt;")).toBe("&lt;");
    expect(decodeText("&quot; &copy;")).toBe("&quot; &copy;");
  });

  test("space replaces each space", () => {
    expect(applySpace("a  b", "ensp")).toBe("a\u2002\u2002b");
    expect(applySpace("a  b", "emsp")).toBe("a\u2003\u2003b");
    expect(applySpace("a  b", "nbsp")).toBe("a\u00a0\u00a0b");
    expect(applySpace("a  b", "")).toBe("a  b");
  });
});

describe("input", () => {
  test("filters typed text as the keyboard of each type allows", () => {
    expect(filterInputValue("number", "12a.3-4")).toBe("1234");
    expect(filterInputValue("digit", "12a.3.4")).toBe("12.34");
    expect(filterInputValue("idcard", "11010x19900101123X!")).toBe("11010x19900101123X");
    expect(filterInputValue("text", "12a.3")).toBe("12a.3");
  });
});

describe("match-media", () => {
  test("builds a media query from the properties", () => {
    expect(mediaQueryOf({ "min-width": 300, "max-width": "600", orientation: "portrait" })).toBe(
      "(min-width: 300px) and (max-width: 600px) and (orientation: portrait)",
    );
    expect(mediaQueryOf({ height: 500, orientation: "sideways" })).toBe("(height: 500px)");
    expect(mediaQueryOf({})).toBe("all");
  });
});

describe("region picker", () => {
  test("levels choose the number of columns", () => {
    expect([regionDepth("province"), regionDepth("city"), regionDepth("region")]).toEqual([
      1, 2, 3,
    ]);
    expect(regionDepth("sub-district")).toBe(3);
  });

  test("finds the places named in value and returns codes and the postcode", () => {
    const path = regionPathOf(["广东省", "广州市", "海珠区"], 3);
    const { columns } = regionColumns(path, 3);
    expect(columns[0]![path[0]!]).toBe("广东省");
    expect(columns[1]).toEqual(["广州市", "深圳市"]);
    expect(regionResult(path, 3)).toEqual({
      value: ["广东省", "广州市", "海珠区"],
      code: ["440000", "440100", "440105"],
      postcode: "510220",
    });
  });

  test("an unknown name selects the first place", () => {
    expect(regionResult(regionPathOf(["火星"], 2), 2).value).toEqual(["北京市", "北京市"]);
  });

  test("custom-item adds an item to every column; below it only the custom item is offered", () => {
    const { columns, path } = regionColumns([3, 0, 0], 3, "全部");
    expect(columns[0]![0]).toBe("全部");
    expect(columns[1]).toEqual(["全部", "广州市", "深圳市"]);
    expect(columns[2]).toEqual(["全部"]);
    expect(regionResult(path, 3, "全部")).toEqual({
      value: ["广东省", "全部", "全部"],
      code: ["440000", "", ""],
      postcode: "510000",
    });
    expect(regionPathOf(["广东省", "全部"], 3, "全部").slice(0, 2)).toEqual([3, 0]);
  });
});

describe("date and time pickers", () => {
  const today = new Date(2024, 1, 10);

  test("days follow the month, and the value stays within start and end", () => {
    const { columns, value } = dateColumns("2024-02-31", "2020-03-15", "2025-06-01", "day", today);
    expect(value).toEqual([2024, 2, 29]);
    expect(columns[0]![0]).toBe(2020);
    expect(columns[0]!.at(-1)).toBe(2025);
    expect(columns[2]!.length).toBe(29);
    const start = dateColumns("2020-01-01", "2020-03-15", "2025-06-01", "day", today);
    expect(start.value).toEqual([2020, 3, 15]);
    expect(start.columns[1]![0]).toBe(3);
    expect(start.columns[2]![0]).toBe(15);
  });

  test("fields choose the parts, and an empty value is today", () => {
    expect(dateColumns("", "", "", "month", today).value).toEqual([2024, 2]);
    expect(formatDate([2024, 2])).toBe("2024-02");
    expect(formatDate([2024, 2, 9])).toBe("2024-02-09");
    expect(formatDate([2024])).toBe("2024");
  });

  test("time is limited by start and end", () => {
    const { columns, value } = timeColumns("08:30", "09:01", "21:01", today);
    expect(value).toEqual([9, 1]);
    expect(columns[0]![0]).toBe(9);
    expect(columns[1]![0]).toBe(1);
    expect(formatTime(value)).toBe("09:01");
  });
});
