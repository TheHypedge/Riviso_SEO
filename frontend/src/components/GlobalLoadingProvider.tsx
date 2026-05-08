"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

type GlobalLoadingApi = {
  show: () => void;
  hide: () => void;
  isLoading: boolean;
};

const GlobalLoadingContext = createContext<GlobalLoadingApi | null>(null);

function clampNonNegative(n: number) {
  return n < 0 ? 0 : n;
}

export function GlobalLoadingProvider({ children }: { children: React.ReactNode }) {
  const [pendingCount, setPendingCount] = useState(0);
  const [visible, setVisible] = useState(false);
  const [statusLines, setStatusLines] = useState<string[]>([]);

  const show = useCallback(() => setPendingCount((c) => c + 1), []);
  const hide = useCallback(() => setPendingCount((c) => clampNonNegative(c - 1)), []);

  useEffect(() => {
    const handler = (evt: Event) => {
      const ce = evt as CustomEvent<{ delta?: number }>;
      const delta = ce?.detail?.delta ?? 0;
      if (!delta) return;
      setPendingCount((c) => clampNonNegative(c + delta));
    };

    window.addEventListener("aa:loading", handler as EventListener);
    return () => window.removeEventListener("aa:loading", handler as EventListener);
  }, []);

  useEffect(() => {
    const handler = (evt: Event) => {
      const ce = evt as CustomEvent<{ lines?: string[] | null }>;
      const lines = ce?.detail?.lines;
      if (lines === null) {
        setStatusLines([]);
        return;
      }
      if (Array.isArray(lines)) setStatusLines(lines.filter(Boolean));
    };
    window.addEventListener("aa:loadingStatus", handler as EventListener);
    return () => window.removeEventListener("aa:loadingStatus", handler as EventListener);
  }, []);

  useEffect(() => {
    if (pendingCount > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVisible(true);
      return;
    }
    // Keep overlay visible briefly so the user can read "completed".
    const t = window.setTimeout(() => {
      setVisible(false);
      setStatusLines([]);
    }, 650);
    return () => window.clearTimeout(t);
  }, [pendingCount]);

  const value = useMemo(
    () => ({
      show,
      hide,
      isLoading: pendingCount > 0,
    }),
    [hide, pendingCount, show],
  );

  return (
    <GlobalLoadingContext.Provider value={value}>
      {children}
      <GlobalLoadingOverlay open={visible} statusLines={statusLines} />
    </GlobalLoadingContext.Provider>
  );
}

export function useGlobalLoading() {
  const ctx = useContext(GlobalLoadingContext);
  if (!ctx) throw new Error("useGlobalLoading must be used within GlobalLoadingProvider");
  return ctx;
}

function GlobalLoadingOverlay({ open, statusLines }: { open: boolean; statusLines: string[] }) {
  if (!open) return null;

  return (
    <div className="aaLoadingOverlay" role="status" aria-live="polite" aria-label="Loading">
      <div className="aaLoadingPanel">
        <div className="aaLoadingGlow" />
        <div className="aaLoadingSpinner">
          <div className="aaLoadingRing" />
          <div className="aaLoadingRing aaLoadingRing2" />
        </div>
        <div className="aaLoadingText">Working…</div>
        <div className="aaLoadingSub">
          {statusLines.length ? (
            <div className="aaLoadingSteps">
              {statusLines.map((s, idx) => (
                <div key={`${idx}-${s}`} className={idx === statusLines.length - 1 ? "aaLoadingStep aaLoadingStepActive" : "aaLoadingStep"}>
                  {s}
                </div>
              ))}
            </div>
          ) : (
            "Generating premium results"
          )}
        </div>
      </div>
    </div>
  );
}

