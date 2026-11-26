/**
 * The view layer of one page: renders the page and its custom components from
 * data the logic layer sends, and sends user events back to it.
 */
import type { WebviewBundle, WxmlFile } from "@omr/compiler";
import type {
  AdConfig,
  ComponentListeners,
  ComponentViewOptions,
  LogicToView,
  EventBinding,
  SelectorQueryRequest,
  TreeNode,
  ViewToLogic,
  WxEventTarget,
} from "@omr/runtime";
import { fsFileUrl, isFsPath, resolvePath, setPath, toJsonValue } from "@omr/runtime";
import { canvasElements, type CanvasElement } from "./canvas.ts";
import { answerRequest } from "./requests.ts";
import { createObservers } from "./observers.ts";
import { createAnimations } from "./animation.ts";
import { toText } from "./expression.ts";
import { BASE_CSS, defineBuiltins, type BuiltinElement, type OmrEventDetail } from "./builtins.ts";
import { setAdConfig } from "./components/ad.ts";
import { setMapLocation } from "./components/map.ts";
import { setStreetsUrl } from "./components/region.ts";
import {
  convertRpx,
  renderScope,
  type RenderScope,
  type VEvent,
  type VElement,
  type VNode,
} from "./render.ts";

export interface ViewOptions {
  bundle: WebviewBundle;
  windowWidth: number;
  /** What a non-zero rpx value that rounds to 0 becomes: 0.5 on iOS devices with a pixel ratio above 1, else 1. */
  hairline?: number;
  /** URL prefix the Mini Program's files are served at, such as `/__omr/files/`. */
  assetBase: string;
  /** Whether app.json sets `"style": "v2"`. */
  styleV2: boolean;
  /** `ad` of the simulator config: whether `<ad>` and `<ad-custom>` fill or fail. */
  ad?: AdConfig;
  /** `location` of the simulator config: where `<map>` puts the user. */
  location?: { latitude: number; longitude: number };
  /** Where the streets of a district are served for `<picker mode="region" level="sub-district">`. */
  regionStreetsUrl?: string;
  post: (message: ViewToLogic) => void;
}

/** The attribute that marks a component host; matches `HOST_ATTRIBUTE` in @omr/compiler. */
const HOST_ATTRIBUTE = "omr-host";
/** Marks the host of a component with `virtualHost`, which takes no box of its own. */
const VIRTUAL_ATTRIBUTE = "omr-virtual";
/** The tag of the `custom-tab-bar` component's host, which the view adds to a tab page. */
const TAB_BAR_TAG = "omr-custom-tab-bar";
const HOST_CSS = `[${VIRTUAL_ATTRIBUTE}] { display: contents !important; }
${TAB_BAR_TAG} { display: block; position: fixed; left: 0; right: 0; bottom: 0; z-index: 9000; }`;

/** What the WeChat events of a button `open-type` are called. */
const OPEN_TYPE_EVENTS: Record<string, string> = {
  getPhoneNumber: "getphonenumber",
  getRealtimePhoneNumber: "getrealtimephonenumber",
  getUserInfo: "getuserinfo",
  chooseAvatar: "chooseavatar",
  openSetting: "opensetting",
  contact: "contact",
  // The simulator is never opened from an app (scene 1069), so launchApp always fails
  launchApp: "error",
  agreePrivacyAuthorization: "agreeprivacyauthorization",
  share: "",
  feedback: "",
};
/** The attributes of a `contact` button the customer service chat shows. */
const CONTACT_ATTRIBUTES = [
  "show-message-card",
  "send-message-title",
  "send-message-img",
  "send-message-path",
];

interface Scope extends RenderScope {
  initialized: boolean;
  /** The element the scope renders into: the body for the page, the host for a component. */
  root: HTMLElement;
  /** Rendered nodes go before this node; null appends. */
  anchor: Node | null;
  depth: number;
  owner?: Scope;
  /** For a component: the host's latest virtual node. */
  host?: VElement;
  vnodes: VNode[];
  options: ComponentViewOptions;
  externalClasses: Record<string, string>;
  slotEls: Map<string, HTMLElement>;
  /** What the owner puts in each slot, and what is in the DOM now. */
  slotContent: Map<string, VNode[]>;
  slotMounted: Map<string, { el: HTMLElement; nodes: VNode[] }>;
  sentProps?: string;
}

interface ElementState {
  ownerId: number;
  events: VEvent[];
  props: Record<string, unknown>;
  /** Set on a component host. */
  scope?: Scope;
}

