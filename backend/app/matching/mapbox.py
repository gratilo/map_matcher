from __future__ import annotations

from typing import Any, Optional

import httpx

from app.config import Settings
from app.models import TrackPoint


PROFILE_MAP = {
    "driving": "mapbox/driving",
    "cycling": "mapbox/cycling",
    "walking": "mapbox/walking",
}


class MapboxError(RuntimeError):
    pass


class MapboxClient:
    def __init__(self, settings: Settings, client: Optional[httpx.AsyncClient] = None):
        self.settings = settings
        self._client = client
        self._owns_client = client is None

    async def __aenter__(self) -> "MapboxClient":
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=60.0)
        return self

    async def __aexit__(self, *args: object) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()

    def _require_token(self) -> str:
        if not self.settings.mapbox_ready():
            raise MapboxError(
                "MAPBOX_ACCESS_TOKEN is not set. Add it to backend/.env to enable matching."
            )
        return self.settings.mapbox_access_token.strip()

    async def map_match(
        self,
        points: list[TrackPoint],
        profile: str = "driving",
        radiuses: Optional[list[float]] = None,
    ) -> dict[str, Any]:
        if len(points) < 2:
            raise MapboxError("Need at least 2 points for map matching")
        token = self._require_token()
        profile_path = PROFILE_MAP.get(profile, PROFILE_MAP["driving"])
        chunk_size = self.settings.match_chunk_size
        geometries: list[list[TrackPoint]] = []
        confidences: list[float] = []

        assert self._client is not None
        for start in range(0, len(points), chunk_size - 1 if len(points) > chunk_size else chunk_size):
            chunk = points[start : start + chunk_size]
            if len(chunk) < 2:
                continue
            coords = ";".join(f"{p.lon:.6f},{p.lat:.6f}" for p in chunk)
            url = f"{self.settings.mapbox_base_url}/matching/v5/{profile_path}/{coords}"
            params: dict[str, Any] = {
                "access_token": token,
                "geometries": "geojson",
                "overview": "full",
                "tidy": "true",
            }
            if radiuses:
                chunk_r = radiuses[start : start + len(chunk)]
                if len(chunk_r) == len(chunk):
                    params["radiuses"] = ";".join(str(int(r)) for r in chunk_r)

            resp = await self._client.get(url, params=params)
            if resp.status_code >= 400:
                raise MapboxError(f"Map Matching failed ({resp.status_code}): {resp.text[:300]}")
            payload = resp.json()
            if payload.get("code") not in (None, "Ok"):
                # Continue trying other chunks/profiles; caller decides
                raise MapboxError(f"Map Matching code={payload.get('code')}: {payload.get('message')}")
            matchings = payload.get("matchings") or []
            if not matchings:
                raise MapboxError("Map Matching returned no matchings")
            best = max(matchings, key=lambda m: m.get("confidence", 0))
            confidences.append(float(best.get("confidence") or 0))
            geom = best.get("geometry") or {}
            coords_out = geom.get("coordinates") or []
            geometries.append([TrackPoint(lon=c[0], lat=c[1]) for c in coords_out])

        merged: list[TrackPoint] = []
        for part in geometries:
            if not merged:
                merged = part
            else:
                # Avoid duplicating join point
                merged.extend(part[1:] if part and merged and part[0].lat == merged[-1].lat else part)

        return {
            "geometry": merged,
            "confidence": sum(confidences) / len(confidences) if confidences else None,
            "profile": profile,
        }

    async def directions(
        self,
        start: TrackPoint,
        end: TrackPoint,
        profile: str = "driving",
        alternatives: bool = True,
    ) -> list[dict[str, Any]]:
        token = self._require_token()
        profile_path = PROFILE_MAP.get(profile, PROFILE_MAP["driving"])
        coords = f"{start.lon:.6f},{start.lat:.6f};{end.lon:.6f},{end.lat:.6f}"
        url = f"{self.settings.mapbox_base_url}/directions/v5/{profile_path}/{coords}"
        params = {
            "access_token": token,
            "geometries": "geojson",
            "overview": "full",
            "alternatives": "true" if alternatives else "false",
        }
        assert self._client is not None
        resp = await self._client.get(url, params=params)
        if resp.status_code >= 400:
            raise MapboxError(f"Directions failed ({resp.status_code}): {resp.text[:300]}")
        payload = resp.json()
        routes = payload.get("routes") or []
        if not routes:
            raise MapboxError("Directions returned no routes")
        out: list[dict[str, Any]] = []
        for idx, route in enumerate(routes):
            coords_out = (route.get("geometry") or {}).get("coordinates") or []
            geometry = [TrackPoint(lon=c[0], lat=c[1]) for c in coords_out]
            out.append(
                {
                    "geometry": geometry,
                    "distance": route.get("distance"),
                    "duration": route.get("duration"),
                    "profile": profile,
                    "alternative_index": idx,
                }
            )
        return out
