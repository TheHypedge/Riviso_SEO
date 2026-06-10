"""MongoDB-backed persistence.

All project/article data is read and written here only (MongoDB is the source of truth).
Do not load or save `data/projects.json` / `data/articles.json` from app routes — use
`scripts/import_json_to_db.py` or opt-in startup import via AUTO_IMPORT_JSON=1.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import threading
import time
import base64
from datetime import date, datetime, timedelta
from typing import Any

from database import get_db, init_db

_log = logging.getLogger(__name__)


def _coerce_str_list(val: object) -> list[str]:
    """Normalize list fields from Mongo/JSON (avoids TypeError when value is a scalar)."""
    if val is None:
        return []
    if isinstance(val, list):
        return [str(x).strip() for x in val if str(x).strip()]
    if isinstance(val, (tuple, set)):
        return [str(x).strip() for x in val if str(x).strip()]
    if isinstance(val, str):
        s = val.strip()
        if not s:
            return []
        if "," in s:
            return [p.strip() for p in s.split(",") if p.strip()]
        return [s]
    s = str(val).strip()
    return [s] if s else []


_db_write_lock = threading.Lock()
_storage_mode: str = "mongo"  # "mongo" | "json"
_storage_init_error: str | None = None


def _data_path(filename: str) -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, "data", filename)


def _data_path(filename: str) -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, "data", filename)


def _article_images_dir(*, ensure: bool = False) -> str:
    path = _data_path("article_images")
    if ensure:
        os.makedirs(path, exist_ok=True)
    return path


def _article_image_file_path(article_id: str, *, ensure_dir: bool = False) -> str:
    safe = re.sub(r"[^\w\-]", "", (article_id or "").strip()) or "unknown"
    return os.path.join(_article_images_dir(ensure=ensure_dir), f"{safe}.png")


def _article_image_meta_path(article_id: str) -> str:
    return _article_image_file_path(article_id) + ".meta.json"


def featured_image_file_exists(article_id: str) -> bool:
    aid = (article_id or "").strip()
    images_dir = _article_images_dir()
    safe = re.sub(r"[^\w\-]", "", aid) or "unknown"
    if os.path.isfile(os.path.join(images_dir, f"{safe}.png")):
        return True
    return os.path.isfile(os.path.join(images_dir, f"{safe}.bin"))


def article_has_stored_featured_image(*, article_id: str = "", row: dict | None = None) -> bool:
    """True when a featured image exists in Mongo, on disk, or inline on the row."""
    r = row or {}
    if (r.get("image_url") or "").strip():
        return True
    if (r.get("featured_image_generated_at") or "").strip():
        return True
    storage = (r.get("featured_image_storage") or "").strip()
    if storage in {"file", "url", "inline"}:
        return True
    aid = (article_id or r.get("id") or "").strip()
    return bool(aid and featured_image_file_exists(aid))


def _persist_featured_image_file(article_id: str, image_url: str) -> bool:
    """Write a data-URL or raw base64 image to disk; return True on success."""
    raw = (image_url or "").strip()
    if not raw.startswith("data:"):
        return False
    m = re.match(r"^data:([^;]+);base64,(.+)$", raw, flags=re.DOTALL)
    if not m:
        return False
    content_type, b64 = m.group(1), m.group(2)
    try:
        data = base64.b64decode(b64, validate=True)
    except Exception:
        return False
    bin_path = _article_image_file_path(article_id, ensure_dir=True)
    meta_path = _article_image_meta_path(article_id)
    tmp = bin_path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, bin_path)
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump({"content_type": content_type or "image/png"}, f)
    return True


def _load_featured_image_file_as_data_url(article_id: str) -> str | None:
    aid = (article_id or "").strip()
    bin_path = _article_image_file_path(aid)
    if not os.path.isfile(bin_path):
        legacy = os.path.join(_article_images_dir(), f"{re.sub(r'[^\w\-]', '', aid) or 'unknown'}.bin")
        if os.path.isfile(legacy):
            bin_path = legacy
        else:
            return None
    try:
        with open(bin_path, "rb") as f:
            data = f.read()
    except OSError:
        return None
    content_type = "image/png"
    meta_path = _article_image_meta_path(article_id)
    if os.path.isfile(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            if isinstance(meta, dict) and meta.get("content_type"):
                content_type = str(meta["content_type"])
        except Exception:
            pass
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{content_type};base64,{b64}"


def _download_and_persist_image_url(article_id: str, url: str) -> bool:
    """Download an HTTPS image URL and save it to disk as a file-backed image.

    Returns True on success.  Called synchronously because this runs inside
    patch_article_fields/update_article_fields which are already blocking calls.
    """
    import urllib.request as _req
    aid = (article_id or "").strip()
    url = (url or "").strip()
    if not url.startswith("http://") and not url.startswith("https://"):
        return False
    try:
        with _req.urlopen(url, timeout=30) as resp:  # nosec — URL comes from OpenAI CDN
            content_type = (resp.headers.get("content-type") or "image/png").split(";")[0].strip()
            data = resp.read()
        if not data:
            return False
        b64 = base64.b64encode(data).decode("ascii")
        data_url = f"data:{content_type or 'image/png'};base64,{b64}"
        return _persist_featured_image_file(aid, data_url)
    except Exception:
        return False


def _externalize_featured_image_in_updates(article_id: str, updates: dict[str, Any]) -> dict[str, Any]:
    """
    Keep Mongo writes small: store multi-MB data URLs on disk, persist only metadata in Mongo.

    HTTPS URLs (e.g. OpenAI CDN) are now also downloaded and stored on disk so
    that they remain available after the CDN URL expires (~1 hour for OpenAI).
    Without this, articles scheduled for later the same day or the next day would
    silently publish without a featured image because the CDN link had expired.
    """
    u2 = dict(updates or {})
    img = (u2.get("image_url") or "").strip()
    if not img:
        return u2
    if img.startswith("http://") or img.startswith("https://"):
        # Download and persist to disk so the URL can't expire before publish.
        if _download_and_persist_image_url(article_id, img):
            u2["image_url"] = ""
            u2["featured_image_storage"] = "file"
        else:
            # Download failed (network, permissions, etc.) — keep the URL inline
            # as a best-effort fallback; publish will attempt to re-download it.
            u2["featured_image_storage"] = "url"
        return u2
    if img.startswith("data:") or len(img) > 80_000:
        try:
            saved = _persist_featured_image_file(article_id, img)
        except Exception:
            saved = False
        if saved:
            u2["image_url"] = ""
            u2["featured_image_storage"] = "file"
        else:
            # Disk write failed (e.g. permissions) — store inline as fallback.
            u2["featured_image_storage"] = "inline"
    return u2


def _users_json_path() -> str:
    return _data_path("users.json")


def _load_json_users() -> list[dict[str, Any]]:
    path = _users_json_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return [x for x in data if isinstance(x, dict)]
    except FileNotFoundError:
        return []
    except (json.JSONDecodeError, OSError, TypeError):
        return []
    return []


def _save_json_users(users: list[dict[str, Any]]) -> None:
    path = _users_json_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(users, f, indent=2, ensure_ascii=False)
        f.write("\n")


def _user_row_to_public(u: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": (u.get("id") or "").strip(),
        "email": (u.get("email") or "").strip(),
        "password_hash": (u.get("password_hash") or "").strip(),
        "role": (u.get("role") or "user").strip().lower(),
        "full_name": (u.get("full_name") or "").strip(),
        "phone": (u.get("phone") or "").strip(),
        "timezone": (u.get("timezone") or "").strip(),
        "address": (u.get("address") or "").strip(),
        "subscription_type": (u.get("subscription_type") or "beta").strip().lower(),
        "last_activity_at": (u.get("last_activity_at") or "").strip(),
        "account_status": (u.get("account_status") or "active").strip().lower(),
        "is_deleted": bool(u.get("is_deleted", False)),
        "is_deactivated": bool(u.get("is_deactivated", False)),
        "deleted_at": (u.get("deleted_at") or "").strip(),
        "deactivated_at": (u.get("deactivated_at") or "").strip(),
        "deletion_requested_at": (u.get("deletion_requested_at") or "").strip(),
        "reactivated_at": (u.get("reactivated_at") or "").strip(),
        "retention_reason": (u.get("retention_reason") or "").strip(),
        "retargeting_retained": bool(u.get("retargeting_retained", False)),
        "usage_daily_articles_date": (u.get("usage_daily_articles_date") or "").strip(),
        "usage_daily_articles_count": int(u.get("usage_daily_articles_count") or 0),
        "usage_monthly_articles_month": (u.get("usage_monthly_articles_month") or "").strip(),
        "usage_monthly_articles_count": int(u.get("usage_monthly_articles_count") or 0),
        "usage_monthly_llm_tokens_month": (u.get("usage_monthly_llm_tokens_month") or "").strip(),
        "usage_monthly_llm_tokens_used": int(u.get("usage_monthly_llm_tokens_used") or 0),
        "created_at": (u.get("created_at") or "").strip(),
        "pending_product_tour": bool(u.get("pending_product_tour", False)),
        # Google Search Console OAuth (stored per-user)
        "gsc_access_token": (u.get("gsc_access_token") or "").strip(),
        "gsc_refresh_token": (u.get("gsc_refresh_token") or "").strip(),
        "gsc_token_expires_at": str(u.get("gsc_token_expires_at") or "").strip(),
        "gsc_scope": (u.get("gsc_scope") or "").strip(),
        "gsc_email": (u.get("gsc_email") or "").strip(),
        "gsc_connected_at": (u.get("gsc_connected_at") or "").strip(),
    }


def _load_json_list(filename: str) -> list[dict[str, Any]]:
    path = _data_path(filename)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return [x for x in data if isinstance(x, dict)]
        return []
    except FileNotFoundError:
        return []
    except Exception:
        return []


def _save_json_articles(articles: list[dict[str, Any]]) -> None:
    """Persist full article list when using JSON storage fallback (see init_storage)."""
    path = _data_path("articles.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(articles, f, indent=2, ensure_ascii=False)
        f.write("\n")


def _save_json_projects(projects: list[dict[str, Any]]) -> None:
    """Persist full project list when using JSON storage fallback (see init_storage)."""
    path = _data_path("projects.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(projects, f, indent=2, ensure_ascii=False)
        f.write("\n")


def _save_json_scheduled_jobs(rows: list[dict[str, Any]]) -> None:
    """Persist scheduled jobs list when using JSON storage fallback."""
    path = _data_path("scheduled_jobs.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2, ensure_ascii=False)
        f.write("\n")


def _save_json(filename: str, rows: list[dict[str, Any]]) -> None:
    """Generic JSON list saver for collections without a dedicated helper."""
    path = _data_path(filename)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2, ensure_ascii=False)
        f.write("\n")


def storage_mode() -> str:
    return _storage_mode


def storage_init_error() -> str | None:
    return _storage_init_error


def _coerce_user_id_str(val: Any) -> str:
    """Normalize user id from Mongo/JSON (string, ObjectId, etc.) for comparisons."""
    if val is None or val == "":
        return ""
    if isinstance(val, str):
        return val.strip()
    return str(val).strip()


def _mongo_owner_user_id_filter(owner_user_id: str) -> dict[str, Any]:
    """
    Match projects.owner_user_id for the logged-in user.

    Mongo may store owner_user_id as a string, legacy 24-hex ObjectId, or alternate casing
    for UUID strings — exact equality on a single string misses rows.
    """
    oid = (owner_user_id or "").strip()
    if not oid:
        return {}
    from bson import ObjectId

    clauses: list[dict[str, Any]] = [{"owner_user_id": oid}]
    lo, hi = oid.casefold(), oid.upper()
    if lo != oid:
        clauses.append({"owner_user_id": lo})
    if hi != oid and hi != lo:
        clauses.append({"owner_user_id": hi})
    if len(oid) == 24 and ObjectId.is_valid(oid):
        try:
            clauses.append({"owner_user_id": ObjectId(oid)})
        except Exception:
            pass
    if len(clauses) == 1:
        return clauses[0]
    return {"$or": clauses}


def _normalize_project_dict(d: dict[str, Any]) -> dict[str, Any]:
    pid = (d.get("id") or "").strip()
    if not pid:
        raise ValueError("project id is required")
    return {
        "id": pid,
        "owner_user_id": _coerce_user_id_str(d.get("owner_user_id")),
        "name": (d.get("name") or "")[:500],
        "website_url": (d.get("website_url") or "")[:2048],
        # Project intelligence / brand flavor.
        # ``brand_identity`` and ``niche_identifier`` remain as flat strings
        # because the LLM prompt builder consumes them directly. They are
        # auto-derived from the structured fields below whenever those are
        # written, but we still persist them so legacy projects (no
        # structured input) keep working unchanged.
        "brand_identity": (d.get("brand_identity") or "")[:20000],
        "niche_identifier": (d.get("niche_identifier") or "")[:20000],
        # Structured Brand identity inputs (Project Settings → "Brand
        # identity & niche"): one voice, multiple tones, plus a short
        # rules block. Stored as plain text/list so the legacy JSON
        # storage backend handles it without schema migration.
        "brand_voice": (d.get("brand_voice") or "")[:64],
        "brand_tones": [str(x)[:64] for x in (d.get("brand_tones") or []) if str(x).strip()][:10],
        "brand_rules": (d.get("brand_rules") or "")[:4000],
        # Structured Niche identifier inputs.
        "niche_topic": (d.get("niche_topic") or "")[:500],
        "audience": [str(x)[:120] for x in (d.get("audience") or []) if str(x).strip()][:30],
        "target_countries": [
            str(x).strip().upper()[:8]
            for x in (d.get("target_countries") or [])
            if str(x).strip()
        ][:270],
        "target_countries_all": bool(d.get("target_countries_all", False)),
        "target_cities": [str(x)[:120] for x in (d.get("target_cities") or []) if str(x).strip()][:500],
        "target_cities_all": bool(d.get("target_cities_all", False)),
        "wp_site_url": (d.get("wp_site_url") or "")[:2048] or "",
        "wp_username": (d.get("wp_username") or "")[:500],
        "wp_app_password": (d.get("wp_app_password") or "")[:500],
        "wp_category_ids": (d.get("wp_category_ids") or "")[:500],
        "prompts": list(d.get("prompts") or []),
        "default_prompt_id": (d.get("default_prompt_id") or "").strip(),
        "image_prompts": list(d.get("image_prompts") or []),
        "default_image_prompt_id": (d.get("default_image_prompt_id") or "").strip(),
        # Content Engine V2 — reusable structured-brief presets, the
        # guided-form successor to the flat "writing prompts" list above.
        # Net-new and additive; `prompts`/`default_prompt_id` are untouched.
        "content_brief_templates": list(d.get("content_brief_templates") or []),
        "default_content_brief_template_id": (d.get("default_content_brief_template_id") or "").strip(),
        "image_style": (d.get("image_style") or "semi_real")[:32],
        "optimize_image_prompt": bool(d.get("optimize_image_prompt", True)),
        "context_links": list(d.get("context_links") or []),
        "gsc_property_url": (d.get("gsc_property_url") or "")[:2048],
        "gsc_index_on_publish": bool(d.get("gsc_index_on_publish", True)),
        # Per-project Google Search Console OAuth (each project can be linked to a separate Google account / property).
        "gsc_access_token": (d.get("gsc_access_token") or "").strip()[:5000],
        "gsc_refresh_token": (d.get("gsc_refresh_token") or "").strip()[:5000],
        "gsc_token_expires_at": str(d.get("gsc_token_expires_at") or "").strip()[:32],
        "gsc_scope": (d.get("gsc_scope") or "").strip()[:2000],
        "gsc_email": (d.get("gsc_email") or "").strip()[:500],
        "gsc_connected_at": (d.get("gsc_connected_at") or "").strip()[:64],
        "default_wp_rest_base": (d.get("default_wp_rest_base") or "")[:200],
        "default_wp_status": (d.get("default_wp_status") or "")[:32],
        # WordPress verification snapshot. Populated by the verify route on
        # success, cleared by /settings PATCH when credentials change.
        "wp_verified_at": (d.get("wp_verified_at") or "")[:32],
        "wp_verified_status": (d.get("wp_verified_status") or "")[:32],
        "wp_verified_message": (d.get("wp_verified_message") or "")[:1000],
        # Connector plugin status snapshot (one of: active, installed,
        # capability, missing, unknown). Cleared on credential changes.
        "wp_plugin_status": (d.get("wp_plugin_status") or "")[:32],
        "wp_plugin_message": (d.get("wp_plugin_message") or "")[:1000],
        "platform": ((d.get("platform") or "wordpress").strip().lower() or "wordpress")[:32],
        "shopify_shop": (d.get("shopify_shop") or "").strip()[:2048],
        "shopify_access_token": (d.get("shopify_access_token") or "").strip()[:5000],
        "shopify_client_id": (d.get("shopify_client_id") or "").strip()[:256],
        "shopify_client_secret": (d.get("shopify_client_secret") or "").strip()[:5000],
        "shopify_token_expires_at": (d.get("shopify_token_expires_at") or "").strip()[:32],
        "shopify_scope": (d.get("shopify_scope") or "").strip()[:2000],
        "shopify_connected_at": (d.get("shopify_connected_at") or "").strip()[:64],
        "shopify_verified_at": (d.get("shopify_verified_at") or "").strip()[:32],
        "shopify_verified_status": (d.get("shopify_verified_status") or "").strip()[:32],
        "shopify_verified_message": (d.get("shopify_verified_message") or "").strip()[:1000],
        "shopify_sync_at": (d.get("shopify_sync_at") or "").strip()[:64],
        "shopify_sync_status": (d.get("shopify_sync_status") or "").strip()[:32],
        "shopify_sync_message": (d.get("shopify_sync_message") or "").strip()[:1000],
        "shopify_catalog": d.get("shopify_catalog") if isinstance(d.get("shopify_catalog"), dict) else {},
        "shopify_product_aware_enabled": bool(d.get("shopify_product_aware_enabled", False)),
        "wp_internal_link_aware_enabled": bool(d.get("wp_internal_link_aware_enabled", False)),
        "content_optimization_profile": (d.get("content_optimization_profile") or "none")[:64],
        "humanization_settings": d.get("humanization_settings") if isinstance(d.get("humanization_settings"), dict) else {},
        "created_at": (d.get("created_at") or "")[:64],
    }


def _normalize_user_dict(d: dict[str, Any]) -> dict[str, Any]:
    uid = (d.get("id") or "").strip()
    if not uid:
        raise ValueError("user id is required")
    email = (d.get("email") or "").strip().lower()
    if not email:
        raise ValueError("user email is required")
    account_status = ((d.get("account_status") or "active").strip().lower()[:32]) or "active"
    is_deleted = bool(d.get("is_deleted", False)) or account_status == "deleted"
    is_deactivated = bool(d.get("is_deactivated", False)) or account_status in {"deleted", "deactivated"}
    return {
        "id": uid,
        "email": email[:500],
        "password_hash": (d.get("password_hash") or "").strip(),
        "role": ((d.get("role") or "user").strip().lower()[:32]) or "user",
        "full_name": (d.get("full_name") or "").strip()[:200],
        "phone": (d.get("phone") or "").strip()[:64],
        "timezone": (d.get("timezone") or "").strip()[:64],
        "address": (d.get("address") or "").strip()[:500],
        "subscription_type": ((d.get("subscription_type") or "beta").strip().lower()[:64]) or "beta",
        "last_activity_at": (d.get("last_activity_at") or "").strip()[:64],
        "account_status": account_status,
        "is_deleted": is_deleted,
        "is_deactivated": is_deactivated,
        "deleted_at": (d.get("deleted_at") or "").strip()[:64],
        "deactivated_at": (d.get("deactivated_at") or "").strip()[:64],
        "deletion_requested_at": (d.get("deletion_requested_at") or "").strip()[:64],
        "reactivated_at": (d.get("reactivated_at") or "").strip()[:64],
        "retention_reason": (d.get("retention_reason") or "").strip()[:500],
        "retargeting_retained": bool(d.get("retargeting_retained", False)),
        "usage_daily_articles_date": (d.get("usage_daily_articles_date") or "").strip()[:16],
        "usage_daily_articles_count": int(d.get("usage_daily_articles_count") or 0),
        "usage_monthly_articles_month": (d.get("usage_monthly_articles_month") or "").strip()[:16],
        "usage_monthly_articles_count": int(d.get("usage_monthly_articles_count") or 0),
        "usage_monthly_export_month": (d.get("usage_monthly_export_month") or "").strip()[:16],
        "usage_monthly_export_count": int(d.get("usage_monthly_export_count") or 0),
        "usage_monthly_scheduled_month": (d.get("usage_monthly_scheduled_month") or "").strip()[:16],
        "usage_monthly_scheduled_count": int(d.get("usage_monthly_scheduled_count") or 0),
        "usage_monthly_cluster_plans_month": (d.get("usage_monthly_cluster_plans_month") or "").strip()[:16],
        "usage_monthly_cluster_plans_count": int(d.get("usage_monthly_cluster_plans_count") or 0),
        "usage_monthly_custom_research_month": (d.get("usage_monthly_custom_research_month") or "").strip()[:16],
        "usage_monthly_custom_research_count": int(d.get("usage_monthly_custom_research_count") or 0),
        "usage_monthly_llm_tokens_month": (d.get("usage_monthly_llm_tokens_month") or "").strip()[:16],
        "usage_monthly_llm_tokens_used": int(d.get("usage_monthly_llm_tokens_used") or 0),
        "created_at": (d.get("created_at") or "")[:64],
        "pending_product_tour": bool(d.get("pending_product_tour", False)),
        "email_verification_token": (d.get("email_verification_token") or "").strip()[:128],
        "email_verification_expires": (d.get("email_verification_expires") or "").strip()[:64],
        "email_verification_expires_at": d.get("email_verification_expires_at"),
        "email_verification_sent_at": d.get("email_verification_sent_at"),
        "password_reset_token": (d.get("password_reset_token") or "").strip()[:128],
        "password_reset_expires": (d.get("password_reset_expires") or "").strip()[:64],
        "password_reset_expires_at": d.get("password_reset_expires_at"),
        # Google Search Console OAuth (stored per-user)
        "gsc_access_token": (d.get("gsc_access_token") or "").strip()[:5000],
        "gsc_refresh_token": (d.get("gsc_refresh_token") or "").strip()[:5000],
        "gsc_token_expires_at": str(d.get("gsc_token_expires_at") or "").strip()[:32],
        "gsc_scope": (d.get("gsc_scope") or "").strip()[:2000],
        "gsc_email": (d.get("gsc_email") or "").strip()[:500],
        "gsc_connected_at": (d.get("gsc_connected_at") or "").strip()[:64],
    }


def list_users() -> list[dict[str, Any]]:
    """Admin-only: list all users (public fields; includes password_hash for compatibility with existing code)."""
    if _storage_mode == "json":
        return [_user_row_to_public(u) for u in _load_json_users()]
    if _storage_mode != "mongo":
        return []
    cur = get_db().users.find({}).sort("created_at", 1)
    out: list[dict[str, Any]] = []
    for doc in cur:
        out.append(
            {
                "id": (doc.get("id") or "").strip(),
                "email": (doc.get("email") or "").strip(),
                "password_hash": (doc.get("password_hash") or "").strip(),
                "role": (doc.get("role") or "user").strip().lower(),
                "full_name": (doc.get("full_name") or "").strip(),
                "phone": (doc.get("phone") or "").strip(),
                "timezone": (doc.get("timezone") or "").strip(),
                "address": (doc.get("address") or "").strip(),
                "subscription_type": (doc.get("subscription_type") or "beta").strip().lower(),
                "last_activity_at": (doc.get("last_activity_at") or "").strip(),
                "account_status": (doc.get("account_status") or "active").strip().lower(),
                "is_deleted": bool(doc.get("is_deleted", False)),
                "is_deactivated": bool(doc.get("is_deactivated", False)),
                "deleted_at": (doc.get("deleted_at") or "").strip(),
                "deactivated_at": (doc.get("deactivated_at") or "").strip(),
                "deletion_requested_at": (doc.get("deletion_requested_at") or "").strip(),
                "reactivated_at": (doc.get("reactivated_at") or "").strip(),
                "retention_reason": (doc.get("retention_reason") or "").strip(),
                "retargeting_retained": bool(doc.get("retargeting_retained", False)),
                "created_at": (doc.get("created_at") or "").strip(),
            }
        )
    return out


def update_user_fields(user_id: str, updates: dict[str, Any]) -> bool:
    uid = (user_id or "").strip()
    if not uid:
        return False
    norm_updates = dict(updates or {})
    if "email" in norm_updates:
        norm_updates.pop("email", None)
    if _storage_mode == "json":
        with _db_write_lock:
            users = _load_json_users()
            for i, u in enumerate(users):
                if (u.get("id") or "").strip() != uid:
                    continue
                d = dict(u)
                d.update(norm_updates)
                users[i] = _normalize_user_dict(d)
                _save_json_users(users)
                return True
        return False
    if _storage_mode != "mongo":
        return False
    with _db_write_lock:
        db = get_db()
        doc = db.users.find_one({"id": uid})
        if not doc:
            return False
        d = dict(doc)
        d.pop("_id", None)
        d.update(norm_updates)
        norm = _normalize_user_dict(d)
        new_doc = {**norm, "_id": norm["id"]}
        res = db.users.replace_one({"id": uid}, new_doc)
        return bool(res.acknowledged and res.matched_count == 1)


def _utc_day_key_now() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d")


def _utc_month_key_now() -> str:
    return datetime.utcnow().strftime("%Y-%m")


def _limit_allows(current: int, limit: int | None, amount: int) -> bool:
    # None or 0 means unlimited.
    if limit is None:
        return True
    try:
        lim = int(limit)
    except Exception:
        return True
    if lim <= 0:
        return True
    return (current + amount) <= lim


def consume_article_usage(user_id: str, *, day_limit: int | None, month_limit: int | None, amount: int = 1) -> tuple[bool, str]:
    """
    Consume "article operations" quota (used for generate/publish).
    Uses per-user counters (UTC day + UTC month).
    """
    uid = (user_id or "").strip()
    if not uid:
        return False, "Missing user id"
    day_key = _utc_day_key_now()
    month_key = _utc_month_key_now()

    def _apply(d: dict[str, Any]) -> tuple[bool, str, dict[str, Any]]:
        cur_day = (d.get("usage_daily_articles_date") or "").strip()
        day_count = int(d.get("usage_daily_articles_count") or 0)
        if cur_day != day_key:
            cur_day = day_key
            day_count = 0
        cur_month = (d.get("usage_monthly_articles_month") or "").strip()
        month_count = int(d.get("usage_monthly_articles_count") or 0)
        if cur_month != month_key:
            cur_month = month_key
            month_count = 0
        if not _limit_allows(day_count, day_limit, amount):
            return False, "Daily article limit reached for your plan.", d
        if not _limit_allows(month_count, month_limit, amount):
            return False, "Monthly article limit reached for your plan.", d
        d2 = dict(d)
        d2["usage_daily_articles_date"] = cur_day
        d2["usage_daily_articles_count"] = day_count + amount
        d2["usage_monthly_articles_month"] = cur_month
        d2["usage_monthly_articles_count"] = month_count + amount
        return True, "", d2

    if _storage_mode == "json":
        with _db_write_lock:
            users = _load_json_users()
            for i, u in enumerate(users):
                if (u.get("id") or "").strip() != uid:
                    continue
                ok, msg, upd = _apply(dict(u))
                if not ok:
                    return False, msg
                users[i] = _normalize_user_dict(upd)
                _save_json_users(users)
                return True, ""
        return False, "User not found"

    if _storage_mode != "mongo":
        return True, ""

    with _db_write_lock:
        db = get_db()
        doc = db.users.find_one({"id": uid})
        if not doc:
            return False, "User not found"
        d = dict(doc)
        d.pop("_id", None)
        ok, msg, upd = _apply(d)
        if not ok:
            return False, msg
        norm = _normalize_user_dict(upd)
        new_doc = {**norm, "_id": norm["id"]}
        res = db.users.replace_one({"id": uid}, new_doc)
        if not (res.acknowledged and res.matched_count == 1):
            return False, "Failed to update usage"
        return True, ""


def peek_article_usage_remaining(
    user_id: str,
    *,
    day_limit: int | None,
    month_limit: int | None,
) -> dict[str, Any]:
    """
    Return a snapshot of how many articles the user can still consume right now,
    *without* mutating any counters.

    Limits of ``None``/``0`` mean "unlimited"; we surface that as
    ``*_remaining = None`` and ``max_can_consume_now = None`` so callers can
    distinguish "unlimited" from "0 remaining".

    Used by:

    - ``GET /api/projects/{id}/article-quota`` — frontend pre-flight before the
      Cluster Planner's "Generate selected" button is clicked, so the user
      sees a clear modal instead of a 403 mid-batch.
    - ``POST /topic-clusters/{id}/generate-all`` — server-side guard so a
      partially-generated cluster doesn't burn quota when the request was
      doomed from the start.
    """
    uid = (user_id or "").strip()
    out: dict[str, Any] = {
        "day_used": 0,
        "day_limit": day_limit,
        "day_remaining": None,
        "month_used": 0,
        "month_limit": month_limit,
        "month_remaining": None,
        "max_can_consume_now": None,
        "day_key": _utc_day_key_now(),
        "month_key": _utc_month_key_now(),
    }
    if not uid:
        return out

    # Fetch the user record without taking a write lock — this is a peek.
    if _storage_mode == "json":
        users = _load_json_users()
        user = next((u for u in users if (u.get("id") or "").strip() == uid), None)
    elif _storage_mode == "mongo":
        doc = get_db().users.find_one({"id": uid})
        user = dict(doc) if doc else None
    else:
        user = None

    if not isinstance(user, dict):
        return out

    cur_day = (user.get("usage_daily_articles_date") or "").strip()
    day_count = int(user.get("usage_daily_articles_count") or 0)
    if cur_day != out["day_key"]:
        # Day rolled over — counters are effectively zero for the purpose of this peek.
        day_count = 0
    cur_month = (user.get("usage_monthly_articles_month") or "").strip()
    month_count = int(user.get("usage_monthly_articles_count") or 0)
    if cur_month != out["month_key"]:
        month_count = 0

    out["day_used"] = day_count
    out["month_used"] = month_count

    def _remaining(used: int, limit: int | None) -> int | None:
        if limit is None:
            return None
        try:
            lim = int(limit)
        except Exception:
            return None
        if lim <= 0:
            return None  # 0 / negative → unlimited
        return max(0, lim - used)

    out["day_remaining"] = _remaining(day_count, day_limit)
    out["month_remaining"] = _remaining(month_count, month_limit)

    if out["day_remaining"] is None and out["month_remaining"] is None:
        out["max_can_consume_now"] = None  # unlimited
    elif out["day_remaining"] is None:
        out["max_can_consume_now"] = out["month_remaining"]
    elif out["month_remaining"] is None:
        out["max_can_consume_now"] = out["day_remaining"]
    else:
        out["max_can_consume_now"] = min(out["day_remaining"], out["month_remaining"])
    return out


def refund_article_usage(user_id: str, *, amount: int = 1) -> tuple[bool, str]:
    """
    Decrement the per-user article counters previously incremented by
    :func:`consume_article_usage`. Used when generation fails after quota was consumed,
    so a transient OpenAI/network error does not burn a user's daily/monthly slot.

    Counters are only refunded when the stored day/month key still matches "now"; if a
    day/month rollover happened between consume and refund, the refund is a no-op (the
    historical counter was already reset).

    Counters never drop below zero. The function is idempotent if the article was never
    consumed (counters at zero stay at zero).
    """
    if amount <= 0:
        return True, ""
    uid = (user_id or "").strip()
    if not uid:
        return False, "Missing user id"
    day_key = _utc_day_key_now()
    month_key = _utc_month_key_now()

    def _apply(d: dict[str, Any]) -> dict[str, Any]:
        d2 = dict(d)
        cur_day = (d2.get("usage_daily_articles_date") or "").strip()
        if cur_day == day_key:
            day_count = int(d2.get("usage_daily_articles_count") or 0)
            d2["usage_daily_articles_count"] = max(0, day_count - amount)
        cur_month = (d2.get("usage_monthly_articles_month") or "").strip()
        if cur_month == month_key:
            month_count = int(d2.get("usage_monthly_articles_count") or 0)
            d2["usage_monthly_articles_count"] = max(0, month_count - amount)
        return d2

    if _storage_mode == "json":
        with _db_write_lock:
            users = _load_json_users()
            for i, u in enumerate(users):
                if (u.get("id") or "").strip() != uid:
                    continue
                users[i] = _normalize_user_dict(_apply(dict(u)))
                _save_json_users(users)
                return True, ""
        return False, "User not found"

    if _storage_mode != "mongo":
        return True, ""

    with _db_write_lock:
        db = get_db()
        doc = db.users.find_one({"id": uid})
        if not doc:
            return False, "User not found"
        d = dict(doc)
        d.pop("_id", None)
        upd = _apply(d)
        norm = _normalize_user_dict(upd)
        new_doc = {**norm, "_id": norm["id"]}
        res = db.users.replace_one({"id": uid}, new_doc)
        if not (res.acknowledged and res.matched_count == 1):
            return False, "Failed to refund usage"
        return True, ""


def consume_export_usage(user_id: str, *, month_limit: int | None, amount: int = 1) -> tuple[bool, str]:
    uid = (user_id or "").strip()
    if not uid:
        return False, "Missing user id"
    month_key = _utc_month_key_now()

    def _apply(d: dict[str, Any]) -> tuple[bool, str, dict[str, Any]]:
        cur_month = (d.get("usage_monthly_export_month") or "").strip()
        count = int(d.get("usage_monthly_export_count") or 0)
        if cur_month != month_key:
            cur_month = month_key
            count = 0
        if not _limit_allows(count, month_limit, amount):
            return False, "Monthly export limit reached for your plan.", d
        d2 = dict(d)
        d2["usage_monthly_export_month"] = cur_month
        d2["usage_monthly_export_count"] = count + amount
        return True, "", d2

    if _storage_mode == "json":
        with _db_write_lock:
            users = _load_json_users()
            for i, u in enumerate(users):
                if (u.get("id") or "").strip() != uid:
                    continue
                ok, msg, upd = _apply(dict(u))
                if not ok:
                    return False, msg
                users[i] = _normalize_user_dict(upd)
                _save_json_users(users)
                return True, ""
        return False, "User not found"

    if _storage_mode != "mongo":
        return True, ""

    with _db_write_lock:
        db = get_db()
        doc = db.users.find_one({"id": uid})
        if not doc:
            return False, "User not found"
        d = dict(doc)
        d.pop("_id", None)
        ok, msg, upd = _apply(d)
        if not ok:
            return False, msg
        norm = _normalize_user_dict(upd)
        new_doc = {**norm, "_id": norm["id"]}
        res = db.users.replace_one({"id": uid}, new_doc)
        if not (res.acknowledged and res.matched_count == 1):
            return False, "Failed to update usage"
        return True, ""


def consume_scheduled_usage(user_id: str, *, month_limit: int | None, amount: int = 1) -> tuple[bool, str]:
    uid = (user_id or "").strip()
    if not uid:
        return False, "Missing user id"
    month_key = _utc_month_key_now()

    def _apply(d: dict[str, Any]) -> tuple[bool, str, dict[str, Any]]:
        cur_month = (d.get("usage_monthly_scheduled_month") or "").strip()
        count = int(d.get("usage_monthly_scheduled_count") or 0)
        if cur_month != month_key:
            cur_month = month_key
            count = 0
        if not _limit_allows(count, month_limit, amount):
            return False, "Monthly schedule limit reached for your plan.", d
        d2 = dict(d)
        d2["usage_monthly_scheduled_month"] = cur_month
        d2["usage_monthly_scheduled_count"] = count + amount
        return True, "", d2

    if _storage_mode == "json":
        with _db_write_lock:
            users = _load_json_users()
            for i, u in enumerate(users):
                if (u.get("id") or "").strip() != uid:
                    continue
                ok, msg, upd = _apply(dict(u))
                if not ok:
                    return False, msg
                users[i] = _normalize_user_dict(upd)
                _save_json_users(users)
                return True, ""
        return False, "User not found"

    if _storage_mode != "mongo":
        return True, ""

    with _db_write_lock:
        db = get_db()
        doc = db.users.find_one({"id": uid})
        if not doc:
            return False, "User not found"
        d = dict(doc)
        d.pop("_id", None)
        ok, msg, upd = _apply(d)
        if not ok:
            return False, msg
        norm = _normalize_user_dict(upd)
        new_doc = {**norm, "_id": norm["id"]}
        res = db.users.replace_one({"id": uid}, new_doc)
        if not (res.acknowledged and res.matched_count == 1):
            return False, "Failed to update usage"
        return True, ""


def _consume_monthly_counter(
    user_id: str,
    *,
    month_field: str,
    count_field: str,
    month_limit: int | None,
    amount: int = 1,
    limit_message: str,
) -> tuple[bool, str]:
    uid = (user_id or "").strip()
    if not uid:
        return False, "Missing user id"
    month_key = _utc_month_key_now()

    def _apply(d: dict[str, Any]) -> tuple[bool, str, dict[str, Any]]:
        cur_month = (d.get(month_field) or "").strip()
        count = int(d.get(count_field) or 0)
        if cur_month != month_key:
            cur_month = month_key
            count = 0
        if not _limit_allows(count, month_limit, amount):
            return False, limit_message, d
        d2 = dict(d)
        d2[month_field] = cur_month
        d2[count_field] = count + amount
        return True, "", d2

    if _storage_mode == "json":
        with _db_write_lock:
            users = _load_json_users()
            for i, u in enumerate(users):
                if (u.get("id") or "").strip() != uid:
                    continue
                ok, msg, upd = _apply(dict(u))
                if not ok:
                    return False, msg
                users[i] = _normalize_user_dict(upd)
                _save_json_users(users)
                return True, ""
        return False, "User not found"

    if _storage_mode != "mongo":
        return True, ""

    with _db_write_lock:
        db = get_db()
        doc = db.users.find_one({"id": uid})
        if not doc:
            return False, "User not found"
        d = dict(doc)
        d.pop("_id", None)
        ok, msg, upd = _apply(d)
        if not ok:
            return False, msg
        norm = _normalize_user_dict(upd)
        new_doc = {**norm, "_id": norm["id"]}
        res = db.users.replace_one({"id": uid}, new_doc)
        if not (res.acknowledged and res.matched_count == 1):
            return False, "Failed to update usage"
        return True, ""


def peek_monthly_counter(user_id: str, *, month_field: str, count_field: str, month_limit: int | None) -> dict[str, Any]:
    uid = (user_id or "").strip()
    month_key = _utc_month_key_now()
    out: dict[str, Any] = {
        "month_used": 0,
        "month_limit": month_limit,
        "month_remaining": None,
        "unlimited": True,
        "month_key": month_key,
    }

    def _remaining(used: int, limit: int | None) -> int | None:
        if limit is None:
            return None
        try:
            lim = int(limit)
        except Exception:
            return None
        if lim <= 0:
            return None
        return max(0, lim - used)

    if not uid:
        return out
    if _storage_mode == "json":
        users = _load_json_users()
        user = next((u for u in users if (u.get("id") or "").strip() == uid), None)
    elif _storage_mode == "mongo":
        doc = get_db().users.find_one({"id": uid})
        user = dict(doc) if doc else None
    else:
        user = None
    if not isinstance(user, dict):
        return out

    cur_month = (user.get(month_field) or "").strip()
    used = int(user.get(count_field) or 0)
    if cur_month != month_key:
        used = 0
    remaining = _remaining(used, month_limit)
    out["month_used"] = used
    out["month_remaining"] = remaining
    out["unlimited"] = remaining is None
    return out


def consume_cluster_plan_usage(user_id: str, *, month_limit: int | None, amount: int = 1) -> tuple[bool, str]:
    return _consume_monthly_counter(
        user_id,
        month_field="usage_monthly_cluster_plans_month",
        count_field="usage_monthly_cluster_plans_count",
        month_limit=month_limit,
        amount=amount,
        limit_message="Monthly Cluster Planner limit reached for your plan.",
    )


def consume_custom_research_usage(user_id: str, *, month_limit: int | None, amount: int = 1) -> tuple[bool, str]:
    return _consume_monthly_counter(
        user_id,
        month_field="usage_monthly_custom_research_month",
        count_field="usage_monthly_custom_research_count",
        month_limit=month_limit,
        amount=amount,
        limit_message="Monthly Custom Curations limit reached for your plan.",
    )


def check_llm_token_budget(user_id: str, estimated_tokens: int, month_limit: int | None) -> tuple[bool, str]:
    """
    Verify the user can afford ``estimated_tokens`` this month against ``month_limit``.

    ``month_limit`` of ``None`` or ``<= 0`` means unlimited (no token-wallet enforcement).
    """
    if estimated_tokens <= 0:
        return True, ""
    uid = (user_id or "").strip()
    if not uid:
        return False, "Missing user id"
    if month_limit is None:
        return True, ""
    try:
        lim = int(month_limit)
    except Exception:
        return True, ""
    if lim <= 0:
        return True, ""

    month_key = _utc_month_key_now()

    def _used_for_month(d: dict[str, Any]) -> int:
        cur_month = (d.get("usage_monthly_llm_tokens_month") or "").strip()
        used = int(d.get("usage_monthly_llm_tokens_used") or 0)
        if cur_month != month_key:
            return 0
        return used

    if _storage_mode == "json":
        with _db_write_lock:
            users = _load_json_users()
            for u in users:
                if (u.get("id") or "").strip() != uid:
                    continue
                used = _used_for_month(u)
                if used + estimated_tokens > lim:
                    return (
                        False,
                        "Requested generation exceeds your tier AI token budget. Please try again next month or upgrade your plan.",
                    )
                return True, ""
        return False, "User not found"

    if _storage_mode != "mongo":
        return True, ""

    with _db_write_lock:
        db = get_db()
        doc = db.users.find_one({"id": uid})
        if not doc:
            return False, "User not found"
        d = dict(doc)
        d.pop("_id", None)
        used = _used_for_month(d)
        if used + estimated_tokens > lim:
            return (
                False,
                "Requested generation exceeds your tier AI token budget. Please try again next month or upgrade your plan.",
            )
        return True, ""


def consume_llm_generation_tokens(user_id: str, amount: int) -> tuple[bool, str]:
    """Increment monthly LLM token usage (call after a successful OpenAI generation)."""
    if amount <= 0:
        return True, ""
    uid = (user_id or "").strip()
    if not uid:
        return False, "Missing user id"
    month_key = _utc_month_key_now()

    def _apply(d: dict[str, Any]) -> tuple[bool, str, dict[str, Any]]:
        cur_month = (d.get("usage_monthly_llm_tokens_month") or "").strip()
        used = int(d.get("usage_monthly_llm_tokens_used") or 0)
        if cur_month != month_key:
            cur_month = month_key
            used = 0
        d2 = dict(d)
        d2["usage_monthly_llm_tokens_month"] = cur_month
        d2["usage_monthly_llm_tokens_used"] = used + amount
        return True, "", d2

    if _storage_mode == "json":
        with _db_write_lock:
            users = _load_json_users()
            for i, u in enumerate(users):
                if (u.get("id") or "").strip() != uid:
                    continue
                ok, msg, upd = _apply(dict(u))
                if not ok:
                    return False, msg
                users[i] = _normalize_user_dict(upd)
                _save_json_users(users)
                return True, ""
        return False, "User not found"

    if _storage_mode != "mongo":
        return True, ""

    with _db_write_lock:
        db = get_db()
        doc = db.users.find_one({"id": uid})
        if not doc:
            return False, "User not found"
        d = dict(doc)
        d.pop("_id", None)
        ok, msg, upd = _apply(d)
        if not ok:
            return False, msg
        norm = _normalize_user_dict(upd)
        new_doc = {**norm, "_id": norm["id"]}
        res = db.users.replace_one({"id": uid}, new_doc)
        if not (res.acknowledged and res.matched_count == 1):
            return False, "Failed to update token usage"
        return True, ""


def _plans_json_path() -> str:
    return _data_path("plans.json")


def _default_plans() -> dict[str, Any]:
    return {
        "beta": {
            "name": "Beta Plan",
            "is_default": True,
            "is_trial_plan": True,
            "trial_period_days": 14,
            "cost_monthly": 0.0,
            "max_projects": 2,
            "max_articles": 5,
            "max_articles_per_day": 0,
            "max_articles_per_month": 0,
            "max_writing_prompts": 1,
            "writing_prompt_char_limit": 4000,
            "max_image_prompts": 1,
            "image_prompt_char_limit": 2000,
            "max_llm_tokens_per_month": 0,
            "allow_scheduling": True,
            "max_scheduled_per_month": 0,
            "allow_export": True,
            "max_export_per_month": 0,
            "allow_bulk_upload": True,
            "max_cluster_plans_per_month": 0,
            "max_custom_research_per_month": 0,
            "max_context_links": 10,
            "max_article_image_regenerations": 3,
        }
    }


# P2.2: plans rarely change but are read on every gatekeeper check / subscription
# status build. Cache the resolved plan map for a short TTL and invalidate it on
# upsert_plan so admin edits take effect promptly.
_PLANS_CACHE: dict[str, Any] | None = None
_PLANS_CACHE_AT: float = 0.0
_PLANS_CACHE_TTL_SECONDS = 60.0
_plans_cache_lock = threading.Lock()


def _invalidate_plans_cache() -> None:
    global _PLANS_CACHE, _PLANS_CACHE_AT
    with _plans_cache_lock:
        _PLANS_CACHE = None
        _PLANS_CACHE_AT = 0.0


def _copy_plans(plans: Any) -> Any:
    """Return a defensive copy so callers can't mutate the shared cache."""
    if isinstance(plans, dict):
        return {k: (dict(v) if isinstance(v, dict) else v) for k, v in plans.items()}
    return plans