export function startView(options: ViewOptions): (message: LogicToView) => void {
  const { bundle, post } = options;
  const hairline = options.hairline ?? 1;
  defineBuiltins();
  setAdConfig(options.ad);
  setMapLocation(options.location);
  setStreetsUrl(options.regionStreetsUrl);

  const style = document.createElement("style");
  style.textContent = `${BASE_CSS}\n${PULL_DOWN_CSS}\n${HOST_CSS}\n${convertRpx(bundle.css, options.windowWidth, hairline)}`;
  document.head.append(style);
  if (options.styleV2) document.documentElement.classList.add("omr-v2");
  if (bundle.window.disableScroll) document.documentElement.style.overflow = "hidden";
  // Rendered nodes stay before this marker; overlays such as pickers go after it
  const anchor = document.createComment("omr-page-end");
  document.body.prepend(anchor);

  const states = new WeakMap<Element, ElementState>();
  const scopes = new Map<number, Scope>();
  let nextNodeId = 1;

  // WXS modules, evaluated once per page
  const wxsExports = new Map<string, unknown>();
  const fileModules = new Map<string, Record<string, unknown>>();
  const runWxs = (id: string, code: string, from: string): unknown => {
    const module = { exports: {} as unknown };
    wxsExports.set(id, module.exports);
    try {
      // oxlint-disable-next-line typescript/no-implied-eval -- WXS modules are code by design
      new Function("module", "exports", "require", "getRegExp", "getDate", code)(
        module,
        module.exports,
        (spec: string) => loadWxs(resolvePath(from, spec)),
        (pattern: string, flags?: string) => new RegExp(pattern, flags),
        (...args: []) => new Date(...args),
      );
    } catch (error) {
      console.error(`[omr] error in ${id}:`, error);
    }
    wxsExports.set(id, module.exports);
    return module.exports;
  };
  const loadWxs = (file: string): unknown => {
    if (wxsExports.has(file)) return wxsExports.get(file);
    const code = bundle.wxs[file];
    if (code === undefined) {
      console.error(`[omr] WXS module ${file} not found`);
      return {};
    }
    return runWxs(file, code, file);
  };
  const wxsModules = (file: WxmlFile): Record<string, unknown> => {
    let modules = fileModules.get(file.path);
    if (!modules) {
      modules = {};
      for (const module of file.wxs) {
        modules[module.module] = module.src
          ? loadWxs(module.src)
          : runWxs(`${file.path}#${module.module}`, module.code ?? "", file.path);
      }
      fileModules.set(file.path, modules);
    }
    return modules;
  };

  const env = {
    bundle,
    wxsModules,
    convertStyle: (css: string) => convertRpx(css, options.windowWidth, hairline),
    resolveAsset: (src: string, file: string) =>
      isFsPath(src)
        ? fsFileUrl(src)
        : /^([a-z][\w+.-]*:|\/\/)/i.test(src)
          ? src
          : `${options.assetBase}${resolvePath(file, src)}`,
  };
  const animations = createAnimations(env.convertStyle);

  const createScope = (
    nodeId: number,
    def: Scope["def"],
    root: HTMLElement,
    owner?: Scope,
  ): Scope => {
    const scope: Scope = {
      nodeId,
      def,
      data: {},
      initialized: false,
      root,
      anchor: owner ? null : anchor,
      depth: owner ? owner.depth + 1 : 0,
      owner,
      vnodes: [],
      options: { externalClasses: [], styleIsolation: "isolated" },
      externalClasses: {},
      slotEls: new Map(),
      slotContent: new Map(),
      slotMounted: new Map(),
      transformClass: (value) =>
        value
          .split(/\s+/)
          .filter(Boolean)
          .flatMap((name) => {
            if (!owner) return [name];
            const external = scope.externalClasses[name];
            if (external !== undefined) return external ? [external] : [];
            const scoped = `${def.prefix}--${name}`;
            return scope.options.styleIsolation === "isolated" ? [scoped] : [scoped, name];
          })
          .join(" "),
    };
    scopes.set(nodeId, scope);
    return scope;
  };
  const page = createScope(0, bundle.page, document.body);

  // DOM patching
  const domOf = (vnode: VNode): Node => (vnode.kind === "text" ? vnode.node! : vnode.el!);

  const setAttribute = (el: HTMLElement, name: string, value: unknown) => {
    if (value === undefined || value === null || value === false || typeof value === "object") {
      el.removeAttribute(name);
      return;
    }
    try {
      el.setAttribute(name, value === true ? "" : toText(value));
    } catch {
      // Names the DOM rejects stay properties only
    }
  };

  const applyAttrs = (
    el: HTMLElement,
    previous: Record<string, unknown>,
    attrs: Record<string, unknown>,
  ) => {
    // A virtual host has no box for its class and style to apply to
    const virtual = states.get(el)?.scope?.options.virtualHost;
    for (const name of Object.keys(previous)) {
      if (!(name in attrs)) setAttribute(el, name, undefined);
    }
    for (const [name, value] of Object.entries(attrs)) {
      if (virtual && (name === "class" || name === "style")) continue;
      if (!(name in previous) || previous[name] !== value) setAttribute(el, name, value);
    }
    // `animation="{{animationData}}"` plays a `wx.createAnimation` export over the element's style
    animations.attribute(el, attrs.animation, previous.style !== attrs.style);
    (el as Partial<BuiltinElement>).omrUpdate?.(attrs);
  };

  const createNode = (vnode: VNode): Node => {
    if (vnode.kind === "text") {
      vnode.node = document.createTextNode(vnode.text);
      return vnode.node;
    }
    const el = document.createElement(vnode.tag);
    vnode.el = el;
    states.set(el, { ownerId: vnode.ownerId, events: vnode.events, props: vnode.attrs });
    // Built-ins that make their own nodes, such as rich-text, scope their classes like the template's,
    // and resolve paths in object attributes, such as a map marker's iconPath, like its paths
    const owner = scopes.get(vnode.ownerId);
    if (owner && vnode.tag.startsWith("wx-")) {
      (el as { omrTransformClass?: (value: string) => string }).omrTransformClass = (value) =>
        owner.transformClass(value);
      (el as Partial<BuiltinElement>).omrResolveAsset = (src) =>
        env.resolveAsset(src, owner.def.template);
    }
    applyAttrs(el, {}, vnode.attrs);
    mountContent(vnode);
    return el;
  };

  const patchNode = (old: VNode, vnode: VNode) => {
    if (vnode.kind === "text") {
      vnode.node = (old as typeof vnode).node;
      if ((old as typeof vnode).text !== vnode.text) vnode.node!.data = vnode.text;
      return;
    }
    const previous = old as VElement;
    const el = previous.el!;
    vnode.el = el;
    const state = states.get(el)!;
    state.ownerId = vnode.ownerId;
    state.events = vnode.events;
    state.props = vnode.attrs;
    applyAttrs(el, previous.attrs, vnode.attrs);
    mountContent(vnode, previous);
  };

  const mountContent = (vnode: VElement, old?: VElement) => {
    if (vnode.slot !== undefined) {
      scopes.get(vnode.ownerId)?.slotEls.set(vnode.slot, vnode.el!);
    } else if (vnode.component && bundle.components[vnode.component.path]) {
      updateComponent(vnode);
    } else {
      patchChildren(vnode.el!, old?.children ?? [], vnode.children, null);
    }
  };

  const sameKind = (a: VNode, b: VNode) =>
    a.kind === b.kind &&
    (a.kind === "text" ||
      (a.tag === (b as VElement).tag && a.component?.path === (b as VElement).component?.path));

  const patchChildren = (parent: Node, oldList: VNode[], newList: VNode[], before: Node | null) => {
    const oldByKey = new Map(oldList.map((vnode) => [vnode.key, vnode]));
    const seen = new Set<string>();
    const reused = new Set<VNode>();
    for (const vnode of newList) {
      // A repeated wx:key gets a suffix, consistently across renders
      const base = vnode.key;
      for (let n = 1; seen.has(vnode.key); n++) vnode.key = `${base}#${n}`;
      seen.add(vnode.key);
      const old = oldByKey.get(vnode.key);
      if (old && !reused.has(old) && sameKind(old, vnode)) {
        reused.add(old);
        patchNode(old, vnode);
      } else {
        createNode(vnode);
      }
    }
    for (const old of oldList) {
      if (!reused.has(old)) (domOf(old) as ChildNode | undefined)?.remove();
    }
    let ref = before;
    for (let i = newList.length - 1; i >= 0; i--) {
      const node = domOf(newList[i]!);
      if (node.parentNode !== parent || node.nextSibling !== ref) parent.insertBefore(node, ref);
      ref = node;
    }
  };

  // Components
  const listenersOf = (events: VEvent[]): ComponentListeners =>
    Object.fromEntries(
      events
        .filter((event) => !event.capture)
        .map((event) => [event.name, { handler: event.handler, catch: event.catch }]),
    );

  const updateComponent = (vnode: VElement) => {
    const el = vnode.el!;
    const state = states.get(el)!;
    const { path, props } = vnode.component!;
    const jsonProps = toJsonValue(props);
    const listeners = listenersOf(vnode.events);
    const id = toText(props.id);
    const dataset = datasetOf(props);
    let scope = state.scope;
    // A host kept while it was out of the page, such as in a slot under wx:if, was detached; it starts again
    if (scope && scopes.get(scope.nodeId) !== scope) {
      scope = state.scope = undefined;
      el.replaceChildren();
    }
    if (!scope) {
      const owner = scopes.get(vnode.ownerId)!;
      scope = createScope(nextNodeId++, bundle.components[path]!, el, owner);
      state.scope = scope;
      el.setAttribute(HOST_ATTRIBUTE, scope.def.prefix);
      post({
        type: "attach",
        nodeId: scope.nodeId,
        ownerId: vnode.ownerId,
        path,
        props: jsonProps,
        listeners,
        id,
        dataset,
      });
      scope.sentProps = JSON.stringify([jsonProps, listeners]);
    } else {
      const sent = JSON.stringify([jsonProps, listeners]);
      if (sent !== scope.sentProps) {
        scope.sentProps = sent;
        post({ type: "props", nodeId: scope.nodeId, props: jsonProps, listeners, id, dataset });
        // External classes come from host attributes
        if (scope.options.externalClasses.length > 0) dirty.add(scope);
      }
    }
    scope.host = vnode;
    const content = new Map<string, VNode[]>();
    for (const child of vnode.children) {
      const name = child.kind === "element" ? toText(child.attrs.slot) : "";
      content.set(name, [...(content.get(name) ?? []), child]);
    }
    scope.slotContent = content;
  };

  /** Puts each slot's content from the owner into the slot element the component rendered. */
  const syncSlots = (scope: Scope): boolean => {
    let changed = false;
    for (const name of new Set([...scope.slotContent.keys(), ...scope.slotMounted.keys()])) {
      const el = scope.slotEls.get(name);
      if (!el) continue;
      const content = scope.slotContent.get(name) ?? [];
      const mounted = scope.slotMounted.get(name);
      if (mounted && mounted.el === el && mounted.nodes === content) continue;
      patchChildren(el, mounted?.nodes ?? [], content, null);
      scope.slotMounted.set(name, { el, nodes: content });
      changed = true;
    }
    return changed;
  };

  const renderNow = (scope: Scope) => {
    if (!scope.initialized || (scope.owner && !scope.root.isConnected)) return;
    if (scope.owner && scope.host) {
      const props = scope.host.component!.props;
      scope.externalClasses = Object.fromEntries(
        scope.options.externalClasses.map((name) => [
          name,
          scope.owner!.transformClass(toText(props[name])),
        ]),
      );
      // `<list generic:item="my-item">`: the owner names a component of its own for each generic
      const generics: Record<string, string> = {};
      for (const [name, fallback] of Object.entries(scope.def.generics ?? {})) {
        const tag = toText(props[`generic:${name}`]);
        const chosen = tag
          ? (scope.owner.def.usingComponents[tag] ?? scope.owner.generics?.[tag])
          : undefined;
        if (chosen || fallback) generics[name] = chosen ?? fallback;
      }
      scope.generics = generics;
    }
    const vnodes = renderScope(scope, env);
    if (scope === page && bundle.customTabBar) {
      vnodes.push({
        kind: "element",
        key: TAB_BAR_TAG,
        tag: TAB_BAR_TAG,
        attrs: {},
        events: [],
        children: [],
        ownerId: 0,
        component: { path: bundle.customTabBar, props: {} },
      });
    }
    patchChildren(scope.root, scope.vnodes, vnodes, scope.anchor);
    scope.vnodes = vnodes;
    if (scope === page && bundle.customTabBar) keepClearOfTabBar((vnodes.at(-1) as VElement).el!);
  };

  // The custom tab bar sits over the bottom of the window; the page ends above it. The room is
  // kept on the root element, as `<page-meta page-style>` replaces the body's style
  let tabBarObserver: ResizeObserver | undefined;
  const keepClearOfTabBar = (host: HTMLElement) => {
    if (tabBarObserver) return;
    tabBarObserver = new ResizeObserver(() => {
      document.documentElement.style.paddingBottom = `${host.offsetHeight}px`;
    });
    tabBarObserver.observe(host);
  };

  // Batching: messages mark scopes dirty; one flush renders them, then reports the sequence number
  const dirty = new Set<Scope>();
  /** Work waiting for the next render, such as `this.animate` called in `onLoad`. */
  const afterRender: (() => void)[] = [];
  let scheduled = false;
  let renderedSeq = 0;
  let pendingSeq = 0;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  };
  const flush = () => {
    scheduled = false;
    while (dirty.size > 0) {
      // Owners first, so components see their latest host attributes
      const next = [...dirty].reduce((a, b) => (b.depth < a.depth ? b : a));
      dirty.delete(next);
      renderNow(next);
    }
    // Slot content can hold slots of other components, so repeat until nothing moves
    for (let pass = 0; pass < 10; pass++) {
      let changed = false;
      for (const scope of [...scopes.values()].sort((a, b) => a.depth - b.depth)) {
        if (syncSlots(scope)) changed = true;
      }
      if (!changed) break;
    }
    const detached: number[] = [];
    for (const [nodeId, scope] of scopes) {
      if (nodeId !== 0 && !scope.root.isConnected) {
        scopes.delete(nodeId);
        detached.push(nodeId);
      }
    }
    if (detached.length > 0) post({ type: "detach", nodeIds: detached });
    reportTree();
    observers.afterRender();
    dropRemovedContainers();
    reportWebView();
    for (const run of afterRender.splice(0)) run();
    if (pendingSeq > renderedSeq) {
      renderedSeq = pendingSeq;
      post({ type: "rendered", seq: renderedSeq });
    }
  };

  /**
   * Tells the logic layer about the page's `<web-view>`, which the shell shows
   * over the page: its `src` and the handlers bound to its events, when they
   * changed. WeChat allows one per page; later ones are ignored.
   */
  let sentWebView = JSON.stringify({ type: "webView" });
  const reportWebView = () => {
    const el = document.querySelector("wx-web-view");
    const state = el ? states.get(el) : undefined;
    const src = state ? toText(state.props.src ?? "").trim() : "";
    let message: Extract<ViewToLogic, { type: "webView" }> = { type: "webView" };
    if (el && state && src) {
      const handlers: NonNullable<typeof message.handlers> = {};
      for (const binding of state.events) {
        if (
          (binding.name === "load" || binding.name === "error" || binding.name === "message") &&
          binding.handler
        ) {
          handlers[binding.name] ??= { ownerId: state.ownerId, handler: binding.handler };
        }
      }
      message = { type: "webView", src, target: targetOf(el), handlers };
    }
    // The target's offsets are not part of what changed
    const key = JSON.stringify({
      ...message,
      target: message.target && { id: message.target.id, dataset: message.target.dataset },
    });
    if (key === sentWebView) return;
    sentWebView = key;
    post(message);
  };

  /** Tells the logic layer where each component is, when that changed. */
  let sentTree = "[]";
  const reportTree = () => {
    const nodes: TreeNode[] = [];
    for (const el of document.querySelectorAll(`[${HOST_ATTRIBUTE}]`)) {
      const scope = states.get(el)?.scope;
      if (!scope?.host || scopes.get(scope.nodeId) !== scope) continue;
      let parentId = 0;
      for (let current = el.parentElement; current; current = current.parentElement) {
        const above = states.get(current)?.scope;
        if (above) {
          parentId = above.nodeId;
          break;
        }
      }
      const ancestors: TreeNode["ancestors"] = [];
      for (let current = managedParent(el); current; current = managedParent(current)) {
        const state = states.get(current)!;
        if (state.events.length === 0) continue;
        ancestors.push({
          ownerId: state.ownerId,
          id: current.id,
          dataset: datasetOf(state.props),
          events: state.events.map(bindingOf),
        });
      }
      nodes.push({
        nodeId: scope.nodeId,
        parentId,
        tag: scope.host.tag,
        className: toText(scope.host.component!.props.class),
        events: scope.host.events.map(bindingOf),
        ancestors,
      });
    }
    const text = JSON.stringify(nodes);
    if (text === sentTree) return;
    sentTree = text;
    post({ type: "tree", nodes: JSON.parse(text) as TreeNode[] });
  };
  const bindingOf = (event: VEvent): EventBinding => ({
    name: event.name,
    handler: event.handler,
    catch: event.catch,
    capture: event.capture,
  });

  // Events
  const datasetOf = (props: Record<string, unknown>): Record<string, unknown> => {
    const dataset: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(props)) {
      if (!name.startsWith("data-")) continue;
      // `data-user-id` is `userId`; WeChat lowercases the rest, so `data-userId` is `userid`
      dataset[
        name
          .slice(5)
          .toLowerCase()
          .replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())
      ] = value;
    }
    return dataset;
  };

  const targetOf = (el: Element): WxEventTarget => {
    const rect = el.getBoundingClientRect();
    return {
      id: el.id,
      dataset: datasetOf(states.get(el)?.props ?? {}),
      offsetLeft: Math.round(rect.left + window.scrollX),
      offsetTop: Math.round(rect.top + window.scrollY),
    };
  };

  /** The nearest rendered element at or above a DOM node. */
  const managed = (node: EventTarget | null): Element | undefined => {
    for (let current = node as Node | null; current; current = current.parentNode) {
      if (current instanceof Element && states.has(current)) return current;
    }
    return undefined;
  };
  const managedParent = (el: Element) => managed(el.parentNode);

  /**
   * Sends a WeChat event to the handlers bound along its path: capture
   * handlers from the root down, then bubble handlers from the target up; a
   * `catch` binding stops it. Returns whether any handler was bound.
   */
  const dispatch = (
    target: Element,
    name: string,
    detail: Record<string, unknown>,
    bubbles: boolean,
    extra: {
      touches?: unknown[];
      changedTouches?: unknown[];
      type?: string;
      causedBy?: string;
    } = {},
    replyId?: number,
  ): boolean => {
    const path: Element[] = [];
    for (let el: Element | undefined = target; el; el = bubbles ? managedParent(el) : undefined) {
      path.push(el);
    }
    const targetInfo = targetOf(target);
    let bound = false;
    const run = (el: Element, capture: boolean): boolean => {
      const state = states.get(el);
      for (const binding of state?.events ?? []) {
        if (binding.name !== name || binding.capture !== capture) continue;
        bound = true;
        if (binding.handler) {
          post({
            type: "event",
            ownerId: state!.ownerId,
            handler: binding.handler,
            event: {
              type: name,
              timeStamp: Math.round(performance.now()),
              target: targetInfo,
              currentTarget: targetOf(el),
              detail,
              mark: {},
              ...extra,
            },
            ...(replyId === undefined ? {} : { replyId }),
          });
        }
        if (binding.catch) return true;
      }
      return false;
    };
    for (const el of [...path].reverse()) if (run(el, true)) return bound;
    for (const el of path) if (run(el, false)) return bound;
    return bound;
  };

  const touchesOf = (event: PointerEvent | MouseEvent, target?: Element) => {
    const identifier = "pointerId" in event ? event.pointerId : 0;
    // A canvas reports CanvasTouch: only the position inside the canvas
    const canvas = target?.closest("wx-canvas");
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      const touch = { identifier, x: event.clientX - rect.left, y: event.clientY - rect.top };
      return { touches: [touch], changedTouches: [touch] };
    }
    const touch = {
      identifier,
      pageX: event.pageX,
      pageY: event.pageY,
      clientX: event.clientX,
      clientY: event.clientY,
      force: 1,
    };
    return { touches: [touch], changedTouches: [touch] };
  };

  const isDisabled = (el: Element | null) => !!el && Boolean(states.get(el)?.props.disabled);

  /** The controls a `<label>` passes its taps to. */
  const LABEL_CONTROLS = "wx-button, wx-checkbox, wx-radio, wx-switch, wx-input, wx-textarea";

  /** What a tap does beyond the tap event: button open-types and forms, navigators, controls. */
  const afterTap = (target: Element) => {
    const button = target.closest("wx-button");
    if (button && !isDisabled(button)) {
      const state = states.get(button)!;
      // A combined open-type such as "getPhoneNumber|agreePrivacyAuthorization" records the agreement first
      const openTypes = toText(state.props["open-type"])
        .split("|")
        .sort(
          (a, b) =>
            Number(b === "agreePrivacyAuthorization") - Number(a === "agreePrivacyAuthorization"),
        );
      for (const openType of openTypes) {
        const eventName = OPEN_TYPE_EVENTS[openType];
        if (eventName === undefined || !openType) continue;
        const binding = state.events.find((event) => event.name === eventName && !event.capture);
        post({
          type: "event",
          ownerId: state.ownerId,
          handler: binding?.handler ?? "",
          openType,
          ...(openType === "contact"
            ? {
                openTypeProps: Object.fromEntries(
                  CONTACT_ATTRIBUTES.map((name) => [name, state.props[name]]),
                ),
              }
            : {}),
          event: {
            type: eventName,
            timeStamp: Math.round(performance.now()),
            target: targetOf(button),
            currentTarget: targetOf(button),
            detail: {},
            mark: {},
          },
        });
      }
      const formType = state.props["form-type"];
      // A button inside a component reaches an outer form only through wx://form-field-button
      let form = button.closest("wx-form");
      while (form && !formReaches(form, button, "formFieldButton")) {
        form = form.parentElement?.closest("wx-form") ?? null;
      }
      if (form && (formType === "submit" || formType === "reset")) submitForm(form, formType);
    }
    const navigator = target.closest("wx-navigator");
    if (navigator) {
      const state = states.get(navigator);
      const props = state?.props ?? {};
      const openType = toText(props["open-type"] ?? "navigate");
      if (props.target === "miniProgram") {
        const handler = (name: string) => {
          const binding = state?.events.find((event) => event.name === name && !event.capture);
          return binding?.handler
            ? { ownerId: state!.ownerId, handler: binding.handler }
            : undefined;
        };
        post({
          type: "navigateMiniProgram",
          openType,
          props: Object.fromEntries(
            ["app-id", "path", "extra-data", "version", "short-link"].map((name) => [
              name,
              props[name],
            ]),
          ),
          target: targetOf(navigator),
          handlers: {
            success: handler("success"),
            fail: handler("fail"),
            complete: handler("complete"),
          },
        });
      } else {
        post({
          type: "navigate",
          openType,
          url: props.url === undefined ? undefined : toText(props.url),
          delta: props.delta === undefined ? undefined : Number(props.delta),
        });
      }
    }
    const control = target.closest<BuiltinElement>("wx-checkbox, wx-radio, wx-switch, wx-picker");
    const label = target.closest("wx-label");
    if (control) {
      control.omrActivate?.();
    } else if (label && !target.closest("wx-button, wx-input, wx-textarea")) {
      // `for` names a control in the label's own template; otherwise the first control inside it
      const owner = states.get(label)?.ownerId;
      const forId = states.get(label)?.props.for;
      const linked = forId
        ? [...(scopes.get(owner ?? -1)?.root ?? document).querySelectorAll("[id]")].find(
            (el) => el.id === toText(forId) && states.get(el)?.ownerId === owner,
          )
        : label.querySelector(LABEL_CONTROLS);
      if (!linked) return;
      if (/^WX-(INPUT|TEXTAREA)$/.test(linked.tagName)) {
        linked.querySelector<HTMLElement>("input, textarea")?.focus();
      } else if (linked.tagName === "WX-BUTTON") {
        if (!isDisabled(linked)) dispatch(linked, "tap", {}, true);
        afterTap(linked);
      } else {
        (linked as Partial<BuiltinElement>).omrActivate?.();
      }
    }
  };

  /**
   * Whether a form sees an element: the element is in the form's template, or
   * every component between them has the behavior that opens it to forms.
   */
  const formReaches = (
    form: Element,
    el: Element,
    behavior: "formFieldGroup" | "formFieldButton",
  ): boolean => {
    const formOwner = states.get(form)?.ownerId;
    for (let scope = scopes.get(states.get(el)?.ownerId ?? -1); scope; scope = scope.owner) {
      if (scope.nodeId === formOwner) return true;
      if (!scope.options[behavior]) return false;
    }
    return false;
  };

  const submitForm = (form: Element, kind: "submit" | "reset") => {
    const controls = [...form.querySelectorAll("*")].filter(
      (el) =>
        typeof (el as Partial<BuiltinElement>).omrFormValue === "function" &&
        formReaches(form, el, "formFieldGroup"),
    ) as BuiltinElement[];
    if (kind === "reset") {
      for (const control of controls) control.omrReset?.();
      dispatch(form, "reset", {}, false);
      return;
    }
    const value: Record<string, unknown> = {};
    for (const control of controls) {
      const name = states.get(control)?.props.name;
      if (name !== undefined && name !== "") value[toText(name)] = control.omrFormValue!();
    }
    // Custom components with wx://form-field submit their `value` data
    for (const host of form.querySelectorAll(`[${HOST_ATTRIBUTE}]`)) {
      const scope = states.get(host)?.scope;
      if (!scope?.options.formField || !formReaches(form, host, "formFieldGroup")) continue;
      const name = toText(scope.data.name);
      if (name) value[name] = scope.data.value;
    }
    dispatch(form, "submit", { value }, false);
  };

  let pressed:
    | { target: Element; x: number; y: number; timer: ReturnType<typeof setTimeout> }
    | undefined;
  let suppressTap = false;
  /** The press's hover states: each shows after its start time and goes `stay` ms after release. */
  let hovered: {
    el: Element;
    classes: string[];
    stay: number;
    shown: boolean;
    timer?: ReturnType<typeof setTimeout>;
  }[] = [];
  /** Pending removals of hover classes, so a new press on the element keeps its classes. */
  const hoverRemovals = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  const showHover = (entry: (typeof hovered)[number]) => {
    clearTimeout(entry.timer);
    clearTimeout(hoverRemovals.get(entry.el));
    entry.el.classList.add(...entry.classes);
    entry.shown = true;
  };

  const hoverOf = (el: Element) => {
    const props = states.get(el)?.props ?? {};
    const tag = el.tagName;
    const builtinHover =
      tag === "WX-BUTTON" ? "button-hover" : tag === "WX-NAVIGATOR" ? "navigator-hover" : "none";
    const value = toText(props["hover-class"] ?? builtinHover);
    if (value === "none" || value === "" || props.disabled) return undefined;
    // Defaults from the docs: view 400 ms, button 70 ms, navigator 600 ms
    const stay = Number(
      props["hover-stay-time"] ?? (tag === "WX-BUTTON" ? 70 : tag === "WX-NAVIGATOR" ? 600 : 400),
    );
    const start = Number(props["hover-start-time"] ?? 50);
    return { classes: value.split(/\s+/), stay, start: Number.isFinite(start) ? start : 50 };
  };

  document.addEventListener("pointerdown", (event) => {
    const target = managed(event.target);
    if (!target) return;
    suppressTap = false;
    dispatch(target, "touchstart", {}, true, touchesOf(event, target));
    for (let el: Element | undefined = target; el; el = managedParent(el)) {
      const hover = hoverOf(el);
      if (hover) {
        const entry = {
          el,
          classes: hover.classes,
          stay: hover.stay,
          shown: false,
        } as (typeof hovered)[number];
        entry.timer = setTimeout(() => showHover(entry), hover.start);
        hovered.push(entry);
      }
      if (states.get(el)?.props["hover-stop-propagation"]) break;
    }
    pressed = {
      target,
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        const detail = { x: event.pageX, y: event.pageY };
        if (dispatch(target, "longpress", detail, true)) suppressTap = true;
        dispatch(target, "longtap", detail, true);
        if (
          target.localName === "wx-image" &&
          states.get(target)?.props["show-menu-by-longpress"]
        ) {
          suppressTap = true;
          post({ type: "imageMenu" });
        }
      }, 350),
    };
  });
  document.addEventListener("pointermove", (event) => {
    if (!pressed) return;
    if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 10) {
      clearTimeout(pressed.timer);
      // Moving the finger, such as to scroll a list, cancels the hover state
      for (const { el, classes, timer, shown } of hovered) {
        clearTimeout(timer);
        if (shown) el.classList.remove(...classes);
      }
      hovered = [];
    }
    dispatch(pressed.target, "touchmove", {}, true, touchesOf(event, pressed.target));
  });
  const release = (name: string) => (event: PointerEvent) => {
    if (!pressed) return;
    clearTimeout(pressed.timer);
    dispatch(pressed.target, name, {}, true, touchesOf(event, pressed.target));
    pressed = undefined;
    for (const entry of hovered) {
      // A tap shorter than the start time still shows the hover state for its stay time
      if (!entry.shown) showHover(entry);
      const { el, classes, stay } = entry;
      hoverRemovals.set(
        el,
        setTimeout(() => el.classList.remove(...classes), stay),
      );
    }
    hovered = [];
  };
  document.addEventListener("pointerup", release("touchend"));
  document.addEventListener("pointercancel", release("touchcancel"));

  document.addEventListener("click", (event) => {
    const target = managed(event.target);
    if (!target) return;
    if (suppressTap) {
      suppressTap = false;
      return;
    }
    if (!isDisabled(target.closest("wx-button"))) {
      // A component may tell where the tap was in its own terms, such as a map's coordinates
      const detail = (target as Partial<BuiltinElement>).omrTapDetail?.(event) ?? {
        x: event.pageX,
        y: event.pageY,
      };
      dispatch(target, "tap", detail, true, touchesOf(event, target));
    }
    afterTap(target);
  });

  // Events raised by built-in components do not bubble
  document.addEventListener(
    "omr-event",
    (event) => {
      const target = managed(event.target);
      const { name, detail, fields = {} } = (event as CustomEvent<OmrEventDetail>).detail;
      if (!target) return;
      // A bindinput handler may return the field's new value, so the input waits for its answer
      const handled =
        name === "input" &&
        /^WX-(INPUT|TEXTAREA)$/.test(target.tagName) &&
        states.get(target)?.events.some((binding) => binding.name === "input" && binding.handler);
      if (!handled) {
        dispatch(target, name, detail, false, fields);
        return;
      }
      const replyId = ++nextReplyId;
      inputReplies.set(replyId, { input: target as BuiltinElement, value: toText(detail.value) });
      dispatch(target, name, detail, false, {}, replyId);
    },
    true,
  );

  /** Inputs waiting for their bindinput handler's result, with the value the handler saw. */
  const inputReplies = new Map<number, { input: BuiltinElement; value: string }>();
  let nextReplyId = 0;

  // <input type="nickname"> asks the logic layer for the system nickname bar while it has focus
  let nicknameInput: BuiltinElement | undefined;
  document.addEventListener("omr-nickname", (event) => {
    const { focused, input } = (event as CustomEvent<{ focused: boolean; input: BuiltinElement }>)
      .detail;
    nicknameInput = focused ? input : undefined;
    post({ type: "nickname", focused });
  });

  // <camera> asks the logic layer for scope.camera when it is inserted
  const cameras = new Map<number, BuiltinElement>();
  document.addEventListener("omr-camera", (event) => {
    const { camera, mounted, mode, frameSize } = (
      event as CustomEvent<{
        camera: BuiltinElement & { cameraId: number };
        mounted: boolean;
        mode: string;
        frameSize: string;
      }>
    ).detail;
    if (mounted) cameras.set(camera.cameraId, camera);
    else cameras.delete(camera.cameraId);
    post({ type: "camera", cameraId: camera.cameraId, mounted, mode, frameSize });
  });

  // <official-account> asks the logic layer whether the launch scene lets it show
  const officialAccounts = new Map<number, BuiltinElement>();
  document.addEventListener("omr-official-account", (event) => {
    const { account } = (event as CustomEvent<{ account: BuiltinElement & { accountId: number } }>)
      .detail;
    officialAccounts.set(account.accountId, account);
    post({ type: "officialAccount", accountId: account.accountId });
  });

  // Pull-down refresh: the page slides down over the window background, which shows three dots
  const pullDown = createPullDown(bundle.window, () => post({ type: "pullDownRefresh" }));

  // <navigation-bar> is applied by the shell; <page-meta>'s window background by the view itself
  // Open page containers, last opened last: a return closes the latest
  const openContainers: (HTMLElement & { omrClose(): void })[] = [];
  document.addEventListener("omr-page-container", (event) => {
    const container = event.target as HTMLElement & { omrClose(): void };
    const index = openContainers.indexOf(container);
    if (index !== -1) openContainers.splice(index, 1);
    if ((event as CustomEvent<{ open: boolean }>).detail.open) openContainers.push(container);
    post({ type: "pageContainer", open: openContainers.length > 0 });
  });
  /** After a render: an open container that `wx:if` removed no longer holds a return. */
  const dropRemovedContainers = () => {
    const count = openContainers.length;
    for (let i = openContainers.length - 1; i >= 0; i--) {
      if (!openContainers[i]!.isConnected) openContainers.splice(i, 1);
    }
    if (openContainers.length !== count)
      post({ type: "pageContainer", open: openContainers.length > 0 });
  };

  document.addEventListener("omr-page-config", (event) => {
    const { navigationBar, pageMeta } = (
      event as CustomEvent<{
        navigationBar?: Record<string, unknown>;
        pageMeta?: Record<string, unknown>;
      }>
    ).detail;
    if (navigationBar) post({ type: "navigationBar", attributes: navigationBar });
    if (pageMeta) {
      const text = (name: string) =>
        typeof pageMeta[name] === "string" ? (pageMeta[name] as string) : undefined;
      pullDown.background({
        color: text("background-color"),
        top: text("background-color-top"),
        textStyle: text("background-text-style"),
      });
    }
  });

  // A full-screen <video> asks the shell to grow the page's window over its chrome. That
  // window is the video's, not the page's: its resize, and the one back, are not the page's
  const fullScreenVideos = new Set<Element>();
  document.addEventListener("omr-video-fullscreen", (event) => {
    const { video, fullScreen } = (event as CustomEvent<{ video: Element; fullScreen: boolean }>)
      .detail;
    const before = fullScreenVideos.size > 0;
    if (fullScreen) fullScreenVideos.add(video);
    else fullScreenVideos.delete(video);
    if (before !== fullScreenVideos.size > 0)
      post({ type: "videoFullScreen", fullScreen: !before });
  });
  let windowSize = `${window.innerWidth}x${window.innerHeight}`;
  window.addEventListener("resize", () => {
    const size = `${window.innerWidth}x${window.innerHeight}`;
    if (fullScreenVideos.size > 0 || size === windowSize) return;
    windowSize = size;
    post({
      type: "resize",
      size: { windowWidth: window.innerWidth, windowHeight: window.innerHeight },
    });
  });

  let scrollQueued = false;
  let atBottom = false;
  window.addEventListener(
    "scroll",
    () => {
      if (scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(() => {
        scrollQueued = false;
        post({ type: "scroll", scrollTop: window.scrollY });
        const distance = Number(bundle.window.onReachBottomDistance ?? 50);
        const bottom =
          window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - distance;
        if (bottom && !atBottom) post({ type: "reachBottom" });
        atBottom = bottom;
      });
    },
    { passive: true },
  );

  // Selector queries
  const queryFields = (el: Element | null, fields: SelectorQueryRequest["fields"]) => {
    const result: Record<string, unknown> = {};
    const isViewport = el === null;
    if (fields.id) result.id = el?.id ?? "";
    if (fields.dataset) result.dataset = el ? datasetOf(states.get(el)?.props ?? {}) : {};
    if (fields.rect || fields.size) {
      const rect = el
        ? el.getBoundingClientRect()
        : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
      if (fields.rect)
        Object.assign(result, {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        });
      if (fields.size) Object.assign(result, { width: rect.width, height: rect.height });
    }
    if (fields.scrollOffset) {
      const box = isViewport ? document.documentElement : el;
      Object.assign(result, {
        scrollLeft: box.scrollLeft,
        scrollTop: box.scrollTop,
        scrollWidth: box.scrollWidth,
        scrollHeight: box.scrollHeight,
      });
    }
    if (fields.computedStyle && el) {
      const computed = getComputedStyle(el);
      for (const name of fields.computedStyle) {
        result[name] = computed.getPropertyValue(
          name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`),
        );
      }
    }
    if (fields.node) {
      const canvasNodeId = (el as Partial<CanvasElement> | null)?.canvasNodeId;
      const settings = (el as Partial<BuiltinElement> | null)?.omrSettings?.();
      result.node =
        canvasNodeId !== undefined
          ? { canvasNodeId, width: el!.clientWidth, height: el!.clientHeight }
          : el && settings
            ? {
                // A ScrollViewContext: the logic layer calls this very element back
                scrollView: {
                  tag: el.localName.slice(3),
                  id: el.id,
                  scopeNodeId: states.get(el)!.ownerId,
                  nodeKey: keyOf(el),
                  settings,
                },
              }
            : null;
    }
    if (fields.context) {
      // What the node is, so the logic layer builds its context, such as an EditorContext
      const state = el ? states.get(el) : undefined;
      result.context =
        el && state && el.localName.startsWith("wx-")
          ? {
              tag: el.localName.slice(3),
              id: el.id,
              scopeNodeId: state.ownerId,
              canvasId:
                state.props["canvas-id"] === undefined
                  ? undefined
                  : toText(state.props["canvas-id"]),
              canvasType: state.props.type ? toText(state.props.type) : undefined,
            }
          : null;
    }
    if (fields.properties && el) {
      const props = states.get(el)?.props ?? {};
      for (const name of fields.properties) {
        result[name] =
          props[name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)] ?? props[name];
      }
    }
    return result;
  };

  /** Keys of elements a selector query handed to the logic layer, which calls them back by key. */
  const nodeKeys = new WeakMap<Element, number>();
  const keyedNodes = new Map<number, WeakRef<Element>>();
  const keyOf = (el: Element) => {
    let key = nodeKeys.get(el);
    if (key === undefined) {
      key = keyedNodes.size + 1;
      nodeKeys.set(el, key);
      keyedNodes.set(key, new WeakRef(el));
    }
    return key;
  };

  /** The rendered elements a selector matches in a scope's template, in document order. */
  const selectIn = (scope: Scope, selector: string): Element[] => {
    let css = selector.replace(/>>>/g, " ");
    // A component's classes carry its prefix
    if (scope.owner) css = css.replace(/\.(-?[_a-zA-Z][\w-]*)/g, `.${scope.def.prefix}--$1`);
    try {
      return [...scope.root.querySelectorAll(css)].filter((el) => states.has(el));
    } catch {
      console.error(`[omr] invalid selector "${selector}"`);
      return [];
    }
  };

  const runQuery = (request: SelectorQueryRequest): unknown => {
    const scope = scopes.get(request.scopeNodeId);
    if (request.selector === null) return queryFields(null, request.fields);
    if (!scope) return request.all ? [] : null;
    const found = selectIn(scope, request.selector);
    return request.all
      ? found.map((el) => queryFields(el, request.fields))
      : found[0]
        ? queryFields(found[0], request.fields)
        : null;
  };

  // Intersection and media query observers
  const observers = createObservers({
    select: (scopeNodeId, selector) => {
      const scope = scopes.get(scopeNodeId);
      if (!scope) return null;
      if (!scope.initialized || !scope.root.isConnected) return undefined;
      return selectIn(scope, selector);
    },
    describe: (el) => ({ id: el.id, dataset: datasetOf(states.get(el)?.props ?? {}) }),
    post,
  });

  post({ type: "ready" });

  return (message: LogicToView) => {
    switch (message.type) {
      case "init":
        page.data = message.data;
        page.initialized = true;
        dirty.add(page);
        break;
      case "setData": {
        const scope = scopes.get(message.nodeId);
        if (scope) {
          for (const [key, value] of Object.entries(message.patch)) setPath(scope.data, key, value);
          dirty.add(scope);
        }
        break;
      }
      case "componentInit": {
        const scope = scopes.get(message.nodeId);
        if (scope) {
          scope.data = message.data;
          scope.options = message.options;
          scope.initialized = true;
          if (message.options.virtualHost) {
            scope.root.setAttribute(VIRTUAL_ATTRIBUTE, "");
            scope.root.removeAttribute("class");
            scope.root.removeAttribute("style");
          }
          dirty.add(scope);
        }
        break;
      }
      case "canvasFrame":
        canvasElements.get(message.canvasNodeId)?.omrDraw(message.bitmap);
        return;
      case "eventResult": {
        const pending = inputReplies.get(message.replyId);
        inputReplies.delete(message.replyId);
        // Typing that came after the event wins over the handler's late answer
        if (
          pending &&
          message.value !== undefined &&
          pending.input.omrFormValue?.() === pending.value
        ) {
          pending.input.omrReplaceValue?.(message.value);
        }
        return;
      }
      case "closePageContainer":
        openContainers.at(-1)?.omrClose();
        return;
      case "pageVisibility":
        // auto-pause-if-navigate, true by default: a hidden page's videos pause
        if (!message.visible) {
          for (const video of document.getElementsByTagName("wx-video")) {
            const props = states.get(video)?.props ?? {};
            if (
              props["auto-pause-if-navigate"] === false ||
              props["auto-pause-if-navigate"] === "false"
            ) {
              continue;
            }
            void (video as Partial<BuiltinElement>).omrCall?.("pause", []);
          }
        }
        return;
      case "pullDownRefresh":
        pullDown.set(message.refreshing);
        return;
      case "background":
        pullDown.background(message);
        return;
      case "backToTop":
        for (const el of document.querySelectorAll("wx-scroll-view")) {
          (el as { omrBackToTop?(): void }).omrBackToTop?.();
        }
        return;
      case "pageScrollTo":
        window.scrollTo({
          top: message.scrollTop,
          behavior: message.duration > 0 ? "smooth" : "auto",
        });
        return;
      case "fillNickname":
        nicknameInput?.omrFill?.(message.value);
        return;
      case "officialAccountState":
        officialAccounts.get(message.accountId)?.omrAccountState?.(message);
        officialAccounts.delete(message.accountId);
        return;
      case "cameraState":
        cameras.get(message.cameraId)?.omrCameraState?.(message);
        return;
      case "animate":
      case "clearAnimation": {
        const run = () => {
          const scope = scopes.get(message.scopeNodeId);
          const elements = scope ? selectIn(scope, message.selector) : [];
          const done = () => post({ type: "animationDone", animationId: message.animationId });
          if (elements.length === 0) {
            console.warn(`[omr] this.${message.type}: nothing matches "${message.selector}"`);
          }
          if (message.type === "animate") {
            animations.animate(elements, message.keyframes, message.duration, done);
          } else {
            animations.clear(elements, message.properties);
            done();
          }
        };
        // The elements may be in a render still to come, such as the first one after onLoad
        const scope = scopes.get(message.scopeNodeId);
        if (scope && (scheduled || !scope.initialized)) afterRender.push(run);
        else run();
        return;
      }
      case "query":
        post({
          type: "queryResult",
          queryId: message.queryId,
          results: message.requests.map(runQuery),
        });
        return;
      case "viewRequest": {
        const reply = (result?: Record<string, unknown>, error?: string) =>
          post({ type: "viewReply", requestId: message.requestId, result, error });
        void answerRequest(message.request, options.assetBase).then(
          (result) => reply(result),
          (error: unknown) =>
            reply(undefined, error instanceof Error ? error.message : String(error)),
        );
        return;
      }
      case "callBuiltin": {
        // A context such as VideoContext drives the component with its id in the caller's
        // template; the call runs after the renders that come before it
        const { callId, target } = message;
        void Promise.resolve()
          .then(() => {
            const keyed =
              target.nodeKey === undefined ? undefined : keyedNodes.get(target.nodeKey)?.deref();
            const el = (
              target.nodeKey !== undefined
                ? keyed?.isConnected
                  ? keyed
                  : undefined
                : [
                    ...(scopes
                      .get(target.scopeNodeId)
                      ?.root.getElementsByTagName(`wx-${target.tag}`) ?? []),
                  ].find(
                    (el) =>
                      target.id === undefined ||
                      (el.id === target.id && states.get(el)?.ownerId === target.scopeNodeId),
                  )
            ) as Partial<BuiltinElement> | undefined;
            if (!el?.omrCall) throw new Error(`no <${target.tag}> found`);
            // Sources a context passes, such as EditorContext.insertImage's, resolve like the template's,
            // and its selectors, such as ScrollViewContext.scrollIntoView's, match in that template
            const scope = scopes.get(target.scopeNodeId);
            if ("omrResolveAsset" in el && scope) {
              el.omrResolveAsset = (src: string) => env.resolveAsset(src, scope.def.template);
            }
            if (scope) el.omrSelect = (selector: string) => selectIn(scope, selector);
            return el.omrCall(message.method, message.args);
          })
          .then(
            (result) => post({ type: "builtinResult", callId, result: result ?? {} }),
            (error: unknown) =>
              post({
                type: "builtinResult",
                callId,
                error: error instanceof Error ? error.message : String(error),
              }),
          );
        return;
      }
      case "observeIntersection":
      case "observeMediaQuery":
      case "unobserve":
        // Observations start after the renders that come before them
        observers.receive(message);
        schedule();
        return;
    }
    pendingSeq = Math.max(pendingSeq, message.seq);
    schedule();
  };
}

const PULL_DOWN_CSS = `
.omr-refresh { position: fixed; top: 0; left: 0; right: 0; z-index: -1; display: flex; align-items: center; justify-content: center; gap: 6px; height: 0; overflow: hidden; }
.omr-refresh i { width: 6px; height: 6px; border-radius: 50%; background: rgba(0, 0, 0, 0.3); }
.omr-refresh[data-text-style="light"] i { background: rgba(255, 255, 255, 0.8); }
.omr-refresh.omr-refreshing i { animation: omr-refresh-dot 1.2s ease-in-out infinite; }
.omr-refresh.omr-refreshing i:nth-child(2) { animation-delay: 0.2s; }
.omr-refresh.omr-refreshing i:nth-child(3) { animation-delay: 0.4s; }
@keyframes omr-refresh-dot { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }
/* The page covers the backdrop until it is pulled down */
body { position: relative; background: #fff; }
`;

/** How far the page must be pulled before release starts a refresh, and where it rests while refreshing. */
const PULL_THRESHOLD = 50;
const PULL_MAX = 100;

/**
 * The pull-down refresh of a page with `enablePullDownRefresh`: pulling the
 * page down at the top uncovers the window background with three loading
 * dots, and letting go past the threshold refreshes until `stopPullDownRefresh`.
 */
function createPullDown(win: Record<string, unknown>, onRefresh: () => void) {
  const str = (value: unknown) => (typeof value === "string" ? value : undefined);
  const backdrop = document.createElement("div");
  backdrop.className = "omr-refresh";
  backdrop.innerHTML = "<i></i><i></i><i></i>";
  document.documentElement.append(backdrop);
  const paint = (options: { color?: string; top?: string; textStyle?: string }) => {
    const color = str(options.top) ?? str(options.color);
    if (color) backdrop.style.background = color;
    if (options.textStyle === "dark" || options.textStyle === "light") {
      backdrop.dataset.textStyle = options.textStyle;
    }
  };
  paint({
    color: str(win.backgroundColorTop) ?? str(win.backgroundColor) ?? "#ffffff",
    textStyle: str(win.backgroundTextStyle) ?? "dark",
  });

  let offset = 0;
  let refreshing = false;
  const move = (value: number, animate: boolean) => {
    offset = value;
    const body = document.body.style;
    body.transition = animate ? "transform 0.3s" : "none";
    body.transform = value ? `translateY(${value}px)` : "";
    backdrop.style.height = `${value}px`;
    backdrop.classList.toggle("omr-refreshing", refreshing);
  };
  const set = (value: boolean) => {
    if (value === refreshing) return;
    refreshing = value;
    move(value ? PULL_THRESHOLD : 0, true);
    if (value) onRefresh();
  };

  if (win.enablePullDownRefresh === true) {
    let start: { y: number; pointerId: number } | undefined;
    /** Whether the last press pulled the page, so its click is not a tap. */
    let pulled = false;
    document.addEventListener("pointerdown", (event) => {
      pulled = false;
      if (refreshing || window.scrollY > 0) return;
      start = { y: event.clientY, pointerId: event.pointerId };
    });
    document.addEventListener("pointermove", (event) => {
      if (!start || event.pointerId !== start.pointerId) return;
      const distance = event.clientY - start.y;
      // Resistance grows as the page is pulled further
      move(distance > 0 ? Math.min(PULL_MAX, distance * 0.5) : 0, false);
    });
    const release = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.pointerId) return;
      start = undefined;
      pulled = offset > 0;
      if (offset >= PULL_THRESHOLD) set(true);
      else move(0, true);
    };
    // Letting go after a pull is not a tap
    window.addEventListener(
      "click",
      (event) => {
        if (!pulled) return;
        pulled = false;
        event.stopPropagation();
      },
      true,
    );
    document.addEventListener("pointerup", release);
    document.addEventListener("pointercancel", release);
  }
  return { set, background: paint };
}
