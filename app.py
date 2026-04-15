import base64
import os
import re
import json
import uuid
import secrets
import threading
import time
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from urllib.parse import urlencode, urlparse

from dotenv import load_dotenv
from flask import Flask, Response, flash, jsonify, redirect, render_template, request, send_file, session, url_for
from flask_session import Session

_APP_DIR = os.path.dirname(os.path.abspath(__file__))
# Load .env from the project folder (next to app.py), not from the shell's cwd — otherwise
# GOOGLE_OAUTH_* and other keys are missing when Flask is started from another directory.
load_dotenv(os.path.join(_APP_DIR, ".env"))

# Google OAuth local dev: oauthlib rejects http:// callback URLs unless this is set.
# In production, use HTTPS and set OAUTHLIB_INSECURE_TRANSPORT=0 (or remove) in .env.
if "OAUTHLIB_INSECURE_TRANSPORT" not in os.environ:
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

from wordpress_module import (
    WordPressConfig,
    create_post,
    ensure_tag_ids,
    fetch_rest_post_types,
    markdown_to_wp_html,
    upload_media,
)


app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY")

# Store sessions server-side so we can keep large generated articles.
app.config.update(
    SESSION_TYPE="filesystem",
    # SESSION_FILE_DIR=os.path.join(os.path.dirname(__file__), ".flask_session"),
    SESSION_PERMANENT=False,
    SESSION_USE_SIGNER=True,
)
Session(app)

_DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
_PROJECTS_FILE = os.path.join(_DATA_DIR, "projects.json")
_ARTICLES_FILE = os.path.join(_DATA_DIR, "articles.json")
_ARTICLE_IMAGES_DIR = os.path.join(_DATA_DIR, "article_images")
_MAX_PROJECTS = 9  # 3×3 grid


def _ensure_data_dir() -> None:
    os.makedirs(_DATA_DIR, exist_ok=True)


def _load_projects() -> list[dict]:
    _ensure_data_dir()
    if not os.path.isfile(_PROJECTS_FILE):
        return []
    try:
        with open(_PROJECTS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
    except Exception:
        pass
    return []


def _save_projects(projects: list[dict]) -> None:
    _ensure_data_dir()
    with open(_PROJECTS_FILE, "w", encoding="utf-8") as f:
        json.dump(projects, f, ensure_ascii=False, indent=2)


def _update_project_fields(project_id: str, updates: dict) -> bool:
    projects = _load_projects()
    for i, p in enumerate(projects):
        if (p.get("id") or "") == project_id:
            projects[i].update(updates)
            _save_projects(projects)
            return True
    return False


_articles_file_lock = threading.Lock()
_wp_scheduled_processor_lock = threading.Lock()
_wp_bg_trigger_last = 0.0
_wp_bg_trigger_lock = threading.Lock()


def _load_articles() -> list[dict]:
    _ensure_data_dir()
    if not os.path.isfile(_ARTICLES_FILE):
        return []
    try:
        with _articles_file_lock:
            with open(_ARTICLES_FILE, encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, list):
                return []
            changed = False
            for a in data:
                if not (a.get("status") or "").strip():
                    a["status"] = "pending"
                    changed = True
                gs = (a.get("gsc_status") or "").strip().lower()
                if gs not in {"pending", "requested"}:
                    a["gsc_status"] = "pending"
                    changed = True
            if changed:
                with open(_ARTICLES_FILE, "w", encoding="utf-8") as wf:
                    json.dump(data, wf, ensure_ascii=False, indent=2)
        return data
    except Exception:
        pass
    return []


def _save_articles(articles: list[dict]) -> None:
    _ensure_data_dir()
    with _articles_file_lock:
        with open(_ARTICLES_FILE, "w", encoding="utf-8") as f:
            json.dump(articles, f, ensure_ascii=False, indent=2)


def _get_project_by_id(project_id: str) -> dict | None:
    pid = (project_id or "").strip()
    for p in _load_projects():
        if (p.get("id") or "") == pid:
            return p
    return None


def _normalize_project_prompts(project: dict) -> None:
    """Ensure prompts list exists and entries have id, name, text."""
    raw = project.get("prompts")
    if not isinstance(raw, list):
        project["prompts"] = []
        return
    cleaned: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        pid = (item.get("id") or "").strip()
        name = (item.get("name") or "").strip()
        text = (item.get("text") or "").strip()
        if not pid or not name:
            continue
        cleaned.append({"id": pid, "name": name[:200], "text": text[:100_000]})
    project["prompts"] = cleaned


def _get_prompt_by_id(project: dict, prompt_id: str) -> dict | None:
    pid = (prompt_id or "").strip()
    for pr in project.get("prompts") or []:
        if isinstance(pr, dict) and (pr.get("id") or "") == pid:
            return pr
    return None


def _resolve_default_prompt_text(project: dict) -> str | None:
    """Text of the default prompt for article generation, or None to use built-in template."""
    _normalize_project_prompts(project)
    did = (project.get("default_prompt_id") or "").strip()
    if not did:
        return None
    pr = _get_prompt_by_id(project, did)
    if pr and (pr.get("text") or "").strip():
        return (pr.get("text") or "").strip()
    return None


# Placeholders users can put in stored prompt text; filled at generation time.
_ARTICLE_PROMPT_PLACEHOLDER_KEYS = (
    "{article title}",
    "{targeting keywords}",
    "{focus keyphrase}",
    "{title}",
    "{keywords}",
    "{focus_keyphrase}",
)


def _prompt_template_has_placeholders(raw: str) -> bool:
    s = raw or ""
    return any(k in s for k in _ARTICLE_PROMPT_PLACEHOLDER_KEYS)


def _interpolate_article_prompt_template(
    raw: str,
    title: str,
    keywords: list[str],
    focus_keyphrase: str | None = None,
) -> str:
    """Replace {article title}, {targeting keywords}, {focus keyphrase}, and short aliases."""
    kw_display = ", ".join(keywords) if keywords else "(none)"
    fk_display = (focus_keyphrase or "").strip() or "(none)"
    out = raw or ""
    # Longer tokens first so partial overlaps are safe
    out = out.replace("{article title}", title)
    out = out.replace("{targeting keywords}", kw_display)
    out = out.replace("{focus keyphrase}", fk_display)
    out = out.replace("{title}", title)
    out = out.replace("{keywords}", kw_display)
    out = out.replace("{focus_keyphrase}", fk_display)
    return out


def _normalize_project_image_prompts(project: dict) -> None:
    """Ensure image_prompts list exists (same shape as writing prompts)."""
    raw = project.get("image_prompts")
    if not isinstance(raw, list):
        project["image_prompts"] = []
        return
    cleaned: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        pid = (item.get("id") or "").strip()
        name = (item.get("name") or "").strip()
        text = (item.get("text") or "").strip()
        if not pid or not name:
            continue
        cleaned.append({"id": pid, "name": name[:200], "text": text[:100_000]})
    project["image_prompts"] = cleaned


def _normalize_project_gsc(project: dict) -> None:
    """Search Console property URL + whether to request inspection after a live WordPress publish."""
    raw = project.get("gsc_property_url")
    project["gsc_property_url"] = (raw or "").strip() if isinstance(raw, str) else ""
    iop = project.get("gsc_index_on_publish")
    if iop is None:
        project["gsc_index_on_publish"] = True
    else:
        project["gsc_index_on_publish"] = bool(iop)


def _normalize_project_context_links(project: dict) -> None:
    """Ensure context_links list exists: phrase + url for inline linking when posting to WordPress."""
    raw = project.get("context_links")
    if not isinstance(raw, list):
        project["context_links"] = []
        return
    cleaned: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        lid = (item.get("id") or "").strip()
        phrase = (item.get("phrase") or item.get("text") or "").strip()
        url = (item.get("url") or item.get("link") or "").strip()
        if not lid or not phrase:
            continue
        cleaned.append({"id": lid, "phrase": phrase[:2000], "url": url[:2048]})
    project["context_links"] = cleaned


def _normalize_project_wp_defaults(project: dict) -> None:
    """
    Ensure default WordPress settings exist on the project.
    - default_wp_rest_base: REST collection (e.g. posts, pages, articles)
    - default_wp_status: draft or publish
    """
    if not isinstance(project, dict):
        return
    rb = (project.get("default_wp_rest_base") or "").strip().strip("/") or "posts"
    project["default_wp_rest_base"] = rb
    st = (project.get("default_wp_status") or "draft").strip().lower()
    project["default_wp_status"] = st if st in ("draft", "publish") else "draft"


def _is_valid_context_link_url(url: str) -> bool:
    raw = (url or "").strip()
    if not raw or ")" in raw:
        return False
    u = urlparse(raw)
    if u.scheme not in ("http", "https") or not u.netloc:
        return False
    return True


def _context_link_rules_for_project(project: dict) -> list[tuple[str, str]]:
    """(phrase, url) pairs, longest phrases first; skips invalid rows."""
    _normalize_project_context_links(project)
    rules: list[tuple[str, str]] = []
    for item in project.get("context_links") or []:
        phrase = (item.get("phrase") or "").strip()
        url = (item.get("url") or "").strip()
        if not phrase or not url or not _is_valid_context_link_url(url):
            continue
        if "]" in phrase or "\n" in phrase or "\r" in phrase:
            continue
        rules.append((phrase, url))
    rules.sort(key=lambda x: len(x[0]), reverse=True)
    return rules


_CTX_LINK_TOKEN = "\u2060CTX\u2060{}"

def _protect_regions_for_context_links(md: str) -> tuple[str, list[str]]:
    """Temporarily replace markdown links and HTML anchors so phrase replacement does not run inside them."""
    vault: list[str] = []

    def stash_md(m):
        vault.append(m.group(0))
        return _CTX_LINK_TOKEN.format(len(vault) - 1)

    s = re.sub(r"\[[^\]]*\]\([^)]*\)", stash_md, md)

    def stash_html(m):
        vault.append(m.group(0))
        return _CTX_LINK_TOKEN.format(len(vault) - 1)

    s = re.sub(r"<a\s[^>]*>.*?</a>", stash_html, s, flags=re.I | re.DOTALL)
    return s, vault


def _unprotect_context_link_regions(s: str, vault: list[str]) -> str:
    for i, chunk in enumerate(vault):
        s = s.replace(_CTX_LINK_TOKEN.format(i), chunk)
    return s


def _apply_context_links_to_markdown(md: str, project: dict | None) -> str:
    """
    Wrap phrase matches in markdown links before HTML conversion.
    Matching is case-insensitive; the linked text keeps the article’s original casing.
    Longer phrases are applied first; existing markdown links and <a> tags are not modified.
    """
    if not md or not project:
        return md
    rules = _context_link_rules_for_project(project)
    if not rules:
        return md
    s = md
    for phrase, url in rules:
        s, vault = _protect_regions_for_context_links(s)
        pattern = re.compile(re.escape(phrase), re.IGNORECASE)
        if not pattern.search(s):
            s = _unprotect_context_link_regions(s, vault)
            continue

        def _ctx_link_repl(m):
            matched = m.group(0)
            return f"[{matched}]({url})"

        s = pattern.sub(_ctx_link_repl, s)
        s = _unprotect_context_link_regions(s, vault)
    return s


def _article_body_to_wp_html(body: str, project: dict | None) -> str:
    """Markdown → HTML for WordPress, applying project context links when `project` is set."""
    md = _apply_context_links_to_markdown(body or "", project)
    return markdown_to_wp_html(md)


def _project_wp_credentials_configured(project: dict) -> bool:
    """True when WordPress username and application password are set (required for posting)."""
    u = (project.get("wp_username") or "").strip()
    p = (project.get("wp_app_password") or "").strip()
    return bool(u and p)


def _get_image_prompt_by_id(project: dict, prompt_id: str) -> dict | None:
    pid = (prompt_id or "").strip()
    for pr in project.get("image_prompts") or []:
        if isinstance(pr, dict) and (pr.get("id") or "") == pid:
            return pr
    return None


def _resolve_default_image_prompt_text(project: dict) -> str | None:
    _normalize_project_image_prompts(project)
    did = (project.get("default_image_prompt_id") or "").strip()
    if not did:
        return None
    pr = _get_image_prompt_by_id(project, did)
    if pr and (pr.get("text") or "").strip():
        return (pr.get("text") or "").strip()
    return None


def _ensure_article_images_dir() -> None:
    os.makedirs(_ARTICLE_IMAGES_DIR, exist_ok=True)


def _article_featured_image_path(article_id: str) -> str:
    return os.path.join(_ARTICLE_IMAGES_DIR, f"{article_id}.png")


def _delete_article_featured_image_file(article_id: str) -> None:
    p = _article_featured_image_path(article_id)
    if os.path.isfile(p):
        try:
            os.remove(p)
        except OSError:
            pass


def _save_article_featured_image_png(article_id: str, png_bytes: bytes) -> None:
    _ensure_article_images_dir()
    path = _article_featured_image_path(article_id)
    with open(path, "wb") as f:
        f.write(png_bytes)


_MAX_FEATURED_UPLOAD_BYTES = 8 * 1024 * 1024


_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _convert_upload_to_png_bytes(raw: bytes) -> bytes:
    """Convert a single uploaded image (JPEG/PNG/WebP/GIF) to PNG bytes."""
    from io import BytesIO

    try:
        from PIL import Image
    except ImportError:
        # Allow PNG-only uploads when Pillow is not installed (same bytes stored as .png).
        if len(raw) >= 8 and raw[:8] == _PNG_SIGNATURE:
            return raw
        raise ValueError(
            "Install Pillow to upload JPEG, WebP, or GIF: pip install Pillow "
            "(PNG uploads work without it; see requirements.txt)."
        ) from None

    im = Image.open(BytesIO(raw))
    if im.mode == "P" and "transparency" in im.info:
        im = im.convert("RGBA")
    if im.mode == "LA":
        im = im.convert("RGBA")
    if im.mode == "RGBA":
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[3])
        im = bg
    elif im.mode != "RGB":
        im = im.convert("RGB")
    out = BytesIO()
    im.save(out, format="PNG", optimize=True)
    return out.getvalue()


