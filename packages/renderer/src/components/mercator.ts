/** Web Mercator math of `<map>`: where a point is at a scale, as Tencent Maps and WeChat place it. */

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** The size of the world at scale 0, in px: each scale step doubles it. */
export const MAP_TILE = 256;
/** Web Mercator stops at the latitude that makes the world square. */
export const MAX_LATITUDE = 85.05112878;
/** The radius Web Mercator uses for the Earth, in meters. */
const EARTH_RADIUS = 6378137;

const clampLatitude = (latitude: number) =>
  Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, latitude));

/** Longitude in [-180, 180). */
export const wrapLongitude = (longitude: number) => ((((longitude + 180) % 360) + 360) % 360) - 180;

/** The pixel position of a point in the world at a scale; (0, 0) is the north-west corner. */
export function project({ latitude, longitude }: LatLng, scale: number): { x: number; y: number } {
  const size = MAP_TILE * 2 ** scale;
  const sin = Math.sin((clampLatitude(latitude) * Math.PI) / 180);
  return {
    x: ((longitude + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

/** The point at a pixel position in the world at a scale. */
export function unproject(x: number, y: number, scale: number): LatLng {
  const size = MAP_TILE * 2 ** scale;
  const n = Math.PI - (2 * Math.PI * y) / size;
  return {
    latitude: (180 / Math.PI) * Math.atan(Math.sinh(n)),
    longitude: wrapLongitude((x / size) * 360 - 180),
  };
}

/** How many meters one pixel covers at a latitude and scale. */
export function metersPerPixel(latitude: number, scale: number): number {
  const circumference = 2 * Math.PI * EARTH_RADIUS;
  return (
    (circumference * Math.cos((clampLatitude(latitude) * Math.PI) / 180)) / (MAP_TILE * 2 ** scale)
  );
}

/** How `fitPoints` lays the points out on the map. */
export interface FitOptions {
  /** Kept free at the edges, in px: [top, right, bottom, left]. */
  padding?: number[];
  /** Keeps a scale in the map's range. */
  limit?: (scale: number) => number;
  /** The map's rotation in degrees, whose screen axes the box follows. */
  rotate?: number;
  /** Where the map's center is drawn, in px from its top left; the middle by default. */
  origin?: { x: number; y: number };
  /** The map's scale, kept when the points are in one place. */
  scale?: number;
}

/**
 * The center and the largest scale that show every point inside a box of
 * `width` × `height` px less the padding, centered in what the padding leaves.
 * Points spread across the antimeridian use their nearby copies. Points in one
 * place give no scale, so the map keeps its own.
 */
export function fitPoints(
  points: LatLng[],
  width: number,
  height: number,
  {
    padding = [],
    limit = (scale) => scale,
    rotate = 0,
    origin = { x: width / 2, y: height / 2 },
    scale: current = 0,
  }: FitOptions = {},
): { center: LatLng; scale?: number } {
  const [top = 0, right = 0, bottom = 0, left = 0] = padding;
  const projected = points.map((point) => project(point, 0));
  // Cut the world at the widest gap between the points, so they lie in the shortest interval
  const sorted = projected.map((p) => p.x).sort((a, b) => a - b);
  let cut = sorted[0]!;
  let widest = sorted[0]! + MAP_TILE - sorted.at(-1)!;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]! - sorted[i - 1]!;
    if (gap > widest) [widest, cut] = [gap, sorted[i]!];
  }
  const angle = (rotate * Math.PI) / 180;
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  // In the screen's axes, as the map draws a point at its rotation
  const screen = projected.map(({ x, y }) => {
    const wx = x < cut ? x + MAP_TILE : x;
    return { u: wx * cos + y * sin, v: -wx * sin + y * cos };
  });
  const us = screen.map((p) => p.u);
  const vs = screen.map((p) => p.v);
  const [minU, maxU, minV, maxV] = [
    Math.min(...us),
    Math.max(...us),
    Math.min(...vs),
    Math.max(...vs),
  ];
  const innerWidth = Math.max(1, width - left - right);
  const innerHeight = Math.max(1, height - top - bottom);
  const fit = Math.min(innerWidth / (maxU - minU), innerHeight / (maxV - minV));
  const scale = Number.isFinite(fit) && fit > 0 ? limit(Math.log2(fit)) : undefined;
  // The points' middle goes to the middle of the padded box, which lies off the drawn center
  const zoom = 2 ** (scale ?? current);
  const u = (minU + maxU) / 2 - (left + innerWidth / 2 - origin.x) / zoom;
  const v = (minV + maxV) / 2 - (top + innerHeight / 2 - origin.y) / zoom;
  return { center: unproject(u * cos - v * sin, u * sin + v * cos, 0), scale };
}
