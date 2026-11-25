/**
 * What the `wx` API modules share: the host the logic layer runs in, and the
 * helpers of `createWx` that several modules need, such as the privacy check.
 */
import type {
  BuiltinTarget,
  LogicToView,
  Manifest,
  MenuButtonRect,
  PermissionKind,
  SelectorQueryRequest,
  SystemInfo,
} from "../protocol.ts";
import type { Theme } from "../theme.ts";

/** Where the simulator serves a file of the Mini Program's file system, by its path, such as `http://tmp/a.png`. */
export const FS_FILE_PATH = "/__omr/fs/file";

/** Whether a path names a file of the Mini Program's file system rather than of its code package. */
export const isFsPath = (path: string) => /^(http:\/\/tmp\/|wxfile:\/\/)/.test(path);

/** The URL the simulator serves a file system path at. */
export const fsFileUrl = (path: string) => `${FS_FILE_PATH}?path=${encodeURIComponent(path)}`;

/**
 * The Mini Program's file system: `http://tmp/` and `wxfile://` paths. The
 * simulator server keeps it, so the view can show its files by URL; the logic
 * layer reaches it synchronously, as `FileSystemManager`'s `*Sync` methods need.
 */
export interface FsHost {
  /** Runs one operation of `MemoryFs` and returns its result; throws an Error with WeChat's fail reason. */
  call(op: string, args: Record<string, unknown>, data?: Uint8Array): FsResult;
}

export interface FsResult {
  value?: unknown;
  data?: Uint8Array;
}

/** Files other API modules create and read, such as a canvas export or a chosen image. */
export interface TempFiles {
  /** Stores bytes as a new temporary file and returns its path, `http://tmp/<name>.<ext>`. */
  writeTemp(data: Uint8Array, extension: string): string;
  /** The bytes of a file, or undefined when there is none. */
  read(path: string): Uint8Array | undefined;
  /** The size of a file in bytes, or undefined when there is none. */
  size(path: string): number | undefined;
}

export interface WxHost {
  manifest: Manifest;
  system: SystemInfo;
  menuButton: MenuButtonRect;
  /** Mutable; call `saveStorage` after changing it. */
  storage: Record<string, unknown>;
  saveStorage(): void;
  launchOptions: Record<string, unknown>;
  /** The options of the latest launch or return to the foreground. */
  enterOptions(): Record<string, unknown>;
  /** The system theme. */
  theme(): Theme;
  fs: FsHost;
  /** Shows native UI in the shell, such as a toast or a consent dialog, and resolves with its result. */
  ui(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Performs a navigation; for `navigateTo`, returns the opener's event channel. */
  navigate(openType: string, options: { url?: string; delta?: number; events?: object }): unknown;
  topWebviewId(): number | undefined;
  scopeOf(instance: object): { webviewId: number; nodeId: number } | undefined;
  query(webviewId: number, requests: SelectorQueryRequest[]): Promise<unknown[]>;
  /** Calls a method of a built-in component in a page; rejects with the view's reason, or when the page is gone. */
  callBuiltin(
    webviewId: number,
    target: BuiltinTarget,
    method: string,
    args: unknown[],
  ): Promise<Record<string, unknown>>;
  sendView(webviewId: number, message: LogicToView): void;
  /** How far the current page's window starts below the screen top and ends above its bottom. */
  windowInsets(): { top: number; bottom: number };
  /** `wx.hideTabBar` and `wx.showTabBar`: a hidden tab bar leaves its height to the page's window. */
  setTabBarHidden(hidden: boolean): void;
  /** Shows in the capsule which capabilities are in use. */
  setPermissionsInUse(kinds: PermissionKind[]): void;
}

export interface ApiContext {
  host: WxHost;
  /** The `wx` object, for APIs built on other APIs. */
  wx: Record<string, any>;
  files: TempFiles;
  /** Waits for the privacy guide to be agreed, as privacy APIs do; throws the WeChat failure. */
  requirePrivacy(referrer: string): Promise<void>;
  /** Asks for a scope as `wx.authorize` does and resolves whether it is granted. */
  requestScope(scope: string): Promise<boolean>;
  /** Shows a capability in use in the capsule until the returned function is called. */
  holdPermission(kind: PermissionKind): () => void;
  /**
   * The `<camera>` on a page, or undefined without one: `ready` once it shows
   * its preview, else `error` is its `insertCamera` failure, or it is still asking.
   */
  cameraState(webviewId: number): { ready: boolean; error?: string } | undefined;
}
