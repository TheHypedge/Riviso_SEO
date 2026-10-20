"use client";

import { Fragment, useMemo, useState } from "react";
import type { TechnicalAuditOpportunity } from "@/lib/api";
import { describeSample, formatSavings } from "@/lib/technicalAudit";
import {
  IMPACT_LABELS,
  type OpportunitySort,
  bestSavingsMs,
  impactTier,
  kindFromScore,
  metricFilterChips,
  savingsMetrics,
  sortOpportunities,
} from "@/lib/technicalAuditView";
import { type CssModule, LighthouseText, ShapeIcon, resourceCount } from "./parts";

const SORT_LABELS: Record<OpportunitySort, string> = { savings: "Estimated savings", impact: "Impact", metric: "Metric", name: "Name" };

/** Block G: Lighthouse opportunities with metric filters, sorting and inline "Show how". */
export function OpportunitiesPanel({
  opportunities,
  stored,
  psiUrl,
  styles,
}: {
  opportunities: TechnicalAuditOpportunity[];
  /** False for runs stored before the full audit index existed. */
  stored: boolean;
  psiUrl: string | null;
  styles: CssModule;
}) {
  const [metric, setMetric] = useState("all");
  const [sort, setSort] = useState<OpportunitySort>("savings");
  const [open, setOpen] = useState<string | null>(null);
  const chips = useMemo(() => metricFilterChips(opportunities), [opportunities]);
  const activeMetric = chips.some((c) => c.key === metric) ? metric : "all";
  const rows = useMemo(() => {
    const filtered = activeMetric === "all" ? opportunities : opportunities.filter((o) => savingsMetrics(o).includes(activeMetric));
    return sortOpportunities(filtered, sort);
  }, [opportunities, activeMetric, sort]);

  return (
    <section id="ta-opportunities" aria-labelledby="ta-opportunities-title" className={`${styles.card} ${styles.siteAuditPanel}`}>
      <div className={styles.siteAuditPanelHead}>
        <div>
          <h3 id="ta-opportunities-title" className={styles.siteAuditPanelTitle}>
            Performance Opportunities
          </h3>
          <p className={styles.muted} style={{ margin: "2px 0 0", fontSize: 13 }}>
            These suggestions can help your page load faster. They are ordered by the potential savings.
          </p>
        </div>
        {opportunities.length > 1 ? (
          <label className={styles.siteAuditSortLabel}>
            Sort by
            <select className={styles.siteAuditSelect} value={sort} onChange={(e) => setSort(e.target.value as OpportunitySort)}>
              {(Object.keys(SORT_LABELS) as OpportunitySort[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {opportunities.length === 0 ? (
        <p className={styles.muted} style={{ margin: 0, fontSize: 14 }}>
          {stored ? "No opportunities found — Lighthouse found nothing to improve here." : "Opportunities were not stored for this run. Re-run the audit."}
        </p>
      ) : (
        <>
          {chips.length > 1 ? (
            <div className={styles.siteAuditChips} role="group" aria-label="Filter by metric">
              {chips.map((c) => (
                <button key={c.key} type="button" className={styles.siteAuditChip} aria-pressed={activeMetric === c.key} onClick={() => setMetric(c.key)}>
                  {c.label} ({c.count})
                </button>
              ))}
            </div>
          ) : null}
          <div className={styles.siteAuditTableWrap} role="region" aria-label="Performance opportunities" tabIndex={0}>
            <table className={`${styles.siteAuditTable} ${styles.siteAuditTableStack}`}>
              <caption className={styles.srOnly}>Opportunities sorted by {SORT_LABELS[sort].toLowerCase()}</caption>
              <thead>
                <tr>
                  <th scope="col">Opportunity</th>
                  <th scope="col">Estimated savings</th>
                  <th scope="col">Metric</th>
                  <th scope="col">
                    <span title="Based on Google's estimated savings">Impact</span>
                  </th>
                  <th scope="col">
                    <span className={styles.srOnly}>Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const isOpen = open === o.id;
                  const metrics = savingsMetrics(o);
                  const tier = impactTier(bestSavingsMs(o), o.overall_savings_bytes);
                  const savings = formatSavings(o.overall_savings_ms, o.overall_savings_bytes, o.metric_savings)?.replace("Est. savings ", "");
                  const files = resourceCount(o);
                  const samples = o.samples || [];
                  return (
                    <Fragment key={o.id}>
                      <tr>
                        <th scope="row" data-label="Opportunity">
                          <button type="button" className={styles.siteAuditRowTitle} onClick={() => setOpen(isOpen ? null : o.id)} aria-expanded={isOpen} aria-controls={`ta-opp-${o.id}`}>
                            <ShapeIcon kind={kindFromScore(o.score)} styles={styles} />
                            {o.title || o.id}
                          </button>
                        </th>
                        <td data-label="Estimated savings" className="tabular-nums">
                          {savings || <span className={styles.muted}>—</span>}
                        </td>
                        <td data-label="Metric">
                          {metrics.length ? (
                            <span className={styles.siteAuditChips}>
                              {metrics.slice(0, 2).map((m) => (
                                <button key={m} type="button" className={styles.siteAuditMetricChip} onClick={() => setMetric(m)} aria-label={`Show only ${m} opportunities`}>
                                  {m}
                                </button>
                              ))}
                              {metrics.length > 2 ? <span className={styles.muted}>+{metrics.length - 2}</span> : null}
                            </span>
                          ) : (
                            <span className={styles.muted}>—</span>
                          )}
                        </td>
                        <td data-label="Impact">
                          {tier ? (
                            <span className={styles.siteAuditNeutralPill} title="Based on Google's estimated savings">
                              {IMPACT_LABELS[tier]}
                            </span>
                          ) : (
                            <span className={styles.muted}>—</span>
                          )}
                        </td>
                        <td>
                          <button type="button" className={styles.siteAuditTextButton} onClick={() => setOpen(isOpen ? null : o.id)} aria-expanded={isOpen} aria-controls={`ta-opp-${o.id}`}>
                            Show how <span aria-hidden="true">{isOpen ? "⌃" : "⌄"}</span>
                            <span className={styles.srOnly}> for {o.title || o.id}</span>
                          </button>
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr id={`ta-opp-${o.id}`} className={styles.siteAuditDetailRow}>
                          <td colSpan={5}>
                            {o.description ? (
                              <p style={{ margin: 0, fontSize: 14 }}>
                                <LighthouseText text={o.description} styles={styles} />
                              </p>
                            ) : null}
                            {samples.length ? (
                              <>
                                <p className={styles.siteAuditMiniHeading}>Top {Math.min(5, samples.length)} affected files</p>
                                <ul className={styles.siteAuditSampleList}>
                                  {samples.slice(0, 5).map((s, i) => (
                                    <li key={i}>
                                      <code title={s.url || undefined}>{describeSample(s)}</code>
                                    </li>
                                  ))}
                                </ul>
                              </>
                            ) : files > 0 ? (
                              <p className={styles.muted} style={{ margin: "6px 0 0", fontSize: 13 }}>
                                Detailed resource list is not stored for this run. Re-run the audit to capture it.
                              </p>
                            ) : null}
                            {files > samples.length && psiUrl ? (
                              <a href={psiUrl} target="_blank" rel="noopener noreferrer" className={styles.siteAuditTextLink}>
                                View all {files} files in PageSpeed Insights →<span className={styles.srOnly}> (opens in a new tab)</span>
                              </a>
                            ) : null}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
