/**
 * `wx.createIntersectionObserver` and `wx.createMediaQueryObserver`. The view
 * of the observer's page measures its nodes and window and reports threshold
 * crossings and match changes; the logic layer keeps the callbacks, which stop
 * with `disconnect` or when the page unloads.
 */
import { safeCall, type AnyFunction } from "./common.ts";
import type { ApiContext } from "./context.ts";
import type {
  IntersectionMargins,
  IntersectionRequest,
  LogicToView,
  MediaQueryDescriptor,
  ViewToLogic,
} from "../protocol.ts";

type Scope = { webviewId: number; nodeId: number };

export function createObserverApis({ host }: ApiContext): {
  apis: Record<string, unknown>;
  /** A report of a page's view about one of its observations. */
  receive(
    webviewId: number,
    message: Extract<ViewToLogic, { type: "intersection" | "mediaQuery" }>,
  ): void;
  releasePage(webviewId: number): void;
} {
  let lastObserverId = 0;
  /** Live observations by id: the page that reports them and the callback. */
  const observations = new Map<number, { webviewId: number; callback: AnyFunction }>();

  /** The page or component whose template selectors are scoped to; the current page without one. */
  const scopeOf = (component: unknown): Scope | undefined => {
    const scope = component && typeof component === "object" ? host.scopeOf(component) : undefined;
    if (scope) return scope;
    const webviewId = host.topWebviewId();
    return webviewId === undefined ? undefined : { webviewId, nodeId: 0 };
  };

  const start = (
    api: string,
    scope: Scope | undefined,
    callback: unknown,
    message: (observerId: number) => LogicToView,
  ): number | undefined => {
    if (typeof callback !== "function") {
      console.error(`[omr] ${api}: callback should be a function`);
      return undefined;
    }
    if (!scope) {
      console.error(`[omr] ${api}: no page is open`);
      return undefined;
    }
    const observerId = ++lastObserverId;
    observations.set(observerId, { webviewId: scope.webviewId, callback: callback as AnyFunction });
    host.sendView(scope.webviewId, message(observerId));
    return observerId;
  };
  const stop = (observerIds: number[]) => {
    for (const observerId of observerIds) {
      const observation = observations.get(observerId);
      if (!observation) continue;
      observations.delete(observerId);
      host.sendView(observation.webviewId, { type: "unobserve", observerId });
    }
  };

  const number = (value: unknown, fallback: number) => {
    const n = Number(value);
    return value !== null && value !== "" && Number.isFinite(n) ? n : fallback;
  };
  const marginsOf = (value: unknown): IntersectionMargins => {
    const margins = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    return {
      left: number(margins.left, 0),
      right: number(margins.right, 0),
      top: number(margins.top, 0),
      bottom: number(margins.bottom, 0),
    };
  };

  class IntersectionObserver {
    private readonly scope: Scope | undefined;
    private readonly thresholds: number[];
    private readonly initialRatio: number;
    private readonly observeAll: boolean;
    private readonly relatives: IntersectionRequest["relatives"] = [];
    private observerIds: number[] = [];
    constructor(scope: Scope | undefined, options: Record<string, unknown>) {
      this.scope = scope;
      this.thresholds = Array.isArray(options.thresholds)
        ? options.thresholds.map((value) => number(value, NaN)).filter(Number.isFinite)
        : [0];
      this.initialRatio = number(options.initialRatio, 0);
      this.observeAll = Boolean(options.observeAll);
    }
    relativeTo(selector: string, margins?: Partial<IntersectionMargins>) {
      this.relatives.push({ selector: String(selector), margins: marginsOf(margins) });
      return this;
    }
    relativeToViewport(margins?: Partial<IntersectionMargins>) {
      this.relatives.push({ selector: null, margins: marginsOf(margins) });
      return this;
    }
    observe(targetSelector: string, callback: AnyFunction) {
      const observerId = start("IntersectionObserver.observe", this.scope, callback, (id) => ({
        type: "observeIntersection",
        request: {
          observerId: id,
          scopeNodeId: this.scope!.nodeId,
          selector: String(targetSelector),
          all: this.observeAll,
          relatives: this.relatives.map((relative) => ({ ...relative })),
          thresholds: [...this.thresholds],
          initialRatio: this.initialRatio,
        },
      }));
      if (observerId !== undefined) this.observerIds.push(observerId);
    }
    disconnect() {
      stop(this.observerIds);
      this.observerIds = [];
    }
  }

  const descriptorOf = (value: unknown): MediaQueryDescriptor => {
    const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const descriptor: MediaQueryDescriptor = {};
    for (const name of ["minWidth", "maxWidth", "width", "minHeight", "maxHeight", "height"]) {
      const length = number(source[name], NaN);
      if (Number.isFinite(length)) descriptor[name as "width"] = length;
    }
    if (source.orientation === "landscape" || source.orientation === "portrait") {
      descriptor.orientation = source.orientation;
    }
    return descriptor;
  };

  class MediaQueryObserver {
    private readonly scope: Scope | undefined;
    private observerIds: number[] = [];
    constructor(scope: Scope | undefined) {
      this.scope = scope;
    }
    observe(descriptor: MediaQueryDescriptor, callback: AnyFunction) {
      const observerId = start("MediaQueryObserver.observe", this.scope, callback, (id) => ({
        type: "observeMediaQuery",
        observerId: id,
        descriptor: descriptorOf(descriptor),
      }));
      if (observerId !== undefined) this.observerIds.push(observerId);
    }
    disconnect() {
      stop(this.observerIds);
      this.observerIds = [];
    }
  }

  /** A report of the view of `webviewId`; only the page an observation belongs to may answer it. */
  const receive = (
    webviewId: number,
    message: Extract<ViewToLogic, { type: "intersection" | "mediaQuery" }>,
  ) => {
    const observation = observations.get(message.observerId);
    if (observation?.webviewId !== webviewId) return;
    safeCall(
      observation.callback,
      message.type === "intersection" ? message.result : { matches: message.matches },
    );
  };

  /** The page is gone; its observations end without telling its view. */
  const releasePage = (webviewId: number) => {
    for (const [observerId, observation] of observations) {
      if (observation.webviewId === webviewId) observations.delete(observerId);
    }
  };

  return {
    apis: {
      createIntersectionObserver: (component?: object, options?: Record<string, unknown>) =>
        new IntersectionObserver(scopeOf(component), options ?? {}),
      createMediaQueryObserver: (component?: object) => new MediaQueryObserver(scopeOf(component)),
    },
    receive,
    releasePage,
  };
}
