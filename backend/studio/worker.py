"""Durable PostgreSQL job worker with explicit external-effect checkpoints.

Run ``python -m studio.worker`` independently of the HTTP server. PostgreSQL
SKIP LOCKED supports multiple workers. SQLite is for single-worker development.
Neither an ambiguous submission nor a completed generation is replayed.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import logging
import shutil
import threading
import time
from datetime import timedelta
from pathlib import Path
from typing import Callable
from uuid import uuid4

from sqlalchemy import or_, select, update

from .config import get_settings
from .db import SessionLocal
from .media import admit_generated
from .models import AssetRow, ExportRow, JobRow, ProjectRow, utcnow
from .providers import Cancelled, ProviderError, ProviderResult, run_provider

log = logging.getLogger("studio.worker")
LEASE_SECONDS = 120
HEARTBEAT_SECONDS = 10


def claim_next(worker_id: str, session_factory: Callable = SessionLocal) -> dict | None:
    with session_factory() as session, session.begin():
        job = session.scalar(select(JobRow).where(JobRow.status == "queued").order_by(JobRow.created_at, JobRow.id).with_for_update(skip_locked=True).limit(1))
        if job is None:
            return None
        if job.cancel_requested:
            job.status = "cancelled"
            job.updated_at = utcnow()
            return {"id": job.id, "cancelled": True}
        job.status = "running"
        job.worker_id = worker_id
        job.locked_at = job.heartbeat_at = job.updated_at = utcnow()
        job.progress = 0.02
        job.error = None
        return {"id": job.id, "project_id": job.project_id, "kind": job.kind,
                "request": copy.deepcopy(job.request), "snapshot": copy.deepcopy(job.snapshot),
                "provider_id": job.provider_id, "worker_id": worker_id}


def recover_stale(session_factory: Callable = SessionLocal, *, now=None) -> dict[str, int]:
    now = now or utcnow()
    counts = {"queued": 0, "unknown": 0, "cancelled": 0}
    with session_factory() as session, session.begin():
        jobs = session.scalars(select(JobRow).where(JobRow.status == "running",
            or_(JobRow.heartbeat_at < now - timedelta(seconds=LEASE_SECONDS),
                (JobRow.heartbeat_at.is_(None) & (JobRow.locked_at < now - timedelta(seconds=LEASE_SECONDS)))))
            .with_for_update(skip_locked=True)).all()
        for job in jobs:
            if job.cancel_requested:
                job.status = "cancelled"
                job.error = "Cancelled; an already submitted provider task may still incur a charge."
            elif job.kind == "export" or job.provider_phase == "not_submitted":
                job.status = "queued"
                job.error = None
            elif job.kind == "video" and job.provider_phase == "submitted" and (job.provider_id or "").startswith("runway:"):
                # Reclaim only the existing provider task. run_provider receives its ID.
                job.status = "queued"
                job.error = None
            else:
                job.status = "unknown"
                job.error = "Worker stopped after submission began. Provider outcome is unknown; no automatic resubmission was made."
            job.worker_id = None
            job.updated_at = now
            counts[job.status] += 1
    return counts


class Lease:
    def __init__(self, job_id: str, worker_id: str, session_factory: Callable):
        self.job_id, self.worker_id, self.session_factory = job_id, worker_id, session_factory
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None
        self.last_progress = 0.0

    def _owned(self, job: JobRow | None) -> bool:
        return bool(job and job.status == "running" and job.worker_id == self.worker_id)

    def cancelled(self) -> bool:
        with self.session_factory() as session:
            job = session.get(JobRow, self.job_id)
            if not self._owned(job) or job.cancel_requested:
                return True
            project = session.get(ProjectRow, job.project_id)
            return project is None or project.deleted_at is not None

    def cancel_remote(self) -> bool:
        """Only explicit cancellation/deletion authorizes stopping paid work."""
        with self.session_factory() as session:
            job = session.get(JobRow, self.job_id)
            if job is None:
                return False
            project = session.get(ProjectRow, job.project_id)
            return bool(job.cancel_requested or (project and project.deleted_at is not None))

    def before_submit(self) -> None:
        with self.session_factory() as session, session.begin():
            job = session.scalar(select(JobRow).where(JobRow.id == self.job_id).with_for_update())
            if not self._owned(job) or job.cancel_requested:
                raise Cancelled()
            if job.provider_phase != "not_submitted":
                raise ProviderError("Submission was already started; it will not be repeated.", uncertain=True)
            job.provider_phase = "submitting"
            job.heartbeat_at = job.updated_at = utcnow()
        # The durable commit above must precede the first paid network operation.

    def submitted(self, provider_id: str) -> None:
        with self.session_factory() as session, session.begin():
            job = session.scalar(select(JobRow).where(JobRow.id == self.job_id).with_for_update())
            # Persist a returned task ID even after a concurrent cancel request, so
            # a subsequent provider cancel can target the accepted operation.
            if job is None or job.worker_id != self.worker_id:
                raise Cancelled()
            job.provider_id = provider_id
            job.provider_phase = "submitted"
            job.heartbeat_at = job.updated_at = utcnow()

    def progress(self, value: float) -> None:
        value = min(.98, max(0.0, float(value)))
        if abs(value - self.last_progress) < .01:
            return
        self.last_progress = value
        with self.session_factory() as session, session.begin():
            session.execute(update(JobRow).where(JobRow.id == self.job_id, JobRow.worker_id == self.worker_id, JobRow.status == "running")
                .values(progress=value, heartbeat_at=utcnow(), updated_at=utcnow()))

    def start(self) -> None:
        def heartbeat():
            while not self.stop.wait(HEARTBEAT_SECONDS):
                try:
                    with self.session_factory() as session, session.begin():
                        result = session.execute(update(JobRow).where(JobRow.id == self.job_id, JobRow.worker_id == self.worker_id, JobRow.status == "running")
                            .values(heartbeat_at=utcnow()))
                        if result.rowcount == 0:
                            return
                except Exception:
                    # Never print connection strings or credentials. Losing the
                    # lease is checked again transactionally before adoption.
                    log.warning("Job heartbeat temporarily unavailable for %s", self.job_id)
        self.thread = threading.Thread(target=heartbeat, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=2)


def _finish_error(claim: dict, status: str, message: str | None, session_factory: Callable) -> None:
    with session_factory() as session, session.begin():
        job = session.scalar(select(JobRow).where(JobRow.id == claim["id"]).with_for_update())
        if job and job.worker_id == claim["worker_id"] and job.status == "running":
            job.status = "cancelled" if job.cancel_requested else status
            job.error = message
            job.updated_at = utcnow()


def _adopt(claim: dict, generated: ProviderResult, session_factory: Callable,
           *, admitted: dict | None = None, export: dict | None = None) -> None:
    with session_factory() as session, session.begin():
        # Consistent lock order with project mutation/admission: project then job.
        project = session.scalar(select(ProjectRow).where(ProjectRow.id == claim["project_id"]).with_for_update())
        job = session.scalar(select(JobRow).where(JobRow.id == claim["id"]).with_for_update())
        if project is None or project.deleted_at is not None or job is None or job.worker_id != claim["worker_id"] or job.status != "running" or job.cancel_requested:
            raise Cancelled()
        result = dict(generated.result)
        if admitted:
            asset_id = str(uuid4())
            metadata = {**admitted.get("metadata_json", {}), **generated.metadata, "job_id": job.id}
            # Alternatives are independent assets: selection always needs a
            # separate project PUT carrying the client's current revision.
            session.add(AssetRow(id=asset_id, project_id=job.project_id,
                scene_id=job.request.get("scene_id"), character_id=job.request.get("character_id"),
                kind=generated.kind, name=f"Generated {generated.kind}", source="generated", metadata_json=metadata,
                **{key: admitted.get(key) for key in ("path", "mime_type", "sha256", "byte_size", "duration", "width", "height")}))
            result.update(asset_id=asset_id, asset_ids=[asset_id], source_revision=job.snapshot["revision"])
        if export:
            export_id = str(uuid4())
            session.add(ExportRow(id=export_id, project_id=job.project_id, job_id=job.id,
                revision=job.snapshot["revision"], **export))
            result.update(export_id=export_id, source_revision=job.snapshot["revision"])
        job.result = result
        job.status = "succeeded"
        job.progress = 1.0
        job.provider_phase = "complete"
        job.error = None
        job.updated_at = utcnow()


def run_claim(claim: dict, *, session_factory: Callable = SessionLocal, settings=None,
              provider_runner: Callable = run_provider, renderer: Callable | None = None,
              heartbeat: bool = True) -> None:
    if claim.get("cancelled"):
        return
    settings = settings or get_settings()
    lease = Lease(claim["id"], claim["worker_id"], session_factory)
    # A fresh attempt directory prevents stale workers from removing another
    # worker's files after lease recovery.
    scratch = Path(settings.media_root) / "work" / claim["id"] / str(uuid4())
    scratch.mkdir(parents=True, exist_ok=True, mode=0o700)
    adopted = False
    cleanup_safe = True
    final_path: Path | None = None
    if heartbeat:
        lease.start()
    try:
        if lease.cancelled():
            raise Cancelled()
        for asset in claim["snapshot"].get("assets", {}).values():
            path = Path(asset["path"]).resolve()
            if not path.is_relative_to(Path(settings.media_root).resolve()) or not path.is_file():
                raise ValueError("A frozen source asset is no longer available.")
            with path.open("rb") as source:
                digest = hashlib.file_digest(source, "sha256").hexdigest()
            if not asset.get("sha256") or digest != asset["sha256"]:
                raise ValueError("A source asset changed after the job was queued. No generation or export was started.")
        if claim["kind"] == "export":
            if renderer is None:
                from .render import render_project
                renderer = render_project
            options = claim["request"].get("settings", {})
            output = scratch / "export.mp4"
            info = renderer(claim["snapshot"]["document"], claim["snapshot"].get("assets", {}), output,
                            progress=lease.progress, cancelled=lease.cancelled,
                            resolution=options.get("resolution", 720), quality=options.get("quality", "high"))
            if lease.cancelled():
                raise Cancelled()
            final_path = Path(settings.media_root) / "exports" / f"{uuid4()}.mp4"
            final_path.parent.mkdir(parents=True, exist_ok=True)
            output.replace(final_path)
            final_path.chmod(0o600)
            cleanup_safe = False
            try:
                _adopt(claim, ProviderResult(), session_factory, export={"path": str(final_path.resolve()),
                    "duration": info["duration"], "byte_size": info["byte_size"], "resolution": options.get("resolution", 720)})
            except Cancelled:
                cleanup_safe = True
                raise
        else:
            generated = provider_runner(claim["kind"], claim["snapshot"], claim["request"], settings, scratch,
                before_submit=lease.before_submit, submitted=lease.submitted, progress=lease.progress,
                cancelled=lease.cancelled, provider_id=claim.get("provider_id"), cancel_remote=lease.cancel_remote)
            if lease.cancelled():
                raise Cancelled()
            admitted = None
            if generated.path:
                admitted = admit_generated(generated.path, generated.kind, settings)
                final_path = Path(admitted["path"])
            cleanup_safe = False
            try:
                _adopt(claim, generated, session_factory, admitted=admitted)
            except Cancelled:
                cleanup_safe = True
                raise
        adopted = True
    except Cancelled:
        _finish_error(claim, "cancelled", "Cancelled. Already submitted provider work may still incur a charge.", session_factory)
    except ProviderError as exc:
        _finish_error(claim, "unknown" if exc.uncertain else "failed", str(exc), session_factory)
    except ValueError as exc:
        _finish_error(claim, "failed", str(exc)[:500], session_factory)
    except Exception:
        # A crash after the network call could hide a charge. Never retry it.
        with session_factory() as session:
            job = session.get(JobRow, claim["id"])
            ambiguous = job is not None and job.provider_phase in ("submitting", "submitted")
        _finish_error(claim, "unknown" if ambiguous else "failed",
            "The job stopped unexpectedly. Review server diagnostics; no automatic provider resubmission was made.", session_factory)
        log.error("Job %s stopped with a local error", claim["id"])
    finally:
        lease.close()
        # A dropped COMMIT acknowledgment can hide a successful publication.
        # Retain the file on ambiguous database outcomes; a later operator audit
        # may clean confirmed orphans. Never delete potentially committed media.
        if not adopted and cleanup_safe and final_path:
            final_path.unlink(missing_ok=True)
        shutil.rmtree(scratch, ignore_errors=True)


def reconcile_video(job_id: str, session_factory: Callable = SessionLocal) -> None:
    """Resume GET-only polling of a known task after an operator request."""
    with session_factory() as session, session.begin():
        job = session.scalar(select(JobRow).where(JobRow.id == job_id).with_for_update())
        if not job or job.kind != "video" or job.status != "unknown" or not (job.provider_id or "").startswith("runway:") or job.cancel_requested:
            raise ValueError("Only an unresolved, uncancelled video job with a stored provider ID can be reconciled.")
        job.status, job.error, job.worker_id = "queued", None, None
        job.updated_at = utcnow()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="Process at most one queued job")
    parser.add_argument("--reconcile", metavar="JOB_ID", help="Resume polling an existing unresolved video task")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.reconcile:
        reconcile_video(args.reconcile)
        return
    worker_id = str(uuid4())
    while True:
        recover_stale()
        claim = claim_next(worker_id)
        if claim:
            run_claim(claim)
        elif not args.once:
            time.sleep(2)
        if args.once:
            break


if __name__ == "__main__":
    main()
