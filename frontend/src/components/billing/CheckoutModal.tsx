"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, Button, StatusPill } from "@/components/ui";
import { api, ApiError, type PlanSummary, type SubscriptionStatusPublic } from "@/lib/api";
import { connectionErrorMessage } from "@/lib/networkErrors";
import { useSubscription } from "@/components/subscription/SubscriptionProvider";
import { useRazorpayScript } from "@/lib/useRazorpayScript";
import { PlanPicker } from "./PlanPicker";

/** Remembered across a reload/tab-close so a background check can recover the outcome
 * of a payment whose client-side confirmation never arrived -- see SubscriptionProvider. */
export const PENDING_PAYMENT_ORDER_KEY = "riviso_pending_payment_order_id";

type Step = "pick" | "confirm" | "processing" | "verifying" | "success" | "failed";

function formatInr(rupees: number): string {
  return `₹${rupees.toLocaleString("en-IN")}`;
}

export function CheckoutModal({
  open,
  onClose,
  planKey,
  prefillEmail,
}: {
  open: boolean;
  onClose: () => void;
  /** Pre-selects a plan (e.g. opened from a specific locked-feature gate) and skips the
   * picker step. Omit to let the user choose from PlanPicker first. */
  planKey?: string;
  prefillEmail?: string;
}) {
  const { refresh: refreshSubscription } = useSubscription();
  const { ensureLoaded } = useRazorpayScript();
  const [step, setStep] = useState<Step>(planKey ? "confirm" : "pick");
  const [selectedPlan, setSelectedPlan] = useState<PlanSummary | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resultPlanName, setResultPlanName] = useState<string>("");
  const [resultPeriodEnd, setResultPeriodEnd] = useState<string | null>(null);
  const orderIdRef = useRef<string | null>(null);

  // Reset to a clean first step every time the modal is (re)opened.
  useEffect(() => {
    if (!open) return;
    setStep(planKey ? "confirm" : "pick");
    setAgreed(false);
    setErrorMessage(null);
  }, [open, planKey]);

  // Resolve the preselected plan's details once the plan list loads.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await api.listAvailablePlans();
        if (cancelled) return;
        if (planKey) {
          const match = rows.find((p) => p.key === planKey);
          if (match) setSelectedPlan(match);
        }
      } catch (e) {
        if (!cancelled) setErrorMessage(connectionErrorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, planKey]);

  const locked = step === "processing" || step === "verifying";

  const startCheckout = useCallback(async () => {
    if (!selectedPlan || !agreed) return;
    setErrorMessage(null);
    setStep("processing");

    const scriptReady = await ensureLoaded();
    if (!scriptReady) {
      setErrorMessage("Couldn't load the payment provider — check your connection and try again.");
      setStep("confirm");
      return;
    }

    let order;
    try {
      order = await api.createRazorpayOrder(selectedPlan.key);
    } catch (e) {
      setErrorMessage(connectionErrorMessage(e));
      setStep("confirm");
      return;
    }

    orderIdRef.current = order.order_id;
    try {
      window.localStorage.setItem(PENDING_PAYMENT_ORDER_KEY, order.order_id);
    } catch {
      /* localStorage unavailable (private window etc.) -- reconciliation fallback just won't apply */
    }

    if (!window.Razorpay) {
      setErrorMessage("Couldn't load the payment provider — check your connection and try again.");
      setStep("confirm");
      return;
    }

    const rzp = new window.Razorpay({
      key: order.key_id,
      amount: order.amount_paise,
      currency: order.currency,
      name: "Riviso",
      description: `${order.plan_name} — monthly subscription`,
      order_id: order.order_id,
      prefill: prefillEmail ? { email: prefillEmail } : undefined,
      theme: { color: "#e15a2c" },
      modal: {
        // The widget was closed with no payment made -- not a failure, just an
        // uncompleted attempt. No charge occurred; nothing to alarm the user about.
        ondismiss: () => {
          setErrorMessage("cancelled");
          setStep("failed");
        },
      },
      handler: (response: unknown) => {
        void (async () => {
          setStep("verifying");
          const r = response as { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };
          try {
            const status: SubscriptionStatusPublic = await api.verifyRazorpayPayment({
              razorpay_order_id: r.razorpay_order_id,
              razorpay_payment_id: r.razorpay_payment_id,
              razorpay_signature: r.razorpay_signature,
            });
            try {
              window.localStorage.removeItem(PENDING_PAYMENT_ORDER_KEY);
            } catch {
              /* ignore */
            }
            setResultPlanName(status.plan_name || selectedPlan.name);
            setResultPeriodEnd(status.current_period_end ?? null);
            setStep("success");
            void refreshSubscription();
          } catch (e) {
            // The network may well be fine and the payment may still be genuinely
            // captured -- verification failing here does not mean no charge happened.
            // The webhook and the 15-minute reconciliation sweep are the real safety
            // net; this message reflects that rather than claiming outright failure.
            const msg =
              e instanceof ApiError && e.status === 400
                ? "We couldn't confirm this payment. If an amount was charged, it will be reflected in your Billing History within a few minutes."
                : connectionErrorMessage(e);
            setErrorMessage(msg);
            setStep("failed");
          }
        })();
      },
    });
    rzp.on("payment.failed", (resp: unknown) => {
      const err = (resp as { error?: { description?: string } })?.error;
      setErrorMessage(err?.description || "Your payment was declined.");
      setStep("failed");
    });
    rzp.open();
  }, [selectedPlan, agreed, ensureLoaded, prefillEmail, refreshSubscription]);

  const retry = useCallback(() => {
    setErrorMessage(null);
    setStep("confirm");
  }, []);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !locked && onClose()}>
      <DialogContent
        showClose={!locked}
        onEscapeKeyDown={(e) => locked && e.preventDefault()}
        onPointerDownOutside={(e) => locked && e.preventDefault()}
      >
        {step === "pick" ? (
          <>
            <DialogHeader>
              <DialogTitle>Choose a plan</DialogTitle>
            </DialogHeader>
            {errorMessage ? <p className="mb-3 text-sm text-danger">{errorMessage}</p> : null}
            <PlanPicker
              onSelect={(plan) => {
                setSelectedPlan(plan);
                setStep("confirm");
              }}
            />
          </>
        ) : step === "confirm" ? (
          <>
            <DialogHeader>
              <DialogTitle>{selectedPlan ? selectedPlan.name : "Checkout"}</DialogTitle>
            </DialogHeader>
            {!selectedPlan ? (
              <p className="text-sm text-ink-secondary">Loading plan details…</p>
            ) : (
              <>
                <div className="mb-4 font-sans text-2xl font-bold text-ink">
                  {formatInr(selectedPlan.cost_monthly)}
                  <span className="text-sm font-normal text-ink-secondary"> / month</span>
                </div>
                <ul className="mb-4 flex flex-col gap-1.5 font-sans text-sm text-ink-secondary">
                  <li>✓ {selectedPlan.max_projects ? `${selectedPlan.max_projects} projects` : "Unlimited projects"}</li>
                  <li>✓ {selectedPlan.max_articles_per_month ? `${selectedPlan.max_articles_per_month} articles / month` : "Unlimited articles"}</li>
                  {selectedPlan.allow_scheduling ? <li>✓ Scheduling</li> : null}
                  {selectedPlan.allow_export ? <li>✓ Bulk export</li> : null}
                </ul>
                <label className="mb-4 flex items-start gap-2 font-sans text-xs text-ink-secondary">
                  <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5" required />
                  <span>
                    I agree to the{" "}
                    <Link href="/refund-policy" target="_blank" rel="noreferrer" className="text-accent underline">
                      Refund Policy
                    </Link>{" "}
                    and{" "}
                    <Link href="/terms" target="_blank" rel="noreferrer" className="text-accent underline">
                      Terms &amp; Conditions
                    </Link>
                    .
                  </span>
                </label>
                {errorMessage ? <p className="mb-3 text-sm text-danger">{errorMessage}</p> : null}
              </>
            )}
            <DialogFooter>
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!selectedPlan || !agreed}
                onClick={() => void startCheckout()}
              >
                {selectedPlan ? `Pay ${formatInr(selectedPlan.cost_monthly)}` : "Pay"}
              </Button>
            </DialogFooter>
          </>
        ) : step === "processing" ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-border-strong border-t-accent" aria-hidden="true" />
            <p className="font-sans text-sm text-ink-secondary">Opening secure checkout…</p>
          </div>
        ) : step === "verifying" ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-border-strong border-t-accent" aria-hidden="true" />
            <p className="font-sans text-sm font-semibold text-ink">Confirming your payment…</p>
            <p className="font-sans text-xs text-ink-secondary">Please don&apos;t close this window.</p>
          </div>
        ) : step === "success" ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <StatusPill status="success" label="Payment confirmed" />
            <p className="font-sans text-base font-semibold text-ink">You&apos;re now on {resultPlanName}</p>
            {resultPeriodEnd ? (
              <p className="font-sans text-xs text-ink-secondary">
                Renews on {new Date(resultPeriodEnd).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}
              </p>
            ) : null}
            <Button variant="primary" className="mt-2" onClick={onClose}>
              Continue
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <StatusPill status="danger" label="Payment wasn't completed" />
            <p className="font-sans text-sm text-ink-secondary">
              {errorMessage === "cancelled" ? "You closed the payment window before completing checkout." : errorMessage}
            </p>
            <div className="mt-2 flex gap-2">
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" onClick={retry}>
                Try again
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
