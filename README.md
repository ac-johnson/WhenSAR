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
python pipeline/frame_times.py         # actual frame start times + flown modes (CMR, ~3 min)
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
- Product availability = pass time + measured median latency (nightly sample of ASF
  processing dates), including Urgent Response products.

## Data sources (all public, no login)
- NISAR Reference Observation Plan (ASF ArcGIS feature service)
- NASA CMR for acquisition history and frame start times
- ASF SearchAPI for processing dates (latency)

No credentials are needed to run the app. Never commit credentials; this repo uses
[git-secrets](https://github.com/awslabs/git-secrets) hooks.
