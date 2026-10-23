import { framesAt } from "./lib/plan.js";
import { framePasses, nextIndex, countdown } from "./lib/passes.js";
import { describeMode, describeFileMode, planBandwidths, fileBandwidths, sameBandwidths } from "./lib/modes.js";
import { zoneAt, fmtLocal, fmtDate, fmtUTC, fmtRange } from "./lib/timefmt.js";
import { acquisitions, productDates, browseURL, vertexLink, PRODUCTS } from "./lib/history.js";
import { loadSites, findSite, siteData, saveSite, refreshSite, removeSite } from "./lib/sites.js";
import { buildTracks, s1Products, dispForTrack, describePol, s1VertexLink, HYP3_URL } from "./lib/s1.js";
import { featuresAt } from "./lib/plan.js";
import { createPolarMap } from "./lib/polarmap.js";

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const PRODUCT_WINDOW_DAYS = 90;
// ASF-stated typical latency for standard L1/L2 products; replaced by measured stats when available
const DEFAULT_LATENCY = {
  source: "ASF typical",
  L0B: { p50: 6, p90: 10 }, RSLC: { p50: 48, p90: 72 }, GCOV: { p50: 48, p90: 72 }, GUNW: { p50: 54, p90: 80 },
  S1_SLC: { p50: 10, p90: 24 }, S1_RTC: { p50: 12, p90: 48 }, S1_CSLC: { p50: 24, p90: 72 },
};
const MISSIONS = { nisar: "NISAR", s1: "Sentinel-1" };
const S1_MODES = { IW: "Interferometric Wide swath", EW: "Extra Wide swath", SM: "Stripmap" };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// NISAR is the default; Sentinel-1 is chosen with the switch (and kept in the link)
const state = {
  mission: "nisar", proj: "geo", marker: null, cards: [], point: null, offlineSince: null, raw: null, controller: null,
  mapFeatures: [], fitFeatures: false, selected: 0,
};
const polarMaps = {}; // pole -> Promise of a polar map view (lib/polarmap.js)

// Urgent Response timing is opt-in; the standard products stay the main estimate.
const UR_KEY = "whensar.showUrgent";
function setUrgent(on) {
  document.body.classList.toggle("show-ur", on);
  document.querySelectorAll(".ur-toggle").forEach((t) => (t.checked = on));
  try { localStorage.setItem(UR_KEY, on ? "1" : "0"); } catch {}
}
try { setUrgent(localStorage.getItem(UR_KEY) === "1"); } catch {}
const modesP = fetch("data/nisar_modes.json").then((r) => r.json()).catch(() => ({}));
const latencyP = fetch("data/nisar_latency.json").then((r) => (r.ok ? r.json() : DEFAULT_LATENCY)).catch(() => DEFAULT_LATENCY);
const metaP = fetch("data/nisar_plan_meta.json").then((r) => r.json()).catch(() => ({}));
const s1MetaP = fetch("data/s1_plan_meta.json").then((r) => r.json()).catch(() => ({}));

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  center: [0, 20],
  zoom: 1.4,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

// Map layers are added once the style is ready; the panel doesn't wait for the basemap.
const mapReady = new Promise((resolve) => map.on("load", resolve)).then(() => {
  map.addSource("frames", { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "key" });
  const color = ["match", ["get", "dir"], "A", "#2563eb", "#d9480f"];
  const selected = ["boolean", ["feature-state", "selected"], false];
  map.addLayer({ id: "frames-fill", type: "fill", source: "frames",
    paint: { "fill-color": color, "fill-opacity": ["case", selected, 0.22, 0.06] } });
  map.addLayer({ id: "frames-line", type: "line", source: "frames",
    paint: { "line-color": color, "line-width": ["case", selected, 2.5, 1], "line-opacity": ["case", selected, 1, 0.6] } });
});

