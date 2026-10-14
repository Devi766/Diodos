import fs from 'node:fs';
import { createHash } from 'node:crypto';

// Generate evenly spaced land samples from pinned public-domain map geometry.
const revision = 'ca96624a56bd078437bca8184e78163e5039ad19';
const source = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${revision}/geojson/ne_110m_land.geojson`;
let bytes;
if (process.argv[2]) bytes = fs.readFileSync(process.argv[2]);
else {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Map download failed: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
}
const features = JSON.parse(bytes).features;
const polygons = features.flatMap(feature => feature.geometry.type === 'MultiPolygon'
  ? feature.geometry.coordinates : feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : []);
const insideRing = (lon, lat, ring) => {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x, y] = ring[index], [px, py] = ring[previous];
    if ((y > lat) !== (py > lat) && lon < (px - x) * (lat - y) / (py - y) + x) inside = !inside;
  }
  return inside;
};
const land = (lon, lat) => polygons.some(polygon => insideRing(lon, lat, polygon[0])
  && !polygon.slice(1).some(hole => insideRing(lon, lat, hole)));
const points = [];
const step = 2.2;
for (let row = 0, lat = -90 + step / 2; lat < 90; row++, lat += step) {
  const columns = Math.max(1, Math.round(360 * Math.cos(lat * Math.PI / 180) / step));
  for (let column = 0; column < columns; column++) {
    const lon = -180 + (column + (row % 2 ? 0.5 : 0)) * 360 / columns;
    if (land(lon, lat)) points.push([lat, lon]);
  }
}
if (points.length < 2000 || points.length > 10000) throw new Error('Unexpected land point count');
const output = Buffer.alloc(4 + points.length * 4);
output.writeInt32BE(points.length, 0);
points.forEach(([lat, lon], index) => {
  output.writeInt16BE(Math.round(lat * 100), 4 + index * 4);
  output.writeInt16BE(Math.round(lon * 100), 6 + index * 4);
});
fs.writeFileSync('public/dashboard/globe-land-dots.bin', output);
console.log(JSON.stringify({ points: points.length, source, sourceSha256: createHash('sha256').update(bytes).digest('hex') }));
