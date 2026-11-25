/** Page, Component and Behavior definitions, normalized into one shape. */

type AnyFunction = (...args: any[]) => unknown;

export interface PropertyDefinition {
  type: unknown;
  value: unknown;
  observer?: AnyFunction | string;
}

export interface Definition {
  kind: "page" | "component";
  data: Record<string, unknown>;
  properties: Record<string, PropertyDefinition>;
  /** Copied onto every instance; a page's lifecycle callbacks such as `onLoad` are methods. */
  methods: Record<string, AnyFunction>;
  /** A page's other non-function fields, copied onto every instance. */
  fields: Record<string, unknown>;
  lifetimes: Record<string, AnyFunction[]>;
  pageLifetimes: Record<string, AnyFunction[]>;
  observers: { fields: string[]; fn: AnyFunction }[];
  externalClasses: string[];
  options: Record<string, unknown>;
}

const COMPONENT_LIFETIMES = ["created", "attached", "ready", "moved", "detached", "error"];

/** Marks objects returned by `Behavior()`. */
const BEHAVIOR = Symbol("omr.behavior");

export function defineBehavior(options: Record<string, unknown>): Record<string, unknown> {
  return Object.assign(Object.create(null), options, { [BEHAVIOR]: true });
}

/** Normalizes the object passed to `Page()`. */
export function normalizePage(options: Record<string, unknown>): Definition {
  const definition = emptyDefinition("page");
  for (const [key, value] of Object.entries(options)) {
    if (key === "data") definition.data = (value as Record<string, unknown>) ?? {};
    else if (typeof value === "function") definition.methods[key] = value as AnyFunction;
    else definition.fields[key] = value;
  }
  return definition;
}

/** Normalizes the object passed to `Component()`, merging its behaviors. */
export function normalizeComponent(options: Record<string, unknown>): Definition {
  const definition = emptyDefinition("component");
  mergeComponent(definition, options);
  return definition;
}

function emptyDefinition(kind: Definition["kind"]): Definition {
  return {
    kind,
    data: {},
    properties: {},
    methods: {},
    fields: {},
    lifetimes: {},
    pageLifetimes: {},
    observers: [],
    externalClasses: [],
    options: {},
  };
}

function mergeComponent(definition: Definition, options: Record<string, unknown>): void {
  // Behaviors first, so the component's own fields override theirs
  for (const behavior of (options.behaviors as unknown[] | undefined) ?? []) {
    // Built-in behaviors such as "wx://form-field" are strings
    if (behavior && typeof behavior === "object") {
      mergeComponent(definition, behavior as Record<string, unknown>);
    }
  }
  Object.assign(definition.data, options.data as Record<string, unknown> | undefined);
  for (const [name, spec] of Object.entries(
    (options.properties as Record<string, unknown> | undefined) ?? {},
  )) {
    definition.properties[name] = normalizeProperty(spec);
  }
  Object.assign(definition.methods, options.methods as Record<string, AnyFunction> | undefined);

  const lifetimes = (options.lifetimes as Record<string, AnyFunction> | undefined) ?? {};
  for (const name of COMPONENT_LIFETIMES) {
    // `lifetimes` takes precedence over the legacy top-level declaration
    const fn = lifetimes[name] ?? options[name];
    if (typeof fn === "function") (definition.lifetimes[name] ??= []).push(fn as AnyFunction);
  }
  for (const [name, fn] of Object.entries(
    (options.pageLifetimes as Record<string, AnyFunction> | undefined) ?? {},
  )) {
    (definition.pageLifetimes[name] ??= []).push(fn);
  }
  for (const [fields, fn] of Object.entries(
    (options.observers as Record<string, AnyFunction> | undefined) ?? {},
  )) {
    definition.observers.push({ fields: fields.split(",").map((field) => field.trim()), fn });
  }
  definition.externalClasses.push(...((options.externalClasses as string[] | undefined) ?? []));
  Object.assign(definition.options, options.options as Record<string, unknown> | undefined);
  if (options.addGlobalClass === true) definition.options.addGlobalClass = true;
}

function normalizeProperty(spec: unknown): PropertyDefinition {
  if (spec && typeof spec === "object") {
    const { type = null, value, observer } = spec as Record<string, unknown>;
    return {
      type,
      value: value === undefined ? defaultValue(type) : value,
      observer: observer as PropertyDefinition["observer"],
    };
  }
  return { type: spec ?? null, value: defaultValue(spec) };
}

function defaultValue(type: unknown): unknown {
  switch (type) {
    case String:
      return "";
    case Number:
      return 0;
    case Boolean:
      return false;
    case Array:
      return [];
    default:
      return null;
  }
}

/**
 * Whether setting `changed` (a `setData` key) affects an observed field. Setting
 * `a` affects `a.b`, and setting `a.b` affects `a`; `**` observes everything.
 */
export function affects(changed: string, field: string): boolean {
  if (field === "**") return true;
  const base = field.endsWith(".**") ? field.slice(0, -3) : field;
  return (
    changed === base ||
    changed.startsWith(`${base}.`) ||
    changed.startsWith(`${base}[`) ||
    base.startsWith(`${changed}.`) ||
    base.startsWith(`${changed}[`)
  );
}
