// Point queries against the static FlatGeobuf files. The spatial index means only the
// index and the few matching features are fetched (HTTP range requests).

const EPS = 1e-6;

// Features of `url` whose polygon contains the point. Footprints crossing the antimeridian
// are stored with continuous longitudes (beyond +/-180), so the point is also tried +/-360.
export async function featuresAt(url, lon, lat) {
  const hits = [];
  for (const x of [lon, lon + 360, lon - 360]) {
    const rect = { minX: x - EPS, minY: lat - EPS, maxX: x + EPS, maxY: lat + EPS };
    for await (const f of flatgeobuf.deserialize(url, rect)) {
      if (containsPoint(f.geometry, x, lat)) hits.push(f);
    }
  }
  return hits;
}

export const framesAt = (lon, lat) => featuresAt("data/nisar_plan.fgb", lon, lat);

function containsPoint(geom, x, y) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
  return polys.some((rings) => rings.reduce((inside, ring) => (inRing(ring, x, y) ? !inside : inside), false));
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
