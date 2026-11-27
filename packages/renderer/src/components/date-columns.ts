/** The columns of `<picker mode="date">` and `<picker mode="time">`; no DOM, so tests can import them. */

/**
 * The values each column offers for a value that has as many parts as there
 * are columns, such as [year, month, day], kept between `start` and `end`.
 * `natural` gives a column's own range, which may depend on the columns
 * before it, such as the days of a month. Returns the clamped value too.
 */
export function boundedColumns(
  value: number[],
  start: number[],
  end: number[],
  natural: (column: number, before: number[]) => [number, number],
): { columns: number[][]; value: number[] } {
  const columns: number[][] = [];
  const clamped: number[] = [];
  let atStart = true;
  let atEnd = true;
  /** Set once a part was moved up to start or down to end: the parts after it go to the same limit. */
  let forced: "low" | "high" | undefined;
  for (let column = 0; column < start.length; column++) {
    let [low, high] = natural(column, clamped);
    if (atStart) low = Math.max(low, start[column]!);
    if (atEnd) high = Math.min(high, end[column]!);
    if (high < low) high = low;
    const wanted = value[column] ?? low;
    const part =
      forced === "low" ? low : forced === "high" ? high : Math.max(low, Math.min(high, wanted));
    if (!forced && wanted < low) forced = "low";
    else if (!forced && wanted > high) forced = "high";
    columns.push(Array.from({ length: high - low + 1 }, (_, i) => low + i));
    clamped.push(part);
    atStart &&= part === start[column];
    atEnd &&= part === end[column];
  }
  return { columns, value: clamped };
}

export type DateFields = "year" | "month" | "day";

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The parts of a date such as "2016-09-01", "2016-09" or "2016"; missing parts come from `fallback`. */
export function parseDate(text: string, fallback: number[]): number[] {
  const parts = /^(\d{1,4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(text.trim());
  return [0, 1, 2].map((i) => {
    const part = parts?.[i + 1];
    return part === undefined ? fallback[i]! : Number(part);
  });
}

/** The years, months and days a date picker offers for `fields`, between `start` and `end`. */
export function dateColumns(
  value: string,
  start: string,
  end: string,
  fields: DateFields,
  today: Date,
): { columns: number[][]; value: number[] } {
  const depth = fields === "year" ? 1 : fields === "month" ? 2 : 3;
  const now = [today.getFullYear(), today.getMonth() + 1, today.getDate()];
  const from = parseDate(start || "1900-01-01", [1900, 1, 1]).slice(0, depth);
  const to = parseDate(end || "2100-12-31", [2100, 12, 31]).slice(0, depth);
  return boundedColumns(parseDate(value, now).slice(0, depth), from, to, (column, before) =>
    column === 0
      ? [from[0]!, to[0]!]
      : column === 1
        ? [1, 12]
        : [1, daysIn(before[0]!, before[1]!)],
  );
}

/** Formats a date picker value as WeChat does: "YYYY", "YYYY-MM" or "YYYY-MM-DD". */
export function formatDate(parts: number[]): string {
  return parts
    .map((part, i) => (i === 0 ? String(part).padStart(4, "0") : String(part).padStart(2, "0")))
    .join("-");
}

/** The hours and minutes a time picker offers between `start` and `end`, as "hh:mm". */
export function timeColumns(
  value: string,
  start: string,
  end: string,
  now: Date,
): { columns: number[][]; value: number[] } {
  const parse = (text: string, fallback: number[]) => {
    const parts = /^(\d{1,2}):(\d{1,2})/.exec(text.trim());
    return parts ? [Number(parts[1]), Number(parts[2])] : fallback;
  };
  return boundedColumns(
    parse(value, [now.getHours(), now.getMinutes()]),
    parse(start, [0, 0]),
    parse(end, [23, 59]),
    (column) => (column === 0 ? [0, 23] : [0, 59]),
  );
}

export const formatTime = (parts: number[]) =>
  parts.map((part) => String(part).padStart(2, "0")).join(":");
