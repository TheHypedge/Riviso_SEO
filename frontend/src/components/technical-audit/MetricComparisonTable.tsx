"use client";

import { useState } from "react";
import type { TechnicalAuditStrategyResult } from "@/lib/api";
import {
  type Difference,
  METRIC_LABELS,
  type MetricKey,
  type ScoreKey,
  SCORE_LABELS,
  type Strategy,
  goodTarget,
  metricDifference,
  scoreDifference,
  scoreStatus,
  statusLabel,
} from "@/lib/technicalAuditView";
import { type CssModule, StatusText } from "./parts";

type View = Strategy | "both";

type Row = {
  id: string;
  label: string;
  values: Record<Strategy, { text: string; status: string | null }>;
  diff: Difference;
  target: string | null;
};

const METRIC_ROWS: MetricKey[] = ["lcp", "fcp", "speed_index", "tbt", "ttfb", "cls"];
const SCORE_ROWS: ScoreKey[] = ["accessibility", "best_practices", "pagespeed_seo"];

function scoreRow(key: ScoreKey, label: string, mobile: TechnicalAuditStrategyResult, desktop: TechnicalAuditStrategyResult): Row {
  const m = mobile.scores[key];
  const d = desktop.scores[key];
  return {
    id: `score:${key}`,
    label,
    values: {
      mobile: { text: m === null ? "—" : String(m), status: scoreStatus(m) },
      desktop: { text: d === null ? "—" : String(d), status: scoreStatus(d) },
    },
    diff: scoreDifference(m, d),
    target: "Good ≥ 90",
  };
}

function metricRow(key: MetricKey, mobile: TechnicalAuditStrategyResult, desktop: TechnicalAuditStrategyResult): Row {
  const m = mobile.core_web_vitals[key];
  const d = desktop.core_web_vitals[key];
  return {
    id: `metric:${key}`,
    label: METRIC_LABELS[key],
    values: {
      mobile: { text: m?.display_value || "—", status: m?.status ?? null },
      desktop: { text: d?.display_value || "—", status: d?.status ?? null },
    },
    diff: metricDifference(key, m, d),
    target: goodTarget(key),
  };
}

export function buildRows(mobile: TechnicalAuditStrategyResult, desktop: TechnicalAuditStrategyResult): Row[] {
  const metrics: MetricKey[] = [...METRIC_ROWS];
  if (mobile.core_web_vitals.inp || desktop.core_web_vitals.inp) metrics.push("inp");
  return [
    scoreRow("performance", "Performance Score", mobile, desktop),
    ...metrics.map((k) => metricRow(k, mobile, desktop)),
    ...SCORE_ROWS.map((k) => scoreRow(k, k === "pagespeed_seo" ? "SEO" : SCORE_LABELS[k], mobile, desktop)),
  ];
}

function ValueCell({ v, styles }: { v: { text: string; status: string | null }; styles: CssModule }) {
  if (v.text === "—") {
    return (
      <span className={styles.muted}>
        —<span className={styles.srOnly}> Not reported</span>
      </span>
    );
  }
  return (
    <span className={styles.siteAuditMetricValue}>
      <span className={styles.siteAuditBreakdownDot} data-status={v.status || "unknown"} aria-hidden="true" />
      <span className="tabular-nums">{v.text}</span>
      {v.status ? <span className={styles.srOnly}> ({statusLabel(v.status)})</span> : null}
    </span>
  );
}

function DiffText({ diff, styles }: { diff: Difference; styles: CssModule }) {
  if (!diff) return <span className={styles.muted}>—</span>;
  return (
    <span>
      <span aria-hidden="true">{diff.text}</span>
      <span className={styles.srOnly}>{diff.words}</span>
    </span>
  );
}

