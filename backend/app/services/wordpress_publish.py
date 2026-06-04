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
    body: dict[str, Any] = {
        "post_type": _wp_post_type_slug(rest_base),
        "title": payload.get("title"),
        "content": payload.get("content"),
        "status": payload.get("status"),
        "categories": payload.get("categories"),
        "featured_media": payload.get("featured_media"),
        "meta": payload.get("meta"),
    }
    tag_names = payload.get("tag_names")
    if isinstance(tag_names, list) and tag_names:
        body["tag_names"] = [str(t).strip()[:200] for t in tag_names if str(t).strip()][:15]
    elif payload.get("tags"):
        body["tags"] = payload.get("tags")
    return body


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
    await wp.ensure_resolved_site_url()
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
    plugin_auth_block = False
    for label, body in attempts:
        try:
            if label.startswith("plugin:"):
                ns = label.split(":", 1)[1]
                return await _post_plugin_publish(wp, ns, body)
            return await _post_core_rest(wp, rest_base, body)
        except httpx.HTTPStatusError as e:
            last_err = e
            if label.startswith("plugin:") and e.response.status_code in (401, 403):
                plugin_auth_block = True
            log.debug("WP publish attempt %s failed: %s", label, _http_detail(e))
            continue
        except Exception as e:
            last_err = e
            log.debug("WP publish attempt %s failed: %s", label, _http_detail(e))
            continue

    if last_err is not None:
        status = last_err.response.status_code if isinstance(last_err, httpx.HTTPStatusError) else None
        if plugin_auth_block or status in (401, 403):
            raise RuntimeError(
                "WordPress blocked publishing (HTTP 403). Confirm RivisoSEO v0.6.1+ is active, "
                "re-verify with an Editor/Admin application password (WordPress username, not email), "
                "and allow POST to wp-json/riviso/v1/publish and wp-json/wp/v2/posts in your "
                "host security plugin."
            ) from last_err
        raise RuntimeError(
            "WordPress publish failed after all attempts. "
            f"Last error: {_http_detail(last_err)}. "
            "Install/activate the Riviso connector plugin, confirm the user can Publish posts, "
            "and allow POST to wp-json/wp/v2/posts in your security plugin."
        ) from last_err
    raise RuntimeError("WordPress publish failed")


