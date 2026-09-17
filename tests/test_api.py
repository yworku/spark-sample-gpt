from __future__ import annotations

import io
import wave
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

import pytest
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.orm import Session

from studio.api import app
from studio.auth import _attempts
from studio.config import get_settings
from studio.db import SessionLocal, _factory, init_schema
from studio.models import AssetRow, JobRow, ProjectRow


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIO_ENV", "test")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'db.sqlite'}")
    monkeypatch.setenv("STUDIO_MEDIA_ROOT", str(tmp_path / "media"))
    monkeypatch.setenv("STUDIO_OWNER_PASSWORD_HASH", PasswordHasher(time_cost=1, memory_cost=8192).hash("correct-password"))
    monkeypatch.setenv("STUDIO_ALLOWED_ORIGINS", "http://testserver")
    monkeypatch.setenv("STUDIO_SECURE_COOKIES", "false")
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("RUNWAY_API_KEY", "")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "")
    get_settings.cache_clear()
    _attempts.clear()
    init_schema()
    with TestClient(app, headers={"origin": "http://testserver"}) as value:
        yield value
    get_settings.cache_clear()
    _factory.cache_clear()


def login(client):
    response = client.post("/api/login", json={"password": "correct-password"})
    assert response.status_code == 200
    return response


def project(client, **kwargs):
    response = client.post("/api/projects", json={"name": "A new story", **kwargs})
    assert response.status_code == 201, response.text
    return response.json()


def document(project):
    return {key: value for key, value in project.items() if key not in {"id", "revision", "created_at", "updated_at", "deleted_at"}}


def image_upload(client, project):
    data = io.BytesIO()
    Image.new("RGB", (64, 64), "orange").save(data, format="PNG")
    response = client.post(f"/api/projects/{project['id']}/assets", data={"kind": "image"}, files={"file": ("scene.png", data.getvalue(), "image/png")})
    assert response.status_code == 201, response.text
    return response.json(), data.getvalue()


def test_auth_origin_logout_and_private_endpoints(client):
    assert client.get("/api/session").json() == {"authenticated": False}
    assert client.get("/api/projects").status_code == 401
    assert client.post("/api/login", headers={"origin": "https://attacker.example"}, json={"password": "correct-password"}).status_code == 403
    assert client.post("/api/login", json={"password": "wrong"}).status_code == 401
    response = login(client)
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie
    assert client.get("/api/session").json() == {"authenticated": True}
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.post("/api/logout").status_code == 200
    assert client.get("/api/projects").status_code == 401


def test_validation_never_echoes_password(client):
    secret = "secret-value-that-must-not-be-echoed"
    result = client.post("/api/login", json={"password": {"value": secret}})
    assert result.status_code == 422 and secret not in result.text


def test_project_roundtrip_conflict_and_restore(client):
    login(client)
    item = project(client, mode="paste", script="The first scene.\n\nThe second scene.")
    assert len(item["scenes"]) == 2
    body = document(item)
    body["name"] = "Saved name"
    update = {"base_revision": 1, "document": body}
    saved = client.put(f"/api/projects/{item['id']}", json=update)
    assert saved.status_code == 200 and saved.json()["revision"] == 2
    assert client.put(f"/api/projects/{item['id']}", json=update).status_code == 409
    assert client.delete(f"/api/projects/{item['id']}").status_code == 204
    assert client.get(f"/api/projects/{item['id']}").status_code == 404
    assert len(client.get("/api/projects?deleted=true").json()) == 1
    restored = client.post(f"/api/projects/{item['id']}/restore")
    assert restored.status_code == 200 and restored.json()["name"] == "Saved name"


def test_asset_private_ranges_integrity_and_project_scoping(client):
    login(client)
    first = project(client)
    second = project(client)
    asset, image = image_upload(client, first)
    assert "path" not in asset and "sha256" not in asset
    ranged = client.get(asset["url"], headers={"range": "bytes=0-7"})
    assert ranged.status_code == 206 and ranged.content == image[:8]
    assert ranged.headers["content-range"] == f"bytes 0-7/{len(image)}"
    assert client.get(asset["url"], headers={"range": "bytes=999999-"}).status_code == 416
    invalid = document(second)
    invalid["scenes"][0]["image_id"] = asset["id"]
    assert client.put(f"/api/projects/{second['id']}", json={"base_revision": 1, "document": invalid}).status_code == 422
    valid = document(first)
    valid["scenes"][0]["image_id"] = asset["id"]
    assert client.put(f"/api/projects/{first['id']}", json={"base_revision": 1, "document": valid}).status_code == 200
    assert client.delete(f"/api/assets/{asset['id']}").status_code == 409
    client.post("/api/logout")
    assert client.get(asset["url"]).status_code == 401


