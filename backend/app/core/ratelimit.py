from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address

# Shared limiter instance for app + route decorators.
limiter = Limiter(key_func=get_remote_address, default_limits=["300/minute"])

