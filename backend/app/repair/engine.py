from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from app.config import Settings
from app.geo import interpolate_points
from app.matching.mapbox import MapboxClient, MapboxError
from app.models import Anomaly, AnomalyType, RepairOption, Track, TrackPoint


async def build_repair_options(
    track: Track,
    anomalies: list[Anomaly],
    settings: Settings,
    profile_hint: str = "mixed",
) -> list[RepairOption]:
    options: list[RepairOption] = []
    profiles = list(settings.default_profiles) if profile_hint == "mixed" else [profile_hint]

    for anomaly in anomalies:
        options.extend(_local_options(track, anomaly))

    if not settings.mapbox_ready():
        return _dedupe(options)

    async with MapboxClient(settings) as client:
        for anomaly in anomalies:
            context = _context_points(track, anomaly)
            if len(context) < 2:
                continue

            # Gap: Directions fill is usually better than matching sparse points
            if anomaly.type == AnomalyType.GAP:
                start = track.points[anomaly.start_index]
                end = track.points[anomaly.end_index]
                for profile in profiles:
                    try:
                        result = await client.directions(start, end, profile=profile)
                        geom = result["geometry"]
                        if len(geom) >= 2:
                            options.append(
                                RepairOption(
                                    id=f"opt-{uuid.uuid4().hex[:8]}",
                                    anomaly_id=anomaly.id,
                                    label=f"Маршрут по карте ({profile})",
                                    description="Построить путь между концами разрыва через Mapbox Directions",
                                    profile=profile,
                                    method="directions_fill",
                                    confidence=0.8,
                                    geometry=geom,
                                    replaces_from=anomaly.start_index,
                                    replaces_to=anomaly.end_index,
                                )
                            )
                    except MapboxError:
                        continue
                continue

            # Spike / noise / jump: try Directions between ends + Map Matching on a window
            start = track.points[anomaly.start_index]
            end = track.points[anomaly.end_index]
            for profile in profiles:
                try:
                    result = await client.directions(start, end, profile=profile)
                    geom = result["geometry"]
                    if len(geom) >= 2:
                        options.append(
                            RepairOption(
                                id=f"opt-{uuid.uuid4().hex[:8]}",
                                anomaly_id=anomaly.id,
                                label=f"Объехать по дорогам ({profile})",
                                description="Заменить скачок маршрутом Mapbox Directions",
                                profile=profile,
                                method="directions_fill",
                                confidence=0.75,
                                geometry=geom,
                                replaces_from=anomaly.start_index,
                                replaces_to=anomaly.end_index,
                            )
                        )
                except MapboxError:
                    continue

            window = _window_points(track, anomaly, pad=3)
            if len(window) >= 2:
                for profile in profiles:
                    try:
                        matched = await client.map_match(window, profile=profile, radius_m=50.0)
                        geom = matched["geometry"]
                        conf = float(matched.get("confidence") or 0)
                        if len(geom) < 2:
                            continue
                        label = f"Snap к дорогам ({profile})"
                        if conf < 0.1:
                            label += " · низкая уверенность"
                        options.append(
                            RepairOption(
                                id=f"opt-{uuid.uuid4().hex[:8]}",
                                anomaly_id=anomaly.id,
                                label=label,
                                description="Притянуть участок к дорожному графу через Map Matching",
                                profile=profile,
                                method="map_match",
                                confidence=conf,
                                geometry=geom,
                                replaces_from=max(0, anomaly.start_index - 3),
                                replaces_to=min(len(track.points) - 1, anomaly.end_index + 3),
                            )
                        )
                    except MapboxError:
                        continue

    # Deduplicate by (anomaly, method, profile) keeping highest confidence
    return _dedupe(options)


