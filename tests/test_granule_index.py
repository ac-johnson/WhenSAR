import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

from granule_index import add, frame_summary, prune  # noqa: E402

RSLC = "NISAR_L1_PR_RSLC_{cy}_034_A_019_4005_DHDH_A_{t}_{t}_P{crid}_N_{cov}_J_{ctr}"
GUNW = "NISAR_L2_PR_GUNW_032_034_A_019_{cy}_4005_HH_20261002T130823_20261002T130857_{t}_{t}_P05023_N_F_J_001"


def rslc(cy, t, crid="05023", cov="F", ctr="001"):
    return RSLC.format(cy=cy, t=t, crid=crid, cov=cov, ctr=ctr)


def test_reprocessed_and_partial_rslc_collapse_per_cycle():
    index = {}
    add(index, rslc("033", "20261014T130823", ctr="001"))
    add(index, rslc("033", "20261014T130823", ctr="002"))  # reprocessed: wins
    add(index, rslc("033", "20261014T130900", cov="P", ctr="009"))  # partial: never beats full
    assert index["034_A_019"]["RSLC"] == {"33": rslc("033", "20261014T130823", ctr="002")}


def test_pair_product_belongs_to_secondary_cycle():
    index = {}
    add(index, GUNW.format(cy="033", t="20261014T130823"))
    assert index["034_A_019"]["GUNW"] == {"33": "20261014"}


def test_urgent_and_unparseable_names_ignored():
    index = {}
    add(index, rslc("033", "20261014T130823").replace("_PR_", "_UR_"))
    add(index, "NISAR_ANC_SOMETHING")
    assert index == {}


def test_prune_keeps_rslc_history():
    index = {"034_A_019": {"RSLC": {"1": rslc("001", "20251101T130823")}, "GCOV": {"1": "20251101", "33": "20261014"}}}
    prune(index, datetime(2026, 10, 22, tzinfo=timezone.utc))
    assert index["034_A_019"]["GCOV"] == {"33": "20261014"}
    assert "1" in index["034_A_019"]["RSLC"]


def test_frame_summary():
    products = {
        "RSLC": {"32": rslc("032", "20261002T130823"), "33": rslc("033", "20261014T130900", cov="P")},
        "GUNW": {"32": "20261002"},
    }
    s = frame_summary(products)
    assert s["ref_start"] == "2026-10-02T13:08:23Z"  # latest *full* frame
    assert s["latest_rslc"].endswith("_P_J_001") and "20261014" in s["latest_rslc"]
    assert s["acq"] == "20261014T130900 4005 DHDH P;20261002T130823 4005 DHDH F"
    assert json.loads(s["products"]) == {"GUNW": "20261002"}
    assert frame_summary({})["ref_start"] is None
