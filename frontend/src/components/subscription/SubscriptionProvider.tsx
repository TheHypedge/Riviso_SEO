"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { api, getAccessToken, SubscriptionStatusPublic } from "@/lib/api";

import { TrialUpgradeModal } from "./TrialUpgradeModal";
import { TrialCountdownBanner } from "./TrialCountdownBanner";

type SubscriptionContextValue = {
  status: SubscriptionStatusPublic | null;
  loading: boolean;
  trialExpired: boolean;
  refresh: () => Promise<void>;
};

const SubscriptionContext = createContext<SubscriptionContextValue>({
  status: null,
  loading: true,
  trialExpired: false,
  refresh: async () => {},
});

/** Refresh usage/trial state periodically — not every minute (too noisy on the API). */
const SUBSCRIPTION_POLL_MS = 5 * 60_000;

export function useSubscription() {
  return useContext(SubscriptionContext);
}

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SubscriptionStatusPublic | null>(null);
  const [loading, setLoading] = useState(true);
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

  const value = useMemo(
    () => ({ status, loading, trialExpired, refresh }),
    [status, loading, trialExpired, refresh],
  );

  return (
    <SubscriptionContext.Provider value={value}>
      {status && !trialExpired ? <TrialCountdownBanner status={status} /> : null}
      {children}
      {trialExpired ? <TrialUpgradeModal status={status} /> : null}
    </SubscriptionContext.Provider>
  );
}
