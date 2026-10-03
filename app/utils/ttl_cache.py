"""Tiny in-process TTL cache with single-flight for hot aggregate endpoints."""

from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable, Hashable


class AsyncTTLCache:
    """Caches coroutine results per key for ``ttl`` seconds.

    Concurrent misses for the same key share one computation, so a burst of
    polling clients costs one query instead of one per client.
    """

    def __init__(self, ttl: float, max_entries: int = 512) -> None:
        self._ttl = ttl
        self._max = max_entries
        self._data: dict[Hashable, tuple[float, Any]] = {}
        self._inflight: dict[Hashable, asyncio.Future] = {}

    async def get_or_compute(self, key: Hashable, compute: Callable[[], Awaitable[Any]]) -> Any:
        now = time.monotonic()
        hit = self._data.get(key)
        if hit is not None and hit[0] > now:
            return hit[1]
        pending = self._inflight.get(key)
        if pending is not None:
            return await asyncio.shield(pending)
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._inflight[key] = fut
        try:
            value = await compute()
        except BaseException as e:
            fut.set_exception(e)
            fut.exception()
            raise
        finally:
            self._inflight.pop(key, None)
        if len(self._data) >= self._max:
            self._data = {k: v for k, v in self._data.items() if v[0] > now}
            if len(self._data) >= self._max:
                self._data.clear()
        self._data[key] = (time.monotonic() + self._ttl, value)
        fut.set_result(value)
        return value
