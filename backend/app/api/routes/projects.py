from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Response

from app.core.deps import get_current_user
from app.core.ids import user_ids_equal
from app.legacy.storage import get_legacy_storage_module
from app.schemas.projects import ProjectCreate, ProjectPublic, ProjectUpdate


# ISO-3166 alpha-2 → display name. Tiny lookup so the auto-derived
# ``niche_identifier`` text is human-readable ("United States" instead of
# "US"). The frontend ships the canonical list; we only need the codes
# people actually save, so we keep this short and fall back to the raw
# code when a country isn't in the map.
_COUNTRY_NAMES: dict[str, str] = {
    "AE": "United Arab Emirates",
    "AR": "Argentina",
    "AT": "Austria",
    "AU": "Australia",
    "BD": "Bangladesh",
    "BE": "Belgium",
    "BR": "Brazil",
    "CA": "Canada",
    "CH": "Switzerland",
    "CN": "China",
    "DE": "Germany",
    "DK": "Denmark",
    "EG": "Egypt",
    "ES": "Spain",
    "FR": "France",
    "GB": "United Kingdom",
    "GR": "Greece",
    "HK": "Hong Kong",
    "ID": "Indonesia",
    "IE": "Ireland",
    "IL": "Israel",
    "IN": "India",
    "IT": "Italy",
    "JP": "Japan",
    "KE": "Kenya",
    "KR": "South Korea",
    "LK": "Sri Lanka",
    "MX": "Mexico",
    "MY": "Malaysia",
    "NG": "Nigeria",
    "NL": "Netherlands",
    "NO": "Norway",
    "NP": "Nepal",
    "NZ": "New Zealand",
    "PH": "Philippines",
    "PK": "Pakistan",
    "PL": "Poland",
    "PT": "Portugal",
    "RU": "Russia",
    "SA": "Saudi Arabia",
    "SE": "Sweden",
    "SG": "Singapore",
    "TH": "Thailand",
    "TR": "Türkiye",
    "TW": "Taiwan",
    "UA": "Ukraine",
    "US": "United States",
    "VN": "Vietnam",
    "ZA": "South Africa",
}


def _country_display(code: str) -> str:
    c = (code or "").strip().upper()
    return _COUNTRY_NAMES.get(c, c)


def _derive_brand_identity_text(
    *, voice: str, tones: list[str], rules: str
) -> str:
    """Render the structured Brand identity inputs into the plain-text form
    consumed by the article generation prompt builder.

    The output mirrors how a human would describe themselves to a writer:

        Voice: Professional. Tones: direct, evidence-driven, no hype.
        Rules: We avoid buzzwords. ...

    Empty pieces are simply skipped so partial input is still useful.
    """
    parts: list[str] = []
    v = (voice or "").strip()
    if v:
        parts.append(f"Voice: {v[:80]}.")
    cleaned_tones = [str(t).strip() for t in (tones or []) if str(t).strip()][:10]
    if cleaned_tones:
        parts.append("Tones: " + ", ".join(cleaned_tones) + ".")
    r = (rules or "").strip()
    if r:
        parts.append("Rules: " + r[:4000])
    return " ".join(parts).strip()


def _derive_niche_text(
    *,
    topic: str,
    audience: list[str],
    countries: list[str],
    countries_all: bool,
    cities: list[str],
    cities_all: bool,
) -> str:
    """Render the structured Niche inputs into the plain-text form consumed
    by the article generation prompt builder. Same shape as the legacy
    free-text field so downstream consumers don't need to change.

    ``countries_all=True`` is the canonical "global targeting" sentinel —
    we render a single line ("all countries") instead of enumerating ~250
    ISO codes, which both keeps the project document small and reads more
    naturally to the LLM.
    """
    parts: list[str] = []
    t = (topic or "").strip()
    if t:
        parts.append(f"Niche: {t[:500]}.")
    aud = [str(a).strip() for a in (audience or []) if str(a).strip()][:30]
    if aud:
        parts.append("Audience: " + ", ".join(aud) + ".")
    if countries_all:
        parts.append("Target countries: all countries (global targeting).")
    else:
        country_codes = [
            str(c).strip().upper()
            for c in (countries or [])
            if str(c).strip()
        ][:270]
        if country_codes:
            names = [_country_display(c) for c in country_codes]
            parts.append("Target countries: " + ", ".join(names) + ".")
    if cities_all:
        parts.append("Target cities: all major cities in the listed countries.")
    else:
        clean_cities = [str(c).strip() for c in (cities or []) if str(c).strip()][:500]
        if clean_cities:
            parts.append("Target cities: " + ", ".join(clean_cities) + ".")
    return " ".join(parts).strip()

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


