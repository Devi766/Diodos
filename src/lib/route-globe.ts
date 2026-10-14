import type { RoutePoint } from '@/lib/route-trace';

export const rad = (degrees: number) => degrees * Math.PI / 180;
export type Vec3 = [number, number, number];
export const vector = (point: Pick<RoutePoint, 'lat' | 'lon'>): Vec3 => {
  const lat = rad(point.lat); const lon = rad(point.lon);
  return [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
};
export function greatCircle(a: Vec3, b: Vec3, t: number): Vec3 {
  const dot = Math.max(-1, Math.min(1, a.reduce((sum, value, i) => sum + value * b[i], 0)));
  const angle = Math.acos(dot);
  if (angle < 1e-5) return [...a];
  if (Math.PI - angle < 1e-5) {
    const axis: Vec3 = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const projection = a.reduce((sum, v, i) => sum + v * axis[i], 0);
    const tangent = axis.map((v, i) => v - projection * a[i]);
    const length = Math.hypot(...tangent);
    return a.map((v, i) => v * Math.cos(Math.PI * t) + tangent[i] / length * Math.sin(Math.PI * t)) as Vec3;
  }
  return a.map((v, i) => (v * Math.sin((1 - t) * angle) + b[i] * Math.sin(t * angle)) / Math.sin(angle)) as Vec3;
}

export function parseLandDots(buffer: ArrayBuffer): RoutePoint[] {
  const view = new DataView(buffer);
  if (buffer.byteLength < 4) throw new Error('invalid_land_data');
  const count = view.getInt32(0, false);
  if (count < 0 || count > 100_000 || buffer.byteLength !== 4 + count * 4) throw new Error('invalid_land_data');
  return Array.from({ length: count }, (_, i) => ({ lat: view.getInt16(4 + i * 4, false) / 100, lon: view.getInt16(6 + i * 4, false) / 100, label: '' }));
}
let landRequest: Promise<RoutePoint[]> | null = null;
export const loadLandDots = () => landRequest ?? (landRequest = fetch('/dashboard/globe-land-dots.bin').then(response => {
  if (!response.ok) throw new Error('land_data_unavailable');
  return response.arrayBuffer();
}).then(parseLandDots).catch(error => { landRequest = null; throw error; }));

export function cameraFor(points: RoutePoint[]) {
  if (!points.length) return { lat: 25, lon: 110, zoom: 1 };
  const sum = points.map(vector).reduce((a, b) => a.map((v, i) => v + b[i]) as Vec3, [0, 0, 0]);
  if (Math.hypot(...sum) < 1e-5) return { lat: 25, lon: 110, zoom: 0.95 };
  const lat = Math.atan2(sum[1], Math.hypot(sum[0], sum[2])) * 180 / Math.PI;
  const lon = Math.atan2(sum[0], sum[2]) * 180 / Math.PI;
  const center = vector({ lat, lon });
  const spread = Math.max(...points.map(p => Math.acos(Math.max(-1, Math.min(1, vector(p).reduce((s, v, i) => s + v * center[i], 0))))));
  return { lat, lon, zoom: Math.max(0.85, Math.min(1.7, 0.78 / Math.max(0.45, Math.sin(spread)))) };
}
