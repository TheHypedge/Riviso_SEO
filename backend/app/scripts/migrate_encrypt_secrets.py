"""
One-time migration (F0.2): re-encrypt any project whose WordPress/Shopify/GSC
secret fields are still plaintext from before FIELD_ENCRYPTION_KEY was added.

Safe to run multiple times and safe to interrupt -- every write goes through
the same update_project_fields() used by normal API calls, and encrypt_field()
is idempotent (already-encrypted values pass through unchanged). Projects with
no plaintext secrets left are skipped without a write.

Run inside the backend container:

    docker compose exec backend python -m app.scripts.migrate_encrypt_secrets [--dry-run]
"""

from __future__ import annotations

import argparse
import sys

sys.path.insert(0, "/app")

from app.core.field_encryption import is_encrypted  # noqa: E402
from storage import (  # noqa: E402
    _PROJECT_SECRET_FIELDS,
    get_db,
    load_projects_listing,
    update_project_fields,
)


def _needs_migration(project_id: str) -> bool:
    doc = get_db().projects.find_one({"id": project_id})
    if not doc:
        return False
    return any(
        (doc.get(field) or "").strip() and not is_encrypted(doc.get(field))
        for field in _PROJECT_SECRET_FIELDS
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Report what would change without writing.")
    args = parser.parse_args()

    projects = load_projects_listing()
    total = len(projects)
    to_migrate = [p["id"] for p in projects if p.get("id") and _needs_migration(p["id"])]

    print(f"{total} projects total, {len(to_migrate)} with plaintext secrets to encrypt.")
    if args.dry_run:
        for pid in to_migrate:
            print(f"  would migrate: {pid}")
        return

    migrated = 0
    failed = 0
    for pid in to_migrate:
        try:
            # Empty updates -- forces the existing decrypt -> normalize -> encrypt ->
            # replace_one cycle in update_project_fields() without changing any data.
            ok = update_project_fields(pid, {})
            if ok:
                migrated += 1
            else:
                failed += 1
                print(f"  FAILED (not found/not matched): {pid}")
        except Exception as exc:
            failed += 1
            print(f"  FAILED ({exc}): {pid}")

    print(f"Done. {migrated} migrated, {failed} failed out of {len(to_migrate)}.")


if __name__ == "__main__":
    main()
