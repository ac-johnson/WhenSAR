"""Index recent Sentinel-1 acquisitions (footprints) into a spatially indexed FlatGeobuf.

An acquisition counts if any of its RAW, SLC or medium-resolution GRD products covers the
point: RAW exists for every acquisition but ASF's RAW footprints are narrower than the
swath, SLC footprints are accurate but SLCs aren't made for everything, and Extra Wide swath
(e.g. over sea ice) is processed to GRD only.

The app groups the scenes covering a point by relative orbit (path) and direction to show
each track's history, how complete it is against the 6/12-day repeat, and to project passes
beyond ESA's ~3-week plan.

Keeps the last KEEP_DAYS days. The first run backfills one day at a time (~25 min); later
runs re-fetch only the last few days (data reaches ASF within ~1 day).

Cache: pipeline/cache/s1_products.json; output: web/data/s1_scenes.fgb
Usage: python pipeline/s1_index.py [--full]
"""

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import geopandas as gpd
from shapely import wkt

import http_session as http

ASF_SEARCH = "https://api.daac.asf.alaska.edu/services/search/param"
PLATFORMS = "SENTINEL-1C,SENTINEL-1D"  # Sentinel-1A ended operations 2026-06-30
KEEP_DAYS = 100
REFRESH_DAYS = 4
CACHE = Path(__file__).resolve().parent / "cache" / "s1_products.json"


LEVELS = ["RAW", "SLC", "GRD_MD"]


def fetch_day(session, day, level):
    r = session.get(
        ASF_SEARCH,
        params={
            "platform": PLATFORMS,
            "processingLevel": level,
            "beamMode": "IW,EW,SM",
            "start": f"{day:%Y-%m-%dT00:00:00Z}",
            "end": f"{day + timedelta(days=1):%Y-%m-%dT00:00:00Z}",
            "output": "jsonlite",
        },
        timeout=300,
    )
    r.raise_for_status()
    return r.json()["results"]


def record(r):
    return {
        "sat": r["granuleName"][:3],  # S1C / S1D
        "product": r["granuleName"][7:10],  # RAW / SLC / GRD
        "path": int(r["path"]),
        "dir": r["flightDirection"][0],  # A / D
        "mode": r["beamMode"],
        "pol": r["polarization"],
        "start": r["startTime"],
        "stop": r["stopTime"],
        "wkt": r.get("wkt_unwrapped") or r["wkt"],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--full", action="store_true", help="rebuild from scratch")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "web" / "data")
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    scenes = {} if args.full or not CACHE.exists() else json.loads(CACHE.read_text())
    days = REFRESH_DAYS if scenes else KEEP_DAYS
    session = http.session()
    for back in range(days, -1, -1):
        day = today - timedelta(days=back)
        counts = []
        for level in LEVELS:
            results = fetch_day(session, day, level)
            scenes.update({r["granuleName"]: record(r) for r in results})
            counts.append(f"{len(results)} {level}")
        print(f"{day:%Y-%m-%d}: {', '.join(counts)}", flush=True)

    cutoff = f"{today - timedelta(days=KEEP_DAYS):%Y-%m-%d}"
    scenes = {k: v for k, v in scenes.items() if v["start"] >= cutoff}
    CACHE.parent.mkdir(exist_ok=True)
    CACHE.write_text(json.dumps(scenes))

    rows = [{**{k: v for k, v in s.items() if k != "wkt"}, "geometry": wkt.loads(s["wkt"])} for s in scenes.values()]
    gdf = gpd.GeoDataFrame(rows, crs=4326)
    args.out.mkdir(parents=True, exist_ok=True)
    gdf.to_file(args.out / "s1_scenes.fgb", driver="FlatGeobuf", engine="pyogrio", SPATIAL_INDEX="YES")
    print(f"{len(gdf)} scenes since {cutoff} -> {args.out / 's1_scenes.fgb'}")


if __name__ == "__main__":
    main()
