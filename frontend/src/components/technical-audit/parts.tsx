"use client";

import { type ReactNode, useEffect, useId } from "react";
import type { TechnicalAuditFinding, TechnicalAuditIndexEntry } from "@/lib/api";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { describeSample, formatSavings } from "@/lib/technicalAudit";
import { METRIC_THRESHOLDS, type MetricKey, parseLighthouseText, scoreStatus, statusLabel } from "@/lib/technicalAuditView";

export type CssModule = { [key: string]: string };

const ICON_STROKE = { fill: "none" as const, stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/** Neutral line icons; only the surrounding tile's status colour carries meaning (spec D1). */
export function CategoryIcon({ category }: { category: string }) {
  switch (category) {
    case "performance":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 20a8 8 0 1 0-8-8" {...ICON_STROKE} />
          <path d="M12 12l4-5" {...ICON_STROKE} />
          <path d="M12 4v1.5M4 12H2.5M21.5 12H20" {...ICON_STROKE} />
        </svg>
      );
    case "accessibility":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="5" r="1.6" {...ICON_STROKE} />
          <path d="M5 8.5c2.3.9 4.6 1.3 7 1.3s4.7-.4 7-1.3" {...ICON_STROKE} />
          <path d="M12 9.8V14M12 14l-3 6.5M12 14l3 6.5" {...ICON_STROKE} />
        </svg>
      );
    case "best_practices":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2l8 3.5v5.5c0 5-3.4 8.9-8 11-4.6-2.1-8-6-8-11V5.5L12 2z" {...ICON_STROKE} />
          <path d="M9 12.5l2 2 4-4.5" {...ICON_STROKE} />
        </svg>
      );
    case "pagespeed_seo":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" {...ICON_STROKE} />
          <path d="M20 20l-4.8-4.8" {...ICON_STROKE} />
        </svg>
      );
    case "metric":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="13" r="7.5" {...ICON_STROKE} />
          <path d="M12 13V9M10 2.5h4" {...ICON_STROKE} />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8" {...ICON_STROKE} />
          <path d="M12 8v5M12 16h.01" {...ICON_STROKE} />
        </svg>
      );
  }
}

export function statusPillClass(styles: CssModule, status: string | null | undefined): string {
  if (status === "good") return `${styles.statusPill} ${styles.statusPublished}`;
  if (status === "needs_improvement") return `${styles.statusPill} ${styles.statusDraft}`;
  if (status === "poor") return `${styles.statusPill} ${styles.statusPending}`;
  return `${styles.statusPill} ${styles.statusNeutral}`;
}

/** Status dot + visible text label (colour is never the only signal). */
export function StatusText({ status, styles }: { status: string | null | undefined; styles: CssModule }) {
  return (
    <span className={styles.siteAuditStatusText}>
      <span className={styles.siteAuditBreakdownDot} data-status={status || "unknown"} aria-hidden="true" />
      {status ? statusLabel(status) : "Not reported"}
    </span>
  );
}

/** Good | Needs Improvement | Poor bar from Google's published limits (METRIC_THRESHOLDS). */
export function MetricThresholdBar({ metric, numericValue, styles }: { metric: MetricKey; numericValue: number | null | undefined; styles: CssModule }) {
  const t = METRIC_THRESHOLDS[metric];
  if (!t || numericValue === null || numericValue === undefined) return null;
  // Each third of the bar is one band so the marker stays legible far past the poor limit.
  const pct =
    numericValue <= t.good
      ? (numericValue / t.good) * 33.33
      : numericValue <= t.poor
        ? 33.33 + ((numericValue - t.good) / (t.poor - t.good)) * 33.33
        : Math.min(100, 66.67 + ((numericValue - t.poor) / t.poor) * 33.33);
  return (
    <div className={styles.siteAuditThresholdBar} aria-hidden="true">
      <div className={styles.siteAuditThresholdBarTrack}>
        <span className={styles.siteAuditThresholdBarMarker} style={{ left: `${Math.max(1, Math.min(99, pct))}%` }} />
      </div>
      <div className={styles.siteAuditThresholdBarLabels}>
        <span>Good</span>
        <span>Needs Improvement</span>
        <span>Poor</span>
      </div>
    </div>
  );
}

