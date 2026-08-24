from __future__ import annotations

import uuid

from app.config import Settings
from app.geo import bearing_deg, haversine_m, speed_mps, time_delta_seconds
from app.models import Anomaly, AnomalyType, Track


def detect_anomalies(track: Track, settings: Settings) -> list[Anomaly]:
    points = track.points
    if len(points) < 2:
        return []

    anomalies: list[Anomaly] = []
    i = 0
    while i < len(points) - 1:
        a = points[i]
        b = points[i + 1]
        dist = haversine_m(a, b)
        dt = time_delta_seconds(a, b)
        spd = speed_mps(a, b)

        # Gap: large time hole and/or spatial hole
        is_time_gap = dt is not None and dt >= settings.gap_time_seconds
        is_space_gap = dist >= settings.gap_distance_meters and (dt is None or dt >= 8)
        if is_time_gap or (is_space_gap and (dt is None or dt > 3)):
            severity = min(1.0, dist / max(settings.gap_distance_meters * 4, 1) + (dt or 0) / 300)
            anomalies.append(
                Anomaly(
                    id=f"gap-{uuid.uuid4().hex[:8]}",
                    type=AnomalyType.GAP,
                    start_index=i,
                    end_index=i + 1,
                    severity=severity,
                    message=f"Потеря трека: {dist:.0f} м"
                    + (f", {dt:.0f} с" if dt is not None else ""),
                    metrics={"distance_m": dist, "dt_s": dt},
                )
            )
            i += 1
            continue

        # Spike / impossible speed
        if (spd is not None and spd > settings.max_speed_mps) or (
            dist >= settings.spike_distance_meters and (dt is None or dt < 5)
        ):
            anomalies.append(
                Anomaly(
                    id=f"spike-{uuid.uuid4().hex[:8]}",
                    type=AnomalyType.SPIKE,
                    start_index=i,
                    end_index=i + 1,
                    severity=min(1.0, (spd or dist / 5) / settings.max_speed_mps),
                    message=f"Скачок координат: {dist:.0f} м"
                    + (f", {spd * 3.6:.0f} км/ч" if spd else ""),
                    metrics={"distance_m": dist, "speed_mps": spd, "dt_s": dt},
                )
            )
            i += 1
            continue

        # Local noise: sharp bearing changes with small net progress
        if i + 2 < len(points):
            c = points[i + 2]
            b1 = bearing_deg(a, b)
            b2 = bearing_deg(b, c)
            turn = abs(b1 - b2)
            turn = min(turn, 360 - turn)
            leg = haversine_m(a, b) + haversine_m(b, c)
            net = haversine_m(a, c)
            if turn > 120 and leg > 15 and net < leg * 0.35:
                anomalies.append(
                    Anomaly(
                        id=f"noise-{uuid.uuid4().hex[:8]}",
                        type=AnomalyType.NOISE,
                        start_index=i,
                        end_index=i + 2,
                        severity=min(1.0, turn / 180),
                        message=f"Шум / зигзаг: поворот {turn:.0f}°",
                        metrics={"turn_deg": turn, "leg_m": leg, "net_m": net},
                    )
                )
                i += 2
                continue

        i += 1

    return _merge_nearby(anomalies)


def _merge_nearby(anomalies: list[Anomaly], max_gap: int = 2) -> list[Anomaly]:
    if not anomalies:
        return []
    ordered = sorted(anomalies, key=lambda a: a.start_index)
    merged: list[Anomaly] = [ordered[0]]
    for cur in ordered[1:]:
        prev = merged[-1]
        if cur.start_index <= prev.end_index + max_gap and cur.type == prev.type:
            prev.end_index = max(prev.end_index, cur.end_index)
            prev.severity = max(prev.severity, cur.severity)
            prev.message = f"{prev.type.value}: индексы {prev.start_index}–{prev.end_index}"
            prev.metrics = {**prev.metrics, **cur.metrics, "merged": True}
        else:
            merged.append(cur)
    return merged
