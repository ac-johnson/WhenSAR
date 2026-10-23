# WhenSAR

Pick a point on a map → see which SAR track/frames cover it, **when the next acquisition is**
(in local time), what mode it collects in, when products should become available, and how
regularly the scene has been acquired in the past. NISAR first; Sentinel-1 later.

Status: early development.

## Layout
- `web/` — static site (vanilla JS, no build step)
- `pipeline/` — Python jobs that snapshot the NISAR observation plan and compute latency stats
- `tests/` — pytest

## Local development
```bash
mamba env create -f environment.yml
conda activate whensar
python pipeline/granule_index.py       # per-frame acquisitions + products (CMR; first run ~20 min, then ~1 min)
python pipeline/snapshot_rop.py        # plan snapshot -> web/data/nisar_plan.fgb
python pipeline/latency_stats.py       # measured product latency (ASF, ~4 min)
python serve.py 8000                   # open http://localhost:8000
```
`serve.py` is used instead of `python -m http.server` because the plan file is read with
HTTP range requests. `python tests/browser_smoke.py` screenshots a few test points
(needs `pip install playwright` and Chrome).

## How "next pass" is computed
- Planned dates and modes come from the NISAR Reference Observation Plan.
- The plan's time is the *datatake* start, shared by every frame in it. The exact frame
  time comes from the frame's most recent real acquisition + N × 12 days (exact repeat
  orbit, ~1 s). Frames never acquired yet show the datatake time, marked "approx."
- The published plan's mode can differ from what is actually flown (~6% of frames,
  mostly 77 MHz planned vs 40+5 MHz flown); the card notes this when it happens.
- Frames that are planned but have never produced data are left off the map. Frames not
  acquired in the last 90 days sort last, with a warning.
- Product availability = pass time + measured median to 90th-percentile latency (nightly
  sample of ASF processing dates), shown as local clock times. Urgent Response timing is
  behind a toggle; standard products (corrected orbit) stay the main estimate.
- "Products · last 90 days" = share of planned passes that produced each product type
  (passes still within normal processing time are excluded).

## Data sources (all public, no login)
- NISAR Reference Observation Plan (ASF ArcGIS feature service)
- NASA CMR for acquisition history, frame start times and product frequency, precomputed
  every 6 hours so the app makes no live catalog queries
- ASF SearchAPI for processing dates (latency)

No credentials are needed to run the app. Never commit credentials; this repo uses
[git-secrets](https://github.com/awslabs/git-secrets) hooks.
