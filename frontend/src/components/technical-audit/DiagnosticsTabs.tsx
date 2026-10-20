"use client";

import { type KeyboardEvent, useRef, useState } from "react";
import type { TechnicalAuditCategorySummary, TechnicalAuditFinding } from "@/lib/api";
import { scoreStatus } from "@/lib/technicalAuditView";
import { type CssModule, FindingDetails, StatusText, resourceCount } from "./parts";

export type DiagnosticsTabKey = "performance" | "accessibility" | "best_practices" | "seo";

export type DiagnosticsTab = {
  key: DiagnosticsTabKey;
  label: string;
  findings: TechnicalAuditFinding[];
  summary?: TechnicalAuditCategorySummary | null;
  /** False for runs stored before this category was captured (old history rows). */
  available: boolean;
};

const CAP = 5;

/** Block F2: failing audits per Lighthouse category, as an accessible tablist. */
export function DiagnosticsTabs({ tabs, onRerun, canRerun, styles }: { tabs: DiagnosticsTab[]; onRerun: () => void; canRerun: boolean; styles: CssModule }) {
  const [active, setActive] = useState<DiagnosticsTabKey>(tabs[0]?.key ?? "performance");
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const current = tabs.find((t) => t.key === active) ?? tabs[0];

  const select = (key: DiagnosticsTabKey, focus = false) => {
    setActive(key);
    setShowAll(false);
    setOpen(null);
    if (focus) tabRefs.current[key]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = tabs.findIndex((t) => t.key === active);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    select(tabs[(next + tabs.length) % tabs.length].key, true);
  };

  if (!current) return null;
  const visible = showAll ? current.findings : current.findings.slice(0, CAP);

  return (
    <section id="ta-diagnostics" tabIndex={-1} aria-labelledby="ta-diagnostics-title" className={`${styles.card} ${styles.siteAuditPanel}`}>
      <div className={styles.siteAuditPanelHead}>
        <h3 id="ta-diagnostics-title" className={styles.siteAuditPanelTitle}>
          Diagnostics
        </h3>
      </div>
      <div role="tablist" aria-label="Diagnostics category" className={styles.siteAuditTabs}>
        {tabs.map((t) => (
          <button
            key={t.key}
            ref={(el) => {
              tabRefs.current[t.key] = el;
            }}
            type="button"
            role="tab"
            id={`ta-diag-tab-${t.key}`}
            aria-selected={t.key === active}
            aria-controls="ta-diag-panel"
            tabIndex={t.key === active ? 0 : -1}
            className={styles.siteAuditTab}
            onClick={() => select(t.key)}
            onKeyDown={onKeyDown}
          >
            {t.label}
            <span className={styles.siteAuditCount}>{t.available ? t.findings.length : "—"}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" id="ta-diag-panel" aria-labelledby={`ta-diag-tab-${current.key}`} className={styles.siteAuditTabPanel}>
        {current.summary ? (
          <p className={styles.muted} style={{ margin: 0, fontSize: 12 }}>
            {current.summary.passed} passed · {current.summary.warnings} warnings · {current.summary.failed} failed
          </p>
        ) : null}
        {!current.available ? (
          <div className={styles.siteAuditEmptyInline}>
            <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
              {current.label} audit details appear after you re-run the audit.
            </p>
            {canRerun ? (
              <button type="button" className={styles.btnSecondary} onClick={onRerun}>
                Re-run audit
              </button>
            ) : null}
          </div>
        ) : current.findings.length === 0 ? (
          <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
            No failing {current.label.toLowerCase()} audits for this device.
          </p>
        ) : (
          <ul className={styles.siteAuditFindingList}>
            {visible.map((f, i) => {
              const key = `${f.id}-${i}`;
              const isOpen = open === key;
              const n = resourceCount(f);
              return (
                <li key={key} className={styles.siteAuditFindingRowStatic}>
                  <button type="button" className={styles.siteAuditFindingToggle} onClick={() => setOpen(isOpen ? null : key)} aria-expanded={isOpen}>
                    <span className={styles.siteAuditDiagRow}>
                      <StatusText status={scoreStatus(f.score)} styles={styles} />
                      <span className={styles.siteAuditDiagTitle}>{f.title || f.id}</span>
                      <span className={styles.muted}>
                        {[f.display_value, n > 0 ? `${n} resource${n === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  </button>
                  {isOpen ? <FindingDetails finding={f} styles={styles} /> : null}
                </li>
              );
            })}
          </ul>
        )}
        {current.available && current.findings.length > CAP ? (
          <button type="button" className={styles.siteAuditViewAllBtn} onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
            {showAll ? "Show fewer" : `View all ${current.findings.length} ${current.label.toLowerCase()} diagnostics →`}
          </button>
        ) : null}
      </div>
    </section>
  );
}
