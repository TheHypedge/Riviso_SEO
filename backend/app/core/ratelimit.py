"""
Global SlowAPI rate limiter (IP-based via ``X-Forwarded-For`` / remote addr).

Mounted in ``app.main`` together with ``SlowAPIMiddleware``. Tune ``default_limits``
for capacity planning (consider proxy-aware IP headers).
"""

from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address, default_limits=["300/minute"])

