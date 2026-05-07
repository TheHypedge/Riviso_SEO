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
        return (path or "").strip()

    from urllib.parse import urlparse, urlunparse

    p0 = (path or "").strip()
    b = urlparse(base)
    u = urlparse(p0)

    # If already absolute, keep its path/query but force PUBLIC_BASE_URL origin (scheme+host).
    if u.scheme and u.netloc:
        return urlunparse((b.scheme, b.netloc, u.path, u.params, u.query, u.fragment))

    # If relative, join onto base.
    p = p0 if p0.startswith("/") else f"/{p0}"
    return f"{base}{p}"


def _frontend_redirect_url(*, ok: bool, message: str | None = None) -> str:
    base = (str(settings.frontend_base_url) if settings.frontend_base_url else "").strip().rstrip("/")
    if not base:
        # Best-effort fallback: many installs serve frontend at the same public origin.
        base = (str(settings.public_base_url) if settings.public_base_url else "").strip().rstrip("/")
    frag = "gsc=connected" if ok else "gsc=error"
    if message:
        # Keep it short; frontend can render it.
        frag += f"&msg={message[:180]}"
    if not base:
        # Relative redirect (same origin). Avoid `//dashboard` which browsers treat as a hostname.
        return f"/dashboard#{frag}"
    return f"{base}/dashboard#{frag}"


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


def _frontend_project_redirect_url(*, project_id: str, ok: bool, message: str | None = None) -> str:
    base = (str(settings.frontend_base_url) if settings.frontend_base_url else "").strip().rstrip("/")
    if not base:
        base = (str(settings.public_base_url) if settings.public_base_url else "").strip().rstrip("/")
    frag = "gsc=connected" if ok else "gsc=error"
    if message:
        frag += f"&msg={message[:180]}"
    pid = (project_id or "").strip()
    target = f"/projects/{pid}?tab=tools#{frag}" if pid else f"/dashboard#{frag}"
    if not base:
        return target
    return f"{base}{target}"


@router.get("/oauth/callback", name="gsc_oauth_callback")
async def oauth_callback(request: Request) -> RedirectResponse:
    code = (request.query_params.get("code") or "").strip()
    state = (request.query_params.get("state") or "").strip()
    if not code or not state:
        return RedirectResponse(_frontend_redirect_url(ok=False, message="Missing code/state"), status_code=302)
    try:
        parsed = gsc.parse_state_token(state)
    except Exception:
        return RedirectResponse(_frontend_redirect_url(ok=False, message="Invalid state"), status_code=302)
    uid = (parsed.get("uid") or "").strip()
    pid = (parsed.get("pid") or "").strip()

    redirect_uri = _public_api_url(str(request.url_for("gsc_oauth_callback")))
    try:
        tok = await gsc.exchange_code_for_tokens(code=code, redirect_uri=redirect_uri)
    except Exception:
        target = _frontend_project_redirect_url(project_id=pid, ok=False, message="Token exchange failed") if pid else _frontend_redirect_url(ok=False, message="Token exchange failed")
        return RedirectResponse(target, status_code=302)

    access_token = (tok.get("access_token") or "").strip()
    refresh_token = (tok.get("refresh_token") or "").strip()
    expires_in = int(tok.get("expires_in") or 0)
    exp = int(time.time()) + max(0, expires_in)
    scope = (tok.get("scope") or "").strip()

    email = await gsc.fetch_user_email(access_token=access_token) if access_token else None
    now_str = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    st = get_legacy_storage_module()

    if pid:
        # Per-project flow: store the new GSC connection on the project itself.
        if not hasattr(st, "update_project_fields"):
            return RedirectResponse(_frontend_project_redirect_url(project_id=pid, ok=False, message="Storage missing update_project_fields"), status_code=302)
        proj = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
        if not isinstance(proj, dict):
            return RedirectResponse(_frontend_project_redirect_url(project_id=pid, ok=False, message="Project not found"), status_code=302)
        # Ensure the same user that started the flow still owns the project.
        owner = (proj.get("owner_user_id") or "").strip()
        if owner and owner != uid:
            return RedirectResponse(_frontend_project_redirect_url(project_id=pid, ok=False, message="Project owner mismatch"), status_code=302)
        st.update_project_fields(
            pid,
            {
                "gsc_access_token": access_token,
                # Google only returns refresh_token on the first consent; keep the existing
                # one if the new exchange did not include one (subsequent re-auths).
                "gsc_refresh_token": refresh_token or (proj.get("gsc_refresh_token") or ""),
                "gsc_token_expires_at": str(exp),
                "gsc_scope": scope,
                "gsc_email": email or "",
                "gsc_connected_at": now_str,
            },
        )
        return RedirectResponse(_frontend_project_redirect_url(project_id=pid, ok=True), status_code=302)

    # Legacy user-level flow (kept for backward compat with older clients/tabs).
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
            "gsc_connected_at": now_str,
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

