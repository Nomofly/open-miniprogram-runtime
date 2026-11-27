/**
 * `<map>`: a simulated map without tiles. The simulator has no map data and
 * fetches none, so the base is a plain light surface with a latitude and
 * longitude grid, a scale bar, a compass and a "模拟地图" watermark; markers,
 * callouts, labels, polylines, polygons, circles and controls are drawn at
 * their Web Mercator positions over it. Dragging pans and the wheel or a
 * double tap zooms, firing WeChat's map events, and `MapContext` drives the
 * map through `omrCall`. Gestures and context calls move the map without
 * changing its attributes, as on WeChat; changing an attribute moves it again.
 */
import { toText } from "../expression.ts";
import { Applied, Builtin, animate, emit, lengthOf, trackDrag } from "./base.ts";
import {
  fitPoints,
  metersPerPixel,
  MAP_TILE,
  project,
  unproject,
  type LatLng,
} from "./mercator.ts";

type Options = Record<string, unknown>;

const DEFAULT_LOCATION: LatLng = { latitude: 39.908823, longitude: 116.39747 };
let mapLocation: LatLng = DEFAULT_LOCATION;

/** Sets where the user is: `location` of the simulator config, for `show-location`, `moveToLocation` and maps without a center. */
export function setMapLocation(location: LatLng | undefined): void {
  mapLocation = location
    ? { latitude: Number(location.latitude), longitude: Number(location.longitude) }
    : DEFAULT_LOCATION;
}

const DEFAULT_SCALE = 16;
const MIN_SCALE = 3;
const MAX_SCALE = 20;
/** How long a move the page asks for takes, in milliseconds. */
const MOVE_MS = 300;
/** How long the wheel rests before its zoom ends. */
const WHEEL_END_MS = 250;
/** The size of the marker icon the simulator draws when a marker has no `iconPath`. */
const PIN_WIDTH = 22;
const PIN_HEIGHT = 32;
/** `include-points` keeps the points this far from the map's edges: [top, right, bottom, left]. */
const INCLUDE_PADDING = [40, 30, 30, 30];
/** The distances the scale bar shows from scale 3 to 20, in meters, from WeChat's scale table. */
const SCALE_BAR_METERS = [
  1e6, 5e5, 2e5, 1e5, 5e4, 2.5e4, 2e4, 1e4, 5e3, 2e3, 1e3, 500, 200, 100, 50, 20, 10, 5,
];
/** Grid steps in degrees, from the coarsest. */
const GRID_STEPS = [
  30, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001,
].concat([5e-4, 2e-4, 1e-4, 5e-5, 2e-5, 1e-5]);
/** Grid lines are at least this far apart, in px. */
const GRID_SPACING = 80;

const SVG_NS = "http://www.w3.org/2000/svg";

const PIN =
  '<svg viewBox="0 0 22 32" preserveAspectRatio="none"><path d="M11 31C11 31 1.5 18.6 1.5 11a9.5 9.5 0 0 1 19 0C20.5 18.6 11 31 11 31z" fill="#f04b3e" stroke="#b8302a" stroke-width="1"/><circle cx="11" cy="11" r="3.6" fill="#fff"/></svg>';

const STYLE = `
  :host { display: inline-block; position: relative; overflow: hidden; }
  .surface { position: absolute; inset: 0; overflow: hidden; background: #f2efe9; touch-action: none; cursor: grab; user-select: none; -webkit-user-select: none; }
  .surface.satellite { background: #56634f; }
  :host-context(html.omr-dark) .surface { background: #24282d; }
  svg.layer { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
  .grid line { stroke: rgba(0, 0, 0, 0.08); stroke-width: 1; }
  .satellite .grid line, :host-context(html.omr-dark) .grid line { stroke: rgba(255, 255, 255, 0.08); }
  .hit { pointer-events: stroke; cursor: pointer; }
  .layer-div { position: absolute; inset: 0; pointer-events: none; isolation: isolate; }
  .marker { position: absolute; pointer-events: auto; cursor: pointer; }
  .marker > img, .marker > svg { display: block; width: 100%; height: 100%; pointer-events: none; }
  .label { position: absolute; pointer-events: auto; cursor: pointer; white-space: pre; line-height: 1.3; box-sizing: border-box; }
  .callout { position: absolute; pointer-events: auto; cursor: pointer; white-space: pre; line-height: 1.4; box-sizing: border-box; transform: translate(-50%, calc(-100% - 6px)); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2); }
  .callout::after { content: ""; position: absolute; left: 50%; top: 100%; margin-left: -6px; border: 6px solid transparent; border-top-color: var(--bg); }
  .control { position: absolute; pointer-events: none; }
  .control.clickable { pointer-events: auto; cursor: pointer; }
  .control > img { display: block; width: 100%; height: 100%; }
  .location { position: absolute; width: 0; height: 0; pointer-events: none; }
  .location .halo { position: absolute; left: -22px; top: -22px; width: 44px; height: 44px; border-radius: 50%; background: rgba(36, 122, 245, 0.18); }
  .location .dot { position: absolute; left: -7px; top: -7px; width: 14px; height: 14px; border-radius: 50%; background: #247af5; border: 2px solid #fff; box-sizing: border-box; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); }
  .location img { position: absolute; transform: translate(-50%, -50%); }
  .compass { position: absolute; left: 8px; top: 8px; width: 32px; height: 32px; border-radius: 50%; background: rgba(255, 255, 255, 0.92); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); pointer-events: none; }
  .compass svg { display: block; width: 100%; height: 100%; }
  .scalebar { position: absolute; left: 8px; bottom: 6px; pointer-events: none; font: 10px/1.2 -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif; color: #333; }
  .scalebar .bar { height: 4px; border: 1.5px solid #333; border-top: none; box-sizing: border-box; }
  :host-context(html.omr-dark) .scalebar, .satellite .scalebar { color: #eee; }
  :host-context(html.omr-dark) .scalebar .bar, .satellite .scalebar .bar { border-color: #eee; }
  .watermark { position: absolute; right: 6px; bottom: 4px; pointer-events: none; font: 10px/1.2 -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif; color: rgba(0, 0, 0, 0.35); }
  :host-context(html.omr-dark) .watermark, .satellite .watermark { color: rgba(255, 255, 255, 0.45); }
  .custom, .children { position: absolute; inset: 0; pointer-events: none; }
  ::slotted([slot="callout"]) { position: absolute !important; inset: 0 !important; overflow: visible !important; pointer-events: none !important; }
  .children ::slotted(*) { pointer-events: auto; }
`;

