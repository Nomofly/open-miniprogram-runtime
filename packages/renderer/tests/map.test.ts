// @vitest-environment happy-dom
import { compileWxml, type WebviewBundle } from "@omr/compiler";
import type { ViewToLogic } from "@omr/runtime";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { defineBuiltins, type BuiltinElement } from "../src/builtins.ts";
import {
  fitPoints,
  MAP_TILE,
  metersPerPixel,
  project,
  unproject,
} from "../src/components/mercator.ts";
import { startView } from "../src/view.ts";

defineBuiltins();

/** A 300×150 map with an explicit size, as happy-dom has no layout. */
function mountMap(props: Record<string, unknown>): BuiltinElement {
  const el = document.createElement("wx-map") as BuiltinElement;
  el.style.width = "300px";
  el.style.height = "150px";
  el.omrUpdate(props);
  document.body.append(el);
  return el;
}

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function events(el: Element) {
  const fired: { name: string; detail: Record<string, unknown> }[] = [];
  el.addEventListener("omr-event", (event) => {
    const { name, detail } = (
      event as CustomEvent<{ name: string; detail: Record<string, unknown> }>
    ).detail;
    fired.push({ name, detail });
  });
  return fired;
}

const shadow = (el: Element) => el.shadowRoot!;
const markerBox = (el: Element, id: number | string) =>
  shadow(el).querySelector<HTMLElement>(`.marker[data-key="${id}"]`)!;

afterEach(() => {
  document.body.replaceChildren();
});

describe("Web Mercator", () => {
  test("lat 0, lng 0 is the center of the world; a point is where its longitude says", () => {
    expect(project({ latitude: 0, longitude: 0 }, 0)).toEqual({ x: 128, y: 128 });
    // At scale 1 the world is two tiles wide; 90° east is one tile east of the center
    const east = project({ latitude: 0, longitude: 90 }, 1);
    expect(east.x).toBeCloseTo(MAP_TILE * 1.5);
    expect(east.y).toBeCloseTo(MAP_TILE);
  });

  test("unproject inverts project", () => {
    const point = { latitude: 31.2304, longitude: 121.4737 };
    const { x, y } = project(point, 16);
    const back = unproject(x, y, 16);
    expect(back.latitude).toBeCloseTo(point.latitude, 9);
    expect(back.longitude).toBeCloseTo(point.longitude, 9);
  });

  test("points across the antimeridian fit around it, not around the world", () => {
    const { center, scale } = fitPoints(
      [
        { latitude: 0, longitude: 179.99 },
        { latitude: 0, longitude: -179.99 },
      ],
      300,
      150,
    );
    expect(Math.abs(center.longitude)).toBeGreaterThan(179.99);
    // 0.02° is about 0.014 px at scale 0; 300 px fit it at about scale 14
    expect(scale).toBeGreaterThan(13);
  });

  test("a rotated map fits the points along its own axes", () => {
    const points = [
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0.05 },
    ];
    // Turned a quarter, the east-west span runs down the 150 px height
    const upright = fitPoints(points, 300, 150).scale!;
    const turned = fitPoints(points, 300, 150, [], (scale) => scale, 90).scale!;
    expect(upright - turned).toBeCloseTo(1, 5);
  });

  test("a meter is wider in px away from the equator", () => {
    // About 156 km per px at the equator at scale 0; half that at 60°
    expect(metersPerPixel(0, 0)).toBeCloseTo(156543.03, 1);
    expect(metersPerPixel(60, 0)).toBeCloseTo(156543.03 / 2, 1);
  });
});

