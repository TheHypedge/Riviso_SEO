from __future__ import annotations

from datetime import datetime, timedelta, timezone

from jose import jwt

from app.core.config import settings


ALGORITHM = "HS256"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def create_access_token(*, subject: str, extra_claims: dict | None = None) -> str:
    exp = _utc_now() + timedelta(seconds=int(settings.access_token_ttl_seconds))
    payload = {"sub": subject, "type": "access", "exp": exp}
    if extra_claims:
        payload.update(extra_claims)
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def create_refresh_token(*, subject: str, extra_claims: dict | None = None) -> str:
    exp = _utc_now() + timedelta(seconds=int(settings.refresh_token_ttl_seconds))
    payload = {"sub": subject, "type": "refresh", "exp": exp}
    if extra_claims:
        payload.update(extra_claims)
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    return jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])

