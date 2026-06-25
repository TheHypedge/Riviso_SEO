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
    # L6.5: use purge_user_data (hard delete) so all owned projects, articles,
    # scheduled jobs, and the subscription are erased — not soft-retained.
    purge_fn = getattr(st, "purge_user_data", None)
    if purge_fn is not None:
        ok = purge_fn(uid)
    else:
        ok = st.delete_user(uid)
    if not ok:
        raise HTTPException(status_code=404, detail="User not found")
    response.delete_cookie("aa_access", path="/", domain=settings.cookie_domain)
    response.delete_cookie("aa_refresh", path="/", domain=settings.cookie_domain)
    response.status_code = 204
    return response



class _UserLookupResult(dict):
    pass


from pydantic import BaseModel as _BM

class UserLookupResponse(_BM):
    found: bool
    name: str | None = None


@router.get("/lookup-email", response_model=UserLookupResponse)
async def lookup_user_by_email(
    email: str,
    user: dict = Depends(get_current_user),
) -> UserLookupResponse:
    """
    Check if an email address belongs to a registered Riviso user.
    Returns {found: bool, name?: str}. Never exposes passwords or IDs.
    """
    st = get_legacy_storage_module()
    em = (email or "").strip().lower()
    if not em:
        return UserLookupResponse(found=False)
    target = st.get_user_by_email(em)
    if not target:
        return UserLookupResponse(found=False)
    # Don't expose the caller's own details back (redundant but safe)
    name = (target.get("full_name") or "").strip() or None
    return UserLookupResponse(found=True, name=name)
