from app.services.article_generation import build_generation_messages
from app.services.editorial_profiles import resolve_editorial_profile


def _sys(profile):
    sys, _ = build_generation_messages(
        title="Default Bail Under Section 187 BNSS",
        keywords=["default bail"],
        focus_keyphrase="default bail",
        writing_prompt_text="Write a guide for {article_title}.",
        editorial_profile=profile,
    )
    return sys


def test_detects_legal_from_niche_and_respects_explicit_choice():
    assert resolve_editorial_profile({"niche_topic": "Criminal lawyers in Delhi"}) == "legal"
    assert resolve_editorial_profile({"niche_identifier": "Niche: Divorce law advice."}) == "legal"
    assert resolve_editorial_profile({"name": "Sharma Law Firm"}) == "legal"
    assert resolve_editorial_profile({"niche_topic": "Men's ethnic wear"}) == "general"
    assert resolve_editorial_profile({"niche_topic": "Legal advice", "editorial_profile": "general"}) == "general"
    assert resolve_editorial_profile(None) == "general"


def test_legal_profile_reaches_system_prompt_only_when_selected():
    legal, general = _sys("legal"), _sys("general")
    for rule in ("old Section 167 CrPC", "Bar Council of India Rule 36", "Never invent a case", "not legal advice"):
        assert rule in legal and rule not in general
    assert "EXCEPT the language-quality, factual-accuracy and professional-compliance rules" in general


def test_language_quality_is_always_on_and_sloppiness_is_gone():
    sys = _sys(None)
    assert "Spelling, grammar, punctuation and capitalisation are flawless" in sys
    assert "slightly imperfect" not in sys and "over chai" not in sys


def test_answer_engine_structure_applies_to_every_niche():
    sys = _sys(None)
    assert "phrase at least 40% of ## H2 headings as the real questions" in sys
    assert '"Key takeaways" markdown blockquote' in sys