def _generate_featured_image_png_bytes(image_prompt: str) -> bytes:
    """DALL·E 3 via OpenAI API (requires OPENAI_API_KEY)."""
    from openai import OpenAI

    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise ValueError(
            "OPENAI_API_KEY is required for featured image generation (DALL·E 3). "
            "Groq and other chat-only keys cannot generate images."
        )
    client = OpenAI(api_key=key)
    prompt = (image_prompt or "").strip()[:4000]
    if not prompt:
        raise ValueError("Image prompt is empty.")
    resp = client.images.generate(
        model="dall-e-3",
        prompt=prompt,
        size="1792x1024",
        quality="standard",
        response_format="b64_json",
        n=1,
    )
    b64 = resp.data[0].b64_json
    if not b64:
        raise ValueError("Image API returned no data.")
    return base64.b64decode(b64)


def _articles_for_project(project_id: str) -> list[dict]:
    pid = (project_id or "").strip()
    return [a for a in _load_articles() if (a.get("project_id") or "") == pid]


def _get_article_by_id(article_id: str) -> dict | None:
    aid = (article_id or "").strip()
    for a in _load_articles():
        if (a.get("id") or "") == aid:
            return a
    return None


def _update_article_fields(article_id: str, updates: dict) -> bool:
    arts = _load_articles()
    for i, a in enumerate(arts):
        if (a.get("id") or "") == article_id:
            arts[i].update(updates)
            _save_articles(arts)
            return True
    return False


def _app_article_status_from_wp_rest_status(raw) -> str:
    """Map WordPress REST post `status` to our article status (published vs draft)."""
    if isinstance(raw, str) and raw.strip():
        w = raw.strip().lower()
    else:
        w = str(raw or "draft").lower()
    return "published" if w == "publish" else "draft"


def _article_to_last(article: dict) -> dict:
    """Shape compatible with article generator / WordPress templates."""
    return {
        "title": article.get("title") or "",
        "keywords": article.get("keywords") or [],
        "article": article.get("article") or "",
        "focus_keyphrase": article.get("focus_keyphrase") or "",
        "meta_title": article.get("meta_title") or "",
        "meta_description": article.get("meta_description") or "",
        "generated_at": article.get("generated_at") or "",
    }


def _normalize_article_text(s: str | None) -> str:
    if not s:
        return ""
    return s.replace("\r\n", "\n").replace("\r", "\n")


def _article_body_matches_stored(form_body: str | None, stored: str | None) -> bool:
    return _normalize_article_text(form_body) == _normalize_article_text(stored)


def _parse_article_datetime(s: str) -> datetime | None:
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _parse_schedule_times_json(raw: str) -> dict[str, str] | None:
    """Parse JSON object of article_id -> datetime-local string from bulk schedule form."""
    s = (raw or "").strip()
    if not s:
        return None
    try:
        data = json.loads(s)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    out: dict[str, str] = {}
    for k, v in data.items():
        ks = str(k).strip()
        if not ks or v is None:
            continue
        vs = str(v).strip()
        if vs:
            out[ks] = vs
    return out or None


def _parse_bulk_schedule_datetime(raw: str) -> datetime | None:
    """Parse datetime from bulk schedule form (datetime-local or stored format)."""
    s = (raw or "").strip().replace("T", " ", 1)
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _clamp_future_schedule_dt(dt: datetime) -> datetime:
    now = datetime.now().replace(microsecond=0)
    if dt < now:
        return now + timedelta(minutes=1)
    return dt.replace(microsecond=0)


def _bulk_schedule_thread_entry(project_id: str, ids: list[str], form_snapshot: dict) -> None:
    with app.app_context():
        err = _bulk_schedule_pipeline(project_id, ids, form_snapshot)
        if err:
            app.logger.error("Bulk schedule failed: %s", err)


def _bulk_schedule_pipeline(project_id: str, ids: list[str], form_snapshot: dict) -> str | None:
    project = _get_project_by_id(project_id)
    if not project:
        return "Project not found."

    wp_st = (form_snapshot.get("schedule_wp_status") or "draft").strip().lower()
    if wp_st not in ("draft", "publish"):
        wp_st = "draft"

    wp_types, _ = _wp_post_types_for_project(project)
    allowed_bases = {t["rest_base"] for t in wp_types}
    raw_schedule_rb = (form_snapshot.get("schedule_wp_rest_base") or "").strip()
    if raw_schedule_rb:
        schedule_rest_base = _normalize_wp_rest_base(raw_schedule_rb, allowed_bases)
    else:
        schedule_rest_base = _normalize_wp_rest_base(project.get("default_wp_rest_base"), allowed_bases)

    bulk_prompt = (form_snapshot.get("bulk_prompt_id") or "").strip()
    bulk_image = (form_snapshot.get("bulk_image_prompt_id") or "").strip()

    proj_gen = dict(project)
    _normalize_project_prompts(proj_gen)
    _normalize_project_image_prompts(proj_gen)

    arts = _load_articles()
    id_set = set(ids)
    targets = [
        a
        for a in arts
        if (a.get("id") or "") in id_set and (a.get("project_id") or "") == project_id
    ]
    if not targets:
        return "No matching articles for this project."

    proj_check = dict(project)
    _normalize_project_image_prompts(proj_check)
    need_img = len(proj_check.get("image_prompts") or []) > 0

    for t in targets:
        aid = (t.get("id") or "").strip()
        if not aid or t.get("wp_post_id"):
            continue
        need_body = not (t.get("article") or "").strip()
        need_img_file = need_img and not os.path.isfile(_article_featured_image_path(aid))
        if not need_body and not need_img_file:
            continue
        title = (t.get("title") or "").strip()
        if not title:
            return "Cannot generate or schedule: one or more selected articles have no title. Add a title first."
        kws = _article_keywords_list(t)
        ok, err, img_err = _generate_article_content_core(
            proj_gen,
            aid,
            title=title,
            keywords=kws,
            writing_prompt_id=bulk_prompt,
            image_prompt_id=bulk_image,
            user_focus_keyphrase=((t.get("focus_keyphrase") or "").strip() or None),
        )
        if not ok:
            return f"Generation failed for «{title[:80]}»: {err}"
        if need_img and not os.path.isfile(_article_featured_image_path(aid)):
            return (
                f"Featured image missing for «{title[:80]}» after generation. "
                f"{img_err or 'Check OPENAI_API_KEY for DALL·E.'}"
            )

    arts_fresh = _load_articles()
    targets = [
        a
        for a in arts_fresh
        if (a.get("id") or "") in id_set and (a.get("project_id") or "") == project_id
    ]

    proj_check = dict(project)
    _normalize_project_image_prompts(proj_check)
    need_img = len(proj_check.get("image_prompts") or []) > 0

    eligible: list[dict] = []
    skipped = 0
    for t in targets:
        aid = (t.get("id") or "").strip()
        if not aid:
            continue
        if t.get("wp_post_id"):
            skipped += 1
            continue
        if need_img and not os.path.isfile(_article_featured_image_path(aid)):
            skipped += 1
            continue
        if not (t.get("article") or "").strip():
            skipped += 1
            continue
        eligible.append(t)

    eligible.sort(key=lambda x: ((x.get("created_at") or ""), (x.get("id") or "")))
    n_elig = len(eligible)
    if n_elig == 0:
        return (
            "No articles could be scheduled. "
            + (f"Skipped {skipped} (already posted, empty body, or missing featured image)." if skipped else "")
        )

    times_map = _parse_schedule_times_json(form_snapshot.get("schedule_times_json") or "")
    if not times_map:
        return "Please set a date and time for each selected article."
    times: list[datetime] = []
    for t in eligible:
        aid = (t.get("id") or "").strip()
        title_hint = (t.get("title") or "").strip() or "Untitled"
        raw_dt = times_map.get(aid)
        if raw_dt is None:
            return f"Missing schedule time for «{title_hint[:80]}»."
        dt = _parse_bulk_schedule_datetime(raw_dt)
        if not dt:
            return f"Invalid date and time for «{title_hint[:80]}»."
        times.append(_clamp_future_schedule_dt(dt))

    batch_id = str(uuid.uuid4())
    arts = _load_articles()
    id_to_i = {(a.get("id") or ""): idx for idx, a in enumerate(arts)}
    for i, t in enumerate(eligible):
        aid = (t.get("id") or "").strip()
        idx = id_to_i.get(aid)
        if idx is None:
            continue
        sched_str = times[i].strftime("%Y-%m-%d %H:%M:%S")
        arts[idx].update(
            {
                "wp_scheduled_at": sched_str,
                "wp_schedule_wp_status": wp_st,
                "wp_rest_base": schedule_rest_base,
                "wp_schedule_error": "",
                "wp_schedule_batch_id": batch_id,
                "wp_schedule_batch_index": i,
                "wp_schedule_batch_total": n_elig,
            }
        )
    _save_articles(arts)

    msg = f"Scheduled {n_elig} article(s) for automatic WordPress posting."
    if skipped:
        msg += f" Skipped {skipped} (already posted, empty body, or missing featured image)."
    app.logger.info(msg)
    return None


