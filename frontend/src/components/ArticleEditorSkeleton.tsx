"use client";

import editorStyles from "@/app/projects/[projectId]/articles/[articleId]/articleEditor.module.css";

type Props = {
  /** When true, only the main content column shows a large skeleton. */
  bodyOnly?: boolean;
};

export function ArticleEditorSkeleton({ bodyOnly }: Props) {
  if (bodyOnly) {
    return (
      <div className={editorStyles.skeletonEditor} aria-hidden="true">
        <div className={`${editorStyles.skeletonLine} ${editorStyles.skeletonLineLg}`} />
        <div className={editorStyles.skeletonLine} />
        <div className={editorStyles.skeletonLine} />
        <div className={`${editorStyles.skeletonLine} ${editorStyles.skeletonLineMd}`} />
        <div className={editorStyles.skeletonLine} />
        <div className={`${editorStyles.skeletonLine} ${editorStyles.skeletonLineSm}`} />
      </div>
    );
  }

  return (
    <div className={editorStyles.skeletonBlock} aria-hidden="true">
      <div className={`${editorStyles.skeletonLine} ${editorStyles.skeletonLineLg}`} />
      <div className={editorStyles.skeletonLine} />
      <div className={`${editorStyles.skeletonLine} ${editorStyles.skeletonLineMd}`} />
    </div>
  );
}

export function ArticleEditorIntegritySkeleton() {
  return (
    <div className={editorStyles.skeletonBlock} aria-hidden="true">
      <div className={editorStyles.skeletonRingRow}>
        <div className={editorStyles.skeletonRing} />
        <div className={editorStyles.skeletonRingMeta}>
          <div className={`${editorStyles.skeletonLine} ${editorStyles.skeletonLineSm}`} />
          <div className={`${editorStyles.skeletonLine} ${editorStyles.skeletonLineMd}`} />
        </div>
      </div>
      <div className={editorStyles.skeletonRingRow}>
        <div className={editorStyles.skeletonRing} />
        <div className={editorStyles.skeletonRingMeta}>
          <div className={`${editorStyles.skeletonLine} ${editorStyles.skeletonLineSm}`} />
          <div className={`${editorStyles.skeletonLine} ${editorStyles.skeletonLineMd}`} />
        </div>
      </div>
    </div>
  );
}
