"use client";

import { type Strategy, scoreStatus, statusLabel } from "@/lib/technicalAuditView";
import { type CssModule, ScoreGauge, ShapeIcon, statusPillClass } from "./parts";

const LEGEND = [
  { kind: "passed", range: "90–100", label: "Good" },
  { kind: "warning", range: "50–89", label: "Needs improvement" },
  { kind: "failed", range: "0–49", label: "Poor" },
];

/** Block D (and the header of each category tab): one Lighthouse category score. */
export function PerformanceScoreCard({
  title,
  score,
  previousScore,
  comparable,
  hasPrevious,
  strategy,
  id = "ta-score",
  styles,
}: {
  title: string;
  score: number | null;
  previousScore: number | null;
  /** False when the previous run audited a different URL. */
  comparable: boolean;
  hasPrevious: boolean;
  strategy: Strategy;
  id?: string;
  styles: CssModule;
}) {
  const st = scoreStatus(score);
  let delta: string;
  if (!hasPrevious) delta = "No previous audit";
  else if (!comparable) delta = "Previous audit was for a different URL";
  else if (score === null || previousScore === null) delta = "Not comparable with the previous audit";
  else if (score === previousScore) delta = "No change vs previous audit";
  else delta = `${score > previousScore ? "▲" : "▼"} ${Math.abs(score - previousScore)} vs previous audit`;
  const dir = delta.startsWith("▲") ? "up" : delta.startsWith("▼") ? "down" : "none";

  return (
    <section id={id} aria-labelledby={`${id}-title`} className={`${styles.card} ${styles.siteAuditPanel} ${styles.siteAuditScorePanel}`}>
      <h3 id={`${id}-title`} className={styles.siteAuditPanelTitle}>
        {title}
      </h3>
      <div className={styles.siteAuditScoreBody}>
        <ScoreGauge score={score} size={136} strokeWidth={11} styles={styles} />
        <div className={styles.siteAuditScoreMeta}>
          {st ? <span className={statusPillClass(styles, st)}>{statusLabel(st)}</span> : <span className={styles.muted}>Not reported for this run</span>}
          <span className={styles.siteAuditDelta} data-dir={dir}>
            {delta}
          </span>
          <span className={styles.muted} style={{ fontSize: 12 }}>
            Based on Google PageSpeed Insights · {strategy === "mobile" ? "Mobile" : "Desktop"}
          </span>
        </div>
      </div>
      <ul className={styles.siteAuditLegend} aria-label="Lighthouse score bands">
        {LEGEND.map((l) => (
          <li key={l.kind}>
            <ShapeIcon kind={l.kind} styles={styles} />
            <span className="tabular-nums">{l.range}</span> {l.label}
          </li>
        ))}
      </ul>
    </section>
  );
}