def _earlier_batch_member_blocks(arts: list[dict], article: dict, now: datetime) -> bool:
    """
    True if another article in the same batch with a lower index is still ahead of this one
    in the queue: they have no wp_post_id yet, their schedule time is already due (<= now),
    and they still have a schedule row. Earlier rows with a *future* schedule time do not block
    (avoids deadlock when batch times are out of order or were edited).
    """
    bid = (article.get("wp_schedule_batch_id") or "").strip()
    if not bid:
        return False
    my_idx = int(article.get("wp_schedule_batch_index") or 0)
    for o in arts:
        if (o.get("wp_schedule_batch_id") or "").strip() != bid:
            continue
        oidx = int(o.get("wp_schedule_batch_index") or 0)
        if oidx >= my_idx:
            continue
        if o.get("wp_post_id"):
            continue
        sched_o = (o.get("wp_scheduled_at") or "").strip()
        if not sched_o:
            continue
        try:
            dt_o = datetime.strptime(sched_o, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        if dt_o > now:
            continue
        return True
    return False


def _redirect_project_detail_with_dates(project_id: str):
    df = request.form.get("date_from", "").strip()
    dt = request.form.get("date_to", "").strip()
    fs = request.form.get("filter_status", "").strip().lower()
    if fs not in {"pending", "draft", "published"}:
        fs = ""
    q = urlencode({k: v for k, v in [("date_from", df), ("date_to", dt), ("status", fs)] if v})
    url = url_for("project_detail", project_id=project_id)
    return redirect(url + ("?" + q if q else ""))


def _cleared_wp_schedule_fields() -> dict:
    return {
        "wp_scheduled_at": "",
        "wp_schedule_wp_status": "",
        "wp_schedule_error": "",
        "wp_schedule_batch_id": "",
        "wp_schedule_batch_index": "",
        "wp_schedule_batch_total": "",
    }


def _pending_scheduled_article_rows(project_id: str) -> list[dict]:
    """Articles queued for WordPress (scheduled time set, not yet posted)."""
    pid = (project_id or "").strip()
    rows: list[dict] = []
    for a in _articles_for_project(pid):
        if a.get("wp_post_id"):
            continue
        sched = (a.get("wp_scheduled_at") or "").strip()
        if not sched:
            continue
        wp_st = (a.get("wp_schedule_wp_status") or "draft").strip().lower()
        if wp_st not in ("draft", "publish"):
            wp_st = "draft"
        rows.append(
            {
                "id": (a.get("id") or "").strip(),
                "title": (a.get("title") or "").strip() or "(Untitled)",
                "wp_scheduled_at": sched,
                "wp_schedule_wp_status": wp_st,
            }
        )

    def _sort_key(r: dict):
        dt = _parse_article_datetime(r.get("wp_scheduled_at") or "")
        return dt or datetime.min

    rows.sort(key=_sort_key)
    return rows


def _status_display_article(st: str | None) -> str:
    s = (st or "pending").strip().lower()
    if s == "published":
        return "Published"
    if s == "draft":
        return "Draft"
    return "Pending"


def _filter_articles_by_date_range(
    articles: list[dict], date_from: str | None, date_to: str | None
) -> list[dict]:
    """Filter by calendar date using posted_at when set, otherwise created_at."""
    df = (date_from or "").strip()
    dt = (date_to or "").strip()
    if not df and not dt:
        return articles
    d_from = None
    d_to = None
    if df:
        try:
            d_from = datetime.strptime(df, "%Y-%m-%d").date()
        except ValueError:
            pass
    if dt:
        try:
            d_to = datetime.strptime(dt, "%Y-%m-%d").date()
        except ValueError:
            pass
    out: list[dict] = []
    for a in articles:
        ref = (a.get("posted_at") or "").strip() or (a.get("created_at") or "").strip()
        adt = _parse_article_datetime(ref)
        if not adt:
            continue
        ad = adt.date()
        if d_from and ad < d_from:
            continue
        if d_to and ad > d_to:
            continue
        out.append(a)
    return out


def _article_status_key(a: dict) -> str:
    st = (a.get("status") or "pending").strip().lower()
    if st not in {"pending", "draft", "published"}:
        return "pending"
    return st


def _filter_articles_by_status(articles: list[dict], status_key: str | None) -> list[dict]:
    """Keep articles whose app status matches (pending / draft / published). Empty key = no filter."""
    sk = (status_key or "").strip().lower()
    if sk not in {"pending", "draft", "published"}:
        return articles
    return [a for a in articles if _article_status_key(a) == sk]


def _build_articles_excel_bytes(articles: list[dict]) -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

    wb = Workbook()
    ws = wb.active
    ws.title = "Articles"
    headers = ["Title", "Targeting keywords", "Status", "Added", "Posted", "WP link"]
    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill("solid", fgColor="4472C4")
    thin = Side(style="thin", color="CCCCCC")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    for col, h in enumerate(headers, start=1):
        c = ws.cell(row=1, column=col, value=h)
        c.font = header_font
        c.fill = header_fill
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        c.border = border

    for row_idx, a in enumerate(articles, start=2):
        row = [
            a.get("title") or "",
            ", ".join(a.get("keywords") or []),
            _status_display_article(a.get("status")),
            a.get("created_at") or "",
            a.get("posted_at") or "",
            a.get("wp_link") or "",
        ]
        for col_idx, val in enumerate(row, start=1):
            cell = ws.cell(row=row_idx, column=col_idx, value=val)
            cell.border = border
            cell.alignment = Alignment(vertical="top", wrap_text=True)

    ws.column_dimensions["A"].width = 42
    ws.column_dimensions["B"].width = 40
    ws.column_dimensions["C"].width = 14
    ws.column_dimensions["D"].width = 20
    ws.column_dimensions["E"].width = 20
    ws.column_dimensions["F"].width = 36
    ws.freeze_panes = "A2"

    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf.getvalue()


def _normalize_bulk_sheet_header_cell(x) -> str:
    """Lowercase header labels and normalize spaces to underscores (e.g. 'Focus Keyphrase' -> 'focus_keyphrase')."""
    s = str(x).strip().lower() if x is not None else ""
    s = re.sub(r"[\s\-]+", "_", s)
    return s


def _build_bulk_upload_sample_bytes() -> bytes:
    """
    Sample sheet for bulk importing articles into a project.
    Columns: Title, Focus Keyphrase, Targeting Keywords (imported rows are always pending).
    """
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

    wb = Workbook()
    ws = wb.active
    ws.title = "Sample"

    headers = ["Title", "Focus Keyphrase", "Targeting Keywords"]
    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill("solid", fgColor="2F5597")
    thin = Side(style="thin", color="CCCCCC")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    for col, h in enumerate(headers, start=1):
        c = ws.cell(row=1, column=col, value=h)
        c.font = header_font
        c.fill = header_fill
        c.alignment = Alignment(horizontal="center", vertical="center")
        c.border = border

    examples = [
        [
            "Key Factors That Define Top Supreme Court Lawyers for Complex Litigation",
            "top supreme court lawyers india",
            "top supreme court lawyers india, senior advocate Supreme Court",
        ],
        [
            "Writ Petition under Article 226: Procedure and Reliefs",
            "writ petition article 226",
            "writ petition article 226, high court writ jurisdiction",
        ],
    ]
    for r, row in enumerate(examples, start=2):
        for cidx, val in enumerate(row, start=1):
            cell = ws.cell(row=r, column=cidx, value=val)
            cell.border = border
            cell.alignment = Alignment(vertical="top", wrap_text=True)

    ws.column_dimensions["A"].width = 55
    ws.column_dimensions["B"].width = 32
    ws.column_dimensions["C"].width = 45
    ws.freeze_panes = "A2"

    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf.getvalue()


def _normalize_website_url(raw: str) -> str:
    s = (raw or "").strip()
    if not s:
        raise ValueError("Website URL is required.")
    if not re.match(r"^https?://", s, re.IGNORECASE):
        s = "https://" + s
    if len(s) > 2048:
        raise ValueError("Website URL is too long.")
    return s.rstrip("/")


def _is_project_wordpress_configured(project: dict) -> bool:
    return bool((project.get("wp_username") or "").strip() and (project.get("wp_app_password") or "").strip())


def _wp_post_types_for_project(project: dict) -> tuple[list[dict[str, str]], str | None]:
    """Fetch REST post types from WordPress (GET /wp/v2/types), or a safe fallback."""
    fallback = [{"slug": "post", "name": "Posts", "rest_base": "posts"}]
    if not _is_project_wordpress_configured(project):
        return fallback, None
    try:
        cfg = WordPressConfig(
            site_url=(project.get("wp_site_url") or project.get("website_url") or "").strip(),
            username=(project.get("wp_username") or "").strip(),
            application_password=(project.get("wp_app_password") or "").strip(),
        )
        types = fetch_rest_post_types(cfg)
        if not types:
            return fallback, "WordPress returned no post types; using Posts only."
        return types, None
    except Exception as e:
        return fallback, str(e)


def _normalize_wp_rest_base(rest_base: str | None, allowed: set[str]) -> str:
    rb = (rest_base or "").strip().strip("/") or "posts"
    if rb in allowed:
        return rb
    if "posts" in allowed:
        return "posts"
    return next(iter(sorted(allowed))) if allowed else "posts"


def _parse_keywords(raw: str) -> list[str]:
    items = [x.strip() for x in (raw or "").split(",")]
    items = [x for x in items if x]
    # de-dup preserve order
    seen = set()
    out: list[str] = []
    for k in items:
        key = k.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(k)
    return out


def _parse_focus_keyphrase_single_field(raw: str) -> tuple[str | None, str | None]:
    """
    Focus keyphrase must be one phrase (no comma-separated list).
    Returns (value or None if empty, error_message or None).
    """
    parts = _parse_keywords(raw or "")
    if len(parts) > 1:
        return None, "Focus keyphrase must be a single phrase (no commas)."
    if not parts:
        return None, None
    return parts[0], None


def _article_keywords_list(article: dict) -> list[str]:
    """Normalize stored article keywords to a list (max 10)."""
    kw = article.get("keywords") or []
    if isinstance(kw, list):
        out = [str(x).strip() for x in kw if str(x).strip()]
    else:
        out = _parse_keywords(str(kw))
    return out[:10]


def _sanitize_filename(name: str) -> str:
    name = (name or "").strip() or "article"
    name = re.sub(r"[^a-zA-Z0-9\-_ ]+", "", name).strip()
    name = re.sub(r"\s+", "_", name)
    return (name[:80] or "article") + ".txt"


def _extract_first_json_object(text: str) -> dict:
    """
    Best-effort extraction of the first JSON object from an LLM response.
    """
    s = (text or "").strip()
    if not s:
        raise ValueError("Empty model response.")
    # Direct JSON
    try:
        obj = json.loads(s)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass

    # Try to find a JSON object within text.
    start = s.find("{")
    end = s.rfind("}")
    if start != -1 and end != -1 and end > start:
        chunk = s[start : end + 1]
        obj = json.loads(chunk)
        if isinstance(obj, dict):
            return obj
    raise ValueError("Could not parse JSON from model response.")


def _get_openai_client_and_model(api_key: str | None):
    # Lazy import so the app can start even if deps missing; error shown on generate.
    from openai import OpenAI

    key = (api_key or "").strip()
    if not key:
        # Prefer explicit OpenAI key, then Groq key.
        key = os.environ.get("OPENAI_API_KEY", "").strip() or os.environ.get("GROQ_API_KEY", "").strip()
    if not key:
        raise ValueError(
            "Missing API key. Set OPENAI_API_KEY or GROQ_API_KEY, or paste a key in the form."
        )

    # If it's a Groq key (usually starts with gsk_) route to Groq's OpenAI-compatible endpoint.
    if key.lower().startswith("gsk_") or os.environ.get("LLM_PROVIDER", "").strip().lower() == "groq":
        base_url = os.environ.get("GROQ_BASE_URL", "https://api.groq.com/openai/v1").strip()
        model = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile").strip() or "llama-3.3-70b-versatile"
        return OpenAI(api_key=key, base_url=base_url), model

    model = os.environ.get("OPENAI_MODEL", "gpt-4.1-mini").strip() or "gpt-4.1-mini"
    return OpenAI(api_key=key), model


def _generate_article_markdown(
    title: str,
    keywords: list[str],
    api_key: str | None,
    *,
    article_prompt: str | None = None,
    focus_keyphrase: str | None = None,
) -> str:
    client, model = _get_openai_client_and_model(api_key)

    kw = ", ".join(keywords) if keywords else "(none)"
    fk = (focus_keyphrase or "").strip()
    custom = (article_prompt or "").strip()
    if custom:
        system = (
            "You are an expert writer. Follow the user's instructions precisely. "
            "Produce well-structured Markdown suitable for web publishing unless instructed otherwise."
        )
        raw_template = custom
        interpolated = _interpolate_article_prompt_template(raw_template, title, keywords, focus_keyphrase)
        uses_placeholders = _prompt_template_has_placeholders(raw_template)
        if uses_placeholders:
            user = f"""{interpolated}

Do not use a Markdown # line (H1) in the article body; the site shows the post title as the only H1. Start sections with ## (H2) or deeper. You may begin with paragraphs or an H2 section—never repeat the title as a # heading."""
        else:
            fk_line = f"Focus keyphrase (Yoast): {fk}\n\n" if fk else ""
            user = f"""{interpolated}

{fk_line}Article/post title: {title}
Targeting keywords (use naturally where appropriate): {kw}

Do not use `#` (H1) in the Markdown. Start the first section with ## (H2) or deeper; the theme displays the title separately."""
    else:
        system = (
            "Role & Perspective: You are a senior legal research analyst, subject-matter expert in Indian law, "
            "and enterprise SEO/AEO/GEO strategist. You draft high-authority informational legal content for a law "
            "firm knowledge repository, strictly aligned with Bar Council of India regulations and non-solicitation norms."
        )
        user = f"""
Write a ~2,000-word, high-authority, informational legal article for a law firm's website knowledge repository.

Title: {title}
Targeting keywords (use naturally): {kw}

Requirements:
- Approx length: ~2,000 words (±10%).
- Output in Markdown (clean conversion to HTML).
- Do not use `#` (H1) in the Markdown body—the WordPress theme outputs the article title as the page H1. Start all section headings at `##` (H2) or deeper (###, ####).
- Use scannable formatting: short paragraphs, bullet points, numbered lists, and a table where appropriate.
- SEO/AEO/GEO: answer high-intent queries succinctly; include clear definitions, step-by-step legal explanations, and FAQ-style sections.
- Keyword integration:
  - Use the targeting keywords naturally (no stuffing).
  - Include short-tail, long-tail, and conversational queries.
  - Place keywords/synonyms in headings (H2–H4 only; never H1 in the body), intro, conclusion, and contextual body sections.
  - Include 2–3 additional external keywords relevant to the topic.
  - Include internal/external keywords aligned to the website context: https://sheokandlegal.com/
- Legal accuracy & Indian law framework:
  - Reference only accurate and current Indian laws (Constitution Articles, Central Acts/Codes/Rules/Regulations).
  - If a law is amended/replaced, reflect the updated framework.
  - Cite authoritative Supreme Court/High Court judgments where relevant (avoid speculative citations).
  - Keep statutory/judicial citations precise and contextual.
- Tone, style & compliance:
  - Formal, neutral, and authoritative.
  - Avoid promotional language, calls to action, outcome assurances, or legal advice.
  - Position as general legal information only.

Mandatory structure (use `##` headings in this order; do not use `#`):
1) Introduction – Context, scope, and relevance
2) Conceptual Overview – Foundational explanation
3) Statutory Framework Under Indian Law – Laws, sections, constitutional provisions
4) Rights, Duties, and Legal Obligations
5) Procedural Aspects and Legal Mechanisms
6) Judicial Interpretation and Landmark Case Laws
7) Practical Implications for Individuals and Businesses
8) Common Misconceptions and Clarifications
9) Frequently Asked Questions (AEO-Optimized) – 5–8 Q&As
10) Emerging Trends and Legal Developments in India
11) Conclusion – Key takeaways and informational summary
"""

    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user.strip()},
        ],
        temperature=0.7,
    )
    return (resp.choices[0].message.content or "").strip()


def _generate_yoast_fields(
    title: str,
    keywords: list[str],
    api_key: str | None,
    *,
    website_context_url: str | None = None,
    focus_keyphrase_preset: str | None = None,
) -> dict:
    client, model = _get_openai_client_and_model(api_key)

    kw = ", ".join(keywords) if keywords else "(none)"
    site = (website_context_url or "").strip() or "https://sheokandlegal.com/"
    preset = (focus_keyphrase_preset or "").strip()
    system = (
        "You are an enterprise SEO/AEO strategist for an Indian law firm website. "
        "Return STRICT JSON only (no markdown fences, no extra text)."
    )
    preset_block = ""
    if preset:
        preset_block = f"""
CRITICAL: The Yoast focus keyphrase is FIXED by the user. Use this exact string (copy verbatim, do not paraphrase):
"{preset}"
Build meta_title and meta_description around this keyphrase.
"""
    fk_rule = (
        '- focus_keyphrase: MUST be the exact fixed string given in CRITICAL above.\n'
        if preset
        else "- focus_keyphrase: 2-6 words, must match search intent, prefer one of the targeting keywords if suitable.\n"
    )
    user = f"""
Generate Yoast SEO fields for this article.

Title: {title}
Targeting keywords: {kw}
{preset_block}
Constraints:
{fk_rule}- meta_title: 50-60 characters target, include focus keyphrase near the start, readable.
- meta_description: 140-160 characters target, include focus keyphrase once, include a benefit + CTA, no quotes.
- Avoid promotional/salesy language; keep informational and compliant with Indian legal ethics.
- Website context for phrasing: {site}

Return strict JSON with exactly these keys:
{{"focus_keyphrase":"...","meta_title":"...","meta_description":"..."}}
"""

    resp = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user.strip()},
        ],
        temperature=0.4,
    )
    raw = (resp.choices[0].message.content or "").strip()
    obj = _extract_first_json_object(raw)
    out = {
        "focus_keyphrase": (obj.get("focus_keyphrase") or "").strip(),
        "meta_title": (obj.get("meta_title") or "").strip(),
        "meta_description": (obj.get("meta_description") or "").strip(),
    }
    if preset:
        out["focus_keyphrase"] = preset
    return out


