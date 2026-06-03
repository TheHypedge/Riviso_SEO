"""Lightweight domain models (P4.6).

These dataclasses give the domain explicit *light* vs *heavy* shapes so call
sites can state, at the type level, "I do not need the article body here". They
are intentionally thin views over the ``dict`` rows that ``storage`` returns —
construction never triggers extra I/O.

- ``ArticleRef``  — id/title/status/has_body (no body, no image bytes).
- ``ProjectRef``  — id/owner/name/platform (no prompts, catalog, or credentials).

Heavy fields (``article`` body, ``image_url`` data URLs, prompt arrays, OAuth
tokens) are deliberately *absent* here; load them through the explicit
repository methods that name them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class ArticleRef:
    id: str
    project_id: str
    title: str
    status: str
    has_body: bool

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "ArticleRef":
        r = row or {}
        has_body = r.get("has_body")
        if has_body is None:
            has_body = bool((r.get("article") or "").strip())
        return cls(
            id=(r.get("id") or "").strip(),
            project_id=(r.get("project_id") or "").strip(),
            title=(r.get("title") or "").strip(),
            status=(r.get("listing_status") or r.get("status") or "pending").strip().lower(),
            has_body=bool(has_body),
        )


@dataclass(frozen=True, slots=True)
class ProjectRef:
    id: str
    owner_user_id: str
    name: str
    platform: str

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "ProjectRef":
        r = row or {}
        return cls(
            id=(r.get("id") or "").strip(),
            owner_user_id=str(r.get("owner_user_id") or "").strip(),
            name=(r.get("name") or "").strip(),
            platform=((r.get("platform") or "wordpress").strip().lower() or "wordpress"),
        )
