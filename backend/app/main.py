"""
FastAPI ASGI entrypoint: middleware stack, API router, lifespan hooks.

**Production notes**

- Set ``ENVIRONMENT=production`` to disable interactive OpenAPI/Swagger UIs.
- Run startup checks via :func:`app.core.production.run_startup_checks`.
- Prefer TLS termination at a reverse proxy; enable ``COOKIE_SECURE`` when HTTPS is used.
- The in-process scheduler is optional; for multiple API workers, set ``ENABLE_SCHEDULER=0`` and run
  a single dedicated worker process for scheduled jobs.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pymongo.errors import PyMongoError
from starlette.middleware.gzip import GZipMiddleware
from starlette.datastructures import MutableHeaders
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.services.storage_db import is_transient_storage_error
from app.services.storage_http import DATABASE_UNAVAILABLE_DETAIL

from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from app.core.ratelimit import limiter

from app.api.router import api_router
from app.core.config import settings
from app.core.logging import configure_logging
from app.core.metrics import MetricsMiddleware, metrics_available, render_latest, set_queue_depth
from app.core.observability import init_sentry
from app.core.production import run_startup_checks
from app.middleware.request_id import RequestIdMiddleware
from app.services.scheduler import scheduler_loop
from app.services.generation_worker import start_generation_worker, stop_generation_worker
from app.services.subscription_daily_reset import subscription_daily_reset_loop
from app.middleware.plan_limits import PlanLimitsMiddleware
from app.legacy.storage import get_legacy_storage_module

_log = logging.getLogger("uvicorn.error")

# Next.js local dev always hits the API from these origins (even when API is 127.0.0.1:8000).
_LOCAL_DEV_ORIGINS = ("http://localhost:3000", "http://127.0.0.1:3000")
# If CORS_ORIGINS is empty in .env, use the same defaults as app.core.config.Settings.cors_origins.
_DEFAULT_CORS_ORIGINS = ",".join(
    [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://riviso.com",
        "https://www.riviso.com",
        "https://app.riviso.com",
        "https://riviso.cloud",
        "https://www.riviso.cloud",
        "https://app.riviso.cloud",
    ]
)


def _is_local_origin(origin: str) -> bool:
    """True for localhost / loopback dev origins that must be excluded in production."""
    o = (origin or "").strip().lower()
    return "localhost" in o or "127.0.0.1" in o or "0.0.0.0" in o or "[::1]" in o


def _parse_cors_origins(raw: str) -> list[str]:
    out: list[str] = []
    for part in (raw or "").split(","):
        p = part.strip().strip("'\"")
        if p:
            out.append(p)
    return out


def _effective_cors_origins() -> list[str]:
    """
    Merge local dev origins, env CORS_ORIGINS, and built-in production defaults.

    If production sets CORS_ORIGINS to only one domain (e.g. riviso.cloud) while the
    browser uses another (e.g. riviso.com → api.riviso.cloud), requests fail with
    "No Access-Control-Allow-Origin" and the article editor shows "Failed to fetch".
    """
    user = _parse_cors_origins(settings.cors_origins or "")
    base = list(user) + _parse_cors_origins(_DEFAULT_CORS_ORIGINS)
    if not settings.is_production:
        # Local dev convenience only.
        base = list(_LOCAL_DEV_ORIGINS) + base
    merged: list[str] = []
    seen: set[str] = set()
    for o in base:
        # S1.8: never allow localhost / loopback origins in production.
        if settings.is_production and _is_local_origin(o):
            continue
        if o not in seen:
            seen.add(o)
            merged.append(o)
    return merged


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Startup: storage init, production checks, optional background scheduler.
    Shutdown: cancel scheduler task so workers exit cleanly.
    """
    run_startup_checks(settings)

    st = get_legacy_storage_module()
    if hasattr(st, "init_storage"):
        try:
            await asyncio.to_thread(st.init_storage)
        except Exception:
            # Legacy JSON fallback may still run if Mongo is unavailable.
            pass
    if hasattr(st, "storage_mode"):
        try:
            mode = await asyncio.to_thread(st.storage_mode)
            err = (
                await asyncio.to_thread(st.storage_init_error)
                if hasattr(st, "storage_init_error")
                else None
            )
            if (mode or "").strip().lower() != "mongo":
                _log.warning(
                    "Storage backend is %r (not MongoDB). You will not see production/live Atlas data. "
                    "Unset FORCE_JSON_STORAGE and fix MONGODB_URI if you expected mongo. Detail: %s",
                    mode,
                    err or "unknown",
                )
            else:
                _log.info("Storage backend: mongo")
        except Exception as e:
            _log.warning("Could not read storage mode after init: %s", e)

    # P4.3: backfill persisted has_body + listing_status for rows written before the
    # feature shipped. Idempotent (only touches docs missing the fields) and runs off
    # the event loop so startup is never blocked. Disable with RUN_LISTING_BACKFILL=0.
    if (os.environ.get("RUN_LISTING_BACKFILL", "1") or "1").strip().lower() in {"1", "true", "yes", "on"} and hasattr(
        st, "backfill_article_listing_fields"
    ):
        async def _run_listing_backfill() -> None:
            try:
                n = await asyncio.to_thread(st.backfill_article_listing_fields)
                if n:
                    _log.info("Listing-field backfill updated %d article(s)", n)
            except Exception as e:
                _log.warning("Listing-field backfill skipped: %s", e)

        asyncio.create_task(_run_listing_backfill())

    # Migrate legacy default writing prompt ("Default writing prompt") to the
    # new SEO/AEO/GEO version across all projects. Idempotent — only updates
    # prompts whose name still matches the legacy sentinel.
    async def _run_default_prompt_migration() -> None:
        try:
            from app.api.routes.prompts import migrate_all_default_prompts
            n = await asyncio.to_thread(migrate_all_default_prompts, st)
            if n:
                _log.info("Default prompt migration updated %d project(s)", n)
        except Exception as e:
            _log.warning("Default prompt migration skipped: %s", e)

    asyncio.create_task(_run_default_prompt_migration())

    scheduler_task: asyncio.Task | None = None
    generation_worker_task: asyncio.Task | None = None
    subscription_reset_task: asyncio.Task | None = None

    # Prefer Settings (pydantic-settings reads backend/.env) so the .env value wins
    # over any ENABLE_GENERATION_WORKER=0 set by the Procfile or a process manager.
    if settings.enable_generation_worker:
        generation_worker_task = start_generation_worker()

    if settings.enable_scheduler:
        # One task per process; use ENABLE_SCHEDULER=0 when running multiple uvicorn workers.
        scheduler_task = asyncio.create_task(scheduler_loop(poll_seconds=10.0))
        # I3.1: the daily subscription reset is a singleton job — bind it to the
        # scheduler so a horizontally-scaled, scheduler-less API (ENABLE_SCHEDULER=0)
        # does not run it on every instance. The standalone scheduler process
        # (app.run_background) runs it instead.
        subscription_reset_task = asyncio.create_task(subscription_daily_reset_loop())

    yield

    if subscription_reset_task:
        subscription_reset_task.cancel()
        try:
            await subscription_reset_task
        except asyncio.CancelledError:
            pass
    if generation_worker_task:
        await stop_generation_worker()
    if scheduler_task:
        scheduler_task.cancel()
        try:
            await scheduler_task
        except asyncio.CancelledError:
            pass


