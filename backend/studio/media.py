from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import warnings
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from PIL import Image, UnidentifiedImageError

from .config import Settings, get_settings

Image.MAX_IMAGE_PIXELS = 24_000_000
KINDS = {"image", "video", "voice", "music", "character"}


def private_path(path: str | Path, settings: Settings | None = None) -> Path:
    settings = settings or get_settings()
    candidate = Path(path).resolve()
    if not candidate.is_relative_to(settings.media_root) or not candidate.is_file():
        raise ValueError("The private media file is unavailable.")
    return candidate


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_integrity(asset: dict, settings: Settings | None = None) -> Path:
    path = private_path(asset["path"], settings)
    if asset.get("sha256") and digest(path) != asset["sha256"]:
        raise ValueError("A media file failed its integrity check. Upload it again.")
    return path


def inspect_media(path: Path, kind: str) -> dict:
    if kind not in KINDS:
        raise ValueError("Unsupported asset type.")
    if kind in {"image", "character"}:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(path) as img:
                    fmt = img.format
                    if fmt not in {"PNG", "JPEG", "WEBP"} or getattr(img, "is_animated", False):
                        raise ValueError("Use a still PNG, JPEG, or WebP image.")
                    width, height = img.size
                    if min(width, height) < 8 or max(width, height) > 8192:
                        raise ValueError("Image dimensions must be between 8 and 8192 pixels.")
                    img.verify()
                with Image.open(path) as img:
                    img.load()
            mime, extension = {"PNG": ("image/png", ".png"), "JPEG": ("image/jpeg", ".jpg"), "WEBP": ("image/webp", ".webp")}[fmt]
            return dict(mime_type=mime, extension=extension, width=width, height=height, duration=None, metadata_json={})
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
            raise ValueError("The image could not be decoded safely.") from exc
    try:
        with path.open("rb") as source:
            signature = source.read(16)
        # Reject playlists and arbitrary text before a demuxer can follow file references.
        allowed_container = (signature.startswith((b"ID3", b"RIFF", b"OggS", b"fLaC", b"\x1aE\xdf\xa3"))
                             or signature[4:8] == b"ftyp"
                             or len(signature) >= 2 and signature[0] == 0xFF and signature[1] & 0xE0 == 0xE0)
        if not allowed_container:
            raise ValueError("Unsupported media container. Use a standard image, MP4, WebM, or audio file.")
        completed = subprocess.run([
            "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_format", "-show_streams", "-of", "json", str(path)
        ], capture_output=True, timeout=20, check=True)
        if len(completed.stdout) > 100000:
            raise ValueError("Media metadata exceeds the allowed size.")
        probe = json.loads(completed.stdout)
        streams = probe.get("streams", [])
        if not streams or len(streams) > 8:
            raise ValueError("Media must contain a bounded number of audio/video streams.")
        duration = float(probe.get("format", {}).get("duration", "nan"))
        if not math.isfinite(duration) or not 0.1 <= duration <= 1200:
            raise ValueError("Media duration must be between 0.1 seconds and 20 minutes.")
        videos = [s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")]
        audios = [s for s in streams if s.get("codec_type") == "audio"]
        formats = set(probe.get("format", {}).get("format_name", "").split(","))
        if kind == "video":
            if len(videos) != 1 or not formats.intersection({"mov", "mp4", "matroska", "webm"}):
                raise ValueError("Use an MP4 or WebM video containing one video track.")
            stream = videos[0]
            width, height = int(stream["width"]), int(stream["height"])
            if min(width, height) < 8 or max(width, height) > 4096 or width * height > 4096 * 2160:
                raise ValueError("Video dimensions exceed the supported 4K limit.")
            webm = bool(formats.intersection({"webm", "matroska"}))
            mime, extension = ("video/webm", ".webm") if webm else ("video/mp4", ".mp4")
        else:
            if videos or len(audios) != 1:
                raise ValueError("Narration and music must contain one audio track and no video.")
            width = height = None
            if "mp3" in formats:
                mime, extension = "audio/mpeg", ".mp3"
            elif "wav" in formats:
                mime, extension = "audio/wav", ".wav"
            elif formats.intersection({"ogg"}):
                mime, extension = "audio/ogg", ".ogg"
            elif formats.intersection({"mov", "mp4", "m4a"}):
                mime, extension = "audio/mp4", ".m4a"
            elif "flac" in formats:
                mime, extension = "audio/flac", ".flac"
            else:
                raise ValueError("Use MP3, WAV, Ogg, FLAC, or M4A audio.")
        subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-i", str(path), "-t", "0.2", "-f", "null", "-"],
                       capture_output=True, timeout=20, check=True)
        return dict(mime_type=mime, extension=extension, duration=duration, width=width, height=height, metadata_json={})
    except FileNotFoundError as exc:
        raise ValueError("Audio and video processing requires FFmpeg on the server.") from exc
    except (subprocess.SubprocessError, KeyError, json.JSONDecodeError) as exc:
        raise ValueError("The media file could not be decoded safely.") from exc


def admit_generated(path: Path, kind: str, settings: Settings | None = None) -> dict:
    """Validate a private temporary provider/upload file and store an immutable copy."""
    settings = settings or get_settings()
    if not path.is_file() or not 0 < path.stat().st_size <= settings.max_upload_bytes:
        raise ValueError("The media file is empty or exceeds the 100 MB limit.")
    properties = inspect_media(path, kind)
    directory = settings.media_root / "assets"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = directory / f"{uuid4()}{properties.pop('extension')}"
    with path.open("rb") as source, destination.open("xb") as target:
        shutil.copyfileobj(source, target, 1024 * 1024)
    destination.chmod(0o600)
    return {**properties, "path": str(destination), "sha256": digest(destination), "byte_size": destination.stat().st_size}


async def admit_upload(upload: UploadFile, kind: str, settings: Settings | None = None) -> dict:
    settings = settings or get_settings()
    directory = settings.media_root / "temporary"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, filename = tempfile.mkstemp(prefix="upload-", dir=directory)
    path = Path(filename)
    size = 0
    try:
        with os.fdopen(fd, "wb") as output:
            while chunk := await upload.read(1024 * 1024):
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise ValueError("The upload exceeds the 100 MB limit.")
                output.write(chunk)
        return admit_generated(path, kind, settings)
    finally:
        path.unlink(missing_ok=True)
        await upload.close()


def media_response(path: Path, request: Request, mime_type: str, filename: str | None = None):
    path = private_path(path)
    size = path.stat().st_size
    start, end, status = 0, size - 1, 200
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}
    value = request.headers.get("range")
    if value:
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
        if not match or not any(match.groups()):
            raise HTTPException(416, "Unsupported byte range.", headers={"Content-Range": f"bytes */{size}"})
        first, last = match.groups()
        if first:
            start = int(first)
            end = min(int(last), size - 1) if last else size - 1
        else:
            start, end = max(0, size - int(last)), size - 1
        if start >= size or end < start:
            raise HTTPException(416, "Byte range is outside the file.", headers={"Content-Range": f"bytes */{size}"})
        status = 206
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    headers["Content-Length"] = str(end - start + 1)
    if filename:
        safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", filename)[:150]
        headers["Content-Disposition"] = f'attachment; filename="{safe_name}"'

    def content():
        with path.open("rb") as source:
            source.seek(start)
            remaining = end - start + 1
            while remaining:
                chunk = source.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk
    return StreamingResponse(content(), status_code=status, media_type=mime_type, headers=headers)