async def build_manual_connect_options(
    track: Track,
    start_index: int,
    end_index: int,
    settings: Settings,
    profile_hint: str = "mixed",
) -> list[RepairOption]:
    """Optional variant: user picks A/B, Mapbox Directions fills the gap along roads."""
    n = len(track.points)
    if start_index < 0 or end_index < 0 or start_index >= n or end_index >= n:
        raise ValueError("Point indices out of range")
    if start_index == end_index:
        raise ValueError("Pick two different points")
    lo, hi = sorted((start_index, end_index))

    connect_id = f"manual-{uuid.uuid4().hex[:8]}"
    start = track.points[lo]
    end = track.points[hi]
    profiles = list(settings.default_profiles) if profile_hint == "mixed" else [profile_hint]

    options: list[RepairOption] = [
        RepairOption(
            id=f"opt-{uuid.uuid4().hex[:8]}",
            anomaly_id=connect_id,
            label="Прямая линия (без карты)",
            description="Соединить A и B по прямой — для сравнения",
            method="interpolate",
            confidence=0.25,
            geometry=[start, *interpolate_points(start, end, count=max(3, min(20, hi - lo))), end],
            replaces_from=lo,
            replaces_to=hi,
        )
    ]

    if not settings.mapbox_ready():
        return options

    async with MapboxClient(settings) as client:
        for profile in profiles:
            try:
                result = await client.directions(start, end, profile=profile)
            except MapboxError:
                continue
            geom = result["geometry"]
            if len(geom) < 2:
                continue
            dist = result.get("distance")
            dur = result.get("duration")
            meta = []
            if dist is not None:
                meta.append(f"{dist / 1000:.2f} км")
            if dur is not None:
                meta.append(f"{dur / 60:.0f} мин")
            suffix = f" · {' · '.join(meta)}" if meta else ""
            options.append(
                RepairOption(
                    id=f"opt-{uuid.uuid4().hex[:8]}",
                    anomaly_id=connect_id,
                    label=f"Соединить по дорогам ({profile}){suffix}",
                    description="Вариант: маршрут Mapbox Directions между выбранными точками A и B",
                    profile=profile,
                    method="directions_fill",
                    confidence=0.9,
                    geometry=geom,
                    replaces_from=lo,
                    replaces_to=hi,
                )
            )

    return options


async def build_supplement_options(
    track: Track,
    start_index: int,
    end_index: int,
    settings: Settings,
    profile_hint: str = "mixed",
) -> list[RepairOption]:
    """Fill missing section between two existing track anchors A and B (anchors kept)."""
    n = len(track.points)
    if start_index < 0 or end_index < 0 or start_index >= n or end_index >= n:
        raise ValueError("Point indices out of range")
    if start_index == end_index:
        raise ValueError("Pick two different track points")
    lo, hi = sorted((start_index, end_index))

    supplement_id = f"supplement-{uuid.uuid4().hex[:8]}"
    start = track.points[lo]
    end = track.points[hi]
    profiles = list(settings.default_profiles) if profile_hint == "mixed" else [profile_hint]

    options: list[RepairOption] = [
        RepairOption(
            id=f"opt-{uuid.uuid4().hex[:8]}",
            anomaly_id=supplement_id,
            label="Прямая линия (без карты)",
            description="Вставить прямую между якорями A и B — для сравнения",
            method="supplement_interpolate",
            confidence=0.25,
            geometry=[start, *interpolate_points(start, end, count=max(3, min(20, hi - lo))), end],
            replaces_from=lo,
            replaces_to=hi,
        )
    ]

    if not settings.mapbox_ready():
        return options

    async with MapboxClient(settings) as client:
        for profile in profiles:
            try:
                result = await client.directions(start, end, profile=profile)
            except MapboxError:
                continue
            geom = result["geometry"]
            if len(geom) < 2:
                continue
            dist = result.get("distance")
            dur = result.get("duration")
            meta = []
            if dist is not None:
                meta.append(f"{dist / 1000:.2f} км")
            if dur is not None:
                meta.append(f"{dur / 60:.0f} мин")
            suffix = f" · {' · '.join(meta)}" if meta else ""
            options.append(
                RepairOption(
                    id=f"opt-{uuid.uuid4().hex[:8]}",
                    anomaly_id=supplement_id,
                    label=f"Дополнить по дорогам ({profile}){suffix}",
                    description="Маршрут Mapbox между якорями A и B; точки A/B трека сохраняются",
                    profile=profile,
                    method="supplement_fill",
                    confidence=0.9,
                    geometry=geom,
                    replaces_from=lo,
                    replaces_to=hi,
                )
            )

    return options


