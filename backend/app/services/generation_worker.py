"""
In-process worker that drains the generation queue with bounded concurrency.

Run one worker per API process (default on via ENABLE_GENERATION_WORKER=1).
For multiple uvicorn workers, Redis shares the queue; each process runs its own consumer.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime

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
    close_redis,
)
from app.services.scheduler import prepare_article_for_scheduled_job, scheduler_error_message
from app.services.to_thread import run_sync

log = logging.getLogger(__name__)

_worker_task: asyncio.Task | None = None


async def _handle_scheduled_prep(payload: dict) -> None:
    st = get_legacy_storage_module()
    jid = (payload.get("job_id") or "").strip()
    pid = (payload.get("project_id") or "").strip()
    aid = (payload.get("article_id") or "").strip()
    if not jid or not pid or not aid:
        return

    dedup = f"prep:{jid}"
    try:
        proj = await run_sync(st.get_project_by_id, pid) if hasattr(st, "get_project_by_id") else None
        if not isinstance(proj, dict):
            prows = await run_sync(st.load_projects)
            proj = next((p for p in (prows or []) if isinstance(p, dict) and (p.get("id") or "") == pid), None)
        if not isinstance(proj, dict):
            raise RuntimeError("Project not found")

        art = await run_sync(st.get_article, project_id=pid, article_id=aid)
        if not isinstance(art, dict):
            raise RuntimeError("Article not found")

        jobs = await run_sync(st.load_scheduled_jobs, project_id=pid, article_id=aid)
        job = next((j for j in (jobs or []) if isinstance(j, dict) and (j.get("id") or "").strip() == jid), None)
        if not isinstance(job, dict):
            job = {"id": jid, "project_id": pid, "article_id": aid}

        state = (job.get("state") or "").strip().lower()
        if state in {"ready_to_post", "posted", "posting"}:
            return

        await run_sync(
            st.update_scheduled_job_fields,
            jid,
            {
                "state": "content_generating",
                "last_error": "",
                "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
            },
        )

        async with generation_slot():
            await prepare_article_for_scheduled_job(st=st, jid=jid, proj=proj, art=art, job=job)

        await run_sync(
            st.update_scheduled_job_fields,
            jid,
            {
                "state": "ready_to_post",
                "last_error": "",
                "updated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
            },
        )
    except Exception as e:
        err = scheduler_error_message(e)
        log.exception("Scheduled prep failed job_id=%s", jid)
        try:
            await run_sync(
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

    proj = await run_sync(st.get_project_by_id, pid) if hasattr(st, "get_project_by_id") else None
    if not isinstance(proj, dict):
        raise RuntimeError("Project not found")

    row = await run_sync(st.get_article, project_id=pid, article_id=aid)
    if not isinstance(row, dict):
        raise RuntimeError("Article not found")

    async with generation_slot():
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
        )


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

    proj = await run_sync(st.get_project_by_id, pid) if hasattr(st, "get_project_by_id") else None
    if not isinstance(proj, dict):
        raise RuntimeError("Project not found")

    row = await run_sync(st.get_article, project_id=pid, article_id=aid)
    if not isinstance(row, dict):
        raise RuntimeError("Article not found")

    async with generation_slot():
        await execute_featured_image_regeneration(
            st=st,
            user=user,
            proj=proj,
            article_id=aid,
            row=row,
            image_prompt_id=payload.get("image_prompt_id"),
        )


async def process_generation_job(job: GenerationJob) -> None:
    if job.kind == GenerationJobKind.SCHEDULED_PREP:
        await _handle_scheduled_prep(job.payload)
    elif job.kind == GenerationJobKind.ARTICLE_GENERATE:
        await _handle_article_generate(job.payload)
    elif job.kind == GenerationJobKind.IMAGE_REGENERATE:
        await _handle_image_regenerate(job.payload)
    else:
        log.warning("Unknown generation job kind: %s", job.kind)


async def generation_worker_loop() -> None:
    poll = max(0.1, float(settings.generation_worker_poll_seconds or 0.5))
    log.info(
        "Generation worker started (max_concurrent=%s, redis=%s)",
        settings.max_concurrent_generations,
        (settings.redis_url or "").strip() or "default",
    )
    while True:
        try:
            job = await dequeue_blocking(timeout_seconds=poll)
            if job is None:
                continue
            try:
                await process_generation_job(job)
            except Exception:
                log.exception("Generation job failed id=%s kind=%s", job.id, job.kind)
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
