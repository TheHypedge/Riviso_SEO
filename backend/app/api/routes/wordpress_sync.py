"""WordPress Sync & Self-Healing API routes.

Riviso is the Source of Truth. These endpoints let users check and repair
discrepancies between stored articles and their live WordPress posts.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from app.core.deps import get_current_user
from app.core.project_lookup import async_require_project_access
from app.legacy.storage import get_legacy_storage_module
from app.schemas.wordpress_sync import (
    ArticleSyncResult,
    BulkRepairResponse,
    ProjectSyncResponse,
    RepairResult,
    SyncIgnoreRequest,
)
from app.services.to_thread import run_sync
from app.services.wordpress_sync import (
    SYNC_MISSING,
    SYNC_NEEDS_ATTENTION,
    SYNC_SYNCED,
    SYNC_UNKNOWN,
    check_article_sync,
    repair_article_issue,
)

router = APIRouter(prefix="/projects/{project_id}/wordpress", tags=["wordpress-sync"])

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_wp_client(proj: dict):
    from app.api.routes.wordpress import _get_wp_client_for_project
    return _get_wp_client_for_project(proj)


def _article_to_sync_result(article: dict) -> ArticleSyncResult:
    issues_raw = (article.get("sync_issue_type") or "").strip()
    issues = [i.strip() for i in issues_raw.split(",") if i.strip()] if issues_raw else []
    return ArticleSyncResult(
        article_id=(article.get("id") or "").strip(),
        article_title=(article.get("title") or "").strip(),
        wp_post_id=article.get("wp_post_id"),
        wp_link=(article.get("wp_link") or "") or None,
        sync_status=(article.get("sync_status") or SYNC_UNKNOWN),
        issues=issues,
        last_synced_at=article.get("last_synced_at") or None,
        last_successful_sync=article.get("last_successful_sync") or None,
        last_fix_at=article.get("last_fix_at") or None,
        repair_count=int(article.get("repair_count") or 0),
        ignored_sync_issue=bool(article.get("ignored_sync_issue", False)),
        sync_history=list(article.get("sync_history") or [])[-5:],
    )


# ---------------------------------------------------------------------------
# POST /api/projects/{project_id}/wordpress/sync
# ---------------------------------------------------------------------------

@router.post("/sync", response_model=ProjectSyncResponse)
async def sync_project(
    project_id: str,
    user: dict = Depends(get_current_user),
) -> ProjectSyncResponse:
    """
    Scan all WordPress-published articles in the project.
    Compare each against the live WordPress post and update sync_status.
    Riviso is always the Source of Truth.
    """
    st = get_legacy_storage_module()
    proj = await async_require_project_access(user=user, project_id=project_id, full=True, allow_collaborators=True)

    wp = _get_wp_client(proj)

    articles = await run_sync(st.load_wp_published_articles_for_project, project_id, 500)
    if not articles:
        return ProjectSyncResponse(
            project_id=project_id,
            total=0,
            healthy=0,
            needs_attention=0,
            by_status={},
            results=[],
            synced_at=_now_iso(),
        )

    results: list[ArticleSyncResult] = []
    by_status: dict[str, int] = {}

    for article in articles:
        if bool(article.get("ignored_sync_issue", False)):
            # Keep the ignored status but don't re-check
            result = _article_to_sync_result(article)
            results.append(result)
            s = result.sync_status
            by_status[s] = by_status.get(s, 0) + 1
            continue

        try:
            updates = await check_article_sync(wp, article)
        except Exception as exc:
            log.warning("Sync check failed for article %s: %s", article.get("id"), exc)
            updates = {
                "sync_status": "error",
                "sync_issue_type": str(exc)[:200],
                "last_synced_at": _now_iso(),
            }

        try:
            await run_sync(st.patch_article_fields, article["id"], updates)
        except Exception as exc:
            log.error("Failed to persist sync status for article %s: %s", article.get("id"), exc)

        merged = {**article, **updates}
        result = _article_to_sync_result(merged)
        results.append(result)
        s = result.sync_status
        by_status[s] = by_status.get(s, 0) + 1

    healthy = sum(1 for r in results if r.sync_status == SYNC_SYNCED)
    attention = sum(1 for r in results if r.sync_status not in (SYNC_SYNCED, SYNC_UNKNOWN))

    return ProjectSyncResponse(
        project_id=project_id,
        total=len(results),
        healthy=healthy,
        needs_attention=attention,
        by_status=by_status,
        results=results,
        synced_at=_now_iso(),
    )


# ---------------------------------------------------------------------------
# POST /api/projects/{project_id}/wordpress/articles/{article_id}/sync
# ---------------------------------------------------------------------------

@router.post("/articles/{article_id}/sync", response_model=ArticleSyncResult)
async def sync_single_article(
    project_id: str,
    article_id: str,
    user: dict = Depends(get_current_user),
) -> ArticleSyncResult:
    """Sync a single article against WordPress."""
    st = get_legacy_storage_module()
    proj = await async_require_project_access(user=user, project_id=project_id, full=True, allow_collaborators=True)
    wp = _get_wp_client(proj)

    article = await run_sync(st.get_article, project_id=project_id, article_id=article_id)
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")
    if not article.get("wp_post_id"):
        raise HTTPException(status_code=400, detail="Article has not been published to WordPress")

    updates = await check_article_sync(wp, article)
    try:
        await run_sync(st.patch_article_fields, article_id, updates)
    except Exception as exc:
        log.error("Failed to persist sync for article %s: %s", article_id, exc)

    return _article_to_sync_result({**article, **updates})


# ---------------------------------------------------------------------------
# POST /api/projects/{project_id}/wordpress/articles/{article_id}/repair
# ---------------------------------------------------------------------------

@router.post("/articles/{article_id}/repair", response_model=RepairResult)
async def repair_article(
    project_id: str,
    article_id: str,
    user: dict = Depends(get_current_user),
) -> RepairResult:
    """Repair all detected sync issues for a single article."""
    st = get_legacy_storage_module()
    proj = await async_require_project_access(user=user, project_id=project_id, full=True, allow_collaborators=True)
    wp = _get_wp_client(proj)

    article = await run_sync(st.get_article, project_id=project_id, article_id=article_id)
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")

    issue_type = (article.get("sync_issue_type") or article.get("sync_status") or "").strip()
    issues = [i.strip() for i in issue_type.split(",") if i.strip() and i.strip() != SYNC_SYNCED]

    if not issues:
        return RepairResult(article_id=article_id, ok=True, operation="skipped")

    operations: list[str] = []
    last_err: str | None = None
    new_wp_post_id: int | None = None
    new_wp_link: str | None = None

    for issue in issues:
        try:
            res = await repair_article_issue(wp, article, issue)
            operations.append(res.get("operation", issue))
            if res.get("error"):
                last_err = res["error"]
            if res.get("new_wp_post_id"):
                new_wp_post_id = res["new_wp_post_id"]
            if res.get("new_wp_link"):
                new_wp_link = res["new_wp_link"]
        except Exception as exc:
            last_err = str(exc)
            log.error("Repair failed for article %s issue %s: %s", article_id, issue, exc)

    now = _now_iso()
    db_updates: dict = {
        "last_fix_at": now,
        "repair_count": int(article.get("repair_count") or 0) + 1,
        "last_synced_at": now,
    }
    if not last_err:
        db_updates["sync_status"] = SYNC_SYNCED
        db_updates["sync_issue_type"] = ""
        db_updates["last_successful_sync"] = now
    if new_wp_post_id:
        db_updates["wp_post_id"] = new_wp_post_id
    if new_wp_link:
        db_updates["wp_link"] = new_wp_link

    history = list(article.get("sync_history") or [])
    history.append({"ts": now, "action": "repair", "detail": ", ".join(operations) or issue_type})
    db_updates["sync_history"] = history[-20:]

    try:
        await run_sync(st.patch_article_fields, article_id, db_updates)
    except Exception as exc:
        log.error("Failed to persist repair for article %s: %s", article_id, exc)

    ok = last_err is None
    return RepairResult(
        article_id=article_id,
        ok=ok,
        operation=", ".join(operations) or issue_type,
        error=last_err,
        new_wp_post_id=new_wp_post_id,
        new_wp_link=new_wp_link,
    )


# ---------------------------------------------------------------------------
# POST /api/projects/{project_id}/wordpress/repair-all
# ---------------------------------------------------------------------------

@router.post("/repair-all", response_model=BulkRepairResponse)
async def repair_all_articles(
    project_id: str,
    user: dict = Depends(get_current_user),
) -> BulkRepairResponse:
    """Repair all articles with detected sync issues in the project."""
    st = get_legacy_storage_module()
    proj = await async_require_project_access(user=user, project_id=project_id, full=True, allow_collaborators=True)
    wp = _get_wp_client(proj)

    articles = await run_sync(st.load_wp_published_articles_for_project, project_id, 500)
    articles_with_issues = [
        a for a in articles
        if (a.get("sync_status") or SYNC_UNKNOWN) not in (SYNC_SYNCED, SYNC_UNKNOWN, "")
        and not bool(a.get("ignored_sync_issue", False))
    ]

    results: list[RepairResult] = []
    repaired = 0
    failed = 0
    skipped = 0

    for article in articles_with_issues:
        article_id = (article.get("id") or "").strip()
        if not article_id:
            continue
        issue_type = (article.get("sync_issue_type") or article.get("sync_status") or "").strip()
        issues = [i.strip() for i in issue_type.split(",") if i.strip() and i.strip() != SYNC_SYNCED]
        if not issues:
            skipped += 1
            results.append(RepairResult(article_id=article_id, ok=True, operation="skipped"))
            continue

        operations: list[str] = []
        last_err: str | None = None
        new_wp_post_id: int | None = None
        new_wp_link: str | None = None

        for issue in issues:
            try:
                res = await repair_article_issue(wp, article, issue)
                operations.append(res.get("operation", issue))
                if res.get("error") and not res.get("ok", True):
                    last_err = res["error"]
                if res.get("new_wp_post_id"):
                    new_wp_post_id = res["new_wp_post_id"]
                if res.get("new_wp_link"):
                    new_wp_link = res["new_wp_link"]
            except Exception as exc:
                last_err = str(exc)
                log.error("Bulk repair failed for article %s issue %s: %s", article_id, issue, exc)

        now = _now_iso()
        db_updates: dict = {
            "last_fix_at": now,
            "repair_count": int(article.get("repair_count") or 0) + 1,
            "last_synced_at": now,
        }
        if not last_err:
            db_updates["sync_status"] = SYNC_SYNCED
            db_updates["sync_issue_type"] = ""
            db_updates["last_successful_sync"] = now
            repaired += 1
        else:
            failed += 1
        if new_wp_post_id:
            db_updates["wp_post_id"] = new_wp_post_id
        if new_wp_link:
            db_updates["wp_link"] = new_wp_link

        history = list(article.get("sync_history") or [])
        history.append({"ts": now, "action": "repair", "detail": ", ".join(operations) or issue_type})
        db_updates["sync_history"] = history[-20:]

        try:
            await run_sync(st.patch_article_fields, article_id, db_updates)
        except Exception as exc:
            log.error("Failed to persist bulk repair for article %s: %s", article_id, exc)

        results.append(RepairResult(
            article_id=article_id,
            ok=last_err is None,
            operation=", ".join(operations) or issue_type,
            error=last_err,
            new_wp_post_id=new_wp_post_id,
            new_wp_link=new_wp_link,
        ))

    return BulkRepairResponse(repaired=repaired, failed=failed, skipped=skipped, results=results)


# ---------------------------------------------------------------------------
# PATCH /api/projects/{project_id}/wordpress/articles/{article_id}/sync-ignore
# ---------------------------------------------------------------------------

@router.patch("/articles/{article_id}/sync-ignore")
async def set_sync_ignore(
    project_id: str,
    article_id: str,
    body: SyncIgnoreRequest,
    user: dict = Depends(get_current_user),
) -> dict:
    """Toggle the ignored_sync_issue flag for an article."""
    st = get_legacy_storage_module()
    await async_require_project_access(user=user, project_id=project_id, allow_collaborators=True)

    article = await run_sync(st.get_article, project_id=project_id, article_id=article_id)
    if not article:
        raise HTTPException(status_code=404, detail="Article not found")

    await run_sync(st.patch_article_fields, article_id, {"ignored_sync_issue": body.ignored})
    return {"ok": True, "ignored": body.ignored}
