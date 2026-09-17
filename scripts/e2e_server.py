"""Disposable loopback-only server for browser tests. Never loads production .env."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile

from argon2 import PasswordHasher
import uvicorn


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="spark-e2e-") as temporary:
        os.environ.update({
            "STUDIO_ENV": "test",
            "DATABASE_URL": os.getenv("TEST_POSTGRES_URL", f"sqlite:///{temporary}/test.sqlite"),
            "STUDIO_MEDIA_ROOT": str(Path(temporary) / "media"),
            "STUDIO_FRONTEND_DIST": str(root / "frontend" / "dist"),
            "STUDIO_ALLOWED_ORIGINS": "http://127.0.0.1:8000",
            "STUDIO_SECURE_COOKIES": "false",
            "STUDIO_OWNER_PASSWORD_HASH": PasswordHasher().hash("disposable-browser-test-password"),
            "OPENAI_API_KEY": "", "RUNWAY_API_KEY": "", "ELEVENLABS_API_KEY": "",
        })
        from studio.db import init_schema
        init_schema()
        worker = subprocess.Popen([sys.executable, "-m", "studio.worker"], cwd=root)
        try:
            uvicorn.run("studio.api:app", host="127.0.0.1", port=8000, proxy_headers=False)
        finally:
            worker.terminate()
            try:
                worker.wait(timeout=10)
            except subprocess.TimeoutExpired:
                worker.kill()
                worker.wait()


if __name__ == "__main__":
    main()
