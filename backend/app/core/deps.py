from __future__ import annotations

from fastapi import Cookie, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.security import decode_token
from app.legacy.storage import get_legacy_storage_module

_bearer = HTTPBearer(auto_error=False)


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
    user = st.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if (user.get("role") or "").strip().lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return user