@app.get("/")
def home():
    projects = _load_projects()
    # Client id/secret come from .env (loaded from the app directory at startup).
    cid = (os.environ.get("GOOGLE_OAUTH_CLIENT_ID") or "").strip()
    csec = (os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET") or "").strip()
    gsc_oauth_env_configured = bool(cid and csec)
    gsc_google_connected = False
    gsc_google_email = None
    gsc_google_libs_missing = False
    try:
        import google_integration as gi

        gsc_google_email = gi.get_stored_email()
        gsc_google_connected = gi.get_valid_credentials() is not None
    except ImportError:
        gsc_google_libs_missing = True
    return render_template(
        "home.html",
        projects=projects,
        max_projects=_MAX_PROJECTS,
        gsc_google_connected=gsc_google_connected,
        gsc_google_email=gsc_google_email,
        gsc_oauth_env_configured=gsc_oauth_env_configured,
        gsc_google_libs_missing=gsc_google_libs_missing,
    )


@app.post("/projects")
def add_project():
    name = (request.form.get("project_name") or "").strip()
    url_raw = (request.form.get("website_url") or "").strip()
    if not name:
        flash("Please enter a project name.", "error")
        return redirect(url_for("home"))
    try:
        url = _normalize_website_url(url_raw)
    except ValueError as e:
        flash(str(e), "error")
        return redirect(url_for("home"))
    projects = _load_projects()
    if len(projects) >= _MAX_PROJECTS:
        flash(f"Maximum {_MAX_PROJECTS} projects reached (3×3 grid). Remove a project to add another.", "error")
        return redirect(url_for("home"))
    new_id = str(uuid.uuid4())
    projects.append(
        {
            "id": new_id,
            "name": name[:200],
            "website_url": url,
            # WordPress settings (optional; can be configured later per project)
            "wp_site_url": url,
            "wp_username": "",
            "wp_app_password": "",
            "wp_category_ids": "",
            "prompts": [],
            "default_prompt_id": "",
            "image_prompts": [],
            "default_image_prompt_id": "",
            "context_links": [],
            "gsc_property_url": "",
            "gsc_index_on_publish": True,
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
    )
    _save_projects(projects)
    flash(f"Project “{name}” added. Configure WordPress in Project settings.", "success")
    return redirect(url_for("project_detail", project_id=new_id, open_settings=1))


@app.post("/projects/<project_id>/settings")
def update_project_settings(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))

    wp_site_url_raw = (request.form.get("wp_site_url") or "").strip() or project.get("website_url") or ""
    wp_username = (request.form.get("wp_username") or "").strip()
    wp_app_password = (request.form.get("wp_app_password") or "").strip()
    wp_category_ids = (request.form.get("wp_category_ids") or "").strip()

    try:
        wp_site_url = _normalize_website_url(wp_site_url_raw)
    except ValueError as e:
        flash(str(e), "error")
        return redirect(url_for("project_detail", project_id=project_id))

    # Category IDs are optional but if provided must be comma-separated integers
    if wp_category_ids:
        for part in wp_category_ids.split(","):
            part = part.strip()
            if not part:
                continue
            if not part.isdigit():
                flash("Category IDs must be comma-separated numbers (e.g. 12, 34).", "error")
                return redirect(url_for("project_detail", project_id=project_id))

    _update_project_fields(
        project_id,
        {
            "wp_site_url": wp_site_url,
            "wp_username": wp_username,
            "wp_app_password": wp_app_password,
            "wp_category_ids": wp_category_ids,
        },
    )
    flash("Project settings saved.", "success")
    return redirect(url_for("project_detail", project_id=project_id))


@app.post("/projects/<project_id>/prompts/add")
def add_project_prompt(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))
    name = (request.form.get("prompt_name") or "").strip()
    text = (request.form.get("prompt_text") or "").strip()
    if not name:
        flash("Please enter a prompt name.", "error")
        return redirect(url_for("project_detail", project_id=project_id))
    if not text:
        flash("Please enter the prompt text used for article generation.", "error")
        return redirect(url_for("project_detail", project_id=project_id))

    proj = dict(project)
    _normalize_project_prompts(proj)
    prompts = list(proj.get("prompts") or [])
    new_id = str(uuid.uuid4())
    prompts.append({"id": new_id, "name": name[:200], "text": text[:100_000]})
    updates: dict = {"prompts": prompts}
    set_default = (request.form.get("set_as_default") or "") == "on"
    if len(prompts) == 1 or set_default:
        updates["default_prompt_id"] = new_id
    _update_project_fields(project_id, updates)
    flash(f"Prompt “{name[:80]}” added.", "success")
    return redirect(url_for("project_detail", project_id=project_id))


@app.post("/projects/<project_id>/prompts/default")
def set_project_default_prompt(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))
    prompt_id = (request.form.get("prompt_id") or "").strip()
    proj = dict(project)
    _normalize_project_prompts(proj)
    if not prompt_id or not _get_prompt_by_id(proj, prompt_id):
        flash("Select a valid prompt.", "error")
        return redirect(url_for("project_detail", project_id=project_id))
    _update_project_fields(project_id, {"default_prompt_id": prompt_id})
    flash("Default prompt updated for this project.", "success")
    return redirect(url_for("project_detail", project_id=project_id))


@app.post("/projects/<project_id>/prompts/update")
def update_project_prompt(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))
    prompt_id = (request.form.get("prompt_id") or "").strip()
    name = (request.form.get("prompt_name") or "").strip()
    text = (request.form.get("prompt_text") or "").strip()
    if not prompt_id:
        flash("Missing prompt.", "error")
        return redirect(url_for("project_detail", project_id=project_id))
    if not name:
        flash("Please enter a prompt name.", "error")
        return redirect(url_for("project_detail", project_id=project_id))
    if not text:
        flash("Please enter the prompt text.", "error")
        return redirect(url_for("project_detail", project_id=project_id))

    proj = dict(project)
    _normalize_project_prompts(proj)
    prompts = list(proj.get("prompts") or [])
    found = False
    for i, p in enumerate(prompts):
        if isinstance(p, dict) and (p.get("id") or "") == prompt_id:
            prompts[i] = {"id": prompt_id, "name": name[:200], "text": text[:100_000]}
            found = True
            break
    if not found:
        flash("Prompt not found.", "error")
        return redirect(url_for("project_detail", project_id=project_id))

    updates: dict = {"prompts": prompts}
    if (request.form.get("set_as_default") or "") == "on":
        updates["default_prompt_id"] = prompt_id
    _update_project_fields(project_id, updates)
    flash(f"Prompt “{name[:80]}” updated.", "success")
    return redirect(url_for("project_detail", project_id=project_id))


@app.post("/projects/<project_id>/prompts/delete")
def delete_project_prompt(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))
    prompt_id = (request.form.get("prompt_id") or "").strip()
    if not prompt_id:
        flash("Missing prompt.", "error")
        return redirect(url_for("project_detail", project_id=project_id))

    proj = dict(project)
    _normalize_project_prompts(proj)
    prompts = [p for p in (proj.get("prompts") or []) if isinstance(p, dict) and (p.get("id") or "") != prompt_id]
    if len(prompts) == len(proj.get("prompts") or []):
        flash("Prompt not found.", "error")
        return redirect(url_for("project_detail", project_id=project_id))

    updates: dict = {"prompts": prompts}
    default_id = (proj.get("default_prompt_id") or "").strip()
    if default_id == prompt_id:
        updates["default_prompt_id"] = (prompts[0].get("id") or "") if prompts else ""
    _update_project_fields(project_id, updates)
    flash("Prompt removed.", "success")
    return redirect(url_for("project_detail", project_id=project_id))


@app.post("/projects/<project_id>/image-prompts/add")
def add_project_image_prompt(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))
    name = (request.form.get("image_prompt_name") or "").strip()
    text = (request.form.get("image_prompt_text") or "").strip()
    if not name:
        flash("Please enter an image prompt name.", "error")
        return redirect(url_for("project_detail", project_id=project_id))
    if not text:
        flash("Please enter the image prompt text.", "error")
        return redirect(url_for("project_detail", project_id=project_id))

    proj = dict(project)
    _normalize_project_image_prompts(proj)
    prompts = list(proj.get("image_prompts") or [])
    new_id = str(uuid.uuid4())
    prompts.append({"id": new_id, "name": name[:200], "text": text[:100_000]})
    updates: dict = {"image_prompts": prompts}
    set_default = (request.form.get("set_as_default") or "") == "on"
    if len(prompts) == 1 or set_default:
        updates["default_image_prompt_id"] = new_id
    _update_project_fields(project_id, updates)
    flash(f"Image prompt “{name[:80]}” added.", "success")
    return redirect(url_for("project_detail", project_id=project_id))


@app.post("/projects/<project_id>/image-prompts/default")
def set_project_default_image_prompt(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))
    prompt_id = (request.form.get("image_prompt_id") or "").strip()
    proj = dict(project)
    _normalize_project_image_prompts(proj)
    if not prompt_id or not _get_image_prompt_by_id(proj, prompt_id):
        flash("Select a valid image prompt.", "error")
        return redirect(url_for("project_detail", project_id=project_id))
    _update_project_fields(project_id, {"default_image_prompt_id": prompt_id})
    flash("Default image prompt updated.", "success")
    return redirect(url_for("project_detail", project_id=project_id))


@app.post("/projects/<project_id>/wp-defaults")
def set_project_wp_defaults(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))

    proj = dict(project)
    wp_types, _ = _wp_post_types_for_project(proj)
    allowed = {t["rest_base"] for t in wp_types}
    rest_base = _normalize_wp_rest_base(request.form.get("default_wp_rest_base"), allowed)

    st = (request.form.get("default_wp_status") or "draft").strip().lower()
    if st not in ("draft", "publish"):
        st = "draft"

    _update_project_fields(project_id, {"default_wp_rest_base": rest_base, "default_wp_status": st})
    flash("Default WordPress post type and status saved.", "success")
    return redirect(url_for("project_detail", project_id=project_id))


@app.post("/projects/<project_id>/image-prompts/update")
def update_project_image_prompt(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))
    prompt_id = (request.form.get("image_prompt_id") or "").strip()
    name = (request.form.get("image_prompt_name") or "").strip()
    text = (request.form.get("image_prompt_text") or "").strip()
    if not prompt_id:
        flash("Missing prompt.", "error")
        return redirect(url_for("project_detail", project_id=project_id))
    if not name:
        flash("Please enter a prompt name.", "error")
        return redirect(url_for("project_detail", project_id=project_id))
    if not text:
        flash("Please enter the prompt text.", "error")
        return redirect(url_for("project_detail", project_id=project_id))

    proj = dict(project)
    _normalize_project_image_prompts(proj)
    prompts = list(proj.get("image_prompts") or [])
    found = False
    for i, p in enumerate(prompts):
        if isinstance(p, dict) and (p.get("id") or "") == prompt_id:
            prompts[i] = {"id": prompt_id, "name": name[:200], "text": text[:100_000]}
            found = True
            break
    if not found:
        flash("Prompt not found.", "error")
        return redirect(url_for("project_detail", project_id=project_id))

    updates: dict = {"image_prompts": prompts}
    if (request.form.get("set_as_default") or "") == "on":
        updates["default_image_prompt_id"] = prompt_id
    _update_project_fields(project_id, updates)
    flash(f"Image prompt “{name[:80]}” updated.", "success")
    return redirect(url_for("project_detail", project_id=project_id))


@app.post("/projects/<project_id>/image-prompts/delete")
def delete_project_image_prompt(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))
    prompt_id = (request.form.get("image_prompt_id") or "").strip()
    if not prompt_id:
        flash("Missing prompt.", "error")
        return redirect(url_for("project_detail", project_id=project_id))

    proj = dict(project)
    _normalize_project_image_prompts(proj)
    prompts = [p for p in (proj.get("image_prompts") or []) if isinstance(p, dict) and (p.get("id") or "") != prompt_id]
    if len(prompts) == len(proj.get("image_prompts") or []):
        flash("Prompt not found.", "error")
        return redirect(url_for("project_detail", project_id=project_id))

    updates: dict = {"image_prompts": prompts}
    default_id = (proj.get("default_image_prompt_id") or "").strip()
    if default_id == prompt_id:
        updates["default_image_prompt_id"] = (prompts[0].get("id") or "") if prompts else ""
    _update_project_fields(project_id, updates)
    flash("Image prompt removed.", "success")
    return redirect(url_for("project_detail", project_id=project_id))


def _validate_context_link_phrase(phrase: str) -> str | None:
    p = (phrase or "").strip()
    if not p:
        return "Text to match is required."
    if len(p) > 2000:
        return "Text is too long (max 2000 characters)."
    if "]" in p or "\n" in p or "\r" in p:
        return "Text cannot contain ] or line breaks."
    return None


@app.post("/projects/<project_id>/context-links/add")
def add_project_context_link(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))
    phrase = (request.form.get("link_phrase") or request.form.get("context_link_phrase") or "").strip()
    url = (request.form.get("link_url") or request.form.get("context_link_url") or "").strip()
    err = _validate_context_link_phrase(phrase)
    if err:
        flash(err, "error")
        return redirect(url_for("project_detail", project_id=project_id))
    if not _is_valid_context_link_url(url):
        flash("Enter a valid http(s) URL (no ) in the URL).", "error")
        return redirect(url_for("project_detail", project_id=project_id))

    proj = dict(project)
    _normalize_project_context_links(proj)
    links = list(proj.get("context_links") or [])
    new_id = str(uuid.uuid4())
    links.append({"id": new_id, "phrase": phrase[:2000], "url": url[:2048]})
    _update_project_fields(project_id, {"context_links": links})
    flash("Context link added.", "success")
    return redirect(url_for("project_detail", project_id=project_id))


@app.post("/projects/<project_id>/context-links/update")
def update_project_context_link(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))
    link_id = (request.form.get("context_link_id") or "").strip()
    phrase = (request.form.get("link_phrase") or "").strip()
    url = (request.form.get("link_url") or "").strip()
    if not link_id:
        flash("Missing link id.", "error")
        return redirect(url_for("project_detail", project_id=project_id))
    err = _validate_context_link_phrase(phrase)
    if err:
        flash(err, "error")
        return redirect(url_for("project_detail", project_id=project_id))
    if not _is_valid_context_link_url(url):
        flash("Enter a valid http(s) URL (no ) in the URL).", "error")
        return redirect(url_for("project_detail", project_id=project_id))

    proj = dict(project)
    _normalize_project_context_links(proj)
    links = list(proj.get("context_links") or [])
    found = False
    for i, item in enumerate(links):
        if isinstance(item, dict) and (item.get("id") or "") == link_id:
            links[i] = {"id": link_id, "phrase": phrase[:2000], "url": url[:2048]}
            found = True
            break
    if not found:
        flash("Link not found.", "error")
        return redirect(url_for("project_detail", project_id=project_id))
    _update_project_fields(project_id, {"context_links": links})
    flash("Context link updated.", "success")
    return redirect(url_for("project_detail", project_id=project_id))


@app.post("/projects/<project_id>/context-links/delete")
def delete_project_context_link(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))
    link_id = (request.form.get("context_link_id") or "").strip()
    if not link_id:
        flash("Missing link id.", "error")
        return redirect(url_for("project_detail", project_id=project_id))

    proj = dict(project)
    _normalize_project_context_links(proj)
    links = [x for x in (proj.get("context_links") or []) if isinstance(x, dict) and (x.get("id") or "") != link_id]
    if len(links) == len(proj.get("context_links") or []):
        flash("Link not found.", "error")
        return redirect(url_for("project_detail", project_id=project_id))
    _update_project_fields(project_id, {"context_links": links})
    flash("Context link removed.", "success")
    return redirect(url_for("project_detail", project_id=project_id))


@app.get("/oauth/google/start")
def google_oauth_start():
    try:
        import google_integration as gi
    except ImportError:
        flash(
            "Install Google client libraries: pip install google-api-python-client google-auth-oauthlib google-auth-httplib2",
            "error",
        )
        return redirect(url_for("home"))
    if not gi.oauth_client_configured():
        flash("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the environment.", "error")
        return redirect(url_for("home"))
    redirect_uri = url_for("google_oauth_callback", _external=True)
    flow = gi.build_flow(redirect_uri)
    state = secrets.token_hex(16)
    session["oauth_google_state"] = state
    authorization_url, _ = flow.authorization_url(
        access_type="offline",
        prompt="consent",
        state=state,
        include_granted_scopes="true",
    )
    return redirect(authorization_url)