// Browser history: the first selection pushes an entry so Back clears it instead of leaving
// the site; later selections replace it. A shared link gets the same treatment.
// Links look like #34.05,-118.25 (NISAR) or #s1/34.05,-118.25 (Sentinel-1)
const parseHash = () => {
  const m = location.hash.match(/^#(?:(s1)\/)?(-?[\d.]+),(-?[\d.]+)$/);
  return m && { mission: m[1] || "nisar", lat: +m[2], lon: +m[3] };
};
const hashFor = (lat, lon) => `#${state.mission === "s1" ? "s1/" : ""}${lat.toFixed(4)},${lon.toFixed(4)}`;
const fromHash = parseHash();
if (fromHash) {
  history.replaceState(null, "", location.pathname);
  setMission(fromHash.mission, false);
  select(fromHash.lon, fromHash.lat, true);
}
window.addEventListener("popstate", () => {
  const h = parseHash();
  if (h) {
    history.replaceState({ selected: true }, "", location.hash);
    setMission(h.mission, false);
    select(h.lon, h.lat, true, false);
  } else clearSelection();
});

function setMission(mission, reselect = true) {
  state.mission = mission;
  document.querySelectorAll(".mission-switch button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.m === mission)));
  $("hint").textContent = `Tap the map to see when ${MISSIONS[mission]} images that spot`;
  if (reselect && state.point) select(state.point.lon, state.point.lat, false);
}
document.querySelectorAll(".mission-switch button").forEach((b) => b.addEventListener("click", () => setMission(b.dataset.m)));

map.on("click", (e) => select(e.lngLat.lng, e.lngLat.lat));

// Map projection: MapLibre for the default view; OpenLayers polar stereographic views
// (Arctic / Antarctic) are created on first use. The choice is remembered in this browser.
const PROJ_KEY = "whensar.projection";
async function setProjection(proj) {
  state.proj = proj;
  $("proj").value = proj;
  try { localStorage.setItem(PROJ_KEY, proj); } catch {}
  $("map").hidden = proj !== "geo";
  for (const pole of ["arctic", "antarctic"]) {
    const el = $(`polar-${pole}`);
    el.hidden = proj !== pole;
  }
  if (proj !== "geo" && !polarMaps[proj]) {
    try {
      polarMaps[proj] = createPolarMap($(`polar-${proj}`), proj, { onClick: (lon, lat) => select(lon, lat) });
      await polarMaps[proj];
    } catch {
      delete polarMaps[proj];
      alert("Couldn't load the polar map view.");
      return setProjection("geo");
    }
  }
  if (proj === "geo") map.resize();
  drawMap(true);
}
$("proj").addEventListener("change", (e) => setProjection(e.target.value));
try {
  const saved = localStorage.getItem(PROJ_KEY);
  if (saved && saved !== "geo") setProjection(saved);
} catch {}
$("close").addEventListener("click", () => {
  if (history.state?.selected && history.length > 1) history.back();
  else {
    history.replaceState(null, "", location.pathname);
    clearSelection();
  }
});

// Phone bottom sheet: swipe down (or tap the handle) to collapse, swipe up to expand
const isPhone = () => window.matchMedia("(max-width: 640px)").matches;
function setCollapsed(on) {
  $("panel").classList.toggle("collapsed", on);
  if (on) document.querySelectorAll(".card").forEach((card) => (card.scrollTop = 0));
}
$("grabber").addEventListener("click", () => setCollapsed(!$("panel").classList.contains("collapsed")));
$("panel-head").addEventListener("click", (e) => {
  if (!e.target.closest("button") && $("panel").classList.contains("collapsed")) setCollapsed(false);
});
(() => {
  let start = null;
  $("panel").addEventListener("touchstart", (e) => {
    if (!isPhone()) return;
    const t = e.touches[0];
    const card = e.target.closest(".card");
    // Swipes inside a card only count when it is scrolled to the top
    start = { x: t.clientX, y: t.clientY, atTop: !card || card.scrollTop <= 0 };
  }, { passive: true });
  let last = null;
  $("panel").addEventListener("touchmove", (e) => {
    if (start) last = e.touches[0];
  }, { passive: true });
  const finish = () => {
    if (!start || !last) return (start = last = null);
    const dx = last.clientX - start.x, dy = last.clientY - start.y;
    const collapsed = $("panel").classList.contains("collapsed");
    if (Math.abs(dy) > 50 && Math.abs(dy) > 1.5 * Math.abs(dx)) {
      if (dy > 0 && start.atTop && !collapsed) setCollapsed(true);
      else if (dy < 0 && collapsed) setCollapsed(false);
    }
    start = last = null;
  };
  // Browsers may cancel the touch when they take over scrolling; decide on either
  $("panel").addEventListener("touchend", finish, { passive: true });
  $("panel").addEventListener("touchcancel", finish, { passive: true });
})();

// Saved sites
function updateWhere() {
  const { lat, lon } = state.point;
  const site = findSite(lat, lon);
  $("where").textContent = `${site ? `${site.name} · ` : ""}${lat.toFixed(3)}, ${lon.toFixed(3)} · ${state.zone}` +
    (state.offlineSince ? ` · offline, saved ${fmtDate(state.offlineSince, state.zone)}` : "");
}
function updateSaveButton() {
  const p = state.point;
  const saved = p && findSite(p.lat, p.lon);
  $("save").textContent = saved ? "★" : "☆";
  $("save").classList.toggle("on", !!saved);
  $("save").title = saved ? "Remove from saved sites" : "Save this site (works offline)";
  $("save").hidden = !!state.offlineSince && !saved;
}
$("save").addEventListener("click", () => {
  const { lat, lon } = state.point;
  const site = findSite(lat, lon);
  if (site) removeSite(site.id);
  else {
    const name = prompt("Name this site", `${lat.toFixed(3)}, ${lon.toFixed(3)}`);
    if (name === null) return;
    if (!saveSite(lat, lon, name.trim() || `${lat.toFixed(3)}, ${lon.toFixed(3)}`, state.mission, state.raw)) {
      alert("Couldn't save: this browser is blocking storage.");
    }
  }
  updateSaveButton();
  updateWhere();
  renderSites();
});
function renderSites() {
  const sites = loadSites();
  $("sites").innerHTML = sites.length
    ? sites.map((s) => `<div class="site"><button class="open" data-id="${esc(s.id)}">${esc(s.name)}<span class="sub">${s.lat.toFixed(3)}, ${s.lon.toFixed(3)}</span></button><button class="icon-btn del" data-id="${esc(s.id)}" aria-label="Remove ${esc(s.name)}">✕</button></div>`).join("")
    : `<div class="empty sub">No saved sites yet. Tap ☆ on a location to save it; saved sites also work offline.</div>`;
}
$("sites-btn").addEventListener("click", () => {
  const open = $("sites").hidden;
  if (open) renderSites();
  $("sites").hidden = !open;
  $("sites-btn").setAttribute("aria-expanded", String(open));
});
$("sites").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const site = loadSites().find((s) => s.id === btn.dataset.id);
  if (btn.classList.contains("del")) {
    removeSite(btn.dataset.id);
    renderSites();
    updateSaveButton();
  } else if (site) {
    $("sites").hidden = true;
    select(site.lon, site.lat, true);
  }
});

