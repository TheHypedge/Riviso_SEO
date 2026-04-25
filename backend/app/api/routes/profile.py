from __future__ import annotations

from fastapi import APIRouter, Depends

from app.core.deps import get_current_user
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