@app.get("/oauth/google/callback")
def google_oauth_callback():
    try:
        import google_integration as gi
    except ImportError:
        flash("Google libraries are not installed.", "error")
        return redirect(url_for("home"))
    err = request.args.get("error")
    if err:
        flash(request.args.get("error_description") or "Google sign-in was cancelled or denied.", "error")
        return redirect(url_for("home"))
    if request.args.get("state") != session.pop("oauth_google_state", None):
        flash("Invalid OAuth state. Try connecting again.", "error")
        return redirect(url_for("home"))
    redirect_uri = url_for("google_oauth_callback", _external=True)
    flow = gi.build_flow(redirect_uri)
    try:
        flow.fetch_token(authorization_response=request.url)
    except Exception as e:
        flash(f"Could not complete Google sign-in: {e}", "error")
        return redirect(url_for("home"))
    creds = flow.credentials
    email = gi.fetch_user_email(creds)
    gi.save_oauth_session(creds, email)
    flash(
        f"Google account connected{f' ({email})' if email else ''}. Assign a Search Console property on each project as needed.",
        "success",
    )
    return redirect(url_for("home"))


@app.post("/oauth/google/disconnect")
def google_oauth_disconnect():
    try:
        import google_integration as gi

        gi.disconnect()
        flash("Google account disconnected from this app.", "success")
    except ImportError:
        pass
    return redirect(request.referrer or url_for("home"))


@app.post("/projects/<project_id>/gsc")
def update_project_gsc(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))
    prop = (request.form.get("gsc_property_url") or "").strip()
    index_on = (request.form.get("gsc_index_on_publish") or "") == "on"
    try:
        import google_integration as gi

        creds = gi.get_valid_credentials()
        if prop and creds:
            sites = {
                s.get("siteUrl")
                for s in gi.list_search_console_sites(creds)
                if isinstance(s, dict)
            }
            if prop not in sites:
                flash("That Search Console property is not in your connected account.", "error")
                return redirect(url_for("project_detail", project_id=project_id))
        elif prop and not creds:
            flash("Connect your Google account from the home page before choosing a property.", "error")
            return redirect(url_for("project_detail", project_id=project_id))
    except ImportError:
        pass
    _update_project_fields(
        project_id,
        {
            "gsc_property_url": prop,
            "gsc_index_on_publish": index_on,
        },
    )
    flash("Search Console settings saved for this project.", "success")
    return redirect(url_for("project_detail", project_id=project_id))


@app.post("/projects/<project_id>/delete")
def delete_project(project_id: str):
    pid = (project_id or "").strip()
    if not pid:
        flash("Invalid project.", "error")
        return redirect(url_for("home"))
    projects = _load_projects()
    before = len(projects)
    projects = [p for p in projects if (p.get("id") or "") != pid]
    if len(projects) == before:
        flash("Project not found.", "error")
        return redirect(url_for("home"))
    _save_projects(projects)
    arts = _load_articles()
    arts = [a for a in arts if (a.get("project_id") or "") != pid]
    _save_articles(arts)
    flash("Project removed.", "success")
    return redirect(url_for("home"))


@app.get("/projects/<project_id>")
def project_detail(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))
    date_from = request.args.get("date_from", "").strip()
    date_to = request.args.get("date_to", "").strip()
    status_filter = request.args.get("status", "").strip().lower()
    if status_filter not in {"pending", "draft", "published"}:
        status_filter = ""
    all_articles = _articles_for_project(project_id)
    article_count_total = len(all_articles)
    all_articles.sort(key=lambda a: (a.get("created_at") or ""), reverse=True)
    articles = _filter_articles_by_date_range(all_articles, date_from, date_to)
    articles = _filter_articles_by_status(articles, status_filter)
    proj = dict(project)
    _normalize_project_prompts(proj)
    _normalize_project_image_prompts(proj)
    _normalize_project_wp_defaults(proj)
    _normalize_project_context_links(proj)
    _normalize_project_gsc(proj)
    wp_post_types, wp_post_types_error = _wp_post_types_for_project(proj)
    gsc_sites: list[dict] = []
    gsc_google_connected = False
    gsc_oauth_env_configured = bool(
        (os.environ.get("GOOGLE_OAUTH_CLIENT_ID") or "").strip()
        and (os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET") or "").strip()
    )
    gsc_google_email = None
    gsc_google_libs_missing = False
    try:
        import google_integration as gi

        gsc_google_email = gi.get_stored_email()
        creds = gi.get_valid_credentials()
        gsc_google_connected = creds is not None
        if creds:
            try:
                gsc_sites = gi.list_search_console_sites(creds)
            except Exception as e:
                app.logger.warning("Could not list Google Search Console sites: %s", e)
                gsc_sites = []
    except ImportError:
        gsc_google_libs_missing = True
    bulk_schedule_meta: list[dict] = []
    for a in articles:
        aid = (a.get("id") or "").strip()
        if not aid:
            continue
        bulk_schedule_meta.append(
            {
                "id": aid,
                "created_at": (a.get("created_at") or "").strip(),
                "hasBody": bool((a.get("article") or "").strip()),
                "hasImage": bool(os.path.isfile(_article_featured_image_path(aid))),
            }
        )
    open_settings = request.args.get("open_settings", "").strip().lower() in ("1", "true", "yes")
    poll_articles_wp = any(
        (a.get("wp_scheduled_at") or "").strip()
        for a in articles
    ) or any(
        (a.get("wp_post_id") and (a.get("status") or "").strip().lower() == "pending")
        for a in articles
    ) or any(
        ((a.get("posted_at") or "").strip() and (a.get("status") or "").strip().lower() == "pending")
        for a in articles
    )
    scheduled_pending_articles = _pending_scheduled_article_rows(project_id)

    def _status_filter_qs(st: str) -> str:
        st = st.strip().lower()
        if st not in {"pending", "draft", "published"}:
            st = ""
        return urlencode(
            {k: v for k, v in [("date_from", date_from), ("date_to", date_to), ("status", st)] if v}
        )

    article_status_filter_qs = {
        "all": _status_filter_qs(""),
        "pending": _status_filter_qs("pending"),
        "draft": _status_filter_qs("draft"),
        "published": _status_filter_qs("published"),
    }
    return render_template(
        "project.html",
        project=proj,
        articles=articles,
        date_from=date_from,
        date_to=date_to,
        article_count_total=article_count_total,
        bulk_schedule_meta=bulk_schedule_meta,
        scheduled_pending_articles=scheduled_pending_articles,
        status_filter=status_filter,
        article_status_filter_qs=article_status_filter_qs,
        project_settings_incomplete=not _project_wp_credentials_configured(proj),
        open_project_settings_modal=open_settings,
        poll_articles_wp=poll_articles_wp,
        wp_post_types=wp_post_types,
        wp_post_types_error=wp_post_types_error,
        gsc_sites=gsc_sites,
        gsc_google_connected=gsc_google_connected,
        gsc_oauth_env_configured=gsc_oauth_env_configured,
        gsc_google_email=gsc_google_email,
        gsc_google_libs_missing=gsc_google_libs_missing,
    )


@app.get("/projects/<project_id>/articles/status-summary")
def project_articles_status_summary(project_id: str):
    """JSON for refreshing article status/posted/scheduled columns without a full page reload."""
    project = _get_project_by_id(project_id)
    if not project:
        return jsonify({"error": "not found"}), 404
    date_from = request.args.get("date_from", "").strip()
    date_to = request.args.get("date_to", "").strip()
    status_filter = request.args.get("status", "").strip().lower()
    if status_filter not in {"pending", "draft", "published"}:
        status_filter = ""
    all_articles = _articles_for_project(project_id)
    all_articles.sort(key=lambda a: (a.get("created_at") or ""), reverse=True)
    articles = _filter_articles_by_date_range(all_articles, date_from, date_to)
    articles = _filter_articles_by_status(articles, status_filter)
    out: list[dict] = []
    for a in articles:
        aid = (a.get("id") or "").strip()
        if not aid:
            continue
        st = (a.get("status") or "pending").strip().lower()
        if st not in {"pending", "draft", "published"}:
            st = "pending"
        gs = (a.get("gsc_status") or "pending").strip().lower()
        if gs not in {"pending", "requested"}:
            gs = "pending"
        out.append(
            {
                "id": aid,
                "status": st,
                "posted_at": (a.get("posted_at") or "").strip(),
                "wp_scheduled_at": (a.get("wp_scheduled_at") or "").strip(),
                "wp_schedule_error": (a.get("wp_schedule_error") or "").strip(),
                "gsc_status": gs,
            }
        )
    return jsonify({"articles": out})


@app.get("/projects/<project_id>/articles/export")
def export_project_articles(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))
    date_from = request.args.get("date_from", "").strip()
    date_to = request.args.get("date_to", "").strip()
    status_filter = request.args.get("status", "").strip().lower()
    if status_filter not in {"pending", "draft", "published"}:
        status_filter = ""
    all_articles = _articles_for_project(project_id)
    all_articles.sort(key=lambda a: (a.get("created_at") or ""), reverse=True)
    filtered = _filter_articles_by_date_range(all_articles, date_from, date_to)
    filtered = _filter_articles_by_status(filtered, status_filter)
    safe_name = re.sub(r"[^a-zA-Z0-9\-_]+", "_", project.get("name") or "project")[:60] or "project"
    filename = f"{safe_name}_articles.xlsx"
    data = _build_articles_excel_bytes(filtered)
    return Response(
        data,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/projects/<project_id>/articles/bulk/sample")
def bulk_upload_sample(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))
    safe_name = re.sub(r"[^a-zA-Z0-9\-_]+", "_", project.get("name") or "project")[:60] or "project"
    filename = f"{safe_name}_bulk_upload_sample.xlsx"
    data = _build_bulk_upload_sample_bytes()
    return Response(
        data,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/projects/<project_id>/articles/bulk/upload")
def bulk_upload_articles(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))

    file = request.files.get("file")
    if not file or not getattr(file, "filename", ""):
        flash("Please choose an Excel file to upload.", "error")
        return redirect(url_for("project_detail", project_id=project_id))

    try:
        from openpyxl import load_workbook

        wb = load_workbook(file, data_only=True)
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            raise ValueError("The uploaded sheet is empty.")

        header = [_normalize_bulk_sheet_header_cell(x) for x in rows[0]]

        def col_idx(*names: str) -> int | None:
            for name in names:
                if name in header:
                    return header.index(name)
            return None

        idx_title = col_idx("title")
        idx_focus = col_idx("focus_keyphrase")
        idx_keywords = col_idx("targeting_keywords", "keywords")
        if idx_title is None:
            raise ValueError("Missing required column: title")

        to_add: list[dict] = []
        errors: list[str] = []

        for r_i, row in enumerate(rows[1:], start=2):
            title = ""
            if idx_title < len(row) and row[idx_title] is not None:
                title = str(row[idx_title]).strip()
            if not title:
                # skip completely blank rows
                if all((c is None or str(c).strip() == "") for c in row):
                    continue
                errors.append(f"Row {r_i}: title is required.")
                continue

            fk_raw = ""
            if idx_focus is not None and idx_focus < len(row) and row[idx_focus] is not None:
                fk_raw = str(row[idx_focus]).strip()
            fk_val, fk_err = _parse_focus_keyphrase_single_field(fk_raw)
            if fk_err:
                errors.append(f"Row {r_i}: {fk_err}")
                continue

            kw_raw = ""
            if idx_keywords is not None and idx_keywords < len(row) and row[idx_keywords] is not None:
                kw_raw = str(row[idx_keywords]).strip()
            keywords = _parse_keywords(kw_raw)
            if len(keywords) > 10:
                errors.append(f"Row {r_i}: maximum 10 keywords allowed.")
                continue

            to_add.append(
                {
                    "id": str(uuid.uuid4()),
                    "project_id": project_id,
                    "title": title[:500],
                    "keywords": keywords,
                    "status": "pending",
                    "article": "",
                    "focus_keyphrase": (fk_val or "")[:500],
                    "meta_title": "",
                    "meta_description": "",
                    "generated_at": "",
                    "posted_at": "",
                    "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "gsc_status": "pending",
                }
            )

        if errors:
            flash("Bulk upload failed: " + " ".join(errors[:6]) + (" ..." if len(errors) > 6 else ""), "error")
            return redirect(url_for("project_detail", project_id=project_id))

        if not to_add:
            flash("No valid rows found to import.", "error")
            return redirect(url_for("project_detail", project_id=project_id))

        arts = _load_articles()
        arts.extend(to_add)
        _save_articles(arts)
        flash(f"Imported {len(to_add)} articles.", "success")
        return redirect(url_for("project_detail", project_id=project_id))
    except Exception as e:
        flash(f"Bulk upload failed: {e}", "error")
        return redirect(url_for("project_detail", project_id=project_id))


def _project_detail_redirect_query_from_parts(date_from: str, date_to: str, filter_status: str) -> str:
    df = (date_from or "").strip()
    dt = (date_to or "").strip()
    fs = (filter_status or "").strip().lower()
    if fs not in {"pending", "draft", "published"}:
        fs = ""
    return urlencode({k: v for k, v in [("date_from", df), ("date_to", dt), ("status", fs)] if v})


@app.post("/projects/<project_id>/articles/status-batch")
def batch_update_article_statuses(project_id: str):
    """Apply multiple article status changes in one request (JSON)."""
    project = _get_project_by_id(project_id)
    if not project:
        return jsonify({"ok": False, "error": "Project not found."}), 404
    data = request.get_json(silent=True) or {}
    updates = data.get("updates")
    if not isinstance(updates, list) or not updates:
        return jsonify({"ok": False, "error": "No updates."}), 400

    changed = 0
    for u in updates:
        if not isinstance(u, dict):
            continue
        aid = (u.get("id") or "").strip()
        raw = (u.get("status") or "").strip().lower()
        if raw not in {"pending", "draft", "published"}:
            continue
        article = _get_article_by_id(aid)
        if not article or (article.get("project_id") or "") != project_id:
            continue
        _update_article_fields(aid, {"status": raw})
        changed += 1

    if changed == 0:
        return jsonify({"ok": False, "error": "No valid articles updated."}), 400

    df = (data.get("date_from") or "").strip()
    dt = (data.get("date_to") or "").strip()
    fs = (data.get("filter_status") or "").strip().lower()
    q = _project_detail_redirect_query_from_parts(df, dt, fs)
    base = url_for("project_detail", project_id=project_id)
    redirect_url = base + ("?" + q if q else "")
    return jsonify({"ok": True, "changed": changed, "redirect": redirect_url})


