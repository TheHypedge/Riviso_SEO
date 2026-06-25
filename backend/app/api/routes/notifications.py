"""
In-app notification routes.

Prefix: /api/notifications
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.core.deps import get_current_user
from app.legacy.storage import get_legacy_storage_module
from app.schemas.collaboration import NotificationCountResponse, NotificationPublic

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationPublic])
async def list_notifications(user: dict = Depends(get_current_user)) -> list[NotificationPublic]:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    records = st.get_notifications_for_user(uid, limit=50)
    return [
        NotificationPublic(
            id=r["id"],
            type=r.get("type") or "",
            title=r.get("title") or "",
            body=r.get("body") or "",
            data=r.get("data") or {},
            read=bool(r.get("read")),
            created_at=r.get("created_at") or "",
        )
        for r in records
    ]


@router.get("/count", response_model=NotificationCountResponse)
async def get_unread_count(user: dict = Depends(get_current_user)) -> NotificationCountResponse:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    count = st.get_unread_notification_count(uid)
    return NotificationCountResponse(count=count)


@router.patch("/{notification_id}/read", response_model=NotificationPublic)
async def mark_read(notification_id: str, user: dict = Depends(get_current_user)) -> NotificationPublic:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    ok = st.mark_notification_read(notification_id, uid)
    if not ok:
        raise HTTPException(status_code=404, detail="Notification not found")
    # Reload to return updated record
    records = st.get_notifications_for_user(uid, limit=100)
    for r in records:
        if r.get("id") == notification_id:
            return NotificationPublic(
                id=r["id"],
                type=r.get("type") or "",
                title=r.get("title") or "",
                body=r.get("body") or "",
                data=r.get("data") or {},
                read=bool(r.get("read")),
                created_at=r.get("created_at") or "",
            )
    raise HTTPException(status_code=404, detail="Notification not found")


@router.post("/read-all", response_model=NotificationCountResponse)
async def mark_all_read(user: dict = Depends(get_current_user)) -> NotificationCountResponse:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    count = st.mark_all_notifications_read(uid)
    return NotificationCountResponse(count=count)
