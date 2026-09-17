"""Create local secrets without putting a password in shell history or overwriting configuration."""
from __future__ import annotations

import argparse
import getpass
import os
from pathlib import Path
import secrets

from argon2 import PasswordHasher


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default="http://localhost:8000", help="Public browser origin without a trailing slash")
    args = parser.parse_args()
    origin = args.origin.rstrip("/")
    if not origin.startswith(("http://localhost:", "http://127.0.0.1:", "https://")) or any(c in origin for c in "\n\r'\""):
        parser.error("Use a localhost HTTP origin or your HTTPS origin.")
    destination = Path(__file__).resolve().parent.parent / ".env"
    if destination.exists():
        raise SystemExit(".env already exists. Edit that file to retain your database credentials.")
    password = getpass.getpass("Choose your studio password (at least 12 characters): ")
    if len(password) < 12:
        raise SystemExit("Password must be at least 12 characters.")
    if password != getpass.getpass("Repeat studio password: "):
        raise SystemExit("Passwords did not match. No file was written.")
    database_password = secrets.token_urlsafe(36)
    password_hash = PasswordHasher().hash(password)
    secure = origin.startswith("https://")
    origins = origin if secure else ",".join(dict.fromkeys([origin, "http://localhost:8000", "http://127.0.0.1:8000", "http://localhost:5173", "http://127.0.0.1:5173"]))
    content = (
        f"POSTGRES_PASSWORD='{database_password}'\n"
        f"STUDIO_OWNER_PASSWORD_HASH='{password_hash}'\n"
        "STUDIO_ENV=production\n"
        f"STUDIO_ALLOWED_ORIGINS={origins}\n"
        f"STUDIO_SECURE_COOKIES={str(secure).lower()}\n"
        "STUDIO_MEDIA_ROOT=./var/media\nSTUDIO_FRONTEND_DIST=./frontend/dist\n"
        f"DATABASE_URL=postgresql+psycopg://studio:{database_password}@localhost:5432/studio\n"
        "OPENAI_API_KEY=''\nRUNWAY_API_KEY=''\nELEVENLABS_API_KEY=''\n"
    )
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(content)
    print("Created .env. Start the application with: docker compose up --build -d")


if __name__ == "__main__":
    main()
