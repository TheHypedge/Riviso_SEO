"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import type { TechnicalAuditIndexEntry, TechnicalAuditLatestResponse, TechnicalAuditRun, TechnicalAuditStrategyResult } from "@/lib/api";
import { withTechnicalResultDefaults } from "@/lib/technicalAudit";
import { type Strategy, categoryToFix, healthDelta, kindFromScore } from "@/lib/technicalAuditView";
import { formatShortDate, formatSiteAuditTimestamp } from "@/lib/technicalAuditFormat";
import { AuditDetailsPanel } from "@/components/technical-audit/AuditDetailsPanel";
import { CategoryAuditsTab } from "@/components/technical-audit/CategoryAuditsTab";
import { CoreWebVitalsPanel } from "@/components/technical-audit/CoreWebVitalsPanel";
import { DiagnosticsPanel } from "@/components/technical-audit/DiagnosticsPanel";
import { MetricComparisonTable } from "@/components/technical-audit/MetricComparisonTable";
import { OpportunitiesPanel } from "@/components/technical-audit/OpportunitiesPanel";
import { OtherMetricsPanel } from "@/components/technical-audit/OtherMetricsPanel";
import { PagePreview } from "@/components/technical-audit/PagePreview";
import { PerformanceScoreCard } from "@/components/technical-audit/PerformanceScoreCard";
import { TechnicalAuditExplainer } from "@/components/technical-audit/TechnicalAuditExplainer";
import { TechnicalAuditHeader } from "@/components/technical-audit/TechnicalAuditHeader";
import { type TaTab, TechnicalAuditTabs } from "@/components/technical-audit/TechnicalAuditTabs";
import { type CssModule, ScoreGauge } from "@/components/technical-audit/parts";

function pageSpeedInsightsUrl(url: string | null | undefined, strategy: Strategy): string | null {
  return url ? `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(url)}&form_factor=${strategy}` : null;
}

// Re-exported: SeoAuditResults and the project page import these from here.
export { ScoreGauge, formatSiteAuditTimestamp };

/* ── Running-state checklist: illustrative staged progress, not a claim of real
   per-stage backend status (mobile + desktop run concurrently server-side, so
   there's no genuine per-stage signal to bind to). Advances on a fixed timer so the
   page never sits on an empty/blank state while PSI's 20-45s round trip is in flight. */

const RUN_STAGES = ["Validating website", "Connecting to PageSpeed Insights", "Running mobile analysis", "Running desktop analysis"];

