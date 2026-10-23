"""Parse NISAR granule names (JPL D-102255 Rev C file naming convention)."""

import re
from datetime import datetime, timezone

_T = r"\d{8}T\d{6}"
_TAIL = r"_(?P<crid>[A-Z]\d{5})_(?P<orbit_acc>[A-Z])_(?P<coverage>[FP])_(?P<loc>[A-Z])_(?P<counter>\d{3})"
_HEAD = (
    r"NISAR_(?P<band>[LS])(?P<level>\d)_(?P<pipeline>PR|UR|OD)_(?P<product>[A-Z0-9]{4})"
    r"_(?P<cycle>\d{3})_(?P<track>\d{3})_(?P<dir>[AD])_(?P<frame>\d{3})"
)

# RSLC, GSLC, GCOV, SME2: one acquisition
SINGLE = re.compile(
    _HEAD + rf"_(?P<mode>\d{{4}})_(?P<pol>[A-Z]{{4}})_(?P<source>[AM])_(?P<start>{_T})_(?P<end>{_T})" + _TAIL
)
# RIFG, RUNW, GUNW, ROFF, GOFF: reference/secondary pair
PAIR = re.compile(
    _HEAD + rf"_(?P<cycle2>\d{{3}})_(?P<mode>\d{{4}})_(?P<pol>[A-Z]{{2}})"
    rf"_(?P<ref_start>{_T})_(?P<ref_end>{_T})_(?P<sec_start>{_T})_(?P<sec_end>{_T})" + _TAIL
)


def _dt(s):
    return datetime.strptime(s, "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)


def parse(name):
    """Return a dict of fields for a NISAR L1/L2/L3 granule name, or None if it doesn't match."""
    name = name.removesuffix(".h5")
    m = SINGLE.fullmatch(name) or PAIR.fullmatch(name)
    if not m:
        return None
    d = m.groupdict()
    for k in ("level", "cycle", "track", "frame", "counter", "cycle2"):
        if d.get(k) is not None:
            d[k] = int(d[k])
    for k in ("start", "end", "ref_start", "ref_end", "sec_start", "sec_end"):
        if d.get(k) is not None:
            d[k] = _dt(d[k])
    d["full_frame"] = d["coverage"] == "F"
    return d
