from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response

from app.core.deps import get_current_user
from app.core.project_lookup import require_project_access
from app.legacy.storage import get_legacy_storage_module
from app.schemas.prompts import PromptCreate, PromptItem, PromptListResponse, PromptUpdate, SetDefaultRequest
from app.services.prompt_validation import validate_image_prompt

router = APIRouter(prefix="/projects/{project_id}", tags=["image-prompts"])


def _plan_limit(plan: dict, field: str) -> int | None:
    try:
        raw = int(plan.get(field) or 0)
    except (TypeError, ValueError):
        raw = 0
    return raw if raw > 0 else None


def _plan_for(user: dict, st) -> tuple[dict, str, str]:
    role = (user.get("role") or "").strip().lower()
    plan_key = ((user.get("subscription_type") or "").strip().lower() or "beta")
    try:
        plans = st.load_plans() or {}
        plan = plans.get(plan_key) if isinstance(plans, dict) else {}
        if not isinstance(plan, dict):
            plan = {}
    except Exception:
        plan = {}
    return plan, plan_key, role


def _enforce_image_prompt_limits(*, plan: dict, plan_key: str, role: str, proj: dict, text: str, is_create: bool) -> None:
    if role == "admin":
        return
    char_limit = _plan_limit(plan, "image_prompt_char_limit")
    if char_limit is not None and len(text) > char_limit:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Image prompt is too long for your {plan_key} plan. "
                f"Maximum allowed is {char_limit} characters (currently {len(text)})."
            ),
        )
    if is_create:
        count_limit = _plan_limit(plan, "max_image_prompts")
        if count_limit is not None:
            current = len([p for p in (proj.get("image_prompts") or []) if isinstance(p, dict)])
            if current >= count_limit:
                raise HTTPException(
                    status_code=403,
                    detail=(
                        f"Image prompt limit reached for your {plan_key} plan "
                        f"({count_limit}). Delete an existing prompt or upgrade your plan to add more."
                    ),
                )

_DEFAULT_IMAGE_PROMPT_NAME = "Default image prompt"
_DEFAULT_IMAGE_PROMPT_TEXT = (
    "Create a realistic, professional featured image that matches the article topic.\n"
    "No text, no watermarks, clean composition, editorial lighting, sharp focus.\n"
)


def _ensure_default_image_prompt(*, st, project_id: str, proj: dict) -> dict:
    prompts = [p for p in (proj.get("image_prompts") or []) if isinstance(p, dict)]
    default_id = (proj.get("default_image_prompt_id") or "").strip()
    if prompts and default_id:
        return proj
    if prompts and not default_id:
        st.update_project_fields(project_id, {"default_image_prompt_id": (prompts[0].get("id") or "").strip()})
        proj["default_image_prompt_id"] = (prompts[0].get("id") or "").strip()
        return proj
    pid = str(uuid.uuid4())
    row = {"id": pid, "name": _DEFAULT_IMAGE_PROMPT_NAME, "text": _DEFAULT_IMAGE_PROMPT_TEXT}
    st.update_project_fields(project_id, {"image_prompts": [row], "default_image_prompt_id": pid})
    proj["image_prompts"] = [row]
    proj["default_image_prompt_id"] = pid
    return proj


def _require_project_access(*, st, user: dict, project_id: str) -> dict:
    # Image prompts are a content operation — active project collaborators may manage them.
    # full=True: callers read/mutate proj["image_prompts"] / proj["default_image_prompt_id"],
    # which are not present in the lightweight access-row projection.
    return require_project_access(st=st, user=user, project_id=project_id, full=True, allow_collaborators=True)


def _coerce_prompt_item(x: dict) -> PromptItem | None:
    if not isinstance(x, dict):
        return None
    pid = (x.get("id") or "").strip()
    name = (x.get("name") or "").strip()
    text = (x.get("text") or "").strip()
    if not pid or not name:
        return None
    return PromptItem(id=pid, name=name[:200], text=text[:100_000])


