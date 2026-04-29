from __future__ import annotations

from typing import Any, Callable, TypeVar

import anyio

T = TypeVar("T")


async def run_sync(fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """
    Run blocking (sync) functions off the event loop.

    This backend uses synchronous persistence (pymongo / JSON fallback). Calling it directly
    from `async def` routes blocks the event loop and makes every request feel slow.
    """

    def _call() -> T:
        return fn(*args, **kwargs)

    return await anyio.to_thread.run_sync(_call)

