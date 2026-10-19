"""Repair links broken by the old context-link linker, everywhere it reached.

The old linker applied labels one at a time, so overlapping labels nested links:
``[criminal [defense lawyer](u2)](u1)`` in stored Markdown, which reached WordPress as
``<a href="u1">criminal [defense lawyer](u2)</a>``.

    docker compose exec backend python -m app.scripts.repair_nested_context_links [--apply] [--backup-dir DIR]

1. Stored articles: un-nests the ``article`` Markdown (outer/longest link kept).
2. Every WordPress post Riviso is linked to: fetches the live raw content and fixes only
   the leaked Markdown links, then sends back ``content`` alone (core REST) -- title,
   status, meta, categories and any edits made directly in WordPress are left untouched.

Dry run by default. With --apply, each changed post's original raw content is written to
--backup-dir first (default ./nested-link-backups) so it can be restored.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

from app.legacy.storage import get_legacy_storage_module
from app.services.context_links import repair_markdown_links_in_html, unnest_markdown_links
from app.services.wordpress_client import WordpressClient

_NESTED_MD = {"article": {"$regex": r"\[[^\]\n]*\[[^\]\n]+\]\([^)\s]+\)[^\]\n]*\]\("}}


def repair_stored(st, apply: bool) -> None:
    db = st.get_db()
    ids = [d["_id"] for d in db.articles.find(_NESTED_MD, {"_id": 1})]
    print(f"[stored] {len(ids)} article(s) with nested links")
    for _id in ids:
        d = db.articles.find_one({"_id": _id}, {"id": 1, "article": 1, "title": 1, "status": 1})
        new, n = unnest_markdown_links(d.get("article") or "")
        print(f"  - {_id} [{d.get('status')}] {d.get('title')!r}: {n} nested link(s)")
        if apply and n:
            st.patch_article_fields(d.get("id") or _id, {"article": new})


async def _repair_project(proj: dict, rows: list[dict], apply: bool, backup_dir: str) -> tuple[int, int, int]:
    """Posts in one site run sequentially (gentle on the client's host). Returns
    (checked, broken, failed)."""
    checked = broken = failed = 0
    name = proj.get("name") or proj.get("id")
    try:
        wp = WordpressClient(
            site_url=(proj.get("wp_site_url") or proj.get("website_url") or ""),
            username=proj.get("wp_username") or "",
            app_password=(proj.get("wp_app_password") or "").replace(" ", ""),
        )
        await wp.ensure_resolved_site_url()
    except Exception as e:
        print(f"  ! {name}: cannot connect ({type(e).__name__}: {str(e)[:120]}) -- {len(rows)} post(s) skipped")
        return 0, 0, len(rows)
    for d in rows:
        rb = (d.get("wp_rest_base") or "posts").strip() or "posts"
        path = f"/wp-json/wp/v2/{rb}/{int(d['wp_post_id'])}"
        try:
            post = await wp.get_json(f"{path}?context=edit&_fields=id,content,link")
            raw = ((post or {}).get("content") or {}).get("raw") or ""
            checked += 1
            fixed, n = repair_markdown_links_in_html(raw)
            if not n:
                continue
            broken += 1
            print(f"  - {name}: {rb}/{d['wp_post_id']} {n} fix(es) {post.get('link') or ''}")
            if apply:
                with open(os.path.join(backup_dir, f"{d['_id']}_{rb}_{d['wp_post_id']}.json"), "w") as f:
                    json.dump({"article_id": d["_id"], "path": path, "raw": raw}, f)
                await wp.post_json(path, {"content": fixed}, timeout=90.0)
                after = await wp.get_json(f"{path}?context=edit&_fields=content")
                left = repair_markdown_links_in_html(((after or {}).get("content") or {}).get("raw") or "")[1]
                print(f"      updated; remaining issues after update: {left}")
        except Exception as e:
            failed += 1
            print(f"  ! {name}: {rb}/{d.get('wp_post_id')} failed: {type(e).__name__}: {str(e)[:160]}")
    return checked, broken, failed


async def repair_live(st, apply: bool, backup_dir: str) -> None:
    db = st.get_db()
    by_project: dict[str, list[dict]] = {}
    for d in db.articles.find({"wp_post_id": {"$nin": [None, "", 0]}}, {"_id": 1, "project_id": 1, "wp_post_id": 1, "wp_rest_base": 1}):
        by_project.setdefault(d["project_id"], []).append(d)
    print(f"[live] checking {sum(map(len, by_project.values()))} WordPress post(s) across {len(by_project)} site(s)")
    results = await asyncio.gather(
        *[_repair_project(st.get_project_by_id(pid) or {"id": pid}, rows, apply, backup_dir) for pid, rows in by_project.items()]
    )
    checked, broken, failed = (sum(x) for x in zip(*results)) if results else (0, 0, 0)
    print(f"[live] checked {checked}, needing repair {broken}, failed/skipped {failed}")


def main(argv: list[str]) -> None:
    apply = "--apply" in argv
    backup_dir = argv[argv.index("--backup-dir") + 1] if "--backup-dir" in argv else "nested-link-backups"
    if apply:
        os.makedirs(backup_dir, exist_ok=True)
    print("MODE:", "APPLY" if apply else "dry run (no changes)")
    st = get_legacy_storage_module()
    repair_stored(st, apply)
    asyncio.run(repair_live(st, apply, backup_dir))


if __name__ == "__main__":
    main(sys.argv[1:])
