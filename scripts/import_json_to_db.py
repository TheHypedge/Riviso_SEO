#!/usr/bin/env python3
"""
One-time import from legacy data/projects.json and data/articles.json into MongoDB.

Usage (from project root, with venv activated):
  python scripts/import_json_to_db.py
  python scripts/import_json_to_db.py --force   # replace existing rows (destructive)

Requires MONGODB_URI (and optional MONGODB_DB_NAME) in .env.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

os.chdir(_ROOT)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(_ROOT, ".env"))

import storage  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Import projects.json and articles.json into MongoDB.")
    p.add_argument(
        "--force",
        action="store_true",
        help="Delete all existing projects/articles in the DB before import.",
    )
    args = p.parse_args()

    projects_path = os.path.join(_ROOT, "data", "projects.json")
    articles_path = os.path.join(_ROOT, "data", "articles.json")

    if not os.path.isfile(projects_path) or not os.path.isfile(articles_path):
        print("Missing data/projects.json or data/articles.json — nothing to import.", file=sys.stderr)
        return 1

    storage.init_storage()

    if storage.load_projects() or storage.load_articles():
        if not args.force:
            print(
                "Database already has data. Run with --force to replace (this deletes all projects and articles).",
                file=sys.stderr,
            )
            return 2

    with open(projects_path, encoding="utf-8") as f:
        projects = json.load(f)
    with open(articles_path, encoding="utf-8") as f:
        articles = json.load(f)

    if not isinstance(projects, list) or not isinstance(articles, list):
        print("Invalid JSON structure (expected arrays).", file=sys.stderr)
        return 1

    if args.force:
        storage.save_projects_replace_all([])

    for pr in projects:
        if isinstance(pr, dict) and (pr.get("id") or "").strip():
            storage.insert_project(pr)

    storage.insert_articles_batch([a for a in articles if isinstance(a, dict) and (a.get("id") or "").strip()])

    print(f"Imported {len(projects)} project(s) and {len(articles)} article(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
