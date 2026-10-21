"""Manual status changes survive the posted-job overlay; deleted articles free their cluster topics."""
import app.services.topic_cluster_service as tcs
from app.api.routes.articles import _derive_listing_status, _merge_posted_job_into_article_row

JOB = {"wp_status": "publish", "wp_link": "https://x.test/p", "updated_at": "2026-10-01T10:00:00"}


def _status(article):
    return _derive_listing_status(_merge_posted_job_into_article_row(article, JOB))


def test_status_changed_after_post_is_kept():
    for s in ("draft", "pending"):
        assert _status({"id": "a", "status": s, "updated_at": "2026-10-21 09:00:00"}) == s


def test_legacy_row_left_pending_by_scheduler_still_shows_published():
    assert _status({"id": "a", "status": "pending", "updated_at": "2026-10-01 09:59:00"}) == "published"


class _St:
    def __init__(self, alive):
        self.alive, self.saved = set(alive), []

    def load_articles_by_ids_for_project(self, pid, ids):
        return {i: {"id": i} for i in ids if i in self.alive}

    def save_topic_cluster(self, row):
        self.saved.append(row["id"])
        return row


def test_deleted_articles_release_topics(monkeypatch):
    st = _St(alive={"a1"})
    monkeypatch.setattr(tcs, "get_legacy_storage_module", lambda: st)
    rows = [
        {"id": "c1", "pillar": {"id": "p", "imported_article_id": "a1"}, "clusters": [{"id": "x", "imported_article_id": "gone"}]},
        {"id": "c2", "pillar": {"id": "p", "imported_article_id": ""}, "clusters": []},
    ]
    out = tcs.TopicClusterService(project={"id": "pid"}, owner_user_id="u")._release_deleted_articles(rows)
    assert out[0]["pillar"]["imported_article_id"] == "a1"
    assert out[0]["clusters"][0]["imported_article_id"] == ""
    assert st.saved == ["c1"]  # only the changed cluster is written


def test_lookup_failure_releases_nothing(monkeypatch):
    class Boom(_St):
        def load_articles_by_ids_for_project(self, pid, ids):
            raise RuntimeError("db down")

    st = Boom(alive=set())
    monkeypatch.setattr(tcs, "get_legacy_storage_module", lambda: st)
    rows = [{"id": "c1", "pillar": {"imported_article_id": "a1"}, "clusters": []}]
    out = tcs.TopicClusterService(project={"id": "pid"}, owner_user_id="u")._release_deleted_articles(rows)
    assert out[0]["pillar"]["imported_article_id"] == "a1" and st.saved == []