def _local_options(track: Track, anomaly: Anomaly) -> list[RepairOption]:
    start = track.points[anomaly.start_index]
    end = track.points[anomaly.end_index]
    options = [
        RepairOption(
            id=f"opt-{uuid.uuid4().hex[:8]}",
            anomaly_id=anomaly.id,
            label="Оставить как есть",
            description="Не менять этот участок",
            method="keep",
            confidence=1.0,
            geometry=track.points[anomaly.start_index : anomaly.end_index + 1],
            replaces_from=anomaly.start_index,
            replaces_to=anomaly.end_index,
        )
    ]
    interp = interpolate_points(start, end, count=max(1, anomaly.end_index - anomaly.start_index))
    options.append(
        RepairOption(
            id=f"opt-{uuid.uuid4().hex[:8]}",
            anomaly_id=anomaly.id,
            label="Прямая интерполяция",
            description="Соединить концы прямой линией без карты",
            method="interpolate",
            confidence=0.4,
            geometry=[start, *interp, end],
            replaces_from=anomaly.start_index,
            replaces_to=anomaly.end_index,
        )
    )
    if anomaly.type in {AnomalyType.SPIKE, AnomalyType.NOISE, AnomalyType.JUMP}:
        options.append(
            RepairOption(
                id=f"opt-{uuid.uuid4().hex[:8]}",
                anomaly_id=anomaly.id,
                label="Удалить выброс",
                description="Вырезать аномальные точки и соединить соседей",
                method="discard",
                confidence=0.55,
                geometry=[start, end] if anomaly.end_index > anomaly.start_index else [start],
                replaces_from=anomaly.start_index,
                replaces_to=anomaly.end_index,
            )
        )
    return options


def _context_points(track: Track, anomaly: Anomaly) -> list[TrackPoint]:
    return track.points[anomaly.start_index : anomaly.end_index + 1]


def _window_points(track: Track, anomaly: Anomaly, pad: int = 4) -> list[TrackPoint]:
    lo = max(0, anomaly.start_index - pad)
    hi = min(len(track.points) - 1, anomaly.end_index + pad)
    return track.points[lo : hi + 1]


def _dedupe(options: list[RepairOption]) -> list[RepairOption]:
    best: dict[tuple[str, str, Optional[str]], RepairOption] = {}
    for opt in options:
        key = (opt.anomaly_id, opt.method, opt.profile)
        prev = best.get(key)
        if prev is None or (opt.confidence or 0) >= (prev.confidence or 0):
            best[key] = opt
    # Stable-ish order: keep, then map methods by confidence
    ordered = list(best.values())
    method_rank = {
        "keep": 0,
        "map_match": 1,
        "directions_fill": 2,
        "supplement_fill": 2,
        "interpolate": 3,
        "supplement_interpolate": 3,
        "discard": 4,
    }
    ordered.sort(key=lambda o: (o.anomaly_id, method_rank.get(o.method, 9), -(o.confidence or 0)))
    return ordered


