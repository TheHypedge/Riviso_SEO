"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { api, getAccessToken, SubscriptionStatusPublic } from "@/lib/api";

import { TrialCountdownBanner, UpgradeRequiredModal } from "./TrialCountdownBanner";

type SubscriptionContextValue = {
  status: SubscriptionStatusPublic | null;
  loading: boolean;
  trialExpired: boolean;
  refresh: () => Promise<void>;
  openUpgradeModal: () => void;
};

const SubscriptionContext = createContext<SubscriptionContextValue>({
  status: null,
  loading: true,
  trialExpired: false,
  refresh: async () => {},
  openUpgradeModal: () => {},
});

const SUBSCRIPTION_POLL_MS = 5 * 60_000;

export function useSubscription() {
  return useContext(SubscriptionContext);
}

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SubscriptionStatusPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const inflightRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (!getAccessToken()) {
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
  }, []);

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

  const trialExpired = status?.status === "trial_expired";

  const openUpgradeModal = useCallback(() => setShowUpgradeModal(true), []);

  const value = useMemo(
    () => ({ status, loading, trialExpired, refresh, openUpgradeModal }),
    [status, loading, trialExpired, refresh, openUpgradeModal],
  );

  return (
    <SubscriptionContext.Provider value={value}>
      {/* Banner: handles active trial (dismissible) and expired (permanent) */}
      {status ? <TrialCountdownBanner status={status} /> : null}
      {children}
      {/* Upgrade Required modal — triggered by locked feature clicks */}
      {showUpgradeModal && <UpgradeRequiredModal onClose={() => setShowUpgradeModal(false)} />}
    </SubscriptionContext.Provider>
  );
}