describe("<map>", () => {
  const CENTER = { latitude: 31.2304, longitude: 121.4737 };

  test("a circle's radius is its meters at the map's scale and latitude", () => {
    const map = mountMap({
      ...CENTER,
      scale: 16,
      circles: [{ ...CENTER, radius: 100, fillColor: "#ff000033" }],
    });
    const circle = shadow(map).querySelector("circle")!;
    const expected = 100 / metersPerPixel(CENTER.latitude, 16);
    expect(Number(circle.getAttribute("r"))).toBeCloseTo(expected, 3);
    expect(Number(circle.getAttribute("cx"))).toBeCloseTo(150, 3);
    expect(Number(circle.getAttribute("cy"))).toBeCloseTo(75, 3);
  });

  test("a marker sits on its point by its bottom center by default", () => {
    // 100 px east and 50 px south of the center at scale 16
    const center = project(CENTER, 16);
    const point = unproject(center.x + 100, center.y + 50, 16);
    const map = mountMap({
      ...CENTER,
      scale: 16,
      markers: [{ id: 7, ...point, width: 20, height: 30 }],
    });
    const box = markerBox(map, 7);
    expect(parseFloat(box.style.left)).toBeCloseTo(150 + 100 - 10, 3);
    expect(parseFloat(box.style.top)).toBeCloseTo(75 + 50 - 30, 3);
    expect(box.style.width).toBe("20px");
    expect(box.style.height).toBe("30px");
  });

  test("tapping a marker fires markertap and opens its BYCLICK callout only", async () => {
    const map = mountMap({
      ...CENTER,
      markers: [
        { id: 1, ...CENTER, callout: { content: "Shop A", display: "BYCLICK" } },
        { id: 2, ...CENTER, callout: { content: "Shop B", display: "ALWAYS" } },
      ],
    });
    const fired = events(map);
    const callout = (id: number) =>
      shadow(map).querySelector<HTMLElement>(`.callout[data-key="${id}"]`)!;
    expect(callout(1).hidden).toBe(true);
    expect(callout(2).hidden).toBe(false);
    markerBox(map, 1).click();
    expect(fired.filter((e) => e.name !== "updated")).toEqual([
      { name: "markertap", detail: { markerId: 1 } },
    ]);
    expect(callout(1).hidden).toBe(false);
    expect(callout(1).textContent).toBe("Shop A");
    callout(1).click();
    expect(fired.at(-1)).toEqual({ name: "callouttap", detail: { markerId: 1 } });
  });

  test("getCenterLocation answers where moveToLocation moved the map", async () => {
    const map = mountMap({ ...CENTER });
    const fired = events(map);
    await map.omrCall!("moveToLocation", [{ latitude: 22.5, longitude: 114.05 }]);
    expect(map.omrCall!("getCenterLocation", [{}])).toEqual({ latitude: 22.5, longitude: 114.05 });
    // The attributes did not change, so the next render keeps the map where it is
    map.omrUpdate({ ...CENTER });
    expect(map.omrCall!("getCenterLocation", [{}])).toEqual({ latitude: 22.5, longitude: 114.05 });
    expect(
      fired.filter((e) => e.name === "regionchange").map((e) => [e.detail.type, e.detail.causedBy]),
    ).toEqual([
      ["begin", "update"],
      ["end", "update"],
    ]);
    expect(() => map.omrCall!("moveToLocation", [{ latitude: "x", longitude: 1 }])).toThrow(
      "parameter error: latitude and longitude should be Number",
    );
  });

  test("include-points fits the points inside the map", async () => {
    const points = [
      { latitude: 31.25, longitude: 121.45 },
      { latitude: 31.2, longitude: 121.5 },
    ];
    const map = mountMap({ ...CENTER, scale: 5, "include-points": points });
    await settle(450);
    const { scale } = map.omrCall!("getScale", [{}]) as { scale: number };
    // The latitudes span 0.05°: 80 px of height less padding fits them at 10.9
    expect(scale).toBe(10);
    for (const point of points) {
      const { x, y } = map.omrCall!("toScreenLocation", [point]) as { x: number; y: number };
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(300);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(150);
    }
    // One more scale step would put a point outside
    const center = map.omrCall!("getCenterLocation", [{}]) as {
      latitude: number;
      longitude: number;
    };
    const a = project(points[0]!, scale + 1);
    const b = project(points[1]!, scale + 1);
    expect(Math.abs(a.x - b.x) > 300 - 60 || Math.abs(a.y - b.y) > 150 - 70).toBe(true);
    expect(center.latitude).toBeCloseTo(31.225, 1);
  });

  test("include-points with a new rotate in the same update fits the rotated map and keeps the rotate", async () => {
    const map = mountMap({ ...CENTER, scale: 5 });
    await settle();
    const points = [
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 0.05 },
    ];
    map.omrUpdate({ ...CENTER, scale: 5, rotate: 90, "include-points": points });
    await settle(450);
    expect(map.omrCall!("getRotate", [{}])).toEqual({ rotate: 90 });
    for (const point of points) {
      const { x, y } = map.omrCall!("toScreenLocation", [point]) as { x: number; y: number };
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(300);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(150);
    }
  });

  test("a translateMarker that takes over a turning marker is not undone by the first call's move", async () => {
    const center = project(CENTER, 16);
    const east = unproject(center.x + 100, center.y, 16);
    const west = unproject(center.x - 100, center.y, 16);
    const map = mountMap({
      ...CENTER,
      scale: 16,
      markers: [{ id: 1, ...CENTER, width: 20, height: 20 }],
    });
    // The first call turns, then moves east; the second moves west while turning
    const first = map.omrCall!("translateMarker", [
      { markerId: 1, destination: east, rotate: 90, duration: 50 },
    ]);
    await settle(10);
    const second = map.omrCall!("translateMarker", [
      { markerId: 1, destination: west, moveWithRotate: true, duration: 50 },
    ]);
    await Promise.all([first, second]);
    await settle(200);
    expect(parseFloat(markerBox(map, 1).style.left)).toBeCloseTo(150 - 100 - 10, 0);
  });

  test("addMarkers replacing a moving marker stops the old animation", async () => {
    const center = project(CENTER, 16);
    const east = unproject(center.x + 100, center.y, 16);
    const south = unproject(center.x, center.y + 40, 16);
    const map = mountMap({ ...CENTER, scale: 16 });
    void map.omrCall!("addMarkers", [{ markers: [{ id: 1, ...CENTER, width: 20, height: 20 }] }]);
    void map.omrCall!("translateMarker", [{ markerId: 1, destination: east, duration: 100 }]);
    await settle(20);
    void map.omrCall!("addMarkers", [{ markers: [{ id: 1, ...south, width: 20, height: 20 }] }]);
    await settle(250);
    const box = markerBox(map, 1);
    expect(parseFloat(box.style.left)).toBeCloseTo(150 - 10, 0);
    expect(parseFloat(box.style.top)).toBeCloseTo(75 + 40 - 20, 0);
  });

  test("a drag pans the map with regionchange begin (gesture) and end (drag)", () => {
    const map = mountMap({ ...CENTER, scale: 16 });
    const fired = events(map);
    const surface = shadow(map).querySelector(".surface")!;
    const pointer = (type: string, x: number, target: EventTarget = window) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          clientX: x,
          clientY: 50,
          bubbles: true,
          composed: true,
        }),
      );
    pointer("pointerdown", 100, surface);
    pointer("pointermove", 120);
    pointer("pointermove", 160);
    pointer("pointerup", 160);
    const changes = fired.filter((e) => e.name === "regionchange").map((e) => e.detail);
    expect(changes.map((d) => [d.type, d.causedBy])).toEqual([
      ["begin", "gesture"],
      ["end", "drag"],
    ]);
    // Dragging 60 px east moves the center 60 px west
    const before = project(CENTER, 16);
    const after = project(changes[1]!.centerLocation as typeof CENTER, 16);
    expect(after.x - before.x).toBeCloseTo(-60, 0);
    expect(changes[1]).toMatchObject({ scale: 16, rotate: 0, skew: 0 });
    expect(changes[1]!.region).toHaveProperty("southwest");
  });
});

