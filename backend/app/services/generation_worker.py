"""
In-process worker that drains the generation queue with bounded concurrency.

Run one worker per API process (default on via ENABLE_GENERATION_WORKER=1).
For multiple uvicorn workers, Redis shares the queue; each process runs its own consumer.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any

from app.core.config import settings
from app.legacy.storage import get_legacy_storage_module
from app.services.article_pipeline import (
    execute_article_generation,
    execute_featured_image_regeneration,
)
from app.services.generation_queue import (
    GenerationJob,
    GenerationJobKind,
    clear_dedup,
    dequeue_blocking,
    generation_slot,
    queue_depth,
    close_redis,
)
from app.core.metrics import set_queue_depth
from app.services.pipeline_streamer import (
    MSG_WORKER_START,
    STAGE_WORKER_START,
    publish_pipeline_error,
    publish_pipeline_status,
)
from app.services.scheduler import (
    _patch_scheduled_job,
    prepare_article_for_scheduled_job,
    scheduler_error_message,
)
from app.services.storage_db import call_storage
from app.services.to_thread import run_sync

log = logging.getLogger(__name__)

_worker_task: asyncio.Task | None = None


async def _storage(fn, /, *args, **kwargs):
    return await run_sync(call_storage, fn, *args, **kwargs)


def _gen_project_reader(st):
    """Prefer the catalog-excluding generation projection (P4.1); fall back to full read."""
    return getattr(st, "get_project_for_generation", None) or getattr(st, "get_project_by_id", None)


async def _handle_scheduled_prep(payload: dict) -> None:
    st = get_legacy_storage_module()
    jid = (payload.get("job_id") or "").strip()
    pid = (payload.get("project_id") or "").strip()
    aid = (payload.get("article_id") or "").strip()
    if not jid or not pid or not aid:
        return

    dedup = f"prep:{jid}"
    try:
        proj = await _storage(_gen_project_reader(st), pid) if hasattr(st, "get_project_by_id") else None
        if not isinstance(proj, dict):
            prows = await _storage(st.load_projects)
            proj = next((p for p in (prows or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
        if not isinstance(proj, dict):
            raise RuntimeError("Project not found")

        art = await _storage(st.get_article, project_id=pid, article_id=aid)
        if not isinstance(art, dict):
            raise RuntimeError("Article not found")

        jobs = await _storage(st.load_scheduled_jobs, project_id=pid, article_id=aid)
        job = next((j for j in (jobs or []) if isinstance(j, dict) and (j.get("id") or "").strip() == jid), None)
        if not isinstance(job, dict):
            job = {"id": jid, "project_id": pid, "article_id": aid}

        state = (job.get("state") or "").strip().lower()
        if state in {"ready_to_post", "posted", "posting"}:
            return

        from app.services.schedule_timing import is_within_scheduled_prep_window

        run_at = (job.get("run_at") or "").strip()
        if run_at and not is_within_scheduled_prep_window(run_at):
            if state in {"content_generating", "image_generating"}:
                try:
                    await _patch_scheduled_job(st, jid, {"state": "scheduled"})
                except Exception:
                    pass
            return

        await _patch_scheduled_job(st, jid, {"state": "content_generating", "last_error": ""})

        async with generation_slot():
            await prepare_article_for_scheduled_job(st=st, jid=jid, proj=proj, art=art, job=job)

        await _patch_scheduled_job(st, jid, {"state": "ready_to_post", "last_error": ""})
    except Exception as e:
        err = scheduler_error_message(e)
        log.exception("Scheduled prep failed job_id=%s", jid)
        try:
            await _patch_scheduled_job(st, jid, {"state": "failed", "last_error": err})
        except Exception:
            pass
    finally:
        await clear_dedup(dedup)


async def _persist_article_generation_error(st: Any, aid: str, err_msg: str) -> None:
    """Persist generation error to the article document so the polling endpoint surfaces it quickly."""
    try:
        if hasattr(st, "patch_article_fields"):
            await run_sync(st.patch_article_fields, aid, {"generation_error": err_msg[:500]})
        elif hasattr(st, "update_article_fields"):
            await run_sync(st.update_article_fields, aid, {"generation_error": err_msg[:500]})
    except Exception:
        pass


async def _handle_article_generate(payload: dict) -> None:
    st = get_legacy_storage_module()
    pid = (payload.get("project_id") or "").strip()
    aid = (payload.get("article_id") or "").strip()
    uid = (payload.get("user_id") or "").strip()
    if not pid or not aid or not uid:
        return

    user = await run_sync(st.get_user_by_id, uid) if hasattr(st, "get_user_by_id") else None
    if not isinstance(user, dict):
        users = await run_sync(st.load_users)
        user = next((u for u in (users or []) if isinstance(u, dict) and (u.get("id") or "") == uid), None)
    if not isinstance(user, dict):
        log.warning("article_generate job missing user id=%s", uid)
        return

    proj = await run_sync(_gen_project_reader(st), pid) if hasattr(st, "get_project_by_id") else None
    if not isinstance(proj, dict):
        err = "Project not found — cannot generate article."
        await _persist_article_generation_error(st, aid, err)
        raise RuntimeError(err)

    # Auto-create default prompts so generation doesn't fail with
    # "No writing prompt selected" on projects that were never configured.
    try:
        from app.services.scheduler import _ensure_project_prompt_defaults as _epd
        proj = await _epd(st, pid, proj)
    except Exception:
        pass

    row = await run_sync(st.get_article, project_id=pid, article_id=aid)
    if not isinstance(row, dict):
        err = "Article not found — it may have been deleted."
        await _persist_article_generation_error(st, aid, err)
        raise RuntimeError(err)

    await publish_pipeline_status(aid, MSG_WORKER_START, STAGE_WORKER_START)

    # Clear any previous generation error before starting a fresh attempt.
    try:
        if hasattr(st, "patch_article_fields"):
            await run_sync(st.patch_article_fields, aid, {"generation_error": ""})
    except Exception:
        pass

    try:
        async with generation_slot():
            mapped_products = payload.get("mapped_products")
            mapped_products_list = mapped_products if isinstance(mapped_products, list) else None
            mapped_pages = payload.get("mapped_pages")
            mapped_pages_list = mapped_pages if isinstance(mapped_pages, list) else None

            await execute_article_generation(
                st=st,
                user=user,
                proj=proj,
                project_id=pid,
                article_id=aid,
                row=row,
                writing_prompt_id=payload.get("writing_prompt_id"),
                generate_image=bool(payload.get("generate_image", True)),
                image_prompt_id=payload.get("image_prompt_id"),
                focus_keyphrase_override=payload.get("focus_keyphrase"),
                mapped_products=mapped_products_list,
                mapped_pages=mapped_pages_list,
                humanization_settings=proj.get("humanization_settings"),
                content_optimization_profile=proj.get("content_optimization_profile"),
            )
    except Exception as exc:
        from fastapi import HTTPException as FastAPIHTTPException

        if isinstance(exc, FastAPIHTTPException):
            err_msg = str(exc.detail) if isinstance(exc.detail, str) else "Generation failed."
        else:
            err_msg = str(exc) or "Generation failed — check server logs."
        await _persist_article_generation_error(st, aid, err_msg)
        raise


async def _handle_image_regenerate(payload: dict) -> None:
    st = get_legacy_storage_module()
    pid = (payload.get("project_id") or "").strip()
    aid = (payload.get("article_id") or "").strip()
    uid = (payload.get("user_id") or "").strip()
    if not pid or not aid or not uid:
        return

    user = await run_sync(st.get_user_by_id, uid) if hasattr(st, "get_user_by_id") else None
    if not isinstance(user, dict):
        users = await run_sync(st.load_users)
        user = next((u for u in (users or []) if isinstance(u, dict) and (u.get("id") or "") == uid), None)
    if not isinstance(user, dict):
        return

    proj = await run_sync(_gen_project_reader(st), pid) if hasattr(st, "get_project_by_id") else None
    if not isinstance(proj, dict):
        raise RuntimeError("Project not found")

    row = await run_sync(st.get_article, project_id=pid, article_id=aid)
    if not isinstance(row, dict):
        raise RuntimeError("Article not found")

    await publish_pipeline_status(aid, MSG_WORKER_START, STAGE_WORKER_START)

    # Clear any previous generation error before starting a fresh attempt.
    try:
        if hasattr(st, "patch_article_fields"):
            await run_sync(st.patch_article_fields, aid, {"generation_error": ""})
    except Exception:
        pass

    try:
        async with generation_slot():
            await execute_featured_image_regeneration(
                st=st,
                user=user,
                proj=proj,
                article_id=aid,
                row=row,
                image_prompt_id=payload.get("image_prompt_id"),
                custom_image_prompt=(payload.get("custom_image_prompt") or "").strip() or None,
            )
    except Exception as exc:
        log.exception("Image regeneration failed for article %s", aid)
        detail = getattr(exc, "detail", None)
        if isinstance(detail, dict):
            err_msg = detail.get("message") or str(exc)
        elif isinstance(detail, str):
            err_msg = detail
        else:
            err_msg = str(exc) or "Image regeneration failed. Please try again."
        await publish_pipeline_error(aid, f"Image regeneration failed: {err_msg[:300]}")
        await _persist_article_generation_error(st, aid, err_msg[:500])
        raise


async def _handle_cluster_generate_all(payload: dict) -> None:
    from app.services.topic_cluster_service import TopicClusterService

    st = get_legacy_storage_module()
    pid = (payload.get("project_id") or "").strip()
    cid = (payload.get("cluster_id") or "").strip()
    uid = (payload.get("user_id") or "").strip()
    if not pid or not cid or not uid:
        return

    user = await run_sync(st.get_user_by_id, uid) if hasattr(st, "get_user_by_id") else None
    if not isinstance(user, dict):
        users = await run_sync(st.load_users)
        user = next((u for u in (users or []) if isinstance(u, dict) and (u.get("id") or "") == uid), None)
    if not isinstance(user, dict):
        log.warning("cluster_generate_all missing user id=%s", uid)
        return

    proj = await run_sync(_gen_project_reader(st), pid) if hasattr(st, "get_project_by_id") else None
    if not isinstance(proj, dict):
        raise RuntimeError("Project not found")

    svc = TopicClusterService(project=proj, owner_user_id=uid)
    async with generation_slot():
        await svc.generate_all(
            user=user,
            cluster_id=cid,
            generate_image=bool(payload.get("generate_image", True)),
            writing_prompt_id=(payload.get("writing_prompt_id") or "").strip() or None,
            image_prompt_id=(payload.get("image_prompt_id") or "").strip() or None,
            topic_ids=payload.get("topic_ids"),
            mapped_products=payload.get("mapped_products"),
        )


async def _handle_topic_cluster_plan(payload: dict) -> None:
    from app.services.topic_cluster_service import TopicClusterService

    st = get_legacy_storage_module()
    pid = (payload.get("project_id") or "").strip()
    cid = (payload.get("cluster_id") or "").strip()
    uid = (payload.get("user_id") or "").strip()
    if not pid or not cid or not uid:
        return

    proj = await run_sync(_gen_project_reader(st), pid) if hasattr(st, "get_project_by_id") else None
    if not isinstance(proj, dict):
        await run_sync(
            st.update_topic_cluster_fields,
            cid,
            {"status": "error", "error_message": "Project not found"},
        )
        return

    svc = TopicClusterService(project=proj, owner_user_id=uid)
    try:
        await svc.plan_and_persist_into(
            cluster_id=cid,
            seed_intent=str(payload.get("seed_intent") or ""),
            country_code=str(payload.get("country_code") or "IN"),
            tone=str(payload.get("tone") or "informative"),
            language=str(payload.get("language") or "en"),
        )
    except Exception as e:
        log.exception("Topic cluster plan failed cluster_id=%s", cid)
        if hasattr(st, "update_topic_cluster_fields"):
            await run_sync(
                st.update_topic_cluster_fields,
                cid,
                {"status": "error", "error_message": str(e)[:500]},
            )


async def _handle_scheduled_post_now(payload: dict) -> None:
    from app.services.scheduler import (
        _ensure_project_prompt_defaults,
        _reload_project,
        _reload_scheduled_job,
        _storage,
        execute_scheduled_job_post_now,
        scheduler_error_message,
    )

    st = get_legacy_storage_module()
    jid = (payload.get("job_id") or "").strip()
    pid = (payload.get("project_id") or "").strip()
    aid = (payload.get("article_id") or "").strip()
    if not jid or not pid or not aid:
        return

    dedup = f"postnow:{jid}"
    try:
        proj = await _reload_project(st, pid)
        if not isinstance(proj, dict):
            raise RuntimeError("Project not found")
        proj = await _ensure_project_prompt_defaults(st, pid, proj)

        job = await _reload_scheduled_job(st, pid, jid)
        if not isinstance(job, dict):
            raise RuntimeError("Scheduled job not found")

        state = (job.get("state") or "").strip().lower()
        if state in {"posted", "cancelled"}:
            return

        await execute_scheduled_job_post_now(st=st, proj=proj, job=job, already_claimed=True)
    except Exception as e:
        err = scheduler_error_message(e)
        log.exception("Scheduled post now failed job_id=%s", jid)
        try:
            await _storage(
                st.update_scheduled_job_fields,
                jid,
                {
                    "state": "failed",
                    "last_error": err,
                    "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                },
            )
        except Exception:
            pass
    finally:
        await clear_dedup(dedup)


async def process_generation_job(job: GenerationJob) -> None:
    if job.kind == GenerationJobKind.SCHEDULED_PREP:
        await _handle_scheduled_prep(job.payload)
    elif job.kind == GenerationJobKind.SCHEDULED_POST_NOW:
        await _handle_scheduled_post_now(job.payload)
    elif job.kind == GenerationJobKind.ARTICLE_GENERATE:
        await _handle_article_generate(job.payload)
    elif job.kind == GenerationJobKind.IMAGE_REGENERATE:
        await _handle_image_regenerate(job.payload)
    elif job.kind == GenerationJobKind.CLUSTER_GENERATE_ALL:
        await _handle_cluster_generate_all(job.payload)
    elif job.kind == GenerationJobKind.TOPIC_CLUSTER_PLAN:
        await _handle_topic_cluster_plan(job.payload)
    elif job.kind == GenerationJobKind.RESEARCH_IDEAS:
        await _handle_research_ideas(job.payload)
    else:
        log.warning("Unknown generation job kind: %s", job.kind)


async def _handle_research_ideas(payload: dict) -> None:
    from app.services.research_job_runner import run_research_ideas_job

    await run_research_ideas_job(payload)


async def generation_worker_loop() -> None:
    poll = max(0.1, float(settings.generation_worker_poll_seconds or 0.5))
    log.info(
        "Generation worker started (max_concurrent=%s, redis=%s)",
        settings.max_concurrent_generations,
        (settings.redis_url or "").strip() or "default",
    )
    import structlog

    while True:
        try:
            job = await dequeue_blocking(timeout_seconds=poll)
            try:
                set_queue_depth(await queue_depth())
            except Exception:
                pass
            if job is None:
                continue
            # I5.3: bind a correlation id so worker logs can be matched to the
            # request/article that enqueued the job.
            structlog.contextvars.bind_contextvars(job_id=job.id, job_kind=str(job.kind))
            try:
                await process_generation_job(job)
            except Exception:
                log.exception("Generation job failed id=%s kind=%s", job.id, job.kind)
            finally:
                structlog.contextvars.unbind_contextvars("job_id", "job_kind")
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Generation worker loop error")
            await asyncio.sleep(1.0)


def start_generation_worker() -> asyncio.Task:
    global _worker_task
    if _worker_task is not None and not _worker_task.done():
        return _worker_task
    _worker_task = asyncio.create_task(generation_worker_loop())
    return _worker_task


async def stop_generation_worker() -> None:
    global _worker_task
    if _worker_task:
        _worker_task.cancel()
        try:
            await _worker_task
        except asyncio.CancelledError:
            pass
        _worker_task = None
    await close_redis()


def enqueue_scheduled_post_now(*, job_id: str, project_id: str, article_id: str) -> None:
    """Fire-and-forget enqueue for Post Now (generate + publish)."""
    from app.services.generation_queue import GenerationJob, GenerationJobKind, enqueue

    job = GenerationJob(
        kind=GenerationJobKind.SCHEDULED_POST_NOW,
        payload={
            "job_id": job_id,
            "project_id": project_id,
            "article_id": article_id,
        },
    )

    async def _put() -> None:
        try:
            await enqueue(job, dedup_key=f"postnow:{job_id}")
        except Exception:
            log.exception("Failed to enqueue scheduled post now job_id=%s", job_id)

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_put())
    except RuntimeError:
        asyncio.run(_put())


def enqueue_scheduled_prep(*, job_id: str, project_id: str, article_id: str) -> None:
    """Fire-and-forget enqueue (safe from sync or async contexts)."""
    from app.services.generation_queue import GenerationJob, GenerationJobKind, enqueue

    job = GenerationJob(
        kind=GenerationJobKind.SCHEDULED_PREP,
        payload={
            "job_id": job_id,
            "project_id": project_id,
            "article_id": article_id,
        },
    )

    async def _put() -> None:
        try:
            await enqueue(job, dedup_key=f"prep:{job_id}")
        except Exception:
            log.exception("Failed to enqueue scheduled prep job_id=%s", job_id)

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_put())
    except RuntimeError:
        asyncio.run(_put())
