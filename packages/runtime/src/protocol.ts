/**
 * Messages between the logic layer (a Worker), the view layer (one WebView per
 * page) and the simulator shell that hosts both and relays between them.
 */
import type { AuthConfig } from "./auth.ts";

/** omr.config.json: how the simulator stands in for WeChat. */
export interface SimulatorConfig {
  /** The simulated WeChat user and the permissions they have granted. */
  auth?: AuthConfig;
  /** Initial `wx.getStorageSync` contents, such as a login token that skips the login flow. */
  storage?: Record<string, unknown>;
  /** What `wx.getLocation` returns. */
  location?: { latitude: number; longitude: number };
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
}

export type ViewToLogic =
  | { type: "ready" }
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
    }
  | { type: "detach"; nodeIds: number[] }
  | { type: "navigate"; openType: string; url?: string; delta?: number }
  | { type: "scroll"; scrollTop: number }
  | { type: "reachBottom" }
  | { type: "queryResult"; queryId: number; results: unknown[] };

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
  | { type: "query"; queryId: number; requests: SelectorQueryRequest[] };

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
  };
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
    }
  | { type: "view"; webviewId: number; message: ViewToLogic }
  | { type: "uiResult"; callId: number; result?: Record<string, unknown>; error?: string }
  | { type: "switchTab"; url: string }
  | { type: "navigateBack" };

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
