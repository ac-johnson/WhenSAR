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
python pipeline/s1_plan.py             # Sentinel-1 plan from ESA (~30 s)
python pipeline/s1_index.py            # Sentinel-1 acquisitions (ASF; first run ~25 min)
python pipeline/latency_stats.py       # measured product latency (ASF/CMR, ~5 min)
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

## Planning for a later date
The calendar button on a location picks a day up to a year ahead. A first card then lists
every pass over the point in the 12 days from that day (one full repeat cycle), across all
tracks, in local time; each card shows its first pass from that day. Links keep the date,
e.g. `#34.05,-118.25/2027-03-15`, so a schedule can be shared. Passes past the published
plans are projected on the 12-day repeat and labelled.

## Sentinel-1 mode
Switch with the NISAR | Sentinel-1 control (links look like `#s1/lat,lon`). Cards are per
track (relative orbit + direction); Sentinel-1C and 1D alternate on the same tracks.
- Upcoming passes: ESA's acquisition plans (~3 weeks ahead, merged every 6 hours by
  `pipeline/s1_plan.py`); the time over the point is interpolated along each datatake.
  Beyond the plan, each satellite's 12-day repeat is projected (dashed).
- Repeat: 6 days where both Sentinel-1C and 1D cover the track, 12 where one does.
- History: acquisitions over the last 100 days from ASF RAW, SLC and medium-resolution GRD
  footprints (`pipeline/s1_index.py`); Extra Wide swath over sea ice is GRD-only.
- Products · last 90 days: share of *expected* passes (from the 6/12-day repeat) that were
  acquired, and that produced SLC, GRD, OPERA RTC and CSLC (products queried live from CMR);
  OPERA DISP and ARIA GUNW show their latest dates.
- Interferograms: no systematic global product; the card links to ASF HyP3 on-demand InSAR
  and notes ARIA GUNW where it exists.

## Map projections
The selector at the top right switches between Geographic (MapLibre, Web Mercator) and
Arctic / Antarctic polar stereographic views (EPSG:3413 / 3031; OpenLayers with NASA GIBS
Blue Marble tiles, loaded only when first chosen). The choice is remembered in the browser.

## Phone / offline use
WhenSAR is a Progressive Web App: open the site on a phone and use the browser's
"Add to Home Screen" / "Install app" to get an app icon. Tap ☆ on a location to save it;
saved sites (★ list) keep a copy of their frame data in the browser, so they open
offline, e.g. in the field. The basemap itself needs a connection.

Passes beyond the end of the published observation plan are projected on the same
12-day pattern and mode and shown dashed / labelled "projected".

## Data sources (all public, no login)
- NISAR Reference Observation Plan (ASF ArcGIS feature service)
- NASA CMR for acquisition history, frame start times and product frequency, precomputed
  every 6 hours so the app makes no live catalog queries
- ASF SearchAPI for processing dates (latency)

## License
MIT, see [LICENSE](LICENSE). Third-party libraries in `web/vendor/` keep their own licences.
