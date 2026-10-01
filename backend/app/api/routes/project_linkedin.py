"""
Per-project LinkedIn connection + posting routes, and Quora discovery/answer routes
(Social Media module, v1: LinkedIn auto-post + Quora assisted-answer only -- see the
module plan for why Instagram/Facebook/X aren't here yet).

- ``GET    /api/projects/{project_id}/linkedin/status``          — connection status
- ``GET    /api/projects/{project_id}/linkedin/connect-url``     — kick off OAuth
- ``GET    /api/linkedin/oauth/callback``                        — OAuth callback (global path, pid in state)
- ``POST   /api/projects/{project_id}/linkedin/select-author``   — post as member vs. a specific Company Page
- ``POST   /api/projects/{project_id}/linkedin/disconnect``      — clear the project's LinkedIn tokens
- ``POST   /api/projects/{project_id}/articles/{article_id}/linkedin/generate-caption``
- ``POST   /api/projects/{project_id}/articles/{article_id}/linkedin/post``
- ``POST   /api/projects/{project_id}/articles/{article_id}/linkedin/schedule``
- ``GET    /api/projects/{project_id}/quora/discover-questions``
- ``POST   /api/projects/{project_id}/articles/{article_id}/quora/generate-answer``
- ``POST   /api/social-posts/{post_id}/mark-posted``             — self-reported Quora "I pasted this" checkbox
"""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from starlette.responses import RedirectResponse

from app.core.config import settings
from app.core.deps import get_current_user
from app.core.project_lookup import require_project_access
from app.legacy.storage import get_legacy_storage_module
from app.services import linkedin_client, linkedin_oauth
from app.services.quora_question_finder import discover_quora_questions
from app.services.schedule_timing import SCHEDULE_TOO_SOON_MESSAGE, is_schedule_time_allowed
from app.services.shopify_oauth import validate_return_origin
from app.services.social_caption_generator import generate_linkedin_caption, generate_quora_answer
from app.services.to_thread import run_sync
from app.services.user_timezone import parse_schedule_input_to_utc, zoneinfo_for_user

router = APIRouter(prefix="/projects/{project_id}/linkedin", tags=["linkedin-project"])
quora_router = APIRouter(prefix="/projects/{project_id}/quora", tags=["quora-project"])
social_posts_router = APIRouter(prefix="/social-posts", tags=["social-posts"])
project_social_posts_router = APIRouter(prefix="/projects/{project_id}/social-posts", tags=["social-posts"])


def _require_project(*, st, user: dict, project_id: str, allow_collaborators: bool = False) -> dict:
    # allow_collaborators=True for read/content actions (status, caption generation,
    # posting) that shared collaborators should be able to use; connect/disconnect/
    # author-selection (account-level setup) keep the default owner-only.
    return require_project_access(st=st, user=user, project_id=project_id, full=True, allow_collaborators=allow_collaborators)


def _public_api_url(path: str) -> str:
    base = (str(settings.public_base_url) if settings.public_base_url else "").strip().rstrip("/")
    if not base:
        return (path or "").strip()
    from urllib.parse import urlparse, urlunparse

    p0 = (path or "").strip()
    b = urlparse(base)
    u = urlparse(p0)
    if u.scheme and u.netloc:
        return urlunparse((b.scheme, b.netloc, u.path, u.params, u.query, u.fragment))
    p = p0 if p0.startswith("/") else f"/{p0}"
    return f"{base}{p}"


def _frontend_project_redirect_url(*, project_id: str, ok: bool, message: str | None = None, origin_override: str | None = None) -> str:
    base = validate_return_origin(origin_override)
    frag = "linkedin=connected" if ok else "linkedin=error"
    if message:
        frag += f"&msg={message[:180]}"
    pid = (project_id or "").strip()
    target = f"/projects/{pid}?tab=social#{frag}" if pid else f"/dashboard#{frag}"
    if not base:
        return target
    return f"{base}{target}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- status


