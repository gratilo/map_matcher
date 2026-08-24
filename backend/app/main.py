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
from app.models import AnalysisResult, ApplyRepairsRequest, ApplyRepairsResponse
from app.parsers.track_parser import parse_track
from app.repair.engine import apply_repairs, build_repair_options
from app.store import SessionStore, new_track_id

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIR = ROOT / "frontend"

app = FastAPI(title="GPS Track Repair", version="0.1.0")
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
    options = await build_repair_options(track, anomalies, settings, profile_hint=profile)

    analysis = AnalysisResult(
        track_id=new_track_id(),
        track=track,
        anomalies=anomalies,
        options=options,
        summary={
            "point_count": len(track.points),
            "length_m": round(path_length_m(track.points), 1),
            "anomaly_count": len(anomalies),
            "option_count": len(options),
            "mapbox_configured": settings.mapbox_ready(),
            "profile": profile,
        },
    )
    store.put(analysis)
    return analysis


@app.post("/api/apply", response_model=ApplyRepairsResponse)
async def apply(body: ApplyRepairsRequest) -> ApplyRepairsResponse:
    rec = store.get(body.track_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="Track session not found or expired")

    try:
        repaired = apply_repairs(rec.analysis.track, rec.options_by_id, body.selections)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    store.set_repaired(body.track_id, repaired)
    return ApplyRepairsResponse(
        track_id=body.track_id,
        point_count=len(repaired.points),
        applied=list(body.selections.values()),
        download_path=f"/api/download/{body.track_id}?format={body.export_format}",
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
