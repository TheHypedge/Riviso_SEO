"use client";

import { markdownToArticleHtml } from "@/lib/articleMarkdown";

import styles from "@/app/page.module.css";

type Props = {
  markdown: string;
};

/**
 * Read-only article body — renders markdown as HTML without TipTap parsing, so headings/tables/etc.
 * from `marked` always display (published articles rely on this).
 */
export function ArticleReadonlyBody({ markdown }: Props) {
  const html = markdownToArticleHtml(markdown);

  return (
    <div className={`${styles.articleRichEditorWrap} ${styles.articleRichEditorReadonly}`}>
      <div className={`${styles.articleReadonlyArticleHtml} article-readonly-html`}>
        {/* eslint-disable-next-line react/no-danger */}
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      <div className={styles.muted} style={{ fontSize: 11, padding: "6px 10px", borderTop: "1px solid var(--aa-hairline-soft)" }}>
        Published — read only. Same markdown is converted to HTML when posting to WordPress.
      </div>
    </div>
  );
}
