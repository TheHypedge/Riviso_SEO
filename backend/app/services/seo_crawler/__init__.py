"""Riviso SEO Audit crawl engine (Site Audit → SEO Audit sub-tab, Phase 1).

Built from backend/docs/SEO-Audit-Design.md, scoped to the doc's own Phase 1
(Crawl Foundation) + Phase 2 (Core SEO). See the module docstrings below for the
pipeline: url_utils -> robots -> fetcher -> parser -> crawler -> analysis ->
rules/issues -> scoring.
"""
