from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response

from app.core.deps import get_current_user
from app.core.ids import user_ids_equal
from app.legacy.storage import get_legacy_storage_module
from app.schemas.projects import ProjectCreate, ProjectPublic, ProjectUpdate

router = APIRouter(prefix="/projects", tags=["projects"])


def _normalize_url(raw: str | None) -> str:
    s = (raw or "").strip()
    if not s:
        return ""
    # Simple normalization (legacy app enforces stricter rules in app.py; we’ll port later).
    if not (s.startswith("http://") or s.startswith("https://")):
        s = "https://" + s
    return s[:2048]


def _to_public(p: dict) -> ProjectPublic:
    return ProjectPublic(
        id=(p.get("id") or "").strip(),
        owner_user_id=(p.get("owner_user_id") or "").strip(),
        name=(p.get("name") or "").strip(),
        website_url=(p.get("website_url") or "").strip() or None,
    )


@router.get("", response_model=list[ProjectPublic])
async def list_projects(user: dict = Depends(get_current_user)) -> list[ProjectPublic]:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    # Admins see every project (workspace / project management). Regular users only their own.
    if role == "admin":
        projects = st.load_projects(None) or []
        out = [_to_public(p) for p in projects if isinstance(p, dict)]
    else:
        projects = st.load_projects(uid) or []
        out = []
        for p in projects:
            if not isinstance(p, dict):
                continue
            owner = (p.get("owner_user_id") or "").strip()
            if not user_ids_equal(owner, uid):
                continue
            out.append(_to_public(p))
    out.sort(key=lambda x: (x.name.lower(), x.id))
    return out


@router.post("", response_model=ProjectPublic, status_code=201)
async def create_project(payload: ProjectCreate, user: dict = Depends(get_current_user)) -> ProjectPublic:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    pid = str(uuid.uuid4())
    url = _normalize_url(payload.website_url)
    st.insert_project(
        {
            "id": pid,
            "owner_user_id": uid,
            "name": payload.name.strip()[:200],
            "website_url": url,
            "wp_site_url": url,
            "wp_username": "",
            "wp_app_password": "",
            "wp_category_ids": "",
            "prompts": [],
            "default_prompt_id": "",
            "image_prompts": [],
            "default_image_prompt_id": "",
            "image_style": "semi_real",
            "optimize_image_prompt": True,
            "context_links": [],
            "gsc_property_url": "",
            "gsc_index_on_publish": True,
            "created_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        }
    )
    proj = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
    if not proj:
        raise HTTPException(status_code=500, detail="Project creation failed")
    return _to_public(proj)


@router.get("/{project_id}", response_model=ProjectPublic)
async def get_project(project_id: str, user: dict = Depends(get_current_user)) -> ProjectPublic:
    st = get_legacy_storage_module()
    pid = (project_id or "").strip()
    if not pid:
        raise HTTPException(status_code=404, detail="Not found")
    proj = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
    if not proj:
        raise HTTPException(status_code=404, detail="Not found")
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role != "admin" and not user_ids_equal(proj.get("owner_user_id"), uid):
        raise HTTPException(status_code=404, detail="Not found")
    return _to_public(proj)


@router.patch("/{project_id}", response_model=ProjectPublic)
async def update_project(project_id: str, payload: ProjectUpdate, user: dict = Depends(get_current_user)) -> ProjectPublic:
    st = get_legacy_storage_module()
    pid = (project_id or "").strip()
    proj = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
    if not proj:
        raise HTTPException(status_code=404, detail="Not found")
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role != "admin" and not user_ids_equal(proj.get("owner_user_id"), uid):
        raise HTTPException(status_code=404, detail="Not found")

    updates: dict = {}
    if payload.name is not None:
        updates["name"] = payload.name.strip()[:200]
    if payload.website_url is not None:
        url = _normalize_url(payload.website_url)
        updates["website_url"] = url
        updates.setdefault("wp_site_url", url)

    if updates:
        st.update_project_fields(pid, updates)
    proj2 = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
    if not proj2:
        raise HTTPException(status_code=404, detail="Not found")
    return _to_public(proj2)


@router.delete("/{project_id}")
async def delete_project(project_id: str, user: dict = Depends(get_current_user)) -> Response:
    st = get_legacy_storage_module()
    pid = (project_id or "").strip()
    proj = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
    if not proj:
        return Response(status_code=204)
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role != "admin" and not user_ids_equal(proj.get("owner_user_id"), uid):
        return Response(status_code=204)
    # Delete the project and all resources that reference it (articles, scheduled jobs, settings, prompts, etc.).
    if hasattr(st, "delete_project_and_resources"):
        st.delete_project_and_resources(pid)
    else:
        st.delete_project_and_articles(pid)
    return Response(status_code=204)

