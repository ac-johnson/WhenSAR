// Sentinel-1 at a point: upcoming passes from ESA's acquisition plan, past SLC acquisitions
// (both precomputed, see pipeline/s1_plan.py and s1_index.py) and OPERA / ARIA products
// (queried live from CMR; too many granules to precompute).
//
// A "track" is a relative orbit (path) and direction. Sentinel-1C and 1D fly the same tracks
// 6 days apart, each repeating every 12 days.

import { featuresAt } from "./plan.js";

const DAY = 86400e3;
const CYCLE = 12 * DAY;
const PROJECT_DAYS = 90; // beyond ESA's ~3-week plan, assume each satellite keeps its 12-day repeat

const CMR_XML = "https://cmr.earthdata.nasa.gov/search/granules.xml";
const OPERA = { RTC: "C2777436413-ASF", CSLC: "C2777443834-ASF" };
// ESA products at ASF: SLC, and GRD (dual/single-pol, high/medium resolution) for both satellites
const SLC = ["C3470873558-ASF", "C4175278193-ASF"];
const GRD = ["C3486566209-ASF", "C4163054563-ASF", "C3486605959-ASF", "C4174076966-ASF",
  "C3488402208-ASF", "C4174044457-ASF", "C3488414315-ASF", "C4175200051-ASF"];
const DISP = "C3294057315-ASF";
const ARIA_GUNW = "C2859376221-ASF";

// Fraction of the way along a datatake's centre line, from its start (0) to its end (1)
function alongTrack(p, lon, lat) {
  let x = lon;
  while (x - p.ax > 180) x -= 360;
  while (x - p.ax < -180) x += 360;
  const vx = p.bx - p.ax, vy = p.by - p.ay;
  const f = ((x - p.ax) * vx + (lat - p.ay) * vy) / (vx * vx + vy * vy);
  return Math.min(1, Math.max(0, f));
}

// Time over the point for a plan datatake or an SLC scene
function timeOver(p, lon, lat) {
  const t0 = Date.parse(p.start), t1 = Date.parse(p.stop);
  return new Date(p.ax !== undefined ? t0 + alongTrack(p, lon, lat) * (t1 - t0) : (t0 + t1) / 2);
}

export async function s1Tracks(lon, lat, meta, now = Date.now()) {
  const [plan, scenes] = await Promise.all([
    featuresAt("data/s1_plan.fgb", lon, lat),
    featuresAt("data/s1_scenes.fgb", lon, lat),
  ]);
  return buildTracks(plan, scenes, meta, lon, lat, now);
}

export function buildTracks(plan, scenes, meta, lon, lat, now = Date.now()) {
  const tracks = new Map();
  const track = (p) => {
    const key = `${p.path}_${p.dir}`;
    if (!tracks.has(key)) tracks.set(key, { key, path: p.path, dir: p.dir, passes: [], acq: [], footprint: null });
    return tracks.get(key);
  };

  for (const f of plan) {
    const p = f.properties;
    track(p).passes.push({ time: timeOver(p, lon, lat), sat: p.sat, mode: p.mode, pol: p.pol, projected: false });
  }
  for (const f of scenes) {
    const p = f.properties;
    const t = track(p);
    const time = timeOver(p, lon, lat);
    // The same acquisition can appear as overlapping scenes; keep one per satellite pass
    if (!t.acq.some((a) => a.sat === p.sat && Math.abs(a.time - time) < 10 * 60e3)) {
      t.acq.push({ time, sat: p.sat, mode: p.mode, pol: p.pol });
    }
    // Map footprint: the latest scene, preferring SLC/GRD (ASF's RAW footprints are narrower than the swath)
    const rank = (x) => [x.properties.product !== "RAW", Date.parse(x.properties.start)];
    const better = (a, b) => { const [ra, rb] = [rank(a), rank(b)]; return ra[0] !== rb[0] ? ra[0] : ra[1] > rb[1]; };
    if (!t.footprint || better(f, t.footprint)) t.footprint = f;
  }

  for (const t of tracks.values()) {
    t.acq.sort((a, b) => b.time - a.time);
    t.passes = t.passes.filter((q) => q.time > now - 60e3).sort((a, b) => a.time - b.time);
    // Project each satellite past the end of its published plan on its 12-day repeat
    for (const sat of new Set([...t.passes, ...t.acq].map((q) => q.sat))) {
      const known = [...t.passes, ...t.acq].filter((q) => q.sat === sat).sort((a, b) => b.time - a.time);
      const planEnd = Date.parse(meta.plan_end?.[sat] || 0);
      const last = known[0];
      // Only satellites still covering this track recently (within two cycles of the plan's end)
      if (!last || +last.time < planEnd - 2 * CYCLE) continue;
      for (let time = +last.time + CYCLE; time < now + PROJECT_DAYS * DAY; time += CYCLE) {
        if (time > planEnd) t.passes.push({ time: new Date(time), sat, mode: last.mode, pol: last.pol, projected: true });
      }
    }
    t.passes.sort((a, b) => a.time - b.time);
    t.next = t.passes[0] || null;
    t.lastSeen = t.acq[0]?.time || null;
    // Only real scene footprints are drawn: plan datatakes are strips thousands of km long
    t.feature = t.footprint;
  }
  return [...tracks.values()]
    .filter((t) => t.next || t.acq.length)
    .sort((a, b) => (a.next?.time ?? Infinity) - (b.next?.time ?? Infinity));
}

