"""
Content Brief CRUD routes — per-article structured configuration (19 sections)
and project-level brief templates.

Route shape mirrors prompts.py: project-scoped prefix, same auth/storage
patterns, same plan-based guard approach.

Endpoints:
  GET    /projects/{id}/articles/{article_id}/content-brief          → ContentBriefResponse
  PUT    /projects/{id}/articles/{article_id}/content-brief          → ContentBrief (commit)
  PATCH  /projects/{id}/articles/{article_id}/content-brief/draft    → draft autosave
  DELETE /projects/{id}/articles/{article_id}/content-brief          → clear brief + draft

  GET    /projects/{id}/brief-templates                               → ContentBriefTemplateListResponse
  POST   /projects/{id}/brief-templates                               → ContentBriefTemplate
  PATCH  /projects/{id}/brief-templates/{template_id}                → ContentBriefTemplate
  DELETE /projects/{id}/brief-templates/{template_id}                → 204
  POST   /projects/{id}/brief-templates/set-default                  → {"default_id": ...}
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import ValidationError

from app.core.deps import get_current_user
from app.core.ids import user_ids_equal
from app.legacy.storage import get_legacy_storage_module
from app.schemas.content_brief import (
    ContentBrief,
    ContentBriefDraft,
    ContentBriefResponse,
    ContentBriefTemplate,
    ContentBriefTemplateCreate,
    ContentBriefTemplateListResponse,
    ContentBriefTemplateUpdate,
    SetDefaultBriefTemplateRequest,
)

router = APIRouter(prefix="/projects/{project_id}", tags=["content-briefs"])


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _require_project_access(*, st, user: dict, project_id: str) -> dict:
    pid = (project_id or "").strip()
    proj = next(
        (p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid),
        None,
    )
    if proj is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    owner_id = (proj.get("user_id") or proj.get("owner_id") or "").strip()
    user_id = (user.get("id") or user.get("_id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role != "admin" and not user_ids_equal(owner_id, user_id):
        raise HTTPException(status_code=403, detail="Access denied.")
    return proj


def _require_article(*, st, project_id: str, article_id: str) -> dict:
    article = st.get_article(article_id)
    if not article or (article.get("project_id") or "") != project_id:
        raise HTTPException(status_code=404, detail="Article not found.")
    return article


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Per-article brief endpoints
# ---------------------------------------------------------------------------


@router.get("/articles/{article_id}/content-brief", response_model=ContentBriefResponse)
async def get_content_brief(
    project_id: str,
    article_id: str,
    user: dict = Depends(get_current_user),
    st=Depends(get_legacy_storage_module),
) -> ContentBriefResponse:
    _require_project_access(st=st, user=user, project_id=project_id)
    article = _require_article(st=st, project_id=project_id, article_id=article_id)

    brief_raw = article.get("content_brief")
    draft_raw = article.get("content_brief_draft")

    brief: ContentBrief | None = None
    if isinstance(brief_raw, dict):
        try:
            brief = ContentBrief.model_validate(brief_raw)
        except (ValidationError, Exception):
            brief = None

    draft: ContentBriefDraft | None = None
    if isinstance(draft_raw, dict):
        try:
            draft = ContentBriefDraft.model_validate(draft_raw)
        except (ValidationError, Exception):
            draft = None

    return ContentBriefResponse(brief=brief, draft=draft)


@router.put("/articles/{article_id}/content-brief", response_model=ContentBrief)
async def commit_content_brief(
    project_id: str,
    article_id: str,
    body: ContentBrief,
    user: dict = Depends(get_current_user),
    st=Depends(get_legacy_storage_module),
) -> ContentBrief:
    """Validate and commit a content brief — replaces any existing committed brief.
    Also clears the draft (the committed brief supersedes it).
    """
    _require_project_access(st=st, user=user, project_id=project_id)
    _require_article(st=st, project_id=project_id, article_id=article_id)

    st.patch_article_fields(
        article_id,
        {
            "content_brief": body.model_dump(),
            "content_brief_draft": None,
        },
    )
    return body


@router.patch("/articles/{article_id}/content-brief/draft")
async def autosave_draft(
    project_id: str,
    article_id: str,
    body: ContentBriefDraft,
    user: dict = Depends(get_current_user),
    st=Depends(get_legacy_storage_module),
) -> dict:
    """Debounced partial autosave — always uses $set semantics (patch_article_fields)
    so a mid-panel edit never clobbers the committed brief or older draft keys.
    """
    _require_project_access(st=st, user=user, project_id=project_id)
    _require_article(st=st, project_id=project_id, article_id=article_id)

    draft_data = body.model_dump()
    draft_data["saved_at"] = _now_iso()
    st.patch_article_fields(article_id, {"content_brief_draft": draft_data})
    return {"saved_at": draft_data["saved_at"]}


@router.delete("/articles/{article_id}/content-brief", status_code=204, response_class=Response)
async def delete_content_brief(
    project_id: str,
    article_id: str,
    user: dict = Depends(get_current_user),
    st=Depends(get_legacy_storage_module),
) -> Response:
    """Clear the committed brief and any in-progress draft."""
    _require_project_access(st=st, user=user, project_id=project_id)
    _require_article(st=st, project_id=project_id, article_id=article_id)

    st.patch_article_fields(
        article_id,
        {"content_brief": None, "content_brief_draft": None},
    )
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Brief template endpoints (project-level reusable presets)
# ---------------------------------------------------------------------------


@router.get("/brief-templates", response_model=ContentBriefTemplateListResponse)
async def list_brief_templates(
    project_id: str,
    user: dict = Depends(get_current_user),
    st=Depends(get_legacy_storage_module),
) -> ContentBriefTemplateListResponse:
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    raw_templates = [t for t in (proj.get("content_brief_templates") or []) if isinstance(t, dict)]
    items: list[ContentBriefTemplate] = []
    for t in raw_templates:
        try:
            items.append(ContentBriefTemplate.model_validate(t))
        except (ValidationError, Exception):
            continue
    default_id = (proj.get("default_content_brief_template_id") or "").strip() or None
    return ContentBriefTemplateListResponse(items=items, default_id=default_id)


@router.post("/brief-templates", response_model=ContentBriefTemplate, status_code=201)
async def create_brief_template(
    project_id: str,
    body: ContentBriefTemplateCreate,
    user: dict = Depends(get_current_user),
    st=Depends(get_legacy_storage_module),
) -> ContentBriefTemplate:
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    templates = [t for t in (proj.get("content_brief_templates") or []) if isinstance(t, dict)]

    new_id = str(uuid.uuid4())
    new_template = ContentBriefTemplate(id=new_id, name=body.name, brief=body.brief)
    templates.append(new_template.model_dump())
    st.update_project_fields(project_id, {"content_brief_templates": templates})
    return new_template


@router.patch("/brief-templates/{template_id}", response_model=ContentBriefTemplate)
async def update_brief_template(
    project_id: str,
    template_id: str,
    body: ContentBriefTemplateUpdate,
    user: dict = Depends(get_current_user),
    st=Depends(get_legacy_storage_module),
) -> ContentBriefTemplate:
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    templates = [t for t in (proj.get("content_brief_templates") or []) if isinstance(t, dict)]

    idx = next((i for i, t in enumerate(templates) if (t.get("id") or "") == template_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Template not found.")

    existing = ContentBriefTemplate.model_validate(templates[idx])
    updated = existing.model_copy(
        update={
            **({"name": body.name} if body.name is not None else {}),
            **({"brief": body.brief} if body.brief is not None else {}),
        }
    )
    templates[idx] = updated.model_dump()
    st.update_project_fields(project_id, {"content_brief_templates": templates})
    return updated


@router.delete("/brief-templates/{template_id}", status_code=204, response_class=Response)
async def delete_brief_template(
    project_id: str,
    template_id: str,
    user: dict = Depends(get_current_user),
    st=Depends(get_legacy_storage_module),
) -> Response:
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    templates = [t for t in (proj.get("content_brief_templates") or []) if isinstance(t, dict)]

    filtered = [t for t in templates if (t.get("id") or "") != template_id]
    if len(filtered) == len(templates):
        raise HTTPException(status_code=404, detail="Template not found.")

    updates: dict = {"content_brief_templates": filtered}
    if (proj.get("default_content_brief_template_id") or "") == template_id:
        updates["default_content_brief_template_id"] = ""
    st.update_project_fields(project_id, updates)
    return Response(status_code=204)


@router.post("/brief-templates/set-default")
async def set_default_brief_template(
    project_id: str,
    body: SetDefaultBriefTemplateRequest,
    user: dict = Depends(get_current_user),
    st=Depends(get_legacy_storage_module),
) -> dict:
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    templates = [t for t in (proj.get("content_brief_templates") or []) if isinstance(t, dict)]

    if not any((t.get("id") or "") == body.id for t in templates):
        raise HTTPException(status_code=404, detail="Template not found.")

    st.update_project_fields(project_id, {"default_content_brief_template_id": body.id})
    return {"default_id": body.id}
