"""Prometheus metrics (I5.2) — dependency-safe.

Exposes request rate / latency / in-flight gauges and a hook for queue depth and
Mongo/OpenAI op timing. If ``prometheus-client`` is not installed the middleware
is a transparent pass-through and ``/metrics`` reports unavailable, so the app
runs unchanged without the dependency.

Cardinality is kept bounded by labelling on the matched *route template*
(``/api/projects/{project_id}/articles``) rather than the raw path.
"""

from __future__ import annotations

import time

from starlette.types import ASGIApp, Message, Receive, Scope, Send

try:  # optional dependency
    from prometheus_client import (
        CONTENT_TYPE_LATEST,
        REGISTRY,
        Counter,
        Gauge,
        Histogram,
        generate_latest,
    )

    _ENABLED = True
except Exception:  # pragma: no cover - exercised only when dep is missing
    _ENABLED = False


def metrics_available() -> bool:
    return _ENABLED


if _ENABLED:
    HTTP_REQUESTS = Counter(
        "riviso_http_requests_total",
        "Total HTTP requests.",
        ["method", "path", "status"],
    )
    HTTP_LATENCY = Histogram(
        "riviso_http_request_duration_seconds",
        "HTTP request latency in seconds.",
        ["method", "path"],
    )
    HTTP_IN_PROGRESS = Gauge(
        "riviso_http_requests_in_progress",
        "In-flight HTTP requests.",
    )
    GENERATION_QUEUE_DEPTH = Gauge(
        "riviso_generation_queue_depth",
        "Pending jobs in the generation queue.",
    )


def _route_template(scope: Scope) -> str:
    route = scope.get("route")
    path = getattr(route, "path", None)
    if isinstance(path, str) and path:
        return path
    return "other"


def set_queue_depth(depth: int) -> None:
    if _ENABLED:
        try:
            GENERATION_QUEUE_DEPTH.set(int(depth))
        except Exception:
            pass


def render_latest() -> tuple[bytes, str]:
    if not _ENABLED:
        return b"prometheus-client not installed\n", "text/plain; charset=utf-8"
    return generate_latest(REGISTRY), CONTENT_TYPE_LATEST


class MetricsMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not _ENABLED or scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "GET")
        status_code = {"code": 500}
        start = time.perf_counter()
        HTTP_IN_PROGRESS.inc()

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status_code["code"] = int(message.get("status", 500))
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            HTTP_IN_PROGRESS.dec()
            path = _route_template(scope)
            elapsed = time.perf_counter() - start
            try:
                HTTP_LATENCY.labels(method=method, path=path).observe(elapsed)
                HTTP_REQUESTS.labels(method=method, path=path, status=str(status_code["code"])).inc()
            except Exception:
                pass
