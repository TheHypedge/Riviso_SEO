"""Redis pub/sub pipeline status streaming for live article generation UI."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, AsyncIterator

from app.services.generation_queue import get_async_redis

log = logging.getLogger(__name__)

PIPELINE_CHANNEL_PREFIX = "channel:article:"

# Canonical stage keys
STAGE_CONNECTED = "connected"
STAGE_WORKER_START = "worker_start"
STAGE_INTERNAL_LINKS = "internal_links"
STAGE_OPENAI_DISPATCH = "openai_dispatch"
STAGE_INTEGRITY_VERIFY = "integrity_verify"
STAGE_HUMANIZATION = "humanization"
STAGE_FEATURED_IMAGE = "featured_image"
STAGE_PUBLISH_DISPATCH = "publish_dispatch"
STAGE_COMPLETE = "complete"
STAGE_ERROR = "error"

MSG_OPENAI = "🛰️ Dispatched asynchronous generation bundle token to OpenAI..."
MSG_INTEGRITY = "🛡️ Content received. Initializing integrity verification engine..."
MSG_HUMANIZE = "🧬 Running structural humanization pass (Analyzing sentence rhythm complexity)..."
MSG_INTERNAL_LINKS = "🔗 Scanning site-map cache. Automatically injecting localized internal anchors..."
MSG_FEATURED_IMAGE = "🎨 Rendering branded featured image reference from catalog asset..."
MSG_PUBLISH_COMPLETE = "✨ Complete! Post successfully queued and published to store blog."
MSG_GENERATION_COMPLETE = "✨ Complete! Article generation pipeline finished — draft saved."
MSG_PUBLISH_DISPATCH = "📤 Dispatching live publish to connected CMS..."
MSG_WORKER_START = "⚡ Background worker claimed job — starting pipeline..."


def pipeline_channel(article_id: str) -> str:
    aid = (article_id or "").strip()
    return f"{PIPELINE_CHANNEL_PREFIX}{aid}:stream"


def _utc_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def format_pipeline_event(*, message: str, stage: str, time: str | None = None) -> dict[str, str]:
    return {
        "time": time or _utc_iso(),
        "message": (message or "").strip(),
        "stage": (stage or "").strip(),
    }


def format_sse_payload(data: dict[str, Any]) -> str:
    body = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    return f"data: {body}\n\n"


async def publish_pipeline_status(article_id: str, status_message: str, current_stage: str) -> None:
    """
    Publish a timestamped pipeline log line to the article's Redis channel.
    Best-effort: never raises (workers must not fail on stream outages).
    """
    aid = (article_id or "").strip()
    if not aid:
        return
    event = format_pipeline_event(message=status_message, stage=current_stage)
    payload = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
    r = get_async_redis()
    if r is None:
        return
    try:
        await r.publish(pipeline_channel(aid), payload)
    except Exception:
        log.debug("publish_pipeline_status failed article_id=%s stage=%s", aid, current_stage, exc_info=True)


async def publish_pipeline_error(article_id: str, status_message: str) -> None:
    await publish_pipeline_status(article_id, status_message, STAGE_ERROR)


async def pipeline_event_stream(
    article_id: str,
    *,
    request: Any | None = None,
    heartbeat_seconds: float = 15.0,
) -> AsyncIterator[str]:
    """
    Async generator yielding SSE frames from Redis pub/sub for one article.

    Unsubscribes and closes pubsub in ``finally``; exits when the client disconnects.
    """
    aid = (article_id or "").strip()
    channel = pipeline_channel(aid)
    r = get_async_redis()
    if r is None:
        # Redis not configured — emit a connected event so the frontend overlay
        # opens, then keep the stream alive with heartbeats. The frontend's
        # polling loop (generation-status endpoint) will detect completion or
        # error via has_body / generation_error fields without needing pub/sub.
        yield format_sse_payload(
            format_pipeline_event(
                message="Live pipeline stream connected.",
                stage=STAGE_CONNECTED,
            )
        )
        while True:
            if request is not None:
                try:
                    disconnected = await request.is_disconnected()
                except Exception:
                    disconnected = False
                if disconnected:
                    return
            await asyncio.sleep(heartbeat_seconds)
            yield ": heartbeat\n\n"
        return

    pubsub = r.pubsub()
    last_heartbeat = time.monotonic()
    try:
        await pubsub.subscribe(channel)
        yield format_sse_payload(
            format_pipeline_event(
                message="Live pipeline stream connected.",
                stage=STAGE_CONNECTED,
            )
        )

        while True:
            if request is not None:
                try:
                    disconnected = await request.is_disconnected()
                except Exception:
                    disconnected = False
                if disconnected:
                    break

            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if msg and msg.get("type") == "message":
                raw = msg.get("data")
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", errors="replace")
                if isinstance(raw, str) and raw.strip():
                    try:
                        parsed = json.loads(raw)
                        if isinstance(parsed, dict):
                            yield format_sse_payload(parsed)
                        else:
                            yield f"data: {raw.strip()}\n\n"
                    except json.JSONDecodeError:
                        yield f"data: {raw.strip()}\n\n"
                    last_heartbeat = time.monotonic()
                    continue

            now = time.monotonic()
            if heartbeat_seconds > 0 and (now - last_heartbeat) >= heartbeat_seconds:
                yield ": ping\n\n"
                last_heartbeat = now

            await asyncio.sleep(0)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        log.debug("pipeline_event_stream error article_id=%s", aid, exc_info=True)
        yield format_sse_payload(
            format_pipeline_event(
                message=f"Stream interrupted: {exc}",
                stage=STAGE_ERROR,
            )
        )
    finally:
        try:
            await pubsub.unsubscribe(channel)
        except Exception:
            pass
        try:
            await pubsub.aclose()
        except Exception:
            pass
