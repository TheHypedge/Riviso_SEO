"""Regression: re-scheduling a job without sending inner_image_count must keep the
job's saved count. The schedule request used to default it to 0 and $set that onto the
job, so changing only the date silently dropped the user's inner images."""

from __future__ import annotations

import asyncio
import os

os.environ.setdefault("FORCE_JSON_STORAGE", "1")
os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")
os.environ.setdefault("ENVIRONMENT", "test")

from app.api.routes.articles import _persist_schedule_row
from app.schemas.articles import ScheduleRequest


class _FakeStorage:
    def __init__(self, saved_inner: int | None) -> None:
        self.jobs = [] if saved_inner is None else [{"id": "job_1", "state": "scheduled", "inner_image_count": saved_inner}]
        self.written: dict = {}

    def patch_article_fields(self, article_id, fields):
        return True

    def load_scheduled_jobs(self, **_kw):
        return self.jobs

    def update_scheduled_job_fields(self, job_id, fields):
        if not self.jobs:
            return False
        self.written = fields
        return True

    def insert_scheduled_job(self, row):
        self.written = row


def _persist(st, inner_image_count):
    return asyncio.run(
        _persist_schedule_row(
            st=st, project_id="p1", article_id="a1", article={}, proj={}, norm_utc="2026-11-01 08:00:00",
            wp_status="draft", post_type="posts", writing_prompt_id="", image_prompt_id="",
            generate_image=True, enqueue_preparation=False, inner_image_count=inner_image_count,
        )
    )


def test_request_omitting_count_means_keep() -> None:
    assert ScheduleRequest(wp_scheduled_at="2026-11-01 08:00").inner_image_count is None


def test_reschedule_without_count_keeps_saved_value() -> None:
    st = _FakeStorage(saved_inner=4)
    _persist(st, None)
    assert st.written["inner_image_count"] == 4


def test_explicit_count_overrides_saved_value() -> None:
    st = _FakeStorage(saved_inner=4)
    _persist(st, 2)
    assert st.written["inner_image_count"] == 2


def test_new_job_without_count_defaults_to_zero() -> None:
    st = _FakeStorage(saved_inner=None)
    _persist(st, None)
    assert st.written["inner_image_count"] == 0
