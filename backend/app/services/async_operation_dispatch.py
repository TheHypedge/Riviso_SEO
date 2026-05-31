"""Fire-and-forget dispatch for long-running API operations."""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from app.core.config import settings
from app.services.generation_queue import GenerationJob, GenerationJobKind, clear_dedup, enqueue

log = logging.getLogger(__name__)


def _fire_enqueue(job: GenerationJob, *, dedup_key: str) -> str:
    async def _put() -> None:
        try:
            await enqueue(job, dedup_key=dedup_key)
        except Exception:
            log.exception("Failed to enqueue job kind=%s id=%s", job.kind, job.id)
            await clear_dedup(dedup_key)

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_put())
    except RuntimeError:
        asyncio.run(_put())
    return job.id


def enqueue_article_generation_job(
    *,
    project_id: str,
    article_id: str,
    user_id: str,
    payload: dict[str, Any],
) -> str:
    job = GenerationJob(
        kind=GenerationJobKind.ARTICLE_GENERATE,
        payload={
            "project_id": project_id,
            "article_id": article_id,
            "user_id": user_id,
            **payload,
        },
    )
    return _fire_enqueue(job, dedup_key=f"gen:{project_id}:{article_id}")


def enqueue_image_regeneration_job(
    *,
    project_id: str,
    article_id: str,
    user_id: str,
    payload: dict[str, Any],
) -> str:
    job = GenerationJob(
        kind=GenerationJobKind.IMAGE_REGENERATE,
        payload={
            "project_id": project_id,
            "article_id": article_id,
            "user_id": user_id,
            **payload,
        },
    )
    return _fire_enqueue(job, dedup_key=f"img:{project_id}:{article_id}")


def enqueue_cluster_generate_all_job(
    *,
    project_id: str,
    cluster_id: str,
    user_id: str,
    payload: dict[str, Any],
) -> str:
    job = GenerationJob(
        kind=GenerationJobKind.CLUSTER_GENERATE_ALL,
        payload={
            "project_id": project_id,
            "cluster_id": cluster_id,
            "user_id": user_id,
            **payload,
        },
    )
    return _fire_enqueue(job, dedup_key=f"cluster_gen:{project_id}:{cluster_id}")


def enqueue_topic_cluster_plan_job(
    *,
    project_id: str,
    cluster_id: str,
    user_id: str,
    payload: dict[str, Any],
) -> str:
    job = GenerationJob(
        kind=GenerationJobKind.TOPIC_CLUSTER_PLAN,
        payload={
            "project_id": project_id,
            "cluster_id": cluster_id,
            "user_id": user_id,
            **payload,
        },
    )
    return _fire_enqueue(job, dedup_key=f"cluster_plan:{project_id}:{cluster_id}")


def enqueue_research_ideas_job(
    *,
    project_id: str,
    user_id: str,
    cache_key: str,
    payload: dict[str, Any],
) -> str:
    job = GenerationJob(
        kind=GenerationJobKind.RESEARCH_IDEAS,
        payload={
            "project_id": project_id,
            "user_id": user_id,
            "cache_key": cache_key,
            **payload,
        },
    )
    return _fire_enqueue(job, dedup_key=f"research:{project_id}:{cache_key}")


def new_cluster_plan_id() -> str:
    return f"tc_{uuid.uuid4().hex[:14]}"


def should_use_async_queue() -> bool:
    return bool(settings.generation_queue_enabled)