function clearSelection() {
  state.point = null;
  state.cards = [];
  state.mapFeatures = [];
  drawMap(false);
  $("panel").hidden = true;
  $("hint").hidden = false;
}

$("locate").addEventListener("click", () => {
  navigator.geolocation?.getCurrentPosition(
    (p) => select(p.coords.longitude, p.coords.latitude, true),
    (err) => alert(`Couldn't get location: ${err.message}`),
    { enableHighAccuracy: false, timeout: 10000 }
  );
});

async function select(lon, lat, fly = false, updateHistory = true) {
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (updateHistory) {
    const url = hashFor(lat, lon);
    if (history.state?.selected) history.replaceState({ selected: true }, "", url);
    else history.pushState({ selected: true }, "", url);
  }

  $("hint").hidden = true;

  state.point = { lon, lat };
  drawPoint();
  state.controller?.abort();
  state.controller = new AbortController();
  const mission = state.mission;
  const t0 = performance.now();
  const now = Date.now();
  // Offline (or the data files unreachable): fall back to a saved copy of this site
  let offlineSince = null;
  const fromSaved = (err) => {
    const saved = siteData(findSite(lat, lon), mission);
    if (!saved) throw err;
    offlineSince = new Date(saved.saved);
    return saved.data;
  };
  const rawP = mission === "s1"
    ? Promise.all([featuresAt("data/s1_plan.fgb", lon, lat), featuresAt("data/s1_scenes.fgb", lon, lat)])
        .then(([plan, scenes]) => ({ plan, scenes })).catch(fromSaved)
    : framesAt(lon, lat).catch(fromSaved);
  let raw, modes, latency, meta, s1Meta;
  try {
    [raw, modes, latency, meta, s1Meta] = await Promise.all([rawP, modesP, latencyP, metaP, s1MetaP]);
  } catch {
    $("panel").hidden = false;
    $("where").textContent = `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    $("pager").innerHTML = "";
    $("cards").innerHTML = `<div class="card empty">Can't load ${MISSIONS[mission]} data — you may be offline. Saved sites (★) can be viewed offline.</div>`;
    return;
  }
  if (mission !== state.mission) return; // switched while loading
  if (!offlineSince) refreshSite(lat, lon, mission, raw);
  state.raw = raw;
  state.offlineSince = offlineSince;
  updateSaveButton();
  const zone = zoneAt(lat, lon);

  if (mission === "s1") {
    state.cards = buildTracks(raw.plan, raw.scenes, s1Meta, lon, lat, now);
    renderS1({ zone, latency, s1Meta });
    console.info(`plan lookup + render: ${(performance.now() - t0).toFixed(0)} ms, ${state.cards.length} tracks`);
    if (!offlineSince) fillS1Products(lon, lat, zone, latency, now, state.controller.signal);
    await showOnMap(lon, lat, fly);
    return;
  }

  const frames = raw;
  state.cards = frames
    .filter((f) => f.properties.ref_start) // frames with no processed data stay off the map
    .map((f) => {
      const passes = framePasses(f.properties, meta.plan_end, now);
      const i = nextIndex(passes, now);
      const lastSeen = new Date(f.properties.ref_start);
      const acq = acquisitions(f.properties);
      return {
        acq,
        prodDates: productDates(f.properties, acq),
        f, p: f.properties, passes, next: i >= 0 ? passes[i] : null, nextIdx: i,
        key: `${f.properties.track}_${f.properties.dir}_${f.properties.frame}`,
        lastSeen,
        active: now - lastSeen < PRODUCT_WINDOW_DAYS * DAY,
      };
    })
    // Frames acquired recently first (soonest pass on top), then dormant ones
    .sort((a, b) => b.active - a.active || (a.next?.time ?? Infinity) - (b.next?.time ?? Infinity));
  state.cards.forEach((c) => (c.rates = productRates(c, latency, now)));

  render({ lon, lat, zone, modes, latency, meta });
  console.info(`plan lookup + render: ${(performance.now() - t0).toFixed(0)} ms, ${frames.length} frames`);
  state.cards.forEach((c) => (c.feature = c.f));
  await showOnMap(lon, lat, fly);
}

