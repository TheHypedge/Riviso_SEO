"""Compress the history of SEO audits: every finished audit except each project's newest one
is packed into storage.seo_audit_archives and its raw url/link/issue rows are dropped.
Users still open old audits exactly as before (inflated on demand). Safe to re-run.

    docker compose exec backend python -m app.scripts.archive_seo_audits --dry-run
    docker compose exec backend python -m app.scripts.archive_seo_audits
"""

from __future__ import annotations

import argparse
import sys

sys.path.insert(0, "/app")

import storage as st  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="List what would be archived; write nothing.")
    ap.add_argument("--project-id", default=None)
    args = ap.parse_args()

    db = st.get_db()
    if args.dry_run:
        q = {"project_id": args.project_id} if args.project_id else {}
        by_project: dict[str, list[dict]] = {}
        for a in db.seo_audits.find(q, {"_id": 1, "project_id": 1, "status": 1, "started_at": 1, "archived_at": 1}):
            by_project.setdefault(a.get("project_id") or "", []).append(a)
        n = 0
        for audits in by_project.values():
            audits.sort(key=lambda a: str(a.get("started_at") or ""), reverse=True)
            for a in audits[1:]:
                if a.get("archived_at") or a.get("status") not in st._SEO_TERMINAL_STATUSES:  # noqa: SLF001
                    continue
                rows = {k: db[c].count_documents({"audit_id": a["_id"]}) for k, c in st._SEO_ROW_COLLECTIONS.items()}  # noqa: SLF001
                print(f"  would archive {a['_id']} ({a.get('status')}, {a.get('started_at')}): {rows}")
                n += 1
        print(f"{n} audit(s) would be archived (dry run -- nothing written)")
        return

    done = st.archive_old_seo_audits(args.project_id)
    print(f"Archived {len(done)} audit(s).")


if __name__ == "__main__":
    main()
