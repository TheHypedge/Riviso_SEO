from __future__ import annotations

# The google.com/ping and bing.com/ping sitemap endpoints were retired (2023); discovery now
# goes through the Search Console Sitemaps API (gsc_actions) and IndexNow (indexnow.py).


def default_sitemap_url(*, wp_site_url: str) -> str:
    base = (wp_site_url or "").strip().rstrip("/")
    if not base:
        return ""
    # Works for modern WordPress core sitemap. Some SEO plugins use /sitemap_index.xml;
    # user can override by setting a custom sitemap URL later if needed.
    return f"{base}/sitemap.xml"
