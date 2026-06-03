"""
Global SlowAPI rate limiter (per-user when authenticated, else client IP).

Mounted in ``app.main`` together with ``SlowAPIMiddleware``. Tune ``default_limits``
for capacity planning (consider proxy-aware IP headers).

I3.10: when ``REDIS_URL`` (or ``RATELIMIT_REDIS_URL``) is set the limiter stores
counters in Redis so limits are enforced correctly across multiple API instances.
Without it, counts are per-process (in-memory) and diverge when scaled out.
"""

from __future__ import annotations

import logging
import os

from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.requests import Request

from app.core.security import decode_token

_log = logging.getLogger("riviso.ratelimit")


def rate_limit_key(request: Request) -> str:
    """Rate-limit key: authenticated user id when available, else client IP.

    S1.10: keying authenticated requests by the JWT subject means a spoofed
    ``X-Forwarded-For`` cannot be used to dodge per-user limits. Anonymous
    requests fall back to the (proxy-resolved) client address.
    """
    token = None
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        token = auth[7:].strip()
    if not token:
        token = request.cookies.get("aa_access")
    if token:
        try:
            payload = decode_token(token)
            sub = (payload.get("sub") or "").strip()
            if sub:
                return f"user:{sub}"
        except Exception:
            pass
    return f"ip:{get_remote_address(request)}"


_storage_uri = (os.environ.get("RATELIMIT_REDIS_URL") or os.environ.get("REDIS_URL") or "").strip()

_limiter_kwargs: dict = {"key_func": rate_limit_key, "default_limits": ["300/minute"]}
if _storage_uri:
    # Shared store across instances; fall back to in-memory if Redis is unreachable
    # so a transient Redis blip degrades limit accuracy rather than failing requests.
    _limiter_kwargs["storage_uri"] = _storage_uri
    _limiter_kwargs["in_memory_fallback_enabled"] = True
    _log.info("Rate limiter using Redis storage backend")

limiter = Limiter(**_limiter_kwargs)

