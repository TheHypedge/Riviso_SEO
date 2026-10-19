import asyncio
from datetime import datetime, timedelta, timezone

from app.services import scheduler

NOW = datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc)


def _fmt(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S")


class _St:
    def __init__(self, jobs):
        self.jobs, self.updates = jobs, {}

    def load_scheduled_jobs(self, project_id=None, limit=500):
        return self.jobs

    def update_scheduled_job_fields(self, jid, u):
        self.updates[jid] = u


def _run(jobs):
    st = _St(jobs)
    asyncio.run(scheduler._heal_premature_generating_jobs(st=st, now=NOW))
    return st.updates


def test_abandoned_prep_for_due_job_is_reset():
    jobs = [{"id": "j1", "state": "content_generating", "run_at": _fmt(NOW - timedelta(hours=12)), "updated_at": _fmt(NOW - timedelta(hours=12))}]
    assert _run(jobs)["j1"]["state"] == "scheduled"


def test_prep_still_running_is_left_alone():
    jobs = [{"id": "j2", "state": "image_generating", "run_at": _fmt(NOW + timedelta(minutes=5)), "updated_at": _fmt(NOW - timedelta(minutes=10))}]
    assert _run(jobs) == {}


def test_far_future_generating_job_still_reset_and_other_states_ignored():
    jobs = [
        {"id": "j3", "state": "content_generating", "run_at": _fmt(NOW + timedelta(days=3)), "updated_at": _fmt(NOW)},
        {"id": "j4", "state": "scheduled", "run_at": _fmt(NOW - timedelta(hours=1)), "updated_at": _fmt(NOW - timedelta(hours=5))},
        {"id": "j5", "state": "content_generating", "run_at": _fmt(NOW), "updated_at": ""},
    ]
    assert set(_run(jobs)) == {"j3"}