def test_spoofed_image_and_unsupported_effect_rejected(client):
    login(client)
    item = project(client)
    bad = client.post(f"/api/projects/{item['id']}/assets", data={"kind": "image"}, files={"file": ("image.png", b"<svg><script>alert(1)</script></svg>", "image/png")})
    assert bad.status_code == 422
    value = document(item)
    value["scenes"][0]["effect"]["type"] = "unimplemented_effect"
    assert client.put(f"/api/projects/{item['id']}", json={"base_revision": 1, "document": value}).status_code == 422
    assert client.post("/api/projects", json={"name": "Book", "kind": "book"}).status_code == 422


def test_job_idempotency_snapshot_and_cancellation(client):
    login(client)
    item = project(client)
    request = {"kind": "export", "base_revision": 1, "idempotency_key": str(uuid4()), "settings": {"resolution": 720, "quality": "high", "fps": 30}}
    first = client.post(f"/api/projects/{item['id']}/jobs", json=request)
    assert first.status_code == 202, first.text
    again = client.post(f"/api/projects/{item['id']}/jobs", json=request)
    assert again.json()["id"] == first.json()["id"]
    changed = {**request, "settings": {"resolution": 1080}}
    assert client.post(f"/api/projects/{item['id']}/jobs", json=changed).status_code == 409
    value = document(item)
    value["name"] = "Later edit"
    assert client.put(f"/api/projects/{item['id']}", json={"base_revision": 1, "document": value}).status_code == 200
    with SessionLocal() as db:
        job = db.get(JobRow, first.json()["id"])
        assert job.snapshot["revision"] == 1 and job.snapshot["document"]["name"] == "A new story"
    assert client.post(f"/api/projects/{item['id']}/jobs", json=request).json()["id"] == first.json()["id"]
    cancelled = client.post(f"/api/jobs/{first.json()['id']}/cancel")
    assert cancelled.json()["status"] == "cancelled"


def test_disabled_provider_and_stale_request_never_queue(client):
    login(client)
    item = project(client)
    body = {"kind": "story", "base_revision": 1, "idempotency_key": str(uuid4()), "prompt": "An adventure"}
    assert client.post(f"/api/projects/{item['id']}/jobs", json=body).status_code == 422
    assert client.get(f"/api/projects/{item['id']}/jobs").json() == []
    capabilities = client.get("/api/capabilities").json()
    assert not any(capabilities["providers"].values())
    assert len(capabilities["voices"]) >= 6 and "api_key" not in str(capabilities)


def test_owner_scope_and_soft_delete_cancel(client):
    login(client)
    item = project(client)
    with SessionLocal() as db:
        foreign = ProjectRow(owner_id="someone-else", document=document(item))
        db.add(foreign)
        db.commit()
        foreign_id = foreign.id
    assert client.get(f"/api/projects/{foreign_id}").status_code == 404
    queued = client.post(f"/api/projects/{item['id']}/jobs", json={"kind": "export", "base_revision": 1, "idempotency_key": str(uuid4())}).json()
    assert client.delete(f"/api/projects/{item['id']}").status_code == 204
    with SessionLocal() as db:
        assert db.get(JobRow, queued["id"]).status == "cancelled"


def test_database_initializer_refuses_nonempty_unversioned_database(client, tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path / 'foreign.sqlite'}"
    engine = create_engine(url)
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE foreign_table (id INTEGER)"))
    monkeypatch.setenv("DATABASE_URL", url)
    get_settings.cache_clear()
    with pytest.raises(RuntimeError, match="unversioned"):
        init_schema()
    assert inspect(engine).get_table_names() == ["foreign_table"]


