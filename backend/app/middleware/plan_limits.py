"""ASGI middleware: fast trial-expiration gate on mutating API requests."""

from __future__ import annotations

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.core.security import decode_token
from app.legacy.storage import get_legacy_storage_module
from app.services.plan_gatekeeper import is_trial_expired


_SKIP_PREFIXES = (
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/verify-email",
    "/api/auth/resend-verification",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
    "/api/auth/reactivate",
    "/api/auth/refresh",
    "/api/health",
    "/api/user/subscription-status",
    "/docs",
    "/openapi.json",
    "/redoc",
)

_PROTECTED_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def _extract_user_id(request: Request) -> str | None:
    token = None
    auth = (request.headers.get("authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        token = auth[7:].strip()
    elif request.cookies.get("aa_access"):
        token = request.cookies.get("aa_access")
    if not token:
        return None
    try:
        payload = decode_token(token)
    except Exception:
        return None
    if (payload.get("type") or "") != "access":
        return None
    return (payload.get("sub") or "").strip() or None


class PlanLimitsMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive)
        method = request.method.upper()
        path = request.url.path or ""

        if method not in _PROTECTED_METHODS or not path.startswith("/api/"):
            await self.app(scope, receive, send)
            return
        if any(path.startswith(p) for p in _SKIP_PREFIXES):
            await self.app(scope, receive, send)
            return
        if path.startswith("/api/admin/"):
            await self.app(scope, receive, send)
            return

        uid = _extract_user_id(request)
        if not uid:
            await self.app(scope, receive, send)
            return

        st = get_legacy_storage_module()
        user = st.get_user_by_id(uid) if hasattr(st, "get_user_by_id") else None
        if not isinstance(user, dict):
            await self.app(scope, receive, send)
            return
        if (user.get("role") or "").strip().lower() == "admin":
            await self.app(scope, receive, send)
            return

        subscription = st.get_subscription_by_user_id(uid) if hasattr(st, "get_subscription_by_user_id") else None
        if subscription is None and hasattr(st, "ensure_subscription_for_user"):
            subscription = st.ensure_subscription_for_user(user)

        if is_trial_expired(user=user, subscription=subscription):
            response = JSONResponse(
                status_code=403,
                content={"error": "trial_expired", "message": "Your beta access has ended."},
            )
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)
