"""
FastAPI dependencies for authentication.

Resolves the current user from either ``Authorization: Bearer`` or the ``aa_access`` cookie,
then loads the user record from legacy storage. Used by all authenticated API routes.
"""

from __future__ import annotations

from fastapi import Cookie, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.security import decode_token
from app.legacy.storage import get_legacy_storage_module
from app.services.storage_db import call_storage
from app.services.storage_http import raise_storage_http

_bearer = HTTPBearer(auto_error=False)


def account_is_inactive(user: dict) -> bool:
    status = (user.get("account_status") or "active").strip().lower()
    return status in {"deleted", "deactivated"} or bool(user.get("is_deleted")) or bool(user.get("is_deactivated"))


def account_requires_email_verification(user: dict) -> bool:
    status = (user.get("account_status") or "active").strip().lower()
    return status == "pending"


def _email_verification_detail() -> dict:
    return {
        "code": "email_verification_required",
        "message": "Verify your email address before signing in or using Riviso features.",
    }


async def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    aa_access: str | None = Cookie(default=None),
) -> dict:
    token = None
    if creds and creds.credentials:
        token = creds.credentials
    elif aa_access:
        token = aa_access
    if not token:
        raise HTTPException(status_code=401, detail="Missing bearer token")
    try:
        payload = decode_token(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    if (payload.get("type") or "") != "access":
        raise HTTPException(status_code=401, detail="Invalid token type")
    user_id = (payload.get("sub") or "").strip()
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token subject")
    st = get_legacy_storage_module()
    try:
        user = call_storage(st.get_user_by_id, user_id)
    except HTTPException:
        raise
    except Exception as e:
        raise_storage_http(e)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    if account_is_inactive(user):
        raise HTTPException(status_code=401, detail="Account is deactivated or deleted")
    if account_requires_email_verification(user):
        raise HTTPException(status_code=403, detail=_email_verification_detail())
    return user


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if (user.get("role") or "").strip().lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return user
