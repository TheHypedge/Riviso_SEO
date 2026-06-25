"""
User-scoped invitation routes — list, accept, decline.

Prefix: /api/invitations
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from app.core.deps import get_current_user
from app.legacy.storage import get_legacy_storage_module
from app.schemas.collaboration import InvitationPublic
from app.schemas.projects import ProjectPublic

router = APIRouter(prefix="/invitations", tags=["invitations"])


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _is_expired(inv: dict) -> bool:
    exp = (inv.get("expires_at") or "").strip()
    if not exp:
        return False
    try:
        expiry = datetime.fromisoformat(exp.replace("Z", "+00:00"))
        return datetime.now(timezone.utc) > expiry
    except Exception:
        return False


def _enrich_invitation(inv: dict) -> InvitationPublic:
    return InvitationPublic(
        id=inv["id"],
        project_id=inv["project_id"],
        project_name=inv.get("project_name") or "",
        project_website_url=inv.get("project_website_url") or None,
        invited_email=inv.get("invited_email") or "",
        invited_by_name=inv.get("invited_by_name") or "",
        role=inv.get("role") or "editor",
        status=inv.get("status") or "pending",
        created_at=inv.get("created_at") or "",
        expires_at=inv.get("expires_at") or "",
        responded_at=inv.get("responded_at") or None,
    )


def _to_project_public(proj: dict) -> ProjectPublic:
    return ProjectPublic(
        id=proj.get("id") or "",
        owner_user_id=proj.get("owner_user_id") or "",
        name=proj.get("name") or "",
        website_url=proj.get("website_url") or None,
        platform=proj.get("platform") or "wordpress",
    )


def _notify(st, *, user_id: str, type_: str, title: str, body: str, data: dict) -> None:
    try:
        st.insert_notification({
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "type": type_,
            "title": title,
            "body": body,
            "data": data,
            "read": False,
            "created_at": _utcnow_iso(),
        })
    except Exception:
        pass


def _log_activity(st, *, project_id: str, actor_user_id: str, actor_name: str, action: str, data: dict) -> None:
    try:
        st.insert_activity({
            "id": str(uuid.uuid4()),
            "project_id": project_id,
            "actor_user_id": actor_user_id,
            "actor_name": actor_name,
            "action": action,
            "data": data,
            "created_at": _utcnow_iso(),
        })
    except Exception:
        pass


# ---------------------------------------------------------------------------
# GET /api/invitations
# ---------------------------------------------------------------------------

@router.get("", response_model=list[InvitationPublic])
async def list_my_invitations(
    user: dict = Depends(get_current_user),
) -> list[InvitationPublic]:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    email = (user.get("email") or "").strip().lower()

    # Collect by user_id (existing user) + by email (in case id wasn't stamped)
    by_id = st.get_pending_invitations_for_user_id(uid) if uid else []
    by_email = st.get_pending_invitations_for_email(email) if email else []

    # Merge, deduplicate by id
    seen: set[str] = set()
    merged: list[dict] = []
    for inv in by_id + by_email:
        iid = inv.get("id") or ""
        if iid and iid not in seen:
            seen.add(iid)
            # Auto-expire
            if _is_expired(inv) and inv.get("status") == "pending":
                st.patch_invitation_fields(iid, {"status": "expired", "responded_at": _utcnow_iso()})
                continue
            merged.append(inv)

    return [_enrich_invitation(i) for i in merged]


# ---------------------------------------------------------------------------
# POST /api/invitations/{invite_id}/accept
# ---------------------------------------------------------------------------

@router.post("/{invite_id}/accept")
async def accept_invitation(
    invite_id: str,
    user: dict = Depends(get_current_user),
) -> dict:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    email = (user.get("email") or "").strip().lower()

    inv = st.get_invitation(invite_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invitation not found")
    if inv.get("status") != "pending":
        raise HTTPException(status_code=409, detail=f"Invitation is already {inv.get('status')}")
    if _is_expired(inv):
        st.patch_invitation_fields(invite_id, {"status": "expired", "responded_at": _utcnow_iso()})
        raise HTTPException(status_code=410, detail="Invitation has expired")

    # Verify this invitation belongs to the current user
    inv_email = (inv.get("invited_email") or "").strip().lower()
    inv_uid = (inv.get("invited_user_id") or "").strip()
    if inv_email != email and (not inv_uid or inv_uid != uid):
        raise HTTPException(status_code=403, detail="This invitation is not for your account")

    project_id = inv.get("project_id") or ""
    role = inv.get("role") or "editor"
    now = _utcnow_iso()

    # Check not already a collaborator
    existing = st.get_collaborator_for_user(project_id, uid)
    if existing:
        raise HTTPException(status_code=409, detail="You already have access to this project")

    # Insert collaborator record
    st.insert_collaborator({
        "id": str(uuid.uuid4()),
        "project_id": project_id,
        "user_id": uid,
        "role": role,
        "status": "active",
        "invited_at": inv.get("created_at") or now,
        "joined_at": now,
        "invited_by_user_id": inv.get("invited_by_user_id") or "",
    })

    # Mark invitation accepted
    st.patch_invitation_fields(invite_id, {"status": "accepted", "responded_at": now, "invited_user_id": uid})

    # Notify owner
    owner_uid = ""
    try:
        proj = st.get_project_access_row(project_id)
        if proj:
            owner_uid = (proj.get("owner_user_id") or "").strip()
    except Exception:
        pass

    acceptor_name = (user.get("full_name") or user.get("email") or "A user").strip()
    if owner_uid:
        _notify(st,
            user_id=owner_uid,
            type_="invitation_accepted",
            title=f"{acceptor_name} accepted your invitation",
            body=f"{acceptor_name} joined {inv.get('project_name') or 'your project'} as {role.capitalize()}",
            data={"project_id": project_id, "user_id": uid, "role": role},
        )

    _log_activity(st,
        project_id=project_id,
        actor_user_id=uid,
        actor_name=acceptor_name,
        action="invite_accepted",
        data={"role": role},
    )

    # Return the project so the frontend can redirect
    proj_data = st.get_project_listing_by_id(project_id) if hasattr(st, "get_project_listing_by_id") else None
    project_out = _to_project_public(proj_data) if proj_data else None

    return {
        "invitation": _enrich_invitation({**inv, "status": "accepted", "responded_at": now}),
        "project": project_out.model_dump() if project_out else None,
    }


# ---------------------------------------------------------------------------
# POST /api/invitations/{invite_id}/decline
# ---------------------------------------------------------------------------

@router.post("/{invite_id}/decline", status_code=204, response_class=Response)
async def decline_invitation(
    invite_id: str,
    user: dict = Depends(get_current_user),
) -> Response:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    email = (user.get("email") or "").strip().lower()

    inv = st.get_invitation(invite_id)
    if not inv:
        raise HTTPException(status_code=404, detail="Invitation not found")
    if inv.get("status") != "pending":
        raise HTTPException(status_code=409, detail=f"Invitation is already {inv.get('status')}")

    inv_email = (inv.get("invited_email") or "").strip().lower()
    inv_uid = (inv.get("invited_user_id") or "").strip()
    if inv_email != email and (not inv_uid or inv_uid != uid):
        raise HTTPException(status_code=403, detail="This invitation is not for your account")

    now = _utcnow_iso()
    st.patch_invitation_fields(invite_id, {"status": "declined", "responded_at": now})

    # Notify owner
    try:
        proj = st.get_project_access_row(inv.get("project_id") or "")
        if proj:
            owner_uid = (proj.get("owner_user_id") or "").strip()
            decliner = (user.get("full_name") or user.get("email") or "A user").strip()
            _notify(st,
                user_id=owner_uid,
                type_="invitation_declined",
                title=f"{decliner} declined your invitation",
                body=f"{decliner} declined the invitation to {inv.get('project_name') or 'your project'}",
                data={"project_id": inv.get("project_id") or ""},
            )
    except Exception:
        pass
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# GET /api/invitations/by-token/{token}  — email link lookup (no auth needed for preview)
# ---------------------------------------------------------------------------

@router.get("/by-token/{token}", response_model=InvitationPublic)
async def get_invitation_by_token(token: str) -> InvitationPublic:
    st = get_legacy_storage_module()
    inv = st.get_invitation_by_token(token.strip())
    if not inv:
        raise HTTPException(status_code=404, detail="Invitation not found")
    return _enrich_invitation(inv)
