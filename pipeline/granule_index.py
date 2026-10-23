"""Maintain a per-frame index of NISAR acquisitions and products from CMR.

For every track/frame, records which 12-day cycles produced each product type, so the web
app can show history, regularity and product frequency without querying CMR live.

- RSLC: full archive, with granule names (exact start time, mode, coverage, browse image).
- Other products: last PRODUCT_DAYS days, acquisition date per cycle (the secondary
  acquisition for interferogram/offset pairs).

The first run backfills (~20 min); later runs fetch only granules CMR has updated since the
previous run (~1 min), which also picks up back-processed data.

Cache: pipeline/cache/granule_index.json
Usage: python pipeline/granule_index.py [--full]
"""

import argparse
import json
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path


import http_session as http
from nisar_names import parse

CMR_GRANULES_XML = "https://cmr.earthdata.nasa.gov/search/granules.xml"
# *_PROVISIONAL_V1 collections
COLLECTIONS = {
    "RSLC": "C2853145197-ASF",
    "GSLC": "C2854332392-ASF",
    "GCOV": "C2854338529-ASF",
    "RIFG": "C2853147928-ASF",
    "RUNW": "C2853153429-ASF",
    "ROFF": "C2853156054-ASF",
    "GUNW": "C2854335566-ASF",
    "GOFF": "C2854341702-ASF",
    "SME2": "C2854344945-ASF",
}
ARCHIVE_START = datetime(2025, 10, 1, tzinfo=timezone.utc)  # before the first NISAR RSLC
PRODUCT_DAYS = 120  # kept for non-RSLC products; the app shows the last 90
PAGE_SIZE = 2000
CACHE = Path(__file__).resolve().parent / "cache" / "granule_index.json"
_NAME = re.compile(r"<name>([^<]+)</name>")


def frame_key(track, direction, frame):
    return f"{track:03d}_{direction}_{frame:03d}"


def granule_names(session, collection, **filters):
    """Yield granule names from CMR's compact XML references, following CMR-Search-After paging."""
    params = {"collection_concept_id": collection, "page_size": PAGE_SIZE, "sort_key": "start_date", **filters}
    headers = {}
    while True:
        r = session.get(CMR_GRANULES_XML, params=params, headers=headers, timeout=300)
        r.raise_for_status()
        names = _NAME.findall(r.text)
        if names:
            print(f"  {collection}: page through {names[-1][-60:-25]}", flush=True)
        yield from names
        after = r.headers.get("CMR-Search-After")
        if len(names) < PAGE_SIZE or not after:
            return
        headers["CMR-Search-After"] = after


def _rank(g):
    return (g["full_frame"], g["crid"], g["counter"])


def add(index, name):
    """Record one granule. index[frame][product][cycle] = RSLC name, or YYYYMMDD for other products."""
    g = parse(name)
    if not g or g["pipeline"] != "PR":
        return
    product = g["product"]
    frame = index.setdefault(frame_key(g["track"], g["dir"], g["frame"]), {}).setdefault(product, {})
    if g.get("cycle2") is not None:  # pair product: belongs to its secondary acquisition
        cycle, when = g["cycle2"], g["sec_start"]
    else:
        cycle, when = g["cycle"], g["start"]
    cycle = str(cycle)
    if product == "RSLC":
        # Reprocessing leaves several granules per acquisition, and a frame split across two
        # datatakes yields two partial ones: prefer full frames, then the latest CRID and counter
        old = parse(frame[cycle]) if cycle in frame else None
        if not old or _rank(g) > _rank(old):
            frame[cycle] = name
    else:
        frame[cycle] = f"{when:%Y%m%d}"


def frame_summary(products):
    """Compact per-frame properties for the web app (see snapshot_rop.py)."""
    rslc = sorted((parse(n) for n in products.get("RSLC", {}).values()), key=lambda g: g["start"], reverse=True)
    if not rslc:
        return {"ref_start": None, "last_mode": None, "last_pol": None, "latest_rslc": None, "acq": None, "products": None}
    # Reference for timing and mode: the latest full frame (partial frames start late or early)
    ref = next((g for g in rslc if g["full_frame"]), rslc[0])
    return {
        "ref_start": f"{ref['start']:%Y-%m-%dT%H:%M:%SZ}",
        "last_mode": ref["mode"],  # filename codes, e.g. "4005" / "DHDH"
        "last_pol": ref["pol"],
        "latest_rslc": rslc[0]["name"],
        # Every acquisition, newest first: "YYYYMMDDTHHMMSS MODE POL F|P;..."
        "acq": ";".join(f"{g['start']:%Y%m%dT%H%M%S} {g['mode']} {g['pol']} {g['coverage']}" for g in rslc),
        # Recent acquisition dates that produced each other product type
        "products": json.dumps(
            {p: ",".join(sorted(c.values(), reverse=True)) for p, c in sorted(products.items()) if p != "RSLC" and c},
            separators=(",", ":"),
        ),
    }


def prune(index, now):
    cutoff = f"{now - timedelta(days=PRODUCT_DAYS):%Y%m%d}"
    for products in index.values():
        for product, cycles in products.items():
            if product != "RSLC":
                for cycle in [c for c, day in cycles.items() if day < cutoff]:
                    del cycles[cycle]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--full", action="store_true", help="rebuild from scratch instead of updating")
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    cache = {} if args.full or not CACHE.exists() else json.loads(CACHE.read_text())
    index = cache.get("frames", {})
    session = http.session()
    counts = defaultdict(int)

    for product, collection in COLLECTIONS.items():
        if "updated_through" in cache:
            # A day of overlap guards against clock skew and slow CMR ingestion
            since = datetime.fromisoformat(cache["updated_through"]) - timedelta(days=1)
            filters = {"updated_since": f"{since:%Y-%m-%dT%H:%M:%SZ}"}
        else:
            start = ARCHIVE_START if product == "RSLC" else now - timedelta(days=PRODUCT_DAYS)
            filters = {"temporal": f"{start:%Y-%m-%dT%H:%M:%SZ},"}
        for name in granule_names(session, collection, **filters):
            add(index, name)
            counts[product] += 1
        print(f"{product}: {counts[product]} granules", flush=True)

    prune(index, now)
    CACHE.parent.mkdir(exist_ok=True)
    CACHE.write_text(json.dumps({"updated_through": now.isoformat(timespec="seconds"), "frames": index}))
    print(f"{len(index)} frames indexed in {CACHE}")


if __name__ == "__main__":
    main()
