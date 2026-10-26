"""Regression: retrying a failed scheduled job must still add its inner images.

Jobs that failed while gpt-image-1 was dead had their content saved but no images. A
retry only re-ran the featured image (inner images were added only on fresh content),
so the requested inner images were lost for good. Every expensive step is mocked here.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

import app.services.article_pipeline as pipeline
import app.services.inner_images as inner_images
import app.services.scheduler as scheduler

BODY = "# T\n\n## Section\n\nText."
PROJ = {"id": "p1", "wp_verified_status": "connected"}


@pytest.fixture()
def calls(monkeypatch):
    log: list = []

    async def generate(**kw):
        log.append("generate")
        return {"generated": {"article": BODY}}

    async def featured(**kw):
        log.append("featured")

    async def inner(**kw):
        log.append(("inner", kw["count"], kw["markdown"]))
        return kw["count"]

    async def passthrough_proj(st, pid, proj):
        return proj

    async def noop(*a, **kw):
        return None

    async def owner(st, proj):
        return {"id": "u1"}

    monkeypatch.setattr(pipeline, "execute_article_generation", generate)
    monkeypatch.setattr(pipeline, "execute_featured_image_regeneration", featured)
    monkeypatch.setattr(inner_images, "add_inner_images", inner)
    monkeypatch.setattr(scheduler, "_ensure_project_prompt_defaults", passthrough_proj)
    monkeypatch.setattr(scheduler, "_patch_scheduled_job", noop)
    monkeypatch.setattr(scheduler, "_owner_user_dict", owner)
    monkeypatch.setattr(scheduler, "_load_article_row", noop)
    return log


def _prep(art: dict, inner_count: int = 2):
    job = {"project_id": "p1", "generate_image": True, "inner_image_count": inner_count}
    return asyncio.run(scheduler.prepare_article_for_scheduled_job(st=object(), jid="j1", proj=PROJ, art={"id": "a1", **art}, job=job))


def test_retry_adds_inner_images_before_featured(calls):
    _prep({"article": BODY, "image_url": ""})
    assert calls == [("inner", 2, BODY), "featured"]


def test_retry_with_existing_images_does_not_stack(calls):
    _prep({"article": BODY + '\n\n<img src="x.png" alt="">', "image_url": "https://img.test/f.png"})
    assert calls == []


def test_fresh_generation_adds_inner_images_to_new_body(calls):
    _prep({"article": "", "image_url": ""})
    assert calls == ["generate", ("inner", 2, BODY)]


def test_no_inner_requested_only_retries_featured(calls):
    _prep({"article": BODY, "image_url": ""}, inner_count=0)
    assert calls == ["featured"]


def test_featured_failure_keeps_inner_images(calls, monkeypatch):
    async def failing_featured(**kw):
        raise HTTPException(status_code=502, detail="image model down")

    monkeypatch.setattr(pipeline, "execute_featured_image_regeneration", failing_featured)
    with pytest.raises(RuntimeError, match="image model down"):
        _prep({"article": BODY, "image_url": ""})
    assert calls == [("inner", 2, BODY)]
