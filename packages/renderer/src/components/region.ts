/**
 * The places `<picker mode="region">` offers: every province, city and
 * district of China's statistical division codes (2023), bundled from
 * region-data.ts, and the streets of a district, which the simulator serves
 * and the picker loads when `level="sub-district"` needs them. Postcodes are
 * the province capital's, as no public table gives one per district.
 */
import { REGION_DATA } from "./region-data.ts";

export interface Region {
  name: string;
  code: string;
  postcode: string;
  children?: Region[];
}

let regions: Region[] | undefined;
/** The provinces, parsed from the bundled data on first use. */
export function allRegions(): Region[] {
  regions ??= REGION_DATA.split("\n").map((line) => {
    const [head = "", body = ""] = line.split(":");
    const [provinceText = "", postcode = ""] = head.split("@");
    const pcode = provinceText.slice(0, 2);
    const cities = body.split("|").map((cityText) => {
      const [city = "", districts = ""] = cityText.split("=");
      const ccode = `${pcode}${city.slice(0, 2)}`;
      return {
        name: city.slice(2),
        code: `${ccode}00`,
        postcode,
        children: districts
          ? districts.split(",").map((district) => ({
              name: district.slice(4),
              code: `${pcode}${district.slice(0, 4)}`,
              postcode,
            }))
          : [],
      };
    });
    return { name: provinceText.slice(2), code: `${pcode}0000`, postcode, children: cities };
  });
  return regions;
}

/** Where the streets of a district are served: `<url>?code=<district code>` answers `[[code, name], ...]`. */
let streetsUrl: string | undefined;
const streets = new Map<string, Region[] | Promise<void>>();
export function setStreetsUrl(url: string | undefined): void {
  streetsUrl = url;
}

/**
 * The streets of a district, or undefined while they load; `loaded` is
 * called once they arrive. Without a source, a district has no streets. A
 * failed load is forgotten, so the next time the district is shown asks again.
 */
function streetsOf(district: Region, loaded?: () => void): Region[] | undefined {
  const known = streets.get(district.code);
  if (Array.isArray(known)) return known;
  if (!streetsUrl) return [];
  if (!known) {
    const url = `${streetsUrl}?code=${encodeURIComponent(district.code)}`;
    const request = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<[string, string][]>;
      })
      .then(
        (list) => {
          streets.set(
            district.code,
            list.map(([code, name]) => ({ name, code, postcode: district.postcode })),
          );
          loaded?.();
        },
        () => {
          if (streets.get(district.code) === request) streets.delete(district.code);
        },
      );
    streets.set(district.code, request);
  } else if (loaded) {
    void known.then(() => {
      if (Array.isArray(streets.get(district.code))) loaded();
    });
  }
  return undefined;
}

/** Whether the streets of the district `path` selects are still loading. */
export function streetsLoading(path: number[], depth: number, customItem = ""): boolean {
  if (depth < 4) return false;
  let list: Region[] = allRegions();
  for (let level = 0; level < 3; level++) {
    const region = placeAt(list, path[level] ?? 0, customItem);
    if (!region) return false;
    if (level === 2) return streets.get(region.code) instanceof Promise;
    list = region.children ?? [];
  }
  return false;
}

/** How many columns a `level` shows. */
export function regionDepth(level: string): number {
  return level === "province" ? 1 : level === "city" ? 2 : level === "sub-district" ? 4 : 3;
}

/** The places below `region` at the next level, or undefined while streets load. */
function childrenOf(region: Region | undefined, level: number, loaded?: () => void) {
  if (!region) return [];
  // Districts are level 2; their children are streets, loaded on demand
  return level === 2 ? streetsOf(region, loaded) : (region.children ?? []);
}

/**
 * The places of each column for the selected indexes; `customItem` adds an
 * item at the top of every column. `loaded` is called when streets the
 * columns need arrive, so the picker can show them.
 */
export function regionColumns(
  path: number[],
  depth: number,
  customItem = "",
  loaded?: () => void,
): { columns: string[][]; path: number[] } {
  const columns: string[][] = [];
  const clamped: number[] = [];
  let list: Region[] | undefined = allRegions();
  for (let level = 0; level < depth; level++) {
    const places: Region[] = list ?? [];
    const labels = [...(customItem ? [customItem] : []), ...places.map((region) => region.name)];
    const index = Math.max(0, Math.min(labels.length - 1, path[level] ?? 0));
    columns.push(labels);
    clamped.push(index);
    // Below the custom item, only the custom item is offered
    list = childrenOf(placeAt(places, index, customItem), level, loaded);
  }
  return { columns, path: clamped };
}

function placeAt(list: Region[], index: number, customItem: string): Region | undefined {
  return list[customItem ? index - 1 : index];
}

/** The indexes of the places named in a picker's `value`; a name that is not found selects the first item. */
export function regionPathOf(
  value: unknown,
  depth: number,
  customItem = "",
  loaded?: () => void,
): number[] {
  const names = Array.isArray(value) ? value.map(String) : [];
  const path: number[] = [];
  let list: Region[] | undefined = allRegions();
  for (let level = 0; level < depth; level++) {
    const places: Region[] = list ?? [];
    const name = names[level];
    let index = places.findIndex((region) => region.name === name);
    // The first item of the column is the custom item when there is one
    if (index === -1 && !customItem) index = 0;
    path.push(customItem ? index + 1 : index);
    list = index === -1 ? undefined : childrenOf(places[index], level, loaded);
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
  let list: Region[] | undefined = allRegions();
  for (let level = 0; level < depth; level++) {
    // A district without streets (or whose streets have not arrived) ends the value there
    if (!customItem && (!list || list.length === 0)) break;
    const region: Region | undefined = list
      ? placeAt(list, path[level] ?? 0, customItem)
      : undefined;
    value.push(region?.name ?? customItem);
    code.push(region?.code ?? "");
    if (region) postcode = region.postcode;
    list = region ? childrenOf(region, level) : undefined;
  }
  return { value, code, postcode };
}
