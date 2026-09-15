"""
Shared filename derivation for generated featured images.

Both the WordPress and Shopify upload paths were naming every generated featured
image "featured.{ext}", which WordPress in turn uses to derive the media library
title when none is supplied -- so every uploaded image ended up titled "featured"
regardless of the article. This gives both paths one place to turn an article
title into a filename stem, matching the slug pattern already used for WP post
lookups in wordpress_sync.py.
"""
from __future__ import annotations

import re


def slugify_for_filename(title: str, *, max_len: int = 80) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (title or "").strip().lower()).strip("-")
    return slug[:max_len].strip("-") or "article"
