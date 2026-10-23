// Turn a plan frame (from nisar_plan.fgb) into concrete pass datetimes.
//
// The ROP lists planned dates plus a datatake start time shared by all frames in the
// datatake. When we know a recent actual start of this frame (ref_start), the orbit's
// exact 12-day repeat gives the frame's start to about a second.

const DAY = 86400e3;
const CYCLE = 12 * DAY;

export function framePasses(props) {
  const planned = JSON.parse(props.passes); // [["2026-10-26", [238]], ...]
  const datatake = (props.datatake_utc || "00:00:00").split(",")[0];
  const ref = props.ref_start ? Date.parse(props.ref_start) : null;

  return planned.map(([date, modes]) => {
    const approx = Date.parse(`${date}T${datatake}Z`);
    let t = approx;
    let exact = false;
    if (ref !== null) {
      const k = Math.round((approx - ref) / CYCLE);
      const candidate = ref + k * CYCLE;
      // The frame starts at or a few minutes after its datatake start
      if (Math.abs(candidate - approx) < DAY / 2) {
        t = candidate;
        exact = true;
      }
    }
    return { time: new Date(t), exact, modes };
  });
}

// Index of the first pass that hasn't finished yet (frames take ~35 s)
export function nextIndex(passes, now = Date.now()) {
  return passes.findIndex((p) => p.time.getTime() + 60e3 > now);
}

export function countdown(ms) {
  if (ms < 0) return "now";
  const m = Math.floor(ms / 60e3);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `in ${d} d ${h} h`;
  if (h > 0) return `in ${h} h ${m % 60} min`;
  return `in ${m % 60} min`;
}
