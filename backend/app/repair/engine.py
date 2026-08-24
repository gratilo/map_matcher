from __future__ import annotations

import uuid
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

            # Spike / noise / jump: map match a local window
            window = _window_points(track, anomaly, pad=4)
            if len(window) >= 2:
                for profile in profiles:
                    try:
                        matched = await client.map_match(window, profile=profile)
                        geom = matched["geometry"]
                        if len(geom) >= 2:
                            options.append(
                                RepairOption(
                                    id=f"opt-{uuid.uuid4().hex[:8]}",
                                    anomaly_id=anomaly.id,
                                    label=f"Snap к дорогам ({profile})",
                                    description="Притянуть участок к дорожному графу через Map Matching",
                                    profile=profile,
                                    method="map_match",
                                    confidence=matched.get("confidence"),
                                    geometry=geom,
                                    replaces_from=max(0, anomaly.start_index - 4),
                                    replaces_to=min(len(track.points) - 1, anomaly.end_index + 4),
                                )
                            )
                    except MapboxError:
                        continue

    # Deduplicate by (anomaly, method, profile) keeping highest confidence
    return _dedupe(options)


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
    method_rank = {"keep": 0, "map_match": 1, "directions_fill": 2, "interpolate": 3, "discard": 4}
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
        left = points[: opt.replaces_from]
        right = points[opt.replaces_to + 1 :]
        mid = list(opt.geometry)
        # Avoid duplicating endpoints if geometry already includes them
        if mid and left and _same_point(left[-1], mid[0]):
            mid = mid[1:]
        if mid and right and _same_point(mid[-1], right[0]):
            mid = mid[:-1]
        points = left + mid + right

    return Track(
        name=track.name,
        points=points,
        source_format=track.source_format,
        metadata={**track.metadata, "repaired": True},
    )


def _same_point(a: TrackPoint, b: TrackPoint, eps: float = 1e-6) -> bool:
    return abs(a.lat - b.lat) < eps and abs(a.lon - b.lon) < eps
