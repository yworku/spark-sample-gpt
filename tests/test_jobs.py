from __future__ import annotations

import base64
import copy
import hashlib
import io
import json
import os
import wave
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from PIL import Image
from sqlalchemy import create_engine, select, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import sessionmaker

from studio.config import Settings
from studio.models import AssetRow, Base, ExportRow, JobRow, ProjectRow, utcnow
from studio.providers import (Cancelled, ProviderError, ProviderResult, _caption_candidate, _story_candidate, available_voices,
                              capabilities, reference_ids, run_provider, validate_job)
from studio.schemas import Character, ProjectDocument, Scene
from studio.worker import _adopt, claim_next, reconcile_video, recover_stale, run_claim


@pytest.fixture
def setup(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'jobs.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    settings = Settings(database_url=str(engine.url), media_root=tmp_path / "media", environment="test",
        owner_password_hash="", allowed_origins=("http://localhost",), session_secure=False,
        openai_api_key="unit-test-secret", openai_base_url="https://provider.example/v1",
        story_model="gpt-4.1-mini", image_model="gpt-image-1", speech_model="gpt-4o-mini-tts",
        runway_api_key="runway-test-secret", elevenlabs_api_key="music-test-secret")
    settings.media_root.mkdir()
    scene = Scene(title="First", script="The little fox finds its way home.", image_prompt="Fox in a forest", video_prompt="The fox walks home")
    document = ProjectDocument(name="Story", scenes=[scene]).model_dump(mode="json")
    project_id = str(uuid4())
    with factory() as session, session.begin():
        session.add(ProjectRow(id=project_id, document=document, revision=2))
    return factory, settings, project_id, document


def enqueue(setup, kind="image", **values):
    factory, _, project_id, document = setup
    job_id = str(uuid4())
    with factory() as session, session.begin():
        session.add(JobRow(id=job_id, project_id=project_id, kind=kind,
            snapshot={"document": copy.deepcopy(document), "revision": 1, "assets": {}},
            request={"scene_id": document["scenes"][0]["id"], "settings": {}},
            idempotency_key=job_id, request_hash="0" * 64, **values))
    return job_id


def png_bytes():
    buffer = io.BytesIO()
    Image.new("RGB", (32, 32), "orange").save(buffer, "PNG")
    return buffer.getvalue()


def generated_image(kind, snapshot, request, settings, directory, **callbacks):
    callbacks["before_submit"]()
    path = directory / "image.png"
    path.write_bytes(png_bytes())
    return ProviderResult(path=path, kind="image", metadata={"model": "test", "source_revision": snapshot["revision"]})


def test_claim_and_alternative_do_not_overwrite_newer_project(setup):
    factory, settings, project_id, original = setup
    job_id = enqueue(setup)
    claim = claim_next("worker-a", factory)
    assert claim_next("worker-b", factory) is None
    run_claim(claim, session_factory=factory, settings=settings, provider_runner=generated_image, heartbeat=False)
    with factory() as session:
        job = session.get(JobRow, job_id)
        project = session.get(ProjectRow, project_id)
        asset = session.get(AssetRow, job.result["asset_id"])
        assert job.status == "succeeded"
        assert job.provider_phase == "complete"
        assert project.revision == 2 and project.document == original
        assert job.result["source_revision"] == 1
        assert asset.source == "generated" and Path(asset.path).is_file()


def test_postgres_claim_is_skip_locked():
    statement = select(JobRow).where(JobRow.status == "queued").with_for_update(skip_locked=True).limit(1)
    assert "FOR UPDATE SKIP LOCKED" in str(statement.compile(dialect=postgresql.dialect()))


def test_timeout_is_unknown_and_never_reclaimed(setup):
    factory, settings, _, _ = setup
    job_id = enqueue(setup)
    calls = []
    def timeout(*args, **callbacks):
        callbacks["before_submit"]()
        calls.append(1)
        raise ProviderError("Unconfirmed connection", uncertain=True)
    run_claim(claim_next("worker", factory), session_factory=factory, settings=settings, provider_runner=timeout, heartbeat=False)
    assert claim_next("worker2", factory) is None
    recover_stale(factory, now=utcnow() + timedelta(hours=1))
    assert claim_next("worker2", factory) is None
    with factory() as session:
        assert session.get(JobRow, job_id).status == "unknown"
    assert len(calls) == 1