@app.post("/projects/<project_id>/articles/<article_id>/status")
def update_article_status(project_id: str, article_id: str):
    project = _get_project_by_id(project_id)
    article = _get_article_by_id(article_id)
    if not project or not article or (article.get("project_id") or "") != project_id:
        flash("Article not found.", "error")
        return redirect(url_for("home"))
    raw = (request.form.get("status") or "").strip().lower()
    if raw not in {"pending", "draft", "published"}:
        flash("Invalid status.", "error")
        df = request.form.get("date_from", "").strip()
        dt = request.form.get("date_to", "").strip()
        fs = request.form.get("filter_status", "").strip().lower()
        q = _project_detail_redirect_query_from_parts(df, dt, fs)
        url = url_for("project_detail", project_id=project_id)
        return redirect(url + ("?" + q if q else ""))
    _update_article_fields(article_id, {"status": raw})
    flash("Status updated.", "success")
    df = request.form.get("date_from", "").strip()
    dt = request.form.get("date_to", "").strip()
    fs = request.form.get("filter_status", "").strip().lower()
    q = _project_detail_redirect_query_from_parts(df, dt, fs)
    url = url_for("project_detail", project_id=project_id)
    return redirect(url + ("?" + q if q else ""))


@app.post("/projects/<project_id>/articles/<article_id>/schedule/cancel")
def cancel_article_schedule(project_id: str, article_id: str):
    project = _get_project_by_id(project_id)
    article = _get_article_by_id(article_id)
    if not project or not article or (article.get("project_id") or "") != project_id:
        flash("Article not found.", "error")
        return redirect(url_for("home"))
    if article.get("wp_post_id"):
        flash("This article is already posted to WordPress.", "error")
        return _redirect_project_detail_with_dates(project_id)
    if not (article.get("wp_scheduled_at") or "").strip():
        flash("Nothing to cancel — this article is not scheduled.", "error")
        return _redirect_project_detail_with_dates(project_id)
    _update_article_fields(article_id, _cleared_wp_schedule_fields())
    flash("Scheduled post cancelled for this article.", "success")
    return _redirect_project_detail_with_dates(project_id)


@app.post("/projects/<project_id>/articles/<article_id>/schedule/update")
def update_article_schedule(project_id: str, article_id: str):
    project = _get_project_by_id(project_id)
    article = _get_article_by_id(article_id)
    if not project or not article or (article.get("project_id") or "") != project_id:
        flash("Article not found.", "error")
        return redirect(url_for("home"))
    if article.get("wp_post_id"):
        flash("This article is already posted to WordPress.", "error")
        return _redirect_project_detail_with_dates(project_id)
    if not (article.get("wp_scheduled_at") or "").strip():
        flash("This article is not scheduled.", "error")
        return _redirect_project_detail_with_dates(project_id)
    if not _is_project_wordpress_configured(project):
        flash("Configure WordPress for this project before editing a schedule.", "error")
        return _redirect_project_detail_with_dates(project_id)

    raw_dt = (request.form.get("schedule_at") or "").strip()
    dt = _parse_bulk_schedule_datetime(raw_dt)
    if not dt:
        flash("Please enter a valid date and time.", "error")
        return _redirect_project_detail_with_dates(project_id)
    dt = _clamp_future_schedule_dt(dt)
    sched_str = dt.strftime("%Y-%m-%d %H:%M:%S")

    wp_st = (request.form.get("schedule_wp_status") or "draft").strip().lower()
    if wp_st not in ("draft", "publish"):
        wp_st = "draft"

    _update_article_fields(
        article_id,
        {
            "wp_scheduled_at": sched_str,
            "wp_schedule_wp_status": wp_st,
            "wp_schedule_error": "",
            "wp_schedule_batch_id": "",
            "wp_schedule_batch_index": "",
            "wp_schedule_batch_total": "",
        },
    )
    flash("Schedule updated.", "success")
    return _redirect_project_detail_with_dates(project_id)


@app.post("/projects/<project_id>/articles/bulk-action")
def bulk_articles_action(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))
    action = (request.form.get("action") or "").strip().lower()
    ids = [x.strip() for x in request.form.getlist("article_ids") if x.strip()]
    if not ids:
        flash("No articles selected.", "error")
        return _redirect_project_detail_with_dates(project_id)

    arts = _load_articles()
    id_set = set(ids)
    targets = [
        a
        for a in arts
        if (a.get("id") or "") in id_set and (a.get("project_id") or "") == project_id
    ]
    if not targets:
        flash("No matching articles for this project.", "error")
        return _redirect_project_detail_with_dates(project_id)

    if action == "delete":
        del_ids = {(t.get("id") or "") for t in targets}
        new_arts = [a for a in arts if (a.get("id") or "") not in del_ids]
        for t in targets:
            _delete_article_featured_image_file((t.get("id") or "").strip())
        _save_articles(new_arts)
        flash(f"Deleted {len(targets)} article(s).", "success")
        return _redirect_project_detail_with_dates(project_id)

    if action == "change_status":
        raw = (request.form.get("new_status") or "").strip().lower()
        if raw not in {"pending", "draft", "published"}:
            flash("Invalid status.", "error")
            return _redirect_project_detail_with_dates(project_id)
        for t in targets:
            _update_article_fields((t.get("id") or "").strip(), {"status": raw})
        flash(f"Updated status for {len(targets)} article(s).", "success")
        return _redirect_project_detail_with_dates(project_id)

    if action == "schedule":
        if not _is_project_wordpress_configured(project):
            flash("Configure WordPress for this project before scheduling posts.", "error")
            return _redirect_project_detail_with_dates(project_id)
        wp_st = (request.form.get("schedule_wp_status") or "draft").strip().lower()
        if wp_st not in ("draft", "publish"):
            wp_st = "draft"

        proj_check = dict(project)
        _normalize_project_image_prompts(proj_check)
        need_img = len(proj_check.get("image_prompts") or []) > 0
        for t in targets:
            aid = (t.get("id") or "").strip()
            if not aid or t.get("wp_post_id"):
                continue
            need_body = not (t.get("article") or "").strip()
            need_img_file = need_img and not os.path.isfile(_article_featured_image_path(aid))
            if not need_body and not need_img_file:
                continue
            if not (t.get("title") or "").strip():
                flash(
                    "Cannot generate or schedule: one or more selected articles have no title. Add a title first.",
                    "error",
                )
                return _redirect_project_detail_with_dates(project_id)

        form_snapshot = {
            "schedule_wp_status": wp_st,
            "schedule_wp_rest_base": (request.form.get("schedule_wp_rest_base") or "").strip(),
            "bulk_prompt_id": (request.form.get("bulk_prompt_id") or "").strip(),
            "bulk_image_prompt_id": (request.form.get("bulk_image_prompt_id") or "").strip(),
            "schedule_times_json": request.form.get("schedule_times_json") or "",
        }
        threading.Thread(
            target=_bulk_schedule_thread_entry,
            args=(project_id, list(ids), form_snapshot),
            daemon=True,
        ).start()
        flash(
            "Scheduling is running in the background. Refresh the page in a minute to see scheduled times. "
            "If times were in the past, they were adjusted to a few minutes from now. "
            "You can keep using the app while this completes; check the server log if something fails.",
            "success",
        )
        return _redirect_project_detail_with_dates(project_id)

    flash("Unknown bulk action.", "error")
    return _redirect_project_detail_with_dates(project_id)


@app.post("/projects/<project_id>/articles")
def add_project_article(project_id: str):
    project = _get_project_by_id(project_id)
    if not project:
        flash("Project not found.", "error")
        return redirect(url_for("home"))
    title = (request.form.get("title") or "").strip()
    keywords_raw = request.form.get("keywords") or ""
    if not title:
        flash("Please enter an article title.", "error")
        return redirect(url_for("project_detail", project_id=project_id))
    keywords = _parse_keywords(keywords_raw)
    if len(keywords) > 10:
        flash("Maximum 10 targeting keywords allowed.", "error")
        return redirect(url_for("project_detail", project_id=project_id))
    fk_val, fk_err = _parse_focus_keyphrase_single_field(request.form.get("focus_keyphrase") or "")
    if fk_err:
        flash(fk_err, "error")
        return redirect(url_for("project_detail", project_id=project_id))
    arts = _load_articles()
    arts.append(
        {
            "id": str(uuid.uuid4()),
            "project_id": project_id,
            "title": title[:500],
            "keywords": keywords,
            "status": "pending",
            "article": "",
            "focus_keyphrase": (fk_val or "")[:500],
            "meta_title": "",
            "meta_description": "",
            "generated_at": "",
            "posted_at": "",
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "gsc_status": "pending",
        }
    )
    _save_articles(arts)
    flash("Article added.", "success")
    return redirect(url_for("project_detail", project_id=project_id))


@app.get("/projects/<project_id>/articles/<article_id>")
def article_edit(project_id: str, article_id: str):
    project = _get_project_by_id(project_id)
    article = _get_article_by_id(article_id)
    if not project or not article or (article.get("project_id") or "") != project_id:
        flash("Article not found.", "error")
        return redirect(url_for("home"))
    last = _article_to_last(article)
    proj = dict(project)
    _normalize_project_prompts(proj)
    _normalize_project_wp_defaults(proj)
    default_prompt = _get_prompt_by_id(proj, (proj.get("default_prompt_id") or "").strip())
    _normalize_project_image_prompts(proj)
    default_image_prompt = _get_image_prompt_by_id(proj, (proj.get("default_image_prompt_id") or "").strip())
    aid = (article.get("id") or "").strip()
    has_featured_image = bool(aid and os.path.isfile(_article_featured_image_path(aid)))
    requires_featured_image = len(proj.get("image_prompts") or []) > 0
    wp_post_types, wp_post_types_error = _wp_post_types_for_project(proj)
    allowed_bases = {t["rest_base"] for t in wp_post_types}
    project_default_wp_rest_base = _normalize_wp_rest_base((proj.get("default_wp_rest_base") or "posts"), allowed_bases)
    selected_wp_rest_base = _normalize_wp_rest_base((article.get("wp_rest_base") or project_default_wp_rest_base), allowed_bases)
    wp_status_default = (proj.get("default_wp_status") or "draft").strip().lower()
    if wp_status_default not in ("draft", "publish"):
        wp_status_default = "draft"
    selected_wp_status = (article.get("wp_last_wp_status") or "").strip().lower() or wp_status_default
    if selected_wp_status not in ("draft", "publish"):
        selected_wp_status = wp_status_default
    return render_template(
        "article_edit.html",
        project=proj,
        article=article,
        last=last,
        default_prompt_name=(default_prompt.get("name") if default_prompt else None),
        default_prompt_id=(proj.get("default_prompt_id") or "").strip(),
        default_image_prompt_name=(default_image_prompt.get("name") if default_image_prompt else None),
        default_image_prompt_id=(proj.get("default_image_prompt_id") or "").strip(),
        has_featured_image=has_featured_image,
        requires_featured_image=requires_featured_image,
        wp_post_types=wp_post_types,
        wp_post_types_error=wp_post_types_error,
        selected_wp_rest_base=selected_wp_rest_base,
        project_default_wp_rest_base=project_default_wp_rest_base,
        selected_wp_status=selected_wp_status,
        project_default_wp_status=wp_status_default,
        project_settings_incomplete=not _project_wp_credentials_configured(proj),
    )


@app.get("/projects/<project_id>/articles/<article_id>/featured-image.png")
def serve_article_featured_image(project_id: str, article_id: str):
    project = _get_project_by_id(project_id)
    article = _get_article_by_id(article_id)
    if not project or not article or (article.get("project_id") or "") != project_id:
        return Response("Not found", 404)
    path = _article_featured_image_path(article_id)
    if not os.path.isfile(path):
        return Response("Not found", 404)
    resp = send_file(path, mimetype="image/png")
    resp.headers["Cache-Control"] = "no-cache, max-age=0"
    return resp


def _generate_article_content_core(
    project: dict,
    article_id: str,
    *,
    title: str,
    keywords: list[str],
    writing_prompt_id: str,
    image_prompt_id: str,
    user_focus_keyphrase: str | None = None,
) -> tuple[bool, str | None, str | None]:
    """
    Shared article + optional featured image generation (same as article edit Generate).
    Returns (ok, error_message, image_error_message). image_error_message is set when
    article saved but DALL·E failed (ok is still True).
    """
    api_key: str | None = None
    proj = dict(project)
    _normalize_project_prompts(proj)
    _normalize_project_image_prompts(proj)
    form_prompt_id = (writing_prompt_id or "").strip()
    if form_prompt_id:
        sel = _get_prompt_by_id(proj, form_prompt_id)
        if not sel:
            return False, "Invalid writing prompt selection.", None
        article_prompt = (sel.get("text") or "").strip() or None
    else:
        article_prompt = _resolve_default_prompt_text(proj)
    site_url = (project.get("website_url") or project.get("wp_site_url") or "").strip() or None
    fk_preset = (user_focus_keyphrase or "").strip() or None

    image_prompts_list = proj.get("image_prompts") or []
    form_image_prompt_id = (image_prompt_id or "").strip()
    image_prompt_raw: str | None = None
    used_image_prompt_id = ""
    if image_prompts_list:
        if form_image_prompt_id:
            ip = _get_image_prompt_by_id(proj, form_image_prompt_id)
            if not ip:
                return False, "Invalid image prompt selection.", None
            image_prompt_raw = (ip.get("text") or "").strip() or None
            used_image_prompt_id = form_image_prompt_id
        else:
            image_prompt_raw = _resolve_default_image_prompt_text(proj)
            did = (proj.get("default_image_prompt_id") or "").strip()
            if did:
                used_image_prompt_id = did
        if not image_prompt_raw:
            return (
                False,
                "This project has image prompts but none could be used. "
                "Set a default image prompt on the project page or pick prompts in the schedule dialog.",
                None,
            )

    run_image = bool(image_prompts_list and image_prompt_raw)
    interpolated_image_prompt: str | None = None
    if run_image and image_prompt_raw:
        interpolated_image_prompt = _interpolate_article_prompt_template(
            image_prompt_raw, title, keywords, fk_preset
        )

    _delete_article_featured_image_file(article_id)

    article_md = ""
    yoast: dict = {}
    image_bytes: bytes | None = None
    image_err: str | None = None

    try:
        # Keep peak memory low on small instances (e.g. Render free/starter):
        # generate article + yoast in parallel, but run image generation after.
        with ThreadPoolExecutor(max_workers=2) as ex:
            fut_article = ex.submit(
                _generate_article_markdown,
                title,
                keywords,
                api_key,
                article_prompt=article_prompt,
                focus_keyphrase=fk_preset,
            )
            fut_yoast = ex.submit(
                _generate_yoast_fields,
                title,
                keywords,
                api_key,
                website_context_url=site_url,
                focus_keyphrase_preset=fk_preset,
            )
            article_md = fut_article.result()
            yoast = fut_yoast.result()
    except Exception as e:
        return False, str(e), None

    if run_image and interpolated_image_prompt:
        try:
            image_bytes = _generate_featured_image_png_bytes(interpolated_image_prompt)
        except Exception as e:
            image_err = str(e)

    gen_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    fi_time = ""
    if run_image and image_bytes:
        try:
            _save_article_featured_image_png(article_id, image_bytes)
            fi_time = gen_time
        except Exception as e:
            image_err = image_err or str(e)
    elif run_image and image_err:
        pass

    fk_stored = (yoast.get("focus_keyphrase") or "").strip()
    if fk_preset:
        fk_stored = fk_preset
    upd: dict = {
        "title": title[:500],
        "keywords": keywords,
        "article": (article_md or "").strip(),
        "focus_keyphrase": fk_stored,
        "meta_title": (yoast.get("meta_title") or "").strip(),
        "meta_description": (yoast.get("meta_description") or "").strip(),
        "generated_at": gen_time,
        "status": "pending",
        "featured_image_generated_at": fi_time,
        "featured_image_prompt_id": used_image_prompt_id if (run_image and image_bytes) else "",
        "featured_image_source": ("generated" if (run_image and image_bytes) else ""),
    }
    if not run_image:
        upd["featured_image_generated_at"] = ""
        upd["featured_image_prompt_id"] = ""
        upd["featured_image_source"] = ""

    _update_article_fields(article_id, upd)
    return True, None, image_err


