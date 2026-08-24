from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


class AnomalyType(str, Enum):
    GAP = "gap"
    SPIKE = "spike"
    JUMP = "jump"
    NOISE = "noise"
    OFF_ROAD = "off_road"


class Profile(str, Enum):
    DRIVING = "driving"
    CYCLING = "cycling"
    WALKING = "walking"
    MIXED = "mixed"


class TrackPoint(BaseModel):
    lat: float
    lon: float
    ele: Optional[float] = None
    time: Optional[datetime] = None
    hdop: Optional[float] = None


class Track(BaseModel):
    name: Optional[str] = None
    points: list[TrackPoint] = Field(default_factory=list)
    source_format: str = "gpx"
    metadata: dict[str, Any] = Field(default_factory=dict)

    @property
    def bbox(self) -> Optional[tuple[float, float, float, float]]:
        if not self.points:
            return None
        lats = [p.lat for p in self.points]
        lons = [p.lon for p in self.points]
        return (min(lons), min(lats), max(lons), max(lats))


class Anomaly(BaseModel):
    id: str
    type: AnomalyType
    start_index: int
    end_index: int
    severity: float = Field(ge=0, le=1)
    message: str
    metrics: dict[str, Any] = Field(default_factory=dict)


class RepairOption(BaseModel):
    id: str
    anomaly_id: str
    label: str
    description: str
    profile: Optional[str] = None
    method: str  # map_match | directions_fill | interpolate | keep | discard
    confidence: Optional[float] = None
    geometry: list[TrackPoint] = Field(default_factory=list)
    replaces_from: int
    replaces_to: int


class AnalysisResult(BaseModel):
    track_id: str
    track: Track
    anomalies: list[Anomaly]
    options: list[RepairOption]
    summary: dict[str, Any] = Field(default_factory=dict)


class ApplyRepairsRequest(BaseModel):
    track_id: str
    selections: dict[str, str]  # anomaly_id -> option_id
    export_format: str = "gpx"


class ApplyRepairsResponse(BaseModel):
    track_id: str
    point_count: int
    applied: list[str]
    download_path: str
    track: Optional[Track] = None


class ConnectRequest(BaseModel):
    track_id: str
    start_index: int
    end_index: int
    profile: str = "mixed"


class ConnectResponse(BaseModel):
    track_id: str
    connect_id: str
    start_index: int
    end_index: int
    options: list[RepairOption]
    message: str = ""


class SupplementRequest(BaseModel):
    track_id: str
    start_index: int
    end_index: int
    profile: str = "mixed"


class SupplementResponse(BaseModel):
    track_id: str
    supplement_id: str
    start_index: int
    end_index: int
    options: list[RepairOption]
    message: str = ""


class MapboxTokenRequest(BaseModel):
    token: str


class MapboxTokenResponse(BaseModel):
    ok: bool
    mapbox_configured: bool
    source: str  # user | server | none
    message: str = ""
