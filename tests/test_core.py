from datetime import datetime, timedelta, timezone

from app.analysis.anomalies import detect_anomalies
from app.config import Settings
from app.export import export_gpx, export_kml
from app.models import AnomalyType, RepairOption, Track, TrackPoint
from app.parsers.track_parser import parse_gpx, parse_kml
from app.repair.engine import apply_repairs


def _pts():
    t0 = datetime(2024, 6, 1, 10, 0, tzinfo=timezone.utc)
    return [
        TrackPoint(lat=55.751, lon=37.618, time=t0),
        TrackPoint(lat=55.752, lon=37.620, time=t0 + timedelta(seconds=20)),
        # big gap
        TrackPoint(lat=55.760, lon=37.640, time=t0 + timedelta(seconds=300)),
        TrackPoint(lat=55.761, lon=37.641, time=t0 + timedelta(seconds=320)),
        # spike
        TrackPoint(lat=55.790, lon=37.700, time=t0 + timedelta(seconds=325)),
        TrackPoint(lat=55.762, lon=37.642, time=t0 + timedelta(seconds=345)),
    ]


def test_detect_gap_and_spike():
    track = Track(points=_pts(), source_format="gpx")
    settings = Settings(mapbox_access_token="")
    anomalies = detect_anomalies(track, settings)
    types = {a.type for a in anomalies}
    assert AnomalyType.GAP in types
    assert AnomalyType.SPIKE in types


def test_parse_and_export_gpx_roundtrip(tmp_path):
    sample = open("/agent/samples/broken_track.gpx", "rb").read()
    track = parse_gpx(sample)
    assert len(track.points) >= 10
    raw = export_gpx(track)
    again = parse_gpx(raw)
    assert len(again.points) == len(track.points)


def test_parse_kml_linestring():
    kml = b"""<?xml version='1.0' encoding='UTF-8'?>
    <kml xmlns='http://www.opengis.net/kml/2.2'>
      <Document>
        <Placemark>
          <LineString>
            <coordinates>37.618423,55.751244,0 37.620000,55.752000,0</coordinates>
          </LineString>
        </Placemark>
      </Document>
    </kml>"""
    track = parse_kml(kml)
    assert len(track.points) == 2
    assert abs(track.points[0].lat - 55.751244) < 1e-6


def test_apply_interpolate_repair():
    track = Track(points=_pts(), source_format="gpx")
    opt = RepairOption(
        id="o1",
        anomaly_id="a1",
        label="interp",
        description="",
        method="interpolate",
        geometry=[
            track.points[1],
            TrackPoint(lat=55.756, lon=37.630),
            track.points[2],
        ],
        replaces_from=1,
        replaces_to=2,
    )
    repaired = apply_repairs(track, {"o1": opt}, {"a1": "o1"})
    assert len(repaired.points) >= len(track.points)
    assert any(abs(p.lat - 55.756) < 1e-9 for p in repaired.points)


def test_export_kml_nonempty():
    track = Track(points=_pts()[:3], name="t", source_format="gpx")
    data = export_kml(track)
    assert b"LineString" in data
    assert b"37.618" in data


def test_manual_connect_requires_distinct_points():
    import asyncio
    from app.repair.engine import build_manual_connect_options

    track = Track(points=_pts(), source_format="gpx")
    settings = Settings(mapbox_access_token="")

    async def _run():
        await build_manual_connect_options(track, 1, 1, settings, "driving")

    try:
        asyncio.run(_run())
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_manual_connect_local_interpolate_without_mapbox():
    import asyncio
    from app.repair.engine import build_manual_connect_options

    track = Track(points=_pts(), source_format="gpx")
    settings = Settings(mapbox_access_token="")
    opts = asyncio.run(build_manual_connect_options(track, 1, 2, settings, "driving"))
    assert len(opts) == 1
    assert opts[0].method == "interpolate"