def load_plans() -> dict[str, Any]:
    """Return dict of plan_key -> plan data (cached ~60s; see ``_invalidate_plans_cache``)."""
    global _PLANS_CACHE, _PLANS_CACHE_AT
    now = time.monotonic()
    cached = _PLANS_CACHE
    if cached is not None and (now - _PLANS_CACHE_AT) < _PLANS_CACHE_TTL_SECONDS:
        return _copy_plans(cached)
    fresh = _load_plans_uncached()
    with _plans_cache_lock:
        _PLANS_CACHE = _copy_plans(fresh)
        _PLANS_CACHE_AT = time.monotonic()
    return _copy_plans(fresh)


def _load_plans_uncached() -> dict[str, Any]:
    """Return dict of plan_key -> plan data."""
    if _storage_mode == "json":
        path = _plans_json_path()
        try:
            with open(path, encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict) and raw:
                defaults = _default_plans()
                merged: dict[str, Any] = {}
                for k, v in raw.items():
                    kk = (str(k or "").strip().lower()) or str(k)
                    if isinstance(v, dict):
                        merged[kk] = {**(defaults.get(kk) or {}), **v, "key": (v.get("key") or kk)}
                    else:
                        merged[kk] = v
                return merged
        except FileNotFoundError:
            pass
        except Exception:
            pass
        out = _default_plans()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=2, ensure_ascii=False)
            f.write("\n")
        return out
    if _storage_mode != "mongo":
        return _default_plans()
    db = get_db()
    cur = db.plans.find({})
    out: dict[str, Any] = {}
    defaults = _default_plans()
    for doc in cur:
        key = (doc.get("key") or doc.get("id") or "").strip().lower()
        if not key:
            continue
        d = dict(doc)
        d.pop("_id", None)
        d.pop("id", None)
        d["key"] = key
        d = {**((defaults.get(key) or {})), **d}
        out[key] = d
    if not out:
        # Seed defaults
        for k, v in _default_plans().items():
            upsert_plan(k, v)
        return load_plans()
    return out