// "VV+VH" (ASF) or "DV" (ESA plan) -> words
export function describePol(pol) {
  const map = { DV: "VV+VH", DH: "HH+HV", SV: "VV", SH: "HH", HH: "HH", VV: "VV" };
  const p = map[pol] || pol;
  return p.includes("+") ? `dual-pol ${p}` : `single-pol ${p}`;
}

async function cmrNames(params, signal) {
  const r = await fetch(`${CMR_XML}?${params}`, { signal });
  if (!r.ok) throw new Error(`CMR ${r.status}`);
  const doc = new DOMParser().parseFromString(await r.text(), "application/xml");
  return [...doc.querySelectorAll("reference > name")].map((n) => n.textContent);
}

const ts = (s) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11) || "00"}:${s.slice(11, 13) || "00"}:${s.slice(13, 15) || "00"}Z`);
const minuteOfDay = (d) => d.getUTCHours() * 60 + d.getUTCMinutes();

// OPERA and ARIA products at the point. Three independent CMR queries (ARIA can be slow), so
// each resolves on its own:
//   opera: {rtc: {"71": [Date...]}, cslc: {...}}   disp: [{frame, time}]   aria: {"71_D": Date}
export function s1Products(lon, lat, since, signal) {
  const point = `${lon.toFixed(5)},${lat.toFixed(5)}`;
  const recent = new URLSearchParams({ point, temporal: `${since.toISOString().slice(0, 19)}Z,`, page_size: "2000" });
  [...Object.values(OPERA), ...SLC, ...GRD].forEach((c) => recent.append("collection_concept_id", c));
  const latest = (c) => new URLSearchParams({ collection_concept_id: c, point, page_size: "200", sort_key: "-end_date" });

  // {rtc: [{track, time}], cslc: [...], slc: [{sat, time}], grd: [...]}
  const opera = cmrNames(recent, signal).then((names) => {
    const out = { rtc: [], cslc: [], slc: [], grd: [] };
    for (const name of names) {
      // OPERA_L2_RTC-S1_T071-151229-IW2_20261020T135150Z_...
      let m = name.match(/^OPERA_L2_(RTC|CSLC)-S1_T(\d{3})-\d+-\w+?_(\d{8}T\d{6})Z/);
      if (m) { out[m[1].toLowerCase()].push({ track: +m[2], time: ts(m[3]) }); continue; }
      // S1C_IW_SLC__1SDV_20261020T135136_... / S1D_EW_GRDM_1SDH_20261018T162518_...
      m = name.match(/^(S1[A-D])_\w\w_(SLC_|GRD\w)_\w{4}_(\d{8}T\d{6})/);
      if (m) out[m[2].startsWith("SLC") ? "slc" : "grd"].push({ sat: m[1], time: ts(m[3]) });
    }
    return out;
  });
  const disp = cmrNames(latest(DISP), signal).then((names) =>
    names
      // OPERA_L3_DISP-S1_IW_F18904_VV_<reference>_<secondary>_v1.0_<production>
      .map((name) => name.match(/^OPERA_L3_DISP-S1_\w+?_F(\d+)_\w+?_\d{8}T\d{6}Z_(\d{8}T\d{6})Z/))
      .filter(Boolean)
      .map((m) => ({ frame: m[1], time: ts(m[2]) }))
  );
  const aria = cmrNames(latest(ARIA_GUNW), signal).then((names) => {
    const out = {};
    for (const name of names) {
      // S1-GUNW-D-R-071-tops-20250918_20250226-135250-...: newest date first
      const m = name.match(/^S1-GUNW-([AD])-R-(\d{3})-tops-(\d{8})_\d{8}-(\d{6})/);
      if (!m) continue;
      const key = `${+m[2]}_${m[1]}`, t = ts(`${m[3]}T${m[4]}`);
      if (!out[key] || t > out[key]) out[key] = t;
    }
    return out;
  });
  return { opera, disp, aria };
}

// DISP frames don't name their track; match by time of day (passes repeat to the minute)
export function dispForTrack(disp, track) {
  const ref = track.acq[0]?.time || track.next?.time;
  if (!ref) return null;
  const hits = disp.filter((d) => Math.abs(minuteOfDay(d.time) - minuteOfDay(ref)) <= 5);
  return hits.length ? new Date(Math.max(...hits.map((d) => +d.time))) : null;
}

export function s1VertexLink(path, lon, lat) {
  const p = new URLSearchParams({
    dataset: "SENTINEL-1",
    productTypes: "SLC",
    polygon: `POINT(${lon.toFixed(4)} ${lat.toFixed(4)})`,
    path: `${path}-${path}`,
    searchType: "Geographic Search",
    resultsLoaded: "true",
  });
  return `https://search.asf.alaska.edu/#/?${p}`;
}

