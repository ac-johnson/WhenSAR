import { framesAt } from "./lib/plan.js";
import { framePasses, nextIndex, countdown } from "./lib/passes.js";
import { describeMode, describeFileMode, planBandwidths, fileBandwidths, sameBandwidths } from "./lib/modes.js";
import { zoneAt, fmtLocal, fmtDate, fmtUTC, fmtRange } from "./lib/timefmt.js";
import { frameHistory, frameProducts, vertexLink, PRODUCTS } from "./lib/history.js";

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const PRODUCT_WINDOW_DAYS = 90;
// ASF-stated typical latency for standard L1/L2 products; replaced by measured stats when available
const DEFAULT_LATENCY = { source: "ASF typical", RSLC: { p50: 48, p90: 72 }, GCOV: { p50: 48, p90: 72 }, GUNW: { p50: 54, p90: 80 } };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const state = { marker: null, cards: [], controller: null, point: null };

// Urgent Response timing is opt-in; the standard products stay the main estimate.
const UR_KEY = "whensar.showUrgent";
function setUrgent(on) {
  document.body.classList.toggle("show-ur", on);
  document.querySelectorAll(".ur-toggle").forEach((t) => (t.checked = on));
  try { localStorage.setItem(UR_KEY, on ? "1" : "0"); } catch {}
}
try { setUrgent(localStorage.getItem(UR_KEY) === "1"); } catch {}
const modesP = fetch("data/nisar_modes.json").then((r) => r.json());
const latencyP = fetch("data/nisar_latency.json").then((r) => (r.ok ? r.json() : DEFAULT_LATENCY)).catch(() => DEFAULT_LATENCY);
const metaP = fetch("data/nisar_plan_meta.json").then((r) => r.json());

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

