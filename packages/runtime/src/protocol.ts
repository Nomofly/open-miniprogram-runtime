/**
 * Messages between the logic layer (a Worker), the view layer (one WebView per
 * page) and the simulator shell that hosts both and relays between them.
 */
import type { AuthConfig } from "./auth.ts";
import type { Theme, ThemeVariables } from "./theme.ts";

/** omr.config.json: how the simulator stands in for WeChat. */
export interface SimulatorConfig {
  /** The simulated WeChat user and the permissions they have granted. */
  auth?: AuthConfig;
  /** Initial `wx.getStorageSync` contents, such as a login token that skips the login flow. */
  storage?: Record<string, unknown>;
  /** What `wx.getLocation` returns; `wx.chooseLocation` also returns the name and address. */
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  /** What `wx.scanCode` reads; the scan sheet is shown unless `auth.consent` answers it. */
  scanCode?: { result?: string; scanType?: string; charSet?: string; path?: string };
  /**
   * How payment sheets (`wx.requestPayment`, `wx.requestCommonPayment`,
   * `wx.requestVirtualPayment`) are answered: `success` or `cancel` without the
   * sheet; otherwise as `auth.consent` says. `amount` in fen is shown for
   * `wx.requestPayment`, whose parameters do not carry it.
   */
  payment?: { result?: "success" | "cancel"; amount?: number };
  /** `wx.requestSubscribeMessage` answers by template id; templates not listed are asked for. */
  subscribeMessage?: Record<string, "accept" | "reject" | "ban" | "filter">;
  /** What `wx.chooseAddress` returns, over a default address in Beijing. */
  address?: Record<string, string>;
  /** What `wx.chooseInvoiceTitle` returns, over a default company title. */
  invoiceTitle?: Record<string, string>;
  /** `wx.getExtConfig` and `wx.getExtConfigSync`: the `ext` of a third-party platform's ext.json. */
  extConfig?: Record<string, unknown>;
  media?: {
    /** Project paths of the images `wx.chooseImage` and `wx.chooseMedia` pick from the album; generated images otherwise. */
    images?: string[];
    /** The duration in seconds of every audio source; default 10. */
    audioDuration?: number;
  };
}

export interface Manifest {
  appid: string;
  /** `projectname` from project.config.json, shown in authorization dialogs. */
  appName: string;
  appJson: Record<string, unknown>;
  pages: string[];
  entryPage: string;
  /** Window configuration of each page, from app.json and the page's json. */
  windows: Record<string, Record<string, unknown>>;
  /** theme.json at app.json `themeLocation`, read when app.json sets `"darkmode": true`. */
  themeVariables?: ThemeVariables;
  config: SimulatorConfig;
}

/** The `wx.getSystemInfoSync()` result for the simulated device. */
export type SystemInfo = Record<string, unknown> & {
  windowWidth: number;
  windowHeight: number;
  statusBarHeight: number;
};

