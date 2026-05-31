"use client";

import { useMemo } from "react";

import styles from "@/app/page.module.css";
import { markdownToArticleHtml } from "@/lib/articleMarkdown";
import {
  buildHumanizeCompareBlocks,
  countChangedBlocks,
  type HumanizeRewritten,
} from "@/lib/humanizeDiff";

type Props = {
  original: string;
  humanized: string;
  rewritten?: HumanizeRewritten[] | null;
  aiBefore?: number | null;
  aiAfter?: number | null;
};

/**
 * Side-by-side humanization review: humanized column highlights edits in green.
 */
export function IntegrityHumanizeCompare({ original, humanized, rewritten, aiBefore, aiAfter }: Props) {
  const blocks = useMemo(
    () => buildHumanizeCompareBlocks(original, humanized, rewritten),
    [original, humanized, rewritten],
  );
  const changedCount = countChangedBlocks(blocks);

  if (!blocks.length) {
    return <p className={styles.muted}>No content to compare.</p>;
  }

  return (
    <div className={styles.humanizeCompareRoot}>
      <p className={styles.humanizeCompareLegend}>
        <span className={styles.humanizeCompareLegendSwatch} aria-hidden />
        Green = paraphrased blocks ({changedCount} of {blocks.length} changed). The full article is rewritten on
        apply—not only highlighted sections.
        {aiBefore != null && aiAfter != null ? (
          <>
            {" "}
            Riviso AI risk: <strong>{aiBefore.toFixed(0)}%</strong> → <strong>{aiAfter.toFixed(0)}%</strong>.
          </>
        ) : null}{" "}
        SEO terms stay protected. Works across all industries.
      </p>
      <div className={styles.humanizeCompareGrid}>
        <div className={styles.humanizeCompareCol}>
          <div className={styles.humanizeCompareColTitle}>Original</div>
          <div className={styles.humanizeCompareScroll}>
            {blocks.map((b) => (
              <div
                key={`orig-${b.index}`}
                className={`${styles.humanizeCompareBlock} ${b.changed ? styles.humanizeCompareBlockMuted : ""}`}
              >
                {b.original.trim() ? (
                  <div
                    className={styles.humanizeCompareProse}
                    dangerouslySetInnerHTML={{ __html: markdownToArticleHtml(b.original) }}
                  />
                ) : (
                  <span className={styles.muted}>—</span>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className={styles.humanizeCompareCol}>
          <div className={styles.humanizeCompareColTitle}>Riviso humanized</div>
          <div className={styles.humanizeCompareScroll}>
            {blocks.map((b) => (
              <div
                key={`hum-${b.index}`}
                className={`${styles.humanizeCompareBlock} ${b.changed ? styles.humanizeCompareBlockChanged : ""}`}
              >
                {b.humanized.trim() ? (
                  b.changed ? (
                    <div
                      className={`${styles.humanizeCompareProse} ${styles.humanizeCompareProseDiff}`}
                      dangerouslySetInnerHTML={{ __html: b.humanizedHtml }}
                    />
                  ) : (
                    <div
                      className={styles.humanizeCompareProse}
                      dangerouslySetInnerHTML={{ __html: markdownToArticleHtml(b.humanized) }}
                    />
                  )
                ) : (
                  <span className={styles.muted}>—</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
