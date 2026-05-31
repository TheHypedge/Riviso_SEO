"""Tests for planning-layer title humanization guardrails."""

from app.services.title_humanization_guardrail import (
    apply_cluster_map_title_guardrails,
    apply_research_idea_title_guardrails,
    build_semantic_fallback_title,
    humanize_planning_title,
    scrub_title_linguistics,
    title_has_banned_cliche,
    title_has_forbidden_template,
)


def test_title_ban_list_rejects_ultimate() -> None:
    assert title_has_banned_cliche("The Ultimate Guide to Linen Suits")
    assert title_has_forbidden_template("An Introduction to SEO", role="pillar")
    assert title_has_forbidden_template("How to fix crawl errors", role="cluster")


def test_scrub_removes_cliche_words() -> None:
    scrubbed = scrub_title_linguistics("Navigating the Ultimate Comprehensive SEO Stack")
    assert "ultimate" not in scrubbed.casefold()
    assert "comprehensive" not in scrubbed.casefold()
    assert "navigating" not in scrubbed.casefold()


def test_humanize_planning_title_falls_back_to_keyword() -> None:
    out = humanize_planning_title(
        "The Ultimate Guide to Enterprise SEO",
        role="pillar",
        keyword_fallback="enterprise SEO architecture",
    )
    assert "ultimate" not in out.casefold()
    assert out  # non-empty


def test_semantic_fallback_uses_keyword() -> None:
    fb = build_semantic_fallback_title(keyword="linen suits for weddings", role="cluster")
    assert fb.startswith("Linen")


def test_apply_cluster_map_title_guardrails_preserves_keywords() -> None:
    derived = {
        "pillar": {
            "title": "The Ultimate Guide to Content Ops",
            "keywords": ["content operations"],
            "intent": "informational",
        },
        "clusters": [
            {
                "title": "How to Build a Content Calendar",
                "keywords": ["content calendar"],
                "intent": "informational",
            }
        ],
    }
    out = apply_cluster_map_title_guardrails(derived, seed_intent="content operations")
    assert out["pillar"]["keywords"] == ["content operations"]
    assert "ultimate" not in out["pillar"]["title"].casefold()
    assert not out["pillar"]["title"].lower().startswith("how to")
    assert out["clusters"][0]["keywords"] == ["content calendar"]


def test_apply_research_idea_title_guardrails_preserves_focus_keyphrase() -> None:
    ideas = [
        {
            "title": "7 Benefits of Technical SEO Audits",
            "focus_keyphrase": "technical SEO audit",
            "keywords": ["crawl budget"],
        }
    ]
    out = apply_research_idea_title_guardrails(ideas, seed_keywords=["technical SEO"])
    assert out[0]["focus_keyphrase"] == "technical SEO audit"
    assert out[0]["keywords"] == ["crawl budget"]
    assert not out[0]["title"].lower().startswith("7 benefits")
