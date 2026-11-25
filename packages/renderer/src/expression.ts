import type { Value } from "@omr/compiler";

type Compiled = (scope: object) => unknown;
const cache = new Map<string, Compiled>();

/**
 * Evaluates a WXML expression. Names resolve through `lookup`; WXML has no
 * globals, so a name that is not in scope is undefined rather than an error, and
 * an expression that throws, such as reading a field of undefined, is undefined.
 */
export function evaluate(expression: string, lookup: (name: string) => unknown): unknown {
  let compiled = cache.get(expression);
  if (!compiled) {
    try {
      // Function bodies are sloppy-mode code, so `with` is allowed here
      // oxlint-disable-next-line typescript/no-implied-eval -- WXML expressions are code by design
      compiled = new Function(
        "$omrScope",
        `with ($omrScope) { return (${expression}); }`,
      ) as Compiled;
    } catch {
      console.error(`[omr] invalid WXML expression: {{${expression}}}`);
      compiled = () => undefined;
    }
    cache.set(expression, compiled);
  }
  const scope = new Proxy(Object.create(null) as object, {
    has: (_, key) => typeof key === "string",
    get: (_, key) => (typeof key === "string" ? lookup(key) : undefined),
  });
  try {
    return compiled(scope);
  } catch {
    return undefined;
  }
}

/** Evaluates an attribute or text value; a lone `{{ }}` keeps the raw value, anything else is a string. */
export function evaluateValue(value: Value, lookup: (name: string) => unknown): unknown {
  if (typeof value === "string") return value;
  if (value.length === 1 && typeof value[0] !== "string") return evaluate(value[0]!.e, lookup);
  return value
    .map((part) => (typeof part === "string" ? part : toText(evaluate(part.e, lookup))))
    .join("");
}

/** How WXML shows a value in text: undefined and null are empty. */
export function toText(value: unknown): string {
  // oxlint-disable-next-line typescript/no-base-to-string -- WXML shows objects as String() does
  return value === undefined || value === null ? "" : String(value);
}
