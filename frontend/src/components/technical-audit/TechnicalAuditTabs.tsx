"use client";

import { type KeyboardEvent, useRef } from "react";
import type { Strategy } from "@/lib/technicalAuditView";
import { type CssModule } from "./parts";

export type TaTab = "overview" | "performance" | "accessibility" | "best_practices" | "seo";

export const TA_TABS: { key: TaTab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "performance", label: "Performance" },
  { key: "accessibility", label: "Accessibility" },
  { key: "best_practices", label: "Best Practices" },
  { key: "seo", label: "SEO" },
];

/** Block C: ARIA tabs + the Mobile | Desktop switch (one shared strategy state). */
export function TechnicalAuditTabs({
  active,
  onChange,
  toFix,
  strategy,
  onStrategyChange,
  styles,
}: {
  active: TaTab;
  onChange: (t: TaTab) => void;
  /** Failing + warning audits per category tab; null/absent when not stored. */
  toFix: Partial<Record<TaTab, number | null>>;
  strategy: Strategy;
  onStrategyChange: (s: Strategy) => void;
  styles: CssModule;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TA_TABS.findIndex((t) => t.key === active);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? TA_TABS.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const key = TA_TABS[(next + TA_TABS.length) % TA_TABS.length].key;
    onChange(key);
    refs.current[key]?.focus();
  };

  return (
    <div className={styles.siteAuditTabBar}>
      <div className={styles.siteAuditTabScroll} role="region" aria-label="Technical Audit sections" tabIndex={-1}>
        <div role="tablist" aria-label="Technical Audit sections" className={styles.siteAuditTabs}>
          {TA_TABS.map((t) => {
            const n = toFix[t.key];
            return (
              <button
                key={t.key}
                ref={(el) => {
                  refs.current[t.key] = el;
                }}
                type="button"
                role="tab"
                id={`ta-tab-${t.key}`}
                aria-selected={t.key === active}
                aria-controls={`ta-panel-${t.key}`}
                tabIndex={t.key === active ? 0 : -1}
                className={styles.siteAuditTab}
                onClick={() => onChange(t.key)}
                onKeyDown={onKeyDown}
              >
                {t.label}
                {typeof n === "number" && n > 0 ? <span className={styles.siteAuditCount}>{n} to fix</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      <div className={styles.segmentGroup} role="group" aria-label="Device">
        {(["mobile", "desktop"] as const).map((s) => (
          <button key={s} type="button" className={styles.miniBtn} onClick={() => onStrategyChange(s)} aria-pressed={strategy === s}>
            {s === "mobile" ? "Mobile" : "Desktop"}
          </button>
        ))}
      </div>
    </div>
  );
}
