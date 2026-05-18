"use client";

import type { OverviewReadinessResult } from "@/lib/overviewReadiness";

export function OverviewReadinessGate(props: {
  readiness: OverviewReadinessResult;
  styles: Record<string, string>;
  primaryAction?: { label: string; onClick: () => void };
  secondaryAction?: { label: string; onClick: () => void };
}) {
  const { readiness, styles, primaryAction, secondaryAction } = props;

  return (
    <div className={styles.overviewReadinessShell} role="status" aria-live="polite">
      <div className={styles.overviewReadinessCard}>
        <div className={styles.overviewReadinessProgress} aria-hidden="true">
          <span
            className={styles.overviewReadinessProgressFill}
            style={{ width: `${readiness.progressPercent}%` }}
          />
        </div>
        <p className={styles.overviewReadinessKicker}>Overview preview</p>
        <h2 className={styles.overviewReadinessTitle}>{readiness.headline}</h2>
        <p className={styles.overviewReadinessBody}>{readiness.body}</p>

        <ul className={styles.overviewReadinessChecklist}>
          {readiness.checklist.map((item) => (
            <li
              key={item.id}
              className={`${styles.overviewReadinessCheckItem} ${
                item.done ? styles.overviewReadinessCheckItemDone : ""
              }`}
            >
              <span className={styles.overviewReadinessCheckIcon} aria-hidden="true">
                {item.done ? "✓" : "○"}
              </span>
              <span className={styles.overviewReadinessCheckText}>
                <span className={styles.overviewReadinessCheckLabel}>{item.label}</span>
                {item.detail ? (
                  <span className={styles.overviewReadinessCheckDetail}>{item.detail}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>

        {primaryAction || secondaryAction ? (
          <div className={styles.overviewReadinessActions}>
            {primaryAction ? (
              <button type="button" className={styles.overviewReadinessPrimary} onClick={primaryAction.onClick}>
                {primaryAction.label}
              </button>
            ) : null}
            {secondaryAction ? (
              <button
                type="button"
                className={styles.overviewReadinessSecondary}
                onClick={secondaryAction.onClick}
              >
                {secondaryAction.label}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
