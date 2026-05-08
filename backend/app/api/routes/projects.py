from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response

from app.core.deps import get_current_user
from app.core.ids import user_ids_equal
from app.legacy.storage import get_legacy_storage_module
from app.schemas.projects import ProjectCreate, ProjectPublic, ProjectUpdate

router = APIRouter(prefix="/projects", tags=["projects"])

_DEFAULT_WRITING_PROMPT_NAME = "Default writing prompt"
_DEFAULT_WRITING_PROMPT_TEXT = (
    "You are Riviso, an expert content writer.\n"
    "Write a clear, SEO-friendly article for the given title and keywords.\n"
    "- Use a compelling introduction\n"
    "- Use helpful headings (H2/H3)\n"
    "- Include practical details and examples where relevant\n"
    "- Keep tone professional, readable, and concise\n"
    "- Avoid fluff, repetition, and keyword stuffing\n"
    "- End with a short conclusion\n"
)

_DEFAULT_IMAGE_PROMPT_NAME = "Default image prompt"
_DEFAULT_IMAGE_PROMPT_TEXT = (
    "Create a realistic, professional featured image that matches the article topic.\n"
    "No text, no watermarks, clean composition, editorial lighting, sharp focus.\n"
)


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
        brand_identity=(p.get("brand_identity") or "").strip() or None,
        niche_identifier=(p.get("niche_identifier") or "").strip() or None,
    )


@router.get("", response_model=list[ProjectPublic])
async def list_projects(user: dict = Depends(get_current_user)) -> list[ProjectPublic]:
    st = get_legacy_storage_module()
    uid = (user.get("id") or "").strip()
    # Workspace project list is always scoped to the signed-in account (including admins).
    # Admins browse other accounts' projects via Manage users → workspace view.
    projects = st.load_projects(uid) or []
    out: list[ProjectPublic] = []
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
    role = (user.get("role") or "").strip().lower()

    # Enforce plan limits for regular users (admins are not limited).
    if role != "admin":
        plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
        plan = {}
        try:
            plans = st.load_plans() or {}
            plan = plans.get(plan_key) if isinstance(plans, dict) else {}
            if not isinstance(plan, dict):
                plan = {}
        except Exception:
            plan = {}
        max_projects = plan.get("max_projects")
        try:
            max_projects_i = int(max_projects) if max_projects is not None else None
        except Exception:
            max_projects_i = None
        if max_projects_i is not None and max_projects_i > 0 and hasattr(st, "project_ids_for_owner"):
            try:
                existing = st.project_ids_for_owner(uid) or []
            except Exception:
                existing = []
            if len(existing) >= max_projects_i:
                raise HTTPException(
                    status_code=403,
                    detail=f"Project limit reached for your plan (max {max_projects_i}). Upgrade your subscription to create more projects.",
                )
    pid = str(uuid.uuid4())
    default_writing_id = str(uuid.uuid4())
    default_image_id = str(uuid.uuid4())
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
            "prompts": [{"id": default_writing_id, "name": _DEFAULT_WRITING_PROMPT_NAME, "text": _DEFAULT_WRITING_PROMPT_TEXT}],
            "default_prompt_id": default_writing_id,
            "image_prompts": [{"id": default_image_id, "name": _DEFAULT_IMAGE_PROMPT_NAME, "text": _DEFAULT_IMAGE_PROMPT_TEXT}],
            "default_image_prompt_id": default_image_id,
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
    if payload.brand_identity is not None:
        updates["brand_identity"] = (payload.brand_identity or "").strip()[:20000]
    if payload.niche_identifier is not None:
        updates["niche_identifier"] = (payload.niche_identifier or "").strip()[:20000]

    if updates:
        st.update_project_fields(pid, updates)
    proj2 = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
    if not proj2:
        raise HTTPException(status_code=404, detail="Not found")
    return _to_public(proj2)


@router.get("/{project_id}/article-quota")
async def get_article_quota(project_id: str, user: dict = Depends(get_current_user)) -> dict:
    """
    Return the user's remaining article-generation slots so the UI can pre-flight
    bulk actions (e.g. Cluster Planner's "Generate selected") and surface a
    clean modal *before* the user fires a request that's doomed to a 403.

    Admins always show as unlimited. The route is per-project so it can also
    deny access for users who don't own the project (consistent with the rest
    of the API surface).
    """
    st = get_legacy_storage_module()
    pid = (project_id or "").strip()
    proj = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
    if not proj:
        raise HTTPException(status_code=404, detail="Not found")
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role != "admin" and not user_ids_equal(proj.get("owner_user_id"), uid):
        raise HTTPException(status_code=404, detail="Not found")

    plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
    plan: dict = {}
    try:
        plans = st.load_plans() or {}
        plan = plans.get(plan_key) if isinstance(plans, dict) else {}
        if not isinstance(plan, dict):
            plan = {}
    except Exception:
        plan = {}

    if role == "admin":
        return {
            "plan_key": plan_key,
            "is_admin": True,
            "unlimited": True,
            "max_can_consume_now": None,
            "day_used": 0,
            "day_limit": None,
            "day_remaining": None,
            "month_used": 0,
            "month_limit": None,
            "month_remaining": None,
        }

    if not hasattr(st, "peek_article_usage_remaining"):
        return {
            "plan_key": plan_key,
            "is_admin": False,
            "unlimited": True,
            "max_can_consume_now": None,
            "day_used": 0,
            "day_limit": None,
            "day_remaining": None,
            "month_used": 0,
            "month_limit": None,
            "month_remaining": None,
        }

    snap = st.peek_article_usage_remaining(
        uid,
        day_limit=plan.get("max_articles_per_day"),
        month_limit=plan.get("max_articles_per_month"),
    )
    return {
        "plan_key": plan_key,
        "is_admin": False,
        "unlimited": snap.get("max_can_consume_now") is None,
        **snap,
    }


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

