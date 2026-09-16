from app.services.ai_citation.prompt_builder import build_check_prompts


class _FakeStorage:
    def __init__(self, articles, clusters):
        self._articles = articles
        self._clusters = clusters

    def load_articles_listing_for_project(self, project_id, limit=5000):
        return self._articles

    def list_topic_clusters_for_project(self, project_id, limit=100):
        return self._clusters


def test_builds_three_templates_per_keyword():
    st = _FakeStorage(
        articles=[{"focus_keyphrase": "seo content ops", "keywords": []}],
        clusters=[],
    )
    prompts = build_check_prompts("p1", st, max_keywords=10)
    assert len(prompts) == 3
    assert all(p["keyword"] == "seo content ops" for p in prompts)
    assert all(p["keyword_source"] == "article_focus_keyphrase" for p in prompts)


def test_dedupes_case_insensitively_across_sources():
    st = _FakeStorage(
        articles=[{"focus_keyphrase": "SEO Tools", "keywords": ["seo tools"]}],
        clusters=[{"pillar": {"keywords": ["seo tools"]}, "clusters": []}],
    )
    prompts = build_check_prompts("p1", st, max_keywords=10)
    # one keyword -> 3 templates, not 9
    assert len(prompts) == 3


def test_caps_at_max_keywords():
    st = _FakeStorage(
        articles=[{"focus_keyphrase": f"keyword {i}", "keywords": []} for i in range(20)],
        clusters=[],
    )
    prompts = build_check_prompts("p1", st, max_keywords=2)
    assert len(prompts) == 2 * 3


def test_pulls_topic_cluster_slot_keywords():
    st = _FakeStorage(
        articles=[],
        clusters=[
            {
                "pillar": {"keywords": ["content marketing"]},
                "clusters": [{"title": "x", "keywords": ["ai writing tools"]}],
            }
        ],
    )
    prompts = build_check_prompts("p1", st, max_keywords=10)
    keywords = {p["keyword"] for p in prompts}
    assert keywords == {"content marketing", "ai writing tools"}
    sources = {p["keyword_source"] for p in prompts}
    assert sources == {"topic_cluster_keyword"}


def test_no_keywords_returns_empty():
    st = _FakeStorage(articles=[], clusters=[])
    assert build_check_prompts("p1", st) == []


def test_missing_project_id_returns_empty():
    st = _FakeStorage(articles=[{"focus_keyphrase": "x", "keywords": []}], clusters=[])
    assert build_check_prompts("", st) == []