const isObject = (value: unknown): value is Options =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const listOf = (value: unknown): Options[] => (Array.isArray(value) ? value.filter(isObject) : []);
const numberOf = (value: unknown, fallback: number) => {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number) => Math.round(value * 1e6) / 1e6;
const rounded = ({ latitude, longitude }: LatLng): LatLng => ({
  latitude: round(latitude),
  longitude: round(longitude),
});
const pointOf = (value: unknown): LatLng | undefined => {
  if (!isObject(value)) return undefined;
  const latitude = numberOf(value.latitude, Number.NaN);
  const longitude = numberOf(value.longitude, Number.NaN);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : undefined;
};
const pointsOf = (value: unknown): LatLng[] =>
  Array.isArray(value) ? value.flatMap((point) => pointOf(point) ?? []) : [];
/** A point of a context call, or the call's failure. */
function requirePoint(value: unknown, prefix = ""): LatLng {
  const point = pointOf(value);
  if (!point) {
    throw new Error(`parameter error: ${prefix}latitude and ${prefix}longitude should be Number`);
  }
  return point;
}
const keyOf = (id: unknown) => String(id);
const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
/** Interpolates an angle the short way round. */
const lerpAngle = (from: number, to: number, t: number) =>
  from + (((((to - from) % 360) + 540) % 360) - 180) * t;

function div(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
}

/** Runs `step` over `duration` ms; resolves at the end, or when cancelled. A hidden page's frames may never come, so a timer finishes it too. */
function tween(
  duration: number,
  step: (t: number) => void,
  easing?: (t: number) => number,
): { promise: Promise<void>; cancel: () => void } {
  let done = false;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop = () => {};
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    stop();
    resolve();
  };
  stop = animate(
    duration,
    (t) => {
      if (done) return;
      step(t);
      if (t >= 1) finish();
    },
    easing,
  );
  if (!done) {
    timer = setTimeout(() => {
      if (done) return;
      step(1);
      finish();
    }, duration + 100);
  }
  return { promise, cancel: finish };
}

const linear = (t: number) => t;

/** What the map shows: its center, scale, rotation and skew. */
interface Camera {
  center: LatLng;
  scale: number;
  rotate: number;
  skew: number;
}

/** A marker as drawn: its parts and where it is now. */
interface MarkerView {
  key: string;
  id: unknown;
  marker: Options;
  box: HTMLElement;
  callout?: HTMLElement;
  calloutDisplay?: string;
  label?: HTMLElement;
  /** The size of an icon without width and height, once its image loaded. */
  natural?: { width: number; height: number };
}

let nextMapId = 0;

export class WxMap extends Builtin {
  /** Set by the view: resolves an `iconPath` like the owner template's paths. */
  omrResolveAsset?: (src: string) => string;
  private readonly surface: HTMLElement;
  private readonly grid: SVGElement;
  private readonly shapes: SVGElement;
  private readonly markerLayer: HTMLElement;
  private readonly calloutLayer: HTMLElement;
  private readonly controlLayer: HTMLElement;
  private readonly ui: HTMLElement;
  private readonly customLayer: HTMLElement;
  private readonly applied = new Applied();
  private readonly mapId = String(++nextMapId);
  private customStyle?: HTMLStyleElement;
  private camera: Camera = { center: mapLocation, scale: DEFAULT_SCALE, rotate: 0, skew: 0 };
  /** Where the center is on the map, as fractions of its size: `setCenterOffset`. */
  private offset = [0.5, 0.5];
  private initialized = false;
  /** `include-points` that arrived before the map had a size. */
  private pendingFit?: LatLng[];
  private markerViews: MarkerView[] = [];
  /** Markers added by `MapContext.addMarkers`, by id. */
  private readonly addedMarkers = new Map<string, Options>();
  /** Markers of the `markers` attribute removed by `removeMarkers`, or all of them after `addMarkers` with `clear`. */
  private readonly removed = new Set<string>();
  private clearedAttribute = false;
  /** Where `translateMarker` and `moveAlong` left markers, until `markers` changes. */
  private readonly moved = new Map<
    string,
    { latitude: number; longitude: number; rotate: number }
  >();
  private readonly markerAnimations = new Map<string, () => void>();
  /** The marker whose BYCLICK callout is open. */
  private openCallout?: string;
  private stopMove?: () => void;
  /** Where the move under way ends, which a fit that takes it over keeps. */
  private heading?: Camera;
  private wheel?: { timer: ReturnType<typeof setTimeout> };
  private updatedPending = false;
  private locationIcon?: string;

