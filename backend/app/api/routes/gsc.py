from __future__ import annotations

import time
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from starlette.responses import RedirectResponse

from app.core.config import settings
from app.core.deps import get_current_user
from app.legacy.storage import get_legacy_storage_module
from app.services import gsc


router = APIRouter(prefix="/gsc", tags=["gsc"])

def _public_api_url(path: str) -> str:
    """
    Build an absolute URL for Google OAuth redirect_uri.
    Prefer PUBLIC_BASE_URL because requests may come via internal hostnames (127.0.0.1, docker).
    """
    base = (str(settings.public_base_url) if settings.public_base_url else "").strip().rstrip("/")
    if not base:
        return path
    p = path if path.startswith("/") else f"/{path}"
    return f"{base}{p}"


def _frontend_redirect_url(*, ok: bool, message: str | None = None) -> str:
    base = (str(settings.frontend_base_url) if settings.frontend_base_url else "").strip().rstrip("/")
    if not base:
        # Best-effort fallback: many installs serve frontend at the same public origin.
        base = (str(settings.public_base_url) if settings.public_base_url else "").strip().rstrip("/")
    qs = "gsc=connected" if ok else "gsc=error"
    if message:
        # Keep it short; frontend can render it.
        qs += f"&msg={message[:180]}"
    if not base:
        # Relative redirect (same origin). Avoid `//dashboard` which browsers treat as a hostname.
        return f"/dashboard?{qs}"
    return f"{base}/dashboard?{qs}"


@router.get("/status")
async def status(user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    fresh = st.get_user_by_id(uid) if hasattr(st, "get_user_by_id") else user
    email = (fresh.get("gsc_email") or "").strip() or None
    rt = (fresh.get("gsc_refresh_token") or "").strip()
    return {
        "configured": gsc.oauth_configured(),
        "connected": bool(rt),
        "email": email,
    }


@router.get("/connect-url")
async def connect_url(request: Request, user: dict = Depends(get_current_user)) -> dict:
    if not gsc.oauth_configured():
        raise HTTPException(status_code=400, detail="Google OAuth client is not configured on the backend")
    uid = (user.get("id") or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="Unauthorized")
    state = gsc.make_state_token(user_id=uid)
    redirect_uri = _public_api_url(str(request.url_for("gsc_oauth_callback")))
    url = gsc.build_auth_url(redirect_uri=redirect_uri, state=state)
    return {"url": url}


@router.get("/oauth/callback", name="gsc_oauth_callback")
async def oauth_callback(request: Request) -> RedirectResponse:
    code = (request.query_params.get("code") or "").strip()
    state = (request.query_params.get("state") or "").strip()
    if not code or not state:
        return RedirectResponse(_frontend_redirect_url(ok=False, message="Missing code/state"), status_code=302)
    try:
        uid = gsc.parse_state_token(state)
    except Exception:
        return RedirectResponse(_frontend_redirect_url(ok=False, message="Invalid state"), status_code=302)

    redirect_uri = _public_api_url(str(request.url_for("gsc_oauth_callback")))
    try:
        tok = await gsc.exchange_code_for_tokens(code=code, redirect_uri=redirect_uri)
    except Exception:
        return RedirectResponse(_frontend_redirect_url(ok=False, message="Token exchange failed"), status_code=302)

    access_token = (tok.get("access_token") or "").strip()
    refresh_token = (tok.get("refresh_token") or "").strip()
    expires_in = int(tok.get("expires_in") or 0)
    exp = int(time.time()) + max(0, expires_in)
    scope = (tok.get("scope") or "").strip()

    email = await gsc.fetch_user_email(access_token=access_token) if access_token else None

    st = get_legacy_storage_module()
    if not hasattr(st, "update_user_fields"):
        return RedirectResponse(_frontend_redirect_url(ok=False, message="Storage missing update_user_fields"), status_code=302)
    st.update_user_fields(
        uid,
        {
            "gsc_access_token": access_token,
            "gsc_refresh_token": refresh_token,
            "gsc_token_expires_at": str(exp),
            "gsc_scope": scope,
            "gsc_email": email or "",
            "gsc_connected_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        },
    )

    return RedirectResponse(_frontend_redirect_url(ok=True), status_code=302)


async def _get_valid_access_token_for_user(*, st, uid: str) -> str:
    u = st.get_user_by_id(uid) if hasattr(st, "get_user_by_id") else None
    if not isinstance(u, dict):
        raise HTTPException(status_code=400, detail="User not found")
    rt = (u.get("gsc_refresh_token") or "").strip()
    if not rt:
        raise HTTPException(status_code=400, detail="Google Search Console is not connected for this user")
    at = (u.get("gsc_access_token") or "").strip()
    exp_raw = (u.get("gsc_token_expires_at") or "").strip()
    try:
        exp = int(exp_raw or "0")
    except Exception:
        exp = 0
    now = int(time.time())
    if at and exp and (exp - now) > 60:
        return at
    # refresh
    try:
        tok = await gsc.refresh_access_token(refresh_token=rt)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not refresh Google token: {e}") from None
    at2 = (tok.get("access_token") or "").strip()
    expires_in = int(tok.get("expires_in") or 0)
    exp2 = int(time.time()) + max(0, expires_in)
    if at2:
        st.update_user_fields(uid, {"gsc_access_token": at2, "gsc_token_expires_at": str(exp2)})
    return at2


@router.get("/sites")
async def list_sites(user: dict = Depends(get_current_user)) -> list[dict]:
    if not gsc.oauth_configured():
        raise HTTPException(status_code=400, detail="Google OAuth client is not configured on the backend")
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    tok = await _get_valid_access_token_for_user(st=st, uid=uid)
    return await gsc.list_search_console_sites(access_token=tok)

