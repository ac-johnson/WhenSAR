// Saved sites, kept in this browser only (localStorage). Each keeps a copy of its frame
// data so it can be shown offline; the copy is refreshed whenever the site is viewed online.

const KEY = "whensar.sites";

export const siteId = (lat, lon) => `${lat.toFixed(4)},${lon.toFixed(4)}`;

export function loadSites() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

function store(sites) {
  try {
    localStorage.setItem(KEY, JSON.stringify(sites));
    return true;
  } catch {
    return false; // private browsing, storage full or blocked
  }
}

export const findSite = (lat, lon) => loadSites().find((s) => s.id === siteId(lat, lon));

export function saveSite(lat, lon, name, frames) {
  const sites = loadSites().filter((s) => s.id !== siteId(lat, lon));
  sites.unshift({ id: siteId(lat, lon), name, lat, lon, saved: new Date().toISOString(), frames });
  return store(sites);
}

export function refreshSite(lat, lon, frames) {
  const sites = loadSites();
  const site = sites.find((s) => s.id === siteId(lat, lon));
  if (!site) return;
  site.frames = frames;
  site.saved = new Date().toISOString();
  store(sites);
}

export function removeSite(id) {
  return store(loadSites().filter((s) => s.id !== id));
}