@app.post("/projects/<project_id>/articles/<article_id>/generate")
def generate_project_article(project_id: str, article_id: str):
    project = _get_project_by_id(project_id)
    article = _get_article_by_id(article_id)
    if not project or not article or (article.get("project_id") or "") != project_id:
        flash("Article not found.", "error")
        return redirect(url_for("home"))

    title = (request.form.get("title") or "").strip()
    keywords_raw = request.form.get("keywords") or ""
    keywords = _parse_keywords(keywords_raw)

    if not title:
        flash("Please enter an article title.", "error")
        return redirect(url_for("article_edit", project_id=project_id, article_id=article_id))

    if not keywords:
        flash("Please enter at least one targeting keyword (comma-separated, max 10).", "error")
        return redirect(url_for("article_edit", project_id=project_id, article_id=article_id))

    if len(keywords) > 10:
        flash("Maximum 10 targeting keywords allowed.", "error")
        return redirect(url_for("article_edit", project_id=project_id, article_id=article_id))

    fk_val, fk_err = _parse_focus_keyphrase_single_field(request.form.get("focus_keyphrase") or "")
    if fk_err:
        flash(fk_err, "error")
        return redirect(url_for("article_edit", project_id=project_id, article_id=article_id))
    user_fk = (fk_val or "").strip() or None

    proj = dict(project)
    ok, err, image_err = _generate_article_content_core(
        proj,
        article_id,
        title=title,
        keywords=keywords,
        writing_prompt_id=(request.form.get("prompt_id") or "").strip(),
        image_prompt_id=(request.form.get("image_prompt_id") or "").strip(),
        user_focus_keyphrase=user_fk,
    )
    if not ok:
        flash(f"Generation failed: {err}", "error")
        return redirect(url_for("article_edit", project_id=project_id, article_id=article_id))

    run_image = len((proj.get("image_prompts") or [])) > 0
    if run_image and not image_err:
        flash("Article and featured image generated. You can post to WordPress.", "success")
    elif run_image and image_err:
        flash(f"Article generated, but featured image failed: {image_err}", "error")
    else:
        flash("Article generated. You can post to WordPress as Draft or Published.", "success")
    return redirect(url_for("article_edit", project_id=project_id, article_id=article_id))


@app.post("/projects/<project_id>/articles/<article_id>/save-body")
def save_article_body(project_id: str, article_id: str):
    project = _get_project_by_id(project_id)
    article = _get_article_by_id(article_id)
    if not project or not article or (article.get("project_id") or "") != project_id:
        if request.headers.get("X-Requested-With") == "XMLHttpRequest":
            return jsonify({"ok": False, "error": "not_found"}), 404
        flash("Article not found.", "error")
        return redirect(url_for("home"))

    body = request.form.get("article_body")
    if body is None:
        body = ""
    _update_article_fields(article_id, {"article": body[:500_000]})

    wants_json = request.headers.get("X-Requested-With") == "XMLHttpRequest"
    if wants_json:
        return jsonify({"ok": True})
    flash("Article saved.", "success")
    return redirect(url_for("article_edit", project_id=project_id, article_id=article_id))


@app.post("/projects/<project_id>/articles/<article_id>/featured-image/clear")
def clear_article_featured_image(project_id: str, article_id: str):
    project = _get_project_by_id(project_id)
    article = _get_article_by_id(article_id)
    if not project or not article or (article.get("project_id") or "") != project_id:
        flash("Article not found.", "error")
        return redirect(url_for("home"))

    _delete_article_featured_image_file(article_id)
    _update_article_fields(
        article_id,
        {
            "featured_image_generated_at": "",
            "featured_image_prompt_id": "",
            "featured_image_source": "",
        },
    )
    flash("Featured image removed. You can generate a new one or upload one image.", "success")
    return redirect(url_for("article_edit", project_id=project_id, article_id=article_id))


@app.post("/projects/<project_id>/articles/<article_id>/featured-image/upload")
def upload_article_featured_image(project_id: str, article_id: str):
    project = _get_project_by_id(project_id)
    article = _get_article_by_id(article_id)
    if not project or not article or (article.get("project_id") or "") != project_id:
        flash("Article not found.", "error")
        return redirect(url_for("home"))

    if os.path.isfile(_article_featured_image_path(article_id)):
        flash("Clear the current featured image before uploading a new one.", "error")
        return redirect(url_for("article_edit", project_id=project_id, article_id=article_id))

    f = request.files.get("file")
    if not f or not getattr(f, "filename", ""):
        flash("Choose one image file to upload.", "error")
        return redirect(url_for("article_edit", project_id=project_id, article_id=article_id))

    raw = f.read()
    if len(raw) > _MAX_FEATURED_UPLOAD_BYTES:
        flash(f"Image is too large (max { _MAX_FEATURED_UPLOAD_BYTES // (1024 * 1024) } MB).", "error")
        return redirect(url_for("article_edit", project_id=project_id, article_id=article_id))

    try:
        png = _convert_upload_to_png_bytes(raw)
    except Exception as e:
        flash(f"Could not read that image. Use PNG, JPEG, WebP, or GIF. ({e})", "error")
        return redirect(url_for("article_edit", project_id=project_id, article_id=article_id))

    try:
        _save_article_featured_image_png(article_id, png)
    except OSError as e:
        flash(f"Could not save image: {e}", "error")
        return redirect(url_for("article_edit", project_id=project_id, article_id=article_id))

    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    _update_article_fields(
        article_id,
        {
            "featured_image_generated_at": ts,
            "featured_image_prompt_id": "",
            "featured_image_source": "uploaded",
        },
    )
    flash("Featured image saved. It will be used when you post to WordPress.", "success")
    return redirect(url_for("article_edit", project_id=project_id, article_id=article_id))


def _execute_wordpress_post_from_last(last: dict) -> tuple[bool, str | None, dict]:
    """
    Uses request.form. Returns (ok, error_message, info) where info may include
    post_id, link, wp_status in {"draft", "publish"}.
    """
    if not last or not last.get("article"):
        return False, "Generate an article first before posting to WordPress.", {}

    site_url = (request.form.get("wp_site_url") or "").strip()
    username = (request.form.get("wp_username") or "").strip()
    app_password = (request.form.get("wp_app_password") or "").strip()
    remember = (request.form.get("wp_remember") or "") == "on"

    status = (request.form.get("wp_status") or "draft").strip().lower()
    if status not in {"draft", "publish"}:
        status = "draft"

    title = (request.form.get("wp_title") or "").strip() or (last.get("title") or "").strip()
    tags_raw = request.form.get("wp_tags") or ""
    tags = _parse_keywords(tags_raw)

    cat_raw = (request.form.get("wp_category_ids") or "").strip()
    category_ids: list[int] = []
    if cat_raw:
        for part in cat_raw.split(","):
            part = part.strip()
            if not part:
                continue
            if part.isdigit():
                category_ids.append(int(part))

    excerpt = (request.form.get("wp_excerpt") or "").strip() or None
    focus_keyphrase = (request.form.get("wp_focus_keyphrase") or "").strip() or (last.get("focus_keyphrase") or "").strip() or None
    meta_title = (request.form.get("wp_meta_title") or "").strip() or (last.get("meta_title") or "").strip() or None
    meta_description = (request.form.get("wp_meta_description") or "").strip() or (last.get("meta_description") or "").strip() or None

    if remember:
        session["wp_site_url"] = site_url
        session["wp_username"] = username
        session["wp_app_password"] = app_password
        session["wp_focus_keyphrase"] = focus_keyphrase or ""
        session["wp_meta_title"] = meta_title or ""
        session["wp_meta_description"] = meta_description or ""

    try:
        cfg = WordPressConfig(site_url=site_url, username=username, application_password=app_password)
        html = _article_body_to_wp_html(last["article"], None)
        if not html:
            raise ValueError("Generated article was empty after formatting.")

        tag_ids = ensure_tag_ids(cfg, tags) if tags else []
        yoast_meta = {}
        if focus_keyphrase:
            yoast_meta["_yoast_wpseo_focuskw"] = focus_keyphrase
        if meta_title:
            yoast_meta["_yoast_wpseo_title"] = meta_title
        if meta_description:
            yoast_meta["_yoast_wpseo_metadesc"] = meta_description

        created = create_post(
            cfg,
            title=title or "Untitled",
            html_content=html,
            status=status,
            excerpt=excerpt,
            tag_ids=tag_ids,
            category_ids=category_ids,
            meta=yoast_meta or None,
        )

        return True, None, {
            "post_id": created.get("id"),
            "link": created.get("link") or "",
            "wp_status": status,
        }
    except Exception as e:
        return False, str(e), {}


def _post_article_to_wordpress(
    project: dict,
    article: dict,
    article_id: str,
    *,
    wp_status: str = "draft",
    rest_base_preference: str | None = None,
    site_url_override: str | None = None,
    allow_without_featured_image: bool = False,
) -> tuple[bool, str | None, dict]:
    """
    Post one article to WordPress using project credentials.
    Returns (ok, error_message, info) with post_id, link, wp_status, rest_base on success.
    """
    last = _article_to_last(article)
    if not (last.get("article") or "").strip():
        return False, "Article body is empty.", {}

    if not _is_project_wordpress_configured(project):
        return False, "WordPress is not configured for this project.", {}

    proj_check = dict(project)
    _normalize_project_image_prompts(proj_check)
    need_featured = len(proj_check.get("image_prompts") or []) > 0
    has_file = os.path.isfile(_article_featured_image_path(article_id))
    if need_featured and not has_file and not allow_without_featured_image:
        return False, "Featured image is required before posting (generate, upload, or confirm posting without an image).", {}

    site_url = (site_url_override or "").strip() or (project.get("wp_site_url") or project.get("website_url") or "").strip()
    status = wp_status if wp_status in {"draft", "publish"} else "draft"
    tags = last.get("keywords") or []

    category_ids: list[int] = []
    cat_raw = (project.get("wp_category_ids") or "").strip()
    if cat_raw:
        for part in cat_raw.split(","):
            part = part.strip()
            if part.isdigit():
                category_ids.append(int(part))

    excerpt = None
    focus_keyphrase = (last.get("focus_keyphrase") or "").strip() or None
    meta_title = (last.get("meta_title") or "").strip() or None
    meta_description = (last.get("meta_description") or "").strip() or None

    wp_types, _ = _wp_post_types_for_project(project)
    allowed_bases = {t["rest_base"] for t in wp_types}
    rest_base = _normalize_wp_rest_base(rest_base_preference if rest_base_preference is not None else article.get("wp_rest_base"), allowed_bases)

    try:
        cfg = WordPressConfig(
            site_url=site_url,
            username=(project.get("wp_username") or "").strip(),
            application_password=(project.get("wp_app_password") or "").strip(),
        )
        html = _article_body_to_wp_html(last["article"], project)
        if not html:
            raise ValueError("Generated article was empty after formatting.")

        tag_ids = ensure_tag_ids(cfg, tags) if tags else []
        yoast_meta = {}
        if focus_keyphrase:
            yoast_meta["_yoast_wpseo_focuskw"] = focus_keyphrase
        if meta_title:
            yoast_meta["_yoast_wpseo_title"] = meta_title
        if meta_description:
            yoast_meta["_yoast_wpseo_metadesc"] = meta_description

        featured_media_id: int | None = None
        img_path = _article_featured_image_path(article_id)
        if os.path.isfile(img_path):
            with open(img_path, "rb") as img_f:
                img_bytes = img_f.read()
            safe_fn = re.sub(r"[^a-zA-Z0-9._-]+", "-", (last.get("title") or "featured")[:80]).strip("-") or "featured"
            media = upload_media(cfg, img_bytes, safe_fn + ".png")
            mid = media.get("id")
            if isinstance(mid, int):
                featured_media_id = mid

        created = create_post(
            cfg,
            title=(last.get("title") or "Untitled"),
            html_content=html,
            status=status,
            excerpt=excerpt,
            tag_ids=tag_ids,
            category_ids=category_ids,
            meta=yoast_meta or None,
            featured_media=featured_media_id,
            rest_base=rest_base,
        )
        wp_status_actual = (created.get("status") or status or "draft")
        if isinstance(wp_status_actual, str):
            wp_status_actual = wp_status_actual.strip().lower()
        else:
            wp_status_actual = str(wp_status_actual).lower()
        return True, None, {
            "post_id": created.get("id"),
            "link": created.get("link") or "",
            "wp_status": wp_status_actual,
            "rest_base": rest_base,
        }
    except Exception as e:
        return False, str(e), {}


