"use client";

import type { TechnicalAuditStrategyResult } from "@/lib/api";
import { type ScoreKey, SCORE_LABELS, type Strategy, scoreStatus, statusLabel, technicalHealthScore } from "@/lib/technicalAuditView";
import { CategoryIcon, type CssModule, ScoreGauge, statusPillClass } from "./parts";

const TILE_KEYS: ScoreKey[] = ["performance", "accessibility", "best_practices", "pagespeed_seo"];

function deltaText(current: number | null, previous: number | null, hasPrevious: boolean): string {
  if (!hasPrevious) return "No previous audit";
  if (current === null || previous === null) return "Not comparable with the previous audit";
  const d = current - previous;
  if (d === 0) return "No change vs previous audit";
  return `${d > 0 ? "▲" : "▼"} ${Math.abs(d)} vs previous audit`;
}

/** Block C: Overall Site Health (wide) + the four Lighthouse category scores. */
export function ScoreRow({
  mobile,
  desktop,
  strategy,
  previous,
  comparable,
  styles,
}: {
  mobile: TechnicalAuditStrategyResult;
  desktop: TechnicalAuditStrategyResult;
  strategy: Strategy;
  /** Same-strategy result of the previous (older) run, if any. */
  previous: TechnicalAuditStrategyResult | null;
  /** False when the previous run audited a different website URL. */
  comparable: boolean;
  styles: CssModule;
}) {
  const active = strategy === "mobile" ? mobile : desktop;
  const health = technicalHealthScore(active);
  const status = scoreStatus(health);
  const delta = comparable ? deltaText(health, technicalHealthScore(previous), previous !== null) : "Previous audit was for a different URL";
  const deltaDir = delta.startsWith("▲") ? "up" : delta.startsWith("▼") ? "down" : "none";

  return (
    <section id="ta-scores" aria-labelledby="ta-scores-title" className={styles.siteAuditScoreRow}>
      <h3 id="ta-scores-title" className={styles.srOnly}>
        Scores ({strategy === "mobile" ? "Mobile" : "Desktop"})
      </h3>
      <div className={`${styles.siteAuditScoreCard} ${styles.siteAuditScoreCardWide}`} title="Riviso Technical Health Score">
        <ScoreGauge score={health} size={112} strokeWidth={10} styles={styles} />
        <div className={styles.siteAuditScoreCardBody}>
          <span className={styles.siteAuditScoreCardLabel}>Overall Site Health</span>
          {status ? <span className={statusPillClass(styles, status)}>{statusLabel(status)}</span> : null}
          <span className={styles.siteAuditDelta} data-dir={deltaDir}>
            {delta}
          </span>
        </div>
      </div>
      {TILE_KEYS.map((key) => {
        const value = active.scores[key];
        const st = scoreStatus(value);
        return (
          <div key={key} className={styles.siteAuditScoreCard}>
            <span className={styles.siteAuditCategoryIcon} data-status={st || "unknown"} aria-hidden="true">
              <CategoryIcon category={key} />
            </span>
            <span className={styles.siteAuditScoreCardLabel}>{SCORE_LABELS[key]}</span>
            {key === "performance" ? (
              <span className={styles.siteAuditScorePair}>
                {(["mobile", "desktop"] as const).map((s) => {
                  const v = (s === "mobile" ? mobile : desktop).scores.performance;
                  return (
                    <span key={s} className={styles.siteAuditScorePairItem} data-active={s === strategy || undefined}>
                      <span className={styles.siteAuditScorePairValue}>{v ?? "—"}</span>
                      <span className={styles.siteAuditScorePairLabel}>
                        <span className={styles.siteAuditBreakdownDot} data-status={scoreStatus(v) || "unknown"} aria-hidden="true" />
                        {s === "mobile" ? "Mobile" : "Desktop"}
                        <span className={styles.srOnly}>, {v === null ? "not reported" : statusLabel(scoreStatus(v))}</span>
                      </span>
                    </span>
                  );
                })}
              </span>
            ) : (
              <>
                <span className={styles.siteAuditCategoryValue}>
                  {value ?? "—"}
                  <span className={styles.siteAuditCategoryValueUnit}>/100</span>
                </span>
                {st ? <span className={statusPillClass(styles, st)}>{statusLabel(st)}</span> : <span className={styles.muted}>Not reported</span>}
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}