const positions = (g) => (g.type === "MultiPolygon" ? g.coordinates.flat(2) : g.type === "Polygon" ? g.coordinates.flat(1) : []);

// Draw each card's footprint (NISAR frame, or latest Sentinel-1 scene on the track)
async function showOnMap(lon, lat, fly) {
  state.mapFeatures = state.cards.filter((c) => c.feature).map((c) => ({ ...c.feature, properties: { key: c.key, dir: c.dir || c.p.dir } }));
  // Sentinel-1 plan strips span thousands of km, so only fit to scene-sized footprints
  state.fitFeatures = state.mission === "nisar" || state.cards.some((c) => c.footprint);
  state.selected = 0;
  await drawMap(fly);
}

function drawPoint() {
  const p = state.point;
  if (state.proj === "geo") {
    state.marker?.remove();
    state.marker = p ? new maplibregl.Marker({ color: "#16181d" }).setLngLat([p.lon, p.lat]).addTo(map) : null;
  } else {
    polarMaps[state.proj]?.then((m) => m.setPoint(p && [p.lon, p.lat]));
  }
}

// Apply the current selection (point, footprints, highlighted card) to the active map view
async function drawMap(fly) {
  drawPoint();
  const features = state.mapFeatures;
  const fitTo = state.fitFeatures ? features.filter((f) => state.mission === "nisar" || state.cards.find((c) => c.key === f.properties.key)?.footprint) : [];
  if (state.proj !== "geo") {
    const m = await polarMaps[state.proj];
    if (!m) return;
    m.setFootprints(features);
    highlight(state.selected);
    if (state.point) m.fit(panelPadding(), fitTo.length > 0);
    return;
  }
  await mapReady;
  map.getSource("frames").setData({ type: "FeatureCollection", features });
  highlight(state.selected);
  if (!state.point) return;
  if (fitTo.length) {
    const b = new maplibregl.LngLatBounds();
    fitTo.forEach((f) => positions(f.geometry).forEach(([x, y]) => b.extend([x, y])));
    map.fitBounds(b, { padding: panelPadding(), maxZoom: 8, duration: fly ? 1200 : 600 });
  } else if (fly || state.mission === "s1") {
    map.flyTo({ center: [state.point.lon, state.point.lat], zoom: 6 });
  }
}


function panelPadding() {
  return isPhone()
    ? { top: 70, bottom: window.innerHeight * 0.62 + 20, left: 30, right: 30 }
    : { top: 70, bottom: 30, left: 420, right: 60 };
}

function render({ lon, lat, zone, modes, latency, meta }) {
  $("panel").hidden = false;
  setCollapsed(false);
  state.zone = zone;
  updateWhere();
  const cards = $("cards");

  if (!state.cards.length) {
    cards.innerHTML = `<div class="card empty">No NISAR frames with processed data cover this point yet.</div>`;
    $("pager").innerHTML = "";
    return;
  }

  cards.innerHTML = state.cards.map((c) => cardHTML(c, zone, modes, latency, meta)).join("");
  cards.querySelectorAll(".ur-toggle").forEach((t) => {
    t.checked = document.body.classList.contains("show-ur");
    t.addEventListener("change", () => setUrgent(t.checked));
  });
  cards.scrollLeft = 0;
  setupPager();
}

