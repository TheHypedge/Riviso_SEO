from __future__ import annotations

import uuid
from datetime import datetime

import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from werkzeug.security import check_password_hash, generate_password_hash

from app.core.deps import get_current_user
from app.core.security import create_access_token, create_refresh_token, decode_token
from app.core.config import settings
from app.core.ratelimit import limiter
from app.legacy.storage import get_legacy_storage_module
from app.services.to_thread import run_sync
from app.schemas.auth import LoginRequest, RegisterRequest, TokenPair, UserPublic

router = APIRouter(prefix="/auth", tags=["auth"])


def _to_user_public(u: dict) -> UserPublic:
    return UserPublic(
        id=(u.get("id") or "").strip(),
        email=(u.get("email") or "").strip(),
        role=((u.get("role") or "user").strip().lower() or "user"),
        subscription_type=((u.get("subscription_type") or "").strip() or None),
    )


@limiter.limit("10/minute")
@router.post("/login", response_model=TokenPair)
async def login(payload: LoginRequest, request: Request, response: Response) -> TokenPair:
    st = get_legacy_storage_module()
    try:
        user = await run_sync(st.get_user_by_email, str(payload.email).strip().lower())
    except Exception:
        # Most common cause in local dev: MongoDB/Atlas not reachable.
        raise HTTPException(status_code=503, detail="Database temporarily unavailable. Please try again.")
    if not user or not (user.get("password_hash") or ""):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not check_password_hash(user["password_hash"], payload.password):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "user").strip().lower()
    access = create_access_token(subject=uid, extra_claims={"role": role})
    refresh = create_refresh_token(subject=uid, extra_claims={"role": role})
    # Set httpOnly cookies (in addition to returning tokens) for safer clients.
    response.set_cookie(
        "aa_access",
        access,
        httponly=True,
        secure=bool(settings.cookie_secure),
        samesite=settings.cookie_samesite,
        domain=settings.cookie_domain,
        path="/",
    )
    response.set_cookie(
        "aa_refresh",
        refresh,
        httponly=True,
        secure=bool(settings.cookie_secure),
        samesite=settings.cookie_samesite,
        domain=settings.cookie_domain,
        path="/",
    )
    return TokenPair(access_token=access, refresh_token=refresh)


@limiter.limit("5/minute")
@router.post("/register", response_model=TokenPair)
async def register(payload: RegisterRequest, request: Request, response: Response) -> TokenPair:
    st = get_legacy_storage_module()
    email = str(payload.email).strip().lower()
    try:
        existing = await run_sync(st.get_user_by_email, email)
    except Exception:
        raise HTTPException(status_code=503, detail="Database temporarily unavailable. Please try again.")
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")
    # Basic server-side password hygiene (UI already checks; backend enforces too).
    pw = payload.password or ""
    if not re.search(r"[a-zA-Z]", pw) or not re.search(r"\d", pw) or not re.search(r"[^a-zA-Z0-9]", pw):
        raise HTTPException(status_code=400, detail="Password must include letters, numbers, and a special character")
    uid = str(uuid.uuid4())
    default_plan = "beta"
    try:
        if hasattr(st, "get_default_plan_key"):
            default_plan = str(st.get_default_plan_key() or "beta").strip().lower() or "beta"
    except Exception:
        default_plan = "beta"
    try:
        await run_sync(
            st.insert_user,
            {
                "id": uid,
                "email": email,
                "password_hash": generate_password_hash(payload.password),
                "role": "user",
                "subscription_type": default_plan,
                "full_name": "",
                "phone": "",
                "last_activity_at": "",
                "pending_product_tour": True,
                "created_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
            },
        )
    except Exception:
        raise HTTPException(status_code=503, detail="Database temporarily unavailable. Please try again.")
    access = create_access_token(subject=uid, extra_claims={"role": "user"})
    refresh = create_refresh_token(subject=uid, extra_claims={"role": "user"})
    response.set_cookie(
        "aa_access",
        access,
        httponly=True,
        secure=bool(settings.cookie_secure),
        samesite=settings.cookie_samesite,
        domain=settings.cookie_domain,
        path="/",
    )
    response.set_cookie(
        "aa_refresh",
        refresh,
        httponly=True,
        secure=bool(settings.cookie_secure),
        samesite=settings.cookie_samesite,
        domain=settings.cookie_domain,
        path="/",
    )
    return TokenPair(access_token=access, refresh_token=refresh)


@router.get("/me", response_model=UserPublic)
async def me(user: dict = Depends(get_current_user)) -> UserPublic:
    return _to_user_public(user)


@router.post("/refresh", response_model=TokenPair)
async def refresh_token(request: Request, response: Response) -> TokenPair:
    """
    Exchange a refresh token for a new access token.
    Accepts refresh token via:
    - JSON body: {"refresh_token": "..."} (for localStorage-based clients)
    - httpOnly cookie: aa_refresh (for cookie-based clients)
    """
    st = get_legacy_storage_module()
    body = {}
    try:
        body = await request.json()
    except Exception:
        body = {}
    rt = (body.get("refresh_token") if isinstance(body, dict) else None) or request.cookies.get("aa_refresh") or ""
    rt = str(rt or "").strip()
    if not rt:
        raise HTTPException(status_code=401, detail="Missing refresh token")
    try:
        payload = decode_token(rt)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    if (payload.get("type") or "") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid token type")
    uid = (payload.get("sub") or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="Invalid token subject")
    try:
        user = await run_sync(st.get_user_by_id, uid)
    except Exception:
        raise HTTPException(status_code=503, detail="Database temporarily unavailable. Please try again.")
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    role = (user.get("role") or "user").strip().lower()

    access = create_access_token(subject=uid, extra_claims={"role": role})
    # Keep refresh token as-is (simple + stable). Could be rotated later if needed.
    response.set_cookie(
        "aa_access",
        access,
        httponly=True,
        secure=bool(settings.cookie_secure),
        samesite=settings.cookie_samesite,
        domain=settings.cookie_domain,
        path="/",
    )
    return TokenPair(access_token=access, refresh_token=rt)