def test_database_initializer_does_not_mutate_unknown_version(client):
    with SessionLocal() as db:
        db.execute(text("UPDATE schema_versions SET version=99"))
        db.commit()
    with pytest.raises(RuntimeError, match="Unsupported"):
        init_schema()
    with SessionLocal() as db:
        assert db.execute(text("SELECT version FROM schema_versions")).scalar_one() == 99


def test_chunked_request_limit_does_not_trust_content_length(client, monkeypatch):
    login(client)
    settings = replace(get_settings(), max_upload_bytes=16)
    monkeypatch.setattr("studio.api.get_settings", lambda: settings)

    def chunks():
        for _ in range(18):
            yield b" " * 65536
    response = client.post("/api/projects", content=chunks(), headers={"content-type": "application/json"})
    assert response.status_code == 413, response.text


def test_lost_upload_commit_ack_keeps_committed_private_file(client, monkeypatch):
    login(client)
    item = project(client)
    original = Session.commit

    def lost_ack(session):
        original(session)
        raise RuntimeError("Lost commit acknowledgement")
    data = io.BytesIO()
    Image.new("RGB", (64, 64), "orange").save(data, format="PNG")
    monkeypatch.setattr(Session, "commit", lost_ack)
    with pytest.raises(RuntimeError, match="acknowledgement"):
        client.post(f"/api/projects/{item['id']}/assets", data={"kind": "image"}, files={"file": ("scene.png", data.getvalue(), "image/png")})
    monkeypatch.setattr(Session, "commit", original)
    with SessionLocal() as db:
        asset = db.scalar(select(AssetRow).where(AssetRow.project_id == item["id"]))
        assert asset is not None and Path(asset.path).is_file()
        assert client.get(f"/api/assets/{asset.id}/file").status_code == 200


def test_asset_integrity_checked_before_serving_and_export(client):
    login(client)
    item = project(client)
    asset, _ = image_upload(client, item)
    value = document(item)
    value["scenes"][0]["image_id"] = asset["id"]
    assert client.put(f"/api/projects/{item['id']}", json={"base_revision": 1, "document": value}).status_code == 200
    with SessionLocal() as db:
        row = db.get(AssetRow, asset["id"])
        Path(row.path).write_bytes(b"modified")
    assert client.get(asset["url"]).status_code == 409
    queued = client.post(f"/api/projects/{item['id']}/jobs", json={"kind": "export", "base_revision": 2, "idempotency_key": str(uuid4())})
    assert queued.status_code == 422
    assert client.get(f"/api/projects/{item['id']}/jobs").json() == []


def test_character_library_import_copies_reference_and_preserves_revision_scope(client):
    login(client)
    source = project(client, name="Source cast")
    target = project(client, name="New story")
    image, content = image_upload(client, source)
    source_document = document(source)
    character_id = str(uuid4())
    source_document["characters"] = [{"id": character_id, "name": "Ari", "description": "An explorer in a green coat", "asset_id": image["id"]}]
    assert client.put(f"/api/projects/{source['id']}", json={"base_revision": 1, "document": source_document}).status_code == 200
    library = client.get("/api/library/characters").json()
    assert len(library) == 1 and library[0]["source_character_id"] == character_id
    assert library[0]["asset"]["id"] == image["id"] and "path" not in str(library)
    body = {"source_project_id": source["id"], "source_character_id": character_id, "base_revision": 1}
    response = client.post(f"/api/projects/{target['id']}/characters/import", json=body)
    assert response.status_code == 200, response.text
    saved = response.json()
    imported = saved["characters"][0]
    assert saved["revision"] == 2 and imported["name"] == "Ari"
    assert imported["id"] != character_id and imported["asset_id"] != image["id"]
    with SessionLocal() as db:
        original = db.get(AssetRow, image["id"])
        copied = db.get(AssetRow, imported["asset_id"])
        assert copied.project_id == target["id"] and copied.character_id == imported["id"]
        assert copied.path != original.path and Path(copied.path).read_bytes() == content
    assert client.post(f"/api/projects/{target['id']}/characters/import", json=body).status_code == 409
    assert len(client.get(f"/api/projects/{target['id']}/assets").json()) == 1
    assert client.delete(f"/api/projects/{source['id']}").status_code == 204
    assert client.get(f"/api/assets/{imported['asset_id']}/file").content == content
    assert len(client.get("/api/library/characters").json()) == 1


