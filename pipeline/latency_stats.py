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
from nisar_names import parse

ASF_SEARCH = "https://api.daac.asf.alaska.edu/services/search/param"
PRODUCTS = ["RSLC", "GSLC", "GCOV", "GUNW"]
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
        name = parse(g["sceneName"])
        if not name or not g.get("processingDate"):
            continue
        key = (name["track"], name["frame"], g["stopTime"])
        hours = (_ts(g["processingDate"]) - _ts(g["stopTime"])).total_seconds() / 3600
        first[key] = min(hours, first.get(key, hours))
    return list(first.values())


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

    result["generated_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "nisar_latency.json").write_text(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
