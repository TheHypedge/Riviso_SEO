"""user_generation_slot: same account serializes, different accounts run concurrently."""

from __future__ import annotations

import asyncio

import pytest

from app.services.generation_queue import user_generation_slot


@pytest.mark.asyncio
async def test_same_user_jobs_never_overlap():
    order: list[str] = []

    async def job(tag: str, hold_seconds: float) -> None:
        async with user_generation_slot("user-a"):
            order.append(f"{tag}:start")
            await asyncio.sleep(hold_seconds)
            order.append(f"{tag}:end")

    await asyncio.gather(job("first", 0.05), job("second", 0.0))

    assert order == ["first:start", "first:end", "second:start", "second:end"]


@pytest.mark.asyncio
async def test_different_users_run_concurrently():
    started = asyncio.Event()
    overlapped = False

    async def slow_job() -> None:
        nonlocal overlapped
        async with user_generation_slot("user-a"):
            started.set()
            await asyncio.sleep(0.1)

    async def other_user_job() -> None:
        nonlocal overlapped
        await started.wait()
        async with user_generation_slot("user-b"):
            # If user-b had to wait for user-a's lock, this would only run
            # after slow_job releases its slot ~0.1s later than started.set().
            overlapped = True

    await asyncio.gather(slow_job(), other_user_job())
    assert overlapped is True
