// Saved sites, kept in this browser only (localStorage). Each keeps a copy of its data per
// mission ({nisar: frames, s1: {plan, scenes}}) so it can be shown offline; a copy is
// refreshed whenever the site is viewed online in that mission.

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

// A site's saved copy for one mission: {data, saved} or null. Older saves held NISAR frames only.
export function siteData(site, mission) {
  if (!site) return null;
  if (site.data?.[mission]) return site.data[mission];
  if (mission === "nisar" && site.frames) return { data: site.frames, saved: site.saved };
  return null;
}

export function saveSite(lat, lon, name, mission, data) {
  const sites = loadSites().filter((s) => s.id !== siteId(lat, lon));
  const saved = new Date().toISOString();
  sites.unshift({ id: siteId(lat, lon), name, lat, lon, saved, data: { [mission]: { data, saved } } });
  return store(sites);
}

export function refreshSite(lat, lon, mission, data) {
  const sites = loadSites();
  const site = sites.find((s) => s.id === siteId(lat, lon));
  if (!site) return;
  if (site.frames) {
    site.data = { nisar: { data: site.frames, saved: site.saved }, ...site.data }; // migrate older saves
    delete site.frames;
  }
  site.data = { ...site.data, [mission]: { data, saved: new Date().toISOString() } };
  store(sites);
}

export function removeSite(id) {
  return store(loadSites().filter((s) => s.id !== id));
}
