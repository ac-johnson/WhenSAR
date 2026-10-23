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
python pipeline/snapshot_rop.py        # writes web/data/nisar_plan.fgb
python -m http.server -d web 8000      # open http://localhost:8000
```

## Data sources
- NISAR Reference Observation Plan (ASF ArcGIS feature service)
- ASF SearchAPI for past acquisitions (no login required)

No credentials are needed to run the app. Never commit credentials; this repo uses
[git-secrets](https://github.com/awslabs/git-secrets) hooks.
