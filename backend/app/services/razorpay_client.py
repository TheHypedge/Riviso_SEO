"""
Thin wrapper around Razorpay's official Python SDK.

Unlike most third-party integrations in this codebase (``gsc.py``, ``google_console_service.py``),
this deliberately uses the vendor SDK rather than a hand-rolled ``httpx`` client -- signature
verification (HMAC comparison) is exactly the class of security-critical code that should not be
reimplemented, the same reasoning that already justifies using ``cryptography.Fernet`` instead of
hand-rolled encryption elsewhere in this app.

The SDK is synchronous (``requests``-based); every call here must go through
``app.services.to_thread.run_sync`` from async route handlers.
"""

from __future__ import annotations

import logging
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

import razorpay
from razorpay.errors import SignatureVerificationError

from app.core.config import settings

log = logging.getLogger(__name__)

_client: razorpay.Client | None = None


def _get_client() -> razorpay.Client:
    global _client
    if _client is None:
        if not settings.razorpay_configured:
            raise RuntimeError("Razorpay is not configured (RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET missing)")
        _client = razorpay.Client(auth=(settings.razorpay_key_id, settings.razorpay_key_secret))
    return _client


def rupees_to_paise(amount_rupees: float) -> int:
    """Convert a rupee amount (e.g. ``plan.cost_monthly``) to integer paise for the Orders API.

    Uses Decimal rather than raw float multiplication to avoid rounding artifacts
    (e.g. ``999.99 * 100`` in binary floats is not exactly ``99999``).
    """
    return int((Decimal(str(amount_rupees)) * 100).to_integral_value(rounding=ROUND_HALF_UP))


def create_order(*, amount_paise: int, currency: str, receipt: str, notes: dict[str, str] | None = None) -> dict[str, Any]:
    """Create a Razorpay Order. ``payment_capture: 1`` auto-captures on successful authorization,
    so this app's simple one-time-per-cycle checkout never needs a separate manual-capture step
    (and the failure mode of "authorized but never captured" it would otherwise introduce)."""
    return _get_client().order.create(data={
        "amount": amount_paise,
        "currency": currency,
        "receipt": receipt[:40],  # Razorpay caps receipt at 40 chars
        "payment_capture": 1,
        "notes": notes or {},
    })


def fetch_order(order_id: str) -> dict[str, Any]:
    return _get_client().order.fetch(order_id)


def list_order_payments(order_id: str) -> list[dict[str, Any]]:
    """All payment attempts against an order -- used by the reconciliation sweep to find
    the captured payment_id for an order Razorpay reports as ``paid`` but whose
    confirmation (client callback or webhook) never reached us."""
    result = _get_client().order.payments(order_id)
    items = (result or {}).get("items") or []
    return [i for i in items if isinstance(i, dict)]


def fetch_payment(payment_id: str) -> dict[str, Any]:
    return _get_client().payment.fetch(payment_id)


def verify_payment_signature(*, order_id: str, payment_id: str, signature: str) -> bool:
    """True if the client-returned signature is genuine. False (never raised) on mismatch --
    an invalid signature is an entirely expected "someone tampered with the response" case, not
    an exceptional one, so callers can just branch on the return value."""
    try:
        _get_client().utility.verify_payment_signature({
            "razorpay_order_id": order_id,
            "razorpay_payment_id": payment_id,
            "razorpay_signature": signature,
        })
        return True
    except SignatureVerificationError:
        return False


def verify_webhook_signature(*, raw_body: bytes, signature: str) -> bool:
    """Verify Razorpay's webhook HMAC. ``raw_body`` MUST be the exact bytes read off the request
    before any JSON parsing -- re-serializing the parsed body produces a different signature and
    verification will always fail."""
    secret = (settings.razorpay_webhook_secret or "").strip()
    if not secret or not signature:
        return False
    try:
        _get_client().utility.verify_webhook_signature(raw_body.decode("utf-8"), signature, secret)
        return True
    except SignatureVerificationError:
        return False
    except Exception:
        log.exception("razorpay_client: unexpected error verifying webhook signature")
        return False
