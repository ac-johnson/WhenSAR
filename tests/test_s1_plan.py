import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))

from s1_plan import centre_line, direction, merge, parse_kml, plan_files, unwrap  # noqa: E402

KML = """<kml><Placemark><name>x</name><ExtendedData>
<Data name="SatelliteId"><value>S1C</value></Data><Data name="DatatakeId"><value>ABC</value></Data>
<Data name="Mode"><value>IW</value></Data><Data name="Swath"><value>IW</value></Data>
<Data name="Polarisation"><value>DV</value></Data>
<Data name="ObservationTimeStart"><value>2026-10-20T13:50:16</value></Data>
<Data name="ObservationTimeStop"><value>2026-10-20T13:52:23</value></Data>
<Data name="OrbitAbsolute"><value>9969</value></Data><Data name="OrbitRelative"><value>71</value></Data>
</ExtendedData><LinearRing><coordinates>-117,36,0 -117.5,34,0 -118,32,0 -120.5,32.5,0 -120,34.5,0 -119.5,36.5,0 -117,36,0</coordinates></LinearRing></Placemark>
<Placemark><ExtendedData><Data name="SatelliteId"><value>S1C</value></Data><Data name="DatatakeId"><value>W</value></Data>
<Data name="Mode"><value>WV</value></Data></ExtendedData></Placemark></kml>"""


def utc(*a):
    return datetime(*a, tzinfo=timezone.utc)


def test_parse_kml_skips_wave_mode():
    (d,) = parse_kml(KML)
    assert (d["sat"], d["mode"], d["pol"], d["rel_orbit"]) == ("S1C", "IW", "DV", 71)
    assert d["start"] == utc(2026, 10, 20, 13, 50, 16)


def test_centre_line_and_direction():
    (d,) = parse_kml(KML)
    a, b = centre_line(d["ring"])
    assert a == (-118.25, 36.25)  # start corners: first and last vertex
    assert b == (-119.25, 32.25)  # end corners: middle two
    assert direction(d) == "D"  # ~05:51 local solar time: descending


def test_unwrap_antimeridian():
    assert unwrap([(179.5, 0), (-179.5, 1), (-179, 2)]) == [(179.5, 0), (180.5, 1), (181, 2)]


def test_newer_file_replaces_overlapping_span():
    old = [{"sat": "S1C", "datatake": "A", "start": utc(2026, 10, 5)}, {"sat": "S1C", "datatake": "B", "start": utc(2026, 10, 12)}]
    new = [{"sat": "S1C", "datatake": "C", "start": utc(2026, 10, 13)}]
    out = merge([("s1c", utc(2026, 10, 1), utc(2026, 10, 20), old), ("s1c", utc(2026, 10, 10), utc(2026, 10, 30), new)])
    assert [d["datatake"] for d in out] == ["A", "C"]  # B was dropped by the newer plan


def test_plan_files_keeps_current_ones_oldest_first():
    html = "s1c_mp_user_20261001t000000_20261020t000000 s1d_mp_user_20261015t000000_20261104t000000 s1c_mp_user_20261012t000000_20261103t000000"
    files = plan_files(html, utc(2026, 10, 23))
    assert [f[3] for f in files] == ["s1c_mp_user_20261012t000000_20261103t000000", "s1d_mp_user_20261015t000000_20261104t000000"]
