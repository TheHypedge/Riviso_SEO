"""Repository facade over ``storage`` (P4.6). Only the scheduled-jobs aggregate is adopted.

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
