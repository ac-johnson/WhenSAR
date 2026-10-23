// Past acquisitions and products of one frame, from CMR (public, CORS-enabled, ~1 s).
// Everything needed is encoded in the granule name.

const CMR_XML = "https://cmr.earthdata.nasa.gov/search/granules.xml";
const RSLC = "C2853145197-ASF"; // NISAR_L1_RSLC_PROVISIONAL_V1

// *_PROVISIONAL_V1 collections, in display order
export const PRODUCTS = {
  RSLC: "C2853145197-ASF",
  GSLC: "C2854332392-ASF",
  GCOV: "C2854338529-ASF",
  RIFG: "C2853147928-ASF",
  RUNW: "C2853153429-ASF",
  ROFF: "C2853156054-ASF",
  GUNW: "C2854335566-ASF",
  GOFF: "C2854341702-ASF",
  SME2: "C2854344945-ASF",
};

const NAME = new RegExp(
  "^NISAR_[LS]\\d_(PR|UR|OD)_[A-Z0-9]{4}_(\\d{3})_(\\d{3})_([AD])_(\\d{3})_(\\d{4})_([A-Z]{4})_[AM]" +
    "_(\\d{8}T\\d{6})_(\\d{8}T\\d{6})_([A-Z]\\d{5})_[A-Z]_([FP])_[A-Z]_(\\d{3})$"
);

const pad3 = (n) => String(n).padStart(3, "0");
const ts = (s) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);

export function parseName(name) {
  const m = NAME.exec(name);
  if (!m) return null;
  return {
    name,
    pipeline: m[1],
    cycle: +m[2],
    mode: m[6], // bandwidth code, e.g. 4005 = 40+5 MHz
    pol: m[7], // two chars per band, e.g. DHDH
    start: ts(m[8]),
    crid: m[10],
    fullFrame: m[11] === "F",
    counter: +m[12],
  };
}

// Reprocessing leaves several granules per acquisition: keep the highest CRID, then counter
function dedupe(granules) {
  const best = new Map();
  for (const g of granules) {
    const key = Math.round(g.start / 60e3);
    const cur = best.get(key);
    const newer = !cur || g.crid > cur.crid || (g.crid === cur.crid && g.counter > cur.counter);
    if (newer) best.set(key, g);
  }
  return [...best.values()].sort((a, b) => b.start - a.start);
}

// CMR's "references" XML is the smallest response (~270 bytes/granule) and the granule
// name is all we need.
async function cmrNames(collections, track, dir, frame, extra, signal) {
  const params = new URLSearchParams({
    "attribute[]": `string,STACK_ID,${pad3(track)}_${dir}_${pad3(frame)}`,
    page_size: "2000",
    sort_key: "-start_date",
    ...extra,
  });
  collections.forEach((c) => params.append("collection_concept_id", c));
  const r = await fetch(`${CMR_XML}?${params}`, { signal });
  if (!r.ok) throw new Error(`CMR ${r.status}`);
  const doc = new DOMParser().parseFromString(await r.text(), "application/xml");
  return [...doc.querySelectorAll("reference > name")].map((n) => n.textContent);
}

const browseURL = (name) =>
  `https://nisar.asf.earthdatacloud.nasa.gov/BROWSE/NISAR_L1_RSLC_PROVISIONAL_V1/${name}/${name}_LATLON_thumbnail.png`;

export async function frameHistory(track, dir, frame, signal) {
  const names = await cmrNames([RSLC], track, dir, frame, {}, signal);
  const granules = names.map(parseName).filter((g) => g && g.pipeline !== "OD");
  const latest = dedupe(granules);
  if (latest.length) latest[0].browse = browseURL(latest[0].name);
  return latest;
}

// Standard-pipeline products of every type acquired since `since`.
// Returns [{product, time}], where time is the acquisition the product was made from
// (the secondary acquisition for interferogram/offset pairs). Reprocessed copies collapse.
export async function frameProducts(track, dir, frame, since, signal) {
  const temporal = `${since.toISOString().slice(0, 19)}Z,`;
  const names = await cmrNames(Object.values(PRODUCTS), track, dir, frame, { temporal }, signal);
  const seen = new Map();
  for (const name of names) {
    const parts = name.split("_");
    const times = name.match(/\d{8}T\d{6}/g);
    if (parts[2] !== "PR" || !times) continue;
    const time = ts(times.length === 4 ? times[2] : times[0]);
    seen.set(`${parts[3]}_${Math.round(time / 60e3)}`, { product: parts[3], time });
  }
  return [...seen.values()];
}

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
