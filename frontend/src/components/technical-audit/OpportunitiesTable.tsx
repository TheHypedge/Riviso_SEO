"use client";

import { Fragment, useMemo, useState } from "react";
import type { TechnicalAuditOpportunity } from "@/lib/api";
import { formatSavings } from "@/lib/technicalAudit";
import { bestSavingsMs, improvesText } from "@/lib/technicalAuditView";
import { type CssModule, FindingDetails, resourceCount } from "./parts";

const CAP = 5;

/** Block F1: Lighthouse opportunities, largest estimated saving first. */
export function OpportunitiesTable({ opportunities, styles }: { opportunities: TechnicalAuditOpportunity[]; styles: CssModule }) {
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const sorted = useMemo(
    () => [...opportunities].sort((a, b) => bestSavingsMs(b) - bestSavingsMs(a) || (b.overall_savings_bytes ?? 0) - (a.overall_savings_bytes ?? 0)),
    [opportunities],
  );
  const visible = showAll ? sorted : sorted.slice(0, CAP);

  return (
    <section id="ta-opportunities" aria-labelledby="ta-opportunities-title" className={`${styles.card} ${styles.siteAuditPanel}`}>
      <div className={styles.siteAuditPanelHead}>
        <h3 id="ta-opportunities-title" className={styles.siteAuditPanelTitle}>
          Audit Opportunities
        </h3>
        <span className={styles.siteAuditCount}>{opportunities.length}</span>
      </div>
      {sorted.length === 0 ? (
        <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
          Lighthouse reported no opportunities for this device.
        </p>
      ) : (
        <div className={styles.siteAuditTableWrap}>
          <table className={`${styles.siteAuditTable} ${styles.siteAuditTableStack}`}>
            <caption className={styles.srOnly}>Opportunities sorted by Google&rsquo;s estimated savings, largest first</caption>
            <thead>
              <tr>
                <th scope="col">Issue</th>
                <th scope="col">Impact</th>
                <th scope="col">Est. Savings</th>
                <th scope="col">Affected Resources</th>
                <th scope="col">
                  <span className={styles.srOnly}>Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((o) => {
                const n = resourceCount(o);
                const isOpen = open === o.id;
                return (
                  <Fragment key={o.id}>
                    <tr>
                      <th scope="row" data-label="Issue">
                        {o.title || o.id}
                      </th>
                      <td data-label="Impact">{improvesText(o.metric_savings) || <span className={styles.muted}>—</span>}</td>
                      <td data-label="Est. Savings" className="tabular-nums">
                        {formatSavings(o.overall_savings_ms, o.overall_savings_bytes, o.metric_savings)?.replace("Est. savings ", "") || <span className={styles.muted}>—</span>}
                      </td>
                      <td data-label="Affected Resources">{n > 0 ? `${n} resource${n === 1 ? "" : "s"}` : <span className={styles.muted}>—</span>}</td>
                      <td>
                        <button
                          type="button"
                          className={styles.siteAuditTextButton}
                          aria-expanded={isOpen}
                          aria-controls={`ta-opp-${o.id}`}
                          onClick={() => setOpen(isOpen ? null : o.id)}
                        >
                          {isOpen ? "Hide details" : "View details →"}
                          <span className={styles.srOnly}> for {o.title || o.id}</span>
                        </button>
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr id={`ta-opp-${o.id}`} className={styles.siteAuditDetailRow}>
                        <td colSpan={5}>
                          <FindingDetails finding={o} styles={styles} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {sorted.length > CAP ? (
        <button type="button" className={styles.siteAuditViewAllBtn} onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
          {showAll ? "Show fewer opportunities" : `View all ${sorted.length} opportunities`}
        </button>
      ) : null}
    </section>
  );
}