export interface MenuButtonRect {
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface WxEventTarget {
  id: string;
  dataset: Record<string, unknown>;
  offsetLeft?: number;
  offsetTop?: number;
}

export interface WxEvent {
  type: string;
  timeStamp: number;
  target: WxEventTarget;
  currentTarget: WxEventTarget;
  detail: Record<string, unknown>;
  touches?: unknown[];
  changedTouches?: unknown[];
  mark?: Record<string, unknown>;
}

/** Event handlers a component's host binds in its owner's template, by event name. */
export type ComponentListeners = Record<string, { handler: string; catch: boolean }>;

export interface ComponentViewOptions {
  externalClasses: string[];
  /** `isolated`, `apply-shared` or `shared`. */
  styleIsolation: string;
  /** `options.virtualHost`: the host takes no box, so its children lay out in its parent. */
  virtualHost?: boolean;
  /** Has `wx://form-field`: a form submits its `value` data under its `name`. */
  formField?: boolean;
}

/** An event binding in a template, as `triggerEvent` finds it on the way up. */
export interface EventBinding {
  name: string;
  handler: string;
  catch: boolean;
  capture: boolean;
}

/** An element above a component host that binds events, nearest first. */
export interface AncestorBindings {
  /** The page (0) or component whose template has the element. */
  ownerId: number;
  id: string;
  dataset: Record<string, unknown>;
  events: EventBinding[];
}

/** Where a component sits in the page, which relations, selectors and bubbling events use. */
export interface TreeNode {
  nodeId: number;
  /** The nearest component host above it in the rendered page, through slots; 0 for the page. */
  parentId: number;
  /** The tag its owner wrote, such as `van-button`. */
  tag: string;
  /** The `class` its owner wrote, before scoping. */
  className: string;
  /** Its host's bindings, capture ones included. */
  events: EventBinding[];
  ancestors: AncestorBindings[];
}

export type ViewToLogic =
  | { type: "ready" }
  /** Whether a `<page-container>` is open on the page; a return closes it instead of the page. */
  | { type: "pageContainer"; open: boolean }
  | { type: "rendered"; seq: number }
  | {
      type: "event";
      /** The page (0) or component whose template binds the handler. */
      ownerId: number;
      handler: string;
      event: WxEvent;
      /**
       * Set for button `open-type` events whose detail the logic layer provides;
       * one part of a combined open-type such as `getPhoneNumber|agreePrivacyAuthorization`.
       */
      openType?: string;
    }
  /** An `<input type="nickname">` gained or lost focus. */
  | { type: "nickname"; focused: boolean }
  /** A `<camera>` was inserted into or removed from the page. */
  | { type: "camera"; cameraId: number; mounted: boolean }
  | {
      type: "attach";
      nodeId: number;
      ownerId: number;
      /** Component path, such as `components/card/card`. */
      path: string;
      props: Record<string, unknown>;
      listeners: ComponentListeners;
      id: string;
      dataset: Record<string, unknown>;
    }
  | {
      type: "props";
      nodeId: number;
      props: Record<string, unknown>;
      listeners: ComponentListeners;
      /** The host's current id and dataset, which `selectComponent` and `triggerEvent` use. */
      id: string;
      dataset: Record<string, unknown>;
    }
  | { type: "detach"; nodeIds: number[] }
  /** Every component of the page in document order, sent after a render that changed any of them. */
  | { type: "tree"; nodes: TreeNode[] }
  | { type: "navigate"; openType: string; url?: string; delta?: number }
  | { type: "scroll"; scrollTop: number }
  /** The page's window changed size. */
  | { type: "resize"; size: { windowWidth: number; windowHeight: number } }
  | { type: "reachBottom" }
  /** The attributes of the page's `<navigation-bar>` changed. */
  | { type: "navigationBar"; attributes: Record<string, unknown> }
  /** The user pulled the page down far enough, or `wx.startPullDownRefresh` started it. */
  | { type: "pullDownRefresh" }
  /** An observed node's intersection ratio crossed a threshold. */
  | { type: "intersection"; observerId: number; result: IntersectionResult }
  /** A media query's match state at first, then each time it changes. */
  | { type: "mediaQuery"; observerId: number; matches: boolean }
  | { type: "queryResult"; queryId: number; results: unknown[] }
  /** The answer to `callBuiltin`: what the method returned, or why it failed. */
  | { type: "builtinResult"; callId: number; result?: Record<string, unknown>; error?: string }
  /** An `animate` finished, or a `clearAnimation` is done. */
  | { type: "animationDone"; animationId: number }
  /** The answer to a `viewRequest`; `error` is the fail reason. */
  | { type: "viewReply"; requestId: number; result?: Record<string, unknown>; error?: string };

export type LogicToView =
  | { type: "init"; data: Record<string, unknown>; seq: number }
  | { type: "setData"; nodeId: number; patch: Record<string, unknown>; seq: number }
  | {
      type: "componentInit";
      nodeId: number;
      data: Record<string, unknown>;
      options: ComponentViewOptions;
      seq: number;
    }
  | { type: "pageScrollTo"; scrollTop: number; duration: number }
  /** The user chose their WeChat nickname above the keyboard of the focused nickname input. */
  | { type: "fillNickname"; value: string }
  /** Whether a `<camera>` may show its preview; `error` is the `binderror` message when not. */
  | { type: "cameraState"; cameraId: number; error?: string }
  /** `this.animate`: plays WeChat keyframes on the elements a selector finds in a page's or component's template. */
  | {
      type: "animate";
      animationId: number;
      scopeNodeId: number;
      selector: string;
      keyframes: Record<string, unknown>[];
      duration: number;
    }
  /** `this.clearAnimation`: removes the named keyframe fields of earlier `animate` calls, or all of them. */
  | {
      type: "clearAnimation";
      animationId: number;
      scopeNodeId: number;
      selector: string;
      properties?: string[];
    }
  | { type: "query"; queryId: number; requests: SelectorQueryRequest[] }
  /** Calls a method of a built-in component, such as `VideoContext.play` on a `<video>`; answered by `builtinResult`. */
  | { type: "callBuiltin"; callId: number; target: BuiltinTarget; method: string; args: unknown[] }
  /** `IntersectionObserver.observe`: the view reports threshold crossings as `intersection`. */
  | { type: "observeIntersection"; request: IntersectionRequest }
  /** `MediaQueryObserver.observe`: the view reports the match state as `mediaQuery`. */
  | { type: "observeMediaQuery"; observerId: number; descriptor: MediaQueryDescriptor }
  /** Stops an intersection or media query observation. */
  | { type: "unobserve"; observerId: number }
  /** A new picture of a `<canvas>`, drawn by the logic layer. */
  | { type: "canvasFrame"; canvasNodeId: number; bitmap: ImageBitmap }
  /** A return while a `<page-container>` is open: the view closes the container. */
  | { type: "closePageContainer" }
  /** The page went to the background (another page covers it, or the app left) or came back. */
  | { type: "pageVisibility"; visible: boolean }
  /** Starts or ends the pull-down refresh animation. */
  | { type: "pullDownRefresh"; refreshing: boolean }
  /** `wx.setBackgroundColor` and `wx.setBackgroundTextStyle`: the window behind the page. */
  | { type: "background"; color?: string; top?: string; bottom?: string; textStyle?: string }
  /** Work an app-level API needs done in the page, answered with `viewReply`. */
  | { type: "viewRequest"; requestId: number; request: ViewRequest };

/** What a `viewRequest` asks the view to do. */
export type ViewRequest =
  /** `wx.loadFontFace`: adds a font to the page; `source` is a `url(...)` or a plain URL. */
  | { kind: "loadFontFace"; family: string; source: string; desc: Record<string, string> }
  /** `wx.hideKeyboard`: blurs the focused input. */
  | { kind: "hideKeyboard" }
  /** `wx.getSelectedTextRange`: the focused input's selection, `{ start, end }`, or `{}`. */
  | { kind: "selectedTextRange" };

/** The built-in component a context such as `VideoContext` drives. */
export interface BuiltinTarget {
  /** The component's tag, such as `video`. */
  tag: string;
  /** Its id in the template of `scopeNodeId`; without one, the first such component anywhere in the page. */
  id?: string;
  /** The page (0) or component whose template has the component. */
  scopeNodeId: number;
}

/** One `wx.createSelectorQuery()` selection and the fields to read from it. */
export interface SelectorQueryRequest {
  /** Null selects the viewport. */
  selector: string | null;
  all: boolean;
  /** The page (0) or component whose template the selector is scoped to. */
  scopeNodeId: number;
  fields: {
    id?: boolean;
    dataset?: boolean;
    rect?: boolean;
    size?: boolean;
    scrollOffset?: boolean;
    computedStyle?: string[];
    properties?: string[];
    /** The node of a `<canvas type="2d">`: the view answers `{ canvasNodeId, width, height }`. */
    node?: boolean;
    /** The node's context, such as an `EditorContext`: the view answers what the node is, a `ContextNode`. */
    context?: boolean;
  };
}

/** What the view tells the logic layer about a node, so it can build the node's context. */
export interface ContextNode extends BuiltinTarget {
  /** The `canvas-id` of a `<canvas>`. */
  canvasId?: string;
  /** The `type` of a `<canvas>`, such as `2d`; a legacy canvas has none. */
  canvasType?: string;
}

/** How far each edge of a reference area moves outward; negative values shrink it. */
export interface IntersectionMargins {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** One `IntersectionObserver.observe` call, with the reference areas set before it. */
export interface IntersectionRequest {
  observerId: number;
  /** The page (0) or component whose template the selectors are scoped to. */
  scopeNodeId: number;
  selector: string;
  /** `observeAll`: every node the selector matches rather than the first. */
  all: boolean;
  /** `relativeTo` nodes, or the viewport for a null selector; the reference area is their intersection. */
  relatives: { selector: string | null; margins: IntersectionMargins }[];
  thresholds: number[];
  initialRatio: number;
}

export interface IntersectionRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/** The callback argument of `IntersectionObserver.observe`. */
export interface IntersectionResult {
  id: string;
  dataset: Record<string, unknown>;
  time: number;
  intersectionRatio: number;
  intersectionRect: IntersectionRect;
  boundingClientRect: IntersectionRect;
  relativeRect: { left: number; right: number; top: number; bottom: number };
}

/** The descriptor of `MediaQueryObserver.observe`; lengths in px. */
export interface MediaQueryDescriptor {
  minWidth?: number;
  maxWidth?: number;
  width?: number;
  minHeight?: number;
  maxHeight?: number;
  height?: number;
  orientation?: "landscape" | "portrait";
}

export interface StackEntry {
  webviewId: number;
  route: string;
}

export type ShellToLogic =
  | {
      type: "boot";
      manifest: Manifest;
      system: SystemInfo;
      menuButton: MenuButtonRect;
      /** Heights of the status and navigation bars together, and of the tab bar with the safe area below it. */
      chrome: { navigationBar: number; tabBar: number };
      /** The logic-layer bundle from the compiler's `compileAppService`. */
      appService: string;
      /** Storage kept from an earlier session; config storage is used when absent. */
      storage?: Record<string, unknown>;
      /** The page to open first, instead of the app's entry page. */
      launch?: { path: string; query: Record<string, string> };
      /** The system theme; light when absent. */
      theme?: Theme;
    }
  | { type: "view"; webviewId: number; message: ViewToLogic }
  | { type: "uiResult"; callId: number; result?: Record<string, unknown>; error?: string }
  | { type: "switchTab"; url: string }
  | { type: "navigateBack" }
  /** The navigation bar's home button. */
  | { type: "reLaunch"; url: string }
  /** The capsule's menu button was tapped. */
  | { type: "menu" }
  /** The user left the Mini Program, such as with the capsule's close button. */
  | { type: "appHide" }
  /** The user came back to the Mini Program from `scene` (1001 when absent); the last page shows again. */
  | { type: "appShow"; scene?: number }
  /** The system theme changed. */
  | { type: "theme"; theme: Theme };

export type LogicToShell =
  | {
      type: "route";
      openType: string;
      /** The page stack, bottom first; the last entry is shown. */
      stack: StackEntry[];
      /** Every live WebView: the stack and tab pages kept in the background. */
      alive: StackEntry[];
    }
  | { type: "toView"; webviewId: number; message: LogicToView }
  | { type: "ui"; callId: number; name: string; args: Record<string, unknown> }
  | { type: "storage"; storage: Record<string, unknown> }
  /** Capabilities the Mini Program is using now; the capsule shows their icons instead of its dots. */
  | { type: "permissionsInUse"; kinds: PermissionKind[] };

/** Capabilities whose use WeChat shows in the capsule. */
export type PermissionKind = "camera" | "record" | "location";
