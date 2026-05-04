"""Stable user-id comparisons across JWT, MongoDB, and legacy data."""

from __future__ import annotations

import re

_UUID_DASHED = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_HEX32 = re.compile(r"^[0-9a-f]{32}$", re.IGNORECASE)
_OID24 = re.compile(r"^[0-9a-f]{24}$", re.IGNORECASE)


def _uuid_hex_norm(s: str) -> str | None:
    """Canonical 32-hex form for UUID strings (with or without dashes)."""
    t = (s or "").strip()
    if not t:
        return None
    if _UUID_DASHED.match(t):
        return t.replace("-", "").casefold()
    if len(t) == 32 and _HEX32.match(t):
        return t.casefold()
    return None


def _objectid_hex_norm(s: str) -> str | None:
    t = (s or "").strip()
    if len(t) == 24 and _OID24.match(t):
        return t.casefold()
    return None


def user_ids_equal(a: str | None, b: str | None) -> bool:
    """
    True when two ids refer to the same user.

    Handles: exact match, case-only differences, dashed vs undashed UUID, and
    24-hex legacy ObjectId strings compared case-insensitively.
    """
    xa = (a or "").strip()
    xb = (b or "").strip()
    if not xa or not xb:
        return False
    if xa == xb:
        return True
    if xa.casefold() == xb.casefold():
        return True
    ha, hb = _uuid_hex_norm(xa), _uuid_hex_norm(xb)
    if ha and hb and ha == hb:
        return True
    oa, ob = _objectid_hex_norm(xa), _objectid_hex_norm(xb)
    if oa and ob and oa == ob:
        return True
    return False