def _plugin_update_body(*, wp_post_id: int, rest_base: str, payload: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {
        "post_id": int(wp_post_id),
        "post_type": _wp_post_type_slug(rest_base),
        "title": payload.get("title"),
        "content": payload.get("content"),
        "status": payload.get("status"),
        "categories": payload.get("categories"),
        "featured_media": payload.get("featured_media"),
        "meta": payload.get("meta"),
    }
    tag_names = payload.get("tag_names")
    if isinstance(tag_names, list) and tag_names:
        body["tag_names"] = [str(t).strip()[:200] for t in tag_names if str(t).strip()][:15]
    elif payload.get("tags"):
        body["tags"] = payload.get("tags")
    return body


async def _post_plugin_update(wp: WordpressClient, namespace: str, body: dict[str, Any]) -> dict[str, Any]:
    updated = await wp.post_json(f"/wp-json/{namespace}/update", body, timeout=90.0)
    if not isinstance(updated, dict):
        raise RuntimeError("Unexpected WordPress plugin update response")
    return updated


async def update_post_on_wordpress(
    wp: WordpressClient,
    *,
    post_type: str,
    wp_post_id: int,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Update an existing WordPress post via connector plugin (preferred) or core REST."""
    # Resolve canonical site URL first so redirecting sites (http→https, www→non-www)
    # don't strip the Authorization header mid-request and silently fail.
    await wp.ensure_resolved_site_url()
    rest_base = _normalize_rest_base(post_type)
    pid = int(wp_post_id)
    if pid <= 0:
        raise ValueError("Invalid WordPress post id")

    plugin_body = _plugin_update_body(wp_post_id=pid, rest_base=rest_base, payload=payload)
    attempts: list[tuple[str, dict[str, Any] | None]] = []

    for ns in _PLUGIN_NAMESPACES:
        attempts.append((f"plugin:{ns}", dict(plugin_body)))

    # Core REST: try both PUT and POST — some hosts (e.g. Cloudflare, Nginx configs)
    # block the PUT method. WordPress accepts POST to the same endpoint for updates.
    core_endpoint = f"/wp-json/wp/v2/{rest_base}/{pid}"
    no_tags = {k: v for k, v in payload.items() if k != "tags"}
    no_meta = {k: v for k, v in payload.items() if k not in {"tags", "meta"}}
    minimal = {k: payload[k] for k in ("title", "content", "status", "categories", "featured_media") if k in payload}

    attempts.extend(
        [
            (f"core-put:{rest_base}", dict(payload)),
            (f"core-post:{rest_base}", dict(payload)),
            (f"core-put:{rest_base}:no-tags", no_tags),
            (f"core-post:{rest_base}:no-tags", no_tags),
            (f"core-put:{rest_base}:no-meta", no_meta),
            (f"core-post:{rest_base}:no-meta", no_meta),
            (f"core-put:{rest_base}:minimal", minimal),
            (f"core-post:{rest_base}:minimal", minimal),
        ]
    )

    last_err: Exception | None = None
    for label, body in attempts:
        if body is None:
            continue
        try:
            if label.startswith("plugin:"):
                ns = label.split(":", 1)[1]
                return await _post_plugin_update(wp, ns, body)
            if label.startswith("core-post:"):
                updated = await wp.post_json(core_endpoint, body, timeout=90.0)
            else:
                updated = await wp.put_json(core_endpoint, body, timeout=90.0)
            if not isinstance(updated, dict):
                raise RuntimeError("Unexpected WordPress REST update response")
            return updated
        except Exception as e:
            last_err = e
            log.debug("WP update attempt %s failed: %s", label, _http_detail(e))
            continue

    if last_err is not None:
        raise RuntimeError(
            "WordPress update failed after all attempts. "
            f"Last error: {_http_detail(last_err)}."
        ) from last_err
    raise RuntimeError("WordPress update failed")


def _publish_validate_response_ok(data: Any) -> bool:
    return (
        isinstance(data, dict)
        and data.get("ok") is True
        and data.get("can_publish") is True
    )


async def assert_wordpress_publish_ready(wp: WordpressClient) -> None:
    """
    Fail fast when WordPress blocks POST publish before media/tags/upload work.

    Raises ``RuntimeError`` with an actionable message for HTTP 401/403.
    """
    await wp.ensure_resolved_site_url()
    ok, detail = await probe_publish_permission_on_client(wp)
    if ok:
        return
    raise RuntimeError(detail or (
        "WordPress blocked publishing for this account. Re-verify in Project Settings with an "
        "Editor or Administrator application password, and allow POST to wp-json/riviso/v1/publish "
        "in your security plugin (Wordfence, etc.)."
    ))


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
            if res.status_code in (401, 403):
                detail = _wp_error_snippet_from_response(res)
                return False, (
                    "WordPress rejected the publish request (HTTP "
                    f"{res.status_code}). {detail or 'Use an Editor/Admin application password.'}"
                )
        except Exception:
            pass

    try:
        res = await client.request("OPTIONS", f"{wp_site_url}/wp-json/wp/v2/posts", headers=headers)
        allow = (res.headers.get("allow") or "").upper()
        if "POST" in allow:
            return True, ""
    except Exception:
        pass

    return False, (
        "Could not confirm publish permission. Install the Riviso connector plugin and ensure the "
        "WordPress user has the Editor role (publish_posts). Some hosts block POST to wp/v2/posts even "
        "when GET works."
    )


async def probe_publish_permission_on_client(wp: WordpressClient) -> tuple[bool, str]:
    """Probe Riviso ``/publish`` validate_only using the client's resolved site URL."""
    base = await wp.ensure_resolved_site_url()
    headers = {**wp.auth_headers(), "content-type": "application/json"}
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        return await probe_publish_permission(
            wp_site_url=base,
            headers=headers,
            client=client,
        )


def _wp_error_snippet_from_response(res: httpx.Response) -> str:
    try:
        data = res.json()
        if isinstance(data, dict):
            msg = (data.get("message") or "").strip()
            code = (data.get("code") or "").strip()
            if msg and code:
                return f"{msg} ({code})"
            if msg:
                return msg
    except Exception:
        pass
    return ""
