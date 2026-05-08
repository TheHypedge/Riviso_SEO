"""
GoogleConsoleService — wrapper around Google Search Console's ``searchanalytics:query``
endpoint with project-aware token resolution, dimension aggregation, per-URL filter,
and a tiny in-process cache.

This service powers the **GSC ROI Dashboard** (Feature 1). It deliberately exposes a
narrow, intent-driven surface so route handlers stay thin:

- :meth:`query_traffic_series` — daily totals over the requested window (clicks,
  impressions, ctr, position) for every page that belongs to the project's WP host.
- :meth:`query_top_pages` — paginated page-level breakdown for the same window.

The service treats any GSC error as a runtime exception with a friendly message; the
route handler maps that to HTTP 400 with the error string.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable
from urllib.parse import quote, urlparse

import httpx

from app.services import gsc as gsc_service
from app.services.gsc_actions import _get_valid_access_token_for_project


log = logging.getLogger(__name__)


GSC_SEARCH_ANALYTICS_URL_TPL = (
    "https://www.googleapis.com/webmasters/v3/sites/{site}/searchAnalytics/query"
)


def _today_iso() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d")


def _date_n_days_ago_iso(n: int) -> str:
    return (datetime.utcnow() - timedelta(days=max(1, int(n)))).strftime("%Y-%m-%d")


def _safe_host_from_url(url: str) -> str:
    """Extract the bare host (no port, no scheme) so we can compare WP links to GSC pages."""
    try:
        parsed = urlparse((url or "").strip())
        host = (parsed.hostname or "").strip().lower()
        return host
    except Exception:
        return ""


def _normalise_property_for_query(prop: str) -> tuple[str, str]:
    """
    Return ``(site_url_for_query, host_for_filtering)``.

    Google's API takes the property identifier verbatim — both ``sc-domain:example.com``
    and ``https://www.example.com/`` are valid but they filter differently. The host is
    used purely for our own URL filtering against the project's published articles.
    """
    p = (prop or "").strip()
    if p.startswith("sc-domain:"):
        host = p.split(":", 1)[1].strip().lower()
        return p, host
    return p, _safe_host_from_url(p)


class GoogleConsoleService:
    """
    Stateless service that performs Search Console analytics queries on behalf of
    a single project. Instantiate per-request; the cache is shared across instances.
    """

    # Process-wide micro-cache so the same dashboard load doesn't fan out to GSC twice.
    # Key: (project_id, dimension, start, end). Value: (expires_at_epoch, payload).
    _CACHE: dict[tuple, tuple[float, list[dict[str, Any]]]] = {}
    _CACHE_TTL_SECONDS: int = 90

    def __init__(self, *, st: Any, project: dict[str, Any]) -> None:
        self.st = st
        self.project = project
        self.property_url = (project.get("gsc_property_url") or "").strip()
        if not self.property_url:
            raise RuntimeError("Search Console property is not selected for this project")
        if not gsc_service.oauth_configured():
            raise RuntimeError("Google OAuth client is not configured on the backend")

    # ------------------------------------------------------------------ helpers

    async def _access_token(self) -> str:
        at, _src = await _get_valid_access_token_for_project(st=self.st, proj=self.project)
        return at

    @classmethod
    def _cache_get(cls, key: tuple) -> list[dict[str, Any]] | None:
        entry = cls._CACHE.get(key)
        if not entry:
            return None
        expires_at, value = entry
        if expires_at < time.time():
            cls._CACHE.pop(key, None)
            return None
        return value

    @classmethod
    def _cache_put(cls, key: tuple, value: list[dict[str, Any]]) -> None:
        cls._CACHE[key] = (time.time() + cls._CACHE_TTL_SECONDS, value)

    # ------------------------------------------------------------------ queries

    async def _search_analytics_query(
        self,
        *,
        start_date: str,
        end_date: str,
        dimensions: list[str],
        row_limit: int = 1000,
        filters: Iterable[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        """
        Low-level wrapper that returns the raw ``rows`` array from the API.

        Always pass ``dataState="all"`` so the dashboard can show the latest 2-3 days of
        partial data (Google delays ~3 days for "final"). The frontend can label these.
        """
        site, _host = _normalise_property_for_query(self.property_url)
        url = GSC_SEARCH_ANALYTICS_URL_TPL.format(site=quote(site, safe=""))
        body: dict[str, Any] = {
            "startDate": start_date,
            "endDate": end_date,
            "dimensions": list(dimensions or []),
            "rowLimit": int(row_limit or 1000),
            "dataState": "all",
        }
        if filters:
            body["dimensionFilterGroups"] = [{"filters": list(filters)}]

        token = await self._access_token()
        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.post(url, headers={"authorization": f"Bearer {token}"}, json=body)
        if res.status_code == 403:
            raise RuntimeError(
                "Search Console denied the analytics query (403). The connected Google account does "
                "not have access to this property — re-link the property under Tools → Search Console."
            )
        if res.status_code != 200:
            try:
                data = res.json()
                msg = (data.get("error") or {}).get("message") or str(data)
            except Exception:
                msg = (res.text or "")[:300]
            raise RuntimeError(f"Search Analytics query failed ({res.status_code}): {msg}")
        try:
            data = res.json()
        except Exception:
            data = {}
        rows = data.get("rows") if isinstance(data, dict) else None
        return list(rows) if isinstance(rows, list) else []

    async def query_traffic_series(self, *, days: int = 30) -> list[dict[str, Any]]:
        """
        Daily totals over the last ``days`` days. Returns a list sorted ascending by date.

        Each row: ``{date, clicks, impressions, ctr, position}``. Days with zero traffic
        are *not* returned by Google; the frontend should fill gaps as zeroes.
        """
        d = max(7, min(int(days or 30), 365))
        start = _date_n_days_ago_iso(d)
        end = _today_iso()
        cache_key = (self.project.get("id"), "date", start, end)
        cached = self._cache_get(cache_key)
        if cached is not None:
            return cached
        rows = await self._search_analytics_query(start_date=start, end_date=end, dimensions=["date"])
        out: list[dict[str, Any]] = []
        for r in rows:
            keys = r.get("keys") or []
            if not keys:
                continue
            out.append(
                {
                    "date": str(keys[0]),
                    "clicks": int(r.get("clicks") or 0),
                    "impressions": int(r.get("impressions") or 0),
                    "ctr": float(r.get("ctr") or 0.0),
                    "position": float(r.get("position") or 0.0),
                }
            )
        out.sort(key=lambda x: x["date"])
        self._cache_put(cache_key, out)
        return out

    async def query_top_pages(self, *, days: int = 30, limit: int = 25) -> list[dict[str, Any]]:
        """Top pages by clicks for the same window."""
        d = max(7, min(int(days or 30), 365))
        start = _date_n_days_ago_iso(d)
        end = _today_iso()
        cache_key = (self.project.get("id"), "page", start, end)
        cached = self._cache_get(cache_key)
        if cached is not None:
            return cached[: int(limit or 25)]
        rows = await self._search_analytics_query(
            start_date=start,
            end_date=end,
            dimensions=["page"],
            row_limit=max(1, min(int(limit or 25) * 4, 1000)),
        )
        out: list[dict[str, Any]] = []
        for r in rows:
            keys = r.get("keys") or []
            if not keys:
                continue
            out.append(
                {
                    "url": str(keys[0]),
                    "clicks": int(r.get("clicks") or 0),
                    "impressions": int(r.get("impressions") or 0),
                    "ctr": float(r.get("ctr") or 0.0),
                    "position": float(r.get("position") or 0.0),
                }
            )
        out.sort(key=lambda x: (x.get("clicks") or 0), reverse=True)
        out = out[: max(1, min(int(limit or 25), 200))]
        self._cache_put(cache_key, out)
        return out

    # ------------------------------------------------------------ aggregates

    @staticmethod
    def aggregate_totals(series: list[dict[str, Any]]) -> dict[str, Any]:
        """Roll up a daily series into headline KPIs the dashboard shows above the chart."""
        clicks = sum(int(r.get("clicks") or 0) for r in series)
        impressions = sum(int(r.get("impressions") or 0) for r in series)
        ctr = (clicks / impressions) if impressions else 0.0
        positions = [float(r.get("position") or 0.0) for r in series if (r.get("impressions") or 0) > 0]
        position = (sum(positions) / len(positions)) if positions else 0.0
        return {
            "clicks": clicks,
            "impressions": impressions,
            "ctr": ctr,
            "position": position,
            "days_with_data": len([r for r in series if (r.get("impressions") or 0) > 0]),
        }

    @staticmethod
    def fill_zero_days(series: list[dict[str, Any]], *, start_date: str, end_date: str) -> list[dict[str, Any]]:
        """Insert zero rows for days Google didn't return so the chart's X axis is continuous."""
        try:
            start = datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            end = datetime.strptime(end_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except Exception:
            return series
        by_date = {r["date"]: r for r in series if isinstance(r, dict) and r.get("date")}
        out: list[dict[str, Any]] = []
        cur = start
        while cur <= end:
            iso = cur.strftime("%Y-%m-%d")
            if iso in by_date:
                out.append(by_date[iso])
            else:
                out.append({"date": iso, "clicks": 0, "impressions": 0, "ctr": 0.0, "position": 0.0})
            cur += timedelta(days=1)
        return out

    # ------------------------------------------------------------ markers

    @staticmethod
    def collect_publication_markers(
        articles: list[dict[str, Any]],
        *,
        property_host: str,
        start_date: str,
        end_date: str,
    ) -> list[dict[str, Any]]:
        """
        Build the chart marker list — one entry per article published inside the window
        whose live URL belongs to the linked Search Console property.
        """
        host = (property_host or "").strip().lower()
        out: list[dict[str, Any]] = []
        for a in articles or []:
            if not isinstance(a, dict):
                continue
            link = (a.get("wp_link") or "").strip()
            if not link:
                continue
            if host:
                ah = _safe_host_from_url(link)
                if ah and not (ah == host or ah.endswith("." + host) or host.endswith("." + ah)):
                    continue
            published = (a.get("posted_at") or a.get("updated_at") or a.get("created_at") or "").strip()
            if not published:
                continue
            iso_day = published[:10]
            if iso_day < start_date or iso_day > end_date:
                continue
            out.append(
                {
                    "date": iso_day,
                    "article_id": (a.get("id") or "").strip(),
                    "title": (a.get("title") or "").strip(),
                    "url": link,
                }
            )
        out.sort(key=lambda x: x["date"])
        return out
