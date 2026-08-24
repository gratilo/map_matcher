from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from threading import Lock
from typing import Optional

from app.models import AnalysisResult, RepairOption, Track


@dataclass
class SessionRecord:
    track_id: str
    analysis: AnalysisResult
    options_by_id: dict[str, RepairOption]
    repaired: Optional[Track] = None
    created_at: float = field(default_factory=time.time)


class SessionStore:
    def __init__(self, ttl_seconds: int = 3600):
        self.ttl_seconds = ttl_seconds
        self._lock = Lock()
        self._items: dict[str, SessionRecord] = {}

    def put(self, analysis: AnalysisResult) -> SessionRecord:
        self._cleanup()
        options_by_id = {o.id: o for o in analysis.options}
        rec = SessionRecord(track_id=analysis.track_id, analysis=analysis, options_by_id=options_by_id)
        with self._lock:
            self._items[analysis.track_id] = rec
        return rec

    def get(self, track_id: str) -> Optional[SessionRecord]:
        self._cleanup()
        with self._lock:
            return self._items.get(track_id)

    def set_repaired(self, track_id: str, track: Track) -> None:
        with self._lock:
            rec = self._items.get(track_id)
            if rec is None:
                raise KeyError(track_id)
            rec.repaired = track

    def add_options(self, track_id: str, options: list[RepairOption]) -> None:
        with self._lock:
            rec = self._items.get(track_id)
            if rec is None:
                raise KeyError(track_id)
            existing_ids = {o.id for o in rec.analysis.options}
            for opt in options:
                rec.options_by_id[opt.id] = opt
                if opt.id not in existing_ids:
                    rec.analysis.options.append(opt)

    def _cleanup(self) -> None:
        now = time.time()
        with self._lock:
            expired = [k for k, v in self._items.items() if now - v.created_at > self.ttl_seconds]
            for k in expired:
                del self._items[k]


def new_track_id() -> str:
    return uuid.uuid4().hex
