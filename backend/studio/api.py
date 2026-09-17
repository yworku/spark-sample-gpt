from __future__ import annotations

import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Annotated
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth import check_origin, require_owner, session_owner, sign_in, sign_out
from .config import get_settings
from .db import get_session
from .media import admit_generated, admit_upload, media_response, private_path, verify_integrity
from .models import AssetRow, ExportRow, JobRow, ProjectRow, utcnow
from .schemas import Character, CreateJob, CreateProject, ImportAsset, ImportCharacter, Login, ProjectDocument, UpdateProject, initial_document

log = logging.getLogger("studio.api")
app = FastAPI(title="Spark Studio", docs_url=None, redoc_url=None)
Database = Annotated[Session, Depends(get_session)]
Owner = Annotated[str, Depends(require_owner)]


class BodyLimitExceeded(HTTPException):
    def __init__(self):
        super().__init__(413, "The request exceeds the upload limit.")


class BodySizeLimit:
    """Cap bytes as they arrive, including chunked multipart before spooling completes."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api"):
            return await self.app(scope, receive, send)
        limit = get_settings().max_upload_bytes + 1024 * 1024
        received = 0

        async def bounded_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise BodyLimitExceeded()
            return message
        await self.app(scope, bounded_receive, send)


app.add_middleware(BodySizeLimit)

STYLES = [
    {"id": "3d-cartoon", "name": "3D Cartoon", "category": "Animation", "prompt": "Polished stylized 3D animation, expressive characters, soft global illumination."},
    {"id": "papercraft", "name": "PaperCraft", "category": "Animation", "prompt": "Handcrafted layered paper diorama, folded paper characters, tactile cut edges and soft shadows."},
    {"id": "animated-3d", "name": "Animated 3D", "category": "Animation", "prompt": "Detailed cinematic 3D animation, appealing character design, rich materials and expressive lighting."},
    {"id": "building-blocks", "name": "Building Blocks", "category": "Animation", "prompt": "Playful interlocking plastic building-block world, miniature block characters, bright studio lighting."},
    {"id": "stick-figure", "name": "Stick Figure", "category": "Animation", "prompt": "Expressive minimalist stick-figure illustration, simple geometric props, clean uncluttered background."},
    {"id": "voxel", "name": "Voxel", "category": "Animation", "prompt": "Three-dimensional voxel art, block-built characters and environments, warm ambient lighting."},
    {"id": "low-poly", "name": "Low Poly", "category": "Animation", "prompt": "Faceted low-polygon 3D art, geometric shapes, elegant limited palette, soft directional lighting."},
    {"id": "urban-cartoon", "name": "Urban Cartoon", "category": "Animation", "prompt": "Contemporary urban cartoon, bold expressive shapes, graphic street-inspired textures and vibrant colors."},
    {"id": "anime", "name": "Anime", "category": "Animation", "prompt": "Hand-drawn anime illustration, clean linework, expressive cinematic composition."},
    {"id": "storybook", "name": "Storybook", "category": "Animation", "prompt": "Warm illustrated storybook art, charming shapes, gentle colors and rich details."},
    {"id": "classic-animation", "name": "Classic Animation", "category": "Animation", "prompt": "Traditional hand-drawn cel animation, expressive silhouettes, painted backgrounds, charming fluid poses."},
    {"id": "clay", "name": "Claymation", "category": "Animation", "prompt": "Handcrafted clay animation aesthetic, tactile surfaces, miniature set lighting."},
    {"id": "sketch", "name": "Sketch", "category": "Illustration", "prompt": "Expressive pencil-and-charcoal sketch on textured paper, confident linework and delicate crosshatching."},
    {"id": "watercolor", "name": "Watercolor", "category": "Illustration", "prompt": "Delicate watercolor illustration, textured paper, soft washes of color."},
    {"id": "cartoon", "name": "Cartoon", "category": "Illustration", "prompt": "Colorful editorial cartoon illustration, rounded forms, clear outlines, exaggerated expressive characters."},
    {"id": "comic", "name": "Comic Book", "category": "Illustration", "prompt": "Bold comic-book illustration, ink outlines, expressive poses, vibrant colors."},
    {"id": "oil-painting", "name": "Oil Painting", "category": "Fine Art", "prompt": "Rich oil painting on canvas, visible brushwork, layered pigments, luminous painterly light."},
    {"id": "impressionist", "name": "Impressionist", "category": "Fine Art", "prompt": "Impressionist painting, loose broken brushstrokes, atmospheric daylight, vivid color relationships."},
    {"id": "surrealist", "name": "Surrealist", "category": "Fine Art", "prompt": "Surrealist art, dreamlike visual juxtapositions, meticulous painterly detail and imaginative symbolism."},
    {"id": "ukiyo-e", "name": "Ukiyo-e", "category": "Fine Art", "prompt": "Traditional Japanese ukiyo-e woodblock print aesthetic, flat color planes, flowing contours and delicate paper texture."},
    {"id": "expressionist", "name": "Expressionist", "category": "Fine Art", "prompt": "Expressionist painting, emotionally charged color, bold gestural strokes, expressive distorted forms."},
    {"id": "vaporwave", "name": "Vaporwave", "category": "Contemporary", "prompt": "Vaporwave aesthetic, pastel pink and aqua, nostalgic digital textures, dreamy retro-futuristic atmosphere."},
    {"id": "synthwave", "name": "Synthwave", "category": "Contemporary", "prompt": "Synthwave art, electric neon magenta and cyan, retro-futuristic lighting, dramatic nighttime atmosphere."},
    {"id": "isometric", "name": "Isometric", "category": "Contemporary", "prompt": "Precise isometric illustration, three-quarter orthographic view, clean geometric forms and harmonious colors."},
    {"id": "pixel", "name": "Pixel Art", "category": "Contemporary", "prompt": "Detailed pixel art, controlled color palette, crisp pixel clusters."},
    {"id": "cinematic", "name": "Cinematic", "category": "Contemporary", "prompt": "Cinematic photography, expressive composition, dramatic natural lighting."},
]
VOICES = [
    {"id": "alloy", "name": "Alloy", "description": "Balanced and versatile"},
    {"id": "echo", "name": "Echo", "description": "Clear and assured"},
    {"id": "fable", "name": "Fable", "description": "Expressive storytelling"},
    {"id": "onyx", "name": "Onyx", "description": "Deep and grounded"},
    {"id": "nova", "name": "Nova", "description": "Warm and engaging"},
    {"id": "shimmer", "name": "Shimmer", "description": "Bright and gentle"},
]


@app.middleware("http")
async def security_headers(request: Request, call_next):
    if request.url.path.startswith("/api"):
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            try:
                check_origin(request)
                length = request.headers.get("content-length")
                if length and int(length) > get_settings().max_upload_bytes + 1024 * 1024:
                    return JSONResponse({"detail": "The request exceeds the upload limit."}, status_code=413)
            except (HTTPException, ValueError) as exc:
                return JSONResponse({"detail": exc.detail if isinstance(exc, HTTPException) else "Invalid request length."}, status_code=exc.status_code if isinstance(exc, HTTPException) else 400)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["X-Frame-Options"] = "DENY"
    if request.url.path.startswith("/api"):
        response.headers["Cache-Control"] = "private, no-store"
    return response


@app.exception_handler(RequestValidationError)
async def validation_error(_request, exc):
    # Pydantic errors otherwise include the rejected input, including login passwords.
    errors = [{"loc": error["loc"], "msg": error["msg"], "type": error["type"]} for error in exc.errors()]
    return JSONResponse({"detail": errors}, status_code=422)


@app.exception_handler(BodyLimitExceeded)
async def body_limit_error(_request, _exc):
    return JSONResponse({"detail": "The request exceeds the upload limit."}, status_code=413)


@app.exception_handler(Exception)
async def unexpected_error(_request, exc):
    log.error("Unhandled API failure: %s", type(exc).__name__)
    return JSONResponse({"detail": "The request could not be completed. Please try again."}, status_code=500)


def project_row(db: Session, project_id: str, owner: str, *, deleted=False, lock=False) -> ProjectRow:
    query = select(ProjectRow).where(ProjectRow.id == project_id, ProjectRow.owner_id == owner)
    if not deleted:
        query = query.where(ProjectRow.deleted_at.is_(None))
    if lock:
        query = query.with_for_update()
    row = db.scalar(query)
    if row is None:
        raise HTTPException(404, "Project not found.")
    return row


def project_json(row: ProjectRow):
    return {**row.document, "id": row.id, "revision": row.revision, "created_at": row.created_at.isoformat(),
            "updated_at": row.updated_at.isoformat(), "deleted_at": row.deleted_at.isoformat() if row.deleted_at else None}


def asset_json(row: AssetRow):
    return {"id": row.id, "project_id": row.project_id, "scene_id": row.scene_id, "character_id": row.character_id,
            "kind": row.kind, "name": row.name, "mime_type": row.mime_type, "url": f"/api/assets/{row.id}/file",
            "duration": row.duration, "width": row.width, "height": row.height, "created_at": row.created_at.isoformat(),
            "source": row.source, "metadata": row.metadata_json}


def job_json(row: JobRow):
    return {"id": row.id, "project_id": row.project_id, "kind": row.kind, "status": row.status,
            "scene_id": row.request.get("scene_id"), "character_id": row.request.get("character_id"),
            "progress": row.progress, "error": row.error, "result": row.result, "created_at": row.created_at.isoformat()}


def export_json(row: ExportRow):
    return {"id": row.id, "project_id": row.project_id, "revision": row.revision, "url": f"/api/exports/{row.id}/file",
            "resolution": row.resolution, "duration": row.duration, "byte_size": row.byte_size, "created_at": row.created_at.isoformat()}


def assets_for(db: Session, project_id: str) -> dict[str, AssetRow]:
    return {asset.id: asset for asset in db.scalars(select(AssetRow).where(AssetRow.project_id == project_id, AssetRow.deleted_at.is_(None)))}


def asset_snapshot(row: AssetRow) -> dict:
    return {"id": row.id, "path": row.path, "duration": row.duration, "width": row.width, "height": row.height,
            "mime_type": row.mime_type, "kind": row.kind, "sha256": row.sha256, "byte_size": row.byte_size,
            "metadata": row.metadata_json}


def referenced_assets(document: dict) -> set[str]:
    refs = {document.get("music", {}).get("asset_id")}
    for char in document.get("characters", []):
        refs.add(char.get("asset_id"))
    for scene in document.get("scenes", []):
        refs.update(scene.get(key) for key in ("image_id", "video_id", "voice_id"))
        refs.update(layer.get("asset_id") for layer in scene.get("layers", []))
    return refs - {None}


def validate_document(document: ProjectDocument, assets: dict[str, AssetRow]):
    def asset(identifier, kinds):
        if identifier is None:
            return None
        row = assets.get(identifier)
        if row is None or row.kind not in kinds:
            raise HTTPException(422, "A selected asset is missing, has the wrong type, or belongs to another project.")
        return row

    def clip_duration(row, clip):
        if row is None or row.duration is None:
            return None
        end = clip.trim_end if clip.trim_end is not None else row.duration
        if end > row.duration + 0.02 or clip.trim_start >= end:
            raise HTTPException(422, "Clip trim points must fit within the selected recording.")
        return clip.offset + (end - clip.trim_start) / clip.speed

    for character in document.characters:
        asset(character.asset_id, {"character", "image"})
    music = asset(document.music.asset_id, {"music", "voice"})
    if music and music.duration is not None:
        music_end = document.music.trim_end or music.duration
        if music_end > music.duration + 0.02 or document.music.trim_start >= music_end:
            raise HTTPException(422, "Music trim points must fit within the selected recording.")
    durations = []
    allowed_fonts = {"Arial", "Inter", "Roboto", "Sans", "sans", "sans-serif", "Serif", "serif", "mono", "monospace", "DejaVu Sans", "DejaVu Serif", "DejaVu Sans Mono"}
    for scene in document.scenes:
        asset(scene.image_id, {"image", "character"})
        video = asset(scene.video_id, {"video"})
        voice = asset(scene.voice_id, {"voice", "music"})
        vd, ad = clip_duration(video, scene.video), clip_duration(voice, scene.voice)
        duration = scene.duration
        if scene.duration_mode == "voice" and ad is not None:
            duration = ad
        elif scene.duration_mode == "video" and vd is not None:
            duration = vd
        if not 0.1 <= duration <= 120:
            raise HTTPException(422, "A scene duration must be between 0.1 and 120 seconds.")
        durations.append(duration)
        if scene.caption.font not in allowed_fonts:
            raise HTTPException(422, "That caption font is not supported. Choose Sans, Serif, or Mono.")
        if any(word.end > duration + 0.02 for word in scene.caption.words):
            raise HTTPException(422, "Caption timing extends beyond its scene.")
        for layer in scene.layers:
            if layer.kind == "image":
                asset(layer.asset_id, {"image", "character"})
            if layer.start >= duration or (layer.end is not None and layer.end > duration + 0.02):
                raise HTTPException(422, "Layer timing extends beyond its scene.")
    total = sum(durations)
    for i, scene in enumerate(document.scenes[:-1]):
        if scene.transition.type != "none":
            total -= min(scene.transition.duration, durations[i] / 2, durations[i + 1] / 2)
    if total > 1200:
        raise HTTPException(422, "A project cannot exceed 20 minutes.")


@app.get("/api/health")
def health(db: Database):
    try:
        db.execute(text("SELECT version FROM schema_versions WHERE version = 1")).scalar_one()
    except Exception:
        return JSONResponse({"status": "unavailable"}, status_code=503)
    return {"status": "ok"}


@app.get("/api/session")
def get_auth_session(request: Request, db: Database):
    return {"authenticated": session_owner(request, db) is not None}


@app.post("/api/login")
def login(body: Login, request: Request, response: Response, db: Database):
    sign_in(body.password, request, response, db)
    return {"authenticated": True}


@app.post("/api/logout")
def logout(request: Request, response: Response, db: Database):
    sign_out(request, response, db)
    return {"authenticated": False}


@app.get("/api/capabilities")
def capabilities(owner: Owner):
    from .providers import available_voices, capabilities as provider_capabilities
    settings = get_settings()
    return {"project_types": [{"id": "video", "label": "Story video", "enabled": True}, {"id": "music", "label": "Music", "enabled": False}, {"id": "book", "label": "Book", "enabled": False}],
            "providers": provider_capabilities(settings), "voices": [next((voice for voice in VOICES if voice["id"] == identifier), {"id": identifier, "name": identifier.title(), "description": "AI-generated narration"}) for identifier in available_voices(settings)], "styles": STYLES,
            "limits": {"max_scenes": 50, "max_duration": 1200, "max_upload_bytes": settings.max_upload_bytes, "max_pending_jobs": settings.max_pending_jobs}}


@app.get("/api/projects")
def list_projects(db: Database, owner: Owner, deleted: bool = False):
    query = select(ProjectRow).where(ProjectRow.owner_id == owner)
    query = query.where(ProjectRow.deleted_at.is_not(None) if deleted else ProjectRow.deleted_at.is_(None))
    return [project_json(row) for row in db.scalars(query.order_by(ProjectRow.updated_at.desc()))]


@app.post("/api/projects", status_code=201)
def create_project(body: CreateProject, db: Database, owner: Owner):
    try:
        document = initial_document(body)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    validate_document(document, {})
    row = ProjectRow(owner_id=owner, document=document.model_dump())
    db.add(row)
    db.commit()
    return project_json(row)


@app.get("/api/projects/{project_id}")
def get_project(project_id: str, db: Database, owner: Owner):
    return project_json(project_row(db, project_id, owner))


@app.put("/api/projects/{project_id}")
def update_project(project_id: str, body: UpdateProject, db: Database, owner: Owner):
    row = project_row(db, project_id, owner, lock=True)
    if row.revision != body.base_revision:
        raise HTTPException(409, "This project changed in another view. Reload before saving.")
    validate_document(body.document, assets_for(db, project_id))
    # The conditional update also protects SQLite tests and future non-locking adapters.
    result = db.execute(update(ProjectRow).where(ProjectRow.id == row.id, ProjectRow.revision == body.base_revision).values(
        document=body.document.model_dump(), revision=body.base_revision + 1, updated_at=utcnow()).execution_options(synchronize_session=False))
    if result.rowcount != 1:
        raise HTTPException(409, "This project changed in another view. Reload before saving.")
    db.commit()
    db.refresh(row)
    return project_json(row)


@app.delete("/api/projects/{project_id}", status_code=204)
def delete_project(project_id: str, db: Database, owner: Owner):
    row = project_row(db, project_id, owner, lock=True)
    row.deleted_at = utcnow()
    row.updated_at = utcnow()
    jobs = db.scalars(select(JobRow).where(JobRow.project_id == row.id, JobRow.status.in_(["queued", "running"])).with_for_update()).all()
    for job in jobs:
        job.cancel_requested = True
        if job.status == "queued":
            job.status = "cancelled"
        job.updated_at = utcnow()
    db.commit()
    return Response(status_code=204)


@app.post("/api/projects/{project_id}/restore")
def restore_project(project_id: str, db: Database, owner: Owner):
    row = project_row(db, project_id, owner, deleted=True, lock=True)
    row.deleted_at = None
    row.updated_at = utcnow()
    db.commit()
    return project_json(row)


@app.get("/api/projects/{project_id}/assets")
def list_assets(project_id: str, db: Database, owner: Owner):
    project_row(db, project_id, owner)
    return [asset_json(row) for row in assets_for(db, project_id).values()]


@app.post("/api/projects/{project_id}/assets", status_code=201)
async def upload_asset(project_id: str, db: Database, owner: Owner,
                       file: UploadFile = File(...), kind: str = Form(...), scene_id: str | None = Form(None), character_id: str | None = Form(None)):
    row = project_row(db, project_id, owner)
    if scene_id and scene_id not in {scene["id"] for scene in row.document["scenes"]}:
        raise HTTPException(422, "The upload scene does not exist in this project.")
    if character_id and character_id not in {char["id"] for char in row.document["characters"]}:
        raise HTTPException(422, "The upload character does not exist in this project.")
    if db.scalar(select(func.count()).select_from(AssetRow).where(AssetRow.project_id == project_id)) >= get_settings().max_project_assets:
        raise HTTPException(422, "This project has reached its asset limit.")
    try:
        media = await admit_upload(file, kind)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    # Re-check deletion under lock after potentially slow decoding.
    try:
        db.expire_all()
        current = project_row(db, project_id, owner, lock=True)
        if scene_id and scene_id not in {scene["id"] for scene in current.document["scenes"]}:
            raise HTTPException(409, "The selected scene was removed during the upload.")
        if character_id and character_id not in {char["id"] for char in current.document["characters"]}:
            raise HTTPException(409, "The selected character was removed during the upload.")
        if db.scalar(select(func.count()).select_from(AssetRow).where(AssetRow.project_id == project_id)) >= get_settings().max_project_assets:
            raise HTTPException(422, "This project has reached its asset limit.")
        safe_name = re.sub(r"[\x00-\x1f\x7f]", "", Path(file.filename or "Upload").name)[:200] or "Upload"
        asset = AssetRow(project_id=project_id, scene_id=scene_id, character_id=character_id, kind=kind, name=safe_name, source="upload", **media)
        db.add(asset)
        db.commit()
    except HTTPException:
        Path(media["path"]).unlink(missing_ok=True)
        raise
    # A commit acknowledgement can be lost after PostgreSQL committed. Retain the
    # immutable file on unexpected DB errors; later reconciliation can remove orphans.
    return asset_json(asset)


@app.get("/api/assets/{asset_id}/file")
def get_asset_file(asset_id: str, request: Request, db: Database, owner: Owner):
    row = db.get(AssetRow, asset_id)
    if row is None or row.deleted_at is not None:
        raise HTTPException(404, "Asset not found.")
    project_row(db, row.project_id, owner)
    try:
        path = verify_integrity(asset_snapshot(row))
        return media_response(path, request, row.mime_type)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.delete("/api/assets/{asset_id}", status_code=204)
def delete_asset(asset_id: str, db: Database, owner: Owner):
    row = db.get(AssetRow, asset_id)
    if row is None or row.deleted_at is not None:
        raise HTTPException(404, "Asset not found.")
    project = project_row(db, row.project_id, owner, lock=True)
    if asset_id in referenced_assets(project.document):
        raise HTTPException(409, "This asset is selected in your project. Replace it before hiding it.")
    active = db.scalars(select(JobRow).where(JobRow.project_id == project.id, JobRow.status.in_(["queued", "running", "unknown"])))
    if any(asset_id in job.snapshot.get("assets", {}) for job in active):
        raise HTTPException(409, "This asset belongs to an active production snapshot.")
    row.deleted_at = utcnow()
    db.commit()
    return Response(status_code=204)


@app.get("/api/projects/{project_id}/jobs")
def list_jobs(project_id: str, db: Database, owner: Owner):
    project_row(db, project_id, owner)
    return [job_json(row) for row in db.scalars(select(JobRow).where(JobRow.project_id == project_id).order_by(JobRow.created_at.desc()).limit(100))]


@app.post("/api/projects/{project_id}/jobs", status_code=202)
def create_job(project_id: str, body: CreateJob, db: Database, owner: Owner):
    from .providers import reference_ids, validate_job
    row = project_row(db, project_id, owner, lock=True)
    request_data = body.model_dump(exclude={"idempotency_key"})
    request_hash = hashlib.sha256(json.dumps(request_data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    existing = db.scalar(select(JobRow).where(JobRow.project_id == project_id, JobRow.idempotency_key == body.idempotency_key))
    if existing:
        if existing.request_hash != request_hash:
            raise HTTPException(409, "This request key has already been used with different settings.")
        return job_json(existing)
    if row.revision != body.base_revision:
        raise HTTPException(409, "Save or reload the current project before starting production.")
    active_count = db.scalar(select(func.count()).select_from(JobRow).where(JobRow.project_id == project_id, JobRow.status.in_(["queued", "running"])))
    if active_count >= get_settings().max_pending_jobs:
        raise HTTPException(429, "Wait for a production job to finish before adding more.")
    assets = assets_for(db, project_id)
    document = ProjectDocument.model_validate(row.document)
    validate_document(document, assets)
    if body.scene_id and body.scene_id not in {s.id for s in document.scenes}:
        raise HTTPException(422, "The selected scene does not exist.")
    if body.character_id and body.character_id not in {c.id for c in document.characters}:
        raise HTTPException(422, "The selected character does not exist.")
    snapshot_assets = {identifier: asset_snapshot(asset) for identifier, asset in assets.items()}
    try:
        validate_job(body.kind, request_data, row.document, snapshot_assets, get_settings())
        # Preserve the source-integrity boundary before provider submission or export.
        required_ids = referenced_assets(row.document) if body.kind == "export" else set(reference_ids(body.kind, request_data, row.document))
        for identifier in required_ids:
            verify_integrity(snapshot_assets[identifier])
        snapshot_assets = {identifier: snapshot_assets[identifier] for identifier in required_ids}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    job = JobRow(project_id=project_id, kind=body.kind, request=request_data,
                 snapshot={"document": row.document, "revision": row.revision, "assets": snapshot_assets,
                           "style_prompt": next((style["prompt"] for style in STYLES if style["id"] == document.style), document.style)},
                 idempotency_key=body.idempotency_key, request_hash=request_hash)
    db.add(job)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(JobRow).where(JobRow.project_id == project_id, JobRow.idempotency_key == body.idempotency_key))
        if existing and existing.request_hash == request_hash:
            return job_json(existing)
        raise HTTPException(409, "A production request with that key already exists.")
    return job_json(job)


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str, db: Database, owner: Owner):
    row = db.get(JobRow, job_id)
    if row is None:
        raise HTTPException(404, "Production job not found.")
    project_row(db, row.project_id, owner, lock=True)
    row = db.scalar(select(JobRow).where(JobRow.id == job_id).with_for_update().execution_options(populate_existing=True))
    if row.status in {"queued", "running"}:
        row.cancel_requested = True
        if row.status == "queued":
            row.status = "cancelled"
        row.updated_at = utcnow()
        db.commit()
    return job_json(row)


@app.get("/api/projects/{project_id}/exports")
def list_exports(project_id: str, db: Database, owner: Owner):
    project_row(db, project_id, owner)
    rows = db.scalars(select(ExportRow).where(ExportRow.project_id == project_id, ExportRow.deleted_at.is_(None)).order_by(ExportRow.created_at.desc()))
    return [export_json(row) for row in rows]


@app.get("/api/exports/{export_id}/file")
def get_export_file(export_id: str, request: Request, db: Database, owner: Owner):
    row = db.get(ExportRow, export_id)
    if row is None or row.deleted_at is not None:
        raise HTTPException(404, "Export not found.")
    project_row(db, row.project_id, owner)
    try:
        return media_response(private_path(row.path), request, "video/mp4", f"spark-studio-r{row.revision}-{row.resolution}p.mp4")
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.delete("/api/exports/{export_id}", status_code=204)
def delete_export(export_id: str, db: Database, owner: Owner):
    row = db.get(ExportRow, export_id)
    if row is None or row.deleted_at is not None:
        raise HTTPException(404, "Export not found.")
    project_row(db, row.project_id, owner, lock=True)
    row.deleted_at = utcnow()
    db.commit()
    return Response(status_code=204)


@app.get("/api/library/characters")
def character_library(db: Database, owner: Owner):
    projects = db.scalars(select(ProjectRow).where(ProjectRow.owner_id == owner, ProjectRow.deleted_at.is_(None)).order_by(ProjectRow.updated_at.desc())).all()
    result = []
    for project in projects:
        assets = assets_for(db, project.id)
        for character in project.document.get("characters", []):
            asset = assets.get(character.get("asset_id"))
            result.append({"id": character["id"], "source_project_id": project.id,
                           "source_character_id": character["id"], "project_name": project.document["name"],
                           "name": character["name"], "description": character["description"],
                           "asset": asset_json(asset) if asset else None})
    return result


@app.get("/api/library/assets")
def asset_library(db: Database, owner: Owner, kind: str | None = None):
    if kind is not None and kind not in {"image", "character", "music", "voice", "video"}:
        raise HTTPException(422, "Choose image, character, music, voice, or video assets.")
    query = select(AssetRow).join(ProjectRow, AssetRow.project_id == ProjectRow.id).where(
        ProjectRow.owner_id == owner, ProjectRow.deleted_at.is_(None), AssetRow.deleted_at.is_(None))
    if kind:
        query = query.where(AssetRow.kind == kind)
    return [asset_json(row) for row in db.scalars(query.order_by(AssetRow.created_at.desc()))]


def lock_library_projects(db: Session, owner: str, source_id: str, target_id: str) -> tuple[ProjectRow, ProjectRow]:
    # Importing opposite directions concurrently must use the same lock order.
    projects = {identifier: project_row(db, identifier, owner, lock=True) for identifier in sorted({source_id, target_id})}
    return projects[source_id], projects[target_id]


def clone_library_asset(db: Session, source: AssetRow, target: ProjectRow, *, scene_id: str | None = None,
                        character_id: str | None = None) -> AssetRow:
    if scene_id and scene_id not in {scene["id"] for scene in target.document["scenes"]}:
        raise HTTPException(422, "The import scene does not exist in this project.")
    if character_id and character_id not in {character["id"] for character in target.document["characters"]}:
        raise HTTPException(422, "The import character does not exist in this project.")
    count = db.scalar(select(func.count()).select_from(AssetRow).where(AssetRow.project_id == target.id))
    if count >= get_settings().max_project_assets:
        raise HTTPException(422, "This project has reached its asset limit.")
    try:
        path = verify_integrity(asset_snapshot(source))
        copied = admit_generated(path, source.kind)
        if copied["sha256"] != source.sha256:
            Path(copied["path"]).unlink(missing_ok=True)
            raise ValueError("The source media changed during import. Try again with a valid reference.")
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    copied["metadata_json"] = {**source.metadata_json, "imported_from_project_id": source.project_id, "imported_from_asset_id": source.id}
    row = AssetRow(id=str(uuid4()), project_id=target.id, scene_id=scene_id, character_id=character_id,
                   kind=source.kind, name=source.name, source=source.source, **copied)
    db.add(row)
    return row


@app.post("/api/projects/{project_id}/assets/import", status_code=201)
def import_asset(project_id: str, body: ImportAsset, db: Database, owner: Owner):
    original = db.get(AssetRow, body.source_asset_id)
    if original is None:
        raise HTTPException(404, "Source asset not found.")
    _source, target = lock_library_projects(db, owner, original.project_id, project_id)
    # Refresh after locking: deletion also acquires the source-project lock.
    db.refresh(original)
    if original.deleted_at is not None:
        raise HTTPException(404, "Source asset not found.")
    copied = clone_library_asset(db, original, target, scene_id=body.scene_id, character_id=body.character_id)
    # Preserve copies after an ambiguous commit acknowledgment, as for uploads.
    db.commit()
    return asset_json(copied)


@app.post("/api/projects/{project_id}/characters/import")
def import_character(project_id: str, body: ImportCharacter, db: Database, owner: Owner):
    source, target = lock_library_projects(db, owner, body.source_project_id, project_id)
    if target.revision != body.base_revision:
        raise HTTPException(409, "This project changed in another view. Reload before importing.")
    original = next((character for character in source.document["characters"] if character["id"] == body.source_character_id), None)
    if original is None:
        raise HTTPException(404, "Source character not found.")
    document = ProjectDocument.model_validate(target.document)
    if len(document.characters) >= 30:
        raise HTTPException(422, "A project can contain at most 30 characters.")
    character = Character(name=original["name"], description=original["description"])
    assets = assets_for(db, target.id)
    copied = None
    if original.get("asset_id"):
        original_asset = db.get(AssetRow, original["asset_id"])
        if original_asset is None or original_asset.project_id != source.id or original_asset.deleted_at is not None or original_asset.kind not in {"image", "character"}:
            raise HTTPException(422, "The character's saved reference image is unavailable.")
        copied = clone_library_asset(db, original_asset, target)
        copied.character_id = character.id
        character.asset_id = copied.id
        assets[copied.id] = copied
    document.characters.append(character)
    try:
        validate_document(document, assets)
        result = db.execute(update(ProjectRow).where(ProjectRow.id == target.id, ProjectRow.revision == body.base_revision).values(
            document=document.model_dump(), revision=body.base_revision + 1, updated_at=utcnow()).execution_options(synchronize_session=False))
        if result.rowcount != 1:
            raise HTTPException(409, "This project changed in another view. Reload before importing.")
    except HTTPException:
        if copied:
            Path(copied.path).unlink(missing_ok=True)
        raise
    db.commit()
    db.refresh(target)
    return project_json(target)


@app.get("/{path:path}")
def frontend(path: str):
    if path == "api" or path.startswith("api/"):
        raise HTTPException(404, "Endpoint not found.")
    directory = get_settings().frontend_dist
    if directory is None:
        raise HTTPException(404, "Frontend is served separately in this environment.")
    candidate = (directory / path).resolve()
    if not candidate.is_relative_to(directory):
        raise HTTPException(404, "File not found.")
    if candidate.is_file():
        return FileResponse(candidate)
    if Path(path).suffix:
        raise HTTPException(404, "File not found.")
    index = directory / "index.html"
    if index.is_file():
        return FileResponse(index)
    raise HTTPException(404, "Build the frontend before starting the application.")
