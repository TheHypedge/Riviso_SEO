"""IndexNow: tell Bing (and Yandex, Naver, Seznam, Yep — participating engines share every
submission) that a URL was added or updated. Google does not take part in IndexNow.

The protocol proves site ownership with a key file at ``{site}/{key}.txt``. The Riviso
connector plugin (>= 0.7.0) serves it once Riviso stores the key through ``POST /indexnow-key``;
sites without the plugin can upload that file by hand and press "Verify".

A project is ready when ``indexnow_key_location`` is set (only written after the key file was
fetched and matched). Auto-submits after publish/update are best-effort and only logged, so a
background task never rewrites the project document (``update_project_fields`` is a full replace).
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from datetime import datetime
from typing import Any
from urllib.parse import urlparse

import httpx

from app.services.to_thread import run_sync
from app.services.url_guard import SsrfError, assert_public_http_url
from app.services.wordpress_client import RIVISO_WP_USER_AGENT, WordpressClient

log = logging.getLogger(__name__)

ENDPOINT = "https://api.indexnow.org/indexnow"
MAX_URLS = 10_000
_PLUGIN_NAMESPACES = ("riviso/v1", "auto-articles/v1")

_REJECTIONS = {
    400: "bad request",
    403: "key not valid — the key file is missing or does not match",
    422: "URLs do not belong to the site, or the key does not match",
    429: "too many requests — wait before submitting again",
}


def _now_str() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")


def is_ready(proj: dict) -> bool:
    return bool((proj.get("indexnow_key") or "").strip() and (proj.get("indexnow_key_location") or "").strip())


def same_host_urls(urls: list[str], key_location: str) -> list[str]:
    """IndexNow rejects the whole batch (422) if any URL is on another host — keep matching ones."""
    host = (urlparse(key_location).netloc or "").lower()
    out: list[str] = []
    for u in dict.fromkeys((u or "").strip() for u in urls):
        p = urlparse(u)
        if p.scheme in ("http", "https") and (p.netloc or "").lower() == host:
            out.append(u)
    return out[:MAX_URLS]


async def submit_urls(*, key: str, key_location: str, urls: list[str]) -> dict[str, Any]:
    """POST a batch to IndexNow. Raises ``RuntimeError`` with a readable reason on rejection."""
    batch = same_host_urls(urls, key_location)
    if not batch:
        raise RuntimeError(f"No URLs on {urlparse(key_location).netloc} to submit")
    body = {
        "host": urlparse(key_location).netloc,
        "key": key,
        "keyLocation": key_location,
        "urlList": batch,
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        res = await client.post(ENDPOINT, json=body, headers={"content-type": "application/json; charset=utf-8"})
    # 202 = accepted, key validation still pending on the engine side.
    if res.status_code not in (200, 202):
        reason = _REJECTIONS.get(res.status_code, (res.text or "")[:200])
        raise RuntimeError(f"IndexNow rejected the submission (HTTP {res.status_code}: {reason})")
    return {"http_status": res.status_code, "submitted": len(batch)}


async def maybe_submit(*, proj: dict, urls: list[str]) -> bool:
    """Best-effort hook after a live publish/update. Never raises."""
    if not proj.get("indexnow_enabled", True) or not is_ready(proj):
        return False
    try:
        r = await submit_urls(key=proj["indexnow_key"], key_location=proj["indexnow_key_location"], urls=urls)
        log.info("IndexNow: project=%s submitted %s URL(s) (HTTP %s)", proj.get("id"), r["submitted"], r["http_status"])
        return True
    except Exception as e:
        log.warning("IndexNow submit failed for project=%s: %s", proj.get("id"), e)
        return False


_background: set[asyncio.Task] = set()


def submit_in_background(*, proj: dict, urls: list[str]) -> None:
    """Fire-and-forget :func:`maybe_submit`, keeping a reference so the task is not GC'd mid-flight."""
    task = asyncio.create_task(maybe_submit(proj=proj, urls=urls))
    _background.add(task)
    task.add_done_callback(_background.discard)


async def key_file_matches(key_location: str, key: str) -> bool:
    """Fetch the key file exactly as IndexNow will (no redirects — it must live on this host)."""
    try:
        assert_public_http_url(key_location)
    except SsrfError:
        return False
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=False) as client:
            res = await client.get(key_location, headers={"user-agent": RIVISO_WP_USER_AGENT})
    except Exception:
        return False
    return res.status_code == 200 and (res.text or "").strip() == key


async def setup_for_project(*, st, proj: dict) -> dict[str, Any]:
    """
    Create the project key (once), hand it to the connector plugin, then verify the key file.

    Safe to call repeatedly: it doubles as "Verify" after a manual key-file upload.
    """
    site = (proj.get("wp_site_url") or proj.get("website_url") or "").strip()
    user = (proj.get("wp_username") or "").strip()
    pw = (proj.get("wp_app_password") or "").strip()
    if not site or not user or not pw:
        raise RuntimeError("Connect WordPress in Project Settings first.")

    key = (proj.get("indexnow_key") or "").strip() or secrets.token_hex(16)
    wp = WordpressClient(site_url=site, username=user, app_password=pw)
    site = await wp.ensure_resolved_site_url()
    key_location = f"{site.rstrip('/')}/{key}.txt"

    plugin_saved = False
    for ns in _PLUGIN_NAMESPACES:
        try:
            res = await wp.post_json(f"/wp-json/{ns}/indexnow-key", {"key": key}, timeout=20.0)
            plugin_saved = True
            # The plugin answers with home_url()-based location, which differs from site_url
            # when WordPress core lives in its own subdirectory.
            loc = str((res or {}).get("key_location") or "").strip() if isinstance(res, dict) else ""
            if loc.endswith(f"/{key}.txt") and urlparse(loc).netloc == urlparse(key_location).netloc:
                key_location = loc
            break
        except Exception:
            continue

    verified = await key_file_matches(key_location, key)
    if verified:
        error = ""
    elif plugin_saved:
        error = (
            f"The plugin saved the key, but {key_location} is not reachable. A caching or security rule "
            f"may block .txt files — upload a file named {key}.txt containing {key} to the site root, then Verify."
        )
    else:
        error = (
            "The Riviso connector plugin is missing or older than 0.7.0. Update the plugin, or upload a file "
            f"named {key}.txt containing {key} to the site root, then Verify."
        )

    updates = {
        "indexnow_key": key,
        "indexnow_key_location": key_location if verified else "",
        "indexnow_error": error,
    }
    await run_sync(st.update_project_fields, proj["id"], updates)
    return {**updates, "verified": verified, "plugin_saved": plugin_saved, "checked_at": _now_str()}
