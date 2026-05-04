from __future__ import annotations

import os
import asyncio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.datastructures import MutableHeaders
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from app.core.ratelimit import limiter

from app.api.router import api_router
from app.core.config import settings
from app.core.logging import configure_logging
from app.services.scheduler import scheduler_loop
from app.legacy.storage import get_legacy_storage_module

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
    Merge local dev origins with CORS_ORIGINS from env.

    Production-only CORS_ORIGINS (e.g. https://riviso.com) would otherwise block
    http://localhost:3000 and the UI shows "Failed to fetch" / missing ACAO header.
    """
    user = _parse_cors_origins(settings.cors_origins or "")
    merged: list[str] = []
    seen: set[str] = set()
    for o in list(_LOCAL_DEV_ORIGINS) + user:
        if o not in seen:
            seen.add(o)
            merged.append(o)
    if not user:
        for o in _parse_cors_origins(_DEFAULT_CORS_ORIGINS):
            if o not in seen:
                seen.add(o)
                merged.append(o)
    return merged


def create_app() -> FastAPI:
    configure_logging(level="INFO")

    app = FastAPI(title=settings.app_name)
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

    @app.on_event("startup")
    async def _start_scheduler() -> None:
        # Initialize storage early so we can fall back to JSON mode if Mongo is down.
        st = get_legacy_storage_module()
        if hasattr(st, "init_storage"):
            try:
                await asyncio.to_thread(st.init_storage)
            except Exception:
                pass

        enable = (os.environ.get("ENABLE_SCHEDULER", "1") or "1").strip()
        if enable not in {"1", "true", "yes", "on"}:
            return
        # In-process scheduler for dev. For production, run a separate worker.
        asyncio.create_task(scheduler_loop(poll_seconds=10.0))

    @app.get("/", include_in_schema=False)
    async def _root():
        return {
            "service": settings.app_name,
            "status": "ok",
            "docs": "/docs",
            "health": f"{settings.api_prefix}/health",
        }

    origins = _effective_cors_origins()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(api_router, prefix=settings.api_prefix)
    return app


app = create_app()

