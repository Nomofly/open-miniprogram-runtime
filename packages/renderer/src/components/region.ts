/**
 * The places `<picker mode="region">` offers. The simulator ships a small
 * sample, written for this project: a few provinces with some of their cities
 * and districts, with their statistical division codes and sample postcodes.
 */

export interface Region {
  name: string;
  code: string;
  postcode: string;
  children?: Region[];
}

const place = (name: string, code: string, postcode: string, children?: Region[]): Region => ({
  name,
  code,
  postcode,
  children,
});

export const REGIONS: Region[] = [
  place("北京市", "110000", "100000", [
    place("北京市", "110100", "100000", [
      place("东城区", "110101", "100010"),
      place("西城区", "110102", "100032"),
      place("朝阳区", "110105", "100020"),
      place("海淀区", "110108", "100080"),
    ]),
  ]),
  place("上海市", "310000", "200000", [
    place("上海市", "310100", "200000", [
      place("黄浦区", "310101", "200001"),
      place("徐汇区", "310104", "200030"),
      place("浦东新区", "310115", "200120"),
    ]),
  ]),
  place("广东省", "440000", "510000", [
    place("广州市", "440100", "510000", [
      place("荔湾区", "440103", "510145"),
      place("越秀区", "440104", "510030"),
      place("海珠区", "440105", "510220"),
      place("天河区", "440106", "510630"),
    ]),
    place("深圳市", "440300", "518000", [
      place("罗湖区", "440303", "518001"),
      place("福田区", "440304", "518033"),
      place("南山区", "440305", "518051"),
    ]),
  ]),
  place("浙江省", "330000", "310000", [
    place("杭州市", "330100", "310000", [
      place("上城区", "330102", "310002"),
      place("西湖区", "330106", "310013"),
    ]),
    place("宁波市", "330200", "315000", [
      place("海曙区", "330203", "315000"),
      place("江北区", "330205", "315020"),
    ]),
  ]),
  place("四川省", "510000", "610000", [
    place("成都市", "510100", "610000", [
      place("锦江区", "510104", "610021"),
      place("武侯区", "510107", "610041"),
    ]),
  ]),
];

/** How many columns a `level` shows; the simulator has no streets, so `sub-district` shows districts. */
export function regionDepth(level: string): number {
  return level === "province" ? 1 : level === "city" ? 2 : 3;
}

/** The places of each column for the selected indexes; `customItem` adds an item at the top of every column. */
export function regionColumns(
  path: number[],
  depth: number,
  customItem = "",
): { columns: string[][]; path: number[] } {
  const columns: string[][] = [];
  const clamped: number[] = [];
  let list: Region[] | undefined = REGIONS;
  for (let level = 0; level < depth; level++) {
    const places: Region[] = list ?? [];
    const labels = [...(customItem ? [customItem] : []), ...places.map((region) => region.name)];
    const index = Math.max(0, Math.min(labels.length - 1, path[level] ?? 0));
    columns.push(labels);
    clamped.push(index);
    // Below the custom item, only the custom item is offered
    list = placeAt(places, index, customItem)?.children;
  }
  return { columns, path: clamped };
}

function placeAt(list: Region[], index: number, customItem: string): Region | undefined {
  return list[customItem ? index - 1 : index];
}

/** The indexes of the places named in a picker's `value`; a name that is not found selects the first item. */
export function regionPathOf(value: unknown, depth: number, customItem = ""): number[] {
  const names = Array.isArray(value) ? value.map(String) : [];
  const path: number[] = [];
  let list: Region[] | undefined = REGIONS;
  for (let level = 0; level < depth; level++) {
    const places: Region[] = list ?? [];
    const name = names[level];
    let index = places.findIndex((region) => region.name === name);
    // The first item of the column is the custom item when there is one
    if (index === -1 && !customItem) index = 0;
    path.push(customItem ? index + 1 : index);
    list = index === -1 ? undefined : places[index]?.children;
  }
  return path;
}

/** The `change` event detail: the names, their division codes and the postcode of the last place. */
export function regionResult(
  path: number[],
  depth: number,
  customItem = "",
): { value: string[]; code: string[]; postcode: string } {
  const value: string[] = [];
  const code: string[] = [];
  let postcode = "";
  let list: Region[] | undefined = REGIONS;
  for (let level = 0; level < depth; level++) {
    const region: Region | undefined = list
      ? placeAt(list, path[level] ?? 0, customItem)
      : undefined;
    value.push(region?.name ?? customItem);
    code.push(region?.code ?? "");
    if (region) postcode = region.postcode;
    list = region?.children;
  }
  return { value, code, postcode };
}
