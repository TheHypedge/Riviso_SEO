"use client";

import { useMemo } from "react";
import type { TechnicalAuditStrategyResult } from "@/lib/api";
import { formatSavings } from "@/lib/technicalAudit";
import { METRIC_LABELS, type TopInsight, plainLighthouseText, rankTopInsights, scoreStatus, statusLabel } from "@/lib/technicalAuditView";
import { CategoryIcon, type CssModule, statusPillClass } from "./parts";

function row(item: TopInsight): { title: string; text: string; status: string | null; pill: string | null; icon: string } {
  if (item.kind === "metric") {
    return {
      title: `${METRIC_LABELS[item.metric]}: ${item.entry.display_value || "—"}`,
      text: "A Core Web Vital outside Google's \"good\" range for this device.",
      status: item.status,
      pill: statusLabel(item.status),
      icon: "metric",
    };
  }
  const f = item.finding;
  const savings = item.kind === "opportunity" ? formatSavings(item.finding.overall_savings_ms, item.finding.overall_savings_bytes, item.finding.metric_savings) : formatSavings(null, null, f.metric_savings);
  const st = item.kind === "opportunity" ? null : scoreStatus(f.score);
  return {
    title: f.title || f.id,
    text: plainLighthouseText(f.description),
    status: st,
    pill: savings ? savings.replace("Est. savings ", "") : st ? statusLabel(st) : null,
    icon: item.kind === "accessibility" ? "accessibility" : "performance",
  };
}

/** Block E2: up to 6 real findings, ranked deterministically (see rankTopInsights). */
export function TopInsightsList({ result, onSeeAllDiagnostics, styles }: { result: TechnicalAuditStrategyResult; onSeeAllDiagnostics: () => void; styles: CssModule }) {
  const items = useMemo(() => rankTopInsights(result), [result]);
  return (
    <section id="ta-insights" aria-labelledby="ta-insights-title" className={`${styles.card} ${styles.siteAuditPanel}`}>
      <div className={styles.siteAuditPanelHead}>
        <h3 id="ta-insights-title" className={styles.siteAuditPanelTitle}>
          Top Issues &amp; Insights
        </h3>
      </div>
      {items.length === 0 ? (
        <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
          Lighthouse found no failing audits or Core Web Vitals outside the good range for this device.
        </p>
      ) : (
        <ul className={styles.siteAuditInsightList}>
          {items.map((item) => {
            const r = row(item);
            return (
              <li key={item.key} className={styles.siteAuditInsightRow}>
                <span className={styles.siteAuditCategoryIcon} data-status={r.status || "unknown"} aria-hidden="true">
                  <CategoryIcon category={r.icon} />
                </span>
                <span className={styles.siteAuditInsightText}>
                  <span className={styles.siteAuditInsightTitle}>{r.title}</span>
                  {r.text ? <span className={styles.siteAuditInsightDesc}>{r.text}</span> : null}
                </span>
                {r.pill ? <span className={statusPillClass(styles, r.status)}>{r.pill}</span> : null}
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" className={styles.siteAuditViewAllBtn} onClick={onSeeAllDiagnostics}>
        See all diagnostics →
      </button>
    </section>
  );
}
