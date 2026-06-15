from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from app.core.deps import get_current_user
from app.core.ids import user_ids_equal
from app.legacy.storage import get_legacy_storage_module
from app.schemas.content_brief import PromptTemplateOptions
from app.schemas.prompts import PromptCreate, PromptItem, PromptListResponse, PromptUpdate, SetDefaultRequest
from app.services.ai.prompt_template_builder import compile_prompt_template
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

# Legacy name used to detect and migrate old default prompts.
_LEGACY_WRITING_PROMPT_NAME = "Default writing prompt"

_DEFAULT_WRITING_PROMPT_NAME = "SEO & AI Optimized — Default"
_DEFAULT_WRITING_PROMPT_TEXT = (
    "You are a senior SEO strategist, content researcher, topical authority expert, "
    "E-E-A-T evaluator, Answer Engine Optimization specialist, and Generative Engine "
    "Optimization expert.\n\n"
    "Your objective is to create a comprehensive, authoritative, search-intent-driven "
    "article capable of ranking in Google Search, appearing in Google AI Overviews, and "
    "being cited by AI systems such as ChatGPT, Gemini, Perplexity, and Copilot.\n\n"
    "PRE-WRITING ANALYSIS (INTERNAL — reason through this silently, do not output this section)\n"
    "Before writing, identify: primary search intent (Informational / Commercial / Transactional / "
    "Navigational), target audience, core problem, desired outcome, common misconceptions, "
    "related entities and concepts, and frequently asked questions. Build the article around "
    "complete topic coverage rather than keyword repetition.\n\n"
    "ARTICLE CONTEXT\n"
    "- Article title: {article_title}\n"
    "- Focus keyphrase: {focus_keyphrase}\n"
    "- Target keywords: {targeting_keywords}\n\n"
    "CONTENT GOAL\n"
    "Create a genuinely useful resource that completely satisfies user intent and demonstrates "
    "expertise. Prioritise: search intent satisfaction, E-E-A-T, topical authority, semantic SEO, "
    "entity SEO, AEO, GEO, readability, and information gain.\n\n"
    "WORD COUNT\n"
    "Minimum 2,800 words. Target range:\n"
    "- Standard topics: 2,800–3,500 words\n"
    "- Competitive topics: 3,500–4,500 words\n"
    "- Pillar topics: 4,500–6,000 words\n"
    "Do not add filler — every section must contribute unique value.\n\n"
    "ARTICLE STRUCTURE\n\n"
    "Write in the following order:\n\n"
    "INTRODUCTION (3–4 paragraphs)\n"
    "- Immediately identify the user's problem or the situation the reader is in.\n"
    "- Explain why the topic matters.\n"
    "- Establish relevance and credibility.\n"
    "- Naturally include the focus keyphrase within the first 100 words.\n\n"
    "QUICK ANSWER (50–100 words)\n"
    "Provide a concise, direct answer to the primary search query immediately after the introduction. "
    "Optimised for featured snippets, Google AI Overviews, Perplexity summaries, and voice search. "
    "Use a clear callout or bold label.\n\n"
    "MAIN CONTENT (5–8 H2 sections)\n"
    "Each H2 must:\n"
    "- Cover a distinct aspect of the topic.\n"
    "- Begin with a direct answer paragraph of 40–80 words (required for AEO and AI Overview eligibility).\n"
    "- Contain at least 400–600 words.\n"
    "- Include original insights, examples, and practical applications.\n"
    "- Include specific details: named processes, comparisons, real data points — not vague generalities.\n"
    "- Use H3 sub-headings whenever multiple sub-topics exist within the section.\n\n"
    "Where relevant, include dedicated sections covering:\n"
    "- What It Is: definition, explanation, and context.\n"
    "- Why It Matters: benefits, impact, and significance.\n"
    "- How It Works: process, methodology, or framework.\n"
    "- Examples: practical scenarios and use cases.\n"
    "- Common Mistakes: frequent errors and misconceptions.\n"
    "- Best Practices: expert recommendations and proven approaches.\n"
    "- Trends and Future Outlook: recent developments and emerging considerations.\n\n"
    "ENTITY SEO\n"
    "Identify and naturally incorporate related entities, industry terminology, concepts, tools, "
    "frameworks, and standards. Use semantic relevance — not keyword stuffing.\n\n"
    "INFORMATION GAIN\n"
    "Every major section must contain specific examples, real-world scenarios, comparisons, "
    "practical recommendations, and industry insights. Avoid generic statements.\n\n"
    "GEO OPTIMIZATION\n"
    "Use definitions, lists, tables, step-by-step explanations, summary boxes, and comparison "
    "sections. Write clear, citation-friendly statements so AI systems can easily extract and "
    "cite information.\n\n"
    "E-E-A-T REQUIREMENTS\n"
    "Demonstrate:\n"
    "- Experience: practical examples, real-world applications, common implementation challenges.\n"
    "- Expertise: accurate explanations, industry-specific knowledge, advanced insights.\n"
    "- Authoritativeness: reference established standards, accepted frameworks, recognised methodologies.\n"
    "- Trustworthiness: balanced viewpoints, limitations, risks, and honest considerations.\n\n"
    "FORMATTING\n"
    "- Use H2 and H3 headings throughout.\n"
    "- Use bullet lists and numbered lists.\n"
    "- Use comparison tables where relevant.\n"
    "- Use callout summaries and step-by-step explanations.\n"
    "- Never create large blocks of unbroken text.\n"
    "- Paragraphs: maximum 3–4 sentences.\n"
    "- Active voice preferred.\n"
    "- Explain technical terms on first use.\n"
    "- Use **bold** for 2–4 key terms, statistics, or critical phrases per article.\n\n"
    "SEO REQUIREMENTS\n"
    "- Focus keyphrase in the introduction within the first 100 words.\n"
    "- Focus keyphrase in at least one H2 heading.\n"
    "- Focus keyphrase in the conclusion.\n"
    "- Natural keyword placement only — no stuffing.\n"
    "- Use semantic keyword variations throughout.\n"
    "- Cover related entities comprehensively.\n\n"
    "FAQ SECTION (10–15 questions, MANDATORY)\n"
    "Based on real search intent. Include:\n"
    "- Informational questions (what is, how does, why)\n"
    "- Comparison questions (X vs Y, which is better)\n"
    "- Implementation questions (how to, step-by-step)\n"
    "- Beginner questions (common starting points and misconceptions)\n"
    "- Cost or pricing questions where relevant\n"
    "Each answer: 50–120 words, direct, specific, and optimised for AI extraction and featured snippets.\n\n"
    "KEY TAKEAWAYS\n"
    "8–10 bullet points summarising the most important insights from the article.\n\n"
    "CONCLUSION (2–3 paragraphs)\n"
    "Summarise the key insights and reinforce the main takeaway. No promotional language. "
    "No aggressive calls-to-action."
)


