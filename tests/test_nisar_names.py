import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

from nisar_names import parse  # noqa: E402
from snapshot_rop import mode_table, parse_date_modes  # noqa: E402


def test_single_acquisition_name():
    g = parse("NISAR_L2_PR_GCOV_033_034_A_019_4005_DHDH_A_20261014T130823_20261014T130857_P05023_N_F_J_001.h5")
    assert (g["product"], g["cycle"], g["track"], g["dir"], g["frame"]) == ("GCOV", 33, 34, "A", 19)
    assert g["mode"] == "4005" and g["pol"] == "DHDH" and g["full_frame"]
    assert g["start"] == datetime(2026, 10, 14, 13, 8, 23, tzinfo=timezone.utc)
    assert g["crid"] == "P05023" and g["counter"] == 1


def test_pair_name():
    g = parse(
        "NISAR_L2_PR_GUNW_032_034_A_019_033_4005_HH_20261002T130823_20261002T130857"
        "_20261014T130823_20261014T130857_P05023_N_P_J_002"
    )
    assert g["product"] == "GUNW" and g["cycle2"] == 33 and g["pol"] == "HH"
    assert g["sec_start"] == datetime(2026, 10, 14, 13, 8, 23, tzinfo=timezone.utc)
    assert not g["full_frame"]


def test_non_matching_name():
    assert parse("NISAR_ECMWF_SMST_20261014.h5") is None


def test_parse_date_modes():
    assert parse_date_modes("2025-09-24 | 214,153\n2025-10-06 | 214") == [
        ["2025-09-24", [214, 153]],
        ["2025-10-06", [214]],
    ]


def test_mode_table_majority_and_placeholder():
    feats = [
        {"properties": {"radar_mode_combination_1": "156,000", "radar_mode_mnemonic_combination_1": "A,B"}},
        {"properties": {"radar_mode_combination_1": "156,000", "radar_mode_mnemonic_combination_1": "A,C"}},
        {"properties": {"radar_mode_combination_1": "156", "radar_mode_mnemonic_combination_1": "Z"}},
    ]
    assert mode_table(feats) == {156: "A", 0: None}
