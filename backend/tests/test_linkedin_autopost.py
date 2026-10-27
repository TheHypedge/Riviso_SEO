"""LinkedIn auto-post: an article going live queues one caption-less LinkedIn job N minutes
later -- only when enabled and connected, never twice, never breaking the publish."""

import asyncio
import os
from datetime import datetime, timedelta

os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")

import pytest
from fastapi import HTTPException

import app.api.routes.project_linkedin as pl
from app.services import linkedin_autopost as auto

PROJ = {
    "id": "p1",
    "linkedin_access_token": "tok",
    "linkedin_person_urn": "urn:li:person:x",
    "linkedin_auto_post_enabled": True,
    "linkedin_auto_post_delay_minutes": 60,
}


class FakeSt:
    def __init__(self, article=None, jobs=None):
        self.article = article if article is not None else {"id": "a1"}
        self.jobs = jobs or []
        self.inserted: list[dict] = []
        self.project_updates: list[dict] = []

    def get_article(self, *, project_id, article_id):
        return self.article

    def load_scheduled_jobs(self, project_id=None):
        return list(self.jobs)

    def insert_scheduled_job(self, doc):
        self.inserted.append(doc)

    def update_project_fields(self, pid, fields):
        self.project_updates.append(fields)
        return True


def _run(st, proj=PROJ):
    return asyncio.run(auto.schedule_after_publish(st=st, proj=proj, article_id="a1"))


def test_queues_caption_less_linkedin_job_after_the_delay():
    st = FakeSt()
    before = datetime.utcnow()
    assert _run(st)
    job = st.inserted[0]
    assert job["platform"] == "linkedin" and job["article_id"] == "a1" and job["state"] == "scheduled"
    assert job["linkedin_commentary"] == ""  # scheduler writes the caption at run time
    run_at = datetime.strptime(job["run_at"], "%Y-%m-%d %H:%M:%S")
    assert timedelta(minutes=59) <= run_at - before <= timedelta(minutes=61)


@pytest.mark.parametrize(
    "proj",
    [
        {**PROJ, "linkedin_auto_post_enabled": False},
        {**PROJ, "linkedin_access_token": ""},
        {**PROJ, "linkedin_person_urn": "", "linkedin_selected_author_urn": ""},
    ],
)
def test_nothing_queued_when_off_or_not_connected(proj):
    st = FakeSt()
    assert _run(st, proj) is None and st.inserted == []


def test_never_twice_for_shared_or_already_queued_articles():
    shared = FakeSt(article={"id": "a1", "linkedin_post_urn": "urn:li:share:1"})
    assert _run(shared) is None and shared.inserted == []
    queued = FakeSt(jobs=[{"platform": "linkedin", "article_id": "a1", "state": "scheduled"}])
    assert _run(queued) is None and queued.inserted == []
    done = FakeSt(jobs=[{"platform": "linkedin", "article_id": "a1", "state": "failed"}])
    assert _run(done)  # a failed earlier attempt doesn't block a new one


def test_unknown_delay_falls_back_to_default_and_errors_never_raise():
    assert auto.auto_post_settings({**PROJ, "linkedin_auto_post_delay_minutes": 7}) == (True, auto.DEFAULT_DELAY_MIN)

    class Boom(FakeSt):
        def insert_scheduled_job(self, doc):
            raise RuntimeError("db down")

    assert _run(Boom()) is None


def _settings(monkeypatch, proj, **body):
    st = FakeSt()
    monkeypatch.setattr(pl, "get_legacy_storage_module", lambda: st)
    monkeypatch.setattr(pl, "_require_project", lambda **_k: proj)
    out = asyncio.run(pl.linkedin_settings("p1", pl.LinkedInSettingsRequest(**body), user={"id": "u"}))
    return out, st


def test_settings_saves_valid_choice(monkeypatch):
    out, st = _settings(monkeypatch, PROJ, auto_post_enabled=True, auto_post_delay_minutes=1440)
    assert out["auto_post_delay_minutes"] == 1440
    assert st.project_updates == [{"linkedin_auto_post_enabled": True, "linkedin_auto_post_delay_minutes": 1440}]


def test_settings_rejects_bad_delay_and_disconnected_enable(monkeypatch):
    with pytest.raises(HTTPException):
        _settings(monkeypatch, PROJ, auto_post_enabled=True, auto_post_delay_minutes=2)
    with pytest.raises(HTTPException):
        _settings(monkeypatch, {**PROJ, "linkedin_access_token": ""}, auto_post_enabled=True, auto_post_delay_minutes=30)