def _maybe_request_gsc_url_inspection(
    project: dict,
    live_url: str,
    wp_status: str | None,
    article_id: str | None,
) -> bool:
    """
    After a live (publish) WordPress post, call Search Console URL Inspection API.
    On a valid inspection response, sets gsc_status to 'requested' (shown in UI as Submitted).
    """
    st = (wp_status or "").strip().lower()
    if st != "publish":
        return False
    url = (live_url or "").strip()
    if not url:
        return False
    proj = dict(project)
    _normalize_project_gsc(proj)
    if not proj.get("gsc_index_on_publish", True):
        return False
    prop = (proj.get("gsc_property_url") or "").strip()
    if not prop:
        return False
    try:
        import google_integration as gi
    except ImportError:
        app.logger.warning("Google integration unavailable (install google-api-python-client et al.).")
        return False
    creds = gi.get_valid_credentials()
    if not creds:
        return False
    try:
        resp = gi.request_url_inspection(creds, prop, url)
        if not gi.gsc_inspection_response_accepted(resp):
            app.logger.warning(
                "Search Console inspect returned no usable inspectionResult for %s (property %s). Not marking GSC submitted.",
                url,
                prop,
            )
            return False
        app.logger.info("Search Console URL Inspection accepted for %s (property %s).", url, prop)
        if article_id:
            _update_article_fields(article_id, {"gsc_status": "requested"})
        return True
    except Exception as e:
        app.logger.warning("Search Console URL Inspection failed for %s: %s", url, e)
        return False


@app.post("/projects/<project_id>/articles/<article_id>/wordpress")
def wordpress_post_project(project_id: str, article_id: str):
    project = _get_project_by_id(project_id)
    article = _get_article_by_id(article_id)
    if not project or not article or (article.get("project_id") or "") != project_id:
        flash("Article not found.", "error")
        return redirect(url_for("home"))

    last = _article_to_last(article)
    if not _is_project_wordpress_configured(project):
        flash("Configure WordPress settings for this project first.", "error")
        return redirect(url_for("article_edit", project_id=project_id, article_id=article_id))

    proj_check = dict(project)
    _normalize_project_image_prompts(proj_check)
    need_featured = len(proj_check.get("image_prompts") or []) > 0
    has_file = os.path.isfile(_article_featured_image_path(article_id))
    allow_without = (request.form.get("confirm_post_without_featured_image") or "").strip() == "1"

    form_body = request.form.get("article_body")
    if not _article_body_matches_stored(form_body, article.get("article")):
        flash("Save your article before posting to WordPress.", "error")
        return redirect(url_for("article_edit", project_id=project_id, article_id=article_id))

    status = (request.form.get("wp_status") or "draft").strip().lower()
    if status not in {"draft", "publish"}:
        status = "draft"

    wp_types, _ = _wp_post_types_for_project(project)
    allowed_bases = {t["rest_base"] for t in wp_types}
    rest_base = _normalize_wp_rest_base(request.form.get("wp_rest_base"), allowed_bases)

    form_site_url = (request.form.get("wp_site_url") or "").strip()
    site_override = form_site_url or None

    ok, err, info = _post_article_to_wordpress(
        project,
        article,
        article_id,
        wp_status=status,
        rest_base_preference=rest_base,
        site_url_override=site_override,
        allow_without_featured_image=allow_without,
    )

    if not ok:
        flash(f"WordPress post failed: {err}", "error")
        return redirect(url_for("article_edit", project_id=project_id, article_id=article_id))

    new_status = _app_article_status_from_wp_rest_status(info.get("wp_status"))
    no_image_suffix = (
        " No featured image was attached (as confirmed)."
        if (not has_file and allow_without)
        else ""
    )
    fk = (request.form.get("wp_focus_keyphrase") or "").strip() or (last.get("focus_keyphrase") or "").strip() or ""
    mt = (request.form.get("wp_meta_title") or "").strip() or (last.get("meta_title") or "").strip() or ""
    md = (request.form.get("wp_meta_description") or "").strip() or (last.get("meta_description") or "").strip() or ""
    posted_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    _update_article_fields(
        article_id,
        {
            "status": new_status,
            "wp_post_id": info.get("post_id"),
            "wp_link": info.get("link") or "",
            "wp_rest_base": info.get("rest_base"),
            "focus_keyphrase": fk,
            "meta_title": mt,
            "meta_description": md,
            "posted_at": posted_at,
            "wp_scheduled_at": "",
            "wp_schedule_error": "",
            "wp_schedule_batch_id": "",
            "wp_schedule_batch_index": "",
            "wp_schedule_batch_total": "",
        },
    )

    post_id = info.get("post_id")
    link = info.get("link") or ""
    proj_fresh = _get_project_by_id(project_id) or project
    gsc_requested = _maybe_request_gsc_url_inspection(
        proj_fresh,
        info.get("link") or "",
        info.get("wp_status"),
        article_id,
    )

    if link:
        posted_msg = (
            f"Posted to WordPress ({new_status.capitalize()}). ID {post_id}. Link: {link}{no_image_suffix}"
        )
    else:
        posted_msg = f"Posted to WordPress ({new_status.capitalize()}). ID {post_id}.{no_image_suffix}"
    if gsc_requested:
        posted_msg += (
            " Search Console accepted the live URL (submitted for processing). "
            "Indexing status in Google updates on its own schedule."
        )
    flash(posted_msg, "success")
    return redirect(url_for("project_detail", project_id=project_id))


@app.get("/projects/<project_id>/articles/<article_id>/download")
def download_project_article(project_id: str, article_id: str):
    project = _get_project_by_id(project_id)
    article = _get_article_by_id(article_id)
    if not project or not article or (article.get("project_id") or "") != project_id:
        flash("Article not found.", "error")
        return redirect(url_for("home"))
    text = article.get("article") or ""
    if not text.strip():
        flash("Nothing to download yet. Generate an article first.", "error")
        return redirect(url_for("article_edit", project_id=project_id, article_id=article_id))
    filename = _sanitize_filename(article.get("title", "article"))
    return Response(
        text,
        mimetype="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/articles")
def articles():
    last = session.get("last_result")
    return render_template("index.html", last=last)


@app.post("/generate")
def generate():
    title = (request.form.get("title") or "").strip()
    keywords_raw = request.form.get("keywords") or ""
    api_key = request.form.get("api_key") or ""
    remember_key = (request.form.get("remember_key") or "") == "on"

    keywords = _parse_keywords(keywords_raw)

    if not title:
        flash("Please enter an article title.", "error")
        return redirect(url_for("articles"))

    if len(keywords) > 10:
        flash("Maximum 10 keywords allowed. Please remove extra keywords.", "error")
        return redirect(url_for("articles"))

    if remember_key and api_key.strip():
        session["api_key"] = api_key.strip()
    else:
        api_key = api_key.strip() or session.get("api_key", "")

    try:
        with ThreadPoolExecutor(max_workers=2) as ex:
            fut_article = ex.submit(_generate_article_markdown, title, keywords, api_key)
            fut_yoast = ex.submit(_generate_yoast_fields, title, keywords, api_key)
            article_md = fut_article.result()
            yoast = fut_yoast.result()
    except Exception as e:
        flash(f"Generation failed: {e}", "error")
        return redirect(url_for("articles"))

    result = {
        "title": title,
        "keywords": keywords,
        "article": (article_md or "").strip(),
        "focus_keyphrase": (yoast.get("focus_keyphrase") or "").strip(),
        "meta_title": (yoast.get("meta_title") or "").strip(),
        "meta_description": (yoast.get("meta_description") or "").strip(),
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    session["last_result"] = result
    return render_template("index.html", last=result)


@app.post("/wordpress/post")
def wordpress_post():
    last = session.get("last_result")
    ok, err, info = _execute_wordpress_post_from_last(last or {})
    if not ok:
        flash(f"WordPress post failed: {err}", "error")
        return redirect(url_for("articles"))

    post_id = info.get("post_id")
    link = info.get("link") or ""
    if link:
        flash(f"Posted to WordPress (ID {post_id}). Link: {link}", "success")
    else:
        flash(f"Posted to WordPress (ID {post_id}).", "success")
    return redirect(url_for("articles"))


@app.get("/download")
def download():
    last = session.get("last_result")
    if not last or not last.get("article"):
        flash("Nothing to download yet. Generate an article first.", "error")
        return redirect(url_for("articles"))

    filename = _sanitize_filename(last.get("title", "article"))
    text = last["article"]
    return Response(
        text,
        mimetype="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _process_due_scheduled_wordpress_posts() -> None:
    if not _wp_scheduled_processor_lock.acquire(blocking=False):
        return
    try:
        with app.app_context():
            now = datetime.now()
            arts = _load_articles()
            candidates: list[dict] = []
            for a in arts:
                sched = (a.get("wp_scheduled_at") or "").strip()
                if not sched:
                    continue
                aid = (a.get("id") or "").strip()
                if not aid:
                    continue
                if a.get("wp_post_id"):
                    continue
                try:
                    dt = datetime.strptime(sched, "%Y-%m-%d %H:%M:%S")
                except ValueError:
                    _update_article_fields(
                        aid,
                        {"wp_scheduled_at": "", "wp_schedule_error": "Invalid schedule time stored."},
                    )
                    continue
                if dt > now:
                    continue
                candidates.append(a)

            candidates.sort(
                key=lambda x: (
                    (x.get("wp_schedule_batch_id") or ""),
                    int(x.get("wp_schedule_batch_index") or 0),
                    x.get("wp_scheduled_at") or "",
                )
            )

            for a in candidates:
                arts = _load_articles()
                aid = (a.get("id") or "").strip()
                cur = _get_article_by_id(aid)
                if not cur or cur.get("wp_post_id"):
                    continue
                sched = (cur.get("wp_scheduled_at") or "").strip()
                if not sched:
                    continue
                try:
                    dt = datetime.strptime(sched, "%Y-%m-%d %H:%M:%S")
                except ValueError:
                    continue
                if dt > now:
                    continue
                if _earlier_batch_member_blocks(arts, cur, now):
                    continue

                project = _get_project_by_id(cur.get("project_id") or "")
                if not project:
                    _update_article_fields(
                        aid,
                        {
                            "wp_scheduled_at": "",
                            "wp_schedule_error": "Project no longer exists.",
                            "wp_schedule_batch_id": "",
                            "wp_schedule_batch_index": "",
                            "wp_schedule_batch_total": "",
                        },
                    )
                    continue
                if not _is_project_wordpress_configured(project):
                    _update_article_fields(
                        aid,
                        {
                            "wp_scheduled_at": "",
                            "wp_schedule_error": "WordPress is not configured for this project.",
                            "wp_schedule_batch_id": "",
                            "wp_schedule_batch_index": "",
                            "wp_schedule_batch_total": "",
                        },
                    )
                    continue
                wp_st = (cur.get("wp_schedule_wp_status") or "draft").strip().lower()
                if wp_st not in ("draft", "publish"):
                    wp_st = "draft"
                fresh = _get_article_by_id(aid) or cur
                ok, err, info = _post_article_to_wordpress(
                    project,
                    fresh,
                    aid,
                    wp_status=wp_st,
                    rest_base_preference=None,
                    site_url_override=None,
                    allow_without_featured_image=True,
                )
                if not ok:
                    app.logger.warning(
                        "Scheduled WordPress post failed for article %s: %s", aid, err or "unknown"
                    )
                    _update_article_fields(
                        aid,
                        {
                            "wp_scheduled_at": "",
                            "wp_schedule_error": err or "WordPress post failed.",
                            "wp_schedule_batch_id": "",
                            "wp_schedule_batch_index": "",
                            "wp_schedule_batch_total": "",
                        },
                    )
                    continue
                new_status = _app_article_status_from_wp_rest_status(info.get("wp_status"))
                posted_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                _update_article_fields(
                    aid,
                    {
                        "status": new_status,
                        "wp_post_id": info.get("post_id"),
                        "wp_link": info.get("link") or "",
                        "wp_rest_base": info.get("rest_base"),
                        "posted_at": posted_at,
                        "wp_scheduled_at": "",
                        "wp_schedule_error": "",
                        "wp_schedule_batch_id": "",
                        "wp_schedule_batch_index": "",
                        "wp_schedule_batch_total": "",
                    },
                )
                proj_fresh = _get_project_by_id(project.get("id") or "") or project
                _maybe_request_gsc_url_inspection(
                    proj_fresh,
                    info.get("link") or "",
                    info.get("wp_status"),
                    aid,
                )
    except Exception:
        app.logger.exception("Scheduled WordPress posting failed")
    finally:
        _wp_scheduled_processor_lock.release()


def _maybe_trigger_scheduled_wp_posts() -> None:
    """If APScheduler did not run (e.g. Flask reloader on Windows), posting still runs while you browse /projects/."""
    global _wp_bg_trigger_last
    with _wp_bg_trigger_lock:
        t = time.time()
        if t - _wp_bg_trigger_last < 5.0:
            return
        _wp_bg_trigger_last = t
    threading.Thread(target=_process_due_scheduled_wordpress_posts, daemon=True).start()


def _should_run_background_scheduler() -> bool:
    return os.environ.get("WERKZEUG_RUN_MAIN") != "false"


def _start_wp_schedule_scheduler() -> None:
    if not _should_run_background_scheduler():
        app.logger.info(
            "APScheduler skipped (WERKZEUG_RUN_MAIN=false, reloader parent). "
            "Due WordPress posts still run when you open any GET /projects/ URL."
        )
        return
    try:
        from apscheduler.schedulers.background import BackgroundScheduler
    except ImportError:
        app.logger.warning(
            "APScheduler not installed; install APScheduler or rely on browsing /projects/ to post due items."
        )
        return

    sched = BackgroundScheduler(daemon=True)
    sched.add_job(
        _process_due_scheduled_wordpress_posts,
        "interval",
        seconds=60,
        id="wp_scheduled_posts",
        max_instances=1,
        coalesce=True,
    )
    sched.start()
    app.logger.info("APScheduler started: due WordPress posts checked every 60s.")
    import atexit

    atexit.register(lambda: sched.shutdown(wait=False))


@app.before_request
def _trigger_wp_schedule_on_project_get():
    if request.method != "GET":
        return
    p = request.path or ""
    if not p.startswith("/projects/"):
        return
    _maybe_trigger_scheduled_wp_posts()


_start_wp_schedule_scheduler()


if __name__ == "__main__":
    app.run()

