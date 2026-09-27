"""
Background jobs for Razorpay one-time-per-cycle billing.

Two responsibilities, both called from the scheduler loop:

- ``reconcile_pending_payments`` -- the safety net for a dropped connection. If a user
  pays but the browser tab closes/loses the network before either the client-side
  ``/verify`` call or Razorpay's webhook confirms it, a ``payments`` doc is left stuck in
  ``created``/``attempted``. This sweep asks Razorpay directly for the true state of any
  such order older than a few minutes and resolves it -- the same "don't trust the
  client, ask the source of truth" principle used everywhere else in this app's
  resilient flows (article generation status polling, etc.).
- ``check_renewal_milestones`` -- mirrors ``trial_reminder_service.check_trial_milestones``
  exactly (same milestone shape, same idempotent-notification technique, including the
  copy-not-alias fix already learned there), but keyed on a paid subscription's
  ``current_period_end`` instead of ``trial_end_date``.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

log = logging.getLogger(__name__)

_MILESTONES = [
    ("7d", 7, "Your Riviso plan renews in one week. Renew now to avoid any interruption."),
    ("3d", 3, "Only three days left on your current billing period. Renew today."),
    ("1d", 1, "Your plan expires today. Renew now to keep your projects and content active."),
    ("expired", 0, "Your Riviso plan has expired. Renew your subscription to regain access."),
]


def _parse_iso(raw: str | None) -> datetime | None:
    s = (raw or "").strip()
    if not s:
        return None
    try:
        s2 = s.replace(" ", "T")
        if not s2.endswith("Z") and "+" not in s2[10:]:
            s2 += "Z"
        s2 = s2.replace("Z", "+00:00")
        return datetime.fromisoformat(s2)
    except Exception:
        return None


def _remaining_days(period_end: str | None) -> int | None:
    end = _parse_iso(period_end)
    if end is None:
        return None
    delta = end - datetime.now(timezone.utc)
    return max(-1, int(delta.total_seconds() // 86400))


async def check_renewal_milestones(st) -> None:
    """Check every user with an active (or just-ended) paid billing period and insert
    in-app notifications for approaching/passed renewal milestones. Each milestone fires
    at most once per billing cycle -- a renewal resets the tracked list (see
    ``payments.py::_mark_payment_paid``)."""
    from app.services.to_thread import run_sync

    try:
        users = await run_sync(st.list_users) if hasattr(st, "list_users") else []
    except Exception as exc:
        log.warning("subscription_reconcile: could not load users: %s", exc)
        return

    for user in (users or []):
        if not isinstance(user, dict):
            continue
        uid = (user.get("id") or "").strip()
        if not uid:
            continue

        try:
            sub = await run_sync(st.get_subscription_by_user_id, uid)
        except Exception:
            continue
        if not isinstance(sub, dict):
            continue

        period_end = sub.get("current_period_end")
        if not period_end:
            continue  # never paid, or on a plan with no period tracking

        days_left = _remaining_days(period_end)
        if days_left is None:
            continue

        # Copy, not alias -- see trial_reminder_service.py for why this matters: mutating
        # an aliased list would make the end-of-loop "did anything change" comparison
        # always true-equal, silently dropping the persisted update every time.
        existing_notified = sub.get("payment_notified_milestones")
        notified: list[str] = list(existing_notified) if isinstance(existing_notified, list) else []

        new_milestones: list[tuple[str, str]] = []
        for key, threshold, msg in _MILESTONES:
            if key in notified:
                continue
            if key == "expired":
                if days_left < 0:
                    new_milestones.append((key, msg))
            elif days_left <= threshold:
                new_milestones.append((key, msg))

        if not new_milestones:
            continue

        for key, msg in new_milestones:
            try:
                await run_sync(
                    st.insert_notification,
                    {
                        "id": str(uuid.uuid4()),
                        "user_id": uid,
                        "type": "subscription_renewal",
                        "title": "Subscription renewal",
                        "body": msg,
                        "data": {"milestone": key},
                        "read": False,
                        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                    },
                )
                notified.append(key)
                log.info("subscription_reconcile: notified user %s milestone=%s", uid, key)
            except Exception as exc:
                log.warning("subscription_reconcile: failed to insert notification uid=%s key=%s: %s", uid, key, exc)

        if notified != (sub.get("payment_notified_milestones") or []):
            try:
                await run_sync(st.patch_subscription_fields, uid, {"payment_notified_milestones": notified})
            except Exception as exc:
                log.warning("subscription_reconcile: failed to save milestones uid=%s: %s", uid, exc)


async def reconcile_pending_payments(st, *, older_than_minutes: int = 15) -> None:
    """Resolve any payment stuck in created/attempted by asking Razorpay directly --
    covers the case where neither the client callback nor the webhook arrived (dropped
    connection, closed tab, or a webhook delivery failure)."""
    from app.services.to_thread import run_sync
    from app.services import razorpay_client
    from app.api.routes.payments import _mark_payment_paid

    try:
        stale = await run_sync(st.load_stale_pending_payments, older_than_minutes)
    except Exception as exc:
        log.warning("subscription_reconcile: could not load stale payments: %s", exc)
        return

    for payment in (stale or []):
        order_id = (payment.get("razorpay_order_id") or "").strip()
        if not order_id:
            continue
        try:
            order = await run_sync(razorpay_client.fetch_order, order_id)
        except Exception as exc:
            log.warning("subscription_reconcile: fetch_order failed for %s: %s", order_id, exc)
            continue

        # Razorpay orders move to "paid" once a payment against them is captured.
        if (order.get("status") or "") == "paid":
            payment_id = None
            try:
                items = await run_sync(razorpay_client.list_order_payments, order_id)
                captured = next((p for p in items if (p.get("status") or "") == "captured"), None)
                if captured:
                    payment_id = (captured.get("id") or "").strip() or None
            except Exception:
                log.warning("subscription_reconcile: could not list payments for order %s", order_id)
            try:
                await _mark_payment_paid(order_id=order_id, payment_id=payment_id, signature=None)
                log.info("subscription_reconcile: resolved stale order %s as paid", order_id)
            except Exception:
                log.exception("subscription_reconcile: failed to mark order %s paid", order_id)
        else:
            # Anything still not "paid" this long after order creation is legitimately
            # abandoned/failed, not merely slow -- 15+ minutes is well past any realistic
            # checkout duration, so there is no "genuinely still waiting" case left here.
            try:
                await run_sync(
                    st.update_payment_fields,
                    order_id,
                    {
                        "status": "failed",
                        "failure_reason": f"reconciliation_timeout (razorpay status: {order.get('status') or 'unknown'})",
                        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    },
                )
                log.info("subscription_reconcile: marked stale order %s failed (status=%s)", order_id, order.get("status"))
            except Exception:
                log.exception("subscription_reconcile: failed to mark order %s failed", order_id)
