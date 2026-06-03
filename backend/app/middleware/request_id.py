"""Per-request correlation id middleware (I5.3).

Reads an inbound ``X-Request-ID`` (so an upstream proxy / the frontend can supply
one) or generates a short id, binds it to ``structlog`` contextvars for the life
of the request so every log line in that request carries ``request_id``, and
echoes it back in the ``X-Request-ID`` response header for client-side
correlation. Implemented as pure ASGI to avoid ``BaseHTTPMiddleware`` pitfalls
(it also runs cleanly around the existing CORS/error wrappers).
"""

from __future__ import annotations

import uuid

import structlog
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

_HEADER = "x-request-id"
_MAX_LEN = 128


def _sanitize(raw: str) -> str:
    out = "".join(ch for ch in raw if ch.isalnum() or ch in "-_.")
    return out[:_MAX_LEN]


class RequestIdMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        incoming = ""
        for name, value in scope.get("headers", []):
            if name == _HEADER.encode("latin-1"):
                incoming = _sanitize(value.decode("latin-1"))
                break
        request_id = incoming or uuid.uuid4().hex[:16]

        structlog.contextvars.bind_contextvars(request_id=request_id)

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                headers = MutableHeaders(raw=message["headers"])
                if _HEADER not in headers:
                    headers[_HEADER] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            structlog.contextvars.unbind_contextvars("request_id")
