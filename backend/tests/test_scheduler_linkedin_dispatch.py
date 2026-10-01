"""Self-check for the scheduler's platform=="linkedin" branch (_publish_scheduled_job_to_linkedin):
double-post guard, successful post persisting to scheduled_jobs/article/social_posts, and
failure marking the job failed instead of raising into the shared WordPress/Shopify handler."""

import asyncio

from app.services.scheduler import _publish_scheduled_job_to_linkedin


class _FakeStorage:
    def __init__(self):
        self.job_updates: list[tuple[str, dict]] = []
        self.article_patches: list[tuple[str, dict]] = []
        self.social_posts: list[dict] = []

    def update_scheduled_job_fields(self, jid, fields):
        self.job_updates.append((jid, fields))

    def patch_article_fields(self, article_id, fields):
        self.article_patches.append((article_id, fields))

    def create_social_post(self, doc):
        self.social_posts.append(doc)


_PROJ = {
    "linkedin_access_token": "tok",
    "linkedin_selected_author_urn": "urn:li:person:abc",
}
_ART = {"id": "art1", "title": "My Article", "meta_description": "desc", "image_url": ""}
_JOB = {"project_id": "p1", "article_id": "art1", "linkedin_commentary": "Check this out!"}


def test_double_post_guard_skips_reposting():
    st = _FakeStorage()
    art = {**_ART, "linkedin_post_urn": "urn:li:share:existing", "linkedin_post_url": "https://linkedin.com/existing"}

    asyncio.run(_publish_scheduled_job_to_linkedin(st=st, jid="job1", proj=_PROJ, art=art, job=_JOB))

    assert len(st.job_updates) == 1
    jid, fields = st.job_updates[0]
    assert jid == "job1"
    assert fields["state"] == "posted"
    assert fields["linkedin_post_urn"] == "urn:li:share:existing"
    assert st.social_posts == []


def test_successful_post_persists_to_all_three_places(monkeypatch):
    st = _FakeStorage()

    async def fake_create_post(*, access_token, author_urn, commentary, article_url, thumbnail_urn, title, description):
        return {"post_urn": "urn:li:share:999", "post_url": "https://linkedin.com/feed/update/urn:li:share:999/"}

    monkeypatch.setattr("app.services.linkedin_client.create_post", fake_create_post)

    asyncio.run(_publish_scheduled_job_to_linkedin(st=st, jid="job2", proj=_PROJ, art=_ART, job=_JOB))

    assert st.job_updates[0][1]["state"] == "posted"
    assert st.job_updates[0][1]["linkedin_post_urn"] == "urn:li:share:999"
    assert st.article_patches == [("art1", {"linkedin_post_urn": "urn:li:share:999", "linkedin_post_url": "https://linkedin.com/feed/update/urn:li:share:999/"})]
    assert len(st.social_posts) == 1
    assert st.social_posts[0]["platform"] == "linkedin"
    assert st.social_posts[0]["status"] == "posted"


def test_missing_connection_marks_job_failed_not_raised():
    st = _FakeStorage()
    proj = {"linkedin_access_token": "", "linkedin_selected_author_urn": ""}

    asyncio.run(_publish_scheduled_job_to_linkedin(st=st, jid="job3", proj=proj, art=_ART, job=_JOB))

    assert len(st.job_updates) == 1
    jid, fields = st.job_updates[0]
    assert fields["state"] == "failed"
    assert "not connected" in fields["last_error"]
    assert st.social_posts == []
    assert st.article_patches == []


if __name__ == "__main__":
    test_double_post_guard_skips_reposting()
    test_missing_connection_marks_job_failed_not_raised()
    print("ok")
