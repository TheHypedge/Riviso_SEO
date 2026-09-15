"""
Re-enqueue articles stuck in "queued"/"generating" status.

This happens locally when the backend (and its in-process generation worker
loop) is stopped or restarted while a job was still sitting in the Redis
queue or mid-flight: the queue is not durable across a Redis/process
restart, so the article row is left pointing at a job that no longer exists
anywhere, and nothing else in this codebase automatically retries it.

Safe to run repeatedly: only touches rows currently in "queued"/"generating"
and enqueues through the same ``enqueue_article_generation_job()`` path a
normal "Generate" click uses, so plan-quota/eligibility checks still apply
once the running worker picks the job up.

Run locally, with the backend server (and its generation worker) already
running so the freshly-enqueued job actually gets drained:

    cd backend && PYTHONPATH=. .venv/bin/python -m app.scripts.requeue_stuck_articles [--dry-run]

Or inside the backend container:

    docker compose exec backend python -m app.scripts.requeue_stuck_articles [--dry-run]
"""

from __future__ import annotations

import argparse

from app.legacy.storage import get_legacy_storage_module
from app.services.async_operation_dispatch import enqueue_article_generation_job


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="Report what would be re-queued without enqueueing.")
    args = parser.parse_args()

    st = get_legacy_storage_module()
    rows = list(st.get_db().articles.find({"status": {"$in": ["queued", "generating"]}}))
    print(f"{len(rows)} article(s) stuck in queued/generating.")

    for a in rows:
        aid = (a.get("id") or "").strip()
        pid = (a.get("project_id") or "").strip()
        title = (a.get("title") or "")[:60]
        proj = st.get_project_by_id(pid) if pid else None
        owner_id = (proj.get("owner_user_id") or "").strip() if proj else ""
        if not aid or not pid or not owner_id:
            print(f"  SKIP {aid or '?'} ({title!r}) — missing article id, project, or project owner")
            continue
        label = "[dry-run] would re-queue" if args.dry_run else "Re-queuing"
        print(f"  {label}: {aid} ({title!r}) in project {pid}")
        if not args.dry_run:
            enqueue_article_generation_job(project_id=pid, article_id=aid, user_id=owner_id, payload={})


if __name__ == "__main__":
    main()