def create_app() -> FastAPI:
    configure_logging(level="INFO")
    # I5.1: error tracking (no-op unless SENTRY_DSN is set + sentry-sdk installed).
    init_sentry("api")

    expose_docs = not settings.is_production

    app = FastAPI(
        title=settings.app_name,
        lifespan=lifespan,
        docs_url="/docs" if expose_docs else None,
        redoc_url="/redoc" if expose_docs else None,
        openapi_url="/openapi.json" if expose_docs else None,
    )
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, lambda request, exc: Response("Rate limit exceeded", status_code=429))

    @app.exception_handler(PyMongoError)
    async def _pymongo_exception_handler(_request: Request, exc: PyMongoError) -> JSONResponse:
        """Return JSON (with CORS) instead of an uncaught 500 that browsers report as 'Failed to fetch'."""
        if is_transient_storage_error(exc):
            return JSONResponse(status_code=503, content={"detail": DATABASE_UNAVAILABLE_DETAIL})
        _log.exception("MongoDB error: %s", exc)
        return JSONResponse(
            status_code=500,
            content={"detail": "A database error occurred. Please try again."},
        )

    app.add_middleware(PlanLimitsMiddleware)
    app.add_middleware(SlowAPIMiddleware)

    # Pure ASGI wrapper (avoid BaseHTTPMiddleware): uncaught DB errors otherwise surface as
    # ExceptionGroup and the browser may see no Access-Control-Allow-Origin on the 500 body.
    class SecurityHeadersASGIMiddleware:
        def __init__(self, app: ASGIApp) -> None:
            self.app = app

        async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
            if scope["type"] != "http":
                await self.app(scope, receive, send)
                return

            async def send_wrapper(message: Message) -> None:
                if message["type"] == "http.response.start":
                    message.setdefault("headers", [])
                    headers = MutableHeaders(raw=message["headers"])
                    if "x-content-type-options" not in headers:
                        headers["X-Content-Type-Options"] = "nosniff"
                    if "x-frame-options" not in headers:
                        headers["X-Frame-Options"] = "DENY"
                    if "referrer-policy" not in headers:
                        headers["Referrer-Policy"] = "no-referrer"
                    if "content-security-policy" not in headers:
                        headers["Content-Security-Policy"] = (
                            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
                        )
                    if "permissions-policy" not in headers:
                        headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
                await send(message)

            await self.app(scope, receive, send_wrapper)

    app.add_middleware(SecurityHeadersASGIMiddleware)

    # S1.7: CSRF protection for cookie-authenticated mutations. Bearer-token
    # requests are not CSRF-able (an attacker page cannot read the token to set
    # the header), and cross-site form posts cannot set a custom request header.
    _CSRF_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
    _CSRF_EXEMPT_MARKERS = ("/auth/", "/oauth/", "/webhook")

    class CsrfProtectMiddleware:
        def __init__(self, app: ASGIApp) -> None:
            self.app = app

        async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
            if scope["type"] != "http":
                await self.app(scope, receive, send)
                return
            method = scope.get("method", "GET").upper()
            path = scope.get("path", "") or ""
            if (
                method in _CSRF_METHODS
                and path.startswith(settings.api_prefix)
                and not any(m in path for m in _CSRF_EXEMPT_MARKERS)
            ):
                headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
                has_bearer = headers.get("authorization", "").lower().startswith("bearer ")
                cookie = headers.get("cookie", "")
                has_session_cookie = "aa_access=" in cookie or "aa_refresh=" in cookie
                # Only cookie-authenticated requests without a bearer token are CSRF-exposed.
                if has_session_cookie and not has_bearer and not headers.get("x-requested-with"):
                    resp = JSONResponse(
                        status_code=403,
                        content={"detail": "Missing X-Requested-With header (CSRF protection)."},
                    )
                    await resp(scope, receive, send)
                    return
            await self.app(scope, receive, send)

    app.add_middleware(CsrfProtectMiddleware)

    # I5.2: Prometheus scrape endpoint. Optionally protected by METRICS_TOKEN
    # (Bearer or ?token=). Disable entirely with METRICS_ENABLED=0.
    _metrics_enabled = (os.environ.get("METRICS_ENABLED", "1") or "1").strip().lower() in {"1", "true", "yes", "on"}
    _metrics_token = (os.environ.get("METRICS_TOKEN") or "").strip()

    @app.get("/metrics", include_in_schema=False)
    async def _metrics(request: Request):
        if not _metrics_enabled:
            return Response("metrics disabled", status_code=404)
        if not metrics_available():
            return Response("prometheus-client not installed", status_code=503)
        if _metrics_token:
            auth = request.headers.get("authorization", "")
            supplied = auth[7:].strip() if auth.lower().startswith("bearer ") else request.query_params.get("token", "")
            if supplied != _metrics_token:
                return Response("unauthorized", status_code=401)
        body, content_type = render_latest()
        return Response(content=body, media_type=content_type)

    @app.get("/", include_in_schema=False)
    async def _root():
        payload: dict = {
            "service": settings.app_name,
            "status": "ok",
            "health": f"{settings.api_prefix}/health",
        }
        if expose_docs:
            payload["docs"] = "/docs"
        return payload

    origins = _effective_cors_origins()
    _log.info("CORS allow_origins: %s", ", ".join(origins))
    app.add_middleware(GZipMiddleware, minimum_size=1000)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Length", "Content-Type"],
    )

    # Outermost layer: some uncaught errors (e.g. ExceptionGroup from thread pools) bypass
    # Starlette CORS; ensure allowed browser origins still receive ACAO on error responses.
    allowed_origins = set(origins)

    class EnsureCorsASGIMiddleware:
        def __init__(self, inner: ASGIApp) -> None:
            self.app = inner

        async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
            if scope["type"] != "http":
                await self.app(scope, receive, send)
                return

            origin: str | None = None
            for name, value in scope.get("headers", []):
                if name == b"origin":
                    origin = value.decode("latin-1")
                    break
            allow_origin = origin if origin in allowed_origins else None

            async def send_wrapper(message: Message) -> None:
                if allow_origin and message["type"] == "http.response.start":
                    message.setdefault("headers", [])
                    headers = MutableHeaders(raw=message["headers"])
                    if "access-control-allow-origin" not in headers:
                        headers["Access-Control-Allow-Origin"] = allow_origin
                        headers["Access-Control-Allow-Credentials"] = "true"
                        headers["Vary"] = "Origin"
                await send(message)

            await self.app(scope, receive, send_wrapper)

    app.add_middleware(EnsureCorsASGIMiddleware)

    # Outermost layers: metrics wraps everything for full request latency, and the
    # request-id binder runs first so every log line (including the wrappers above)
    # carries a correlation id (I5.2 / I5.3).
    app.add_middleware(MetricsMiddleware)
    app.add_middleware(RequestIdMiddleware)

    app.include_router(api_router, prefix=settings.api_prefix)
    return app


app = create_app()