const fromHash = location.hash.match(/^#(-?[\d.]+),(-?[\d.]+)$/);
if (fromHash) select(+fromHash[2], +fromHash[1], true);

map.on("click", (e) => select(e.lngLat.lng, e.lngLat.lat));

$("locate").addEventListener("click", () => {
  navigator.geolocation?.getCurrentPosition(
    (p) => select(p.coords.longitude, p.coords.latitude, true),
    (err) => alert(`Couldn't get location: ${err.message}`),
    { enableHighAccuracy: false, timeout: 10000 }
  );
});

async function select(lon, lat, fly = false) {
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  history.replaceState(null, "", `#${lat.toFixed(4)},${lon.toFixed(4)}`);
  state.controller?.abort();
  state.controller = new AbortController();

  state.marker?.remove();
  state.marker = new maplibregl.Marker({ color: "#16181d" }).setLngLat([lon, lat]).addTo(map);
  $("hint").hidden = true;

  state.point = { lon, lat };
  const t0 = performance.now();
  const [frames, modes, latency, meta] = await Promise.all([framesAt(lon, lat), modesP, latencyP, metaP]);
  const zone = zoneAt(lat, lon);
  const now = Date.now();

  state.cards = frames
    .filter((f) => f.properties.ref_start) // frames with no processed data stay off the map
    .map((f) => {
      const passes = framePasses(f.properties);
      const i = nextIndex(passes, now);
      const lastSeen = new Date(f.properties.ref_start);
      return {
        f, p: f.properties, passes, next: i >= 0 ? passes[i] : null, nextIdx: i,
        key: `${f.properties.track}_${f.properties.dir}_${f.properties.frame}`,
        lastSeen,
        active: now - lastSeen < PRODUCT_WINDOW_DAYS * DAY,
      };
    })
    // Frames acquired recently first (soonest pass on top), then dormant ones
    .sort((a, b) => b.active - a.active || (a.next?.time ?? Infinity) - (b.next?.time ?? Infinity));

  render({ lon, lat, zone, modes, latency, meta });
  console.info(`plan lookup + render: ${(performance.now() - t0).toFixed(0)} ms, ${frames.length} frames`);
  state.cards.forEach((c) => {
    loadHistory(c, zone, state.controller.signal);
    loadProducts(c, zone, latency, state.controller.signal);
  });

  await mapReady;
  map.getSource("frames").setData({
    type: "FeatureCollection",
    features: state.cards.map((c) => ({ ...c.f, properties: { key: c.key, dir: c.p.dir } })),
  });
  highlight(0);

  if (state.cards.length) {
    const b = new maplibregl.LngLatBounds();
    state.cards.forEach((c) => c.f.geometry.coordinates.flat(2).forEach(([x, y]) => b.extend([x, y])));
    map.fitBounds(b, { padding: panelPadding(), maxZoom: 8, duration: fly ? 1200 : 600 });
  } else if (fly) {
    map.flyTo({ center: [lon, lat], zoom: 6 });
  }
}

function panelPadding() {
  return window.innerWidth <= 640
    ? { top: 70, bottom: window.innerHeight * 0.62 + 20, left: 30, right: 30 }
    : { top: 70, bottom: 30, left: 420, right: 60 };
}

function render({ lon, lat, zone, modes, latency, meta }) {
  $("panel").hidden = false;
  $("where").textContent = `${lat.toFixed(3)}, ${lon.toFixed(3)} · ${zone}`;
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
      ${ids}${productsSection(c)}${historySection(c)}</section>`;
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
  const upcoming = c.passes.slice(c.nextIdx + 1, c.nextIdx + 6).map((q) => `<span class="chip">${fmtDate(q.time, zone)}</span>`).join("");

  const produce = new Set(p.produce.split(","));
  const lat = (k) => latency[k] || DEFAULT_LATENCY[k];
  // Median to 90th-percentile processing time, shown as local clock times
  const avail = (k) => fmtRange(new Date(+t + lat(k).p50 * HOUR), new Date(+t + lat(k).p90 * HOUR), zone);
  // An interferogram needs a real earlier acquisition; pair with the latest one if it is recent
  const prev = t - c.lastSeen <= 25 * DAY ? { time: c.lastSeen } : null;
  const gunwPossible = produce.has("gunw") && prev;

  return `<section class="card" data-key="${c.key}">
    <div class="next-label">Next pass · <span class="countdown" data-t="${+t}">${countdown(t - Date.now())}</span></div>
    <div class="next-time">${fmtLocal(t, zone)}</div>
    <div class="sub">${fmtUTC(t)}${next.exact ? "" : ` · <span class="approx" title="Frame start not yet observed; using datatake start">approx.</span>`}${zone !== Intl.DateTimeFormat().resolvedOptions().timeZone ? ` · your time ${fmtLocal(t, undefined)}` : ""}</div>
    ${ids}${dormantNote}
    <div class="section"><h3>Planned mode</h3>${modeLines || '<div class="sub">not specified</div>'}${flownNote}</div>
    <div class="section"><h3 class="h3-row">Expected data availability
      <label class="switch" title="Also show Urgent Response timing"><input type="checkbox" class="ur-toggle"><span class="track"></span>Urgent</label></h3>
      <div class="rows">
      ${produce.has("gcov") || produce.has("gslc") ? `<span class="k">GCOV / GSLC</span><span data-prod="GCOV">${avail("GCOV")}</span>` : `<span class="k">RSLC</span><span data-prod="RSLC">${avail("RSLC")}</span>`}
      ${gunwPossible ? `<span class="k">Interferogram</span><span data-prod="GUNW">${avail("GUNW")}<br><span class="sub">GUNW with ${fmtDate(prev.time, zone)} acquisition</span></span>` : ""}
      ${latency.UR_GCOV?.p50 ? `<span class="k ur-row">Urgent GCOV</span><span class="ur-row">${avail("UR_GCOV")}</span>` : ""}
      ${gunwPossible && latency.UR_GUNW?.p50 ? `<span class="k ur-row">Urgent GUNW</span><span class="ur-row">${avail("UR_GUNW")}</span>` : ""}
    </div>
    <div class="sub ur-row" style="margin-top:4px">Urgent Response products appear only if triggered (e.g. by a USGS earthquake alert). They use a rapid orbit; the standard products above use the corrected orbit and remain the reference.</div>
    <div class="sub" style="margin-top:4px">Median–90th percentile of recent processing times (${esc(latency.source || "measured")})</div></div>
    <div class="section"><h3>Following passes</h3><div class="upcoming">${upcoming || '<span class="sub">none in current plan</span>'}</div></div>
    ${productsSection(c)}
    ${historySection(c)}
  </section>`;
}

function historySection(c) {
  return `<div class="section"><h3>History</h3><div class="history" id="hist-${c.key}"><span class="loading">loading…</span></div>
    <div style="margin-top:6px"><a href="${vertexLink(c.p.track, c.p.frame, state.point.lon, state.point.lat)}" target="_blank" rel="noopener">Open in ASF Vertex ↗</a></div></div>`;
}

async function loadHistory(c, zone, signal) {
  const el = () => document.getElementById(`hist-${c.key}`);
  try {
    const acq = await frameHistory(c.p.track, c.p.dir, c.p.frame, signal);
    if (!el()) return;
    if (!acq.length) {
      el().innerHTML = `<span class="sub">No acquisitions in the public archive yet.</span>`;
      return;
    }
    const since = acq[acq.length - 1].start;
    const planned = c.passes.filter((q) => q.time >= since - 86400e3 && q.time <= Date.now() - 86400e3);
    const got = planned.filter((q) => acq.some((a) => Math.abs(a.start - q.time) < 86400e3)).length;
    const last = acq[0];
    el().innerHTML = `
      <div class="rows">
        <span class="k">Last acquired</span><span>${fmtLocal(last.start, zone)}</span>
        <span class="k">Mode</span><span>${esc(describeFileMode(last.mode, last.pol))}${last.fullFrame ? "" : " · partial frame"}</span>
        <span class="k">Regularity</span><span>${got} of ${planned.length} planned passes since ${fmtDate(since, zone)}</span>
      </div>
      ${last.browse ? `<img class="browse" src="${esc(last.browse)}" alt="Latest browse image" loading="lazy">` : ""}
      <div class="upcoming" style="margin-top:6px">${acq.slice(0, 8).map((a) => `<span class="chip" title="${esc(describeFileMode(a.mode, a.pol))}">${fmtDate(a.start, zone)}</span>`).join("")}</div>`;
  } catch (e) {
    if (e.name !== "AbortError" && el()) el().innerHTML = `<span class="sub">History unavailable (${esc(e.message)})</span>`;
  }
}

function productsSection(c) {
  return `<div class="section"><h3>Products · last ${PRODUCT_WINDOW_DAYS} days</h3><div id="prod-${c.key}"><span class="loading">loading…</span></div></div>`;
}

// Share of planned passes in the window that produced each product. The window ends one
// slow (90th percentile) processing time ago so passes still in processing don't count as missing.
async function loadProducts(c, zone, latency, signal) {
  const el = () => document.getElementById(`prod-${c.key}`);
  const settle = ((latency.GCOV || DEFAULT_LATENCY.GCOV).p90 + 12) * HOUR;
  const since = new Date(Date.now() - PRODUCT_WINDOW_DAYS * DAY);
  const until = new Date(Date.now() - settle);
  try {
    const products = await frameProducts(c.p.track, c.p.dir, c.p.frame, since, signal);
    if (!el()) return;
    const planned = c.passes.filter((q) => q.time >= since && q.time <= until);
    if (!planned.length) {
      el().innerHTML = `<span class="sub">No planned passes in this period.</span>`;
      return;
    }
    const rows = Object.keys(PRODUCTS).map((name) => {
      const n = planned.filter((q) => products.some((g) => g.product === name && Math.abs(g.time - q.time) < DAY)).length;
      return { name, pct: Math.round((100 * n) / planned.length) };
    });
    // Availability estimates are moot for products this frame hasn't been getting
    document.querySelectorAll(`.card[data-key="${c.key}"] [data-prod]`).forEach((cell) => {
      if (rows.find((r) => r.name === cell.dataset.prod)?.pct === 0) {
        cell.innerHTML = `<span class="sub">None produced here in the last ${PRODUCT_WINDOW_DAYS} days</span>`;
      }
    });
    const made = rows.filter((r) => r.pct > 0);
    const none = rows.filter((r) => r.pct === 0).map((r) => r.name);
    if (!made.length) {
      el().innerHTML = `<span class="sub">No products from the ${planned.length} planned passes, ${fmtDate(planned[0].time, zone)} – ${fmtDate(planned.at(-1).time, zone)}.</span>`;
      return;
    }
    el().innerHTML = `
      <div class="sub" style="margin-bottom:6px">Share of ${planned.length} planned passes, ${fmtDate(planned[0].time, zone)} – ${fmtDate(planned.at(-1).time, zone)}</div>
      ${made.length ? `<div class="freq">${made.map((r) => `<span class="k">${r.name}</span><span class="bar"><span style="width:${r.pct}%"></span></span><span class="pct">${r.pct}%</span>`).join("")}</div>` : ""}
      ${none.length ? `<div class="sub" style="margin-top:6px">None: ${none.join(", ")}</div>` : ""}`;
  } catch (e) {
    if (e.name !== "AbortError" && el()) el().innerHTML = `<span class="sub">Products unavailable (${esc(e.message)})</span>`;
  }
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
  if (map.getSource("frames")) {
    state.cards.forEach((c, j) => map.setFeatureState({ source: "frames", id: c.key }, { selected: j === i }));
  }
  const pos = $("pos");
  if (pos) pos.textContent = `${i + 1} / ${state.cards.length}`;
}

// Keep countdowns live
setInterval(() => {
  document.querySelectorAll(".countdown[data-t]").forEach((el) => (el.textContent = countdown(+el.dataset.t - Date.now())));
}, 30e3);
