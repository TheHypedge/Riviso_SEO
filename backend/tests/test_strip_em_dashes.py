from app.services.generation_blocklist import strip_em_dashes
from app.services.title_humanization_guardrail import humanize_planning_title


def test_mid_string_em_dash_becomes_hyphen():
    assert strip_em_dashes("Great — Article") == "Great - Article"


def test_leading_em_dash_is_dropped_not_replaced():
    assert strip_em_dashes("— Great Article") == "Great Article"


def test_trailing_em_dash_is_dropped_not_replaced():
    assert strip_em_dashes("Great Article —") == "Great Article"


def test_no_dash_is_unchanged():
    assert strip_em_dashes("No dash here") == "No dash here"


def test_empty_and_none_are_safe():
    assert strip_em_dashes("") == ""
    assert strip_em_dashes(None) == ""


def test_humanize_planning_title_strips_em_dash_even_on_the_clean_fast_path():
    # No banned cliché word here, so this would take the early-return path —
    # the em dash must still be stripped, not skipped because it "looks clean."
    title = humanize_planning_title("Widgets — A Buyer's Guide", role="research", keyword_fallback="widgets")
    assert "—" not in title
