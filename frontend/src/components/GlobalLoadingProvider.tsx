"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import {
  PIPELINE_STAGE_LABELS,
  type PipelineEvent,
  cancelActivePipeline,
  pipelineStageProgress,
} from "@/lib/pipelineStream";

type GlobalLoadingApi = {
  show: () => void;
  hide: () => void;
  isLoading: boolean;
};

const GlobalLoadingContext = createContext<GlobalLoadingApi | null>(null);

function clampNonNegative(n: number) {
  return n < 0 ? 0 : n;
}

function formatLogTime(iso: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(11, 19) || iso;
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso.slice(11, 19) || iso;
  }
}

/** Pipeline SSE overlay only — routine API loads use page-level skeletons. */
export function GlobalLoadingProvider({ children }: { children: React.ReactNode }) {
  const [pendingCount, setPendingCount] = useState(0);
  const [pipelineEvents, setPipelineEvents] = useState<PipelineEvent[]>([]);
  const [pipelineActive, setPipelineActive] = useState(false);

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
      const ce = evt as CustomEvent<{ events?: PipelineEvent[]; active?: boolean }>;
      if (ce.detail?.events) setPipelineEvents(ce.detail.events);
      if (typeof ce.detail?.active === "boolean") setPipelineActive(ce.detail.active);
    };
    window.addEventListener("aa:pipelineProgress", handler as EventListener);
    return () => window.removeEventListener("aa:pipelineProgress", handler as EventListener);
  }, []);

  useEffect(() => {
    if (pipelineActive) return;
    const t = window.setTimeout(() => setPipelineEvents([]), 650);
    return () => window.clearTimeout(t);
  }, [pipelineActive]);

  const value = useMemo(
    () => ({
      show,
      hide,
      isLoading: pendingCount > 0,
    }),
    [hide, pendingCount, show],
  );

  const showOverlay = pipelineActive && pipelineEvents.length > 0;
  const latest = pipelineEvents[pipelineEvents.length - 1];
  const progressPct = pipelineStageProgress(latest?.stage);

  // Smooth display progress — ticks toward progressPct at ~0.2%/100ms so the bar
  // never looks frozen during long stages (e.g. openai_dispatch can take 10–60s).
  const targetPctRef = useRef(0);
  targetPctRef.current = progressPct;
  const [displayProgress, setDisplayProgress] = useState(0);

  useEffect(() => {
    if (!showOverlay) {
      setDisplayProgress(0);
      return;
    }
    const id = window.setInterval(() => {
      setDisplayProgress((prev) => {
        const target = targetPctRef.current;
        if (prev >= target) return target;
        const step = Math.max(0.15, (target - prev) * 0.05);
        return parseFloat(Math.min(target, prev + step).toFixed(1));
      });
    }, 100);
    return () => window.clearInterval(id);
  }, [showOverlay]);

  return (
    <GlobalLoadingContext.Provider value={value}>
      {children}
      <GlobalLoadingOverlay
        open={showOverlay}
        pipelineEvents={pipelineEvents}
        progressPct={displayProgress}
        latestStage={latest?.stage || ""}
      />
    </GlobalLoadingContext.Provider>
  );
}

export function useGlobalLoading() {
  const ctx = useContext(GlobalLoadingContext);
  if (!ctx) throw new Error("useGlobalLoading must be used within GlobalLoadingProvider");
  return ctx;
}

function GlobalLoadingOverlay({
  open,
  pipelineEvents,
  progressPct,
  latestStage,
}: {
  open: boolean;
  pipelineEvents: PipelineEvent[];
  progressPct: number;
  latestStage: string;
}) {
  const logScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = logScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [pipelineEvents.length, pipelineEvents[pipelineEvents.length - 1]?.message]);

  if (!open) return null;

  const stageLabel = PIPELINE_STAGE_LABELS[latestStage] || (latestStage ? latestStage.replace(/_/g, " ") : "Working");

  return (
    <div className="aaLoadingOverlay" role="status" aria-live="polite" aria-label="Pipeline progress">
      <div className="aaLoadingPanel aaLoadingPanelWide">
        <div className="aaLoadingGlow" />
        <div className="aaLoadingSpinner">
          <div className="aaLoadingRing" />
          <div className="aaLoadingRing aaLoadingRing2" />
        </div>
        <div className="aaLoadingText">Pipeline in progress</div>
        <div className="aaLoadingSub">
          <div className="aaPipelineMeta">
            <span className="aaPipelineStageBadge">{stageLabel}</span>
            <span className="aaPipelineProgressPct">{progressPct}%</span>
          </div>
          <div className="aaPipelineProgressTrack" aria-hidden>
            <div className="aaPipelineProgressFill" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="aaPipelineTerminal" aria-label="Live pipeline log">
            <div className="aaPipelineTerminalHeader">
              <span className="aaPipelineTerminalDot" />
              <span className="aaPipelineTerminalDot aaPipelineTerminalDotMid" />
              <span className="aaPipelineTerminalDot aaPipelineTerminalDotDim" />
              <span className="aaPipelineTerminalTitle">riviso pipeline stream</span>
            </div>
            <div className="aaPipelineLogScroll" ref={logScrollRef}>
              {pipelineEvents.map((ev, idx) => {
                const isLatest = idx === pipelineEvents.length - 1;
                const isError = ev.stage === "error";
                const isComplete = ev.stage === "complete";
                return (
                  <div
                    key={`${idx}-${ev.time}-${ev.stage}`}
                    className={`aaPipelineLogRow ${isLatest ? "aaPipelineLogRowActive" : ""} ${isError ? "aaPipelineLogRowError" : ""} ${isComplete ? "aaPipelineLogRowComplete" : ""}`}
                  >
                    <span className="aaPipelineLogTime">{formatLogTime(ev.time)}</span>
                    <span className="aaPipelineLogMsg">{ev.message}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <button
            type="button"
            className="aaPipelineCancelBtn"
            onClick={cancelActivePipeline}
          >
            Cancel Generation
          </button>
        </div>
      </div>
    </div>
  );
}
