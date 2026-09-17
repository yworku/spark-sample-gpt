from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    database_url: str
    media_root: Path
    environment: str
    owner_password_hash: str
    allowed_origins: tuple[str, ...]
    session_secure: bool
    openai_api_key: str
    openai_base_url: str
    story_model: str
    image_model: str
    speech_model: str
    video_model: str = "gen4.5"
    runway_api_key: str = ""
    runway_base_url: str = "https://api.dev.runwayml.com/v1"
    runway_output_hosts: tuple[str, ...] = ("dnznrvs05pmza.cloudfront.net",)
    elevenlabs_api_key: str = ""
    elevenlabs_base_url: str = "https://api.elevenlabs.io/v1"
    music_model: str = "music_v1"
    provider_timeout_seconds: int = 300
    session_hours: int = 24
    max_upload_bytes: int = 100 * 1024 * 1024
    max_project_assets: int = 500
    max_pending_jobs: int = 8
    frontend_dist: Path | None = None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    environment = os.getenv("STUDIO_ENV", "production")
    database_url = os.getenv("DATABASE_URL", "postgresql+psycopg://studio:studio@db:5432/studio")
    if database_url.startswith("postgresql://"):
        database_url = database_url.replace("postgresql://", "postgresql+psycopg://", 1)
    if not database_url.startswith("postgresql+psycopg://") and not (
        environment == "test" and database_url.startswith("sqlite")
    ):
        raise RuntimeError("Production requires PostgreSQL. SQLite is permitted only in tests.")
    media_root = Path(os.getenv("STUDIO_MEDIA_ROOT", "/data/media")).resolve()
    origins = tuple(item.strip().rstrip("/") for item in os.getenv(
        "STUDIO_ALLOWED_ORIGINS", "http://localhost:8000,http://localhost:5173"
    ).split(",") if item.strip())
    if not origins or any(not value.startswith(("https://", "http://")) or "*" in value for value in origins):
        raise RuntimeError("STUDIO_ALLOWED_ORIGINS must contain explicit HTTP origins.")
    frontend = os.getenv("STUDIO_FRONTEND_DIST", "")
    return Settings(
        database_url=database_url,
        media_root=media_root,
        environment=environment,
        owner_password_hash=os.getenv("STUDIO_OWNER_PASSWORD_HASH", ""),
        allowed_origins=origins,
        session_secure=os.getenv("STUDIO_SECURE_COOKIES", "true").lower() == "true",
        openai_api_key=os.getenv("OPENAI_API_KEY", ""),
        openai_base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        story_model=os.getenv("STUDIO_STORY_MODEL", "gpt-4.1-mini"),
        image_model=os.getenv("STUDIO_IMAGE_MODEL", "gpt-image-1"),
        speech_model=os.getenv("STUDIO_SPEECH_MODEL", "gpt-4o-mini-tts"),
        video_model=os.getenv("STUDIO_VIDEO_MODEL", "gen4.5"),
        runway_api_key=os.getenv("RUNWAY_API_KEY", ""),
        runway_base_url=os.getenv("RUNWAY_BASE_URL", "https://api.dev.runwayml.com/v1"),
        runway_output_hosts=tuple(x.strip() for x in os.getenv("STUDIO_RUNWAY_OUTPUT_HOSTS", "dnznrvs05pmza.cloudfront.net").split(",") if x.strip()),
        elevenlabs_api_key=os.getenv("ELEVENLABS_API_KEY", ""),
        elevenlabs_base_url=os.getenv("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io/v1"),
        music_model=os.getenv("STUDIO_MUSIC_MODEL", "music_v1"),
        provider_timeout_seconds=int(os.getenv("STUDIO_PROVIDER_TIMEOUT_SECONDS", "300")),
        frontend_dist=Path(frontend).resolve() if frontend else None,
    )