def test_cancel_after_paid_response_never_adopts_asset(setup):
    factory, settings, _, _ = setup
    job_id = enqueue(setup)
    def response_then_cancel(*args, **callbacks):
        result = generated_image(*args, **callbacks)
        with factory() as session, session.begin():
            session.get(JobRow, job_id).cancel_requested = True
        return result
    run_claim(claim_next("worker", factory), session_factory=factory, settings=settings, provider_runner=response_then_cancel, heartbeat=False)
    with factory() as session:
        assert session.get(JobRow, job_id).status == "cancelled"
        assert session.scalars(select(AssetRow)).all() == []
    assert not list(settings.media_root.rglob("*.png"))


def test_cancel_before_submit_makes_no_paid_call(setup):
    factory, settings, _, _ = setup
    job_id = enqueue(setup)
    claim = claim_next("worker", factory)
    with factory() as session, session.begin():
        session.get(JobRow, job_id).cancel_requested = True
    def forbidden(*args, **kwargs):
        pytest.fail("Provider must not be called")
    run_claim(claim, session_factory=factory, settings=settings, provider_runner=forbidden, heartbeat=False)
    with factory() as session:
        job = session.get(JobRow, job_id)
        assert job.status == "cancelled" and job.provider_phase == "not_submitted"


def test_lost_lease_cannot_publish_result(setup):
    factory, settings, _, _ = setup
    job_id = enqueue(setup)
    def lost_lease(*args, **kwargs):
        result = generated_image(*args, **kwargs)
        with factory() as session, session.begin():
            session.get(JobRow, job_id).worker_id = "replacement"
        return result
    run_claim(claim_next("worker", factory), session_factory=factory, settings=settings, provider_runner=lost_lease, heartbeat=False)
    with factory() as session:
        job = session.get(JobRow, job_id)
        assert job.worker_id == "replacement" and job.result is None
        assert not session.scalars(select(AssetRow)).all()


def test_lost_commit_acknowledgment_does_not_delete_committed_media(setup, monkeypatch):
    import studio.worker as worker
    factory, settings, _, _ = setup
    job_id = enqueue(setup)
    real_adopt = worker._adopt
    def committed_then_ack_lost(*args, **kwargs):
        real_adopt(*args, **kwargs)
        raise ConnectionError("Lost COMMIT acknowledgment")
    monkeypatch.setattr(worker, "_adopt", committed_then_ack_lost)
    run_claim(claim_next("worker", factory), session_factory=factory, settings=settings, provider_runner=generated_image, heartbeat=False)
    with factory() as session:
        job = session.get(JobRow, job_id)
        asset = session.get(AssetRow, job.result["asset_id"])
        assert job.status == "succeeded" and Path(asset.path).is_file()


def test_video_lease_loss_stops_locally_without_remote_cancel(setup, tmp_path):
    _, settings, _, doc = setup
    cancelled_calls = []
    def cancelled():
        cancelled_calls.append(1)
        return len(cancelled_calls) > 1
    with httpx.Client(transport=httpx.MockTransport(lambda request: pytest.fail("No DELETE on lease loss"))) as client, pytest.raises(Cancelled):
        run_provider("video", {"document": doc, "assets": {}, "revision": 1}, {"scene_id": doc["scenes"][0]["id"], "settings": {}},
            settings, tmp_path / "out", client=client, provider_id="runway:known-task", before_submit=lambda: None,
            submitted=lambda id: None, progress=lambda p: None, cancelled=cancelled, cancel_remote=lambda: False)


def test_stale_recovery_resumes_known_tasks_but_not_ambiguous_submission(setup):
    factory, _, _, _ = setup
    stale = utcnow() - timedelta(hours=1)
    prepared = enqueue(setup, status="running", heartbeat_at=stale, provider_phase="not_submitted")
    submitting = enqueue(setup, status="running", heartbeat_at=stale, provider_phase="submitting")
    polling = enqueue(setup, kind="video", status="running", heartbeat_at=stale, provider_phase="submitted", provider_id="runway:known-task")
    render = enqueue(setup, kind="export", status="running", heartbeat_at=stale)
    result = recover_stale(factory)
    assert result == {"queued": 3, "unknown": 1, "cancelled": 0}
    with factory() as session:
        assert session.get(JobRow, submitting).status == "unknown"
        assert all(session.get(JobRow, id).status == "queued" for id in (prepared, polling, render))
        assert session.get(JobRow, polling).provider_id == "runway:known-task"