function cardHTML(c, zone, modes, latency, meta) {
  const { p, next } = c;
  const dirName = p.dir === "A" ? "Ascending" : "Descending";
  const ids = `<div class="frame-id"><span class="chip">Track ${p.track}</span><span class="chip">Frame ${p.frame}</span><span class="chip ${p.dir === "A" ? "asc" : "desc"}">${dirName}</span></div>`;

  if (!next) {
    return `<section class="card" data-key="${c.key}">
      <div class="next-label">Next pass</div>
      <div class="next-time">Not in current plan</div>
      <div class="sub">Published plan ends ${esc(meta.plan_end)}; a new plan is expected before then.</div>
      ${ids}${productsSection(c, zone)}${historySection(c, zone)}</section>`;
  }

  const t = next.time;
  const modeLines = next.modes.map((m) => describeMode(modes[m])).map((d) => `<div>${esc(d.lband?.text || d.short)}${d.sband ? `<br><span class="sub">${esc(d.sband.text)}</span>` : ""}</div>`).join("");
  // The published plan's modes can lag what is actually flown (e.g. 77 MHz planned, 40+5 flown)
  let flownNote = "";
  if (p.last_mode && p.last_pol) {
    const flown = fileBandwidths(p.last_mode);
    if (!next.modes.some((m) => sameBandwidths(planBandwidths(modes[m]), flown))) {
      flownNote = `<div class="note">The last acquisition here (${fmtDate(c.lastSeen, zone)}) was <b>${esc(describeFileMode(p.last_mode, p.last_pol))}</b>, which differs from the published plan. Actual acquisitions are likely the better guide.</div>`;
    }
  }
  const dormantNote = c.active ? "" :
    `<div class="note">Not acquired since ${fmtDate(c.lastSeen, zone)}, although passes were planned. This pass may not be collected or processed.</div>`;
  const upcoming = c.passes
    .slice(c.nextIdx + 1, c.nextIdx + 6)
    .map((q) => (q.projected
      ? `<span class="chip projected" title="Projected: beyond the published plan">${fmtDate(q.time, zone)}</span>`
      : `<span class="chip">${fmtDate(q.time, zone)}</span>`))
    .join("");

  const produce = new Set(p.produce.split(","));
  const lat = (k) => latency[k] || DEFAULT_LATENCY[k];
  // Median to 90th-percentile processing time, shown as local clock times
  // Availability estimates are moot for products this frame hasn't been getting
  const avail = (k, product) =>
    c.rates.byProduct[product] === 0
      ? `<span class="sub">None produced here in the last ${PRODUCT_WINDOW_DAYS} days</span>`
      : fmtRange(new Date(+t + lat(k).p50 * HOUR), new Date(+t + lat(k).p90 * HOUR), zone);
  // An interferogram needs a real earlier acquisition; pair with the latest one if it is recent
  const prev = t - c.lastSeen <= 25 * DAY ? { time: c.lastSeen } : null;
  const gunwPossible = produce.has("gunw") && prev;

  return `<section class="card" data-key="${c.key}">
    <div class="next-label">Next pass · <span class="countdown" data-t="${+t}">${countdown(t - Date.now())}</span></div>
    <div class="next-time">${fmtLocal(t, zone)}</div>
    ${next.projected ? `<div class="note">Projected: the published plan ends ${esc(meta.plan_end)}. This assumes its 12-day pattern and mode continue.</div>` : ""}
    <div class="sub">${fmtUTC(t)}${next.exact ? "" : ` · <span class="approx" title="Frame start not yet observed; using datatake start">approx.</span>`}${zone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? ` · your time ${fmtLocal(t, undefined)}` : ""}</div>
    ${ids}${dormantNote}
    <div class="section"><h3>Planned mode</h3>${modeLines || '<div class="sub">not specified</div>'}${flownNote}</div>
    <div class="section"><h3 class="h3-row">Expected data availability
      <label class="switch" title="Also show Urgent Response timing"><input type="checkbox" class="ur-toggle"><span class="track"></span>Urgent</label></h3>
      <div class="rows">
      <span class="k">L0B (raw)</span><span>${avail("L0B")}</span>
      ${produce.has("gcov") || produce.has("gslc") ? `<span class="k">GCOV / GSLC</span><span>${avail("GCOV", "GCOV")}</span>` : `<span class="k">RSLC</span><span>${avail("RSLC", "RSLC")}</span>`}
      ${gunwPossible ? `<span class="k">Interferogram</span><span>${avail("GUNW", "GUNW")}${c.rates.byProduct.GUNW === 0 ? "" : `<br><span class="sub">GUNW with ${fmtDate(prev.time, zone)} acquisition</span>`}</span>` : ""}
      ${latency.UR_GCOV?.p50 ? `<span class="k ur-row">Urgent GCOV</span><span class="ur-row">${avail("UR_GCOV", "GCOV")}</span>` : ""}
      ${gunwPossible && latency.UR_GUNW?.p50 ? `<span class="k ur-row">Urgent GUNW</span><span class="ur-row">${avail("UR_GUNW", "GUNW")}</span>` : ""}
    </div>
    <div class="sub ur-row" style="margin-top:4px">Urgent Response products are made only if this pass is tasked for it.
      <a href="https://nisar-docs.asf.alaska.edu/urgent-response/" target="_blank" rel="noopener">ASF documentation ↗</a></div>
    <div class="sub" style="margin-top:4px">Median–90th percentile of recent processing times (${esc(latency.source || "measured")})</div></div>
    <div class="section"><h3>Following passes</h3><div class="upcoming">${upcoming || '<span class="sub">none in current plan</span>'}</div>${c.passes.slice(c.nextIdx + 1, c.nextIdx + 6).some((q) => q.projected) ? '<div class="sub" style="margin-top:4px">Dashed: projected beyond the published plan</div>' : ""}</div>
    ${productsSection(c, zone)}
    ${historySection(c, zone)}
  </section>`;
}