/** Inline finding details: Google's description, savings and up to 5 affected resources. */
export function FindingDetails({
  finding,
  styles,
}: {
  finding: TechnicalAuditFinding & { overall_savings_ms?: number | null; overall_savings_bytes?: number | null; affected_resources?: number };
  styles: CssModule;
}) {
  const samples = finding.samples || [];
  const total = finding.item_count ?? finding.affected_resources ?? 0;
  const more = Math.max(0, total - samples.length);
  const savings = formatSavings(finding.overall_savings_ms, finding.overall_savings_bytes, finding.metric_savings);
  return (
    <div className={styles.siteAuditFindingBody}>
      {finding.description ? (
        <p style={{ margin: 0, fontSize: 13 }}>
          <LighthouseText text={finding.description} styles={styles} />
        </p>
      ) : null}
      {savings ? (
        <p className={styles.muted} style={{ margin: "4px 0 0", fontSize: 12 }}>
          {savings} (Google estimate)
        </p>
      ) : null}
      {samples.length > 0 ? (
        <ul className={styles.siteAuditSampleList} aria-label="Affected resources">
          {samples.map((s, i) => (
            <li key={i}>
              <code>{describeSample(s)}</code>
            </li>
          ))}
          {more > 0 ? <li className={styles.muted}>and {more} more not shown</li> : null}
        </ul>
      ) : total > 0 ? (
        <p className={styles.muted} style={{ margin: "4px 0 0", fontSize: 12 }}>
          {total} affected resource{total === 1 ? "" : "s"}. Detailed resource list is not stored for this run. Re-run the audit to capture it.
        </p>
      ) : null}
    </div>
  );
}

export function resourceCount(f: { item_count?: number; affected_resources?: number }): number {
  return f.item_count ?? f.affected_resources ?? 0;
}

/* ── Score gauge (270° arc) ─────────────────────────────────────────────── */