def apply_repairs(
    track: Track,
    options_by_id: dict[str, RepairOption],
    selections: dict[str, str],
) -> Track:
    """Apply selected repair options. Selections: anomaly_id -> option_id."""
    chosen: list[RepairOption] = []
    for anomaly_id, option_id in selections.items():
        opt = options_by_id.get(option_id)
        if opt is None:
            raise ValueError(f"Unknown option: {option_id}")
        if opt.anomaly_id != anomaly_id:
            raise ValueError(f"Option {option_id} does not belong to anomaly {anomaly_id}")
        if opt.method == "keep":
            continue
        chosen.append(opt)

    # Apply from the end so indices stay valid
    points = list(track.points)
    for opt in sorted(chosen, key=lambda o: o.replaces_from, reverse=True):
        lo = max(0, min(opt.replaces_from, len(points) - 1))
        hi = max(0, min(opt.replaces_to, len(points) - 1))
        if hi < lo:
            lo, hi = hi, lo
        if opt.method in ("supplement_fill", "supplement_interpolate"):
            points = _apply_supplement(points, lo, hi, list(opt.geometry))
            continue
        left = points[:lo]
        right = points[hi + 1 :]
        mid = _prepare_insert_geometry(points, lo, hi, list(opt.geometry))
        points = left + mid + right

    return Track(
        name=track.name,
        points=points,
        source_format=track.source_format,
        metadata={**track.metadata, "repaired": True},
    )


def _apply_supplement(
    points: list[TrackPoint],
    lo: int,
    hi: int,
    geometry: list[TrackPoint],
) -> list[TrackPoint]:
    """Keep anchor points at lo and hi; insert route between them."""
    if hi <= lo:
        return points
    start = points[lo]
    end = points[hi]
    mid = [TrackPoint(**p.model_dump()) for p in geometry]
    if mid and _same_point(mid[0], start):
        mid = mid[1:]
    if mid and _same_point(mid[-1], end):
        mid = mid[:-1]
    mid = _interpolate_times_between(start, end, mid)
    return points[: lo + 1] + mid + points[hi:]


def _interpolate_times_between(
    start: TrackPoint,
    end: TrackPoint,
    mid: list[TrackPoint],
) -> list[TrackPoint]:
    if not mid or start.time is None or end.time is None:
        return mid
    t0 = start.time.timestamp()
    t1 = end.time.timestamp()
    if t1 <= t0:
        return mid
    out: list[TrackPoint] = []
    n = len(mid)
    for i, p in enumerate(mid):
        if p.time is not None:
            out.append(p)
            continue
        frac = (i + 1) / (n + 1)
        ts = t0 + (t1 - t0) * frac
        tz = start.time.tzinfo or timezone.utc
        out.append(
            TrackPoint(
                lat=p.lat,
                lon=p.lon,
                ele=p.ele,
                time=datetime.fromtimestamp(ts, tz=tz),
                hdop=p.hdop,
            )
        )
    return out


def _prepare_insert_geometry(
    points: list[TrackPoint],
    lo: int,
    hi: int,
    geometry: list[TrackPoint],
) -> list[TrackPoint]:
    if not geometry:
        return geometry
    start = points[lo]
    end = points[hi]
    mid = [TrackPoint(**p.model_dump()) for p in geometry]
    if mid:
        mid[0] = TrackPoint(
            lat=mid[0].lat,
            lon=mid[0].lon,
            ele=mid[0].ele if mid[0].ele is not None else start.ele,
            time=mid[0].time if mid[0].time is not None else start.time,
            hdop=mid[0].hdop if mid[0].hdop is not None else start.hdop,
        )
        mid[-1] = TrackPoint(
            lat=mid[-1].lat,
            lon=mid[-1].lon,
            ele=mid[-1].ele if mid[-1].ele is not None else end.ele,
            time=mid[-1].time if mid[-1].time is not None else end.time,
            hdop=mid[-1].hdop if mid[-1].hdop is not None else end.hdop,
        )
    # Avoid duplicating endpoints if geometry already includes them
    if mid and lo > 0 and _same_point(points[lo - 1], mid[0]):
        mid = mid[1:]
    if mid and hi + 1 < len(points) and _same_point(mid[-1], points[hi + 1]):
        mid = mid[:-1]
    return mid


def _same_point(a: TrackPoint, b: TrackPoint, eps: float = 1e-6) -> bool:
    return abs(a.lat - b.lat) < eps and abs(a.lon - b.lon) < eps