/** Block D: every metric and score for mobile and desktop, side by side. */
export function MetricComparisonTable({
  mobile,
  desktop,
  strategy,
  onStrategyChange,
  styles,
}: {
  mobile: TechnicalAuditStrategyResult;
  desktop: TechnicalAuditStrategyResult;
  strategy: Strategy;
  onStrategyChange: (s: Strategy) => void;
  styles: CssModule;
}) {
  // "Both" is local view state; the page's strategy stays mobile | desktop.
  const [both, setBoth] = useState(false);
  const view: View = both ? "both" : strategy;
  const columns: Strategy[] = view === "desktop" ? ["desktop", "mobile"] : ["mobile", "desktop"];
  const rows = buildRows(mobile, desktop);
  const select = (v: View) => {
    setBoth(v === "both");
    if (v !== "both") onStrategyChange(v);
  };
  const dim = (s: Strategy) => view !== "both" && s !== view;
  const statusFor = (row: Row) =>
    view === "both" ? null : row.values[view].status;

  return (
    <section id="ta-metrics" aria-labelledby="ta-metrics-title" className={`${styles.card} ${styles.siteAuditPanel}`}>
      <div className={styles.siteAuditPanelHead}>
        <h3 id="ta-metrics-title" className={styles.siteAuditPanelTitle}>
          Mobile vs Desktop Performance
        </h3>
        <div className={styles.segmentGroup} role="group" aria-label="Device view">
          {(["mobile", "desktop", "both"] as const).map((v) => (
            <button key={v} type="button" className={styles.miniBtn} onClick={() => select(v)} aria-pressed={view === v}>
              {v === "mobile" ? "Mobile" : v === "desktop" ? "Desktop" : "Both"}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.siteAuditTableWrap}>
        <table className={styles.siteAuditTable}>
          <caption className={styles.srOnly}>Mobile and desktop values for each Lighthouse metric and score</caption>
          <thead>
            <tr>
              <th scope="col">Metric</th>
              {columns.map((s) => (
                <th key={s} scope="col" data-dim={dim(s) || undefined}>
                  {s === "mobile" ? "Mobile" : "Desktop"}
                </th>
              ))}
              <th scope="col">Difference</th>
              <th scope="col">Status / Interpretation</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const st = statusFor(row);
              return (
                <tr key={row.id}>
                  <th scope="row">{row.label}</th>
                  {columns.map((s) => (
                    <td key={s} data-dim={dim(s) || undefined}>
                      <ValueCell v={row.values[s]} styles={styles} />
                    </td>
                  ))}
                  <td>
                    <DiffText diff={row.diff} styles={styles} />
                  </td>
                  <td>
                    {view === "both" ? (
                      <span className={styles.siteAuditInterpretation}>
                        <StatusText status={row.values.mobile.status} styles={styles} />
                        <span className={styles.muted}>/</span>
                        <StatusText status={row.values.desktop.status} styles={styles} />
                      </span>
                    ) : (
                      <span className={styles.siteAuditInterpretation}>
                        <StatusText status={st} styles={styles} />
                      </span>
                    )}
                    {row.target ? <span className={styles.siteAuditTarget}>{row.target}</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* <640px: one card per row instead of a horizontally scrolling table. */}
      <ul className={styles.siteAuditMetricCards}>
        {rows.map((row) => (
          <li key={row.id} className={styles.siteAuditMetricCard}>
            <span className={styles.siteAuditMetricCardTitle}>{row.label}</span>
            <dl>
              {columns.map((s) => (
                <div key={s} data-dim={dim(s) || undefined}>
                  <dt>{s === "mobile" ? "Mobile" : "Desktop"}</dt>
                  <dd>
                    <ValueCell v={row.values[s]} styles={styles} />
                  </dd>
                </div>
              ))}
              <div>
                <dt>Difference</dt>
                <dd>
                  <DiffText diff={row.diff} styles={styles} />
                </dd>
              </div>
              {row.target ? (
                <div>
                  <dt>Target</dt>
                  <dd>{row.target}</dd>
                </div>
              ) : null}
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
