"""Shopify Admin REST client."""
from __future__ import annotations

from typing import Any

import httpx

from app.services.shopify_oauth import SHOPIFY_API_VERSION, normalize_shop_domain


class ShopifyClient:
    def __init__(self, *, shop: str, access_token: str) -> None:
        self.shop = normalize_shop_domain(shop)
        self.access_token = (access_token or "").strip()
        if not self.shop or not self.access_token:
            raise ValueError("Shopify shop and access token are required")

    def _headers(self) -> dict[str, str]:
        return {
            "X-Shopify-Access-Token": self.access_token,
            "Content-Type": "application/json",
        }

    def _url(self, path: str) -> str:
        p = path if path.startswith("/") else f"/{path}"
        return f"https://{self.shop}/admin/api/{SHOPIFY_API_VERSION}{p}"

    async def get_paginated(
        self,
        path: str,
        *,
        resource_key: str,
        limit: int = 250,
        max_pages: int = 4,
        params: dict[str, str] | None = None,
    ) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        query = dict(params or {})
        query.setdefault("limit", str(min(250, max(1, limit))))
        url: str | None = self._url(path)
        pages = 0
        async with httpx.AsyncClient(timeout=60.0) as client:
            while url and pages < max_pages:
                res = await client.get(url, headers=self._headers(), params=query if pages == 0 else None)
                res.raise_for_status()
                data = res.json()
                if not isinstance(data, dict):
                    break
                chunk = data.get(resource_key) or []
                if isinstance(chunk, list):
                    out.extend([x for x in chunk if isinstance(x, dict)])
                link = res.headers.get("link") or ""
                url = _parse_next_link(link)
                query = {}
                pages += 1
        return out

    async def get_json(self, path: str, *, params: dict[str, str] | None = None) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.get(self._url(path), headers=self._headers(), params=params or {})
            res.raise_for_status()
            data = res.json()
        return data if isinstance(data, dict) else {}

    async def fetch_access_scopes(self) -> list[str]:
        """Return scope handles granted to the current access token (authoritative)."""
        url = f"https://{self.shop}/admin/oauth/access_scopes.json"
        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.get(url, headers=self._headers())
            res.raise_for_status()
            data = res.json()
        if not isinstance(data, dict):
            return []
        raw = data.get("access_scopes") if isinstance(data.get("access_scopes"), list) else []
        out: list[str] = []
        for item in raw:
            if isinstance(item, dict):
                handle = (item.get("handle") or "").strip()
                if handle:
                    out.append(handle)
        return sorted(set(out))

    async def post_json(self, path: str, *, payload: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=60.0) as client:
            res = await client.post(self._url(path), headers=self._headers(), json=payload or {})
            res.raise_for_status()
            data = res.json()
        return data if isinstance(data, dict) else {}

    async def put_json(self, path: str, *, payload: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=60.0) as client:
            res = await client.put(self._url(path), headers=self._headers(), json=payload or {})
            res.raise_for_status()
            data = res.json()
        return data if isinstance(data, dict) else {}


def _parse_next_link(link_header: str) -> str | None:
    if not link_header:
        return None
    for part in link_header.split(","):
        segment = part.strip()
        if 'rel="next"' in segment:
            start = segment.find("<")
            end = segment.find(">")
            if start >= 0 and end > start:
                return segment[start + 1 : end]
    return None
