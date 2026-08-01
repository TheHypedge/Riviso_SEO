"""
Encryption at rest for third-party credentials stored on project/user documents
(F0.2): WordPress application passwords, Shopify access tokens, and Google
Search Console OAuth tokens.

Dual-read rollout: :func:`encrypt_field` and :func:`decrypt_field` are both
idempotent and format-detecting, so this ships safely without a blocking
migration --

- New writes (anything going through ``_encrypt_project_secrets`` in
  ``storage.py``) are encrypted immediately.
- Reads (``_mongo_doc_to_project``) transparently decrypt either format --
  a value with the ``ENC_PREFIX`` is decrypted, anything else is assumed to
  be a pre-migration plaintext value and returned unchanged.
- ``scripts/migrate_encrypt_secrets.py`` re-encrypts existing plaintext rows
  in the background; if it never runs, or stalls partway, nothing breaks --
  old rows just keep working as plaintext until they're next written.
"""

from __future__ import annotations

import logging

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings

log = logging.getLogger("riviso.field_encryption")

ENC_PREFIX = "enc:v1:"

_fernet: Fernet | None = None
_fernet_load_attempted = False


def _get_fernet() -> Fernet | None:
    """Lazily build the Fernet instance. Returns None if no key is configured."""
    global _fernet, _fernet_load_attempted
    if _fernet_load_attempted:
        return _fernet
    _fernet_load_attempted = True
    key = (settings.field_encryption_key or "").strip()
    if not key:
        return None
    try:
        _fernet = Fernet(key.encode("ascii"))
    except Exception:
        log.error("FIELD_ENCRYPTION_KEY is set but not a valid Fernet key -- secrets will NOT be encrypted.")
        _fernet = None
    return _fernet


def encrypt_field(value: str | None) -> str:
    """Encrypt ``value`` for storage. Empty values and already-encrypted values pass through."""
    v = (value or "").strip()
    if not v or v.startswith(ENC_PREFIX):
        return v
    fernet = _get_fernet()
    if fernet is None:
        # No key configured (e.g. local dev) -- store as plaintext rather than crash.
        return v
    return ENC_PREFIX + fernet.encrypt(v.encode("utf-8")).decode("ascii")


def decrypt_field(value: str | None) -> str:
    """Decrypt ``value`` if encrypted; legacy plaintext (no prefix) passes through unchanged."""
    v = (value or "").strip()
    if not v or not v.startswith(ENC_PREFIX):
        return v
    fernet = _get_fernet()
    if fernet is None:
        log.error("Encountered an encrypted field but FIELD_ENCRYPTION_KEY is not configured.")
        return ""
    token = v[len(ENC_PREFIX):]
    try:
        return fernet.decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken:
        log.error("Failed to decrypt a field -- wrong/rotated key, or corrupted value.")
        return ""


def is_encrypted(value: str | None) -> bool:
    return bool(value) and value.startswith(ENC_PREFIX)
