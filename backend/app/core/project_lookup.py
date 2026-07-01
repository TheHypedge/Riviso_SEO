"""Lightweight project access helpers for hot API read paths."""

from __future__ import annotations

from fastapi import HTTPException

from app.core.ids import user_ids_equal


async def async_require_project_access(
    *,
    user: dict,
    project_id: str,
    full: bool = False,
    allow_collaborators: bool = False,
) -> dict:
    """
    Async project access check — uses Motor (non-blocking) for the hot read.

    P2.3 / P4.8: replaces the direct sync `require_project_access` call in
    async route handlers so PyMongo never blocks the event loop on this path.
    Falls back to the sync helper if Motor is unavailable.

    ``allow_collaborators=True`` additionally grants access to an active
    project collaborator (any role) — use this for content operations.
    Administrative/settings/credential endpoints must keep the default
    (owner or global-admin only).
    """
    pid = (project_id or "").strip()
    if not pid:
        raise HTTPException(status_code=404, detail="Project not found")

    proj: dict | None = None
    if not full:
        try:
            from app.services.mongo_listings_async import fetch_project_access_row
            proj = await fetch_project_access_row(pid)
        except Exception:
            proj = None

    if proj is None:
        from app.legacy.storage import get_legacy_storage_module
        from app.services.storage_db import call_storage
        from app.services.to_thread import run_sync
        st = get_legacy_storage_module()
        try:
            if full and hasattr(st, "get_project_by_id"):
                # call_storage gives retry-on-stale-connection behaviour; crucial
                # when the caller needs a full project doc (wp credentials, prompts).
                proj = await run_sync(call_storage, st.get_project_by_id, pid)
            elif hasattr(st, "get_project_access_row"):
                proj = await run_sync(call_storage, st.get_project_access_row, pid)
            elif hasattr(st, "get_project_by_id"):
                proj = await run_sync(call_storage, st.get_project_by_id, pid)
        except Exception:
            proj = None

    if not isinstance(proj, dict):
        raise HTTPException(status_code=404, detail="Project not found")

    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role == "admin" or user_ids_equal(proj.get("owner_user_id"), uid):
        return proj
    if allow_collaborators:
        from app.legacy.storage import get_legacy_storage_module
        from app.services.storage_db import call_storage
        from app.services.to_thread import run_sync
        st = get_legacy_storage_module()
        if hasattr(st, "get_collaborator_for_user"):
            try:
                collab = await run_sync(call_storage, st.get_collaborator_for_user, pid, uid)
            except Exception:
                collab = None
            if isinstance(collab, dict):
                return proj
    raise HTTPException(status_code=404, detail="Project not found")


def require_project_access(
    *,
    st,
    user: dict,
    project_id: str,
    full: bool = False,
    allow_collaborators: bool = False,
) -> dict:
    """
    Resolve a project the caller may access.

    ``full=False`` (default for listings/auth) avoids loading ``shopify_catalog``,
    prompt arrays, and credential blobs. Use ``full=True`` for generation/settings writes.

    ``allow_collaborators=True`` additionally grants access to an active
    project collaborator (any role) — use this for content operations.
    Administrative/settings/credential endpoints must keep the default
    (owner or global-admin only).
    """
    pid = (project_id or "").strip()
    if not pid:
        raise HTTPException(status_code=404, detail="Project not found")

    proj = None
    if full:
        if hasattr(st, "get_project_by_id"):
            proj = st.get_project_by_id(pid)
    else:
        if hasattr(st, "get_project_access_row"):
            proj = st.get_project_access_row(pid)
        elif hasattr(st, "get_project_listing_by_id"):
            proj = st.get_project_listing_by_id(pid)
        elif hasattr(st, "get_project_by_id"):
            proj = st.get_project_by_id(pid)

    if not proj and not full and hasattr(st, "get_project_by_id"):
        proj = st.get_project_by_id(pid)
    if not proj:
        proj = next(
            (p for p in (st.load_projects_listing((user.get("id") or "").strip()) if hasattr(st, "load_projects_listing") else st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid),
            None,
        )
    if not isinstance(proj, dict):
        raise HTTPException(status_code=404, detail="Project not found")

    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role == "admin" or user_ids_equal(proj.get("owner_user_id"), uid):
        return proj
    if allow_collaborators and hasattr(st, "get_collaborator_for_user"):
        from app.services.storage_db import call_storage
        collab = call_storage(st.get_collaborator_for_user, pid, uid)
        if isinstance(collab, dict):
            return proj
    raise HTTPException(status_code=404, detail="Project not found")
