from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response

from app.core.deps import get_current_user
from app.core.ids import user_ids_equal
from app.legacy.storage import get_legacy_storage_module
from app.schemas.prompts import PromptCreate, PromptItem, PromptListResponse, PromptUpdate, SetDefaultRequest
from app.services.prompt_validation import validate_writing_prompt

router = APIRouter(prefix="/projects/{project_id}", tags=["prompts"])


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


def _enforce_writing_prompt_limits(*, st, user: dict, plan: dict, plan_key: str, role: str, proj: dict, text: str, is_create: bool) -> None:
    if role == "admin":
        return
    char_limit = _plan_limit(plan, "writing_prompt_char_limit")
    if char_limit is not None and len(text) > char_limit:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Writing prompt is too long for your {plan_key} plan. "
                f"Maximum allowed is {char_limit} characters (currently {len(text)})."
            ),
        )
    if is_create:
        count_limit = _plan_limit(plan, "max_writing_prompts")
        if count_limit is not None:
            current = len([p for p in (proj.get("prompts") or []) if isinstance(p, dict)])
            if current >= count_limit:
                raise HTTPException(
                    status_code=403,
                    detail=(
                        f"Writing prompt limit reached for your {plan_key} plan "
                        f"({count_limit}). Delete an existing prompt or upgrade your plan to add more."
                    ),
                )

_DEFAULT_WRITING_PROMPT_NAME = "Default writing prompt"
_DEFAULT_WRITING_PROMPT_TEXT = (
    "Write a well-structured, SEO-friendly article for the given title and keywords.\n\n"
    "REQUIRED structure:\n"
    "- Start with a compelling 2–3 sentence introduction that names the problem or situation directly\n"
    "- Divide the body into at least 3 main sections using ## H2 headings\n"
    "- Use ### H3 sub-headings inside any section with multiple sub-topics\n"
    "- Use bullet points (- item) for any list of 3 or more tips, features, steps, or options\n"
    "- Use numbered lists (1. 2. 3.) for any sequential process or step-by-step instructions\n"
    "- Use **bold** for key terms, statistics, or critical phrases (2–4 per article)\n"
    "- Keep paragraphs short: 2–4 sentences maximum\n"
    "- End with a short 2–3 sentence conclusion — no salesy CTA, no 'In conclusion' opener\n\n"
    "Tone: professional, readable, and specific — name real details rather than abstract statements.\n"
    "Avoid fluff, repetition, and keyword stuffing.\n"
)


def _ensure_default_prompt(*, st, project_id: str, proj: dict) -> dict:
    prompts = [p for p in (proj.get("prompts") or []) if isinstance(p, dict)]
    default_id = (proj.get("default_prompt_id") or "").strip()
    if prompts and default_id:
        return proj
    if prompts and not default_id:
        st.update_project_fields(project_id, {"default_prompt_id": (prompts[0].get("id") or "").strip()})
        proj["default_prompt_id"] = (prompts[0].get("id") or "").strip()
        return proj
    # Seed a default writing prompt for new/empty projects.
    pid = str(uuid.uuid4())
    row = {"id": pid, "name": _DEFAULT_WRITING_PROMPT_NAME, "text": _DEFAULT_WRITING_PROMPT_TEXT}
    st.update_project_fields(project_id, {"prompts": [row], "default_prompt_id": pid})
    proj["prompts"] = [row]
    proj["default_prompt_id"] = pid
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


@router.get("/prompts", response_model=PromptListResponse)
async def list_prompts(project_id: str, user: dict = Depends(get_current_user)) -> PromptListResponse:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    try:
        proj = _ensure_default_prompt(st=st, project_id=project_id, proj=proj)
    except Exception:
        pass
    items = []
    for p in proj.get("prompts") or []:
        it = _coerce_prompt_item(p) if isinstance(p, dict) else None
        if it:
            items.append(it)
    default_id = (proj.get("default_prompt_id") or "").strip() or None
    return PromptListResponse(items=items, default_id=default_id)


@router.post("/prompts", response_model=PromptItem, status_code=201)
async def create_prompt(project_id: str, payload: PromptCreate, user: dict = Depends(get_current_user)) -> PromptItem:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    plan, plan_key, role = _plan_for(user, st)
    text = payload.text.strip()[:100_000]
    _enforce_writing_prompt_limits(
        st=st, user=user, plan=plan, plan_key=plan_key, role=role, proj=proj, text=text, is_create=True,
    )
    validate_writing_prompt(text, user_id=(user.get("id") or "").strip() or None)
    prompts = [p for p in (proj.get("prompts") or []) if isinstance(p, dict)]
    pid = str(uuid.uuid4())
    row = {"id": pid, "name": payload.name.strip()[:200], "text": text}
    prompts.append(row)
    st.update_project_fields(project_id, {"prompts": prompts})
    return PromptItem(**row)


@router.patch("/prompts/{prompt_id}", response_model=PromptItem)
async def update_prompt(
    project_id: str,
    prompt_id: str,
    payload: PromptUpdate,
    user: dict = Depends(get_current_user),
) -> PromptItem:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    plan, plan_key, role = _plan_for(user, st)
    pid = (prompt_id or "").strip()
    prompts = [p for p in (proj.get("prompts") or []) if isinstance(p, dict)]
    if payload.text is not None:
        text = payload.text.strip()[:100_000]
        _enforce_writing_prompt_limits(
            st=st, user=user, plan=plan, plan_key=plan_key, role=role, proj=proj, text=text, is_create=False,
        )
        validate_writing_prompt(text, user_id=(user.get("id") or "").strip() or None)
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
        raise HTTPException(status_code=404, detail="Prompt not found")
    st.update_project_fields(project_id, {"prompts": prompts})
    return PromptItem(id=(found.get("id") or "").strip(), name=(found.get("name") or "").strip(), text=(found.get("text") or "").strip())


@router.delete("/prompts/{prompt_id}")
async def delete_prompt(project_id: str, prompt_id: str, user: dict = Depends(get_current_user)) -> Response:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    pid = (prompt_id or "").strip()
    prompts = [p for p in (proj.get("prompts") or []) if isinstance(p, dict)]
    prompts2 = [p for p in prompts if (p.get("id") or "").strip() != pid]
    if len(prompts2) == len(prompts):
        return Response(status_code=204)
    updates = {"prompts": prompts2}
    if (proj.get("default_prompt_id") or "").strip() == pid:
        updates["default_prompt_id"] = ""
    st.update_project_fields(project_id, updates)
    return Response(status_code=204)


@router.post("/prompts/default", status_code=200)
async def set_default_prompt(project_id: str, payload: SetDefaultRequest, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    proj = _require_project_access(st=st, user=user, project_id=project_id)
    pid = (payload.id or "").strip()
    prompts = [p for p in (proj.get("prompts") or []) if isinstance(p, dict)]
    if not any((p.get("id") or "").strip() == pid for p in prompts):
        raise HTTPException(status_code=404, detail="Prompt not found")
    st.update_project_fields(project_id, {"default_prompt_id": pid})
    return {"ok": True, "default_id": pid}

