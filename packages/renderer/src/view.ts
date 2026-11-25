/**
 * The view layer of one page: renders the page and its custom components from
 * data the logic layer sends, and sends user events back to it.
 */
import type { WebviewBundle, WxmlFile } from "@omr/compiler";
import type {
  ComponentListeners,
  ComponentViewOptions,
  LogicToView,
  SelectorQueryRequest,
  ViewToLogic,
  WxEventTarget,
} from "@omr/runtime";
import { resolvePath, setPath, toJsonValue } from "@omr/runtime";
import { toText } from "./expression.ts";
import { BASE_CSS, defineBuiltins, type BuiltinElement, type OmrEventDetail } from "./builtins.ts";
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
  post: (message: ViewToLogic) => void;
}

/** The attribute that marks a component host; matches `HOST_ATTRIBUTE` in @omr/compiler. */
const HOST_ATTRIBUTE = "omr-host";

/** What the WeChat events of a button `open-type` are called. */
const OPEN_TYPE_EVENTS: Record<string, string> = {
  getPhoneNumber: "getphonenumber",
  getRealtimePhoneNumber: "getrealtimephonenumber",
  getUserInfo: "getuserinfo",
  chooseAvatar: "chooseavatar",
  openSetting: "opensetting",
  contact: "contact",
  launchApp: "launchapp",
  agreePrivacyAuthorization: "agreeprivacyauthorization",
  share: "",
  feedback: "",
};

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

  const style = document.createElement("style");
  style.textContent = `${BASE_CSS}\n${convertRpx(bundle.css, options.windowWidth, hairline)}`;
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
      /^([a-z][\w+.-]*:|\/\/)/i.test(src) ? src : `${options.assetBase}${resolvePath(file, src)}`,
  };

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
    for (const name of Object.keys(previous)) {
      if (!(name in attrs)) setAttribute(el, name, undefined);
    }
    for (const [name, value] of Object.entries(attrs)) {
      if (!(name in previous) || previous[name] !== value) setAttribute(el, name, value);
    }
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
    let scope = state.scope;
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
        id: toText(props.id),
        dataset: datasetOf(props),
      });
      scope.sentProps = JSON.stringify([jsonProps, listeners]);
    } else {
      const sent = JSON.stringify([jsonProps, listeners]);
      if (sent !== scope.sentProps) {
        scope.sentProps = sent;
        post({ type: "props", nodeId: scope.nodeId, props: jsonProps, listeners });
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
    }
    const vnodes = renderScope(scope, env);
    patchChildren(scope.root, scope.vnodes, vnodes, scope.anchor);
    scope.vnodes = vnodes;
  };

  // Batching: messages mark scopes dirty; one flush renders them, then reports the sequence number
  const dirty = new Set<Scope>();
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
    if (pendingSeq > renderedSeq) {
      renderedSeq = pendingSeq;
      post({ type: "rendered", seq: renderedSeq });
    }
  };

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
    extra: { touches?: unknown[]; changedTouches?: unknown[] } = {},
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

  const touchesOf = (event: PointerEvent | MouseEvent) => {
    const touch = {
      identifier: "pointerId" in event ? event.pointerId : 0,
      pageX: event.pageX,
      pageY: event.pageY,
      clientX: event.clientX,
      clientY: event.clientY,
      force: 1,
    };
    return { touches: [touch], changedTouches: [touch] };
  };

  const isDisabled = (el: Element | null) => !!el && Boolean(states.get(el)?.props.disabled);

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
      const form = button.closest("wx-form");
      if (form && (formType === "submit" || formType === "reset")) submitForm(form, formType);
    }
    const navigator = target.closest("wx-navigator");
    if (navigator) {
      const props = states.get(navigator)?.props ?? {};
      if (props.target !== "miniProgram") {
        post({
          type: "navigate",
          openType: toText(props["open-type"] ?? "navigate"),
          url: props.url === undefined ? undefined : toText(props.url),
          delta: props.delta === undefined ? undefined : Number(props.delta),
        });
      }
    }
    const control = target.closest<BuiltinElement>("wx-checkbox, wx-radio, wx-switch, wx-picker");
    const label = target.closest("wx-label");
    if (control) {
      control.omrActivate?.();
    } else if (label) {
      const forId = states.get(label)?.props.for;
      const linked = forId
        ? document.getElementById(toText(forId))
        : label.querySelector("wx-checkbox, wx-radio, wx-switch");
      (linked as Partial<BuiltinElement> | null)?.omrActivate?.();
      if (linked && /^WX-(INPUT|TEXTAREA)$/.test(linked.tagName)) {
        linked.querySelector<HTMLElement>("input, textarea")?.focus();
      }
    }
  };

  const submitForm = (form: Element, kind: "submit" | "reset") => {
    const controls = [...form.querySelectorAll("*")].filter(
      (el) => typeof (el as Partial<BuiltinElement>).omrFormValue === "function",
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
    dispatch(form, "submit", { value }, false);
  };

  let pressed:
    | { target: Element; x: number; y: number; timer: ReturnType<typeof setTimeout> }
    | undefined;
  let suppressTap = false;
  let hovered: { el: Element; classes: string[]; stay: number }[] = [];

  const hoverOf = (el: Element) => {
    const props = states.get(el)?.props ?? {};
    const tag = el.tagName;
    const builtinHover =
      tag === "WX-BUTTON" ? "button-hover" : tag === "WX-NAVIGATOR" ? "navigator-hover" : "none";
    const value = toText(props["hover-class"] ?? builtinHover);
    if (value === "none" || value === "" || props.disabled) return undefined;
    const stay = Number(props["hover-stay-time"] ?? (builtinHover === "none" ? 400 : 70));
    return { classes: value.split(/\s+/), stay };
  };

  document.addEventListener("pointerdown", (event) => {
    const target = managed(event.target);
    if (!target) return;
    suppressTap = false;
    dispatch(target, "touchstart", {}, true, touchesOf(event));
    for (let el: Element | undefined = target; el; el = managedParent(el)) {
      const hover = hoverOf(el);
      if (hover) {
        el.classList.add(...hover.classes);
        hovered.push({ el, ...hover });
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
      }, 350),
    };
  });
  document.addEventListener("pointermove", (event) => {
    if (!pressed) return;
    if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 10)
      clearTimeout(pressed.timer);
    dispatch(pressed.target, "touchmove", {}, true, touchesOf(event));
  });
  const release = (name: string) => (event: PointerEvent) => {
    if (!pressed) return;
    clearTimeout(pressed.timer);
    dispatch(pressed.target, name, {}, true, touchesOf(event));
    pressed = undefined;
    for (const { el, classes, stay } of hovered)
      setTimeout(() => el.classList.remove(...classes), stay);
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
      dispatch(target, "tap", { x: event.pageX, y: event.pageY }, true, touchesOf(event));
    }
    afterTap(target);
  });

  // Events raised by built-in components do not bubble
  document.addEventListener(
    "omr-event",
    (event) => {
      const target = managed(event.target);
      const { name, detail } = (event as CustomEvent<OmrEventDetail>).detail;
      if (target) dispatch(target, name, detail, false);
    },
    true,
  );

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
    const { camera, mounted } = (
      event as CustomEvent<{ camera: BuiltinElement & { cameraId: number }; mounted: boolean }>
    ).detail;
    if (mounted) cameras.set(camera.cameraId, camera);
    else cameras.delete(camera.cameraId);
    post({ type: "camera", cameraId: camera.cameraId, mounted });
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
    if (fields.properties && el) {
      const props = states.get(el)?.props ?? {};
      for (const name of fields.properties) {
        result[name] =
          props[name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)] ?? props[name];
      }
    }
    return result;
  };

  const runQuery = (request: SelectorQueryRequest): unknown => {
    const scope = scopes.get(request.scopeNodeId);
    if (request.selector === null) return queryFields(null, request.fields);
    if (!scope) return request.all ? [] : null;
    let selector = request.selector.replace(/>>>/g, " ");
    // A component's classes carry its prefix
    if (scope.owner)
      selector = selector.replace(/\.(-?[_a-zA-Z][\w-]*)/g, `.${scope.def.prefix}--$1`);
    let found: Element[] = [];
    try {
      found = [...scope.root.querySelectorAll(selector)].filter((el) => states.has(el));
    } catch {
      console.error(`[omr] invalid selector "${request.selector}"`);
    }
    return request.all
      ? found.map((el) => queryFields(el, request.fields))
      : found[0]
        ? queryFields(found[0], request.fields)
        : null;
  };

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
          dirty.add(scope);
        }
        break;
      }
      case "pageScrollTo":
        window.scrollTo({
          top: message.scrollTop,
          behavior: message.duration > 0 ? "smooth" : "auto",
        });
        return;
      case "fillNickname":
        nicknameInput?.omrFill?.(message.value);
        return;
      case "cameraState":
        cameras.get(message.cameraId)?.omrCameraState?.(message.error);
        return;
      case "query":
        post({
          type: "queryResult",
          queryId: message.queryId,
          results: message.requests.map(runQuery),
        });
        return;
    }
    pendingSeq = Math.max(pendingSeq, message.seq);
    schedule();
  };
}
