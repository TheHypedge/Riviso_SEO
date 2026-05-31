"use client";

import { useMemo } from "react";

import styles from "@/app/page.module.css";
import { markdownToArticleHtml } from "@/lib/articleMarkdown";
import { splitMarkdownParagraphs } from "@/lib/rivisoLinguistics";

type Props = {
  markdown: string;
  flaggedIndices: number[];
  className?: string;
};

/**
 * Highlighted article view — same typography as the read-only editor; flagged blocks only get a background.
 */
export function ArticleIntegrityBody({ markdown, flaggedIndices, className }: Props) {
  const flagged = useMemo(() => new Set(flaggedIndices), [flaggedIndices]);
  const blocks = useMemo(() => splitMarkdownParagraphs(markdown), [markdown]);

  if (!blocks.length) {
    return <div className={styles.muted} style={{ padding: 16 }}>No article content to analyze.</div>;
  }

  return (
    <div className={`${styles.articleRichEditorWrap} ${styles.articleRichEditorReadonly} ${className || ""}`}>
      <div className={`${styles.articleReadonlyArticleHtml} ${styles.articleIntegrityBody}`}>
        {blocks.map((block, i) => {
          const html = markdownToArticleHtml(block);
          if (flagged.has(i)) {
            return (
              <div
                key={`flag-${i}`}
                className={styles.integrityFlaggedBlock}
                data-integrity-flagged="true"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            );
          }
          return <div key={`blk-${i}`} dangerouslySetInnerHTML={{ __html: html }} />;
        })}
      </div>
    </div>
  );
}
