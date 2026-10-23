"""Measure NISAR product latency (acquisition end -> ASF processing date) per product type.

Samples granules acquired 7-13 days ago (old enough that almost all have been processed,
so slow ones aren't censored), one day at a time to keep ASF queries small.

Writes web/data/nisar_latency.json: {"GUNW": {"p50": 52.1, "p90": 77.0, "n": 600}, ...} (hours)
Usage: python pipeline/latency_stats.py
"""

import argparse
import json
import statistics
from datetime import datetime, timedelta, timezone
from pathlib import Path

import http_session as http

ASF_SEARCH = "https://api.daac.asf.alaska.edu/services/search/param"
CMR_UMM = "https://cmr.earthdata.nasa.gov/search/granules.umm_json"
# Sentinel-1 products: ASF's processingDate is the acquisition time, so use CMR insert dates
S1_COLLECTIONS = {
    "S1_SLC": ["C3470873558-ASF", "C4175278193-ASF"],  # SENTINEL-1C_SLC, SENTINEL-1D_SLC
    # SENTINEL-1C/1D_DP_GRD_HIGH and _MEDIUM (medium resolution: Extra Wide swath, e.g. sea ice)
    "S1_GRD": ["C3486566209-ASF", "C4163054563-ASF", "C3486605959-ASF", "C4174076966-ASF"],
    "S1_RTC": ["C2777436413-ASF"],  # OPERA_L2_RTC-S1_V1
    "S1_CSLC": ["C2777443834-ASF"],  # OPERA_L2_CSLC-S1_V1
}
PRODUCTS = ["L0B", "RSLC", "GSLC", "GCOV", "GUNW"]
PER_DAY = 100


def _ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def sample(session, product, day, pipeline):
    r = session.get(
        ASF_SEARCH,
        params={
            "dataset": "NISAR",
            "processingLevel": product,
            "productionConfiguration": pipeline,
            "start": f"{day:%Y-%m-%dT00:00:00Z}",
            "end": f"{day + timedelta(days=1):%Y-%m-%dT00:00:00Z}",
            "maxResults": PER_DAY,
            "output": "geojson",
        },
        timeout=120,
    )
    r.raise_for_status()
    return [f["properties"] for f in r.json()["features"]]


def latencies(granules):
    """Hours from acquisition end to first processing; reprocessed copies are ignored."""
    first = {}
    for g in granules:
        if not g.get("processingDate"):
            continue
        # One acquisition (L0B has no frame, so key on ASF's fields rather than the name)
        key = (g.get("pathNumber"), g.get("frameNumber"), g["stopTime"])
        hours = (_ts(g["processingDate"]) - _ts(g["stopTime"])).total_seconds() / 3600
        first[key] = min(hours, first.get(key, hours))
    return list(first.values())


def cmr_insert_latencies(session, collections, start, end, per_collection=300):
    """Hours from acquisition end to CMR insert (when the granule became searchable)."""
    hours = []
    for c in collections:
        r = session.get(
            CMR_UMM,
            params={"collection_concept_id": c, "temporal": f"{start:%Y-%m-%dT%H:%M:%SZ},{end:%Y-%m-%dT%H:%M:%SZ}",
                    "page_size": per_collection, "sort_key": "-start_date"},
            timeout=300,
        )
        r.raise_for_status()
        for item in r.json()["items"]:
            u = item["umm"]
            inserted = next((p["Date"] for p in u.get("ProviderDates", []) if p["Type"] == "Insert"), None)
            if inserted:
                end_t = u["TemporalExtent"]["RangeDateTime"]["EndingDateTime"]
                hours.append((_ts(inserted) - _ts(end_t)).total_seconds() / 3600)
    return hours


def summarize(hours):
    if len(hours) < 10:
        return None
    q = statistics.quantiles(hours, n=10)
    return {"p50": round(statistics.median(hours), 1), "p90": round(q[8], 1), "n": len(hours)}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "web" / "data")
    args = ap.parse_args()

    session = http.session()
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    result = {"source": f"measured {today - timedelta(days=13):%b %d}–{today - timedelta(days=7):%b %d}"}

    for product in PRODUCTS:
        hours = []
        for back in range(7, 14):
            hours += latencies(sample(session, product, today - timedelta(days=back), "PR"))
        result[product] = summarize(hours)
        print(product, result[product])

    # Urgent Response products are rare and kept 30 days; report them if any exist
    for product in ["GCOV", "GUNW"]:
        hours = []
        for back in range(1, 30):
            hours += latencies(sample(session, product, today - timedelta(days=back), "UR"))
        result[f"UR_{product}"] = summarize(hours) if len(hours) >= 10 else ({"n": len(hours)} if hours else None)
        print("UR", product, result[f"UR_{product}"])

    # Sentinel-1: sample acquisitions from 6-9 days ago (old enough that slow ones have arrived)
    for key, collections in S1_COLLECTIONS.items():
        result[key] = summarize(cmr_insert_latencies(session, collections, today - timedelta(days=9), today - timedelta(days=6)))
        print(key, result[key])

    result["generated_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "nisar_latency.json").write_text(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
