"""Self-checks for carrying Post Type / Status from Generate-All into Schedule/Publish:

1. The request schemas (single generate + cluster generate-all) accept the new
   ``post_type``/``wp_status`` fields, default to None (no WordPress call forced).
2. ``ArticlePublic`` round-trips ``wp_schedule_wp_status`` -- this is exactly the bug class
   that silently dropped the field from every API response before this fix (the field
   existed in storage.py's raw dict but was never declared on the Pydantic response model).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.schemas.articles import ArticlePublic, GenerateRequest  # noqa: E402
from app.api.routes.project_topic_cluster import TopicClusterGenerateAllPayload  # noqa: E402


def test_generate_request_accepts_post_type_and_wp_status():
    req = GenerateRequest(post_type="pages", wp_status="publish")
    assert req.post_type == "pages"
    assert req.wp_status == "publish"


def test_generate_request_defaults_post_type_and_wp_status_to_none():
    req = GenerateRequest()
    assert req.post_type is None
    assert req.wp_status is None


def test_cluster_generate_all_payload_accepts_post_type_and_wp_status():
    payload = TopicClusterGenerateAllPayload(post_type="pages", wp_status="draft")
    assert payload.post_type == "pages"
    assert payload.wp_status == "draft"


def test_cluster_generate_all_payload_defaults_to_none():
    payload = TopicClusterGenerateAllPayload()
    assert payload.post_type is None
    assert payload.wp_status is None


def test_article_public_round_trips_wp_schedule_wp_status():
    """Regression check: this field used to be silently dropped on serialization
    even though storage.py always included it in the raw article dict."""
    row = {
        "id": "a1",
        "project_id": "p1",
        "title": "Test",
        "wp_rest_base": "pages",
        "wp_schedule_wp_status": "publish",
    }
    article = ArticlePublic(**row)
    assert article.wp_rest_base == "pages"
    assert article.wp_schedule_wp_status == "publish"


if __name__ == "__main__":
    import pytest

    pytest.main([__file__, "-v"])