def test_image_edit_uses_frozen_selected_image_and_character_references(setup, tmp_path):
    _, settings, _, doc = setup
    first, reference = str(uuid4()), str(uuid4())
    assets = {}
    for id in (first, reference):
        path = settings.media_root / f"{id}.png"
        path.write_bytes(png_bytes())
        assets[id] = {"path": str(path), "kind": "image", "mime_type": "image/png", "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    char = Character(name="Fox", asset_id=reference)
    doc["characters"] = [char.model_dump(mode="json")]
    doc["scenes"][0].update(image_id=first, character_ids=[char.id])
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(png_bytes()).decode()}]})
    callbacks = dict(before_submit=lambda: None, submitted=lambda id: None, progress=lambda p: None, cancelled=lambda: False)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = run_provider("image_edit", {"document": doc, "assets": assets, "revision": 1},
            {"scene_id": doc["scenes"][0]["id"], "prompt": "Make the forest brighter", "settings": {}}, settings, tmp_path / "out", client=client, **callbacks)
    payload = json.loads(requests[0].content)
    assert requests[0].url.path == "/v1/images/edits"
    assert len(payload["images"]) == 2 and all(x["image_url"].startswith("data:image/png;base64,") for x in payload["images"])
    assert result.path.read_bytes() == png_bytes()
    assert result.metadata["reference_asset_ids"] == [first, reference]


def test_modified_reference_fails_before_provider_submission(setup, tmp_path):
    _, settings, _, doc = setup
    id = str(uuid4())
    path = settings.media_root / "changed.png"
    path.write_bytes(png_bytes())
    doc["scenes"][0]["image_id"] = id
    assets = {id: {"path": str(path), "kind": "image", "mime_type": "image/png", "sha256": "0" * 64}}
    with pytest.raises(ValueError, match="changed after"):
        run_provider("image_edit", {"document": doc, "assets": assets, "revision": 1},
            {"scene_id": doc["scenes"][0]["id"], "settings": {}}, settings, tmp_path / "out",
            before_submit=lambda: pytest.fail("must validate before paying"), submitted=lambda id: None,
            progress=lambda p: None, cancelled=lambda: False)


@pytest.mark.parametrize("status,uncertain", [(401, False), (429, False), (500, True)])
def test_provider_errors_redact_bodies_and_do_not_retry(setup, tmp_path, status, uncertain):
    _, settings, _, doc = setup
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(status, json={"error": "secret-token-and-private-prompt"})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client, pytest.raises(ProviderError) as caught:
        run_provider("voice", {"document": doc, "assets": {}, "revision": 1}, {"scene_id": doc["scenes"][0]["id"], "settings": {}},
            settings, tmp_path / "out", client=client, before_submit=lambda: None, submitted=lambda id: None,
            progress=lambda p: None, cancelled=lambda: False)
    assert caught.value.uncertain is uncertain
    assert "secret" not in str(caught.value) and len(requests) == 1


def test_video_resume_only_polls_and_downloads_allowlisted_output(setup, tmp_path):
    _, settings, _, doc = setup
    requests = []
    def handler(request):
        requests.append(request)
        if "/tasks/" in request.url.path:
            return httpx.Response(200, json={"status": "SUCCEEDED", "output": ["https://dnznrvs05pmza.cloudfront.net/video.mp4?private=token"]})
        assert "Authorization" not in request.headers
        return httpx.Response(200, content=b"private video")
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = run_provider("video", {"document": doc, "assets": {}, "revision": 1}, {"scene_id": doc["scenes"][0]["id"], "settings": {}},
            settings, tmp_path / "out", client=client, provider_id="runway:known-task", before_submit=lambda: pytest.fail("No new submission"),
            submitted=lambda id: pytest.fail("Already submitted"), progress=lambda p: None, cancelled=lambda: False)
    assert all(req.method == "GET" for req in requests)
    assert result.path.read_bytes() == b"private video"


