"""Typed repositories by aggregate (P4.6).

The data layer is otherwise ~4,800 lines of flat module-level functions over raw
dicts (see RIVISO_PERFORMANCE_OPTIMIZATION_AUDIT §2.1/2.2). These repository
classes give each aggregate a cohesive home that owns:

- its collection's read/write entry points,
- the *heavy vs light* distinction (light list reads vs full-document reads),
- and batch operations (``$in`` reads, ``delete_many``).

They are a thin, behaviour-preserving facade: every method delegates to the
existing ``storage`` functions, so adopting a repository never changes results —
it only gives new code a typed, discoverable surface and a natural place to add
projections/caching/batching going forward. Methods are synchronous; async call
sites should wrap them with ``app.services.to_thread.run_sync`` exactly as they
already do for the raw ``storage`` functions.
"""

from __future__ import annotations

from typing import Any

from app.legacy.storage import get_legacy_storage_module


class _Repo:
    __slots__ = ("st",)

    def __init__(self, st: Any | None = None) -> None:
        self.st = st if st is not None else get_legacy_storage_module()

    def _call(self, name: str, *args, **kwargs):
        fn = getattr(self.st, name, None)
        if not callable(fn):
            raise AttributeError(f"storage backend has no {name!r}")
        return fn(*args, **kwargs)

    def _has(self, name: str) -> bool:
        return callable(getattr(self.st, name, None))


class ArticleRepository(_Repo):
    """Articles aggregate — light listings vs heavy body/image reads."""

    # --- heavy / single-document reads -------------------------------------
    def get(self, project_id: str, article_id: str) -> dict | None:
        return self._call("get_article", project_id=project_id, article_id=article_id)

    def shell(self, project_id: str, article_id: str) -> dict | None:
        return self._call("get_article_editor_shell", project_id=project_id, article_id=article_id)

    def body_text(self, project_id: str, article_id: str) -> str | None:
        return self._call("get_article_body_text", project_id=project_id, article_id=article_id)

    def image_url(self, project_id: str, article_id: str) -> str | None:
        return self._call("get_article_image_url", project_id=project_id, article_id=article_id)

    def generation_status(self, project_id: str, article_id: str) -> dict | None:
        return self._call("get_article_generation_status", project_id=project_id, article_id=article_id)

    # --- light list reads --------------------------------------------------
    def listing_page(
        self,
        project_id: str,
        *,
        page: int = 1,
        per_page: int = 10,
        q: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        sort: str = "desc",
        status_key: str | None = None,
    ) -> list[dict]:
        return self._call(
            "load_articles_listing_page_for_project",
            project_id,
            page=page,
            per_page=per_page,
            q=q,
            date_from=date_from,
            date_to=date_to,
            sort=sort,
            status_key=status_key,
        )

    def count(
        self,
        project_id: str,
        *,
        q: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        status_key: str | None = None,
    ) -> int:
        return int(
            self._call(
                "count_articles_listing_for_project",
                project_id,
                q=q,
                date_from=date_from,
                date_to=date_to,
                status_key=status_key,
            )
            or 0
        )

    def titles(self, project_id: str, *, limit: int = 20000) -> list[dict]:
        return self._call("load_article_titles_for_project", project_id, limit=limit)

    def by_ids(self, project_id: str, ids: list[str]) -> list[dict]:
        return self._call("load_articles_by_ids_for_project", project_id, ids)

    # --- writes ------------------------------------------------------------
    def patch(self, article_id: str, fields: dict) -> bool:
        return bool(self._call("patch_article_fields", article_id, fields))

    def bulk_update(self, updates: list[tuple[str, dict]]) -> None:
        self._call("bulk_update_articles", updates)

    def delete_by_ids(self, ids: list[str]) -> None:
        self._call("delete_articles_by_ids", ids)


class ProjectRepository(_Repo):
    """Projects aggregate — full vs access/listing/generation projections."""

    def get(self, project_id: str) -> dict | None:
        return self._call("get_project_by_id", project_id)

    def for_generation(self, project_id: str) -> dict | None:
        if self._has("get_project_for_generation"):
            return self._call("get_project_for_generation", project_id)
        return self._call("get_project_by_id", project_id)

    def access_row(self, project_id: str) -> dict | None:
        if self._has("get_project_access_row"):
            return self._call("get_project_access_row", project_id)
        return self._call("get_project_by_id", project_id)

    def listing_by_id(self, project_id: str) -> dict | None:
        if self._has("get_project_listing_by_id"):
            return self._call("get_project_listing_by_id", project_id)
        return self._call("get_project_by_id", project_id)

    def listing(self, owner_user_id: str | None = None) -> list[dict]:
        if self._has("load_projects_listing"):
            return self._call("load_projects_listing", owner_user_id)
        return self._call("load_projects", owner_user_id)

    def update(self, project_id: str, fields: dict) -> bool:
        return bool(self._call("update_project_fields", project_id, fields))


class UserRepository(_Repo):
    """Users aggregate."""

    def get(self, user_id: str) -> dict | None:
        return self._call("get_user_by_id", user_id)

    def by_email(self, email: str) -> dict | None:
        if self._has("get_user_by_email"):
            return self._call("get_user_by_email", email)
        em = (email or "").strip().lower()
        return next(
            (u for u in (self._call("load_users") or []) if (u.get("email") or "").strip().lower() == em),
            None,
        )

    def update(self, user_id: str, fields: dict) -> bool:
        for name in ("update_user_fields", "patch_user_fields"):
            if self._has(name):
                return bool(self._call(name, user_id, fields))
        raise AttributeError("storage backend cannot update users")


class ScheduledJobRepository(_Repo):
    """Scheduled-jobs aggregate — includes batch deletes (P4.4)."""

    def load(
        self,
        project_id: str,
        *,
        article_id: str | None = None,
        state: str | None = None,
        limit: int = 5000,
    ) -> list[dict]:
        kwargs: dict[str, Any] = {"project_id": project_id, "limit": limit}
        if article_id is not None:
            kwargs["article_id"] = article_id
        if state is not None:
            kwargs["state"] = state
        return self._call("load_scheduled_jobs", **kwargs)

    def update(self, job_id: str, fields: dict) -> bool:
        return bool(self._call("update_scheduled_job_fields", job_id, fields))

    def delete(self, job_id: str) -> bool:
        return bool(self._call("delete_scheduled_job", job_id))

    def delete_for_project(self, project_id: str, *, exclude_states: list[str] | None = None) -> int:
        return int(self._call("delete_scheduled_jobs_for_project", project_id, exclude_states=exclude_states) or 0)

    def delete_for_article(
        self, project_id: str, article_id: str, *, exclude_states: list[str] | None = None
    ) -> int:
        return int(
            self._call(
                "delete_scheduled_jobs_for_article", project_id, article_id, exclude_states=exclude_states
            )
            or 0
        )
