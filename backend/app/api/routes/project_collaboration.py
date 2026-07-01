"""
Project collaboration routes — members, invitations, activity timeline.

Prefix: /api/projects/{project_id}/collaboration
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from app.core.deps import get_current_user
from app.core.ids import user_ids_equal
from app.legacy.storage import get_legacy_storage_module
from app.schemas.collaboration import (
    ActivityRecord,
    ChangeRoleRequest,
    CollaboratorPublic,
    InvitationPublic,
    InviteRequest,
    MembersResponse,
)

router = APIRouter(prefix="/projects/{project_id}/collaboration", tags=["collaboration"])

_ROLE_RANK = {"owner": 4, "admin": 3, "editor": 2, "viewer": 1}


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _expires_iso(days: int = 7) -> str:
    dt = datetime.now(timezone.utc) + timedelta(days=days)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _avatar_initials(name: str, email: str) -> str:
    n = (name or email or "").strip()
    parts = n.split()
    if len(parts) >= 2:
        return (parts[0][0] + parts[-1][0]).upper()
    return n[:2].upper() if n else "?"


def _enrich_collaborator(collab: dict, st) -> CollaboratorPublic:
    u = st.get_user_by_id(collab.get("user_id") or "")
    name = (u.get("full_name") or u.get("email") or "") if u else ""
    email = (u.get("email") or "") if u else ""
    return CollaboratorPublic(
        id=collab["id"],
        project_id=collab["project_id"],
        user_id=collab["user_id"],
        user_name=name,
        user_email=email,
        user_avatar_initials=_avatar_initials(name, email),
        role=collab.get("role") or "editor",
        status=collab.get("status") or "active",
        invited_at=collab.get("invited_at") or "",
        joined_at=collab.get("joined_at") or None,
    )


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


def _get_member_context_or_403(st, project_id: str, user_id: str) -> dict:
    ctx = st.get_project_member_context(project_id, user_id)
    if not ctx:
        raise HTTPException(status_code=404, detail="Project not found")
    if not ctx["has_access"]:
        raise HTTPException(status_code=403, detail="Access denied")
    return ctx


def _require_owner_or_admin(ctx: dict) -> None:
    role = ctx.get("role") or ""
    if _ROLE_RANK.get(role, 0) < _ROLE_RANK["admin"]:
        raise HTTPException(status_code=403, detail="Admin or owner access required")


def _require_owner(ctx: dict) -> None:
    if not ctx.get("is_owner"):
        raise HTTPException(status_code=403, detail="Owner access required")


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
# GET /members
# ---------------------------------------------------------------------------

@router.get("/members", response_model=MembersResponse)
async def list_members(
    project_id: str,
    user: dict = Depends(get_current_user),
) -> MembersResponse:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    ctx = _get_member_context_or_403(st, project_id, uid)
    _require_owner_or_admin(ctx)

    collaborators = st.get_project_collaborators(project_id)
    invitations = [
        inv for inv in st.get_project_invitations(project_id)
        if inv.get("status") == "pending"
    ]

    return MembersResponse(
        collaborators=[_enrich_collaborator(c, st) for c in collaborators],
        pending_invitations=[_enrich_invitation(i) for i in invitations],
    )


# ---------------------------------------------------------------------------
# POST /invite
# ---------------------------------------------------------------------------

@router.post("/invite", response_model=InvitationPublic, status_code=201)
async def invite_collaborator(
    project_id: str,
    payload: InviteRequest,
    user: dict = Depends(get_current_user),
) -> InvitationPublic:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    ctx = _get_member_context_or_403(st, project_id, uid)
    _require_owner(ctx)

    invited_email = (payload.email or "").strip().lower()
    if not invited_email:
        raise HTTPException(status_code=422, detail="Email is required")

    role = payload.role.value

    # Cannot invite self
    caller_email = (user.get("email") or "").strip().lower()
    if invited_email == caller_email:
        raise HTTPException(status_code=422, detail="You cannot invite yourself")

    # Load project details for display
    proj = st.get_project_access_row(project_id)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")

    # Cannot invite the project owner
    owner_user = st.get_user_by_id(ctx["owner_user_id"])
    owner_email = (owner_user.get("email") or "").strip().lower() if owner_user else ""
    if invited_email == owner_email:
        raise HTTPException(status_code=422, detail="The project owner already has full access")

    # Check for existing active collaborator
    invited_user = st.get_user_by_email(invited_email)
    if invited_user:
        existing = st.get_collaborator_for_user(project_id, invited_user.get("id") or "")
        if existing:
            raise HTTPException(status_code=409, detail="This user is already a collaborator")

    # Check for existing pending invitation
    existing_invites = [
        i for i in st.get_project_invitations(project_id)
        if i.get("invited_email") == invited_email and i.get("status") == "pending"
    ]
    if existing_invites:
        raise HTTPException(status_code=409, detail="A pending invitation already exists for this email")

    inviter_name = (user.get("full_name") or user.get("email") or "A teammate").strip()
    now = _utcnow_iso()
    invite_id = str(uuid.uuid4())
    token = str(uuid.uuid4())

    invitation = {
        "id": invite_id,
        "project_id": project_id,
        "project_name": proj.get("name") or "",
        "project_website_url": proj.get("website_url") or "",
        "invited_email": invited_email,
        "invited_user_id": (invited_user.get("id") or "") if invited_user else "",
        "invited_by_user_id": uid,
        "invited_by_name": inviter_name,
        "role": role,
        "status": "pending",
        "token": token,
        "created_at": now,
        "expires_at": _expires_iso(7),
        "responded_at": "",
    }
    st.insert_invitation(invitation)

    # In-app notification for existing user
    if invited_user:
        invited_uid = (invited_user.get("id") or "").strip()
        if invited_uid:
            _notify(st,
                user_id=invited_uid,
                type_="invitation_received",
                title=f"Project invitation: {proj.get('name') or 'a project'}",
                body=f"{inviter_name} invited you to collaborate as {role.capitalize()}",
                data={"project_id": project_id, "invitation_id": invite_id, "role": role},
            )

    # Email invitation
    try:
        from app.core.config import settings as _s
        frontend = (str(_s.frontend_base_url or "") or "https://riviso.cloud").rstrip("/")
    except Exception:
        import os
        frontend = (os.environ.get("FRONTEND_BASE_URL") or "https://riviso.cloud").rstrip("/")

    accept_url = f"{frontend}/invitations?token={token}"
    try:
        from app.services.email_dispatch import dispatch_invitation_email
        dispatch_invitation_email(
            to=invited_email,
            invited_by_name=inviter_name,
            project_name=proj.get("name") or "",
            project_website_url=proj.get("website_url") or "",
            role=role,
            accept_url=accept_url,
        )
    except Exception:
        pass

    _log_activity(st,
        project_id=project_id,
        actor_user_id=uid,
        actor_name=inviter_name,
        action="member_invited",
        data={"invited_email": invited_email, "role": role},
    )

    return _enrich_invitation(invitation)


# ---------------------------------------------------------------------------
# PATCH /members/{collab_id}/role
# ---------------------------------------------------------------------------

@router.patch("/members/{collab_id}/role", response_model=CollaboratorPublic)
async def change_collaborator_role(
    project_id: str,
    collab_id: str,
    payload: ChangeRoleRequest,
    user: dict = Depends(get_current_user),
) -> CollaboratorPublic:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    ctx = _get_member_context_or_403(st, project_id, uid)
    _require_owner(ctx)

    collab = st.get_collaborator(collab_id)
    if not collab or collab.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="Collaborator not found")

    new_role = payload.role.value
    st.patch_collaborator_fields(collab_id, {"role": new_role})

    collab["role"] = new_role

    actor_name = (user.get("full_name") or user.get("email") or "Owner").strip()
    _notify(st,
        user_id=collab["user_id"],
        type_="role_updated",
        title="Your project role has been updated",
        body=f"Your role in {ctx.get('project_name', 'the project')} was changed to {new_role.capitalize()}",
        data={"project_id": project_id, "new_role": new_role},
    )
    _log_activity(st,
        project_id=project_id,
        actor_user_id=uid,
        actor_name=actor_name,
        action="role_changed",
        data={"user_id": collab["user_id"], "new_role": new_role},
    )

    return _enrich_collaborator(collab, st)


# ---------------------------------------------------------------------------
# DELETE /members/{collab_id}
# ---------------------------------------------------------------------------

@router.delete("/members/{collab_id}", status_code=204, response_class=Response)
async def remove_collaborator(
    project_id: str,
    collab_id: str,
    user: dict = Depends(get_current_user),
) -> Response:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    ctx = _get_member_context_or_403(st, project_id, uid)
    _require_owner(ctx)

    collab = st.get_collaborator(collab_id)
    if not collab or collab.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="Collaborator not found")

    removed_user_id = collab.get("user_id") or ""
    st.delete_collaborator(collab_id)

    actor_name = (user.get("full_name") or user.get("email") or "Owner").strip()
    if removed_user_id:
        _notify(st,
            user_id=removed_user_id,
            type_="member_removed",
            title="Project access removed",
            body=f"Your access to the project has been removed by {actor_name}",
            data={"project_id": project_id},
        )
    _log_activity(st,
        project_id=project_id,
        actor_user_id=uid,
        actor_name=actor_name,
        action="member_removed",
        data={"removed_user_id": removed_user_id},
    )
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# POST /invitations/{invite_id}/resend
# ---------------------------------------------------------------------------

@router.post("/invitations/{invite_id}/resend", status_code=204, response_class=Response)
async def resend_invitation(
    project_id: str,
    invite_id: str,
    user: dict = Depends(get_current_user),
) -> Response:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    ctx = _get_member_context_or_403(st, project_id, uid)
    _require_owner(ctx)

    inv = st.get_invitation(invite_id)
    if not inv or inv.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="Invitation not found")
    if inv.get("status") != "pending":
        raise HTTPException(status_code=409, detail="Invitation is no longer pending")

    try:
        from app.core.config import settings as _s
        frontend = (str(_s.frontend_base_url or "") or "https://riviso.cloud").rstrip("/")
    except Exception:
        import os
        frontend = (os.environ.get("FRONTEND_BASE_URL") or "https://riviso.cloud").rstrip("/")

    accept_url = f"{frontend}/invitations?token={inv['token']}"
    try:
        from app.services.email_dispatch import dispatch_invitation_email
        dispatch_invitation_email(
            to=inv["invited_email"],
            invited_by_name=inv.get("invited_by_name") or "",
            project_name=inv.get("project_name") or "",
            project_website_url=inv.get("project_website_url") or "",
            role=inv.get("role") or "editor",
            accept_url=accept_url,
        )
    except Exception:
        pass
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# DELETE /invitations/{invite_id}  — cancel
# ---------------------------------------------------------------------------

@router.delete("/invitations/{invite_id}", status_code=204, response_class=Response)
async def cancel_invitation(
    project_id: str,
    invite_id: str,
    user: dict = Depends(get_current_user),
) -> Response:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    ctx = _get_member_context_or_403(st, project_id, uid)
    _require_owner(ctx)

    inv = st.get_invitation(invite_id)
    if not inv or inv.get("project_id") != project_id:
        raise HTTPException(status_code=404, detail="Invitation not found")
    if inv.get("status") != "pending":
        raise HTTPException(status_code=409, detail="Invitation is not pending")

    st.patch_invitation_fields(invite_id, {"status": "cancelled", "responded_at": _utcnow_iso()})

    # Notify invited user if they have an account
    invited_uid = (inv.get("invited_user_id") or "").strip()
    if invited_uid:
        _notify(st,
            user_id=invited_uid,
            type_="invitation_cancelled",
            title="Project invitation cancelled",
            body=f"The invitation to {inv.get('project_name') or 'a project'} has been cancelled",
            data={"project_id": project_id},
        )
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# GET /activity
# ---------------------------------------------------------------------------

@router.get("/activity", response_model=list[ActivityRecord])
async def get_activity(
    project_id: str,
    user: dict = Depends(get_current_user),
) -> list[ActivityRecord]:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    _get_member_context_or_403(st, project_id, uid)

    records = st.get_project_activity(project_id, limit=50)
    return [
        ActivityRecord(
            id=r["id"],
            actor_name=r.get("actor_name") or "",
            action=r.get("action") or "",
            data=r.get("data") or {},
            created_at=r.get("created_at") or "",
        )
        for r in records
    ]
