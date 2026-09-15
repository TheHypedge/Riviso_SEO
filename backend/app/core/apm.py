"""New Relic APM (I5.8) — background-transaction instrumentation.

Web transactions (every FastAPI/Starlette route) are captured automatically
by the New Relic Python agent's import-hook instrumentation once the process
is launched under ``newrelic-admin run-program`` (see docker-entrypoint.sh)
with ``NEW_RELIC_LICENSE_KEY`` set — no code changes needed for the API.

The worker and scheduler loops are plain asyncio, not a web framework, so
they get no automatic transactions. :func:`background_task` wraps a job's
entry point so it shows up in APM as its own transaction (with nested spans
for the OpenAI, MongoDB, WordPress/Shopify calls inside it, all
auto-instrumented by the agent).

No-ops completely when the ``newrelic`` package is not installed or the
agent was never initialised (no NEW_RELIC_LICENSE_KEY) — safe to leave these
decorators in place for local dev and tests, same contract as
:mod:`app.core.observability` (Sentry) and :mod:`app.core.metrics` (Prometheus).
"""

from __future__ import annotations

import functools
import logging
from typing import Any, Awaitable, Callable, TypeVar

_log = logging.getLogger("riviso.apm")

try:
    import newrelic.agent as _nr
except Exception:
    _nr = None

F = TypeVar("F", bound=Callable[..., Awaitable[Any]])


def background_task(name: str | None = None, group: str = "Riviso") -> Callable[[F], F]:
    """Wrap an async function as a New Relic non-web transaction. No-op without the agent."""

    def _decorate(fn: F) -> F:
        if _nr is None:
            return fn

        txn_name = name or fn.__name__

        @functools.wraps(fn)
        async def _wrapper(*args: Any, **kwargs: Any) -> Any:
            with _nr.BackgroundTask(_nr.application(), name=txn_name, group=group):
                return await fn(*args, **kwargs)

        return _wrapper  # type: ignore[return-value]

    return _decorate


def set_transaction_name(name: str, group: str | None = None) -> None:
    """Rename the currently-active transaction (e.g. by job kind). No-op without the agent."""
    if _nr is None:
        return
    try:
        _nr.set_transaction_name(name, group=group)
    except Exception:
        pass
