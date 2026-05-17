"""Create WordPress posts via connector plugin (preferred) or core REST."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.services.wordpress_client import WordpressClient

log = logging.getLogger(__name__)

_PLUGIN_NAMESPACES = ("riviso/v1", "auto-articles/v1")


def _normalize_rest_base(post_type: str) -> str:
    base = (post_type or "posts").strip().lower() or "posts"
    if base in {"post", "posts"}:
        return "posts"
    return base


def _wp_post_type_slug(rest_base: str) -> str:
    """Map REST collection name to ``wp_insert_post`` post_type slug."""
    if rest_base in {"posts", "post"}:
        return "post"
    return rest_base


def _plugin_payload(*, rest_base: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "post_type": _wp_post_type_slug(rest_base),
        "title": payload.get("title"),
        "content": payload.get("content"),
        "status": payload.get("status"),
        "categories": payload.get("categories"),
        "featured_media": payload.get("featured_media"),
        "meta": payload.get("meta"),
        "tags": payload.get("tags"),
    }


async def _post_plugin_publish(wp: WordpressClient, namespace: str, body: dict[str, Any]) -> dict[str, Any]:
    created = await wp.post_json(f"/wp-json/{namespace}/publish", body, timeout=90.0)
    if not isinstance(created, dict):
        raise RuntimeError("Unexpected WordPress plugin publish response")
    return created


async def _post_core_rest(wp: WordpressClient, rest_base: str, payload: dict[str, Any]) -> dict[str, Any]:
    created = await wp.post_json(f"/wp-json/wp/v2/{rest_base}", payload, timeout=90.0)
    if not isinstance(created, dict):
        raise RuntimeError("Unexpected WordPress REST response")
    return created


def _http_detail(exc: BaseException) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        try:
            data = exc.response.json()
            if isinstance(data, dict):
                msg = (data.get("message") or "").strip()
                code = (data.get("code") or "").strip()
                if msg and code:
                    return f"{msg} ({code})"
                if msg:
                    return msg
        except Exception:
            pass
        return f"HTTP {exc.response.status_code}"
    return str(exc) or exc.__class__.__name__


async def publish_post_to_wordpress(
    wp: WordpressClient,
    *,
    post_type: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """
    Publish using Riviso connector ``POST /publish`` when available, else core ``/wp/v2/{type}``.

    Retries with a slimmer payload when security plugins reject meta/tags/media fields.
    """
    rest_base = _normalize_rest_base(post_type)
    plugin_body = _plugin_payload(rest_base=rest_base, payload=payload)
    attempts: list[tuple[str, dict[str, Any]]] = []

    for ns in _PLUGIN_NAMESPACES:
        attempts.append((f"plugin:{ns}", dict(plugin_body)))

    core = dict(payload)
    attempts.append((f"core:{rest_base}", core))

    slim = dict(payload)
    slim.pop("tags", None)
    attempts.append((f"core:{rest_base}:no-tags", slim))

    slimmer = dict(slim)
    slimmer.pop("meta", None)
    attempts.append((f"core:{rest_base}:no-meta", slimmer))

    minimal = {
        "title": payload.get("title"),
        "content": payload.get("content"),
        "status": payload.get("status"),
    }
    if payload.get("categories"):
        minimal["categories"] = payload["categories"]
    attempts.append((f"core:{rest_base}:minimal", minimal))

    last_err: Exception | None = None
    for label, body in attempts:
        try:
            if label.startswith("plugin:"):
                ns = label.split(":", 1)[1]
                return await _post_plugin_publish(wp, ns, body)
            return await _post_core_rest(wp, rest_base, body)
        except Exception as e:
            last_err = e
            log.debug("WP publish attempt %s failed: %s", label, _http_detail(e))
            continue

    if last_err is not None:
        raise RuntimeError(
            "WordPress publish failed after all attempts. "
            f"Last error: {_http_detail(last_err)}. "
            "Install/activate the Riviso connector plugin, confirm the user can Publish posts, "
            "and allow POST to wp-json/wp/v2/posts in your security plugin."
        ) from last_err
    raise RuntimeError("WordPress publish failed")


def _publish_validate_response_ok(data: Any) -> bool:
    return (
        isinstance(data, dict)
        and data.get("ok") is True
        and data.get("can_publish") is True
    )


async def probe_publish_permission(
    *,
    wp_site_url: str,
    headers: dict[str, str],
    client: httpx.AsyncClient,
) -> tuple[bool, str]:
    """Return whether the Riviso connector publish route confirms publish_posts."""
    for ns in _PLUGIN_NAMESPACES:
        url = f"{wp_site_url}/wp-json/{ns}/publish"
        try:
            res = await client.post(
                url,
                headers={**headers, "content-type": "application/json"},
                json={"validate_only": True},
            )
            if res.status_code == 200 and _publish_validate_response_ok(res.json()):
                return True, ""
        except Exception:
            pass

    try:
        res = await client.request("OPTIONS", f"{wp_site_url}/wp-json/wp/v2/posts", headers=headers)
        allow = (res.headers.get("allow") or "").upper()
        if "POST" in allow:
            return True, ""
    except Exception:
        pass

    # Minimal create + trash — only if plugin missing; skip destructive probe on production.
    return False, (
        "Could not confirm publish permission. Install the Riviso connector plugin and ensure the "
        "WordPress user has the Editor role (publish_posts). Some hosts block POST to wp/v2/posts even "
        "when GET works."
    )
