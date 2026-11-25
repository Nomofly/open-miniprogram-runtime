/**
 * The logic layer: runs the Mini Program's JavaScript (`App`, `Page`,
 * `Component`), owns page data and the page stack, and talks to the view layer
 * of each page only through messages, as WeChat's two-thread model does.
 */
import { getPath, setPath, toJsonValue } from "./data.ts";
import { affects, defineBehavior, normalizeComponent, normalizePage } from "./definition.ts";
import type { Definition } from "./definition.ts";
import { dirname, normalizePath, parsePageUrl, resolvePath } from "./paths.ts";
import type {
  ComponentListeners,
  LogicToShell,
  LogicToView,
  Manifest,
  SelectorQueryRequest,
  ShellToLogic,
  ViewToLogic,
  WxEvent,
} from "./protocol.ts";
import { createWx, runWithTapGesture } from "./wx.ts";

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
}

interface PageRecord {
  webviewId: number;
  route: string;
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

/** Starts a logic layer. Returns the handler for messages from the shell. */
export function startLogic(post: (message: LogicToShell) => void): (message: ShellToLogic) => void {
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
  const queryPending = new Map<number, (results: unknown[]) => void>();
  let wxApi: ReturnType<typeof createWx> | undefined;

  // Module system for the bundle from the compiler's compileAppService
  const resolveModule = (from: string, spec: string): string | undefined => {
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
      reportError(error, `${target?.is ?? "App"}.${name}`);
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
        reportError(error, `${comp.instance.is}.lifetimes.${name}`);
      }
    }
  };
  const callPageLifetime = (record: PageRecord, name: string, ...args: unknown[]) => {
    for (const comp of record.components.values()) {
      for (const fn of comp.def.pageLifetimes[name] ?? []) {
        try {
          fn.apply(comp.instance, args);
        } catch (error) {
          reportError(error, `${comp.path}.pageLifetimes.${name}`);
        }
      }
    }
  };
  const reportError = (error: unknown, where: string) => {
    console.error("[omr] error in %s:", where, error);
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
      sendView(meta.page, { type: "setData", nodeId: meta.nodeId, patch: toJsonValue(patch), seq });
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

  const invokeHandler = (owner: Instance, handler: string, event: WxEvent) => {
    const fn = owner[handler];
    if (typeof fn !== "function") {
      console.warn(
        `[omr] ${owner.is} does not have a method "${handler}" to handle event "${event.type}".`,
      );
      return;
    }
    try {
      fn.call(owner, event);
    } catch (error) {
      reportError(error, `${owner.is}.${handler}`);
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
    getOpenerEventChannel() {
      return { on() {}, once() {}, off() {}, emit() {} };
    },
    triggerEvent(
      this: Instance,
      name: string,
      detail?: unknown,
      _options?: { bubbles?: boolean; composed?: boolean },
    ) {
      const meta = metas.get(this);
      const comp = meta?.page.components.get(meta.nodeId);
      if (!meta || !comp) return;
      const listener = comp.listeners[name];
      if (!listener) return;
      const owner = ownerInstance(meta.page, comp.ownerNodeId);
      if (!owner) return;
      const target = { id: String(this.id ?? ""), dataset: this.dataset ?? {} };
      invokeHandler(owner, listener.handler, {
        type: name,
        timeStamp: Date.now(),
        target,
        currentTarget: target,
        detail: (detail ?? {}) as Record<string, unknown>,
        mark: {},
      });
    },
  };

  /** `selectComponent` supports `#id` selectors, the most common form. */
  const selectComponents = (owner: Instance, selector: string): Instance[] => {
    const meta = metas.get(owner);
    if (!meta) return [];
    const match = /^#([\w-]+)$/.exec(selector.trim());
    if (!match) {
      console.warn(`[omr] selectComponent supports only "#id" selectors, got "${selector}"`);
      return [];
    }
    return [...meta.page.components.values()]
      .filter((comp) => comp.ownerNodeId === meta.nodeId && comp.instance.id === match[1])
      .map((comp) => comp.instance);
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
    metas.set(instance, {
      page: record,
      nodeId,
      def,
      initSent: false,
      pendingCallbacks: [],
    });
    return instance;
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
    };
    pages.set(record.webviewId, record);
    return record;
  };

  const showPage = (record: PageRecord | undefined) => {
    if (!record?.instance || record.shown) return;
    record.shown = true;
    callHook(record.instance, "onShow");
    callPageLifetime(record, "show");
  };
  const hidePage = (record: PageRecord | undefined) => {
    if (!record?.instance || !record.shown) return;
    record.shown = false;
    callHook(record.instance, "onHide");
    callPageLifetime(record, "hide");
  };
  const unloadPage = (record: PageRecord) => {
    if (record.instance) {
      callHook(record.instance, "onUnload");
      if (record.def?.kind === "component") {
        callLifetime({ def: record.def, instance: record.instance }, "detached");
      }
      for (const comp of record.components.values()) callLifetime(comp, "detached");
    }
    record.components.clear();
    pages.delete(record.webviewId);
    wxApi?.releasePage(record.webviewId);
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

  /** Performs a navigation. Throws an Error whose message is the WeChat `fail` reason. */
  const navigate = (
    openType: string,
    options: { url?: string; delta?: number },
    fromRoute = stack[stack.length - 1]?.route ?? "",
  ): void => {
    if (!manifest) throw new Error("app is not launched");
    const top = stack[stack.length - 1];
    if (openType === "navigateBack") {
      const count = Math.min(Math.max(1, Math.floor(options.delta ?? 1)), stack.length - 1);
      if (count <= 0) throw new Error("cannot navigate back at first page.");
      for (let i = 0; i < count; i++) unloadPage(stack.pop()!);
      showPage(stack[stack.length - 1]);
      emitRoute(openType);
      return;
    }
    if (!options.url) throw new Error("parameter.url should be String");
    const { route, query } = parsePageUrl(options.url, fromRoute);
    if (!manifest.pages.includes(route)) throw new Error(`page "${route}" is not found`);
    const tab = isTabPage(route);
    switch (openType) {
      case "navigateTo":
      case "redirectTo": {
        if (tab) throw new Error(`can not ${openType} a tabbar page`);
        if (openType === "navigateTo") {
          if (stack.length >= MAX_STACK) throw new Error("webview count limit exceed");
          hidePage(top);
        } else if (top) {
          unloadPage(top);
          stack.pop();
        }
        stack.push(openPage(route, query));
        break;
      }
      case "switchTab": {
        if (!tab) throw new Error("can not switch to no-tabBar page");
        for (const record of stack) {
          if (isTabPage(record.route)) hidePage(record);
          else unloadPage(record);
        }
        const existing = [...pages.values()].find((record) => record.route === route);
        stack = [existing ?? openPage(route, {})];
        showPage(existing);
        break;
      }
      case "reLaunch": {
        for (const record of pages.values()) unloadPage(record);
        stack = [openPage(route, query)];
        break;
      }
      default:
        throw new Error(`unknown navigation "${openType}"`);
    }
    emitRoute(openType);
  };

  // Messages from views
  const onViewReady = (record: PageRecord) => {
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
    callHook(instance, "onLoad", { ...record.query });
    if (stack[stack.length - 1] === record) showPage(record);

    const seq = nextSeq(record);
    record.initSeq = seq;
    const meta = metas.get(instance)!;
    meta.initSent = true;
    for (const fn of meta.pendingCallbacks.splice(0)) record.callbacks.push({ seq, fn });
    sendView(record, { type: "init", data: toJsonValue(instance.data), seq });
  };

  const onAttach = (record: PageRecord, message: Extract<ViewToLogic, { type: "attach" }>) => {
    const def = loadDefinition(message.path, componentDefs);
    const instance = createInstance(def, record, message.nodeId, message.path);
    instance.id = message.id;
    instance.dataset = message.dataset;
    const comp: ComponentRecord = {
      nodeId: message.nodeId,
      path: message.path,
      def,
      instance,
      ownerNodeId: message.ownerId,
      listeners: message.listeners,
      readyFired: false,
    };
    record.components.set(message.nodeId, comp);
    if (!record.readyFired) record.pendingInits++;
    callLifetime(comp, "created");
    setProps(comp, message.props);
    callLifetime(comp, "attached");

    const seq = nextSeq(record);
    comp.initSeq = seq;
    const meta = metas.get(instance)!;
    meta.initSent = true;
    for (const fn of meta.pendingCallbacks.splice(0)) record.callbacks.push({ seq, fn });
    sendView(record, {
      type: "componentInit",
      nodeId: message.nodeId,
      data: toJsonValue(instance.data),
      options: {
        externalClasses: def.externalClasses,
        styleIsolation:
          (def.options.styleIsolation as string | undefined) ??
          (def.options.addGlobalClass ? "apply-shared" : "isolated"),
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
        checkPageReady(record);
        break;
      case "event": {
        const owner = ownerInstance(record, message.ownerId);
        if (!owner) break;
        const event = message.event;
        if (message.openType) {
          const detail = await wxApi!.openTypeDetail(message.openType, event.currentTarget.id);
          if (!detail) break;
          event.detail = { ...event.detail, ...detail };
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
        void wxApi!.cameraMounted(record.webviewId, message.cameraId, message.mounted);
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
      case "reachBottom":
        callHook(record.instance, "onReachBottom");
        break;
      case "queryResult":
        queryPending.get(message.queryId)?.(message.results);
        queryPending.delete(message.queryId);
        break;
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
    if (!manifest.pages.includes(launch.path)) {
      console.error(
        `[omr] launch page "${launch.path}" is not in app.json; opening the entry page`,
      );
      launch.path = manifest.entryPage;
      launch.query = {};
    }
    const launchOptions = {
      path: launch.path,
      query: { ...launch.query },
      scene: 1001,
      referrerInfo: {},
      apiCategory: "default",
    };
    wxApi = createWx({
      manifest,
      system: message.system,
      menuButton: message.menuButton,
      storage,
      launchOptions,
      saveStorage: () => post({ type: "storage", storage }),
      ui: (name, args) =>
        new Promise((resolve, reject) => {
          const callId = ++uiCallId;
          uiPending.set(callId, { resolve, reject });
          post({ type: "ui", callId, name, args });
        }),
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
          queryPending.set(id, resolve);
          sendView(record, { type: "query", queryId: id, requests });
        }),
      sendView: (webviewId, viewMessage) => {
        const record = pages.get(webviewId);
        if (record) sendView(record, viewMessage);
      },
      setPermissionsInUse: (kinds) => post({ type: "permissionsInUse", kinds }),
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
    callHook(app, "onLaunch", launchOptions);
    callHook(app, "onShow", launchOptions);
    stack = [openPage(launch.path, launch.query)];
    emitRoute("appLaunch");
  };

  return (message: ShellToLogic) => {
    switch (message.type) {
      case "boot":
        boot(message);
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
        try {
          navigate("navigateBack", { delta: 1 });
        } catch (error) {
          console.error(`[omr] ${(error as Error).message}`);
        }
        break;
    }
  };
}
