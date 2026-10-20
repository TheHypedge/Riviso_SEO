"use client";

import type { TechnicalAuditStrategyResult } from "@/lib/api";
import { METRIC_LABELS, METRIC_SHORT, type MetricKey, formatFieldValue, statusLabel } from "@/lib/technicalAuditView";
import { DistributionBar, labStatus } from "./CoreWebVitalsPanel";
import { type CssModule, statusPillClass } from "./parts";

const OTHER: MetricKey[] = ["fcp", "speed_index", "tbt", "ttfb"];

/** Block F: FCP, Speed Index, TBT, TTFB from the Lighthouse run (TTFB also real-user p75). */
export function OtherMetricsPanel({ result, styles }: { result: TechnicalAuditStrategyResult; styles: CssModule }) {
  return (
    <section id="ta-metrics" aria-labelledby="ta-metrics-title" className={`${styles.card} ${styles.siteAuditPanel}`}>
      <h3 id="ta-metrics-title" className={styles.siteAuditPanelTitle}>
        Other Key Metrics
      </h3>
      <div className={styles.siteAuditMetricGrid}>
        {OTHER.map((key) => {
          const entry = result.core_web_vitals[key];
          const status = labStatus(entry);
          const field = key === "ttfb" ? result.field?.metrics?.ttfb : undefined;
          return (
            <div key={key} className={styles.siteAuditCwvCard}>
              <span className={styles.siteAuditScoreCardLabel}>
                {key === "ttfb" ? "TTFB" : METRIC_SHORT[key]} <span className={styles.muted}>· {METRIC_LABELS[key]}</span>
              </span>
              {entry ? (
                <>
                  <span className={styles.siteAuditCwvValue}>{entry.display_value || "—"}</span>
                  {status ? <span className={statusPillClass(styles, status)}>{statusLabel(status)}</span> : null}
                  <span className={styles.siteAuditSourceTag}>{key === "ttfb" ? "Lab · server response time of the main document" : "Lab"}</span>
                </>
              ) : (
                <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
                  Lighthouse did not report this metric for this run.
                </p>
              )}
              {field ? (
                <div className={styles.siteAuditFieldExtra}>
                  <span style={{ fontSize: 13 }}>
                    Real users (p75): <strong>{formatFieldValue("ttfb", field.percentile)}</strong>
                    {field.status ? ` · ${statusLabel(field.status)}` : ""}
                  </span>
                  <DistributionBar metric={field} styles={styles} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
