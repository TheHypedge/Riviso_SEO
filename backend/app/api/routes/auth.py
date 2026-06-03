from __future__ import annotations



import secrets

import uuid

from datetime import datetime, timedelta



import re



from fastapi import APIRouter, Depends, HTTPException, Request, Response

from werkzeug.security import check_password_hash, generate_password_hash



from app.core.deps import account_is_inactive, account_requires_email_verification, get_current_user

from app.core.security import create_access_token, create_refresh_token, decode_token

from app.core.config import settings

from app.core.ratelimit import limiter

from app.legacy.storage import get_legacy_storage_module

from app.services.email_dispatch import dispatch_password_reset_email, dispatch_verification_email

from app.services.storage_db import call_storage

from app.services.storage_http import DATABASE_UNAVAILABLE_DETAIL, raise_storage_http

from app.services.to_thread import run_sync

from app.schemas.auth import (

    ForgotPasswordRequest,

    ForgotPasswordResponse,

    LoginRequest,

    RegisterPendingResponse,

    RegisterRequest,

    ResendVerificationRequest,

    ResendVerificationResponse,

    ResetPasswordRequest,

    ResetPasswordResponse,

    TokenPair,

    UserPublic,

    VerifyEmailRequest,

    VerifyEmailResponse,

)



router = APIRouter(prefix="/auth", tags=["auth"])





def _retained_account_detail(message: str) -> dict:

    return {

        "code": "account_reactivation_required",

        "message": message,

        "can_reactivate": True,

    }





def _verification_required_detail() -> dict:

    return {

        "code": "email_verification_required",

        "message": "Verify your email address before signing in. Check your inbox for the verification code.",

    }





def _to_user_public(u: dict) -> UserPublic:

    return UserPublic(

        id=(u.get("id") or "").strip(),

        email=(u.get("email") or "").strip(),

        role=((u.get("role") or "user").strip().lower() or "user"),

        subscription_type=((u.get("subscription_type") or "").strip() or None),

    )





def _cookie_secure_flag() -> bool:
    # S1.4: always Secure in production, even if COOKIE_SECURE was left unset.
    return bool(settings.cookie_secure) or settings.is_production


def _set_auth_cookies(response: Response, access: str, refresh: str) -> None:

    response.set_cookie(

        "aa_access",

        access,

        httponly=True,

        secure=_cookie_secure_flag(),

        samesite=settings.cookie_samesite,

        domain=settings.cookie_domain,

        path="/",

        max_age=settings.access_token_ttl_seconds,

    )

    response.set_cookie(

        "aa_refresh",

        refresh,

        httponly=True,

        secure=_cookie_secure_flag(),

        samesite=settings.cookie_samesite,

        domain=settings.cookie_domain,

        path="/",

        max_age=settings.refresh_token_ttl_seconds,

    )





# S1.1: refresh-token rotation. Each refresh token carries a unique ``jti`` that
# must be present in the user's server-side allowlist; refreshing rotates it
# (old jti removed, new added) so a replayed/old refresh token is rejected.
_MAX_REFRESH_SESSIONS = 10


def _active_refresh_jtis(user: dict) -> list[str]:
    raw = user.get("refresh_session_jtis")
    if isinstance(raw, list):
        return [str(x) for x in raw if str(x).strip()]
    return []


async def _persist_refresh_jtis(st, uid: str, jtis: list[str]) -> None:
    if not uid or not hasattr(st, "update_user_fields"):
        return
    trimmed = jtis[-_MAX_REFRESH_SESSIONS:]
    try:
        await run_sync(call_storage, st.update_user_fields, uid, {"refresh_session_jtis": trimmed})
    except Exception:
        # Non-fatal: failing to persist the allowlist must not block auth.
        pass


async def _issue_tokens(st, user: dict, response: Response) -> TokenPair:

    uid = (user.get("id") or "").strip()

    role = (user.get("role") or "user").strip().lower()

    jti = uuid.uuid4().hex

    access = create_access_token(subject=uid, extra_claims={"role": role})

    refresh = create_refresh_token(subject=uid, extra_claims={"role": role, "jti": jti})

    await _persist_refresh_jtis(st, uid, _active_refresh_jtis(user) + [jti])

    _set_auth_cookies(response, access, refresh)

    return TokenPair(access_token=access, refresh_token=refresh)





# S1.5: account lockout after repeated failed logins (per-account backoff).
_LOGIN_MAX_FAILURES = 8
_LOGIN_LOCKOUT_MINUTES = 15
_TS_FMT = "%Y-%m-%d %H:%M:%S"