export function ScoreGauge({
  score,
  size = 148,
  strokeWidth = 12,
  styles,
}: {
  score: number | null;
  size?: number;
  strokeWidth?: number;
  styles?: CssModule;
}) {
  const r = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const arcFraction = 0.75; // 270 of 360 degrees; gap sits at the bottom
  const arcLength = circumference * arcFraction;
  const clamped = score === null ? 0 : Math.max(0, Math.min(100, score));
  const filled = (clamped / 100) * arcLength;
  const status = scoreStatus(score);
  const colorVar =
    status === "good" ? "var(--aa-success, #5db872)" : status === "needs_improvement" ? "var(--aa-warning, #d4a017)" : status === "poor" ? "var(--aa-error, #c64545)" : "var(--aa-on-dark-soft, #a09d96)";

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Score ${score === null ? "not available" : Math.round(score) + " out of 100"}`}>
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke="var(--aa-hairline, rgba(255,255,255,0.1))"
        strokeWidth={strokeWidth}
        strokeDasharray={`${arcLength} ${circumference - arcLength}`}
        strokeLinecap="round"
        transform={`rotate(135 ${cx} ${cy})`}
      />
      {score !== null ? (
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={colorVar}
          strokeWidth={strokeWidth}
          strokeDasharray={`${filled} ${circumference - filled}`}
          strokeLinecap="round"
          transform={`rotate(135 ${cx} ${cy})`}
          className={styles?.siteAuditGaugeArc}
        />
      ) : null}
      <text x={cx} y={cy - 2} textAnchor="middle" fontSize={size * 0.26} fontWeight={700} fill="var(--aa-on-dark, #faf9f5)">
        {score === null ? "—" : Math.round(score)}
      </text>
      <text x={cx} y={cy + size * 0.13} textAnchor="middle" fontSize={size * 0.08} fill="var(--aa-on-dark-soft, #a09d96)">
        / 100
      </text>
    </svg>
  );
}


/** Move to and focus a section; smooth scroll only when the user allows motion. */
export function scrollToSection(id: string): void {
  const el = typeof document !== "undefined" ? document.getElementById(id) : null;
  if (!el) return;
  const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  el.focus({ preventScroll: true });
}

/* ── v2 shared pieces ───────────────────────────────────────────────────── */

export type Kind = TechnicalAuditIndexEntry["kind"];

export const KIND_LABELS: Record<Kind, string> = {
  failed: "Failed",
  warning: "Needs improvement",
  passed: "Passed",
  informational: "Informational",
  manual: "Check manually",
  not_applicable: "Not applicable",
  error: "Could not run",
};

/** PSI's convention: ▲ fail · ■ needs improvement · ● pass · ◆ informational (shape + colour). */
export function ShapeIcon({ kind, styles }: { kind: Kind | string; styles: CssModule }) {
  const k = kind === "failed" || kind === "error" ? "failed" : kind === "warning" ? "warning" : kind === "passed" ? "passed" : "info";
  return (
    <span className={styles.siteAuditShape} data-kind={k} aria-hidden="true">
      <svg viewBox="0 0 12 12" width="12" height="12">
        {k === "failed" ? <path d="M6 1l5 9.5H1z" /> : k === "warning" ? <rect x="1.5" y="1.5" width="9" height="9" rx="1" /> : k === "passed" ? <circle cx="6" cy="6" r="5" /> : <path d="M6 .8l5.2 5.2L6 11.2.8 6z" />}
      </svg>
    </span>
  );
}

/** Lighthouse text with safe https links and code spans; never HTML. */
export function LighthouseText({ text, styles }: { text: string | null | undefined; styles: CssModule }) {
  return (
    <>
      {parseLighthouseText(text).map((p, i) =>
        p.type === "link" ? (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer" className={styles.siteAuditTextLink}>
            {p.text}
            <span className={styles.srOnly}> (opens in a new tab)</span>
          </a>
        ) : p.type === "code" ? (
          <code key={i} className={styles.siteAuditInlineCode}>
            {p.text}
          </code>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

let openDialogs = 0;

/** Focus-trapped dialog (Esc, backdrop, Close button), body scroll locked while open. */
export function AuditDialog({
  open,
  onClose,
  title,
  children,
  size = "md",
  styles,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  size?: "md" | "lg";
  styles: CssModule;
}) {
  const ref = useFocusTrap(open);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    openDialogs += 1;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      openDialogs -= 1;
      if (openDialogs === 0) document.body.style.overflow = "";
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className={styles.siteAuditDialogBackdrop} onClick={onClose} aria-hidden="true" />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={styles.siteAuditDialog} data-size={size}>
        <div className={styles.siteAuditDialogHead}>
          <h3 id={titleId} className={styles.siteAuditPanelTitle}>
            {title}
          </h3>
          <button type="button" className={styles.btnSecondary} onClick={onClose}>
            Close details
          </button>
        </div>
        <div className={styles.siteAuditDialogBody}>{children}</div>
      </div>
    </>
  );
}

/** One Lighthouse audit row: shape icon + title + Lighthouse's displayValue verbatim; expands inline. */
export function AuditRow({
  audit,
  open,
  onToggle,
  styles,
}: {
  audit: TechnicalAuditIndexEntry;
  open: boolean;
  onToggle: () => void;
  styles: CssModule;
}) {
  const hasDetails = Boolean(audit.description || (audit.samples && audit.samples.length) || audit.error_message);
  const panelId = `ta-audit-${audit.category}-${audit.id}`;
  return (
    <li className={styles.siteAuditAuditRow}>
      <button type="button" className={styles.siteAuditAuditToggle} onClick={onToggle} aria-expanded={hasDetails ? open : undefined} aria-controls={hasDetails ? panelId : undefined} disabled={!hasDetails}>
        <ShapeIcon kind={audit.kind} styles={styles} />
        <span className={styles.siteAuditAuditTitle}>
          {audit.title || audit.id}
          <span className={styles.srOnly}> — {KIND_LABELS[audit.kind]}</span>
        </span>
        {audit.display_value ? <span className={styles.siteAuditAuditValue}>{audit.display_value}</span> : null}
        {hasDetails ? (
          <span className={styles.siteAuditChevron} data-open={open || undefined} aria-hidden="true">
            ›
          </span>
        ) : null}
      </button>
      {open && hasDetails ? (
        <div id={panelId}>
          {audit.error_message ? <p className={styles.muted} style={{ margin: "0 0 6px", fontSize: 12 }}>Lighthouse could not run this audit: {audit.error_message}</p> : null}
          <FindingDetails finding={audit} styles={styles} />
        </div>
      ) : null}
    </li>
  );
}
