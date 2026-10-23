// Point query against the plan snapshot. FlatGeobuf's spatial index means only the
// index and the few matching features are fetched (HTTP range requests).

const PLAN_URL = "data/nisar_plan.fgb";
const EPS = 1e-6;

export async function framesAt(lon, lat) {
  const rect = { minX: lon - EPS, minY: lat - EPS, maxX: lon + EPS, maxY: lat + EPS };
  const hits = [];
  for await (const f of flatgeobuf.deserialize(PLAN_URL, rect)) {
    if (containsPoint(f.geometry, lon, lat)) hits.push(f);
  }
  return hits;
}

function containsPoint(geom, x, y) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
  return polys.some((rings) => rings.reduce((inside, ring, i) => (inRing(ring, x, y) ? !inside : inside), false));
}

function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
