/** Pure text helpers of built-in components; no DOM, so tests can import them. */

const ENTITIES: Record<string, string> = {
  nbsp: "\u00a0",
  lt: "<",
  gt: ">",
  amp: "&",
  apos: "'",
  ensp: "\u2002",
  emsp: "\u2003",
};

/** Decodes the entities `<text decode>` understands, once, so `&amp;lt;` becomes `&lt;`. */
export function decodeText(text: string): string {
  return text.replace(/&(nbsp|lt|gt|amp|apos|ensp|emsp);/g, (_, name: string) => ENTITIES[name]!);
}

const SPACES: Record<string, string> = { ensp: "\u2002", emsp: "\u2003", nbsp: "\u00a0" };

/** Shows each space as the space `<text space>` asks for, so runs of spaces are kept. */
export function applySpace(text: string, space: string): string {
  const char = SPACES[space];
  return char ? text.replaceAll(" ", char) : text;
}

/**
 * What an `<input>` keeps of typed text, as its keyboard allows: digits for
 * `number`, digits and one decimal point for `digit`, digits and X for `idcard`.
 */
export function filterInputValue(type: string, value: string): string {
  switch (type) {
    case "number":
      return value.replace(/\D/g, "");
    case "digit": {
      const kept = value.replace(/[^\d.]/g, "");
      const dot = kept.indexOf(".");
      return dot === -1 ? kept : kept.slice(0, dot + 1) + kept.slice(dot + 1).replaceAll(".", "");
    }
    case "idcard":
      return value.replace(/[^\dXx]/g, "");
    default:
      return value;
  }
}

const MEDIA_FEATURES = ["min-width", "max-width", "width", "min-height", "max-height", "height"];

/** The CSS media query of a `<match-media>`: lengths are px numbers; `orientation` is landscape or portrait. */
export function mediaQueryOf(props: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const feature of MEDIA_FEATURES) {
    const value = Number(props[feature] ?? Number.NaN);
    if (Number.isFinite(value)) parts.push(`(${feature}: ${value}px)`);
  }
  const orientation = props.orientation;
  if (orientation === "landscape" || orientation === "portrait") {
    parts.push(`(orientation: ${orientation})`);
  }
  return parts.length > 0 ? parts.join(" and ") : "all";
}
