from __future__ import annotations

import os
import asyncio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from app.core.ratelimit import limiter

from app.api.router import api_router
from app.core.config import settings
from app.core.logging import configure_logging
from app.services.scheduler import scheduler_loop


def create_app() -> FastAPI:
    configure_logging(level="INFO")

    app = FastAPI(title=settings.app_name)
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, lambda request, exc: Response("Rate limit exceeded", status_code=429))
    app.add_middleware(SlowAPIMiddleware)

    class SecurityHeadersMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            resp = await call_next(request)
            if "x-content-type-options" not in resp.headers:
                resp.headers["X-Content-Type-Options"] = "nosniff"
            if "x-frame-options" not in resp.headers:
                resp.headers["X-Frame-Options"] = "DENY"
            if "referrer-policy" not in resp.headers:
                resp.headers["Referrer-Policy"] = "no-referrer"
            # Reasonable baseline CSP for API responses (tight for browser contexts).
            if "content-security-policy" not in resp.headers:
                resp.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
            # Permissions policy baseline
            if "permissions-policy" not in resp.headers:
                resp.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
            return resp

    app.add_middleware(SecurityHeadersMiddleware)

    @app.on_event("startup")
    async def _start_scheduler() -> None:
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

    origins = [o.strip() for o in (settings.cors_origins or "").split(",") if o.strip()]
    if origins:
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