def _utc_day_reset_at() -> str:
    now = datetime.now(timezone.utc)
    tomorrow = (now + timedelta(days=1)).date()
    return datetime(tomorrow.year, tomorrow.month, tomorrow.day, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def _utc_month_reset_at() -> str:
    now = datetime.now(timezone.utc)
    if now.month == 12:
        next_month = datetime(now.year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        next_month = datetime(now.year, now.month + 1, 1, tzinfo=timezone.utc)
    return next_month.isoformat().replace("+00:00", "Z")


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
        brand_voice=(p.get("brand_voice") or "").strip() or None,
        brand_tones=[str(x) for x in (p.get("brand_tones") or []) if str(x).strip()],
        brand_rules=(p.get("brand_rules") or "").strip() or None,
        niche_topic=(p.get("niche_topic") or "").strip() or None,
        audience=[str(x) for x in (p.get("audience") or []) if str(x).strip()],
        target_countries=[
            str(x).strip().upper()
            for x in (p.get("target_countries") or [])
            if str(x).strip()
        ],
        target_countries_all=bool(p.get("target_countries_all", False)),
        target_cities=[str(x) for x in (p.get("target_cities") or []) if str(x).strip()],
        target_cities_all=bool(p.get("target_cities_all", False)),
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

    # Legacy text fields. Accepted for back-compat, but if structured
    # fields are also present below we will overwrite these with the
    # derived form so the project document stays internally consistent.
    if payload.brand_identity is not None:
        updates["brand_identity"] = (payload.brand_identity or "").strip()[:20000]
    if payload.niche_identifier is not None:
        updates["niche_identifier"] = (payload.niche_identifier or "").strip()[:20000]

    # Structured Brand identity fields.
    brand_struct_touched = False
    if payload.brand_voice is not None:
        updates["brand_voice"] = (payload.brand_voice or "").strip()[:64]
        brand_struct_touched = True
    if payload.brand_tones is not None:
        updates["brand_tones"] = [
            str(x).strip()[:64] for x in payload.brand_tones if str(x).strip()
        ][:10]
        brand_struct_touched = True
    if payload.brand_rules is not None:
        updates["brand_rules"] = (payload.brand_rules or "").strip()[:4000]
        brand_struct_touched = True

    # Structured Niche fields.
    niche_struct_touched = False
    if payload.niche_topic is not None:
        updates["niche_topic"] = (payload.niche_topic or "").strip()[:500]
        niche_struct_touched = True
    if payload.audience is not None:
        updates["audience"] = [
            str(x).strip()[:120] for x in payload.audience if str(x).strip()
        ][:30]
        niche_struct_touched = True
    if payload.target_countries is not None:
        updates["target_countries"] = [
            str(x).strip().upper()[:8]
            for x in payload.target_countries
            if str(x).strip()
        ][:270]
        niche_struct_touched = True
    if payload.target_countries_all is not None:
        updates["target_countries_all"] = bool(payload.target_countries_all)
        # When "all countries" is set we drop any enumerated codes so the
        # project document stays internally consistent (the flag is the
        # single source of truth for global targeting).
        if updates["target_countries_all"]:
            updates["target_countries"] = []
        niche_struct_touched = True
    if payload.target_cities is not None:
        updates["target_cities"] = [
            str(x).strip()[:120] for x in payload.target_cities if str(x).strip()
        ][:500]
        niche_struct_touched = True
    if payload.target_cities_all is not None:
        updates["target_cities_all"] = bool(payload.target_cities_all)
        niche_struct_touched = True

    # Whenever the structured inputs change we rebuild the legacy plain-text
    # representation from the *full* (post-update) value of each structured
    # field, so the article generation pipeline picks up the change without
    # needing to read both the structured and the free-text columns.
    if brand_struct_touched:
        merged_voice = updates.get("brand_voice", proj.get("brand_voice") or "")
        merged_tones = updates.get("brand_tones", list(proj.get("brand_tones") or []))
        merged_rules = updates.get("brand_rules", proj.get("brand_rules") or "")
        derived = _derive_brand_identity_text(
            voice=merged_voice or "",
            tones=merged_tones or [],
            rules=merged_rules or "",
        )
        updates["brand_identity"] = derived[:20000]

    if niche_struct_touched:
        merged_topic = updates.get("niche_topic", proj.get("niche_topic") or "")
        merged_aud = updates.get("audience", list(proj.get("audience") or []))
        merged_countries = updates.get(
            "target_countries", list(proj.get("target_countries") or [])
        )
        merged_countries_all = bool(
            updates.get(
                "target_countries_all", proj.get("target_countries_all", False)
            )
        )
        merged_cities = updates.get(
            "target_cities", list(proj.get("target_cities") or [])
        )
        merged_cities_all = bool(
            updates.get("target_cities_all", proj.get("target_cities_all", False))
        )
        derived_n = _derive_niche_text(
            topic=merged_topic or "",
            audience=merged_aud or [],
            countries=merged_countries or [],
            countries_all=merged_countries_all,
            cities=merged_cities or [],
            cities_all=merged_cities_all,
        )
        updates["niche_identifier"] = derived_n[:20000]

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
            "day_reset_at": _utc_day_reset_at(),
            "month_used": 0,
            "month_limit": None,
            "month_remaining": None,
            "month_reset_at": _utc_month_reset_at(),
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
            "day_reset_at": _utc_day_reset_at(),
            "month_used": 0,
            "month_limit": None,
            "month_remaining": None,
            "month_reset_at": _utc_month_reset_at(),
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
        "day_reset_at": _utc_day_reset_at(),
        "month_reset_at": _utc_month_reset_at(),
        **snap,
    }


@router.get("/{project_id}/feature-limits")
async def get_project_feature_limits(project_id: str, user: dict = Depends(get_current_user)) -> dict:
    """
    Plan-aware feature limits for UI pre-flight and messaging.

    Monthly generation features use user-level counters. Context links are a
    project-level hard cap: the current count cannot exceed the plan's
    ``max_context_links`` while that plan is active.
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
    try:
        plans = st.load_plans() or {}
        plan = plans.get(plan_key) if isinstance(plans, dict) else {}
        if not isinstance(plan, dict):
            plan = {}
    except Exception:
        plan = {}

    def _limit(name: str, *, beta_default: int | None = None) -> int | None:
        raw = plan.get(name)
        if raw is None and plan_key == "beta" and beta_default is not None:
            raw = beta_default
        try:
            val = int(raw or 0)
        except Exception:
            val = 0
        return val if val > 0 else None

    def _monthly(feature: str, month_field: str, count_field: str, limit_name: str) -> dict:
        limit = _limit(limit_name)
        if role == "admin":
            return {
                "feature": feature,
                "unlimited": True,
                "month_used": 0,
                "month_limit": None,
                "month_remaining": None,
                "month_reset_at": _utc_month_reset_at(),
            }
        if hasattr(st, "peek_monthly_counter"):
            snap = st.peek_monthly_counter(
                uid,
                month_field=month_field,
                count_field=count_field,
                month_limit=limit,
            )
            return {"feature": feature, "month_reset_at": _utc_month_reset_at(), **snap}
        return {
            "feature": feature,
            "unlimited": True,
            "month_used": 0,
            "month_limit": limit,
            "month_remaining": None,
            "month_reset_at": _utc_month_reset_at(),
        }

    context_limit = None if role == "admin" else _limit("max_context_links", beta_default=10)
    context_used = len(proj.get("context_links") or []) if isinstance(proj.get("context_links"), list) else 0
    context_remaining = None if context_limit is None else max(0, context_limit - context_used)

    return {
        "plan_key": plan_key,
        "is_admin": role == "admin",
        "cluster_plans": _monthly(
            "cluster_plans",
            "usage_monthly_cluster_plans_month",
            "usage_monthly_cluster_plans_count",
            "max_cluster_plans_per_month",
        ),
        "custom_research": _monthly(
            "custom_research",
            "usage_monthly_custom_research_month",
            "usage_monthly_custom_research_count",
            "max_custom_research_per_month",
        ),
        "scheduled_articles": {
            **_monthly(
                "scheduled_articles",
                "usage_monthly_scheduled_month",
                "usage_monthly_scheduled_count",
                "max_scheduled_per_month",
            ),
            "enabled": True if role == "admin" else plan.get("allow_scheduling") is not False,
        },
        "export_articles": {
            **_monthly(
                "export_articles",
                "usage_monthly_export_month",
                "usage_monthly_export_count",
                "max_export_per_month",
            ),
            "enabled": True if role == "admin" else plan.get("allow_export") is not False,
        },
        "context_links": {
            "feature": "context_links",
            "unlimited": context_limit is None,
            "used": context_used,
            "limit": context_limit,
            "remaining": context_remaining,
            "renews_at": _utc_month_reset_at(),
        },
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

