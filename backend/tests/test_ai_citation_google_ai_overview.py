from app.services.ai_citation.google_ai_overview_engine import _looks_blocked


def test_detects_unusual_traffic_interstitial():
    text = "Our systems have detected unusual traffic from your computer network."
    assert _looks_blocked(text, "https://www.google.com/search?q=x") is True


def test_detects_sorry_redirect_url():
    assert _looks_blocked("", "https://www.google.com/sorry/index?continue=...") is True


def test_normal_results_page_not_flagged_as_blocked():
    text = "Python is a programming language. Related searches: python tutorial, python download."
    assert _looks_blocked(text, "https://www.google.com/search?q=python") is False