def upsert_plan(plan_key: str, plan: dict[str, Any]) -> None:
    # P2.2: always drop the cached plan map after a write so edits take effect.
    try:
        _upsert_plan_impl(plan_key, plan)
    finally:
        _invalidate_plans_cache()


def _upsert_plan_impl(plan_key: str, plan: dict[str, Any]) -> None:
    key = (plan_key or "").strip().lower()
    if not key:
        raise ValueError("plan_key is required")
    payload = dict(plan or {})
    payload["key"] = key
    if _storage_mode == "json":
        path = _plans_json_path()
        plans = {}
        try:
            with open(path, encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                plans = raw
        except Exception:
            plans = {}
        # If this plan is being set as default, unset others.
        if payload.get("is_default") is True:
            for k, v in list(plans.items()):
                if not isinstance(v, dict):
                    continue
                if str(k).strip().lower() != key and v.get("is_default") is True:
                    v2 = dict(v)
                    v2["is_default"] = False
                    plans[k] = v2
        if payload.get("is_trial_plan") is True:
            for k, v in list(plans.items()):
                if not isinstance(v, dict):
                    continue
                if str(k).strip().lower() != key and v.get("is_trial_plan") is True:
                    v2 = dict(v)
                    v2["is_trial_plan"] = False
                    plans[k] = v2
        plans[key] = payload
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(plans, f, indent=2, ensure_ascii=False)
            f.write("\n")
        return
    if _storage_mode != "mongo":
        return
    with _db_write_lock:
        # If this plan is being set as default, unset others.
        if payload.get("is_default") is True:
            try:
                get_db().plans.update_many({"_id": {"$ne": key}}, {"$set": {"is_default": False}})
            except Exception:
                pass
        if payload.get("is_trial_plan") is True:
            try:
                get_db().plans.update_many({"_id": {"$ne": key}}, {"$set": {"is_trial_plan": False}})
            except Exception:
                pass
        doc = {**payload, "_id": key}
        get_db().plans.replace_one({"_id": key}, doc, upsert=True)


def get_default_plan_key() -> str:
    """
    Return the default plan key for new registrations.
    Falls back to 'beta' if none is marked default.
    """
    plans = load_plans() or {}
    # Prefer explicit default flag.
    for k, v in plans.items():
        if isinstance(v, dict) and v.get("is_default") is True:
            kk = (v.get("key") or k or "").strip().lower()
            if kk:
                return kk
    # Fallback: beta if present, else first key.
    if "beta" in plans:
        return "beta"
    for k in sorted([str(x).strip().lower() for x in plans.keys() if str(x).strip()]):
        if k:
            return k
    return "beta"


def get_trial_plan_key() -> str | None:
    """Return the plan key marked as the self-expiring trial plan (at most one)."""
    for k, v in (load_plans() or {}).items():
        if isinstance(v, dict) and v.get("is_trial_plan") is True:
            kk = (v.get("key") or k or "").strip().lower()
            if kk:
                return kk
    return None


def _parse_user_created_at(raw: str) -> datetime:
    text = (raw or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            return datetime.strptime(text[:19], fmt.replace("Z", ""))
        except ValueError:
            continue
    return datetime.utcnow()


def _subscription_usage_from_user(user: dict[str, Any]) -> dict[str, Any]:
    day_key = _utc_day_key_now()
    month_key = _utc_month_key_now()
    u_day = (user.get("usage_daily_articles_date") or "").strip()
    day_count = int(user.get("usage_daily_articles_count") or 0)
    if u_day != day_key:
        day_count = 0
    u_month = (user.get("usage_monthly_articles_month") or "").strip()
    month_count = int(user.get("usage_monthly_articles_count") or 0)
    if u_month != month_key:
        month_count = 0
    return {
        "articlesGeneratedToday": day_count,
        "articlesGeneratedTodayDate": day_key,
        "articlesGeneratedThisMonth": month_count,
        "articlesGeneratedMonthKey": month_key,
        "regenerationsThisMonth": int(user.get("usage_monthly_image_regen_count") or 0),
        "schedulesThisMonth": int(user.get("usage_monthly_scheduled_count") or 0),
        "exportsThisMonth": int(user.get("usage_monthly_export_count") or 0),
    }


def _normalize_subscription(doc: dict[str, Any]) -> dict[str, Any]:
    uid = (doc.get("user_id") or doc.get("userId") or "").strip()
    if not uid:
        raise ValueError("subscription requires user_id")
    usage_in = doc.get("usage") if isinstance(doc.get("usage"), dict) else {}
    return {
        "user_id": uid,
        "plan_key": (doc.get("plan_key") or doc.get("planKey") or "beta").strip().lower() or "beta",
        "trial_start_date": (doc.get("trial_start_date") or doc.get("trialStartDate") or "").strip(),
        "trial_end_date": (doc.get("trial_end_date") or doc.get("trialEndDate") or "").strip(),
        "usage": {
            "articlesGeneratedToday": int(usage_in.get("articlesGeneratedToday") or 0),
            "articlesGeneratedTodayDate": (usage_in.get("articlesGeneratedTodayDate") or "").strip(),
            "articlesGeneratedThisMonth": int(usage_in.get("articlesGeneratedThisMonth") or 0),
            "articlesGeneratedMonthKey": (usage_in.get("articlesGeneratedMonthKey") or "").strip(),
            "regenerationsThisMonth": int(usage_in.get("regenerationsThisMonth") or 0),
            "schedulesThisMonth": int(usage_in.get("schedulesThisMonth") or 0),
            "exportsThisMonth": int(usage_in.get("exportsThisMonth") or 0),
        },
        "created_at": (doc.get("created_at") or _now_iso_seconds())[:64],
        "updated_at": (doc.get("updated_at") or _now_iso_seconds())[:64],
    }


def _trial_window_for_signup(*, plan_key: str, account_created_at: str) -> tuple[str, str]:
    """Return ISO UTC trial start/end when signup plan is the designated trial plan."""
    pk = (plan_key or "").strip().lower()
    trial_key = get_trial_plan_key()
    if not trial_key or pk != trial_key:
        return "", ""
    plans = load_plans() or {}
    plan = plans.get(trial_key) if isinstance(plans.get(trial_key), dict) else {}
    try:
        days = max(1, int(plan.get("trial_period_days") or plan.get("validityDays") or 0))
    except Exception:
        days = 14
    start = _parse_user_created_at(account_created_at)
    end = start + timedelta(days=days)
    return start.strftime("%Y-%m-%dT%H:%M:%SZ"), end.strftime("%Y-%m-%dT%H:%M:%SZ")


def create_subscription_for_user(
    *,
    user_id: str,
    plan_key: str,
    account_created_at: str,
) -> dict[str, Any]:
    uid = (user_id or "").strip()
    if not uid:
        raise ValueError("user_id is required")
    trial_start, trial_end = _trial_window_for_signup(plan_key=plan_key, account_created_at=account_created_at)
    now = _now_iso_seconds()
    doc = _normalize_subscription(
        {
            "user_id": uid,
            "plan_key": (plan_key or "beta").strip().lower() or "beta",
            "trial_start_date": trial_start,
            "trial_end_date": trial_end,
            "usage": {
                "articlesGeneratedToday": 0,
                "articlesGeneratedTodayDate": _utc_day_key_now(),
                "articlesGeneratedThisMonth": 0,
                "articlesGeneratedMonthKey": _utc_month_key_now(),
                "regenerationsThisMonth": 0,
                "schedulesThisMonth": 0,
                "exportsThisMonth": 0,
            },
            "created_at": now,
            "updated_at": now,
        }
    )
    if _storage_mode != "mongo":
        rows = _load_json_list("subscriptions.json")
        rows = [r for r in rows if (r.get("user_id") or "").strip() != uid]
        rows.append(doc)
        with _db_write_lock:
            _save_json("subscriptions.json", rows[-50000:])
        return doc
    with _db_write_lock:
        get_db().subscriptions.replace_one({"user_id": uid}, {**doc, "_id": uid}, upsert=True)
    return doc


def ensure_subscription_for_user(user: dict[str, Any]) -> dict[str, Any]:
    """Load or lazily create a subscription row for ``user``."""
    uid = (user.get("id") or "").strip()
    if not uid:
        raise ValueError("user id required")
    existing = get_subscription_by_user_id(uid)
    if existing:
        usage = _subscription_usage_from_user(user)
        if usage != existing.get("usage"):
            existing = {**existing, "usage": usage, "updated_at": _now_iso_seconds()}
            if _storage_mode != "mongo":
                rows = _load_json_list("subscriptions.json")
                for i, r in enumerate(rows):
                    if (r.get("user_id") or "").strip() == uid:
                        rows[i] = existing
                with _db_write_lock:
                    _save_json("subscriptions.json", rows)
            else:
                with _db_write_lock:
                    get_db().subscriptions.update_one({"user_id": uid}, {"$set": {"usage": usage, "updated_at": existing["updated_at"]}})
        plan_key = (user.get("subscription_type") or existing.get("plan_key") or "beta").strip().lower()
        if plan_key != (existing.get("plan_key") or ""):
            existing["plan_key"] = plan_key
        return existing
    created_at = (user.get("created_at") or _now_iso_seconds()).strip()
    plan_key = (user.get("subscription_type") or "beta").strip().lower() or "beta"
    return create_subscription_for_user(user_id=uid, plan_key=plan_key, account_created_at=created_at)


def get_subscription_by_user_id(user_id: str) -> dict[str, Any] | None:
    uid = (user_id or "").strip()
    if not uid:
        return None
    if _storage_mode != "mongo":
        for r in reversed(_load_json_list("subscriptions.json")):
            if isinstance(r, dict) and (r.get("user_id") or "").strip() == uid:
                return _normalize_subscription(r)
        return None
    doc = get_db().subscriptions.find_one({"user_id": uid}, {"_id": 0})
    if not isinstance(doc, dict):
        return None
    return _normalize_subscription(doc)


def reset_daily_subscription_usage() -> int:
    """Midnight UTC reset for daily usage counters on all active subscriptions."""
    day_key = _utc_day_key_now()
    patch = {
        "usage.articlesGeneratedToday": 0,
        "usage.articlesGeneratedTodayDate": day_key,
        "updated_at": _now_iso_seconds(),
    }
    if _storage_mode != "mongo":
        rows = _load_json_list("subscriptions.json")
        n = 0
        for r in rows:
            if not isinstance(r, dict):
                continue
            usage = r.get("usage") if isinstance(r.get("usage"), dict) else {}
            if (usage.get("articlesGeneratedTodayDate") or "").strip() == day_key and int(usage.get("articlesGeneratedToday") or 0) == 0:
                continue
            usage["articlesGeneratedToday"] = 0
            usage["articlesGeneratedTodayDate"] = day_key
            r["usage"] = usage
            r["updated_at"] = patch["updated_at"]
            n += 1
        if n:
            with _db_write_lock:
                _save_json("subscriptions.json", rows)
        return n
    with _db_write_lock:
        res = get_db().subscriptions.update_many(
            {},
            {"$set": patch},
        )
    return int(getattr(res, "modified_count", 0) or 0)


def _user_doc_to_public(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    """Canonical Mongo user-doc → public dict (shared by sync + Motor async reads)."""
    if not doc:
        return None
    return {
        "id": (doc.get("id") or "").strip(),
        "email": (doc.get("email") or "").strip(),
        "password_hash": (doc.get("password_hash") or "").strip(),
        "role": (doc.get("role") or "user").strip().lower(),
        "full_name": (doc.get("full_name") or "").strip(),
        "phone": (doc.get("phone") or "").strip(),
        "timezone": (doc.get("timezone") or "").strip(),
        "address": (doc.get("address") or "").strip(),
        "subscription_type": (doc.get("subscription_type") or "beta").strip().lower(),
        "last_activity_at": (doc.get("last_activity_at") or "").strip(),
        "account_status": (doc.get("account_status") or "active").strip().lower(),
        "is_deleted": bool(doc.get("is_deleted", False)),
        "is_deactivated": bool(doc.get("is_deactivated", False)),
        "deleted_at": (doc.get("deleted_at") or "").strip(),
        "deactivated_at": (doc.get("deactivated_at") or "").strip(),
        "deletion_requested_at": (doc.get("deletion_requested_at") or "").strip(),
        "reactivated_at": (doc.get("reactivated_at") or "").strip(),
        "retention_reason": (doc.get("retention_reason") or "").strip(),
        "retargeting_retained": bool(doc.get("retargeting_retained", False)),
        "usage_daily_articles_date": (doc.get("usage_daily_articles_date") or "").strip(),
        "usage_daily_articles_count": int(doc.get("usage_daily_articles_count") or 0),
        "usage_monthly_articles_month": (doc.get("usage_monthly_articles_month") or "").strip(),
        "usage_monthly_articles_count": int(doc.get("usage_monthly_articles_count") or 0),
        "usage_monthly_llm_tokens_month": (doc.get("usage_monthly_llm_tokens_month") or "").strip(),
        "usage_monthly_llm_tokens_used": int(doc.get("usage_monthly_llm_tokens_used") or 0),
        "created_at": (doc.get("created_at") or "").strip(),
        "pending_product_tour": bool(doc.get("pending_product_tour", False)),
        "email_verification_token": (doc.get("email_verification_token") or "").strip(),
        "email_verification_expires": (doc.get("email_verification_expires") or "").strip(),
        "password_reset_token": (doc.get("password_reset_token") or "").strip(),
        "password_reset_expires": (doc.get("password_reset_expires") or "").strip(),
        # Google Search Console OAuth (stored per-user)
        "gsc_access_token": (doc.get("gsc_access_token") or "").strip(),
        "gsc_refresh_token": (doc.get("gsc_refresh_token") or "").strip(),
        "gsc_token_expires_at": str(doc.get("gsc_token_expires_at") or "").strip(),
        "gsc_scope": (doc.get("gsc_scope") or "").strip(),
        "gsc_email": (doc.get("gsc_email") or "").strip(),
        "gsc_connected_at": (doc.get("gsc_connected_at") or "").strip(),
    }


def get_user_by_id(user_id: str) -> dict[str, Any] | None:
    uid = (user_id or "").strip()
    if not uid:
        return None
    if _storage_mode == "json":
        for u in _load_json_users():
            if (u.get("id") or "").strip() == uid:
                return _user_row_to_public(u)
        return None
    if _storage_mode != "mongo":
        return None
    db = get_db()
    doc = db.users.find_one({"id": uid})
    if not doc and uid:
        # Case-insensitive id match (UUID casing drift between token and DB).
        try:
            doc = db.users.find_one({"id": {"$regex": f"^{re.escape(uid)}$", "$options": "i"}})
        except re.error:
            doc = None
    if not doc:
        return None
    return _user_doc_to_public(doc)


def get_user_by_email(email: str) -> dict[str, Any] | None:
    em = (email or "").strip().lower()
    if not em:
        return None
    if _storage_mode == "json":
        for u in _load_json_users():
            if (u.get("email") or "").strip().lower() == em:
                return _user_row_to_public(u)
        return None
    if _storage_mode != "mongo":
        return None
    doc = get_db().users.find_one({"email": em})
    if not doc:
        return None
    return {
        "id": (doc.get("id") or "").strip(),
        "email": (doc.get("email") or "").strip(),
        "password_hash": (doc.get("password_hash") or "").strip(),
        "role": (doc.get("role") or "user").strip().lower(),
        "full_name": (doc.get("full_name") or "").strip(),
        "phone": (doc.get("phone") or "").strip(),
        "timezone": (doc.get("timezone") or "").strip(),
        "address": (doc.get("address") or "").strip(),
        "subscription_type": (doc.get("subscription_type") or "beta").strip().lower(),
        "last_activity_at": (doc.get("last_activity_at") or "").strip(),
        "account_status": (doc.get("account_status") or "active").strip().lower(),
        "is_deleted": bool(doc.get("is_deleted", False)),
        "is_deactivated": bool(doc.get("is_deactivated", False)),
        "deleted_at": (doc.get("deleted_at") or "").strip(),
        "deactivated_at": (doc.get("deactivated_at") or "").strip(),
        "deletion_requested_at": (doc.get("deletion_requested_at") or "").strip(),
        "reactivated_at": (doc.get("reactivated_at") or "").strip(),
        "retention_reason": (doc.get("retention_reason") or "").strip(),
        "retargeting_retained": bool(doc.get("retargeting_retained", False)),
        "usage_daily_articles_date": (doc.get("usage_daily_articles_date") or "").strip(),
        "usage_daily_articles_count": int(doc.get("usage_daily_articles_count") or 0),
        "usage_monthly_articles_month": (doc.get("usage_monthly_articles_month") or "").strip(),
        "usage_monthly_articles_count": int(doc.get("usage_monthly_articles_count") or 0),
        "usage_monthly_llm_tokens_month": (doc.get("usage_monthly_llm_tokens_month") or "").strip(),
        "usage_monthly_llm_tokens_used": int(doc.get("usage_monthly_llm_tokens_used") or 0),
        "created_at": (doc.get("created_at") or "").strip(),
        "pending_product_tour": bool(doc.get("pending_product_tour", False)),
        "email_verification_token": (doc.get("email_verification_token") or "").strip(),
        "email_verification_expires": (doc.get("email_verification_expires") or "").strip(),
        "password_reset_token": (doc.get("password_reset_token") or "").strip(),
        "password_reset_expires": (doc.get("password_reset_expires") or "").strip(),
    }


def _parse_iso_ts(raw: str) -> datetime | None:
    text = (raw or "").strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(text[:19], fmt.replace("Z", ""))
        except ValueError:
            continue
    return None


_WEAK_EMAIL_OTPS = frozenset(
    {
        "000000",
        "111111",
        "222222",
        "333333",
        "444444",
        "555555",
        "666666",
        "777777",
        "888888",
        "999999",
        "123456",
        "654321",
        "012345",
        "543210",
    }
)


def generate_email_verification_otp() -> str:
    """Cryptographically random 6-digit OTP (never a trivial/sequential code)."""
    for _ in range(32):
        code = "".join(secrets.choice("0123456789") for _ in range(6))
        if code not in _WEAK_EMAIL_OTPS:
            return code
    return f"{secrets.randbelow(900_000) + 100_000:06d}"


def set_email_verification(*, user_id: str, token: str, expires_at: datetime, sent_at: datetime | None = None) -> bool:
    uid = (user_id or "").strip()
    tok = (token or "").strip()[:128]
    if not uid or not tok:
        return False
    sent = sent_at or datetime.utcnow()
    exp_iso = expires_at.strftime("%Y-%m-%dT%H:%M:%SZ")
    updates = {
        "email_verification_token": tok,
        "email_verification_expires": exp_iso,
        "email_verification_expires_at": expires_at,
        "email_verification_sent_at": sent,
    }
    return update_user_fields(uid, updates)


def resend_email_verification(*, email: str, cooldown_seconds: int = 60) -> tuple[str, str, int, str | None]:
    """
    Regenerate verification code for pending accounts.

    Returns ``(action, message, retry_after_seconds, token)`` where action is
    ``sent``, ``cooldown``, or ``noop``.
    """
    em = (email or "").strip().lower()
    generic = "If that email is pending verification, a new code has been sent."
    if not em:
        return "noop", generic, 0, None
    user = get_user_by_email(em)
    if not user:
        return "noop", generic, 0, None
    status = (user.get("account_status") or "active").strip().lower()
    if status != "pending":
        return "noop", generic, 0, None

    now = datetime.utcnow()
    last_sent_raw = user.get("email_verification_sent_at")
    last_sent: datetime | None = None
    if isinstance(last_sent_raw, datetime):
        last_sent = last_sent_raw
    elif isinstance(last_sent_raw, str):
        last_sent = _parse_iso_ts(last_sent_raw)

    if last_sent:
        elapsed = (now - last_sent).total_seconds()
        if elapsed < cooldown_seconds:
            retry = max(1, int(cooldown_seconds - elapsed))
            return (
                "cooldown",
                f"Please wait {retry} seconds before requesting another code.",
                retry,
                None,
            )

    token = generate_email_verification_otp()
    expires_at = now + timedelta(minutes=15)
    uid = (user.get("id") or "").strip()
    ok = set_email_verification(user_id=uid, token=token, expires_at=expires_at, sent_at=now)
    if not ok:
        return "noop", "Could not resend verification email.", 0, None
    return "sent", "Verification email sent. Check your inbox.", cooldown_seconds, token


def verify_email_with_token(*, email: str, token: str) -> tuple[bool, str]:
    em = (email or "").strip().lower()
    tok = (token or "").strip()
    if not em or not tok:
        return False, "Email and verification code are required."
    user = get_user_by_email(em)
    if not user:
        return False, "Invalid verification code."
    stored = (user.get("email_verification_token") or "").strip()
    if not stored or stored != tok:
        return False, "Invalid verification code."
    exp_raw = (user.get("email_verification_expires") or "").strip()
    exp = _parse_iso_ts(exp_raw)
    if not exp or datetime.utcnow() > exp:
        return False, "Verification code has expired. Request a new one."
    uid = (user.get("id") or "").strip()
    ok = update_user_fields(
        uid,
        {
            "account_status": "active",
            "email_verification_token": "",
            "email_verification_expires": "",
            "email_verification_expires_at": None,
        },
    )
    return (ok, "Email verified successfully.") if ok else (False, "Could not activate account.")


def set_password_reset_token(*, email: str, token: str, expires_at: datetime) -> bool:
    em = (email or "").strip().lower()
    tok = (token or "").strip()[:128]
    if not em or not tok:
        return False
    user = get_user_by_email(em)
    if not user:
        return False
    uid = (user.get("id") or "").strip()
    exp_iso = expires_at.strftime("%Y-%m-%dT%H:%M:%SZ")
    return update_user_fields(
        uid,
        {
            "password_reset_token": tok,
            "password_reset_expires": exp_iso,
            "password_reset_expires_at": expires_at,
        },
    )


def get_user_by_password_reset_token(*, email: str, token: str) -> dict[str, Any] | None:
    em = (email or "").strip().lower()
    tok = (token or "").strip()
    if not em or not tok:
        return None
    user = get_user_by_email(em)
    if not user:
        return None
    if (user.get("password_reset_token") or "").strip() != tok:
        return None
    exp = _parse_iso_ts((user.get("password_reset_expires") or "").strip())
    if not exp or datetime.utcnow() > exp:
        return None
    return user


def complete_password_reset(*, email: str, token: str, password_hash: str) -> tuple[bool, str]:
    user = get_user_by_password_reset_token(email=email, token=token)
    if not user:
        return False, "Invalid or expired reset link."
    uid = (user.get("id") or "").strip()
    if not uid:
        return False, "Invalid or expired reset link."
    ok = update_user_fields(
        uid,
        {
            "password_hash": password_hash,
            "password_reset_token": "",
            "password_reset_expires": "",
            "password_reset_expires_at": None,
        },
    )
    return (True, "Password updated successfully.") if ok else (False, "Could not update password.")


def insert_user(user: dict[str, Any]) -> None:
    norm = _normalize_user_dict(user)
    if _storage_mode == "json":
        with _db_write_lock:
            users = _load_json_users()
            if any((u.get("email") or "").strip().lower() == norm["email"] for u in users):
                raise ValueError("email already registered")
            users.append(norm)
            _save_json_users(users)
        create_subscription_for_user(
            user_id=norm["id"],
            plan_key=norm.get("subscription_type") or "beta",
            account_created_at=norm.get("created_at") or _now_iso_seconds(),
        )
        return
    if _storage_mode != "mongo":
        raise RuntimeError("User storage requires MongoDB or JSON fallback")
    doc = {**norm, "_id": norm["id"]}
    with _db_write_lock:
        res = get_db().users.insert_one(doc)
        if not res.acknowledged:
            raise RuntimeError("MongoDB insert_user was not acknowledged")
    create_subscription_for_user(
        user_id=norm["id"],
        plan_key=norm.get("subscription_type") or "beta",
        account_created_at=norm.get("created_at") or _now_iso_seconds(),
    )


def delete_user(user_id: str) -> bool:
    """
    Soft-delete a user account while preserving all owned projects/articles.

    The retained user row keeps email and account metadata available for
    lifecycle/retargeting workflows, while auth guards block future access.
    """
    uid = (user_id or "").strip()
    if not uid:
        return False
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    updates = {
        "account_status": "deleted",
        "is_deleted": True,
        "is_deactivated": True,
        "deleted_at": now,
        "deactivated_at": now,
        "deletion_requested_at": now,
        "retention_reason": "account_deleted_data_retained_for_retargeting",
        "retargeting_retained": True,
        "last_activity_at": now,
    }
    return update_user_fields(uid, updates)


def deactivate_user(user_id: str, *, reason: str = "account_deactivated") -> bool:
    """Deactivate a user account without deleting or anonymizing retained data."""
    uid = (user_id or "").strip()
    if not uid:
        return False
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    return update_user_fields(
        uid,
        {
            "account_status": "deactivated",
            "is_deleted": False,
            "is_deactivated": True,
            "deactivated_at": now,
            "retention_reason": (reason or "account_deactivated")[:500],
            "retargeting_retained": True,
            "last_activity_at": now,
        },
    )


def reactivate_user(user_id: str) -> bool:
    """Restore a retained/deactivated account to active status without changing its user_id."""
    uid = (user_id or "").strip()
    if not uid:
        return False
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    return update_user_fields(
        uid,
        {
            "account_status": "active",
            "is_deleted": False,
            "is_deactivated": False,
            "reactivated_at": now,
            "retention_reason": "",
            "retargeting_retained": False,
            "last_activity_at": now,
        },
    )


def hard_delete_user(user_id: str) -> bool:
    """Physically remove only the user row. Prefer delete_user() for normal app flows."""
    uid = (user_id or "").strip()
    if not uid:
        return False
    if _storage_mode == "json":
        with _db_write_lock:
            users = _load_json_users()
            if not any((u.get("id") or "").strip() == uid for u in users):
                return False
            users = [u for u in users if (u.get("id") or "").strip() != uid]
            _save_json_users(users)
        return True
    if _storage_mode != "mongo":
        return False
    with _db_write_lock:
        res = get_db().users.delete_one({"id": uid})
        return bool(res.deleted_count == 1)


def purge_user_data(user_id: str) -> bool:
    """Hard-delete ALL data owned by a user (L6.5 GDPR account erasure).

    Deletes in order: all projects + their articles/jobs, subscription record,
    then the user row itself. Returns True if the user existed and was removed.
    """
    uid = (user_id or "").strip()
    if not uid:
        return False

    for pid in project_ids_for_owner(uid):
        try:
            delete_project_and_resources(pid)
        except Exception:
            pass

    if _storage_mode == "mongo":
        with _db_write_lock:
            db = get_db()
            db.subscriptions.delete_one({"user_id": uid})
    elif _storage_mode == "json":
        pass  # JSON mode has no separate subscriptions file

    return hard_delete_user(uid)


def _coerce_wp_scheduled_at_str(v: Any, max_len: int = 64) -> str:
    """MongoDB may store schedule times as BSON Date; app code expects YYYY-mm-dd HH:MM:SS strings."""
    if v is None or v == "":
        return ""
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d %H:%M:%S")[:max_len]
    if isinstance(v, date) and not isinstance(v, datetime):
        return v.isoformat()[:max_len]
    return str(v).strip()[:max_len]


# Fields whose change can flip the persisted derived listing status (P4.3). Used by
# patch_article_fields to know when to recompute ``listing_status`` on a $set.
_LISTING_STATUS_AFFECTING_FIELDS = frozenset(
    {
        "status",
        "wp_last_wp_status",
        "wp_link",
        "wp_post_id",
        "wp_scheduled_at",
        "shopify_link",
        "shopify_article_id",
    }
)


def _article_has_body(a: dict[str, Any]) -> bool:
    return bool((a.get("article") or "").strip())


def _article_wp_post_present(a: dict[str, Any]) -> bool:
    link = (a.get("wp_link") or "").strip()
    if link:
        return True
    pid = a.get("wp_post_id")
    if pid is None or pid == "":
        return False
    try:
        return int(pid) > 0
    except (TypeError, ValueError):
        s = str(pid).strip().lower()
        return s not in ("", "0", "none")


def _derive_article_listing_status(a: dict[str, Any]) -> str:
    """Persisted UI status mirror of routes/articles.py:_derive_listing_status.

    Computed purely from article fields so it can be stored on the document and
    matched directly in Mongo (kills the §3.6 double 20k scan). The route still
    applies posted-job overlays for the page it renders, so display stays exact.
    """
    wp_sched = _coerce_wp_scheduled_at_str(a.get("wp_scheduled_at"))
    raw = (str(a.get("status") or "pending").strip().lower()) or "pending"
    wp_last = str(a.get("wp_last_wp_status") or "").strip().lower()
    has_post = _article_wp_post_present(a)
    shopify_published = bool((a.get("shopify_link") or "").strip() or a.get("shopify_article_id"))
    # WordPress live-publish signal overrides status ONLY when the user has not
    # explicitly set status to "pending" or "draft". Those values are treated as
    # deliberate workflow overrides (e.g. bulk status change) and take priority.
    if raw == "published" or (wp_last == "publish" and raw not in {"pending", "draft"}):
        return "published"
    if shopify_published:
        return "published"
    if wp_last == "draft" and has_post and raw not in {"pending"}:
        return "draft"
    if wp_sched:
        if has_post and wp_last == "publish":
            return "published"
        return "scheduled"
    return raw


def _normalize_article_dict(d: dict[str, Any]) -> dict[str, Any]:
    aid = (d.get("id") or "").strip()
    pid = (d.get("project_id") or "").strip()
    if not aid or not pid:
        raise ValueError("article id and project_id are required")
    wp = d.get("wp_post_id")
    if wp is not None and wp != "":
        try:
            wp_id = int(wp)
        except (TypeError, ValueError):
            wp_id = None
    else:
        wp_id = None
    updated_at = (d.get("updated_at") or d.get("created_at") or "")[:64]
    return {
        "id": aid,
        "project_id": pid,
        "title": (d.get("title") or "")[:500],
        "keywords": _coerce_str_list(d.get("keywords")),
        "status": (d.get("status") or "pending")[:32],
        "article": d.get("article") or "",
        "focus_keyphrase": (d.get("focus_keyphrase") or "")[:500],
        "meta_title": (d.get("meta_title") or "")[:500],
        "meta_description": (d.get("meta_description") or "")[:2000],
        # Content Engine V2 — structured guided-form input (see
        # backend/app/schemas/content_brief.py). `content_brief` is the
        # committed, generation-ready brief; `content_brief_draft` holds
        # in-progress wizard edits separately so autosave never clobbers the
        # last generation-ready brief. Both net-new, additive, nullable —
        # not consumed by the live generation pipeline yet.
        "content_brief": d.get("content_brief") if isinstance(d.get("content_brief"), dict) else None,
        "content_brief_draft": d.get("content_brief_draft") if isinstance(d.get("content_brief_draft"), dict) else None,
        # Generated image can be a data URL (can be large). Keep it for preview + WP publish.
        "image_url": (d.get("image_url") or "")[:3_000_000],
        "generated_at": (d.get("generated_at") or "")[:64],
        "posted_at": (d.get("posted_at") or "")[:64],
        "created_at": (d.get("created_at") or "")[:64],
        "updated_at": updated_at,
        "featured_image_generated_at": (d.get("featured_image_generated_at") or "")[:64],
        "featured_image_prompt_id": (d.get("featured_image_prompt_id") or "")[:36],
        "featured_image_source": (d.get("featured_image_source") or "")[:32],
        "featured_image_prompt_final": d.get("featured_image_prompt_final") or "",
        "featured_image_prompt_raw": d.get("featured_image_prompt_raw") or "",
        "featured_image_model": (d.get("featured_image_model") or "")[:200],
        "featured_image_quality": (d.get("featured_image_quality") or "")[:64],
        "featured_image_size": (d.get("featured_image_size") or "")[:32],
        "featured_image_optimizer_model": (d.get("featured_image_optimizer_model") or "")[:200],
        "featured_image_prompt_optimizer_error": d.get("featured_image_prompt_optimizer_error") or "",
        "featured_image_regeneration_count": int(d.get("featured_image_regeneration_count") or 0),
        "featured_image_storage": (d.get("featured_image_storage") or "")[:16],
        "wp_post_id": wp_id,
        "wp_link": (d.get("wp_link") or "")[:2048],
        "wp_rest_base": (d.get("wp_rest_base") or "")[:200],
        "wp_last_wp_status": (d.get("wp_last_wp_status") or "")[:32],
        "wp_modified_at": (d.get("wp_modified_at") or "")[:64],
        "wp_synced_at": (d.get("wp_synced_at") or "")[:64],
        "wp_featured_media_id": int(d["wp_featured_media_id"]) if d.get("wp_featured_media_id") else None,
        "wp_featured_image_url": (d.get("wp_featured_image_url") or "")[:2048],
        "wp_scheduled_at": _coerce_wp_scheduled_at_str(d.get("wp_scheduled_at")),
        "wp_schedule_wp_status": (d.get("wp_schedule_wp_status") or "")[:32],
        "wp_schedule_error": d.get("wp_schedule_error") or "",
        "wp_schedule_batch_id": (d.get("wp_schedule_batch_id") or "")[:36],
        "wp_schedule_batch_index": str(d.get("wp_schedule_batch_index") or "")[:32],
        "wp_schedule_batch_total": str(d.get("wp_schedule_batch_total") or "")[:32],
        "gsc_status": (d.get("gsc_status") or "pending")[:32],
        "gsc_inspection_requested_at": (d.get("gsc_inspection_requested_at") or "")[:64],
        "gsc_inspection_last_attempt_at": (d.get("gsc_inspection_last_attempt_at") or "")[:64],
        "gsc_inspection_error": (d.get("gsc_inspection_error") or "")[:500],
        "gsc_inspection_url": (d.get("gsc_inspection_url") or "")[:2048],
        # Rank-monitor / "Smart Refresh" (Feature 4). status: "fresh" | "stale" | "" (unknown).
        "monitor_status": (d.get("monitor_status") or "")[:16],
        "monitor_last_checked_at": (d.get("monitor_last_checked_at") or "")[:64],
        "monitor_score": str(d.get("monitor_score") or "")[:32],
        "monitor_signature": (d.get("monitor_signature") or "")[:512],
        # Automated internal-linking (Feature 3) — counters only; the actual links live in the body.
        "internal_links_applied_at": (d.get("internal_links_applied_at") or "")[:64],
        "internal_links_count": int(d.get("internal_links_count") or 0),
        "shopify_blog_id": d.get("shopify_blog_id"),
        "shopify_article_id": d.get("shopify_article_id"),
        "shopify_link": (d.get("shopify_link") or "")[:2048],
        "shopify_published_at": (d.get("shopify_published_at") or "")[:64],
        "shopify_scheduled_at": (d.get("shopify_scheduled_at") or "")[:64],
        "shopify_schedule_error": d.get("shopify_schedule_error") or "",
        "topic_cluster_id": (d.get("topic_cluster_id") or "")[:64],
        "topic_slot_id": (d.get("topic_slot_id") or "")[:64],
        "topic_role": (d.get("topic_role") or "")[:16],
        # Persisted derived fields (P4.3) — recomputed on every write so listing
        # queries can use the stored flag/status instead of scanning bodies / 20k rows.
        "has_body": bool((d.get("article") or "").strip()),
        "listing_status": _derive_article_listing_status(d),
        "wp_category_ids": (d.get("wp_category_ids") or "")[:800],
    }


def _normalize_scheduled_job_dict(d: dict[str, Any]) -> dict[str, Any]:
    jid = (d.get("id") or "").strip()
    pid = (d.get("project_id") or "").strip()
    aid = (d.get("article_id") or "").strip()
    if not jid or not pid or not aid:
        raise ValueError("scheduled job id, project_id, and article_id are required")
    return {
        "id": jid,
        "project_id": pid,
        "article_id": aid,
        "run_at": (d.get("run_at") or "")[:64],  # "YYYY-MM-DD HH:MM:SS"
        "post_type": (d.get("post_type") or "posts")[:200],
        "wp_status": (d.get("wp_status") or "draft")[:16],
        "category_ids": (d.get("category_ids") or "")[:800],  # comma-separated ints
        "writing_prompt_id": (d.get("writing_prompt_id") or "")[:100],
        "image_prompt_id": (d.get("image_prompt_id") or "")[:100],
        "generate_image": bool(d.get("generate_image", True)),
        "state": (d.get("state") or "scheduled")[:32],  # scheduled|posting|posted|failed|cancelled
        "last_error": d.get("last_error") or "",
        "attempts": int(d.get("attempts") or 0),
        "last_attempt_at": (d.get("last_attempt_at") or "")[:64],
        "created_at": (d.get("created_at") or "")[:64],
        "updated_at": (d.get("updated_at") or d.get("created_at") or "")[:64],
        "wp_post_id": str(d.get("wp_post_id") or "")[:32],
        "wp_link": (d.get("wp_link") or "")[:2048],
        "shopify_article_id": str(d.get("shopify_article_id") or "")[:32],
        "shopify_link": (d.get("shopify_link") or "")[:2048],
    }


def _apply_project_updates_dict(p: dict[str, Any], updates: dict[str, Any]) -> None:
    for k, v in updates.items():
        if k == "prompts":
            p["prompts"] = v
        elif k == "image_prompts":
            p["image_prompts"] = v
        elif k == "content_brief_templates":
            p["content_brief_templates"] = v
        elif k == "context_links":
            p["context_links"] = v
        elif k in ("brand_tones", "audience", "target_countries", "target_cities"):
            # List-valued structured brand/niche fields. Coerce here so
            # callers can pass either a list or a JSON-encoded string from
            # legacy import paths.
            if isinstance(v, list):
                p[k] = v
            else:
                p[k] = list(v) if v else []
        elif k in ("target_cities_all", "target_countries_all"):
            p[k] = bool(v)
        elif k == "humanization_settings":
            p[k] = v if isinstance(v, dict) else {}
        elif k == "content_optimization_profile":
            p[k] = str(v)[:64] if v is not None else "none"
        elif k in p or k in (
            "id",
            "name",
            "website_url",
            "brand_identity",
            "niche_identifier",
            "brand_voice",
            "brand_rules",
            "niche_topic",
            "wp_site_url",
            "wp_username",
            "wp_app_password",
            "wp_category_ids",
            "default_prompt_id",
            "default_image_prompt_id",
            "default_content_brief_template_id",
            "image_style",
            "optimize_image_prompt",
            "gsc_property_url",
            "gsc_index_on_publish",
            "gsc_access_token",
            "gsc_refresh_token",
            "gsc_token_expires_at",
            "gsc_scope",
            "gsc_email",
            "gsc_connected_at",
            "default_wp_rest_base",
            "default_wp_status",
            "created_at",
            "wp_verified_at",
            "wp_verified_status",
            "wp_verified_message",
            "wp_plugin_status",
            "wp_plugin_message",
            "platform",
            "shopify_shop",
            "shopify_access_token",
            "shopify_client_id",
            "shopify_client_secret",
            "shopify_token_expires_at",
            "shopify_scope",
            "shopify_connected_at",
            "shopify_verified_at",
            "shopify_verified_status",
            "shopify_verified_message",
            "shopify_sync_at",
            "shopify_sync_status",
            "shopify_sync_message",
            "shopify_catalog",
            "shopify_product_aware_enabled",
            "wp_internal_link_aware_enabled",
        ):
            p[k] = v


def _apply_article_updates_dict(a: dict[str, Any], updates: dict[str, Any]) -> None:
    for k, v in updates.items():
        if k == "keywords":
            a["keywords"] = v
        elif k == "wp_post_id":
            if v is not None and v != "":
                try:
                    a["wp_post_id"] = int(v)
                except (TypeError, ValueError):
                    a["wp_post_id"] = None
            else:
                a["wp_post_id"] = None
        elif k in ("wp_schedule_batch_index", "wp_schedule_batch_total"):
            a[k] = str(v) if v is not None and v != "" else ""
        elif k == "content_brief":
            a["content_brief"] = v if isinstance(v, dict) else None
        elif k == "content_brief_draft":
            a["content_brief_draft"] = v if isinstance(v, dict) else None
        elif k in a or k in (
            "id",
            "project_id",
            "title",
            "status",
            "article",
            "focus_keyphrase",
            "meta_title",
            "meta_description",
            "image_url",
            "generated_at",
            "posted_at",
            "created_at",
            "updated_at",
            "featured_image_generated_at",
            "featured_image_prompt_id",
            "featured_image_source",
            "featured_image_prompt_final",
            "featured_image_prompt_raw",
            "featured_image_model",
            "featured_image_quality",
            "featured_image_size",
            "featured_image_optimizer_model",
            "featured_image_prompt_optimizer_error",
            "featured_image_regeneration_count",
            "featured_image_storage",
            "wp_link",
            "wp_rest_base",
            "wp_last_wp_status",
            "wp_modified_at",
            "wp_synced_at",
            "wp_featured_media_id",
            "wp_featured_image_url",
            "wp_scheduled_at",
            "wp_schedule_wp_status",
            "wp_schedule_error",
            "wp_schedule_batch_id",
            "gsc_status",
            "shopify_blog_id",
            "shopify_article_id",
            "shopify_link",
            "shopify_published_at",
            "shopify_scheduled_at",
            "shopify_schedule_error",
            "shopify_mapped_products",
            "wp_mapped_pages",
            "topic_cluster_id",
            "topic_slot_id",
            "topic_role",
            "integrity_ai_percentage",
            "integrity_flagged_paragraphs",
            "integrity_last_audited_at",
            "wp_category_ids",
        ):
            a[k] = v


def _mongo_doc_to_project(doc: dict[str, Any] | None) -> dict[str, Any]:
    if not doc:
        return {}
    d = dict(doc)
    d.pop("_id", None)
    return {
        "id": d.get("id") or "",
        # Required for per-user project lists and access checks (must match _normalize_project_dict).
        "owner_user_id": _coerce_user_id_str(d.get("owner_user_id")),
        "name": d.get("name") or "",
        "website_url": d.get("website_url") or "",
        "brand_identity": d.get("brand_identity") or "",
        "niche_identifier": d.get("niche_identifier") or "",
        # Structured Brand identity & Niche fields (see _normalize_project_dict
        # for the canonical shape and length caps).
        "brand_voice": d.get("brand_voice") or "",
        "brand_tones": list(d.get("brand_tones") or []),
        "brand_rules": d.get("brand_rules") or "",
        "niche_topic": d.get("niche_topic") or "",
        "audience": list(d.get("audience") or []),
        "target_countries": list(d.get("target_countries") or []),
        "target_countries_all": bool(d.get("target_countries_all", False)),
        "target_cities": list(d.get("target_cities") or []),
        "target_cities_all": bool(d.get("target_cities_all", False)),
        "wp_site_url": d.get("wp_site_url") or "",
        "wp_username": d.get("wp_username") or "",
        "wp_app_password": d.get("wp_app_password") or "",
        "wp_category_ids": d.get("wp_category_ids") or "",
        "prompts": list(d.get("prompts") or []),
        "default_prompt_id": d.get("default_prompt_id") or "",
        "image_prompts": list(d.get("image_prompts") or []),
        "default_image_prompt_id": d.get("default_image_prompt_id") or "",
        "content_brief_templates": list(d.get("content_brief_templates") or []),
        "default_content_brief_template_id": d.get("default_content_brief_template_id") or "",
        "image_style": d.get("image_style") or "semi_real",
        "optimize_image_prompt": bool(d.get("optimize_image_prompt", True)),
        "context_links": list(d.get("context_links") or []),
        "gsc_property_url": d.get("gsc_property_url") or "",
        "gsc_index_on_publish": bool(d.get("gsc_index_on_publish", True)),
        "gsc_access_token": d.get("gsc_access_token") or "",
        "gsc_refresh_token": d.get("gsc_refresh_token") or "",
        "gsc_token_expires_at": str(d.get("gsc_token_expires_at") or ""),
        "gsc_scope": d.get("gsc_scope") or "",
        "gsc_email": d.get("gsc_email") or "",
        "gsc_connected_at": d.get("gsc_connected_at") or "",
        "default_wp_rest_base": d.get("default_wp_rest_base") or "",
        "default_wp_status": d.get("default_wp_status") or "",
        "wp_verified_at": d.get("wp_verified_at") or "",
        "wp_verified_status": d.get("wp_verified_status") or "",
        "wp_verified_message": d.get("wp_verified_message") or "",
        "wp_plugin_status": d.get("wp_plugin_status") or "",
        "wp_plugin_message": d.get("wp_plugin_message") or "",
        "platform": ((d.get("platform") or "wordpress").strip().lower() or "wordpress")[:32],
        "shopify_shop": (d.get("shopify_shop") or "").strip()[:2048],
        "shopify_access_token": (d.get("shopify_access_token") or "").strip()[:5000],
        "shopify_client_id": (d.get("shopify_client_id") or "").strip()[:256],
        "shopify_client_secret": (d.get("shopify_client_secret") or "").strip()[:5000],
        "shopify_token_expires_at": (d.get("shopify_token_expires_at") or "").strip()[:32],
        "shopify_scope": (d.get("shopify_scope") or "").strip()[:2000],
        "shopify_connected_at": (d.get("shopify_connected_at") or "").strip()[:64],
        "shopify_verified_at": (d.get("shopify_verified_at") or "").strip()[:32],
        "shopify_verified_status": (d.get("shopify_verified_status") or "").strip()[:32],
        "shopify_verified_message": (d.get("shopify_verified_message") or "").strip()[:1000],
        "shopify_sync_at": (d.get("shopify_sync_at") or "").strip()[:64],
        "shopify_sync_status": (d.get("shopify_sync_status") or "").strip()[:32],
        "shopify_sync_message": (d.get("shopify_sync_message") or "").strip()[:1000],
        "shopify_catalog": d.get("shopify_catalog") if isinstance(d.get("shopify_catalog"), dict) else {},
        "shopify_product_aware_enabled": bool(d.get("shopify_product_aware_enabled", False)),
        "wp_internal_link_aware_enabled": bool(d.get("wp_internal_link_aware_enabled", False)),
        "content_optimization_profile": d.get("content_optimization_profile") or "none",
        "humanization_settings": d.get("humanization_settings") if isinstance(d.get("humanization_settings"), dict) else {},
        "created_at": d.get("created_at") or "",
    }


def _mongo_doc_to_article(doc: dict[str, Any] | None) -> dict[str, Any]:
    if not doc:
        return {}
    d = dict(doc)
    d.pop("_id", None)
    wp = d.get("wp_post_id")
    if isinstance(wp, int):
        wp_out: int | None = wp
    elif wp is not None and wp != "":
        try:
            wp_out = int(wp)
        except (TypeError, ValueError):
            wp_out = None
    else:
        wp_out = None
    return {
        "id": d.get("id") or "",
        "project_id": d.get("project_id") or "",
        "title": d.get("title") or "",
        "keywords": _coerce_str_list(d.get("keywords")),
        "status": d.get("status") or "pending",
        "article": d.get("article") or "",
        "focus_keyphrase": d.get("focus_keyphrase") or "",
        "meta_title": d.get("meta_title") or "",
        "meta_description": d.get("meta_description") or "",
        "content_brief": d.get("content_brief") if isinstance(d.get("content_brief"), dict) else None,
        "content_brief_draft": d.get("content_brief_draft") if isinstance(d.get("content_brief_draft"), dict) else None,
        "image_url": d.get("image_url") or "",
        "generated_at": d.get("generated_at") or "",
        "posted_at": d.get("posted_at") or "",
        "created_at": d.get("created_at") or "",
        "featured_image_generated_at": d.get("featured_image_generated_at") or "",
        "featured_image_prompt_id": d.get("featured_image_prompt_id") or "",
        "featured_image_source": d.get("featured_image_source") or "",
        "featured_image_prompt_final": d.get("featured_image_prompt_final") or "",
        "featured_image_prompt_raw": d.get("featured_image_prompt_raw") or "",
        "featured_image_model": d.get("featured_image_model") or "",
        "featured_image_quality": d.get("featured_image_quality") or "",
        "featured_image_size": d.get("featured_image_size") or "",
        "featured_image_optimizer_model": d.get("featured_image_optimizer_model") or "",
        "featured_image_prompt_optimizer_error": d.get("featured_image_prompt_optimizer_error") or "",
        "wp_post_id": wp_out,
        "wp_link": d.get("wp_link") or "",
        "wp_rest_base": d.get("wp_rest_base") or "",
        "wp_last_wp_status": d.get("wp_last_wp_status") or "",
        "wp_modified_at": d.get("wp_modified_at") or "",
        "wp_synced_at": d.get("wp_synced_at") or "",
        "wp_scheduled_at": _coerce_wp_scheduled_at_str(d.get("wp_scheduled_at")),
        "wp_schedule_wp_status": d.get("wp_schedule_wp_status") or "",
        "wp_schedule_error": d.get("wp_schedule_error") or "",
        "wp_schedule_batch_id": d.get("wp_schedule_batch_id") or "",
        "wp_schedule_batch_index": d.get("wp_schedule_batch_index") or "",
        "wp_schedule_batch_total": d.get("wp_schedule_batch_total") or "",
        "gsc_status": d.get("gsc_status") or "pending",
        # Feature 4 — rank monitor / smart refresh.
        "monitor_status": d.get("monitor_status") or "",
        "monitor_last_checked_at": d.get("monitor_last_checked_at") or "",
        "monitor_score": d.get("monitor_score") or "",
        "monitor_signature": d.get("monitor_signature") or "",
        # Feature 3 — internal linking telemetry.
        "internal_links_applied_at": d.get("internal_links_applied_at") or "",
        "internal_links_count": int(d.get("internal_links_count") or 0),
    }


def load_projects(owner_user_id: str | None = None) -> list[dict[str, Any]]:
    """
    Load projects, optionally filtered by owner_user_id.

    Prefer :func:`load_projects_listing` for dashboard project lists (skips heavy
    embedded fields such as ``shopify_catalog`` and prompt arrays).
    """
    owner = (owner_user_id or "").strip()
    if _storage_mode != "mongo":
        rows = [_normalize_project_dict(p) for p in _load_json_list("projects.json")]
        if not owner:
            return rows
        ocf = owner.casefold()
        return [
            p
            for p in rows
            if (p.get("owner_user_id") or "").strip() == owner
            or (p.get("owner_user_id") or "").strip().casefold() == ocf
        ]
    db = get_db()
    q = _mongo_owner_user_id_filter(owner) if owner else {}
    cur = db.projects.find(q).sort("created_at", 1)
    return [_mongo_doc_to_project(doc) for doc in cur]


_PROJECT_LISTING_MONGO_PROJECTION: dict[str, int] = {
    "_id": 0,
    "id": 1,
    "owner_user_id": 1,
    "name": 1,
    "website_url": 1,
    "platform": 1,
    "shopify_shop": 1,
    "shopify_access_token": 1,
    "shopify_verified_status": 1,
    "shopify_verified_at": 1,
    "shopify_sync_status": 1,
    "brand_identity": 1,
    "niche_identifier": 1,
    "brand_voice": 1,
    "brand_tones": 1,
    "brand_rules": 1,
    "niche_topic": 1,
    "audience": 1,
    "target_countries": 1,
    "target_countries_all": 1,
    "target_cities": 1,
    "target_cities_all": 1,
    "created_at": 1,
}

_PROJECT_ACCESS_MONGO_PROJECTION: dict[str, int] = {
    **_PROJECT_LISTING_MONGO_PROJECTION,
    "wp_verified_at": 1,
    "wp_verified_status": 1,
    "wp_verified_message": 1,
    "wp_site_url": 1,
    "default_prompt_id": 1,
    "default_image_prompt_id": 1,
}

_PROJECT_SHOPIFY_CATALOG_PROJECTION: dict[str, int] = {
    "_id": 0,
    "id": 1,
    "owner_user_id": 1,
    "platform": 1,
    "shopify_shop": 1,
    "shopify_catalog": 1,
    "shopify_sync_at": 1,
    "shopify_sync_status": 1,
    "shopify_sync_message": 1,
    "shopify_verified_status": 1,
    "shopify_verified_at": 1,
}

_PROJECT_SHOPIFY_STATUS_PROJECTION: dict[str, int] = {
    "_id": 0,
    "id": 1,
    "owner_user_id": 1,
    "shopify_shop": 1,
    "shopify_access_token": 1,
    "shopify_scope": 1,
    "shopify_client_id": 1,
    "shopify_connected_at": 1,
    "shopify_sync_at": 1,
    "shopify_sync_status": 1,
    "shopify_sync_message": 1,
    "shopify_verified_at": 1,
    "shopify_verified_status": 1,
    "shopify_catalog.counts": 1,
    "shopify_catalog.granted_scopes": 1,
    "shopify_catalog.warnings": 1,
}

_SCHEDULED_JOB_LISTING_PROJECTION: dict[str, int] = {
    "_id": 0,
    "id": 1,
    "project_id": 1,
    "article_id": 1,
    "state": 1,
    "run_at": 1,
    "updated_at": 1,
    "last_error": 1,
    "wp_link": 1,
    "wp_post_id": 1,
    "wp_status": 1,
}


def load_projects_listing(owner_user_id: str | None = None) -> list[dict[str, Any]]:
    """Project dashboard list — excludes catalog, prompts, tokens, and GSC secrets."""
    owner = (owner_user_id or "").strip()
    if _storage_mode != "mongo":
        return load_projects(owner_user_id=owner or None)
    db = get_db()
    q = _mongo_owner_user_id_filter(owner) if owner else {}
    cur = db.projects.find(q, _PROJECT_LISTING_MONGO_PROJECTION).sort("created_at", 1)
    return [_mongo_doc_to_project(doc) for doc in cur]


def get_project_listing_by_id(project_id: str) -> dict[str, Any] | None:
    pid = (project_id or "").strip()
    if not pid:
        return None
    if _storage_mode != "mongo":
        for p in _load_json_list("projects.json"):
            if isinstance(p, dict) and (p.get("id") or "").strip() == pid:
                return _normalize_project_dict(dict(p))
        return None
    doc = get_db().projects.find_one({"id": pid}, _PROJECT_LISTING_MONGO_PROJECTION)
    if not isinstance(doc, dict):
        return None
    return _mongo_doc_to_project(doc)


def get_project_access_row(project_id: str) -> dict[str, Any] | None:
    """Auth + platform verification fields without heavy project blobs."""
    pid = (project_id or "").strip()
    if not pid:
        return None
    if _storage_mode != "mongo":
        return get_project_listing_by_id(pid)
    doc = get_db().projects.find_one({"id": pid}, _PROJECT_ACCESS_MONGO_PROJECTION)
    if not isinstance(doc, dict):
        return None
    return _mongo_doc_to_project(doc)


def get_project_shopify_catalog_doc(project_id: str) -> dict[str, Any] | None:
    """Read cached Shopify catalog only (no live Admin API)."""
    pid = (project_id or "").strip()
    if not pid:
        return None
    if _storage_mode != "mongo":
        proj = get_project_listing_by_id(pid)
        return proj if isinstance(proj, dict) else None
    doc = get_db().projects.find_one({"id": pid}, _PROJECT_SHOPIFY_CATALOG_PROJECTION)
    if not isinstance(doc, dict):
        return None
    return _mongo_doc_to_project(doc)


def get_project_shopify_status_doc(project_id: str) -> dict[str, Any] | None:
    """Shopify dashboard status from Mongo only — excludes product/page catalog payloads."""
    pid = (project_id or "").strip()
    if not pid:
        return None
    if _storage_mode != "mongo":
        proj = get_project_listing_by_id(pid)
        if not isinstance(proj, dict):
            return None
        catalog = proj.get("shopify_catalog") if isinstance(proj.get("shopify_catalog"), dict) else {}
        return {
            **proj,
            "shopify_catalog": {
                k: catalog.get(k)
                for k in ("counts", "granted_scopes", "warnings")
                if k in catalog
            },
        }
    doc = get_db().projects.find_one({"id": pid}, _PROJECT_SHOPIFY_STATUS_PROJECTION)
    if not isinstance(doc, dict):
        return None
    return _mongo_doc_to_project(doc)


def get_project_by_id(project_id: str) -> dict[str, Any] | None:
    """Point lookup for scheduler / generation worker (avoids loading all projects)."""
    pid = (project_id or "").strip()
    if not pid:
        return None
    if _storage_mode != "mongo":
        for p in _load_json_list("projects.json"):
            if isinstance(p, dict) and (p.get("id") or "").strip() == pid:
                return _normalize_project_dict(dict(p))
        return None
    doc = get_db().projects.find_one({"id": pid})
    if not isinstance(doc, dict):
        return None
    return _mongo_doc_to_project(doc)


def get_project_for_generation(project_id: str) -> dict[str, Any] | None:
    """Project read for the generation/scheduler hot loop (P4.1).

    Excludes the embedded ``shopify_catalog`` metadata: product data lives in the
    ``shopify_products`` collection and is loaded separately, so the worker never
    needs the embedded blob. All other project fields (prompts, brand identity,
    WordPress credentials, etc.) are returned unchanged.
    """
    pid = (project_id or "").strip()
    if not pid:
        return None
    if _storage_mode != "mongo":
        return get_project_by_id(pid)
    doc = get_db().projects.find_one({"id": pid}, {"shopify_catalog": 0})
    if not isinstance(doc, dict):
        return None
    return _mongo_doc_to_project(doc)


def load_articles() -> list[dict[str, Any]]:
    if _storage_mode != "mongo":
        return [_normalize_article_dict(a) for a in _load_json_list("articles.json")]
    db = get_db()
    return [_mongo_doc_to_article(doc) for doc in db.articles.find({})]


def _find_article_doc(db, pid: str, aid: str, projection: dict[str, Any] | None = None):
    """Resolve article by logical id or legacy ``_id``."""
    doc = db.articles.find_one({"project_id": pid, "id": aid}, projection)
    if not isinstance(doc, dict):
        doc = db.articles.find_one({"_id": aid, "project_id": pid}, projection)
    return doc if isinstance(doc, dict) else None


def get_article(*, project_id: str, article_id: str) -> dict[str, Any] | None:
    """
    Fetch one article by id within a project.

    Used by the editor API to avoid scanning `load_articles()` for large collections.
    """
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    if not pid or not aid:
        return None
    if _storage_mode != "mongo":
        for a in _load_json_list("articles.json"):
            if not isinstance(a, dict):
                continue
            if (a.get("id") or "").strip() == aid and (a.get("project_id") or "").strip() == pid:
                return _normalize_article_dict(a)
        return None

    db = get_db()
    doc = _find_article_doc(db, pid, aid)
    if not doc:
        return None
    return _mongo_doc_to_article(doc)


# Fields required for featured-image generation/regeneration (no article body or inline image bytes).
_IMAGE_REGEN_FIELD_NAMES = (
    "id",
    "project_id",
    "title",
    "keywords",
    "focus_keyphrase",
    "featured_image_regeneration_count",
    "featured_image_generated_at",
    "featured_image_source",
    "featured_image_prompt_id",
    "shopify_mapped_products",
    "wp_mapped_pages",
)


def get_article_for_image_regeneration(*, project_id: str, article_id: str) -> dict[str, Any] | None:
    """
    Lightweight article row for OpenAI image generation.

    Excludes ``article`` (markdown body) and ``image_url`` (often a multi‑MB data URL) so
    Mongo reads stay fast and do not hit socket timeouts on large documents.
    """
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    if not pid or not aid:
        return None
    if _storage_mode != "mongo":
        row = get_article(project_id=pid, article_id=aid)
        if not row:
            return None
        out = {k: row.get(k) for k in _IMAGE_REGEN_FIELD_NAMES}
        out["has_featured_image"] = article_has_stored_featured_image(article_id=aid, row=row)
        return out

    db = get_db()
    match_or = [{"project_id": pid, "id": aid}, {"_id": aid, "project_id": pid}]
    pipeline = [
        {"$match": {"$or": match_or}},
        {"$limit": 1},
        {
            "$project": {
                "_id": 0,
                "id": 1,
                "project_id": 1,
                "title": 1,
                "keywords": 1,
                "focus_keyphrase": 1,
                "featured_image_regeneration_count": 1,
                "featured_image_generated_at": 1,
                "featured_image_source": 1,
                "featured_image_prompt_id": 1,
                "shopify_mapped_products": 1,
                "wp_mapped_pages": 1,
                "has_featured_image": {
                    "$or": [
                        {"$gt": [{"$strLenCP": {"$ifNull": ["$image_url", ""]}}, 0]},
                        {"$gt": [{"$strLenCP": {"$ifNull": ["$featured_image_generated_at", ""]}}, 0]},
                    ]
                },
            }
        },
    ]
    cur = db.articles.aggregate(pipeline)
    doc = next(cur, None)
    if not isinstance(doc, dict):
        return None
    row = _mongo_doc_to_article(doc)
    row["has_featured_image"] = article_has_stored_featured_image(article_id=aid, row=row)
    return row


def get_article_image_url(*, project_id: str, article_id: str) -> str | None:
    """Return only ``image_url`` (for GET featured-image) without loading the article body."""
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    if not pid or not aid:
        return None
    if _storage_mode != "mongo":
        row = get_article(project_id=pid, article_id=aid)
        if not row:
            if featured_image_file_exists(aid):
                return _load_featured_image_file_as_data_url(aid)
            return None
        if featured_image_file_exists(aid):
            loaded = _load_featured_image_file_as_data_url(aid)
            if loaded:
                return loaded
        raw = (row.get("image_url") or "").strip()
        return raw or None

    db = get_db()
    doc = _find_article_doc(
        db,
        pid,
        aid,
        {"_id": 0, "image_url": 1, "featured_image_storage": 1},
    )
    if featured_image_file_exists(aid):
        loaded = _load_featured_image_file_as_data_url(aid)
        if loaded:
            return loaded
    if not doc:
        return None
    raw = (doc.get("image_url") or "").strip()
    return raw or None


def get_article_generation_status(*, project_id: str, article_id: str) -> dict[str, Any] | None:
    """Tiny projection for frontend polling — no body, image bytes, or cluster scans."""
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    if not pid or not aid:
        return None
    if _storage_mode != "mongo":
        row = get_article(project_id=pid, article_id=aid)
        if not row:
            return None
        has_img = article_has_stored_featured_image(article_id=aid, row=row)
        return {
            "id": aid,
            "status": (row.get("status") or "pending")[:32],
            "generated_at": (row.get("generated_at") or "")[:64] or None,
            "has_body": bool((row.get("article") or "").strip()),
            "has_featured_image": has_img,
            "featured_image_regeneration_count": int(row.get("featured_image_regeneration_count") or 0),
        }

    db = get_db()
    match_or = [{"project_id": pid, "id": aid}, {"_id": aid, "project_id": pid}]
    pipeline = [
        {"$match": {"$or": match_or}},
        {"$limit": 1},
        {
            "$project": {
                "_id": 0,
                "id": 1,
                "status": 1,
                "generated_at": 1,
                "featured_image_generated_at": 1,
                "featured_image_regeneration_count": 1,
                "has_body": {"$gt": [{"$strLenCP": {"$ifNull": ["$article", ""]}}, 0]},
                "has_featured_image": {
                    "$or": [
                        {"$gt": [{"$strLenCP": {"$ifNull": ["$image_url", ""]}}, 0]},
                        {"$gt": [{"$strLenCP": {"$ifNull": ["$featured_image_generated_at", ""]}}, 0]},
                    ]
                },
            }
        },
    ]
    try:
        doc = next(db.articles.aggregate(pipeline), None)
    except Exception:
        doc = _find_article_doc(
            db,
            pid,
            aid,
            {
                "_id": 0,
                "id": 1,
                "status": 1,
                "generated_at": 1,
                "featured_image_generated_at": 1,
                "featured_image_regeneration_count": 1,
            },
        )
        if not isinstance(doc, dict):
            return None
        doc["has_body"] = _mongo_article_has_body(db, pid, aid)
        doc["has_featured_image"] = article_has_stored_featured_image(article_id=aid, row=doc)
    if not isinstance(doc, dict):
        return None
    has_img = bool(doc.get("has_featured_image"))
    if not has_img:
        has_img = article_has_stored_featured_image(article_id=aid, row=doc)
    return {
        "id": (doc.get("id") or aid).strip(),
        "status": (doc.get("status") or "pending")[:32],
        "generated_at": (doc.get("generated_at") or "")[:64] or None,
        "has_body": bool(doc.get("has_body")),
        "has_featured_image": has_img,
        "featured_image_regeneration_count": int(doc.get("featured_image_regeneration_count") or 0),
    }


def get_article_editor_shell(*, project_id: str, article_id: str) -> dict[str, Any] | None:
    """Metadata for the editor without the large ``article`` body or inline ``image_url``."""
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    if not pid or not aid:
        return None
    if _storage_mode != "mongo":
        row = get_article(project_id=pid, article_id=aid)
        if not row:
            return None
        out = dict(row)
        out["hasBody"] = bool((row.get("article") or "").strip())
        out["article"] = ""
        out["image_url"] = ""
        return out

    db = get_db()
    doc = _find_article_doc(
        db,
        pid,
        aid,
        {
            "_id": 0,
            "article": 0,
            "image_url": 0,
        },
    )
    if not doc:
        return None
    row = _mongo_doc_to_article(doc)
    row["article"] = ""
    row["image_url"] = ""
    row["hasBody"] = _mongo_article_has_body(db, pid, aid)
    return row


def _mongo_article_has_body(db, pid: str, aid: str) -> bool:
    """True when body text exists, without loading the full article string."""
    for match in ({"project_id": pid, "id": aid}, {"_id": aid, "project_id": pid}):
        try:
            cur = db.articles.aggregate(
                [
                    {"$match": match},
                    {"$limit": 1},
                    {"$project": {"hb": {"$gt": [{"$strLenCP": {"$ifNull": ["$article", ""]}}, 0]}}},
                ]
            )
            for d in cur:
                return bool(d.get("hb"))
        except Exception:
            probe = db.articles.find_one(match, {"_id": 0, "article": 1})
            if isinstance(probe, dict):
                return bool((probe.get("article") or "").strip())
    return False


def get_article_body_text(*, project_id: str, article_id: str) -> str | None:
    """Return only the article body markdown/HTML."""
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    if not pid or not aid:
        return None
    if _storage_mode != "mongo":
        row = get_article(project_id=pid, article_id=aid)
        return (row or {}).get("article") or "" if row else None

    db = get_db()
    doc = _find_article_doc(db, pid, aid, {"_id": 0, "article": 1})
    if not doc:
        return None
    return (doc.get("article") or "")


def load_articles_by_ids_for_project(project_id: str, article_ids: list[str]) -> dict[str, dict[str, Any]]:
    """Return article rows keyed by id for bulk schedule / batch operations."""
    pid = (project_id or "").strip()
    aids = sorted({(x or "").strip() for x in (article_ids or []) if (x or "").strip()})
    if not pid or not aids:
        return {}
    if _storage_mode != "mongo":
        out: dict[str, dict[str, Any]] = {}
        for a in _load_json_list("articles.json"):
            if not isinstance(a, dict):
                continue
            aid = (a.get("id") or "").strip()
            if aid in aids and (a.get("project_id") or "").strip() == pid:
                out[aid] = _normalize_article_dict(a)
        return out
    out: dict[str, dict[str, Any]] = {}
    stub_proj = {
        "_id": 0,
        "id": 1,
        "title": 1,
        "status": 1,
        "focus_keyphrase": 1,
        "keywords": 1,
        "wp_scheduled_at": 1,
        "wp_post_id": 1,
        "wp_link": 1,
        "posted_at": 1,
        "created_at": 1,
    }
    for doc in get_db().articles.find({"project_id": pid, "id": {"$in": aids}}, stub_proj):
        if isinstance(doc, dict):
            aid = (doc.get("id") or "").strip()
            if aid:
                out[aid] = dict(doc)
    return out


def load_articles_for_project_minimal(
    project_id: str,
    *,
    status: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 500,
) -> list[dict[str, Any]]:
    """
    Fast path for UI polling: returns minimal fields for a project's articles.
    Uses a projection and query on project_id to avoid full collection scans.
    """
    pid = (project_id or "").strip()
    if not pid:
        return []
    if _storage_mode != "mongo":
        # JSON fallback is already in-memory file read; keep compatibility.
        rows = [_normalize_article_dict(a) for a in _load_json_list("articles.json")]
        out = [r for r in rows if (r.get("project_id") or "") == pid]
        return out[: max(1, min(int(limit or 500), 2000))]

    q: dict[str, Any] = {"project_id": pid}
    if status:
        s = (status or "").strip().lower()
        if s in {"pending", "draft", "published"}:
            q["status"] = s

    # Date filtering: use posted_at when available otherwise created_at.
    # We store these as strings, so range queries are only safe on consistent formats.
    # Keep filtering in app for correctness; only constrain by project/status here.

    proj = {
        "_id": 0,
        "id": 1,
        "status": 1,
        "posted_at": 1,
        "created_at": 1,
        "updated_at": 1,
        "wp_scheduled_at": 1,
        "wp_schedule_error": 1,
        "gsc_status": 1,
        "gsc_inspection_requested_at": 1,
        "gsc_inspection_error": 1,
    }
    lim = max(1, min(int(limit or 500), 2000))
    cur = (
        get_db()
        .articles.find(q, proj)
        .sort("created_at", -1)
        .limit(lim)
    )
    out: list[dict[str, Any]] = []
    for d in cur:
        out.append(
            {
                "id": (d.get("id") or "").strip(),
                "project_id": pid,
                "status": (d.get("status") or "pending"),
                "posted_at": (d.get("posted_at") or ""),
                "created_at": (d.get("created_at") or ""),
                "updated_at": (d.get("updated_at") or ""),
                "wp_scheduled_at": _coerce_wp_scheduled_at_str(d.get("wp_scheduled_at")),
                "wp_schedule_error": (d.get("wp_schedule_error") or ""),
                "gsc_status": (d.get("gsc_status") or "pending"),
                "gsc_inspection_requested_at": (d.get("gsc_inspection_requested_at") or ""),
                "gsc_inspection_error": (d.get("gsc_inspection_error") or ""),
            }
        )
    return out


def load_scheduled_pending_for_project_minimal(project_id: str, *, limit: int = 200) -> list[dict[str, Any]]:
    """Fast path: only scheduled + not posted items for sidebar polling."""
    pid = (project_id or "").strip()
    if not pid:
        return []
    if _storage_mode != "mongo":
        rows = [_normalize_article_dict(a) for a in _load_json_list("articles.json")]
        out = []
        for r in rows:
            if (r.get("project_id") or "") != pid:
                continue
            if r.get("wp_post_id"):
                continue
            if not _coerce_wp_scheduled_at_str(r.get("wp_scheduled_at")):
                continue
            out.append(r)
        return out[: max(1, min(int(limit or 200), 1000))]

    q: dict[str, Any] = {
        "project_id": pid,
        "$and": [{"wp_post_id": {"$in": [None, "", 0]}}],
        "wp_scheduled_at": {"$exists": True, "$ne": ""},
    }
    proj = {
        "_id": 0,
        "id": 1,
        "title": 1,
        "wp_scheduled_at": 1,
        "wp_schedule_wp_status": 1,
        "wp_schedule_state": 1,
        "wp_schedule_error": 1,
        "hasBody": {"$gt": [{"$strLenCP": {"$ifNull": ["$article", ""]}}, 0]},
    }
    lim = max(1, min(int(limit or 200), 1000))
    cur = get_db().articles.find(q, proj).sort("wp_scheduled_at", 1).limit(lim)
    return [dict(d) for d in cur]


def load_articles_schedule_stubs_for_project(project_id: str, *, limit: int = 500) -> list[dict[str, Any]]:
    """Minimal rows for scheduled-articles UI (orphan job detection without full article bodies)."""
    pid = (project_id or "").strip()
    if not pid:
        return []
    lim = max(1, min(int(limit or 500), 2000))
    if _storage_mode != "mongo":
        rows = [_normalize_article_dict(a) for a in _load_json_list("articles.json")]
        out = []
        for r in rows:
            if (r.get("project_id") or "") != pid:
                continue
            if not _coerce_wp_scheduled_at_str(r.get("wp_scheduled_at")):
                continue
            out.append(
                {
                    "id": (r.get("id") or "").strip(),
                    "title": (r.get("title") or "").strip(),
                    "wp_scheduled_at": _coerce_wp_scheduled_at_str(r.get("wp_scheduled_at")),
                    "wp_link": (r.get("wp_link") or "").strip(),
                }
            )
        return out[:lim]

    q: dict[str, Any] = {
        "project_id": pid,
        "wp_scheduled_at": {"$exists": True, "$ne": ""},
    }
    proj = {"_id": 0, "id": 1, "title": 1, "wp_scheduled_at": 1, "wp_link": 1}
    cur = get_db().articles.find(q, proj).sort("wp_scheduled_at", -1).limit(lim)
    out: list[dict[str, Any]] = []
    for d in cur:
        if not _coerce_wp_scheduled_at_str(d.get("wp_scheduled_at")):
            continue
        out.append(
            {
                "id": (d.get("id") or "").strip(),
                "title": (d.get("title") or "").strip(),
                "wp_scheduled_at": _coerce_wp_scheduled_at_str(d.get("wp_scheduled_at")),
                "wp_link": (d.get("wp_link") or "").strip(),
            }
        )
    return out


# Listing queries must not touch the full ``article`` body (large HTML); only fields needed for
# status derivation and the Articles table UI.
_LISTING_PROJECTION_STAGE = {
    "$project": {
        "_id": 0,
        "id": 1,
        "project_id": 1,
        "title": 1,
        "keywords": 1,
        "status": {"$ifNull": ["$status", "pending"]},
        "focus_keyphrase": 1,
        "posted_at": 1,
        "created_at": 1,
        "updated_at": 1,
        "wp_post_id": 1,
        "wp_link": 1,
        "wp_last_wp_status": 1,
        "wp_scheduled_at": 1,
        "gsc_status": 1,
        "monitor_status": 1,
        "shopify_link": 1,
        "shopify_article_id": 1,
        # Prefer the persisted flag (P4.3); fall back to a body length check only
        # for rows written before the backfill ran.
        "hasBody": {"$ifNull": ["$has_body", {"$gt": [{"$strLenCP": {"$ifNull": ["$article", ""]}}, 0]}]},
        "listing_status": 1,
    }
}


def load_articles_listing_for_project(
    project_id: str,
    *,
    limit: int = 5000,
) -> list[dict[str, Any]]:
    """
    Return article rows for the project page listing without loading full article bodies.
    Includes a computed hasBody flag (derived in Mongo) so UI can decide which items need generation.
    """
    pid = (project_id or "").strip()
    if not pid:
        return []
    if _storage_mode != "mongo":
        rows = [_normalize_article_dict(a) for a in _load_json_list("articles.json")]
        out = [r for r in rows if (r.get("project_id") or "") == pid]
        # Compute hasBody locally for JSON fallback
        for r in out:
            r["hasBody"] = bool((r.get("article") or "").strip())
        return out[: max(1, min(int(limit or 5000), 20000))]

    lim = max(1, min(int(limit or 5000), 20000))
    db = get_db()
    pipeline = [
        {"$match": {"project_id": pid}},
        {
            "$project": {
                **_LISTING_PROJECTION_STAGE["$project"],
                "id": {
                    "$cond": {
                        "if": {"$gt": [{"$strLenCP": {"$ifNull": ["$id", ""]}}, 0]},
                        "then": "$id",
                        "else": {"$toString": "$_id"},
                    }
                },
            }
        },
        {"$sort": {"created_at": -1}},
        {"$limit": lim},
    ]
    out: list[dict[str, Any]] = []
    for d in db.articles.aggregate(pipeline, allowDiskUse=False):
        # Normalize a subset (keep strings tidy)
        d["wp_scheduled_at"] = _coerce_wp_scheduled_at_str(d.get("wp_scheduled_at"))
        out.append(d)
    return out


def _listing_match_for_project(
    project_id: str,
    *,
    q: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, Any]:
    """Mongo match for listing queries (project, optional text + created_at range)."""
    pid = (project_id or "").strip()
    match: dict[str, Any] = {"project_id": pid}
    qs = (q or "").strip()
    if qs:
        import re

        rx = re.escape(qs)
        match["$or"] = [
            {"title": {"$regex": rx, "$options": "i"}},
            {"focus_keyphrase": {"$regex": rx, "$options": "i"}},
            {"keywords": {"$elemMatch": {"$regex": rx, "$options": "i"}}},
        ]
    df = (date_from or "").strip()
    dt = (date_to or "").strip()
    created: dict[str, Any] = {}
    if df:
        created["$gte"] = df if len(df) > 10 else f"{df} 00:00:00"
    if dt:
        # Inclusive end date: rows strictly before the next calendar day.
        try:
            from datetime import datetime, timedelta

            d0 = datetime.strptime(dt[:10], "%Y-%m-%d")
            next_day = (d0 + timedelta(days=1)).strftime("%Y-%m-%d")
            created["$lt"] = f"{next_day} 00:00:00"
        except Exception:
            created["$lte"] = f"{dt} 23:59:59"
    if created:
        match["created_at"] = created
    return match


def _normalize_listing_row(d: dict[str, Any]) -> dict[str, Any]:
    d["wp_scheduled_at"] = _coerce_wp_scheduled_at_str(d.get("wp_scheduled_at"))
    return d


def count_articles_listing_for_project(
    project_id: str,
    *,
    q: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    status_key: str | None = None,
) -> int:
    """Count articles matching listing filters.

    When ``status_key`` is given, matches the persisted ``listing_status`` (P4.3)
    directly in Mongo instead of scanning up to 20k rows in Python.
    """
    pid = (project_id or "").strip()
    if not pid:
        return 0
    sk = (status_key or "").strip().lower()
    if _storage_mode != "mongo":
        rows = load_articles_listing_for_project(pid, limit=20000)
        match = _listing_match_for_project(pid, q=q, date_from=date_from, date_to=date_to)
        if sk:
            rows = [r for r in rows if (r.get("listing_status") or "").strip().lower() == sk]
        # JSON fallback: approximate by re-filtering in Python
        out = []
        for r in rows:
            if match.get("$or"):
                qs = (q or "").strip().lower()
                hay = " ".join(
                    [
                        str(r.get("title") or ""),
                        str(r.get("focus_keyphrase") or ""),
                        " ".join(str(x) for x in (r.get("keywords") or [])),
                    ]
                ).lower()
                if qs not in hay:
                    continue
            ca = str(r.get("created_at") or "")
            cr = match.get("created_at") or {}
            if "$gte" in cr and ca < str(cr["$gte"]):
                continue
            if "$lt" in cr and ca >= str(cr["$lt"]):
                continue
            out.append(r)
        return len(out)
    db = get_db()
    match = _listing_match_for_project(pid, q=q, date_from=date_from, date_to=date_to)
    if sk:
        match["listing_status"] = sk
    return int(db.articles.count_documents(match))


def load_articles_listing_page_for_project(
    project_id: str,
    *,
    page: int = 1,
    per_page: int = 10,
    q: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    sort: str = "desc",
    status_key: str | None = None,
) -> list[dict[str, Any]]:
    """One page of listing rows (no full article body), sorted by created_at.

    When ``status_key`` is given, matches the persisted ``listing_status`` (P4.3)
    directly in Mongo so a status-filtered page is a single indexed query.
    """
    pid = (project_id or "").strip()
    if not pid:
        return []
    pg = max(1, int(page or 1))
    pp = max(1, min(int(per_page or 10), 5000))
    direction = -1 if (sort or "desc").strip().lower() != "asc" else 1
    skip = (pg - 1) * pp
    sk = (status_key or "").strip().lower()

    if _storage_mode != "mongo":
        rows = load_articles_listing_for_project(pid, limit=20000)
        match = _listing_match_for_project(pid, q=q, date_from=date_from, date_to=date_to)
        if sk:
            rows = [r for r in rows if (r.get("listing_status") or "").strip().lower() == sk]
        filtered: list[dict[str, Any]] = []
        for r in rows:
            if match.get("$or"):
                qs = (q or "").strip().lower()
                hay = " ".join(
                    [
                        str(r.get("title") or ""),
                        str(r.get("focus_keyphrase") or ""),
                        " ".join(str(x) for x in (r.get("keywords") or [])),
                    ]
                ).lower()
                if qs not in hay:
                    continue
            ca = str(r.get("created_at") or "")
            cr = match.get("created_at") or {}
            if "$gte" in cr and ca < str(cr["$gte"]):
                continue
            if "$lt" in cr and ca >= str(cr["$lt"]):
                continue
            filtered.append(r)
        filtered.sort(key=lambda x: str(x.get("created_at") or ""), reverse=(direction < 0))
        return filtered[skip : skip + pp]

    db = get_db()
    match = _listing_match_for_project(pid, q=q, date_from=date_from, date_to=date_to)
    if sk:
        match["listing_status"] = sk
    pipeline = [
        {"$match": match},
        _LISTING_PROJECTION_STAGE,
        {"$sort": {"created_at": direction}},
        {"$skip": skip},
        {"$limit": pp},
    ]
    out: list[dict[str, Any]] = []
    for d in db.articles.aggregate(pipeline, allowDiskUse=False):
        out.append(_normalize_listing_row(dict(d)))
    return out


def backfill_article_listing_fields(*, batch_size: int = 1000) -> int:
    """Idempotent backfill of persisted ``has_body`` + ``listing_status`` (P4.3).

    Only touches docs missing either field. A server-side ``$project`` computes
    ``has_body`` without transferring article bodies to the client; the
    ``listing_status`` is derived in Python from the light status fields. Returns
    the number of documents updated. Safe to call repeatedly (becomes a no-op
    once every doc carries both fields).
    """
    if _storage_mode != "mongo":
        return 0
    from pymongo import UpdateOne

    db = get_db()
    flt = {"$or": [{"has_body": {"$exists": False}}, {"listing_status": {"$exists": False}}]}
    pipeline = [
        {"$match": flt},
        {
            "$project": {
                "status": 1,
                "wp_last_wp_status": 1,
                "wp_link": 1,
                "wp_post_id": 1,
                "wp_scheduled_at": 1,
                "shopify_link": 1,
                "shopify_article_id": 1,
                "has_body": {"$gt": [{"$strLenCP": {"$ifNull": ["$article", ""]}}, 0]},
            }
        },
    ]
    updated = 0
    ops: list[UpdateOne] = []
    bs = max(100, int(batch_size or 1000))
    for d in db.articles.aggregate(pipeline, allowDiskUse=True):
        ops.append(
            UpdateOne(
                {"_id": d["_id"]},
                {
                    "$set": {
                        "has_body": bool(d.get("has_body")),
                        "listing_status": _derive_article_listing_status(d),
                    }
                },
            )
        )
        if len(ops) >= bs:
            res = db.articles.bulk_write(ops, ordered=False)
            updated += int(res.modified_count or 0)
            ops = []
    if ops:
        res = db.articles.bulk_write(ops, ordered=False)
        updated += int(res.modified_count or 0)
    if updated:
        _log.info("backfill_article_listing_fields: updated %d article(s)", updated)
    return updated


def load_article_titles_for_project(project_id: str, *, limit: int = 20000) -> list[dict[str, Any]]:
    """Id + title only — for scheduled-job labels and research import reconciliation."""
    pid = (project_id or "").strip()
    if not pid:
        return []
    lim = max(1, min(int(limit or 20000), 20000))
    if _storage_mode != "mongo":
        rows = load_articles_listing_for_project(pid, limit=lim)
        return [{"id": (r.get("id") or "").strip(), "title": (r.get("title") or "").strip()} for r in rows if (r.get("id") or "").strip()]

    db = get_db()
    cur = (
        db.articles.find({"project_id": pid}, {"_id": 0, "id": 1, "title": 1})
        .sort("created_at", -1)
        .limit(lim)
    )
    return [{"id": (d.get("id") or "").strip(), "title": (d.get("title") or "").strip()} for d in cur if (d.get("id") or "").strip()]


def load_posted_scheduled_jobs_for_articles(
    project_id: str,
    article_ids: list[str],
) -> dict[str, dict[str, Any]]:
    """Posted scheduled-job rows keyed by article_id (only for the given ids)."""
    pid = (project_id or "").strip()
    aids = sorted({(x or "").strip() for x in (article_ids or []) if (x or "").strip()})
    if not pid or not aids:
        return {}
    if _storage_mode != "mongo":
        rows = load_scheduled_jobs(project_id=pid, state="posted", limit=5000) or []
        best: dict[str, dict[str, Any]] = {}
        aid_set = set(aids)
        for j in rows:
            if not isinstance(j, dict):
                continue
            aid = (j.get("article_id") or "").strip()
            if aid not in aid_set:
                continue
            cur = best.get(aid)
            if cur is None:
                best[aid] = j
                continue
            jw = (j.get("wp_link") or "").strip()
            cw = (cur.get("wp_link") or "").strip()
            if jw and not cw:
                best[aid] = j
        return best

    q: dict[str, Any] = {"project_id": pid, "state": "posted", "article_id": {"$in": aids}}
    proj = {
        "_id": 0,
        "article_id": 1,
        "wp_link": 1,
        "wp_post_id": 1,
        "wp_status": 1,
        "updated_at": 1,
        "last_attempt_at": 1,
        "created_at": 1,
    }
    best: dict[str, dict[str, Any]] = {}
    for doc in get_db().scheduled_jobs.find(q, proj):
        if not isinstance(doc, dict):
            continue
        aid = (doc.get("article_id") or "").strip()
        if not aid:
            continue
        cur = best.get(aid)
        if cur is None:
            best[aid] = dict(doc)
            continue
        jw = (doc.get("wp_link") or "").strip()
        cw = (cur.get("wp_link") or "").strip()
        if jw and not cw:
            best[aid] = dict(doc)
    return best


def article_totals_per_project(project_ids: list[str]) -> dict[str, int]:
    """Return total article counts keyed by project_id (admin reporting)."""
    pids = sorted({str(x).strip() for x in (project_ids or []) if str(x).strip()})
    if not pids:
        return {}
    if _storage_mode != "mongo":
        rows = [_normalize_article_dict(a) for a in _load_json_list("articles.json")]
        out: dict[str, int] = {p: 0 for p in pids}
        ps = set(pids)
        for a in rows:
            pid = (a.get("project_id") or "").strip()
            if pid in ps:
                out[pid] = out.get(pid, 0) + 1
        return out
    db = get_db()
    tallies: dict[str, int] = {p: 0 for p in pids}
    try:
        pipeline = [
            {"$match": {"project_id": {"$in": pids}}},
            {"$group": {"_id": "$project_id", "n": {"$sum": 1}}},
        ]
        for row in db.articles.aggregate(pipeline, allowDiskUse=False):
            k = str(row.get("_id") or "").strip()
            if k in tallies:
                tallies[k] = int(row.get("n") or 0)
    except Exception:
        for pid in pids:
            tallies[pid] = int(db.articles.count_documents({"project_id": pid}))
    return tallies


def load_recent_article_listings_for_projects(
    project_ids: list[str],
    *,
    limit: int = 1500,
) -> list[dict[str, Any]]:
    """
    Recent articles across multiple projects for admin dashboards (titles + listing fields only).
    """
    pids = sorted({str(x).strip() for x in (project_ids or []) if str(x).strip()})
    if not pids:
        return []
    lim = max(1, min(int(limit or 1500), 5000))

    if _storage_mode != "mongo":
        rows = [_normalize_article_dict(a) for a in _load_json_list("articles.json")]
        ps = set(pids)
        out = [r for r in rows if (r.get("project_id") or "").strip() in ps]
        out.sort(key=lambda r: (r.get("created_at") or ""), reverse=True)
        trimmed = out[:lim]
        for r in trimmed:
            r["hasBody"] = bool((r.get("article") or "").strip())
            r["status"] = (r.get("status") or "pending") if isinstance(r.get("status"), str) else str(r.get("status") or "pending")
            r["title"] = (r.get("title") or "").strip()
        return trimmed

    db = get_db()
    pipeline = [
        {"$match": {"project_id": {"$in": pids}}},
        {
            "$project": {
                "_id": 0,
                "id": {
                    "$cond": {
                        "if": {"$gt": [{"$strLenCP": {"$ifNull": ["$id", ""]}}, 0]},
                        "then": "$id",
                        "else": {"$toString": "$_id"},
                    }
                },
                "project_id": 1,
                "title": 1,
                "keywords": 1,
                "status": {"$ifNull": ["$status", "pending"]},
                "focus_keyphrase": 1,
                "meta_title": 1,
                "meta_description": 1,
                "generated_at": 1,
                "posted_at": 1,
                "created_at": 1,
                "updated_at": 1,
                "wp_post_id": 1,
                "wp_link": 1,
                "wp_rest_base": 1,
                "wp_last_wp_status": 1,
                "wp_scheduled_at": 1,
                "wp_schedule_wp_status": 1,
                "wp_schedule_error": 1,
                "wp_schedule_batch_id": 1,
                "wp_schedule_batch_index": 1,
                "wp_schedule_batch_total": 1,
                "gsc_status": 1,
                "gsc_inspection_requested_at": 1,
                "gsc_inspection_error": 1,
                "hasFeaturedImage": {
                    "$gt": [{"$strLenCP": {"$ifNull": ["$image_url", ""]}}, 0],
                },
                "hasBody": {"$gt": [{"$strLenCP": {"$ifNull": ["$article", ""]}}, 0]},
            }
        },
        {"$sort": {"created_at": -1}},
        {"$limit": lim},
    ]
    out_list: list[dict[str, Any]] = []
    for d in db.articles.aggregate(pipeline, allowDiskUse=True):
        d["wp_scheduled_at"] = _coerce_wp_scheduled_at_str(d.get("wp_scheduled_at"))
        if not (d.get("id") or "").strip():
            continue
        out_list.append(d)
    return out_list


def save_research_serp_snapshot(snapshot: dict[str, Any]) -> None:
    """
    Persist a SERP snapshot for future improvements/learning.

    Storage:
    - Mongo: `research_serp` collection, keyed by a stable `_id` (project_id + query + gl + hl + html_sha256).
    - JSON fallback: append to `research_serp.json` (bounded list).
    """
    s = dict(snapshot or {})
    pid = (s.get("project_id") or "").strip()
    query = (s.get("query") or "").strip()
    gl = (s.get("gl") or "").strip()
    hl = (s.get("hl") or "").strip()
    sha = (s.get("html_sha256") or "").strip()
    if not pid or not query:
        return
    if _storage_mode != "mongo":
        with _db_write_lock:
            rows = [x for x in _load_json_list("research_serp.json") if isinstance(x, dict)]
            rows.append(s)
            # Keep most recent 2000 snapshots to avoid unbounded growth in fallback mode.
            rows = rows[-2000:]
            _save_json("research_serp.json", rows)
        return
    doc = dict(s)
    doc["_id"] = f"{pid}:{gl}:{hl}:{query.casefold()}:{sha}" if sha else f"{pid}:{gl}:{hl}:{query.casefold()}"
    with _db_write_lock:
        get_db().research_serp.update_one({"_id": doc["_id"]}, {"$set": doc}, upsert=True)


def load_research_serp_history(
    *,
    project_id: str,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Load recent SERP snapshots for a project (for analysis context)."""
    pid = (project_id or "").strip()
    if not pid:
        return []
    lim = max(1, min(int(limit or 50), 200))
    if _storage_mode != "mongo":
        rows = [x for x in _load_json_list("research_serp.json") if isinstance(x, dict)]
        out = [r for r in rows if (r.get("project_id") or "").strip() == pid]
        out.sort(key=lambda r: float(r.get("fetched_at") or 0.0), reverse=True)
        return out[:lim]
    cur = get_db().research_serp.find(
        {"project_id": pid},
        {
            "_id": 0,
            "project_id": 1,
            "query": 1,
            "gl": 1,
            "hl": 1,
            "fetched_at": 1,
            "results": 1,
            "related_searches": 1,
            "created_at": 1,
        },
    ).sort("fetched_at", -1).limit(lim)
    return [dict(d) for d in cur]


def save_research_ideas_run(run: dict[str, Any]) -> None:
    """
    Persist a research generation run: inputs + structured outputs.

    Used to improve quality over time by feeding previous runs back into the prompt as context.
    """
    r = dict(run or {})
    pid = (r.get("project_id") or "").strip()
    rid = (r.get("id") or "").strip()
    if not pid:
        return
    if _storage_mode != "mongo":
        with _db_write_lock:
            rows = [x for x in _load_json_list("research_ideas_runs.json") if isinstance(x, dict)]
            rows.append(r)
            rows = rows[-2000:]
            _save_json("research_ideas_runs.json", rows)
        return
    doc = dict(r)
    if rid:
        doc["_id"] = rid
    else:
        # Deterministic enough; callers can still pass explicit ids.
        doc["_id"] = f"{pid}:{doc.get('created_at') or ''}:{len(str(doc.get('ideas') or ''))}"
    with _db_write_lock:
        get_db().research_ideas_runs.update_one({"_id": doc["_id"]}, {"$set": doc}, upsert=True)


def load_research_ideas_runs(*, project_id: str, limit: int = 30) -> list[dict[str, Any]]:
    """Load recent research runs (inputs + outputs) for a project."""
    pid = (project_id or "").strip()
    if not pid:
        return []
    lim = max(1, min(int(limit or 30), 120))
    if _storage_mode != "mongo":
        rows = [x for x in _load_json_list("research_ideas_runs.json") if isinstance(x, dict)]
        out = [r for r in rows if (r.get("project_id") or "").strip() == pid]
        out.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
        return out[:lim]
    cur = get_db().research_ideas_runs.find({"project_id": pid}, {"_id": 0}).sort("created_at", -1).limit(lim)
    return [dict(d) for d in cur]


def get_research_cache(*, cache_key: str, max_age_s: int = 6 * 60 * 60) -> dict[str, Any] | None:
    """Fetch a cached research response by key if still fresh."""
    key = (cache_key or "").strip()
    if not key:
        return None
    if _storage_mode != "mongo":
        rows = [x for x in _load_json_list("research_cache.json") if isinstance(x, dict)]
        now = time.time()
        for r in reversed(rows):
            if (r.get("key") or "").strip() != key:
                continue
            try:
                ts = float(r.get("saved_at") or 0.0)
            except Exception:
                ts = 0.0
            if now is not None and max_age_s and ts and (now - ts) > float(max_age_s):
                return None
            val = r.get("value") if isinstance(r.get("value"), dict) else None
            if isinstance(val, dict):
                status = (val.get("status") or "").strip().lower()
                if status in {"queued", "processing"}:
                    return None
            return val
        return None
    doc = get_db().research_cache.find_one({"_id": key})
    if not isinstance(doc, dict):
        return None
    try:
        saved_at = float(doc.get("saved_at") or 0.0)
    except Exception:
        saved_at = 0.0
    if max_age_s and saved_at and (time.time() - saved_at) > float(max_age_s):
        return None
    v = doc.get("value")
    if not isinstance(v, dict):
        return None
    status = (v.get("status") or "").strip().lower()
    if status in {"queued", "processing"}:
        return None
    return v


def set_research_cache(*, cache_key: str, value: dict[str, Any]) -> None:
    """Set cached research response by key."""
    key = (cache_key or "").strip()
    if not key:
        return
    v = dict(value or {})
    now = time.time()
    if _storage_mode != "mongo":
        with _db_write_lock:
            rows = [x for x in _load_json_list("research_cache.json") if isinstance(x, dict)]
            rows.append({"key": key, "saved_at": float(now or 0.0), "value": v})
            rows = rows[-5000:]
            _save_json("research_cache.json", rows)
        return
    # `expires_at` is a real datetime so the research_cache TTL index (P4.5) can purge stale entries.
    doc = {
        "_id": key,
        "saved_at": float(time.time()),
        "expires_at": datetime.utcnow() + timedelta(days=7),
        "value": v,
    }
    with _db_write_lock:
        get_db().research_cache.update_one({"_id": key}, {"$set": doc}, upsert=True)


# ----------------------------
# Scheduled jobs (queue table)
# ----------------------------


def load_scheduled_jobs(
    *,
    project_id: str | None = None,
    article_id: str | None = None,
    state: str | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """
    Load scheduled jobs, optionally filtered.

    Historically this function only filtered by project_id and returned the full list; the editor
    view for a single article now uses `article_id` to avoid scanning all jobs for large projects.
    """
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    st = (state or "").strip().lower()
    lim = int(limit) if isinstance(limit, int) and limit > 0 else None
    if _storage_mode != "mongo":
        rows = [_normalize_scheduled_job_dict(x) for x in _load_json_list("scheduled_jobs.json")]
        out = rows
        if pid:
            out = [r for r in out if (r.get("project_id") or "").strip() == pid]
        if aid:
            out = [r for r in out if (r.get("article_id") or "").strip() == aid]
        if st:
            out = [r for r in out if (r.get("state") or "").strip().lower() == st]
        if lim is not None:
            out = out[:lim]
        return out

    q: dict[str, Any] = {}
    if pid:
        q["project_id"] = pid
    if aid:
        q["article_id"] = aid
    if st:
        q["state"] = st

    cur = get_db().scheduled_jobs.find(q, _SCHEDULED_JOB_LISTING_PROJECTION).sort("run_at", 1)
    if lim is not None:
        cur = cur.limit(lim)
    out: list[dict[str, Any]] = []
    for doc in cur:
        if isinstance(doc, dict):
            d = dict(doc)
            try:
                out.append(_normalize_scheduled_job_dict(d))
            except Exception:
                continue
    return out


def get_scheduled_job_by_id(job_id: str) -> dict[str, Any] | None:
    """Indexed single-document lookup for a scheduled job by its id field."""
    jid = (job_id or "").strip()
    if not jid:
        return None
    if _storage_mode != "mongo":
        rows = [_normalize_scheduled_job_dict(x) for x in _load_json_list("scheduled_jobs.json")]
        return next((r for r in rows if (r.get("id") or "").strip() == jid), None)
    doc = get_db().scheduled_jobs.find_one(
        {"$or": [{"id": jid}, {"_id": jid}]},
        _SCHEDULED_JOB_LISTING_PROJECTION,
    )
    if not doc:
        return None
    return _normalize_scheduled_job_dict(dict(doc))


def get_research_job_status(*, cache_key: str) -> dict[str, Any] | None:
    """Return in-flight research job status (queued/processing) for polling."""
    key = (cache_key or "").strip()
    if not key:
        return None
    if _storage_mode != "mongo":
        rows = [x for x in _load_json_list("research_cache.json") if isinstance(x, dict)]
        for r in reversed(rows):
            if (r.get("key") or "").strip() != key:
                continue
            val = r.get("value") if isinstance(r.get("value"), dict) else None
            if isinstance(val, dict) and (val.get("status") or "").strip().lower() in {"queued", "processing"}:
                return val
            return None
        return None
    doc = get_db().research_cache.find_one({"_id": key}, {"_id": 0, "value": 1})
    if not isinstance(doc, dict):
        return None
    val = doc.get("value")
    if isinstance(val, dict) and (val.get("status") or "").strip().lower() in {"queued", "processing"}:
        return val
    return None


def load_due_scheduled_jobs(
    *,
    due_before_utc_str: str,
    states: list[str] | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """
    Jobs with ``run_at`` on or before ``due_before_utc_str`` (UTC ``YYYY-MM-DD HH:MM:SS``).

    Used by the scheduler loop to avoid scanning the full ``scheduled_jobs`` collection each tick.
    """
    before = (due_before_utc_str or "").strip()
    if not before:
        return []
    states_norm = [
        s.strip().lower()
        for s in (states or ["scheduled", "ready_to_post"])
        if isinstance(s, str) and s.strip()
    ]
    lim = max(1, min(int(limit or 200), 1000))
    if _storage_mode != "mongo":
        rows = [_normalize_scheduled_job_dict(x) for x in _load_json_list("scheduled_jobs.json")]
        out = [
            r
            for r in rows
            if (r.get("run_at") or "").strip() <= before
            and (not states_norm or (r.get("state") or "").strip().lower() in states_norm)
        ]
        out.sort(key=lambda r: (r.get("run_at") or "", r.get("id") or ""))
        return out[:lim]

    q: dict[str, Any] = {"run_at": {"$lte": before}}
    if states_norm:
        q["state"] = {"$in": states_norm}
    cur = get_db().scheduled_jobs.find(q).sort("run_at", 1).limit(lim)
    out: list[dict[str, Any]] = []
    for doc in cur:
        if isinstance(doc, dict):
            d = dict(doc)
            d.pop("_id", None)
            try:
                out.append(_normalize_scheduled_job_dict(d))
            except Exception:
                continue
    return out


def load_scheduled_jobs_due_for_prep(
    *,
    due_before_utc_str: str,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """
    Jobs that should begin background prep: ``state=scheduled`` and ``run_at`` on or before
    ``due_before_utc_str`` (typically now + SCHEDULE_PREP_LEAD_MINUTES).
    """
    before = (due_before_utc_str or "").strip()
    if not before:
        return []
    lim = max(1, min(int(limit or 50), 500))
    if _storage_mode != "mongo":
        rows = [_normalize_scheduled_job_dict(x) for x in _load_json_list("scheduled_jobs.json")]
        out = [
            r
            for r in rows
            if (r.get("state") or "").strip().lower() == "scheduled"
            and (r.get("run_at") or "").strip() <= before
        ]
        out.sort(key=lambda r: (r.get("run_at") or "", r.get("id") or ""))
        return out[:lim]

    q: dict[str, Any] = {"state": "scheduled", "run_at": {"$lte": before}}
    cur = get_db().scheduled_jobs.find(q).sort("run_at", 1).limit(lim)
    out: list[dict[str, Any]] = []
    for doc in cur:
        if isinstance(doc, dict):
            d = dict(doc)
            d.pop("_id", None)
            try:
                out.append(_normalize_scheduled_job_dict(d))
            except Exception:
                continue
    return out


def insert_scheduled_job(job: dict[str, Any]) -> None:
    norm = _normalize_scheduled_job_dict(job)
    if _storage_mode != "mongo":
        with _db_write_lock:
            rows = _load_json_list("scheduled_jobs.json")
            rows.append(norm)
            _save_json_scheduled_jobs(rows)
        return
    doc = {**norm, "_id": norm["id"]}
    with _db_write_lock:
        res = get_db().scheduled_jobs.insert_one(doc)
        if not res.acknowledged:
            raise RuntimeError("MongoDB insert_scheduled_job was not acknowledged")


def update_scheduled_job_fields(job_id: str, updates: dict[str, Any]) -> bool:
    jid = (job_id or "").strip()
    if not jid:
        return False
    if _storage_mode != "mongo":
        with _db_write_lock:
            rows = _load_json_list("scheduled_jobs.json")
            found = False
            for r in rows:
                if isinstance(r, dict) and (r.get("id") or "").strip() == jid:
                    merged = {**r, **updates}
                    merged["id"] = jid
                    rows[rows.index(r)] = _normalize_scheduled_job_dict(merged)
                    found = True
                    break
            if found:
                _save_json_scheduled_jobs([_normalize_scheduled_job_dict(x) for x in rows if isinstance(x, dict)])
            return found
    with _db_write_lock:
        job_filter = {"$or": [{"_id": jid}, {"id": jid}]}
        doc = get_db().scheduled_jobs.find_one(job_filter)
        if not doc:
            return False
        d = dict(doc)
        d.pop("_id", None)
        merged = {**d, **updates, "id": jid}
        norm = _normalize_scheduled_job_dict(merged)
        new_doc = {**norm, "_id": norm["id"]}
        res = get_db().scheduled_jobs.replace_one(job_filter, new_doc)
        return bool(res.acknowledged and res.matched_count == 1)


def patch_scheduled_job_fields(job_id: str, updates: dict[str, Any]) -> bool:
    """Partial update (Mongo ``$set``) — lighter than read-merge-replace for state transitions."""
    jid = (job_id or "").strip()
    if not jid or not updates:
        return False
    ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    u2 = dict(updates)
    u2.setdefault("updated_at", ts)
    if _storage_mode != "mongo":
        return update_scheduled_job_fields(jid, u2)
    with _db_write_lock:
        res = get_db().scheduled_jobs.update_one({"$or": [{"_id": jid}, {"id": jid}]}, {"$set": u2})
        return bool(res.acknowledged and res.matched_count >= 1)


def claim_scheduled_job_for_posting(
    job_id: str,
    allowed_states: list[str],
    *,
    now_str: str | None = None,
    target_state: str = "posting",
) -> bool:
    """
    Atomically transition a scheduled job from any state in ``allowed_states`` to
    ``target_state``.

    Returns True only if this caller won the race (i.e., the row was matched
    AND modified). Returns False otherwise (already claimed by another worker
    or row not found / wrong state).

    Why this exists: when multiple uvicorn workers or background loops run in
    parallel, the read-modify-write performed by ``update_scheduled_job_fields``
    is not safe. Two callers can both observe ``state == "scheduled"`` and both
    proceed to publish the same article to WordPress, producing duplicate posts.

    Mongo path uses ``find_one_and_update`` with a state filter so only one
    caller succeeds. JSON path leans on the global ``_db_write_lock``.
    """
    jid = (job_id or "").strip()
    if not jid:
        return False
    allowed = [str(s).strip().lower() for s in (allowed_states or []) if str(s).strip()]
    if not allowed:
        return False
    target = (target_state or "posting").strip() or "posting"
    stamp = (now_str or datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"))[:64]

    if _storage_mode != "mongo":
        with _db_write_lock:
            rows = _load_json_list("scheduled_jobs.json")
            for i, r in enumerate(rows):
                if not isinstance(r, dict):
                    continue
                if (r.get("id") or "").strip() != jid:
                    continue
                current = (r.get("state") or "").strip().lower()
                if current not in allowed:
                    return False
                merged = {
                    **r,
                    "state": target,
                    "updated_at": stamp,
                    "last_attempt_at": stamp,
                    "attempts": int(r.get("attempts") or 0) + 1,
                    "last_error": "",
                }
                rows[i] = _normalize_scheduled_job_dict(merged)
                _save_json_scheduled_jobs([_normalize_scheduled_job_dict(x) for x in rows if isinstance(x, dict)])
                return True
            return False

    with _db_write_lock:
        res = get_db().scheduled_jobs.find_one_and_update(
            {"_id": jid, "state": {"$in": allowed}},
            {
                "$set": {
                    "state": target,
                    "updated_at": stamp,
                    "last_attempt_at": stamp,
                    "last_error": "",
                },
                "$inc": {"attempts": 1},
            },
        )
        return res is not None


def delete_scheduled_job(job_id: str) -> bool:
    jid = (job_id or "").strip()
    if not jid:
        return False
    if _storage_mode != "mongo":
        with _db_write_lock:
            rows = _load_json_list("scheduled_jobs.json")
            before = len(rows)
            rows = [r for r in rows if isinstance(r, dict) and (r.get("id") or "").strip() != jid]
            if len(rows) == before:
                return False
            _save_json_scheduled_jobs([_normalize_scheduled_job_dict(x) for x in rows if isinstance(x, dict)])
            return True
    with _db_write_lock:
        res = get_db().scheduled_jobs.delete_one({"_id": jid})
        return bool(res.deleted_count == 1)


def delete_scheduled_jobs_for_project(project_id: str, *, exclude_states: list[str] | None = None) -> int:
    """Bulk-delete every scheduled-job row for a project in one operation.

    Returns the number of rows removed. ``exclude_states`` keeps rows whose
    state is in the set (e.g. already ``posted`` jobs).
    """
    pid = (project_id or "").strip()
    if not pid:
        return 0
    skip = {(s or "").strip().lower() for s in (exclude_states or []) if (s or "").strip()}
    if _storage_mode != "mongo":
        with _db_write_lock:
            rows = _load_json_list("scheduled_jobs.json")
            kept: list[dict[str, Any]] = []
            removed = 0
            for r in rows:
                if not isinstance(r, dict):
                    continue
                if (r.get("project_id") or "").strip() == pid and (r.get("state") or "").strip().lower() not in skip:
                    removed += 1
                    continue
                kept.append(r)
            if removed:
                _save_json_scheduled_jobs([_normalize_scheduled_job_dict(x) for x in kept if isinstance(x, dict)])
            return removed
    flt: dict[str, Any] = {"project_id": pid}
    if skip:
        flt["state"] = {"$nin": sorted(skip)}
    with _db_write_lock:
        res = get_db().scheduled_jobs.delete_many(flt)
        return int(res.deleted_count or 0)


def delete_scheduled_jobs_for_article(
    project_id: str, article_id: str, *, exclude_states: list[str] | None = None
) -> int:
    """Bulk-delete scheduled-job rows for one article in a project (single op)."""
    pid = (project_id or "").strip()
    aid = (article_id or "").strip()
    if not pid or not aid:
        return 0
    skip = {(s or "").strip().lower() for s in (exclude_states or []) if (s or "").strip()}
    if _storage_mode != "mongo":
        with _db_write_lock:
            rows = _load_json_list("scheduled_jobs.json")
            kept: list[dict[str, Any]] = []
            removed = 0
            for r in rows:
                if not isinstance(r, dict):
                    continue
                same = (r.get("project_id") or "").strip() == pid and (r.get("article_id") or "").strip() == aid
                if same and (r.get("state") or "").strip().lower() not in skip:
                    removed += 1
                    continue
                kept.append(r)
            if removed:
                _save_json_scheduled_jobs([_normalize_scheduled_job_dict(x) for x in kept if isinstance(x, dict)])
            return removed
    flt: dict[str, Any] = {"project_id": pid, "article_id": aid}
    if skip:
        flt["state"] = {"$nin": sorted(skip)}
    with _db_write_lock:
        res = get_db().scheduled_jobs.delete_many(flt)
        return int(res.deleted_count or 0)


def count_articles_by_project_ids(project_ids: list[str]) -> dict[str, int]:
    """
    Fast counts for a set of project_ids. Uses Mongo aggregation when available.
    Returns {total, pending, draft, published, active}.
    """
    pids = [str(x).strip() for x in (project_ids or []) if str(x).strip()]
    if not pids:
        return {"total": 0, "pending": 0, "draft": 0, "published": 0, "active": 0}
    if _storage_mode != "mongo":
        rows = [_normalize_article_dict(a) for a in _load_json_list("articles.json")]
        pending = draft = published = total = 0
        pid_set = set(pids)
        for a in rows:
            if (a.get("project_id") or "") not in pid_set:
                continue
            total += 1
            st = (a.get("status") or "pending").strip().lower()
            if st == "published":
                published += 1
            elif st == "draft":
                draft += 1
            else:
                pending += 1
        return {"total": total, "pending": pending, "draft": draft, "published": published, "active": pending + draft}

    db = get_db()
    pipeline = [
        {"$match": {"project_id": {"$in": pids}}},
        {"$group": {"_id": {"$ifNull": ["$status", "pending"]}, "n": {"$sum": 1}}},
    ]
    pending = draft = published = total = 0
    try:
        for row in db.articles.aggregate(pipeline, allowDiskUse=False):
            st = str(row.get("_id") or "pending").strip().lower()
            n = int(row.get("n") or 0)
            total += n
            if st == "published":
                published += n
            elif st == "draft":
                draft += n
            else:
                pending += n
    except Exception:
        # Fallback: still avoid loading entire collection; count per status.
        pending = int(db.articles.count_documents({"project_id": {"$in": pids}, "status": {"$nin": ["draft", "published"]}}))
        draft = int(db.articles.count_documents({"project_id": {"$in": pids}, "status": "draft"}))
        published = int(db.articles.count_documents({"project_id": {"$in": pids}, "status": "published"}))
        total = pending + draft + published
    return {"total": total, "pending": pending, "draft": draft, "published": published, "active": pending + draft}


def project_ids_for_owner(user_id: str) -> list[str]:
    """Fast owner -> project ids lookup (Mongo uses indexed query)."""
    uid = (user_id or "").strip()
    if not uid:
        return []
    if _storage_mode != "mongo":
        projs = [_normalize_project_dict(p) for p in _load_json_list("projects.json")]
        ucf = uid.casefold()
        return [
            (p.get("id") or "").strip()
            for p in projs
            if ((p.get("owner_user_id") or "").strip() == uid or (p.get("owner_user_id") or "").strip().casefold() == ucf)
            and (p.get("id") or "").strip()
        ]
    cur = get_db().projects.find(_mongo_owner_user_id_filter(uid), {"_id": 0, "id": 1})
    out: list[str] = []
    for d in cur:
        pid = (d.get("id") or "").strip()
        if pid:
            out.append(pid)
    return out


def save_projects_replace_all(projects: list[dict[str, Any]]) -> None:
    """Replace all projects (import/backup only). Deletes all articles first."""
    with _db_write_lock:
        db = get_db()
        db.articles.delete_many({})
        db.projects.delete_many({})
        if not projects:
            return
        docs = []
        for p in projects:
            norm = _normalize_project_dict(p)
            docs.append({**norm, "_id": norm["id"]})
        res = db.projects.insert_many(docs)
        if not res.acknowledged or len(res.inserted_ids) != len(docs):
            raise RuntimeError("MongoDB save_projects_replace_all insert was not fully acknowledged")


def insert_project(project: dict[str, Any]) -> None:
    norm = _normalize_project_dict(project)
    if _storage_mode != "mongo":
        with _db_write_lock:
            rows = [_normalize_project_dict(dict(p)) for p in _load_json_list("projects.json")]
            if any((x.get("id") or "") == norm["id"] for x in rows):
                raise ValueError("project id already exists")
            rows.append(norm)
            _save_json_projects(rows)
        return
    doc = {**norm, "_id": norm["id"]}
    with _db_write_lock:
        res = get_db().projects.insert_one(doc)
        if not res.acknowledged:
            raise RuntimeError("MongoDB insert_project was not acknowledged")


def update_project_fields(project_id: str, updates: dict[str, Any]) -> bool:
    if _storage_mode != "mongo":
        with _db_write_lock:
            rows = [_normalize_project_dict(dict(p)) for p in _load_json_list("projects.json")]
            idx = next((i for i, x in enumerate(rows) if (x.get("id") or "") == project_id), None)
            if idx is None:
                return False
            d = dict(rows[idx])
            _apply_project_updates_dict(d, updates)
            rows[idx] = _normalize_project_dict(d)
            _save_json_projects(rows)
        return True
    with _db_write_lock:
        db = get_db()
        doc = db.projects.find_one({"id": project_id})
        if not doc:
            return False
        d = _mongo_doc_to_project(doc)
        _apply_project_updates_dict(d, updates)
        norm = _normalize_project_dict(d)
        new_doc = {**norm, "_id": norm["id"]}
        res = db.projects.replace_one({"id": project_id}, new_doc)
        return bool(res.acknowledged and res.matched_count == 1)


def delete_project_and_resources(project_id: str) -> bool:
    """
    Hard-delete a project and all resources that reference it.

    This is intentionally destructive and is used for "Delete project" actions.
    """
    if _storage_mode != "mongo":
        with _db_write_lock:
            projects = [_normalize_project_dict(dict(p)) for p in _load_json_list("projects.json")]
            if not any((p.get("id") or "") == project_id for p in projects):
                return False
            _save_json_projects([p for p in projects if (p.get("id") or "") != project_id])

            articles = [_normalize_article_dict(dict(a)) for a in _load_json_list("articles.json")]
            _save_json_articles([a for a in articles if (a.get("project_id") or "") != project_id])

            # Scheduled jobs are stored separately from the project row.
            jobs = [_normalize_scheduled_job_dict(dict(j)) for j in _load_json_list("scheduled_jobs.json")]
            _save_json_scheduled_jobs([j for j in jobs if (j.get("project_id") or "") != project_id])
        return True

    with _db_write_lock:
        db = get_db()
        if db.projects.count_documents({"id": project_id}, limit=1) == 0:
            return False
        db.articles.delete_many({"project_id": project_id})
        db.scheduled_jobs.delete_many({"project_id": project_id})
        db.projects.delete_one({"id": project_id})
        return True


def delete_project_and_articles(project_id: str) -> bool:
    """
    Backward-compatible wrapper.

    Historically this function deleted only projects + articles. It now deletes all related
    project resources as well (scheduled jobs), which is the desired behavior for the API.
    """
    return delete_project_and_resources(project_id)


def save_articles_replace_all(articles: list[dict[str, Any]]) -> None:
    with _db_write_lock:
        get_db().articles.delete_many({})
    for a in articles:
        insert_article(a)


def insert_article(article: dict[str, Any]) -> None:
    norm = _normalize_article_dict(article)
    doc = {**norm, "_id": norm["id"]}
    with _db_write_lock:
        res = get_db().articles.insert_one(doc)
        if not res.acknowledged:
            raise RuntimeError("MongoDB insert_article was not acknowledged")


def insert_articles_batch(articles: list[dict[str, Any]]) -> None:
    if not articles:
        return
    docs = []
    for a in articles:
        norm = _normalize_article_dict(a)
        docs.append({**norm, "_id": norm["id"]})
    with _db_write_lock:
        res = get_db().articles.insert_many(docs)
        if not res.acknowledged or len(res.inserted_ids) != len(docs):
            raise RuntimeError("MongoDB insert_articles_batch was not fully acknowledged")


def update_article_fields(article_id: str, updates: dict[str, Any]) -> bool:
    ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    u2 = dict(updates or {})
    u2.setdefault("updated_at", ts)
    if _storage_mode != "mongo":
        with _db_write_lock:
            arts = [_normalize_article_dict(dict(a)) for a in _load_json_list("articles.json")]
            idx = next((i for i, x in enumerate(arts) if x.get("id") == article_id), None)
            if idx is None:
                return False
            d = dict(arts[idx])
            _apply_article_updates_dict(d, u2)
            arts[idx] = _normalize_article_dict(d)
            _save_json_articles(arts)
        return True
    with _db_write_lock:
        db = get_db()
        doc = db.articles.find_one({"id": article_id})
        if not doc:
            return False
        d = _mongo_doc_to_article(doc)
        _apply_article_updates_dict(d, u2)
        norm = _normalize_article_dict(d)
        new_doc = {**norm, "_id": norm["id"]}
        res = db.articles.replace_one({"id": article_id}, new_doc)
        return bool(res.acknowledged and res.matched_count == 1)


def patch_article_fields(article_id: str, updates: dict[str, Any]) -> bool:
    """Partial update (Mongo ``$set``) — avoids full-document replace during generation."""
    aid = (article_id or "").strip()
    if not aid or not updates:
        return False
    ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    u2 = dict(updates)
    u2.setdefault("updated_at", ts)
    u2 = _externalize_featured_image_in_updates(aid, u2)
    if _storage_mode != "mongo":
        # JSON path runs through _normalize_article_dict, which recomputes the
        # persisted derived fields automatically.
        return update_article_fields(aid, u2)
    with _db_write_lock:
        db = get_db()
        # Keep the persisted derived fields (P4.3) consistent on a partial $set.
        if "article" in u2:
            u2["has_body"] = bool((u2.get("article") or "").strip())
        if _LISTING_STATUS_AFFECTING_FIELDS & set(u2.keys()):
            proj = {
                "_id": 0,
                "status": 1,
                "wp_last_wp_status": 1,
                "wp_link": 1,
                "wp_post_id": 1,
                "wp_scheduled_at": 1,
                "shopify_link": 1,
                "shopify_article_id": 1,
            }
            cur = db.articles.find_one({"$or": [{"id": aid}, {"_id": aid}]}, proj) or {}
            merged = {**cur, **{k: u2[k] for k in u2 if k in _LISTING_STATUS_AFFECTING_FIELDS}}
            u2["listing_status"] = _derive_article_listing_status(merged)
        res = db.articles.update_one(
            {"$or": [{"id": aid}, {"_id": aid}]},
            {"$set": u2},
        )
        return bool(res.acknowledged and res.matched_count >= 1)


def delete_articles_by_ids(article_ids: list[str]) -> None:
    if not article_ids:
        return
    with _db_write_lock:
        get_db().articles.delete_many({"id": {"$in": article_ids}})


def bulk_update_articles(updates: list[tuple[str, dict[str, Any]]]) -> None:
    if not updates:
        return
    if _storage_mode != "mongo":
        with _db_write_lock:
            arts = [_normalize_article_dict(dict(a)) for a in _load_json_list("articles.json")]
            by_id = {x.get("id"): i for i, x in enumerate(arts) if x.get("id")}
            for aid, u in updates:
                idx = by_id.get(aid)
                if idx is None:
                    _log.warning("bulk_update_articles: missing article id %r in articles.json", aid)
                    continue
                d = dict(arts[idx])
                _apply_article_updates_dict(d, u)
                arts[idx] = _normalize_article_dict(d)
            _save_json_articles(arts)
        return
    ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    with _db_write_lock:
        db = get_db()
        from pymongo import ReplaceOne

        # Batch-read every target doc in a single round-trip instead of one
        # find_one per id (the previous N+1). Behaviour is preserved: each row
        # still goes through _apply_article_updates_dict + _normalize_article_dict.
        ids = [aid for aid, _ in updates if aid]
        docs_by_id: dict[str, dict[str, Any]] = {}
        for doc in db.articles.find({"id": {"$in": ids}}):
            did = (doc.get("id") or "").strip()
            if did:
                docs_by_id[did] = doc

        ops: list[ReplaceOne] = []
        for aid, u in updates:
            doc = docs_by_id.get(aid)
            if not doc:
                _log.warning("bulk_update_articles: missing article id %r in MongoDB", aid)
                continue
            d = _mongo_doc_to_article(doc)
            u2 = dict(u or {})
            u2.setdefault("updated_at", ts)
            _apply_article_updates_dict(d, u2)
            norm = _normalize_article_dict(d)
            ops.append(ReplaceOne({"id": aid}, {**norm, "_id": norm["id"]}))
        if ops:
            res = db.articles.bulk_write(ops, ordered=False)
            if not res.acknowledged:
                raise RuntimeError("MongoDB bulk_update_articles was not acknowledged")


def export_tables_to_json() -> tuple[list[dict], list[dict]]:
    """Snapshot for backup."""
    return load_projects(), load_articles()


# ===========================================================================
# Feature foundations (v1 schema — see docstrings for spec)
# ===========================================================================
#
# These three collections back the new "Undefeated" features. They share a
# uniform shape: project-scoped, opaque ``id`` per row, and each row stores its
# own ``created_at`` / ``updated_at`` for auditability.
#
# - ``site_maps``        — Feature 3 (Automated Internal Linking)
# - ``topic_clusters``   — Feature 2 (Topical Authority Cluster Mapping)
# - ``content_monitors`` — Feature 4 (Rank Monitoring & Smart Refresh)
#
# They keep the "JSON fallback" code path for parity with the rest of the
# module so dev-without-mongo and tests still work.


def _now_iso_seconds() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------------------
# site_maps  (Feature 3 — Internal Linking)
# ---------------------------------------------------------------------------


def _normalize_site_map_entry(d: dict[str, Any]) -> dict[str, Any]:
    """One row per WordPress post mirrored into Riviso for internal-link matching."""
    pid = (d.get("project_id") or "").strip()
    url = (d.get("post_url") or "").strip()
    if not pid or not url:
        raise ValueError("site_map entry requires project_id and post_url")
    keywords = d.get("focus_keywords") or []
    if not isinstance(keywords, list):
        keywords = []
    keywords_clean = [str(k).strip()[:120] for k in keywords if str(k).strip()][:20]
    return {
        "id": (d.get("id") or "").strip() or f"sm_{pid[:8]}_{url[-32:]}",
        "project_id": pid,
        "post_url": url[:2048],
        "post_title": (d.get("post_title") or "")[:500],
        "focus_keyphrase": (d.get("focus_keyphrase") or "")[:200],
        "focus_keywords": keywords_clean,
        "post_id": str(d.get("post_id") or "")[:64],
        "post_modified_at": (d.get("post_modified_at") or "")[:64],
        "featured_image_url": (d.get("featured_image_url") or "")[:4000],
        "fetched_at": (d.get("fetched_at") or _now_iso_seconds())[:64],
    }


def replace_site_map_for_project(project_id: str, entries: list[dict[str, Any]]) -> int:
    """
    Replace the project's site map with ``entries`` (atomic from the API caller's POV).

    Used by :class:`InternalLinkService.sync_site_map_from_wp`. Returns the number of rows written.
    """
    pid = (project_id or "").strip()
    if not pid:
        raise ValueError("project_id is required")
    rows = [_normalize_site_map_entry({**e, "project_id": pid}) for e in (entries or []) if isinstance(e, dict)]
    if _storage_mode != "mongo":
        existing = _load_json_list("site_maps.json")
        kept = [r for r in existing if (r.get("project_id") or "") != pid]
        with _db_write_lock:
            with open(_data_path("site_maps.json"), "w", encoding="utf-8") as f:
                json.dump(kept + rows, f, indent=2)
        return len(rows)
    db = get_db()
    with _db_write_lock:
        db.site_maps.delete_many({"project_id": pid})
        if rows:
            db.site_maps.insert_many([{**r, "_id": r["id"]} for r in rows])
    return len(rows)


def load_site_map_for_project(project_id: str, *, limit: int = 5000) -> list[dict[str, Any]]:
    """Read the site map; only fields needed for matching are returned."""
    pid = (project_id or "").strip()
    if not pid:
        return []
    lim = max(1, min(int(limit or 5000), 20000))
    if _storage_mode != "mongo":
        rows = [r for r in _load_json_list("site_maps.json") if (r.get("project_id") or "") == pid]
        return rows[:lim]
    cur = (
        get_db()
        .site_maps.find({"project_id": pid}, {"_id": 0})
        .sort("post_modified_at", -1)
        .limit(lim)
    )
    return list(cur)


def site_map_cache_age_seconds(project_id: str) -> int | None:
    """
    Return how old the *freshest* site-map row for ``project_id`` is, in seconds.

    Used by the cluster-validation service to decide whether to fire a background
    WordPress refetch (24h staleness window). Returns ``None`` when the project
    has no site map cached at all (caller treats that as "infinitely stale").
    """
    pid = (project_id or "").strip()
    if not pid:
        return None
    rows = load_site_map_for_project(pid, limit=1)
    if not rows:
        return None
    raw = (rows[0].get("fetched_at") or "").strip()
    if not raw:
        return None
    # ``fetched_at`` is stored as ``YYYY-MM-DD HH:MM:SS`` (UTC) by ``_now_iso_seconds``.
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            ts = datetime.strptime(raw[:19], fmt)
        except ValueError:
            continue
        delta = datetime.utcnow() - ts
        return max(0, int(delta.total_seconds()))
    return None


# ---------------------------------------------------------------------------
# topic_clusters  (Feature 2 — Topical Authority Cluster Mapping)
# ---------------------------------------------------------------------------


def _normalize_topic_cluster(d: dict[str, Any]) -> dict[str, Any]:
    cid = (d.get("id") or "").strip()
    pid = (d.get("project_id") or "").strip()
    uid = (d.get("owner_user_id") or "").strip()
    if not cid or not pid:
        raise ValueError("topic_cluster requires id and project_id")
    pillar = d.get("pillar") or {}
    if not isinstance(pillar, dict):
        pillar = {}
    clusters = d.get("clusters") or []
    if not isinstance(clusters, list):
        clusters = []
    clusters_clean: list[dict[str, Any]] = []
    for c in clusters:
        if not isinstance(c, dict):
            continue
        clusters_clean.append(
            {
                "id": (c.get("id") or "").strip()[:64],
                "title": (c.get("title") or "")[:300],
                "intent": (c.get("intent") or "")[:80],
                "keywords": [str(k).strip()[:120] for k in (c.get("keywords") or []) if str(k).strip()][:10],
                "imported_article_id": (c.get("imported_article_id") or "")[:64],
            }
        )
    serp_summary = d.get("serp_summary")
    if not isinstance(serp_summary, dict):
        serp_summary = {}
    serp_out: dict[str, Any] = {
        "query": str(serp_summary.get("query") or "")[:200],
        "gl": str(serp_summary.get("gl") or "")[:8],
        "hl": str(serp_summary.get("hl") or "")[:8],
        "fetched_at": float(serp_summary.get("fetched_at") or 0) or 0.0,
        "result_count": int(serp_summary.get("result_count") or 0),
        "results": [],
    }
    for r in (serp_summary.get("results") or [])[:10]:
        if not isinstance(r, dict):
            continue
        serp_out["results"].append(
            {
                "title": str(r.get("title") or "")[:200],
                "url": str(r.get("url") or "")[:2048],
                "snippet": str(r.get("snippet") or "")[:400],
            }
        )
    gen_err_in = d.get("generation_errors") or []
    gen_err_out: list[dict[str, str]] = []
    if isinstance(gen_err_in, list):
        for e in gen_err_in[:12]:
            if not isinstance(e, dict):
                continue
            gen_err_out.append(
                {
                    "topic_id": str(e.get("topic_id") or "")[:64],
                    "message": str(e.get("message") or "")[:500],
                }
            )

    base = {
        "id": cid,
        "project_id": pid,
        "owner_user_id": uid,
        "seed_intent": (d.get("seed_intent") or "")[:500],
        "country_code": (d.get("country_code") or "IN")[:8],
        "tone": (d.get("tone") or "informative")[:32],
        "status": (d.get("status") or "draft")[:32],  # draft|generating|ready|imported
        "pillar": {
            "id": (pillar.get("id") or "").strip()[:64],
            "title": (pillar.get("title") or "")[:300],
            "intent": (pillar.get("intent") or "")[:80],
            "keywords": [str(k).strip()[:120] for k in (pillar.get("keywords") or []) if str(k).strip()][:10],
            "outline": list(pillar.get("outline") or [])[:20],
            "imported_article_id": (pillar.get("imported_article_id") or "")[:64],
        },
        "clusters": clusters_clean[:8],
        "created_at": (d.get("created_at") or _now_iso_seconds())[:64],
        "updated_at": (d.get("updated_at") or _now_iso_seconds())[:64],
        "serp_summary": serp_out,
        "generation_errors": gen_err_out,
    }
    return base


def save_topic_cluster(cluster: dict[str, Any]) -> dict[str, Any]:
    norm = _normalize_topic_cluster(cluster)
    if _storage_mode != "mongo":
        existing = _load_json_list("topic_clusters.json")
        existing = [r for r in existing if (r.get("id") or "") != norm["id"]]
        existing.append(norm)
        with _db_write_lock:
            with open(_data_path("topic_clusters.json"), "w", encoding="utf-8") as f:
                json.dump(existing, f, indent=2)
        return norm
    with _db_write_lock:
        get_db().topic_clusters.replace_one({"_id": norm["id"]}, {**norm, "_id": norm["id"]}, upsert=True)
    return norm


def list_topic_clusters_for_project(project_id: str, *, limit: int = 100) -> list[dict[str, Any]]:
    pid = (project_id or "").strip()
    if not pid:
        return []
    lim = max(1, min(int(limit or 100), 500))
    if _storage_mode != "mongo":
        rows = [r for r in _load_json_list("topic_clusters.json") if (r.get("project_id") or "") == pid]
        rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
        return rows[:lim]
    cur = (
        get_db()
        .topic_clusters.find({"project_id": pid}, {"_id": 0})
        .sort("created_at", -1)
        .limit(lim)
    )
    return list(cur)


def get_topic_cluster_by_id(cluster_id: str) -> dict[str, Any] | None:
    cid = (cluster_id or "").strip()
    if not cid:
        return None
    if _storage_mode != "mongo":
        for r in _load_json_list("topic_clusters.json"):
            if (r.get("id") or "") == cid:
                return r
        return None
    doc = get_db().topic_clusters.find_one({"_id": cid}, {"_id": 0})
    return doc if isinstance(doc, dict) else None


def update_topic_cluster_fields(cluster_id: str, updates: dict[str, Any]) -> bool:
    cid = (cluster_id or "").strip()
    if not cid or not isinstance(updates, dict) or not updates:
        return False
    updates = {**updates, "updated_at": _now_iso_seconds()}
    if _storage_mode != "mongo":
        rows = _load_json_list("topic_clusters.json")
        changed = False
        for r in rows:
            if (r.get("id") or "") == cid:
                r.update(updates)
                changed = True
        if changed:
            with _db_write_lock:
                with open(_data_path("topic_clusters.json"), "w", encoding="utf-8") as f:
                    json.dump(rows, f, indent=2)
        return changed
    with _db_write_lock:
        res = get_db().topic_clusters.update_one({"_id": cid}, {"$set": updates})
    return bool(res.matched_count)


# ---------------------------------------------------------------------------
# content_monitors  (Feature 4 — Rank Monitoring & Smart Refresh)
# ---------------------------------------------------------------------------


def _normalize_content_monitor(d: dict[str, Any]) -> dict[str, Any]:
    pid = (d.get("project_id") or "").strip()
    aid = (d.get("article_id") or "").strip()
    if not pid or not aid:
        raise ValueError("content_monitor requires project_id and article_id")
    return {
        # One monitor per article — easy to upsert by article_id.
        "id": aid,
        "project_id": pid,
        "article_id": aid,
        "url": (d.get("url") or "")[:2048],
        "status": (d.get("status") or "")[:16],  # fresh | stale | unknown | ""
        "score": str(d.get("score") or "")[:32],
        "signature": (d.get("signature") or "")[:512],
        "last_checked_at": (d.get("last_checked_at") or "")[:64],
        "next_check_at": (d.get("next_check_at") or "")[:64],
        "created_at": (d.get("created_at") or _now_iso_seconds())[:64],
        "updated_at": _now_iso_seconds()[:64],
    }


def upsert_content_monitor(monitor: dict[str, Any]) -> dict[str, Any]:
    norm = _normalize_content_monitor(monitor)
    if _storage_mode != "mongo":
        rows = _load_json_list("content_monitors.json")
        rows = [r for r in rows if (r.get("article_id") or "") != norm["article_id"]]
        rows.append(norm)
        with _db_write_lock:
            with open(_data_path("content_monitors.json"), "w", encoding="utf-8") as f:
                json.dump(rows, f, indent=2)
        return norm
    with _db_write_lock:
        get_db().content_monitors.replace_one({"_id": norm["id"]}, {**norm, "_id": norm["id"]}, upsert=True)
    return norm


def list_content_monitors_for_project(project_id: str, *, status: str | None = None) -> list[dict[str, Any]]:
    pid = (project_id or "").strip()
    if not pid:
        return []
    if _storage_mode != "mongo":
        rows = [r for r in _load_json_list("content_monitors.json") if (r.get("project_id") or "") == pid]
        if status:
            rows = [r for r in rows if (r.get("status") or "") == status]
        return rows
    q: dict[str, Any] = {"project_id": pid}
    if status:
        q["status"] = status
    cur = get_db().content_monitors.find(q, {"_id": 0}).sort("updated_at", -1)
    return list(cur)


def list_due_content_monitors(*, before_iso: str, limit: int = 200) -> list[dict[str, Any]]:
    """Used by the scheduler sweep: returns monitors whose ``next_check_at`` <= ``before_iso``."""
    cutoff = (before_iso or "").strip()
    if not cutoff:
        return []
    lim = max(1, min(int(limit or 200), 1000))
    if _storage_mode != "mongo":
        rows = [
            r
            for r in _load_json_list("content_monitors.json")
            if (r.get("next_check_at") or "") and r["next_check_at"] <= cutoff
        ]
        rows.sort(key=lambda r: r.get("next_check_at") or "")
        return rows[:lim]
    cur = (
        get_db()
        .content_monitors.find({"next_check_at": {"$lte": cutoff}}, {"_id": 0})
        .sort("next_check_at", 1)
        .limit(lim)
    )
    return list(cur)


# ---------------------------------------------------------------------------
# shopify_products  (per-project Shopify catalog rows)
# ---------------------------------------------------------------------------


def _coerce_shopify_product_id(raw: Any) -> int | None:
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _normalize_shopify_product_row(
    *,
    project_id: str,
    summary: dict[str, Any],
    synced_at: str,
) -> dict[str, Any] | None:
    """Map sync summary or storage doc to a normalized shopify_products document."""
    pid = (project_id or "").strip()
    spid = _coerce_shopify_product_id(summary.get("shopify_product_id") if "shopify_product_id" in summary else summary.get("id"))
    if not pid or spid is None:
        return None
    title = str(summary.get("title") or "").strip()[:500]
    handle = str(summary.get("handle") or "").strip()[:256]
    if not title or not handle:
        return None
    image = str(
        summary.get("featured_image_url")
        or summary.get("image_url")
        or ""
    ).strip()[:4000]
    return {
        "project_id": pid,
        "shopify_product_id": spid,
        "title": title,
        "handle": handle,
        "featured_image_url": image,
        "status": str(summary.get("status") or "").strip()[:32],
        "tags": str(summary.get("tags") or "").strip()[:2000],
        "price": str(summary.get("price") or "").strip()[:64],
        "product_type": str(summary.get("product_type") or "").strip()[:256],
        "vendor": str(summary.get("vendor") or "").strip()[:256],
        "updated_at": str(summary.get("updated_at") or "").strip()[:64],
        "updatedAt": synced_at,
    }


def _shopify_product_doc_to_catalog_row(doc: dict[str, Any]) -> dict[str, Any]:
    """API / catalog list shape expected by the frontend."""
    return {
        "id": doc.get("shopify_product_id"),
        "title": doc.get("title") or "",
        "handle": doc.get("handle") or "",
        "product_type": doc.get("product_type") or "",
        "vendor": doc.get("vendor") or "",
        "status": doc.get("status") or "",
        "tags": doc.get("tags") or "",
        "image_url": doc.get("featured_image_url") or "",
        "price": doc.get("price") or "",
        "updated_at": doc.get("updated_at") or "",
    }


def upsert_shopify_products_bulk(project_id: str, products: list[dict[str, Any]]) -> int:
    """
    Upsert synced product rows into ``shopify_products`` and remove stale rows for the project.
    Returns the number of products written.
    """
    pid = (project_id or "").strip()
    if not pid:
        return 0
    synced_at = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    rows: list[dict[str, Any]] = []
    synced_ids: list[int] = []
    for raw in products or []:
        if not isinstance(raw, dict):
            continue
        norm = _normalize_shopify_product_row(project_id=pid, summary=raw, synced_at=synced_at)
        if not norm:
            continue
        rows.append(norm)
        synced_ids.append(int(norm["shopify_product_id"]))

    if _storage_mode != "mongo":
        with _db_write_lock:
            existing = [
                r
                for r in _load_json_list("shopify_products.json")
                if isinstance(r, dict) and (r.get("project_id") or "").strip() != pid
            ]
            existing.extend(rows)
            with open(_data_path("shopify_products.json"), "w", encoding="utf-8") as f:
                json.dump(existing, f, indent=2)
        return len(rows)

    from pymongo import UpdateOne

    with _db_write_lock:
        db = get_db()
        ops: list[UpdateOne] = []
        for norm in rows:
            spid = norm["shopify_product_id"]
            filt = {"project_id": pid, "shopify_product_id": spid}
            ops.append(
                UpdateOne(
                    filt,
                    {"$set": norm},
                    upsert=True,
                )
            )
        if ops:
            db.shopify_products.bulk_write(ops, ordered=False)
        if synced_ids:
            db.shopify_products.delete_many(
                {"project_id": pid, "shopify_product_id": {"$nin": synced_ids}},
            )
        elif rows == []:
            db.shopify_products.delete_many({"project_id": pid})
    return len(rows)


def list_shopify_products(
    project_id: str,
    *,
    status: str | None = None,
    limit: int = 500,
) -> list[dict[str, Any]]:
    """List catalog rows for API responses (legacy ``products[]`` shape)."""
    pid = (project_id or "").strip()
    if not pid:
        return []
    lim = max(1, min(int(limit or 500), 500))
    status_f = (status or "").strip().lower()

    if _storage_mode != "mongo":
        rows = [
            r
            for r in _load_json_list("shopify_products.json")
            if isinstance(r, dict) and (r.get("project_id") or "").strip() == pid
        ]
        if status_f:
            rows = [r for r in rows if str(r.get("status") or "").strip().lower() == status_f]
        rows.sort(key=lambda r: (r.get("title") or "").lower())
        return [_shopify_product_doc_to_catalog_row(r) for r in rows[:lim]]

    q: dict[str, Any] = {"project_id": pid}
    if status_f:
        q["status"] = status_f
    cur = (
        get_db()
        .shopify_products.find(q, {"_id": 0})
        .sort("title", 1)
        .limit(lim)
    )
    return [_shopify_product_doc_to_catalog_row(doc) for doc in cur if isinstance(doc, dict)]


def count_shopify_products(project_id: str) -> int:
    pid = (project_id or "").strip()
    if not pid:
        return 0
    if _storage_mode != "mongo":
        return len(
            [
                r
                for r in _load_json_list("shopify_products.json")
                if isinstance(r, dict) and (r.get("project_id") or "").strip() == pid
            ]
        )
    return int(get_db().shopify_products.count_documents({"project_id": pid}))


def delete_shopify_products_for_project(project_id: str) -> int:
    pid = (project_id or "").strip()
    if not pid:
        return 0
    if _storage_mode != "mongo":
        with _db_write_lock:
            rows = _load_json_list("shopify_products.json")
            kept = [r for r in rows if isinstance(r, dict) and (r.get("project_id") or "").strip() != pid]
            removed = len(rows) - len(kept)
            if removed:
                with open(_data_path("shopify_products.json"), "w", encoding="utf-8") as f:
                    json.dump(kept, f, indent=2)
            return removed
    with _db_write_lock:
        res = get_db().shopify_products.delete_many({"project_id": pid})
    return int(res.deleted_count or 0)


def init_storage() -> None:
    global _storage_mode, _storage_init_error
    force_json = (os.environ.get("FORCE_JSON_STORAGE") or "").strip().lower() in {"1", "true", "yes", "on"}
    require_mongo = (os.environ.get("REQUIRE_MONGO") or "").strip().lower() in {"1", "true", "yes", "on"}
    if force_json:
        _storage_mode = "json"
        _storage_init_error = "FORCE_JSON_STORAGE enabled"
        return
    try:
        init_db()
        # Ensure we can actually read from PRIMARY; Atlas issues can allow ping on a node
        # while PRIMARY is unavailable (ReplicaSetNoPrimary), which would break app reads.
        try:
            get_db().users.find_one({}, {"_id": 1})
        except Exception as e:
            raise RuntimeError(f"Mongo primary not available: {e}") from e
        _storage_mode = "mongo"
        _storage_init_error = None
    except Exception as e:
        if require_mongo:
            # When operators expect live Atlas data, failing open into JSON mode hides the real issue
            # (IP allowlist / DNS / TLS interception). Crash early so the deployment is obviously broken.
            raise
        _storage_mode = "json"
        _storage_init_error = str(e)
