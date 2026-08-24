from __future__ import annotations

import math
from datetime import datetime
from typing import Iterable, Optional

from app.models import TrackPoint


EARTH_RADIUS_M = 6_371_000.0


def haversine_m(a: TrackPoint, b: TrackPoint) -> float:
    lat1, lon1 = math.radians(a.lat), math.radians(a.lon)
    lat2, lon2 = math.radians(b.lat), math.radians(b.lon)
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def bearing_deg(a: TrackPoint, b: TrackPoint) -> float:
    lat1, lon1 = math.radians(a.lat), math.radians(a.lon)
    lat2, lon2 = math.radians(b.lat), math.radians(b.lon)
    dlon = lon2 - lon1
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def time_delta_seconds(a: TrackPoint, b: TrackPoint) -> Optional[float]:
    if a.time is None or b.time is None:
        return None
    return max((b.time - a.time).total_seconds(), 0.0)


def speed_mps(a: TrackPoint, b: TrackPoint) -> Optional[float]:
    dt = time_delta_seconds(a, b)
    if dt is None:
        return None
    if dt <= 0:
        return None
    return haversine_m(a, b) / dt


def interpolate_points(a: TrackPoint, b: TrackPoint, count: int) -> list[TrackPoint]:
    if count <= 0:
        return []
    out: list[TrackPoint] = []
    for i in range(1, count + 1):
        t = i / (count + 1)
        lat = a.lat + (b.lat - a.lat) * t
        lon = a.lon + (b.lon - a.lon) * t
        ele = None
        if a.ele is not None and b.ele is not None:
            ele = a.ele + (b.ele - a.ele) * t
        time = None
        if a.time is not None and b.time is not None:
            delta = (b.time - a.time).total_seconds() * t
            time = datetime.fromtimestamp(a.time.timestamp() + delta, tz=a.time.tzinfo)
        out.append(TrackPoint(lat=lat, lon=lon, ele=ele, time=time))
    return out


def path_length_m(points: Iterable[TrackPoint]) -> float:
    pts = list(points)
    if len(pts) < 2:
        return 0.0
    return sum(haversine_m(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