  constructor() {
    super();
    const root = this.shadow(
      `<style>${STYLE}</style><div class="surface"></div><div class="custom"><slot name="callout"></slot></div><div class="children"><slot></slot></div>`,
    );
    this.surface = root.querySelector(".surface")!;
    this.customLayer = root.querySelector(".custom")!;
    this.grid = svg("svg", { class: "layer grid" });
    this.shapes = svg("svg", { class: "layer shapes" });
    this.markerLayer = div("layer-div markers");
    this.calloutLayer = div("layer-div callouts");
    this.controlLayer = div("layer-div controls");
    this.ui = div("layer-div ui");
    this.surface.append(
      this.grid,
      this.shapes,
      this.markerLayer,
      this.calloutLayer,
      this.controlLayer,
      this.ui,
    );
    this.surface.addEventListener("click", (event) => this.onClick(event));
    this.surface.addEventListener("dblclick", (event) => this.onDoubleClick(event));
    this.surface.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
    this.customLayer.addEventListener("click", (event) => {
      const el = event
        .composedPath()
        .find((node): node is Element => node instanceof Element && node.hasAttribute("marker-id"));
      if (el) emit(this, "callouttap", { markerId: this.markerIdOf(el.getAttribute("marker-id")) });
    });
    root.querySelector('slot[name="callout"]')!.addEventListener("slotchange", () => this.draw());
    this.trackGestures();
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => this.draw()).observe(this);
  }

  connectedCallback(): void {
    this.setAttribute("omr-map", this.mapId);
    this.customStyle ??= document.createElement("style");
    this.ownerDocument.head.append(this.customStyle);
    if (this.pendingFit) {
      const points = this.pendingFit;
      this.pendingFit = undefined;
      Object.assign(this.camera, this.fit(points, INCLUDE_PADDING));
    }
    this.draw();
    this.scheduleUpdated();
  }

  disconnectedCallback(): void {
    this.customStyle?.remove();
  }

  // Attributes

  /** An attribute by its kebab-case name, its camelCase name, or in `setting`, which wins. */
  private option(name: string): unknown {
    const camel = name.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
    const setting = isObject(this.props.setting) ? this.props.setting : {};
    for (const value of [setting[camel], this.props[name], this.props[camel]]) {
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  }
  private numOption(name: string, fallback: number): number {
    return numberOf(this.option(name), fallback);
  }
  private flagOption(name: string, fallback: boolean): boolean {
    const value = this.option(name);
    return value === undefined ? fallback : Boolean(value);
  }
  private limits(): [number, number] {
    const min = clamp(this.numOption("min-scale", MIN_SCALE), MIN_SCALE, MAX_SCALE);
    const max = clamp(this.numOption("max-scale", MAX_SCALE), min, MAX_SCALE);
    return [min, max];
  }
  private clampScale(scale: number): number {
    const [min, max] = this.limits();
    return clamp(scale, min, max);
  }

  protected override update(): void {
    const latitude = this.numOption("latitude", Number.NaN);
    const longitude = this.numOption("longitude", Number.NaN);
    const center =
      Number.isFinite(latitude) && Number.isFinite(longitude)
        ? { latitude, longitude }
        : mapLocation;
    const target: Partial<Camera> = {};
    if (this.applied.changed("center", center)) target.center = center;
    const scale = this.clampScale(this.numOption("scale", DEFAULT_SCALE));
    if (this.applied.changed("scale", scale)) target.scale = scale;
    const rotate = this.numOption("rotate", 0);
    if (this.applied.changed("rotate", rotate)) target.rotate = rotate;
    const skew = clamp(this.numOption("skew", 0), 0, 40);
    if (this.applied.changed("skew", skew)) target.skew = skew;
    const include = pointsOf(this.props["include-points"] ?? this.props.includePoints);
    const fitting = this.applied.changed("include-points", include) && include.length > 0;
    if (!this.initialized) {
      this.initialized = true;
      Object.assign(this.camera, target);
    } else if (Object.keys(target).length > 0 && !(fitting && this.isConnected)) {
      void this.moveTo(target);
    }
    this.camera.scale = this.clampScale(this.camera.scale);

    let overlays = false;
    if (this.applied.changed("markers", this.props.markers ?? null)) {
      // New markers replace what the context did to the old ones
      this.removed.clear();
      this.clearedAttribute = false;
      for (const stop of this.markerAnimations.values()) stop();
      this.markerAnimations.clear();
      this.moved.clear();
      this.buildMarkers();
      overlays = true;
    }
    if (this.applied.changed("controls", this.props.controls ?? null)) {
      this.buildControls();
      overlays = true;
    }
    for (const name of ["polyline", "polygons", "circles"]) {
      if (this.applied.changed(name, this.props[name] ?? null)) overlays = true;
    }
    if (fitting) {
      if (!this.isConnected) this.pendingFit = include;
      // The fit sets the center and scale; the rest of the update's camera still applies
      else {
        const fit = this.fit(include, INCLUDE_PADDING, target.rotate, target.scale);
        void this.moveTo({ ...target, ...fit });
      }
    }
    this.surface.classList.toggle("satellite", this.flagOption("enable-satellite", false));
    this.draw();
    // Custom callouts are children, which the view renders after the map's attributes
    queueMicrotask(() => this.drawCustomCallouts());
    if (overlays) this.scheduleUpdated();
  }

  /** `updated` fires once the overlays of a change are drawn. */
  private scheduleUpdated(): void {
    if (this.updatedPending) return;
    this.updatedPending = true;
    setTimeout(() => {
      this.updatedPending = false;
      if (this.isConnected) emit(this, "updated");
    }, 0);
  }

  // Geometry

  private size(): { width: number; height: number } {
    const length = (value: string, fallback: number) =>
      /^\s*[\d.]+(px|rpx)?\s*$/.test(value) ? lengthOf(value, fallback) : fallback;
    return {
      width: this.clientWidth || length(this.style.width, 300),
      height: this.clientHeight || length(this.style.height, 150),
    };
  }

  /** Where the center is on the map, in px from its top left. */
  private origin(): { x: number; y: number } {
    const { width, height } = this.size();
    return { x: this.offset[0]! * width, y: this.offset[1]! * height };
  }

  /** Where a point is on the map, in px from its top left. */
  toScreen(point: LatLng, camera: Camera = this.camera): { x: number; y: number } {
    const world = MAP_TILE * 2 ** camera.scale;
    const center = project(camera.center, camera.scale);
    const at = project(point, camera.scale);
    // The nearest copy of the point across the antimeridian
    const dx = ((((at.x - center.x + world / 2) % world) + world) % world) - world / 2;
    const dy = at.y - center.y;
    const angle = (camera.rotate * Math.PI) / 180;
    const origin = this.origin();
    return {
      x: origin.x + dx * Math.cos(angle) + dy * Math.sin(angle),
      y: origin.y - dx * Math.sin(angle) + dy * Math.cos(angle),
    };
  }

  /** The point at a position on the map, in px from its top left. */
  fromScreen(x: number, y: number, camera: Camera = this.camera): LatLng {
    const origin = this.origin();
    const sx = x - origin.x;
    const sy = y - origin.y;
    const angle = (camera.rotate * Math.PI) / 180;
    const center = project(camera.center, camera.scale);
    return unproject(
      center.x + sx * Math.cos(angle) - sy * Math.sin(angle),
      center.y + sx * Math.sin(angle) + sy * Math.cos(angle),
      camera.scale,
    );
  }

  private region(): { southwest: LatLng; northeast: LatLng } {
    const { width, height } = this.size();
    const corners = [
      this.fromScreen(0, 0),
      this.fromScreen(width, 0),
      this.fromScreen(0, height),
      this.fromScreen(width, height),
    ];
    const latitudes = corners.map((point) => point.latitude);
    const longitudes = corners.map((point) => point.longitude);
    return {
      southwest: rounded({
        latitude: Math.min(...latitudes),
        longitude: Math.min(...longitudes),
      }),
      northeast: rounded({
        latitude: Math.max(...latitudes),
        longitude: Math.max(...longitudes),
      }),
    };
  }

  /** The center and scale that show the points inside the padding. */
  private fit(
    points: LatLng[],
    padding: number[],
    rotate = this.heading?.rotate ?? this.camera.rotate,
    current = this.heading?.scale ?? this.camera.scale,
  ): Partial<Camera> {
    const { width, height } = this.size();
    const { center, scale = this.clampScale(current) } = fitPoints(points, width, height, {
      padding,
      limit: (value) => this.clampScale(Math.floor(value)),
      rotate,
      origin: this.origin(),
      scale: this.clampScale(current),
    });
    // The fit holds at this rotation and scale (the map's own for points in one place), so the move ends there
    return { center, scale, rotate };
  }

  // Moving the map

  private regionChange(type: "begin" | "end", causedBy: string): void {
    const { rotate, skew, scale, center } = this.camera;
    // WeChat puts type and causedBy on the event itself; the detail carries them too
    emit(
      this,
      "regionchange",
      {
        type,
        causedBy,
        rotate,
        skew,
        scale,
        centerLocation: rounded(center),
        region: this.region(),
      },
      { type, causedBy },
    );
  }

  /** Moves the map as the page asked, by an attribute or the context, with `regionchange` caused by `update`. */
  private async moveTo(target: Partial<Camera>, duration = MOVE_MS): Promise<void> {
    this.stopMove?.();
    const from = { ...this.camera };
    const to: Camera = {
      center: target.center ?? from.center,
      scale: this.clampScale(target.scale ?? from.scale),
      rotate: target.rotate ?? from.rotate,
      skew: target.skew ?? from.skew,
    };
    this.heading = to;
    const start = project(from.center, 0);
    const end = project(to.center, 0);
    this.regionChange("begin", "update");
    const move = tween(this.isConnected ? duration : 0, (t) => {
      this.camera =
        t >= 1
          ? { ...to }
          : {
              center: unproject(lerp(start.x, end.x, t), lerp(start.y, end.y, t), 0),
              scale: lerp(from.scale, to.scale, t),
              rotate: lerpAngle(from.rotate, to.rotate, t),
              skew: lerp(from.skew, to.skew, t),
            };
      this.draw();
    });
    this.stopMove = move.cancel;
    await move.promise;
    if (this.stopMove === move.cancel) this.stopMove = undefined;
    if (this.heading === to) this.heading = undefined;
    this.regionChange("end", "update");
  }

  /** Changes the scale keeping the point at (x, y) of the map where it is. */
  private zoomAt(x: number, y: number, scale: number): void {
    const point = this.fromScreen(x, y);
    this.camera.scale = this.clampScale(scale);
    const angle = (this.camera.rotate * Math.PI) / 180;
    const origin = this.origin();
    const sx = x - origin.x;
    const sy = y - origin.y;
    const at = project(point, this.camera.scale);
    this.camera.center = unproject(
      at.x - (sx * Math.cos(angle) - sy * Math.sin(angle)),
      at.y - (sx * Math.sin(angle) + sy * Math.cos(angle)),
      this.camera.scale,
    );
    this.draw();
  }

  private trackGestures(): void {
    let start: { x: number; y: number } | undefined;
    let dragging = false;
    trackDrag(this, {
      start: (event) => {
        if (!event.composedPath().includes(this.surface)) return false;
        if (!this.flagOption("enable-scroll", true)) return false;
        this.stopMove?.();
        start = project(this.camera.center, this.camera.scale);
        dragging = false;
      },
      move: (dx, dy) => {
        if (!start) return;
        if (!dragging) {
          dragging = true;
          this.regionChange("begin", "gesture");
        }
        const angle = (this.camera.rotate * Math.PI) / 180;
        this.camera.center = unproject(
          start.x - (dx * Math.cos(angle) - dy * Math.sin(angle)),
          start.y - (dx * Math.sin(angle) + dy * Math.cos(angle)),
          this.camera.scale,
        );
        this.draw();
      },
      end: () => {
        start = undefined;
        if (!dragging) return;
        dragging = false;
        this.regionChange("end", "drag");
      },
    });
  }

  private pointerOf(event: MouseEvent): { x: number; y: number } {
    const rect = this.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private onWheel(event: WheelEvent): void {
    if (!this.flagOption("enable-zoom", true)) return;
    event.preventDefault();
    if (!event.deltaY) return;
    this.stopMove?.();
    if (this.wheel) clearTimeout(this.wheel.timer);
    else this.regionChange("begin", "gesture");
    const { x, y } = this.pointerOf(event);
    const delta = event.deltaMode === 1 ? event.deltaY * 30 : event.deltaY;
    this.zoomAt(x, y, this.camera.scale - clamp(delta, -300, 300) / 200);
    this.wheel = {
      timer: setTimeout(() => {
        this.wheel = undefined;
        this.regionChange("end", "scale");
      }, WHEEL_END_MS),
    };
  }

  private onDoubleClick(event: MouseEvent): void {
    if (!this.flagOption("enable-zoom", true)) return;
    if (this.overlayOf(event)) return;
    this.stopMove?.();
    const { x, y } = this.pointerOf(event);
    const from = this.camera.scale;
    const to = this.clampScale(Math.round(from) + 1);
    if (to === from) return;
    this.regionChange("begin", "gesture");
    const zoom = tween(MOVE_MS, (t) => this.zoomAt(x, y, lerp(from, to, t)));
    this.stopMove = zoom.cancel;
    void zoom.promise.then(() => this.regionChange("end", "scale"));
  }

  // Taps

  /** The overlay part a click hit: a marker, callout, label, control or polyline. */
  private overlayOf(event: Event): HTMLElement | SVGElement | undefined {
    for (const node of event.composedPath()) {
      if (node === this.surface) return undefined;
      if ((node instanceof HTMLElement || node instanceof SVGElement) && node.dataset.part) {
        return node;
      }
    }
    return undefined;
  }

  private onClick(event: MouseEvent): void {
    const part = this.overlayOf(event);
    if (!part) {
      // A tap on the map closes the open callout; the view raises the tap with omrTapDetail
      if (this.openCallout !== undefined) {
        this.openCallout = undefined;
        this.draw();
      }
      return;
    }
    // A tap on an overlay raises its own event instead of the map's tap
    event.stopPropagation();
    const key = part.dataset.key ?? "";
    const view = this.markerViews.find((candidate) => candidate.key === key);
    switch (part.dataset.part) {
      case "marker":
        if (view?.calloutDisplay === "BYCLICK") this.openCallout = key;
        else this.openCallout = undefined;
        this.draw();
        emit(this, "markertap", { markerId: view?.id });
        break;
      case "callout":
        emit(this, "callouttap", { markerId: view?.id });
        break;
      case "label":
        emit(this, "labeltap", { markerId: view?.id });
        break;
      case "control": {
        const control = listOf(this.props.controls)[Number(part.dataset.index)];
        emit(this, "controltap", { controlId: control?.id });
        break;
      }
      case "polyline": {
        const { x, y } = this.pointerOf(event);
        emit(this, "polylinetap", { ...rounded(this.fromScreen(x, y)) });
        break;
      }
    }
  }

  /** The detail of the map's `tap`: where on the map it was, since base library 2.9.0. */
  omrTapDetail(event: MouseEvent): Record<string, unknown> {
    const { x, y } = this.pointerOf(event);
    return { ...rounded(this.fromScreen(x, y)) };
  }

  // Markers

  private resolve(src: string): string {
    return this.omrResolveAsset ? this.omrResolveAsset(src) : src;
  }

  /** The markers on the map: the attribute's, less those removed, with those the context added. */
  private markers(): { key: string; marker: Options }[] {
    const byKey = new Map<string, Options>();
    if (!this.clearedAttribute) {
      for (const marker of listOf(this.props.markers)) {
        const key = keyOf(marker.id);
        if (!this.removed.has(key)) byKey.set(key, marker);
      }
    }
    for (const [key, marker] of this.addedMarkers) byKey.set(key, marker);
    return [...byKey].map(([key, marker]) => ({ key, marker }));
  }

  private markerIdOf(value: string | null): unknown {
    const view = this.markerViews.find((candidate) => candidate.key === value);
    if (view) return view.id;
    const number = Number(value);
    return value !== null && value !== "" && Number.isFinite(number) ? number : value;
  }

  private buildMarkers(): void {
    this.markerLayer.replaceChildren();
    this.calloutLayer.replaceChildren();
    this.markerViews = this.markers().map(({ key, marker }) => {
      const box = div("marker");
      box.dataset.part = "marker";
      box.dataset.key = key;
      const view: MarkerView = { key, id: marker.id, marker, box };
      const iconPath = toText(marker.iconPath ?? "").trim();
      if (iconPath) {
        const img = document.createElement("img");
        img.alt = "";
        img.draggable = false;
        img.addEventListener("load", () => {
          view.natural = { width: img.naturalWidth, height: img.naturalHeight };
          this.draw();
        });
        img.src = this.resolve(iconPath);
        box.append(img);
      } else {
        box.innerHTML = PIN;
      }
      const label = this.bubble(marker.label, "label", key);
      if (label) view.label = label;
      // customCallout replaces callout, which replaces title
      if (isObject(marker.customCallout)) {
        view.calloutDisplay = toText(marker.customCallout.display || "BYCLICK").toUpperCase();
      } else if (isObject(marker.callout) && toText(marker.callout.content ?? "") !== "") {
        view.callout = this.bubble(marker.callout, "callout", key);
        view.calloutDisplay = toText(marker.callout.display || "BYCLICK").toUpperCase();
      } else if (toText(marker.title ?? "") !== "") {
        view.callout = this.bubble(
          { content: marker.title, padding: 6, borderRadius: 4, fontSize: 13 },
          "callout",
          key,
        );
        view.calloutDisplay = "BYCLICK";
      }
      this.markerLayer.append(box);
      if (view.label) this.markerLayer.append(view.label);
      if (view.callout) this.calloutLayer.append(view.callout);
      return view;
    });
  }

  /** A callout or label from its documented fields. */
  private bubble(value: unknown, part: "callout" | "label", key: string): HTMLElement | undefined {
    if (!isObject(value)) return undefined;
    const content = toText(value.content ?? "");
    if (content === "") return undefined;
    const el = div(part);
    el.dataset.part = part;
    el.dataset.key = key;
    el.textContent = content;
    const background = toText(value.bgColor ?? "") || (part === "callout" ? "#ffffff" : "");
    el.style.setProperty("--bg", background || "transparent");
    el.style.background = background || "transparent";
    el.style.color = toText(value.color ?? "") || "#000000";
    el.style.fontSize = `${numberOf(value.fontSize, 14)}px`;
    el.style.padding = `${numberOf(value.padding, part === "callout" ? 4 : 0)}px`;
    el.style.borderRadius = `${numberOf(value.borderRadius, part === "callout" ? 4 : 0)}px`;
    const border = numberOf(value.borderWidth, 0);
    if (border > 0) {
      el.style.border = `${border}px solid`;
      el.style.borderColor = toText(value.borderColor ?? "") || "#000000";
    }
    el.style.textAlign = toText(value.textAlign ?? "") || "center";
    if (part === "callout") el.style.boxShadow = background ? "" : "none";
    return el;
  }

  /** Where a marker is now and how it is turned. */
  private placeOf(view: MarkerView): { latitude: number; longitude: number; rotate: number } {
    const moved = this.moved.get(view.key);
    if (moved) return moved;
    return {
      latitude: numberOf(view.marker.latitude, 0),
      longitude: numberOf(view.marker.longitude, 0),
      rotate: numberOf(view.marker.rotate, 0),
    };
  }

  /** The icon's size: its width and height, else its image's size, else the default pin's. */
  private iconSize(view: MarkerView): { width: number; height: number } {
    const { marker } = view;
    const fallback = toText(marker.iconPath ?? "").trim()
      ? (view.natural ?? { width: 0, height: 0 })
      : { width: PIN_WIDTH, height: PIN_HEIGHT };
    let width = lengthOf(marker.width, Number.NaN);
    let height = lengthOf(marker.height, Number.NaN);
    // One side keeps the image's proportions
    if (Number.isFinite(width) && !Number.isFinite(height) && fallback.width) {
      height = (width * fallback.height) / fallback.width;
    } else if (Number.isFinite(height) && !Number.isFinite(width) && fallback.height) {
      width = (height * fallback.width) / fallback.height;
    }
    return {
      width: Number.isFinite(width) ? width : fallback.width,
      height: Number.isFinite(height) ? height : fallback.height,
    };
  }

  /** The bottom center of a marker's callout: above its icon, moved by anchorX and anchorY. */
  private calloutPoint(view: MarkerView, callout: Options): { x: number; y: number } {
    const at = this.toScreen(this.placeOf(view));
    const { width, height } = this.iconSize(view);
    const anchor = isObject(view.marker.anchor) ? view.marker.anchor : {};
    const left = at.x - numberOf(anchor.x, 0.5) * width;
    const top = at.y - numberOf(anchor.y, 1) * height;
    return {
      x: left + width / 2 + numberOf(callout.anchorX, 0),
      y: top + numberOf(callout.anchorY, 0),
    };
  }

  private drawMarkers(): void {
    for (const view of this.markerViews) {
      const { marker, box } = view;
      const place = this.placeOf(view);
      const at = this.toScreen(place);
      const { width, height } = this.iconSize(view);
      const anchor = isObject(marker.anchor) ? marker.anchor : {};
      const ax = numberOf(anchor.x, 0.5);
      const ay = numberOf(anchor.y, 1);
      const zIndex = String(Math.round(numberOf(marker.zIndex, 0)));
      box.style.left = `${at.x - ax * width}px`;
      box.style.top = `${at.y - ay * height}px`;
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
      box.style.zIndex = zIndex;
      box.style.opacity = String(clamp(numberOf(marker.alpha, 1), 0, 1));
      box.style.transformOrigin = `${ax * 100}% ${ay * 100}%`;
      box.style.transform = place.rotate ? `rotate(${place.rotate}deg)` : "";
      const ariaLabel = toText(marker["aria-label"] ?? marker.ariaLabel ?? "");
      if (ariaLabel) box.setAttribute("aria-label", ariaLabel);
      if (view.label) {
        const label = marker.label as Options;
        view.label.style.left = `${at.x + numberOf(label.anchorX ?? label.x, 0)}px`;
        view.label.style.top = `${at.y + numberOf(label.anchorY ?? label.y, 0)}px`;
        view.label.style.zIndex = zIndex;
      }
      if (view.callout) {
        const callout = isObject(marker.callout) ? marker.callout : {};
        const point = this.calloutPoint(view, callout);
        view.callout.style.left = `${point.x}px`;
        view.callout.style.top = `${point.y}px`;
        view.callout.hidden = !this.calloutShown(view);
      }
    }
  }

  private calloutShown(view: MarkerView): boolean {
    return view.calloutDisplay === "ALWAYS" || this.openCallout === view.key;
  }

  /**
   * Places the `<cover-view marker-id>` children of `<cover-view slot="callout">`
   * above their markers. They are the page's elements, so a stylesheet of this
   * map places them instead of their own style attribute.
   */
  private drawCustomCallouts(): void {
    if (!this.customStyle) return;
    const scope = `wx-map[omr-map="${this.mapId}"] > [slot="callout"] > [marker-id=`;
    const rules: string[] = [];
    for (const slot of this.children) {
      if (slot.getAttribute("slot") !== "callout") continue;
      for (const el of slot.children) {
        const key = el.getAttribute("marker-id");
        if (key === null) continue;
        const selector = `${scope}${JSON.stringify(key)}]`;
        const view = this.markerViews.find((candidate) => candidate.key === key);
        const custom =
          view && isObject(view.marker.customCallout) ? view.marker.customCallout : undefined;
        if (!view || !custom || !this.calloutShown(view)) {
          rules.push(`${selector} { display: none !important; }`);
          continue;
        }
        const { x, y } = this.calloutPoint(view, custom);
        rules.push(
          `${selector} { position: absolute !important; left: ${x}px !important; top: ${y}px !important; transform: translate(-50%, -100%) !important; pointer-events: auto !important; }`,
        );
      }
    }
    const css = rules.join("\n");
    if (this.customStyle.textContent !== css) this.customStyle.textContent = css;
  }

  // Controls

  private buildControls(): void {
    this.controlLayer.replaceChildren(
      ...listOf(this.props.controls).map((control, index) => {
        const el = div(`control${control.clickable ? " clickable" : ""}`);
        el.dataset.part = "control";
        el.dataset.index = String(index);
        const position = isObject(control.position) ? control.position : {};
        el.style.left = `${numberOf(position.left, 0)}px`;
        el.style.top = `${numberOf(position.top, 0)}px`;
        if (position.width !== undefined) el.style.width = `${numberOf(position.width, 0)}px`;
        if (position.height !== undefined) el.style.height = `${numberOf(position.height, 0)}px`;
        const iconPath = toText(control.iconPath ?? "").trim();
        if (iconPath) {
          const img = document.createElement("img");
          img.alt = "";
          img.draggable = false;
          img.src = this.resolve(iconPath);
          el.append(img);
        }
        return el;
      }),
    );
  }

  // Drawing

  /** Redraws the map for where it is now. */
  private draw(): void {
    this.drawGrid();
    this.drawShapes();
    this.drawMarkers();
    this.drawUi();
    this.drawCustomCallouts();
  }

  /** Lines of latitude and longitude, spaced for the scale. */
  private drawGrid(): void {
    const { width, height } = this.size();
    const degreesPerPixel = 360 / (MAP_TILE * 2 ** this.camera.scale);
    const step =
      [...GRID_STEPS].reverse().find((candidate) => candidate / degreesPerPixel >= GRID_SPACING) ??
      GRID_STEPS[0]!;
    const { southwest, northeast } = this.region();
    const lines: SVGElement[] = [];
    const line = (a: LatLng, b: LatLng) => {
      const from = this.toScreen(a);
      const to = this.toScreen(b);
      lines.push(svg("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y }));
    };
    const pad = step;
    const [south, north] = [southwest.latitude - pad, northeast.latitude + pad];
    const [west, east] = [southwest.longitude - pad, northeast.longitude + pad];
    if (east > west && (east - west) / step < 400) {
      for (let lng = Math.ceil(west / step) * step; lng <= east; lng += step) {
        line({ latitude: south, longitude: lng }, { latitude: north, longitude: lng });
      }
    }
    if ((north - south) / step < 400) {
      for (let lat = Math.ceil(south / step) * step; lat <= north; lat += step) {
        if (Math.abs(lat) > 85) continue;
        line({ latitude: lat, longitude: west }, { latitude: lat, longitude: east });
      }
    }
    this.grid.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.grid.replaceChildren(...lines);
  }

  private path(points: LatLng[]): { d: string; screen: { x: number; y: number }[] } {
    const screen = points.map((point) => this.toScreen(point));
    const d = screen.map(
      ({ x, y }, index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`,
    );
    return { d: d.join(" "), screen };
  }

  private drawShapes(): void {
    const { width, height } = this.size();
    const shapes: SVGElement[] = [];
    const polygons = listOf(this.props.polygons)
      .map((polygon, index) => ({ polygon, index }))
      .sort(
        (a, b) =>
          numberOf(a.polygon.zIndex, 0) - numberOf(b.polygon.zIndex, 0) || a.index - b.index,
      );
    for (const { polygon } of polygons) {
      const points = pointsOf(polygon.points);
      if (points.length < 3) continue;
      const strokeWidth = numberOf(polygon.strokeWidth, 1);
      const dash = Array.isArray(polygon.dashArray) ? polygon.dashArray.map(Number) : [];
      shapes.push(
        svg("path", {
          d: `${this.path(points).d} Z`,
          fill: toText(polygon.fillColor ?? "") || "none",
          stroke: strokeWidth > 0 ? toText(polygon.strokeColor ?? "") || "#000000" : "none",
          "stroke-width": strokeWidth,
          "stroke-linejoin": "round",
          ...(dash.length === 2 && dash.every((n) => n > 0)
            ? { "stroke-dasharray": dash.join(" ") }
            : {}),
        }),
      );
    }
    for (const circle of listOf(this.props.circles)) {
      const center = pointOf(circle);
      if (!center) continue;
      const at = this.toScreen(center);
      const radius =
        numberOf(circle.radius, 0) / metersPerPixel(center.latitude, this.camera.scale);
      const strokeWidth = numberOf(circle.strokeWidth, 1);
      shapes.push(
        svg("circle", {
          cx: at.x,
          cy: at.y,
          r: Math.max(0, radius),
          fill: toText(circle.fillColor ?? "") || "none",
          stroke: strokeWidth > 0 ? toText(circle.color ?? "") || "#000000" : "none",
          "stroke-width": strokeWidth,
        }),
      );
    }
    for (const [index, polyline] of listOf(this.props.polyline).entries()) {
      const points = pointsOf(polyline.points);
      if (points.length < 2) continue;
      const { d, screen } = this.path(points);
      const lineWidth = Math.max(1, numberOf(polyline.width, 2));
      const color = toText(polyline.color ?? "") || "#000000";
      const dash: Record<string, string> = polyline.dottedLine
        ? { "stroke-dasharray": `${lineWidth * 2} ${lineWidth * 1.5}` }
        : {};
      const lineStyle = { fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
      const borderWidth = numberOf(polyline.borderWidth, 0);
      if (borderWidth > 0) {
        shapes.push(
          svg("path", {
            d,
            ...lineStyle,
            stroke: toText(polyline.borderColor ?? "") || "#000000",
            "stroke-width": lineWidth + 2 * borderWidth,
            ...dash,
          }),
        );
      }
      const colors = Array.isArray(polyline.colorList)
        ? polyline.colorList.map((c) => toText(c))
        : [];
      if (colors.length > 0) {
        // A rainbow line: each segment its color, the last color for the rest
        for (let i = 1; i < screen.length; i++) {
          const a = screen[i - 1]!;
          const b = screen[i]!;
          shapes.push(
            svg("path", {
              d: `M${a.x} ${a.y} L${b.x} ${b.y}`,
              ...lineStyle,
              stroke: colors[Math.min(i - 1, colors.length - 1)]!,
              "stroke-width": lineWidth,
              ...dash,
            }),
          );
        }
      } else {
        shapes.push(
          svg("path", { d, ...lineStyle, stroke: color, "stroke-width": lineWidth, ...dash }),
        );
      }
      if (polyline.arrowLine) shapes.push(...this.arrows(screen, lineWidth));
      const hit = svg("path", {
        d,
        class: "hit",
        fill: "none",
        stroke: "transparent",
        "stroke-width": Math.max(lineWidth + 6, 12),
      });
      hit.dataset.part = "polyline";
      hit.dataset.index = String(index);
      shapes.push(hit);
    }
    this.shapes.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.shapes.replaceChildren(...shapes);
  }

  /** White chevrons along a line, pointing the way it goes. */
  private arrows(screen: { x: number; y: number }[], lineWidth: number): SVGElement[] {
    const spacing = Math.max(36, lineWidth * 6);
    const size = Math.max(3, lineWidth * 0.6);
    const arrows: SVGElement[] = [];
    let next = spacing / 2;
    let walked = 0;
    for (let i = 1; i < screen.length && arrows.length < 500; i++) {
      const a = screen[i - 1]!;
      const b = screen[i]!;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      while (next <= walked + length && arrows.length < 500) {
        const t = (next - walked) / length;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        arrows.push(
          svg("path", {
            d: `M${-size / 2} ${-size} L${size / 2} 0 L${-size / 2} ${size}`,
            transform: `translate(${x} ${y}) rotate(${angle})`,
            fill: "none",
            stroke: "#ffffff",
            "stroke-width": Math.max(1.2, lineWidth / 4),
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
          }),
        );
        next += spacing;
      }
      walked += length;
    }
    return arrows;
  }

  /** The location dot, compass, scale bar and watermark. */
  private drawUi(): void {
    const parts: HTMLElement[] = [];
    if (this.flagOption("show-location", false)) {
      const at = this.toScreen(mapLocation);
      const location = div("location");
      location.style.left = `${at.x}px`;
      location.style.top = `${at.y}px`;
      if (this.locationIcon) {
        const img = document.createElement("img");
        img.alt = "";
        img.src = this.locationIcon;
        location.append(img);
      } else {
        location.append(div("halo"), div("dot"));
      }
      parts.push(location);
    }
    if (this.flagOption("show-compass", false)) {
      const compass = div("compass");
      compass.innerHTML =
        '<svg viewBox="0 0 32 32"><g><path d="M16 4l4.5 12h-9z" fill="#f04b3e"/><path d="M16 28l-4.5-12h9z" fill="#9aa0a6"/></g></svg>';
      compass.querySelector("g")!.setAttribute("transform", `rotate(${-this.camera.rotate} 16 16)`);
      parts.push(compass);
    }
    if (this.flagOption("show-scale", false)) {
      const level = clamp(Math.round(this.camera.scale), MIN_SCALE, MAX_SCALE);
      const meters = SCALE_BAR_METERS[level - MIN_SCALE]!;
      const pixels = meters / metersPerPixel(this.camera.center.latitude, this.camera.scale);
      const scale = div("scalebar");
      const text = div("text");
      text.textContent = meters >= 1000 ? `${meters / 1000}公里` : `${meters}米`;
      const bar = div("bar");
      bar.style.width = `${Math.round(pixels)}px`;
      scale.append(text, bar);
      parts.push(scale);
    }
    const watermark = div("watermark");
    watermark.textContent = "模拟地图";
    parts.push(watermark);
    this.ui.replaceChildren(...parts);
  }

  // MapContext

  omrCall(
    method: string,
    args: unknown[],
  ): Record<string, unknown> | Promise<Record<string, unknown>> {
    const options = isObject(args[0]) ? args[0] : {};
    switch (method) {
      case "getCenterLocation":
        return { ...rounded(this.camera.center) };
      case "getScale":
        return { scale: this.camera.scale };
      case "getRotate":
        return { rotate: this.camera.rotate };
      case "getSkew":
        return { skew: this.camera.skew };
      case "getRegion":
        return this.region();
      case "moveToLocation": {
        // Without a point, the map moves to the user's location
        const center =
          options.latitude === undefined && options.longitude === undefined
            ? mapLocation
            : requirePoint(options);
        return this.moveTo({ center }).then(() => ({}));
      }
      case "includePoints": {
        if (!Array.isArray(options.points) || options.points.length === 0) {
          throw new Error("parameter error: points should not be empty");
        }
        const points = options.points.map((point) => requirePoint(point));
        const padding = Array.isArray(options.padding)
          ? options.padding.map((n) => numberOf(n, 0))
          : [];
        return this.moveTo(this.fit(points, padding)).then(() => ({}));
      }
      case "toScreenLocation": {
        const { x, y } = this.toScreen(requirePoint(options));
        return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
      }
      case "fromScreenLocation": {
        const x = numberOf(options.x, Number.NaN);
        const y = numberOf(options.y, Number.NaN);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error("parameter error: x and y should be Number");
        }
        return { ...rounded(this.fromScreen(x, y)) };
      }
      case "translateMarker":
        return this.translateMarker(options);
      case "moveAlong":
        return this.moveAlong(options);
      case "addMarkers": {
        if (!Array.isArray(options.markers))
          throw new Error("parameter error: markers should be Array");
        if (options.clear) {
          this.addedMarkers.clear();
          this.clearedAttribute = true;
          // Every marker shown is gone, and so are its animations
          for (const stop of this.markerAnimations.values()) stop();
          this.markerAnimations.clear();
          this.moved.clear();
        }
        for (const marker of listOf(options.markers)) {
          const key = keyOf(marker.id);
          // A replaced marker stops where its old one was going
          this.markerAnimations.get(key)?.();
          this.markerAnimations.delete(key);
          this.addedMarkers.set(key, marker);
          this.moved.delete(key);
        }
        this.redrawMarkers();
        return {};
      }
      case "removeMarkers": {
        if (!Array.isArray(options.markerIds)) {
          throw new Error("parameter error: markerIds should be Array");
        }
        for (const id of options.markerIds) {
          const key = keyOf(id);
          this.addedMarkers.delete(key);
          this.removed.add(key);
          this.markerAnimations.get(key)?.();
        }
        this.redrawMarkers();
        return {};
      }
      case "setCenterOffset": {
        const offset = Array.isArray(options.offset) ? options.offset.map(Number) : [];
        if (offset.length !== 2 || !offset.every(Number.isFinite)) {
          throw new Error("parameter error: offset should be Array of two Numbers");
        }
        this.offset = offset.map((value) => clamp(value, 0.25, 0.75));
        this.draw();
        return {};
      }
      case "setLocMarkerIcon": {
        const iconPath = toText(options.iconPath ?? "").trim();
        this.locationIcon = iconPath ? this.resolve(iconPath) : undefined;
        this.draw();
        return {};
      }
      default:
        // Layers, arcs, clusters, boundaries and openMapApp change nothing the simulator draws
        return {};
    }
  }

  private redrawMarkers(): void {
    this.buildMarkers();
    this.draw();
    this.scheduleUpdated();
  }

  private markerView(id: unknown): MarkerView {
    const view = this.markerViews.find((candidate) => candidate.key === keyOf(id));
    if (!view) throw new Error(`marker ${toText(id)} not found`);
    return view;
  }

  /** The bearing from one point to another on the map, in degrees clockwise from north. */
  private bearing(from: LatLng, to: LatLng): number {
    const a = project(from, 0);
    const b = project(to, 0);
    return ((Math.atan2(b.x - a.x, a.y - b.y) * 180) / Math.PI + 360) % 360;
  }

  /** Runs a marker animation, stopping the one it had; resolves whether it ran to its end. */
  private async animateMarker(
    view: MarkerView,
    duration: number,
    step: (t: number) => { latitude: number; longitude: number; rotate: number },
  ): Promise<boolean> {
    this.markerAnimations.get(view.key)?.();
    let ended = false;
    const move = tween(
      Math.max(0, duration),
      (t) => {
        if (t >= 1) ended = true;
        this.moved.set(view.key, step(t));
        this.drawMarkers();
        this.drawCustomCallouts();
      },
      linear,
    );
    this.markerAnimations.set(view.key, move.cancel);
    await move.promise;
    if (this.markerAnimations.get(view.key) === move.cancel) this.markerAnimations.delete(view.key);
    return ended;
  }

  private async translateMarker(options: Options): Promise<Record<string, unknown>> {
    const destination = requirePoint(options.destination, "destination.");
    const view = this.markerView(options.markerId);
    const from = this.placeOf(view);
    const duration = numberOf(options.duration, 1000);
    const rotate = options.autoRotate
      ? this.bearing(from, destination)
      : numberOf(options.rotate, from.rotate);
    const start = project(from, 0);
    const end = project(destination, 0);
    const at = (t: number) => {
      const point = unproject(lerp(start.x, end.x, t), lerp(start.y, end.y, t), 0);
      return t >= 1 ? destination : point;
    };
    if (options.moveWithRotate || rotate === from.rotate) {
      await this.animateMarker(view, duration, (t) => ({
        ...at(t),
        rotate: lerpAngle(from.rotate, rotate, t),
      }));
    } else {
      // Turning and moving take the duration each, one after the other; a stopped turn does not move
      const turned = await this.animateMarker(view, duration, (t) => ({
        ...at(0),
        rotate: lerpAngle(from.rotate, rotate, t),
      }));
      if (turned) await this.animateMarker(view, duration, (t) => ({ ...at(t), rotate }));
    }
    return {};
  }

  private async moveAlong(options: Options): Promise<Record<string, unknown>> {
    if (!Array.isArray(options.path) || options.path.length === 0) {
      throw new Error("parameter error: path should not be empty");
    }
    const path = options.path.map((point) => requirePoint(point));
    const view = this.markerView(options.markerId);
    const autoRotate = options.autoRotate === undefined ? true : Boolean(options.autoRotate);
    const precision = numberOf(options.precision, 0);
    const projected = path.map((point) => project(point, 0));
    const lengths = projected.map((point, i) =>
      i === 0 ? 0 : Math.hypot(point.x - projected[i - 1]!.x, point.y - projected[i - 1]!.y),
    );
    const total = lengths.reduce((sum, length) => sum + length, 0);
    const metersOf = (distance: number, latitude: number) => distance * metersPerPixel(latitude, 0);
    let walkedMeters = 0;
    let nextReport = precision;
    let last = path[0]!;
    const rotateOf = (i: number) =>
      autoRotate && i > 0 ? this.bearing(path[i - 1]!, path[i]!) : this.placeOf(view).rotate;
    await this.animateMarker(view, numberOf(options.duration, 0), (t) => {
      let target = t * total;
      let i = 1;
      while (i < projected.length - 1 && target > lengths[i]!) {
        target -= lengths[i]!;
        i++;
      }
      const a = projected[Math.max(0, i - 1)]!;
      const b = projected[Math.min(i, projected.length - 1)]!;
      const segment = lengths[Math.min(i, lengths.length - 1)] || 1;
      const f = Math.min(1, target / segment);
      const point = t >= 1 ? path.at(-1)! : unproject(lerp(a.x, b.x, f), lerp(a.y, b.y, f), 0);
      if (precision > 0) {
        const from = project(last, 0);
        const to = project(point, 0);
        walkedMeters += metersOf(Math.hypot(to.x - from.x, to.y - from.y), point.latitude);
        while (walkedMeters >= nextReport && t < 1) {
          emit(this, "interpolatepoint", {
            markerId: view.id,
            ...rounded(point),
            animationStatus: "interpolating",
          });
          nextReport += precision;
        }
        if (t >= 1) {
          emit(this, "interpolatepoint", {
            markerId: view.id,
            ...rounded(point),
            animationStatus: "complete",
          });
        }
      }
      last = point;
      return { ...point, rotate: rotateOf(Math.min(i, path.length - 1)) };
    });
    return {};
  }
}
