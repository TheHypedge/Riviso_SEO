"use client";

import type { TechnicalAuditCwvEntry, TechnicalAuditStrategyResult } from "@/lib/api";
import { CORE_WEB_VITALS, METRIC_LABELS, METRIC_SHORT, type Strategy, goodTarget, statusLabel } from "@/lib/technicalAuditView";
import { type CssModule, MetricThresholdBar, statusPillClass } from "./parts";

/** Where the status came from. The displayed value is always Lighthouse's lab number. */
function sourceTag(entry: TechnicalAuditCwvEntry): string | null {
  if (entry.source === "field") return "Status from real-user data (this page)";
  if (entry.source === "field_origin") return "Status from origin-level real-user data";
  if (entry.source === "lab") return "Lab data";
  return null;
}

export function pageSpeedInsightsUrl(url: string | null | undefined, strategy: Strategy): string | null {
  if (!url) return null;
  return `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(url)}&form_factor=${strategy}`;
}

/** Block E1: Google's Core Web Vitals (LCP, INP, CLS) for the active strategy. */
export function CoreWebVitalsCards({
  result,
  strategy,
  auditedUrl,
  styles,
}: {
  result: TechnicalAuditStrategyResult;
  strategy: Strategy;
  auditedUrl: string | null;
  styles: CssModule;
}) {
  const psi = pageSpeedInsightsUrl(result.final_url || auditedUrl, strategy);
  const device = strategy === "mobile" ? "Mobile" : "Desktop";
  return (
    <section id="ta-cwv" aria-labelledby="ta-cwv-title" className={`${styles.card} ${styles.siteAuditPanel}`}>
      <div className={styles.siteAuditPanelHead}>
        <h3 id="ta-cwv-title" className={styles.siteAuditPanelTitle}>
          Core Web Vitals ({device})
        </h3>
        {psi ? (
          <a className={styles.siteAuditTextLink} href={psi} target="_blank" rel="noreferrer">
            View in PageSpeed Insights ↗<span className={styles.srOnly}> (opens in a new tab)</span>
          </a>
        ) : null}
      </div>
      <div className={styles.siteAuditCwvCards}>
        {CORE_WEB_VITALS.map((key) => {
          const entry = result.core_web_vitals[key];
          const target = goodTarget(key);
          return (
            <div key={key} className={styles.siteAuditCwvCard}>
              <span className={styles.siteAuditScoreCardLabel}>
                {METRIC_SHORT[key]} <span className={styles.muted}>· {METRIC_LABELS[key]}</span>
              </span>
              {entry ? (
                <>
                  <span className={styles.siteAuditCwvValue}>{entry.display_value || "—"}</span>
                  <span className={styles.siteAuditCwvMeta}>
                    {entry.status ? <span className={statusPillClass(styles, entry.status)}>{statusLabel(entry.status)}</span> : null}
                    {target ? <span className={styles.muted}>{target}</span> : null}
                  </span>
                  <MetricThresholdBar metric={key} numericValue={entry.numeric_value} styles={styles} />
                  {sourceTag(entry) ? <span className={styles.siteAuditSourceTag}>{sourceTag(entry)}</span> : null}
                </>
              ) : (
                <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
                  {key === "inp"
                    ? "No real-user data available for this site. INP needs real visits; a lab test cannot measure it."
                    : "Lighthouse did not report this metric for this run."}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
