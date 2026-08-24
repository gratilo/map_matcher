from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    mapbox_access_token: str = ""
    mapbox_base_url: str = "https://api.mapbox.com"
    max_upload_mb: int = 25
    # Anomaly thresholds (mixed activity: conservative defaults)
    gap_time_seconds: float = 45.0
    gap_distance_meters: float = 80.0
    max_speed_mps: float = 55.0  # ~198 km/h ceiling for mixed
    spike_distance_meters: float = 120.0
    match_chunk_size: int = 95  # Mapbox limit is 100
    default_profiles: tuple[str, ...] = ("driving", "cycling", "walking")

    def mapbox_ready(self) -> bool:
        token = self.mapbox_access_token.strip()
        if not token.startswith("pk."):
            return False
        if len(token) < 40:
            return False
        placeholders = ("your_mapbox_token", "pk.your_", "replace_me", "changeme")
        lowered = token.lower()
        return not any(p in lowered for p in placeholders)


@lru_cache
def get_settings() -> Settings:
    return Settings()


def effective_settings(mapbox_token: str | None = None) -> Settings:
    """Server .env token, overridden by per-request user token when provided."""
    base = get_settings()
    token = (mapbox_token or "").strip()
    if not token:
        return base
    return base.model_copy(update={"mapbox_access_token": token})