export function SiteAuditRunChecklist({ styles }: { styles: CssModule }) {
  const [stageIndex, setStageIndex] = useState(0);
  useEffect(() => {
    setStageIndex(0);
    const id = setInterval(() => {
      setStageIndex((i) => Math.min(i + 1, RUN_STAGES.length - 1));
    }, 4000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className={styles.siteAuditRunChecklist} role="status" aria-label="Running Technical Audit">
      {RUN_STAGES.map((label, i) => {
        const state = i < stageIndex ? "done" : i === stageIndex ? "active" : "pending";
        return (
          <div key={label} className={styles.siteAuditRunChecklistItem} data-state={state}>
            <span className={styles.siteAuditRunChecklistMark} aria-hidden="true">
              {state === "done" ? "✓" : state === "active" ? <span className={styles.siteAuditBtnSpinner} /> : "○"}
            </span>
            {label}
          </div>
        );
      })}
    </div>
  );
}

/* ── Trend chart: Mobile vs Desktop Performance over audit history ─────── */

type RangeKey = "7d" | "30d" | "3m" | "6m" | "1y" | "all";
const RANGE_DAYS: Record<RangeKey, number | null> = { "7d": 7, "30d": 30, "3m": 90, "6m": 180, "1y": 365, all: null };

function parseAuditDate(iso: string): number {
  const normalized = iso.includes("T") ? iso : iso.replace(" ", "T") + "Z";
  return new Date(normalized).getTime();
}

export function TechnicalAuditTrendChart({ history, styles }: { history: TechnicalAuditRun[]; styles: CssModule }) {
  const gradId = useId().replace(/:/g, "");
  const wrapRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<RangeKey>("30d");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; transform: string } | null>(null);

  // history arrives newest-first; the chart reads oldest-to-newest, filtered to the selected range.
  const points = useMemo(() => {
    const days = RANGE_DAYS[range];
    const cutoff = days ? Date.now() - days * 86400000 : null;
    return [...history]
      .filter((r) => !cutoff || parseAuditDate(r.created_at) >= cutoff)
      .sort((a, b) => parseAuditDate(a.created_at) - parseAuditDate(b.created_at));
  }, [history, range]);

  const W = 700;
  const H = 220;
  const padL = 36;
  const padR = 16;
  const padT = 20;
  const padB = 32;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const xForIndex = useCallback((i: number, n: number) => (n <= 1 ? padL + innerW / 2 : padL + (innerW * i) / (n - 1)), [innerW]);
  const yForScore = useCallback((v: number) => padT + innerH - (innerH * v) / 100, [innerH]);

  const series = useMemo(() => {
    const n = points.length;
    const mobile = points.map((p, i) => ({ x: xForIndex(i, n), y: yForScore(p.mobile?.scores?.performance ?? 0), v: p.mobile?.scores?.performance }));
    const desktop = points.map((p, i) => ({ x: xForIndex(i, n), y: yForScore(p.desktop?.scores?.performance ?? 0), v: p.desktop?.scores?.performance }));
    return { mobile, desktop };
  }, [points, xForIndex, yForScore]);

  const linePath = (pts: { x: number; y: number }[]) => (pts.length ? `M ${pts.map((p) => `${p.x} ${p.y}`).join(" L ")}` : "");

  const showTooltip = useCallback((index: number, clientX: number, clientY: number) => {
    const tipW = 180;
    const pad = 12;
    const clampedX = typeof window !== "undefined" ? Math.min(Math.max(clientX, tipW / 2 + pad), window.innerWidth - tipW / 2 - pad) : clientX;
    setHoverIndex(index);
    setTooltip({ x: clampedX, y: clientY, transform: "translate(-50%, calc(-100% - 12px))" });
  }, []);
  const hideTooltip = useCallback(() => {
    setHoverIndex(null);
    setTooltip(null);
  }, []);

  const hoverPoint = hoverIndex !== null ? points[hoverIndex] : null;
  const yTicks = [0, 25, 50, 75, 100];
  const colWidth = points.length > 1 ? innerW / (points.length - 1) : innerW;

  const tooltipEl =
    tooltip && hoverPoint ? (
      <div
        role="tooltip"
        style={{ position: "fixed", left: tooltip.x, top: tooltip.y, transform: tooltip.transform, zIndex: "var(--z-tooltip)" }}
        className={styles.siteAuditChartTooltip}
      >
        <div className={styles.siteAuditChartTooltipDate}>{formatSiteAuditTimestamp(hoverPoint.created_at)}</div>
        <div className={styles.siteAuditChartTooltipRow}>
          <span className={styles.siteAuditChartTooltipSwatch} style={{ background: "var(--aa-primary)" }} />
          Mobile <strong>{hoverPoint.mobile?.scores?.performance ?? "—"}</strong>
        </div>
        <div className={styles.siteAuditChartTooltipRow}>
          <span className={styles.siteAuditChartTooltipSwatch} style={{ background: "var(--aa-muted)" }} />
          Desktop <strong>{hoverPoint.desktop?.scores?.performance ?? "—"}</strong>
        </div>
      </div>
    ) : null;

  return (
    <div className={`${styles.card} ${styles.cardWide}`}>
      <div className={styles.analyticsHeaderRow}>
        <h3 className={styles.sectionTitle} style={{ fontSize: 15 }}>
          Performance Trend
        </h3>
        {points.length > 1 ? (
          <div className={styles.segmentGroup} aria-label="Date range">
            {(["7d", "30d", "3m", "6m", "1y", "all"] as const).map((r) => (
              <button key={r} type="button" className={styles.miniBtn} onClick={() => setRange(r)} aria-pressed={range === r}>
                {r === "all" ? "All" : r.toUpperCase()}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {points.length < 2 ? (
        <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
          Run a few more audits to see your performance trend over time.
        </p>
      ) : (
        <>
          <ul className={styles.siteAuditChartLegend} aria-hidden="true">
            <li>
              <span className={styles.siteAuditChartLegendSwatch} style={{ background: "var(--aa-primary)" }} /> Mobile
            </li>
            <li>
              <span className={styles.siteAuditChartLegendSwatch} style={{ background: "transparent", borderTop: "2px dashed var(--aa-muted)", height: 0 }} /> Desktop (dashed)
            </li>
          </ul>
          <div ref={wrapRef}>
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Mobile and desktop performance score trend" onMouseLeave={hideTooltip}>
              {yTicks.map((tick) => (
                <g key={tick}>
                  <line x1={padL} y1={yForScore(tick)} x2={W - padR} y2={yForScore(tick)} stroke="var(--aa-hairline)" strokeDasharray="4 6" />
                  <text x={padL - 8} y={yForScore(tick) + 4} textAnchor="end" fontSize={10} fill="var(--aa-muted)">
                    {tick}
                  </text>
                </g>
              ))}
              {hoverIndex !== null ? (
                <line x1={xForIndex(hoverIndex, points.length)} y1={padT} x2={xForIndex(hoverIndex, points.length)} y2={padT + innerH} stroke="var(--aa-hairline)" />
              ) : null}
              <path d={linePath(series.desktop)} fill="none" stroke="var(--aa-muted)" strokeDasharray="6 4" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              <path d={linePath(series.mobile)} fill="none" stroke="var(--aa-primary)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              {hoverIndex !== null ? (
                <>
                  <circle cx={series.mobile[hoverIndex]?.x} cy={series.mobile[hoverIndex]?.y} r={3.5} fill="var(--aa-primary)" stroke="var(--aa-surface-card)" strokeWidth={1.5} />
                  <circle cx={series.desktop[hoverIndex]?.x} cy={series.desktop[hoverIndex]?.y} r={3.5} fill="var(--aa-muted)" stroke="var(--aa-surface-card)" strokeWidth={1.5} />
                </>
              ) : null}
              {points.map((p, i) => (
                <rect
                  key={p.id}
                  x={padL + colWidth * (i - 0.5)}
                  y={padT}
                  width={colWidth}
                  height={innerH}
                  fill="transparent"
                  onMouseMove={(e) => showTooltip(i, e.clientX, e.clientY)}
                  onFocus={() => showTooltip(i, xForIndex(i, points.length), padT + innerH / 2)}
                  onBlur={hideTooltip}
                  tabIndex={0}
                  role="presentation"
                />
              ))}
              {points.map((p, i) =>
                i === 0 || i === points.length - 1 || i % Math.max(1, Math.floor(points.length / 5)) === 0 ? (
                  <text key={`lbl-${p.id}`} x={xForIndex(i, points.length)} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--aa-muted)">
                    {formatShortDate(p.created_at)}
                  </text>
                ) : null,
              )}
            </svg>
          </div>
        </>
      )}
      {typeof document !== "undefined" && tooltipEl ? createPortal(tooltipEl, document.body) : null}
    </div>
  );
}

/* ── Audit history: Date & Time · Mobile · Desktop · Change ─────────────── */

const HISTORY_CAP = 3;

export function TechnicalAuditHistoryList({
  history,
  selectedRunId,
  onSelectRun,
  styles,
}: {
  history: TechnicalAuditRun[];
  selectedRunId: string | null;
  onSelectRun: (id: string | null) => void;
  styles: CssModule;
}) {
  const [showAll, setShowAll] = useState(false);
  if (history.length === 0) return null;
  const visible = showAll ? history : history.slice(0, HISTORY_CAP);
  return (
    <section id="ta-history" aria-labelledby="ta-history-title" className={`${styles.card} ${styles.siteAuditPanel}`}>
      <div className={styles.siteAuditPanelHead}>
        <h3 id="ta-history-title" className={styles.siteAuditPanelTitle}>
          Audit History
        </h3>
      </div>
      <div className={styles.siteAuditHistoryHead} aria-hidden="true">
        <span>Date &amp; Time</span>
        <span>Mobile</span>
        <span>Desktop</span>
        <span>Change</span>
      </div>
      <ul className={styles.siteAuditHistoryList}>
        {visible.map((run, i) => {
          const isSelected = selectedRunId === run.id || (!selectedRunId && i === 0);
          // history is newest-first, so the run below this one is the previous audit.
          const older = history[history.indexOf(run) + 1];
          const sameSite = older && older.website_url === run.website_url;
          const change = sameSite ? healthDelta(run.mobile, older.mobile) : null;
          return (
            <li key={run.id}>
              <button
                type="button"
                className={styles.siteAuditHistoryRow}
                onClick={() => onSelectRun(history.indexOf(run) === 0 ? null : run.id)}
                aria-pressed={isSelected}
                aria-label={`Show audit from ${formatSiteAuditTimestamp(run.created_at)}`}
              >
                <span className={styles.siteAuditHistoryDate}>{formatSiteAuditTimestamp(run.created_at)}</span>
                <span className="tabular-nums">{run.mobile?.scores?.performance ?? "—"}</span>
                <span className="tabular-nums">{run.desktop?.scores?.performance ?? "—"}</span>
                <span className="tabular-nums">{change ?? "—"}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {history.length > HISTORY_CAP ? (
        <button type="button" className={styles.siteAuditViewAllBtn} onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
          {showAll ? "Show fewer" : `View all ${history.length} audits →`}
        </button>
      ) : null}
      <p className={styles.muted} style={{ margin: 0, fontSize: 11 }}>
        Mobile and Desktop show the Performance score. Change is the mobile Riviso Technical Health Score vs the audit before it.
      </p>
    </section>
  );
}

/* ── The Technical Audit screen (TECHNICAL_AUDIT_UI_SPEC v2) ─────────────── */

const CATEGORY_TITLES: Record<Exclude<TaTab, "overview">, string> = {
  performance: "Performance",
  accessibility: "Accessibility",
  best_practices: "Best Practices",
  seo: "PageSpeed SEO",
};
const SCORE_KEY: Record<Exclude<TaTab, "overview">, keyof TechnicalAuditStrategyResult["scores"]> = {
  performance: "performance",
  accessibility: "accessibility",
  best_practices: "best_practices",
  seo: "pagespeed_seo",
};

/** Old runs (no audits index) only have the failing diagnostics; show those as rows. */
function legacyDiagnostics(result: TechnicalAuditStrategyResult): TechnicalAuditIndexEntry[] {
  return result.diagnostics.map((d) => ({ ...d, category: "performance" as const, kind: kindFromScore(d.score) }));
}

export function TechnicalAuditScreen({
  projectId,
  latest,
  history,
  busy,
  running,
  justCompleted,
  error,
  strategy,
  onStrategyChange,
  selectedRunId,
  onSelectRun,
  onRun,
  onGoToSettings,
  onOpenSeoAudit,
  faviconUrl,
  styles,
}: {
  projectId: string;
  latest: TechnicalAuditLatestResponse | null;
  history: TechnicalAuditRun[];
  busy: boolean;
  running: boolean;
  justCompleted: boolean;
  error: string | null;
  strategy: Strategy;
  onStrategyChange: (s: Strategy) => void;
  selectedRunId: string | null;
  onSelectRun: (id: string | null) => void;
  onRun: () => void;
  onGoToSettings: () => void;
  onOpenSeoAudit: () => void;
  faviconUrl: string | null;
  styles: CssModule;
}) {
  const [tab, setTab] = useState<TaTab>("overview");
  const [learnOpen, setLearnOpen] = useState(false);
  // History rows omit the audits index; a selected run's full document is fetched once.
  const [fullRuns, setFullRuns] = useState<Record<string, TechnicalAuditRun>>({});
  const historyRow = selectedRunId ? history.find((r) => r.id === selectedRunId) || null : null;
  const run = (historyRow && fullRuns[historyRow.id]) || historyRow || latest?.audit || null;

  useEffect(() => {
    if (!historyRow || fullRuns[historyRow.id] || historyRow.mobile?.audits_index) return;
    let cancelled = false;
    api
      .getTechnicalAuditRun(projectId, historyRow.id)
      .then((res) => {
        if (!cancelled && res?.run) setFullRuns((m) => ({ ...m, [historyRow.id]: res.run }));
      })
      .catch(() => {
        /* the slim history row still renders; full lists show the "not stored" state */
      });
    return () => {
      cancelled = true;
    };
  }, [historyRow, fullRuns, projectId]);

  const idx = run ? history.findIndex((r) => r.id === run.id) : -1;
  const previousRun = idx >= 0 ? history[idx + 1] || null : history[1] || null;

  const rawResult: Partial<TechnicalAuditStrategyResult> | null | undefined = run ? (strategy === "mobile" ? run.mobile : run.desktop) : null;
  const result = useMemo(() => withTechnicalResultDefaults(rawResult || undefined), [rawResult]);
  const previous = previousRun ? withTechnicalResultDefaults(strategy === "mobile" ? previousRun.mobile : previousRun.desktop) : null;
  const comparable = !previousRun || !run || previousRun.website_url === run.website_url;
  const index = Array.isArray(rawResult?.audits_index) ? (rawResult!.audits_index as TechnicalAuditIndexEntry[]) : null;
  const stored = index !== null;
  const psiUrl = run ? pageSpeedInsightsUrl(result.final_url || run.website_url, strategy) : null;

  const opportunityIds = useMemo(() => new Set(result.opportunities.map((o) => o.id)), [result]);
  const diagnosticsRows = useMemo(
    () =>
      index
        ? index.filter((a) => a.category === "performance" && !opportunityIds.has(a.id) && ["passed", "warning", "failed", "informational"].includes(a.kind))
        : legacyDiagnostics(result),
    [index, opportunityIds, result],
  );
  const toFix = {
    performance: categoryToFix(index ?? undefined, "performance"),
    accessibility: categoryToFix(index ?? undefined, "accessibility"),
    best_practices: categoryToFix(index ?? undefined, "best_practices"),
    seo: categoryToFix(index ?? undefined, "seo"),
  };

  const header = (
    <TechnicalAuditHeader
      latest={latest}
      viewing={historyRow}
      displayed={run}
      busy={busy}
      running={running}
      justCompleted={justCompleted}
      error={error}
      faviconUrl={faviconUrl}
      onRun={onRun}
      onBackToLatest={() => onSelectRun(null)}
      onGoToSettings={onGoToSettings}
      onLearn={() => setLearnOpen(true)}
      styles={styles}
    />
  );
  const states = (
    <>
      {latest && !latest.pagespeed_configured ? (
        <div className={`${styles.card} ${styles.cardWide}`}>
          <p className={styles.muted} style={{ margin: 0 }}>
            Google PageSpeed Insights is not configured on the backend yet. Technical Audit will be available once it is.
          </p>
        </div>
      ) : null}
      {error ? (
        <div className={`${styles.card} ${styles.cardWide}`} style={{ borderColor: "var(--aa-error)" }} role="alert">
          <p style={{ margin: 0, color: "var(--aa-error)", fontSize: 14 }}>{error}</p>
        </div>
      ) : null}
      {running ? (
        <div className={`${styles.card} ${styles.cardWide}`}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Running Technical Audit</p>
          <SiteAuditRunChecklist styles={styles} />
          <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
            Fetching mobile and desktop results from PageSpeed Insights. This can take up to two minutes for heavy pages.
          </p>
        </div>
      ) : null}
      {!busy && latest && !latest.audit && !running && latest.website?.connected ? (
        <div className={`${styles.card} ${styles.cardWide}`} style={{ alignItems: "center", textAlign: "center", padding: "40px 24px" }}>
          <p style={{ margin: 0, fontWeight: 600 }}>No audit has been performed yet.</p>
          <p className={styles.muted} style={{ margin: 0, maxWidth: 440 }}>
            Run a Technical Audit to see performance, Core Web Vitals, accessibility, best practices and SEO checks for your site.
          </p>
        </div>
      ) : null}
    </>
  );
  const explainer = <TechnicalAuditExplainer open={learnOpen} onClose={() => setLearnOpen(false)} styles={styles} />;

  if (!run) {
    return (
      <>
        {header}
        {states}
        {explainer}
      </>
    );
  }

  const missingStrategy = !rawResult ? (
    <div className={`${styles.card} ${styles.cardWide}`} role="status">
      <p style={{ margin: 0, fontSize: 14 }}>
        {strategy === "mobile" ? "Mobile" : "Desktop"} results are missing for this run. Switch device or re-run the audit.
      </p>
    </div>
  ) : null;
  const warnings = result.run_warnings || [];

  return (
    <>
      {header}
      {states}
      <TechnicalAuditTabs active={tab} onChange={setTab} toFix={toFix} strategy={strategy} onStrategyChange={onStrategyChange} styles={styles} />
      {missingStrategy}
      {warnings.length ? (
        <div className={`${styles.card} ${styles.cardWide} ${styles.siteAuditWarningBanner}`} role="status">
          <strong>Lighthouse reported a problem with this test.</strong>
          <span>{warnings[0]}</span>
          <span className={styles.muted}>Scores below may not reflect your real page. Fix the issue and re-run the audit.</span>
        </div>
      ) : null}

      <div role="tabpanel" id={`ta-panel-${tab}`} aria-labelledby={`ta-tab-${tab}`} className={styles.analyticsStack}>
        {tab === "overview" ? (
          <>
            <div className={styles.siteAuditGridTop}>
              <PerformanceScoreCard
                title="Performance Score"
                score={result.scores.performance}
                previousScore={previous?.scores.performance ?? null}
                comparable={comparable}
                hasPrevious={previousRun !== null}
                strategy={strategy}
                styles={styles}
              />
              <div className={styles.siteAuditStack}>
                <CoreWebVitalsPanel key={`${run.id}-${strategy}`} result={result} strategy={strategy} onExplain={() => setLearnOpen(true)} styles={styles} />
                <OtherMetricsPanel result={result} styles={styles} />
              </div>
            </div>
            <div className={styles.siteAuditGridMain}>
              <div className={styles.siteAuditStack}>
                <OpportunitiesPanel key={`${run.id}-${strategy}`} opportunities={result.opportunities} stored={stored} psiUrl={psiUrl} styles={styles} />
                <DiagnosticsPanel key={`d-${run.id}-${strategy}`} rows={diagnosticsRows} stored={stored} styles={styles} />
              </div>
              <div className={styles.siteAuditStack}>
                <PagePreview result={result} strategy={strategy} onStrategyChange={onStrategyChange} pageUrl={result.final_url || run.website_url} styles={styles} />
                <AuditDetailsPanel run={run} result={result} strategy={strategy} psiUrl={psiUrl} styles={styles} />
                <section className={`${styles.card} ${styles.siteAuditPanel}`} aria-labelledby="ta-crawl-title">
                  <h3 id="ta-crawl-title" className={styles.siteAuditPanelTitle}>
                    Check how search engines crawl your site
                  </h3>
                  <p className={styles.muted} style={{ margin: 0, fontSize: 14 }}>
                    Technical issues like these can affect how users and search engines experience your pages.
                  </p>
                  <button type="button" className={styles.button} onClick={onOpenSeoAudit}>
                    Open SEO Audit
                  </button>
                </section>
              </div>
            </div>
            <section className={styles.siteAuditHistorySection} aria-label="History and device comparison">
              <MetricComparisonTable mobile={withTechnicalResultDefaults(run.mobile)} desktop={withTechnicalResultDefaults(run.desktop)} strategy={strategy} onStrategyChange={onStrategyChange} styles={styles} />
              <div className={styles.siteAuditGridHistory}>
                <section id="ta-trend" aria-label="Performance trend">
                  <TechnicalAuditTrendChart history={history} styles={styles} />
                </section>
                <TechnicalAuditHistoryList history={history} selectedRunId={selectedRunId} onSelectRun={onSelectRun} styles={styles} />
              </div>
            </section>
          </>
        ) : (
          <>
            <PerformanceScoreCard
              id={`ta-score-${tab}`}
              title={`${CATEGORY_TITLES[tab]} Score`}
              score={result.scores[SCORE_KEY[tab]]}
              previousScore={previous?.scores[SCORE_KEY[tab]] ?? null}
              comparable={comparable}
              hasPrevious={previousRun !== null}
              strategy={strategy}
              styles={styles}
            />
            {tab === "performance" ? (
              <>
                <CoreWebVitalsPanel key={`p-${run.id}-${strategy}`} result={result} strategy={strategy} onExplain={() => setLearnOpen(true)} styles={styles} />
                <OtherMetricsPanel result={result} styles={styles} />
                <OpportunitiesPanel key={`po-${run.id}-${strategy}`} opportunities={result.opportunities} stored={stored} psiUrl={psiUrl} styles={styles} />
              </>
            ) : null}
            <CategoryAuditsTab
              key={`${tab}-${run.id}-${strategy}`}
              rows={(index || []).filter((a) => a.category === tab)}
              stored={stored}
              note={
                tab === "seo" ? (
                  <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
                    This is Google&rsquo;s PageSpeed SEO category, not the Riviso SEO Audit.{" "}
                    <button type="button" className={styles.siteAuditTextButton} onClick={onOpenSeoAudit}>
                      Open SEO Audit →
                    </button>
                  </p>
                ) : null
              }
              styles={styles}
            />
          </>
        )}
      </div>
      {explainer}
    </>
  );
}

/* ── Bottom insight banner: rotating, evidence-based performance facts ──── */

const INSIGHT_FACTS: Array<{ title: string; body: string; href: string; hrefLabel: string }> = [
  {
    title: "Did you know?",
    body: "Google's Core Web Vitals use a 75th-percentile threshold: a page only passes LCP, INP, and CLS if at least 75% of real-user visits meet the “good” cutoff.",
    href: "https://web.dev/articles/defining-core-web-vitals-thresholds",
    hrefLabel: "View Performance Guide",
  },
  {
    title: "Did you know?",
    body: "Largest Contentful Paint (LCP) measures how quickly the largest visible element renders — Google's “good” threshold is 2.5 seconds or less.",
    href: "https://web.dev/articles/lcp",
    hrefLabel: "View Performance Guide",
  },
  {
    title: "Did you know?",
    body: "Interaction to Next Paint (INP) replaced First Input Delay as a Core Web Vital in 2024 — it measures responsiveness across a page's entire lifespan, not just the first interaction.",
    href: "https://web.dev/articles/inp",
    hrefLabel: "View Performance Guide",
  },
];

export function SiteAuditInsightBanner({ styles, seed }: { styles: CssModule; seed?: string }) {
  const index = useMemo(() => {
    if (!seed) return 0;
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return h % INSIGHT_FACTS.length;
  }, [seed]);
  const fact = INSIGHT_FACTS[index];
  return (
    <div className={styles.siteAuditInsightBanner}>
      <div className={styles.siteAuditInsightIcon} aria-hidden="true">
        💡
      </div>
      <div className={styles.siteAuditInsightBody}>
        <strong>{fact.title}</strong>
        <p style={{ margin: "2px 0 0", fontSize: 13 }}>{fact.body}</p>
      </div>
      <a href={fact.href} target="_blank" rel="noreferrer" className={styles.siteAuditInsightLink}>
        {fact.hrefLabel} →
      </a>
    </div>
  );
}

