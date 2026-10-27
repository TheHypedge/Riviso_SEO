"""
Per-project IndexNow (Bing, Yandex, Naver, Seznam, Yep) — see :mod:`app.services.indexnow`.

- ``GET  /api/projects/{project_id}/indexnow/status``     — key / verification / last bulk result
- ``POST /api/projects/{project_id}/indexnow/setup``      — create key, push to plugin, verify (also "Verify")
- ``POST /api/projects/{project_id}/indexnow/settings``   — auto-submit on publish on/off
- ``POST /api/projects/{project_id}/indexnow/submit-all`` — submit every published post URL once
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.deps import get_current_user
from app.core.project_lookup import require_project_access
from app.legacy.storage import get_legacy_storage_module
from app.services import indexnow
from app.services.to_thread import run_sync

router = APIRouter(prefix="/projects/{project_id}/indexnow", tags=["indexnow"])


def _status(proj: dict) -> dict:
    return {
        "supported": (proj.get("platform") or "") != "shopify" and not proj.get("shopify_shop"),
        "enabled": bool(proj.get("indexnow_enabled", True)),
        "ready": indexnow.is_ready(proj),
        "key": (proj.get("indexnow_key") or "") or None,
        "key_location": (proj.get("indexnow_key_location") or "") or None,
        "error": (proj.get("indexnow_error") or "") or None,
        "last_submit_at": (proj.get("indexnow_last_submit_at") or "") or None,
        "last_result": (proj.get("indexnow_last_result") or "") or None,
    }


@router.get("/status")
async def status(project_id: str, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    proj = require_project_access(st=st, user=user, project_id=project_id, full=True, allow_collaborators=True)
    return _status(proj)


@router.post("/setup")
async def setup(project_id: str, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    proj = require_project_access(st=st, user=user, project_id=project_id, full=True)
    if not _status(proj)["supported"]:
        raise HTTPException(status_code=400, detail="IndexNow is available for WordPress projects only.")
    try:
        await indexnow.setup_for_project(st=st, proj=proj)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e) or "IndexNow setup failed") from e
    fresh = await run_sync(st.get_project_by_id, project_id)
    return _status(fresh or proj)


class IndexNowSettings(BaseModel):
    enabled: bool


@router.post("/settings")
async def settings(project_id: str, payload: IndexNowSettings, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    proj = require_project_access(st=st, user=user, project_id=project_id, full=True)
    await run_sync(st.update_project_fields, project_id, {"indexnow_enabled": payload.enabled})
    return _status({**proj, "indexnow_enabled": payload.enabled})


@router.post("/submit-all")
async def submit_all(project_id: str, user: dict = Depends(get_current_user)) -> dict:
    """Submit every published post URL (WordPress site map; synced first if empty)."""
    from app.services.internal_link_service import InternalLinkService

    st = get_legacy_storage_module()
    proj = require_project_access(st=st, user=user, project_id=project_id, full=True)
    if not indexnow.is_ready(proj):
        raise HTTPException(status_code=400, detail="Set up and verify IndexNow first.")

    rows = await run_sync(st.load_site_map_for_project, project_id, limit=indexnow.MAX_URLS)
    if not rows:
        try:
            await InternalLinkService(project=proj).sync_site_map_from_wp()
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not read posts from WordPress: {e}") from e
        rows = await run_sync(st.load_site_map_for_project, project_id, limit=indexnow.MAX_URLS)
    urls = [r.get("post_url") or "" for r in rows]

    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    try:
        r = await indexnow.submit_urls(key=proj["indexnow_key"], key_location=proj["indexnow_key_location"], urls=urls)
        result = f"{r['submitted']} URL(s) accepted (HTTP {r['http_status']})"
        error = None
    except Exception as e:
        result = error = str(e)[:500]
    await run_sync(
        st.update_project_fields,
        project_id,
        {"indexnow_last_submit_at": now, "indexnow_last_result": result},
    )
    if error:
        raise HTTPException(status_code=400, detail=error)
    return _status({**proj, "indexnow_last_submit_at": now, "indexnow_last_result": result})
