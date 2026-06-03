"""
Standalone background process runner (I3.1).

Runs the generation worker and/or the scheduler (and the daily subscription
reset) **outside** the API process, so a long OpenAI generation or a slow
publish never contends with request handling. Toggle each loop with env flags:

    ENABLE_GENERATION_WORKER=1   # run the generation worker loop
    ENABLE_SCHEDULER=1           # run the scheduler loop (+ subscription daily reset)

Recommended topology for ~50 users (see RIVISO_PRODUCTION_HARDENING_PLAN I3.1):

    api        : ENABLE_SCHEDULER=0  ENABLE_GENERATION_WORKER=0  -> uvicorn app.main:app
    worker     : ENABLE_GENERATION_WORKER=1 ENABLE_SCHEDULER=0   -> python -m app.run_background
    scheduler  : ENABLE_SCHEDULER=1 ENABLE_GENERATION_WORKER=0   -> python -m app.run_background

Run with:  python -m app.run_background
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import time

from app.core.config import settings
from app.core.logging import configure_logging
from app.core.observability import init_sentry
from app.core.production import run_startup_checks
from app.legacy.storage import get_legacy_storage_module
from app.services.generation_worker import generation_worker_loop
from app.services.scheduler import scheduler_loop
from app.services.subscription_daily_reset import subscription_daily_reset_loop

_log = logging.getLogger("riviso.background")

# I3.7: sentinel files that the Docker healthcheck probes to confirm each loop
# is still making progress. Touched every heartbeat interval by _heartbeat_loop.
_WORKER_HEARTBEAT = "/tmp/riviso_worker.heartbeat"
_SCHEDULER_HEARTBEAT = "/tmp/riviso_scheduler.heartbeat"
_HEARTBEAT_INTERVAL = 30  # seconds


async def _heartbeat_loop(path: str) -> None:
    """Touch a sentinel file every interval so the Docker healthcheck can detect hangs."""
    while True:
        try:
            with open(path, "w") as f:
                f.write(str(time.time()))
        except Exception:
            pass
        await asyncio.sleep(_HEARTBEAT_INTERVAL)


def _flag_enabled(name: str, default: str = "0") -> bool:
    return (os.environ.get(name, default) or default).strip().lower() in {"1", "true", "yes", "on"}


async def _init_storage() -> None:
    st = get_legacy_storage_module()
    if hasattr(st, "init_storage"):
        try:
            await asyncio.to_thread(st.init_storage)
        except Exception:
            # JSON fallback may still run if Mongo is unavailable.
            _log.warning("init_storage failed; continuing with fallback if available", exc_info=True)
    if hasattr(st, "storage_mode"):
        try:
            mode = await asyncio.to_thread(st.storage_mode)
            _log.info("Background runner storage backend: %s", mode)
        except Exception:
            pass


async def _run() -> None:
    configure_logging(level="INFO")
    # I5.1: error tracking for the background process (no-op unless SENTRY_DSN set).
    init_sentry("worker")
    # Same fail-fast production guards as the API (insecure SECRET_KEY / TLS escape hatches).
    run_startup_checks(settings)
    await _init_storage()

    run_worker = _flag_enabled("ENABLE_GENERATION_WORKER")
    run_scheduler = _flag_enabled("ENABLE_SCHEDULER")

    if not run_worker and not run_scheduler:
        _log.error(
            "Nothing to run: set ENABLE_GENERATION_WORKER=1 and/or ENABLE_SCHEDULER=1. Exiting."
        )
        return

    tasks: list[asyncio.Task] = []
    if run_worker:
        _log.info("Starting generation worker loop")
        tasks.append(asyncio.create_task(generation_worker_loop(), name="generation_worker"))
        tasks.append(asyncio.create_task(_heartbeat_loop(_WORKER_HEARTBEAT), name="worker_heartbeat"))
    if run_scheduler:
        _log.info("Starting scheduler loop + subscription daily reset")
        tasks.append(asyncio.create_task(scheduler_loop(poll_seconds=10.0), name="scheduler"))
        tasks.append(asyncio.create_task(subscription_daily_reset_loop(), name="subscription_reset"))
        tasks.append(asyncio.create_task(_heartbeat_loop(_SCHEDULER_HEARTBEAT), name="scheduler_heartbeat"))

    stop = asyncio.Event()

    def _request_stop() -> None:
        _log.info("Shutdown signal received; stopping background loops")
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _request_stop)
        except (NotImplementedError, RuntimeError):
            # add_signal_handler is unavailable on some platforms (e.g. Windows).
            pass

    # Exit if any loop dies unexpectedly, or when a stop signal arrives.
    done, _pending = await asyncio.wait(
        [*tasks, asyncio.create_task(stop.wait(), name="stop_wait")],
        return_when=asyncio.FIRST_COMPLETED,
    )

    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    _log.info("Background runner stopped")


def main() -> None:
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
