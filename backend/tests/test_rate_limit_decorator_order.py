"""Regression: per-route rate limits must actually run.

Decorators apply bottom-up. With '@limiter.limit' ABOVE '@router.post', FastAPI registers the
un-wrapped function and the limit never runs -- that is how every auth limit (login 10/min,
register 5/min, OTP verify, reset...) was silently disabled until 2026-10-27, found by the QA run
(15 wrong passwords in a row, no 429). '@router.*' must come first, '@limiter.limit' right under it.
"""

from __future__ import annotations

import glob
import os

os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")

ROUTES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app", "api", "routes")


def test_no_limiter_decorator_sits_above_a_router_decorator():
    bad = []
    for path in glob.glob(os.path.join(ROUTES, "*.py")):
        lines = open(path, encoding="utf-8").read().split("\n")
        for i, line in enumerate(lines):
            if line.strip().startswith("@limiter.limit"):
                nxt = next((x.strip() for x in lines[i + 1:] if x.strip()), "")
                if nxt.startswith("@router.") or nxt.startswith("@app."):
                    bad.append(f"{os.path.basename(path)}:{i + 1}")
    assert not bad, f"limit never applied (put @router first): {bad}"


def test_login_limit_is_enforced(monkeypatch):
    from fastapi.testclient import TestClient

    import app.api.routes.auth as auth_routes
    import app.main as main_mod

    class _NoUsers:
        def get_user_by_email(self, email):
            return None

    monkeypatch.setattr(auth_routes, "get_legacy_storage_module", lambda: _NoUsers())
    c = TestClient(main_mod.app)
    hdr = {"X-Requested-With": "XMLHttpRequest", "X-Forwarded-For": "203.0.113.77"}
    codes = [c.post("/api/auth/login", json={"email": "nobody@example.com", "password": "x"}, headers=hdr).status_code
             for _ in range(12)]
    assert 429 in codes, codes
