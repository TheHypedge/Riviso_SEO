"""Regression: every monthly plan counter must survive the user write shape.

_consume_monthly_counter rewrites the whole user through _normalize_user_dict
(replace_one in Mongo). Counters missing from that shape reset on every write, so
their plan limits were never enforced (production had 22 SEO audits and no user with
an SEO-audit counter)."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import storage as S  # noqa: E402

COUNTERS = [
    ("consume_cluster_plan_usage", "cluster_plans"),
    ("consume_custom_research_usage", "custom_research"),
    ("consume_technical_audit_usage", "technical_audit"),
    ("consume_seo_audit_usage", "seo_audit"),
    ("consume_ai_citation_usage", "ai_citation"),
    ("consume_image_prompt_test_usage", "image_prompt_test"),
    ("consume_inner_image_usage", "inner_image"),
]


@pytest.fixture
def json_store(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "_storage_mode", "json")
    monkeypatch.setattr(S, "_data_path", lambda name: str(tmp_path / name))
    monkeypatch.setattr(S, "create_subscription_for_user", lambda **kw: None)
    S.insert_user({"id": "u1", "email": "u1@example.invalid", "subscription_type": "beta"})


@pytest.mark.parametrize("fn, name", COUNTERS)
def test_counter_persists_and_limit_is_enforced(json_store, fn, name):
    consume = getattr(S, fn)
    assert consume("u1", month_limit=2) == (True, "")
    assert consume("u1", month_limit=2) == (True, "")
    ok, msg = consume("u1", month_limit=2)
    assert ok is False and msg  # third use over a limit of 2 is refused
    raw = next(u for u in S._load_json_users() if u["id"] == "u1")
    assert raw[f"usage_monthly_{name}_count"] == 2
    assert raw[f"usage_monthly_{name}_month"] == S._utc_month_key_now()


def test_one_counter_does_not_reset_another(json_store):
    S.consume_seo_audit_usage("u1", month_limit=None)
    S.consume_technical_audit_usage("u1", month_limit=None)
    S.consume_inner_image_usage("u1", month_limit=None)
    raw = next(u for u in S._load_json_users() if u["id"] == "u1")
    assert (raw["usage_monthly_seo_audit_count"], raw["usage_monthly_technical_audit_count"], raw["usage_monthly_inner_image_count"]) == (1, 1, 1)