@router.get("/status")
async def linkedin_status(project_id: str, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    proj = await run_sync(_require_project, st=st, user=user, project_id=project_id, allow_collaborators=True)
    token = (proj.get("linkedin_access_token") or "").strip()
    org_urns = proj.get("linkedin_org_urns") or []
    organizations = [{"urn": u, "name": None} for u in org_urns if isinstance(u, str)]
    return {
        "configured": linkedin_oauth.oauth_configured(),
        "connected": bool(token),
        "member_name": (proj.get("linkedin_member_name") or "").strip() or None,
        "person_urn": (proj.get("linkedin_person_urn") or "").strip() or None,
        "connected_at": (proj.get("linkedin_connected_at") or "").strip() or None,
        "token_expires_at": (proj.get("linkedin_token_expires_at") or "").strip() or None,
        "organizations": organizations,
        "selected_author_urn": (proj.get("linkedin_selected_author_urn") or "").strip() or None,
    }


@router.get("/connect-url")
async def linkedin_connect_url(request: Request, project_id: str, user: dict = Depends(get_current_user)) -> dict:
    if not linkedin_oauth.oauth_configured():
        raise HTTPException(status_code=400, detail="LinkedIn OAuth client is not configured on the backend")
    st = get_legacy_storage_module()
    await run_sync(_require_project, st=st, user=user, project_id=project_id)
    uid = (user.get("id") or "").strip()
    origin = validate_return_origin(request.headers.get("origin") or request.headers.get("referer"))
    state = linkedin_oauth.make_state_token(user_id=uid, project_id=project_id, origin=origin)
    redirect_uri = _public_api_url(str(request.url_for("linkedin_oauth_callback")))
    url = linkedin_oauth.build_auth_url(redirect_uri=redirect_uri, state=state)
    return {"url": url}


linkedin_oauth_router = APIRouter(prefix="/linkedin", tags=["linkedin"])


@linkedin_oauth_router.get("/oauth/callback", name="linkedin_oauth_callback")
async def linkedin_oauth_callback(request: Request) -> RedirectResponse:
    code = (request.query_params.get("code") or "").strip()
    state = (request.query_params.get("state") or "").strip()
    if not code or not state:
        return RedirectResponse(_frontend_project_redirect_url(project_id="", ok=False, message="Missing code/state"), status_code=302)
    try:
        parsed = linkedin_oauth.parse_state_token(state)
    except Exception:
        return RedirectResponse(_frontend_project_redirect_url(project_id="", ok=False, message="Invalid state"), status_code=302)
    uid = (parsed.get("uid") or "").strip()
    pid = (parsed.get("pid") or "").strip()
    origin = parsed.get("origin")

    redirect_uri = _public_api_url(str(request.url_for("linkedin_oauth_callback")))
    try:
        tok = await linkedin_oauth.exchange_code_for_token(code=code, redirect_uri=redirect_uri)
    except Exception:
        return RedirectResponse(_frontend_project_redirect_url(project_id=pid, ok=False, message="Token exchange failed", origin_override=origin), status_code=302)

    access_token = (tok.get("access_token") or "").strip()
    expires_in = int(tok.get("expires_in") or 0)
    expires_at = int(time.time()) + max(0, expires_in)

    identity = await linkedin_oauth.fetch_member_identity(access_token=access_token) if access_token else {}
    member_sub = (identity.get("sub") or "").strip()
    member_name = (identity.get("name") or "").strip()
    person_urn = f"urn:li:person:{member_sub}" if member_sub else ""

    orgs = await linkedin_oauth.fetch_administered_organizations(access_token=access_token) if access_token else []
    org_urns = [o["urn"] for o in orgs if o.get("urn")]

    st = get_legacy_storage_module()
    proj = st.get_project_by_id(pid) if pid and hasattr(st, "get_project_by_id") else None
    if not pid or not isinstance(proj, dict):
        return RedirectResponse(_frontend_project_redirect_url(project_id=pid, ok=False, message="Project not found", origin_override=origin), status_code=302)
    owner = (proj.get("owner_user_id") or "").strip()
    if owner and owner != uid:
        return RedirectResponse(_frontend_project_redirect_url(project_id=pid, ok=False, message="Project owner mismatch", origin_override=origin), status_code=302)

    st.update_project_fields(
        pid,
        {
            "linkedin_access_token": access_token,
            "linkedin_token_expires_at": str(expires_at),
            "linkedin_person_urn": person_urn,
            "linkedin_member_name": member_name,
            "linkedin_org_urns": org_urns,
            # Default to posting as the member; select-author can switch to a Company Page.
            "linkedin_selected_author_urn": person_urn,
            "linkedin_connected_at": _now_iso(),
            "linkedin_reconnect_notified": False,
        },
    )
    return RedirectResponse(_frontend_project_redirect_url(project_id=pid, ok=True, origin_override=origin), status_code=302)


class SelectAuthorRequest(BaseModel):
    author_urn: str


@router.post("/select-author")
async def linkedin_select_author(project_id: str, payload: SelectAuthorRequest, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    proj = await run_sync(_require_project, st=st, user=user, project_id=project_id)
    urn = (payload.author_urn or "").strip()
    valid = {proj.get("linkedin_person_urn") or ""} | set(proj.get("linkedin_org_urns") or [])
    if urn not in valid:
        raise HTTPException(status_code=400, detail="Not one of this project's connected LinkedIn identities")
    await run_sync(st.update_project_fields, project_id, {"linkedin_selected_author_urn": urn})
    return {"ok": True, "selected_author_urn": urn}


@router.post("/disconnect")
async def linkedin_disconnect(project_id: str, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    await run_sync(_require_project, st=st, user=user, project_id=project_id)
    await run_sync(
        st.update_project_fields,
        project_id,
        {
            "linkedin_access_token": "",
            "linkedin_token_expires_at": "",
            "linkedin_person_urn": "",
            "linkedin_member_name": "",
            "linkedin_org_urns": [],
            "linkedin_selected_author_urn": "",
            "linkedin_connected_at": "",
            "linkedin_reconnect_notified": False,
        },
    )
    return {"ok": True}


# --------------------------------------------------------------------------- posting


def _require_linkedin_connected(proj: dict) -> tuple[str, str]:
    """Returns (access_token, author_urn) or raises a clear, actionable 400."""
    token = (proj.get("linkedin_access_token") or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="LinkedIn is not connected for this project")
    expires_at = int((proj.get("linkedin_token_expires_at") or "0").strip() or 0)
    if expires_at and time.time() > expires_at:
        raise HTTPException(status_code=400, detail="Your LinkedIn connection has expired. Please reconnect.")
    author_urn = (proj.get("linkedin_selected_author_urn") or proj.get("linkedin_person_urn") or "").strip()
    if not author_urn:
        raise HTTPException(status_code=400, detail="LinkedIn is not connected for this project")
    return token, author_urn


article_linkedin_router = APIRouter(prefix="/projects/{project_id}/articles/{article_id}/linkedin", tags=["linkedin-project"])


@article_linkedin_router.post("/generate-caption")
async def linkedin_generate_caption(project_id: str, article_id: str, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    await run_sync(_require_project, st=st, user=user, project_id=project_id, allow_collaborators=True)
    article = await run_sync(st.get_article, project_id=project_id, article_id=article_id)
    if not isinstance(article, dict):
        raise HTTPException(status_code=404, detail="Article not found")
    text = await generate_linkedin_caption(article)
    return {"text": text}


class LinkedInPostRequest(BaseModel):
    commentary: str


@article_linkedin_router.post("/post")
async def linkedin_post(project_id: str, article_id: str, payload: LinkedInPostRequest, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    proj = await run_sync(_require_project, st=st, user=user, project_id=project_id, allow_collaborators=True)
    access_token, author_urn = _require_linkedin_connected(proj)
    article = await run_sync(st.get_article, project_id=project_id, article_id=article_id)
    if not isinstance(article, dict):
        raise HTTPException(status_code=404, detail="Article not found")
    commentary = (payload.commentary or "").strip()
    if not commentary:
        raise HTTPException(status_code=400, detail="commentary is required")

    article_url = (article.get("wp_link") or article.get("shopify_link") or "").strip() or None
    thumbnail_urn = await linkedin_client.upload_article_thumbnail(
        st=st, project_id=project_id, article_id=article_id, access_token=access_token, owner_urn=author_urn,
    )

    try:
        result = await linkedin_client.create_post(
            access_token=access_token,
            author_urn=author_urn,
            commentary=commentary,
            article_url=article_url,
            thumbnail_urn=thumbnail_urn,
            title=(article.get("title") or "").strip() or None,
            description=(article.get("meta_description") or "").strip() or None,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LinkedIn post failed: {e}") from e

    now = _now_iso()
    post_id = str(uuid.uuid4())
    await run_sync(
        st.create_social_post,
        {
            "id": post_id,
            "project_id": project_id,
            "article_id": article_id,
            "platform": "linkedin",
            "status": "posted",
            "content_text": commentary,
            "external_url": result["post_url"],
            "created_at": now,
            "posted_at": now,
        },
    )
    return {"id": post_id, "post_url": result["post_url"]}


class LinkedInScheduleRequest(BaseModel):
    run_at: str
    commentary: str
    user_timezone: str | None = None


@article_linkedin_router.post("/schedule", status_code=200)
async def linkedin_schedule(project_id: str, article_id: str, payload: LinkedInScheduleRequest, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    proj = await run_sync(_require_project, st=st, user=user, project_id=project_id, allow_collaborators=True)
    _require_linkedin_connected(proj)
    article = await run_sync(st.get_article, project_id=project_id, article_id=article_id)
    if not isinstance(article, dict):
        raise HTTPException(status_code=404, detail="Article not found")
    commentary = (payload.commentary or "").strip()
    if not commentary:
        raise HTTPException(status_code=400, detail="commentary is required")

    tz_name = (payload.user_timezone or "").strip() or (user.get("timezone") or "").strip()
    try:
        dt_utc = parse_schedule_input_to_utc((payload.run_at or "").strip(), user_tz=zoneinfo_for_user(tz_name or None))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e) or "Invalid schedule time format") from None
    if not is_schedule_time_allowed(dt_utc):
        raise HTTPException(status_code=400, detail=SCHEDULE_TOO_SOON_MESSAGE)
    run_at = dt_utc.replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")

    now = _now_iso()
    job_id = str(uuid.uuid4())
    await run_sync(
        st.insert_scheduled_job,
        {
            "id": job_id,
            "project_id": project_id,
            "article_id": article_id,
            "run_at": run_at,
            "state": "scheduled",
            "platform": "linkedin",
            "linkedin_commentary": commentary,
            "created_at": now,
        },
    )
    return {"ok": True, "id": job_id, "status": "scheduled", "run_at": run_at}


# --------------------------------------------------------------------------- quora


@quora_router.get("/discover-questions")
async def quora_discover_questions(project_id: str, keywords: str | None = None, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    proj = await run_sync(_require_project, st=st, user=user, project_id=project_id, allow_collaborators=True)
    kw_list = [k.strip() for k in (keywords or "").split(",") if k.strip()]
    if not kw_list:
        fallback = (proj.get("niche_topic") or proj.get("niche_identifier") or "").strip()
        kw_list = [fallback] if fallback else []
    if not kw_list:
        raise HTTPException(status_code=400, detail="No keywords provided and this project has no niche topic set")
    results = await discover_quora_questions(keywords=kw_list[:5])
    return {"questions": results}


class QuoraAnswerRequest(BaseModel):
    question: str
    question_url: str


article_quora_router = APIRouter(prefix="/projects/{project_id}/articles/{article_id}/quora", tags=["quora-project"])


@article_quora_router.post("/generate-answer")
async def quora_generate_answer(project_id: str, article_id: str, payload: QuoraAnswerRequest, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    await run_sync(_require_project, st=st, user=user, project_id=project_id, allow_collaborators=True)
    article = await run_sync(st.get_article, project_id=project_id, article_id=article_id)
    if not isinstance(article, dict):
        raise HTTPException(status_code=404, detail="Article not found")
    question = (payload.question or "").strip()
    question_url = (payload.question_url or "").strip()
    if not question or not question_url:
        raise HTTPException(status_code=400, detail="question and question_url are required")

    text = await generate_quora_answer(question=question, article=article)

    now = _now_iso()
    post_id = str(uuid.uuid4())
    await run_sync(
        st.create_social_post,
        {
            "id": post_id,
            "project_id": project_id,
            "article_id": article_id,
            "platform": "quora",
            "status": "draft",
            "content_text": text,
            "external_url": question_url,
            "created_at": now,
            "posted_at": None,
        },
    )
    return {"id": post_id, "text": text, "question_url": question_url}


@project_social_posts_router.get("")
async def list_project_social_posts(project_id: str, platform: str | None = None, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    await run_sync(_require_project, st=st, user=user, project_id=project_id, allow_collaborators=True)
    posts = await run_sync(st.load_social_posts_for_project, project_id, platform=(platform or "").strip() or None)
    return {"posts": posts}


@social_posts_router.post("/{post_id}/mark-posted")
async def mark_social_post_posted(post_id: str, user: dict = Depends(get_current_user)) -> dict:
    """Self-reported "I pasted this on Quora" checkbox -- not verified, clearly labeled
    as such in the UI. LinkedIn posts never need this (they're marked posted at the
    moment of the real API call)."""
    st = get_legacy_storage_module()
    post = await run_sync(st.get_social_post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Not found")
    await run_sync(_require_project, st=st, user=user, project_id=post.get("project_id") or "", allow_collaborators=True)
    await run_sync(st.update_social_post_fields, post_id, {"status": "posted", "posted_at": _now_iso()})
    return {"ok": True}
