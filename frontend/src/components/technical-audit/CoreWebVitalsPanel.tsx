"use client";

import { useState } from "react";
import type { TechnicalAuditCwvEntry, TechnicalAuditFieldMetric, TechnicalAuditStrategyResult } from "@/lib/api";
import {
  CORE_WEB_VITALS,
  METRIC_LABELS,
  METRIC_SHORT,
  METRIC_THRESHOLDS,
  type MetricKey,
  type Strategy,
  distributionPercents,
  fieldAssessment,
  formatFieldValue,
  goodTarget,
  statusLabel,
} from "@/lib/technicalAuditView";
import { type CssModule, MetricThresholdBar, statusPillClass } from "./parts";

export function labTag(result: TechnicalAuditStrategyResult, strategy: Strategy): string {
  const device = (result.form_factor || strategy) === "desktop" ? "desktop" : "mobile";
  return `Lab test · emulated ${device}${result.lighthouse_version ? ` · Lighthouse ${result.lighthouse_version}` : ""}`;
}

/** Status for a lab entry, but only when it came from the lab audit itself. Runs stored
 * before 2026-10-20 mixed in real-user status, so theirs is not shown. */
export function labStatus(entry: TechnicalAuditCwvEntry | undefined): string | null {
  return entry && (entry.source === "lab" || entry.source == null) ? entry.status ?? null : null;
}

export function DistributionBar({ metric, styles }: { metric: TechnicalAuditFieldMetric | undefined; styles: CssModule }) {
  const pct = distributionPercents(metric);
  if (!pct) return null;
  const [good, ni, poor] = pct;
  return (
    <div className={styles.siteAuditDistribution}>
      <div className={styles.siteAuditDistributionBar} aria-hidden="true">
        <span data-band="good" style={{ width: `${good}%` }} />
        <span data-band="ni" style={{ width: `${ni}%` }} />
        <span data-band="poor" style={{ width: `${poor}%` }} />
      </div>
      <p className={styles.siteAuditDistributionText}>
        {good}% good · {ni}% needs improvement · {poor}% poor
      </p>
    </div>
  );
}

function OffScale({ metric, value, styles }: { metric: MetricKey; value: number | null | undefined; styles: CssModule }) {
  const t = METRIC_THRESHOLDS[metric];
  if (!t || typeof value !== "number" || value < t.poor * 2) return null;
  return <span className={styles.siteAuditSourceTag}>Beyond the end of the scale</span>;
}

/** Block E: LCP, INP, CLS from real users (Field) or the Lighthouse run (Lab). */
export function CoreWebVitalsPanel({ result, strategy, onExplain, styles }: { result: TechnicalAuditStrategyResult; strategy: Strategy; onExplain: () => void; styles: CssModule }) {
  const field = result.field || null;
  const hasField = Boolean(field && Object.keys(field.metrics || {}).length);
  const [mode, setMode] = useState<"field" | "lab" | null>(null);
  const view = mode ?? (hasField ? "field" : "lab");
  const assessment = fieldAssessment(field);
  const device = strategy === "mobile" ? "Mobile" : "Desktop";

  return (
    <section id="ta-cwv" aria-labelledby="ta-cwv-title" className={`${styles.card} ${styles.siteAuditPanel}`}>
      <div className={styles.siteAuditPanelHead}>
        <h3 id="ta-cwv-title" className={styles.siteAuditPanelTitle}>
          Core Web Vitals <span className={styles.muted}>({device})</span>
        </h3>
        <div className={styles.siteAuditPanelTools}>
          <div className={styles.segmentGroup} role="group" aria-label="Data source">
            <button
              type="button"
              className={styles.miniBtn}
              aria-pressed={view === "field"}
              disabled={!hasField}
              title={hasField ? undefined : "No real-user data available for this URL or origin"}
              onClick={() => setMode("field")}
            >
              Field Data
            </button>
            <button type="button" className={styles.miniBtn} aria-pressed={view === "lab"} onClick={() => setMode("lab")}>
              Lab Data
            </button>
          </div>
          <button type="button" className={styles.siteAuditIconButton} onClick={onExplain} aria-haspopup="dialog" aria-label="What is the difference between field and lab data?">
            <span aria-hidden="true">i</span>
          </button>
        </div>
      </div>

      {view === "field" && field ? (
        <p className={styles.siteAuditAssessment} data-result={assessment}>
          Core Web Vitals assessment:{" "}
          <strong>{assessment === "passed" ? "Passed" : assessment === "failed" ? "Failed" : "No data"}</strong>
          <span className={styles.muted}>
            {" "}
            · {field.scope === "origin" ? "Origin" : "URL"} · Chrome real-user data (CrUX), 75th percentile
          </span>
        </p>
      ) : !hasField ? (
        <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
          No real-user data available for this URL or origin. Showing the lab test.
        </p>
      ) : null}

      <div className={styles.siteAuditCwvRow}>
        {CORE_WEB_VITALS.map((key) => {
          if (view === "field" && field) {
            const m = field.metrics[key as keyof typeof field.metrics];
            return (
              <div key={key} className={styles.siteAuditCwvCard}>
                <span className={styles.siteAuditScoreCardLabel}>
                  {METRIC_SHORT[key]} <span className={styles.muted}>· {METRIC_LABELS[key]}</span>
                </span>
                {m ? (
                  <>
                    <span className={styles.siteAuditCwvValue}>{formatFieldValue(key, m.percentile)}</span>
                    <span className={styles.siteAuditCwvMeta}>
                      {m.status ? <span className={statusPillClass(styles, m.status)}>{statusLabel(m.status)}</span> : null}
                      {goodTarget(key) ? <span className={styles.muted}>{goodTarget(key)}</span> : null}
                    </span>
                    <MetricThresholdBar metric={key} numericValue={m.percentile} styles={styles} />
                    <OffScale metric={key} value={m.percentile} styles={styles} />
                    <DistributionBar metric={m} styles={styles} />
                  </>
                ) : (
                  <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
                    Not enough real-user data for this metric.
                  </p>
                )}
              </div>
            );
          }
          const entry = result.core_web_vitals[key];
          const status = labStatus(entry);
          return (
            <div key={key} className={styles.siteAuditCwvCard}>
              <span className={styles.siteAuditScoreCardLabel}>
                {METRIC_SHORT[key]} <span className={styles.muted}>· {METRIC_LABELS[key]}</span>
              </span>
              {key === "inp" ? (
                <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
                  Not measurable in a lab test. Total Blocking Time is the lab proxy; see Field Data for real INP.
                </p>
              ) : entry ? (
                <>
                  <span className={styles.siteAuditCwvValue}>{entry.display_value || "—"}</span>
                  <span className={styles.siteAuditCwvMeta}>
                    {status ? <span className={statusPillClass(styles, status)}>{statusLabel(status)}</span> : <span className={styles.muted}>Status not stored for this older run</span>}
                  </span>
                  <span className={styles.siteAuditSourceTag}>Status from Lighthouse&rsquo;s score for this device</span>
                </>
              ) : (
                <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
                  Lighthouse did not report this metric for this run.
                </p>
              )}
            </div>
          );
        })}
      </div>
      <span className={styles.siteAuditSourceTag}>{view === "field" ? "Source: Chrome UX Report via PageSpeed Insights" : labTag(result, strategy)}</span>
    </section>
  );
}
