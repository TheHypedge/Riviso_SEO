"""Regression: the Mongo projection used by load_scheduled_jobs() must keep every field the
scheduled-job normalizer knows. It used to keep only 10, so in production every loaded job
had inner_image_count=0, image_prompt_id/writing_prompt_id="" and generate_image=True --
scheduled prep made no inner images and ignored the chosen prompts. JSON-mode tests could
not see it (no projection there); it surfaced only against a real MongoDB in the QA run."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import storage as storage_module  # noqa: E402


def test_projection_covers_every_normalized_job_field():
    normalized = storage_module._normalize_scheduled_job_dict(
        {"id": "j1", "project_id": "p1", "article_id": "a1", "run_at": "2026-11-01 08:00:00"}
    )
    projected = {k for k, v in storage_module._SCHEDULED_JOB_LISTING_PROJECTION.items() if v}
    missing = set(normalized) - projected
    assert not missing, f"load_scheduled_jobs() would silently reset: {sorted(missing)}"


def test_projection_keeps_the_generation_settings():
    p = storage_module._SCHEDULED_JOB_LISTING_PROJECTION
    for f in ("inner_image_count", "image_prompt_id", "writing_prompt_id", "generate_image", "post_type", "category_ids"):
        assert p.get(f) == 1, f
