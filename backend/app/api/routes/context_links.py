from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from app.core.deps import get_current_user
from app.core.project_lookup import require_project_access
from app.legacy.storage import get_legacy_storage_module

router = APIRouter(prefix="/projects/{project_id}/context-links", tags=["context-links"])


class ContextLinkItem(BaseModel):
    id: str
    label: str = ""
    url: str


class ContextLinkCreate(BaseModel):
    label: str = Field(default="", max_length=200)
    url: str = Field(min_length=1, max_length=2048)


class ContextLinkUpdate(BaseModel):
    label: str | None = Field(default=None, max_length=200)
    url: str | None = Field(default=None, max_length=2048)


def _require_project_access(*, st, user: dict, project_id: str) -> dict:
    # Context links are a content operation — active project collaborators may manage them.
    # full=True: callers read proj["context_links"], not present in the lightweight
    # access-row projection.
    return require_project_access(st=st, user=user, project_id=project_id, full=True, allow_collaborators=True)


def _plan_for_user(*, st, user: dict) -> tuple[str, dict]:
    plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
    try:
        plans = st.load_plans() or {}
        plan = plans.get(plan_key) if isinstance(plans, dict) else {}
        if not isinstance(plan, dict):
            plan = {}
    except Exception:
        plan = {}
    return plan_key, plan


def _context_link_limit_for_plan(plan_key: str, plan: dict) -> int | None:
    raw = plan.get("max_context_links")
    if raw is None and plan_key == "beta":
        raw = 10
    try:
        val = int(raw or 0)
    except Exception:
        val = 0
    # Match the rest of plan semantics: 0/negative means unlimited.
    return val if val > 0 else None


def _coerce_links(raw) -> list[dict]:
    out: list[dict] = []
    for x in raw or []:
        if isinstance(x, dict) and (x.get("id") or "").strip() and (x.get("url") or "").strip():
            # Legacy keys: some older rows used "text"/"phrase" instead of "label".
            label = (
                (x.get("label") or "").strip()
                or (x.get("text") or "").strip()
                or (x.get("phrase") or "").strip()
            )
            out.append(
                {
                    "id": (x.get("id") or "").strip(),
                    "label": label[:200],
                    "url": (x.get("url") or "").strip()[:2048],
                }
            )
    return out


@router.get("", response_model=list[ContextLinkItem])
async def list_context_links(project_id: str, user: dict = Depends(get_current_user)) -> list[ContextLinkItem]:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    links = _coerce_links(proj.get("context_links") or [])
    return [ContextLinkItem(**x) for x in links]


@router.post("", response_model=ContextLinkItem, status_code=201)
async def create_context_link(project_id: str, payload: ContextLinkCreate, user: dict = Depends(get_current_user)) -> ContextLinkItem:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    links = _coerce_links(proj.get("context_links") or [])
    if (user.get("role") or "").strip().lower() != "admin":
        plan_key, plan = _plan_for_user(st=st, user=user)
        max_links = _context_link_limit_for_plan(plan_key, plan)
        if max_links is not None and len(links) >= max_links:
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "quota_exceeded",
                    "feature": "context_links",
                    "plan_key": plan_key,
                    "message": f"Context link limit reached for your plan (max {max_links}).",
                    "limit": max_links,
                    "used": len(links),
                    "remaining": 0,
                },
            )
    # id: simple deterministic-ish for now (safe)
    new_id = f"cl_{len(links)+1}_{abs(hash(payload.url))%10_000_000}"
    row = {"id": new_id, "label": payload.label.strip()[:200], "url": payload.url.strip()[:2048]}
    links.append(row)
    st.update_project_fields(project_id, {"context_links": links})
    return ContextLinkItem(**row)


@router.patch("/{link_id}", response_model=ContextLinkItem)
async def update_context_link(
    project_id: str,
    link_id: str,
    payload: ContextLinkUpdate,
    user: dict = Depends(get_current_user),
) -> ContextLinkItem:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    lid = (link_id or "").strip()
    links = _coerce_links(proj.get("context_links") or [])
    found = None
    for x in links:
        if (x.get("id") or "").strip() == lid:
            if payload.label is not None:
                x["label"] = payload.label.strip()[:200]
            if payload.url is not None:
                x["url"] = payload.url.strip()[:2048]
            found = x
            break
    if not found:
        raise HTTPException(status_code=404, detail="Context link not found")
    st.update_project_fields(project_id, {"context_links": links})
    return ContextLinkItem(**found)


@router.delete("/{link_id}")
async def delete_context_link(project_id: str, link_id: str, user: dict = Depends(get_current_user)) -> Response:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    lid = (link_id or "").strip()
    links = _coerce_links(proj.get("context_links") or [])
    links2 = [x for x in links if (x.get("id") or "").strip() != lid]
    if len(links2) == len(links):
        return Response(status_code=204)
    st.update_project_fields(project_id, {"context_links": links2})
    return Response(status_code=204)