def _parse_utc_ts(raw) -> datetime | None:
    s = str(raw or "").strip()
    if not s:
        return None
    try:
        return datetime.strptime(s, _TS_FMT)
    except (TypeError, ValueError):
        return None


def _lockout_remaining_seconds(user: dict) -> int:
    until = _parse_utc_ts(user.get("login_lockout_until"))
    if not until:
        return 0
    delta = (until - datetime.utcnow()).total_seconds()
    return int(delta) if delta > 0 else 0


async def _register_failed_login(st, user: dict) -> None:
    uid = (user.get("id") or "").strip()
    if not uid or not hasattr(st, "update_user_fields"):
        return
    count = int(user.get("login_failed_count") or 0) + 1
    updates: dict = {"login_failed_count": count}
    if count >= _LOGIN_MAX_FAILURES:
        updates["login_lockout_until"] = (
            datetime.utcnow() + timedelta(minutes=_LOGIN_LOCKOUT_MINUTES)
        ).strftime(_TS_FMT)
        updates["login_failed_count"] = 0
    try:
        await run_sync(call_storage, st.update_user_fields, uid, updates)
    except Exception:
        pass


async def _reset_failed_login(st, user: dict) -> None:
    uid = (user.get("id") or "").strip()
    if not uid or not hasattr(st, "update_user_fields"):
        return
    if not int(user.get("login_failed_count") or 0) and not (user.get("login_lockout_until") or ""):
        return
    try:
        await run_sync(call_storage, st.update_user_fields, uid, {"login_failed_count": 0, "login_lockout_until": ""})
    except Exception:
        pass


@limiter.limit("10/minute")

@router.post("/login", response_model=TokenPair)

async def login(payload: LoginRequest, request: Request, response: Response) -> TokenPair:

    st = get_legacy_storage_module()

    email = str(payload.email).strip().lower()

    try:

        user = await run_sync(call_storage, st.get_user_by_email, email)

    except HTTPException:

        raise

    except Exception as e:

        raise_storage_http(e)

    if not user or not (user.get("password_hash") or ""):

        raise HTTPException(status_code=401, detail="Invalid email or password")

    remaining = _lockout_remaining_seconds(user)

    if remaining > 0:

        raise HTTPException(

            status_code=429,

            detail=f"Too many failed login attempts. Try again in about {max(1, remaining // 60)} minute(s).",

            headers={"Retry-After": str(remaining)},

        )

    if not check_password_hash(user["password_hash"], payload.password):

        await _register_failed_login(st, user)

        raise HTTPException(status_code=401, detail="Invalid email or password")

    await _reset_failed_login(st, user)

    if account_is_inactive(user):

        raise HTTPException(

            status_code=403,

            detail=_retained_account_detail(

                "This account is retained but inactive. Reactivate it to restore your projects and articles."

            ),

        )

    if account_requires_email_verification(user):

        raise HTTPException(status_code=403, detail=_verification_required_detail())



    return await _issue_tokens(st, user, response)





@limiter.limit("5/minute")

@router.post("/register", response_model=RegisterPendingResponse, status_code=201)

async def register(payload: RegisterRequest, request: Request) -> RegisterPendingResponse:

    st = get_legacy_storage_module()

    email = str(payload.email).strip().lower()

    try:

        existing = await run_sync(call_storage, st.get_user_by_email, email)

    except HTTPException:

        raise

    except Exception as e:

        raise_storage_http(e)

    if existing:

        if account_is_inactive(existing):

            raise HTTPException(

                status_code=409,

                detail=_retained_account_detail(

                    "This email belongs to a retained account. Reactivate it to restore the saved workspace."

                ),

            )

        raise HTTPException(status_code=409, detail="Email already registered")

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

    if hasattr(st, "generate_email_verification_otp"):
        verification_code = str(st.generate_email_verification_otp())
    else:
        verification_code = f"{secrets.randbelow(900_000) + 100_000:06d}"

    expires_at = datetime.utcnow() + timedelta(minutes=15)

    sent_at = datetime.utcnow()

    created_at = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    try:

        await run_sync(

            call_storage,

            st.insert_user,

            {

                "id": uid,

                "email": email,

                "password_hash": generate_password_hash(payload.password),

                "role": "user",

                "subscription_type": default_plan,

                "account_status": "pending",

                "full_name": "",

                "phone": "",

                "last_activity_at": "",

                "pending_product_tour": True,

                "created_at": created_at,

                "email_verification_token": verification_code,

                "email_verification_expires": expires_at.strftime("%Y-%m-%dT%H:%M:%SZ"),

                "email_verification_expires_at": expires_at,

                "email_verification_sent_at": sent_at,

            },

        )

    except HTTPException:

        raise

    except Exception as e:

        raise_storage_http(e)



    dispatch_verification_email(to=email, token=verification_code)

    return RegisterPendingResponse(email=email, retry_after_seconds=60)





