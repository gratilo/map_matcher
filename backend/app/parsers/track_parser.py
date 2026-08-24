from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from xml.etree import ElementTree as ET

import gpxpy
from fitparse import FitFile

from app.models import Track, TrackPoint


def _parse_time(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def parse_gpx(data: bytes, name_hint: Optional[str] = None) -> Track:
    gpx = gpxpy.parse(data.decode("utf-8", errors="replace"))
    points: list[TrackPoint] = []
    for track in gpx.tracks:
        for segment in track.segments:
            for p in segment.points:
                points.append(
                    TrackPoint(
                        lat=p.latitude,
                        lon=p.longitude,
                        ele=p.elevation,
                        time=p.time,
                        hdop=getattr(p, "horizontal_dilution", None),
                    )
                )
    if not points:
        for route in gpx.routes:
            for p in route.points:
                points.append(
                    TrackPoint(lat=p.latitude, lon=p.longitude, ele=p.elevation, time=p.time)
                )
    if not points:
        for wpt in gpx.waypoints:
            points.append(
                TrackPoint(lat=wpt.latitude, lon=wpt.longitude, ele=wpt.elevation, time=wpt.time)
            )
    track_name = name_hint
    if gpx.tracks and gpx.tracks[0].name:
        track_name = gpx.tracks[0].name
    elif gpx.name:
        track_name = gpx.name
    return Track(name=track_name, points=points, source_format="gpx")


def _local_tag(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[-1]
    return tag


def parse_kml(data: bytes, name_hint: Optional[str] = None) -> Track:
    root = ET.fromstring(data)
    points: list[TrackPoint] = []
    name = name_hint

    for elem in root.iter():
        tag = _local_tag(elem.tag)
        if tag == "name" and name is None and elem.text:
            name = elem.text.strip()
        if tag not in {"coordinates", "coord"}:
            continue
        text = (elem.text or "").strip()
        if not text:
            continue
        # KML coordinates: lon,lat[,ele] whitespace-separated
        for token in text.replace("\n", " ").split():
            parts = token.split(",")
            if len(parts) < 2:
                continue
            lon = float(parts[0])
            lat = float(parts[1])
            ele = float(parts[2]) if len(parts) > 2 and parts[2] else None
            points.append(TrackPoint(lat=lat, lon=lon, ele=ele))

    if not points:
        raise ValueError("KML does not contain coordinates")
    return Track(name=name, points=points, source_format="kml")


def parse_fit(data: bytes, name_hint: Optional[str] = None) -> Track:
    fit = FitFile(data)
    points: list[TrackPoint] = []
    for record in fit.get_messages("record"):
        lat_raw = record.get_value("position_lat")
        lon_raw = record.get_value("position_long")
        if lat_raw is None or lon_raw is None:
            continue
        # FIT semicircles → degrees
        lat = lat_raw * (180.0 / 2**31)
        lon = lon_raw * (180.0 / 2**31)
        if abs(lat) > 90 or abs(lon) > 180:
            continue
        ele = record.get_value("enhanced_altitude")
        if ele is None:
            ele = record.get_value("altitude")
        ts = record.get_value("timestamp")
        time = None
        if isinstance(ts, datetime):
            time = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
        points.append(TrackPoint(lat=lat, lon=lon, ele=ele, time=time))

    if not points:
        raise ValueError("FIT file has no GPS records")
    return Track(name=name_hint, points=points, source_format="fit")


def parse_track(filename: str, data: bytes) -> Track:
    suffix = Path(filename).suffix.lower()
    stem = Path(filename).stem
    if suffix == ".gpx":
        return parse_gpx(data, name_hint=stem)
    if suffix in {".kml", ".kmz"}:
        if suffix == ".kmz":
            raise ValueError("KMZ is not supported yet; please upload KML")
        return parse_kml(data, name_hint=stem)
    if suffix == ".fit":
        return parse_fit(data, name_hint=stem)
    raise ValueError(f"Unsupported format: {suffix or 'unknown'}. Use .gpx, .kml, or .fit")
