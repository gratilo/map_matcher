from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from app.analysis.anomalies import detect_anomalies
from app.config import get_settings
from app.export import export_track
from app.geo import path_length_m
from app.matching.mapbox import MapboxError
from app.models import (
    AnalysisResult,
    ApplyRepairsRequest,
    ApplyRepairsResponse,
    ConnectRequest,
    ConnectResponse,
)
from app.parsers.track_parser import parse_track
from app.repair.engine import apply_repairs, build_manual_connect_options
from app.store import SessionStore, new_track_id

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIR = ROOT / "frontend"

app = FastAPI(title="GPS Track Repair", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

store = SessionStore()


@app.get("/api/health")
async def health() -> dict:
    settings = get_settings()
    return {
        "ok": True,
        "mapbox_configured": settings.mapbox_ready(),
    }


@app.post("/api/analyze", response_model=AnalysisResult)
async def analyze(
    file: UploadFile = File(...),
    profile: str = Form("mixed"),
) -> AnalysisResult:
    """Parse track and detect anomaly hints. Mapbox routes are built on /api/connect."""
    settings = get_settings()
    raw = await file.read()
    max_bytes = settings.max_upload_mb * 1024 * 1024
    if len(raw) > max_bytes:
        raise HTTPException(status_code=413, detail=f"File too large (max {settings.max_upload_mb} MB)")
    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename required")

    try:
        track = parse_track(file.filename, raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if len(track.points) < 2:
        raise HTTPException(status_code=400, detail="Track must contain at least 2 points")

    anomalies = detect_anomalies(track, settings)

    analysis = AnalysisResult(
        track_id=new_track_id(),
        track=track,
        anomalies=anomalies,
        options=[],
        summary={
            "point_count": len(track.points),
            "length_m": round(path_length_m(track.points), 1),
            "anomaly_count": len(anomalies),
            "option_count": 0,
            "mapbox_configured": settings.mapbox_ready(),
            "profile": profile,
            "mode": "manual_connect",
        },
    )
    store.put(analysis)
    return analysis


@app.post("/api/connect", response_model=ConnectResponse)
async def connect(body: ConnectRequest) -> ConnectResponse:
    """User picked points A and B — propose Mapbox road routes between them."""
    settings = get_settings()
    rec = store.get(body.track_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Track session not found or expired")

    track = store.current_track(body.track_id)
    try:
        options = await build_manual_connect_options(
            track,
            body.start_index,
            body.end_index,
            settings,
            profile_hint=body.profile,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except MapboxError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    store.add_options(body.track_id, options)
    connect_id = options[0].anomaly_id
    lo, hi = sorted((body.start_index, body.end_index))
    road_n = sum(1 for o in options if o.method == "directions_fill")
    return ConnectResponse(
        track_id=body.track_id,
        connect_id=connect_id,
        start_index=lo,
        end_index=hi,
        options=options,
        message=f"Найдено вариантов по карте: {road_n}. Выберите маршрут на карте или в списке.",
    )


@app.post("/api/apply", response_model=ApplyRepairsResponse)
async def apply(body: ApplyRepairsRequest) -> ApplyRepairsResponse:
    rec = store.get(body.track_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Track session not found or expired")

    track = store.current_track(body.track_id)
    try:
        repaired = apply_repairs(track, rec.options_by_id, body.selections)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    store.set_repaired(body.track_id, repaired)
    # Re-detect hints on repaired track for next manual fix
    settings = get_settings()
    rec.analysis.anomalies = detect_anomalies(repaired, settings)
    rec.analysis.track = repaired
    rec.analysis.summary["point_count"] = len(repaired.points)
    rec.analysis.summary["length_m"] = round(path_length_m(repaired.points), 1)
    rec.analysis.summary["anomaly_count"] = len(rec.analysis.anomalies)

    return ApplyRepairsResponse(
        track_id=body.track_id,
        point_count=len(repaired.points),
        applied=list(body.selections.values()),
        download_path=f"/api/download/{body.track_id}?format={body.export_format}",
        track=repaired,
        anomalies=rec.analysis.anomalies,
    )


@app.get("/api/download/{track_id}")
async def download(track_id: str, format: str = "gpx") -> Response:
    rec = store.get(track_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Track session not found or expired")
    track = rec.repaired or rec.analysis.track
    try:
        data, media, filename = export_track(track, format)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return Response(
        content=data,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
        reload=True,
    )