@limiter.limit("5/minute")

@router.post("/resend-verification", response_model=ResendVerificationResponse)

async def resend_verification(payload: ResendVerificationRequest, request: Request) -> ResendVerificationResponse:

    st = get_legacy_storage_module()

    email = str(payload.email).strip().lower()

    generic = ResendVerificationResponse(retry_after_seconds=60)

    if not hasattr(st, "resend_email_verification"):

        raise HTTPException(status_code=501, detail="Resend verification is not available")

    try:

        action, message, retry_after, token = await run_sync(st.resend_email_verification, email=email)

    except Exception as e:

        raise_storage_http(e)

    if action == "cooldown":

        raise HTTPException(

            status_code=429,

            detail={

                "code": "resend_cooldown",

                "message": message,

                "retry_after_seconds": retry_after,

            },

        )

    if action == "sent" and token:

        dispatch_verification_email(to=email, token=token)

        return ResendVerificationResponse(message=message, retry_after_seconds=retry_after or 60)

    return generic





@limiter.limit("10/minute")

@router.post("/verify-email", response_model=VerifyEmailResponse)

async def verify_email(payload: VerifyEmailRequest, request: Request, response: Response) -> VerifyEmailResponse:

    st = get_legacy_storage_module()

    email = str(payload.email).strip().lower()

    token = (payload.token or "").strip()

    if not hasattr(st, "verify_email_with_token"):

        raise HTTPException(status_code=501, detail="Email verification is not available")

    try:

        ok, message = await run_sync(st.verify_email_with_token, email=email, token=token)

    except Exception as e:

        raise_storage_http(e)

    if not ok:

        raise HTTPException(status_code=400, detail=message)

    try:

        user = await run_sync(call_storage, st.get_user_by_email, email)

    except Exception as e:

        raise_storage_http(e)

    if not user:

        return VerifyEmailResponse(ok=True, message=message)

    tokens = await _issue_tokens(st, user, response)

    return VerifyEmailResponse(

        ok=True,

        message=message,

        access_token=tokens.access_token,

        refresh_token=tokens.refresh_token,

    )





@limiter.limit("5/minute")

@router.post("/forgot-password", response_model=ForgotPasswordResponse)

async def forgot_password(payload: ForgotPasswordRequest, request: Request) -> ForgotPasswordResponse:

    st = get_legacy_storage_module()

    email = str(payload.email).strip().lower()

    generic = ForgotPasswordResponse()

    try:

        user = await run_sync(call_storage, st.get_user_by_email, email)

    except Exception:

        return generic

    if not user or account_is_inactive(user):

        return generic

    reset_token = uuid.uuid4().hex

    expires_at = datetime.utcnow() + timedelta(hours=1)

    if hasattr(st, "set_password_reset_token"):

        try:

            saved = await run_sync(

                st.set_password_reset_token,

                email=email,

                token=reset_token,

                expires_at=expires_at,

            )

        except Exception:

            saved = False

        if saved:

            dispatch_password_reset_email(to=email, token=reset_token)

    return generic





@limiter.limit("5/minute")

@router.post("/reset-password", response_model=ResetPasswordResponse)

async def reset_password(payload: ResetPasswordRequest, request: Request) -> ResetPasswordResponse:

    st = get_legacy_storage_module()

    email = str(payload.email).strip().lower()

    token = (payload.token or "").strip()

    pw = payload.password or ""

    if not re.search(r"[a-zA-Z]", pw) or not re.search(r"\d", pw) or not re.search(r"[^a-zA-Z0-9]", pw):

        raise HTTPException(status_code=400, detail="Password must include letters, numbers, and a special character")

    if not hasattr(st, "complete_password_reset"):

        raise HTTPException(status_code=501, detail="Password reset is not available")

    try:

        ok, message = await run_sync(

            st.complete_password_reset,

            email=email,

            token=token,

            password_hash=generate_password_hash(pw),

        )

    except Exception as e:

        raise_storage_http(e)

    if not ok:

        raise HTTPException(status_code=400, detail=message)

    return ResetPasswordResponse(message=message)





@limiter.limit("5/minute")

