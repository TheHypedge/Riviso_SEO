from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response

from app.core.deps import get_current_user
from app.core.ids import user_ids_equal
from app.legacy.storage import get_legacy_storage_module
from app.schemas.prompts import PromptCreate, PromptItem, PromptListResponse, PromptUpdate, SetDefaultRequest

router = APIRouter(prefix="/projects/{project_id}", tags=["image-prompts"])

_IMAGE_PROMPT_LOCKED_DETAIL = (
    "Featured images are generated automatically from each article's focus keyphrase "
    "and your project's brand niche. Custom image prompt text is not accepted."
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
    pid = (project_id or "").strip()
    proj = next((p for p in (st.load_projects() or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    uid = (user.get("id") or "").strip()
    role = (user.get("role") or "").strip().lower()
    if role != "admin" and not user_ids_equal(proj.get("owner_user_id"), uid):
        raise HTTPException(status_code=404, detail="Project not found")
    return proj


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
async def create_image_prompt(project_id: str, _payload: PromptCreate, user: dict = Depends(get_current_user)) -> PromptItem:
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    raise HTTPException(status_code=400, detail=_IMAGE_PROMPT_LOCKED_DETAIL)


@router.patch("/image-prompts/{prompt_id}", response_model=PromptItem)
async def update_image_prompt(
    project_id: str,
    prompt_id: str,
    payload: PromptUpdate,
    user: dict = Depends(get_current_user),
) -> PromptItem:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    pid = (prompt_id or "").strip()
    prompts = [p for p in (proj.get("image_prompts") or []) if isinstance(p, dict)]
    if payload.text is not None:
        raise HTTPException(status_code=400, detail=_IMAGE_PROMPT_LOCKED_DETAIL)
    found = None
    for p in prompts:
        if (p.get("id") or "").strip() == pid:
            if payload.name is not None:
                p["name"] = payload.name.strip()[:200]
            if payload.text is not None:
                p["text"] = payload.text.strip()[:100_000]
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

