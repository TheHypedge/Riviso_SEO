"""Self-check for _sum_submitted_pages -- the one piece of new non-trivial logic
in the GSC Insights enrichment (device breakdown / headline ctr+position are
straight field pass-throughs, no branching to test)."""

from app.api.routes.project_gsc import _sum_submitted_pages, _to_int


def test_prefers_index_entry_over_summing_children():
    # Real shape observed on a live project: an index entry's submitted_urls
    # already aggregates its children -- summing everything would double-count.
    sitemaps = [
        {"is_sitemaps_index": False, "submitted_urls": "5"},
        {"is_sitemaps_index": False, "submitted_urls": "19"},
        {"is_sitemaps_index": False, "submitted_urls": "280"},
        {"is_sitemaps_index": True, "submitted_urls": "311"},
        {"is_sitemaps_index": True, "submitted_urls": "311"},
    ]
    assert _sum_submitted_pages(sitemaps) == 311


def test_sums_plain_entries_when_no_index_present():
    sitemaps = [
        {"is_sitemaps_index": False, "submitted_urls": "5"},
        {"is_sitemaps_index": False, "submitted_urls": "19"},
    ]
    assert _sum_submitted_pages(sitemaps) == 24


def test_empty_list_returns_none():
    assert _sum_submitted_pages([]) is None


def test_non_numeric_values_treated_as_zero():
    sitemaps = [{"is_sitemaps_index": False, "submitted_urls": ""}, {"is_sitemaps_index": False, "submitted_urls": "not-a-number"}]
    assert _sum_submitted_pages(sitemaps) == 0
    assert _to_int(None) == 0
    assert _to_int("42") == 42


if __name__ == "__main__":
    test_prefers_index_entry_over_summing_children()
    test_sums_plain_entries_when_no_index_present()
    test_empty_list_returns_none()
    test_non_numeric_values_treated_as_zero()
    print("ok")
