// Decode NISAR radar-mode mnemonics, e.g. "L:SCI:DH:40M+05N:FS:B4:D02  S:DB:DH:37W:B4"
// Format reference: https://nisar-docs.asf.alaska.edu/observation-plan/

const POL = {
  SH: "single-pol HH",
  SV: "single-pol VV",
  DH: "dual-pol HH/HV",
  DV: "dual-pol VV/VH",
  QP: "quad-pol",
  QD: "quasi-dual (HH lower band + VV upper band)",
  QQ: "quasi-quad (HH/HV lower band + VV/VH upper band)",
  CP: "compact-pol",
};

function bandwidth(bw) {
  // "40M+05N" -> "40+5 MHz"; "05W+---" -> "5 MHz"; "37W" -> "37 MHz"
  const parts = bw.split("+").filter((p) => !p.startsWith("-")).map((p) => parseInt(p, 10));
  return `${parts.join("+")} MHz`;
}

export function describeMode(mnemonic) {
  if (!mnemonic) return { short: "mode not specified", lband: null, sband: null };
  const out = { lband: null, sband: null };
  for (const part of mnemonic.trim().split(/\s+/)) {
    const f = part.split(":");
    if (f[0] === "L") {
      out.lband = { pol: f[2], text: `L-band ${POL[f[2]] || f[2]}, ${bandwidth(f[3])}${f[4] === "HS" ? ", half swath" : ""}` };
    } else if (f[0] === "S") {
      out.sband = { pol: f[2], text: `S-band ${POL[f[2]] || f[2]}, ${bandwidth(f[3])}` };
    }
  }
  out.short = [out.lband?.text, out.sband ? "+ S-band" : null].filter(Boolean).join(" ") || mnemonic;
  return out;
}

// Bandwidth set (MHz) of the L-band part of a plan mnemonic, e.g. "40M+05N" -> [5, 40]
export function planBandwidths(mnemonic) {
  const l = (mnemonic || "").split(/\s+/).find((p) => p.startsWith("L:"));
  if (!l) return null;
  const f = l.split(":");
  const bws = f[3].split("+").filter((p) => !p.startsWith("-")).map((p) => parseInt(p, 10));
  // QD/QQ put the same bandwidth on both lower and upper bands
  if ((f[2] === "QD" || f[2] === "QQ") && bws.length === 1) bws.push(bws[0]);
  return bws.sort((a, b) => a - b);
}

// Granule-name mode/pol codes, e.g. ("4005", "DHDH") or ("0005", "NASV"); band A then band B
export function fileBandwidths(mode) {
  return [+mode.slice(0, 2), +mode.slice(2)].filter(Boolean).sort((a, b) => a - b);
}

export function describeFileMode(mode, pol) {
  const bands = [[mode.slice(0, 2), pol.slice(0, 2)], [mode.slice(2), pol.slice(2)]].filter(([bw]) => +bw);
  const pols = [...new Set(bands.map(([, p]) => p).filter((p) => p !== "NA"))];
  return `L-band ${pols.map((p) => POL[p] || p).join(" / ")}, ${bands.map(([bw]) => +bw).join("+")} MHz`;
}

export const sameBandwidths = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
