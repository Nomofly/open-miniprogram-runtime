/** Splits a `setData` key such as `list[0].name` into `["list", 0, "name"]`. */
export function parsePath(key: string): (string | number)[] {
  const parts: (string | number)[] = [];
  let current = "";
  let i = 0;
  while (i < key.length) {
    const char = key[i]!;
    if (char === "\\" && i + 1 < key.length) {
      current += key[i + 1];
      i += 2;
    } else if (char === ".") {
      parts.push(current);
      current = "";
      i++;
    } else if (char === "[") {
      if (current !== "") parts.push(current);
      current = "";
      const end = key.indexOf("]", i);
      if (end === -1) throw new Error(`Invalid data path: ${key}`);
      const index = Number(key.slice(i + 1, end));
      if (!Number.isInteger(index)) throw new Error(`Invalid data path: ${key}`);
      parts.push(index);
      i = end + 1;
      if (key[i] === ".") i++;
    } else {
      current += char;
      i++;
    }
  }
  if (current !== "" || parts.length === 0) parts.push(current);
  return parts;
}

type DataNode = Record<string | number, unknown>;

// Path parts are data keys: only own properties are read, and every write defines
// an own property, so a key such as __proto__ never reaches an object's prototype
const own = (node: DataNode, part: string | number) =>
  Object.hasOwn(node, part) ? node[part] : undefined;
const define = (node: DataNode, part: string | number, value: unknown) =>
  Object.defineProperty(node, part, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });

/** Sets `value` at a `setData` path, creating missing objects and arrays on the way. */
export function setPath(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = parsePath(key);
  let node: DataNode = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    let next = own(node, part);
    if (next === null || typeof next !== "object") {
      next = typeof parts[i + 1] === "number" ? [] : {};
      define(node, part, next);
    }
    node = next as DataNode;
  }
  define(node, parts[parts.length - 1]!, value);
}

/** Reads the value at a `setData` path, or undefined when part of it is missing. */
export function getPath(target: unknown, key: string): unknown {
  let node = target;
  for (const part of parsePath(key)) {
    if (node === null || typeof node !== "object") return undefined;
    node = own(node as DataNode, part);
  }
  return node;
}

/**
 * Copies data the way it crosses between the logic and view layers: as JSON, so
 * functions and undefined object fields are dropped and dates become strings.
 */
export function toJsonValue<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
