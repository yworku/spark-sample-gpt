from __future__ import annotations

import hashlib
import secrets
import threading
import time
from collections import defaultdict, deque
from datetime import timedelta

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy import delete
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_session
from .models import SessionRow, utcnow

COOKIE = "spark_session"
_attempts: dict[str, deque] = defaultdict(deque)
_attempts_lock = threading.Lock()


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def check_origin(request: Request):
    """All browser state changes require an exact trusted Origin, including login."""
    if request.headers.get("origin") not in get_settings().allowed_origins:
        raise HTTPException(403, "The request origin is not allowed.")
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "Cross-site changes are not allowed.")


def session_owner(request: Request, db: Session) -> str | None:
    token = request.cookies.get(COOKIE)
    if not token or len(token) > 200:
        return None
    session = db.get(SessionRow, token_hash(token))
    if session is None:
        return None
    if session.expires_at.replace(tzinfo=None) <= utcnow().replace(tzinfo=None):
        return None
    return session.owner_id


def require_owner(request: Request, db: Session = Depends(get_session)) -> str:
    owner = session_owner(request, db)
    if owner is None:
        raise HTTPException(401, "Sign in to continue.")
    return owner


def sign_in(password: str, request: Request, response: Response, db: Session):
    check_origin(request)
    settings = get_settings()
    if not settings.owner_password_hash:
        raise HTTPException(503, "Owner sign-in has not been configured.")
    address = request.client.host if request.client else "unknown"
    now = time.monotonic()
    with _attempts_lock:
        attempts = _attempts[address]
        while attempts and attempts[0] < now - 60:
            attempts.popleft()
        if len(attempts) >= 5:
            raise HTTPException(429, "Too many sign-in attempts. Try again in a minute.")
        attempts.append(now)
        if len(_attempts) > 10000:
            for key in list(_attempts):
                if not _attempts[key] or _attempts[key][-1] < now - 60:
                    _attempts.pop(key, None)
    try:
        valid = PasswordHasher().verify(settings.owner_password_hash, password)
    except (VerificationError, InvalidHashError):
        valid = False
    if not valid:
        raise HTTPException(401, "Incorrect password.")
    token = secrets.token_urlsafe(48)
    existing = request.cookies.get(COOKIE)
    if existing:
        db.execute(delete(SessionRow).where(SessionRow.token_hash == token_hash(existing)))
    db.execute(delete(SessionRow).where(SessionRow.expires_at <= utcnow()))
    db.add(SessionRow(token_hash=token_hash(token), owner_id="owner", expires_at=utcnow() + timedelta(hours=settings.session_hours)))
    db.commit()
    response.set_cookie(COOKIE, token, max_age=settings.session_hours * 3600,
                        httponly=True, secure=settings.session_secure, samesite="strict", path="/api")
    with _attempts_lock:
        _attempts.pop(address, None)


def sign_out(request: Request, response: Response, db: Session):
    check_origin(request)
    token = request.cookies.get(COOKIE)
    if token:
        db.execute(delete(SessionRow).where(SessionRow.token_hash == token_hash(token)))
        db.commit()
    response.delete_cookie(COOKIE, path="/api", secure=get_settings().session_secure, httponly=True, samesite="strict")