function historySection(c, zone) {
  const acq = c.acq;
  const vertex = `<div style="margin-top:6px"><a href="${vertexLink(c.p.track, c.p.frame, state.point.lon, state.point.lat)}" target="_blank" rel="noopener">Open in ASF Vertex ↗</a></div>`;
  if (!acq.length) return `<div class="section"><h3>History</h3><span class="sub">No acquisitions in the public archive yet.</span>${vertex}</div>`;
  const since = acq.at(-1).start;
  const planned = c.passes.filter((q) => q.time >= since - DAY && q.time <= Date.now() - DAY);
  const got = planned.filter((q) => acq.some((a) => Math.abs(a.start - q.time) < DAY)).length;
  const last = acq[0];
  return `<div class="section"><h3>History</h3>
    <div class="rows">
      <span class="k">Last acquired</span><span>${fmtLocal(last.start, zone)}</span>
      <span class="k">Mode</span><span>${esc(describeFileMode(last.mode, last.pol))}${last.fullFrame ? "" : " · partial frame"}</span>
      <span class="k">Regularity</span><span>${got} of ${planned.length} planned passes since ${fmtDate(since, zone)}</span>
    </div>
    ${c.p.latest_rslc ? `<img class="browse" src="${esc(browseURL(c.p.latest_rslc))}" alt="Latest browse image" loading="lazy">` : ""}
    <div class="upcoming" style="margin-top:6px">${acq.slice(0, 8).map((a) => `<span class="chip" title="${esc(describeFileMode(a.mode, a.pol))}">${fmtDate(a.start, zone)}</span>`).join("")}</div>
    ${vertex}</div>`;
}

// Share of planned passes in the window that produced each product. The window ends one
// slow (90th percentile) processing time ago so passes still in processing don't count as missing.
function productRates(c, latency, now) {
  const settle = ((latency.GCOV || DEFAULT_LATENCY.GCOV).p90 + 12) * HOUR;
  const planned = c.passes.filter((q) => q.time >= now - PRODUCT_WINDOW_DAYS * DAY && q.time <= now - settle);
  const byProduct = {};
  for (const name of PRODUCTS) {
    const dates = c.prodDates[name] || [];
    const n = planned.filter((q) => dates.some((d) => Math.abs(d - q.time) < DAY)).length;
    byProduct[name] = planned.length ? Math.round((100 * n) / planned.length) : null;
  }
  return { planned, byProduct };
}

function productsSection(c, zone) {
  const { planned, byProduct } = c.rates;
  const head = `<div class="section"><h3>Products · last ${PRODUCT_WINDOW_DAYS} days</h3>`;
  if (!planned.length) return `${head}<span class="sub">No planned passes in this period.</span></div>`;
  const span = `${planned.length} planned passes, ${fmtDate(planned[0].time, zone)} – ${fmtDate(planned.at(-1).time, zone)}`;
  const made = PRODUCTS.filter((p) => byProduct[p] > 0);
  const none = PRODUCTS.filter((p) => byProduct[p] === 0);
  if (!made.length) return `${head}<span class="sub">No products from the ${span}.</span></div>`;
  return `${head}
    <div class="sub" style="margin-bottom:6px">Share of ${span}</div>
    <div class="freq">${made.map((p) => `<span class="k">${p}</span><span class="bar"><span style="width:${byProduct[p]}%"></span></span><span class="pct">${byProduct[p]}%</span>`).join("")}</div>
    ${none.length ? `<div class="sub" style="margin-top:6px">None: ${none.join(", ")}</div>` : ""}</div>`;
}

// ---- Sentinel-1 ----

function renderS1({ zone, latency, s1Meta }) {
  $("panel").hidden = false;
  setCollapsed(false);
  state.zone = zone;
  updateWhere();
  const cards = $("cards");
  if (!state.cards.length) {
    cards.innerHTML = `<div class="card empty">No Sentinel-1 acquisitions here in the last 100 days or in ESA's current plan.</div>`;
    $("pager").innerHTML = "";
    return;
  }
  cards.innerHTML = state.cards.map((c) => s1CardHTML(c, zone, latency, s1Meta)).join("");
  cards.scrollLeft = 0;
  setupPager();
}

const satName = (sat) => `Sentinel-1${sat.slice(-1)}`;

