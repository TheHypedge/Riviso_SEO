"""
Site Audit — Technical Audit (Google PageSpeed Insights) and, in a later phase,
the SEO Audit crawler. See backend/docs/SITE-AUDIT-GUIDE.md for the full spec.

website.py — resolves a project's canonical live website URL (shared by both
audits); pagespeed_client.py (sibling module, not under this package) is the
PSI HTTP client + response normalizer for Phase 1.
"""

from __future__ import annotations

from app.services.site_audit.website import resolve_project_website_url

__all__ = ["resolve_project_website_url"]