@router.get("/image-prompts", response_model=PromptListResponse)
async def list_image_prompts(project_id: str, user: dict = Depends(get_current_user)) -> PromptListResponse:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    try:
        proj = _ensure_default_image_prompt(st=st, project_id=project_id, proj=proj)
    except Exception:
        pass
    items = []
    for p in proj.get("image_prompts") or []:
        it = _coerce_prompt_item(p) if isinstance(p, dict) else None
        if it:
            items.append(it)
    default_id = (proj.get("default_image_prompt_id") or "").strip() or None
    return PromptListResponse(items=items, default_id=default_id)


@router.post("/image-prompts", response_model=PromptItem, status_code=201)
async def create_image_prompt(project_id: str, payload: PromptCreate, user: dict = Depends(get_current_user)) -> PromptItem:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    plan, plan_key, role = _plan_for(user, st)
    text = payload.text.strip()[:100_000]
    _enforce_image_prompt_limits(plan=plan, plan_key=plan_key, role=role, proj=proj, text=text, is_create=True)
    validate_image_prompt(text)
    prompts = [p for p in (proj.get("image_prompts") or []) if isinstance(p, dict)]
    pid = str(uuid.uuid4())
    row = {"id": pid, "name": payload.name.strip()[:200], "text": text}
    prompts.append(row)
    updates = {"image_prompts": prompts}
    if not (proj.get("default_image_prompt_id") or "").strip():
        updates["default_image_prompt_id"] = pid
    st.update_project_fields(project_id, updates)
    return PromptItem(**row)


@router.patch("/image-prompts/{prompt_id}", response_model=PromptItem)
async def update_image_prompt(
    project_id: str,
    prompt_id: str,
    payload: PromptUpdate,
    user: dict = Depends(get_current_user),
) -> PromptItem:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    plan, plan_key, role = _plan_for(user, st)
    pid = (prompt_id or "").strip()
    prompts = [p for p in (proj.get("image_prompts") or []) if isinstance(p, dict)]
    if payload.text is not None:
        text = payload.text.strip()[:100_000]
        _enforce_image_prompt_limits(plan=plan, plan_key=plan_key, role=role, proj=proj, text=text, is_create=False)
        validate_image_prompt(text)
    found = None
    for p in prompts:
        if (p.get("id") or "").strip() == pid:
            if payload.name is not None:
                p["name"] = payload.name.strip()[:200]
            if payload.text is not None:
                p["text"] = text
            found = p
            break
    if not found:
        raise HTTPException(status_code=404, detail="Image prompt not found")
    st.update_project_fields(project_id, {"image_prompts": prompts})
    return PromptItem(id=(found.get("id") or "").strip(), name=(found.get("name") or "").strip(), text=(found.get("text") or "").strip())


@router.delete("/image-prompts/{prompt_id}")
async def delete_image_prompt(project_id: str, prompt_id: str, user: dict = Depends(get_current_user)) -> Response:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    pid = (prompt_id or "").strip()
    prompts = [p for p in (proj.get("image_prompts") or []) if isinstance(p, dict)]
    prompts2 = [p for p in prompts if (p.get("id") or "").strip() != pid]
    if len(prompts2) == len(prompts):
        return Response(status_code=204)
    updates = {"image_prompts": prompts2}
    if (proj.get("default_image_prompt_id") or "").strip() == pid:
        updates["default_image_prompt_id"] = ""
    st.update_project_fields(project_id, updates)
    return Response(status_code=204)


@router.post("/image-prompts/default", status_code=200)
async def set_default_image_prompt(project_id: str, payload: SetDefaultRequest, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    pid = (payload.id or "").strip()
    prompts = [p for p in (proj.get("image_prompts") or []) if isinstance(p, dict)]
    if not any((p.get("id") or "").strip() == pid for p in prompts):
        raise HTTPException(status_code=404, detail="Image prompt not found")
    st.update_project_fields(project_id, {"default_image_prompt_id": pid})
    return {"ok": True, "default_id": pid}

