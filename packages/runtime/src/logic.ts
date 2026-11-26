/**
 * The logic layer: runs the Mini Program's JavaScript (`App`, `Page`,
 * `Component`), owns page data and the page stack, and talks to the view layer
 * of each page only through messages, as WeChat's two-thread model does.
 */
import { getPath, setPath, toJsonValue } from "./data.ts";
import { affects, defineBehavior, normalizeComponent, normalizePage } from "./definition.ts";
import type { Definition, RelationDefinition } from "./definition.ts";
import { dirname, normalizePath, parsePageUrl, resolvePath } from "./paths.ts";
import type {
  AncestorBindings,
  ComponentListeners,
  EventBinding,
  LogicToShell,
  LogicToView,
  Manifest,
  SelectorQueryRequest,
  ShellToLogic,
  TreeNode,
  ViewToLogic,
  WebViewEventName,
  WxEvent,
  WxEventTarget,
} from "./protocol.ts";
import { runWithTapGesture } from "./api/common.ts";
import type { FsHost } from "./api/context.ts";
import { MemoryFs } from "./api/memory-fs.ts";
import { createEventChannel, type EventChannel } from "./event-channel.ts";
import type { Theme } from "./theme.ts";
import { createWx } from "./wx.ts";

type AnyFunction = (...args: any[]) => any;

/** Events whose handlers run with the tap state that APIs such as `wx.getUserProfile` require. */
const TAP_EVENTS = new Set(["tap", "longpress", "longtap"]);
export type Instance = Record<string, any> & { data: Record<string, unknown> };

interface ComponentRecord {
  nodeId: number;
  path: string;
  def: Definition;
  instance: Instance;
  ownerNodeId: number;
  listeners: ComponentListeners;
  initSeq?: number;
  readyFired: boolean;
  /** Where the view last placed it; unset until the view reports the tree. */
  tree?: TreeNode & { order: number };
}

/** A relation between two components, each seen from its own definition. */
interface Link {
  a: ComponentRecord;
  aKey: string;
  b: ComponentRecord;
  bKey: string;
}

/** One route, as `wx.onBeforeAppRoute` and the other route listeners describe it. */
interface RouteEvent {
  routeEventId: string;
  openType: string;
  /** With a leading `/`, as in WeChat's route rewrite guide. */
  path: string;
  query: Record<string, string>;
  webviewId: number;
  timeStamp: number;
}

/** The relation type that answers each type on the other component. */
const RECIPROCAL: Record<RelationDefinition["type"], RelationDefinition["type"]> = {
  parent: "child",
  child: "parent",
  ancestor: "descendant",
  descendant: "ancestor",
};

/** One compound selector of `selectComponent`, such as `my-item.active`, and the combinator before it. */
interface SelectorStep {
  combinator: "" | " " | ">" | ">>>";
  tag?: string;
  id?: string;
  classes: string[];
}

interface PageRecord {
  webviewId: number;
  route: string;
  /** Whether the view reports an open `<page-container>`, which a return closes first. */
  containerOpen?: boolean;
  query: Record<string, string>;
  def?: Definition;
  instance?: Instance;
  components: Map<number, ComponentRecord>;
  /** The last message sequence number sent to this page's view. */
  seq: number;
  renderedSeq: number;
  callbacks: { seq: number; fn: AnyFunction }[];
  initSeq?: number;
  /** Components attached during the first render that have not rendered yet; onReady waits for them. */
  pendingInits: number;
  readyFired: boolean;
  shown: boolean;
  /** For a page opened with `wx.navigateTo`: its end of the channel to the opener. */
  openerChannel?: EventChannel;
  /** Relations linked between its components, by `linkId`. */
  links: Map<string, Link>;
  /** The route that opened the page, until its route listeners have all run. */
  routeEvent?: RouteEvent;
  /**
   * The `custom-tab-bar` of a tab page, created before `onLoad` so `getTabBar`
   * works in `onShow`, until the view renders its host and attaches it.
   */
  tabBar?: ComponentRecord;
  /** The page's `<web-view>`, as its view reports it. */
  webView?: {
    src: string;
    target: WxEventTarget;
    handlers: Partial<Record<WebViewEventName, { ownerId: number; handler: string }>>;
    /** The URL the web page is at now, which sharing reports as `webViewUrl`. */
    url: string;
    /** What the web page posted with `wx.miniProgram.postMessage` since `bindmessage` last fired. */
    messages: unknown[];
  };
}

interface Meta {
  page: PageRecord;
  nodeId: number;
  def: Definition;
  initSent: boolean;
  /** `setData` callbacks given before the first render; they run after it. */
  pendingCallbacks: AnyFunction[];
}

const MAX_STACK = 10;
/** The component app.json `tabBar.custom` renders on each tab page. */
const CUSTOM_TAB_BAR = "custom-tab-bar/index";

/** Starts a logic layer. Returns the handler for messages from the shell. */
export interface LogicOptions {
  /** The Mini Program's file system; the simulator keeps it on its server. */
  fs?: FsHost;
}

