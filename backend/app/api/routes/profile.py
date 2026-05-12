from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response

from app.core.deps import get_current_user
from app.core.config import settings
from app.legacy.storage import get_legacy_storage_module
from app.schemas.profile import ProfilePublic, ProfileUpdate
from app.services.user_timezone import normalize_user_timezone

router = APIRouter(prefix="/profile", tags=["profile"])


def _to_public(u: dict) -> ProfilePublic:
    tz_raw = (u.get("timezone") or "").strip()
    tz_norm = normalize_user_timezone(tz_raw) if tz_raw else None
    return ProfilePublic(
        id=(u.get("id") or "").strip(),
        email=(u.get("email") or "").strip(),
        full_name=((u.get("full_name") or "").strip() or None),
        phone=((u.get("phone") or "").strip() or None),
        timezone=(tz_norm or None),
        subscription_type=((u.get("subscription_type") or "").strip() or None),
        account_status=((u.get("account_status") or "active").strip().lower() or "active"),
        created_at=((u.get("created_at") or "").strip() or None),
    )


@router.get("/me", response_model=ProfilePublic)
async def me(user: dict = Depends(get_current_user)) -> ProfilePublic:
    return _to_public(user)


@router.patch("/me", response_model=ProfilePublic)
async def update_me(payload: ProfileUpdate, user: dict = Depends(get_current_user)) -> ProfilePublic:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    updates = payload.model_dump(exclude_unset=True)
    if "timezone" in updates and isinstance(updates.get("timezone"), str):
        updates["timezone"] = normalize_user_timezone(updates["timezone"])
    st.update_user_fields(uid, updates)
    fresh = st.get_user_by_id(uid) or user
    return _to_public(fresh)


@router.post("/me/deactivate", status_code=204)
async def deactivate_me(response: Response, user: dict = Depends(get_current_user)) -> Response:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    ok = st.deactivate_user(uid) if hasattr(st, "deactivate_user") else st.update_user_fields(uid, {"account_status": "deactivated", "is_deactivated": True})
    if not ok:
        raise HTTPException(status_code=404, detail="User not found")
    response.delete_cookie("aa_access", path="/", domain=settings.cookie_domain)
    response.delete_cookie("aa_refresh", path="/", domain=settings.cookie_domain)
    response.status_code = 204
    return response


@router.delete("/me", status_code=204)
async def delete_me(response: Response, user: dict = Depends(get_current_user)) -> Response:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    ok = st.delete_user(uid)
    if not ok:
        raise HTTPException(status_code=404, detail="User not found")
    response.delete_cookie("aa_access", path="/", domain=settings.cookie_domain)
    response.delete_cookie("aa_refresh", path="/", domain=settings.cookie_domain)
    response.status_code = 204
    return response