def _ensure_default_prompt(*, st, project_id: str, proj: dict) -> dict:
    prompts = [p for p in (proj.get("prompts") or []) if isinstance(p, dict)]
    default_id = (proj.get("default_prompt_id") or "").strip()

    # Migrate any prompt still using the legacy default name to the new version.
    migrated = False
    for p in prompts:
        if isinstance(p, dict) and (p.get("name") or "").strip() == _LEGACY_WRITING_PROMPT_NAME:
            p["name"] = _DEFAULT_WRITING_PROMPT_NAME
            p["text"] = _DEFAULT_WRITING_PROMPT_TEXT
            migrated = True
    if migrated:
        try:
            st.update_project_fields(project_id, {"prompts": prompts})
        except Exception:
            pass
        proj["prompts"] = prompts

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


def migrate_all_default_prompts(st) -> int:
    """Replace legacy default prompt text across all projects. Returns count of projects updated."""
    try:
        projects = st.load_projects() or []
    except Exception:
        return 0
    count = 0
    for proj in projects:
        if not isinstance(proj, dict):
            continue
        project_id = (proj.get("id") or "").strip()
        if not project_id:
            continue
        prompts = [p for p in (proj.get("prompts") or []) if isinstance(p, dict)]
        updated = False
        for p in prompts:
            if isinstance(p, dict) and (p.get("name") or "").strip() == _LEGACY_WRITING_PROMPT_NAME:
                p["name"] = _DEFAULT_WRITING_PROMPT_NAME
                p["text"] = _DEFAULT_WRITING_PROMPT_TEXT
                updated = True
        if updated:
            try:
                st.update_project_fields(project_id, {"prompts": prompts})
                count += 1
            except Exception:
                pass
    return count


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


class _CompileTemplateResponse(BaseModel):
    text: str


@router.post("/prompts/compile-template", response_model=_CompileTemplateResponse)
async def compile_writing_prompt_template(
    project_id: str,
    payload: PromptTemplateOptions,
    user: dict = Depends(get_current_user),
) -> _CompileTemplateResponse:
    """Compile guided option selections into a reusable prompt text blob."""
    st = get_legacy_storage_module()
    _require_project_access(st=st, user=user, project_id=project_id)
    return _CompileTemplateResponse(text=compile_prompt_template(payload))


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

