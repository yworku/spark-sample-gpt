"""Exercise the private HTTP -> durable worker -> real MP4 -> download workflow."""
from __future__ import annotations

from test_api import client as client, document, image_upload, login, project
from studio.worker import claim_next, run_claim


def test_private_export_roundtrip_uses_the_queued_revision(client):
    login(client)
    created = project(client, mode="paste", script="A small beginning.\n\nA new adventure.")
    asset, _ = image_upload(client, created)
    content = document(created)
    for scene in content["scenes"]:
        scene["image_id"] = asset["id"]
        scene["duration"] = .5
        scene["caption"]["enabled"] = True
    content["scenes"][0]["transition"] = {"type": "fade", "duration": .1}
    saved = client.put(f"/api/projects/{created['id']}", json={"base_revision": 1, "document": content})
    assert saved.status_code == 200, saved.text
    queued = client.post(f"/api/projects/{created['id']}/jobs", json={
        "kind": "export", "base_revision": 2, "idempotency_key": "private-export-roundtrip",
        "settings": {"resolution": 720, "quality": "standard", "fps": 30},
    })
    assert queued.status_code == 202, queued.text
    # The editor remains usable while the queued job retains its revision.
    content["name"] = "Edited while rendering"
    updated = client.put(f"/api/projects/{created['id']}", json={"base_revision": 2, "document": content})
    assert updated.status_code == 200
    claim = claim_next("integration-worker")
    assert claim["id"] == queued.json()["id"]
    run_claim(claim, heartbeat=False)
    jobs = client.get(f"/api/projects/{created['id']}/jobs").json()
    assert jobs[0]["status"] == "succeeded", jobs[0]
    exports = client.get(f"/api/projects/{created['id']}/exports").json()
    assert len(exports) == 1 and exports[0]["revision"] == 2
    assert abs(exports[0]["duration"] - .9) < .1
    url = exports[0]["url"]
    download = client.get(url)
    assert download.status_code == 200 and b"ftyp" in download.content[:32]
    assert download.headers["content-type"] == "video/mp4"
    part = client.get(url, headers={"Range": "bytes=0-31"})
    assert part.status_code == 206 and len(part.content) == 32
    assert "no-store" in part.headers["cache-control"]
    client.post("/api/logout")
    assert client.get(url).status_code == 401
    login(client)
    client.delete(f"/api/projects/{created['id']}")
    assert client.get(url).status_code == 404
    client.post(f"/api/projects/{created['id']}/restore")
    assert client.get(url).status_code == 200