export const HYP3_URL = "https://hyp3-docs.asf.alaska.edu/guides/insar_product_guide/";

// Satellites covering this track (recent acquisitions or ESA's current plan) and the
// resulting repeat: 6 days with both Sentinel-1C and 1D, 12 with one
export function s1Repeat(track) {
  const sats = [...new Set([...track.acq, ...track.passes.filter((q) => !q.projected)].map((q) => q.sat))].sort();
  return { sats, days: sats.length >= 2 ? 6 : 12 };
}

// Passes expected over [now - days, now - settle]: each covering satellite passes every
// 12 days on its own fixed schedule (anchored on any known pass time). Each slot records
// whether an acquisition happened.
export function expectedSlots(track, now, days, settle) {
  const start = now - days * DAY, end = now - settle;
  const slots = [];
  for (const sat of s1Repeat(track).sats) {
    const known = [...track.acq, ...track.passes].filter((q) => q.sat === sat);
    if (!known.length) continue;
    const anchor = +known[0].time;
    for (let t = anchor + Math.ceil((start - anchor) / CYCLE) * CYCLE; t <= end; t += CYCLE) {
      slots.push({ sat, time: new Date(t), acquired: track.acq.some((a) => a.sat === sat && Math.abs(a.time - t) < DAY) });
    }
  }
  return slots.sort((a, b) => a.time - b.time);
}

// Share of expected slots that produced a product. Products are matched to a slot by time
// (within 15 min), and by satellite (SLC/GRD) or track number (OPERA) when known.
export function productShare(slots, granules, path) {
  if (!slots.length) return null;
  const n = slots.filter((s) => granules.some((g) =>
    Math.abs(g.time - s.time) < 15 * 60e3 && (g.sat ? g.sat === s.sat : g.track === path))).length;
  return Math.round((100 * n) / slots.length);
}
