"""
Password hashing (F2.3): Argon2id for new hashes, going forward.

Correction from the original audit: production's actual stored hashes are
werkzeug's ``scrypt:32768:8:1$...`` format (werkzeug 3.x's default), not PBKDF2
as first assumed -- scrypt is already memory-hard and an OWASP-acceptable
choice. This migration is a best-practice alignment (Argon2id is OWASP's #1
recommendation) rather than closing an active weakness.

Opportunistic rehash on login, no bulk migration: :func:`verify_password`
returns the new Argon2 hash whenever it successfully verifies a legacy
werkzeug hash, for the caller to persist. Verification transparently detects
which library produced the stored hash by its format prefix -- passlib's
argon2/pbkdf2_sha256 schemes use MCF strings starting with ``$``; werkzeug's
scrypt/pbkdf2 hashes use ``method:params$salt$hash``, which passlib can't
parse, so those still fall back to ``werkzeug.security.check_password_hash``.
"""

from __future__ import annotations

from passlib.context import CryptContext
from werkzeug.security import check_password_hash as _werkzeug_check

_pwd_context = CryptContext(schemes=["argon2", "pbkdf2_sha256"], deprecated="auto")


def hash_password(password: str) -> str:
    """Hash a new/changed password. Always Argon2id going forward."""
    return _pwd_context.hash(password)


def verify_password(password: str, stored_hash: str) -> tuple[bool, str | None]:
    """
    Verify ``password`` against ``stored_hash``.

    Returns ``(is_valid, upgraded_hash)``. ``upgraded_hash`` is non-None only
    when verification succeeded against a hash the caller should replace --
    either a legacy werkzeug hash (always upgraded) or a passlib hash flagged
    deprecated by the CryptContext above (e.g. a pdkdf2_sha256 one, should
    that scheme ever be produced). Callers should persist it via a normal
    update_user_fields-style call; if that write fails or is skipped, nothing
    breaks -- the next successful login just offers the same upgrade again.
    """
    h = (stored_hash or "").strip()
    if not h:
        return False, None

    if h.startswith("$"):
        # passlib-produced hash (argon2 or pbkdf2_sha256 MCF string).
        try:
            valid = _pwd_context.verify(password, h)
        except ValueError:
            return False, None
        if not valid:
            return False, None
        if _pwd_context.needs_update(h):
            return True, hash_password(password)
        return True, None

    # Legacy werkzeug format (scrypt:... or pbkdf2:sha256:...) -- werkzeug's
    # own format, not something passlib's schemes can parse.
    if not _werkzeug_check(h, password):
        return False, None
    return True, hash_password(password)
