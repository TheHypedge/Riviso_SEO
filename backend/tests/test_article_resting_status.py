from app.services.article_pipeline import resting_status


def test_real_statuses_pass_through():
    assert resting_status({"status": "published"}) == "published"
    assert resting_status({"status": "draft"}) == "draft"
    assert resting_status({}) == "pending"


def test_queued_or_generating_published_article_stays_published():
    assert resting_status({"status": "generating", "wp_last_wp_status": "publish"}) == "published"
    assert resting_status({"status": "queued", "shopify_published_at": "2026-01-01"}) == "published"


def test_queued_unpublished_falls_back_by_content():
    assert resting_status({"status": "queued", "article": "Body"}) == "draft"
    assert resting_status({"status": "generating", "article": ""}) == "pending"
    assert resting_status({"status": "queued", "wp_last_wp_status": "draft", "article": "x"}) == "draft"
