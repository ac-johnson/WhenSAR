"""Snapshot the NISAR Reference Observation Plan (ROP) into a spatially indexed FlatGeobuf.

Source: ASF's public ArcGIS feature service behind the ROP viewer. One feature per
track/frame that has planned observations; each carries every planned date and the
radar mode(s) planned on that date.

Usage: python pipeline/snapshot_rop.py [--out web/data]
"""

import argparse
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import requests

from frame_times import CACHE as FRAME_TIMES, frame_key

ROP_LAYER = (
    "https://services7.arcgis.com/WSiUmUhlFx4CtMBB/arcgis/rest/services/"
    "nisar_merged_observation_plans/FeatureServer/0"
)
PAGE_SIZE = 2000
REQUIRED_FIELDS = {
    "track", "frame", "passdirection", "acquisition_time", "date_mode_popup",
    "radar_mode_combination_1", "radar_mode_mnemonic_combination_1",
}
PRODUCTS = ["rslc", "gslc", "gcov", "rifg", "runw", "roff", "gunw", "goff", "smst"]


def layer_info(session):
    r = session.get(ROP_LAYER, params={"f": "json"}, timeout=60)
    r.raise_for_status()
    info = r.json()
    missing = REQUIRED_FIELDS - {f["name"] for f in info["fields"]}
    if missing:
        sys.exit(f"ROP layer schema changed; missing fields: {sorted(missing)}")
    return info


def fetch_features(session):
    features, offset = [], 0
    while True:
        r = session.get(
            f"{ROP_LAYER}/query",
            params={
                "where": "1=1",
                "outFields": "*",
                "outSR": 4326,
                "orderByFields": "fid",
                "resultOffset": offset,
                "resultRecordCount": PAGE_SIZE,
                "f": "geojson",
            },
            timeout=120,
        )
        r.raise_for_status()
        page = r.json().get("features", [])
        features.extend(page)
        if len(page) < PAGE_SIZE:
            return features
        offset += PAGE_SIZE


def parse_date_modes(popup):
    """'2025-09-24 | 214,153\\n2025-10-06 | 214' -> [['2025-09-24', [214, 153]], ['2025-10-06', [214]]]"""
    passes = []
    for line in popup.strip().splitlines():
        day, _, modes = line.partition("|")
        passes.append([day.strip(), [int(m) for m in modes.split(",") if m.strip()]])
    return passes


def mode_table(features):
    """Global radar-mode number -> mnemonic table.

    Per-frame `unique_*` lists are deduplicated independently and don't align, so pair the
    `radar_mode_combination_N` / `radar_mode_mnemonic_combination_N` lists instead and take
    the most common mnemonic for each number. Mode 000 is a placeholder with no fixed mnemonic.
    """
    votes = defaultdict(Counter)
    for f in features:
        p = f["properties"]
        for n in range(1, 10):
            ids, names = p.get(f"radar_mode_combination_{n}"), p.get(f"radar_mode_mnemonic_combination_{n}")
            if not ids or ids == "None" or not names:
                continue
            ids, names = ids.split(","), names.split(",")
            if len(ids) == len(names):
                for i, name in zip(ids, names):
                    votes[int(i)][name.strip()] += 1
    table = {i: c.most_common(1)[0][0] for i, c in sorted(votes.items()) if i != 0}
    table[0] = None
    return table


def normalize(feature, frame_times):
    p = feature["properties"]
    passes = parse_date_modes(p["date_mode_popup"])
    direction = p["passdirection"][0].upper()  # 'A' or 'D'
    seen = frame_times.get(frame_key(int(p["track"]), direction, int(p["frame"]))) or {}
    return {
        "mission": "NISAR",
        "track": int(p["track"]),
        "frame": int(p["frame"]),
        "dir": direction,
        "datatake_utc": ",".join(t.strip() for t in p["acquisition_time"].split(",")),
        "passes": json.dumps(passes, separators=(",", ":")),
        "produce": ",".join(k for k in PRODUCTS if str(p.get(f"produce{k}")) == "1"),
        "plan_end": passes[-1][0] if passes else None,
        # Most recent actual acquisition of this frame (see frame_times.py); None if never seen
        "ref_start": seen.get("start"),
        "last_mode": seen.get("mode"),  # filename codes, e.g. "4005" / "DHDH"
        "last_pol": seen.get("pol"),
        "geometry": feature["geometry"],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "web" / "data")
    args = ap.parse_args()

    session = requests.Session()
    info = layer_info(session)
    raw = fetch_features(session)
    frame_times = json.loads(FRAME_TIMES.read_text()) if FRAME_TIMES.exists() else {}
    if not frame_times:
        print(f"warning: {FRAME_TIMES} missing; next-pass times will be datatake-approximate", file=sys.stderr)
    rows = [normalize(f, frame_times) for f in raw if f.get("geometry")]
    if len(rows) < 10000:
        sys.exit(f"Only {len(rows)} ROP frames fetched; refusing to overwrite snapshot")

    gdf = gpd.GeoDataFrame.from_features(
        [{"type": "Feature", "geometry": r.pop("geometry"), "properties": r} for r in rows], crs=4326
    )
    args.out.mkdir(parents=True, exist_ok=True)
    gdf.to_file(args.out / "nisar_plan.fgb", driver="FlatGeobuf", engine="pyogrio", SPATIAL_INDEX="YES")

    meta = {
        "source": ROP_LAYER,
        "source_last_edit": datetime.fromtimestamp(
            info["editingInfo"]["lastEditDate"] / 1000, timezone.utc
        ).isoformat(),
        "snapshot_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "frames": len(gdf),
        "frames_with_ref_start": int(gdf["ref_start"].notna().sum()),
        "plan_end": max(gdf["plan_end"].dropna()),
    }
    (args.out / "nisar_plan_meta.json").write_text(json.dumps(meta, indent=2))
    (args.out / "nisar_modes.json").write_text(json.dumps(mode_table(raw), indent=1))
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
