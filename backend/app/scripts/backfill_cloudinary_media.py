"""
One-time backfill: upload existing local-disk article media (featured images +
inline article-body images) to Cloudinary, now that it's connected, so media is no
longer split across two backends. Cloudinary connection + the "generate going
forward only" scoping were done in a prior change; this script is the deferred
follow-up to also migrate what predates it.

Safe to run multiple times and safe to interrupt -- already-migrated media
(featured_image_storage == "cloudinary", or an inline-media sidecar that already
has cloudinary_public_id) is skipped without a write or a re-upload. Local files
are left in place by default so a run can be spot-checked before any cleanup;
pass --delete-local to remove them after a confirmed-successful upload + DB write.

Run inside the backend container:

    docker compose exec backend python -m app.scripts.backfill_cloudinary_media [options]

Options:
    --dry-run        Report what would be migrated without uploading or writing anything.
    --delete-local    After a successful upload + DB write, delete the local file(s) it replaced.
    --project-id ID   Only migrate articles belonging to this project.
    --limit N         Stop after migrating N featured images and N inline images (a safe first batch).
    --skip-featured   Skip the featured-image pass.
    --skip-inline     Skip the inline article-media pass.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import urllib.request as _req

sys.path.insert(0, "/app")

import storage as st  # noqa: E402
from app.services import article_media_storage as ams  # noqa: E402
from app.services.cloudinary_storage import cloudinary_configured, upload_image_bytes  # noqa: E402
from app.services.url_guard import assert_public_http_url  # noqa: E402

_DATA_URL_RE = re.compile(r"^data:([^;]+);base64,(.+)$", re.DOTALL)


def _read_local_featured_image(article_id: str) -> tuple[bytes, str] | None:
    bin_path = st._article_image_file_path(article_id)  # noqa: SLF001 -- same pattern migrate_encrypt_secrets.py uses
    if not os.path.isfile(bin_path):
        return None
    with open(bin_path, "rb") as f:
        data = f.read()
    content_type = "image/png"
    meta_path = st._article_image_meta_path(article_id)  # noqa: SLF001
    if os.path.isfile(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            content_type = meta.get("content_type") or content_type
        except Exception:
            pass
    return data, content_type


def _download_featured_image_url(url: str) -> tuple[bytes, str] | None:
    try:
        assert_public_http_url(url)
        with _req.urlopen(url, timeout=30) as resp:
            content_type = (resp.headers.get("content-type") or "image/png").split(";")[0].strip()
            data = resp.read()
        return (data, content_type) if data else None
    except Exception:
        return None


def _decode_inline_data_url(raw: str) -> tuple[bytes, str] | None:
    m = _DATA_URL_RE.match(raw)
    if not m:
        return None
    try:
        return base64.b64decode(m.group(2), validate=True), (m.group(1) or "image/png")
    except Exception:
        return None


def _migrate_featured_image(article: dict, *, dry_run: bool, delete_local: bool) -> str:
    aid = (article.get("id") or "").strip()
    storage_mode = (article.get("featured_image_storage") or "").strip()
    if storage_mode == "cloudinary":
        return "skip-already-cloudinary"

    source: tuple[bytes, str] | None = None
    if storage_mode == "file":
        source = _read_local_featured_image(aid)
        if source is None:
            return "skip-no-local-file"
    elif storage_mode == "url":
        url = (article.get("image_url") or "").strip()
        if not url:
            return "skip-no-url"
        source = _download_featured_image_url(url)
        if source is None:
            return "failed-download"
    elif storage_mode == "inline":
        raw = (article.get("image_url") or "").strip()
        source = _decode_inline_data_url(raw) if raw else None
        if source is None:
            return "skip-unparseable-inline-data"
    else:
        return "skip-no-image"

    data, content_type = source
    if not data:
        return "skip-empty"

    if dry_run:
        return f"would-migrate ({len(data)} bytes, content_type={content_type}, was {storage_mode})"

    uploaded = upload_image_bytes(data, folder=f"riviso/articles/{aid}", public_id="featured")
    if not uploaded:
        return "failed-upload"

    ok = st.patch_article_fields(aid, {
        "image_url": uploaded["secure_url"],
        "featured_image_cloudinary_public_id": uploaded["public_id"],
        "featured_image_storage": "cloudinary",
    })
    if not ok:
        return "failed-db-write (uploaded but not recorded -- rerun will retry)"

    if delete_local and storage_mode == "file":
        for p in (st._article_image_file_path(aid), st._article_image_meta_path(aid)):  # noqa: SLF001
            try:
                if os.path.isfile(p):
                    os.remove(p)
            except OSError:
                pass

    return "migrated"


def _migrate_inline_media(*, dry_run: bool, delete_local: bool, project_id: str | None, limit: int | None) -> dict[str, int]:
    stats: dict[str, int] = {}
    media_dir = ams._media_dir()  # noqa: SLF001
    if not os.path.isdir(media_dir):
        return stats
    migrated = 0
    for name in sorted(os.listdir(media_dir)):
        if not name.endswith(".meta.json"):
            continue
        if limit is not None and migrated >= limit:
            stats["skip-limit-reached"] = stats.get("skip-limit-reached", 0) + 1
            continue
        meta_path = os.path.join(media_dir, name)
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            stats["failed-unreadable-sidecar"] = stats.get("failed-unreadable-sidecar", 0) + 1
            continue
        if not isinstance(meta, dict):
            continue
        if (meta.get("cloudinary_public_id") or "").strip():
            stats["skip-already-cloudinary"] = stats.get("skip-already-cloudinary", 0) + 1
            continue
        if project_id and (meta.get("project_id") or "").strip() != project_id:
            continue

        image_id = name[: -len(".meta.json")]
        bin_path = ams._bin_path(image_id)  # noqa: SLF001
        if not os.path.isfile(bin_path):
            stats["skip-no-local-file"] = stats.get("skip-no-local-file", 0) + 1
            continue

        if dry_run:
            stats["would-migrate"] = stats.get("would-migrate", 0) + 1
            migrated += 1
            continue

        with open(bin_path, "rb") as f:
            data = f.read()
        article_id = (meta.get("article_id") or "unknown").strip() or "unknown"
        uploaded = upload_image_bytes(data, folder=f"riviso/articles/{article_id}/media", public_id=image_id)
        if not uploaded:
            stats["failed-upload"] = stats.get("failed-upload", 0) + 1
            continue

        ams._write_meta(image_id, {  # noqa: SLF001
            **meta,
            "cloudinary_public_id": uploaded["public_id"],
            "cloudinary_url": uploaded["secure_url"],
        })

        if delete_local:
            try:
                os.remove(bin_path)
            except OSError:
                pass

        stats["migrated"] = stats.get("migrated", 0) + 1
        migrated += 1

    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="Report what would change without writing.")
    parser.add_argument("--delete-local", action="store_true", help="Delete local files after a confirmed successful migration.")
    parser.add_argument("--project-id", default=None, help="Only migrate articles/media belonging to this project.")
    parser.add_argument("--limit", type=int, default=None, help="Stop after migrating N items per media type.")
    parser.add_argument("--skip-featured", action="store_true", help="Skip the featured-image pass.")
    parser.add_argument("--skip-inline", action="store_true", help="Skip the inline article-media pass.")
    args = parser.parse_args()

    if not cloudinary_configured():
        print("Cloudinary is not configured (CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET) -- nothing to backfill to. Aborting.")
        return

    if not args.skip_featured:
        print("=== Featured images ===")
        articles = st.load_articles()
        if args.project_id:
            articles = [a for a in articles if (a.get("project_id") or "").strip() == args.project_id]
        stats: dict[str, int] = {}
        migrated = 0
        for a in articles:
            if args.limit is not None and migrated >= args.limit:
                stats["skip-limit-reached"] = stats.get("skip-limit-reached", 0) + 1
                continue
            result = _migrate_featured_image(a, dry_run=args.dry_run, delete_local=args.delete_local)
            key = result.split(" (")[0].split(":")[0]
            stats[key] = stats.get(key, 0) + 1
            if key in ("migrated", "would-migrate"):
                migrated += 1
            if key not in ("skip-already-cloudinary", "skip-no-image"):
                print(f"  {a.get('id')}: {result}")
        for k, v in sorted(stats.items()):
            print(f"  {k}: {v}")

    if not args.skip_inline:
        print("=== Inline article media ===")
        stats = _migrate_inline_media(
            dry_run=args.dry_run, delete_local=args.delete_local, project_id=args.project_id, limit=args.limit,
        )
        for k, v in sorted(stats.items()):
            print(f"  {k}: {v}")

    print("Done." + (" (dry run -- nothing was written)" if args.dry_run else ""))


if __name__ == "__main__":
    main()
