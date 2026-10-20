"use client";

import { useMemo, useState } from "react";
import type { TechnicalAuditIndexEntry } from "@/lib/api";
import { type CssModule, AuditRow, KIND_LABELS } from "./parts";

type Section = { key: string; title: string; rows: TechnicalAuditIndexEntry[]; collapsed: boolean };

/** Lighthouse's own group titles; audits without a group are the manual checks or misc. */
function groupAudits(rows: TechnicalAuditIndexEntry[]) {
  const failing = rows.filter((a) => a.kind === "failed" || a.kind === "warning" || a.kind === "error");
  const byGroup = new Map<string, TechnicalAuditIndexEntry[]>();
  for (const a of failing) {
    const g = a.group_title || "Other";
    byGroup.set(g, [...(byGroup.get(g) || []), a]);
  }
  const sections: Section[] = [...byGroup.entries()].map(([title, rs]) => ({ key: `f-${title}`, title, rows: rs, collapsed: false }));
  const add = (key: string, title: string, kinds: string[]) => {
    const rs = rows.filter((a) => kinds.includes(a.kind));
    if (rs.length) sections.push({ key, title: `${title} (${rs.length})`, rows: rs, collapsed: true });
  };
  add("informational", "Informational", ["informational"]);
  add("manual", "Additional items to manually check", ["manual"]);
  add("passed", "Passed audits", ["passed"]);
  add("na", "Not applicable", ["not_applicable"]);
  return { failingCount: failing.length, sections };
}

/** Block L: one Lighthouse category's audits, grouped like PageSpeed Insights. */
export function CategoryAuditsTab({ rows, stored, note, styles }: { rows: TechnicalAuditIndexEntry[]; stored: boolean; note?: React.ReactNode; styles: CssModule }) {
  const { failingCount, sections } = useMemo(() => groupAudits(rows), [rows]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<string | null>(null);

  if (!stored) {
    return (
      <section className={`${styles.card} ${styles.siteAuditPanel}`}>
        <p className={styles.muted} style={{ margin: 0, fontSize: 14 }}>
          The full audit list was not stored for this run. Re-run the audit to see every passed, failed and not-applicable check.
        </p>
      </section>
    );
  }

  return (
    <section className={`${styles.card} ${styles.siteAuditPanel}`} aria-label="Audits">
      {note}
      {failingCount === 0 ? (
        <p className={styles.muted} style={{ margin: 0, fontSize: 14 }}>
          No failing audits in this category for this device.
        </p>
      ) : null}
      {sections.map((s) => {
        const isOpen = s.collapsed ? Boolean(expanded[s.key]) : expanded[s.key] !== false;
        return (
          <div key={s.key} className={styles.siteAuditGroup}>
            <button
              type="button"
              className={styles.siteAuditGroupToggle}
              aria-expanded={isOpen}
              aria-controls={`ta-group-${s.key}`}
              onClick={() => setExpanded((e) => ({ ...e, [s.key]: !isOpen }))}
            >
              <span>{s.title}</span>
              <span className={styles.siteAuditChevron} data-open={isOpen || undefined} aria-hidden="true">
                ›
              </span>
            </button>
            {isOpen ? (
              <ul id={`ta-group-${s.key}`} className={styles.siteAuditAuditList}>
                {s.rows.map((a) => (
                  <AuditRow key={a.id} audit={a} open={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} styles={styles} />
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
      <p className={styles.srOnly}>Result labels: {Object.values(KIND_LABELS).join(", ")}.</p>
    </section>
  );
}
