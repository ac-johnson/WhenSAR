// Service worker: keeps the app usable offline (with saved sites) and on flaky connections.
//
// - App code and small data files: network first, falling back to the cached copy.
// - Vendored libraries and icons: cache first (they only change with a version bump).
// - The plan file (.fgb) is read with HTTP range requests and isn't cached; offline,
//   saved sites carry their own copy of the frame data instead.
// - Map tiles and other sites: not handled (the basemap needs a connection).

const CACHE = "whensar-v3";
const SHELL = [
  "./",
  "index.html",
  "app.js",
  "style.css",
  "manifest.webmanifest",
  "lib/plan.js",
  "lib/passes.js",
  "lib/modes.js",
  "lib/timefmt.js",
  "lib/history.js",
  "lib/sites.js",
  "lib/s1.js",
  "lib/polarmap.js",
  "vendor/maplibre-gl.js",
  "vendor/maplibre-gl.css",
  "vendor/flatgeobuf-geojson.min.js",
  "vendor/tz.js",
  "icons/icon-192.png",
  "data/nisar_modes.json",
  "data/nisar_latency.json",
  "data/nisar_plan_meta.json",
  "data/s1_plan_meta.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || req.headers.has("range") || url.pathname.endsWith(".fgb")) return;

  if (url.pathname.includes("/vendor/") || url.pathname.includes("/icons/")) {
    event.respondWith(caches.match(req).then((hit) => hit || fetchAndCache(req)));
  } else {
    event.respondWith(fetchAndCache(req).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || Response.error())));
  }
});

async function fetchAndCache(req) {
  const res = await fetch(req);
  if (res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
}
