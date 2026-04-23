"""MongoDB-backed persistence.

All project/article data is read and written here only (MongoDB is the source of truth).
Do not load or save `data/projects.json` / `data/articles.json` from app routes — use
`scripts/import_json_to_db.py` or opt-in startup import via AUTO_IMPORT_JSON=1.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import date, datetime
from typing import Any

from database import get_db, init_db

_log = logging.getLogger(__name__)

_db_write_lock = threading.Lock()
_storage_mode: str = "mongo"  # "mongo" | "json"
_storage_init_error: str | None = None


def _data_path(filename: str) -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, "data", filename)


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
        "subscription_type": (u.get("subscription_type") or "beta").strip().lower(),
        "last_activity_at": (u.get("last_activity_at") or "").strip(),
        "usage_daily_articles_date": (u.get("usage_daily_articles_date") or "").strip(),
        "usage_daily_articles_count": int(u.get("usage_daily_articles_count") or 0),
        "usage_monthly_articles_month": (u.get("usage_monthly_articles_month") or "").strip(),
        "usage_monthly_articles_count": int(u.get("usage_monthly_articles_count") or 0),
        "created_at": (u.get("created_at") or "").strip(),
        "pending_product_tour": bool(u.get("pending_product_tour", False)),
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


def _normalize_project_dict(d: dict[str, Any]) -> dict[str, Any]:
    pid = (d.get("id") or "").strip()
    if not pid:
        raise ValueError("project id is required")
    return {
        "id": pid,
        "owner_user_id": _coerce_user_id_str(d.get("owner_user_id")),
        "name": (d.get("name") or "")[:500],
        "website_url": (d.get("website_url") or "")[:2048],
        "wp_site_url": (d.get("wp_site_url") or "")[:2048] or "",
        "wp_username": (d.get("wp_username") or "")[:500],
        "wp_app_password": (d.get("wp_app_password") or "")[:500],
        "wp_category_ids": (d.get("wp_category_ids") or "")[:500],
        "prompts": list(d.get("prompts") or []),
        "default_prompt_id": (d.get("default_prompt_id") or "").strip(),
        "image_prompts": list(d.get("image_prompts") or []),
        "default_image_prompt_id": (d.get("default_image_prompt_id") or "").strip(),
        "image_style": (d.get("image_style") or "semi_real")[:32],
        "optimize_image_prompt": bool(d.get("optimize_image_prompt", True)),
        "context_links": list(d.get("context_links") or []),
        "gsc_property_url": (d.get("gsc_property_url") or "")[:2048],
        "gsc_index_on_publish": bool(d.get("gsc_index_on_publish", True)),
        "default_wp_rest_base": (d.get("default_wp_rest_base") or "")[:200],
        "default_wp_status": (d.get("default_wp_status") or "")[:32],
        "created_at": (d.get("created_at") or "")[:64],
    }


def _normalize_user_dict(d: dict[str, Any]) -> dict[str, Any]:
    uid = (d.get("id") or "").strip()
    if not uid:
        raise ValueError("user id is required")
    email = (d.get("email") or "").strip().lower()
    if not email:
        raise ValueError("user email is required")
    return {
        "id": uid,
        "email": email[:500],
        "password_hash": (d.get("password_hash") or "").strip(),
        "role": ((d.get("role") or "user").strip().lower()[:32]) or "user",
        "full_name": (d.get("full_name") or "").strip()[:200],
        "phone": (d.get("phone") or "").strip()[:64],
        "subscription_type": ((d.get("subscription_type") or "beta").strip().lower()[:64]) or "beta",
        "last_activity_at": (d.get("last_activity_at") or "").strip()[:64],
        "usage_daily_articles_date": (d.get("usage_daily_articles_date") or "").strip()[:16],
        "usage_daily_articles_count": int(d.get("usage_daily_articles_count") or 0),
        "usage_monthly_articles_month": (d.get("usage_monthly_articles_month") or "").strip()[:16],
        "usage_monthly_articles_count": int(d.get("usage_monthly_articles_count") or 0),
        "created_at": (d.get("created_at") or "")[:64],
        "pending_product_tour": bool(d.get("pending_product_tour", False)),
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
                "subscription_type": (doc.get("subscription_type") or "beta").strip().lower(),
                "last_activity_at": (doc.get("last_activity_at") or "").strip(),
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


def _plans_json_path() -> str:
    return _data_path("plans.json")


def _default_plans() -> dict[str, Any]:
    return {
        "beta": {
            "name": "Beta Plan",
            "max_projects": 2,
            "max_articles": 5,
            "max_articles_per_day": 0,
            "max_articles_per_month": 0,
            "max_writing_prompts": 1,
            "writing_prompt_char_limit": 4000,
            "max_image_prompts": 1,
            "image_prompt_char_limit": 2000,
            "allow_scheduling": True,
            "allow_export": True,
            "allow_bulk_upload": True,
        }
    }


def load_plans() -> dict[str, Any]:
    """Return dict of plan_key -> plan data."""
    if _storage_mode == "json":
        path = _plans_json_path()
        try:
            with open(path, encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict) and raw:
                return raw
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
    for doc in cur:
        key = (doc.get("key") or doc.get("id") or "").strip().lower()
        if not key:
            continue
        d = dict(doc)
        d.pop("_id", None)
        d.pop("id", None)
        d["key"] = key
        out[key] = d
    if not out:
        # Seed defaults
        for k, v in _default_plans().items():
            upsert_plan(k, v)
        return load_plans()
    return out


def upsert_plan(plan_key: str, plan: dict[str, Any]) -> None:
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
        plans[key] = payload
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(plans, f, indent=2, ensure_ascii=False)
            f.write("\n")
        return
    if _storage_mode != "mongo":
        return
    with _db_write_lock:
        doc = {**payload, "_id": key}
        get_db().plans.replace_one({"_id": key}, doc, upsert=True)


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
    doc = get_db().users.find_one({"id": uid})
    if not doc:
        return None
    return {
        "id": (doc.get("id") or "").strip(),
        "email": (doc.get("email") or "").strip(),
        "password_hash": (doc.get("password_hash") or "").strip(),
        "role": (doc.get("role") or "user").strip().lower(),
        "full_name": (doc.get("full_name") or "").strip(),
        "phone": (doc.get("phone") or "").strip(),
        "subscription_type": (doc.get("subscription_type") or "beta").strip().lower(),
        "last_activity_at": (doc.get("last_activity_at") or "").strip(),
        "usage_daily_articles_date": (doc.get("usage_daily_articles_date") or "").strip(),
        "usage_daily_articles_count": int(doc.get("usage_daily_articles_count") or 0),
        "usage_monthly_articles_month": (doc.get("usage_monthly_articles_month") or "").strip(),
        "usage_monthly_articles_count": int(doc.get("usage_monthly_articles_count") or 0),
        "created_at": (doc.get("created_at") or "").strip(),
        "pending_product_tour": bool(doc.get("pending_product_tour", False)),
    }


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
        "subscription_type": (doc.get("subscription_type") or "beta").strip().lower(),
        "last_activity_at": (doc.get("last_activity_at") or "").strip(),
        "usage_daily_articles_date": (doc.get("usage_daily_articles_date") or "").strip(),
        "usage_daily_articles_count": int(doc.get("usage_daily_articles_count") or 0),
        "usage_monthly_articles_month": (doc.get("usage_monthly_articles_month") or "").strip(),
        "usage_monthly_articles_count": int(doc.get("usage_monthly_articles_count") or 0),
        "created_at": (doc.get("created_at") or "").strip(),
        "pending_product_tour": bool(doc.get("pending_product_tour", False)),
    }


def insert_user(user: dict[str, Any]) -> None:
    norm = _normalize_user_dict(user)
    if _storage_mode == "json":
        with _db_write_lock:
            users = _load_json_users()
            if any((u.get("email") or "").strip().lower() == norm["email"] for u in users):
                raise ValueError("email already registered")
            users.append(norm)
            _save_json_users(users)
        return
    if _storage_mode != "mongo":
        raise RuntimeError("User storage requires MongoDB or JSON fallback")
    doc = {**norm, "_id": norm["id"]}
    with _db_write_lock:
        res = get_db().users.insert_one(doc)
        if not res.acknowledged:
            raise RuntimeError("MongoDB insert_user was not acknowledged")


def delete_user(user_id: str) -> bool:
    """Remove a user row only. Caller must delete owned projects and articles first."""
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


def _coerce_wp_scheduled_at_str(v: Any, max_len: int = 64) -> str:
    """MongoDB may store schedule times as BSON Date; app code expects YYYY-mm-dd HH:MM:SS strings."""
    if v is None or v == "":
        return ""
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d %H:%M:%S")[:max_len]
    if isinstance(v, date) and not isinstance(v, datetime):
        return v.isoformat()[:max_len]
    return str(v).strip()[:max_len]


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
        "keywords": list(d.get("keywords") or []),
        "status": (d.get("status") or "pending")[:32],
        "article": d.get("article") or "",
        "focus_keyphrase": (d.get("focus_keyphrase") or "")[:500],
        "meta_title": (d.get("meta_title") or "")[:500],
        "meta_description": (d.get("meta_description") or "")[:2000],
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
        "wp_post_id": wp_id,
        "wp_link": (d.get("wp_link") or "")[:2048],
        "wp_rest_base": (d.get("wp_rest_base") or "")[:200],
        "wp_last_wp_status": (d.get("wp_last_wp_status") or "")[:32],
        "wp_scheduled_at": _coerce_wp_scheduled_at_str(d.get("wp_scheduled_at")),
        "wp_schedule_wp_status": (d.get("wp_schedule_wp_status") or "")[:32],
        "wp_schedule_error": d.get("wp_schedule_error") or "",
        "wp_schedule_batch_id": (d.get("wp_schedule_batch_id") or "")[:36],
        "wp_schedule_batch_index": str(d.get("wp_schedule_batch_index") or "")[:32],
        "wp_schedule_batch_total": str(d.get("wp_schedule_batch_total") or "")[:32],
        "gsc_status": (d.get("gsc_status") or "pending")[:32],
    }


def _apply_project_updates_dict(p: dict[str, Any], updates: dict[str, Any]) -> None:
    for k, v in updates.items():
        if k == "prompts":
            p["prompts"] = v
        elif k == "image_prompts":
            p["image_prompts"] = v
        elif k == "context_links":
            p["context_links"] = v
        elif k in p or k in (
            "id",
            "name",
            "website_url",
            "wp_site_url",
            "wp_username",
            "wp_app_password",
            "wp_category_ids",
            "default_prompt_id",
            "default_image_prompt_id",
            "image_style",
            "optimize_image_prompt",
            "gsc_property_url",
            "gsc_index_on_publish",
            "default_wp_rest_base",
            "default_wp_status",
            "created_at",
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
        elif k in a or k in (
            "id",
            "project_id",
            "title",
            "status",
            "article",
            "focus_keyphrase",
            "meta_title",
            "meta_description",
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
            "wp_link",
            "wp_rest_base",
            "wp_last_wp_status",
            "wp_scheduled_at",
            "wp_schedule_wp_status",
            "wp_schedule_error",
            "wp_schedule_batch_id",
            "gsc_status",
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
        "wp_site_url": d.get("wp_site_url") or "",
        "wp_username": d.get("wp_username") or "",
        "wp_app_password": d.get("wp_app_password") or "",
        "wp_category_ids": d.get("wp_category_ids") or "",
        "prompts": list(d.get("prompts") or []),
        "default_prompt_id": d.get("default_prompt_id") or "",
        "image_prompts": list(d.get("image_prompts") or []),
        "default_image_prompt_id": d.get("default_image_prompt_id") or "",
        "image_style": d.get("image_style") or "semi_real",
        "optimize_image_prompt": bool(d.get("optimize_image_prompt", True)),
        "context_links": list(d.get("context_links") or []),
        "gsc_property_url": d.get("gsc_property_url") or "",
        "gsc_index_on_publish": bool(d.get("gsc_index_on_publish", True)),
        "default_wp_rest_base": d.get("default_wp_rest_base") or "",
        "default_wp_status": d.get("default_wp_status") or "",
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
        "keywords": list(d.get("keywords") or []),
        "status": d.get("status") or "pending",
        "article": d.get("article") or "",
        "focus_keyphrase": d.get("focus_keyphrase") or "",
        "meta_title": d.get("meta_title") or "",
        "meta_description": d.get("meta_description") or "",
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
        "wp_scheduled_at": _coerce_wp_scheduled_at_str(d.get("wp_scheduled_at")),
        "wp_schedule_wp_status": d.get("wp_schedule_wp_status") or "",
        "wp_schedule_error": d.get("wp_schedule_error") or "",
        "wp_schedule_batch_id": d.get("wp_schedule_batch_id") or "",
        "wp_schedule_batch_index": d.get("wp_schedule_batch_index") or "",
        "wp_schedule_batch_total": d.get("wp_schedule_batch_total") or "",
        "gsc_status": d.get("gsc_status") or "pending",
    }


def load_projects() -> list[dict[str, Any]]:
    if _storage_mode != "mongo":
        return [_normalize_project_dict(p) for p in _load_json_list("projects.json")]
    db = get_db()
    cur = db.projects.find({}).sort("created_at", 1)
    return [_mongo_doc_to_project(doc) for doc in cur]


def load_articles() -> list[dict[str, Any]]:
    if _storage_mode != "mongo":
        return [_normalize_article_dict(a) for a in _load_json_list("articles.json")]
    db = get_db()
    return [_mongo_doc_to_article(doc) for doc in db.articles.find({})]


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
        "article": 1,
    }
    lim = max(1, min(int(limit or 200), 1000))
    cur = get_db().articles.find(q, proj).sort("wp_scheduled_at", 1).limit(lim)
    return [dict(d) for d in cur]


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
                "_id": 0,
                "id": 1,
                "project_id": 1,
                "title": 1,
                "keywords": 1,
                "status": 1,
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
                "hasBody": {"$gt": [{"$strLenCP": {"$ifNull": ["$article", ""]}}, 0]},
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
        return [(p.get("id") or "").strip() for p in projs if (p.get("owner_user_id") or "").strip() == uid and (p.get("id") or "").strip()]
    cur = get_db().projects.find({"owner_user_id": uid}, {"_id": 0, "id": 1})
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


def delete_project_and_articles(project_id: str) -> bool:
    if _storage_mode != "mongo":
        with _db_write_lock:
            projects = [_normalize_project_dict(dict(p)) for p in _load_json_list("projects.json")]
            if not any((p.get("id") or "") == project_id for p in projects):
                return False
            projects = [p for p in projects if (p.get("id") or "") != project_id]
            _save_json_projects(projects)
            articles = [_normalize_article_dict(dict(a)) for a in _load_json_list("articles.json")]
            articles = [a for a in articles if (a.get("project_id") or "") != project_id]
            _save_json_articles(articles)
        return True
    with _db_write_lock:
        db = get_db()
        if db.projects.count_documents({"id": project_id}, limit=1) == 0:
            return False
        db.articles.delete_many({"project_id": project_id})
        db.projects.delete_one({"id": project_id})
        return True


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
    with _db_write_lock:
        db = get_db()
        for aid, u in updates:
            doc = db.articles.find_one({"id": aid})
            if not doc:
                _log.warning("bulk_update_articles: missing article id %r in MongoDB", aid)
                continue
            d = _mongo_doc_to_article(doc)
            _apply_article_updates_dict(d, u)
            norm = _normalize_article_dict(d)
            new_doc = {**norm, "_id": norm["id"]}
            res = db.articles.replace_one({"id": aid}, new_doc)
            if not (res.acknowledged and res.matched_count == 1):
                raise RuntimeError(f"MongoDB bulk article update failed for id={aid!r}")


def export_tables_to_json() -> tuple[list[dict], list[dict]]:
    """Snapshot for backup."""
    return load_projects(), load_articles()


def init_storage() -> None:
    global _storage_mode, _storage_init_error
    try:
        init_db()
        _storage_mode = "mongo"
        _storage_init_error = None
    except Exception as e:
        _storage_mode = "json"
        _storage_init_error = str(e)
