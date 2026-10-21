"""Regression: inner_image_count must survive the scheduled-job storage shape.

_normalize_scheduled_job_dict is both the write and the read shape for scheduled jobs.
inner_image_count was missing from it, so it was dropped on save and on every reload --
the worker (which reloads the job) always saw 0 and never added inner images."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import storage as storage_module  # noqa: E402

BASE = {"id": "job_1", "project_id": "p1", "article_id": "a1", "run_at": "2026-10-21 08:10:00"}


def test_normalize_keeps_and_clamps_inner_image_count():
    norm = storage_module._normalize_scheduled_job_dict
    assert norm({**BASE, "inner_image_count": 2})["inner_image_count"] == 2
    assert norm({**BASE, "inner_image_count": 9})["inner_image_count"] == 5
    assert norm({**BASE, "inner_image_count": -3})["inner_image_count"] == 0
    assert norm({**BASE, "inner_image_count": "x"})["inner_image_count"] == 0
    assert norm(BASE)["inner_image_count"] == 0  # jobs stored before the field existed


def test_insert_update_and_reload_keep_inner_image_count(tmp_path, monkeypatch):
    monkeypatch.setattr(storage_module, "_storage_mode", "json")
    monkeypatch.setattr(storage_module, "_data_path", lambda name: str(tmp_path / name))

    storage_module.insert_scheduled_job({**BASE, "inner_image_count": 2, "created_at": "2026-10-21 08:00:16"})
    # What the generation worker does before preparing the article:
    jobs = storage_module.load_scheduled_jobs(project_id="p1", article_id="a1")
    assert [j["inner_image_count"] for j in jobs] == [2]

    # A state transition (read-merge-replace) must not drop it either.
    assert storage_module.update_scheduled_job_fields("job_1", {"state": "content_generating"})
    job = storage_module.load_scheduled_jobs(project_id="p1", article_id="a1")[0]
    assert job["state"] == "content_generating" and job["inner_image_count"] == 2

    # Editing the count via PATCH persists the new value.
    assert storage_module.update_scheduled_job_fields("job_1", {"inner_image_count": 4})
    assert storage_module.load_scheduled_jobs(project_id="p1", article_id="a1")[0]["inner_image_count"] == 4
