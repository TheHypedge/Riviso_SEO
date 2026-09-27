"""
Razorpay payment routes -- one-time-per-cycle billing (not Razorpay Subscriptions).

Two independent confirmation paths both funnel into ``_mark_payment_paid``, which is
idempotent: the client-side ``/verify`` call (fast, but lost if the tab closes or the
network drops) and the server-to-server ``/webhook`` (slower, but guaranteed-eventually
-consistent). Whichever arrives first does the work; the other is a safe no-op. A
background reconciliation sweep (``app.services.subscription_reconcile_service``) covers
the case where *neither* arrives promptly.

Access enforcement is declarative, not driven by this module: a paid payment sets
``current_period_start``/``current_period_end`` on the subscription doc, and
``plan_gatekeeper.assert_subscription_active()`` computes lockout from that date at
check-time, exactly like today's trial expiry -- nothing here ever "downgrades" a user.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.core.config import settings
from app.core.deps import get_current_user
from app.core.ratelimit import limiter
from app.legacy.storage import get_legacy_storage_module
from app.services import razorpay_client
from app.services.to_thread import run_sync

log = logging.getLogger(__name__)

router = APIRouter(prefix="/payments", tags=["payments"])
plans_router = APIRouter(prefix="/plans", tags=["payments"])

# One-time-per-cycle billing period. A fixed 30-day window (rather than "same day next
# calendar month") sidesteps end-of-month edge cases (e.g. a Jan 31 purchase) for a v1
# where exact calendar-month billing isn't a stated requirement.
_BILLING_PERIOD_DAYS = 30


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class PlanSummary(BaseModel):
    key: str
    name: str
    cost_monthly: float
    max_projects: int | None = None
    max_articles_per_month: int | None = None
    allow_scheduling: bool = True
    allow_export: bool = True
    allow_bulk_upload: bool = True


class CreateOrderRequest(BaseModel):
    plan_key: str


class CreateOrderResponse(BaseModel):
    order_id: str
    amount_paise: int
    currency: str
    key_id: str
    plan_key: str
    plan_name: str


class VerifyPaymentRequest(BaseModel):
    razorpay_order_id: str
    razorpay_payment_id: str
    razorpay_signature: str


def _resolve_paid_plan(st, plan_key: str) -> dict:
    plans = st.load_plans() or {}
    plan = plans.get((plan_key or "").strip().lower())
    if not isinstance(plan, dict):
        raise HTTPException(status_code=404, detail="Unknown plan")
    if plan.get("is_trial_plan"):
        raise HTTPException(status_code=400, detail="The trial plan cannot be purchased")
    cost = float(plan.get("cost_monthly") or 0)
    if cost <= 0:
        raise HTTPException(status_code=400, detail="This plan has no price configured")
    return plan


@plans_router.get("/available", response_model=list[PlanSummary])
async def list_available_plans(_: dict = Depends(get_current_user)) -> list[PlanSummary]:
    """Purchasable (non-trial, priced) plans for the in-app plan picker."""
    st = get_legacy_storage_module()
    plans = await run_sync(st.load_plans) or {}
    out: list[PlanSummary] = []
    for key, plan in plans.items():
        if not isinstance(plan, dict) or plan.get("is_trial_plan"):
            continue
        cost = float(plan.get("cost_monthly") or 0)
        if cost <= 0:
            continue
        out.append(PlanSummary(
            key=str(plan.get("key") or key),
            name=str(plan.get("name") or key),
            cost_monthly=cost,
            max_projects=plan.get("max_projects"),
            max_articles_per_month=plan.get("max_articles_per_month"),
            allow_scheduling=bool(plan.get("allow_scheduling", True)),
            allow_export=bool(plan.get("allow_export", True)),
            allow_bulk_upload=bool(plan.get("allow_bulk_upload", True)),
        ))
    out.sort(key=lambda p: p.cost_monthly)
    return out


@router.post("/razorpay/order", response_model=CreateOrderResponse)
@limiter.limit("10/minute")
async def create_razorpay_order(
    payload: CreateOrderRequest,
    request: Request,
    user: dict = Depends(get_current_user),
) -> CreateOrderResponse:
    if not settings.razorpay_configured:
        raise HTTPException(status_code=503, detail="Payments are not available right now")

    st = get_legacy_storage_module()
    plan_key = (payload.plan_key or "").strip().lower()
    plan = await run_sync(_resolve_paid_plan, st, plan_key)
    # The client never sends an amount -- it is always looked up server-side from the
    # plan record, so a tampered client request cannot pay less than the real price.
    amount_paise = razorpay_client.rupees_to_paise(float(plan.get("cost_monthly") or 0))
    uid = (user.get("id") or "").strip()
    receipt = f"riviso_{uid[:12]}_{uuid.uuid4().hex[:8]}"

    try:
        order = await run_sync(
            razorpay_client.create_order,
            amount_paise=amount_paise,
            currency="INR",
            receipt=receipt,
            notes={"user_id": uid, "plan_key": plan_key},
        )
    except Exception as e:
        log.exception("razorpay: order creation failed for user=%s plan=%s", uid, plan_key)
        raise HTTPException(status_code=502, detail="Could not start checkout. Please try again.") from e

    razorpay_order_id = (order.get("id") or "").strip()
    if not razorpay_order_id:
        raise HTTPException(status_code=502, detail="Could not start checkout. Please try again.")

    now = _now_iso()
    await run_sync(
        st.create_payment_order,
        {
            "id": str(uuid.uuid4()),
            "user_id": uid,
            "plan_key": plan_key,
            "razorpay_order_id": razorpay_order_id,
            "razorpay_payment_id": None,
            "razorpay_signature": None,
            "amount_paise": amount_paise,
            "currency": "INR",
            "status": "created",
            "failure_reason": None,
            "created_at": now,
            "updated_at": now,
            "paid_at": None,
        },
    )
    return CreateOrderResponse(
        order_id=razorpay_order_id,
        amount_paise=amount_paise,
        currency="INR",
        key_id=settings.razorpay_key_id,
        plan_key=plan_key,
        plan_name=str(plan.get("name") or plan_key),
    )


async def _mark_payment_paid(*, order_id: str, payment_id: str | None, signature: str | None) -> dict:
    """Idempotent: no-ops if the order is already ``paid`` (safe whichever of
    ``/verify``/``/webhook`` arrives second). Marks the payment paid, extends the
    subscription's billing period, assigns the plan, and fires receipt/plan-change email."""
    st = get_legacy_storage_module()
    payment = await run_sync(st.get_payment_by_order_id, order_id)
    if not payment:
        raise HTTPException(status_code=404, detail="Unknown order")
    if payment.get("status") == "paid":
        return payment

    now_dt = datetime.now(timezone.utc)
    now = now_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    period_end = (now_dt + timedelta(days=_BILLING_PERIOD_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")

    payment_updates = {
        "status": "paid",
        "razorpay_payment_id": payment_id or payment.get("razorpay_payment_id"),
        "razorpay_signature": signature or payment.get("razorpay_signature"),
        "paid_at": now,
        "updated_at": now,
    }
    await run_sync(st.update_payment_fields, order_id, payment_updates)

    uid = payment["user_id"]
    plan_key = payment["plan_key"]
    await run_sync(
        st.patch_subscription_fields,
        uid,
        {
            "current_period_start": now,
            "current_period_end": period_end,
            "last_payment_order_id": order_id,
            # Reset so the new cycle's own 7d/3d/1d/expired reminders can fire again --
            # otherwise a renewing user's milestones would already all be "seen" forever.
            "payment_notified_milestones": [],
        },
    )
    # Reuses exactly the mechanism the admin "change user's plan" route already uses --
    # plan_gatekeeper.py needs no new integration point to pick this up.
    await run_sync(st.update_user_fields, uid, {"subscription_type": plan_key})

    try:
        user = await run_sync(st.get_user_by_id, uid)
        plans = await run_sync(st.load_plans) or {}
        plan = plans.get(plan_key) or {}
        plan_name = str(plan.get("name") or plan_key)
        to_email = (user or {}).get("email") or ""
        if to_email:
            from app.services.email_dispatch import dispatch_payment_receipt_email, dispatch_plan_notification_email

            dispatch_plan_notification_email(to=to_email, plan_name=plan_name)
            dispatch_payment_receipt_email(
                to=to_email,
                order_id=order_id,
                amount_paise=int(payment.get("amount_paise") or 0),
                plan_name=plan_name,
                period_end=period_end,
            )
    except Exception:
        # Email failure must never undo a successful payment.
        log.exception("razorpay: post-payment email dispatch failed for order=%s", order_id)

    return {**payment, **payment_updates}


@router.post("/razorpay/verify")
async def verify_razorpay_payment(payload: VerifyPaymentRequest, user: dict = Depends(get_current_user)) -> dict:
    st = get_legacy_storage_module()
    order_id = (payload.razorpay_order_id or "").strip()
    payment = await run_sync(st.get_payment_by_order_id, order_id)
    if not payment:
        raise HTTPException(status_code=404, detail="Unknown order")
    if (payment.get("user_id") or "").strip() != (user.get("id") or "").strip():
        raise HTTPException(status_code=403, detail="This order does not belong to you")

    if payment.get("status") != "paid":
        valid = razorpay_client.verify_payment_signature(
            order_id=order_id,
            payment_id=payload.razorpay_payment_id,
            signature=payload.razorpay_signature,
        )
        if not valid:
            await run_sync(
                st.update_payment_fields,
                order_id,
                {"status": "failed", "failure_reason": "signature_mismatch", "updated_at": _now_iso()},
            )
            raise HTTPException(status_code=400, detail="Payment verification failed")
        await _mark_payment_paid(
            order_id=order_id,
            payment_id=payload.razorpay_payment_id,
            signature=payload.razorpay_signature,
        )

    from app.services.plan_gatekeeper import build_subscription_status

    fresh_user = await run_sync(st.get_user_by_id, user["id"])
    return await run_sync(build_subscription_status, st=st, user=fresh_user)


@router.post("/razorpay/webhook")
async def razorpay_webhook(request: Request) -> dict:
    """Razorpay calls this server-to-server -- no auth, no CSRF (path contains
    ``/webhook``, already exempt in ``app.main``'s CSRF middleware). The raw body is used
    for signature verification; it must never be re-serialized from parsed JSON first."""
    if not settings.razorpay_configured:
        raise HTTPException(status_code=503, detail="Payments are not available right now")

    raw_body = await request.body()
    signature = request.headers.get("X-Razorpay-Signature", "")
    if not razorpay_client.verify_webhook_signature(raw_body=raw_body, signature=signature):
        raise HTTPException(status_code=400, detail="Invalid signature")

    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except Exception as e:
        raise HTTPException(status_code=400, detail="Invalid payload") from e

    st = get_legacy_storage_module()
    event_id = request.headers.get("x-razorpay-event-id", "") or str(payload.get("id") or "")
    first_time = await run_sync(st.mark_webhook_event_seen, event_id)
    if not first_time:
        return {"ok": True, "duplicate": True}

    event = (payload.get("event") or "").strip()
    entity = (((payload.get("payload") or {}).get("payment") or {}).get("entity")) or {}
    order_id = (entity.get("order_id") or "").strip()
    payment_id = (entity.get("id") or "").strip()

    if event == "payment.captured" and order_id:
        try:
            await _mark_payment_paid(order_id=order_id, payment_id=payment_id, signature=None)
        except HTTPException:
            log.warning("razorpay webhook: payment.captured for unknown order_id=%s", order_id)
    elif event == "payment.failed" and order_id:
        reason = entity.get("error_description") or entity.get("error_reason") or "payment_failed"
        try:
            existing = await run_sync(st.get_payment_by_order_id, order_id)
            if existing and existing.get("status") != "paid" and existing.get("status") != "failed":
                user = await run_sync(st.get_user_by_id, existing.get("user_id"))
                plans = await run_sync(st.load_plans) or {}
                plan_name = str((plans.get(existing.get("plan_key")) or {}).get("name") or existing.get("plan_key"))
                to_email = (user or {}).get("email") or ""
                if to_email:
                    from app.services.email_dispatch import dispatch_payment_failed_email

                    dispatch_payment_failed_email(to=to_email, plan_name=plan_name, reason=str(reason))
        except Exception:
            log.exception("razorpay webhook: failed-payment email dispatch error for order=%s", order_id)
        await run_sync(
            st.update_payment_fields,
            order_id,
            {
                "status": "failed",
                "razorpay_payment_id": payment_id or None,
                "failure_reason": str(reason)[:500],
                "updated_at": _now_iso(),
            },
        )

    return {"ok": True}


@router.get("/razorpay/status/{order_id}")
async def razorpay_payment_status(order_id: str, user: dict = Depends(get_current_user)) -> dict:
    """Polled by the frontend when the client-side confirmation never resolves (tab
    closed mid-payment, network dropped) -- the resilience pattern already established
    for article generation status, applied to checkout."""
    st = get_legacy_storage_module()
    payment = await run_sync(st.get_payment_by_order_id, order_id)
    if not payment or (payment.get("user_id") or "").strip() != (user.get("id") or "").strip():
        raise HTTPException(status_code=404, detail="Unknown order")
    return {
        "order_id": order_id,
        "status": payment.get("status"),
        "plan_key": payment.get("plan_key"),
        "failure_reason": payment.get("failure_reason"),
    }


@router.get("/history")
async def payment_history(user: dict = Depends(get_current_user)) -> list[dict]:
    st = get_legacy_storage_module()
    rows = await run_sync(st.load_payments_for_user, user["id"], 20)
    return [
        {
            "order_id": r.get("razorpay_order_id"),
            "plan_key": r.get("plan_key"),
            "amount_paise": r.get("amount_paise"),
            "currency": r.get("currency"),
            "status": r.get("status"),
            "created_at": r.get("created_at"),
            "paid_at": r.get("paid_at"),
        }
        for r in rows
    ]
