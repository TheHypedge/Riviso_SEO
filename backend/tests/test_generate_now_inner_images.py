"""Generate-now (Research ideas, Topic clusters, editor) now supports inner images.

Before, only scheduled jobs added them. The count must reach execute_article_generation
from the queued payload, and the images must land in the SAME save as the generated
content -- otherwise the UI sees the article as done before its images exist.
All OpenAI/storage work is faked.
"""

from __future__ import annotations

import asyncio

import pytest

import app.services.article_pipeline as pipeline
import app.services.generation_worker as worker
import app.services.inner_images as inner_images
import app.services.scheduler as scheduler
from app.api.routes.project_topic_cluster import TopicClusterGenerateAllPayload
from app.schemas.articles import GenerateRequest

PROJ = {"id": "p1", "default_prompt_id": "w1", "prompts": [{"id": "w1", "name": "W", "text": "Write an article."}]}
BODY = "# T\n\n## Costs\n\nFees start at $500.\n\n## Process\n\nFile, then wait."


class _Storage:
    def __init__(self):
        self.saves: list[dict] = []

    def get_user_by_id(self, uid):
        return {"id": uid, "role": "admin"}

    def get_project_by_id(self, pid):
        return {"id": pid, "name": "P"}

    def get_article(self, *, project_id, article_id):
        return {"id": article_id, "project_id": project_id, "title": "T", "keywords": ["k"], "status": "pending"}

    def patch_article_fields(self, aid, fields):
        self.saves.append(dict(fields))
        return True


async def _noop(*a, **kw):
    return None


def test_request_schemas_accept_and_bound_the_count():
    assert GenerateRequest().inner_image_count == 0
    assert GenerateRequest(inner_image_count=3).inner_image_count == 3
    assert TopicClusterGenerateAllPayload(inner_image_count=2).inner_image_count == 2
    with pytest.raises(Exception):
        GenerateRequest(inner_image_count=6)


@pytest.mark.parametrize("sent, expected", [(3, 3), (9, 5), (None, 0)])
def test_worker_passes_count_to_generation(monkeypatch, sent, expected):
    seen = {}

    async def fake_execute(**kw):
        seen.update(kw)
        return {}

    async def same_proj(st, pid, proj):
        return proj

    monkeypatch.setattr(worker, "get_legacy_storage_module", _Storage)
    monkeypatch.setattr(worker, "execute_article_generation", fake_execute)
    monkeypatch.setattr(worker, "publish_pipeline_status", _noop)
    monkeypatch.setattr(worker, "clear_dedup", _noop)
    monkeypatch.setattr(scheduler, "_ensure_project_prompt_defaults", same_proj)

    payload = {"project_id": "p1", "article_id": "a1", "user_id": "u1", "generate_image": False}
    if sent is not None:
        payload["inner_image_count"] = sent
    asyncio.run(worker._handle_article_generate(payload))
    assert seen["inner_image_count"] == expected


def test_inner_images_are_saved_with_the_generated_content(monkeypatch):
    st = _Storage()
    placed = {}

    async def fake_bundle(**kw):
        return {"article": BODY, "meta_title": "M", "meta_description": "D", "generated_at": "2026-10-27 10:00:00", "image_url": ""}

    async def fake_build(**kw):
        placed.update(kw)
        return kw["markdown"] + '\n\n<img src="https://img.test/c.png" alt="chart">', 1

    monkeypatch.setattr(pipeline, "generate_article_bundle_safe", fake_bundle)
    monkeypatch.setattr(pipeline, "publish_pipeline_status", _noop)
    monkeypatch.setattr(inner_images, "build_inner_images", fake_build)

    asyncio.run(
        pipeline.execute_article_generation(
            st=st, user={"id": "u1", "role": "admin"}, proj=PROJ, project_id="p1", article_id="a1",
            row=st.get_article(project_id="p1", article_id="a1"), writing_prompt_id=None, generate_image=False,
            inner_image_count=2,
        )
    )
    assert placed["count"] == 2 and placed["markdown"].startswith("# T")
    content_saves = [s for s in st.saves if "article" in s]
    assert len(content_saves) == 1
    assert '<img src="https://img.test/c.png"' in content_saves[0]["article"]
    assert content_saves[0]["generated_at"] == "2026-10-27 10:00:00"


def test_no_inner_images_requested_skips_them(monkeypatch):
    st = _Storage()

    async def fake_bundle(**kw):
        return {"article": BODY, "meta_title": "M", "meta_description": "D", "generated_at": "2026-10-27 10:00:00", "image_url": ""}

    async def must_not_run(**kw):
        raise AssertionError("inner images must not run for count=0")

    monkeypatch.setattr(pipeline, "generate_article_bundle_safe", fake_bundle)
    monkeypatch.setattr(pipeline, "publish_pipeline_status", _noop)
    monkeypatch.setattr(inner_images, "build_inner_images", must_not_run)

    asyncio.run(
        pipeline.execute_article_generation(
            st=st, user={"id": "u1", "role": "admin"}, proj=PROJ, project_id="p1", article_id="a1",
            row=st.get_article(project_id="p1", article_id="a1"), writing_prompt_id=None, generate_image=False,
        )
    )
    assert "<img" not in [s for s in st.saves if "article" in s][0]["article"]
