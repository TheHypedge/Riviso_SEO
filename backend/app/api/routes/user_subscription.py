from __future__ import annotations

from fastapi import APIRouter, Depends

from app.core.deps import get_current_user
from app.legacy.storage import get_legacy_storage_module
from app.schemas.subscription import SubscriptionStatusPublic
from app.services.plan_gatekeeper import build_subscription_status

router = APIRouter(prefix="/user", tags=["user"])


@router.get("/subscription-status", response_model=SubscriptionStatusPublic)
async def subscription_status(user: dict = Depends(get_current_user)) -> SubscriptionStatusPublic:
    st = get_legacy_storage_module()
    payload = build_subscription_status(st=st, user=user)
    return SubscriptionStatusPublic(**payload)
