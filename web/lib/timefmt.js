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

// "Sun, Oct 25, 4:21 – 8:00 PM PDT", or spanning days: "Sun, Oct 25, 11:21 PM – Mon, Oct 26, 2:00 AM PDT"
export function fmtRange(a, b, timeZone) {
  const day = (d) => new Intl.DateTimeFormat(undefined, { timeZone, weekday: "short", month: "short", day: "numeric" }).format(d);
  const clock = (d, zoneName) =>
    new Intl.DateTimeFormat(undefined, { timeZone, hour: "numeric", minute: "2-digit", ...(zoneName && { timeZoneName: "short" }) }).format(d);
  return day(a) === day(b)
    ? `${day(a)}, ${clock(a)} – ${clock(b, true)}`
    : `${day(a)}, ${clock(a)} – ${day(b)}, ${clock(b, true)}`;
}

// Calendar day ("YYYY-MM-DD") of a moment at the point
export function dayString(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// Start of a calendar day ("YYYY-MM-DD") in a time zone, as epoch ms
export function zonedMidnight(day, timeZone) {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const offset = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(t).map((x) => [x.type, x.value]));
    return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) - t;
  };
  // Second pass settles days where the offset changes (daylight saving)
  const t = guess - offset(guess);
  return guess - offset(t);
}
