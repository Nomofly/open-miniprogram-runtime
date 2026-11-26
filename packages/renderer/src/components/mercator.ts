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

/**
 * The center and the largest scale that show every point inside a box of
 * `width` × `height` px less `padding` ([top, right, bottom, left]), with
 * `limit` keeping the scale in the map's range. Points in one place give no
 * scale, so the map keeps its own.
 */
export function fitPoints(
  points: LatLng[],
  width: number,
  height: number,
  padding: number[] = [],
  limit: (scale: number) => number = (scale) => scale,
): { center: LatLng; scale?: number } {
  const [top = 0, right = 0, bottom = 0, left = 0] = padding;
  const projected = points.map((point) => project(point, 0));
  const xs = projected.map((p) => p.x);
  const ys = projected.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const innerWidth = Math.max(1, width - left - right);
  const innerHeight = Math.max(1, height - top - bottom);
  const fit = Math.min(innerWidth / (maxX - minX), innerHeight / (maxY - minY));
  const scale = Number.isFinite(fit) && fit > 0 ? limit(Math.log2(fit)) : undefined;
  // The padding moves the points' center off the map's center by half its imbalance
  const zoom = 2 ** (scale ?? 0);
  const shiftX = scale === undefined ? 0 : (right - left) / 2 / zoom;
  const shiftY = scale === undefined ? 0 : (bottom - top) / 2 / zoom;
  return { center: unproject((minX + maxX) / 2 + shiftX, (minY + maxY) / 2 + shiftY, 0), scale };
}