@router.post("/reactivate", response_model=TokenPair)

async def reactivate(payload: LoginRequest, request: Request, response: Response) -> TokenPair:

    st = get_legacy_storage_module()

    email = str(payload.email).strip().lower()

    try:

        user = await run_sync(call_storage, st.get_user_by_email, email)

    except HTTPException:

        raise

    except Exception as e:

        raise_storage_http(e)

    if not user or not (user.get("password_hash") or ""):

        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not check_password_hash(user["password_hash"], payload.password):

        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not account_is_inactive(user):

        if account_requires_email_verification(user):

            raise HTTPException(status_code=403, detail=_verification_required_detail())

        return await _issue_tokens(st, user, response)



    uid = (user.get("id") or "").strip()

    try:

        ok = (

            await run_sync(call_storage, st.reactivate_user, uid)

            if hasattr(st, "reactivate_user")

            else False

        )

    except HTTPException:

        raise

    except Exception as e:

        raise_storage_http(e)

    if not ok:

        raise HTTPException(status_code=503, detail=DATABASE_UNAVAILABLE_DETAIL)



    try:

        restored = await run_sync(call_storage, st.get_user_by_id, uid)

    except HTTPException:

        raise

    except Exception as e:

        raise_storage_http(e)

    if not restored:

        raise HTTPException(status_code=503, detail=DATABASE_UNAVAILABLE_DETAIL)

    if account_requires_email_verification(restored):

        raise HTTPException(status_code=403, detail=_verification_required_detail())

    return await _issue_tokens(st, restored, response)





@router.get("/me", response_model=UserPublic)

async def me(user: dict = Depends(get_current_user)) -> UserPublic:

    return _to_user_public(user)





@limiter.limit("20/minute")

@router.post("/refresh", response_model=TokenPair)

async def refresh_token(request: Request, response: Response) -> TokenPair:

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

        user = await run_sync(call_storage, st.get_user_by_id, uid)

    except HTTPException:

        raise

    except Exception as e:

        raise_storage_http(e)

    if not user:

        raise HTTPException(status_code=401, detail="User not found")

    if account_is_inactive(user):

        raise HTTPException(status_code=403, detail="This account is deactivated or deleted")

    if account_requires_email_verification(user):

        raise HTTPException(status_code=403, detail=_verification_required_detail())

    role = (user.get("role") or "user").strip().lower()

    # S1.1: validate the refresh-token jti against the server-side allowlist and
    # rotate it. A replayed or rotated-away token (jti absent from the list) is
    # rejected. Legacy refresh tokens minted before rotation existed have no jti
    # and require a one-time re-login.
    presented_jti = (payload.get("jti") or "").strip()

    active = _active_refresh_jtis(user)

    if not presented_jti or presented_jti not in active:

        raise HTTPException(status_code=401, detail="Refresh token is no longer valid")

    new_jti = uuid.uuid4().hex

    remaining = [j for j in active if j != presented_jti] + [new_jti]

    await _persist_refresh_jtis(st, uid, remaining)

    access = create_access_token(subject=uid, extra_claims={"role": role})

    refresh = create_refresh_token(subject=uid, extra_claims={"role": role, "jti": new_jti})

    _set_auth_cookies(response, access, refresh)

    return TokenPair(access_token=access, refresh_token=refresh)


def _clear_auth_cookies(response: Response) -> None:
    for name in ("aa_access", "aa_refresh"):
        response.delete_cookie(name, path="/", domain=settings.cookie_domain)


@router.post("/logout", status_code=200)
async def logout(request: Request, response: Response) -> dict:
    """Revoke the presented refresh token's jti server-side and clear auth cookies (S1.1)."""
    st = get_legacy_storage_module()
    rt = request.cookies.get("aa_refresh") or ""
    try:
        body = await request.json()
        if isinstance(body, dict) and body.get("refresh_token"):
            rt = str(body.get("refresh_token"))
    except Exception:
        pass
    rt = str(rt or "").strip()
    if rt:
        try:
            payload = decode_token(rt)
            uid = (payload.get("sub") or "").strip()
            jti = (payload.get("jti") or "").strip()
            if uid and jti:
                user = await run_sync(call_storage, st.get_user_by_id, uid)
                if user:
                    remaining = [j for j in _active_refresh_jtis(user) if j != jti]
                    await _persist_refresh_jtis(st, uid, remaining)
        except Exception:
            # Best-effort revocation; always clear cookies regardless.
            pass
    _clear_auth_cookies(response)
    return {"ok": True}