def test_asset_library_import_rejects_foreign_scope_and_invalid_target(client):
    login(client)
    source = project(client)
    target = project(client)
    image, content = image_upload(client, source)
    assert len(client.get("/api/library/assets?kind=image").json()) == 1
    assert client.get("/api/library/assets?kind=music").json() == []
    assert client.get("/api/library/assets?kind=unsupported").status_code == 422
    invalid = client.post(f"/api/projects/{target['id']}/assets/import", json={"source_asset_id": image["id"], "scene_id": str(uuid4())})
    assert invalid.status_code == 422
    imported = client.post(f"/api/projects/{target['id']}/assets/import", json={"source_asset_id": image["id"], "scene_id": target["scenes"][0]["id"]})
    assert imported.status_code == 201, imported.text
    copied = imported.json()
    assert copied["id"] != image["id"] and copied["project_id"] == target["id"]
    assert copied["scene_id"] == target["scenes"][0]["id"] and client.get(copied["url"]).content == content
    # Reassigning the source simulates a second owner's private project.
    with SessionLocal() as db:
        row = db.get(ProjectRow, source["id"])
        row.owner_id = "another-owner"
        db.commit()
    assert client.post(f"/api/projects/{target['id']}/assets/import", json={"source_asset_id": image["id"]}).status_code == 404
    assert client.post(f"/api/projects/{target['id']}/characters/import", json={"source_project_id": source["id"], "source_character_id": str(uuid4()), "base_revision": 1}).status_code == 404
    visible = client.get("/api/library/assets?kind=image").json()
    assert [asset["id"] for asset in visible] == [copied["id"]]
    client.post("/api/logout")
    assert client.get("/api/library/characters").status_code == 401
    assert client.get("/api/library/assets").status_code == 401


def test_caption_alignment_admission_freezes_voice_size_and_exposes_job_target(client, monkeypatch):
    login(client)
    item = project(client)
    scene_id = item["scenes"][0]["id"]
    audio = io.BytesIO()
    with wave.open(audio, "wb") as recording:
        recording.setnchannels(1)
        recording.setsampwidth(2)
        recording.setframerate(16000)
        recording.writeframes(b"\x00\x00" * 16000)
    raw = audio.getvalue()
    uploaded = client.post(f"/api/projects/{item['id']}/assets", data={"kind": "voice", "scene_id": scene_id},
                           files={"file": ("narration.wav", raw, "audio/wav")})
    assert uploaded.status_code == 201, uploaded.text
    asset_id = uploaded.json()["id"]
    value = document(item)
    value["scenes"][0]["voice_id"] = asset_id
    assert client.put(f"/api/projects/{item['id']}", json={"base_revision": 1, "document": value}).status_code == 200
    # Admission only freezes a queued job. No worker or paid provider request runs.
    monkeypatch.setenv("OPENAI_API_KEY", "test-key-never-submitted")
    get_settings.cache_clear()
    body = {"kind": "caption_align", "scene_id": scene_id, "base_revision": 2,
            "idempotency_key": str(uuid4()), "settings": {}}
    response = client.post(f"/api/projects/{item['id']}/jobs", json=body)
    assert response.status_code == 202, response.text
    job = response.json()
    assert job["status"] == "queued" and job["scene_id"] == scene_id and job["character_id"] is None
    assert "prompt" not in job and "settings" not in job
    with SessionLocal() as db:
        saved = db.get(JobRow, job["id"])
        assert set(saved.snapshot["assets"]) == {asset_id}
        assert saved.snapshot["assets"][asset_id]["byte_size"] == len(raw)
        db.get(AssetRow, asset_id).byte_size = 25_000_001
        db.commit()
    oversized = client.post(f"/api/projects/{item['id']}/jobs", json={**body, "idempotency_key": str(uuid4())})
    assert oversized.status_code == 422 and "25 MB" in oversized.text
    listed = client.get(f"/api/projects/{item['id']}/jobs").json()
    assert len(listed) == 1 and listed[0]["scene_id"] == scene_id
