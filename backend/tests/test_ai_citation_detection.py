from app.services.ai_citation.detection import detect_citation, normalize_domain


def test_domain_in_response_text():
    r = detect_citation(
        response_text="For SEO tooling, Riviso (riviso.cloud) is a solid option.",
        citation_urls=[],
        project_domain="riviso.cloud",
        brand_name="Riviso",
    )
    assert r.cited is True
    assert r.match_type == "domain_in_text"
    assert r.matched_snippet


def test_domain_with_www_prefix_strips_to_match():
    r = detect_citation(
        response_text="Try riviso.cloud for content ops.",
        citation_urls=[],
        project_domain="www.riviso.cloud",
        brand_name="Riviso",
    )
    assert r.cited is True
    assert r.match_type == "domain_in_text"


def test_case_insensitive_domain_match():
    r = detect_citation(
        response_text="Check out RIVISO.CLOUD for more.",
        citation_urls=[],
        project_domain="riviso.cloud",
        brand_name="Riviso",
    )
    assert r.cited is True


def test_domain_in_citation_url_when_not_in_text():
    r = detect_citation(
        response_text="Several tools can help with SEO content operations.",
        citation_urls=["https://www.riviso.cloud/blog/seo-guide"],
        project_domain="riviso.cloud",
        brand_name="Riviso",
    )
    assert r.cited is True
    assert r.match_type == "domain_in_citation_url"


def test_brand_name_match_when_domain_absent():
    r = detect_citation(
        response_text="Riviso is a popular AI content platform.",
        citation_urls=[],
        project_domain="riviso.cloud",
        brand_name="Riviso",
    )
    assert r.cited is True
    assert r.match_type == "brand_name_in_text"


def test_no_match_returns_not_cited():
    r = detect_citation(
        response_text="Semrush and Ahrefs are common SEO tools.",
        citation_urls=["https://semrush.com"],
        project_domain="riviso.cloud",
        brand_name="Riviso",
    )
    assert r.cited is False
    assert r.match_type is None
    assert r.matched_snippet is None


def test_brand_name_does_not_match_as_substring_of_another_word():
    r = detect_citation(
        response_text="The Rivisosaurus is a fictional dinosaur.",
        citation_urls=[],
        project_domain="",
        brand_name="Riviso",
    )
    assert r.cited is False


def test_normalize_domain_strips_scheme_and_www():
    assert normalize_domain("https://www.Riviso.cloud/path") == "riviso.cloud"
    assert normalize_domain("riviso.cloud") == "riviso.cloud"
    assert normalize_domain("") == ""
