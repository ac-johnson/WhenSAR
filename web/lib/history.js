// Past acquisitions of one frame, from CMR (public, CORS-enabled, ~1 s).
// Everything needed is encoded in the granule name, so the compact CSV output suffices.

const CMR_CSV = "https://cmr.earthdata.nasa.gov/search/granules.csv";
const RSLC = "C2853145197-ASF"; // NISAR_L1_RSLC_PROVISIONAL_V1

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

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
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

export async function frameHistory(track, dir, frame, signal) {
  const params = new URLSearchParams({
    collection_concept_id: RSLC,
    "attribute[]": `string,STACK_ID,${pad3(track)}_${dir}_${pad3(frame)}`,
    page_size: "500",
    sort_key: "-start_date",
  });
  const r = await fetch(`${CMR_CSV}?${params}`, { signal });
  if (!r.ok) throw new Error(`CMR ${r.status}`);
  const [header, ...rows] = parseCSV(await r.text());
  const iName = header.indexOf("Granule UR");
  const iBrowse = header.indexOf("Browse URLs");
  const granules = rows
    .map((row) => {
      const g = parseName(row[iName] || "");
      if (g) g.browse = (row[iBrowse] || "").split(",").find((u) => u.endsWith("_LATLON_thumbnail.png")) || null;
      return g;
    })
    .filter((g) => g && g.pipeline !== "OD");
  return dedupe(granules);
}

export function vertexLink(track, dir, frame) {
  const p = new URLSearchParams({
    dataset: "NISAR",
    productTypes: "RSLC",
    path: String(track),
    frame: String(frame),
    flightDirs: dir === "A" ? "Ascending" : "Descending",
  });
  return `https://search.asf.alaska.edu/#/?${p}`;
}
