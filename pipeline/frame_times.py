"""Record each frame's actual start time from recent RSLC granules.

The ROP only gives a datatake start time shared by every frame in the datatake; the real
frame start is up to minutes later. NISAR repeats its orbit exactly every 12 days, so a
frame's last actual start + N*12 days predicts future starts to about a second.

Also records the mode actually flown, since the published plan's modes can lag reality.

Writes pipeline/cache/frame_times.json:
  {"034_A_019": {"start": "2026-10-14T13:08:23Z", "mode": "4005", "pol": "DHDH"}, ...}
Usage: python pipeline/frame_times.py [--days 24]
"""

import argparse
import csv
import io
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from nisar_names import parse

CMR_GRANULES_CSV = "https://cmr.earthdata.nasa.gov/search/granules.csv"
RSLC_COLLECTION = "C2853145197-ASF"  # NISAR_L1_RSLC_PROVISIONAL_V1
PAGE_SIZE = 2000
CACHE = Path(__file__).resolve().parent / "cache" / "frame_times.json"


def frame_key(track, direction, frame):
    return f"{track:03d}_{direction}_{frame:03d}"


def granule_names(session, start, end):
    """Yield granule URs from CMR, following CMR-Search-After paging."""
    params = {
        "collection_concept_id": RSLC_COLLECTION,
        "temporal": f"{start:%Y-%m-%dT%H:%M:%SZ},{end:%Y-%m-%dT%H:%M:%SZ}",
        "page_size": PAGE_SIZE,
        "sort_key": "start_date",
    }
    headers = {}
    while True:
        r = session.get(CMR_GRANULES_CSV, params=params, headers=headers, timeout=300)
        r.raise_for_status()
        rows = list(csv.DictReader(io.StringIO(r.text)))
        for row in rows:
            yield row["Granule UR"]
        after = r.headers.get("CMR-Search-After")
        if len(rows) < PAGE_SIZE or not after:
            return
        headers["CMR-Search-After"] = after


def latest_starts(names):
    """Latest start per frame, preferring full-frame granules over partial ones."""
    best = {}
    for name in names:
        g = parse(name)
        if not g or g["pipeline"] != "PR":
            continue
        key = frame_key(g["track"], g["dir"], g["frame"])
        rank = (g["full_frame"], g["start"])
        if key not in best or rank > best[key][0]:
            best[key] = (rank, g)
    return {
        k: {"start": g["start"].strftime("%Y-%m-%dT%H:%M:%SZ"), "mode": g["mode"], "pol": g["pol"]}
        for k, (_, g) in sorted(best.items())
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=24, help="look-back window (24 = two cycles)")
    args = ap.parse_args()

    end = datetime.now(timezone.utc)
    start = end - timedelta(days=args.days)
    times = latest_starts(granule_names(requests.Session(), start, end))

    # Keep entries for frames not seen in this window (e.g. skipped cycles)
    previous = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    previous = {k: v for k, v in previous.items() if isinstance(v, dict)}  # drop old string-only format
    merged = previous | times
    CACHE.parent.mkdir(exist_ok=True)
    CACHE.write_text(json.dumps(merged, indent=0))
    print(f"{len(times)} frames from last {args.days} days; {len(merged)} total in {CACHE}")


if __name__ == "__main__":
    main()