def test_video_rejects_provider_output_pointing_to_local_network(setup, tmp_path):
    _, settings, _, doc = setup
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"status": "SUCCEEDED", "output": ["http://127.0.0.1/admin"]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client, pytest.raises(ProviderError, match="allowlist"):
        run_provider("video", {"document": doc, "assets": {}, "revision": 1}, {"scene_id": doc["scenes"][0]["id"], "settings": {}},
            settings, tmp_path / "out", client=client, provider_id="runway:known-task", before_submit=lambda: None,
            submitted=lambda id: None, progress=lambda p: None, cancelled=lambda: False)
    assert len(requests) == 1


def test_music_adapts_explicit_duration_and_instrumental_choice(setup, tmp_path):
    _, settings, _, doc = setup
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, content=b"audio", headers={"song-id": "track-1"})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = run_provider("music", {"document": doc, "assets": {}, "revision": 1}, {"prompt": "gentle piano", "settings": {"duration": 12, "instrumental": True}},
            settings, tmp_path / "out", client=client, before_submit=lambda: None, submitted=lambda id: None, progress=lambda p: None, cancelled=lambda: False)
    payload = json.loads(requests[0].content)
    assert payload["music_length_ms"] == 12000 and payload["force_instrumental"] is True
    assert requests[0].url.path == "/v1/music" and result.metadata["song_id"] == "track-1"


def test_voice_model_preflight_and_disabled_capabilities(setup):
    _, settings, _, doc = setup
    settings = replace(settings, speech_model="tts-1")
    assert "cedar" not in available_voices(settings)
    with pytest.raises(ValueError, match="supported voice"):
        validate_job("voice", {"scene_id": doc["scenes"][0]["id"], "settings": {"voice": "cedar"}}, doc, {}, settings)
    with pytest.raises(ValueError, match="instructions"):
        validate_job("voice", {"scene_id": doc["scenes"][0]["id"], "settings": {"instructions": "happy"}}, doc, {}, settings)
    off = replace(settings, openai_api_key="", runway_api_key="", elevenlabs_api_key="")
    assert not any(capabilities(off).values())


def test_story_candidate_has_valid_ids_and_matches_project_schema():
    raw = {"characters": [{"name": "Fox", "description": "A small red fox"}], "scenes": [
        {"title": "Home", "script": "The fox returns", "image_prompt": "a fox", "video_prompt": "fox walks", "characters": ["Fox"]}]}
    candidate = _story_candidate(raw, 1)
    project = ProjectDocument(name="Story", **candidate)
    assert project.scenes[0].character_ids == [project.characters[0].id]
    raw["characters"][0]["name"] = "x" * 101
    with pytest.raises(ProviderError):
        _story_candidate(raw, 1)


def test_reconcile_cannot_repeat_paid_submission(setup):
    factory, _, _, _ = setup
    unknown = enqueue(setup, kind="video", status="unknown", provider_phase="submitted", provider_id="runway:known-task")
    ambiguous = enqueue(setup, status="unknown", provider_phase="submitting")
    reconcile_video(unknown, factory)
    with pytest.raises(ValueError):
        reconcile_video(ambiguous, factory)
    claim = claim_next("worker", factory)
    assert claim["id"] == unknown and claim["provider_id"] == "runway:known-task"


def test_export_records_snapshot_revision_without_mutating_project(setup):
    factory, settings, project_id, document = setup
    job_id = enqueue(setup, kind="export")
    def renderer(doc, assets, output, **kwargs):
        assert doc == document
        output.write_bytes(b"test-export-fixture")
        return {"duration": 5, "width": 1280, "height": 720, "byte_size": output.stat().st_size}
    run_claim(claim_next("worker", factory), session_factory=factory, settings=settings, renderer=renderer, heartbeat=False)
    with factory() as session:
        job = session.get(JobRow, job_id)
        export = session.get(ExportRow, job.result["export_id"])
        assert export.revision == 1 and export.duration == 5 and Path(export.path).is_file()
        assert session.get(ProjectRow, project_id).revision == 2


