"""Lightweight project access helpers for hot API read paths."""

from __future__ import annotations

from fastapi import HTTPException

from app.core.ids import user_ids_equal


def require_project_access(
    *,
    st,
    user: dict,
    project_id: str,
    full: bool = False,
) -> dict:
    """
    Resolve a project the caller may access.

    ``full=False`` (default for listings/auth) avoids loading ``shopify_catalog``,
    prompt arrays, and credential blobs. Use ``full=True`` for generation/settings writes.
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
    if role != "admin" and not user_ids_equal(proj.get("owner_user_id"), uid):
        raise HTTPException(status_code=404, detail="Project not found")
    return proj
