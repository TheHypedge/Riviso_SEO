"""
Request-scoped cache (P2.1).

A single authenticated request can otherwise read the same user / subscription /
plan documents 3–5 times (ASGI ``PlanLimitsMiddleware`` → ``get_current_user`` →
``check_plan_limits`` → ``build_subscription_status``). Starlette backs
``request.state`` with ``scope["state"]``, and that same scope dict flows from the
ASGI middleware through to the route dependencies, so we memoize there.

All helpers accept either a Starlette ``Request`` (or ``HTTPConnection``) or a raw
ASGI ``scope`` dict, so both the pure-ASGI middleware and the FastAPI deps can
share one cache.
"""

from __future__ import annotations

from typing import Any

_USER_KEY = "_riviso_user"
_USER_ID_KEY = "_riviso_user_id"
_SUB_KEY = "_riviso_subscription"
_SUB_SET_KEY = "_riviso_subscription_set"
_PROJECTS_KEY = "_riviso_projects"


def _scope_state(target: Any) -> dict | None:
    """Return the mutable ``scope["state"]`` dict, or ``None`` if unavailable."""
    scope = getattr(target, "scope", None)
    if scope is None and isinstance(target, dict):
        scope = target
    if not isinstance(scope, dict):
        return None
    state = scope.get("state")
    if not isinstance(state, dict):
        state = {}
        scope["state"] = state
    return state


def cache_user(target: Any, user_id: str, user: dict) -> None:
    state = _scope_state(target)
    if state is None:
        return
    state[_USER_KEY] = user
    state[_USER_ID_KEY] = (user_id or "").strip()


def cached_user(target: Any, user_id: str) -> dict | None:
    """Return the memoized user iff it matches ``user_id`` for this request."""
    state = _scope_state(target)
    if state is None:
        return None
    if state.get(_USER_ID_KEY) != (user_id or "").strip():
        return None
    user = state.get(_USER_KEY)
    return user if isinstance(user, dict) else None


def cache_subscription(target: Any, subscription: dict | None) -> None:
    state = _scope_state(target)
    if state is None:
        return
    state[_SUB_KEY] = subscription
    state[_SUB_SET_KEY] = True


def has_cached_subscription(target: Any) -> bool:
    state = _scope_state(target)
    return bool(state and state.get(_SUB_SET_KEY))


def cached_subscription(target: Any) -> dict | None:
    state = _scope_state(target)
    if state is None:
        return None
    return state.get(_SUB_KEY)


