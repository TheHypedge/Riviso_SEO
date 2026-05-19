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

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.gzip import GZipMiddleware
from starlette.datastructures import MutableHeaders
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from app.core.ratelimit import limiter

from app.api.router import api_router
from app.core.config import settings
from app.core.logging import configure_logging
from app.core.production import run_startup_checks
from app.services.scheduler import scheduler_loop
from app.services.generation_worker import start_generation_worker, stop_generation_worker
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
        "https://riviso.cloud",
        "https://www.riviso.cloud",
    ]
)


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
    merged: list[str] = []
    seen: set[str] = set()
    for o in list(_LOCAL_DEV_ORIGINS) + user + _parse_cors_origins(_DEFAULT_CORS_ORIGINS):
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

    scheduler_task: asyncio.Task | None = None
    generation_worker_task: asyncio.Task | None = None

    enable_worker = (os.environ.get("ENABLE_GENERATION_WORKER", "1") or "1").strip()
    if enable_worker in {"1", "true", "yes", "on"}:
        generation_worker_task = start_generation_worker()

    enable = (os.environ.get("ENABLE_SCHEDULER", "1") or "1").strip()
    if enable in {"1", "true", "yes", "on"}:
        # One task per process; use ENABLE_SCHEDULER=0 when running multiple uvicorn workers.
        scheduler_task = asyncio.create_task(scheduler_loop(poll_seconds=10.0))

    yield

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
                    headers = MutableHeaders(scope=message)
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
                    headers = MutableHeaders(scope=message)
                    if "access-control-allow-origin" not in headers:
                        headers["Access-Control-Allow-Origin"] = allow_origin
                        headers["Access-Control-Allow-Credentials"] = "true"
                        headers.append("Vary", "Origin")
                await send(message)

            await self.app(scope, receive, send_wrapper)

    app.add_middleware(EnsureCorsASGIMiddleware)

    @app.exception_handler(BaseExceptionGroup)
    async def _exception_group_handler(request: Request, exc: BaseExceptionGroup) -> JSONResponse:
        for sub in exc.exceptions:
            if isinstance(sub, HTTPException):
                return JSONResponse(
                    status_code=sub.status_code,
                    content={"detail": sub.detail},
                    headers=dict(sub.headers or {}),
                )
        _log.exception("ExceptionGroup on %s %s", request.method, request.url.path, exc_info=exc)
        return JSONResponse(status_code=500, content={"detail": "Internal server error"})

    app.include_router(api_router, prefix=settings.api_prefix)
    return app


app = create_app()