export function startLogic(
  post: (message: LogicToShell) => void,
  options: LogicOptions = {},
): (message: ShellToLogic) => void {
  const factories = new Map<string, AnyFunction>();
  const modules = new Map<string, { exports: unknown }>();
  let currentModule: string | undefined;
  const pageDefs = new Map<string, Definition>();
  const componentDefs = new Map<string, Definition>();
  const metas = new WeakMap<object, Meta>();
  const pages = new Map<number, PageRecord>();
  let stack: PageRecord[] = [];
  let nextWebviewId = 1;
  let manifest: Manifest | undefined;
  let app: Instance | undefined;
  let uiCallId = 0;
  const uiPending = new Map<number, { resolve: AnyFunction; reject: AnyFunction }>();
  let queryId = 0;
  /** Selector queries waiting for their WebView's reply, with the WebView asked. */
  const queryPending = new Map<
    number,
    { webviewId: number; resolve: (results: unknown[]) => void; count: number }
  >();
  let builtinCallId = 0;
  /** Calls of built-in component methods waiting for their WebView's reply. */
  const builtinPending = new Map<
    number,
    { webviewId: number; resolve: AnyFunction; reject: (error: Error) => void }
  >();
  let wxApi: ReturnType<typeof createWx> | undefined;
  let theme: Theme = "light";
  /** The options of the latest launch or return to the foreground. */
  let enterOptions: Record<string, unknown> = {};
  let inBackground = false;
  let tabBarHidden = false;
  let routeEventCount = 0;
  /** The route being performed, whose id the page unload listeners get. */
  let activeRoute: RouteEvent | undefined;

  // Module system for the bundle from the compiler's compileAppService
  const resolveModule = (from: string, written: string): string | undefined => {
    // app.json `resolveAlias`, such as `{ "~/*": "/src/*" }`
    let spec = written;
    for (const [aliasFrom, aliasTo] of Object.entries(
      (manifest?.appJson.resolveAlias as Record<string, string> | undefined) ?? {},
    )) {
      if (typeof aliasTo !== "string" || !aliasFrom.endsWith("/*") || !aliasTo.endsWith("/*")) {
        continue;
      }
      if (spec.startsWith(aliasFrom.slice(0, -1))) {
        spec = aliasTo.slice(0, -1) + spec.slice(aliasFrom.length - 1);
        break;
      }
    }
    const bases: string[] = [];
    if (spec.startsWith("/") || spec.startsWith(".")) {
      bases.push(resolvePath(from, spec));
    } else {
      for (let dir = dirname(from); ; dir = dirname(dir)) {
        bases.push(normalizePath(`${dir}/miniprogram_npm/${spec}`));
        if (dir === "") break;
      }
      bases.push(resolvePath(from, spec), normalizePath(spec));
    }
    for (const base of bases) {
      for (const candidate of [base, `${base}.js`, `${base}/index.js`]) {
        if (factories.has(candidate)) return candidate;
      }
    }
    return undefined;
  };

  const requireModule = (file: string): unknown => {
    const cached = modules.get(file);
    if (cached) return cached.exports;
    const factory = factories.get(file);
    if (!factory) throw new Error(`module "${file}" is not defined`);
    const module = { exports: {} as unknown };
    modules.set(file, module);
    const previous = currentModule;
    currentModule = file;
    try {
      const localRequire = (spec: string) => {
        const resolved = resolveModule(file, spec);
        if (!resolved) throw new Error(`module "${spec}" is not defined, required from "${file}"`);
        return requireModule(resolved);
      };
      factory.call(module.exports, localRequire, module, module.exports);
    } catch (error) {
      modules.delete(file);
      throw error;
    } finally {
      currentModule = previous;
    }
    return module.exports;
  };

  const moduleRoute = () => currentModule?.replace(/\.js$/, "");

  // Global constructors
  const App = (options: Record<string, unknown>) => {
    app = options as Instance;
  };
  const Page = (options: Record<string, unknown>) => {
    const route = moduleRoute();
    if (route) pageDefs.set(route, normalizePage(options));
  };
  const Component = (options: Record<string, unknown>) => {
    const route = moduleRoute();
    if (!route) return;
    const def = normalizeComponent(options);
    componentDefs.set(route, def);
    // A page may be built with Component()
    if (manifest?.pages.includes(route)) pageDefs.set(route, def);
  };
  const getApp = () => app;
  const getCurrentPages = () => stack.map((record) => record.instance).filter(Boolean);

  const componentDefsLoadable = (path: string) =>
    componentDefs.has(path) || factories.has(`${path}.js`);
  const loadDefinition = (path: string, defs: Map<string, Definition>): Definition => {
    if (!defs.has(path) && factories.has(`${path}.js`)) {
      try {
        requireModule(`${path}.js`);
      } catch (error) {
        console.error("[omr] failed to load %s.js:", path, error);
      }
    }
    const def = defs.get(path);
    if (def) return def;
    console.error(
      `[omr] ${path}.js did not register a ${defs === pageDefs ? "Page" : "Component"}`,
    );
    return defs === pageDefs ? normalizePage({}) : normalizeComponent({});
  };

  // Instances
  const callHook = (target: Record<string, any> | undefined, name: string, ...args: unknown[]) => {
    const fn = target?.[name];
    if (typeof fn !== "function") return undefined;
    try {
      return fn.apply(target, args);
    } catch (error) {
      reportError(error, `${target?.is ?? "App"}.${name}`, target);
      return undefined;
    }
  };
  const callLifetime = (
    comp: { def: Definition; instance: Instance },
    name: string,
    ...args: unknown[]
  ) => {
    for (const fn of comp.def.lifetimes[name] ?? []) {
      try {
        fn.apply(comp.instance, args);
      } catch (error) {
        reportError(error, `${comp.instance.is}.lifetimes.${name}`, comp.instance);
      }
    }
  };
  const callPageLifetime = (record: PageRecord, name: string, ...args: unknown[]) => {
    for (const comp of record.components.values()) {
      for (const fn of comp.def.pageLifetimes[name] ?? []) {
        try {
          fn.apply(comp.instance, args);
        } catch (error) {
          reportError(error, `${comp.path}.pageLifetimes.${name}`, comp.instance);
        }
      }
    }
  };
  const reportError = (error: unknown, where: string, instance?: object) => {
    console.error("[omr] error in %s:", where, error);
    // A component's `error` lifetime hears what its own methods throw
    const meta = instance && metas.get(instance);
    if (meta?.def.kind === "component" && where.split(".").at(-1) !== "error") {
      for (const fn of meta.def.lifetimes.error ?? []) {
        try {
          fn.call(instance, error);
        } catch (inner) {
          console.error("[omr] error in %s.lifetimes.error:", meta.def.kind, inner);
        }
      }
    }
    if (app && typeof app.onError === "function") {
      try {
        app.onError.call(
          app,
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        );
      } catch {
        // Errors in onError itself are only logged above
      }
    }
    wxApi?.app.emit("Error", {
      message: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  };

  /** Shows native UI in the shell and resolves with its result. */
  const shellUi = (name: string, args: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const callId = ++uiCallId;
      uiPending.set(callId, { resolve, reject });
      post({ type: "ui", callId, name, args });
    });

  /** Applies a page's `<navigation-bar>` as the matching `wx.setNavigationBar*` calls would. */
  const applyNavigationBar = (record: PageRecord, attributes: Record<string, unknown>) => {
    const { webviewId } = record;
    const show = (name: string, args: Record<string, unknown> = {}) =>
      void shellUi(name, { webviewId, ...args }).catch(() => {});
    if (typeof attributes.title === "string")
      show("setNavigationBarTitle", { title: attributes.title });
    if (attributes["front-color"] !== undefined || attributes["background-color"] !== undefined) {
      show("setNavigationBarColor", {
        frontColor: attributes["front-color"],
        backgroundColor: attributes["background-color"],
        animation: {
          duration: Number(attributes["color-animation-duration"]) || 0,
          timingFunc: attributes["color-animation-timing-func"] ?? "linear",
        },
      });
    }
    if (attributes.loading !== undefined) {
      show(attributes.loading ? "showNavigationBarLoading" : "hideNavigationBarLoading");
    }
  };

  const sendView = (record: PageRecord, message: LogicToView) => {
    post({ type: "toView", webviewId: record.webviewId, message });
  };
  const nextSeq = (record: PageRecord) => ++record.seq;

  const applyData = (
    instance: Instance,
    patch: Record<string, unknown>,
    callback?: AnyFunction,
  ): void => {
    const meta = metas.get(instance);
    if (!meta) throw new Error("setData called on an object that is not a page or component");
    if (!patch || typeof patch !== "object") {
      throw new TypeError("setData expects an object");
    }
    const keys = Object.keys(patch);
    const properties = meta.def.kind === "component" ? meta.def.properties : {};
    const previous = new Map<string, unknown>();
    for (const key of keys) {
      const name = key.split(/[.[]/, 1)[0]!;
      if (name in properties && !previous.has(name)) previous.set(name, instance.data[name]);
    }
    for (const key of keys) setPath(instance.data, key, patch[key]);
    // Send this patch before observers send theirs, so the view applies them in order
    if (meta.initSent) {
      const seq = nextSeq(meta.page);
      sendView(meta.page, {
        type: "setData",
        nodeId: meta.nodeId,
        patch: toJsonValue(viewData(meta.def, patch)),
        seq,
      });
      if (callback) meta.page.callbacks.push({ seq, fn: callback });
    } else if (callback) {
      meta.pendingCallbacks.push(callback);
    }
    for (const [name, old] of previous) {
      const observer = properties[name]!.observer;
      const fn = typeof observer === "string" ? instance[observer] : observer;
      if (typeof fn === "function" && old !== instance.data[name]) {
        try {
          fn.call(instance, instance.data[name], old, [name]);
        } catch (error) {
          reportError(error, `${instance.is}.properties.${name}.observer`);
        }
      }
    }
    runObservers(meta, instance, keys);
  };

  /** What the view gets of some data: all of it but the pure data fields, which only the logic layer uses. */
  const viewData = (def: Definition, data: Record<string, unknown>): Record<string, unknown> => {
    const pattern = def.options.pureDataPattern;
    if (!(pattern instanceof RegExp)) return data;
    return Object.fromEntries(
      Object.entries(data).filter(([key]) => {
        pattern.lastIndex = 0;
        return !pattern.test(key.split(/[.[]/, 1)[0]!);
      }),
    );
  };

  const runObservers = (meta: Meta, instance: Instance, keys: string[]) => {
    for (const observer of meta.def.observers) {
      if (!observer.fields.some((field) => keys.some((key) => affects(key, field)))) continue;
      const args = observer.fields.map((field) =>
        field === "**" ? instance.data : getPath(instance.data, field.replace(/\.\*\*$/, "")),
      );
      try {
        observer.fn.apply(instance, args);
      } catch (error) {
        reportError(error, `${instance.is}.observers["${observer.fields.join(",")}"]`);
      }
    }
  };

  const ownerInstance = (record: PageRecord, nodeId: number) =>
    nodeId === 0 ? record.instance : record.components.get(nodeId)?.instance;

  /** Calls an event handler and returns what it returns. */
  const invokeHandler = (owner: Instance, handler: string, event: WxEvent): unknown => {
    const fn = owner[handler];
    if (typeof fn !== "function") {
      console.warn(
        `[omr] ${owner.is} does not have a method "${handler}" to handle event "${event.type}".`,
      );
      return undefined;
    }
    try {
      return fn.call(owner, event);
    } catch (error) {
      reportError(error, `${owner.is}.${handler}`, owner);
      return undefined;
    }
  };

  const instanceProto = {
    setData(this: Instance, patch: Record<string, unknown>, callback?: AnyFunction) {
      applyData(this, patch, callback);
    },
    createSelectorQuery(this: Instance) {
      return wxApi!.wx.createSelectorQuery().in(this);
    },
    selectComponent(this: Instance, selector: string) {
      return selectComponents(this, selector)[0] ?? null;
    },
    selectAllComponents(this: Instance, selector: string) {
      return selectComponents(this, selector);
    },
    selectOwnerComponent(this: Instance) {
      const meta = metas.get(this);
      const comp = meta?.page.components.get(meta.nodeId);
      return (meta && comp && ownerInstance(meta.page, comp.ownerNodeId)) ?? null;
    },
    hasBehavior(this: Instance, behavior: unknown) {
      return metas.get(this)?.def.behaviors.has(behavior) ?? false;
    },
    getRelationNodes(this: Instance, key: string) {
      const meta = metas.get(this);
      if (!meta) return [];
      const related: ComponentRecord[] = [];
      for (const link of meta.page.links.values()) {
        if (link.a.instance === this && link.aKey === key) related.push(link.b);
        if (link.b.instance === this && link.bKey === key) related.push(link.a);
      }
      return related
        .sort((x, y) => (x.tree?.order ?? Infinity) - (y.tree?.order ?? Infinity))
        .map((comp) => comp.instance);
    },
    /** Every setData in the callback reaches the view; the simulator renders them in one frame anyway. */
    groupSetData(this: Instance, callback?: AnyFunction) {
      callback?.call(this);
    },
    getPageId(this: Instance) {
      const meta = metas.get(this);
      return meta ? `pageId:${meta.page.webviewId}` : "";
    },
    getTabBar(this: Instance) {
      const meta = metas.get(this);
      if (!meta) return null;
      for (const comp of meta.page.components.values()) {
        if (comp.path === CUSTOM_TAB_BAR && comp.ownerNodeId === 0) return comp.instance;
      }
      return meta.page.tabBar?.instance ?? null;
    },
    createIntersectionObserver(this: Instance, options?: Record<string, unknown>) {
      return wxApi!.wx.createIntersectionObserver(this, options);
    },
    createMediaQueryObserver(this: Instance) {
      return wxApi!.wx.createMediaQueryObserver(this);
    },
    animate(this: Instance, ...args: unknown[]) {
      return wxApi!.animate(this, ...args);
    },
    clearAnimation(this: Instance, ...args: unknown[]) {
      return wxApi!.clearAnimation(this, ...args);
    },
    getOpenerEventChannel(this: Instance) {
      // A page opened otherwise gets a channel with nobody at the other end
      return metas.get(this)?.page.openerChannel ?? createEventChannel(undefined).opened;
    },
    /**
     * Fires an event on this component's host. It reaches the host's handlers;
     * with `bubbles`, those of the elements above it in its owner's template;
     * with `composed`, also those inside other components it passes through and
     * above its owner; with `capturePhase`, capture handlers first, from the top.
     */
    triggerEvent(
      this: Instance,
      name: string,
      detail?: unknown,
      options: { bubbles?: boolean; composed?: boolean; capturePhase?: boolean } = {},
    ) {
      const meta = metas.get(this);
      const comp = meta?.page.components.get(meta.nodeId);
      if (!meta || !comp) return;
      const target = { id: String(this.id ?? ""), dataset: this.dataset ?? {} };
      const host: AncestorBindings = {
        ownerId: comp.ownerNodeId,
        ...target,
        events:
          comp.tree?.events ??
          Object.entries(comp.listeners).map(([event, listener]) => ({
            name: event,
            ...listener,
            capture: false,
          })),
      };
      let path = [host, ...(comp.tree?.ancestors ?? [])];
      if (!options.composed) path = path.filter((stop) => stop.ownerId === comp.ownerNodeId);
      const capture = options.capturePhase ? [...path].reverse() : [];
      const bubble = options.bubbles ? path : [host];
      const run = (stop: AncestorBindings, binding: EventBinding) => {
        const owner = ownerInstance(meta.page, stop.ownerId);
        if (!owner || !binding.handler) return;
        invokeHandler(owner, binding.handler, {
          type: name,
          timeStamp: Date.now(),
          target,
          currentTarget: { id: stop.id, dataset: stop.dataset },
          detail: (detail ?? {}) as Record<string, unknown>,
          mark: {},
        });
      };
      for (const [stops, phase] of [
        [capture, true],
        [bubble, false],
      ] as const) {
        for (const stop of stops) {
          for (const binding of stop.events) {
            if (binding.name !== name || binding.capture !== phase) continue;
            run(stop, binding);
            if (binding.catch) return;
          }
        }
      }
    },
  };

  /**
   * The components of `owner`'s template that match a selector: tags, `#id`
   * and `.class` compounds joined by descendant (` `), child (`>`) and
   * cross-component (`>>>`) combinators, in comma-separated groups.
   */
  const selectComponents = (owner: Instance, selector: string): unknown[] => {
    const meta = metas.get(owner);
    if (!meta) return [];
    const groups = parseSelector(String(selector));
    if (!groups) {
      console.warn(`[omr] selectComponent: unsupported selector "${selector}"`);
      return [];
    }
    const { page, nodeId } = meta;
    /** The nearest component above `comp` in the same template, through slots. */
    const treeParent = (comp: ComponentRecord): ComponentRecord | undefined => {
      for (
        let above = page.components.get(comp.tree?.parentId ?? 0);
        above && above.nodeId !== comp.ownerNodeId;
        above = page.components.get(above.tree?.parentId ?? 0)
      ) {
        if (above.ownerNodeId === comp.ownerNodeId) return above;
      }
      return undefined;
    };
    const matches = (comp: ComponentRecord, steps: SelectorStep[], i: number): boolean => {
      const step = steps[i]!;
      if (step.tag !== undefined && comp.tree?.tag !== step.tag) return false;
      if (step.id !== undefined && comp.instance.id !== step.id) return false;
      const classes = (comp.tree?.className ?? "").split(/\s+/);
      if (!step.classes.every((name) => classes.includes(name))) return false;
      // Right of a `>>>`, the component may be in any template below; otherwise in owner's own
      const deep = steps.slice(1, i + 1).some((s) => s.combinator === ">>>");
      if (!deep && comp.ownerNodeId !== nodeId) return false;
      if (i === 0) return true;
      if (step.combinator === ">>>") {
        for (let up = page.components.get(comp.ownerNodeId); up;) {
          if (matches(up, steps, i - 1)) return true;
          up = page.components.get(up.ownerNodeId);
        }
        return false;
      }
      for (
        let up = treeParent(comp);
        up;
        up = step.combinator === ">" ? undefined : treeParent(up)
      ) {
        if (matches(up, steps, i - 1)) return true;
      }
      return false;
    };
    return [...page.components.values()]
      .filter((comp) => groups.some((steps) => matches(comp, steps, steps.length - 1)))
      .sort((a, b) => (a.tree?.order ?? Infinity) - (b.tree?.order ?? Infinity))
      .map((comp) =>
        comp.def.export && comp.def.behaviors.has("wx://component-export")
          ? safeExport(comp)
          : comp.instance,
      );
  };
  const safeExport = (comp: ComponentRecord): unknown => {
    try {
      return comp.def.export!.call(comp.instance);
    } catch (error) {
      reportError(error, `${comp.path}.export`, comp.instance);
      return null;
    }
  };

  // Relations
  /** Whether `other` is what `comp`'s relation names: the component at the key's path, or one with its target behavior. */
  const relationNames = (
    comp: ComponentRecord,
    key: string,
    relation: RelationDefinition,
    other: ComponentRecord,
  ): boolean => {
    if (relation.target !== undefined) return other.def.behaviors.has(relation.target);
    const path = resolvePath(comp.path, key);
    return other.path === path || other.path === `${path}/index`;
  };
  const relationCallback = (
    comp: ComponentRecord,
    key: string,
    name: "linked" | "linkChanged" | "unlinked",
    other: ComponentRecord,
  ) => {
    const fn = comp.def.relations[key]?.[name];
    if (typeof fn !== "function") return;
    try {
      fn.call(comp.instance, other.instance);
    } catch (error) {
      reportError(error, `${comp.path}.relations["${key}"].${name}`, comp.instance);
    }
  };
  /**
   * Links each component to the nearest component above it that both declare
   * each other in `relations`, and unlinks pairs that no longer qualify.
   * `moved` lists components the view moved, whose kept links change.
   */
  const updateRelations = (record: PageRecord, moved: Set<ComponentRecord> = new Set()) => {
    const wanted = new Map<string, Link>();
    for (const comp of record.components.values()) {
      for (const [key, relation] of Object.entries(comp.def.relations)) {
        if (relation.type !== "parent" && relation.type !== "ancestor") continue;
        for (
          let up = record.components.get(comp.tree?.parentId ?? 0);
          up;
          up =
            relation.type === "parent" ? undefined : record.components.get(up.tree?.parentId ?? 0)
        ) {
          if (!relationNames(comp, key, relation, up)) continue;
          const answer = Object.entries(up.def.relations).find(
            ([upKey, upRelation]) =>
              upRelation.type === RECIPROCAL[relation.type] &&
              relationNames(up, upKey, upRelation, comp),
          );
          if (!answer) continue;
          const link = { a: comp, aKey: key, b: up, bKey: answer[0] };
          wanted.set(`${comp.nodeId}:${key}:${up.nodeId}:${answer[0]}`, link);
          break;
        }
      }
    }
    for (const [id, link] of record.links) {
      if (wanted.has(id)) {
        if (moved.has(link.a) || moved.has(link.b)) {
          relationCallback(link.a, link.aKey, "linkChanged", link.b);
          relationCallback(link.b, link.bKey, "linkChanged", link.a);
        }
        continue;
      }
      record.links.delete(id);
      relationCallback(link.a, link.aKey, "unlinked", link.b);
      relationCallback(link.b, link.bKey, "unlinked", link.a);
    }
    for (const [id, link] of wanted) {
      if (record.links.has(id)) continue;
      record.links.set(id, link);
      relationCallback(link.b, link.bKey, "linked", link.a);
      relationCallback(link.a, link.aKey, "linked", link.b);
    }
  };

  const onTree = (record: PageRecord, nodes: TreeNode[]) => {
    const moved = new Set<ComponentRecord>();
    nodes.forEach((node, order) => {
      const comp = record.components.get(node.nodeId);
      if (!comp) return;
      if (comp.tree && comp.tree.parentId !== node.parentId) moved.add(comp);
      comp.tree = { ...node, order };
    });
    for (const comp of moved) callLifetime(comp, "moved");
    updateRelations(record, moved);
  };

  const createInstance = (def: Definition, record: PageRecord, nodeId: number, is: string) => {
    const instance = Object.create(instanceProto) as Instance;
    for (const [key, value] of Object.entries(def.fields)) instance[key] = toJsonValue(value);
    for (const [key, fn] of Object.entries(def.methods)) {
      if (!(key in instanceProto)) instance[key] = fn;
    }
    const data = toJsonValue(def.data) ?? {};
    for (const [name, prop] of Object.entries(def.properties)) data[name] = toJsonValue(prop.value);
    instance.data = data;
    instance.is = is;
    if (def.kind === "component") instance.properties = data;
    // Routers resolve relative URLs against the component's own path, or the page's
    instance.router = createRouter(is);
    instance.pageRouter = createRouter(record.route);
    metas.set(instance, {
      page: record,
      nodeId,
      def,
      initSent: false,
      pendingCallbacks: [],
    });
    return instance;
  };

  const createRouter = (base: string) => {
    const call =
      (name: string) =>
      (options: Record<string, unknown> = {}) => {
        const url = typeof options.url === "string" ? options.url : undefined;
        return wxApi!.wx[name]({
          ...options,
          ...(url === undefined
            ? {}
            : { url: url.startsWith("/") ? url : `/${resolvePath(base, url)}` }),
        });
      };
    return Object.fromEntries(
      ["navigateTo", "redirectTo", "reLaunch", "switchTab", "navigateBack"].map((name) => [
        name,
        call(name),
      ]),
    );
  };

  const coerce = (type: unknown, value: unknown): unknown => {
    if (type === Number && typeof value === "string") return Number(value);
    if (type === String && typeof value === "number") return String(value);
    // As on WeChat, any non-empty string, including "false", is true
    if (type === Boolean) return Boolean(value);
    return value;
  };

  const setProps = (comp: ComponentRecord, props: Record<string, unknown>) => {
    const patch: Record<string, unknown> = {};
    for (const [attr, raw] of Object.entries(props)) {
      const name = attr.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
      if (!Object.hasOwn(comp.def.properties, name)) continue;
      const prop = comp.def.properties[name]!;
      const value = coerce(prop.type, raw);
      if (JSON.stringify(value) === JSON.stringify(comp.instance.data[name])) continue;
      patch[name] = value;
    }
    if (Object.keys(patch).length > 0) applyData(comp.instance, patch);
  };

  // Pages
  const isTabPage = (route: string) => {
    const tabBar = manifest?.appJson.tabBar as { list?: { pagePath: string }[] } | undefined;
    return (tabBar?.list ?? []).some((item) => normalizePath(item.pagePath) === route);
  };

  const openPage = (route: string, query: Record<string, string>): PageRecord => {
    const record: PageRecord = {
      webviewId: nextWebviewId++,
      route,
      query,
      components: new Map(),
      seq: 0,
      renderedSeq: 0,
      callbacks: [],
      pendingInits: 0,
      readyFired: false,
      shown: false,
      links: new Map(),
    };
    pages.set(record.webviewId, record);
    return record;
  };

  const showPage = (record: PageRecord | undefined, background = false) => {
    if (!record?.instance || record.shown) return;
    record.shown = true;
    sendView(record, { type: "pageVisibility", visible: true, ...(background && { background }) });
    callHook(record.instance, "onShow");
    callPageLifetime(record, "show");
    // A page shown again has nothing left to render before its route is done
    if (record.readyFired) callPageLifetime(record, "routeDone");
  };
  const hidePage = (record: PageRecord | undefined, background = false) => {
    if (!record?.instance || !record.shown) return;
    record.shown = false;
    sendView(record, { type: "pageVisibility", visible: false, ...(background && { background }) });
    callHook(record.instance, "onHide");
    callPageLifetime(record, "hide");
  };
  /** Fires a `<web-view>` event at the handler its template binds. */
  const fireWebViewEvent = (
    record: PageRecord,
    name: WebViewEventName,
    detail: Record<string, unknown>,
  ) => {
    const webView = record.webView;
    const binding = webView?.handlers[name];
    const owner = binding && ownerInstance(record, binding.ownerId);
    if (!webView || !binding || !owner) return;
    invokeHandler(owner, binding.handler, {
      type: name,
      timeStamp: Math.round(performance.now()),
      target: webView.target,
      currentTarget: webView.target,
      detail,
      mark: {},
    });
  };
  /**
   * Fires `bindmessage` with what the web page posted, as WeChat does when the
   * page goes back, the web-view goes away, or the page is shared or its link copied.
   */
  const flushWebViewMessages = (record: PageRecord) => {
    const messages = record.webView?.messages;
    if (!messages?.length) return;
    fireWebViewEvent(record, "message", { data: messages.splice(0) });
  };
  /** `wx.miniProgram` in the web page: routes from the web-view's page, and `postMessage`. */
  const miniProgramApi = (record: PageRecord, args: Record<string, unknown>) => {
    const name = String(args.name);
    const arg = (args.arg ?? {}) as Record<string, unknown>;
    try {
      if (name === "postMessage") {
        record.webView!.messages.push(arg);
      } else if (
        ["navigateTo", "redirectTo", "switchTab", "reLaunch", "navigateBack"].includes(name)
      ) {
        const url = typeof arg.url === "string" ? arg.url : undefined;
        navigate(
          name,
          // As wx.switchTab, a tab page takes no query
          { url: name === "switchTab" ? url?.split("?")[0] : url, delta: Number(arg.delta) || 1 },
          record.route,
        );
      } else {
        throw new Error(`${name} is not supported`);
      }
      return { err_msg: "invokeMiniProgramAPI:ok" };
    } catch (error) {
      return { err_msg: `invokeMiniProgramAPI:fail ${(error as Error).message}` };
    }
  };
  const answerWebView = async (message: Extract<ShellToLogic, { type: "webViewInvoke" }>) => {
    const record = pages.get(message.webviewId);
    const result = !record?.webView
      ? { err_msg: `${message.name}:fail the web-view is closed` }
      : message.name === "invokeMiniProgramAPI"
        ? miniProgramApi(record, message.args)
        : await wxApi!.webViewInvoke(message.name, message.args);
    post({ type: "webViewResult", webviewId: message.webviewId, callId: message.callId, result });
  };

  const unloadPage = (record: PageRecord) => {
    const unloadEvent = { path: `/${record.route}`, routeEventId: activeRoute?.routeEventId ?? "" };
    if (record.instance) {
      // Going back from a page, or closing it, hands the web-view's messages over first
      flushWebViewMessages(record);
      wxApi?.app.emit("BeforePageUnload", { ...unloadEvent, page: record.instance });
      callHook(record.instance, "onUnload");
      if (record.def?.kind === "component") {
        callLifetime({ def: record.def, instance: record.instance }, "detached");
      }
      for (const comp of record.components.values()) callLifetime(comp, "detached");
    }
    record.components.clear();
    pages.delete(record.webviewId);
    wxApi?.releasePage(record.webviewId);
    if (record.instance) wxApi?.app.emit("AfterPageUnload", unloadEvent);
    // A query the page started will get no reply now; it finds nothing
    for (const [id, pending] of queryPending) {
      if (pending.webviewId !== record.webviewId) continue;
      queryPending.delete(id);
      pending.resolve(Array.from({ length: pending.count }, () => null));
    }
    for (const [id, pending] of builtinPending) {
      if (pending.webviewId !== record.webviewId) continue;
      builtinPending.delete(id);
      pending.reject(new Error("page is unloaded"));
    }
  };

  const emitRoute = (openType: string) => {
    const entry = (record: PageRecord) => ({ webviewId: record.webviewId, route: record.route });
    post({
      type: "route",
      openType,
      stack: stack.map(entry),
      alive: [...pages.values()].map(entry),
    });
  };

  /**
   * A return (the back button or wx.navigateBack) closes the top page's open
   * `<page-container>` instead of leaving the page; returns whether it did.
   */
  const closePageContainer = () => {
    const top = stack[stack.length - 1];
    if (!top?.containerOpen) return false;
    sendView(top, { type: "closePageContainer" });
    return true;
  };

  /** Performs a navigation. Throws an Error whose message is the WeChat `fail` reason. */
  const navigate = (
    openType: string,
    options: { url?: string; delta?: number; events?: object },
    fromRoute = stack[stack.length - 1]?.route ?? "",
  ): EventChannel | undefined => {
    if (!manifest) throw new Error("app is not launched");
    const top = stack[stack.length - 1];
    if (openType === "navigateBack" && closePageContainer()) return undefined;
    if (openType === "navigateBack") {
      const count = Math.min(Math.max(1, Math.floor(options.delta ?? 1)), stack.length - 1);
      if (count <= 0) throw new Error("cannot navigate back at first page.");
      const target = stack[stack.length - 1 - count]!;
      const event = beginRoute(openType, { ...target }, target.webviewId);
      for (let i = 0; i < count; i++) unloadPage(stack.pop()!);
      showPage(target);
      activeRoute = undefined;
      emitRoute(openType);
      finishRoute(event, target);
      return undefined;
    }
    if (!options.url) throw new Error("parameter.url should be String");
    if (!["navigateTo", "redirectTo", "switchTab", "reLaunch"].includes(openType)) {
      throw new Error(`unknown navigation "${openType}"`);
    }
    /** Why `route` cannot be this navigation's target, if it cannot. */
    const unfit = (route: string) => {
      if (!manifest!.pages.includes(route)) return `page "${route}" is not found`;
      const tab = isTabPage(route);
      if (tab && (openType === "navigateTo" || openType === "redirectTo")) {
        return `can not ${openType} a tabbar page`;
      }
      if (!tab && openType === "switchTab") return "can not switch to no-tabBar page";
      if (openType === "navigateTo" && stack.length >= MAX_STACK) {
        return "webview count limit exceed";
      }
      return undefined;
    };
    const target = parsePageUrl(options.url, fromRoute);
    // Before the route does anything, its listeners may rewrite where it goes
    const reused =
      openType === "switchTab"
        ? [...pages.values()].find((record) => record.route === target.route)
        : undefined;
    const event = beginRoute(openType, target, reused?.webviewId ?? nextWebviewId, (route) => {
      const reason = unfit(route);
      if (reason) throw new Error(reason);
    });
    const reason = unfit(target.route);
    if (reason) {
      activeRoute = undefined;
      throw new Error(reason);
    }
    const { route, query } = target;
    const open = (openRoute: string, openQuery: Record<string, string>) => {
      const record = openPage(openRoute, openQuery);
      record.routeEvent = { ...event, webviewId: record.webviewId };
      return record;
    };
    let channel: EventChannel | undefined;
    switch (openType) {
      case "navigateTo":
      case "redirectTo": {
        if (openType === "navigateTo") {
          hidePage(top);
        } else if (top) {
          unloadPage(top);
          stack.pop();
        }
        const record = open(route, query);
        stack.push(record);
        if (openType === "navigateTo") {
          const pair = createEventChannel(options.events);
          record.openerChannel = pair.opened;
          channel = pair.opener;
        }
        break;
      }
      case "switchTab": {
        for (const record of stack) {
          if (isTabPage(record.route)) hidePage(record);
          else unloadPage(record);
        }
        const existing = [...pages.values()].find((record) => record.route === route);
        stack = [existing ?? open(route, {})];
        showPage(existing);
        if (existing) finishRoute(event, existing);
        break;
      }
      case "reLaunch": {
        for (const record of pages.values()) unloadPage(record);
        stack = [open(route, query)];
        break;
      }
    }
    activeRoute = undefined;
    emitRoute(openType);
    return channel;
  };

  /**
   * Starts a route: calls `wx.onBeforeAppRoute`, whose listeners may change
   * `target` with `wx.rewriteRoute` when `check` accepts the new route.
   */
  const beginRoute = (
    openType: string,
    target: { route: string; query: Record<string, string> },
    webviewId: number,
    check?: (route: string) => void,
  ): RouteEvent => {
    const event: RouteEvent = {
      routeEventId: `route_${++routeEventCount}`,
      openType,
      path: `/${target.route}`,
      query: { ...target.query },
      webviewId,
      timeStamp: Date.now(),
    };
    wxApi?.app.beforeAppRoute(
      { ...routeRes(event), notFound: !manifest!.pages.includes(target.route) },
      (url, preserveQuery) => {
        if (!check) throw new Error(`a ${openType} route can not be rewritten`);
        const next = parsePageUrl(url, target.route);
        check(next.route);
        target.route = next.route;
        if (!preserveQuery) target.query = next.query;
        event.path = `/${target.route}`;
        event.query = { ...target.query };
      },
    );
    activeRoute = event;
    return event;
  };
  const routeRes = (event: RouteEvent) => ({
    path: event.path,
    query: { ...event.query },
    renderer: "webview",
    openType: event.openType,
    webviewId: event.webviewId,
    routeEventId: event.routeEventId,
    notFound: false,
  });
  /** Calls `wx.onAppRoute`, and `wx.onAppRouteDone` once the page has rendered. */
  const finishRoute = (event: RouteEvent, record: PageRecord) => {
    wxApi?.app.emit("AppRoute", { ...routeRes(event), timeStamp: event.timeStamp });
    if (record.readyFired) routeDone(event);
    else record.routeEvent = event;
  };
  const routeDone = (event: RouteEvent) => {
    const { path, query, openType, webviewId, timeStamp, routeEventId } = event;
    wxApi?.app.emit("AppRouteDone", {
      path,
      query: { ...query },
      openType,
      webviewId,
      timeStamp,
      routeEventId,
    });
  };

  /**
   * The navigation bar's back button. With `wx.enableAlertBeforeUnload` on
   * the page, it asks first and stays when the user cancels.
   */
  const backButton = async () => {
    if (closePageContainer()) return;
    const top = stack[stack.length - 1];
    const message =
      top && stack.length > 1 ? wxApi?.app.alertBeforeUnload(top.webviewId) : undefined;
    if (message !== undefined) {
      try {
        const { confirm } = await shellUi("showModal", {
          title: "",
          content: message,
          showCancel: true,
          cancelText: "取消",
          cancelColor: "#000000",
          confirmText: "确定",
          confirmColor: "#576B95",
        });
        if (!confirm || stack[stack.length - 1] !== top) return;
      } catch {
        return;
      }
    }
    try {
      navigate("navigateBack", { delta: 1 });
    } catch (error) {
      console.error(`[omr] ${(error as Error).message}`);
    }
  };

  /**
   * Forwards the page to a friend, as the share button and the capsule menu
   * do: the page's `onShareAppMessage` gives the title and path, waiting up to
   * three seconds for its `promise`, and the user confirms in a sheet.
   */
  const share = async (record: PageRecord, options: Record<string, unknown>) => {
    const instance = record.instance;
    if (!instance) return;
    if (record.webView) {
      flushWebViewMessages(record);
      options = { ...options, webViewUrl: record.webView.url };
    }
    let result = callHook(instance, "onShareAppMessage", options) as
      | Record<string, unknown>
      | undefined;
    if (result?.promise instanceof Promise) {
      const later = await Promise.race([
        result.promise.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
      if (later && typeof later === "object") result = { ...result, ...later };
    }
    const title = typeof result?.title === "string" ? result.title : manifest!.appName;
    const path =
      typeof result?.path === "string"
        ? result.path
        : `/${record.route}${queryString(record.query)}`;
    try {
      await shellUi("showModal", {
        title: "发送给朋友",
        content: `${title}\n${path}`,
        showCancel: true,
        cancelText: "取消",
        cancelColor: "#000000",
        confirmText: "发送",
        confirmColor: "#576B95",
      });
    } catch {
      // The sheet was closed
    }
  };
  const queryString = (query: Record<string, string>) => {
    const pairs = Object.entries(query).map(([key, value]) => `${key}=${value}`);
    return pairs.length > 0 ? `?${pairs.join("&")}` : "";
  };

  /**
   * The menu WeChat shows on a long press of an `<image show-menu-by-longpress>`.
   * Its items act in WeChat, not in the Mini Program, which hears nothing of
   * them; codes in the image are not recognized.
   */
  const imageMenu = async () => {
    const toast =
      (title: string, icon = "success") =>
      () =>
        void shellUi("showToast", { title, icon, duration: 1500 }).catch(() => {});
    const items: [string, () => void][] = [
      ["发送给朋友", toast("已发送")],
      ["收藏", toast("已收藏")],
      ["保存图片", toast("已保存到系统相册", "none")],
      // Opens WeChat's search, which the simulator does not have
      ["搜一搜", () => {}],
    ];
    try {
      const { tapIndex } = await shellUi("showActionSheet", {
        itemList: items.map(([label]) => label),
        itemColor: "#000000",
      });
      items[tapIndex as number]?.[1]();
    } catch {
      // Cancelled
    }
  };

  /** The capsule menu: share options the page supports, then the Mini Program's own. */
  const openMenu = async () => {
    const record = stack[stack.length - 1];
    const instance = record?.instance;
    if (!record || !instance) return;
    const items: [string, () => void][] = [];
    if (typeof instance.onShareAppMessage === "function") {
      items.push(["发送给朋友", () => void share(record, { from: "menu" })]);
    }
    if (typeof instance.onShareTimeline === "function") {
      items.push(["分享到朋友圈", () => void shareTimeline(record)]);
    }
    items.push([
      "收藏",
      () => {
        const result = callHook(instance, "onAddToFavorites", {
          webViewUrl: record.webView?.url ?? "",
        });
        const title = (result as Record<string, unknown> | undefined)?.title;
        void shellUi("showToast", {
          title: `已收藏 ${typeof title === "string" ? title : manifest!.appName}`,
          icon: "none",
          duration: 1500,
        }).catch(() => {});
      },
    ]);
    if (record.webView) {
      items.push([
        "复制链接",
        () => {
          flushWebViewMessages(record);
          // WeChat copies the link itself, without the Mini Program's privacy check
          void shellUi("showToast", {
            title: "已复制链接",
            icon: "success",
            duration: 1500,
          }).catch(() => {});
        },
      ]);
    }
    items.push([
      "重新进入小程序",
      () => navigate("reLaunch", { url: `/${manifest!.entryPage}` }, ""),
    ]);
    try {
      const { tapIndex } = await shellUi("showActionSheet", {
        itemList: items.map(([label]) => label),
        itemColor: "#000000",
      });
      items[tapIndex as number]?.[1]();
    } catch {
      // Cancelled
    }
  };
  const shareTimeline = async (record: PageRecord) => {
    const result = callHook(record.instance, "onShareTimeline") as
      | Record<string, unknown>
      | undefined;
    const title = typeof result?.title === "string" ? result.title : manifest!.appName;
    try {
      await shellUi("showModal", {
        title: "分享到朋友圈",
        content: `${title}${typeof result?.query === "string" && result.query ? `\n?${result.query}` : ""}`,
        showCancel: true,
        cancelText: "取消",
        cancelColor: "#000000",
        confirmText: "发表",
        confirmColor: "#576B95",
      });
    } catch {
      // The sheet was closed
    }
  };

  // Messages from views
  const onViewReady = (record: PageRecord) => {
    const route = record.routeEvent;
    const loadRes = route && {
      path: route.path,
      query: { ...route.query },
      componentFramework: "exparser",
      openType: route.openType,
      routeEventId: route.routeEventId,
    };
    if (loadRes) wxApi?.app.emit("BeforePageLoad", loadRes);
    const def = loadDefinition(record.route, pageDefs);
    const instance = createInstance(def, record, 0, record.route);
    instance.route = record.route;
    instance.__route__ = record.route;
    instance.options = { ...record.query };
    record.def = def;
    record.instance = instance;
    if (def.kind === "component") {
      const comp = { def, instance };
      callLifetime(comp, "created");
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record.query)) {
        const prop = def.properties[key];
        if (prop) patch[key] = coerce(prop.type, value);
      }
      if (Object.keys(patch).length > 0) applyData(instance, patch);
      callLifetime(comp, "attached");
    }
    const tabBar = manifest?.appJson.tabBar as { custom?: boolean } | undefined;
    if (
      tabBar?.custom === true &&
      isTabPage(record.route) &&
      componentDefsLoadable(CUSTOM_TAB_BAR)
    ) {
      const comp = createComponent(record, -1, CUSTOM_TAB_BAR, 0);
      record.tabBar = comp;
      callLifetime(comp, "created");
      callLifetime(comp, "attached");
    }
    callHook(instance, "onLoad", { ...record.query });
    if (stack[stack.length - 1] === record) showPage(record);
    if (loadRes) {
      wxApi?.app.emit("AfterPageLoad", { ...loadRes, page: instance });
      wxApi?.app.emit("AppRoute", { ...routeRes(route), timeStamp: route.timeStamp });
    }
    wxApi?.app.pageOpened(record.webviewId);

    const seq = nextSeq(record);
    record.initSeq = seq;
    const meta = metas.get(instance)!;
    meta.initSent = true;
    for (const fn of meta.pendingCallbacks.splice(0)) record.callbacks.push({ seq, fn });
    sendView(record, { type: "init", data: toJsonValue(viewData(def, instance.data)), seq });
  };

  const createComponent = (
    record: PageRecord,
    nodeId: number,
    path: string,
    ownerNodeId: number,
  ): ComponentRecord => {
    const def = loadDefinition(path, componentDefs);
    const instance = createInstance(def, record, nodeId, path);
    instance.id = "";
    instance.dataset = {};
    return { nodeId, path, def, instance, ownerNodeId, listeners: {}, readyFired: false };
  };

  const onAttach = (record: PageRecord, message: Extract<ViewToLogic, { type: "attach" }>) => {
    // The custom tab bar was created with the page; it is attached as it is
    const early =
      message.ownerId === 0 && message.path === CUSTOM_TAB_BAR ? record.tabBar : undefined;
    record.tabBar = undefined;
    const comp = early ?? createComponent(record, message.nodeId, message.path, message.ownerId);
    const { instance, def } = comp;
    comp.nodeId = message.nodeId;
    metas.get(instance)!.nodeId = message.nodeId;
    comp.listeners = message.listeners;
    instance.id = message.id;
    instance.dataset = message.dataset;
    record.components.set(message.nodeId, comp);
    if (!record.readyFired) record.pendingInits++;
    if (!early) callLifetime(comp, "created");
    setProps(comp, message.props);
    if (!early) callLifetime(comp, "attached");

    const seq = nextSeq(record);
    comp.initSeq = seq;
    const meta = metas.get(instance)!;
    meta.initSent = true;
    for (const fn of meta.pendingCallbacks.splice(0)) record.callbacks.push({ seq, fn });
    sendView(record, {
      type: "componentInit",
      nodeId: message.nodeId,
      data: toJsonValue(viewData(def, instance.data)),
      options: {
        externalClasses: def.externalClasses,
        styleIsolation:
          (def.options.styleIsolation as string | undefined) ??
          (def.options.addGlobalClass ? "apply-shared" : "isolated"),
        virtualHost: def.options.virtualHost === true,
        formField: def.behaviors.has("wx://form-field"),
        formFieldGroup: def.behaviors.has("wx://form-field-group"),
        formFieldButton: def.behaviors.has("wx://form-field-button"),
      },
      seq,
    });
  };

  const onRendered = (record: PageRecord, seq: number) => {
    record.renderedSeq = Math.max(record.renderedSeq, seq);
    const due = record.callbacks.filter((entry) => entry.seq <= seq);
    record.callbacks = record.callbacks.filter((entry) => entry.seq > seq);
    for (const comp of record.components.values()) {
      if (!comp.readyFired && comp.initSeq !== undefined && comp.initSeq <= seq) {
        comp.readyFired = true;
        callLifetime(comp, "ready");
        if (!record.readyFired) record.pendingInits--;
      }
    }
    for (const entry of due) {
      try {
        entry.fn();
      } catch (error) {
        reportError(error, "setData callback");
      }
    }
    checkPageReady(record);
  };

  const checkPageReady = (record: PageRecord) => {
    if (
      record.readyFired ||
      record.initSeq === undefined ||
      record.renderedSeq < record.initSeq ||
      record.pendingInits > 0 ||
      !record.instance
    ) {
      return;
    }
    record.readyFired = true;
    if (record.def?.kind === "component") {
      callLifetime({ def: record.def, instance: record.instance }, "ready");
    }
    callHook(record.instance, "onReady");
    if (record.shown) callPageLifetime(record, "routeDone");
    if (record.routeEvent) routeDone(record.routeEvent);
    record.routeEvent = undefined;
  };

  const onViewMessage = async (record: PageRecord, message: ViewToLogic) => {
    switch (message.type) {
      case "ready":
        onViewReady(record);
        break;
      case "rendered":
        onRendered(record, message.seq);
        break;
      case "attach":
        onAttach(record, message);
        break;
      case "props": {
        const comp = record.components.get(message.nodeId);
        if (!comp) break;
        comp.listeners = message.listeners;
        comp.instance.id = message.id;
        comp.instance.dataset = message.dataset;
        setProps(comp, message.props);
        break;
      }
      case "detach":
        for (const nodeId of message.nodeIds) {
          const comp = record.components.get(nodeId);
          if (!comp) continue;
          record.components.delete(nodeId);
          if (!comp.readyFired && !record.readyFired) record.pendingInits--;
          callLifetime(comp, "detached");
        }
        updateRelations(record);
        checkPageReady(record);
        break;
      case "tree":
        onTree(record, message.nodes);
        break;
      case "event": {
        let owner = ownerInstance(record, message.ownerId);
        // An input's handler may return the field's new value; the view waits for the answer
        const { replyId } = message;
        if (replyId !== undefined) {
          const result =
            owner && message.handler
              ? invokeHandler(owner, message.handler, message.event)
              : undefined;
          const value =
            typeof result === "string" || typeof result === "number" ? String(result) : undefined;
          sendView(record, { type: "eventResult", replyId, value });
          break;
        }
        if (!owner) break;
        const event = message.event;
        if (message.openType) {
          const detail = await wxApi!.openTypeDetail(
            message.openType,
            event.currentTarget.id,
            message.openTypeProps,
          );
          if (!detail) break;
          event.detail = { ...event.detail, ...detail };
          // The page or component may be gone once the user answers the dialog
          if (pages.get(record.webviewId) !== record) break;
          owner = ownerInstance(record, message.ownerId);
          if (!owner) break;
        }
        if (message.openType === "share") {
          void share(record, { from: "button", target: event.currentTarget });
        }
        const { handler } = message;
        if (!handler) break;
        if (message.openType || TAP_EVENTS.has(event.type)) {
          runWithTapGesture(() => invokeHandler(owner, handler, event));
        } else {
          invokeHandler(owner, handler, event);
        }
        break;
      }
      case "nickname":
        void wxApi!.nicknameFocus(message.focused, record.webviewId);
        break;
      case "camera":
        void wxApi!.cameraMounted(record.webviewId, message.cameraId, message.mounted, message);
        break;
      case "livePusher":
        void wxApi!.livePusherMounted(record.webviewId, message.pusherId, message.mounted);
        break;
      case "voipRoom":
        wxApi!.voipRoomMounted(
          record.webviewId,
          message.roomId,
          message.mounted,
          message.openid,
          message.mode,
        );
        break;
      case "animationDone":
        wxApi!.animationDone(record.webviewId, message.animationId);
        break;
      case "intersection":
      case "mediaQuery":
        wxApi!.observerMessage(record.webviewId, message);
        break;
      case "navigate":
        try {
          // The navigator component's open-type names
          const openType =
            { navigate: "navigateTo", redirect: "redirectTo", exit: "" }[message.openType] ??
            message.openType;
          if (openType) {
            navigate(openType, { url: message.url, delta: message.delta }, record.route);
          }
        } catch (error) {
          console.error(`[omr] navigator: ${(error as Error).message}`);
        }
        break;
      case "scroll":
        callHook(record.instance, "onPageScroll", { scrollTop: message.scrollTop });
        break;
      case "resize": {
        const size = { size: message.size };
        callHook(record.instance, "onResize", size);
        callPageLifetime(record, "resize", size);
        if (stack[stack.length - 1] === record)
          wxApi!.app.emit("WindowResize", { ...message.size });
        break;
      }
      case "reachBottom":
        callHook(record.instance, "onReachBottom");
        break;
      case "pullDownRefresh":
        callHook(record.instance, "onPullDownRefresh");
        break;
      case "navigationBar":
        applyNavigationBar(record, message.attributes);
        break;
      case "webView": {
        const before = record.webView;
        if (!message.src) {
          if (!before) break;
          // A web-view that goes away hands its messages over
          flushWebViewMessages(record);
          record.webView = undefined;
          post({ type: "webView", webviewId: record.webviewId });
          break;
        }
        record.webView = {
          src: message.src,
          target: message.target ?? { id: "", dataset: {}, offsetLeft: 0, offsetTop: 0 },
          handlers: message.handlers ?? {},
          url: before?.src === message.src ? before.url : message.src,
          messages: before?.messages ?? [],
        };
        if (before?.src !== message.src) {
          post({ type: "webView", webviewId: record.webviewId, src: message.src });
        }
        break;
      }
      case "videoFullScreen":
        post({
          type: "videoFullScreen",
          webviewId: record.webviewId,
          fullScreen: message.fullScreen,
        });
        break;
      case "pageContainer":
        record.containerOpen = message.open;
        break;
      case "imageMenu":
        void imageMenu();
        break;
      case "officialAccount":
        sendView(record, {
          type: "officialAccountState",
          accountId: message.accountId,
          ...wxApi!.officialAccountState(),
        });
        break;
      case "navigateMiniProgram": {
        const { openType, props, target, handlers } = message;
        const api = {
          navigate: "navigateToMiniProgram",
          navigateBack: "navigateBackMiniProgram",
          exit: "exitMiniProgram",
        }[openType];
        if (!api) break;
        const options =
          openType === "navigate"
            ? {
                appId: props["app-id"],
                path: props.path,
                extraData: props["extra-data"],
                envVersion: props.version,
                shortLink: props["short-link"],
              }
            : openType === "navigateBack"
              ? { extraData: props["extra-data"] }
              : {};
        const fire = (name: "success" | "fail" | "complete") => (detail: unknown) => {
          const binding = handlers[name];
          const owner = binding && ownerInstance(record, binding.ownerId);
          if (!owner) return;
          invokeHandler(owner, binding.handler, {
            type: name,
            timeStamp: Date.now(),
            target,
            currentTarget: target,
            detail: toJsonValue(detail) as Record<string, unknown>,
          });
        };
        // The navigator's tap is the user gesture that opening another Mini Program needs
        runWithTapGesture(() =>
          (wxApi!.wx[api] as (options: object) => unknown)({
            ...Object.fromEntries(
              Object.entries(options).filter(([, value]) => value !== undefined),
            ),
            success: fire("success"),
            fail: fire("fail"),
            complete: fire("complete"),
          }),
        );
        break;
      }
      case "viewReply":
        wxApi!.app.viewReply(record.webviewId, message.requestId, message.result, message.error);
        break;
      case "queryResult": {
        // Only the WebView that was asked may answer
        const pending = queryPending.get(message.queryId);
        if (pending?.webviewId !== record.webviewId) break;
        queryPending.delete(message.queryId);
        pending.resolve(message.results);
        break;
      }
      case "builtinResult": {
        const pending = builtinPending.get(message.callId);
        if (pending?.webviewId !== record.webviewId) break;
        builtinPending.delete(message.callId);
        if (message.error === undefined) pending.resolve(message.result ?? {});
        else pending.reject(new Error(message.error));
        break;
      }
    }
  };

  const boot = (message: Extract<ShellToLogic, { type: "boot" }>) => {
    manifest = message.manifest;
    // Without a prototype, any storage key, such as __proto__, is an ordinary key
    const storage = Object.assign(
      Object.create(null) as Record<string, unknown>,
      message.storage ?? toJsonValue(manifest.config.storage ?? {}),
    );
    const launch = message.launch ?? { path: manifest.entryPage, query: {} };
    const missing = manifest.pages.includes(launch.path) ? undefined : { ...launch };
    if (missing) {
      launch.path = manifest.entryPage;
      launch.query = {};
    }
    const launchOptions = {
      path: launch.path,
      query: { ...launch.query },
      scene: message.scene ?? 1001,
      referrerInfo: {},
      apiCategory: "default",
    };
    theme = message.theme ?? "light";
    enterOptions = launchOptions;
    wxApi = createWx({
      manifest,
      system: message.system,
      menuButton: message.menuButton,
      storage,
      launchOptions,
      enterOptions: () => enterOptions,
      theme: () => theme,
      fs: options.fs ?? new MemoryFs(),
      saveStorage: () => post({ type: "storage", storage }),
      ui: shellUi,
      navigate: (openType, options) => navigate(openType, options),
      topWebviewId: () => stack[stack.length - 1]?.webviewId,
      scopeOf: (instance) => {
        const meta = metas.get(instance);
        return meta ? { webviewId: meta.page.webviewId, nodeId: meta.nodeId } : undefined;
      },
      query: (webviewId, requests: SelectorQueryRequest[]) =>
        new Promise((resolve) => {
          const record = pages.get(webviewId);
          if (!record) {
            resolve(requests.map(() => null));
            return;
          }
          const id = ++queryId;
          queryPending.set(id, { webviewId, resolve, count: requests.length });
          sendView(record, { type: "query", queryId: id, requests });
        }),
      callBuiltin: (webviewId, target, method, args) =>
        new Promise((resolve, reject) => {
          const record = pages.get(webviewId);
          if (!record) {
            reject(new Error("page is unloaded"));
            return;
          }
          const callId = ++builtinCallId;
          builtinPending.set(callId, { webviewId, resolve, reject });
          sendView(record, { type: "callBuiltin", callId, target, method, args });
        }),
      sendView: (webviewId, viewMessage) => {
        const record = pages.get(webviewId);
        if (record) sendView(record, viewMessage);
      },
      setPermissionsInUse: (kinds) => post({ type: "permissionsInUse", kinds }),
      exit: () => post({ type: "exit" }),
      setTabBarHidden: (hidden) => {
        tabBarHidden = hidden;
      },
      windowInsets: () => {
        // Before the first page opens, the window is the launch page's
        const route = stack[stack.length - 1]?.route ?? launch.path;
        const custom = message.manifest.windows[route]?.navigationStyle === "custom";
        return {
          top: custom ? 0 : message.chrome.navigationBar,
          bottom: isTabPage(route) && !tabBarHidden ? message.chrome.tabBar : 0,
        };
      },
    });

    Object.assign(globalThis, {
      App,
      Page,
      Component,
      Behavior: defineBehavior,
      getApp,
      getCurrentPages,
      wx: wxApi.wx,
      __omrDefine: (file: string, factory: AnyFunction) => factories.set(file, factory),
    });
    try {
      // oxlint-disable-next-line no-eval -- the Mini Program's code runs in this Worker by design
      (0, eval)(message.appService);
    } catch (error) {
      reportError(error, "app-service.js");
    }
    if (factories.has("app.js")) {
      try {
        requireModule("app.js");
      } catch (error) {
        reportError(error, "app.js");
      }
    }
    if (!app) {
      console.error("[omr] app.js did not call App()");
      app = {} as Instance;
    }
    // A promise rejected without a handler reaches App.onUnhandledRejection
    (globalThis as { addEventListener?: AnyFunction }).addEventListener?.(
      "unhandledrejection",
      (event: { reason: unknown; promise: unknown; preventDefault(): void }) => {
        const res = { reason: event.reason, promise: event.promise };
        callHook(app, "onUnhandledRejection", res);
        wxApi?.app.emit("UnhandledRejection", res);
      },
    );
    callHook(app, "onLaunch", launchOptions);
    callHook(app, "onShow", launchOptions);
    // The launch is a route too: wx.onBeforeAppRoute may rewrite it, such as away from a missing page
    const target = { route: (missing ?? launch).path, query: { ...(missing ?? launch).query } };
    const event = beginRoute("appLaunch", target, nextWebviewId, (route) => {
      if (!manifest!.pages.includes(route)) throw new Error(`page "${route}" is not found`);
    });
    activeRoute = undefined;
    const open = () => {
      const record = openPage(launch.path, launch.query);
      record.routeEvent = {
        ...event,
        path: `/${launch.path}`,
        query: { ...launch.query },
        webviewId: record.webviewId,
      };
      stack = [record];
      emitRoute("appLaunch");
    };
    if (!missing || manifest.pages.includes(target.route)) {
      launch.path = target.route;
      launch.query = target.query;
      open();
      return;
    }
    // onPageNotFound may redirect with wx.redirectTo or wx.reLaunch; otherwise the entry page opens
    const notFound = { path: missing.path, query: { ...missing.query }, isEntryPage: true };
    callHook(app, "onPageNotFound", notFound);
    wxApi.app.emit("PageNotFound", { ...notFound, query: { ...notFound.query } });
    setTimeout(() => {
      if (stack.length > 0) return;
      console.error(
        `[omr] launch page "${missing.path}" is not in app.json; opening the entry page`,
      );
      open();
    }, 0);
  };

  // Leaving hides the page, then the app; coming back shows the app, then the page
  const appHide = () => {
    if (!wxApi || inBackground) return;
    inBackground = true;
    hidePage(stack[stack.length - 1], true);
    callHook(app, "onHide");
    wxApi.app.emit("AppHide", {});
    wxApi.stopCameras(true);
    wxApi.interruptVoip();
  };
  const appShow = (scene = 1001) => {
    if (!wxApi || !inBackground) return;
    inBackground = false;
    const top = stack[stack.length - 1];
    enterOptions = {
      path: top?.route ?? "",
      query: { ...top?.query },
      scene,
      referrerInfo: {},
      apiCategory: "default",
    };
    callHook(app, "onShow", toJsonValue(enterOptions));
    wxApi.app.emit("AppShow", toJsonValue(enterOptions));
    wxApi.stopCameras(false);
    showPage(top, true);
  };
  const changeTheme = (next: Theme) => {
    if (next === theme) return;
    theme = next;
    // Only a Mini Program that supports DarkMode hears of the change
    if (!wxApi || manifest?.appJson.darkmode !== true) return;
    callHook(app, "onThemeChange", { theme });
    wxApi.app.emit("ThemeChange", { theme });
  };

  return (message: ShellToLogic) => {
    switch (message.type) {
      case "boot":
        boot(message);
        break;
      case "appHide":
        appHide();
        break;
      case "appShow":
        appShow(message.scene);
        break;
      case "theme":
        changeTheme(message.theme);
        break;
      case "webViewEvent": {
        const record = pages.get(message.webviewId);
        if (!record?.webView) break;
        if (message.name !== "error" && typeof message.detail.src === "string") {
          record.webView.url = message.detail.src;
        }
        if (message.name !== "location") fireWebViewEvent(record, message.name, message.detail);
        break;
      }
      case "webViewInvoke":
        void answerWebView(message);
        break;
      case "view": {
        const record = pages.get(message.webviewId);
        if (record) void onViewMessage(record, message.message);
        break;
      }
      case "uiResult": {
        const pending = uiPending.get(message.callId);
        uiPending.delete(message.callId);
        if (message.error) pending?.reject(new Error(message.error));
        else pending?.resolve(message.result ?? {});
        break;
      }
      case "switchTab": {
        try {
          navigate("switchTab", { url: message.url }, "");
        } catch (error) {
          console.error(`[omr] tabBar: ${(error as Error).message}`);
          break;
        }
        const top = stack[stack.length - 1];
        const tabBar = manifest?.appJson.tabBar as
          | { list?: { pagePath: string; text?: string }[] }
          | undefined;
        const index = (tabBar?.list ?? []).findIndex(
          (item) => normalizePath(item.pagePath) === top?.route,
        );
        const item = tabBar?.list?.[index];
        callHook(top?.instance, "onTabItemTap", {
          index,
          pagePath: item?.pagePath,
          text: item?.text ?? "",
        });
        break;
      }
      case "navigateBack":
        void backButton();
        break;
      case "reLaunch":
        try {
          navigate("reLaunch", { url: message.url }, "");
        } catch (error) {
          console.error(`[omr] home button: ${(error as Error).message}`);
        }
        break;
      case "menu":
        void openMenu();
        break;
    }
  };
}

/** Parses a `selectComponent` selector into groups of steps, or undefined when it uses what is not supported. */
function parseSelector(selector: string): SelectorStep[][] | undefined {
  const groups: SelectorStep[][] = [];
  for (const group of selector.split(",")) {
    const tokens = group
      .trim()
      .replace(/\s*(>>>|>)\s*/g, " $1 ")
      .split(/\s+/)
      .filter(Boolean);
    const steps: SelectorStep[] = [];
    let combinator: SelectorStep["combinator"] = "";
    for (const token of tokens) {
      if (token === ">" || token === ">>>") {
        if (combinator !== " " || steps.length === 0) return undefined;
        combinator = token;
        continue;
      }
      const step: SelectorStep = { combinator: steps.length === 0 ? "" : combinator, classes: [] };
      const parts = [...token.matchAll(/([#.]?)(-?[_a-zA-Z][\w-]*)/g)];
      if (parts.map((part) => part[0]).join("") !== token) return undefined;
      for (const [index, [, sigil, name]] of parts.entries()) {
        if (sigil === "#") step.id = name;
        else if (sigil === ".") step.classes.push(name!);
        else if (index === 0) step.tag = name;
        else return undefined;
      }
      steps.push(step);
      combinator = " ";
    }
    if (steps.length === 0 || combinator !== " ") return undefined;
    groups.push(steps);
  }
  return groups;
}