function s1CardHTML(c, zone, latency, s1Meta) {
  const dirName = c.dir === "A" ? "Ascending" : "Descending";
  const lat = (k) => latency[k] || DEFAULT_LATENCY[k];
  const ids = (sat) => `<div class="frame-id"><span class="chip">Path ${c.path}</span><span class="chip ${c.dir === "A" ? "asc" : "desc"}">${dirName}</span>${sat ? `<span class="chip">${satName(sat)}</span>` : ""}</div>`;
  const next = c.next;
  if (!next) {
    return `<section class="card" data-key="${c.key}">
      <div class="next-label">Next pass</div><div class="next-time">Not in ESA's current plan</div>
      ${ids()}${s1ProductsSection(c, zone)}${s1HistorySection(c, zone)}</section>`;
  }
  const t = next.time;
  const win = (k) => fmtRange(new Date(+t + lat(k).p50 * HOUR), new Date(+t + lat(k).p90 * HOUR), zone);
  const following = c.passes.slice(1, 6);
  return `<section class="card" data-key="${c.key}">
    <div class="next-label">Next pass · <span class="countdown" data-t="${+t}">${countdown(t - Date.now())}</span></div>
    <div class="next-time">${fmtLocal(t, zone)}</div>
    ${next.projected ? `<div class="note">Projected: ESA's published plan for ${satName(next.sat)} ends ${fmtDate(new Date(s1Meta.plan_end?.[next.sat]), zone)}. This assumes its 12-day repeat continues.</div>` : ""}
    <div class="sub">${fmtUTC(t)}${zone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? ` · your time ${fmtLocal(t, undefined)}` : ""}</div>
    ${ids(next.sat)}
    <div class="section"><h3>${next.projected ? "Expected" : "Planned"} mode</h3>
      <div>${esc(next.mode)} (${esc(S1_MODES[next.mode] || next.mode)}), ${esc(describePol(next.pol))}</div></div>
    <div class="section"><h3>Expected data availability</h3><div class="rows">
      <span class="k">SLC / bursts</span><span>${win("S1_SLC")}</span>
      <span class="k">OPERA RTC</span><span data-s1="rtc">${win("S1_RTC")}</span>
      <span class="k">OPERA CSLC</span><span data-s1="cslc">${win("S1_CSLC")}</span>
      <span class="k">Interferogram</span><span>Once the SLC is available, process one on demand with
        <a href="${HYP3_URL}" target="_blank" rel="noopener">ASF HyP3 ↗</a><span data-s1="aria"></span></span>
    </div><div class="sub" style="margin-top:4px">Median–90th percentile of recent processing times (${esc(latency.source || "measured")})</div></div>
    <div class="section"><h3>Following passes</h3><div class="upcoming">${following.map((q) =>
      `<span class="chip${q.projected ? " projected" : ""}" title="${satName(q.sat)}${q.projected ? ", projected beyond ESA's plan" : ""}">${fmtDate(q.time, zone)} · ${q.sat.slice(-1)}</span>`).join("") || '<span class="sub">none in current plan</span>'}</div>
      <div class="sub" style="margin-top:4px">C / D: Sentinel-1C / 1D${following.some((q) => q.projected) ? "; dashed: projected beyond ESA's plan" : ""}</div></div>
    ${s1ProductsSection(c, zone)}
    ${s1HistorySection(c, zone)}
  </section>`;
}

function s1ProductsSection(c, zone) {
  const recent = c.acq.filter((a) => a.time >= Date.now() - PRODUCT_WINDOW_DAYS * DAY);
  const gaps = recent.slice(1).map((a, i) => (recent[i].time - a.time) / DAY).sort((a, b) => a - b);
  const every = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null;
  return `<div class="section"><h3>Products · last ${PRODUCT_WINDOW_DAYS} days</h3>
    <div class="sub" style="margin-bottom:6px">${recent.length
      ? `SLC: ${recent.length} acquisitions${every ? `, about every ${every} days` : ""}`
      : "No SLC acquisitions here in this period (track is in ESA's plan)"}</div>
    ${recent.length ? '<div data-s1="opera"><span class="loading">loading OPERA…</span></div>' : ""}
    <div class="rows" style="margin-top:6px">
      <span class="k">OPERA DISP</span><span data-s1="disp" class="loading">loading…</span>
      <span class="k">ARIA GUNW</span><span data-s1="gunw" class="loading">loading…</span>
    </div></div>`;
}

function s1HistorySection(c, zone) {
  const vertex = `<div style="margin-top:6px"><a href="${s1VertexLink(c.path, state.point.lon, state.point.lat)}" target="_blank" rel="noopener">Open in ASF Vertex ↗</a></div>`;
  if (!c.acq.length) return `<div class="section"><h3>History</h3><span class="sub">No acquisitions in the last 100 days.</span>${vertex}</div>`;
  const last = c.acq[0];
  return `<div class="section"><h3>History</h3>
    <div class="rows">
      <span class="k">Last acquired</span><span>${fmtLocal(last.time, zone)} · ${satName(last.sat)}</span>
      <span class="k">Mode</span><span>${esc(last.mode)}, ${esc(describePol(last.pol))}</span>
    </div>
    <div class="upcoming" style="margin-top:6px">${c.acq.slice(0, 10).map((a) => `<span class="chip" title="${satName(a.sat)}">${fmtDate(a.time, zone)} · ${a.sat.slice(-1)}</span>`).join("")}</div>
    ${vertex}</div>`;
}

// OPERA / ARIA products are queried live (too many granules to precompute); each part fills
// in as its query returns
function fillS1Products(lon, lat, zone, latency, now, signal) {
  const { opera, disp, aria } = s1Products(lon, lat, new Date(now - PRODUCT_WINDOW_DAYS * DAY), signal);
  const each = (fn) => state.cards.forEach((c) => {
    const card = document.querySelector(`.card[data-key="${c.key}"]`);
    if (card) fn(c, card);
  });
  const failed = (what) => (e) => {
    if (e.name === "AbortError") return;
    each((c, card) => {
      const el = card.querySelector(`[data-s1="${what}"]`);
      if (el) {
        el.innerHTML = `<span class="sub">unavailable right now</span>`;
        el.classList.remove("loading");
      }
    });
  };

  opera.then((prod) => each((c, card) => {
    const rows = [];
    for (const [kind, label] of [["rtc", "RTC"], ["cslc", "CSLC"]]) {
      // Share of SLC acquisitions old enough to have been processed that have this product
      const settle = (latency[`S1_${label}`] || DEFAULT_LATENCY[`S1_${label}`]).p90 * HOUR + 12 * HOUR;
      const eligible = c.acq.filter((a) => a.time >= now - PRODUCT_WINDOW_DAYS * DAY && a.time <= now - settle);
      const dates = prod[kind][c.path] || [];
      const n = eligible.filter((a) => dates.some((d) => Math.abs(d - a.time) < 3600e3)).length;
      const pct = eligible.length ? Math.round((100 * n) / eligible.length) : null;
      rows.push({ label, pct });
      if (!dates.length) {
        const cell = card.querySelector(`[data-s1="${kind}"]`);
        if (cell) cell.innerHTML = `<span class="sub">Not produced here in the last ${PRODUCT_WINDOW_DAYS} days</span>`;
      }
    }
    const operaCell = card.querySelector('[data-s1="opera"]');
    if (!operaCell) return;
    operaCell.innerHTML = `
      <div class="freq">${rows.map((r) => r.pct === null
        ? `<span class="k">${r.label}</span><span class="sub" style="grid-column: span 2">no acquisitions old enough yet</span>`
        : `<span class="k">${r.label}</span><span class="bar"><span style="width:${r.pct}%"></span></span><span class="pct">${r.pct}%</span>`).join("")}</div>
      <div class="sub" style="margin-top:6px">Share of SLC acquisitions with OPERA RTC / CSLC</div>`;
  }), failed("opera"));

  disp.then((list) => each((c, card) => {
    const d = dispForTrack(list, c);
    const cell = card.querySelector('[data-s1="disp"]');
    cell.textContent = d ? `latest through ${fmtDate(d, zone)}` : "none";
    cell.classList.remove("loading");
  }), failed("disp"));

  aria.then((byTrack) => each((c, card) => {
    const t = byTrack[`${c.path}_${c.dir}`];
    const cell = card.querySelector('[data-s1="gunw"]');
    cell.textContent = t ? `latest ${fmtDate(t, zone)}` : "none";
    cell.classList.remove("loading");
    const note = card.querySelector('[data-s1="aria"]');
    if (note && t) note.innerHTML = `<br><span class="sub">ARIA GUNW interferograms exist for this track (latest ${fmtDate(t, zone)})</span>`;
  }), failed("gunw"));
}

function setupPager() {
  const cards = $("cards");
  const n = state.cards.length;
  const pager = $("pager");
  pager.innerHTML = n > 1 ? `<button data-d="-1" aria-label="Previous">‹</button><span id="pos">1 / ${n}</span><button data-d="1" aria-label="Next">›</button>` : "";
  pager.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => cards.scrollBy({ left: +b.dataset.d * cards.clientWidth, behavior: "smooth" }))
  );
  cards.onscroll = () => highlight(Math.round(cards.scrollLeft / cards.clientWidth));
}

function highlight(i) {
  state.selected = i;
  if (state.proj === "geo" && map.getSource("frames")) {
    state.cards.forEach((c, j) => map.setFeatureState({ source: "frames", id: c.key }, { selected: j === i }));
  } else if (state.proj !== "geo") {
    polarMaps[state.proj]?.then((m) => m.highlight(state.cards[i]?.key));
  }
  const pos = $("pos");
  if (pos) pos.textContent = `${i + 1} / ${state.cards.length}`;
}

// Keep countdowns live
setInterval(() => {
  document.querySelectorAll(".countdown[data-t]").forEach((el) => (el.textContent = countdown(+el.dataset.t - Date.now())));
}, 30e3);