describe("<map> in a page", () => {
  test("a tap on the map raises one tap with its coordinates; a marker raises markertap instead", async () => {
    const wxml = `<map id="m" latitude="31.2304" longitude="121.4737" style="width:300px;height:150px" markers="{{markers}}" bindtap="onTap" bindmarkertap="onMarker"></map>`;
    const files = { "pages/a/a.wxml": compileWxml(wxml, "pages/a/a.wxml") };
    const page = { path: "pages/a/a", template: "pages/a/a.wxml", usingComponents: {}, prefix: "" };
    const bundle = {
      route: "pages/a/a",
      page,
      components: {},
      files,
      wxs: {},
      css: "",
      window: {},
    };
    const posted: ViewToLogic[] = [];
    const handle = startView({
      bundle: JSON.parse(JSON.stringify(bundle)) as WebviewBundle,
      windowWidth: 375,
      assetBase: "/files/",
      styleV2: false,
      post: (message) => posted.push(message),
    });
    handle({
      type: "init",
      data: {
        markers: [{ id: 3, latitude: 31.2304, longitude: 121.4737, iconPath: "/img/pin.png" }],
      },
      seq: 1,
    });
    await settle();
    const map = document.querySelector("wx-map")!;
    const handlers = () =>
      posted.flatMap((message) =>
        message.type === "event" ? [{ handler: message.handler, event: message.event }] : [],
      );
    // The marker's iconPath resolves like the template's paths
    expect(shadow(map).querySelector<HTMLImageElement>(".marker img")!.getAttribute("src")).toBe(
      "/files/img/pin.png",
    );

    // A browser retargets a click in the map's shadow root to the map; happy-dom does not, so it is sent there
    map.dispatchEvent(
      new MouseEvent("click", { clientX: 150, clientY: 75, bubbles: true, composed: true }),
    );
    const taps = handlers().filter((entry) => entry.event.type === "tap");
    expect(taps).toHaveLength(1);
    expect(taps[0]!.handler).toBe("onTap");
    expect(taps[0]!.event.detail).toEqual({ latitude: 31.2304, longitude: 121.4737 });

    shadow(map).querySelector<HTMLElement>(".marker")!.click();
    expect(handlers().map((entry) => entry.handler)).toEqual(["onTap", "onMarker"]);
    expect(handlers()[1]!.event.detail).toEqual({ markerId: 3 });
  });
});