def alignment_fixture(setup):
    _, settings, _, document = setup
    audio = io.BytesIO()
    with wave.open(audio, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(8000)
        output.writeframes(b"\x00\x00" * 80000)
    path = settings.media_root / "narration.wav"
    path.write_bytes(audio.getvalue())
    voice_id = str(uuid4())
    document["scenes"][0]["voice_id"] = voice_id
    assets = {voice_id: {"path": str(path), "kind": "voice", "mime_type": "audio/wav", "duration": 10,
                          "byte_size": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}}
    return document, assets


def test_caption_alignment_paid_request_and_trim_speed_offset_candidate(setup, tmp_path):
    _, settings, _, _ = setup
    doc, assets = alignment_fixture(setup)
    scene = doc["scenes"][0]
    scene["duration"] = 3
    scene["voice"].update(trim_start=2, trim_end=8, speed=2, offset=1)
    words = [{"word": "First", "start": 1, "end": 3}, {"word": "second", "start": 3, "end": 4},
             {"word": "last", "start": 5, "end": 7}, {"word": "excluded", "start": 8, "end": 9}]
    requests, effects = [], []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"words": words})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = run_provider("caption_align", {"document": doc, "assets": assets, "revision": 7},
            {"scene_id": scene["id"], "settings": {}}, settings, tmp_path / "out", client=client,
            before_submit=lambda: effects.append("paid"), submitted=lambda id: None,
            progress=lambda p: None, cancelled=lambda: False)
    assert effects == ["paid"] and len(requests) == 1
    request = requests[0]
    assert request.url.path == "/v1/audio/transcriptions" and request.method == "POST"
    for field in (b'filename="narration.wav"', b'"timestamp_granularities[]"', b"whisper-1", b"verbose_json", b"word"):
        assert field in request.content
    assert result.path is None and result.result["voice_settings"] == scene["voice"]
    assert result.result["source_revision"] == 7 and result.result["voice_id"] == scene["voice_id"]
    assert result.result["words"] == [
        {"text": "First", "start": 1, "end": 1.5, "hidden": False},
        {"text": "second", "start": 1.5, "end": 2, "hidden": False},
        {"text": "last", "start": 2.5, "end": 3, "hidden": False}]


def test_caption_alignment_matches_auto_duration_and_looped_narration(setup):
    doc, assets = alignment_fixture(setup)
    scene = doc["scenes"][0]
    scene.update(duration_mode="voice", duration=1)
    scene["voice"].update(trim_start=2, trim_end=8, speed=2, offset=1)
    candidate = _caption_candidate({"words": [{"word": "End", "start": 7, "end": 9}]}, scene, assets, 1)
    assert candidate["words"] == [{"text": "End", "start": 3.5, "end": 4, "hidden": False}]
    scene.update(duration_mode="manual", duration=5)
    scene["voice"].update(trim_start=2, trim_end=4, speed=1, offset=0, loop=True)
    candidate = _caption_candidate({"words": [{"word": "Repeat", "start": 3, "end": 3.5}]}, scene, assets, 1)
    assert [word["start"] for word in candidate["words"]] == [1, 3]


def test_caption_alignment_freezes_video_based_duration_without_sending_video(setup):
    _, settings, _, _ = setup
    doc, assets = alignment_fixture(setup)
    scene = doc["scenes"][0]
    video_id = str(uuid4())
    scene.update(duration_mode="video", video_id=video_id)
    assets[video_id] = {"kind": "video", "duration": 2}
    request = {"scene_id": scene["id"], "settings": {}}
    assert reference_ids("caption_align", request, doc) == [scene["voice_id"], video_id]
    validate_job("caption_align", request, doc, assets, settings)
    result = _caption_candidate({"words": [{"word": "Clip", "start": 1, "end": 3}]}, scene, assets, 1)
    assert result["words"] == [{"text": "Clip", "start": 1, "end": 2, "hidden": False}]


def test_caption_alignment_rejects_oversized_or_invisible_audio_before_paid_call(setup, tmp_path):
    _, settings, _, _ = setup
    doc, assets = alignment_fixture(setup)
    scene = doc["scenes"][0]
    request = {"scene_id": scene["id"], "settings": {}}
    asset = assets[scene["voice_id"]]
    asset["byte_size"] = 25_000_001
    with pytest.raises(ValueError, match="25 MB"):
        run_provider("caption_align", {"document": doc, "assets": assets, "revision": 1}, request, settings, tmp_path / "out",
            before_submit=lambda: pytest.fail("must reject before paid call"), submitted=lambda id: None,
            progress=lambda p: None, cancelled=lambda: False)
    asset["byte_size"] = 100
    scene["voice"]["offset"] = 8
    with pytest.raises(ValueError, match="after this scene"):
        validate_job("caption_align", request, doc, assets, settings)


