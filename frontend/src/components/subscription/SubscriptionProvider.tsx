"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";

import { api, getAccessToken, SubscriptionStatusPublic } from "@/lib/api";

import { TrialCountdownBanner, UpgradeRequiredModal } from "./TrialCountdownBanner";
import { PENDING_PAYMENT_ORDER_KEY } from "@/components/billing/CheckoutModal";

// Public/pre-account routes -- login, registration, password recovery, and the static
// legal pages. A trial/subscription banner (or a payment-recovery check) has no meaning
// here: these pages exist for people who aren't in an authenticated app session yet, even
// if a stale "was logged in" marker happens to still be sitting in localStorage from a
// previous session on the same browser. Exact-match, not prefix, since /projects and
// /dashboard (the actual app) must keep working exactly as before.
const PUBLIC_ROUTES = new Set([
  "/",
  "/login",
  "/forgot-password",
  "/reset-password",
  "/privacy-policy",
  "/terms",
  "/data-privacy-policy",
  "/cookie-policy",
  "/disclaimer",
  "/refund-policy",
  "/grievance-redressal",
]);

type SubscriptionContextValue = {
  status: SubscriptionStatusPublic | null;
  loading: boolean;
  trialExpired: boolean;
  subscriptionExpired: boolean;
  refresh: () => Promise<void>;
  openUpgradeModal: () => void;
};

const SubscriptionContext = createContext<SubscriptionContextValue>({
  status: null,
  loading: true,
  trialExpired: false,
  subscriptionExpired: false,
  refresh: async () => {},
  openUpgradeModal: () => {},
});

const SUBSCRIPTION_POLL_MS = 5 * 60_000;

export function useSubscription() {
  return useContext(SubscriptionContext);
}

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const onPublicRoute = PUBLIC_ROUTES.has(pathname || "");
  const [status, setStatus] = useState<SubscriptionStatusPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [recoveredPaymentNotice, setRecoveredPaymentNotice] = useState<string | null>(null);
  const inflightRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (onPublicRoute || !getAccessToken()) {
      setStatus(null);
      setLoading(false);
      return;
    }
    if (inflightRef.current) {
      await inflightRef.current;
      return;
    }
    const run = (async () => {
      try {
        const row = await api.getSubscriptionStatus();
        setStatus(row);
      } catch {
        setStatus(null);
      } finally {
        setLoading(false);
      }
    })();
    inflightRef.current = run;
    try {
      await run;
    } finally {
      inflightRef.current = null;
    }
  }, [onPublicRoute]);

  useEffect(() => {
    void refresh();

    const poll = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void refresh();
    };

    const id = window.setInterval(poll, SUBSCRIPTION_POLL_MS);

    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // Recovery for a payment whose client-side confirmation never arrived (tab closed or
  // network dropped after paying, before Razorpay's handler callback fired). The backend's
  // webhook and 15-minute reconciliation sweep are the real source of truth; this just
  // notices the outcome next time the app is open, rather than leaving the user with no
  // idea whether their payment went through.
  useEffect(() => {
    if (onPublicRoute || !getAccessToken()) return;
    let orderId: string | null = null;
    try {
      orderId = window.localStorage.getItem(PENDING_PAYMENT_ORDER_KEY);
    } catch {
      return;
    }
    if (!orderId) return;

    let cancelled = false;
    (async () => {
      const maxAttempts = 20; // ~1 minute at 3s/poll -- the reconciliation sweep itself
      // runs server-side regardless, so this is just how long THIS tab waits to notice.
      for (let i = 0; i < maxAttempts && !cancelled; i++) {
        try {
          const res = await api.getRazorpayPaymentStatus(orderId, { skipGlobalLoading: true });
          if (res.status === "paid") {
            try {
              window.localStorage.removeItem(PENDING_PAYMENT_ORDER_KEY);
            } catch {
              /* ignore */
            }
            setRecoveredPaymentNotice("Payment confirmed — your plan is now active.");
            window.setTimeout(() => setRecoveredPaymentNotice(null), 6000);
            void refresh();
            return;
          }
          if (res.status === "failed") {
            try {
              window.localStorage.removeItem(PENDING_PAYMENT_ORDER_KEY);
            } catch {
              /* ignore */
            }
            return; // abandoned/declined -- nothing to tell the user about after the fact
          }
        } catch {
          // transient poll failure -- keep trying rather than giving up on one hiccup
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trialExpired = status?.status === "trial_expired";
  const subscriptionExpired = status?.status === "subscription_expired";

  const openUpgradeModal = useCallback(() => setShowUpgradeModal(true), []);

  const value = useMemo(
    () => ({ status, loading, trialExpired, subscriptionExpired, refresh, openUpgradeModal }),
    [status, loading, trialExpired, subscriptionExpired, refresh, openUpgradeModal],
  );

  return (
    <SubscriptionContext.Provider value={value}>
      {/* Banner: handles active trial (dismissible) and expired (permanent). Never on
          public/pre-account routes, even if a stale session marker + real status briefly
          resolve there (e.g. an already-logged-in user revisiting "/"). */}
      {status && !onPublicRoute ? <TrialCountdownBanner status={status} /> : null}
      {children}
      {/* Upgrade Required modal — triggered by locked feature clicks (which don't exist
          on public routes, but gate it anyway for the same belt-and-suspenders reason). */}
      {showUpgradeModal && !onPublicRoute && <UpgradeRequiredModal onClose={() => setShowUpgradeModal(false)} />}
      {/* One-off recovery notice for a payment confirmed after the tab reopened */}
      {recoveredPaymentNotice ? (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: 20,
            right: 20,
            zIndex: "var(--z-toast)",
            background: "var(--aa-success, #2e8b57)",
            color: "#fff",
            padding: "12px 18px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
          }}
        >
          {recoveredPaymentNotice}
        </div>
      ) : null}
    </SubscriptionContext.Provider>
  );
}
