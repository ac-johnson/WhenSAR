"""Merge ESA's Sentinel-1 acquisition plans into a spatially indexed FlatGeobuf.

ESA publishes one KML per satellite every few days, each covering ~3 weeks ahead; newer
files supersede older ones where they overlap (plans change, e.g. for emergency requests).
The files aren't fetchable from a browser (no CORS), so this runs in CI.

Each datatake becomes one feature with its start/stop time, mode, polarisation, relative
orbit and the end points of its centre line, so the app can estimate when the satellite
passes over a given point (start + fraction along track x duration).

Usage: python pipeline/s1_plan.py [--out web/data]
"""

import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import geopandas as gpd
from shapely.geometry import Polygon

import http_session as http

LIST_URL = "https://sentinels.copernicus.eu/copernicus/sentinel-1/acquisition-plans"
FILE_URL = "https://sentinels.copernicus.eu/documents/d/sentinel/{}"
_FILE = re.compile(r"(s1[a-z])_mp_user_(\d{8}t\d{6})_(\d{8}t\d{6})")
_PLACEMARK = re.compile(r"(?s)<Placemark>.*?</Placemark>")
MODES = {"IW", "EW", "SM"}  # wave mode (WV) only images small ocean vignettes


def _t(s):
    return datetime.strptime(s, "%Y%m%dt%H%M%S").replace(tzinfo=timezone.utc)


def plan_files(html, now):
    """Plan files still covering the future, oldest first: [(sat, start, end, name)]."""
    files = {(m[1], _t(m[2]), _t(m[3]), m[0]) for m in _FILE.finditer(html)}
    return sorted((f for f in files if f[2] > now and f[1] > now - timedelta(days=40)), key=lambda f: f[1])


def parse_kml(text):
    """Datatakes in one plan KML."""
    out = []
    for pm in _PLACEMARK.findall(text):
        data = dict(re.findall(r'<Data name="(\w+)">\s*<value>([^<]*)</value>', pm))
        coords = re.search(r"<coordinates>([^<]*)</coordinates>", pm)
        if data.get("Mode") not in MODES or not coords:
            continue
        ring = [tuple(map(float, c.split(",")[:2])) for c in coords[1].split()]
        out.append({
            "sat": data["SatelliteId"],
            "datatake": data["DatatakeId"],
            "mode": data["Mode"],
            "pol": data["Polarisation"],
            "rel_orbit": int(data["OrbitRelative"]),
            "start": datetime.fromisoformat(data["ObservationTimeStart"]).replace(tzinfo=timezone.utc),
            "stop": datetime.fromisoformat(data["ObservationTimeStop"]).replace(tzinfo=timezone.utc),
            "ring": unwrap(ring),
        })
    return out


def unwrap(ring):
    """Make longitudes continuous across the antimeridian (may then exceed +/-180)."""
    out = [ring[0]]
    for x, y in ring[1:]:
        px = out[-1][0]
        while x - px > 180:
            x -= 360
        while x - px < -180:
            x += 360
        out.append((x, y))
    return out


def centre_line(ring):
    """Start and end of the datatake's centre line.

    The ring runs forward along one edge and back along the other, so the first and last
    vertices are the start corners and the middle two are the end corners.
    """
    pts = ring[:-1] if ring[0] == ring[-1] else ring
    n, h = len(pts), len(pts) // 2
    a = ((pts[0][0] + pts[n - 1][0]) / 2, (pts[0][1] + pts[n - 1][1]) / 2)
    b = ((pts[h - 1][0] + pts[h][0]) / 2, (pts[h - 1][1] + pts[h][1]) / 2)
    return a, b


def direction(dt):
    """Ascending or descending from local solar time: Sentinel-1's dawn-dusk orbit crosses
    the equator northbound around 18:00 and southbound around 06:00 local solar time."""
    (ax, ay), (bx, by) = centre_line(dt["ring"])
    mid = dt["start"] + (dt["stop"] - dt["start"]) / 2
    solar = (mid.hour + mid.minute / 60 + ((ax + bx) / 2) / 15) % 24
    return "A" if 12 <= solar < 24 else "D"


def merge(files_datatakes):
    """Newer files replace older ones over the time span they cover: [(sat, start, end, datatakes)]."""
    merged = {}
    for sat, start, end, datatakes in files_datatakes:
        merged = {k: d for k, d in merged.items() if not (d["sat"].lower() == sat and start <= d["start"] <= end)}
        merged.update({(d["sat"], d["datatake"], d["start"]): d for d in datatakes})
    return sorted(merged.values(), key=lambda d: d["start"])


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "web" / "data")
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    session = http.session()
    r = session.get(LIST_URL, timeout=120)
    r.raise_for_status()
    files = plan_files(r.text, now)
    if not files:
        sys.exit("No current Sentinel-1 plan files found; page layout may have changed")

    loaded = []
    for sat, start, end, name in files:
        resp = session.get(FILE_URL.format(name), timeout=300)
        resp.raise_for_status()
        loaded.append((sat, start, end, parse_kml(resp.text)))
        print(f"{name}: {len(loaded[-1][3])} datatakes", flush=True)

    datatakes = [d for d in merge(loaded) if d["stop"] > now - timedelta(days=1)]
    rows = []
    for d in datatakes:
        (ax, ay), (bx, by) = centre_line(d["ring"])
        rows.append({
            "sat": d["sat"],
            "datatake": d["datatake"],
            "mode": d["mode"],
            "pol": d["pol"],
            "path": d["rel_orbit"],
            "dir": direction(d),
            "start": d["start"].strftime("%Y-%m-%dT%H:%M:%SZ"),
            "stop": d["stop"].strftime("%Y-%m-%dT%H:%M:%SZ"),
            "ax": round(ax, 5), "ay": round(ay, 5), "bx": round(bx, 5), "by": round(by, 5),
            "geometry": Polygon(d["ring"]),
        })
    gdf = gpd.GeoDataFrame(rows, crs=4326)
    args.out.mkdir(parents=True, exist_ok=True)
    gdf.to_file(args.out / "s1_plan.fgb", driver="FlatGeobuf", engine="pyogrio", SPATIAL_INDEX="YES")

    ends = {sat: max(g["stop"]) for sat, g in gdf.groupby("sat")}
    meta = {
        "source": LIST_URL,
        "files": [f[3] for f in files],
        "snapshot_utc": now.isoformat(timespec="seconds"),
        "datatakes": len(gdf),
        "plan_end": ends,  # per satellite
    }
    (args.out / "s1_plan_meta.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps({k: v for k, v in meta.items() if k != "files"}, indent=2))


if __name__ == "__main__":
    main()
