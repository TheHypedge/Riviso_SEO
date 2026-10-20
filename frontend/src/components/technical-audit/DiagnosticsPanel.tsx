"use client";

import { useMemo, useState } from "react";
import type { TechnicalAuditIndexEntry } from "@/lib/api";
import { type DiagnosticsFilter, diagnosticsBuckets, filterDiagnostics } from "@/lib/technicalAuditView";
import { AuditRow, type CssModule } from "./parts";

const CAP = 10;

/** Block K: performance audits other than the opportunities, filterable by result. */
export function DiagnosticsPanel({ rows, stored, styles }: { rows: TechnicalAuditIndexEntry[]; stored: boolean; styles: CssModule }) {
  const [filter, setFilter] = useState<DiagnosticsFilter>("all");
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const counts = useMemo(() => diagnosticsBuckets(rows), [rows]);
  const visibleRows = useMemo(() => filterDiagnostics(rows, filter), [rows, filter]);
  const shown = showAll ? visibleRows : visibleRows.slice(0, CAP);
  const chips: { key: DiagnosticsFilter; label: string; n: number; title?: string }[] = [
    { key: "all", label: "All", n: counts.all, title: "Passed, warnings and failed audits (informational audits are listed separately)" },
    { key: "passed", label: "Passed", n: counts.passed },
    { key: "warning", label: "Warnings", n: counts.warning },
    { key: "failed", label: "Failed", n: counts.failed },
  ];
  if (counts.informational > 0) chips.push({ key: "informational", label: "Informational", n: counts.informational });

  return (
    <section id="ta-diagnostics" tabIndex={-1} aria-labelledby="ta-diagnostics-title" className={`${styles.card} ${styles.siteAuditPanel}`}>
      <h3 id="ta-diagnostics-title" className={styles.siteAuditPanelTitle}>
        Diagnostics
      </h3>
      {!stored ? (
        <p className={styles.muted} style={{ margin: 0, fontSize: 14 }}>
          Only failing diagnostics were stored for this older run. Re-run the audit to see passed and informational audits too.
        </p>
      ) : null}
      <div className={styles.siteAuditChips} role="group" aria-label="Filter diagnostics">
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            className={styles.siteAuditChip}
            aria-pressed={filter === c.key}
            title={c.title}
            onClick={() => {
              setFilter(c.key);
              setShowAll(false);
            }}
          >
            {c.label} ({c.n})
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className={styles.muted} style={{ margin: 0, fontSize: 14 }}>
          No audits in this group.
        </p>
      ) : (
        <ul className={styles.siteAuditAuditList}>
          {shown.map((a) => (
            <AuditRow key={a.id} audit={a} open={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} styles={styles} />
          ))}
        </ul>
      )}
      {visibleRows.length > CAP ? (
        <button type="button" className={styles.siteAuditViewAllBtn} onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
          {showAll ? "Show fewer diagnostics" : `View all diagnostics (${visibleRows.length})`}
        </button>
      ) : null}
    </section>
  );
}