def test_caption_alignment_rejects_malformed_timestamps(setup):
    doc, assets = alignment_fixture(setup)
    for words in ([], [{"word": "bad", "start": 2, "end": 1}], [{"word": "bad", "start": float("nan"), "end": 1}]):
        with pytest.raises(ProviderError):
            _caption_candidate({"words": words}, doc["scenes"][0], assets, 1)


def test_caption_job_retains_candidate_without_changing_project(setup):
    factory, settings, project_id, _ = setup
    doc, assets = alignment_fixture(setup)
    job_id = enqueue(setup, kind="caption_align")
    with factory() as session, session.begin():
        job = session.get(JobRow, job_id)
        job.snapshot = {"document": doc, "revision": 1, "assets": assets}
    def candidate(kind, snapshot, request, settings, output, **callbacks):
        assert kind == "caption_align"
        callbacks["before_submit"]()
        return ProviderResult(result=_caption_candidate({"words": [{"word": "Hello", "start": .2, "end": 1}]}, snapshot["document"]["scenes"][0], snapshot["assets"], 1))
    run_claim(claim_next("worker", factory), session_factory=factory, settings=settings, provider_runner=candidate, heartbeat=False)
    with factory() as session:
        job = session.get(JobRow, job_id)
        project = session.get(ProjectRow, project_id)
        assert job.status == "succeeded" and job.result["words"][0]["text"] == "Hello"
        assert project.revision == 2 and not project.document["scenes"][0]["caption"]["words"]
        assert session.scalars(select(AssetRow)).all() == []


@pytest.fixture
def postgres_factory():
    url = os.getenv("TEST_POSTGRES_URL")
    if not url:
        pytest.skip("TEST_POSTGRES_URL enables real PostgreSQL concurrency checks")
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    admin = create_engine(url)
    schema = "jobs_test_" + uuid4().hex
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(url, connect_args={"options": f"-csearch_path={schema}"}, pool_size=12)
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    try:
        yield factory
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def _postgres_queue(factory, count):
    doc = ProjectDocument(name="Concurrent", scenes=[Scene()]).model_dump(mode="json")
    project_id = str(uuid4())
    with factory() as session, session.begin():
        session.add(ProjectRow(id=project_id, document=doc, revision=1))
    state = factory, None, project_id, doc
    ids = [enqueue(state) for _ in range(count)]
    return state, ids


def test_postgres_parallel_claims_never_duplicate(postgres_factory):
    factory = postgres_factory
    _, ids = _postgres_queue(factory, 8)
    with ThreadPoolExecutor(max_workers=8) as executor:
        claims = list(executor.map(lambda i: claim_next(f"worker-{i}", factory), range(8)))
    assert {claim["id"] for claim in claims} == set(ids)
    assert len({claim["worker_id"] for claim in claims}) == 8
    assert claim_next("empty", factory) is None


def test_postgres_locked_job_is_skipped_and_cancel_wins_adoption(postgres_factory):
    factory = postgres_factory
    state, _ = _postgres_queue(factory, 2)
    with factory() as session, session.begin():
        locked = session.scalar(select(JobRow).order_by(JobRow.created_at).with_for_update().limit(1))
        with ThreadPoolExecutor(max_workers=1) as executor:
            claim = executor.submit(claim_next, "unblocked-worker", factory).result(timeout=5)
        assert claim["id"] != locked.id
    # Block adoption on the project lock while explicit cancellation commits.
    with factory() as project_session, project_session.begin(), ThreadPoolExecutor(max_workers=1) as executor:
        project_session.scalar(select(ProjectRow).where(ProjectRow.id == state[2]).with_for_update())
        pending = executor.submit(_adopt, claim, ProviderResult(result={"candidate": "do not adopt"}), factory)
        with factory() as cancel_session, cancel_session.begin():
            job = cancel_session.scalar(select(JobRow).where(JobRow.id == claim["id"]).with_for_update())
            job.cancel_requested = True
        project_session.commit()
        with pytest.raises(Cancelled):
            pending.result(timeout=5)
    with factory() as session:
        assert session.get(JobRow, claim["id"]).result is None
