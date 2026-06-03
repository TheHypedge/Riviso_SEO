"""Per-request context carrying memoized user / subscription / project / plan (P4.7).

The same authenticated request used to read the same records several times
(``PlanLimitsMiddleware`` → ``get_current_user`` → ``check_plan_limits`` →
``build_subscription_status``; plus per-handler project re-fetches). P2.1 added
request-scoped memoization for user/subscription and P2.2 added a TTL cache for
plans; this object ties them together behind one typed accessor and adds project
memoization, while exposing the P4.6 repositories so handlers/services have a
single dependency to reach the data layer.

Usage (FastAPI):

    async def handler(ctx: RequestContext = Depends(get_request_context)):
        user = await ctx.user(user_id)
        proj = await ctx.project(project_id)          # memoized for the request
        plan_key, plan = await ctx.plan_for_user(user)
        rows = await run_sync(ctx.articles.listing_page, project_id, ...)
"""

from __future__ import annotations

from typing import Any

from fastapi import Request

from app.core.request_cache import (
    cache_project,
    cache_subscription,
    cache_user,
    cached_project,
    cached_subscription,
    cached_user,
    has_cached_subscription,
)
from app.legacy.storage import get_legacy_storage_module
from app.repositories import (
    ArticleRepository,
    ProjectRepository,
    ScheduledJobRepository,
    UserRepository,
)
from app.services.storage_db import call_storage
from app.services.to_thread import run_sync


class RequestContext:
    __slots__ = ("request", "st", "articles", "projects", "users", "scheduled_jobs")

    def __init__(self, request: Request, st: Any | None = None) -> None:
        self.request = request
        self.st = st if st is not None else get_legacy_storage_module()
        self.articles = ArticleRepository(self.st)
        self.projects = ProjectRepository(self.st)
        self.users = UserRepository(self.st)
        self.scheduled_jobs = ScheduledJobRepository(self.st)

    async def user(self, user_id: str) -> dict | None:
        uid = (user_id or "").strip()
        if not uid:
            return None
        cached = cached_user(self.request, uid)
        if cached is not None:
            return cached
        u = await run_sync(call_storage, self.st.get_user_by_id, uid)
        if u:
            cache_user(self.request, uid, u)
        return u

    async def subscription(self, user: dict) -> dict | None:
        if has_cached_subscription(self.request):
            return cached_subscription(self.request)
        sub = None
        if hasattr(self.st, "get_subscription_by_user_id"):
            uid = (user.get("id") or "").strip()
            sub = await run_sync(call_storage, self.st.get_subscription_by_user_id, uid)
        if sub is None and hasattr(self.st, "ensure_subscription_for_user"):
            sub = await run_sync(call_storage, self.st.ensure_subscription_for_user, user)
        cache_subscription(self.request, sub)
        return sub

    async def project(self, project_id: str, *, full: bool = False) -> dict | None:
        pid = (project_id or "").strip()
        if not pid:
            return None
        hit = cached_project(self.request, pid, full=full)
        if hit is not None:
            return hit
        if full:
            proj = await run_sync(call_storage, self.projects.get, pid)
        else:
            proj = await run_sync(call_storage, self.projects.access_row, pid)
        if isinstance(proj, dict):
            cache_project(self.request, pid, proj, full=full)
            return proj
        return None

    async def plan_for_user(self, user: dict) -> tuple[str, dict]:
        # Delegates to the gatekeeper, which reads the TTL-cached plans (P2.2).
        from app.services.plan_gatekeeper import _plan_for_user

        return await run_sync(_plan_for_user, self.st, user)


def get_request_context(request: Request) -> RequestContext:
    """FastAPI dependency: one ``RequestContext`` per request."""
    return RequestContext(request)
