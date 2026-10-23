// Time display: local time at the clicked point (IANA zone via tz-lookup), plus UTC.

export function zoneAt(lat, lon) {
  try {
    return tzlookup(lat, lon);
  } catch {
    return "UTC";
  }
}

export function fmtLocal(date, timeZone) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function fmtDate(date, timeZone) {
  const opts = { timeZone, month: "short", day: "numeric" };
  if (date.getUTCFullYear() !== new Date().getUTCFullYear()) opts.year = "numeric";
  return new Intl.DateTimeFormat(undefined, opts).format(date);
}

export function fmtUTC(date) {
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
