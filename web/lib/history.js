// Past acquisitions and products of a frame, from the precomputed plan data
// (pipeline/granule_index.py, refreshed every 6 hours). No live catalog queries.

// Product types in display order
export const PRODUCTS = ["RSLC", "GSLC", "GCOV", "RIFG", "RUNW", "ROFF", "GUNW", "GOFF", "SME2"];

// "20261014T130823" or "20261014" -> Date (UTC)
const ts = (s) =>
  new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11) || 0, +s.slice(11, 13) || 0, +s.slice(13, 15) || 0));

// "20261014T130823 4005 DHDH F;..." -> [{start, mode, pol, fullFrame}], newest first
export function acquisitions(props) {
  if (!props.acq) return [];
  return props.acq.split(";").map((a) => {
    const [t, mode, pol, coverage] = a.split(" ");
    return { start: ts(t), mode, pol, fullFrame: coverage === "F" };
  });
}

// {product: [Date, ...]}: acquisitions that produced each product type, RSLC included
export function productDates(props, acq) {
  const out = { RSLC: acq.map((a) => a.start) };
  for (const [product, days] of Object.entries(JSON.parse(props.products || "{}"))) {
    out[product] = days.split(",").map(ts);
  }
  return out;
}

export const browseURL = (name) =>
  `https://nisar.asf.earthdatacloud.nasa.gov/BROWSE/NISAR_L1_RSLC_PROVISIONAL_V1/${name}/${name}_LATLON_thumbnail.png`;

// Vertex geographic search for this track/frame: lists every product type there
export function vertexLink(track, frame, lon, lat) {
  const p = new URLSearchParams({
    dataset: "NISAR",
    polygon: `POINT(${lon.toFixed(4)} ${lat.toFixed(4)})`,
    path: `${track}-${track}`,
    frame: `${frame}-${frame}`,
    searchType: "Geographic Search",
    resultsLoaded: "true",
  });
  return `https://search.asf.alaska.edu/#/?${p}`;
}
