"""Post Now / publish quota: charged once per real publish, against the plan governing the project."""

import asyncio
import os
from datetime import datetime, timezone

os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")

import pytest
from fastapi import HTTPException

import app.api.routes.scheduled_jobs as sj
from app.services.plan_gatekeeper import consume_article_quota_for_project


class FakeSt:
    def __init__(self, *, owner="owner", job_state="scheduled", allow=True):
        self.charged: list[str] = []
        self.owner = owner
        self.allow = allow
        self.job = {"id": "j1", "project_id": "p1", "article_id": "a1", "state": job_state,
                    "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")}
        self.job_updates: list[dict] = []

    # plan resolution
    def get_project_member_context(self, pid, uid):
        return {"is_owner": uid == self.owner, "owner_user_id": self.owner}

    def get_user_by_id(self, uid):
        return {"id": uid, "subscription_type": "pro"}

    def load_plans(self):
        return {"pro": {"max_articles_per_day": 5}, "beta": {"max_articles_per_day": 1}}

    def consume_article_usage(self, uid, *, day_limit, month_limit, amount):
        if not self.allow:
            return False, "Daily limit reached"
        self.charged.append(f"{uid}:{day_limit}")
        return True, ""

    # Post Now storage surface
    def load_scheduled_jobs(self, project_id=None):
        return [dict(self.job)]

    def update_scheduled_job_fields(self, jid, fields):
        self.job_updates.append(dict(fields))
        return True


def test_owner_is_charged_on_own_plan():
    st = FakeSt()
    consume_article_quota_for_project(st, {"id": "owner", "subscription_type": "pro"}, "p1")
    assert st.charged == ["owner:5"]


def test_collaborator_publish_charges_the_owner():
    st = FakeSt()
    consume_article_quota_for_project(st, {"id": "collab", "subscription_type": "beta"}, "p1")
    assert st.charged == ["owner:5"]


def test_admin_is_never_charged():
    st = FakeSt()
    consume_article_quota_for_project(st, {"id": "x", "role": "admin"}, "p1")
    assert st.charged == []


def test_limit_reached_is_403():
    with pytest.raises(HTTPException) as e:
        consume_article_quota_for_project(FakeSt(allow=False), {"id": "owner"}, "p1")
    assert e.value.status_code == 403


def _post_now(monkeypatch, st):
    async def access(**_k):
        return {"id": "p1", "wp_verified_status": "connected"}

    monkeypatch.setattr(sj, "get_legacy_storage_module", lambda: st)
    monkeypatch.setattr(sj, "_require_project_access", access)
    monkeypatch.setattr(sj, "_require_verified_website", lambda proj: None)
    monkeypatch.setattr(sj, "_find_article_for_job", lambda **_k: {"article": "body"})
    started: list = []
    monkeypatch.setattr(sj, "start_scheduled_job_post_now_task", lambda **k: started.append(k))
    import app.api.routes.prompts as pr
    import app.api.routes.image_prompts as ip

    monkeypatch.setattr(pr, "_ensure_default_prompt", lambda **k: k["proj"])
    monkeypatch.setattr(ip, "_ensure_default_image_prompt", lambda **k: k["proj"])
    out = asyncio.run(sj.post_scheduled_job_now(project_id="p1", job_id="j1", payload=None, user={"id": "owner", "subscription_type": "pro"}))
    return out, started


def test_post_now_charges_once_and_starts_publish(monkeypatch):
    st = FakeSt()
    out, started = _post_now(monkeypatch, st)
    assert st.charged == ["owner:5"] and len(started) == 1 and out["ok"]


def test_double_click_while_posting_is_not_charged_again(monkeypatch):
    st = FakeSt(job_state="posting")
    out, started = _post_now(monkeypatch, st)
    assert st.charged == [] and started == [] and out["status"] == "posting"
